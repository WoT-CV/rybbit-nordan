"""Retained-capture recovery tests; all clone operations are mocked read-only."""
from copy import deepcopy
from contextlib import redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

import test_wotcv_native_recovery as fixtures


SPEC = importlib.util.spec_from_file_location('native_drill_recovery_under_test',
    Path(__file__).resolve().parents[1] / 'wotcv-native-drill-recovery.py')
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)
updater = fixtures.updater
raw_json = fixtures.raw_json


class DrillRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.f = fixtures.RecoveryTests('test_success_preserves_history_and_atomically_switches_pending_without_activation')
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        f = self.f
        f.failure['errorType'] = 'Refused'
        f.failure['sites'] = [{'file': 'wotcv-native-backup.py', 'line': 487}]
        f.failure_raw = raw_json(f.failure)
        (f.original / 'failure.json').write_bytes(f.failure_raw)
        (f.original / 'recovery.json').write_bytes(raw_json({
            'operation': 'supersede-failed-pre-capture', 'phase': 'recovery-preflight-verified',
            'activation': 'NOT_PERFORMED', 'newOperation': f.failed, 'releaseSha': 'c' * 40,
            'activeReceiptSha256': f.active_hash}))
        self.prior = f.root / 'prior-packet'
        self.prior.mkdir()
        prior_updater = b'prior reviewed updater fixture\n'
        prior_backup = b'prior reviewed backup fixture\n'
        (self.prior / 'wotcv-native-update.py').write_bytes(prior_updater)
        (self.prior / 'wotcv-native-backup.py').write_bytes(prior_backup)
        self.updater_hash = module.sha256(prior_updater)
        f.attestation['toolSha256'] = self.updater_hash
        self.attestation_path = f.state_root / 'reconciliations' / (
            f.active_hash + '.' + f.database_hash + '.' + self.updater_hash + '.json')
        self.attestation_path.write_bytes(raw_json(f.attestation))
        f.summary.update(toolSha256=self.updater_hash,
                         attestationSha256=module.sha256(self.attestation_path.read_bytes()))
        (f.original / 'reconciliation.json').write_bytes(raw_json(f.summary))
        self.target = {'token': '4f6fadc24b610ee2', 'container': 'b' * 64,
                       'volume': 'wotcv-native-drill-4f6fadc24b610ee2-postgres-data',
                       'image': f.live['postgres']['image'], 'exitCode': 137, 'oomKilled': False}
        self.status = {'phase': 'drill_failed_old_apps_resumed', 'at': '2026-11-17T15:08:14Z',
                       'targets': [{'engine': 'postgres', 'container': self.target['container'],
                                    'volume': self.target['volume'], 'image': self.target['image'], 'network': 'none'}],
                       'volumes': [self.target['volume']]}
        (f.backup / 'status.json').write_bytes(raw_json(self.status))
        self.stops = {name: {'id': f.live[name]['id'], 'image': f.live[name]['image'], 'identityMatches': True,
                             'status': 'exited', 'exitCode': 143 if name == 'client' else 0,
                             'oomKilled': False, 'running': False, 'restarting': False,
                             'stateErrorEmpty': True, 'finishedAt': '2026-11-17T15:08:13.000000000Z'}
                      for name in ('backend', 'client')}
        (f.backup / 'stopped-apps.json').write_bytes(raw_json(self.stops))
        self.checks = {'postgres': {'inventory': {'journal': [{'id': 1, 'hash': 'f' * 64, 'created_at': 123}]},
                                   'counts': {'public.fixture': 1}},
                       'clickhouse': {'tables': [], 'counts': {}}, 'redis': {}, 'redisModules': []}
        (f.backup / 'captured-checks.json').write_bytes(raw_json(self.checks))
        for name in ('postgres.dump', 'postgres-globals.sql', 'clickhouse.zip', 'redis.rdb'):
            (f.backup / name).write_bytes(('private fixture artifact ' + name).encode())
        for name in ('postgres.dump.stderr', 'postgres-globals.sql.stderr'):
            (f.backup / name).write_bytes(b'')
        self.save_artifacts()
        self.contract = {'version': 1, 'failedOperation': f.failed, 'failedReleaseSha': 'c' * 40,
                         'failedPendingSha256': module.sha256(f.pending_raw),
                         'failedFailureSha256': module.sha256(f.failure_raw), 'priorPacketDirectory': str(self.prior),
                         'priorUpdaterSha256': self.updater_hash, 'priorBackupSha256': module.sha256(prior_backup),
                         'runtimeSha256': updater.canonical_hash(f.live),
                         'restartContractSha256': module.sha256(f.restart_raw), 'failedDrill': self.target}
        self.manifest = {'releaseSha': 'd' * 40, 'files': {
            'updater': self.updater_hash, 'restartContract': module.sha256(f.restart_raw),
            'drillRecovery': module.sha256(Path(module.__file__).read_bytes())}}
        self.save_contract()
        # POSIX mode checks belong to native.private; Windows fixtures exercise
        # canonical regular-file checks while preserving actual stream reading.
        f.native.private = lambda path: updater.require(path.is_file() and not path.is_symlink() and
            path.resolve() == path, 'Invalid private artifact fixture')
        f.native.receipt_guard = Mock()
        self.item = {'Id': self.target['container'], 'Image': self.target['image'],
                     'Name': '/wotcv-native-drill-' + self.target['token'] + '-postgres',
                     'Config': {'Labels': {'wotcv.native.drill': self.target['token']}},
                     'State': {'Status': 'exited', 'ExitCode': 137, 'OOMKilled': False, 'Running': False, 'Restarting': False},
                     'HostConfig': {'NetworkMode': 'none', 'PortBindings': {}, 'RestartPolicy': {'Name': 'no'}},
                     'Mounts': [{'Type': 'volume', 'Name': self.target['volume'],
                                 'Destination': updater.DATABASES['postgres'], 'RW': True}]}
        self.volume = {'Name': self.target['volume'], 'Driver': 'local', 'Options': {},
                       'Labels': {'wotcv.native.drill': self.target['token']}}
        self.consumers = self.target['container'][:12].encode()
        def docker(*args, **kwargs):
            if args == ('inspect', self.target['container']):
                return raw_json([self.item])
            if args == ('volume', 'inspect', self.target['volume']):
                return raw_json([self.volume])
            if args == ('ps', '-aq', '--filter', 'volume=' + self.target['volume']):
                return self.consumers
            self.fail('Unexpected Docker command; failed clone must not be mutated')
        f.native.docker = Mock(side_effect=docker)

    def save_artifacts(self):
        self.artifacts = {name: {'path': name, 'bytes': (self.f.backup / name).stat().st_size,
                                 'sha256': module.sha256((self.f.backup / name).read_bytes())}
                          for name in module.ARTIFACTS}
        (self.f.backup / 'artifacts.json').write_bytes(raw_json(self.artifacts))

    def save_contract(self):
        raw = raw_json(self.contract)
        (self.f.packet / 'drill-recovery-20261117.json').write_bytes(raw)
        self.manifest['files']['drillRecoveryContract'] = module.sha256(raw)

    def run_recovery(self):
        f = self.f
        return module.supersede(f.native, f.packet, self.manifest, f.failed, f.new, f.transaction)

    def assert_unsuperseded(self):
        f = self.f
        self.assertEqual(f.pending.read_bytes(), f.pending_raw)
        self.assertFalse((f.original / 'superseded-pending.json').exists())
        f.native.record.assert_not_called()
        f.native.compose.assert_not_called()
        self.assertTrue(all(call.args[0] in {'inspect', 'volume', 'ps'} for call in f.native.docker.call_args_list))

    def test_success_returns_prior_capture_keeps_failed_clone_and_switches_pending_atomically(self):
        f = self.f
        original_item = deepcopy(self.item)
        original_dump = (f.backup / 'postgres.dump').read_bytes()
        original_attestation = self.attestation_path.read_bytes()
        result = self.run_recovery()
        self.assertEqual(result, f.backup)
        self.assertEqual(self.item, original_item)
        self.assertEqual((f.backup / 'postgres.dump').read_bytes(), original_dump)
        self.assertEqual(self.attestation_path.read_bytes(), original_attestation)
        self.assertEqual((f.original / 'superseded-pending.json').read_bytes(), f.pending_raw)
        self.assertEqual((f.original / 'failure.json').read_bytes(), f.failure_raw)
        self.assertEqual(json.loads(f.pending.read_bytes()), {'operation': f.new, 'releaseSha': 'd' * 40})
        report = json.loads((f.transaction / 'drill-recovery.json').read_bytes())
        self.assertEqual(report['sourceApplicationStop'], 'NOT_PERFORMED')
        self.assertEqual(report['activation'], 'NOT_PERFORMED')
        self.assertNotIn('private fixture artifact', json.dumps(report))
        self.assertNotIn('must-never-be-reported', json.dumps(report))
        switch = f.events.index(('replace', f.pending))
        self.assertLess(f.events.index(('fsync', f.original)), switch)
        self.assertLess(f.events.index(('fsync', f.transaction)), switch)
        f.native.receipt_guard.assert_called_once_with(f.live)
        self.assertTrue(all(call.args[0] in {'inspect', 'volume', 'ps'} for call in f.native.docker.call_args_list))
        f.native.compose.assert_not_called()

    def test_reviewed_contract_matches_real_native_record_writer_bytes(self):
        reviewed = json.loads((fixtures.SCRIPTS.parent / 'ops/upgrades/drill-recovery-20261117.json').read_bytes())
        marker = {'operation': reviewed['failedOperation'], 'releaseSha': reviewed['failedReleaseSha']}
        path = self.f.root / 'real-recorded-pending.json'
        with patch.object(updater.os, 'O_NOFOLLOW', getattr(updater.os, 'O_NOFOLLOW', 0), create=True):
            updater.record(path, marker)
        raw = path.read_bytes()
        self.assertEqual(module.sha256(raw), reviewed['failedPendingSha256'])
        self.assertNotEqual(module.sha256((json.dumps(marker) + '\n').encode()), reviewed['failedPendingSha256'])

    def test_wrong_compact_contract_refuses_real_record_bytes_without_mutation(self):
        marker = json.loads(self.f.pending_raw)
        with patch.object(updater.os, 'O_NOFOLLOW', getattr(updater.os, 'O_NOFOLLOW', 0), create=True):
            updater.record(self.f.pending, marker)
        self.f.pending_raw = self.f.pending.read_bytes()
        self.contract['failedPendingSha256'] = module.sha256((json.dumps(marker) + '\n').encode())
        self.save_contract()
        with self.assertRaisesRegex(updater.Refused, 'pending marker changed'):
            self.run_recovery()
        self.assert_unsuperseded()

    def test_digest_proof_only_emits_byte_identity_and_match_status(self):
        raw = b'private artifact and credentials must-never-be-reported'
        stream = io.StringIO()
        with redirect_stdout(stream):
            actual = module.digest_proof('pending', raw, module.sha256(raw))
        value = json.loads(stream.getvalue())
        self.assertEqual(set(value), {'check', 'expectedSha256', 'actualSha256', 'bytes', 'matches'})
        self.assertEqual(value['actualSha256'], actual)
        self.assertTrue(value['matches'])
        self.assertEqual(value['bytes'], len(raw))
        self.assertNotIn('must-never-be-reported', stream.getvalue())

    def test_large_dump_is_streamed_without_receipt_file_size_limit(self):
        (self.f.backup / 'postgres.dump').write_bytes(b'PGDMP' + b'x' * (3 * 1024 * 1024))
        self.save_artifacts()
        self.assertEqual(self.run_recovery(), self.f.backup)

    def test_changed_pending_failure_target_or_source_runtime_refuses(self):
        for field, value in [('failedPendingSha256', '0' * 64), ('failedFailureSha256', '0' * 64),
                             ('runtimeSha256', '0' * 64)]:
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
        self.assert_unsuperseded()

    def test_retained_packet_module_hashes_are_verified(self):
        for filename in ('wotcv-native-backup.py', 'wotcv-native-update.py'):
            path = self.prior / filename
            original = path.read_bytes()
            path.write_bytes(b'tampered')
            with self.subTest(filename=filename), self.assertRaises(updater.Refused):
                self.run_recovery()
            path.write_bytes(original)
        self.assert_unsuperseded()

    def test_artifact_hash_size_manifest_and_nonempty_stderr_are_rejected(self):
        path = self.f.backup / 'postgres.dump'
        original = path.read_bytes()
        path.write_bytes(b'x' + original[1:])
        with self.assertRaises(updater.Refused):
            self.run_recovery()
        path.write_bytes(original)
        self.artifacts['postgres.dump']['bytes'] += 1
        (self.f.backup / 'artifacts.json').write_bytes(raw_json(self.artifacts))
        with self.assertRaises(updater.Refused):
            self.run_recovery()
        self.save_artifacts()
        (self.f.backup / 'postgres.dump.stderr').write_bytes(b'PRIVATE-DUMP-DIAGNOSTIC')
        with self.assertRaises(updater.Refused):
            self.run_recovery()
        self.assert_unsuperseded()

    def test_partial_or_verified_capture_inventory_cannot_be_reused(self):
        for filename in ('verified.json', 'drill-postgres.env', 'postgres.dump.partial', 'unknown'):
            path = self.f.backup / filename
            path.write_bytes(b'fixture')
            with self.subTest(filename=filename), self.assertRaises(updater.Refused):
                self.run_recovery()
            path.unlink()
        self.assert_unsuperseded()

    def test_changed_captured_or_live_journal_is_rejected(self):
        checks = deepcopy(self.checks)
        checks['postgres']['inventory']['journal'][0]['hash'] = 'e' * 64
        (self.f.backup / 'captured-checks.json').write_bytes(raw_json(checks))
        with self.assertRaises(updater.Refused):
            self.run_recovery()
        (self.f.backup / 'captured-checks.json').write_bytes(raw_json(self.checks))
        self.f.native.migration_pairs.return_value = []
        with self.assertRaises(updater.Refused):
            self.run_recovery()
        self.assert_unsuperseded()

    def test_changed_capture_stop_and_configuration_evidence_is_rejected(self):
        for filename in ('previous.env', 'compose-0.yml', 'source-configs.json', 'source-configs/config-0.xml'):
            path = self.f.backup / filename
            original = path.read_bytes()
            path.write_bytes(b'{}')
            with self.subTest(filename=filename), self.assertRaises(updater.Refused):
                self.run_recovery()
            path.write_bytes(original)
        stops = deepcopy(self.stops)
        stops['backend']['exitCode'] = 143
        (self.f.backup / 'stopped-apps.json').write_bytes(raw_json(stops))
        with self.assertRaises(updater.Refused):
            self.run_recovery()
        self.assert_unsuperseded()

    def test_clone_must_still_be_exact_stopped_owned_isolated_target(self):
        original = deepcopy(self.item)
        changes = [('Image', 'sha256:' + 'f' * 64), ('Name', '/foreign')]
        for field, value in changes:
            self.item[field] = value
            with self.subTest(field=field), self.assertRaises(updater.Refused):
                self.run_recovery()
            self.item = deepcopy(original)
        for field, value in [('Running', True), ('Restarting', True), ('OOMKilled', True), ('ExitCode', 0)]:
            self.item['State'][field] = value
            with self.subTest(state=field), self.assertRaises(updater.Refused):
                self.run_recovery()
            self.item = deepcopy(original)
        self.item['HostConfig']['NetworkMode'] = 'bridge'
        with self.assertRaises(updater.Refused):
            self.run_recovery()
        self.assert_unsuperseded()

    def test_clone_volume_owner_consumers_or_source_mount_are_rejected(self):
        self.volume['Labels']['wotcv.native.drill'] = 'foreign'
        with self.assertRaises(updater.Refused):
            self.run_recovery()
        self.volume['Labels']['wotcv.native.drill'] = self.target['token']
        self.consumers += b'\nanother-consumer'
        with self.assertRaises(updater.Refused):
            self.run_recovery()
        self.consumers = self.target['container'][:12].encode()
        self.item['Mounts'][0]['Name'] = self.f.live['postgres']['volume']['Name']
        with self.assertRaises(updater.Refused):
            self.run_recovery()
        self.assert_unsuperseded()

    def test_status_is_exact_one_pg_target_within_pinned_operation_window(self):
        for key, value in [('at', '2026-11-17T15:08:16Z'), ('targets', []), ('volumes', []), ('phase', 'verified')]:
            status = dict(self.status, **{key: value})
            (self.f.backup / 'status.json').write_bytes(raw_json(status))
            with self.subTest(field=key), self.assertRaises(updater.Refused):
                self.run_recovery()
        self.assert_unsuperseded()

    def test_old_attestation_and_recovery_chain_are_verified(self):
        path = self.f.original / 'reconciliation.json'
        summary = dict(self.f.summary, attestationSha256='0' * 64)
        path.write_bytes(raw_json(summary))
        with self.assertRaises(updater.Refused):
            self.run_recovery()
        path.write_bytes(raw_json(self.f.summary))
        (self.f.original / 'recovery.json').write_bytes(b'{}')
        with self.assertRaises(updater.Refused):
            self.run_recovery()
        self.assert_unsuperseded()

    def test_readiness_failure_or_source_race_never_archives(self):
        self.f.native.readiness.side_effect = updater.Refused('safe fixture failure')
        with self.assertRaises(updater.Refused):
            self.run_recovery()
        self.f.native.readiness.side_effect = None
        changed = deepcopy(self.f.live)
        changed['client']['started'] = '2026-11-17T15:10:00Z'
        self.f.native.snapshot.side_effect = [self.f.live, changed]
        with self.assertRaises(updater.Refused):
            self.run_recovery()
        self.assert_unsuperseded()

    def test_atomic_switch_failure_preserves_original_pending_and_archives(self):
        self.f.native.record.side_effect = OSError('fixture replacement failure')
        with self.assertRaises(OSError):
            self.run_recovery()
        self.assertEqual(self.f.pending.read_bytes(), self.f.pending_raw)
        self.assertEqual((self.f.original / 'superseded-pending.json').read_bytes(), self.f.pending_raw)


if __name__ == '__main__':
    unittest.main()
