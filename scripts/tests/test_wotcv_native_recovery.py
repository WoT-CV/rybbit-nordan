"""Offline pre-capture HOLD supersession; no Docker, network, SSH or real state."""
from copy import deepcopy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock


SCRIPTS = Path(__file__).resolve().parents[1]


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / filename)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


module = load('recovery_under_test', 'wotcv-native-recovery.py')
updater = load('recovery_native_helpers', 'wotcv-native-update.py')


def raw_json(value):
    return (json.dumps(value, indent=2) + '\n').encode()


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.state_root = self.root / 'state'
        self.operations = self.state_root / 'release-operations'
        self.failed = '20261117T150812Z-033f7aea'
        self.new = '20261117T180000Z-1234abcd'
        self.original = self.operations / self.failed
        self.backup = self.original / 'backup'
        self.backup.mkdir(parents=True)
        self.transaction = self.operations / self.new
        self.transaction.mkdir()
        self.packet = self.root / 'packet'
        self.packet.mkdir()
        self.installation = self.root / 'installation'
        self.source = self.installation / 'source'
        (self.source / 'ops/minimal').mkdir(parents=True)
        (self.source / 'docker-compose.yml').write_bytes(b'sealed compose\n')
        (self.source / 'ops/minimal/compose.fresh.yml').write_bytes(b'sealed overlay\n')
        self.xml = self.source / 'ops/minimal/server.xml'
        self.xml.write_bytes(b'<clickhouse>sealed fixture configuration</clickhouse>\n')
        self.old_env = b'fixture_private_credential=must-never-be-reported\n'
        self.environment = self.state_root / 'deployment.env'
        self.environment.write_bytes(self.old_env)
        self.images = {'backend': 'sha256:' + '1' * 64, 'client': 'sha256:' + '2' * 64}
        self.live = {name: {'id': 'native-' + name, 'image': image, 'mounts': [],
                            'started': '2026-11-17T15:08:30.000000000Z', 'restarts': 0}
                     for name, image in self.images.items()}
        for index, name in enumerate(updater.DATABASES, 3):
            self.live[name] = {'id': 'native-' + name, 'image': 'sha256:' + str(index) * 64,
                               'mounts': [{'Type': 'volume', 'Name': name + '-data'}],
                               'volume': {'Name': name + '-data', 'Driver': 'local'},
                               'started': '2026-11-16T15:46:18.000000000Z', 'restarts': 0}
        self.live['clickhouse']['mounts'].append({'Type': 'bind', 'Source': str(self.xml),
                                                'Destination': '/etc/clickhouse-server/config.d/fixture.xml'})
        old = deepcopy(self.live)
        for name in updater.DATABASES:
            old[name]['started'] = '2026-11-02T06:57:08.000000000Z'
        for name in self.images:
            old[name]['started'] = '2026-11-16T15:46:18.000000000Z'
        self.state = {'phase': 'active', 'sha': 'a' * 40, 'envSha256': module.sha256(self.old_env),
                      'images': self.images, 'runtime': old}
        self.active_hash = module.sha256(raw_json(self.state))
        self.context = (self.state, self.active_hash, self.active_hash, self.environment)
        self.pairs = [{'createdAt': '123', 'sha256': 'f' * 64}]
        self.restart = {'version': 1, 'baseRevision': self.state['sha'], 'baseImages': self.images,
                        'envSha256': self.state['envSha256'],
                        'originalStarted': {name: old[name]['started'] for name in updater.DATABASES},
                        'acceptedStarted': {name: self.live[name]['started'] for name in updater.DATABASES},
                        'dockerLifecycle': {'since': '2026-11-16 15:43:00 UTC',
                                            'until': '2026-11-16 15:49:00 UTC',
                                            'events': [{'event': event, 'timestampMicros': str(1794843966329326 + i)}
                                                       for i, event in enumerate(('stopping', 'stopped', 'starting', 'started'))]},
                        'postgresMigrations': {'count': 1, 'sha256': updater.canonical_hash(self.pairs)}}
        self.restart_raw = raw_json(self.restart)
        (self.packet / 'restart-20261116.json').write_bytes(self.restart_raw)
        database_runtime = updater.database_runtime(self.live)
        self.database_hash = updater.canonical_hash(database_runtime)
        self.prior_tool = '7899a91fb36d1c006d30284fd9fa55a90708ea520eee80c83fb8df8dbe93a4af'
        reconciliations = self.state_root / 'reconciliations'
        reconciliations.mkdir()
        self.attestation_path = reconciliations / (self.active_hash + '.' + self.database_hash + '.json')
        self.attestation = {'version': 1, 'operation': 'reconcile-docker-restart',
                            'activeReceiptSha256': self.active_hash, 'successReceiptSha256': self.active_hash,
                            'toolSha256': self.prior_tool, 'contractSha256': module.sha256(self.restart_raw),
                            'contractRaw': self.restart_raw.decode(), 'contract': self.restart,
                            'databaseRuntime': database_runtime}
        self.attestation_path.write_bytes(raw_json(self.attestation))
        self.summary = {'operation': 'reconcile-docker-restart', 'result': 'VERIFIED',
                        'activeReceiptSha256': self.active_hash, 'databaseRuntimeSha256': self.database_hash,
                        'attestationSha256': module.sha256(self.attestation_path.read_bytes()),
                        'toolSha256': self.prior_tool, 'contractSha256': module.sha256(self.restart_raw)}
        (self.original / 'reconciliation.json').write_bytes(raw_json(self.summary))
        self.failure = {'phase': 'backup_preflight', 'errorType': 'ConnectionResetError',
                        'sites': [{'file': 'wotcv-native-backup.py', 'line': 556}],
                        'at': '2026-11-17T15:08:15Z', 'result': 'HOLD: inspect private transaction before retry'}
        self.failure_raw = raw_json(self.failure)
        (self.original / 'failure.json').write_bytes(self.failure_raw)
        self.pending = self.operations / 'pending.json'
        self.pending_raw = raw_json({'operation': self.failed, 'releaseSha': 'c' * 40})
        self.pending.write_bytes(self.pending_raw)
        (self.backup / 'previous.env').write_bytes(self.old_env)
        for index, relative in enumerate(('docker-compose.yml', 'ops/minimal/compose.fresh.yml')):
            (self.backup / ('compose-' + str(index) + '.yml')).write_bytes((self.source / relative).read_bytes())
        configs = self.backup / 'source-configs'
        configs.mkdir()
        (configs / 'config-0.xml').write_bytes(self.xml.read_bytes())
        (self.backup / 'source-configs.json').write_bytes(raw_json([
            {'file': 'config-0.xml', 'destination': '/etc/clickhouse-server/config.d/fixture.xml',
             'sha256': module.sha256(self.xml.read_bytes())}]))
        (self.backup / 'status.json').write_bytes(raw_json(
            {'phase': 'source_changed_or_old_apps_resume_failed', 'at': self.failure['at']}))
        self.seal = {'project': 'fixture', 'source': updater.BASELINE,
                     'sourceFiles': updater.source_hashes(self.source)}
        (self.installation / 'state.json').write_bytes(raw_json(self.seal))
        self.contract = {'version': 1, 'failedOperation': self.failed, 'failedReleaseSha': 'c' * 40,
                         'failedPendingSha256': module.sha256(self.pending_raw),
                         'failedFailureSha256': module.sha256(self.failure_raw), 'priorUpdaterSha256': self.prior_tool,
                         'runtimeSha256': updater.canonical_hash(self.live),
                         'restartContractSha256': module.sha256(self.restart_raw)}
        self.manifest = {'releaseSha': 'b' * 40, 'files': {
            'recovery': module.sha256((SCRIPTS / 'wotcv-native-recovery.py').read_bytes()),
            'restartContract': module.sha256(self.restart_raw)}}
        self.save_contract()
        self.events = []
        def write(path, value):
            self.events.append(('write', path))
            with path.open('xb') as stream:
                stream.write(value.encode() if isinstance(value, str) else value)
        def record(path, value):
            self.events.append(('replace', path))
            temporary = path.with_name('.pending-replacement')
            temporary.write_bytes(raw_json(value))
            os.replace(temporary, path)
        def file(path):
            updater.require(path.is_file() and not path.is_symlink() and path.resolve() == path and
                            path.stat().st_size <= 2000000, 'Invalid fixture private file')
            return path.read_bytes()
        def directory(path):
            updater.require(path.is_dir() and not path.is_symlink() and path.resolve() == path,
                            'Invalid fixture private directory')
        self.native = SimpleNamespace(
            Refused=updater.Refused, require=updater.require, STATE=self.state_root, ROOT=self.installation,
            PROJECT='fixture', BASELINE=updater.BASELINE, DATABASES=updater.DATABASES,
            receipt_directory=directory, receipt_file=file, reconciliation_json=updater.reconciliation_json,
            canonical_hash=updater.canonical_hash, database_runtime=updater.database_runtime,
            parse_reconciliation_contract=updater.parse_reconciliation_contract,
            read_reconciliation_contract=updater.read_reconciliation_contract,
            restart_only_guard=updater.restart_only_guard, reconciliation_context=Mock(return_value=self.context),
            snapshot=Mock(return_value=self.live), code_runtime_guard=Mock(), source_hashes=updater.source_hashes,
            config=Mock(return_value={'private': 'fixture-model'}), model_guard=Mock(), verify_model_live=Mock(),
            migration_pairs=Mock(return_value=self.pairs), readiness=Mock(), write=write, record=Mock(side_effect=record),
            fsync_directory=Mock(side_effect=lambda path: self.events.append(('fsync', path))),
            docker=Mock(side_effect=AssertionError('No Docker mutations allowed')),
            compose=Mock(side_effect=AssertionError('No activation allowed')))

    def save_contract(self):
        raw = raw_json(self.contract)
        (self.packet / 'recovery-20261117.json').write_bytes(raw)
        self.manifest['files']['recoveryContract'] = module.sha256(raw)

    def run_recovery(self):
        return module.supersede(self.native, self.packet, self.manifest, self.failed, self.new, self.transaction)

    def assert_unchanged(self):
        self.assertEqual(self.pending.read_bytes(), self.pending_raw)
        self.assertFalse((self.original / 'superseded-pending.json').exists())
        self.native.record.assert_not_called()
        self.native.docker.assert_not_called()
        self.native.compose.assert_not_called()

    def test_success_preserves_history_and_atomically_switches_pending_without_activation(self):
        original_attestation = self.attestation_path.read_bytes()
        result = self.run_recovery()
        self.assertEqual((self.original / 'superseded-pending.json').read_bytes(), self.pending_raw)
        self.assertEqual((self.original / 'failure.json').read_bytes(), self.failure_raw)
        self.assertEqual(self.attestation_path.read_bytes(), original_attestation)
        self.assertEqual(json.loads(self.pending.read_bytes()), {'operation': self.new, 'releaseSha': 'b' * 40})
        self.assertEqual(json.loads((self.transaction / 'recovery.json').read_bytes()), result)
        self.assertEqual(json.loads((self.original / 'superseded.json').read_bytes()), result)
        self.assertEqual(result['activation'], 'NOT_PERFORMED')
        self.assertNotIn('must-never-be-reported', json.dumps(result))
        self.native.record.assert_called_once()
        switch = self.events.index(('replace', self.pending))
        self.assertLess(self.events.index(('fsync', self.original)), switch)
        self.assertLess(self.events.index(('fsync', self.transaction)), switch)
        self.native.docker.assert_not_called()
        self.native.compose.assert_not_called()

    def test_wrong_operation_target_or_destination_is_rejected_before_archiving(self):
        with self.assertRaises(updater.Refused):
            module.supersede(self.native, self.packet, self.manifest, self.failed, '../other', self.transaction)
        with self.assertRaises(updater.Refused):
            module.supersede(self.native, self.packet, self.manifest, self.failed, self.new, self.original)
        for field, value in [('failedOperation', '20261117T150812Z-11111111'), ('runtimeSha256', '0' * 64)]:
            original = self.contract[field]
            self.contract[field] = value
            self.save_contract()
            with self.subTest(field=field), self.assertRaises(updater.Refused):
                self.run_recovery()
            self.contract[field] = original
        self.save_contract()
        self.manifest['releaseSha'] = self.contract['failedReleaseSha']
        with self.assertRaises(updater.Refused):
            self.run_recovery()
        self.assert_unchanged()

    def test_a_second_supersession_cannot_rewrite_archived_history(self):
        self.run_recovery()
        archive = (self.original / 'superseded-pending.json').read_bytes()
        metadata = (self.original / 'superseded.json').read_bytes()
        marker = self.pending.read_bytes()
        with self.assertRaises(updater.Refused):
            self.run_recovery()
        self.assertEqual((self.original / 'superseded-pending.json').read_bytes(), archive)
        self.assertEqual((self.original / 'superseded.json').read_bytes(), metadata)
        self.assertEqual(self.pending.read_bytes(), marker)

    def test_contract_hash_duplicate_fields_schema_and_module_hash_are_checked(self):
        path = self.packet / 'recovery-20261117.json'
        for raw in (b'{}', b'{"version":1,"version":1}', b'\xff'):
            path.write_bytes(raw)
            self.manifest['files']['recoveryContract'] = module.sha256(raw)
            with self.subTest(raw=raw), self.assertRaises((updater.Refused, ValueError)):
                self.run_recovery()
        self.save_contract()
        self.manifest['files']['recovery'] = '0' * 64
        with self.assertRaises(updater.Refused):
            self.run_recovery()
        self.assert_unchanged()

    def test_native_pending_including_dangling_symlink_blocks_supersession(self):
        marker = self.state_root / 'pending.json'
        marker.write_bytes(b'{}')
        with self.assertRaises(updater.Refused):
            self.run_recovery()
        marker.unlink()
        try:
            marker.symlink_to(self.state_root / 'missing-target')
        except OSError:
            self.skipTest('Directory does not permit symlinks')
        with self.assertRaises(updater.Refused):
            self.run_recovery()
        self.assert_unchanged()

    def test_pending_failure_or_previously_superseded_operation_is_rejected(self):
        self.pending.write_bytes(self.pending_raw + b'\n')
        with self.assertRaises(updater.Refused):
            self.run_recovery()
        self.pending.write_bytes(self.pending_raw)
        path = self.original / 'failure.json'
        path.write_bytes(self.failure_raw + b'\n')
        with self.assertRaises(updater.Refused):
            self.run_recovery()
        path.write_bytes(self.failure_raw)
        for filename in ('success.json', 'completed-pending.json', 'superseded-pending.json', 'containment.json'):
            extra = self.original / filename
            extra.write_bytes(b'{}')
            with self.subTest(filename=filename), self.assertRaises(updater.Refused):
                self.run_recovery()
            extra.unlink()
        self.assert_unchanged()

    def test_backup_capture_partial_or_unknown_inventory_blocks_supersession(self):
        for filename in ('captured-checks.json', 'postgres.dump', 'postgres.dump.partial',
                         'postgres.dump.stderr', 'artifacts.json', 'verified.json', 'unknown'):
            path = self.backup / filename
            path.write_bytes(b'fixture')
            with self.subTest(filename=filename), self.assertRaises(updater.Refused):
                self.run_recovery()
            path.unlink()
        self.assert_unchanged()

    def test_backup_status_env_compose_and_configuration_copies_are_exact(self):
        for filename in ('previous.env', 'compose-0.yml', 'compose-1.yml', 'source-configs.json',
                         'source-configs/config-0.xml', 'status.json'):
            path = self.backup / filename
            original = path.read_bytes()
            path.write_bytes(b'{}')
            with self.subTest(filename=filename), self.assertRaises(updater.Refused):
                self.run_recovery()
            path.write_bytes(original)
        self.assert_unchanged()

    def test_backup_status_may_precede_root_failure_within_the_observed_operation_window(self):
        (self.backup / 'status.json').write_bytes(raw_json(
            {'phase': 'source_changed_or_old_apps_resume_failed', 'at': '2026-11-17T15:08:14Z'}))
        result = self.run_recovery()
        self.assertEqual(result['phase'], 'recovery-preflight-verified')
        self.assertEqual(json.loads(self.pending.read_bytes())['operation'], self.new)

    def test_backup_status_before_operation_after_failure_or_invalid_is_rejected(self):
        for at in ('2026-11-17T15:08:11Z', '2026-11-17T15:08:16Z',
                   '2026-11-17T15:08:14+00:00', '2026-11-99T15:08:14Z'):
            (self.backup / 'status.json').write_bytes(raw_json(
                {'phase': 'source_changed_or_old_apps_resume_failed', 'at': at}))
            with self.subTest(at=at), self.assertRaises(updater.Refused):
                self.run_recovery()
        self.assert_unchanged()

    def test_old_attestation_summary_tool_raw_contract_and_full_db_identity_are_bound(self):
        original = self.attestation_path.read_bytes()
        summary_path = self.original / 'reconciliation.json'
        for field, value in [('toolSha256', '0' * 64), ('contractRaw', '{}'), ('databaseRuntime', {}),
                             ('successReceiptSha256', '0' * 64), ('extra', 'unreviewed')]:
            changed = deepcopy(self.attestation)
            changed[field] = value
            raw = raw_json(changed)
            self.attestation_path.write_bytes(raw)
            summary = dict(self.summary, attestationSha256=module.sha256(raw))
            summary_path.write_bytes(raw_json(summary))
            with self.subTest(field=field), self.assertRaises(updater.Refused):
                self.run_recovery()
        self.attestation_path.write_bytes(original)
        summary_path.write_bytes(raw_json(dict(self.summary, attestationSha256='0' * 64)))
        with self.assertRaises(updater.Refused):
            self.run_recovery()
        self.assert_unchanged()

    def test_source_model_journal_readiness_or_mid_inspection_race_never_archives(self):
        for name in ('code_runtime_guard', 'model_guard', 'verify_model_live', 'readiness'):
            check = getattr(self.native, name)
            check.side_effect = updater.Refused('safe fixture failure')
            with self.subTest(check=name), self.assertRaises(updater.Refused):
                self.run_recovery()
            check.side_effect = None
        self.native.migration_pairs.return_value = [{'createdAt': '123', 'sha256': 'e' * 64}]
        with self.assertRaises(updater.Refused):
            self.run_recovery()
        self.native.migration_pairs.return_value = self.pairs
        drift = deepcopy(self.live)
        drift['client']['started'] = '2026-11-17T15:10:00Z'
        self.native.snapshot.side_effect = [self.live, drift]
        with self.assertRaises(updater.Refused):
            self.run_recovery()
        self.assert_unchanged()

    def test_sealed_source_change_is_rejected(self):
        self.xml.write_bytes(b'unreviewed changed configuration')
        with self.assertRaisesRegex(updater.Refused, 'Sealed'):
            self.run_recovery()
        self.assert_unchanged()

    def test_archive_or_evidence_failure_preserves_old_pending(self):
        original_write = self.native.write
        def write(path, value):
            if path == self.transaction / 'recovery.json':
                raise OSError('fixture evidence failure')
            original_write(path, value)
        self.native.write = write
        with self.assertRaises(OSError):
            self.run_recovery()
        self.assertEqual(self.pending.read_bytes(), self.pending_raw)
        self.assertEqual((self.original / 'superseded-pending.json').read_bytes(), self.pending_raw)
        self.native.record.assert_not_called()

    def test_atomic_switch_failure_keeps_old_pending_and_durable_archive(self):
        self.native.record.side_effect = OSError('fixture atomic replacement failure')
        with self.assertRaises(OSError):
            self.run_recovery()
        self.assertEqual(self.pending.read_bytes(), self.pending_raw)
        self.assertEqual((self.original / 'superseded-pending.json').read_bytes(), self.pending_raw)

    def test_post_switch_sync_failure_keeps_new_pending_blocking_retry(self):
        def sync(path):
            if path == self.operations:
                raise OSError('fixture directory sync failure')
        self.native.fsync_directory.side_effect = sync
        with self.assertRaises(OSError):
            self.run_recovery()
        self.assertEqual(json.loads(self.pending.read_bytes()), {'operation': self.new, 'releaseSha': 'b' * 40})
        self.assertEqual((self.original / 'superseded-pending.json').read_bytes(), self.pending_raw)


if __name__ == '__main__':
    unittest.main()
