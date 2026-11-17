"""Release orchestration regressions without SSH, Docker or root privileges."""
from contextlib import nullcontext
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch


SPEC = importlib.util.spec_from_file_location('native_release_under_test',
    Path(__file__).resolve().parents[1] / 'wotcv-native-release.py')
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name).resolve()
        self.state = self.root / 'state'
        self.state.mkdir()
        self.events = []
        self.progress = SimpleNamespace(operation='fixture-operation',
            publish=lambda phase: self.events.append(phase))
        self.manifest = {'version': 1, 'releaseSha': 'a' * 40,
                         'files': dict.fromkeys(release.FILES, 'b' * 64)}
        self.live = {'backend': {'id': 'new-backend', 'image': 'backend-image'},
                     'client': {'id': 'new-client', 'image': 'client-image'}}
        self.before = {'backend': {'id': 'old-backend', 'image': 'old-backend-image'},
                       'client': {'id': 'old-client', 'image': 'old-client-image'}}
        self.plan = {'sha': 'a' * 40, 'before': self.before,
                     'images': {'backend': 'backend-image', 'client': 'client-image'}}
        (self.root / 'bundle').mkdir()
        (self.root / 'bundle/plan.json').write_text(json.dumps(self.plan))
        def write(path, value):
            with path.open('x') as stream:
                stream.write(value)
        def record(path, value):
            path.write_text(json.dumps(value))
        self.native = SimpleNamespace(STATE=self.state, ACK='apply-ack', RECONCILE_ACK='reconcile-ack',
            locked=Mock(return_value=nullcontext()), receipt_directory=Mock(), write=write, record=record,
            reconcile=Mock(return_value={'phase': 'attested'}),
            snapshot=Mock(side_effect=[self.before, self.before, self.before, self.live]),
            migration_pairs=Mock(side_effect=[[{'hash': 'same'}], [{'hash': 'same'}], [{'hash': 'same'}]]),
            prepare=Mock(return_value=self.root / 'bundle'), load_plan=Mock(return_value=self.plan),
            apply=Mock(side_effect=lambda *args: (self.state / 'active.json').write_text('{}')),
            receipt_guard=Mock(), current_env=Mock(), config=Mock(),
            model_guard=Mock(), verify_model_live=Mock(), readiness=Mock(),
            image_info=Mock(return_value={'Config': {'Labels': {
                'org.opencontainers.image.revision': 'a' * 40}}}))
        def capture(native, path, progress):
            (path / 'fixture.dump').write_bytes(b'verified-backup')
            return {'phase': 'verified', 'drill': {'phase': 'passed'}, 'after': self.before,
                    'captureWindow': {'start': 'start', 'end': 'end'},
                    'artifacts': {'fixture.dump': {'sha256': hashlib.sha256(b'verified-backup').hexdigest()}}}
        self.backup = SimpleNamespace(capture_and_drill=Mock(side_effect=capture))
        self.private_patch = patch.object(release, 'private_directory')
        self.private_patch.start()
        self.addCleanup(self.private_patch.stop)

    def execute(self):
        return release.execute(self.native, self.backup, self.root, self.manifest, self.progress)

    def test_success_binds_release_and_backup_and_preserves_acceptance_gap(self):
        result = self.execute()
        self.native.locked.assert_called_once_with(root=True)
        self.native.reconcile.assert_called_once_with(self.root / release.FILES['restartContract'],
            'b' * 64, 'reconcile-ack')
        self.native.prepare.assert_called_once_with('a' * 40,
            self.root / release.FILES['codeContract'], 'b' * 64)
        self.native.apply.assert_called_once_with(self.root / 'bundle', 'apply-ack', 'b' * 64)
        self.assertEqual(result['functionalAcceptance'], 'PENDING')
        self.assertEqual(result['applicationRestoreDrill'], 'NOT_TESTED')
        self.assertTrue(result['backupEngineRestoreVerified'])
        self.assertFalse((self.state / 'release-operations/pending.json').exists())
        self.assertTrue((self.state / 'release-operations/fixture-operation/completed-pending.json').exists())
        self.assertEqual(self.events[-1], 'activated_awaiting_functional_acceptance')

    def test_migration_comparison_never_queries_removed_old_backend_after_apply(self):
        self.execute()
        self.assertEqual(self.native.migration_pairs.call_args_list[0].args, (self.before,))
        self.assertEqual(self.native.migration_pairs.call_args_list[1].args, (self.before,))
        self.assertEqual(self.native.migration_pairs.call_args_list[2].args, (self.live,))
        self.assertEqual(self.native.migration_pairs.call_count, 3)

    def test_pending_native_or_release_transaction_blocks_all_mutations(self):
        for own in (False, True):
            with self.subTest(own=own):
                target = self.state / ('release-operations' if own else '.')
                target.mkdir(exist_ok=True)
                (target / 'pending.json').write_text('{}')
                with self.assertRaises(release.Refused):
                    self.execute()
                self.native.reconcile.assert_not_called()
                self.backup.capture_and_drill.assert_not_called()
                (target / 'pending.json').unlink()

    def test_unverified_backup_blocks_prepare_and_apply_and_retains_pending(self):
        self.backup.capture_and_drill = Mock(return_value={'phase': 'verified', 'drill': {'phase': 'failed'}})
        with self.assertRaises(release.Refused):
            self.execute()
        self.native.prepare.assert_not_called()
        self.native.apply.assert_not_called()
        self.assertTrue((self.state / 'release-operations/pending.json').exists())
        failure = json.loads((self.state / 'release-operations/fixture-operation/failure.json').read_text())
        self.assertEqual(failure['phase'], 'backup_preflight')
        self.assertEqual(self.events[-1], 'hold')

    def test_backup_failure_never_prepares_release(self):
        self.backup.capture_and_drill.side_effect = RuntimeError('private credential must not enter status')
        with self.assertRaises(RuntimeError):
            self.execute()
        self.native.prepare.assert_not_called()
        self.native.apply.assert_not_called()
        failure = (self.state / 'release-operations/fixture-operation/failure.json').read_text()
        self.assertNotIn('credential', failure)

    def test_changed_runtime_or_prepared_revision_blocks_apply(self):
        self.plan['sha'] = 'c' * 40
        with self.assertRaises(release.Refused):
            self.execute()
        self.native.apply.assert_not_called()

    def test_changed_backup_bytes_after_build_blocks_apply(self):
        def prepare(*args):
            (self.state / 'release-operations/fixture-operation/backup/fixture.dump').write_bytes(b'tampered')
            return self.root / 'bundle'
        self.native.prepare.side_effect = prepare
        with self.assertRaises(release.Refused):
            self.execute()
        self.native.apply.assert_not_called()

    def test_changed_journal_or_image_revision_leaves_operation_pending(self):
        self.native.migration_pairs.side_effect = [[{'hash': 'same'}], [{'hash': 'same'}], [{'hash': 'changed'}]]
        with patch.object(release, 'contain_release', return_value={'phase': 'candidate-writers-stopped'}) as contain:
            with self.assertRaises(release.Refused):
                self.execute()
            contain.assert_called_once_with(self.native, self.plan)
        self.assertTrue((self.state / 'release-operations/pending.json').exists())
        self.assertFalse((self.state / 'release-operations/fixture-operation/success.json').exists())
        self.assertEqual(self.events[-1], 'hold')

    def test_changed_journal_before_apply_never_activates(self):
        self.native.migration_pairs.side_effect = [[{'hash': 'same'}], [{'hash': 'changed'}]]
        with self.assertRaises(release.Refused):
            self.execute()
        self.native.apply.assert_not_called()

    def test_interrupted_apply_contains_candidate_and_preserves_pending(self):
        self.native.apply.side_effect = KeyboardInterrupt()
        with patch.object(release, 'contain_release', return_value={'phase': 'candidate-writers-stopped'}) as contain:
            with self.assertRaises(KeyboardInterrupt):
                self.execute()
            contain.assert_called_once_with(self.native, self.plan)
        self.assertTrue((self.state / 'release-operations/pending.json').exists())
        self.assertEqual(self.events[-1], 'hold')

    def test_final_progress_failure_keeps_recovery_pending(self):
        def publish(phase):
            if phase == 'activated_awaiting_functional_acceptance':
                raise OSError('status unavailable')
        self.progress.publish = publish
        with patch.object(release, 'contain_release', return_value={'phase': 'candidate-writers-stopped'}):
            with self.assertRaises(OSError):
                self.execute()
        self.assertTrue((self.state / 'release-operations/pending.json').exists())
        self.assertFalse((self.state / 'release-operations/fixture-operation/completed-pending.json').exists())

    def test_containment_stops_only_owned_candidate_and_never_databases(self):
        self.native.PROJECT = 'fixture'
        self.native.ROOT = self.root
        items = [{'Id': name + '-id', 'Image': name + '-image', 'Mounts': [],
                  'State': {'Status': 'running'}, 'Config': {'Labels': {
                    'com.docker.compose.project': 'fixture', 'com.docker.compose.service': name,
                    'com.docker.compose.project.working_dir': str(self.root / 'source')}}}
                 for name in ('backend', 'client')]
        items[0]['State'] = {'Status': 'restarting', 'Restarting': True}
        def docker(*args, **kwargs):
            if args[0] == 'ps':
                return b'backend-id\nclient-id'
            if args[0] == 'inspect':
                if len(args) == 2:
                    return json.dumps([item for item in items if item['Id'] == args[1]]).encode()
                return json.dumps(items).encode()
            if args[0] == 'stop':
                self.assertIn(args[-1], ('backend-id', 'client-id'))
                next(item for item in items if item['Id'] == args[-1])['State'] = {'Status': 'exited'}
                return b''
            self.fail('Unexpected mutation')
        self.native.docker = Mock(side_effect=docker)
        result = release.contain_release(self.native, self.plan)
        self.assertEqual(result['phase'], 'candidate-writers-stopped')
        self.assertEqual([call.args[-1] for call in self.native.docker.call_args_list
                          if call.args[0] == 'stop'], ['backend-id', 'client-id'])
        items[0]['Image'] = 'foreign-image'
        self.native.docker.reset_mock()
        with self.assertRaises(release.Refused):
            release.contain_release(self.native, self.plan)
        self.assertFalse(any(call.args[0] == 'stop' for call in self.native.docker.call_args_list))

    def test_packet_rejects_changed_manifest_before_importing_modules(self):
        path = self.root / 'manifest.json'
        path.write_text(json.dumps(self.manifest))
        with patch.object(release, 'private_file'), patch.object(release, 'load_module') as load:
            with self.assertRaisesRegex(release.Refused, 'manifest hash differs'):
                release.load_packet(path, '0' * 64)
            load.assert_not_called()

    def test_packet_verifies_every_file_and_exact_interface(self):
        for role, name in release.FILES.items():
            path = self.root / name
            path.write_bytes(role.encode())
            self.manifest['files'][role] = release.digest(path)
        path = self.root / 'manifest.json'
        path.write_text(json.dumps(self.manifest))
        with patch.object(release, 'private_file'):
            self.assertEqual(release.load_packet(path, release.digest(path)), self.manifest)
            (self.root / release.FILES['backup']).write_bytes(b'changed')
            with self.assertRaisesRegex(release.Refused, 'packet file changed'):
                release.load_packet(path, release.digest(path))


if __name__ == '__main__':
    unittest.main()
