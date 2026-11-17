#!/usr/bin/env python3
"""Quiesced native backups and DB-only restore drill; never applies a release.

The root orchestrator must hold native.locked(root=True). Only existing native
application containers are stopped/started. Source DB containers are never
restarted. Successful return permits further operator gates, not activation.
PostgreSQL ownership/ACL recreation and authenticated application recovery are
explicitly outside this DB-only drill. Globals/env/config are retained privately.
"""
import hashlib
import copy
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import time
import traceback
import xml.etree.ElementTree as ET


IDENTIFIER = re.compile(r'[A-Za-z_][A-Za-z0-9_]{0,126}\Z')
ENGINES = {'MergeTree', 'ReplacingMergeTree', 'AggregatingMergeTree', 'SummingMergeTree',
           'MaterializedView', 'View'}
TIMEOUT = 600
DRILL_STEPS = {'validating_artifacts', 'postgres_create_target', 'postgres_wait_tcp',
               'postgres_create_database', 'postgres_copy_archive', 'postgres_restore', 'postgres_verify',
               'postgres_cleanup', 'clickhouse_create_target', 'clickhouse_wait_ready', 'clickhouse_restore',
               'clickhouse_verify', 'clickhouse_cleanup', 'redis_create_target', 'redis_wait_ready',
               'redis_verify', 'complete'}
ARTIFACT_NAMES = {'postgres.dump', 'postgres-globals.sql', 'clickhouse.zip', 'redis.rdb', 'previous.env'}
RESTORE_LIMITS = ['No application recovery test', 'PostgreSQL roles/ownership/ACL not replayed',
                  'ClickHouse SQL access management not restored by database-only archive',
                  'Local backup does not cover loss of this host',
                  'Image rollback preserves later writes; data restore requires separate recovery decision']
CH_DRILL_CONFIG = ('<clickhouse><backups><allowed_path>/backup</allowed_path></backups>'
    '<background_schedule_pool_size>16</background_schedule_pool_size>'
    '<background_buffer_flush_schedule_pool_size>4</background_buffer_flush_schedule_pool_size>'
    '<background_message_broker_schedule_pool_size>4</background_message_broker_schedule_pool_size>'
    '<background_distributed_schedule_pool_size>4</background_distributed_schedule_pool_size>'
    '<background_pool_size>16</background_pool_size><background_move_pool_size>4</background_move_pool_size>'
    '<background_fetches_pool_size>4</background_fetches_pool_size><max_thread_pool_size>256</max_thread_pool_size>'
    '<send_crash_reports><enabled>false</enabled></send_crash_reports></clickhouse>')
PG_INVENTORY = """
SELECT json_build_object(
 'columns', (SELECT coalesce(json_agg(row_to_json(x)), '[]') FROM
  (SELECT table_schema,table_name,column_name,ordinal_position,data_type,udt_name,
          is_nullable,column_default
   FROM information_schema.columns WHERE table_schema IN ('public','drizzle')
   ORDER BY table_schema,table_name,ordinal_position) x),
 'constraints', (SELECT coalesce(json_agg(row_to_json(x)), '[]') FROM
  (SELECT n.nspname AS schema,c.relname AS name,k.conname,
          pg_get_constraintdef(k.oid) AS definition
   FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
   JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname IN ('public','drizzle') ORDER BY 1,2,3) x),
 'indexes', (SELECT coalesce(json_agg(row_to_json(x)), '[]') FROM
  (SELECT schemaname,tablename,indexname,indexdef FROM pg_indexes
   WHERE schemaname IN ('public','drizzle') ORDER BY 1,2,3) x),
 'journal', (SELECT coalesce(json_agg(row_to_json(x)), '[]') FROM
  (SELECT id,hash,created_at FROM drizzle.__drizzle_migrations ORDER BY created_at,id) x)
)::text;
"""


def utc():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def file_hash(path):
    value = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def normalize_postgres_checks(checks):
    """Copy raw checks, replacing physical column positions with visible ranks.

    DROP COLUMN leaves attnum gaps; logical pg_dump/pg_restore does not recreate
    those holes. Keep column list order and every other inventory/count value.
    """
    if not (isinstance(checks, dict) and set(checks) == {'inventory', 'counts'} and
            isinstance(checks['inventory'], dict) and
            set(checks['inventory']) == {'columns', 'constraints', 'indexes', 'journal'} and
            all(isinstance(rows, list) for rows in checks['inventory'].values()) and
            isinstance(checks['counts'], dict) and
            all(isinstance(name, str) and type(value) is int and value >= 0 for name, value in checks['counts'].items())):
        raise ValueError('Invalid PostgreSQL check structure')
    fields = {'table_schema', 'table_name', 'column_name', 'ordinal_position',
              'data_type', 'udt_name', 'is_nullable', 'column_default'}
    identities = set()
    ordinals = {}
    for column in checks['inventory']['columns']:
        if not (isinstance(column, dict) and set(column) == fields and
                all(isinstance(column[key], str) and IDENTIFIER.fullmatch(column[key])
                    for key in ('table_schema', 'table_name', 'column_name')) and
                type(column['ordinal_position']) is int and column['ordinal_position'] > 0 and
                isinstance(column['data_type'], str) and isinstance(column['udt_name'], str) and
                column['is_nullable'] in {'YES', 'NO'} and
                (column['column_default'] is None or isinstance(column['column_default'], str))):
            raise ValueError('Invalid PostgreSQL column metadata')
        identity = (column['table_schema'], column['table_name'], column['column_name'])
        table = identity[:2]
        position = column['ordinal_position']
        if identity in identities or position in ordinals.setdefault(table, set()):
            raise ValueError('Duplicate PostgreSQL column identity or ordinal')
        identities.add(identity)
        ordinals[table].add(position)
    ranks = {table: {position: index + 1 for index, position in enumerate(sorted(positions))}
             for table, positions in ordinals.items()}
    normalized = copy.deepcopy(checks)
    for column in normalized['inventory']['columns']:
        column['ordinal_position'] = ranks[(column['table_schema'], column['table_name'])][column['ordinal_position']]
    return normalized


def postgres_checks_digest(checks):
    normalized = normalize_postgres_checks(checks)
    return hashlib.sha256(json.dumps(normalized, sort_keys=True, separators=(',', ':'),
                                    allow_nan=False).encode()).hexdigest()


def postgres_comparison(expected, actual):
    # Canonical JSON also retains JSON scalar types (e.g. integer vs boolean).
    expected_logical = postgres_checks_digest(expected)
    actual_logical = postgres_checks_digest(actual)
    def raw_digest(value):
        return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'),
                                        allow_nan=False).encode()).hexdigest()
    expected_raw, actual_raw = raw_digest(expected), raw_digest(actual)
    return {'version': 1, 'columnOrdinals': 'dense-visible-order-per-table',
            'rawEqual': expected_raw == actual_raw, 'logicalEqual': expected_logical == actual_logical,
            'expectedRawSha256': expected_raw, 'actualRawSha256': actual_raw,
            'expectedLogicalSha256': expected_logical, 'actualLogicalSha256': actual_logical}


def failure_evidence(error, phase):
    """Closed metadata only: never serialize exception messages or frame locals."""
    kind = type(error).__name__
    if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,79}', kind):
        kind = 'UnknownError'
    sites = []
    for frame in traceback.extract_tb(error.__traceback__)[-16:]:
        name = Path(frame.filename).name
        sites.append({'file': name if re.fullmatch(r'[A-Za-z0-9_.-]{1,128}', name) else '[unknown]',
                      'line': frame.lineno})
    return {'phase': phase, 'errorType': kind, 'sites': sites, 'at': utc()}


class Backup:
    def __init__(self, native, transaction, progress=None):
        self.n = native
        self.root = Path(transaction)
        self.token = secrets.token_hex(8)
        self.source_temp = '/tmp/wotcv-native-backup-' + self.token
        self.ch_name = 'wotcv-native-' + self.token + '.zip'
        self.ch_archive = '/var/lib/clickhouse/backups/backups/' + self.ch_name
        self.ch_relative = 'backups/' + self.ch_name
        self.auth = self.root / 'redis-auth.env'
        self.targets = []
        self.volumes = []
        self.before = None
        self.stopped = []
        self.ch_temp_created = False
        self.ch_backup_attempted = False
        self.progress = progress or (lambda phase: None)
        self.drill_history = []
        self.stop_states = {}
        self.capture_stage = 'stopping_apps'
        self.drill_step = 'validating_artifacts'

    def require(self, condition, message):
        self.n.require(condition, message)

    def write(self, path, data):
        self.n.write(path, data)

    def record(self, name, value):
        self.n.record(self.root / name, value)

    def best_effort_record(self, name, value):
        # Evidence I/O is subordinate to restoring the already stopped writers.
        try:
            self.record(name, value)
        except BaseException:
            pass

    def step(self, name):
        self.require(name in DRILL_STEPS, 'Unknown isolated drill step')
        self.drill_step = name
        self.record('drill-status.json', {'phase': 'passed' if name == 'complete' else 'running',
                                         'step': name, 'at': utc()})

    def docker(self, *args, **kwargs):
        return self.n.docker(*args, **kwargs)

    def shell(self, container, script, *args, data=None, timeout=60):
        return self.docker('exec', '-i', container, 'sh', '-ec', script, 'sh', *args,
                           data=data, timeout=timeout)

    def stream(self, args, path, data=None):
        """Keep stdout binary-clean; errors remain in a separate private file."""
        temporary = path.with_suffix(path.suffix + '.partial')
        logpath = path.with_suffix(path.suffix + '.stderr')
        output_fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(output_fd, 'wb') as output:
            error_fd = os.open(logpath, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(error_fd, 'wb') as error:
                try:
                    result = subprocess.run([*self.n.DOCKER, *args], env=self.n.safe_env(), input=data,
                                            stdout=output, stderr=error, timeout=TIMEOUT, check=False)
                except (OSError, subprocess.TimeoutExpired):
                    raise self.n.Refused('Backup stream unavailable or timed out; private evidence retained') from None
                self.require(result.returncode == 0, 'Backup stream failed; private evidence retained')
                output.flush()
                os.fsync(output.fileno())
        self.require(temporary.stat().st_size > 0, 'Backup stream is empty')
        os.replace(temporary, path)

    def pg(self, container, sql, database='analytics', *, tcp=False):
        self.require(IDENTIFIER.fullmatch(database), 'Unsupported PostgreSQL database identifier')
        return self.shell(container,
                          'export PGPASSWORD="$POSTGRES_PASSWORD"; '
                          'exec psql -X -qAt --no-password --username "$POSTGRES_USER" '
                          + ('--host 127.0.0.1 --port 5432 ' if tcp else '') +
                          '--dbname "$1" --set ON_ERROR_STOP=1', database,
                          data=sql.encode(), timeout=120).strip()

    def logged_pg_command(self, container, script, tag, *, data=None):
        """Text-only isolated commands retain stderr and actual terminal result."""
        self.require(tag in {'postgres-create-database', 'postgres-restore'}, 'Unknown private command log')
        self.require(container in self.targets, 'Private step commands require this drill isolated target')
        command = [*self.n.DOCKER, 'exec', '-i', container, 'sh', '-ec', script, 'sh']
        result = {'step': self.drill_step, 'startedAt': utc(), 'returnCode': None, 'timedOut': False}
        error = None
        with os.fdopen(os.open(self.root / (tag + '.stdout.log'),
                               os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'wb') as output:
            with os.fdopen(os.open(self.root / (tag + '.stderr.log'),
                                   os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'wb') as stderr:
                try:
                    completed = subprocess.run(command, env=self.n.safe_env(), input=data,
                                               stdout=output, stderr=stderr, timeout=TIMEOUT, check=False)
                    result['returnCode'] = completed.returncode
                except BaseException as exc:
                    error = exc
                    result['timedOut'] = isinstance(exc, subprocess.TimeoutExpired)
                    result['errorType'] = type(exc).__name__
                finally:
                    output.flush()
                    stderr.flush()
                    os.fsync(output.fileno())
                    os.fsync(stderr.fileno())
        result['finishedAt'] = utc()
        self.record(tag + '.result.json', result)
        if error is not None and not isinstance(error, (OSError, subprocess.TimeoutExpired)):
            raise error
        self.require(error is None and result['returnCode'] == 0,
                     'Isolated PostgreSQL command failed; inspect private step logs and result')

    def pg_json(self, container, sql):
        return json.loads(self.pg(container, sql))

    def ch(self, container, sql, config=None):
        config = config or self.source_temp + '/client.xml'
        return self.docker('exec', '-i', container, 'clickhouse-client', '--config-file', config,
                           '--multiquery', data=('SET log_queries=0;\n' + sql).encode(), timeout=TIMEOUT).strip()

    def ch_rows(self, container, sql, config=None):
        raw = self.ch(container, sql + ' FORMAT JSONEachRow', config)
        return [json.loads(line) for line in raw.splitlines() if line]

    def redis(self, container, *args, source=True, json_output=False):
        options = ['--env-file', str(self.auth)] if source else []
        output = self.docker('exec', *options, container, 'redis-cli', '--no-auth-warning',
                             '--json' if json_output else '--raw', *args, timeout=180).strip()
        return json.loads(output) if json_output else output

    def create_auth(self, model):
        services = model['services']
        backend = services['backend']['environment']
        ch_env = services['clickhouse']['environment']
        self.database = backend.get('POSTGRES_DB', 'analytics')
        self.require(self.database == 'analytics' and backend.get('CLICKHOUSE_DB', 'analytics') == 'analytics',
                     'This reviewed backup supports only native analytics databases')
        password = backend.get('REDIS_PASSWORD')
        self.require(isinstance(password, str) and password and '\n' not in password and '\r' not in password,
                     'Redis authentication environment is unsupported')
        self.write(self.auth, 'REDISCLI_AUTH=' + password + '\n')
        config = ET.Element('config')
        ET.SubElement(config, 'user').text = ch_env.get('CLICKHOUSE_USER', 'default')
        ET.SubElement(config, 'password').text = ch_env.get('CLICKHOUSE_PASSWORD', '')
        self.shell(self.before['clickhouse']['id'], 'umask 077; mkdir "$1"', self.source_temp)
        self.ch_temp_created = True
        self.shell(self.before['clickhouse']['id'], 'umask 077; cat > "$1/client.xml"',
                   self.source_temp, data=ET.tostring(config))

    def preflight(self):
        self.require(hasattr(os, 'geteuid') and os.geteuid() == 0, 'Root backup orchestrator required')
        self.n.private_build_directory(self.root)
        self.require(not any(self.root.iterdir()), 'Backup transaction directory must be new and empty')
        self.require(not (self.n.STATE / 'pending.json').exists(), 'Pending native transaction blocks backup')
        env, model = self.validate_runtime()
        self.write(self.root / 'previous.env', env.read_bytes())
        # Expected image labels remain pinned; saved credentials are needed for
        # actual recovery but are never interpolated into argv or status output.
        for index, relative in enumerate(('docker-compose.yml', 'ops/minimal/compose.fresh.yml')):
            self.write(self.root / ('compose-' + str(index) + '.yml'),
                       (self.n.ROOT / 'source' / relative).read_bytes())
        configs = self.root / 'source-configs'
        configs.mkdir(mode=0o700)
        config_manifest = []
        for name in self.n.DATABASES:
            info = self.n.image_info(self.before[name]['image'])
            self.require(info['Id'] == self.before[name]['image'], 'Source database image is unavailable')
            for mount in self.before[name]['mounts']:
                if mount['Type'] != 'bind':
                    continue
                source = Path(mount['Source'])
                self.require(source.is_file() and not source.is_symlink() and
                             source.resolve().is_relative_to((self.n.ROOT / 'source').resolve()) and
                             mount['Destination'].startswith('/etc/clickhouse-server/'),
                             'Unexpected source database configuration mount')
                target = configs / ('config-' + str(len(config_manifest)) + '.xml')
                self.write(target, source.read_bytes())
                config_manifest.append({'file': target.name, 'destination': mount['Destination'],
                                        'sha256': file_hash(target)})
        self.record('source-configs.json', config_manifest)
        self.create_auth(model)
        return {}

    def validate_runtime(self):
        """Read-only validation shared with a drill of an existing capture."""
        self.before = self.n.snapshot()
        # Reconciliation belongs to the independently reviewed native updater.
        # Capture requires its ordinary guard, including the current attestation.
        self.n.receipt_guard(self.before)
        env = self.n.current_env()
        self.n.private(env)
        model = self.n.config(env)
        self.n.model_guard(model, self.before)
        self.n.verify_model_live(model, self.before)
        sealed = json.loads((self.n.ROOT / 'state.json').read_bytes())
        self.require(sealed['project'] == self.n.PROJECT and sealed['source'] == self.n.BASELINE and
                     sealed['sourceFiles'] == self.n.source_hashes(self.n.ROOT / 'source'),
                     'Sealed native source changed')
        return env, model

    def database_unchanged(self):
        for name in self.n.DATABASES:
            before = self.before[name]
            item = json.loads(self.docker('inspect', before['id']))[0]
            self.require(item['Id'] == before['id'] and item['Image'] == before['image'] and
                         item['State']['Status'] == 'running' and
                         item['State'].get('Health', {}).get('Status') == 'healthy' and
                         item['State']['StartedAt'] == before['started'] and
                         item['RestartCount'] == before['restarts'] and item['Mounts'] == before['mounts'] and
                         set(item['NetworkSettings']['Networks']) == {self.n.PROJECT + '_default'} and
                         not item['HostConfig'].get('PortBindings'),
                         'Source database changed; leave application writers stopped for inspection')
            volume = before['volume']['Name']
            self.require(json.loads(self.docker('volume', 'inspect', volume))[0] == before['volume'],
                         'Source database volume changed; leave writers stopped')

    def stop_apps(self):
        # Track attempts too: a failed command may already have stopped a source.
        for name in ('client', 'backend'):
            self.capture_stage = 'stopping_' + name
            self.stopped.append(name)
            self.docker('stop', '--time', '60', self.before[name]['id'], timeout=90)
            item = json.loads(self.docker('inspect', self.before[name]['id']))[0]
            state = item['State']
            finished = state.get('FinishedAt')
            exit_code = state.get('ExitCode')
            status = state.get('Status')
            self.stop_states[name] = {
                'id': self.before[name]['id'], 'image': self.before[name]['image'],
                'identityMatches': item.get('Id') == self.before[name]['id'] and
                                   item.get('Image') == self.before[name]['image'],
                'status': status if status in {'created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead'}
                          else '[invalid]',
                'exitCode': exit_code if type(exit_code) is int else None,
                'oomKilled': state.get('OOMKilled') is not False,
                'running': bool(state.get('Running')), 'restarting': bool(state.get('Restarting')),
                'stateErrorEmpty': state.get('Error', '') == '',
                'finishedAt': finished if isinstance(finished, str) and
                              re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z', finished) else None}
            # Persist the stopped state before a possible refusal. In particular,
            # the independently observed Next client exits 143 after clean TERM;
            # backend drain still requires its explicit successful exit code 0.
            self.record('stopped-apps.json', self.stop_states)
            allowed = {0, 143} if name == 'client' else {0}
            self.require(self.stop_states[name]['identityMatches'] and status == 'exited' and
                         type(exit_code) is int and exit_code in allowed and state.get('OOMKilled') is False and
                         not state.get('Running') and not state.get('Restarting') and state.get('Error', '') == '',
                         'Application shutdown was not clean; capture refused')

    def resume_apps(self):
        if not self.stopped:
            return None
        self.database_unchanged()
        for name in ('backend', 'client'):
            if name in self.stopped:
                self.docker('start', self.before[name]['id'], timeout=90)
        after = self.n.wait_ready({name: self.before[name]['image'] for name in ('backend', 'client')})
        self.n.infrastructure_unchanged(self.before, after)
        self.require(all(after[name]['id'] == self.before[name]['id'] for name in ('backend', 'client')),
                     'Source application container identity changed')
        self.stopped.clear()
        return after

    def pg_checks(self, container):
        inventory = self.pg_json(container, PG_INVENTORY)
        tables = self.pg_json(container, "SELECT coalesce(json_agg(row_to_json(x)), '[]') FROM "
                              "(SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN "
                              "('public','drizzle') ORDER BY 1,2) x;")
        self.require(0 < len(tables) <= 100, 'Unexpected PostgreSQL table scope')
        counts = {}
        for table in tables:
            schema, name = table['schemaname'], table['tablename']
            self.require(IDENTIFIER.fullmatch(schema) and IDENTIFIER.fullmatch(name),
                         'Unsupported PostgreSQL table identifier')
            counts[schema + '.' + name] = int(self.pg(container, 'SELECT count(*) FROM "' + schema + '"."' + name + '";'))
        return {'inventory': inventory, 'counts': counts}

    def verify_postgres(self, expected, actual):
        # Keep evidence exactly as read; only the comparison uses visible ranks.
        self.record('postgres-expected-checks.json', expected)
        self.record('postgres-actual-checks.json', actual)
        comparison = postgres_comparison(expected, actual)
        self.record('postgres-comparison.json', comparison)
        self.require(comparison['logicalEqual'], 'PostgreSQL restored schema/counts/journal mismatch')
        return comparison

    def ch_checks(self, container, config=None):
        tables = self.ch_rows(container, "SELECT name,engine,create_table_query FROM system.tables "
                              "WHERE database='analytics' ORDER BY name", config)
        self.require(0 < len(tables) <= 100, 'Unexpected ClickHouse table scope')
        counts = {}
        for table in tables:
            name, engine = table['name'], table['engine']
            self.require(IDENTIFIER.fullmatch(name) and engine in ENGINES and
                         not re.search(r'\b(remote|remoteSecure|url|s3|mysql|postgresql|dictionary)\s*\(',
                                       table['create_table_query'], re.I),
                         'ClickHouse table uses an unreviewed remote or unsupported engine')
            table['create_table_query'] = re.sub(r"\s+UUID\s+'[^']+'", '', table['create_table_query'])
            if engine.endswith('MergeTree'):
                final = '' if engine == 'MergeTree' else ' FINAL'
                counts[name] = int(self.ch(container, 'SELECT count() FROM analytics.`' + name + '`' + final, config))
        return {'tables': tables, 'counts': counts}

    def redis_keyspace(self, container, source=True):
        raw = self.redis(container, 'INFO', 'keyspace', source=source).decode()
        result = {}
        for line in raw.splitlines():
            if not line.startswith('db'):
                continue
            name, values = line.split(':', 1)
            self.require(re.fullmatch(r'db[0-9]{1,3}', name), 'Unsupported Redis database identity')
            values = dict(entry.split('=', 1) for entry in values.strip().split(','))
            result[name] = {'keys': int(values['keys']), 'expires': int(values['expires'])}
        return result

    def redis_modules(self, container, source=True):
        raw = self.redis(container, 'MODULE', 'LIST', source=source, json_output=True)
        self.require(isinstance(raw, list) and len(raw) <= 32, 'Unexpected Redis module inventory')
        modules = []
        for entry in raw:
            if isinstance(entry, list):
                self.require(len(entry) % 2 == 0 and all(isinstance(key, str) for key in entry[::2]) and
                             len(set(entry[::2])) == len(entry) // 2, 'Invalid Redis module fields')
                entry = dict(zip(entry[::2], entry[1::2]))
            self.require(isinstance(entry, dict) and {'name', 'ver', 'path', 'args'} <= set(entry) and
                         isinstance(entry['name'], str) and isinstance(entry['path'], str) and
                         type(entry['ver']) is int and isinstance(entry['args'], list) and
                         all(isinstance(arg, str) for arg in entry['args']), 'Invalid Redis module identity')
            value = dict(entry)
            for relationship in ('using', 'usedby'):
                if relationship in value:
                    self.require(isinstance(value[relationship], list) and
                                 all(isinstance(name, str) for name in value[relationship]),
                                 'Invalid Redis module relationships')
                    value[relationship] = sorted(value[relationship])
            modules.append(value)
        self.require(len({value['name'] for value in modules}) == len(modules), 'Duplicate Redis module names')
        return sorted(modules, key=lambda value: value['name'])

    def capture(self):
        pg, ch, redis = (self.before[name]['id'] for name in ('postgres', 'clickhouse', 'redis'))
        self.require(self.pg(pg, "SELECT count(*) FROM pg_tablespace WHERE pg_tablespace_location(oid) <> '';") == b'0',
                     'External PostgreSQL tablespaces are unsupported')
        self.shell(pg, 'test ! -L /var/lib/postgresql/data/pg_wal')
        self.require(self.pg(pg, "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() "
                             "AND pid<>pg_backend_pid() AND backend_type='client backend';") == b'0',
                     'Other PostgreSQL client sessions remain after stopping applications')
        disks = self.ch_rows(ch, 'SELECT name,path,type FROM system.disks ORDER BY name')
        self.require(disks == [{'name': 'default', 'path': '/var/lib/clickhouse/', 'type': 'Local'}],
                     'External or additional ClickHouse storage is unsupported')
        for sql in ("SELECT count() FROM system.mutations WHERE database='analytics' AND NOT is_done",
                    'SELECT count() FROM system.asynchronous_inserts',
                    "SELECT count() FROM system.dictionaries WHERE database='analytics'",
                    "SELECT count() FROM system.processes WHERE query_id != currentQueryID() "
                    "AND query_kind IN ('Insert','Alter','Delete','Create','Drop','Rename')"):
            self.require(self.ch(ch, sql) == b'0', 'ClickHouse pending work or remote dictionary blocks capture')
        modules = self.redis_modules(redis)
        clients = self.redis(redis, 'CLIENT', 'LIST').decode().splitlines()
        self.require(all(dict(field.split('=', 1) for field in line.split() if '=' in field).get('cmd')
                         in {'client|list', 'ping'} for line in clients),
                     'Other Redis clients remain after stopping applications')
        replication = self.redis(redis, 'INFO', 'replication')
        self.require(b'role:master' in replication and b'connected_slaves:0' in replication,
                     'Redis replication is unsupported in this local drill')
        settings = self.redis(redis, 'CONFIG', 'GET', 'dir', 'dbfilename', json_output=True)
        settings = dict(zip(settings[::2], settings[1::2])) if isinstance(settings, list) else settings
        self.require(settings.get('dir') == '/data' and settings.get('dbfilename') == 'dump.rdb',
                     'Redis persistence path changed')
        pg_bytes = int(self.pg(pg, 'SELECT pg_database_size(current_database());'))
        ch_bytes = int(self.ch(ch, "SELECT coalesce(sum(bytes_on_disk),0) FROM system.parts WHERE active AND database='analytics'"))
        memory = self.redis(redis, 'INFO', 'memory').decode()
        redis_bytes = int(next(line.split(':', 1)[1] for line in memory.splitlines() if line.startswith('used_memory:')))
        self.require(shutil.disk_usage(self.root).free >= 3 * (pg_bytes + ch_bytes + redis_bytes) + 512 * 1024 * 1024,
                     'Insufficient space for backup, restore copies and recovery margin')
        expected = {'postgres': self.pg_checks(pg), 'clickhouse': self.ch_checks(ch),
                    'redis': self.redis_keyspace(redis), 'redisModules': modules}
        self.record('captured-checks.json', expected)
        self.stream(['exec', '-i', pg, 'sh', '-ec',
                     'export PGPASSWORD="$POSTGRES_PASSWORD"; exec pg_dump --no-password '
                     '--username "$POSTGRES_USER" --dbname analytics --format=custom'], self.root / 'postgres.dump')
        self.stream(['exec', '-i', pg, 'sh', '-ec',
                     'export PGPASSWORD="$POSTGRES_PASSWORD"; exec pg_dumpall --no-password '
                     '--username "$POSTGRES_USER" --globals-only'], self.root / 'postgres-globals.sql')
        self.shell(ch, 'test ! -e "$1" && test ! -L "$1"', self.ch_archive)
        self.ch_backup_attempted = True
        result = self.ch(ch, "BACKUP DATABASE analytics TO File('" + self.ch_relative + "') FORMAT JSONEachRow")
        rows = [json.loads(line) for line in result.splitlines() if line]
        self.require(len(rows) == 1 and rows[0].get('status') == 'BACKUP_CREATED', 'ClickHouse backup did not finish')
        self.docker('cp', ch + ':' + self.ch_archive, str(self.root / 'clickhouse.zip'), timeout=TIMEOUT)
        self.require(self.redis(redis, 'SAVE') == b'OK', 'Redis SAVE failed')
        self.docker('cp', redis + ':/data/dump.rdb', str(self.root / 'redis.rdb'), timeout=TIMEOUT)
        artifacts = {}
        for name in ('postgres.dump', 'postgres-globals.sql', 'clickhouse.zip', 'redis.rdb', 'previous.env'):
            path = self.root / name
            self.require(path.is_file() and not path.is_symlink() and path.stat().st_size > 0,
                         'Expected backup artifact is absent or empty')
            os.chmod(path, 0o600)
            artifacts[name] = {'path': name, 'bytes': path.stat().st_size, 'sha256': file_hash(path)}
        self.record('artifacts.json', artifacts)
        self.database_unchanged()
        return expected, artifacts

    def cleanup_source(self):
        ch = self.before['clickhouse']['id']
        if self.ch_backup_attempted:
            self.shell(ch, 'rm -f -- "$1"', self.ch_archive)
            self.ch_backup_attempted = False
        if self.ch_temp_created:
            self.shell(ch, 'if test -d "$1"; then rm -f -- "$1/client.xml"; rmdir -- "$1"; fi', self.source_temp)
            self.ch_temp_created = False
        if self.auth.exists():
            self.auth.unlink()

    def create_target(self, engine, *extra, command=()):
        name = 'wotcv-native-drill-' + self.token + '-' + engine
        volume = name + '-data'
        self.docker('volume', 'create', '--label', 'wotcv.native.drill=' + self.token, volume)
        self.volumes.append(volume)
        raw = self.docker('create', '--name', name, '--label', 'wotcv.native.drill=' + self.token,
                          '--network', 'none', '--restart', 'no', '--memory',
                          '2g' if engine == 'clickhouse' else '1g', '--cpus', '1',
                          '--pids-limit', '256', '--mount',
                          'type=volume,src=' + volume + ',dst=' + self.n.DATABASES[engine],
                          *extra, self.before[engine]['image'], *command)
        container = raw.decode().strip()
        self.require(re.fullmatch(r'[0-9a-f]{64}', container), 'Unexpected drill container identity')
        self.targets.append(container)
        self.drill_history.append({'engine': engine, 'container': container, 'volume': volume,
                                   'image': self.before[engine]['image'], 'network': 'none'})
        item = json.loads(self.docker('inspect', container))[0]
        self.require(item['Image'] == self.before[engine]['image'] and
                     item['HostConfig']['NetworkMode'] == 'none' and
                     not item['HostConfig'].get('PortBindings') and
                     item['HostConfig']['RestartPolicy']['Name'] == 'no' and
                     all(mount.get('Name') not in {self.before[n]['volume']['Name'] for n in self.n.DATABASES}
                         for mount in item['Mounts']), 'Restore target isolation failed')
        return container

    def wait(self, check):
        for _ in range(60):
            try:
                if check():
                    return
            except self.n.Refused:
                pass
            time.sleep(1)
        raise self.n.Refused('Isolated restore target did not become ready')

    def drill(self, expected, artifacts):
        self.step('validating_artifacts')
        for name, artifact in artifacts.items():
            self.require(file_hash(self.root / name) == artifact['sha256'], 'Backup artifact changed before restore')
        admin = 'wotcv_restore_' + self.token
        env = self.root / 'drill-postgres.env'
        self.write(env, 'POSTGRES_USER=' + admin + '\nPOSTGRES_PASSWORD=' + secrets.token_hex(24) + '\nPOSTGRES_DB=postgres\n')
        self.step('postgres_create_target')
        try:
            pg = self.create_target('postgres', '--env-file', str(env))
        finally:
            env.unlink()
        self.docker('start', pg)
        self.step('postgres_wait_tcp')
        # The image's initialization server is socket-only. Authenticated TCP
        # proves the final server has started, before any CREATE or restore.
        self.wait(lambda: self.pg(pg, 'SELECT 1;', 'postgres', tcp=True) == b'1')
        self.step('postgres_create_database')
        self.logged_pg_command(pg, 'export PGPASSWORD="$POSTGRES_PASSWORD"; '
                               'exec psql -X -q --no-password --host 127.0.0.1 --port 5432 '
                               '--username "$POSTGRES_USER" --dbname postgres --set ON_ERROR_STOP=1',
                               'postgres-create-database', data=b'CREATE DATABASE analytics;\n')
        self.step('postgres_copy_archive')
        self.docker('cp', str(self.root / 'postgres.dump'), pg + ':/tmp/restore.dump', timeout=TIMEOUT)
        self.step('postgres_restore')
        self.logged_pg_command(pg, 'export PGPASSWORD="$POSTGRES_PASSWORD"; exec pg_restore --exit-on-error '
                               '--no-owner --no-acl --no-password --host 127.0.0.1 --port 5432 '
                               '--username "$POSTGRES_USER" --dbname analytics /tmp/restore.dump', 'postgres-restore')
        self.step('postgres_verify')
        self.verify_postgres(expected['postgres'], self.pg_checks(pg))
        self.step('postgres_cleanup')
        self.cleanup_targets()
        # File bind is deliberately read-only. Its private ancestor remains 0700;
        # readable staging copies allow the unprivileged ClickHouse process access.
        staged = self.root / 'drill-clickhouse.zip'
        shutil.copyfile(self.root / 'clickhouse.zip', staged)
        os.chmod(staged, 0o644)
        config = self.root / 'drill-clickhouse.xml'
        self.write(config, CH_DRILL_CONFIG)
        os.chmod(config, 0o644)
        env = self.root / 'drill-clickhouse.env'
        password = secrets.token_hex(24)
        self.write(env, 'CLICKHOUSE_USER=default\nCLICKHOUSE_PASSWORD=' + password + '\nCLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1\n')
        self.step('clickhouse_create_target')
        try:
            ch = self.create_target('clickhouse', '--env-file', str(env), '--mount',
                                    'type=bind,src=' + str(staged) + ',dst=/backup/analytics.zip,readonly',
                                    '--mount', 'type=bind,src=' + str(config) +
                                    ',dst=/etc/clickhouse-server/config.d/restore-backup.xml,readonly')
        finally:
            env.unlink()
        self.docker('start', ch)
        client = ET.Element('config')
        ET.SubElement(client, 'user').text = 'default'
        ET.SubElement(client, 'password').text = password
        self.shell(ch, 'umask 077; cat > /tmp/drill-client.xml', data=ET.tostring(client))
        auth = '/tmp/drill-client.xml'
        self.step('clickhouse_wait_ready')
        self.wait(lambda: self.ch(ch, 'SELECT 1', auth) == b'1')
        self.step('clickhouse_restore')
        raw = self.ch(ch, "RESTORE DATABASE analytics FROM File('/backup/analytics.zip') FORMAT JSONEachRow", auth)
        rows = [json.loads(line) for line in raw.splitlines() if line]
        self.require(len(rows) == 1 and rows[0].get('status') == 'RESTORED', 'ClickHouse restore did not finish')
        self.step('clickhouse_verify')
        self.require(self.ch_checks(ch, auth) == expected['clickhouse'], 'ClickHouse restored schema/logical counts mismatch')
        self.step('clickhouse_cleanup')
        self.cleanup_targets()
        self.step('redis_create_target')
        redis = self.create_target('redis', command=('redis-server', '--appendonly', 'no', '--save', '',
                                                   '--dir', '/data', '--dbfilename', 'dump.rdb'))
        # The command is explicit for the RDB-only drill: production AOF is not
        # mounted, replayed, truncated or rewritten.
        self.docker('cp', str(self.root / 'redis.rdb'), redis + ':/data/dump.rdb', timeout=TIMEOUT)
        self.docker('start', redis)
        self.step('redis_wait_ready')
        self.wait(lambda: self.redis(redis, 'PING', source=False) == b'PONG')
        self.step('redis_verify')
        self.require(self.redis_modules(redis, source=False) == expected['redisModules'],
                     'Redis restored engine modules differ from source')
        persistence = self.redis(redis, 'INFO', 'persistence', source=False)
        self.require(b'aof_enabled:0' in persistence and b'loading:0' in persistence, 'Redis RDB-only target mode mismatch')
        restored = self.redis_keyspace(redis, source=False)
        for name in set(expected['redis']) | set(restored):
            before = expected['redis'].get(name, {'keys': 0, 'expires': 0})
            after = restored.get(name, {'keys': 0, 'expires': 0})
            self.require(after['keys'] <= before['keys'] and
                         after['keys'] - after['expires'] == before['keys'] - before['expires'],
                         'Redis restored persistent key count mismatch')
        self.step('complete')
        return {'phase': 'passed', 'postgres': {'schemaCountsJournal': 'passed', 'ownershipAcl': 'not_tested'},
                'clickhouse': {'schemaLogicalCounts': 'passed', 'accessManagement': 'not_tested'},
                'redis': {'rdbLoadPersistentKeys': 'passed', 'moduleInventory': 'passed', 'ttlExpiryAccounted': True},
                'application': 'not_tested', 'network': 'none', 'targets': list(self.drill_history)}

    def cleanup_targets(self):
        # Exact resources created by this run only. No prune, wildcard, or source.
        for container in reversed(self.targets):
            item = json.loads(self.docker('inspect', container))[0]
            self.require(item['Config'].get('Labels', {}).get('wotcv.native.drill') == self.token and
                         item['HostConfig']['NetworkMode'] == 'none', 'Drill cleanup ownership mismatch')
            self.docker('rm', '--force', container)
        self.targets.clear()
        for volume in reversed(self.volumes):
            item = json.loads(self.docker('volume', 'inspect', volume))[0]
            self.require(item.get('Labels', {}).get('wotcv.native.drill') == self.token,
                         'Drill volume cleanup ownership mismatch')
            self.docker('volume', 'rm', volume)
        self.volumes.clear()
        for name in ('drill-postgres.env', 'drill-clickhouse.env'):
            path = self.root / name
            if path.exists():
                path.unlink()

    def stop_failed_targets(self):
        for container in self.targets:
            item = json.loads(self.docker('inspect', container))[0]
            self.require(item['Config'].get('Labels', {}).get('wotcv.native.drill') == self.token and
                         item['HostConfig']['NetworkMode'] == 'none', 'Failed drill ownership mismatch')
            if item['State']['Status'] in {'running', 'restarting'}:
                self.docker('stop', '--time', '60', container, timeout=90)

    def failed_drill(self, error, phase):
        # Save the primary cause before cleanup. A cleanup/reporting failure may
        # not hide the actual isolated step that failed.
        self.best_effort_record('drill-failure.json', failure_evidence(error, self.drill_step))
        self.best_effort_record('status.json', {'phase': phase, 'step': self.drill_step, 'at': utc(),
                                              'targets': list(self.drill_history), 'volumes': list(self.volumes)})
        try:
            self.stop_failed_targets()
        except BaseException as cleanup_error:
            self.best_effort_record('drill-cleanup-failure.json',
                                    failure_evidence(cleanup_error, 'stop_failed_targets'))

    def copy_private(self, source, destination, expected_hash=None):
        self.n.private(source)
        # run_existing_capture already proved the destination root-owned/private.
        self.require(source.resolve() == source and source.stat().st_uid == self.root.stat().st_uid,
                     'Existing capture file is not canonical/root-owned')
        frozen_hash = file_hash(source)
        self.require(expected_hash is None or frozen_hash == expected_hash, 'Existing capture artifact hash changed')
        fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as output, source.open('rb') as original:
            shutil.copyfileobj(original, output, length=1024 * 1024)
            output.flush()
            os.fsync(output.fileno())
        self.require(file_hash(destination) == frozen_hash, 'Existing capture changed while copying')

    def copy_capture(self, prior_capture):
        self.n.receipt_directory(prior_capture)
        source_operation = prior_capture.parent.name
        self.require(prior_capture.name == 'backup' and
                     prior_capture.parent.parent == self.n.STATE / 'release-operations' and
                     re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}', source_operation),
                     'Existing capture is outside the reviewed operation directory')
        raw = self.n.receipt_file(prior_capture / 'artifacts.json')
        artifacts = json.loads(raw)
        self.require(isinstance(artifacts, dict) and set(artifacts) == ARTIFACT_NAMES,
                     'Existing capture artifact scope changed')
        total_bytes = 0
        for name, artifact in artifacts.items():
            self.require(isinstance(artifact, dict) and set(artifact) == {'path', 'bytes', 'sha256'} and
                         artifact['path'] == name and type(artifact['bytes']) is int and artifact['bytes'] > 0 and
                         isinstance(artifact['sha256'], str) and re.fullmatch(r'[0-9a-f]{64}', artifact['sha256']),
                         'Invalid existing capture artifact identity')
            self.require((prior_capture / name).stat().st_size == artifact['bytes'], 'Existing capture artifact size changed')
            total_bytes += artifact['bytes']
        self.require(shutil.disk_usage(self.root).free >= 3 * total_bytes + 512 * 1024 * 1024,
                     'Insufficient space for copied capture and isolated restore')
        for name, artifact in artifacts.items():
            self.copy_private(prior_capture / name, self.root / name, artifact['sha256'])
        for name in ('artifacts.json', 'captured-checks.json', 'compose-0.yml', 'compose-1.yml',
                     'source-configs.json', 'stopped-apps.json'):
            self.require((prior_capture / name).stat().st_size <= 2000000, 'Existing capture metadata is oversized')
            self.copy_private(prior_capture / name, self.root / name)
        source_configs = prior_capture / 'source-configs'
        self.n.receipt_directory(source_configs)
        manifest = json.loads((self.root / 'source-configs.json').read_bytes())
        self.require(isinstance(manifest, list) and len(manifest) <= 32, 'Invalid captured configuration scope')
        names = set()
        for entry in manifest:
            self.require(isinstance(entry, dict) and set(entry) == {'file', 'destination', 'sha256'} and
                         isinstance(entry['file'], str) and re.fullmatch(r'config-[0-9]{1,2}\.xml', entry['file']) and
                         entry['file'] not in names and isinstance(entry['destination'], str) and
                         entry['destination'].startswith('/etc/clickhouse-server/') and
                         isinstance(entry['sha256'], str) and re.fullmatch(r'[0-9a-f]{64}', entry['sha256']),
                         'Invalid captured configuration identity')
            names.add(entry['file'])
        self.require({path.name for path in source_configs.iterdir()} == names, 'Captured configuration inventory changed')
        destination = self.root / 'source-configs'
        destination.mkdir(mode=0o700)
        for entry in manifest:
            self.copy_private(source_configs / entry['file'], destination / entry['file'], entry['sha256'])
        expected = json.loads((self.root / 'captured-checks.json').read_bytes())
        self.require(isinstance(expected, dict) and set(expected) == {'postgres', 'clickhouse', 'redis', 'redisModules'},
                     'Existing captured data checks changed scope')
        return expected, artifacts, source_operation

    def run_existing_capture(self, prior_capture):
        started = utc()
        self.require(hasattr(os, 'geteuid') and os.geteuid() == 0, 'Root isolated drill orchestrator required')
        self.n.private_build_directory(self.root)
        self.require(not any(self.root.iterdir()), 'Resumed drill directory must be new and empty')
        self.require(not (self.n.STATE / 'pending.json').exists() and
                     not (self.n.STATE / 'pending.json').is_symlink(), 'Pending native activation blocks isolated drill')
        environment, _ = self.validate_runtime()
        for name in self.n.DATABASES:
            self.require(self.n.image_info(self.before[name]['image'])['Id'] == self.before[name]['image'],
                         'Source database image is unavailable')
        self.n.readiness()
        try:
            expected, artifacts, source_operation = self.copy_capture(prior_capture)
            self.require((self.root / 'previous.env').read_bytes() == environment.read_bytes(),
                         'Captured and current source environment differ')
            for index, relative in enumerate(('docker-compose.yml', 'ops/minimal/compose.fresh.yml')):
                self.require((self.root / ('compose-' + str(index) + '.yml')).read_bytes() ==
                             (self.n.ROOT / 'source' / relative).read_bytes(), 'Captured source Compose changed')
            self.require(self.n.snapshot() == self.before, 'Source changed while copying existing capture')
            self.progress('backup_restoring_isolated_databases')
            drill = self.drill(expected, artifacts)
            after = self.n.snapshot()
            self.require(after == self.before, 'Source changed during isolated restore of existing capture')
            self.cleanup_targets()
            report = {'schemaVersion': 1, 'phase': 'verified', 'startedAt': started, 'finishedAt': utc(),
                      'captureWindow': {'start': None, 'end': None}, 'sourceOperation': source_operation,
                      'captureMode': 'existing-private-capture-no-source-stop',
                      'before': self.before, 'after': after, 'artifacts': artifacts,
                      'startedOnlyReceiptDrift': {}, 'drill': drill,
                      'limits': list(RESTORE_LIMITS) + ['Original exact capture times are unknown']}
            self.record('verified.json', report)
            self.record('status.json', {'phase': 'verified', 'at': utc()})
            self.progress('backup_verified')
            return report
        except BaseException as error:
            self.failed_drill(error, 'existing_capture_drill_failed_source_not_controlled')
            raise

    def run(self):
        started = utc()
        self.progress('backup_preflight')
        try:
            drift = self.preflight()
        except BaseException:
            if self.before is not None:
                self.cleanup_source()
            raise
        self.record('status.json', {'phase': 'capturing', 'startedAt': started})
        capture_error = None
        cleanup_error = None
        progress_error = None
        recovery_error = None
        try:
            self.progress('backup_stopping_apps')
            self.stop_apps()
            capture_start = utc()
            self.capture_stage = 'capturing'
            self.progress('backup_capturing')
            expected, artifacts = self.capture()
            capture_end = utc()
        except BaseException as exc:
            capture_error = exc
            # Recovery may also fail; preserve the first cause before finally.
            self.best_effort_record('capture-failure.json', failure_evidence(exc, self.capture_stage))
        finally:
            try:
                self.cleanup_source()
            except BaseException as exc:
                cleanup_error = exc
                self.best_effort_record('cleanup-failure.json', failure_evidence(exc, 'cleanup_source'))
            finally:
                try:
                    self.progress('backup_resuming_old_apps')
                except BaseException as exc:
                    progress_error = exc
                    self.best_effort_record('reporting-failure.json', failure_evidence(exc, 'reporting_resume'))
                finally:
                    # Reporting failure must never prevent safe writer recovery.
                    try:
                        after = self.resume_apps()
                    except BaseException as exc:
                        recovery_error = exc
                        self.best_effort_record('recovery-failure.json', failure_evidence(exc, 'resume_old_apps'))
                        self.best_effort_record('status.json',
                                               {'phase': 'source_changed_or_old_apps_resume_failed', 'at': utc()})
        if recovery_error is not None:
            # The separate closed reports retain both errors even when the root
            # wrapper reports only this final failure. Preserve Python's cause too.
            if capture_error is not None:
                raise recovery_error from capture_error
            raise recovery_error
        if capture_error is not None:
            self.best_effort_record('status.json', {'phase': 'capture_failed_old_apps_resumed', 'at': utc()})
            raise capture_error
        if cleanup_error is not None:
            self.best_effort_record('status.json', {'phase': 'cleanup_failed_old_apps_resumed', 'at': utc()})
            raise cleanup_error
        if progress_error is not None:
            self.best_effort_record('status.json', {'phase': 'reporting_failed_old_apps_resumed', 'at': utc()})
            raise progress_error
        self.record('status.json', {'phase': 'drilling_old_apps_resumed', 'at': utc()})
        # Preserve failed drill resources as evidence; remove only after PASS.
        self.progress('backup_restoring_isolated_databases')
        try:
            drill = self.drill(expected, artifacts)
        except BaseException as error:
            self.failed_drill(error, 'drill_failed_old_apps_resumed')
            raise
        self.database_unchanged()
        self.cleanup_targets()
        report = {'schemaVersion': 1, 'phase': 'verified', 'startedAt': started, 'finishedAt': utc(),
                  'captureWindow': {'start': capture_start, 'end': capture_end},
                  'before': self.before, 'after': after, 'artifacts': artifacts,
                  'startedOnlyReceiptDrift': drift, 'drill': drill,
                  'limits': list(RESTORE_LIMITS)}
        self.record('verified.json', report)
        self.record('status.json', {'phase': 'verified', 'at': utc()})
        self.progress('backup_verified')
        return report


def capture_and_drill(native, transaction: Path, progress=None):
    """Called only by the reviewed root orchestrator while both native locks hold."""
    return Backup(native, transaction, progress).run()


def resume_drill(native, new_transaction: Path, prior_capture: Path, progress=None):
    """Caller holds locks and separately verified/superseded the exact old HOLD.

    Copy its private hash-bound artifacts and use new disposable targets only.
    This function never calls source capture, auth creation, stop or start.
    """
    return Backup(native, new_transaction, progress).run_existing_capture(Path(prior_capture))


if __name__ == '__main__':
    raise SystemExit('Use the reviewed locked root orchestrator; no standalone apply interface exists.')
