"""Offline v2 continuation proves the full retained-capture and diagnostic chain."""
from contextlib import redirect_stdout
from copy import deepcopy
import io
import json
from pathlib import Path
import shutil
import unittest
from unittest.mock import Mock, patch

import test_wotcv_native_drill_recovery as legacy
import test_wotcv_native_pg_diagnostic as diagnostic


module = legacy.module
updater = legacy.updater
raw_json = legacy.raw_json


class PgVerifyRecoveryTests(unittest.TestCase):
    def setUp(self):
        # Composition intentionally keeps the v1 tests independent of the v2
        # fixture while reusing their real receipt and Docker identity guards.
        self.base = legacy.DrillRecoveryTests(
            'test_success_returns_prior_capture_keeps_failed_clone_and_switches_pending_atomically')
        self.base.setUp()
        self.addCleanup(self.base.doCleanups)
        self.f = f = self.base.f
        self.origin = f.original
        self.origin_capture = f.backup
        self.origin_operation = f.failed
        self.origin_release = self.base.contract['failedReleaseSha']
        self.checks = deepcopy(self.base.checks)
        self.checks['postgres'] = diagnostic.checks()
        (self.origin_capture / 'captured-checks.json').write_bytes(raw_json(self.checks))

        # Let the real v1 writer create both equal provenance reports and the
        # origin pending archive. The retained packet is data, never executed.
        self.current_operation = '20261117T163503Z-a4e9b0da'
        current = f.operations / self.current_operation
        f.transaction.rename(current)
        f.transaction, f.new = current, self.current_operation
        prior_contract = (f.packet / 'drill-recovery-20261117.json').read_bytes()
        prior_code = Path(module.__file__).read_bytes()
        (self.base.prior / 'drill-recovery-20261117.json').write_bytes(prior_contract)
        (self.base.prior / 'wotcv-native-drill-recovery.py').write_bytes(prior_code)
        with redirect_stdout(io.StringIO()):
            self.base.run_recovery()

        self.prior_report = (current / 'drill-recovery.json').read_bytes()
        self.assertEqual(self.prior_report, (self.origin / 'superseded.json').read_bytes())
        f.failed, f.original = self.current_operation, current
        f.backup = current / 'backup'
        shutil.copytree(self.origin_capture, f.backup)
        # run_existing_capture copies the exact capture but never copies the
        # original stream stderr files. They must remain empty at the origin.
        for name in ('postgres.dump.stderr', 'postgres-globals.sql.stderr'):
            (f.backup / name).unlink()
        (current / 'reconciliation.json').write_bytes((self.origin / 'reconciliation.json').read_bytes())
        f.pending_raw = f.pending.read_bytes()
        f.failure = {'phase': 'backup_restoring_isolated_databases', 'errorType': 'Refused',
                     'sites': [{'file': 'wotcv-native-backup.py', 'line': 558}],
                     'at': '2026-11-17T16:36:00Z',
                     'result': 'HOLD: inspect private transaction before retry'}
        f.failure_raw = raw_json(f.failure)
        (current / 'failure.json').write_bytes(f.failure_raw)
        f.new = '20261117T180000Z-1234abcd'
        f.transaction = f.operations / f.new
        f.transaction.mkdir()

        self.target = dict(self.base.target, token='4bc8e3f3f269cdc7', container='a' * 64,
                           volume='wotcv-native-drill-4bc8e3f3f269cdc7-postgres-data', exitCode=0)
        self.base.target = self.target
        self.base.item.update(Id=self.target['container'],
                              Name='/wotcv-native-drill-' + self.target['token'] + '-postgres')
        self.base.item['Config']['Labels']['wotcv.native.drill'] = self.target['token']
        self.base.item['State']['ExitCode'] = 0
        self.base.item['Mounts'][0]['Name'] = self.target['volume']
        self.base.volume['Name'] = self.target['volume']
        self.base.volume['Labels']['wotcv.native.drill'] = self.target['token']
        self.base.consumers = self.target['container'][:12].encode()
        self.status = {'phase': 'existing_capture_drill_failed_source_not_controlled',
                       'step': 'postgres_verify', 'at': '2026-11-17T16:35:59Z',
                       'targets': [{'engine': 'postgres', 'container': self.target['container'],
                                    'volume': self.target['volume'], 'image': self.target['image'],
                                    'network': 'none'}], 'volumes': [self.target['volume']]}
        self.write_json(f.backup / 'status.json', self.status)
        self.write_json(f.backup / 'drill-status.json',
                        {'phase': 'running', 'step': 'postgres_verify', 'at': self.status['at']})
        self.write_json(f.backup / 'drill-failure.json',
                        {'phase': 'postgres_verify', 'errorType': 'Refused',
                         'sites': [{'file': 'wotcv-native-backup.py', 'line': 558}], 'at': self.status['at']})
        for name, step in (('postgres-create-database', 'postgres_create_database'),
                           ('postgres-restore', 'postgres_restore')):
            (f.backup / (name + '.stdout.log')).write_bytes(b'PRIVATE-COMMAND-OUTPUT\n')
            (f.backup / (name + '.stderr.log')).write_bytes(b'')
            self.write_json(f.backup / (name + '.result.json'),
                            {'step': step, 'startedAt': '2026-11-17T16:35:20Z',
                             'finishedAt': '2026-11-17T16:35:58Z', 'returnCode': 0, 'timedOut': False})

        self.diagnostic_dir = f.state_root / 'diagnostics' / (f.failed + '.20261117T174500Z.b38dda34')
        self.diagnostic_dir.mkdir(parents=True)
        (self.diagnostic_dir / 'expected-checks.json').write_bytes((f.backup / 'captured-checks.json').read_bytes())
        self.actual = deepcopy(self.checks['postgres'])
        self.actual['inventory']['columns'][1]['ordinal_position'] = 2
        self.write_json(self.diagnostic_dir / 'actual-checks.json', self.actual)
        self.report = {'phase': 'HOLD', 'diagnosticOnly': True, 'acceptanceChanged': False,
                       'operation': f.failed, 'diagnosticDirectory': str(self.diagnostic_dir),
                       'inspectionComplete': True,
                       'comparison': diagnostic.diag.compare_checks(self.checks['postgres'], self.actual),
                       'cleanup': [], 'errorType': None, 'restore': 'NOT_PERFORMED',
                       'activation': 'NOT_PERFORMED', 'sourceWriterControl': 'NOT_PERFORMED'}
        self.write_json(self.diagnostic_dir / 'report.json', self.report)
        self.contract = deepcopy(self.base.contract)
        self.contract.update(version=2, failedOperation=f.failed, failedReleaseSha='d' * 40,
                             failedPendingSha256=module.sha256(f.pending_raw),
                             failedFailureSha256=module.sha256(f.failure_raw), failedDrill=self.target,
                             verifiedCapture={
                                 'originOperation': self.origin_operation, 'originReleaseSha': self.origin_release,
                                 'priorDrillRecoverySha256': module.sha256(prior_code),
                                 'priorDrillRecoveryContractSha256': module.sha256(prior_contract),
                                 'diagnosticDirectory': str(self.diagnostic_dir),
                                 'diagnosticReportSha256': module.sha256((self.diagnostic_dir / 'report.json').read_bytes())})
        self.manifest = deepcopy(self.base.manifest)
        self.manifest['releaseSha'] = 'e' * 40
        self.save_contract()
        f.events.clear()
        for value in vars(f.native).values():
            if hasattr(value, 'reset_mock'):
                value.reset_mock()

    @staticmethod
    def write_json(path, value):
        path.write_bytes(raw_json(value))

    @staticmethod
    def files(directory):
        return {str(path.relative_to(directory)): path.read_bytes()
                for path in directory.rglob('*') if path.is_file()}

    def save_contract(self):
        raw = raw_json(self.contract)
        (self.f.packet / 'drill-recovery-20261117.json').write_bytes(raw)
        self.manifest['files']['drillRecoveryContract'] = module.sha256(raw)

    def save_report(self):
        self.write_json(self.diagnostic_dir / 'report.json', self.report)
        self.contract['verifiedCapture']['diagnosticReportSha256'] = module.sha256(
            (self.diagnostic_dir / 'report.json').read_bytes())
        self.save_contract()

    def run_recovery(self):
        self.output = io.StringIO()
        with redirect_stdout(self.output):
            return module.supersede(self.f.native, self.f.packet, self.manifest,
                                    self.f.failed, self.f.new, self.f.transaction)

    def assert_refuses_without_write(self):
        before = self.files(self.f.root)
        with self.assertRaises(updater.Refused):
            self.run_recovery()
        self.assertEqual(self.files(self.f.root), before)
        self.assertEqual(self.f.events, [])
        self.f.native.record.assert_not_called()
        self.f.native.compose.assert_not_called()
        self.assertTrue(all(call.args[0] in {'inspect', 'volume', 'ps'}
                            for call in self.f.native.docker.call_args_list))

    def test_success_preserves_old_and_current_capture_clone_source_and_switches_pending_atomically(self):
        f = self.f
        origin = self.files(self.origin)
        capture = self.files(f.backup)
        diagnostic_files = self.files(self.diagnostic_dir)
        source = self.files(f.source)
        item, volume, runtime = deepcopy(self.base.item), deepcopy(self.base.volume), deepcopy(f.live)
        current = {name: (f.original / name).read_bytes()
                   for name in ('failure.json', 'reconciliation.json', 'drill-recovery.json')}
        self.assertEqual(self.run_recovery(), f.backup)
        self.assertEqual(self.files(self.origin), origin)
        self.assertEqual(self.files(f.backup), capture)
        self.assertEqual(self.files(self.diagnostic_dir), diagnostic_files)
        self.assertEqual(self.files(f.source), source)
        self.assertEqual((self.base.item, self.base.volume, f.live), (item, volume, runtime))
        for name, raw in current.items():
            self.assertEqual((f.original / name).read_bytes(), raw)
        self.assertEqual((f.original / 'superseded-pending.json').read_bytes(), f.pending_raw)
        self.assertEqual(json.loads(f.pending.read_bytes()), {'operation': f.new, 'releaseSha': 'e' * 40})
        report_raw = (f.transaction / 'drill-recovery.json').read_bytes()
        self.assertEqual(report_raw, (f.original / 'superseded.json').read_bytes())
        report = json.loads(report_raw)
        self.assertEqual(report['sourceApplicationStop'], 'NOT_PERFORMED')
        self.assertEqual(report['activation'], 'NOT_PERFORMED')
        switch = f.events.index(('replace', f.pending))
        self.assertLess(f.events.index(('fsync', f.original)), switch)
        self.assertLess(f.events.index(('fsync', f.transaction)), switch)
        f.native.record.assert_called_once()
        f.native.compose.assert_not_called()
        self.assertTrue(all(call.args[0] in {'inspect', 'volume', 'ps'} for call in f.native.docker.call_args_list))
        for secret in ('PRIVATE-DEFAULT', 'PRIVATE-DEFINITION', 'PRIVATE-INDEX',
                       'PRIVATE-COMMAND-OUTPUT', 'must-never-be-reported', '8589934591'):
            self.assertNotIn(secret, self.output.getvalue() + report_raw.decode())

    def test_current_operation_requires_drill_recovery_provenance_not_precapture_recovery(self):
        path = self.f.original / 'drill-recovery.json'
        raw = path.read_bytes()
        path.unlink()
        (self.f.original / 'recovery.json').write_bytes(raw)
        self.assert_refuses_without_write()

    def test_config_basename_is_checked_before_any_private_file_join(self):
        foreign = self.f.root / 'private-outside-capture.json'
        foreign.write_bytes(b'PRIVATE-OUTSIDE-SCOPE')
        path = self.f.backup / 'source-configs.json'
        entries = json.loads(path.read_bytes())
        entries[0]['file'] = str(foreign)
        for capture in (self.f.backup, self.origin_capture):
            self.write_json(capture / 'source-configs.json', entries)
        self.f.native.receipt_file = Mock(wraps=self.f.native.receipt_file)
        self.assert_refuses_without_write()
        self.assertNotIn(foreign, [call.args[0] for call in self.f.native.receipt_file.call_args_list])

    def test_diagnostic_drift_during_last_source_check_blocks_pending_switch(self):
        path = self.diagnostic_dir / 'report.json'
        original = path.read_bytes()
        self.f.native.readiness.side_effect = lambda: path.write_bytes(original + b'\n')
        with self.assertRaises(updater.Refused):
            self.run_recovery()
        self.assertEqual(self.f.pending.read_bytes(), self.f.pending_raw)
        self.assertFalse((self.f.original / 'superseded.json').exists())
        self.assertFalse((self.f.original / 'superseded-pending.json').exists())
        self.assertFalse(any(self.f.transaction.iterdir()))
        self.f.native.record.assert_not_called()

    def test_capture_and_metadata_must_be_exact_origin_copies(self):
        for name in ('postgres.dump', 'postgres-globals.sql', 'clickhouse.zip', 'redis.rdb',
                     'previous.env', 'artifacts.json', 'captured-checks.json', 'stopped-apps.json',
                     'compose-0.yml', 'compose-1.yml', 'source-configs.json', 'source-configs/config-0.xml'):
            path = self.f.backup / name
            original = path.read_bytes()
            path.write_bytes(original + b'\n')
            with self.subTest(file=name):
                self.assert_refuses_without_write()
            path.write_bytes(original)

    def test_origin_empty_dump_stderr_and_old_packet_tool_bytes_remain_required(self):
        paths = [self.origin_capture / 'postgres.dump.stderr', self.origin_capture / 'postgres-globals.sql.stderr',
                 self.base.prior / 'wotcv-native-drill-recovery.py',
                 self.base.prior / 'drill-recovery-20261117.json']
        for path in paths:
            original = path.read_bytes()
            path.write_bytes(original + b'PRIVATE-TAMPER')
            with self.subTest(file=path.name):
                self.assert_refuses_without_write()
            path.write_bytes(original)

    def test_old_and_current_reconciliation_and_provenance_archives_are_bound(self):
        for path in (self.origin / 'superseded-pending.json', self.origin / 'superseded.json',
                     self.origin / 'recovery.json', self.origin / 'reconciliation.json',
                     self.f.original / 'drill-recovery.json', self.f.original / 'reconciliation.json',
                     self.base.attestation_path):
            original = path.read_bytes()
            path.write_bytes(b'{}\n')
            with self.subTest(file=str(path.relative_to(self.f.root))):
                self.assert_refuses_without_write()
            path.write_bytes(original)

    def test_verified_capture_contract_rejects_changed_provenance_or_digest(self):
        proof = self.contract['verifiedCapture']
        for key, value in (('originOperation', '20261117T150812Z-11111111'), ('originReleaseSha', '0' * 40),
                           ('priorDrillRecoverySha256', '0' * 64),
                           ('priorDrillRecoveryContractSha256', '0' * 64),
                           ('diagnosticReportSha256', '0' * 64)):
            original = proof[key]
            proof[key] = value
            self.save_contract()
            with self.subTest(field=key):
                self.assert_refuses_without_write()
            proof[key] = original
        self.save_contract()

    def test_diagnostic_bytes_and_private_actual_expected_checks_are_bound(self):
        for name in ('report.json', 'expected-checks.json', 'actual-checks.json'):
            path = self.diagnostic_dir / name
            original = path.read_bytes()
            path.write_bytes(original + b'\n')
            if name == 'actual-checks.json':
                changed = deepcopy(self.actual)
                changed['counts']['public.fixture'] += 1
                self.write_json(path, changed)
            with self.subTest(file=name):
                self.assert_refuses_without_write()
            path.write_bytes(original)

    def test_diagnostic_boolean_shape_and_completed_readonly_scope_are_strict(self):
        for key, value in (('phase', 'verified'), ('diagnosticOnly', 1), ('acceptanceChanged', True),
                           ('inspectionComplete', False), ('cleanup', ['clone-stop-or-state-unverified']),
                           ('errorType', 'Refused'), ('restore', 'PERFORMED'), ('activation', 'PERFORMED'),
                           ('sourceWriterControl', 'PERFORMED'), ('operation', self.origin_operation),
                           ('diagnosticDirectory', str(self.f.root))):
            original = self.report[key]
            self.report[key] = value
            self.save_report()
            with self.subTest(field=key):
                self.assert_refuses_without_write()
            self.report[key] = original
        self.save_report()

    def test_diagnostic_accepts_only_ordinal_gap_with_all_other_sections_equal(self):
        comparison = self.report['comparison']
        changes = [('equal', True), ('sameColumnRowsWithoutPhysicalOrdinal', False),
                   ('columnVisibleOrderMatches', False), ('sameColumnRowsWithoutPhysicalOrdinal', 1)]
        for key, value in changes:
            original = comparison[key]
            comparison[key] = value
            self.save_report()
            with self.subTest(field=key):
                self.assert_refuses_without_write()
            comparison[key] = original
        for section in ('columns', 'constraints', 'indexes', 'journal', 'counts'):
            original = deepcopy(comparison['sections'][section])
            comparison['sections'][section]['expectedSha256'] = '0' * 64
            self.save_report()
            with self.subTest(section=section):
                self.assert_refuses_without_write()
            comparison['sections'][section] = original
        self.save_report()

    def test_diagnostic_directory_must_be_canonical_and_under_private_state_diagnostics(self):
        proof = self.contract['verifiedCapture']
        original = proof['diagnosticDirectory']
        for value in ('diagnostics/relative', str(self.f.root),
                      str(self.diagnostic_dir / '..' / self.diagnostic_dir.name)):
            proof['diagnosticDirectory'] = value
            self.save_contract()
            with self.subTest(path=value):
                self.assert_refuses_without_write()
        proof['diagnosticDirectory'] = original
        self.save_contract()

    def test_private_actual_check_shape_refuses_even_when_report_hashes_are_rebound(self):
        original_report = deepcopy(self.report)
        for mutation in ('unknown-section', 'unknown-column-field', 'boolean-count'):
            changed = deepcopy(self.actual)
            if mutation == 'unknown-section':
                changed['inventory']['foreign'] = []
            elif mutation == 'unknown-column-field':
                changed['inventory']['columns'][0]['foreign'] = 'PRIVATE-UNREVIEWED'
            else:
                changed['counts']['public.fixture'] = True
            self.write_json(self.diagnostic_dir / 'actual-checks.json', changed)
            self.report = deepcopy(original_report)
            for name, section in self.report['comparison']['sections'].items():
                rows = changed['counts'] if name == 'counts' else changed['inventory'][name]
                section['actualSha256'] = updater.canonical_hash(rows)
                section['actualItems'] = len(rows)
            self.save_report()
            with self.subTest(mutation=mutation):
                self.assert_refuses_without_write()
        self.report = original_report
        self.write_json(self.diagnostic_dir / 'actual-checks.json', self.actual)
        self.save_report()

    def test_postgres_verify_failure_and_successful_create_restore_results_are_required(self):
        for filename, key, value in (
                ('status.json', 'phase', 'drill_failed_old_apps_resumed'),
                ('status.json', 'step', 'postgres_restore'), ('drill-status.json', 'step', 'complete'),
                ('drill-failure.json', 'phase', 'postgres_restore'),
                ('drill-failure.json', 'errorType', 'ConnectionResetError'),
                ('postgres-create-database.result.json', 'returnCode', 1),
                ('postgres-create-database.result.json', 'returnCode', False),
                ('postgres-restore.result.json', 'returnCode', 1),
                ('postgres-restore.result.json', 'timedOut', True)):
            path = self.f.backup / filename
            original = path.read_bytes()
            changed = json.loads(original)
            changed[key] = value
            self.write_json(path, changed)
            with self.subTest(file=filename, field=key, value=value):
                self.assert_refuses_without_write()
            path.write_bytes(original)

    def test_foreign_current_origin_operation_or_capture_inventory_refuses_before_write(self):
        for directory, name in ((self.f.original, 'recovery.json'), (self.f.backup, 'unknown'),
                                (self.f.backup, 'postgres.dump.stderr'), (self.f.backup, 'verified.json'),
                                (self.origin, 'foreign.json'), (self.origin_capture, 'unknown')):
            path = directory / name
            path.write_bytes(b'{}')
            with self.subTest(file=str(path.relative_to(self.f.root))):
                self.assert_refuses_without_write()
            path.unlink()

    def test_cleanly_stopped_owned_isolated_clone_is_required(self):
        state = self.base.item['State']
        for key, value in (('ExitCode', 137), ('ExitCode', False), ('Running', True),
                           ('Restarting', True), ('OOMKilled', True)):
            original = state[key]
            state[key] = value
            with self.subTest(field=key):
                self.assert_refuses_without_write()
            state[key] = original
        self.base.consumers += b'\nforeign-consumer'
        self.assert_refuses_without_write()

    def test_source_race_or_readiness_failure_cannot_archive(self):
        self.f.native.readiness.side_effect = updater.Refused('fixture refusal')
        self.assert_refuses_without_write()
        self.f.native.readiness.side_effect = None
        changed = deepcopy(self.f.live)
        changed['backend']['started'] = '2026-11-17T17:59:00Z'
        self.f.native.snapshot.side_effect = [self.f.live, changed]
        self.assert_refuses_without_write()

    def test_v1_contract_continues_to_require_original_exit_137_scope(self):
        self.contract.pop('verifiedCapture')
        self.contract['version'] = 1
        self.save_contract()
        self.assert_refuses_without_write()

    def test_reviewed_v2_pending_hash_matches_actual_native_record_writer(self):
        reviewed = json.loads((diagnostic.SCRIPTS.parent / 'ops/upgrades/drill-recovery-20261117.json').read_bytes())
        self.assertEqual(reviewed['version'], 2)
        marker = {'operation': reviewed['failedOperation'], 'releaseSha': reviewed['failedReleaseSha']}
        path = self.f.root / 'real-native-pending.json'
        with patch.object(updater.os, 'O_NOFOLLOW', getattr(updater.os, 'O_NOFOLLOW', 0), create=True):
            updater.record(path, marker)
        self.assertEqual(module.sha256(path.read_bytes()), reviewed['failedPendingSha256'])


if __name__ == '__main__':
    unittest.main()
