#!/usr/bin/env python3
"""Quiesced native backups and DB-only restore drill; never applies a release.

The root orchestrator must hold native.locked(root=True). Only existing native
application containers are stopped/started. Source DB containers are never
restarted. Successful return permits further operator gates, not activation.
PostgreSQL ownership/ACL recreation and authenticated application recovery are
explicitly outside this DB-only drill. Globals/env/config are retained privately.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import time
import xml.etree.ElementTree as ET


IDENTIFIER = re.compile(r'[A-Za-z_][A-Za-z0-9_]{0,126}\Z')
ENGINES = {'MergeTree', 'ReplacingMergeTree', 'AggregatingMergeTree', 'SummingMergeTree',
           'MaterializedView', 'View'}
TIMEOUT = 600
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

    def require(self, condition, message):
        self.n.require(condition, message)

    def write(self, path, data):
        self.n.write(path, data)

    def record(self, name, value):
        self.n.record(self.root / name, value)

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

    def pg(self, container, sql, database='analytics'):
        self.require(IDENTIFIER.fullmatch(database), 'Unsupported PostgreSQL database identifier')
        return self.shell(container,
                          'export PGPASSWORD="$POSTGRES_PASSWORD"; '
                          'exec psql -X -qAt --no-password --username "$POSTGRES_USER" '
                          '--dbname "$1" --set ON_ERROR_STOP=1', database,
                          data=sql.encode(), timeout=120).strip()

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
            self.stopped.append(name)
            self.docker('stop', '--time', '60', self.before[name]['id'], timeout=90)
            state = json.loads(self.docker('inspect', self.before[name]['id']))[0]['State']
            self.require(state['Status'] == 'exited' and state['ExitCode'] == 0 and not state.get('OOMKilled'),
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
        for name, artifact in artifacts.items():
            self.require(file_hash(self.root / name) == artifact['sha256'], 'Backup artifact changed before restore')
        admin = 'wotcv_restore_' + self.token
        env = self.root / 'drill-postgres.env'
        self.write(env, 'POSTGRES_USER=' + admin + '\nPOSTGRES_PASSWORD=' + secrets.token_hex(24) + '\nPOSTGRES_DB=postgres\n')
        try:
            pg = self.create_target('postgres', '--env-file', str(env))
        finally:
            env.unlink()
        self.docker('start', pg)
        self.wait(lambda: self.pg(pg, 'SELECT 1;', 'postgres') == b'1')
        self.pg(pg, 'CREATE DATABASE analytics;', 'postgres')
        self.docker('cp', str(self.root / 'postgres.dump'), pg + ':/tmp/restore.dump', timeout=TIMEOUT)
        self.shell(pg, 'export PGPASSWORD="$POSTGRES_PASSWORD"; exec pg_restore --exit-on-error '
                   '--no-owner --no-acl --no-password --username "$POSTGRES_USER" --dbname analytics /tmp/restore.dump',
                   timeout=TIMEOUT)
        self.require(self.pg_checks(pg) == expected['postgres'], 'PostgreSQL restored schema/counts/journal mismatch')
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
        self.wait(lambda: self.ch(ch, 'SELECT 1', auth) == b'1')
        raw = self.ch(ch, "RESTORE DATABASE analytics FROM File('/backup/analytics.zip') FORMAT JSONEachRow", auth)
        rows = [json.loads(line) for line in raw.splitlines() if line]
        self.require(len(rows) == 1 and rows[0].get('status') == 'RESTORED', 'ClickHouse restore did not finish')
        self.require(self.ch_checks(ch, auth) == expected['clickhouse'], 'ClickHouse restored schema/logical counts mismatch')
        self.cleanup_targets()
        redis = self.create_target('redis', command=('redis-server', '--appendonly', 'no', '--save', '',
                                                   '--dir', '/data', '--dbfilename', 'dump.rdb'))
        # The command is explicit for the RDB-only drill: production AOF is not
        # mounted, replayed, truncated or rewritten.
        self.docker('cp', str(self.root / 'redis.rdb'), redis + ':/data/dump.rdb', timeout=TIMEOUT)
        self.docker('start', redis)
        self.wait(lambda: self.redis(redis, 'PING', source=False) == b'PONG')
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
            if item['State']['Status'] == 'running':
                self.docker('stop', '--time', '60', container, timeout=90)

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
        try:
            self.progress('backup_stopping_apps')
            self.stop_apps()
            capture_start = utc()
            self.progress('backup_capturing')
            expected, artifacts = self.capture()
            capture_end = utc()
        except BaseException as exc:
            capture_error = exc
        finally:
            try:
                self.cleanup_source()
            finally:
                try:
                    self.progress('backup_resuming_old_apps')
                finally:
                    # Reporting failure must never prevent safe writer recovery.
                    try:
                        after = self.resume_apps()
                    except BaseException:
                        self.record('status.json', {'phase': 'source_changed_or_old_apps_resume_failed', 'at': utc()})
                        raise
        if capture_error is not None:
            self.record('status.json', {'phase': 'capture_failed_old_apps_resumed', 'at': utc()})
            raise capture_error
        self.record('status.json', {'phase': 'drilling_old_apps_resumed', 'at': utc()})
        # Preserve failed drill resources as evidence; remove only after PASS.
        self.progress('backup_restoring_isolated_databases')
        try:
            drill = self.drill(expected, artifacts)
        except BaseException:
            self.record('status.json', {'phase': 'drill_failed_old_apps_resumed', 'at': utc(),
                                        'targets': list(self.drill_history), 'volumes': list(self.volumes)})
            self.stop_failed_targets()
            raise
        self.database_unchanged()
        self.cleanup_targets()
        report = {'schemaVersion': 1, 'phase': 'verified', 'startedAt': started, 'finishedAt': utc(),
                  'captureWindow': {'start': capture_start, 'end': capture_end},
                  'before': self.before, 'after': after, 'artifacts': artifacts,
                  'startedOnlyReceiptDrift': drift, 'drill': drill,
                  'limits': ['No application recovery test', 'PostgreSQL roles/ownership/ACL not replayed',
                             'ClickHouse SQL access management not restored by database-only archive',
                             'Local backup does not cover loss of this host',
                             'Image rollback preserves later writes; data restore requires separate recovery decision']}
        self.record('verified.json', report)
        self.record('status.json', {'phase': 'verified', 'at': utc()})
        self.progress('backup_verified')
        return report


def capture_and_drill(native, transaction: Path, progress=None):
    """Called only by the reviewed root orchestrator while both native locks hold."""
    return Backup(native, transaction, progress).run()


if __name__ == '__main__':
    raise SystemExit('Use the reviewed locked root orchestrator; no standalone apply interface exists.')
