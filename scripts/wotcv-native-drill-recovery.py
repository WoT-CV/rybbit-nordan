#!/usr/bin/env python3
"""Validate one retained capture and supersede its failed isolated PG drill.

The reviewed launcher holds both deployment locks. This module only inspects
the preserved failed clone, never starts/deletes it or stops source writers.
Successful return selects existing capture bytes for a new isolated drill.
"""
from datetime import datetime
import hashlib
import json
from pathlib import Path
import re


OPERATION = re.compile(r'[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}\Z')
SHA = re.compile(r'[0-9a-f]{40}\Z')
HEX = re.compile(r'[0-9a-f]{64}\Z')
IMAGE = re.compile(r'sha256:[0-9a-f]{64}\Z')
STAMP = re.compile(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z\Z')
ARTIFACTS = {'postgres.dump', 'postgres-globals.sql', 'clickhouse.zip', 'redis.rdb', 'previous.env'}
INVENTORY = ARTIFACTS | {'postgres.dump.stderr', 'postgres-globals.sql.stderr', 'captured-checks.json',
                         'artifacts.json', 'stopped-apps.json', 'status.json', 'compose-0.yml',
                         'compose-1.yml', 'source-configs.json', 'source-configs'}
FIELDS = {'version', 'failedOperation', 'failedReleaseSha', 'failedPendingSha256', 'failedFailureSha256',
          'priorPacketDirectory', 'priorUpdaterSha256', 'priorBackupSha256', 'runtimeSha256',
          'restartContractSha256', 'failedDrill'}
VERIFIED_FIELDS = {'originOperation', 'originReleaseSha', 'priorDrillRecoverySha256',
                   'priorDrillRecoveryContractSha256', 'diagnosticDirectory', 'diagnosticReportSha256'}
RESUMED_INVENTORY = (INVENTORY - {'postgres.dump.stderr', 'postgres-globals.sql.stderr'}) | {
    'drill-status.json', 'drill-failure.json'} | {
    tag + suffix for tag in ('postgres-create-database', 'postgres-restore')
    for suffix in ('.stdout.log', '.stderr.log', '.result.json')}


def sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def digest_proof(role, raw, expected):
    """Only byte identities are public; neither file bytes nor errors are emitted."""
    observed = sha256(raw)
    print(json.dumps({'check': 'retained-' + role, 'expectedSha256': expected,
                      'actualSha256': observed, 'bytes': len(raw), 'matches': observed == expected}), flush=True)
    return observed


def read_json(native, path):
    raw = native.receipt_file(path)
    return raw, native.reconciliation_json(raw)


def absent(native, path):
    native.require(not path.exists() and not path.is_symlink(), 'Pending transaction requires inspection')


def contract_for(native, packet_root, manifest):
    raw = native.receipt_file(packet_root / 'drill-recovery-20261117.json')
    native.require(len(raw) <= 131072 and sha256(raw) == manifest['files']['drillRecoveryContract'],
                   'Reviewed drill recovery contract size or hash changed')
    contract = native.reconciliation_json(raw)
    native.require(isinstance(contract, dict) and type(contract.get('version')) is int and
                   contract['version'] in (1, 2) and
                   set(contract) == (FIELDS if contract['version'] == 1 else FIELDS | {'verifiedCapture'}) and
                   isinstance(contract['failedOperation'], str) and OPERATION.fullmatch(contract['failedOperation']) and
                   isinstance(contract['failedReleaseSha'], str) and SHA.fullmatch(contract['failedReleaseSha']) and
                   isinstance(contract['priorPacketDirectory'], str) and Path(contract['priorPacketDirectory']).is_absolute() and
                   all(isinstance(contract[key], str) and HEX.fullmatch(contract[key]) for key in
                       ('failedPendingSha256', 'failedFailureSha256', 'priorUpdaterSha256', 'priorBackupSha256',
                        'runtimeSha256', 'restartContractSha256')),
                   'Invalid reviewed drill recovery contract')
    target = contract['failedDrill']
    native.require(isinstance(target, dict) and set(target) == {'token', 'container', 'volume', 'image', 'exitCode', 'oomKilled'} and
                   isinstance(target['token'], str) and re.fullmatch(r'[0-9a-f]{16}', target['token']) and
                   isinstance(target['container'], str) and HEX.fullmatch(target['container']) and
                   target['volume'] == 'wotcv-native-drill-' + target['token'] + '-postgres-data' and
                   isinstance(target['image'], str) and IMAGE.fullmatch(target['image']) and
                   type(target['exitCode']) is int and target['exitCode'] == (137 if contract['version'] == 1 else 0) and
                   target['oomKilled'] is False,
                   'Invalid reviewed failed PostgreSQL clone')
    native.require(contract['restartContractSha256'] == manifest['files']['restartContract'] and
                   contract['priorUpdaterSha256'] == manifest['files']['updater'] and
                   sha256(Path(__file__).read_bytes()) == manifest['files']['drillRecovery'],
                   'Reviewed drill recovery tools or restart contract changed')
    prior = Path(contract['priorPacketDirectory'])
    native.receipt_directory(prior)
    for filename, expected in (('wotcv-native-backup.py', contract['priorBackupSha256']),
                               ('wotcv-native-update.py', contract['priorUpdaterSha256'])):
        native.require(sha256(native.receipt_file(prior / filename)) == expected,
                       'Retained failed packet tool bytes changed')
    if contract['version'] == 2:
        proof = contract['verifiedCapture']
        native.require(isinstance(proof, dict) and set(proof) == VERIFIED_FIELDS and
                       isinstance(proof['originOperation'], str) and OPERATION.fullmatch(proof['originOperation']) and
                       proof['originOperation'] != contract['failedOperation'] and
                       isinstance(proof['originReleaseSha'], str) and SHA.fullmatch(proof['originReleaseSha']) and
                       all(isinstance(proof[key], str) and HEX.fullmatch(proof[key]) for key in
                           ('priorDrillRecoverySha256', 'priorDrillRecoveryContractSha256', 'diagnosticReportSha256')) and
                       isinstance(proof['diagnosticDirectory'], str) and Path(proof['diagnosticDirectory']).is_absolute(),
                       'Invalid reviewed PostgreSQL verification provenance')
        for filename, key in (('wotcv-native-drill-recovery.py', 'priorDrillRecoverySha256'),
                              ('drill-recovery-20261117.json', 'priorDrillRecoveryContractSha256')):
            native.require(sha256(native.receipt_file(prior / filename)) == proof[key],
                           'Prior drill recovery packet bytes changed')
    return contract


def historical_attestation(native, original, state, active_hash, success_hash, live, contract, restart_raw, restart):
    _, summary = read_json(native, original / 'reconciliation.json')
    database_hash = native.canonical_hash(native.database_runtime(live))
    native.require(isinstance(summary, dict) and set(summary) == {
        'operation', 'result', 'activeReceiptSha256', 'databaseRuntimeSha256', 'attestationSha256',
        'toolSha256', 'contractSha256'} and summary['operation'] == 'reconcile-docker-restart' and
        summary['result'] == 'VERIFIED' and summary['activeReceiptSha256'] == active_hash and
        summary['databaseRuntimeSha256'] == database_hash and summary['toolSha256'] == contract['priorUpdaterSha256'] and
        summary['contractSha256'] == contract['restartContractSha256'], 'Prior restart reconciliation changed')
    directory = native.STATE / 'reconciliations'
    native.receipt_directory(directory)
    path = directory / (active_hash + '.' + database_hash + '.' + contract['priorUpdaterSha256'] + '.json')
    raw, attestation = read_json(native, path)
    native.require(sha256(raw) == summary['attestationSha256'] and isinstance(attestation, dict) and set(attestation) == {
        'version', 'operation', 'activeReceiptSha256', 'successReceiptSha256', 'toolSha256', 'contractSha256',
        'contractRaw', 'contract', 'databaseRuntime'} and type(attestation['version']) is int and
        attestation['version'] == 1 and attestation['operation'] == 'reconcile-docker-restart' and
        attestation['activeReceiptSha256'] == active_hash and attestation['successReceiptSha256'] == success_hash and
        attestation['toolSha256'] == contract['priorUpdaterSha256'] and
        attestation['databaseRuntime'] == native.database_runtime(live) and
        attestation['contractSha256'] == contract['restartContractSha256'] and
        isinstance(attestation['contractRaw'], str) and len(attestation['contractRaw']) <= 131072,
        'Prior restart attestation changed')
    try:
        embedded = attestation['contractRaw'].encode('utf-8')
    except UnicodeError:
        raise native.Refused('Prior restart contract is not valid UTF-8') from None
    parsed = native.parse_reconciliation_contract(embedded, contract['restartContractSha256'])
    native.require(embedded == restart_raw and parsed == attestation['contract'] == restart,
                   'Prior reviewed restart contract changed')
    native.restart_only_guard(state, live, restart)
    native.receipt_guard(live)
    _, earlier = read_json(native, original / 'recovery.json')
    native.require(isinstance(earlier, dict) and earlier.get('operation') == 'supersede-failed-pre-capture' and
                   earlier.get('phase') == 'recovery-preflight-verified' and earlier.get('activation') == 'NOT_PERFORMED' and
                   earlier.get('newOperation') == contract['failedOperation'] and
                   earlier.get('releaseSha') == contract['failedReleaseSha'] and
                   earlier.get('activeReceiptSha256') == active_hash, 'Earlier pre-capture recovery provenance changed')
    return sha256(raw)


def artifact_hash(native, path, expected):
    native.private(path)
    metadata = path.stat()
    native.require(path.resolve() == path and metadata.st_uid == 0 and type(expected['bytes']) is int and
                   expected['bytes'] > 0 and metadata.st_size == expected['bytes'] and
                   isinstance(expected['sha256'], str) and HEX.fullmatch(expected['sha256']),
                   'Retained capture artifact ownership, size or hash is invalid')
    value = hashlib.sha256()
    total = 0
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            total += len(chunk)
            native.require(total <= expected['bytes'], 'Retained capture artifact grew while reading')
            value.update(chunk)
    after = path.stat()
    native.require(total == expected['bytes'] and value.hexdigest() == expected['sha256'] and
                   (after.st_size, after.st_mtime_ns, after.st_ino) ==
                   (metadata.st_size, metadata.st_mtime_ns, metadata.st_ino), 'Retained capture artifact changed')


def captured_files(native, capture, live, state, restart, *, resumed=False):
    native.receipt_directory(capture)
    native.require({path.name for path in capture.iterdir()} == (RESUMED_INVENTORY if resumed else INVENTORY),
                   'Retained capture inventory changed')
    artifacts_raw, artifacts = read_json(native, capture / 'artifacts.json')
    native.require(isinstance(artifacts, dict) and set(artifacts) == ARTIFACTS, 'Retained artifact manifest changed')
    for name in sorted(ARTIFACTS):
        expected = artifacts[name]
        native.require(isinstance(expected, dict) and set(expected) == {'path', 'bytes', 'sha256'} and
                       expected['path'] == name, 'Retained artifact entry changed')
        artifact_hash(native, capture / name, expected)
    if not resumed:
        for filename in ('postgres.dump.stderr', 'postgres-globals.sql.stderr'):
            native.require(native.receipt_file(capture / filename) == b'', 'Captured PostgreSQL stream reported diagnostics')
    native.require(sha256(native.receipt_file(capture / 'previous.env')) == restart['envSha256'],
                   'Captured deployment environment changed')
    source = native.ROOT / 'source'
    for index, relative in enumerate(('docker-compose.yml', 'ops/minimal/compose.fresh.yml')):
        native.require(native.receipt_file(capture / ('compose-' + str(index) + '.yml')) ==
                       (source / relative).read_bytes(), 'Captured Compose copy changed')
    directory = capture / 'source-configs'
    native.receipt_directory(directory)
    expected_configs = []
    for name in native.DATABASES:
        for mount in live[name]['mounts']:
            if mount['Type'] != 'bind':
                continue
            path = Path(mount['Source'])
            native.require(path.is_file() and not path.is_symlink() and path.resolve() == path and
                           path.is_relative_to(source) and path.stat().st_size <= 2000000 and
                           mount['Destination'].startswith('/etc/clickhouse-server/'), 'Unexpected sealed DB configuration')
            filename = 'config-' + str(len(expected_configs)) + '.xml'
            raw = native.receipt_file(directory / filename)
            native.require(raw == path.read_bytes(), 'Captured database configuration changed')
            expected_configs.append({'file': filename, 'destination': mount['Destination'], 'sha256': sha256(raw)})
    _, saved = read_json(native, capture / 'source-configs.json')
    native.require(saved == expected_configs and {path.name for path in directory.iterdir()} ==
                   {entry['file'] for entry in expected_configs}, 'Captured configuration inventory changed')
    _, stops = read_json(native, capture / 'stopped-apps.json')
    native.require(isinstance(stops, dict) and set(stops) == {'backend', 'client'}, 'Captured writer stop evidence changed')
    for name in ('backend', 'client'):
        item = stops[name]
        native.require(isinstance(item, dict) and item.get('id') == live[name]['id'] == state['runtime'][name]['id'] and
                       item.get('image') == live[name]['image'] == restart['baseImages'][name] and
                       item.get('identityMatches') is True and item.get('status') == 'exited' and
                       type(item.get('exitCode')) is int and item['exitCode'] in ({0, 143} if name == 'client' else {0}) and
                       item.get('oomKilled') is False and item.get('running') is False and
                       item.get('restarting') is False and item.get('stateErrorEmpty') is True,
                       'Captured writer shutdown was not verified')
    checks_raw, checks = read_json(native, capture / 'captured-checks.json')
    native.require(isinstance(checks, dict) and set(checks) == {'postgres', 'clickhouse', 'redis', 'redisModules'} and
                   isinstance(checks['postgres'], dict) and isinstance(checks['postgres'].get('inventory'), dict),
                   'Captured database checks changed')
    journal = checks['postgres']['inventory'].get('journal')
    native.require(isinstance(journal, list) and 0 < len(journal) <= 10000, 'Captured migration journal is invalid')
    pairs = []
    for entry in journal:
        native.require(isinstance(entry, dict) and set(entry) == {'id', 'hash', 'created_at'} and
                       type(entry['id']) is int and entry['id'] > 0 and
                       type(entry['created_at']) in (int, str) and re.fullmatch(r'[0-9]+', str(entry['created_at'])) and
                       isinstance(entry['hash'], str) and HEX.fullmatch(entry['hash']), 'Captured migration entry is invalid')
        pairs.append({'createdAt': str(entry['created_at']), 'sha256': entry['hash']})
    native.require(len(pairs) == restart['postgresMigrations']['count'] and
                   native.canonical_hash(pairs) == restart['postgresMigrations']['sha256'], 'Captured journal no longer matches review')
    return pairs, sha256(artifacts_raw), sha256(checks_raw)


def preserved_clone(native, status, live, target):
    expected = {'engine': 'postgres', 'container': target['container'], 'volume': target['volume'],
                'image': target['image'], 'network': 'none'}
    native.require(status['targets'] == [expected] and status['volumes'] == [target['volume']] and
                   target['image'] == live['postgres']['image'], 'Failed drill targets differ from review')
    item = json.loads(native.docker('inspect', target['container']))[0]
    labels = item['Config'].get('Labels') or {}
    state = item['State']
    native.require(item['Id'] == target['container'] and item['Image'] == target['image'] and
                   item.get('Name') == '/wotcv-native-drill-' + target['token'] + '-postgres' and
                   labels.get('wotcv.native.drill') == target['token'] and
                   item['HostConfig']['NetworkMode'] == 'none' and not item['HostConfig'].get('PortBindings') and
                   item['HostConfig']['RestartPolicy']['Name'] == 'no' and state['Status'] == 'exited' and
                   type(state['ExitCode']) is int and state['ExitCode'] == target['exitCode'] and
                   state.get('OOMKilled') is False and not state.get('Running') and not state.get('Restarting'),
                   'Preserved PostgreSQL clone identity or stopped state changed')
    mounts = item.get('Mounts', [])
    native.require(len(mounts) == 1 and mounts[0].get('Type') == 'volume' and
                   mounts[0].get('Name') == target['volume'] and
                   mounts[0].get('Destination') == native.DATABASES['postgres'] and mounts[0].get('RW') is True and
                   target['volume'] not in {live[name]['volume']['Name'] for name in native.DATABASES},
                   'Preserved clone volume isolation changed')
    volume = json.loads(native.docker('volume', 'inspect', target['volume']))[0]
    native.require(volume.get('Name') == target['volume'] and volume.get('Driver') == 'local' and
                   not volume.get('Options') and (volume.get('Labels') or {}).get('wotcv.native.drill') == target['token'],
                   'Preserved clone volume ownership changed')
    consumers = native.docker('ps', '-aq', '--filter', 'volume=' + target['volume']).decode().split()
    native.require(len(consumers) == 1 and target['container'].startswith(consumers[0]),
                   'Preserved clone volume has another consumer')


def verified_capture_origin(native, original, contract, state, active_hash, success_hash, live, restart_raw, restart):
    """Link the resumed operation to its unchanged, previously reviewed capture."""
    proof = contract['verifiedCapture']
    prior = Path(contract['priorPacketDirectory'])
    _, previous = read_json(native, prior / 'drill-recovery-20261117.json')
    native.require(isinstance(previous, dict) and set(previous) == FIELDS and previous['version'] == 1 and
                   previous['failedOperation'] == proof['originOperation'] and
                   previous['failedReleaseSha'] == proof['originReleaseSha'] and
                   previous['priorUpdaterSha256'] == contract['priorUpdaterSha256'] and
                   previous['restartContractSha256'] == contract['restartContractSha256'],
                   'Prior capture recovery contract provenance changed')
    origin = native.STATE / 'release-operations' / proof['originOperation']
    native.receipt_directory(origin)
    native.require({path.name for path in origin.iterdir()} == {
        'failure.json', 'reconciliation.json', 'recovery.json', 'backup', 'superseded-pending.json', 'superseded.json'},
        'Capture origin operation inventory changed')
    attestation_hash = historical_attestation(native, origin, state, active_hash, success_hash, live,
                                             previous, restart_raw, restart)
    native.require(native.receipt_file(original / 'reconciliation.json') ==
                   native.receipt_file(origin / 'reconciliation.json'), 'Resumed restart reconciliation differs from origin')
    pending_raw, pending = read_json(native, origin / 'superseded-pending.json')
    failure_raw = native.receipt_file(origin / 'failure.json')
    raw, report = read_json(native, original / 'drill-recovery.json')
    native.require(raw == native.receipt_file(origin / 'superseded.json') and
                   sha256(pending_raw) == previous['failedPendingSha256'] and
                   pending == {'operation': proof['originOperation'], 'releaseSha': proof['originReleaseSha']} and
                   sha256(failure_raw) == previous['failedFailureSha256'] and
                   isinstance(report, dict) and set(report) == {
                       'operation', 'phase', 'failedOperation', 'newOperation', 'releaseSha', 'failedReleaseSha',
                       'priorCapture', 'activeReceiptSha256', 'historicalAttestationSha256', 'runtimeSha256',
                       'artifactsManifestSha256', 'capturedChecksSha256', 'failedPendingSha256', 'failedFailureSha256',
                       'preservedFailedClone', 'drillRecoveryContractSha256', 'drillRecoveryToolSha256',
                       'sourceApplicationStop', 'activation'} and
                   report['operation'] == 'supersede-failed-isolated-pg-drill' and
                   report['phase'] == 'drill-recovery-preflight-verified' and
                   report['failedOperation'] == proof['originOperation'] and
                   report['newOperation'] == contract['failedOperation'] and
                   report['releaseSha'] == contract['failedReleaseSha'] and
                   report['failedReleaseSha'] == proof['originReleaseSha'] and
                   report['priorCapture'] == str(origin / 'backup') and
                   report['activeReceiptSha256'] == active_hash and
                   report['historicalAttestationSha256'] == attestation_hash and
                   report['runtimeSha256'] == contract['runtimeSha256'] and
                   report['failedPendingSha256'] == previous['failedPendingSha256'] and
                   report['failedFailureSha256'] == previous['failedFailureSha256'] and
                   report['preservedFailedClone'] == previous['failedDrill'] and
                   report['drillRecoveryContractSha256'] == proof['priorDrillRecoveryContractSha256'] and
                   report['drillRecoveryToolSha256'] == proof['priorDrillRecoverySha256'] and
                   report['sourceApplicationStop'] == report['activation'] == 'NOT_PERFORMED',
                   'Resumed capture recovery history changed')
    capture, origin_capture = original / 'backup', origin / 'backup'
    native.receipt_directory(capture)
    native.receipt_directory(origin_capture)
    native.require({path.name for path in origin_capture.iterdir()} == INVENTORY,
                   'Capture origin backup inventory changed')
    # Current artifact bytes are streamed by captured_files. Bind their manifest
    # and all copied metadata to origin without re-reading large origin archives.
    for name in ('artifacts.json', 'captured-checks.json', 'previous.env', 'compose-0.yml', 'compose-1.yml',
                 'source-configs.json', 'stopped-apps.json'):
        native.require(native.receipt_file(capture / name) == native.receipt_file(origin_capture / name),
                       'Resumed capture metadata differs from origin')
    native.require(sha256(native.receipt_file(capture / 'artifacts.json')) == report['artifactsManifestSha256'] and
                   sha256(native.receipt_file(capture / 'captured-checks.json')) == report['capturedChecksSha256'],
                   'Resumed capture does not match archived recovery hashes')
    for name in ('postgres.dump.stderr', 'postgres-globals.sql.stderr'):
        native.require(native.receipt_file(origin_capture / name) == b'', 'Original capture reported PostgreSQL diagnostics')
    _, configs = read_json(native, capture / 'source-configs.json')
    native.receipt_directory(origin_capture / 'source-configs')
    native.require(isinstance(configs, list) and len(configs) <= 32 and all(
        isinstance(entry, dict) and set(entry) == {'file', 'destination', 'sha256'} and
        isinstance(entry['file'], str) and re.fullmatch(r'config-[0-9]{1,2}\.xml', entry['file']) and
        isinstance(entry['destination'], str) and entry['destination'].startswith('/etc/clickhouse-server/') and
        isinstance(entry['sha256'], str) and HEX.fullmatch(entry['sha256']) for entry in configs) and
        len({entry['file'] for entry in configs}) == len(configs) and
        {path.name for path in (origin_capture / 'source-configs').iterdir()} ==
                   {entry['file'] for entry in configs}, 'Original captured configuration inventory changed')
    for entry in configs:
        native.require(native.receipt_file(capture / 'source-configs' / entry['file']) ==
                       native.receipt_file(origin_capture / 'source-configs' / entry['file']),
                       'Copied database configuration differs from origin')
    return attestation_hash


def diagnostic_check_shape(native, checks):
    fields = {'columns': {'table_schema', 'table_name', 'column_name', 'ordinal_position', 'data_type',
                           'udt_name', 'is_nullable', 'column_default'},
              'constraints': {'schema', 'name', 'conname', 'definition'},
              'indexes': {'schemaname', 'tablename', 'indexname', 'indexdef'},
              'journal': {'id', 'hash', 'created_at'}}
    native.require(isinstance(checks, dict) and set(checks) == {'inventory', 'counts'} and
                   isinstance(checks['inventory'], dict) and set(checks['inventory']) == set(fields) and
                   isinstance(checks['counts'], dict) and 0 < len(checks['counts']) <= 100 and
                   all(isinstance(key, str) and type(value) is int and value >= 0
                       for key, value in checks['counts'].items()), 'Invalid private diagnostic check scope')
    for section, keys in fields.items():
        rows = checks['inventory'][section]
        native.require(isinstance(rows, list) and len(rows) <= 10000 and
                       all(isinstance(row, dict) and set(row) == keys for row in rows),
                       'Invalid private diagnostic catalog shape')


def verified_diagnostic(native, original, capture, contract):
    proof = contract['verifiedCapture']
    parent = native.STATE / 'diagnostics'
    directory = Path(proof['diagnosticDirectory'])
    native.receipt_directory(parent)
    native.require(directory.parent == parent and
                   re.fullmatch(re.escape(contract['failedOperation']) + r'\.[0-9]{8}T[0-9]{6}Z\.[0-9a-f]{8}', directory.name),
                   'Diagnostic directory is outside the reviewed operation scope')
    native.receipt_directory(directory)
    raw, report = read_json(native, directory / 'report.json')
    native.require(digest_proof('pg-diagnostic', raw, proof['diagnosticReportSha256']) ==
                   proof['diagnosticReportSha256'] and isinstance(report, dict) and set(report) == {
        'phase', 'diagnosticOnly', 'acceptanceChanged', 'operation', 'diagnosticDirectory', 'inspectionComplete',
        'comparison', 'cleanup', 'errorType', 'restore', 'activation', 'sourceWriterControl'} and
        report['phase'] == 'HOLD' and report['diagnosticOnly'] is True and report['acceptanceChanged'] is False and
        report['operation'] == contract['failedOperation'] and report['diagnosticDirectory'] == str(directory) and
        report['inspectionComplete'] is True and report['cleanup'] == [] and report['errorType'] is None and
        report['restore'] == report['activation'] == report['sourceWriterControl'] == 'NOT_PERFORMED',
        'Pinned isolated PostgreSQL diagnostic is not complete')
    comparison = report['comparison']
    native.require(isinstance(comparison, dict) and set(comparison) == {
        'phase', 'diagnosticOnly', 'acceptanceChanged', 'equal', 'sections',
        'sameColumnRowsWithoutPhysicalOrdinal', 'columnVisibleOrderMatches'} and
        comparison['phase'] == 'HOLD' and comparison['diagnosticOnly'] is True and
        comparison['acceptanceChanged'] is False and comparison['equal'] is False and
        comparison['sameColumnRowsWithoutPhysicalOrdinal'] is True and comparison['columnVisibleOrderMatches'] is True and
        isinstance(comparison['sections'], dict) and set(comparison['sections']) == {
            'columns', 'constraints', 'indexes', 'journal', 'counts'}, 'Diagnostic differs from ordinal-only review')
    expected_raw, expected = read_json(native, directory / 'expected-checks.json')
    native.require(expected_raw == native.receipt_file(capture / 'captured-checks.json') and
                   isinstance(expected, dict) and set(expected) == {'postgres', 'clickhouse', 'redis', 'redisModules'},
                   'Diagnostic expected checks differ from current capture')
    _, actual = read_json(native, directory / 'actual-checks.json')
    diagnostic_check_shape(native, expected['postgres'])
    diagnostic_check_shape(native, actual)
    for name, section in comparison['sections'].items():
        left = expected['postgres']['counts'] if name == 'counts' else expected['postgres']['inventory'][name]
        right = actual['counts'] if name == 'counts' else actual['inventory'][name]
        native.require(isinstance(section, dict) and section.get('expectedSha256') == native.canonical_hash(left) and
                       section.get('actualSha256') == native.canonical_hash(right) and
                       section.get('expectedItems') == len(left) and section.get('actualItems') == len(right),
                       'Diagnostic private catalog hashes differ from reviewed summary')
        if name != 'columns':
            native.require(left == right and section.get('equal') is True and section.get('differentItems') == 0,
                           'Diagnostic contains a non-column difference')
    columns = comparison['sections']['columns']
    native.require(columns.get('equal') is False and type(columns.get('differentItems')) is int and
                   0 < columns['differentItems'] <= 10 and len(columns.get('differences', [])) == columns['differentItems'] and
                   all(item.get('fields') == ['ordinal_position'] and item.get('expectedPresent') is True and
                       item.get('actualPresent') is True for item in columns['differences']),
                   'Diagnostic contains differences beyond existing column ordinals')
    for tag, step in (('postgres-create-database', 'postgres_create_database'), ('postgres-restore', 'postgres_restore')):
        _, result = read_json(native, capture / (tag + '.result.json'))
        native.require(result.get('step') == step and type(result.get('returnCode')) is int and result['returnCode'] == 0 and
                       result.get('timedOut') is False, 'Prior CREATE or restore did not succeed')
        for suffix in ('.stdout.log', '.stderr.log'):
            native.receipt_file(capture / (tag + suffix))
    _, drill = read_json(native, capture / 'drill-status.json')
    _, cause = read_json(native, capture / 'drill-failure.json')
    native.require(drill.get('phase') == 'running' and drill.get('step') == cause.get('phase') == 'postgres_verify' and
                   cause.get('errorType') == 'Refused', 'Prior isolated failure is outside PostgreSQL verification')


def supersede(native, packet_root, manifest, failed_op, new_op, new_transaction):
    """Caller holds native.locked(root=True); return validated prior capture Path."""
    packet_root, new_transaction = Path(packet_root), Path(new_transaction)
    contract = contract_for(native, packet_root, manifest)
    native.require(failed_op == contract['failedOperation'] and isinstance(new_op, str) and OPERATION.fullmatch(new_op) and
                   new_op != failed_op and isinstance(manifest['releaseSha'], str) and SHA.fullmatch(manifest['releaseSha']) and
                   manifest['releaseSha'] != contract['failedReleaseSha'], 'Exact failed drill and new release are required')
    native.receipt_directory(native.STATE)
    absent(native, native.STATE / 'pending.json')
    operations = native.STATE / 'release-operations'
    native.receipt_directory(operations)
    native.require(new_transaction == operations / new_op, 'Drill recovery destination differs from new operation')
    native.receipt_directory(new_transaction)
    native.require(not any(new_transaction.iterdir()), 'New drill recovery transaction must be empty')
    original = operations / failed_op
    native.receipt_directory(original)
    resumed = contract['version'] == 2
    native.require({path.name for path in original.iterdir()} == {
        'failure.json', 'reconciliation.json', 'drill-recovery.json' if resumed else 'recovery.json', 'backup'},
                   'Selected failed drill operation inventory changed')
    pending = operations / 'pending.json'
    pending_raw, marker = read_json(native, pending)
    native.require(digest_proof('pending', pending_raw, contract['failedPendingSha256']) ==
                   contract['failedPendingSha256'] and marker == {
        'operation': failed_op, 'releaseSha': contract['failedReleaseSha']}, 'Failed drill pending marker changed')
    failure_raw, failure = read_json(native, original / 'failure.json')
    native.require(digest_proof('failure', failure_raw, contract['failedFailureSha256']) ==
                   contract['failedFailureSha256'] and isinstance(failure, dict) and
                   set(failure) == {'phase', 'errorType', 'sites', 'at', 'result'} and
                   failure['phase'] == ('backup_restoring_isolated_databases' if resumed else 'backup_preflight') and
                   failure['errorType'] == 'Refused' and isinstance(failure['sites'], list) and
                   {'file': 'wotcv-native-backup.py', 'line': 558 if resumed else 487} in failure['sites'] and
                   isinstance(failure['at'], str) and STAMP.fullmatch(failure['at']) and
                   failure['result'] == 'HOLD: inspect private transaction before retry', 'Pinned failed drill evidence changed')
    state, active_hash, success_hash, environment = native.reconciliation_context()
    live = native.snapshot()
    native.require(native.canonical_hash(live) == contract['runtimeSha256'], 'Source runtime changed since drill recovery review')
    restart_raw, restart = native.read_reconciliation_contract(packet_root / 'restart-20261116.json', contract['restartContractSha256'])
    attestation_hash = (verified_capture_origin(native, original, contract, state, active_hash, success_hash,
                                               live, restart_raw, restart) if resumed else
                        historical_attestation(native, original, state, active_hash, success_hash, live,
                                               contract, restart_raw, restart))
    native.code_runtime_guard(restart, live)
    native.require(all(type(live[name]['restarts']) is int and live[name]['restarts'] == 0 for name in ('backend', 'client')),
                   'Old source application restarted unexpectedly')
    _, seal = read_json(native, native.ROOT / 'state.json')
    native.require(seal['project'] == native.PROJECT and seal['source'] == native.BASELINE and
                   seal['sourceFiles'] == native.source_hashes(native.ROOT / 'source'), 'Sealed native source changed')
    capture = original / 'backup'
    pairs, artifacts_hash, checks_hash = captured_files(native, capture, live, state, restart, resumed=resumed)
    status_raw, status = read_json(native, capture / 'status.json')
    native.require(isinstance(status, dict) and set(status) ==
                   ({'phase', 'at', 'targets', 'volumes', 'step'} if resumed else {'phase', 'at', 'targets', 'volumes'}) and
                   status['phase'] == ('existing_capture_drill_failed_source_not_controlled' if resumed else
                                       'drill_failed_old_apps_resumed') and
                   (not resumed or status['step'] == 'postgres_verify') and
                   isinstance(status['at'], str) and STAMP.fullmatch(status['at']),
                   'Prior drill status changed')
    try:
        native.require(datetime.strptime(failed_op.split('-')[0], '%Y%m%dT%H%M%SZ') <=
                       datetime.strptime(status['at'], '%Y-%m-%dT%H:%M:%SZ') <=
                       datetime.strptime(failure['at'], '%Y-%m-%dT%H:%M:%SZ'), 'Prior drill status is outside operation window')
    except ValueError:
        raise native.Refused('Invalid prior drill timestamp') from None
    preserved_clone(native, status, live, contract['failedDrill'])
    if resumed:
        verified_diagnostic(native, original, capture, contract)
    native.require(sha256(native.receipt_file(environment)) == restart['envSha256'], 'Current environment changed')
    model = native.config(environment)
    native.model_guard(model, live)
    native.verify_model_live(model, live)
    native.require(native.migration_pairs(live) == pairs, 'Live and captured migration journals differ')
    native.readiness()
    native.require(native.reconciliation_context() == (state, active_hash, success_hash, environment) and
                   native.snapshot() == live and native.migration_pairs(live) == pairs and
                   native.receipt_file(pending) == pending_raw and native.receipt_file(original / 'failure.json') == failure_raw and
                   native.receipt_file(capture / 'status.json') == status_raw,
                   'Failed drill evidence or source runtime changed during inspection')
    report = {'operation': 'supersede-failed-isolated-pg-drill', 'phase': 'drill-recovery-preflight-verified',
              'failedOperation': failed_op, 'newOperation': new_op, 'releaseSha': manifest['releaseSha'],
              'failedReleaseSha': contract['failedReleaseSha'], 'priorCapture': str(capture),
              'activeReceiptSha256': active_hash, 'historicalAttestationSha256': attestation_hash,
              'runtimeSha256': contract['runtimeSha256'], 'artifactsManifestSha256': artifacts_hash,
              'capturedChecksSha256': checks_hash, 'failedPendingSha256': contract['failedPendingSha256'],
              'failedFailureSha256': contract['failedFailureSha256'], 'preservedFailedClone': contract['failedDrill'],
              'drillRecoveryContractSha256': manifest['files']['drillRecoveryContract'],
              'drillRecoveryToolSha256': manifest['files']['drillRecovery'],
              'sourceApplicationStop': 'NOT_PERFORMED', 'activation': 'NOT_PERFORMED'}
    if resumed:
        report['verifiedDiagnosticSha256'] = contract['verifiedCapture']['diagnosticReportSha256']
        report['originalCaptureOperation'] = contract['verifiedCapture']['originOperation']
        # Re-read pinned diagnostic metadata after all live/source checks and
        # immediately before the first historical write/atomic pending switch.
        verified_diagnostic(native, original, capture, contract)
    native.write(original / 'superseded-pending.json', pending_raw)
    native.write(original / 'superseded.json', json.dumps(report, indent=2) + '\n')
    native.fsync_directory(original)
    native.write(new_transaction / 'drill-recovery.json', json.dumps(report, indent=2) + '\n')
    native.fsync_directory(new_transaction)
    native.record(pending, {'operation': new_op, 'releaseSha': manifest['releaseSha']})
    native.fsync_directory(operations)
    return capture


if __name__ == '__main__':
    raise SystemExit('Use the reviewed locked root drill continuation packet.')
