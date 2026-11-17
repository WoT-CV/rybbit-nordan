#!/usr/bin/env python3
"""Evidence-only inspection of one retained isolated PostgreSQL restore.

Never restores data, changes acceptance, supersedes pending or controls source
writers. Full checks and query stderr stay private; public output has no values.
"""
import argparse
from collections import Counter
from contextlib import contextmanager
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import signal
import subprocess
import sys
import time
from types import ModuleType


ACK = 'inspect-isolated-pg-restore'
HEX = re.compile(r'[0-9a-f]{64}\Z')
IDENT = re.compile(r'[A-Za-z_][A-Za-z0-9_]{0,126}\Z')
OP = re.compile(r'[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}\Z')
FIELDS = {'version', 'packetDirectory', 'updaterSha256', 'backupSha256', 'operation', 'releaseSha',
          'pendingSha256', 'failureSha256', 'sourceRuntimeSha256', 'sourceOperation', 'clone'}
ARTIFACTS = {'postgres.dump', 'postgres-globals.sql', 'clickhouse.zip', 'redis.rdb', 'previous.env'}
SECTIONS = {'columns': ('table_schema', 'table_name', 'column_name'),
            'constraints': ('schema', 'name', 'conname'),
            'indexes': ('schemaname', 'tablename', 'indexname'), 'journal': ('id',)}
SECTION_FIELDS = {'columns': {'table_schema', 'table_name', 'column_name', 'ordinal_position', 'data_type',
                              'udt_name', 'is_nullable', 'column_default'},
                  'constraints': {'schema', 'name', 'conname', 'definition'},
                  'indexes': {'schemaname', 'tablename', 'indexname', 'indexdef'},
                  'journal': {'id', 'hash', 'created_at'}}
TABLES_SQL = ("SELECT coalesce(json_agg(row_to_json(x)), '[]') FROM "
              "(SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN "
              "('public','drizzle') ORDER BY 1,2) x;")


class Refused(RuntimeError):
    pass


class BudgetExpired(RuntimeError):
    """Separate from readiness Refused so a TCP retry cannot swallow deadlines."""
    pass


def require(condition, message):
    if not condition:
        raise Refused(message)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True)


def checksum(raw):
    return hashlib.sha256(raw).hexdigest()


def private_dir(path):
    require(path.is_dir() and not path.is_symlink() and path.resolve() == path and
            path.stat().st_uid == 0 and path.stat().st_mode & 0o077 == 0, 'Expected root-private canonical directory')


def private_file(path, limit=2000000):
    require(path.is_file() and not path.is_symlink() and path.resolve() == path and
            path.stat().st_uid == 0 and path.stat().st_mode & 0o077 == 0 and path.stat().st_size <= limit,
            'Expected bounded root-private canonical file')
    return path.read_bytes()


def unique_json(raw):
    def unique(pairs):
        value = {}
        for key, item in pairs:
            require(key not in value, 'Duplicate diagnostic JSON field')
            value[key] = item
        return value
    return json.loads(raw, object_pairs_hook=unique)


def load_packet(contract_path, expected_hash):
    require(hasattr(os, 'geteuid') and os.geteuid() == 0, 'Diagnostic requires operator root')
    require(isinstance(expected_hash, str) and HEX.fullmatch(expected_hash), 'Reviewed diagnostic contract hash required')
    private_dir(contract_path.parent)
    raw = private_file(contract_path, 131072)
    require(checksum(raw) == expected_hash, 'Diagnostic contract hash changed')
    contract = unique_json(raw)
    require(isinstance(contract, dict) and set(contract) == FIELDS and type(contract['version']) is int and
            contract['version'] == 1 and isinstance(contract['packetDirectory'], str) and
            Path(contract['packetDirectory']).is_absolute() and
            all(isinstance(contract[key], str) and HEX.fullmatch(contract[key]) for key in
                ('updaterSha256', 'backupSha256', 'pendingSha256', 'failureSha256', 'sourceRuntimeSha256')) and
            all(isinstance(contract[key], str) and OP.fullmatch(contract[key]) for key in ('operation', 'sourceOperation')) and
            isinstance(contract['releaseSha'], str) and re.fullmatch(r'[0-9a-f]{40}', contract['releaseSha']),
            'Invalid diagnostic contract')
    target = contract['clone']
    require(isinstance(target, dict) and set(target) == {'token', 'container', 'volume', 'image', 'exitCode', 'oomKilled'} and
            isinstance(target['token'], str) and re.fullmatch(r'[0-9a-f]{16}', target['token']) and
            isinstance(target['container'], str) and HEX.fullmatch(target['container']) and
            target['volume'] == 'wotcv-native-drill-' + target['token'] + '-postgres-data' and
            isinstance(target['image'], str) and re.fullmatch(r'sha256:[0-9a-f]{64}', target['image']) and
            type(target['exitCode']) is int and target['exitCode'] == 0 and target['oomKilled'] is False,
            'Invalid retained diagnostic clone')
    packet = Path(contract['packetDirectory'])
    private_dir(packet)
    tools = []
    for filename, key in (('wotcv-native-update.py', 'updaterSha256'), ('wotcv-native-backup.py', 'backupSha256')):
        path = packet / filename
        body = private_file(path)
        require(checksum(body) == contract[key], 'Reviewed diagnostic library changed')
        tools.append((path, body))
    # Compile only the exact bytes already checked, rather than reopening paths.
    modules = []
    for index, (path, body) in enumerate(tools):
        module = ModuleType('reviewed_pg_diagnostic_' + str(index))
        module.__file__ = str(path)
        exec(compile(body, str(path), 'exec'), module.__dict__)
        modules.append(module)
    return contract, modules[0], modules[1]


@contextmanager
def wall_budget(seconds, reserve=0):
    """Nested POSIX deadlines reserve cleanup time without altering native APIs."""
    if not hasattr(signal, 'setitimer'):
        yield
        return
    previous = signal.getitimer(signal.ITIMER_REAL)
    if previous[0] > 0:
        require(previous[0] > reserve, 'Diagnostic cleanup reserve exhausted')
        seconds = min(seconds, previous[0] - reserve)
    handler = signal.getsignal(signal.SIGALRM)
    started = time.monotonic()
    def expired(signum, frame):
        raise BudgetExpired('Diagnostic time budget exhausted')
    signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, handler)
        if previous[0] > 0:
            signal.setitimer(signal.ITIMER_REAL, max(0.001, previous[0] - (time.monotonic() - started)), previous[1])


def section_summary(expected, actual, identifiers, limit=100):
    result = {'equal': expected == actual,
              'expectedSha256': checksum(canonical(expected).encode()),
              'actualSha256': checksum(canonical(actual).encode()),
              'expectedItems': len(expected), 'actualItems': len(actual)}
    if isinstance(expected, list) and isinstance(actual, list):
        result['sameRowsIgnoringOrder'] = Counter(map(canonical, expected)) == Counter(map(canonical, actual))
        left = {tuple(row.get(key) for key in identifiers): row for row in expected}
        right = {tuple(row.get(key) for key in identifiers): row for row in actual}
        require(len(left) == len(expected) and len(right) == len(actual), 'Duplicate diagnostic catalog identity')
        differences = []
        for identity in sorted(set(left) | set(right), key=lambda value: canonical(value)):
            if left.get(identity) == right.get(identity):
                continue
            fields = sorted(key for key in set(left.get(identity, {})) | set(right.get(identity, {}))
                            if left.get(identity, {}).get(key) != right.get(identity, {}).get(key))
            safe = [value if isinstance(value, str) and IDENT.fullmatch(value) else '[redacted]'
                    for value in identity]
            differences.append({'identity': safe, 'fields': fields,
                                'expectedPresent': identity in left, 'actualPresent': identity in right})
        result['differentItems'] = len(differences)
        result['differences'] = differences[:limit]
    else:
        keys = sorted(key for key in set(expected) | set(actual) if expected.get(key) != actual.get(key))
        result['differentItems'] = len(keys)
        result['differentTables'] = [key if isinstance(key, str) and
            all(IDENT.fullmatch(part) for part in key.split('.')) and len(key.split('.')) == 2 else '[redacted]'
            for key in keys[:limit]]
    return result


def compare_checks(expected, actual):
    for checks in (expected, actual):
        require(isinstance(checks, dict) and set(checks) == {'inventory', 'counts'} and
                isinstance(checks['inventory'], dict) and set(checks['inventory']) == set(SECTIONS) and
                isinstance(checks['counts'], dict) and
                all(type(value) is int and value >= 0 for value in checks['counts'].values()), 'Invalid PostgreSQL check scope')
        for section in SECTIONS:
            rows = checks['inventory'][section]
            require(isinstance(rows, list) and len(rows) <= 10000 and
                    all(isinstance(row, dict) and set(row) == SECTION_FIELDS[section] for row in rows),
                    'Invalid PostgreSQL inventory shape')
    result = {'phase': 'HOLD', 'diagnosticOnly': True, 'acceptanceChanged': False,
              'equal': expected == actual, 'sections': {}}
    identifier_budget = 100
    for section, keys in SECTIONS.items():
        summary = section_summary(expected['inventory'][section], actual['inventory'][section], keys,
                                  identifier_budget // len(keys))
        identifier_budget -= len(summary.get('differences', [])) * len(keys)
        result['sections'][section] = summary
    result['sections']['counts'] = section_summary(expected['counts'], actual['counts'], (), identifier_budget // 2)
    left, right = expected['inventory']['columns'], actual['inventory']['columns']
    def without_ordinal(rows):
        return Counter(canonical({key: value for key, value in row.items() if key != 'ordinal_position'}) for row in rows)
    def visible_order(rows):
        require(all(type(row['ordinal_position']) is int and row['ordinal_position'] > 0 for row in rows),
                'Invalid column ordinal metadata')
        return [(row['table_schema'], row['table_name'], row['column_name']) for row in sorted(rows,
            key=lambda row: (row['table_schema'], row['table_name'], row['ordinal_position']))]
    result['sameColumnRowsWithoutPhysicalOrdinal'] = without_ordinal(left) == without_ordinal(right)
    result['columnVisibleOrderMatches'] = visible_order(left) == visible_order(right)
    # These booleans explain a difference; they are never used to approve it.
    return result


def clone_state(native, contract, source, *, stopped):
    target = contract['clone']
    item = json.loads(native.docker('inspect', target['container'], timeout=10))[0]
    labels = item['Config'].get('Labels') or {}
    state = item['State']
    require(item['Id'] == target['container'] and item['Image'] == target['image'] == source['postgres']['image'] and
            item.get('Name') == '/wotcv-native-drill-' + target['token'] + '-postgres' and
            labels.get('wotcv.native.drill') == target['token'] and
            item['HostConfig']['NetworkMode'] == 'none' and not item['HostConfig'].get('PortBindings') and
            item['HostConfig']['RestartPolicy']['Name'] == 'no' and not state.get('OOMKilled'), 'Retained clone identity changed')
    if stopped:
        require(state['Status'] == 'exited' and not state.get('Running') and not state.get('Restarting') and
                type(state['ExitCode']) is int and state['ExitCode'] == 0, 'Retained clone is not cleanly stopped')
    mounts = item.get('Mounts', [])
    require(len(mounts) == 1 and mounts[0].get('Type') == 'volume' and mounts[0].get('Name') == target['volume'] and
            mounts[0].get('Destination') == native.DATABASES['postgres'] and mounts[0].get('RW') is True and
            target['volume'] not in {source[name]['volume']['Name'] for name in native.DATABASES}, 'Retained clone storage changed')
    volume = json.loads(native.docker('volume', 'inspect', target['volume'], timeout=10))[0]
    require(volume.get('Driver') == 'local' and not volume.get('Options') and
            (volume.get('Labels') or {}).get('wotcv.native.drill') == target['token'], 'Retained clone volume ownership changed')
    consumers = native.docker('ps', '-aq', '--filter', 'volume=' + target['volume'], timeout=10).decode().split()
    require(len(consumers) == 1 and target['container'].startswith(consumers[0]), 'Retained clone has another storage consumer')


def check_capture(native, contract, capture):
    original = native.STATE / 'release-operations' / contract['sourceOperation'] / 'backup'
    native.receipt_directory(original)
    raw = native.receipt_file(capture / 'captured-checks.json')
    require(raw == native.receipt_file(original / 'captured-checks.json'), 'Copied and original captured checks differ')
    manifests = [unique_json(native.receipt_file(path / 'artifacts.json')) for path in (capture, original)]
    require(manifests[0] == manifests[1] and set(manifests[0]) == ARTIFACTS, 'Copied and original artifact manifests differ')
    for name, entry in manifests[0].items():
        require(isinstance(entry, dict) and set(entry) == {'path', 'bytes', 'sha256'} and entry['path'] == name and
                type(entry['bytes']) is int and entry['bytes'] > 0 and isinstance(entry['sha256'], str) and HEX.fullmatch(entry['sha256']),
                'Invalid copied capture artifact identity')
        for path in (capture / name, original / name):
            native.private(path)
            require(path.resolve() == path and path.stat().st_uid == 0 and path.stat().st_size == entry['bytes'],
                    'Capture artifact ownership or size changed')
        value = hashlib.sha256()
        with (capture / name).open('rb') as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                value.update(chunk)
        require(value.hexdigest() == entry['sha256'], 'Copied capture artifact hash changed')
    checks = unique_json(raw)
    require(isinstance(checks, dict) and set(checks) == {'postgres', 'clickhouse', 'redis', 'redisModules'}, 'Captured check scope changed')
    return raw, checks['postgres']


def inspect(native, backup, contract):
    with native.locked(root=True), wall_budget(180):
        private_dir(native.STATE)
        pending = native.STATE / 'release-operations/pending.json'
        pending_raw = native.receipt_file(pending)
        require(checksum(pending_raw) == contract['pendingSha256'] and unique_json(pending_raw) == {
            'operation': contract['operation'], 'releaseSha': contract['releaseSha']}, 'Diagnostic pending evidence changed')
        require(not (native.STATE / 'pending.json').exists() and not (native.STATE / 'pending.json').is_symlink(),
                'Native activation is pending')
        operation = native.STATE / 'release-operations' / contract['operation']
        native.receipt_directory(operation)
        failure_raw = native.receipt_file(operation / 'failure.json')
        require(checksum(failure_raw) == contract['failureSha256'], 'Diagnostic failure evidence changed')
        failure = unique_json(failure_raw)
        require(failure.get('phase') == 'backup_restoring_isolated_databases' and failure.get('errorType') == 'Refused',
                'Failure is outside isolated PostgreSQL inspection scope')
        capture = operation / 'backup'
        native.receipt_directory(capture)
        status = unique_json(native.receipt_file(capture / 'status.json'))
        drill = unique_json(native.receipt_file(capture / 'drill-status.json'))
        cause = unique_json(native.receipt_file(capture / 'drill-failure.json'))
        target = contract['clone']
        expected_target = {'engine': 'postgres', 'container': target['container'], 'volume': target['volume'],
                           'image': target['image'], 'network': 'none'}
        require(status.get('phase') == 'existing_capture_drill_failed_source_not_controlled' and
                status.get('step') == drill.get('step') == cause.get('phase') == 'postgres_verify' and
                status.get('targets') == [expected_target] and status.get('volumes') == [target['volume']] and
                cause.get('errorType') == 'Refused', 'Failed isolated step differs from reviewed diagnostic')
        for name, step in (('postgres-create-database', 'postgres_create_database'), ('postgres-restore', 'postgres_restore')):
            result = unique_json(native.receipt_file(capture / (name + '.result.json')))
            require(result.get('step') == step and type(result.get('returnCode')) is int and result['returnCode'] == 0 and
                    result.get('timedOut') is False, 'Retained CREATE or restore did not complete successfully')
        before = native.snapshot()
        require(native.canonical_hash(before) == contract['sourceRuntimeSha256'], 'Source runtime changed before diagnostic')
        native.receipt_guard(before)
        environment = native.current_env()
        model = native.config(environment)
        native.model_guard(model, before)
        native.verify_model_live(model, before)
        native.readiness()
        raw_checks, expected = check_capture(native, contract, capture)
        clone_state(native, contract, before, stopped=True)
        diagnostics = native.STATE / 'diagnostics'
        diagnostics.mkdir(mode=0o700, exist_ok=True)
        private_dir(diagnostics)
        directory = diagnostics / (contract['operation'] + '.' + time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '.' + secrets.token_hex(4))
        directory.mkdir(mode=0o700)
        private_dir(directory)
        native.write(directory / 'expected-checks.json', raw_checks)
        checker = backup.Backup(native, directory)
        query_number = 0
        def readonly_pg(container, sql, database='analytics', *, tcp=False):
            nonlocal query_number
            require(container == target['container'] and database in {'postgres', 'analytics'}, 'Read-only query target changed')
            count = re.fullmatch(r'SELECT count\(\*\) FROM "(public|drizzle)"\."([A-Za-z_][A-Za-z0-9_]{0,126})";', sql)
            require(sql in {backup.PG_INVENTORY, TABLES_SQL, 'SELECT 1;'} or count is not None,
                    'Diagnostic permits fixed SELECT queries only')
            query_number += 1
            path = directory / ('query-' + str(query_number) + '.stderr.log')
            script = ('export PGPASSWORD="$POSTGRES_PASSWORD"; '
                      'export PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=30000 -c lock_timeout=5000"; '
                      'exec psql -X -qAt --no-password --host 127.0.0.1 --port 5432 '
                      '--username "$POSTGRES_USER" --dbname "$1" --set ON_ERROR_STOP=1')
            with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'wb') as stderr:
                completed = subprocess.run([*native.DOCKER, 'exec', '-i', container, 'sh', '-ec', script, 'sh', database],
                                           input=sql.encode(), env=native.safe_env(), stdout=subprocess.PIPE,
                                           stderr=stderr, timeout=35, check=False)
            native.record(directory / ('query-' + str(query_number) + '.result.json'), {'returnCode': completed.returncode})
            require(completed.returncode == 0 and len(completed.stdout) <= 2000000, 'Read-only clone query failed or exceeded output bound')
            return completed.stdout.strip()
        def forbidden(*args, **kwargs):
            raise Refused('Diagnostic object cannot control containers or issue shell commands')
        checker.pg = readonly_pg
        checker.shell = forbidden
        checker.docker = forbidden
        started = False
        comparison = None
        error = None
        cleanup_errors = []
        try:
            # Reserve 80 s: mandatory exact-ID stop/readback <= 30 s, source
            # recheck <= 35 s, leaving margin for reports within outer 180 s.
            with wall_budget(90, reserve=80):
                # Track attempted start too; a failing CLI may already start it.
                started = True
                native.docker('start', target['container'], timeout=15)
                for attempt in range(30):
                    try:
                        if readonly_pg(target['container'], 'SELECT 1;', 'postgres', tcp=True) == b'1':
                            break
                    except Refused:
                        if attempt == 29:
                            raise
                    time.sleep(1)
                else:
                    raise Refused('Retained clone TCP readiness timed out')
                actual = checker.pg_checks(target['container'])
                native.record(directory / 'actual-checks.json', actual)
                comparison = compare_checks(expected, actual)
        except BaseException as exc:
            error = exc
        finally:
            if started:
                try:
                    with wall_budget(35):
                        # This immutable full ID was fully verified immediately
                        # before our start. Do not spend the cleanup reserve on
                        # three preliminary metadata calls before attempting stop.
                        native.docker('stop', '--time', '20', target['container'], timeout=25)
                        final = json.loads(native.docker('inspect', target['container'], timeout=5))[0]
                        require(final['Id'] == target['container'] and final['Image'] == target['image'] and
                                (final['Config'].get('Labels') or {}).get('wotcv.native.drill') == target['token'] and
                                final['State']['Status'] == 'exited' and not final['State'].get('Running') and
                                not final['State'].get('Restarting') and final['State']['ExitCode'] == 0 and
                                final['State'].get('OOMKilled') is False, 'Diagnostic clone stop was not confirmed')
                except BaseException:
                    cleanup_errors.append('clone-stop-or-state-unverified')
            try:
                with wall_budget(35):
                    require(native.snapshot() == before, 'Source changed during diagnostic')
                    require(native.receipt_file(pending) == pending_raw and
                            native.receipt_file(operation / 'failure.json') == failure_raw, 'Owning transaction evidence changed')
                    native.readiness()
            except BaseException:
                cleanup_errors.append('source-or-pending-unverified')
            report = {'phase': 'HOLD', 'diagnosticOnly': True, 'acceptanceChanged': False,
                      'operation': contract['operation'], 'diagnosticDirectory': str(directory),
                      'inspectionComplete': comparison is not None and error is None and not cleanup_errors,
                      'comparison': comparison, 'cleanup': cleanup_errors,
                      'errorType': type(error).__name__ if error is not None else None,
                      'restore': 'NOT_PERFORMED', 'activation': 'NOT_PERFORMED', 'sourceWriterControl': 'NOT_PERFORMED'}
            native.record(directory / 'report.json', report)
        print(json.dumps(report), flush=True)
        require(report['inspectionComplete'], 'Diagnostic incomplete; inspect private report')
        return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--contract', required=True, type=Path)
    parser.add_argument('--contract-sha256', required=True)
    parser.add_argument('--ack', required=True)
    args = parser.parse_args()
    require(args.ack == ACK, 'Explicit isolated inspection acknowledgment required')
    contract, native, backup = load_packet(args.contract, args.contract_sha256)
    inspect(native, backup, contract)


if __name__ == '__main__':
    sys.dont_write_bytecode = True
    try:
        main()
    except (Exception, KeyboardInterrupt) as error:
        sites = []
        trace = error.__traceback__
        while trace:
            filename = Path(trace.tb_frame.f_code.co_filename).name
            if filename in {'wotcv-native-pg-diagnostic.py', 'wotcv-native-update.py', 'wotcv-native-backup.py'}:
                sites.append({'file': filename, 'line': trace.tb_lineno})
            trace = trace.tb_next
        print(json.dumps({'phase': 'HOLD', 'inspectionComplete': False, 'errorType': type(error).__name__,
                          'sites': sites[-16:],
                          'message': 'Diagnostic stopped; no acceptance or deployment was authorized.'}), flush=True)
        raise SystemExit(1) from None
