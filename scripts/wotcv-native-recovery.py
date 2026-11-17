#!/usr/bin/env python3
"""Supersede one hash-reviewed pre-capture HOLD; never resume partial work.

Imported by the reviewed root packet while both deployment locks are held.
Historical receipts and evidence are preserved. This module never controls
containers, captures data, clears native pending or approves activation.
"""
import hashlib
import json
from datetime import datetime
from pathlib import Path
import re


OPERATION = re.compile(r'[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}\Z')
SHA = re.compile(r'[0-9a-f]{40}\Z')
HEX = re.compile(r'[0-9a-f]{64}\Z')
STAMP = re.compile(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z\Z')
CONTRACT_FIELDS = {'version', 'failedOperation', 'failedReleaseSha', 'failedPendingSha256',
                   'failedFailureSha256', 'priorUpdaterSha256', 'runtimeSha256', 'restartContractSha256'}
ATTESTATION_FIELDS = {'version', 'operation', 'activeReceiptSha256', 'successReceiptSha256',
                      'toolSha256', 'contractSha256', 'contractRaw', 'contract', 'databaseRuntime'}


def sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def read_json(native, path):
    raw = native.receipt_file(path)
    return raw, native.reconciliation_json(raw)


def absent(native, path):
    native.require(not path.exists() and not path.is_symlink(), 'Recovery requires an absent transaction marker')


def recovery_contract(native, packet_root, manifest):
    raw = native.receipt_file(packet_root / 'recovery-20261117.json')
    native.require(len(raw) <= 131072 and sha256(raw) == manifest['files']['recoveryContract'],
                   'Reviewed recovery contract size or hash changed')
    contract = native.reconciliation_json(raw)
    native.require(isinstance(contract, dict) and set(contract) == CONTRACT_FIELDS and
                   type(contract['version']) is int and contract['version'] == 1 and
                   isinstance(contract['failedOperation'], str) and OPERATION.fullmatch(contract['failedOperation']) and
                   isinstance(contract['failedReleaseSha'], str) and SHA.fullmatch(contract['failedReleaseSha']) and
                   all(isinstance(contract[key], str) and HEX.fullmatch(contract[key]) for key in
                       ('failedPendingSha256', 'failedFailureSha256', 'priorUpdaterSha256',
                        'runtimeSha256', 'restartContractSha256')),
                   'Invalid reviewed recovery contract')
    native.require(contract['restartContractSha256'] == manifest['files']['restartContract'],
                   'Recovery and restart contract hashes differ')
    return contract


def prior_reconciliation(native, original, state, active_hash, success_hash, live, contract, restart_raw, restart):
    _, summary = read_json(native, original / 'reconciliation.json')
    database_hash = native.canonical_hash(native.database_runtime(live))
    native.require(isinstance(summary, dict) and set(summary) == {
        'operation', 'result', 'activeReceiptSha256', 'databaseRuntimeSha256',
        'attestationSha256', 'toolSha256', 'contractSha256'} and
        summary['operation'] == 'reconcile-docker-restart' and summary['result'] == 'VERIFIED' and
        summary['activeReceiptSha256'] == active_hash and summary['databaseRuntimeSha256'] == database_hash and
        summary['toolSha256'] == contract['priorUpdaterSha256'] and
        summary['contractSha256'] == contract['restartContractSha256'],
        'Failed operation reconciliation provenance changed')
    directory = native.STATE / 'reconciliations'
    native.receipt_directory(directory)
    # The original tool used this exact two-hash name. Never rewrite or move it.
    path = directory / (active_hash + '.' + database_hash + '.json')
    raw, attestation = read_json(native, path)
    native.require(sha256(raw) == summary['attestationSha256'] and
                   isinstance(attestation, dict) and set(attestation) == ATTESTATION_FIELDS and
                   type(attestation['version']) is int and attestation['version'] == 1 and
                   attestation['operation'] == 'reconcile-docker-restart' and
                   attestation['activeReceiptSha256'] == active_hash and
                   attestation['successReceiptSha256'] == success_hash and
                   attestation['toolSha256'] == contract['priorUpdaterSha256'] and
                   attestation['databaseRuntime'] == native.database_runtime(live) and
                   attestation['contractSha256'] == contract['restartContractSha256'] and
                   isinstance(attestation['contractRaw'], str) and len(attestation['contractRaw']) <= 131072,
                   'Historical restart attestation changed')
    try:
        embedded = attestation['contractRaw'].encode('utf-8')
    except UnicodeError:
        raise native.Refused('Historical restart contract is not valid UTF-8') from None
    parsed = native.parse_reconciliation_contract(embedded, contract['restartContractSha256'])
    native.require(embedded == restart_raw and parsed == attestation['contract'] == restart,
                   'Historical reviewed restart contract changed')
    native.restart_only_guard(state, live, restart)
    return sha256(raw)


def preflight_files(native, backup, live, failure, restart, failed_operation):
    native.receipt_directory(backup)
    names = {path.name for path in backup.iterdir()}
    native.require(names == {'previous.env', 'compose-0.yml', 'compose-1.yml',
                             'source-configs.json', 'source-configs', 'status.json'},
                   'Recovery only supports the exact pre-capture backup inventory')
    _, status = read_json(native, backup / 'status.json')
    native.require(isinstance(status, dict) and set(status) == {'phase', 'at'} and
                   status['phase'] == 'source_changed_or_old_apps_resume_failed' and
                   isinstance(status['at'], str) and STAMP.fullmatch(status['at']),
                   'Failed backup status differs from the reviewed pre-capture failure')
    try:
        operation_at = datetime.strptime(failed_operation.split('-')[0], '%Y%m%dT%H%M%SZ')
        status_at = datetime.strptime(status['at'], '%Y-%m-%dT%H:%M:%SZ')
        failure_at = datetime.strptime(failure['at'], '%Y-%m-%dT%H:%M:%SZ')
    except ValueError:
        raise native.Refused('Invalid failed operation timestamp') from None
    native.require(operation_at <= status_at <= failure_at,
                   'Failed backup status falls outside the reviewed operation window')
    native.require(sha256(native.receipt_file(backup / 'previous.env')) == restart['envSha256'],
                   'Failed backup environment changed')
    source = native.ROOT / 'source'
    for index, relative in enumerate(('docker-compose.yml', 'ops/minimal/compose.fresh.yml')):
        native.require(native.receipt_file(backup / ('compose-' + str(index) + '.yml')) ==
                       (source / relative).read_bytes(), 'Failed backup Compose copy changed')
    directory = backup / 'source-configs'
    native.receipt_directory(directory)
    expected = []
    for name in native.DATABASES:
        for mount in live[name]['mounts']:
            if mount['Type'] != 'bind':
                continue
            path = Path(mount['Source'])
            native.require(path.is_file() and not path.is_symlink() and path.resolve() == path and
                           path.is_relative_to(source) and path.stat().st_size <= 2000000 and
                           mount['Destination'].startswith('/etc/clickhouse-server/'),
                           'Unexpected sealed database configuration mount')
            filename = 'config-' + str(len(expected)) + '.xml'
            raw = native.receipt_file(directory / filename)
            native.require(raw == path.read_bytes(), 'Failed backup database configuration copy changed')
            expected.append({'file': filename, 'destination': mount['Destination'], 'sha256': sha256(raw)})
    _, saved = read_json(native, backup / 'source-configs.json')
    native.require(saved == expected and {path.name for path in directory.iterdir()} ==
                   {entry['file'] for entry in expected}, 'Failed backup configuration inventory changed')


def supersede(native, packet_root, manifest, failed_operation, new_operation, new_transaction):
    """Caller holds native.locked(root=True); replace one pending atomically."""
    packet_root, new_transaction = Path(packet_root), Path(new_transaction)
    contract = recovery_contract(native, packet_root, manifest)
    native.require(failed_operation == contract['failedOperation'] and
                   isinstance(new_operation, str) and OPERATION.fullmatch(new_operation) and
                   new_operation != failed_operation and isinstance(manifest['releaseSha'], str) and
                   SHA.fullmatch(manifest['releaseSha']) and manifest['releaseSha'] != contract['failedReleaseSha'],
                   'Recovery requires the exact failed operation and a distinct new reviewed release')
    native.require(sha256(Path(__file__).read_bytes()) == manifest['files']['recovery'],
                   'Reviewed recovery module changed')
    native.receipt_directory(native.STATE)
    absent(native, native.STATE / 'pending.json')
    operations = native.STATE / 'release-operations'
    native.receipt_directory(operations)
    native.require(new_transaction == operations / new_operation,
                   'Recovery destination does not match the new operation')
    native.receipt_directory(new_transaction)
    native.require(not any(new_transaction.iterdir()), 'Recovery destination must be new and empty')
    original = operations / failed_operation
    native.receipt_directory(original)
    native.require({path.name for path in original.iterdir()} == {'failure.json', 'reconciliation.json', 'backup'},
                   'Selected operation is not an untouched pre-capture failure')
    pending = operations / 'pending.json'
    pending_raw, marker = read_json(native, pending)
    native.require(sha256(pending_raw) == contract['failedPendingSha256'] and marker == {
        'operation': failed_operation, 'releaseSha': contract['failedReleaseSha']},
        'Pending marker differs from the reviewed failed operation')
    failure_raw, failure = read_json(native, original / 'failure.json')
    native.require(sha256(failure_raw) == contract['failedFailureSha256'] and isinstance(failure, dict) and
                   set(failure) == {'phase', 'errorType', 'sites', 'at', 'result'} and
                   failure['phase'] == 'backup_preflight' and failure['errorType'] == 'ConnectionResetError' and
                   isinstance(failure['at'], str) and STAMP.fullmatch(failure['at']) and
                   failure['result'] == 'HOLD: inspect private transaction before retry',
                   'Failed operation evidence differs from the reviewed failure')
    state, active_hash, success_hash, environment = native.reconciliation_context()
    live = native.snapshot()
    native.require(native.canonical_hash(live) == contract['runtimeSha256'],
                   'Runtime changed since the reviewed recovery observation')
    restart_raw, restart = native.read_reconciliation_contract(packet_root / 'restart-20261116.json',
                                                               contract['restartContractSha256'])
    historical_hash = prior_reconciliation(native, original, state, active_hash, success_hash,
                                           live, contract, restart_raw, restart)
    native.require(all(live[name]['id'] == state['runtime'][name]['id'] and
                       type(live[name]['restarts']) is int and live[name]['restarts'] == 0
                       for name in ('backend', 'client')), 'Recovered old application identities changed')
    native.code_runtime_guard(restart, live)
    _, seal = read_json(native, native.ROOT / 'state.json')
    native.require(seal['project'] == native.PROJECT and seal['source'] == native.BASELINE and
                   seal['sourceFiles'] == native.source_hashes(native.ROOT / 'source'), 'Sealed native source changed')
    preflight_files(native, original / 'backup', live, failure, restart, failed_operation)
    native.require(sha256(native.receipt_file(environment)) == restart['envSha256'], 'Active environment changed')
    model = native.config(environment)
    native.model_guard(model, live)
    native.verify_model_live(model, live)
    pairs = native.migration_pairs(live)
    native.require(len(pairs) == restart['postgresMigrations']['count'] and
                   native.canonical_hash(pairs) == restart['postgresMigrations']['sha256'],
                   'Migration journal changed since the reviewed failed attempt')
    native.readiness()
    native.require(native.reconciliation_context() == (state, active_hash, success_hash, environment) and
                   native.snapshot() == live and native.migration_pairs(live) == pairs and
                   native.receipt_file(pending) == pending_raw and
                   native.receipt_file(original / 'failure.json') == failure_raw,
                   'Recovery evidence or runtime changed during inspection')
    report = {'operation': 'supersede-failed-pre-capture', 'failedOperation': failed_operation,
              'newOperation': new_operation, 'failedReleaseSha': contract['failedReleaseSha'],
              'releaseSha': manifest['releaseSha'], 'activeReceiptSha256': active_hash,
              'historicalAttestationSha256': historical_hash, 'runtimeSha256': contract['runtimeSha256'],
              'failedPendingSha256': contract['failedPendingSha256'],
              'failedFailureSha256': contract['failedFailureSha256'],
              'recoveryContractSha256': manifest['files']['recoveryContract'],
              'recoveryToolSha256': manifest['files']['recovery'],
              'phase': 'recovery-preflight-verified', 'activation': 'NOT_PERFORMED'}
    # Write-once history and evidence become durable before the pending switch.
    native.write(original / 'superseded-pending.json', pending_raw)
    native.write(original / 'superseded.json', json.dumps(report, indent=2) + '\n')
    native.fsync_directory(original)
    native.write(new_transaction / 'recovery.json', json.dumps(report, indent=2) + '\n')
    native.fsync_directory(new_transaction)
    native.record(pending, {'operation': new_operation, 'releaseSha': manifest['releaseSha']})
    native.fsync_directory(operations)
    return report


if __name__ == '__main__':
    raise SystemExit('Use the reviewed root release continuation packet.')
