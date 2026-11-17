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


if __name__ == '__main__':
    unittest.main()
