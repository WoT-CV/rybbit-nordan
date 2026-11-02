"""Offline completion-receipt safety tests: no Docker, SSH or network calls."""

from contextlib import ExitStack
from copy import deepcopy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import test_wotcv_native_cutover as cutover_tests


SCRIPT = Path(__file__).resolve().parents[1] / 'wotcv-complete-native-promotion.py'
SPEC = importlib.util.spec_from_file_location('wotcv_complete_promotion_under_test', SCRIPT)
phase = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(phase)
cutover = cutover_tests.phase
installer = cutover_tests.installer


class CompletionSafetyTests(unittest.TestCase):
    def fixture(self, stack, root):
        config, images, credentials = cutover_tests.public_fixture()
        legacy = [{'name': name, 'id': 'legacy-' + name} for name in installer.SERVICES]
        policies = {name: {'Name': 'unless-stopped', 'MaximumRetryCount': 0}
                    for name in installer.SERVICES}
        db_ids = {name: 'native-' + name for name in installer.VOLUMES}
        volumes = {'postgres-data': {'Name': 'rybbit_postgres-data', 'CreatedAt': 'unchanged'}}
        state = {'phase': 'bootstrap', 'images': deepcopy(images), 'legacy': legacy}
        state['images']['client'] = 'sha256:' + 'b' * 64
        environment = root / 'production.env'
        environment.write_text('OFFLINE_FIXTURE_ONLY=true\n')
        attempt = {'phase': 'promote-attempt', 'images': images, 'dbIds': db_ids,
                   'envSha': installer.digest(environment), 'legacyVolumes': volumes,
                   'oldRestart': policies}
        success = {'status': 'private-closed', 'source': installer.SOURCE,
                   'oldStackUnchanged': True, 'databaseContainersUnchanged': True}
        previous = {'privateContainerIds': db_ids}
        for name, value in (('cutover-promote-attempt.json', attempt),
                            ('private-closed-success.json', success),
                            ('private-closed-receipt.json', previous),
                            ('secrets.json', credentials)):
            (root / name).write_text(json.dumps(value))
        original = cutover_tests.ORIGINAL
        stack.enter_context(patch.object(cutover, 'ORIGINAL_SHA', hashlib.sha256(original.encode()).hexdigest()))
        vhost = root / 'nginx.conf'
        vhost.write_bytes(cutover.nginx_candidate(original, public=True).encode())
        stack.enter_context(patch.object(phase, 'ROOT', root))
        stack.enter_context(patch.object(cutover, 'ROOT', root))
        stack.enter_context(patch.object(cutover, 'VHOST', vhost))
        guards = {}
        for name in ('paths_guard', 'public_probe', 'producer_html_guard'):
            guards[name] = stack.enter_context(patch.object(cutover, name))
        stack.enter_context(patch.object(cutover, 'original_config', return_value=original))
        compose = stack.enter_context(patch.object(cutover, 'compose', return_value=json.dumps(config)))
        stack.enter_context(patch.object(cutover, 'legacy_volumes', return_value=volumes))
        stack.enter_context(patch.object(cutover, 'replace_nginx', side_effect=AssertionError('No nginx mutation permitted')))
        live, _, private, _ = cutover_tests.PublicRuntimeTests().runtime_fixture()
        private.validate_closed = cutover_tests.private.validate_closed
        for name, service in live.items():
            service['RestartCount'] = 0
            service['NetworkSettings'] = {'Networks': {installer.PROJECT + '_default': {}}}
            service['HostConfig']['PortBindings'] = (
                {('3001' if name == 'backend' else '3002') + '/tcp': [{
                    'HostIp': '127.0.0.1', 'HostPort': '13001' if name == 'backend' else '13002'}]}
                if name in ('backend', 'client') else {})
            service['HostConfig']['LogConfig'] = {
                'Type': 'json-file', 'Config': {'max-size': '50m', 'max-file': '5'}}
            service['Config']['Env'] = [key + '=' + value for key, value in
                                        config['services'][name].get('environment', {}).items()]
        def inspect(*args):
            if args[0] == 'inspect':
                name = args[1].removeprefix('legacy-')
                return [{'Id': args[1], 'State': {'Status': 'running'},
                         'HostConfig': {'RestartPolicy': deepcopy(policies[name])}}]
            self.assertEqual(args[:2], ('image', 'inspect'))
            return [{'Id': args[2], 'Config': {'Labels': {
                'org.opencontainers.image.revision': installer.SOURCE,
                'wotcv.fresh.kind': 'client-production' if args[2] == images['client'] else 'backend',
            }}}]
        tool = SimpleNamespace(
            SOURCE=installer.SOURCE, PROJECT=installer.PROJECT,
            SERVICES=installer.SERVICES, VOLUMES=installer.VOLUMES,
            require=installer.require, load=Mock(return_value=state), digest=installer.digest,
            legacy_snapshot=Mock(return_value=deepcopy(legacy)), json_docker=Mock(side_effect=inspect),
            validate_model=installer.validate_model, validate_credentials=installer.validate_credentials,
            private_write=Mock(wraps=installer.private_write),
            docker=Mock(side_effect=AssertionError('Docker mutation forbidden')),
            run=Mock(side_effect=AssertionError('Subprocess forbidden')),
        )
        # Windows chmod does not expose Unix permission bits; emulate only the
        # staged environment's 0600 stat, keeping all other filesystem checks real.
        real_stat = Path.stat
        def private_stat(path, *args, **kwargs):
            if path == environment:
                return SimpleNamespace(st_mode=stat.S_IFREG | 0o600)
            return real_stat(path, *args, **kwargs)
        stack.enter_context(patch.object(Path, 'stat', private_stat))
        stack.enter_context(patch.object(cutover.urllib.request, 'build_opener',
                                         side_effect=AssertionError('Network forbidden')))
        stack.enter_context(patch('sys.stdout', new_callable=io.StringIO))
        return SimpleNamespace(tool=tool, private=private, live=live, guards=guards,
                               compose=compose, root=root, attempt=attempt, state=state,
                               images=images, db_ids=db_ids, vhost=vhost)

    def execute(self, fixture, apply=False, ack=None):
        return phase.execute(fixture.tool, fixture.private, cutover, apply, ack)

    def assert_no_mutation(self, fixture):
        fixture.tool.private_write.assert_not_called()
        fixture.tool.docker.assert_not_called()
        fixture.tool.run.assert_not_called()
        self.assertTrue(all(call.args[2:] == ('config', '--format', 'json')
                            for call in fixture.compose.call_args_list))

    def test_check_verifies_existing_state_without_writes(self):
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            f = self.fixture(stack, Path(temp))
            before = {p.name: p.read_bytes() for p in f.root.iterdir()}
            self.execute(f)
            self.assertEqual({p.name: p.read_bytes() for p in f.root.iterdir()}, before)
            self.assert_no_mutation(f)
            f.guards['public_probe'].assert_called_once_with(f.tool)
            f.guards['producer_html_guard'].assert_called_once_with(f.tool)

    def test_apply_writes_only_missing_readiness_receipt_and_preserves_attempt(self):
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            f = self.fixture(stack, Path(temp))
            before = {p.name: p.read_bytes() for p in f.root.iterdir()}
            self.execute(f, True, phase.ACK)
            self.assertEqual({p.name: p.read_bytes() for p in f.root.iterdir() if p.name in before}, before)
            self.assertEqual(set(p.name for p in f.root.iterdir()) - set(before), {'cutover-public-ready.json'})
            f.tool.private_write.assert_called_once()
            receipt = json.loads((f.root / 'cutover-public-ready.json').read_text())
            self.assertEqual(receipt['images'], f.images)
            self.assertEqual(receipt['dbIds'], f.db_ids)
            self.assertIs(receipt['producerVerified'], False)
            self.assertIs(receipt['frontendSnippetVerified'], True)
            self.assertEqual(receipt['recoveredFrom'], 'promote-attempt')
            self.assertEqual(receipt['originalAttemptSha'], installer.digest(f.root / 'cutover-promote-attempt.json'))
            self.assertEqual(receipt['cutoverArtifactSha'], phase.CUTOVER_SHA)
            f.tool.docker.assert_not_called()
            f.tool.run.assert_not_called()

    def test_missing_or_wrong_ack_refuses_before_any_preflight(self):
        for ack in (None, '', 'promote-native-keep-old-data'):
            with self.subTest(ack=ack), tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
                f = self.fixture(stack, Path(temp))
                with self.assertRaises(installer.Refused):
                    self.execute(f, True, ack)
                f.tool.load.assert_not_called()
                f.guards['paths_guard'].assert_not_called()
                self.assert_no_mutation(f)

    def test_any_later_marker_refuses_without_overwrite(self):
        markers = ('public-ready', 'rollback-attempt', 'rolled-back', 'retire-attempt',
                   'legacy-retired', 'cleanup-attempt', 'cleanup-complete')
        for marker in markers:
            with self.subTest(marker=marker), tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
                f = self.fixture(stack, Path(temp))
                path = f.root / ('cutover-' + marker + '.json')
                path.write_text('{"doNotOverwrite":true}')
                with self.assertRaises(installer.Refused):
                    self.execute(f, True, phase.ACK)
                self.assertEqual(path.read_text(), '{"doNotOverwrite":true}')
                self.assert_no_mutation(f)

    def test_missing_attempt_unexpected_phase_and_bad_provenance_refuse(self):
        for kind in ('no-attempt', 'phase', 'attempt-phase', 'source', 'old-stack', 'databases'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
                f = self.fixture(stack, Path(temp))
                if kind == 'no-attempt':
                    (f.root / 'cutover-promote-attempt.json').unlink()
                elif kind == 'phase':
                    f.state['phase'] = 'starting'
                elif kind == 'attempt-phase':
                    f.attempt['phase'] = 'promote-complete'
                    (f.root / 'cutover-promote-attempt.json').write_text(json.dumps(f.attempt))
                else:
                    path = f.root / 'private-closed-success.json'
                    value = json.loads(path.read_text())
                    value[{'source': 'source', 'old-stack': 'oldStackUnchanged',
                           'databases': 'databaseContainersUnchanged'}[kind]] = False
                    path.write_text(json.dumps(value))
                with self.assertRaises(installer.Refused):
                    self.execute(f, True, phase.ACK)
                self.assert_no_mutation(f)

    def test_attempt_image_database_environment_and_legacy_volume_drift_refuse(self):
        for kind in ('client-image', 'backend-image', 'db-replaced', 'extra-db', 'environment', 'volume', 'restart-receipt'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
                f = self.fixture(stack, Path(temp))
                if kind.endswith('-image'):
                    f.attempt['images'][kind.removesuffix('-image')] = 'sha256:' + 'f' * 64
                elif kind == 'db-replaced':
                    f.attempt['dbIds']['postgres'] = 'replaced'
                elif kind == 'extra-db':
                    f.attempt['dbIds']['other'] = 'unexpected'
                elif kind == 'environment':
                    (f.root / 'production.env').write_text('CHANGED=true')
                elif kind == 'volume':
                    f.attempt['legacyVolumes'] = {}
                else:
                    f.attempt['oldRestart'].pop('backend')
                (f.root / 'cutover-promote-attempt.json').write_text(json.dumps(f.attempt))
                with self.assertRaises(installer.Refused):
                    self.execute(f, True, phase.ACK)
                self.assert_no_mutation(f)

    def test_live_legacy_runtime_and_nginx_drift_refuse(self):
        for kind in ('legacy-identity', 'legacy-stopped', 'legacy-restart', 'native-restart', 'native-image', 'native-db', 'nginx'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
                f = self.fixture(stack, Path(temp))
                if kind == 'legacy-identity':
                    f.tool.legacy_snapshot.return_value = []
                elif kind.startswith('legacy-'):
                    original_inspect = f.tool.json_docker.side_effect
                    def changed_inspect(*args):
                        result = original_inspect(*args)
                        if args[0] == 'inspect':
                            if kind == 'legacy-stopped':
                                result[0]['State']['Status'] = 'exited'
                            else:
                                result[0]['HostConfig']['RestartPolicy']['Name'] = 'no'
                        return result
                    f.tool.json_docker.side_effect = changed_inspect
                elif kind == 'native-restart':
                    f.live['backend']['RestartCount'] = 1
                elif kind == 'native-image':
                    f.live['client']['Image'] = 'sha256:' + 'f' * 64
                elif kind == 'native-db':
                    f.live['postgres']['Id'] = 'replaced'
                else:
                    f.vhost.write_text(f.vhost.read_text() + '# changed')
                with self.assertRaises(installer.Refused):
                    self.execute(f, True, phase.ACK)
                self.assert_no_mutation(f)

    def test_public_or_frontend_probe_failure_cannot_seal_receipt(self):
        for name in ('public_probe', 'producer_html_guard'):
            with self.subTest(probe=name), tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
                f = self.fixture(stack, Path(temp))
                f.guards[name].side_effect = installer.Refused('simulated probe failure')
                with self.assertRaisesRegex(installer.Refused, 'simulated probe failure'):
                    self.execute(f, True, phase.ACK)
                self.assertFalse((f.root / 'cutover-public-ready.json').exists())
                self.assert_no_mutation(f)

    def test_actual_network_ports_logging_and_runtime_environment_must_match(self):
        cases = ('public-bind', 'wrong-port', 'db-exposed', 'foreign-network',
                 'extra-network', 'logging', 'runtime-secret', 'runtime-signup')
        for kind in cases:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
                f = self.fixture(stack, Path(temp))
                backend = f.live['backend']
                if kind in ('public-bind', 'wrong-port'):
                    field = 'HostIp' if kind == 'public-bind' else 'HostPort'
                    backend['HostConfig']['PortBindings']['3001/tcp'][0][field] = (
                        '0.0.0.0' if kind == 'public-bind' else '3001')
                elif kind == 'db-exposed':
                    f.live['postgres']['HostConfig']['PortBindings'] = {'5432/tcp': []}
                elif kind == 'foreign-network':
                    backend['NetworkSettings']['Networks'] = {'rybbit_default': {}}
                elif kind == 'extra-network':
                    backend['NetworkSettings']['Networks']['rybbit_default'] = {}
                elif kind == 'logging':
                    backend['HostConfig']['LogConfig']['Config']['max-file'] = '1'
                else:
                    key = 'POSTGRES_PASSWORD' if kind == 'runtime-secret' else 'DISABLE_SIGNUP'
                    backend['Config']['Env'] = [item for item in backend['Config']['Env']
                                                 if not item.startswith(key + '=')]
                    backend['Config']['Env'].append(key + '=changed')
                with self.assertRaises(installer.Refused):
                    self.execute(f, True, phase.ACK)
                self.assert_no_mutation(f)

    def test_runtime_image_source_label_cannot_drift(self):
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            f = self.fixture(stack, Path(temp))
            original_inspect = f.tool.json_docker.side_effect
            def wrong_source(*args):
                result = original_inspect(*args)
                if args[:2] == ('image', 'inspect'):
                    result[0]['Config']['Labels']['org.opencontainers.image.revision'] = 'old'
                return result
            f.tool.json_docker.side_effect = wrong_source
            with self.assertRaisesRegex(installer.Refused, 'source label'):
                self.execute(f, True, phase.ACK)
            self.assert_no_mutation(f)


if __name__ == '__main__':
    unittest.main()
