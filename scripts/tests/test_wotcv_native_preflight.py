"""Operator preflight regressions with no Docker, SSH, or installed-tool access."""

from contextlib import ExitStack, redirect_stdout
import hashlib
import importlib.util
import io
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import MagicMock, patch


SCRIPT = Path(__file__).resolve().parents[1] / 'wotcv-native-preflight.py'
SPEC = importlib.util.spec_from_file_location('wotcv_native_preflight_under_test', SCRIPT)
preflight = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(preflight)

SECRET = 'PRIVATE_PREFLIGHT_SENTINEL_MUST_NOT_LEAK'
TOOL_BYTES = b'offline reviewed updater fixture\n'
TOOL_HASH = hashlib.sha256(TOOL_BYTES).hexdigest()
MIGRATION_HASH = 'a' * 64


class ReviewedTool:
    def is_symlink(self):
        return False

    def stat(self):
        return SimpleNamespace(st_uid=0, st_mode=0o100644)

    def read_bytes(self):
        return TOOL_BYTES


class OfflinePreflightTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(preflight, 'Path', return_value=ReviewedTool()))
        self.uid = self.stack.enter_context(patch.object(preflight.os, 'geteuid', return_value=0, create=True))
        self.stack.enter_context(patch.object(preflight.sys, 'argv',
                                             ['preflight.py', '--expected-updater-sha256', TOOL_HASH]))
        # A future accidental direct process call must not escape this offline suite.
        self.stack.enter_context(patch('subprocess.run', side_effect=AssertionError('Unexpected process execution')))
        self.loader = SimpleNamespace(exec_module=MagicMock())
        self.stack.enter_context(patch.object(preflight.importlib.util, 'spec_from_file_location',
                                             return_value=SimpleNamespace(loader=self.loader)))
        self.native = SimpleNamespace()
        self.stack.enter_context(patch.object(preflight.importlib.util, 'module_from_spec',
                                             return_value=self.native))
        self.live = {
            name: {'id': 'native-' + name, 'image': 'sha256:' + 'b' * 64,
                   'started': '2026-11-17T00:00:00Z', 'restarts': 0,
                   'environment': {'PASSWORD': SECRET}}
            for name in ('backend', 'client', 'postgres', 'clickhouse', 'redis')
        }
        self.native.snapshot = MagicMock(return_value=self.live)
        self.native.STATE = MagicMock()
        self.pending = (self.native.STATE / 'pending.json').exists
        self.pending.return_value = False
        for name in ('receipt_guard', 'private', 'model_guard', 'verify_model_live'):
            setattr(self.native, name, MagicMock())
        self.native.current_env = MagicMock(return_value='private/deployment.env')
        self.native.config = MagicMock(return_value={'environment': {'PASSWORD': SECRET}})
        self.native.digest = MagicMock(return_value='d' * 64)
        self.expected = [{'createdAt': '123', 'sha256': MIGRATION_HASH}]
        self.native.docker = MagicMock(side_effect=[
            ('123|' + MIGRATION_HASH + '\n').encode(), json.dumps(self.expected).encode()])
        self.mutations = []
        for name in ('prepare', 'apply', 'install', 'write', 'record', 'locked'):
            method = MagicMock(side_effect=AssertionError('Unexpected installed-tool mutation'))
            setattr(self.native, name, method)
            self.mutations.append(method)

    def run_preflight(self):
        output = io.StringIO()
        with redirect_stdout(output):
            result = preflight.main()
        captured = output.getvalue()
        self.assertNotIn(SECRET, captured)
        for mutation in self.mutations:
            mutation.assert_not_called()
        for call in self.native.docker.call_args_list:
            self.assertEqual(call.args[0], 'exec')
            self.assertEqual(call.kwargs.get('timeout'), 30)
            self.assertNotIn(SECRET, repr(call))
        return result, captured

    def test_matching_journal_reports_only_safe_fields_and_never_activation_readiness(self):
        result, captured = self.run_preflight()
        report = json.loads(captured)
        self.assertEqual(result, 0)
        self.assertEqual(report['updaterSha256'], TOOL_HASH)
        self.assertEqual(report['postgresAppliedMigrations'], self.expected)
        self.assertEqual(report['runtimeMigrationFiles'], self.expected)
        self.assertTrue(report['migrationJournalMatchesRuntimeFiles'])
        self.assertTrue(report['receiptMatchesRuntime'])
        self.assertTrue(report['effectiveConfigurationMatchesRuntime'])
        self.assertFalse(report['readyForActivation'])
        self.assertTrue(report['backupEvidence'].startswith('NOT_VERIFIED:'))
        for service in report['runtime'].values():
            self.assertEqual(set(service), {'id', 'image', 'started', 'restarts'})
        self.loader.exec_module.assert_called_once_with(self.native)
        calls = self.native.docker.call_args_list
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0].args[1], 'native-postgres')
        self.assertEqual(calls[1].args[1], 'native-backend')

    def test_unreviewed_updater_digest_refuses_before_import_or_runtime_access(self):
        with patch.object(preflight.sys, 'argv',
                          ['preflight.py', '--expected-updater-sha256', '0' * 64]):
            result, _ = self.run_preflight()
        self.assertEqual(result, 1)
        self.loader.exec_module.assert_not_called()
        self.native.snapshot.assert_not_called()
        self.native.docker.assert_not_called()

    def test_non_root_refuses_before_import_or_runtime_access(self):
        self.uid.return_value = 1000
        result, _ = self.run_preflight()
        self.assertEqual(result, 1)
        self.loader.exec_module.assert_not_called()
        self.native.snapshot.assert_not_called()
        self.native.docker.assert_not_called()

    def test_pending_transaction_is_a_failed_preflight_despite_matching_journal(self):
        self.pending.return_value = True
        result, captured = self.run_preflight()
        report = json.loads(captured)
        self.assertEqual(result, 1)
        self.assertTrue(report['pendingTransaction'])
        self.assertTrue(report['migrationJournalMatchesRuntimeFiles'])
        self.assertFalse(report['readyForActivation'])

    def test_journal_mismatch_is_a_failed_preflight(self):
        changed = [{'createdAt': '123', 'sha256': 'c' * 64}]
        self.native.docker.side_effect = [
            ('123|' + MIGRATION_HASH + '\n').encode(), json.dumps(changed).encode()]
        result, captured = self.run_preflight()
        report = json.loads(captured)
        self.assertEqual(result, 1)
        self.assertFalse(report['migrationJournalMatchesRuntimeFiles'])
        self.assertFalse(report['readyForActivation'])

    def test_runtime_exception_does_not_disclose_its_payload(self):
        self.native.snapshot.side_effect = RuntimeError(SECRET)
        result, captured = self.run_preflight()
        self.assertEqual(result, 1)
        self.assertTrue(json.loads(captured)['result'].startswith('HOLD:'))
        self.native.docker.assert_not_called()

    def test_container_command_exception_does_not_disclose_its_payload(self):
        self.native.docker.side_effect = RuntimeError(SECRET)
        result, captured = self.run_preflight()
        self.assertEqual(result, 1)
        self.assertTrue(json.loads(captured)['result'].startswith('HOLD:'))

    def test_malformed_journal_output_is_not_copied_into_report(self):
        self.native.docker.side_effect = [SECRET.encode()]
        result, captured = self.run_preflight()
        report = json.loads(captured)
        self.assertEqual(result, 1)
        self.assertTrue(report['result'].startswith('HOLD:'))
        self.assertNotIn('postgresAppliedMigrations', report)
        self.assertEqual(self.native.docker.call_count, 1)

    def test_default_receipt_failure_names_the_stage_without_reading_configuration_or_journal(self):
        self.native.receipt_guard.side_effect = RuntimeError(SECRET)
        result, captured = self.run_preflight()
        report = json.loads(captured)
        self.assertEqual(result, 1)
        self.assertEqual(report['failedStage'], 'receipt')
        self.assertFalse(report['receiptMatchesRuntime'])
        self.assertFalse(report['readyForActivation'])
        self.native.current_env.assert_not_called()
        self.native.docker.assert_not_called()

    def test_receipt_diagnostic_collects_independent_checks_without_clearing_hold(self):
        self.native.receipt_guard.side_effect = RuntimeError(SECRET)
        with patch.object(preflight.sys, 'argv',
                          ['preflight.py', '--expected-updater-sha256', TOOL_HASH, '--diagnose-receipt']), \
                patch.object(preflight, 'receipt_diagnostic', return_value={'code': 'receipt.active.compared'}):
            result, captured = self.run_preflight()
        report = json.loads(captured)
        self.assertEqual(result, 1)
        self.assertTrue(report['diagnosticOnly'])
        self.assertFalse(report['receiptMatchesRuntime'])
        self.assertTrue(report['effectiveConfigurationMatchesRuntime'])
        self.assertTrue(report['migrationJournalMatchesRuntimeFiles'])
        self.assertFalse(report['readyForActivation'])
        self.assertTrue(report['result'].startswith('HOLD:'))

    def test_receipt_comparison_discloses_only_fixed_fields_and_validated_identities(self):
        stored = {name: dict(self.live[name]) for name in self.live}
        stored['postgres'].update({'id': SECRET, 'mounts': [SECRET], 'volume': {SECRET: SECRET},
                                   'started': SECRET, 'restarts': SECRET, SECRET: SECRET})
        receipt = {'phase': 'active', 'runtime': stored, 'images': {'backend': SECRET}}
        report = preflight.compare_receipt(receipt, self.live)
        self.assertNotIn(SECRET, json.dumps(report))
        pg = report['databases']['postgres']
        self.assertFalse(pg['exactMatch'])
        self.assertIn('started', pg['differentFields'])
        self.assertIn('mounts', pg['differentFields'])
        self.assertEqual(pg['recorded']['id'], '[invalid]')
        self.assertEqual(report['applications']['backend']['recordedImage'], '[invalid]')

    def test_receipt_comparison_distinguishes_restart_metadata_from_persistent_identity(self):
        stored = {name: dict(self.live[name]) for name in self.live}
        stored['postgres']['started'] = '2026-11-16T00:00:00Z'
        receipt = {'phase': 'active', 'runtime': stored,
                   'images': {n: self.live[n]['image'] for n in ('backend', 'client')}}
        report = preflight.compare_receipt(receipt, self.live)
        self.assertEqual(report['databases']['postgres']['differentFields'], ['started'])
        self.assertFalse(report['databases']['postgres']['exactMatch'])
        self.assertTrue(report['applications']['backend']['imageMatches'])

    def test_receipt_file_exception_is_sanitized(self):
        (self.native.STATE / 'active.json').exists.return_value = True
        self.native.private.side_effect = RuntimeError(SECRET)
        report = preflight.receipt_diagnostic(self.native, self.live)
        self.assertNotIn(SECRET, json.dumps(report))
        self.assertEqual(report['code'], 'receipt.active.private_file_or_structure_check_failed')

    def test_receipt_provenance_refuses_symlinked_unowned_or_public_directories(self):
        for changes in ({'symlink': True}, {'canonical': False}, {'uid': 1000}, {'mode': 0o40755}):
            with self.subTest(changes=changes):
                values = {'symlink': False, 'canonical': True, 'uid': 0, 'mode': 0o40700, **changes}
                directory = MagicMock()
                directory.is_symlink.return_value = values['symlink']
                directory.is_dir.return_value = True
                directory.resolve.return_value = directory if values['canonical'] else Path('/elsewhere')
                directory.stat.return_value = SimpleNamespace(st_uid=values['uid'], st_mode=values['mode'])
                with self.assertRaises(ValueError):
                    preflight.private_receipt_directory(directory)

    def test_receipt_provenance_accepts_private_root_owned_canonical_directory(self):
        directory = MagicMock()
        directory.is_symlink.return_value = False
        directory.is_dir.return_value = True
        directory.resolve.return_value = directory
        directory.stat.return_value = SimpleNamespace(st_uid=0, st_mode=0o40700)
        preflight.private_receipt_directory(directory)

    def test_receipt_provenance_rejects_real_symlink_in_an_ancestor(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve()
            target = base / 'actual'
            (target / 'release').mkdir(parents=True)
            alias = base / 'alias'
            try:
                alias.symlink_to(target, target_is_directory=True)
            except OSError:
                self.skipTest('This operating system does not permit directory symlinks')
            candidate = alias / 'release'
            self.assertFalse(candidate.is_symlink())
            self.assertNotEqual(candidate.resolve(), candidate)
            with self.assertRaisesRegex(ValueError, 'unexpected receipt directory$'):
                preflight.private_receipt_directory(candidate)


if __name__ == '__main__':
    unittest.main()
