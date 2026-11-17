#!/usr/bin/env python3
"""Reviewed root-only restart attestation, backup drill and native release.

Run only the hash-reviewed operator packet. Credentials stay in private engine
authentication/configuration files, never in this program or its public report.
The packet requires existing deployment authorization and never restores live data.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import sys
import time


ACK = 'backup-reconcile-deploy-native-rybbit'
ROLLBACK_ACK = 'rollback-native-reviewed-release'
PUBLIC = Path('/var/tmp/rybbit-native-release-progress-20261117')
PHASES = {'validating', 'reconciling_restart', 'backup_preflight', 'backup_stopping_apps',
          'backup_capturing', 'backup_resuming_old_apps', 'backup_restoring_isolated_databases',
          'backup_verified', 'building_release', 'checking_release', 'activating',
          'verifying_activation', 'activated_awaiting_functional_acceptance',
          'rolling_back', 'verifying_rollback', 'rolled_back_awaiting_functional_acceptance',
          'recovering_failed_operation', 'recovering_failed_drill', 'hold'}
FILES = {'updater': 'wotcv-native-update.py', 'backup': 'wotcv-native-backup.py',
         'rollback': 'wotcv-native-rollback.py',
         'recovery': 'wotcv-native-recovery.py', 'recoveryContract': 'recovery-20261117.json',
         'drillRecovery': 'wotcv-native-drill-recovery.py',
         'drillRecoveryContract': 'drill-recovery-20261117.json',
         'codeContract': 'reviewed-code-20261117.json', 'restartContract': 'restart-20261116.json'}
HEX = re.compile(r'[0-9a-f]{64}\Z')


class Refused(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise Refused(message)


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def private_directory(path):
    require(path.is_dir() and not path.is_symlink() and path.resolve() == path,
            'Expected canonical private packet directory')
    stat = path.stat()
    require(stat.st_uid == 0 and stat.st_mode & 0o077 == 0, 'Packet directory must be root-owned/private')


def private_file(path):
    require(path.is_file() and not path.is_symlink() and path.resolve() == path,
            'Expected canonical private packet file')
    stat = path.stat()
    require(stat.st_uid == 0 and stat.st_mode & 0o077 == 0 and stat.st_size <= 2000000,
            'Packet file ownership, size or privacy is invalid')


def load_packet(path, expected):
    require(isinstance(expected, str) and HEX.fullmatch(expected), 'Explicit packet manifest hash required')
    root = path.parent
    private_directory(root)
    private_file(path)
    require(digest(path) == expected, 'Packet manifest hash differs from reviewed value')
    manifest = json.loads(path.read_bytes())
    require(isinstance(manifest, dict) and set(manifest) == {'version', 'releaseSha', 'files'} and
            type(manifest['version']) is int and manifest['version'] == 1 and
            isinstance(manifest['releaseSha'], str) and re.fullmatch(r'[0-9a-f]{40}', manifest['releaseSha']),
            'Invalid release packet manifest')
    require(isinstance(manifest['files'], dict) and set(manifest['files']) == set(FILES),
            'Release packet files differ from reviewed interface')
    for role, filename in FILES.items():
        identity = manifest['files'][role]
        require(isinstance(identity, str) and HEX.fullmatch(identity), 'Invalid packet file hash')
        target = root / filename
        private_file(target)
        require(digest(target) == identity, 'Reviewed packet file changed')
    return manifest


def load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Progress:
    """Only fixed phase names and public Git/image identities are published."""
    def __init__(self, release, operation):
        if not PUBLIC.exists():
            PUBLIC.mkdir(mode=0o755)
        require(PUBLIC.is_dir() and not PUBLIC.is_symlink() and PUBLIC.resolve() == PUBLIC and
                PUBLIC.stat().st_uid == 0 and PUBLIC.stat().st_mode & 0o022 == 0,
                'Unsafe public progress directory')
        self.release = release
        self.operation = operation
        self.last = 'validating'

    def publish(self, phase):
        require(phase in PHASES, 'Unknown release progress phase')
        self.last = phase
        value = {'version': 1, 'operation': self.operation, 'releaseSha': self.release,
                 'phase': phase, 'pid': os.getpid(),
                 'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
        temporary = PUBLIC / ('.progress-' + secrets.token_hex(8))
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
        try:
            with os.fdopen(fd, 'w') as stream:
                json.dump(value, stream)
                stream.write('\n')
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, PUBLIC / 'current.json')
        finally:
            temporary.unlink(missing_ok=True)
        print('PHASE: ' + phase, flush=True)


def contain_release(native, plan):
    """Stop only this candidate's verified writers after failed post-apply gates."""
    ids = native.docker('ps', '-aq', '--filter',
                        'label=com.docker.compose.project=' + native.PROJECT).decode().split()
    require(ids, 'No candidate containers available for containment')
    items = json.loads(native.docker('inspect', *ids))
    stopped = []
    for name in ('backend', 'client'):
        matches = [item for item in items if
                   (item['Config'].get('Labels') or {}).get('com.docker.compose.service') == name]
        require(len(matches) == 1, 'Candidate writer identity is ambiguous')
        item = matches[0]
        labels = item['Config'].get('Labels') or {}
        require(labels.get('com.docker.compose.project') == native.PROJECT and
                labels.get('com.docker.compose.project.working_dir') == str(native.ROOT / 'source') and
                not item.get('Mounts'), 'Refusing to stop an unrecognized application writer')
        if item['Image'] == plan['before'][name]['image']:
            # Native apply may already have completed its image rollback.
            continue
        require(item['Image'] == plan['images'][name] and
                native.image_info(item['Image'])['Config'].get('Labels', {}).get(
                    'org.opencontainers.image.revision') == plan['sha'],
                'Refusing to stop an unrecognized application writer')
        status = item['State']['Status']
        require(status in {'running', 'restarting', 'exited', 'created'},
                'Candidate writer has an unsupported containment state')
        if status in {'running', 'restarting'}:
            native.docker('stop', '--time', '60', item['Id'], timeout=90)
        final = json.loads(native.docker('inspect', item['Id']))[0]
        require(final['Id'] == item['Id'] and final['Image'] == item['Image'] and
                final['State']['Status'] in {'exited', 'created'} and
                not final['State'].get('Running') and not final['State'].get('Restarting'),
                'Candidate writer stop was not confirmed')
        stopped.append({'service': name, 'id': item['Id'], 'image': item['Image']})
    return {'phase': 'candidate-writers-stopped' if stopped else 'old-applications-retained', 'containers': stopped,
            'dataRestore': 'NOT_PERFORMED', 'automaticImageRollback': 'NOT_PERFORMED'}


def execute(native, backup, root, manifest, progress, recovery=None, failed_operation=None,
            drill_recovery=None, failed_drill=None):
    # The orchestration has one lock scope; component functions do not relock.
    with native.locked(root=True):
        native.receipt_directory(native.STATE)
        require(not (native.STATE / 'pending.json').exists() and not (native.STATE / 'pending.json').is_symlink(),
                'Pending activation requires inspection')
        operations = native.STATE / 'release-operations'
        operations.mkdir(mode=0o700, exist_ok=True)
        private_directory(operations)
        pending = operations / 'pending.json'
        require(failed_operation is None or failed_drill is None, 'Select only one recovery mode')
        if failed_operation is None and failed_drill is None:
            require(not pending.exists() and not pending.is_symlink(), 'Previous release operation requires inspection')
        elif failed_operation is not None:
            require(recovery is not None, 'Reviewed recovery module required')
        else:
            require(drill_recovery is not None, 'Reviewed drill recovery module required')
        transaction = operations / progress.operation
        transaction.mkdir(mode=0o700)
        private_directory(transaction)
        stage = ('recovering_failed_drill' if failed_drill is not None else
                 'recovering_failed_operation' if failed_operation is not None else 'reconciling_restart')
        activated = False
        try:
            if failed_drill is not None:
                progress.publish(stage)
                prior_capture = drill_recovery.supersede(native, root, manifest, failed_drill,
                                                        progress.operation, transaction)
            elif failed_operation is not None:
                progress.publish(stage)
                recovery.supersede(native, root, manifest, failed_operation, progress.operation, transaction)
            else:
                native.write(pending, json.dumps({'operation': progress.operation,
                                                 'releaseSha': manifest['releaseSha']}) + '\n')
            require(json.loads(native.receipt_file(pending)) == {
                'operation': progress.operation, 'releaseSha': manifest['releaseSha']},
                'Release operation marker does not bind this attempt')
            stage = 'reconciling_restart'
            progress.publish(stage)
            reconciliation = native.reconcile(root / FILES['restartContract'],
                                              manifest['files']['restartContract'], native.RECONCILE_ACK)
            native.record(transaction / 'reconciliation.json', reconciliation)
            capture = transaction / 'backup'
            capture.mkdir(mode=0o700)
            stage = 'backup_preflight'
            evidence = (backup.resume_drill(native, capture, prior_capture, progress.publish)
                        if failed_drill is not None else backup.capture_and_drill(native, capture, progress.publish))
            require(evidence.get('phase') == 'verified' and evidence.get('drill', {}).get('phase') == 'passed',
                    'Backup and isolated engine restore must pass before release preparation')
            require(native.snapshot() == evidence['after'], 'Runtime changed after backup validation')
            migrations_before = native.migration_pairs(native.snapshot())
            stage = 'building_release'
            progress.publish(stage)
            bundle = native.prepare(manifest['releaseSha'], root / FILES['codeContract'],
                                    manifest['files']['codeContract'])
            stage = 'checking_release'
            progress.publish(stage)
            plan = native.load_plan(bundle, manifest['files']['codeContract'])
            require(plan['sha'] == manifest['releaseSha'] and
                    plan['before'] == evidence['after'] and native.snapshot() == plan['before'],
                    'Prepared release or runtime changed')
            # Re-read verified backup bytes before activation; no data restore occurs.
            for name, artifact in evidence['artifacts'].items():
                require(isinstance(name, str) and Path(name).name == name and
                        digest(capture / name) == artifact['sha256'], 'Verified backup artifact changed')
            require(native.migration_pairs(plan['before']) == migrations_before,
                    'Migration journal changed before activation')
            stage = 'activating'
            progress.publish(stage)
            native.apply(bundle, native.ACK, manifest['files']['codeContract'])
            activated = True
            stage = 'verifying_activation'
            progress.publish(stage)
            live = native.snapshot()
            native.receipt_guard(live)
            environment = native.current_env()
            model = native.config(environment)
            native.model_guard(model, live)
            native.verify_model_live(model, live)
            native.readiness()
            require(all(live[name]['image'] == plan['images'][name] and
                        native.image_info(live[name]['image'])['Config'].get('Labels', {}).get(
                            'org.opencontainers.image.revision') == manifest['releaseSha']
                        for name in ('backend', 'client')), 'Active release images or revision differ')
            require(native.migration_pairs(live) == migrations_before,
                    'Migration journal changed unexpectedly')
            result = {'operation': progress.operation, 'phase': 'activated-awaiting-functional-acceptance',
                      'releaseSha': manifest['releaseSha'], 'images': plan['images'],
                      'nativeRelease': bundle.name,
                      'nativeActiveReceiptSha256': digest(native.STATE / 'active.json'),
                      'planSha256': digest(bundle / 'plan.json'), 'migrationPairs': migrations_before,
                      'backupEngineRestoreVerified': True, 'backupCaptureWindow': evidence['captureWindow'],
                      'applicationRestoreDrill': 'NOT_TESTED', 'functionalAcceptance': 'PENDING',
                      'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
            progress.publish('activated_awaiting_functional_acceptance')
            native.record(transaction / 'success.json', result)
            os.replace(pending, transaction / 'completed-pending.json')
            return result
        except BaseException as error:
            if activated or stage == 'activating':
                try:
                    containment = contain_release(native, plan)
                except BaseException:
                    containment = {'phase': 'containment-incomplete-manual-inspection-required'}
                native.record(transaction / 'containment.json', containment)
            frames = []
            trace = error.__traceback__
            while trace:
                filename = Path(trace.tb_frame.f_code.co_filename).name
                if filename in {'wotcv-native-release.py', 'wotcv-native-update.py', 'wotcv-native-backup.py'}:
                    frames.append({'file': filename, 'line': trace.tb_lineno})
                trace = trace.tb_next
            observed_stage = getattr(progress, 'last', stage) if stage == 'backup_preflight' else stage
            failure = {'phase': observed_stage if observed_stage in PHASES else stage,
                       'errorType': type(error).__name__, 'sites': frames,
                       'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                       'result': 'HOLD: inspect private transaction before retry'}
            native.record(transaction / 'failure.json', failure)
            print(json.dumps({'operation': progress.operation, **failure}), flush=True)
            progress.publish('hold')
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', required=True, type=Path)
    parser.add_argument('--manifest-sha256', required=True)
    parser.add_argument('--ack', required=True)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--rollback-operation')
    mode.add_argument('--resume-failed-operation')
    mode.add_argument('--resume-failed-drill')
    args = parser.parse_args()
    expected_ack = ROLLBACK_ACK if args.rollback_operation is not None else ACK
    require(hasattr(os, 'geteuid') and os.geteuid() == 0 and args.ack == expected_ack,
            'Operator sudo and reviewed release acknowledgment required')
    manifest = load_packet(args.manifest, args.manifest_sha256)
    root = args.manifest.parent
    native = load_module(root / FILES['updater'], 'reviewed_native_updater')
    operation = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + secrets.token_hex(4)
    progress = Progress(manifest['releaseSha'], operation)
    try:
        if args.rollback_operation is not None:
            rollback = load_module(root / FILES['rollback'], 'reviewed_native_rollback')
            result = rollback.rollback(native, root, manifest, args.rollback_operation, progress)
        else:
            backup = load_module(root / FILES['backup'], 'reviewed_native_backup')
            recovery = (load_module(root / FILES['recovery'], 'reviewed_native_recovery')
                        if args.resume_failed_operation is not None else None)
            drill_recovery = (load_module(root / FILES['drillRecovery'], 'reviewed_native_drill_recovery')
                              if args.resume_failed_drill is not None else None)
            result = execute(native, backup, root, manifest, progress, recovery, args.resume_failed_operation,
                             drill_recovery, args.resume_failed_drill)
    except BaseException:
        progress.publish('hold')
        raise
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    sys.dont_write_bytecode = True
    try:
        main()
    except (Exception, KeyboardInterrupt):
        print('HOLD: operator packet stopped; inspect its sanitized progress and private transaction before retry.')
        raise SystemExit(1) from None
