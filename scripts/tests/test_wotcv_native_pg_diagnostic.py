"""Evidence-only retained-clone diagnostic; never uses Docker or production."""
from contextlib import ExitStack, nullcontext, redirect_stdout
from copy import deepcopy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch


SCRIPTS = Path(__file__).resolve().parents[1]


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / filename)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


diag = load('pg_diagnostic_under_test', 'wotcv-native-pg-diagnostic.py')
backup = load('pg_diagnostic_backup_fixture', 'wotcv-native-backup.py')
updater = load('pg_diagnostic_native_fixture', 'wotcv-native-update.py')


def checks():
    columns = [{'table_schema': 'public', 'table_name': 'fixture', 'column_name': name,
                'ordinal_position': ordinal, 'data_type': 'integer', 'udt_name': 'int4',
                'is_nullable': 'NO', 'column_default': 'PRIVATE-DEFAULT'} for name, ordinal in (('id', 1), ('value', 3))]
    return {'inventory': {'columns': columns,
        'constraints': [{'schema': 'public', 'name': 'fixture', 'conname': 'fixture_pkey', 'definition': 'PRIVATE-DEFINITION'}],
        'indexes': [{'schemaname': 'public', 'tablename': 'fixture', 'indexname': 'fixture_pkey', 'indexdef': 'PRIVATE-INDEX'}],
        'journal': [{'id': 1, 'hash': 'f' * 64, 'created_at': 123}]}, 'counts': {'public.fixture': 8589934591}}


class DiagnosticTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory())).resolve()
        self.stack.enter_context(patch.object(diag, 'private_dir'))
        self.stack.enter_context(patch.object(diag, 'wall_budget', side_effect=lambda *args, **kwargs: nullcontext()))
        self.stack.enter_context(patch.object(diag.time, 'sleep'))
        if not hasattr(diag.os, 'O_NOFOLLOW'):
            self.stack.enter_context(patch.object(diag.os, 'O_NOFOLLOW', 0, create=True))
        self.state = self.root / 'state'
        self.state.mkdir()
        self.operation = '20261117T163503Z-a4e9b0da'
        self.source_operation = '20261117T153454Z-eddd7ac6'
        self.opdir = self.state / 'release-operations' / self.operation
        self.capture = self.opdir / 'backup'
        self.capture.mkdir(parents=True)
        self.release = 'a' * 40
        self.clone = {'token': '4bc8e3f3f269cdc7', 'container': 'a' * 64,
                      'volume': 'wotcv-native-drill-4bc8e3f3f269cdc7-postgres-data',
                      'image': 'sha256:' + 'b' * 64, 'exitCode': 0, 'oomKilled': False}
        self.before = {name: {'id': 'source-' + name, 'image': self.clone['image'] if name == 'postgres' else name,
                              'volume': {'Name': 'source-' + name + '-data'}}
                       for name in ('backend', 'client', 'postgres', 'clickhouse', 'redis')}
        self.pending = self.state / 'release-operations/pending.json'
        self.pending_raw = json.dumps({'operation': self.operation, 'releaseSha': self.release}, indent=2).encode()
        self.pending.write_bytes(self.pending_raw)
        self.failure = {'phase': 'backup_restoring_isolated_databases', 'errorType': 'Refused'}
        self.failure_raw = json.dumps(self.failure).encode()
        (self.opdir / 'failure.json').write_bytes(self.failure_raw)
        target = {'engine': 'postgres', 'container': self.clone['container'], 'volume': self.clone['volume'],
                  'image': self.clone['image'], 'network': 'none'}
        self.save('status.json', {'phase': 'existing_capture_drill_failed_source_not_controlled', 'step': 'postgres_verify',
                                  'targets': [target], 'volumes': [self.clone['volume']]})
        self.save('drill-status.json', {'phase': 'running', 'step': 'postgres_verify'})
        self.save('drill-failure.json', {'phase': 'postgres_verify', 'errorType': 'Refused'})
        for name, step in (('postgres-create-database', 'postgres_create_database'), ('postgres-restore', 'postgres_restore')):
            self.save(name + '.result.json', {'step': step, 'returnCode': 0, 'timedOut': False})
        self.expected = checks()
        self.actual = deepcopy(self.expected)
        self.actual['inventory']['columns'][1]['ordinal_position'] = 2
        self.contract = {'version': 1, 'packetDirectory': str(self.root), 'updaterSha256': 'c' * 64,
                         'backupSha256': 'd' * 64, 'operation': self.operation, 'releaseSha': self.release,
                         'pendingSha256': diag.checksum(self.pending_raw), 'failureSha256': diag.checksum(self.failure_raw),
                         'sourceRuntimeSha256': updater.canonical_hash(self.before),
                         'sourceOperation': self.source_operation, 'clone': self.clone}
        self.item = {'Id': self.clone['container'], 'Image': self.clone['image'],
            'Name': '/wotcv-native-drill-' + self.clone['token'] + '-postgres',
            'Config': {'Labels': {'wotcv.native.drill': self.clone['token']}},
            'State': {'Status': 'exited', 'ExitCode': 0, 'OOMKilled': False, 'Running': False, 'Restarting': False},
            'HostConfig': {'NetworkMode': 'none', 'PortBindings': {}, 'RestartPolicy': {'Name': 'no'}},
            'Mounts': [{'Type': 'volume', 'Name': self.clone['volume'], 'Destination': '/var/lib/postgresql/data', 'RW': True}]}
        def docker(*args, **kwargs):
            if args == ('inspect', self.clone['container']):
                return json.dumps([self.item]).encode()
            if args == ('volume', 'inspect', self.clone['volume']):
                return json.dumps([{'Driver': 'local', 'Options': {}, 'Labels': {'wotcv.native.drill': self.clone['token']}}]).encode()
            if args == ('ps', '-aq', '--filter', 'volume=' + self.clone['volume']):
                return self.clone['container'][:12].encode()
            if args == ('start', self.clone['container']):
                self.item['State'].update(Status='running', Running=True)
                return b''
            if args[0] == 'stop' and args[-1] == self.clone['container']:
                self.item['State'].update(Status='exited', Running=False, Restarting=False)
                return b''
            self.fail('Unexpected container control; source and volumes must remain untouched')
        def write(path, value):
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'wb') as stream:
                stream.write(value.encode() if isinstance(value, str) else value)
        self.native = SimpleNamespace(STATE=self.state, DATABASES=updater.DATABASES,
            DOCKER=['docker-fixture'], safe_env=lambda: {'PATH': '/bin'},
            require=updater.require, Refused=updater.Refused, locked=Mock(return_value=nullcontext()),
            receipt_directory=Mock(), receipt_file=lambda path: path.read_bytes(), write=write,
            record=lambda path, value: path.write_text(json.dumps(value)), canonical_hash=updater.canonical_hash,
            snapshot=Mock(return_value=self.before), receipt_guard=Mock(), current_env=Mock(), config=Mock(),
            model_guard=Mock(), verify_model_live=Mock(), readiness=Mock(), docker=Mock(side_effect=docker))
        raw = json.dumps({'postgres': self.expected}).encode()
        self.capture_check = self.stack.enter_context(patch.object(diag, 'check_capture', return_value=(raw, self.expected)))
        self.stack.enter_context(patch.object(diag.subprocess, 'run', side_effect=self.query))

    def save(self, name, value):
        (self.capture / name).write_text(json.dumps(value))

    def query(self, args, **kwargs):
        self.assertIn(self.clone['container'], args)
        script = args[args.index('-ec') + 1]
        for required in ('default_transaction_read_only=on', 'statement_timeout=30000', 'lock_timeout=5000',
                         '--host 127.0.0.1 --port 5432', 'PGPASSWORD="$POSTGRES_PASSWORD"', '--no-password'):
            self.assertIn(required, script)
        sql = kwargs['input'].decode()
        if sql == 'SELECT 1;':
            output = b'1'
        elif sql == backup.PG_INVENTORY:
            output = json.dumps(self.actual['inventory']).encode()
        elif sql == diag.TABLES_SQL:
            output = b'[{"schemaname":"public","tablename":"fixture"}]'
        elif sql == 'SELECT count(*) FROM "public"."fixture";':
            output = str(self.actual['counts']['public.fixture']).encode()
        else:
            self.fail('Only bounded fixed SELECT queries are permitted')
        return SimpleNamespace(returncode=0, stdout=output)

    def execute(self):
        stream = io.StringIO()
        with redirect_stdout(stream):
            result = diag.inspect(self.native, backup, self.contract)
        return result, stream.getvalue()

    def test_ordinal_gap_is_evidence_only_and_values_never_public(self):
        result, output = self.execute()
        self.assertTrue(result['inspectionComplete'])
        self.assertEqual(result['phase'], 'HOLD')
        self.assertFalse(result['acceptanceChanged'])
        comparison = result['comparison']
        self.assertFalse(comparison['equal'])
        self.assertTrue(comparison['sameColumnRowsWithoutPhysicalOrdinal'])
        self.assertTrue(comparison['columnVisibleOrderMatches'])
        self.assertEqual(comparison['sections']['columns']['differences'][0]['fields'], ['ordinal_position'])
        for secret in ('PRIVATE-DEFAULT', 'PRIVATE-DEFINITION', 'PRIVATE-INDEX', '8589934591'):
            self.assertNotIn(secret, output)
        self.assertEqual(self.item['State']['Status'], 'exited')
        self.assertEqual(self.pending.read_bytes(), self.pending_raw)
        self.assertEqual((self.opdir / 'failure.json').read_bytes(), self.failure_raw)
        self.assertFalse((self.opdir / 'diagnostics').exists())
        self.assertTrue(Path(result['diagnosticDirectory']).is_relative_to(self.state / 'diagnostics'))
        self.assertEqual(json.loads((Path(result['diagnosticDirectory']) / 'actual-checks.json').read_text()), self.actual)

    def test_equal_comparison_still_remains_hold_and_clone_stops(self):
        self.actual = deepcopy(self.expected)
        result, _ = self.execute()
        self.assertTrue(result['comparison']['equal'])
        self.assertEqual(result['phase'], 'HOLD')
        self.assertFalse(result['acceptanceChanged'])
        self.assertEqual(self.item['State']['Status'], 'exited')

    def test_query_failure_stops_clone_and_does_not_print_error(self):
        with patch.object(diag.subprocess, 'run', side_effect=RuntimeError('PRIVATE-QUERY-ERROR')):
            stream = io.StringIO()
            with redirect_stdout(stream), self.assertRaises(diag.Refused):
                diag.inspect(self.native, backup, self.contract)
        self.assertEqual(self.item['State']['Status'], 'exited')
        self.assertNotIn('PRIVATE-QUERY-ERROR', stream.getvalue())
        self.assertEqual(self.pending.read_bytes(), self.pending_raw)

    def test_alarm_exception_during_query_still_attempts_stop_and_readback(self):
        self.assertFalse(issubclass(diag.BudgetExpired, diag.Refused))
        with patch.object(diag.subprocess, 'run', side_effect=diag.BudgetExpired('Diagnostic time budget exhausted')) as query:
            with redirect_stdout(io.StringIO()), self.assertRaises(diag.Refused):
                diag.inspect(self.native, backup, self.contract)
        calls = [call.args for call in self.native.docker.call_args_list]
        stop = next(index for index, args in enumerate(calls) if args[0] == 'stop')
        self.assertEqual(calls[stop][-1], self.clone['container'])
        self.assertIn(('inspect', self.clone['container']), calls[stop + 1:])
        self.assertEqual(self.item['State']['Status'], 'exited')
        self.assertEqual(self.pending.read_bytes(), self.pending_raw)
        query.assert_called_once()

    def test_pending_hash_mismatch_or_foreign_clone_cannot_start_anything(self):
        self.contract['pendingSha256'] = '0' * 64
        with self.assertRaises(diag.Refused):
            self.execute()
        self.native.docker.assert_not_called()
        self.contract['pendingSha256'] = diag.checksum(self.pending_raw)
        self.item['Image'] = 'foreign'
        with self.assertRaises(diag.Refused):
            self.execute()
        self.assertFalse(any(call.args[0] in {'start', 'stop'} for call in self.native.docker.call_args_list))

    def test_source_drift_after_reads_is_hold_and_clone_is_stopped(self):
        changed = deepcopy(self.before)
        changed['postgres']['image'] = 'changed'
        self.native.snapshot.side_effect = [self.before, changed]
        with redirect_stdout(io.StringIO()), self.assertRaises(diag.Refused):
            diag.inspect(self.native, backup, self.contract)
        self.assertEqual(self.item['State']['Status'], 'exited')
        self.assertEqual(self.pending.read_bytes(), self.pending_raw)

    def test_column_order_or_default_changes_are_not_hidden_by_ordinal_diagnostic(self):
        actual = deepcopy(self.expected)
        actual['inventory']['columns'][0]['ordinal_position'] = 4
        value = diag.compare_checks(self.expected, actual)
        self.assertTrue(value['sameColumnRowsWithoutPhysicalOrdinal'])
        self.assertFalse(value['columnVisibleOrderMatches'])
        actual['inventory']['columns'][0]['column_default'] = 'OTHER-PRIVATE-DEFAULT'
        value = diag.compare_checks(self.expected, actual)
        self.assertFalse(value['sameColumnRowsWithoutPhysicalOrdinal'])
        self.assertNotIn('OTHER-PRIVATE', json.dumps(value))

    def test_identifiers_are_validated_and_global_output_budget_is_100(self):
        expected = checks()
        expected['inventory']['columns'] = [dict(expected['inventory']['columns'][0], column_name='column_' + str(index),
                                                ordinal_position=index + 1) for index in range(200)]
        actual = deepcopy(expected)
        for row in actual['inventory']['columns']:
            row['column_default'] = 'PRIVATE-NEW-VALUE'
        value = diag.compare_checks(expected, actual)
        emitted = sum(len(row['identity']) for section in value['sections'].values() for row in section.get('differences', []))
        self.assertLessEqual(emitted, 100)
        self.assertNotIn('PRIVATE-NEW-VALUE', json.dumps(value))

    def test_actual_contract_pending_hash_uses_real_native_record(self):
        contract = json.loads((SCRIPTS.parent / 'ops/upgrades/pg-diagnostic-20261117.json').read_bytes())
        path = self.root / 'actual-writer-pending.json'
        updater.record(path, {'operation': contract['operation'], 'releaseSha': contract['releaseSha']})
        self.assertEqual(diag.checksum(path.read_bytes()), contract['pendingSha256'])

    def test_loader_verifies_both_library_hashes_before_executing_either(self):
        updater_body = b'raise AssertionError("Unreviewed import executed")\n'
        (self.root / 'wotcv-native-update.py').write_bytes(updater_body)
        (self.root / 'wotcv-native-backup.py').write_bytes(b'fixture backup\n')
        contract = dict(self.contract, packetDirectory=str(self.root),
                        updaterSha256=diag.checksum(updater_body), backupSha256='0' * 64)
        path = self.root / 'contract.json'
        raw = json.dumps(contract).encode()
        path.write_bytes(raw)
        with patch.object(diag.os, 'geteuid', return_value=0, create=True), \
                patch.object(diag, 'private_file', side_effect=lambda source, *args: source.read_bytes()):
            with self.assertRaisesRegex(diag.Refused, 'library changed'):
                diag.load_packet(path, diag.checksum(raw))


if __name__ == '__main__':
    unittest.main()
