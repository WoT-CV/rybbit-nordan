"""Offline backup safety regressions. No Docker, SSH, DB or network access."""
from contextlib import ExitStack
from copy import deepcopy
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch


SPEC = importlib.util.spec_from_file_location('native_backup_under_test',
    Path(__file__).resolve().parents[1] / 'wotcv-native-backup.py')
backup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(backup)


class Refused(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise Refused(message)


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        directory = self.stack.enter_context(tempfile.TemporaryDirectory())
        self.path = Path(directory).resolve()
        self.stack.enter_context(patch.object(backup.subprocess, 'run',
            side_effect=AssertionError('Real subprocess forbidden')))
        if not hasattr(backup.os, 'O_NOFOLLOW'):
            self.stack.enter_context(patch.object(backup.os, 'O_NOFOLLOW', 0, create=True))
        self.native = SimpleNamespace(
            Refused=Refused, require=require, DOCKER=['docker', '--host', 'unix:///fixture.sock'],
            safe_env=lambda: {'PATH': '/bin'}, DATABASES={'postgres': '/var/lib/postgresql/data',
                'clickhouse': '/var/lib/clickhouse', 'redis': '/data'}, PROJECT='fixture',
            docker=Mock(side_effect=AssertionError('Unmocked Docker forbidden')),
            record=lambda path, data: path.write_text(json.dumps(data)),
            write=lambda path, data: path.write_bytes(data.encode() if isinstance(data, str) else data))
        self.job = backup.Backup(self.native, self.path)
        self.job.before = {
            name: {'id': name + '-source', 'image': 'sha256:' + str(i) * 64,
                   'started': 'original', 'restarts': 0, 'mounts': [],
                   'volume': {'Name': 'source-' + name}}
            for i, name in enumerate(('postgres', 'clickhouse', 'redis', 'backend', 'client'), 1)}

    def mock_run_stages(self):
        events = []
        for method, value in [('preflight', {}), ('stop_apps', None),
                              ('capture', ({'fixture': True}, {'fixture': True})),
                              ('cleanup_source', None), ('resume_apps', {'resumed': True}),
                              ('drill', {'phase': 'passed'}), ('database_unchanged', None),
                              ('cleanup_targets', None)]:
            setattr(self.job, method, Mock(side_effect=lambda *args, m=method, v=value:
                (events.append(m), v)[1]))
        return events

    def mock_stops(self, client=143, backend=0, *, bad_service=None, oom=False, error=''):
        def docker(*args, **kwargs):
            if args[0] == 'stop':
                return b''
            self.assertEqual(args[0], 'inspect')
            name = next(name for name in ('client', 'backend') if self.job.before[name]['id'] == args[1])
            return json.dumps([{'Id': self.job.before[name]['id'], 'Image': self.job.before[name]['image'],
                'State': {'Status': 'exited', 'ExitCode': client if name == 'client' else backend,
                          'OOMKilled': oom if name == bad_service else False,
                          'Error': error if name == bad_service else '', 'Running': False, 'Restarting': False,
                          'FinishedAt': '2026-11-17T15:08:15.341822155Z'}}]).encode()
        self.native.docker.side_effect = docker

    def test_client_term_143_and_backend_drain_0_are_accepted_and_recorded(self):
        self.mock_stops()
        self.job.stop_apps()
        self.assertEqual([call.args[-1] for call in self.native.docker.call_args_list if call.args[0] == 'stop'],
                         ['client-source', 'backend-source'])
        evidence = json.loads((self.path / 'stopped-apps.json').read_text())
        self.assertEqual(evidence['client']['exitCode'], 143)
        self.assertEqual(evidence['backend']['exitCode'], 0)
        self.assertTrue(all(value['identityMatches'] and value['stateErrorEmpty'] for value in evidence.values()))

    def test_backend_143_client_137_oom_and_nonempty_state_error_refuse_capture(self):
        cases = [({'backend': 143}, 'backend'), ({'client': 137}, 'client'),
                 ({'bad_service': 'client', 'oom': True}, 'client'),
                 ({'bad_service': 'backend', 'oom': True}, 'backend'),
                 ({'bad_service': 'client', 'error': 'SENSITIVE-STATE-DETAILS'}, 'client'),
                 ({'bad_service': 'backend', 'error': 'SENSITIVE-STATE-DETAILS'}, 'backend')]
        for options, service in cases:
            with self.subTest(options=options):
                self.job.stopped.clear()
                self.job.stop_states.clear()
                self.native.docker.reset_mock()
                self.mock_stops(**options)
                with self.assertRaisesRegex(Refused, 'shutdown was not clean'):
                    self.job.stop_apps()
                evidence = json.loads((self.path / 'stopped-apps.json').read_text())
                self.assertIn(service, evidence)
                self.assertNotIn('SENSITIVE-STATE-DETAILS', (self.path / 'stopped-apps.json').read_text())
                if service == 'client':
                    self.assertFalse(any(call.args[0] == 'stop' and call.args[-1] == 'backend-source'
                                         for call in self.native.docker.call_args_list))

    def test_success_orders_capture_resume_drill_and_never_applies(self):
        events = self.mock_run_stages()
        report = self.job.run()
        self.assertEqual(events, ['preflight', 'stop_apps', 'capture', 'cleanup_source',
            'resume_apps', 'drill', 'database_unchanged', 'cleanup_targets'])
        self.assertEqual(report['phase'], 'verified')
        self.assertIn('PostgreSQL roles/ownership/ACL not replayed', report['limits'])
        self.native.docker.assert_not_called()

    def test_capture_failure_resumes_old_apps_and_never_drills(self):
        events = self.mock_run_stages()
        self.job.capture = Mock(side_effect=Refused('capture failed'))
        with self.assertRaisesRegex(Refused, 'capture failed'):
            self.job.run()
        self.assertIn('resume_apps', events)
        self.assertNotIn('drill', events)
        self.assertEqual(json.loads((self.path / 'status.json').read_text())['phase'],
                         'capture_failed_old_apps_resumed')

    def test_shutdown_failure_still_attempts_safe_old_app_resume(self):
        events = self.mock_run_stages()
        self.job.stop_apps = Mock(side_effect=Refused('not drained'))
        with self.assertRaisesRegex(Refused, 'not drained'):
            self.job.run()
        self.assertIn('resume_apps', events)
        self.job.capture.assert_not_called()
        self.job.drill.assert_not_called()

    def test_primary_stop_failure_and_secondary_recovery_failure_are_both_preserved(self):
        self.mock_run_stages()
        primary = Refused('PRIMARY-SECRET-MESSAGE')
        secondary = ConnectionResetError('RECOVERY-SECRET-MESSAGE')
        self.job.stop_apps = Mock(side_effect=primary)
        self.job.resume_apps = Mock(side_effect=secondary)
        with self.assertRaises(ConnectionResetError) as caught:
            self.job.run()
        self.assertIs(caught.exception.__cause__, primary)
        first = json.loads((self.path / 'capture-failure.json').read_text())
        second = json.loads((self.path / 'recovery-failure.json').read_text())
        self.assertEqual(first['errorType'], 'Refused')
        self.assertEqual(second['errorType'], 'ConnectionResetError')
        self.assertTrue(first['sites'])
        self.assertTrue(second['sites'])
        for value in (first, second):
            self.assertEqual(set(value), {'phase', 'errorType', 'sites', 'at'})
            self.assertNotIn('SECRET', json.dumps(value))
            self.assertTrue(all(set(site) == {'file', 'line'} for site in value['sites']))
        self.job.capture.assert_not_called()
        self.job.drill.assert_not_called()

    def test_primary_evidence_write_failure_never_suppresses_resume_or_original_failure(self):
        events = self.mock_run_stages()
        self.job.stop_apps = Mock(side_effect=Refused('primary stop refusal'))
        record = self.native.record
        def fail_primary(path, value):
            if path.name == 'capture-failure.json':
                raise OSError('evidence destination unavailable')
            return record(path, value)
        self.native.record = fail_primary
        with self.assertRaisesRegex(Refused, 'primary stop refusal'):
            self.job.run()
        self.assertIn('resume_apps', events)
        self.job.drill.assert_not_called()

    def test_cleanup_failure_never_suppresses_resume_or_original_failure(self):
        events = self.mock_run_stages()
        self.job.stop_apps = Mock(side_effect=Refused('primary stop refusal'))
        self.job.cleanup_source = Mock(side_effect=OSError('private cleanup error'))
        with self.assertRaisesRegex(Refused, 'primary stop refusal'):
            self.job.run()
        self.assertIn('resume_apps', events)
        self.assertEqual(json.loads((self.path / 'cleanup-failure.json').read_text())['errorType'], 'OSError')

    def test_clone_pg_tcp_gate_is_authenticated_without_changing_source_transport(self):
        self.job.shell = Mock(return_value=b'1\n')
        self.assertEqual(self.job.pg('clone', 'SELECT 1;', 'postgres', tcp=True), b'1')
        clone_script = self.job.shell.call_args.args[1]
        self.assertIn('--host 127.0.0.1 --port 5432', clone_script)
        self.assertIn('PGPASSWORD="$POSTGRES_PASSWORD"', clone_script)
        self.assertIn('--no-password', clone_script)
        self.job.pg('source', 'SELECT 1;', 'postgres')
        self.assertNotIn('--host', self.job.shell.call_args.args[1])

    def test_private_pg_command_keeps_stderr_and_return_code_without_printing_it(self):
        self.job.targets = ['isolated-pg']
        self.job.drill_step = 'postgres_restore'
        def run(args, **kwargs):
            self.assertNotIn('source', args)
            self.assertIn('isolated-pg', args)
            kwargs['stdout'].write(b'private stdout')
            kwargs['stderr'].write(b'PRIVATE-RESTORE-ERROR')
            return SimpleNamespace(returncode=3)
        with patch.object(backup.subprocess, 'run', side_effect=run), \
                patch('sys.stdout', new_callable=io.StringIO) as output:
            with self.assertRaisesRegex(Refused, 'private step logs'):
                self.job.logged_pg_command('isolated-pg', 'exec pg_restore fixture', 'postgres-restore')
        self.assertEqual(output.getvalue(), '')
        self.assertEqual((self.path / 'postgres-restore.stderr.log').read_bytes(), b'PRIVATE-RESTORE-ERROR')
        self.assertEqual(json.loads((self.path / 'postgres-restore.result.json').read_text())['returnCode'], 3)

    def test_private_pg_command_timeout_retains_null_terminal_result(self):
        self.job.targets = ['isolated-pg']
        with patch.object(backup.subprocess, 'run',
                          side_effect=backup.subprocess.TimeoutExpired('private command', 600)):
            with self.assertRaises(Refused):
                self.job.logged_pg_command('isolated-pg', 'exec psql fixture', 'postgres-create-database')
        result = json.loads((self.path / 'postgres-create-database.result.json').read_text())
        self.assertIsNone(result['returnCode'])
        self.assertTrue(result['timedOut'])

    def test_primary_drill_step_is_saved_before_failing_cleanup(self):
        self.mock_run_stages()
        def drill(*args):
            self.job.drill_step = 'postgres_create_database'
            raise Refused('PRIMARY-PRIVATE-ERROR')
        def cleanup():
            report = json.loads((self.path / 'drill-failure.json').read_text())
            self.assertEqual(report['phase'], 'postgres_create_database')
            self.assertNotIn('PRIVATE', json.dumps(report))
            raise OSError('SECONDARY-PRIVATE-ERROR')
        self.job.drill.side_effect = drill
        self.job.stop_failed_targets = Mock(side_effect=cleanup)
        with self.assertRaisesRegex(Refused, 'PRIMARY-PRIVATE-ERROR'):
            self.job.run()
        self.assertEqual(json.loads((self.path / 'drill-cleanup-failure.json').read_text())['errorType'], 'OSError')

    def existing_capture_fixture(self):
        self.native.STATE = self.path / 'state'
        prior = self.native.STATE / 'release-operations' / '20261117T153454Z-eddd7ac6' / 'backup'
        prior.mkdir(parents=True)
        artifacts = {}
        for name in sorted(backup.ARTIFACT_NAMES):
            path = prior / name
            path.write_bytes(('private-fixture-' + name).encode())
            artifacts[name] = {'path': name, 'bytes': path.stat().st_size, 'sha256': backup.file_hash(path)}
        (prior / 'artifacts.json').write_text(json.dumps(artifacts))
        expected = {'postgres': {'fixture': 1}, 'clickhouse': {'fixture': 2}, 'redis': {}, 'redisModules': []}
        (prior / 'captured-checks.json').write_text(json.dumps(expected))
        (prior / 'source-configs.json').write_text('[]')
        (prior / 'source-configs').mkdir()
        (prior / 'stopped-apps.json').write_text('{}')
        self.native.ROOT = self.path / 'install'
        (self.native.ROOT / 'source/ops/minimal').mkdir(parents=True)
        for index, relative in enumerate(('docker-compose.yml', 'ops/minimal/compose.fresh.yml')):
            raw = ('compose-' + str(index)).encode()
            (prior / ('compose-' + str(index) + '.yml')).write_bytes(raw)
            (self.native.ROOT / 'source' / relative).write_bytes(raw)
        self.native.private = Mock()
        self.native.receipt_directory = Mock()
        self.native.private_build_directory = Mock()
        self.native.receipt_file = lambda path: path.read_bytes()
        self.native.snapshot = Mock(return_value=self.job.before)
        self.native.image_info = Mock(side_effect=lambda identity: {'Id': identity})
        self.native.readiness = Mock()
        self.native.receipt_guard = Mock()
        self.before = deepcopy(self.job.before)
        def validate(instance):
            instance.before = deepcopy(self.before)
            return prior / 'previous.env', {}
        self.stack.enter_context(patch.object(backup.Backup, 'validate_runtime', autospec=True, side_effect=validate))
        self.stack.enter_context(patch.object(backup.os, 'geteuid', return_value=0, create=True))
        for method in ('stop_apps', 'resume_apps', 'capture', 'create_auth', 'cleanup_source'):
            self.stack.enter_context(patch.object(backup.Backup, method,
                side_effect=AssertionError('Source control/auth/capture forbidden')))
        drill = self.stack.enter_context(patch.object(backup.Backup, 'drill', autospec=True,
                                                      return_value={'phase': 'passed'}))
        self.stack.enter_context(patch.object(backup.Backup, 'cleanup_targets', autospec=True))
        destination = self.path / 'new-private-drill'
        destination.mkdir()
        return prior, destination, artifacts, drill

    def test_resume_drill_copies_verified_bytes_and_never_controls_source(self):
        prior, destination, artifacts, drill = self.existing_capture_fixture()
        original = {path.relative_to(prior).as_posix(): path.read_bytes() for path in prior.rglob('*') if path.is_file()}
        result = backup.resume_drill(self.native, destination, prior)
        self.assertEqual(result['phase'], 'verified')
        self.assertEqual(result['sourceOperation'], prior.parent.name)
        self.assertEqual(result['captureWindow'], {'start': None, 'end': None})
        for name, artifact in artifacts.items():
            self.assertEqual(backup.file_hash(destination / name), artifact['sha256'])
        self.assertEqual(original, {path.relative_to(prior).as_posix(): path.read_bytes()
                                   for path in prior.rglob('*') if path.is_file()})
        self.assertFalse((destination / 'redis-auth.env').exists())
        self.native.docker.assert_not_called()
        drill.assert_called_once()

    def test_resume_drill_rejects_changed_artifact_without_recapture(self):
        prior, destination, _, drill = self.existing_capture_fixture()
        (prior / 'postgres.dump').write_bytes(b'changed')
        with self.assertRaisesRegex(Refused, 'artifact size changed'):
            backup.resume_drill(self.native, destination, prior)
        drill.assert_not_called()
        self.assertTrue((destination / 'drill-failure.json').exists())
        self.native.docker.assert_not_called()

    def test_resume_drill_source_change_holds_and_preserves_original_capture(self):
        prior, destination, _, _ = self.existing_capture_fixture()
        changed = deepcopy(self.before)
        changed['postgres']['started'] = 'changed'
        self.native.snapshot.side_effect = [self.before, changed]
        with self.assertRaisesRegex(Refused, 'Source changed during'):
            backup.resume_drill(self.native, destination, prior)
        self.assertTrue((prior / 'postgres.dump').exists())
        self.assertTrue((destination / 'drill-failure.json').exists())
        self.assertFalse((destination / 'verified.json').exists())
        self.native.docker.assert_not_called()

    def test_private_copy_is_exclusive_and_requests_mode_0600(self):
        source = self.path / 'source-private'
        source.write_bytes(b'private artifact')
        self.native.private = Mock()
        target = self.path / 'target-private'
        real_open = backup.os.open
        with patch.object(backup.os, 'open', wraps=real_open) as opened:
            self.job.copy_private(source, target, backup.file_hash(source))
        self.assertEqual(opened.call_args.args[-1], 0o600)
        self.assertTrue(opened.call_args.args[1] & os.O_EXCL)
        with self.assertRaises(FileExistsError):
            self.job.copy_private(source, target)
        self.assertEqual(target.read_bytes(), b'private artifact')

    def test_reporting_failure_cannot_suppress_old_app_resume(self):
        events = self.mock_run_stages()
        def progress(phase):
            if phase == 'backup_resuming_old_apps':
                raise OSError('progress storage unavailable')
        self.job.progress = progress
        with self.assertRaisesRegex(OSError, 'progress storage'):
            self.job.run()
        self.assertIn('resume_apps', events)
        self.assertIn('cleanup_source', events)
        self.assertNotIn('drill', events)

    def test_drill_failure_stops_only_its_isolated_targets(self):
        self.mock_run_stages()
        self.job.drill = Mock(side_effect=Refused('restore failed'))
        self.job.stop_failed_targets = Mock()
        with self.assertRaisesRegex(Refused, 'restore failed'):
            self.job.run()
        self.job.stop_failed_targets.assert_called_once_with()
        self.job.cleanup_targets.assert_not_called()
        self.assertEqual(json.loads((self.path / 'status.json').read_text())['phase'],
                         'drill_failed_old_apps_resumed')

    def test_preflight_requires_normal_receipt_guard(self):
        self.native.private_build_directory = Mock()
        self.native.STATE = self.path
        self.native.snapshot = Mock(return_value=self.job.before)
        self.native.receipt_guard = Mock(side_effect=Refused('receipt drift'))
        self.native.current_env = Mock()
        with patch.object(backup.os, 'geteuid', return_value=0, create=True):
            with self.assertRaisesRegex(Refused, 'receipt drift'):
                self.job.preflight()
        self.native.receipt_guard.assert_called_once_with(self.job.before)
        self.native.current_env.assert_not_called()

    def test_resume_checks_databases_before_starting_any_writer(self):
        self.job.stopped = ['client', 'backend']
        self.job.database_unchanged = Mock(side_effect=Refused('DB changed'))
        with self.assertRaisesRegex(Refused, 'DB changed'):
            self.job.resume_apps()
        self.native.docker.assert_not_called()

    def test_binary_stream_separates_stderr_and_never_puts_password_in_args(self):
        seen = []
        def run(args, **kwargs):
            seen.extend(args)
            kwargs['stdout'].write(b'PGDMP\x00binary')
            kwargs['stderr'].write(b'private warning')
            self.assertIsNot(kwargs['stdout'], kwargs['stderr'])
            return SimpleNamespace(returncode=0)
        with patch.object(backup.subprocess, 'run', side_effect=run):
            self.job.stream(['exec', 'fixture', 'pg_dump'], self.path / 'dump')
        self.assertEqual((self.path / 'dump').read_bytes(), b'PGDMP\x00binary')
        self.assertEqual((self.path / 'dump.stderr').read_bytes(), b'private warning')
        self.assertNotIn('password', ' '.join(seen))

    def test_failed_stream_retains_partial_and_has_no_complete_archive(self):
        def run(args, **kwargs):
            kwargs['stdout'].write(b'partial')
            return SimpleNamespace(returncode=1)
        with patch.object(backup.subprocess, 'run', side_effect=run):
            with self.assertRaisesRegex(Refused, 'stream failed'):
                self.job.stream(['exec', 'fixture', 'pg_dump'], self.path / 'dump')
        self.assertFalse((self.path / 'dump').exists())
        self.assertEqual((self.path / 'dump.partial').read_bytes(), b'partial')

    def test_auth_is_stdin_or_envfile_and_xml_escapes_credentials(self):
        password = 'fixture<&"$secret'
        model = {'services': {'backend': {'environment': {'REDIS_PASSWORD': password}},
                             'clickhouse': {'environment': {'CLICKHOUSE_PASSWORD': password}}}}
        calls = []
        self.job.shell = Mock(side_effect=lambda *args, **kwargs: calls.append((args, kwargs)))
        self.job.create_auth(model)
        args, kwargs = calls[1]
        self.assertNotIn(password, str(args))
        self.assertIn(b'&lt;&amp;', kwargs['data'])
        self.assertEqual((self.path / 'redis-auth.env').read_text(), 'REDISCLI_AUTH=' + password + '\n')

    def test_multiline_secret_rejected_before_source_mutation(self):
        model = {'services': {'backend': {'environment': {'REDIS_PASSWORD': 'a\nb'}},
                             'clickhouse': {'environment': {}}}}
        with self.assertRaisesRegex(Refused, 'authentication'):
            self.job.create_auth(model)
        self.native.docker.assert_not_called()

    def test_clickhouse_remote_engine_rejected(self):
        self.job.ch_rows = Mock(return_value=[{'name': 'events', 'engine': 'S3',
                                               'create_table_query': 'CREATE TABLE events ENGINE=S3(...)'}])
        with self.assertRaisesRegex(Refused, 'unsupported engine'):
            self.job.ch_checks('fixture')

    def test_clickhouse_aggregate_counts_use_final(self):
        self.job.ch_rows = Mock(return_value=[{'name': 'totals', 'engine': 'AggregatingMergeTree',
                                               'create_table_query': 'CREATE TABLE totals'}])
        self.job.ch = Mock(return_value=b'10')
        self.assertEqual(self.job.ch_checks('fixture')['counts'], {'totals': 10})
        self.assertIn(' FINAL', self.job.ch.call_args.args[1])

    def test_create_target_has_no_network_ports_or_source_volume_and_explicit_redis_command(self):
        cid = 'a' * 64
        calls = []
        def docker(*args, **kwargs):
            calls.append(args)
            if args[0] == 'volume':
                return b'volume'
            if args[0] == 'create':
                return cid.encode()
            return json.dumps([{'Image': self.job.before['redis']['image'],
                'HostConfig': {'NetworkMode': 'none', 'PortBindings': {},
                               'RestartPolicy': {'Name': 'no'}}, 'Mounts': []}]).encode()
        self.native.docker.side_effect = docker
        self.job.create_target('redis', command=('redis-server', '--appendonly', 'no'))
        create = next(args for args in calls if args[0] == 'create')
        self.assertEqual(create[-4:], (self.job.before['redis']['image'], 'redis-server', '--appendonly', 'no'))
        self.assertIn('--memory', create)
        self.assertIn('--cpus', create)
        self.assertEqual(create[create.index('--network') + 1], 'none')
        self.assertNotIn('--publish', create)
        self.assertFalse(any('source-redis' in item for item in create))

    def test_target_isolation_mismatch_refuses(self):
        self.native.docker.side_effect = [b'volume', ('a' * 64).encode(), json.dumps([{
            'Image': self.job.before['redis']['image'], 'HostConfig': {'NetworkMode': 'host'},
            'Mounts': []}]).encode()]
        with self.assertRaisesRegex(Refused, 'isolation'):
            self.job.create_target('redis')

    def test_cleanup_refuses_foreign_container(self):
        self.job.targets = ['a' * 64]
        self.native.docker.side_effect = lambda *args, **kwargs: json.dumps([{
            'Config': {'Labels': {'wotcv.native.drill': 'foreign'}},
            'HostConfig': {'NetworkMode': 'none'}}]).encode()
        with self.assertRaisesRegex(Refused, 'ownership'):
            self.job.cleanup_targets()
        self.assertFalse(any(call.args[0] == 'rm' for call in self.native.docker.call_args_list))

    def test_source_archive_path_matches_exact_image_file_fixture(self):
        self.assertEqual(self.job.ch_archive,
            '/var/lib/clickhouse/backups/backups/wotcv-native-' + self.job.token + '.zip')
        self.assertEqual(self.job.ch_relative, 'backups/wotcv-native-' + self.job.token + '.zip')

    def test_module_inventory_accepts_permutation_but_preserves_version_and_argument_identity(self):
        a = {'name': 'a', 'ver': 1, 'path': '/modules/a.so', 'args': ['--one', '--two'],
             'usedby': ['c', 'b']}
        b = {'name': 'b', 'ver': 2, 'path': '/modules/b.so', 'args': []}
        self.job.redis = Mock(return_value=[a, b])
        expected = self.job.redis_modules('source')
        self.job.redis.return_value = [list(sum(([key, value] for key, value in b.items()), [])),
                                      dict(a, usedby=['b', 'c'])]
        self.assertEqual(self.job.redis_modules('target', source=False), expected)
        self.job.redis.return_value = [a, dict(b, ver=3)]
        self.assertNotEqual(self.job.redis_modules('target', source=False), expected)
        self.job.redis.return_value = [dict(a, args=['--two', '--one']), b]
        self.assertNotEqual(self.job.redis_modules('target', source=False), expected)

    def test_module_duplicate_identity_or_fields_is_refused(self):
        a = {'name': 'a', 'ver': 1, 'path': '/a.so', 'args': []}
        self.job.redis = Mock(return_value=[a, a])
        with self.assertRaisesRegex(Refused, 'Duplicate'):
            self.job.redis_modules('fixture')
        self.job.redis.return_value = [['name', 'a', 'name', 'b']]
        with self.assertRaisesRegex(Refused, 'module fields'):
            self.job.redis_modules('fixture')


class PostgresLogicalComparisonTests(unittest.TestCase):
    def setUp(self):
        def column(table, name, ordinal, datatype='text', udt='text', nullable='YES', default=None):
            return {'table_schema': 'public', 'table_name': table, 'column_name': name,
                    'ordinal_position': ordinal, 'data_type': datatype, 'udt_name': udt,
                    'is_nullable': nullable, 'column_default': default}
        self.expected = {'inventory': {
            'columns': [column('invitation', 'id', 1, 'integer', 'int4', 'NO'),
                        column('invitation', 'teamId', 10), column('invitation', 'site_role', 14),
                        column('user', 'id', 5, nullable='NO')],
            'constraints': [{'schema': 'public', 'name': 'invitation', 'conname': 'invitation_pkey',
                             'definition': 'PRIMARY KEY (id)'}],
            'indexes': [{'schemaname': 'public', 'tablename': 'invitation', 'indexname': 'invitation_pkey',
                         'indexdef': 'CREATE UNIQUE INDEX invitation_pkey ON public.invitation USING btree (id)'}],
            'journal': [{'id': 1, 'hash': 'a' * 64, 'created_at': 1700000000000}]},
            'counts': {'public.invitation': 7, 'public.user': 2}}
        self.actual = deepcopy(self.expected)
        for row, ordinal in zip(self.actual['inventory']['columns'], (1, 2, 3, 1)):
            row['ordinal_position'] = ordinal

    def test_physical_gaps_are_accepted_per_table_without_mutating_raw_evidence(self):
        expected_raw = json.dumps(self.expected)
        actual_raw = json.dumps(self.actual)
        comparison = backup.postgres_comparison(self.expected, self.actual)
        self.assertFalse(comparison['rawEqual'])
        self.assertTrue(comparison['logicalEqual'])
        self.assertEqual(comparison['expectedLogicalSha256'], comparison['actualLogicalSha256'])
        self.assertEqual([row['ordinal_position'] for row in
                          backup.normalize_postgres_checks(self.expected)['inventory']['columns']], [1, 2, 3, 1])
        self.assertEqual(json.dumps(self.expected), expected_raw)
        self.assertEqual(json.dumps(self.actual), actual_raw)

    def test_changed_visible_column_order_is_rejected(self):
        self.actual['inventory']['columns'][1]['ordinal_position'] = 3
        self.actual['inventory']['columns'][2]['ordinal_position'] = 2
        self.actual['inventory']['columns'][1:3] = reversed(self.actual['inventory']['columns'][1:3])
        self.assertFalse(backup.postgres_comparison(self.expected, self.actual)['logicalEqual'])

    def test_type_default_nullability_and_udt_changes_are_rejected(self):
        for field, value in [('data_type', 'bigint'), ('udt_name', 'int8'),
                             ('column_default', 'PRIVATE-DIFFERENT-DEFAULT'), ('is_nullable', 'YES')]:
            actual = deepcopy(self.actual)
            actual['inventory']['columns'][0][field] = value
            with self.subTest(field=field):
                self.assertFalse(backup.postgres_comparison(self.expected, actual)['logicalEqual'])

    def test_constraints_indexes_journal_and_counts_remain_exact(self):
        changes = [('constraints', 'definition', 'PRIMARY KEY (teamId)'),
                   ('indexes', 'indexdef', 'CREATE INDEX different_definition'),
                   ('journal', 'hash', 'b' * 64), ('journal', 'id', 2), ('journal', 'created_at', 1700000000001)]
        for section, field, value in changes:
            actual = deepcopy(self.actual)
            actual['inventory'][section][0][field] = value
            with self.subTest(section=section, field=field):
                self.assertFalse(backup.postgres_comparison(self.expected, actual)['logicalEqual'])
        self.actual['counts']['public.invitation'] += 1
        self.assertFalse(backup.postgres_comparison(self.expected, self.actual)['logicalEqual'])

    def test_missing_extra_or_renamed_columns_are_rejected(self):
        for change in ('missing', 'extra', 'renamed'):
            actual = deepcopy(self.actual)
            if change == 'missing':
                actual['inventory']['columns'].pop()
            elif change == 'extra':
                row = dict(actual['inventory']['columns'][0], column_name='added', ordinal_position=20)
                actual['inventory']['columns'].append(row)
            else:
                actual['inventory']['columns'][0]['column_name'] = 'renamed'
            with self.subTest(change=change):
                self.assertFalse(backup.postgres_comparison(self.expected, actual)['logicalEqual'])

    def test_malformed_or_duplicate_ordinals_fail_closed_even_if_both_sides_match(self):
        for ordinal in (0, -1, None, '1', 1.0, True, False):
            bad = deepcopy(self.actual)
            bad['inventory']['columns'][0]['ordinal_position'] = ordinal
            with self.subTest(ordinal=ordinal), self.assertRaisesRegex(ValueError, 'column metadata'):
                backup.postgres_comparison(bad, bad)
        bad = deepcopy(self.actual)
        bad['inventory']['columns'][1]['ordinal_position'] = 1
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            backup.postgres_comparison(bad, bad)

    def test_duplicate_column_identity_and_unknown_metadata_fail_closed(self):
        bad = deepcopy(self.actual)
        duplicate = dict(bad['inventory']['columns'][0], ordinal_position=99)
        bad['inventory']['columns'].append(duplicate)
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            backup.postgres_comparison(bad, bad)
        bad = deepcopy(self.actual)
        bad['inventory']['columns'][0]['unreviewed'] = 'value'
        with self.assertRaisesRegex(ValueError, 'column metadata'):
            backup.postgres_comparison(bad, bad)

    def test_verifier_keeps_expected_actual_and_comparison_private_without_rewriting_capture(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            captured = root / 'captured-checks.json'
            original = json.dumps({'postgres': self.expected, 'otherEvidence': 'unchanged'}).encode()
            captured.write_bytes(original)
            native = SimpleNamespace(require=require,
                record=lambda path, value: path.write_text(json.dumps(value)))
            job = backup.Backup(native, root)
            result = job.verify_postgres(self.expected, self.actual)
            self.assertTrue(result['logicalEqual'])
            self.assertEqual(captured.read_bytes(), original)
            self.assertEqual(json.loads((root / 'postgres-expected-checks.json').read_text()), self.expected)
            self.assertEqual(json.loads((root / 'postgres-actual-checks.json').read_text()), self.actual)
            self.assertEqual(json.loads((root / 'postgres-comparison.json').read_text()), result)
            actual = deepcopy(self.actual)
            actual['counts']['public.invitation'] = 999
            with self.assertRaisesRegex(Refused, 'schema/counts/journal mismatch'):
                job.verify_postgres(self.expected, actual)
            self.assertEqual(json.loads((root / 'postgres-actual-checks.json').read_text()), actual)


if __name__ == '__main__':
    unittest.main()
