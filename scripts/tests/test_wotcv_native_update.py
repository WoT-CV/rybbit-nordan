"""Offline native-updater regressions. Never contact Docker, SSH or a network."""

from contextlib import ExitStack, nullcontext
from copy import deepcopy
import importlib.util
import io
import json
from pathlib import Path
import stat
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / 'wotcv-native-update.py'
SPEC = importlib.util.spec_from_file_location('wotcv_native_update_under_test', SCRIPT)
phase = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(phase)
OLD_IMAGES = {name: 'sha256:' + str(index) * 64
              for index, name in enumerate(phase.SERVICES, 1)}
NEW_IMAGES = {'backend': 'sha256:' + 'a' * 64, 'client': 'sha256:' + 'b' * 64}
REVISION = 'c' * 40


def runtime():
    result = []
    for name in phase.SERVICES:
        labels = {'com.docker.compose.project': phase.PROJECT,
                  'com.docker.compose.service': name,
                  'com.docker.compose.project.working_dir': str(phase.ROOT / 'source'),
                  'com.docker.compose.project.config_files':
                  str(phase.ROOT / 'source/docker-compose.yml') + ',' +
                  str(phase.ROOT / 'source/ops/minimal/compose.fresh.yml')}
        mounts = ([{'Type': 'volume', 'Name': phase.PROJECT + '_' + name + '-data',
                    'Destination': phase.DATABASES[name], 'RW': True}]
                  if name in phase.DATABASES else [])
        ports = ({} if name in phase.DATABASES else
                 {('3001/tcp' if name == 'backend' else '3002/tcp'):
                  [{'HostIp': '127.0.0.1', 'HostPort': '13001' if name == 'backend' else '13002'}]})
        result.append({'Id': 'native-' + name, 'Image': OLD_IMAGES[name],
                       'Config': {'Labels': labels},
                       'State': {'Status': 'running', 'Health': {'Status': 'healthy'},
                                 'StartedAt': '2026-11-02T00:00:00Z'},
                       'RestartCount': 0, 'Mounts': mounts,
                       'HostConfig': {'PortBindings': ports},
                       'NetworkSettings': {'Networks': {phase.PROJECT + '_default': {}}}})
    return result


def live_state():
    result = {item['Config']['Labels']['com.docker.compose.service']:
            {'id': item['Id'], 'image': item['Image'], 'mounts': item['Mounts'],
             'started': item['State']['StartedAt'], 'restarts': item['RestartCount']}
            for item in runtime()}
    for name in phase.DATABASES:
        result[name]['volume'] = volume_metadata(phase.PROJECT + '_' + name + '-data')
    return result


def volume_metadata(name):
    return {'Name': name, 'Driver': 'local', 'Options': {},
            'Labels': {'com.docker.compose.project': phase.PROJECT},
            'CreatedAt': '2026-11-02T00:00:00Z'}


def effective_model():
    backend = {'BASE_URL': phase.PUBLIC, 'SERVER_URL': phase.PUBLIC, 'CLOUD': 'false',
               'DISABLE_SIGNUP': 'true', 'DISABLE_TELEMETRY': 'true', 'CLUSTER_WORKERS': '0',
               'WOTCV_REPLAY_CORRELATION_JSON': '[{"name":"offline-fixture"}]', 'SOURCE_CODE_URL': 'old-source',
               'DATABASE_URL': 'postgres://offline-user:secret@postgres/rybbit'}
    client = {'NEXT_PUBLIC_BACKEND_URL': phase.PUBLIC, 'NEXT_PUBLIC_CLOUD': 'false',
              'NEXT_PUBLIC_DISABLE_SIGNUP': 'true'}
    return {'name': phase.PROJECT, 'services': {
        name: {'image': OLD_IMAGES[name], 'pull_policy': 'never',
               'environment': backend if name == 'backend' else client if name == 'client' else {}}
        for name in phase.SERVICES}}


ENV = (b'# credentials and correlation must stay byte-identical\n'
       b"POSTGRES_PASSWORD='offline$ secret#value'\n"
       b"WOTCV_REPLAY_CORRELATION_JSON='[{\"name\":\"test\",\"value\":\"$abc\"}]'\n"
       b"WOTCV_BACKEND_IMAGE='old-backend'\nWOTCV_CLIENT_IMAGE='old-client'\n"
       b"SOURCE_CODE_URL='old-source'\nUNRELATED=untouched\n")


class OfflineTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(phase.subprocess, 'run',
                                             side_effect=AssertionError('Real subprocess forbidden')))
        self.stack.enter_context(patch.object(phase.urllib.request, 'build_opener',
                                             side_effect=AssertionError('Real network forbidden')))
        for name in ('run', 'docker', 'probe'):
            self.stack.enter_context(patch.object(phase, name,
                                                 side_effect=AssertionError('Unmocked ' + name)))
        self.stack.enter_context(patch.object(phase.time, 'sleep',
                                             side_effect=AssertionError('Real wait forbidden')))
        self.stack.enter_context(patch('sys.stdout', new_callable=io.StringIO))
        self.stack.enter_context(patch.object(phase.os, 'geteuid', return_value=0, create=True))
        self.temp = self.stack.enter_context(tempfile.TemporaryDirectory())
        self.root = Path(self.temp)

    def source_fixture(self):
        sealed = self.root / 'sealed'
        original = sealed / 'source'
        candidate = self.root / 'candidate'
        files = {'server/src/index.ts': 'server code', 'server/src/db/schema.ts': 'schema',
                 'server/public/script.js.gz': 'compressed public asset',
                 'shared/index.ts': 'shared contracts', 'clickhouse/schema.sql': 'schema', 'package.json': '{}',
                 'pnpm-lock.yaml': 'lock', 'pnpm-workspace.yaml': 'workspace',
                 'docker-compose.yml': 'compose', '.dockerignore': 'ignore',
                 'client/Dockerfile': 'client image contract', 'client/src/page.tsx': 'frontend'}
        for base in (original, candidate):
            for name, value in files.items():
                path = base / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(value)
        (sealed / 'state.json').write_text(json.dumps({
            'source': phase.BASELINE, 'project': phase.PROJECT,
            'sourceFiles': phase.source_hashes(original)}))
        self.stack.enter_context(patch.object(phase, 'ROOT', sealed))
        return original, candidate

    def snapshot_with(self, items, metadata_change=None, consumers=None):
        def inspect(*args, **kwargs):
            if args[:2] == ('ps', '-aq') and args[-1].startswith('label='):
                return ' '.join(item['Id'] for item in items).encode()
            if args[0] == 'inspect':
                return json.dumps(items).encode()
            if args[:2] == ('volume', 'inspect'):
                metadata = volume_metadata(args[2])
                if metadata_change:
                    metadata_change(metadata)
                return json.dumps([metadata]).encode()
            if args[:2] == ('ps', '-aq') and args[-1].startswith('volume='):
                service = args[-1].removeprefix('volume=' + phase.PROJECT + '_').removesuffix('-data')
                return consumers if consumers is not None else ('native-' + service).encode()
            self.fail('Unexpected Docker call: ' + repr(args))
        docker = self.stack.enter_context(patch.object(phase, 'docker', side_effect=inspect))
        result = phase.snapshot()
        self.assertEqual(docker.call_args_list[0].args[:2], ('ps', '-aq'))
        return result

    def test_source_guard_accepts_frontend_and_compressed_public_asset_changes(self):
        _, candidate = self.source_fixture()
        (candidate / 'client/src/page.tsx').write_text('new frontend')
        (candidate / 'server/public/script.js.gz').write_bytes(b'new compressed asset')
        phase.source_guard(candidate)

    def test_source_guard_rejects_changed_or_added_backend_contracts(self):
        _, candidate = self.source_fixture()
        for name in ('server/src/index.ts', 'server/src/db/schema.ts', 'server/new-migration.sql',
                     'shared/index.ts', 'clickhouse/schema.sql', 'package.json', 'pnpm-lock.yaml',
                     'pnpm-workspace.yaml', 'docker-compose.yml', '.dockerignore', 'client/Dockerfile'):
            with self.subTest(name=name):
                path = candidate / name
                previous = path.read_bytes() if path.exists() else None
                path.write_text('changed')
                with self.assertRaises(phase.Refused):
                    phase.source_guard(candidate)
                if previous is None:
                    path.unlink()
                else:
                    path.write_bytes(previous)

    def test_source_guard_rejects_deleted_schema(self):
        _, candidate = self.source_fixture()
        (candidate / 'server/src/db/schema.ts').unlink()
        with self.assertRaises(phase.Refused):
            phase.source_guard(candidate)

    def test_source_guard_rejects_mutated_sealed_source_and_identity(self):
        original, candidate = self.source_fixture()
        (original / 'client/src/page.tsx').write_text('tampered baseline')
        with self.assertRaises(phase.Refused):
            phase.source_guard(candidate)

    def test_source_guard_rejects_incorrect_baseline_receipt(self):
        original, candidate = self.source_fixture()
        receipt = original.parent / 'state.json'
        state = json.loads(receipt.read_text())
        state['source'] = REVISION
        receipt.write_text(json.dumps(state))
        with self.assertRaises(phase.Refused):
            phase.source_guard(candidate)

    def test_user_prepare_compares_baseline_git_contract_without_root_receipt(self):
        original, candidate = self.source_fixture()
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode='w') as archive:
            for path in original.rglob('*'):
                if path.is_file():
                    value = path.read_bytes()
                    member = tarfile.TarInfo(path.relative_to(original).as_posix())
                    member.size = len(value)
                    archive.addfile(member, io.BytesIO(value))
        (original.parent / 'state.json').unlink()
        with patch.object(phase.os, 'geteuid', return_value=1000, create=True), \
                patch.object(phase, 'git', return_value=data.getvalue()) as git:
            phase.source_guard(candidate)
            git.assert_called_once_with('archive', '--format=tar', phase.BASELINE)
            (original / 'server/src/db/schema.ts').write_text('tampered native baseline')
            with self.assertRaises(phase.Refused):
                phase.source_guard(candidate)

    def archive(self, name, kind=tarfile.REGTYPE):
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode='w') as archive:
            member = tarfile.TarInfo(name)
            member.type = kind
            if kind == tarfile.REGTYPE:
                member.size = 2
                archive.addfile(member, io.BytesIO(b'ok'))
            else:
                member.linkname = '../outside'
                archive.addfile(member)
        return data.getvalue()

    def test_unpack_accepts_regular_git_archive(self):
        target = self.root / 'unpacked'
        target.mkdir()
        # tarfile must not mistake this Windows process for a real Unix root.
        with patch.object(phase.os, 'geteuid', return_value=1000, create=True):
            phase.unpack(self.archive('client/page.tsx'), target)
        self.assertEqual((target / 'client/page.tsx').read_bytes(), b'ok')

    def test_unpack_rejects_traversal_absolute_backslash_and_links(self):
        for name, kind in (('../escape', tarfile.REGTYPE), ('/absolute', tarfile.REGTYPE),
                           ('client/../../escape', tarfile.REGTYPE),
                           ('client\\escape', tarfile.REGTYPE),
                           ('symlink', tarfile.SYMTYPE), ('hardlink', tarfile.LNKTYPE),
                           ('device', tarfile.CHRTYPE), ('fifo', tarfile.FIFOTYPE)):
            with self.subTest(name=name, kind=kind), self.assertRaises(phase.Refused):
                phase.unpack(self.archive(name, kind), self.root)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_app_env_changes_only_two_images_and_provenance(self):
        actual = phase.app_env(ENV, NEW_IMAGES, REVISION).encode()
        expected = ENV.replace(b"WOTCV_BACKEND_IMAGE='old-backend'",
                               ("WOTCV_BACKEND_IMAGE='" + NEW_IMAGES['backend'] + "'").encode())
        expected = expected.replace(b"WOTCV_CLIENT_IMAGE='old-client'",
                                    ("WOTCV_CLIENT_IMAGE='" + NEW_IMAGES['client'] + "'").encode())
        expected = expected.replace(b"SOURCE_CODE_URL='old-source'",
                                    ("SOURCE_CODE_URL='" + phase.REMOTE + '/tree/' + REVISION + "'").encode())
        self.assertEqual(actual, expected)

    def test_app_env_rejects_missing_and_duplicate_keys(self):
        for key in (b'WOTCV_BACKEND_IMAGE', b'WOTCV_CLIENT_IMAGE', b'SOURCE_CODE_URL'):
            for invalid in (b'\n'.join(line for line in ENV.split(b'\n') if not line.startswith(key + b'=')),
                            ENV + key + b"='duplicate'\n"):
                with self.subTest(key=key, invalid=invalid), self.assertRaises(phase.Refused):
                    phase.app_env(invalid, NEW_IMAGES, REVISION)

    def test_snapshot_accepts_exact_native_runtime(self):
        self.assertEqual(self.snapshot_with(runtime()), live_state())

    def test_snapshot_refuses_missing_extra_duplicate_or_foreign_services(self):
        variants = []
        items = runtime()
        variants.append(items[:-1])
        variants.append(items + [deepcopy(items[-1])])
        for label, value in (('com.docker.compose.project', 'legacy'),
                             ('com.docker.compose.service', 'unknown'),
                             ('com.docker.compose.service', 'client')):
            items = runtime()
            items[0]['Config']['Labels'][label] = value
            variants.append(items)
        for items in variants:
            with self.subTest(items=len(items)), self.assertRaises(phase.Refused):
                self.snapshot_with(items)

    def test_snapshot_refuses_unready_services_and_wrong_network(self):
        for service, change in (('backend', 'stopped'), ('postgres', 'unhealthy'),
                                ('client', 'network')):
            items = runtime()
            item = next(i for i in items if i['Config']['Labels']['com.docker.compose.service'] == service)
            if change == 'stopped':
                item['State']['Status'] = 'exited'
            elif change == 'unhealthy':
                item['State']['Health']['Status'] = 'unhealthy'
            else:
                item['NetworkSettings']['Networks']['foreign-network'] = {}
            with self.subTest(change=change), self.assertRaises(phase.Refused):
                self.snapshot_with(items)

    def test_snapshot_refuses_database_publication_or_changed_volumes(self):
        for name in phase.DATABASES:
            for change in ('published', 'foreign-volume', 'wrong-destination', 'readonly', 'missing'):
                items = runtime()
                item = next(i for i in items if i['Config']['Labels']['com.docker.compose.service'] == name)
                if change == 'published':
                    item['HostConfig']['PortBindings'] = {'5432/tcp': [{'HostIp': '0.0.0.0', 'HostPort': '5432'}]}
                elif change == 'foreign-volume':
                    item['Mounts'][0]['Name'] = 'legacy-data'
                elif change == 'wrong-destination':
                    item['Mounts'][0]['Destination'] = '/wrong'
                elif change == 'readonly':
                    item['Mounts'][0]['RW'] = False
                else:
                    item['Mounts'] = []
                with self.subTest(service=name, change=change), self.assertRaises(phase.Refused):
                    self.snapshot_with(items)

    def test_snapshot_refuses_changed_application_binding_ports_and_mounts(self):
        for index in (0, 1):
            for change in ('port', 'mount', 'working-dir', 'compose-files'):
                items = runtime()
                item = items[index]
                if change == 'port':
                    next(iter(item['HostConfig']['PortBindings'].values()))[0]['HostIp'] = '0.0.0.0'
                elif change == 'mount':
                    item['Mounts'] = [{'Type': 'bind', 'Source': '/tmp', 'Destination': '/app'}]
                else:
                    label = 'com.docker.compose.project.' + ('working_dir' if change == 'working-dir' else 'config_files')
                    item['Config']['Labels'][label] = '/wrong'
                with self.subTest(index=index, change=change), self.assertRaises(phase.Refused):
                    self.snapshot_with(items)

    def test_snapshot_refuses_foreign_volume_owner_driver_options_or_consumers(self):
        mutations = (lambda m: m.update(Driver='nfs'),
                     lambda m: m.update(Options={'device': '/legacy'}),
                     lambda m: m.update(Labels={'com.docker.compose.project': 'legacy'}))
        for mutate in mutations:
            with self.subTest(change=mutate), self.assertRaises(phase.Refused):
                self.snapshot_with(runtime(), metadata_change=mutate)
        for consumers in (b'legacy-postgres', b'native-postgres legacy-postgres', b''):
            with self.subTest(consumers=consumers), self.assertRaises(phase.Refused):
                self.snapshot_with(runtime(), consumers=consumers)

    def test_model_guard_accepts_exact_public_closed_contract(self):
        phase.model_guard(effective_model(), live_state())

    def test_model_guard_rejects_project_services_images_and_public_flags(self):
        for change in ('project', 'service', 'image', 'pull', 'signup', 'origin', 'correlation'):
            model = effective_model()
            backend = model['services']['backend']
            if change == 'project':
                model['name'] = 'legacy'
            elif change == 'service':
                model['services']['new-service'] = {}
            elif change == 'image':
                backend['image'] = 'moving-tag:latest'
            elif change == 'pull':
                backend['pull_policy'] = 'always'
            elif change == 'signup':
                backend['environment']['DISABLE_SIGNUP'] = 'false'
            elif change == 'origin':
                backend['environment']['BASE_URL'] = 'https://foreign.example'
            else:
                backend['environment']['WOTCV_REPLAY_CORRELATION_JSON'] = '{}'
            with self.subTest(change=change), self.assertRaises(phase.Refused):
                phase.model_guard(model, live_state())

    def test_model_guard_rejects_all_native_signup_origin_and_correlation_flag_drift(self):
        keys = {'backend': ('BASE_URL', 'SERVER_URL', 'CLOUD', 'DISABLE_SIGNUP',
                            'DISABLE_TELEMETRY', 'CLUSTER_WORKERS'),
                'client': ('NEXT_PUBLIC_BACKEND_URL', 'NEXT_PUBLIC_CLOUD', 'NEXT_PUBLIC_DISABLE_SIGNUP')}
        for name, flags in keys.items():
            for flag in flags:
                model = effective_model()
                del model['services'][name]['environment'][flag]
                with self.subTest(name=name, flag=flag), self.assertRaises(phase.Refused):
                    phase.model_guard(model, live_state())
        for value in ('[]', 'null', '{}', '"profile"', 'invalid-json'):
            model = effective_model()
            model['services']['backend']['environment']['WOTCV_REPLAY_CORRELATION_JSON'] = value
            with self.subTest(value=value), self.assertRaises((phase.Refused, ValueError)):
                phase.model_guard(model, live_state())

    def test_live_model_verification_rejects_credentials_restart_and_logging_drift(self):
        model = effective_model()
        items = runtime()
        for item in items:
            name = item['Config']['Labels']['com.docker.compose.service']
            expected = model['services'][name]
            expected['restart'] = 'unless-stopped'
            expected['logging'] = {'driver': 'json-file', 'options': {'max-size': '50m', 'max-file': '5'}}
            item['Config']['Env'] = [key + '=' + value for key, value in expected['environment'].items()]
            item['HostConfig']['RestartPolicy'] = {'Name': 'unless-stopped'}
            item['HostConfig']['LogConfig'] = {'Type': 'json-file', 'Config': expected['logging']['options']}
        with patch.object(phase, 'docker', return_value=json.dumps(items).encode()):
            phase.verify_model_live(model, live_state())
        for change in ('credential', 'restart', 'logging'):
            actual = deepcopy(items)
            if change == 'credential':
                actual[0]['Config']['Env'] = ['DATABASE_URL=postgres://wrong']
            elif change == 'restart':
                actual[0]['HostConfig']['RestartPolicy']['Name'] = 'always'
            else:
                actual[0]['HostConfig']['LogConfig']['Config']['max-size'] = '1g'
            with self.subTest(change=change), \
                    patch.object(phase, 'docker', return_value=json.dumps(actual).encode()), \
                    self.assertRaises(phase.Refused):
                phase.verify_model_live(model, live_state())

    def test_readiness_requires_closed_signup_and_local_and_public_html(self):
        good = [b'OK\n', b'<html>local login</html>', b'{"disableSignup":true}',
                b'<html>public login</html>', b'a' * 1001, b'b' * 1001, b'c' * 1001]
        with patch.object(phase, 'probe', side_effect=good) as probe:
            phase.readiness()
            self.assertEqual(probe.call_args_list[0].args, ('http://127.0.0.1:13001/api/health',))
        for index, value in ((0, b'FAILED'), (1, b'nginx error'),
                             (2, b'{"disableSignup":false}'), (2, b'[]'), (3, b'error'),
                             (4, b'missing'), (5, b'missing'), (6, b'missing')):
            responses = list(good)
            responses[index] = value
            with self.subTest(index=index, value=value), \
                    patch.object(phase, 'probe', side_effect=responses), self.assertRaises(phase.Refused):
                phase.readiness()

    def test_image_verification_uses_immutable_ids_and_networkless_entrypoint_checks(self):
        info = lambda identity: {'Id': identity, 'Config': {'Labels': {'org.opencontainers.image.revision': REVISION}}}
        with patch.object(phase, 'image_info', side_effect=info), patch.object(phase, 'docker') as docker:
            phase.verify_images(NEW_IMAGES, REVISION)
            self.assertEqual(docker.call_count, 2)
            for call in docker.call_args_list:
                self.assertEqual(call.args[:7], ('run', '--rm', '--network', 'none', '--entrypoint', 'node',
                                                 NEW_IMAGES['backend'] if call == docker.call_args_list[0] else NEW_IMAGES['client']))
        with patch.object(phase, 'docker') as docker:
            with self.assertRaises(phase.Refused):
                phase.image_info('latest:mutable')
            docker.assert_not_called()

    def test_asset_normalization_derives_from_exact_image_offline_and_records_tool_provenance(self):
        original = NEW_IMAGES['backend']
        derived = 'sha256:' + 'd' * 64
        base_tag = 'wotcv-rybbit-native:' + REVISION + '-backend-1234abcd'
        base = {'Id': original, 'RootFS': {'Layers': ['sha256:base-layer']}}
        final = {'Id': derived, 'RootFS': {'Layers': ['sha256:base-layer', 'sha256:asset-layer']}}
        source = self.root / 'source'
        source.mkdir()
        with patch.object(phase, 'docker', side_effect=[json.dumps([base]).encode(), b'',
                          json.dumps([final]).encode(), json.dumps([base]).encode()]) as docker:
            log = io.BytesIO()
            actual = phase.normalize_assets(original, base_tag, source, log)
        self.assertEqual(actual, derived)
        before, build, inspect, after = docker.call_args_list
        self.assertEqual(build.args, ('build', '--pull=false', '--network', 'none', '-f', '-', '-t', base_tag + '-assets', '.'))
        self.assertEqual(build.kwargs['cwd'], source)
        self.assertIs(build.kwargs['log'], log)
        self.assertEqual(build.kwargs['timeout'], 180)
        lines = build.kwargs['data'].decode().splitlines()
        self.assertEqual(lines[0], 'FROM ' + base_tag)
        self.assertEqual(lines[1], 'LABEL wotcv.native.assets="regenerated-from-built-js"')
        self.assertEqual(lines[2], 'LABEL wotcv.native.updater-sha256="' + phase.digest(SCRIPT) + '"')
        command = json.loads(lines[3].removeprefix('RUN '))
        self.assertEqual(command[:2], ['node', '-e'])
        js = command[2]
        for text in ("require('zlib')", "['script.js','rrweb.min.js','web-vitals.iife.js']",
                     "'/app/public/'", "p+'.gz'", 'z.gzipSync', "p+'.br'", 'z.brotliCompressSync'):
            self.assertIn(text, js)
        self.assertEqual(len(lines), 4)
        self.assertEqual(before.args, ('image', 'inspect', base_tag))
        self.assertEqual(after.args, before.args)
        self.assertEqual(inspect.args, ('image', 'inspect', base_tag + '-assets'))
        self.assertEqual(list(source.iterdir()), [])

    def test_asset_normalization_refuses_unpinned_input_before_docker(self):
        for identity in ('backend:latest', 'sha256:abc', 'a' * 64, 'sha256:' + 'G' * 64):
            with self.subTest(identity=identity), patch.object(phase, 'docker') as docker:
                with self.assertRaises(phase.Refused):
                    phase.normalize_assets(identity, 'offline:normalized', self.root, io.BytesIO())
                docker.assert_not_called()

    def test_asset_normalization_refuses_unscoped_or_moving_base_tags(self):
        for tag in ('backend:latest', 'wotcv-rybbit-native:latest',
                    'wotcv-rybbit-native:' + REVISION + '-client-1234abcd',
                    'wotcv-rybbit-native:' + REVISION + '-backend-ABCDEF12'):
            with self.subTest(tag=tag), patch.object(phase, 'docker') as docker:
                with self.assertRaises(phase.Refused):
                    phase.normalize_assets(NEW_IMAGES['backend'], tag, self.root, io.BytesIO())
                docker.assert_not_called()

    def test_asset_normalization_refuses_base_tag_identity_drift_and_unrelated_layer_lineage(self):
        identity = NEW_IMAGES['backend']
        tag = 'wotcv-rybbit-native:' + REVISION + '-backend-1234abcd'
        base = {'Id': identity, 'RootFS': {'Layers': ['base-layer']}}
        final = {'Id': 'sha256:' + 'd' * 64, 'RootFS': {'Layers': ['base-layer', 'asset-layer']}}
        wrong = {'Id': NEW_IMAGES['client'], 'RootFS': {'Layers': ['other-layer']}}
        variants = ([json.dumps([wrong]).encode()],
                    [json.dumps([base]).encode(), b'', json.dumps([final]).encode(), json.dumps([wrong]).encode()],
                    [json.dumps([base]).encode(), b'', json.dumps([wrong]).encode(), json.dumps([base]).encode()])
        for responses in variants:
            with self.subTest(responses=len(responses)), patch.object(phase, 'docker', side_effect=responses), \
                    self.assertRaises(phase.Refused):
                phase.normalize_assets(identity, tag, self.root, io.BytesIO())

    def test_build_images_normalizes_only_backend_and_pins_client_lite_flag(self):
        bundle = self.root / 'release.1234abcd'
        bundle.mkdir()
        def docker(*args, **kwargs):
            if args[0] == 'build':
                return b''
            self.assertEqual(args[:2], ('image', 'inspect'))
            return json.dumps([{'Id': NEW_IMAGES['backend' if '-backend-' in args[2] else 'client']}]).encode()
        derived = 'sha256:' + 'd' * 64
        with patch.object(phase, 'docker', side_effect=docker) as calls, \
                patch.object(phase, 'normalize_assets', return_value=derived) as normalize:
            actual = phase.build_images(bundle, REVISION)
        self.assertEqual(actual, {'backend': derived, 'client': NEW_IMAGES['client']})
        normalize.assert_called_once()
        self.assertEqual(normalize.call_args.args[:3], (NEW_IMAGES['backend'],
                         'wotcv-rybbit-native:' + REVISION + '-backend-1234abcd', bundle / 'source'))
        builds = [call for call in calls.call_args_list if call.args[0] == 'build']
        self.assertEqual(len(builds), 2)
        self.assertIn('NEXT_PUBLIC_LITE_DASHBOARD=false', builds[1].args)
        for call in builds:
            self.assertIn('org.opencontainers.image.revision=' + REVISION, call.args)

    def test_infrastructure_guard_checks_ids_images_mounts_restarts_and_started_time(self):
        before = live_state()
        for name in phase.DATABASES:
            for key in before[name]:
                after = deepcopy(before)
                after[name][key] = 'changed'
                with self.subTest(service=name, key=key), self.assertRaises(phase.Refused):
                    phase.infrastructure_unchanged(before, after)
        after = deepcopy(before)
        after['client']['image'] = NEW_IMAGES['client']
        phase.infrastructure_unchanged(before, after)

    def test_apply_and_install_require_root_and_exact_ack_before_io(self):
        for operation in (phase.apply, phase.install):
            for uid, ack in ((1000, phase.ACK), (0, None), (0, 'wrong')):
                with self.subTest(operation=operation.__name__, uid=uid, ack=ack):
                    with patch.object(phase.os, 'geteuid', return_value=uid, create=True), \
                            patch.object(phase, 'load_plan') as load:
                        with self.assertRaises(phase.Refused):
                            operation(self.root / 'bundle', ack)
                        load.assert_not_called()

    def test_install_refuses_overwriting_existing_native_tool(self):
        installed = self.root / 'installed.py'
        installed.write_bytes(b'previous installed tool')
        with patch.object(phase, 'INSTALLED', installed), patch.object(phase, 'load_plan'), \
                self.assertRaises(phase.Refused):
            phase.install(self.root / 'candidate', phase.ACK)
        self.assertEqual(installed.read_bytes(), b'previous installed tool')

    def test_update_cli_refuses_nonroot_before_locks_or_preparation(self):
        with patch('sys.argv', ['update.py', 'update']), \
                patch.object(phase.os, 'geteuid', return_value=1000, create=True), \
                patch.object(phase, 'locked') as locked, patch.object(phase, 'prepare') as prepare:
            with self.assertRaises(phase.Refused):
                phase.main()
            locked.assert_not_called()
            prepare.assert_not_called()

    def test_update_cli_pending_transaction_prevents_fetch_or_rebuild(self):
        (self.root / 'pending.json').write_text('{}')
        with patch('sys.argv', ['update.py', 'update']), patch.object(phase, 'STATE', self.root), \
                patch.object(phase, 'locked', return_value=nullcontext()), \
                patch.object(phase, 'prepare') as prepare, patch.object(phase, 'apply') as apply:
            with self.assertRaises(phase.Refused):
                phase.main()
            prepare.assert_not_called()
            apply.assert_not_called()

    def test_wait_ready_retries_wrong_image_but_returns_verified_runtime(self):
        wrong = live_state()
        good = deepcopy(wrong)
        for name in NEW_IMAGES:
            good[name]['image'] = NEW_IMAGES[name]
        with patch.object(phase, 'snapshot', side_effect=[wrong, good]), \
                patch.object(phase, 'readiness') as readiness, \
                patch.object(phase.time, 'sleep') as sleep:
            self.assertEqual(phase.wait_ready(NEW_IMAGES), good)
            readiness.assert_called_once_with()
            sleep.assert_called_once_with(2)

    def test_wait_ready_is_bounded_on_persistent_failures(self):
        with patch.object(phase, 'snapshot', side_effect=phase.Refused('not ready')) as snapshot, \
                patch.object(phase.time, 'sleep') as sleep, self.assertRaises(phase.Refused):
            phase.wait_ready(NEW_IMAGES)
        self.assertEqual(snapshot.call_count, 60)
        self.assertEqual(sleep.call_count, 60)

    def application_fixture(self):
        state = self.root / 'state'
        bundle = self.root / 'candidate'
        old_env = self.root / 'production.env'
        old_env.write_bytes(ENV)
        before = live_state()
        after = deepcopy(before)
        for name in NEW_IMAGES:
            after[name]['image'] = NEW_IMAGES[name]
            after[name]['id'] = 'updated-' + name
        plan = {'before': before, 'images': NEW_IMAGES, 'sha': REVISION}
        nginx = self.root / 'nginx.conf'
        nginx.write_text('offline nginx fixture')
        plan['nginxSha256'] = phase.digest(nginx)
        self.stack.enter_context(patch.object(phase, 'NGINX', nginx))
        self.stack.enter_context(patch.object(phase, 'STATE', state))
        self.stack.enter_context(patch.object(phase.os, 'geteuid', return_value=0, create=True))
        self.stack.enter_context(patch.object(phase, 'load_plan', return_value=plan))
        self.stack.enter_context(patch.object(phase, 'snapshot', return_value=deepcopy(before)))
        self.stack.enter_context(patch.object(phase, 'current_env', return_value=old_env))
        self.stack.enter_context(patch.object(phase, 'private'))
        self.stack.enter_context(patch.object(phase, 'readiness'))
        self.stack.enter_context(patch.object(phase, 'verify_model_live'))
        self.stack.enter_context(patch.object(phase, 'receipt_guard'))
        # Local Windows has no Unix uid/private chmod semantics. Emulate only
        # the root-owned transaction-state stat; retain actual filesystem I/O.
        original_stat = Path.stat
        def state_stat(path, *args, **kwargs):
            value = original_stat(path, *args, **kwargs)
            if path == state:
                return SimpleNamespace(st_mode=stat.S_IFDIR | 0o700, st_uid=0)
            return value
        self.stack.enter_context(patch.object(Path, 'stat', state_stat))
        def local_write(path, value):
            self.assertTrue(path.is_relative_to(self.root))
            if isinstance(value, str):
                value = value.encode()
            with path.open('xb') as handle:
                handle.write(value)
        self.stack.enter_context(patch.object(phase, 'write', side_effect=local_write))
        model = effective_model()
        changed = deepcopy(model)
        for name in NEW_IMAGES:
            changed['services'][name]['image'] = NEW_IMAGES[name]
        changed['services']['backend']['environment']['SOURCE_CODE_URL'] = phase.REMOTE + '/tree/' + REVISION
        config = self.stack.enter_context(patch.object(phase, 'config', side_effect=[model, changed]))
        compose = self.stack.enter_context(patch.object(phase, 'compose', return_value=b''))
        wait = self.stack.enter_context(patch.object(phase, 'wait_ready', return_value=after))
        return SimpleNamespace(state=state, bundle=bundle, before=before, after=after,
                               old_env=old_env, plan=plan, compose=compose, wait=wait, config=config)

    def assert_app_only(self, call):
        self.assertEqual(call.args[1:], ('up', '-d', '--no-deps', '--no-build', '--pull', 'never',
                                        'backend', 'client'))

    def test_apply_changes_only_apps_preserves_credentials_and_writes_verified_receipts(self):
        f = self.application_fixture()
        phase.apply(f.bundle, phase.ACK)
        f.compose.assert_called_once()
        self.assert_app_only(f.compose.call_args)
        transaction = f.state / f.bundle.name
        self.assertEqual((transaction / 'previous.env').read_bytes(), ENV)
        self.assertEqual((transaction / 'deployment.env').read_text(), phase.app_env(ENV, NEW_IMAGES, REVISION))
        active = json.loads((f.state / 'active.json').read_text())
        self.assertEqual(active['runtime'], f.after)
        self.assertEqual(active['envSha256'], phase.digest(transaction / 'deployment.env'))
        self.assertFalse((f.state / 'pending.json').exists())
        self.assertTrue((transaction / 'completed-pending.json').is_file())

    def install_fixture(self):
        f = self.application_fixture()
        f.bundle.mkdir()
        (f.bundle / 'plan.json').write_text(json.dumps(f.plan))
        f.wrapper = self.root / 'update.sh'
        f.wrapper.write_bytes(b'original operator wrapper\n')
        f.installed = self.root / 'tool' / 'update.py'
        self.stack.enter_context(patch.object(phase, 'WRAPPER', f.wrapper))
        self.stack.enter_context(patch.object(phase, 'INSTALLED', f.installed))
        original_stat = Path.stat
        def installed_stat(path, *args, **kwargs):
            value = original_stat(path, *args, **kwargs)
            if path == f.wrapper:
                return SimpleNamespace(st_mode=stat.S_IFREG | 0o755, st_uid=0)
            if path == f.installed.parent:
                return SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_uid=0)
            return value
        self.stack.enter_context(patch.object(Path, 'stat', installed_stat))
        self.stack.enter_context(patch.object(phase, 'run', return_value=b''))
        return f

    def test_install_verifies_application_before_writing_tool_or_replacing_wrapper(self):
        f = self.install_fixture()
        def verified_apply(bundle, ack):
            self.assertEqual(bundle, f.bundle)
            self.assertEqual(ack, phase.ACK)
            self.assertFalse(f.installed.exists())
            self.assertEqual(f.wrapper.read_bytes(), b'original operator wrapper\n')
            self.assertEqual((f.state / 'legacy-wrapper.backup.sh').read_bytes(), f.wrapper.read_bytes())
        with patch.object(phase, 'apply', side_effect=verified_apply) as apply:
            phase.install(f.bundle, phase.ACK)
        apply.assert_called_once_with(f.bundle, phase.ACK)
        self.assertEqual(f.installed.read_bytes(), SCRIPT.read_bytes())
        self.assertIn(b'/usr/bin/python3 -I /usr/local/lib/wotcv-rybbit-native/update.py update', f.wrapper.read_bytes())

    def test_failed_first_activation_leaves_original_operator_wrapper_and_no_installed_tool(self):
        f = self.install_fixture()
        with patch.object(phase, 'apply', side_effect=phase.Refused('offline activation failure')):
            with self.assertRaises(phase.Refused):
                phase.install(f.bundle, phase.ACK)
        self.assertEqual(f.wrapper.read_bytes(), b'original operator wrapper\n')
        self.assertFalse(f.installed.exists())
        self.assertEqual((f.state / 'legacy-wrapper.backup.sh').read_bytes(), f.wrapper.read_bytes())

    def test_apply_refuses_pending_transaction_before_runtime_or_compose(self):
        f = self.application_fixture()
        f.state.mkdir()
        (f.state / 'pending.json').write_text('{}')
        with self.assertRaises(phase.Refused):
            phase.apply(f.bundle, phase.ACK)
        f.compose.assert_not_called()
        phase.snapshot.assert_not_called()

    def test_apply_refuses_runtime_drift_before_transaction(self):
        f = self.application_fixture()
        phase.snapshot.return_value['postgres']['restarts'] = 1
        with self.assertRaises(phase.Refused):
            phase.apply(f.bundle, phase.ACK)
        f.compose.assert_not_called()
        self.assertFalse(f.state.exists())

    def test_apply_refuses_extra_candidate_configuration_change(self):
        f = self.application_fixture()
        old, new = list(f.config.side_effect)
        new['services']['backend']['environment']['DATABASE_URL'] = 'postgres://changed'
        f.config.side_effect = [old, new]
        with self.assertRaises(phase.Refused):
            phase.apply(f.bundle, phase.ACK)
        f.compose.assert_not_called()
        self.assertFalse((f.state / 'pending.json').exists())

    def test_activation_failure_rolls_back_only_apps_and_keeps_pending(self):
        f = self.application_fixture()
        f.wait.side_effect = [phase.Refused('offline activation failure'), f.before]
        with self.assertRaises(phase.Refused):
            phase.apply(f.bundle, phase.ACK)
        self.assertEqual(f.compose.call_count, 2)
        for call in f.compose.call_args_list:
            self.assert_app_only(call)
        self.assertEqual(f.compose.call_args_list[1].args[0], f.state / f.bundle.name / 'previous.env')
        self.assertTrue((f.state / 'pending.json').is_file())
        failure = json.loads((f.state / f.bundle.name / 'failure.json').read_text())
        self.assertEqual(failure['phase'], 'application-images-restored')
        self.assertFalse((f.state / 'active.json').exists())

    def test_failed_rollback_keeps_pending_and_explicit_failure_receipt(self):
        f = self.application_fixture()
        f.compose.side_effect = phase.Refused('offline compose failure')
        with self.assertRaises(phase.Refused):
            phase.apply(f.bundle, phase.ACK)
        self.assertEqual(f.compose.call_count, 2)
        failure = json.loads((f.state / f.bundle.name / 'failure.json').read_text())
        self.assertEqual(failure['phase'], 'rollback-incomplete-manual-inspection-required')
        self.assertTrue((f.state / 'pending.json').is_file())

    def test_database_drift_after_activation_prevents_active_receipt(self):
        f = self.application_fixture()
        drifted = deepcopy(f.after)
        drifted['postgres']['id'] = 'recreated-db'
        f.wait.side_effect = [drifted, f.before]
        with self.assertRaises(phase.Refused):
            phase.apply(f.bundle, phase.ACK)
        self.assertTrue((f.state / 'pending.json').is_file())
        self.assertFalse((f.state / 'active.json').exists())

    def test_current_env_rejects_modified_receipt_digest(self):
        state = self.root / 'state'
        release = state / 'release'
        release.mkdir(parents=True)
        environment = release / 'deployment.env'
        environment.write_bytes(ENV)
        (state / 'active.json').write_text(json.dumps({'release': 'release', 'envSha256': 'wrong'}))
        with patch.object(phase, 'STATE', state), patch.object(phase, 'private'):
            with self.assertRaises(phase.Refused):
                phase.current_env()

    def test_original_promotion_receipt_guards_database_ids_and_every_image(self):
        live = live_state()
        receipt = {'dbIds': {name: live[name]['id'] for name in phase.DATABASES},
                   'images': {name: live[name]['image'] for name in phase.SERVICES}}
        (self.root / 'cutover-public-ready.json').write_text(json.dumps(receipt))
        with patch.object(phase, 'ROOT', self.root), patch.object(phase, 'STATE', self.root / 'state'):
            phase.receipt_guard(live)
            for name in phase.SERVICES:
                changed = deepcopy(live)
                changed[name]['image'] = 'sha256:' + 'f' * 64
                with self.subTest(name=name, change='image'), self.assertRaises(phase.Refused):
                    phase.receipt_guard(changed)
            for name in phase.DATABASES:
                changed = deepcopy(live)
                changed[name]['id'] = 'foreign-db'
                with self.subTest(name=name, change='id'), self.assertRaises(phase.Refused):
                    phase.receipt_guard(changed)

    def test_active_receipt_guards_database_state_and_application_images(self):
        live = live_state()
        receipt = {'phase': 'active', 'runtime': live,
                   'images': {name: live[name]['image'] for name in ('backend', 'client')}}
        (self.root / 'active.json').write_text(json.dumps(receipt))
        with patch.object(phase, 'STATE', self.root):
            phase.receipt_guard(live)
            for name in phase.DATABASES:
                changed = deepcopy(live)
                changed[name]['mounts'] = []
                with self.subTest(name=name), self.assertRaises(phase.Refused):
                    phase.receipt_guard(changed)
            for name in ('backend', 'client'):
                changed = deepcopy(live)
                changed[name]['image'] = NEW_IMAGES[name]
                with self.subTest(name=name), self.assertRaises(phase.Refused):
                    phase.receipt_guard(changed)
            receipt['phase'] = 'activating'
            (self.root / 'active.json').write_text(json.dumps(receipt))
            with self.assertRaises(phase.Refused):
                phase.receipt_guard(live)


if __name__ == '__main__':
    unittest.main()
