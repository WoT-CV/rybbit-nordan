"""Offline functional rollback regressions; never contact Docker, SSH or DBs."""
from contextlib import ExitStack, nullcontext
from copy import deepcopy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch


SPEC = importlib.util.spec_from_file_location('native_rollback_under_test',
    Path(__file__).resolve().parents[1] / 'wotcv-native-rollback.py')
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


class Refused(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise Refused(message)


def canonical_hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


class RollbackTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory())).resolve()
        self.stack.enter_context(patch.object(module.os, 'geteuid', return_value=0, create=True))
        if not hasattr(module.os, 'O_NOFOLLOW'):
            self.stack.enter_context(patch.object(module.os, 'O_NOFOLLOW', 0, create=True))
        self.state = self.root / 'state'
        self.state.mkdir()
        self.install = self.root / 'installation'
        self.install.mkdir()
        self.operation = '20261117T180000Z-1234abcd'
        self.new_operation = '20261117T190000Z-5678abcd'
        self.release = 'rybbit-native-update-20261117T180000Z.1234abcd'
        self.original = self.state / 'release-operations' / self.operation
        self.original.mkdir(parents=True)
        self.backup = self.original / 'backup'
        self.backup.mkdir()
        self.source = self.state / self.release
        self.source.mkdir()
        self.old_sha, self.new_sha = 'a' * 40, 'b' * 40
        self.old_images = {'backend': 'sha256:' + '1' * 64, 'client': 'sha256:' + '2' * 64}
        self.new_images = {'backend': 'sha256:' + '3' * 64, 'client': 'sha256:' + '4' * 64}
        self.before = {name: {'id': 'current-' + name, 'image': identity}
                       for name, identity in self.new_images.items()}
        self.old = {name: {'id': 'previous-' + name, 'image': identity}
                    for name, identity in self.old_images.items()}
        for name in ('postgres', 'clickhouse', 'redis'):
            self.before[name] = {'id': name, 'image': 'unchanged-' + name, 'started': 'unchanged'}
            self.old[name] = deepcopy(self.before[name])
        self.after = deepcopy(self.before)
        for name in ('backend', 'client'):
            self.after[name] = {'id': 'rollback-' + name, 'image': self.old_images[name]}
        self.pairs = [{'createdAt': str(i), 'sha256': str(i % 10) * 64} for i in range(25)]
        self.old_raw, self.current_raw = b'old-private-env\n', b'current-private-env\n'
        self.env = self.source / 'deployment.env'
        self.env.write_bytes(self.current_raw)
        (self.source / 'previous.env').write_bytes(self.old_raw)
        (self.backup / 'previous.env').write_bytes(self.old_raw)
        self.active = {'phase': 'active', 'release': self.release, 'sha': self.new_sha,
                       'runtime': self.before, 'images': self.new_images}
        self.write_json(self.state / 'active.json', self.active)
        (self.source / 'success.json').write_bytes((self.state / 'active.json').read_bytes())
        self.write_json(self.source / 'attempt.json', {'release': self.release, 'sha': self.new_sha,
                                                       'images': self.new_images, 'before': self.old})
        self.result = {'operation': self.operation, 'phase': 'activated-awaiting-functional-acceptance',
                       'releaseSha': self.new_sha, 'images': self.new_images,
                       'backupEngineRestoreVerified': True, 'nativeRelease': self.release,
                       'nativeActiveReceiptSha256': module.digest(self.state / 'active.json'),
                       'migrationPairs': self.pairs}
        self.write_json(self.original / 'success.json', self.result)
        self.write_json(self.original / 'completed-pending.json',
                        {'operation': self.operation, 'releaseSha': self.new_sha})
        old_hash = hashlib.sha256(self.old_raw).hexdigest()
        self.write_json(self.backup / 'verified.json', {'phase': 'verified', 'drill': {'phase': 'passed'},
            'after': self.old, 'artifacts': {'previous.env': {'sha256': old_hash}}})
        self.write_json(self.install / 'state.json', {'project': 'fixture', 'source': 'sealed', 'sourceFiles': {'fixture': 'hash'}})
        self.contract = {'baseRevision': self.old_sha, 'baseImages': self.old_images, 'envSha256': old_hash,
                         'postgresMigrations': {'count': 25, 'sha256': canonical_hash(self.pairs)}}
        self.current_model = {'services': {name: {'image': image, 'environment': {}}
                                          for name, image in self.new_images.items()}}
        self.current_model['services']['backend']['environment']['SOURCE_CODE_URL'] = 'https://fixture/tree/' + self.new_sha
        self.old_model = deepcopy(self.current_model)
        for name in self.old_images:
            self.old_model['services'][name]['image'] = self.old_images[name]
        self.old_model['services']['backend']['environment']['SOURCE_CODE_URL'] = 'https://fixture/tree/' + self.old_sha
        def write(path, value):
            with path.open('xb') as stream:
                stream.write(value.encode() if isinstance(value, str) else value)
        self.native = SimpleNamespace(
            Refused=Refused, require=require, STATE=self.state, ROOT=self.install, PROJECT='fixture', BASELINE='sealed',
            REMOTE='https://fixture', DATABASES=dict.fromkeys(('postgres', 'clickhouse', 'redis')),
            locked=Mock(return_value=nullcontext()), receipt_directory=Mock(),
            receipt_file=lambda path: path.read_bytes(), write=write, record=self.write_json,
            snapshot=Mock(return_value=self.before), receipt_guard=Mock(),
            infrastructure_unchanged=Mock(), source_hashes=Mock(return_value={'fixture': 'hash'}),
            read_reconciliation_contract=Mock(return_value=(b'reviewed-contract', self.contract)),
            image_info=Mock(side_effect=lambda identity: {'Id': identity, 'Config': {'Labels': {
                'org.opencontainers.image.revision': self.old_sha if identity in self.old_images.values() else self.new_sha}}}),
            migration_pairs=Mock(return_value=self.pairs), canonical_hash=canonical_hash,
            current_env=Mock(return_value=self.env),
            config=Mock(side_effect=lambda path: self.old_model if path.name == 'previous.env' else self.current_model),
            model_guard=Mock(), verify_model_live=Mock(), readiness=Mock(), compose=Mock(),
            wait_ready=Mock(return_value=self.after), docker=Mock(side_effect=AssertionError('Real Docker forbidden')))
        self.manifest = {'releaseSha': self.new_sha, 'files': {'restartContract': 'c' * 64}}
        self.events = []
        self.progress = SimpleNamespace(operation=self.new_operation, publish=self.events.append)

    @staticmethod
    def write_json(path, value):
        path.write_text(json.dumps(value))

    def run_rollback(self):
        return module.rollback(self.native, self.root, self.manifest, self.operation, self.progress)

    def test_success_restores_only_old_images_and_records_new_history(self):
        previous_active = (self.state / 'active.json').read_bytes()
        result = self.run_rollback()
        self.native.locked.assert_called_once_with(root=True)
        args = self.native.compose.call_args.args
        self.assertEqual(args[1:], ('up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'backend', 'client'))
        active = json.loads((self.state / 'active.json').read_bytes())
        self.assertEqual(active['sha'], self.old_sha)
        self.assertEqual(active['images'], self.old_images)
        self.assertNotEqual(active['release'], self.release)
        destination = self.state / active['release']
        self.assertEqual((destination / 'deployment.env').read_bytes(), self.old_raw)
        self.assertEqual((destination / 'previous.env').read_bytes(), self.current_raw)
        self.assertEqual((destination / 'previous-active.json').read_bytes(), previous_active)
        self.assertEqual((self.source / 'success.json').read_bytes(), previous_active)
        self.assertFalse((self.state / 'pending.json').exists())
        self.assertFalse((self.state / 'release-operations/pending.json').exists())
        self.assertEqual(result['dataRestore'], 'NOT_PERFORMED')
        self.assertEqual(result['functionalAcceptance'], 'PENDING')
        self.native.docker.assert_not_called()

    def test_invalid_operation_cannot_select_arbitrary_path(self):
        with self.assertRaisesRegex(Refused, 'exact completed'):
            module.rollback(self.native, self.root, self.manifest, '../foreign', self.progress)
        self.native.compose.assert_not_called()

    def test_pending_state_blocks_preflight_and_all_mutations(self):
        (self.state / 'pending.json').write_text('{}')
        with self.assertRaisesRegex(Refused, 'Pending'):
            self.run_rollback()
        self.native.compose.assert_not_called()

    def test_active_receipt_hash_mismatch_blocks_other_releases(self):
        self.write_json(self.state / 'active.json', {'different': True})
        with self.assertRaisesRegex(Refused, 'Active receipt differs'):
            self.run_rollback()
        self.native.compose.assert_not_called()

    def test_runtime_restart_drift_blocks_rollback(self):
        drift = deepcopy(self.before)
        drift['postgres']['started'] = 'restarted'
        self.native.snapshot.return_value = drift
        with self.assertRaisesRegex(Refused, 'Runtime drift'):
            self.run_rollback()
        self.native.compose.assert_not_called()

    def test_journal_change_blocks_rollback_before_activation(self):
        self.native.migration_pairs.return_value = []
        with self.assertRaisesRegex(Refused, 'Migration journal drift'):
            self.run_rollback()
        self.native.compose.assert_not_called()

    def test_changed_old_env_or_config_blocks_rollback(self):
        (self.source / 'previous.env').write_bytes(b'tampered')
        with self.assertRaisesRegex(Refused, 'previous environment'):
            self.run_rollback()
        self.native.compose.assert_not_called()

    def test_config_changes_beyond_images_are_rejected(self):
        self.old_model['services']['backend']['environment']['UNKNOWN'] = 'changed'
        with self.assertRaisesRegex(Refused, 'settings beyond'):
            self.run_rollback()
        self.native.compose.assert_not_called()

    def test_old_image_revision_must_match_reviewed_restart_contract(self):
        self.native.image_info.return_value = None
        self.native.image_info.side_effect = lambda identity: {'Id': identity, 'Config': {'Labels': {
            'org.opencontainers.image.revision': 'wrong'}}}
        with self.assertRaisesRegex(Refused, 'revision is unavailable'):
            self.run_rollback()
        self.native.compose.assert_not_called()

    def test_failed_or_interrupted_activation_keeps_both_pending_and_contains(self):
        self.native.compose.side_effect = KeyboardInterrupt()
        with patch.object(module, 'contain', return_value={'phase': 'stopped'}) as contain:
            with self.assertRaises(KeyboardInterrupt):
                self.run_rollback()
            contain.assert_called_once()
        self.assertTrue((self.state / 'pending.json').exists())
        self.assertTrue((self.state / 'release-operations/pending.json').exists())
        self.assertEqual(json.loads((self.state / 'active.json').read_bytes()), self.active)
        self.assertEqual(self.events[-1], 'hold')

    def test_final_reporting_failure_cannot_clear_pending_or_claim_success(self):
        def publish(phase):
            if phase == 'rolled_back_awaiting_functional_acceptance':
                raise RuntimeError('report unavailable')
            self.events.append(phase)
        self.progress.publish = publish
        with patch.object(module, 'contain', return_value={'phase': 'stopped'}):
            with self.assertRaisesRegex(RuntimeError, 'report unavailable'):
                self.run_rollback()
        self.assertTrue((self.state / 'pending.json').exists())
        self.assertTrue((self.state / 'release-operations/pending.json').exists())
        self.assertFalse((self.state / 'release-operations' / self.new_operation / 'success.json').exists())

    def test_post_activation_journal_failure_contains_and_keeps_current_receipt(self):
        self.native.migration_pairs.side_effect = [self.pairs, self.pairs, self.pairs, []]
        with patch.object(module, 'contain', return_value={'phase': 'stopped'}):
            with self.assertRaisesRegex(Refused, 'during application rollback'):
                self.run_rollback()
        self.assertEqual(json.loads((self.state / 'active.json').read_bytes()), self.active)
        self.assertTrue((self.state / 'pending.json').exists())

    def test_containment_stops_running_and_restarting_known_apps_never_databases(self):
        context = module.preflight(self.native, self.root, self.manifest, self.operation)
        items = []
        for name, status in (('backend', 'running'), ('client', 'restarting')):
            items.append({'Id': name, 'Image': self.old_images[name] if name == 'backend' else self.new_images[name],
                'Mounts': [], 'State': {'Status': status, 'Running': True, 'Restarting': status == 'restarting'},
                'Config': {'Labels': {'com.docker.compose.project': 'fixture', 'com.docker.compose.service': name,
                                      'com.docker.compose.project.working_dir': str(self.install / 'source')}}})
        def docker(*args, **kwargs):
            if args[0] == 'ps':
                return b'backend\nclient\npostgres'
            if args[0] == 'inspect':
                return json.dumps([item for item in items if len(args) > 2 or item['Id'] == args[1]]).encode()
            if args[0] == 'stop':
                self.assertIn(args[-1], ('backend', 'client'))
                next(item for item in items if item['Id'] == args[-1])['State'] = {
                    'Status': 'exited', 'Running': False, 'Restarting': False}
                return b''
            self.fail('Unexpected containment mutation')
        self.native.docker.side_effect = docker
        result = module.contain(self.native, context)
        self.assertEqual(result['phase'], 'recognized-application-writers-stopped')
        self.assertEqual([call.args[-1] for call in self.native.docker.call_args_list if call.args[0] == 'stop'],
                         ['backend', 'client'])
        items[0]['Image'] = 'foreign'
        self.native.docker.reset_mock()
        with self.assertRaisesRegex(Refused, 'Unknown writer image'):
            module.contain(self.native, context)
        self.assertFalse(any(call.args[0] == 'stop' for call in self.native.docker.call_args_list))

    def test_second_completion_rename_failure_restores_both_pending_after_containment(self):
        original_replace = module.os.replace
        def replace(source, target):
            if source == self.state / 'release-operations/pending.json':
                raise OSError('second journal unavailable')
            return original_replace(source, target)
        with patch.object(module.os, 'replace', side_effect=replace), \
                patch.object(module, 'contain', return_value={'phase': 'stopped'}):
            with self.assertRaisesRegex(OSError, 'second journal'):
                self.run_rollback()
        self.assertTrue((self.state / 'pending.json').exists())
        self.assertTrue((self.state / 'release-operations/pending.json').exists())


if __name__ == '__main__':
    unittest.main()
