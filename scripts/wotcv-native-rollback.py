#!/usr/bin/env python3
"""Rollback one fully active reviewed native release's application images only.

Imported only after the root packet loader verifies this module's hash. This is
not recovery for partial transactions, schema changes, runtime drift or lost data.
"""
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import time


OPERATION = re.compile(r'[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}\Z')
RELEASE = re.compile(r'rybbit-native-update-[0-9]{8}T[0-9]{6}Z\.[0-9a-f]{8}\Z')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def now():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def read_json(native, path):
    return json.loads(native.receipt_file(path))


def no_pending(native, path):
    native.require(not path.exists() and not path.is_symlink(), 'Pending transaction requires manual inspection')


def preflight(native, packet_root, manifest, operation):
    native.require(hasattr(os, 'geteuid') and os.geteuid() == 0 and
                   isinstance(operation, str) and OPERATION.fullmatch(operation),
                   'Root and an exact completed release operation are required')
    native.receipt_directory(native.STATE)
    no_pending(native, native.STATE / 'pending.json')
    operations = native.STATE / 'release-operations'
    native.receipt_directory(operations)
    no_pending(native, operations / 'pending.json')
    original = operations / operation
    native.receipt_directory(original)
    result = read_json(native, original / 'success.json')
    completed = read_json(native, original / 'completed-pending.json')
    native.require(result.get('operation') == operation and completed.get('operation') == operation and
                   result.get('phase') == 'activated-awaiting-functional-acceptance' and
                   result.get('releaseSha') == completed.get('releaseSha') == manifest['releaseSha'] and
                   result.get('backupEngineRestoreVerified') is True,
                   'Selected operation is not the completed reviewed active deployment')
    raw_active = native.receipt_file(native.STATE / 'active.json')
    native.require(hashlib.sha256(raw_active).hexdigest() == result.get('nativeActiveReceiptSha256'),
                   'Active receipt differs from selected release operation')
    active = json.loads(raw_active)
    release = active.get('release')
    native.require(isinstance(release, str) and RELEASE.fullmatch(release) and
                   release == result.get('nativeRelease') and active.get('phase') == 'active' and
                   active.get('sha') == manifest['releaseSha'] and active.get('images') == result.get('images'),
                   'Active native release provenance differs from selected operation')
    source = native.STATE / release
    native.receipt_directory(source)
    native.require(native.receipt_file(source / 'success.json') == raw_active,
                   'Active and historical native success receipts differ')
    attempt = read_json(native, source / 'attempt.json')
    native.require(attempt.get('release') == release and attempt.get('sha') == manifest['releaseSha'] and
                   attempt.get('images') == active['images'], 'Original native attempt differs')
    live = native.snapshot()
    native.receipt_guard(live)
    native.require(live == active.get('runtime'), 'Runtime drift blocks functional rollback')
    native.infrastructure_unchanged(attempt['before'], live)
    sealed = read_json(native, native.ROOT / 'state.json')
    native.require(sealed['project'] == native.PROJECT and sealed['source'] == native.BASELINE and
                   sealed['sourceFiles'] == native.source_hashes(native.ROOT / 'source'),
                   'Sealed native source changed')
    _, contract = native.read_reconciliation_contract(packet_root / 'restart-20261116.json',
                                                      manifest['files']['restartContract'])
    old_images = contract['baseImages']
    native.require(all(attempt['before'][name]['image'] == old_images[name] for name in ('backend', 'client')),
                   'Rollback target differs from the reviewed original images')
    for name in ('backend', 'client'):
        info = native.image_info(old_images[name])
        native.require(info['Id'] == old_images[name] and
                       info['Config'].get('Labels', {}).get('org.opencontainers.image.revision') == contract['baseRevision'],
                       'Reviewed rollback image or revision is unavailable')
    pairs = native.migration_pairs(live)
    native.require(pairs == result.get('migrationPairs') and len(pairs) == contract['postgresMigrations']['count'] and
                   native.canonical_hash(pairs) == contract['postgresMigrations']['sha256'],
                   'Migration journal drift blocks functional rollback')
    backup = original / 'backup'
    native.receipt_directory(backup)
    evidence = read_json(native, backup / 'verified.json')
    native.require(evidence.get('phase') == 'verified' and evidence.get('drill', {}).get('phase') == 'passed' and
                   evidence.get('after') == attempt['before'], 'Verified backup does not bind the original deployment')
    old_raw = native.receipt_file(source / 'previous.env')
    backup_raw = native.receipt_file(backup / 'previous.env')
    old_hash = hashlib.sha256(old_raw).hexdigest()
    native.require(old_raw == backup_raw and old_hash == contract['envSha256'] ==
                   evidence['artifacts']['previous.env']['sha256'], 'Reviewed previous environment changed')
    current_env = native.current_env()
    current_raw = native.receipt_file(current_env)
    current_model = native.config(current_env)
    native.model_guard(current_model, live)
    native.verify_model_live(current_model, live)
    old_model = native.config(source / 'previous.env')
    expected = copy.deepcopy(current_model)
    for name in ('backend', 'client'):
        expected['services'][name]['image'] = old_images[name]
    expected['services']['backend']['environment']['SOURCE_CODE_URL'] = native.REMOTE + '/tree/' + contract['baseRevision']
    native.require(old_model == expected, 'Rollback would change settings beyond application images/provenance')
    native.readiness()
    native.require(native.snapshot() == live and native.migration_pairs(live) == pairs,
                   'Runtime or journal changed during rollback preflight')
    return {'before': live, 'active': active, 'activeRaw': raw_active, 'currentEnv': current_env,
            'currentRaw': current_raw, 'oldRaw': old_raw, 'oldModel': old_model, 'images': old_images,
            'sha': contract['baseRevision'], 'migrations': pairs, 'originalRelease': release}


def contain(native, context):
    """Stop recognized old/new application writers; never restart or touch DBs."""
    ids = native.docker('ps', '-aq', '--filter',
                        'label=com.docker.compose.project=' + native.PROJECT).decode().split()
    native.require(ids, 'Rollback containment cannot identify native containers')
    items = json.loads(native.docker('inspect', *ids))
    stopped = []
    for name in ('backend', 'client'):
        matches = [item for item in items if
                   (item['Config'].get('Labels') or {}).get('com.docker.compose.service') == name]
        native.require(len(matches) == 1, 'Rollback writer identity is ambiguous')
        item = matches[0]
        labels = item['Config'].get('Labels') or {}
        native.require(labels.get('com.docker.compose.project') == native.PROJECT and
                       labels.get('com.docker.compose.project.working_dir') == str(native.ROOT / 'source') and
                       not item.get('Mounts'), 'Unknown writer prevents automatic rollback containment')
        known = {context['images'][name]: context['sha'],
                 context['before'][name]['image']: context['active']['sha']}
        native.require(item['Image'] in known and
                       native.image_info(item['Image'])['Config'].get('Labels', {}).get(
                           'org.opencontainers.image.revision') == known[item['Image']],
                       'Unknown writer image prevents automatic rollback containment')
        native.require(item['State']['Status'] in {'running', 'restarting', 'exited', 'created'},
                       'Unsupported writer state requires manual rollback containment')
        if item['State']['Status'] in {'running', 'restarting'}:
            native.docker('stop', '--time', '60', item['Id'], timeout=90)
        final = json.loads(native.docker('inspect', item['Id']))[0]
        native.require(final['Id'] == item['Id'] and final['Image'] == item['Image'] and
                       final['State']['Status'] in {'exited', 'created'} and
                       not final['State'].get('Running') and not final['State'].get('Restarting'),
                       'Rollback writer stop was not confirmed')
        stopped.append({'service': name, 'id': item['Id'], 'image': item['Image']})
    return {'phase': 'recognized-application-writers-stopped', 'containers': stopped, 'dataRestore': 'NOT_PERFORMED'}


def rollback(native, packet_root: Path, manifest: dict, operation: str, progress):
    with native.locked(root=True):
        context = preflight(native, Path(packet_root), manifest, operation)
        native.require(isinstance(progress.operation, str) and OPERATION.fullmatch(progress.operation) and
                       progress.operation != operation, 'A new rollback operation identity is required')
        operations = native.STATE / 'release-operations'
        transaction = operations / progress.operation
        transaction.mkdir(mode=0o700)
        native.receipt_directory(transaction)
        release = 'rybbit-native-update-' + time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '.' + secrets.token_hex(4)
        destination = native.STATE / release
        destination.mkdir(mode=0o700)
        native.receipt_directory(destination)
        environment = destination / 'deployment.env'
        native.write(environment, context['oldRaw'])
        native.write(destination / 'previous.env', context['currentRaw'])
        native.write(destination / 'previous-active.json', context['activeRaw'])
        attempt = {'phase': 'rollback-activating', 'operation': 'functional-image-rollback',
                   'release': release, 'sha': context['sha'], 'images': context['images'],
                   'before': context['before'], 'previousEnv': str(context['currentEnv']),
                   'rollbackOf': context['originalRelease'], 'originalOperation': operation,
                   'releaseOperation': progress.operation}
        native.record(destination / 'attempt.json', attempt)
        native.write(operations / 'pending.json', json.dumps(attempt) + '\n')
        native.write(native.STATE / 'pending.json', json.dumps(attempt) + '\n')
        activation_started = False
        stage = 'rolling_back'
        try:
            progress.publish(stage)
            native.require(native.snapshot() == context['before'] and
                           native.migration_pairs(context['before']) == context['migrations'],
                           'Runtime or journal changed before rollback activation')
            activation_started = True
            log_fd = os.open(destination / 'activation.log',
                             os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(log_fd, 'wb') as log:
                native.compose(environment, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never',
                               'backend', 'client', timeout=240, log=log)
            stage = 'verifying_rollback'
            progress.publish(stage)
            after = native.wait_ready(context['images'])
            native.infrastructure_unchanged(context['before'], after)
            native.verify_model_live(context['oldModel'], after)
            native.require(native.migration_pairs(after) == context['migrations'],
                           'Migration journal changed during application rollback')
            for name in ('backend', 'client'):
                native.require(after[name]['image'] == context['images'][name] and
                               native.image_info(after[name]['image'])['Config'].get('Labels', {}).get(
                                   'org.opencontainers.image.revision') == context['sha'],
                               'Rollback image or revision differs')
            native.readiness()
            receipt = {'phase': 'active', 'release': release, 'sha': context['sha'], 'runtime': after,
                       'envSha256': digest(environment), 'previousEnv': str(context['currentEnv']),
                       'images': context['images'], 'operation': 'functional-image-rollback',
                       'rollbackOf': context['originalRelease'], 'releaseOperation': progress.operation}
            result = {'operation': progress.operation, 'originalOperation': operation,
                      'phase': 'rolled-back-awaiting-functional-acceptance', 'releaseSha': context['sha'],
                      'images': context['images'], 'nativeRelease': release,
                      'functionalAcceptance': 'PENDING', 'dataRestore': 'NOT_PERFORMED', 'at': now()}
            progress.publish('rolled_back_awaiting_functional_acceptance')
            native.record(destination / 'success.json', receipt)
            native.record(native.STATE / 'active.json', receipt)
            native.record(transaction / 'success.json', result)
            os.replace(native.STATE / 'pending.json', destination / 'completed-pending.json')
            os.replace(operations / 'pending.json', transaction / 'completed-pending.json')
            return result
        except BaseException:
            if activation_started:
                try:
                    containment = contain(native, context)
                except BaseException:
                    containment = {'phase': 'containment-incomplete-manual-inspection-required'}
                native.record(transaction / 'containment.json', containment)
            # Completion of the two journals is not atomic. If its second rename
            # failed, restore the first marker after writers have been contained.
            for pending in (native.STATE / 'pending.json', operations / 'pending.json'):
                if not pending.exists() and not pending.is_symlink():
                    native.write(pending, json.dumps(attempt) + '\n')
            failure = {'phase': stage, 'result': 'HOLD: inspect private rollback before retry', 'at': now()}
            native.record(transaction / 'failure.json', failure)
            native.record(destination / 'failure.json', failure)
            progress.publish('hold')
            raise


if __name__ == '__main__':
    raise SystemExit('Use the reviewed root release packet and its distinct rollback acknowledgment.')
