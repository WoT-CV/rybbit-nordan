#!/usr/bin/env python3
"""Native app-only updater. Never opens legacy data or mutates the sealed bootstrap.

prepare builds an exact published commit without starting applications. install
and update require an operator's sudo. This first updater intentionally accepts
only frontend/static-asset changes: server code, dependencies and DB contracts
must remain byte-identical to the native bootstrap. Image rollback is NOT a DB
restore. No database deletion, Docker prune, nginx edit or git checkout exists.
"""
import argparse
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request

ROOT = Path('/home/wotcv/rybbit-fresh-20261102.qYlV3CsP')
REPO = Path('/home/rybbit-wotcv')
PROJECT = 'rybbit-wotcv-native'
BASELINE = '58220f65648d91bbb56699233e8e90db82ced302'
REMOTE = 'https://github.com/WoT-CV/rybbit-wotcv'
PUBLIC = 'https://tracking.wot-cv.com'
STATE = Path('/var/lib/wotcv-rybbit-native')
INSTALLED = Path('/usr/local/lib/wotcv-rybbit-native/update.py')
WRAPPER = Path('/home/wotcv/tools/update_rybbit_wotcv.sh')
NGINX = Path('/etc/nginx/sites-available/tracking.wot-cv.com')
DOCKER = ['/usr/bin/docker', '--host', 'unix:///var/run/docker.sock']
SERVICES = ('backend', 'client', 'postgres', 'clickhouse', 'redis')
DATABASES = {'postgres': '/var/lib/postgresql/data', 'clickhouse': '/var/lib/clickhouse', 'redis': '/data'}
SHA = re.compile(r'[0-9a-f]{40}\Z')
IMAGE = re.compile(r'sha256:[0-9a-f]{64}\Z')
ACK = 'update-native-apps-preserve-data'


class Refused(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise Refused(message)


def safe_env():
    return {'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
            'HOME': '/home/wotcv', 'LANG': 'C.UTF-8'}


def run(args, *, cwd=None, timeout=60, log=None, data=None):
    try:
        result = subprocess.run([str(a) for a in args], cwd=cwd, env=safe_env(),
                                input=data,
                                stdout=log or subprocess.PIPE, stderr=log or subprocess.PIPE,
                                timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise Refused('Command unavailable or timed out; inspect private transaction log') from None
    require(result.returncode == 0, 'Command failed; private details withheld; inspect transaction log')
    return result.stdout or b''


def docker(*args, **kwargs):
    return run([*DOCKER, *args], **kwargs)


def git(*args):
    command = ['/usr/bin/git', '-C', str(REPO), *args]
    if os.geteuid() == 0:
        command = ['/usr/sbin/runuser', '-u', 'wotcv', '--', *command]
    return run(command, timeout=180)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write(path, data):
    if isinstance(data, str):
        data = data.encode()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())


def record(path, value):
    temporary = path.with_name('.' + path.name + '-' + secrets.token_hex(6))
    write(temporary, json.dumps(value, indent=2) + '\n')
    os.replace(temporary, path)


def private(path):
    require(path.is_file() and not path.is_symlink() and path.stat().st_mode & 0o077 == 0,
            'Expected a private regular file')


def source_hashes(source):
    require(source.is_dir() and not source.is_symlink(), 'Missing canonical source')
    result = {}
    for path in source.rglob('*'):
        require(not path.is_symlink(), 'Symlinks are not supported')
        if path.is_file():
            result[path.relative_to(source).as_posix()] = digest(path)
    return result


def guarded(name):
    # Conservative by design: no new backend logic/dependency/DDL can enter this
    # app-only update path. Compressed checked-in public assets are the exception.
    return (name.startswith(('server/', 'shared/', 'clickhouse/')) and not
            (name.startswith('server/public/') and name.endswith(('.gz', '.br')))) or name in (
                'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
                'client/package.json', 'client/Dockerfile', 'docker-compose.yml', '.dockerignore')


def source_guard(candidate):
    original = source_hashes(ROOT / 'source')
    if os.geteuid() == 0:
        state = json.loads((ROOT / 'state.json').read_text())
        require(state['source'] == BASELINE and state['project'] == PROJECT and
                original == state['sourceFiles'], 'Sealed bootstrap source changed')
    else:
        # Original receipts are root-only. Do not bypass that permission during
        # user-level preparation: compare the frozen executable contract to the
        # original published Git archive; root additionally checks the full seal.
        with tarfile.open(fileobj=io.BytesIO(git('archive', '--format=tar', BASELINE))) as archive:
            approved = {m.name: hashlib.sha256(archive.extractfile(m).read()).hexdigest()
                        for m in archive.getmembers() if m.isfile() and guarded(m.name)}
        require({k: v for k, v in original.items() if guarded(k)} == approved,
                'Original native executable contract differs from published baseline')
    approved = {k: v for k, v in original.items() if guarded(k)}
    actual = {k: v for k, v in source_hashes(candidate).items() if guarded(k)}
    require(actual == approved,
            'Backend/dependency/database/Compose contract changed; separate reviewed migration required')


def unpack(data, target):
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        for member in archive.getmembers():
            path = PurePosixPath(member.name)
            require(not path.is_absolute() and '..' not in path.parts and '\\' not in member.name and
                    (member.isfile() or member.isdir()), 'Unsupported Git archive member')
        archive.extractall(target, filter='data')


def image_info(identity):
    require(IMAGE.fullmatch(identity), 'Image must be a local immutable sha256 ID')
    return json.loads(docker('image', 'inspect', identity))[0]


def snapshot():
    ids = docker('ps', '-aq', '--filter', 'label=com.docker.compose.project=' + PROJECT).decode().split()
    require(len(ids) == 5, 'Expected exactly five native containers')
    # Kept in memory only; never print the inspect result or container environment.
    containers = json.loads(docker('inspect', *ids))
    result = {}
    for item in containers:
        labels = item['Config'].get('Labels') or {}
        name = labels.get('com.docker.compose.service')
        require(name in SERVICES and name not in result and labels.get('com.docker.compose.project') == PROJECT,
                'Unexpected native service ownership')
        require(item['State']['Status'] == 'running' and
                (name == 'client' or item['State'].get('Health', {}).get('Status') == 'healthy'),
                'Native service is not ready')
        require(set(item['NetworkSettings']['Networks']) == {PROJECT + '_default'}, 'Native network changed')
        ports = item['HostConfig'].get('PortBindings') or {}
        if name in DATABASES:
            require(not ports, 'Database must not publish host ports')
            mounts = item.get('Mounts', [])
            volumes = [m for m in mounts if m.get('Type') == 'volume']
            require(len(volumes) == 1 and volumes[0]['Name'] == PROJECT + '_' + name + '-data' and
                    volumes[0]['Destination'] == DATABASES[name] and volumes[0].get('RW'),
                    'Native database volume changed')
            volume_name = volumes[0]['Name']
            metadata = json.loads(docker('volume', 'inspect', volume_name))[0]
            require(metadata.get('Driver') == 'local' and not metadata.get('Options') and
                    metadata.get('Labels', {}).get('com.docker.compose.project') == PROJECT,
                    'Native physical volume ownership/driver changed')
            consumers = docker('ps', '-aq', '--filter', 'volume=' + volume_name).decode().split()
            require(len(consumers) == 1 and item['Id'].startswith(consumers[0]),
                    'Native database volume has another consumer')
        else:
            require(not item.get('Mounts'), 'Unexpected application mount')
            target, published = ('3001/tcp', '13001') if name == 'backend' else ('3002/tcp', '13002')
            require(ports == {target: [{'HostIp': '127.0.0.1', 'HostPort': published}]}, 'Application port changed')
            require(labels.get('com.docker.compose.project.working_dir') == str(ROOT / 'source') and
                    labels.get('com.docker.compose.project.config_files') ==
                    str(ROOT / 'source/docker-compose.yml') + ',' + str(ROOT / 'source/ops/minimal/compose.fresh.yml'),
                    'Application Compose binding changed')
        result[name] = {'id': item['Id'], 'image': item['Image'], 'mounts': item.get('Mounts', []),
                        'started': item['State']['StartedAt'], 'restarts': item['RestartCount']}
        if name in DATABASES:
            result[name]['volume'] = metadata
    return result


def compose(env, *args, timeout=60, log=None):
    source = ROOT / 'source'
    return docker('compose', '--project-name', PROJECT, '--project-directory', str(source),
                  '--env-file', str(env), '-f', str(source / 'docker-compose.yml'),
                  '-f', str(source / 'ops/minimal/compose.fresh.yml'), *args, timeout=timeout, log=log)


def config(env):
    return json.loads(compose(env, 'config', '--format', 'json'))


def model_guard(model, live):
    require(model.get('name') == PROJECT and set(model['services']) == set(SERVICES),
            'Unexpected effective Compose services/project')
    for name in SERVICES:
        service = model['services'][name]
        require(service['image'] == live[name]['image'] and IMAGE.fullmatch(service['image']) and
                service.get('pull_policy') == 'never', 'Configured and running images differ')
    backend = model['services']['backend']['environment']
    client = model['services']['client']['environment']
    require(backend.get('BASE_URL') == PUBLIC and backend.get('SERVER_URL') == PUBLIC and
            backend.get('CLOUD') == 'false' and backend.get('DISABLE_SIGNUP') == 'true' and
            backend.get('DISABLE_TELEMETRY') == 'true' and backend.get('CLUSTER_WORKERS') == '0' and
            client.get('NEXT_PUBLIC_BACKEND_URL') == PUBLIC and
            client.get('NEXT_PUBLIC_CLOUD') == 'false' and client.get('NEXT_PUBLIC_DISABLE_SIGNUP') == 'true',
            'Public origin, signup or native runtime contract changed')
    require(bool(json.loads(backend.get('WOTCV_REPLAY_CORRELATION_JSON', 'null'))) and
            isinstance(json.loads(backend.get('WOTCV_REPLAY_CORRELATION_JSON', 'null')), list),
            'Correlation profile missing')


def verify_model_live(model, live):
    items = json.loads(docker('inspect', *[live[name]['id'] for name in SERVICES]))
    for item in items:
        name = item['Config']['Labels']['com.docker.compose.service']
        expected = model['services'][name]
        actual = dict(entry.split('=', 1) for entry in item['Config']['Env'] if '=' in entry)
        require(all(actual.get(key) == value for key, value in expected.get('environment', {}).items()),
                'Actual runtime environment differs from effective configuration')
        require(item['HostConfig']['RestartPolicy']['Name'] == expected['restart'] and
                item['HostConfig']['LogConfig'] == {'Type': expected['logging']['driver'],
                                                    'Config': expected['logging']['options']},
                'Actual restart/logging contract differs')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def probe(url):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(url, timeout=10) as response:
        require(response.status == 200, 'HTTP readiness probe failed')
        return response.read(2_000_000)


def readiness():
    require(probe('http://127.0.0.1:13001/api/health').strip() == b'OK', 'Native backend health failed')
    require(b'<html' in probe('http://127.0.0.1:13002/login').lower(), 'Native login page unavailable')
    settings = json.loads(probe(PUBLIC + '/api/config'))
    # The exact config structure is checked in the existing public deployment;
    # the probe also prevents accepting an nginx/network error as readiness.
    require(isinstance(settings, dict) and settings.get('disableSignup') is True, 'Public API/signup config unavailable')
    require(b'<html' in probe(PUBLIC + '/login').lower(), 'Public native login unavailable')
    for asset in ('script.js', 'replay.js', 'metrics.js'):
        require(len(probe(PUBLIC + '/api/' + asset)) > 1000, 'Public tracker/replay asset unavailable')


@contextlib.contextmanager
def locked(root=False):
    import fcntl
    paths = [Path('/home/wotcv/.rybbit-wotcv-native-install.lock')]
    if root:
        paths.insert(0, Path('/run/lock/wotcv-deploy.lock'))
    with contextlib.ExitStack() as stack:
        for path in paths:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
            handle = stack.enter_context(os.fdopen(fd, 'a'))
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise Refused('Another deployment/installation holds the lock') from None
        yield


def build_images(bundle, sha):
    result = {}
    logpath = bundle / 'build.log'
    with os.fdopen(os.open(logpath, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as log:
        for name in ('backend', 'client'):
            tag = 'wotcv-rybbit-native:' + sha + '-' + name + '-' + bundle.name.rsplit('.', 1)[-1].lower()
            args = ['build', '--label', 'org.opencontainers.image.revision=' + sha,
                    '-f', ('server' if name == 'backend' else 'client') + '/Dockerfile', '-t', tag]
            if name == 'client':
                for key, value in {'NEXT_PUBLIC_BACKEND_URL': PUBLIC, 'NEXT_PUBLIC_DISABLE_SIGNUP': 'true',
                                   'NEXT_PUBLIC_CLOUD': 'false', 'NEXT_PUBLIC_DEPLOYMENT': '',
                                   'NEXT_PUBLIC_LITE_DASHBOARD': 'false'}.items():
                    args += ['--build-arg', key + '=' + value]
            print('Building ' + name + '; private log: ' + str(logpath), flush=True)
            docker(*args, '.', cwd=bundle / 'source', timeout=2400, log=log)
            identity = json.loads(docker('image', 'inspect', tag))[0]['Id']
            if name == 'backend':
                identity = normalize_assets(identity, tag, bundle / 'source', log)
            result[name] = identity
    return result


def normalize_assets(identity, base_tag, source, log):
    require(IMAGE.fullmatch(identity), 'Unpinned backend build result')
    require(re.fullmatch(r'wotcv-rybbit-native:[0-9a-f]{40}-backend-[0-9a-f]{8}', base_tag),
            'Unexpected private build tag')
    base = json.loads(docker('image', 'inspect', base_tag))[0]
    require(base['Id'] == identity, 'Backend build tag changed')
    # Native build regenerates script.js but upstream's Dockerfile does not
    # regenerate checked-in compression siblings. Normalize only generated
    # artifacts in a derived image; never change the sealed source or DB code.
    js = ("const f=require('fs'),z=require('zlib');"
          "for(const name of ['script.js','rrweb.min.js','web-vitals.iife.js']){"
          "const p='/app/public/'+name,b=f.readFileSync(p);"
          "f.writeFileSync(p+'.gz',z.gzipSync(b,{level:9}));"
          "f.writeFileSync(p+'.br',z.brotliCompressSync(b));}")
    # BuildKit resolves FROM sha256:<ID> as a registry tag, not an image ID.
    # Use the unique local tag, then prove exact base identity/layer lineage.
    dockerfile = ('FROM ' + base_tag + '\n' +
                  'LABEL wotcv.native.assets="regenerated-from-built-js"\n' +
                  'LABEL wotcv.native.updater-sha256="' + digest(Path(__file__)) + '"\n' +
                  'RUN ' + json.dumps(['node', '-e', js]) + '\n')
    tag = base_tag + '-assets'
    docker('build', '--pull=false', '--network', 'none', '-f', '-', '-t', tag, '.',
           cwd=source, timeout=180, log=log, data=dockerfile.encode())
    final = json.loads(docker('image', 'inspect', tag))[0]
    require(json.loads(docker('image', 'inspect', base_tag))[0]['Id'] == identity and
            final['RootFS']['Layers'][:len(base['RootFS']['Layers'])] == base['RootFS']['Layers'],
            'Generated-asset image no longer derives from the exact built backend')
    return final['Id']


def verify_images(images, sha):
    for name in ('backend', 'client'):
        info = image_info(images[name])
        require(info['Id'] == images[name] and
                info['Config'].get('Labels', {}).get('org.opencontainers.image.revision') == sha,
                'Built image revision mismatch')
    # No native entrypoint, network, DB mounts, credentials or migrations here.
    js = ("const f=require('fs');for(const p of ['/app/dist/cluster.js','/app/drizzle.config.ts'])f.accessSync(p);"
          "for(const p of ['pg','drizzle-kit','better-auth'])require.resolve(p);"
          "const z=require('zlib'),p=require('path');function scan(d){"
          "for(const e of f.readdirSync(d,{withFileTypes:true})){const s=p.join(d,e.name);"
          "if(e.isDirectory())scan(s);else if(/\\.(gz|br)$/.test(s)){"
          "const ext=p.extname(s),raw=f.readFileSync(s.slice(0,-ext.length));"
          "const dec=(ext==='.gz'?z.gunzipSync:z.brotliDecompressSync)(f.readFileSync(s));"
          "if(!raw.equals(dec))throw Error('Compressed static asset mismatch')}}}scan('/app/public')")
    docker('run', '--rm', '--network', 'none', '--entrypoint', 'node', images['backend'], '-e', js)
    client_js = ("const f=require('fs'),p=require('path');let n=0;function scan(d){"
                 "for(const e of f.readdirSync(d,{withFileTypes:true})){const s=p.join(d,e.name);"
                 "if(e.isDirectory())scan(s);else if(e.name.endsWith('.js')&&"
                 "f.readFileSync(s,'utf8').includes(process.argv[1]))n++}}"
                 "scan('/app/client/.next/static');if(!n)process.exit(3)")
    docker('run', '--rm', '--network', 'none', '--entrypoint', 'node', images['client'], '-e', client_js, PUBLIC)


def prepare(expected=None):
    require(git('remote', 'get-url', 'origin').decode().strip().removesuffix('.git') == REMOTE,
            'Unexpected Git origin')
    require(expected is None or SHA.fullmatch(expected), 'Expected SHA must be 40 lowercase hex characters')
    git('fetch', '--no-tags', 'origin', 'refs/heads/feat/wotcv')
    sha = git('rev-parse', 'FETCH_HEAD^{commit}').decode().strip()
    require(SHA.fullmatch(sha) and (not expected or sha == expected), 'Published branch SHA differs from expected')
    before = snapshot()
    bundle = Path('/home/wotcv') / ('rybbit-native-update-' + time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '.' + secrets.token_hex(4))
    bundle.mkdir(mode=0o700)
    source = bundle / 'source'
    source.mkdir(mode=0o700)
    unpack(git('archive', '--format=tar', sha), source)
    source_guard(source)
    images = build_images(bundle, sha)
    verify_images(images, sha)
    require(snapshot() == before, 'Runtime changed while building; candidate not approved')
    plan = {'version': 1, 'sha': sha, 'project': PROJECT, 'root': str(ROOT), 'before': before,
            'images': images, 'files': source_hashes(source), 'toolSha256': digest(Path(__file__)),
            'nginxSha256': digest(NGINX), 'phase': 'prepared'}
    record(bundle / 'plan.json', plan)
    print('PREPARED: ' + str(bundle) + '; SHA ' + sha + '. No application start, restart or migration.')
    return bundle


def load_plan(bundle):
    require(bundle.parent == Path('/home/wotcv') and
            re.fullmatch(r'rybbit-native-update-[0-9]{8}T[0-9]{6}Z\.[0-9a-f]{8}', bundle.name) and
            bundle.resolve() == bundle and not bundle.is_symlink() and bundle.stat().st_mode & 0o077 == 0,
            'Unexpected prepared release path')
    private(bundle / 'plan.json')
    plan = json.loads((bundle / 'plan.json').read_text())
    require(plan.get('version') == 1 and plan.get('phase') == 'prepared' and plan.get('project') == PROJECT and
            plan.get('root') == str(ROOT) and SHA.fullmatch(plan.get('sha', '')) and
            plan.get('toolSha256') == digest(Path(__file__)), 'Prepared plan/tool identity mismatch')
    require(plan['files'] == source_hashes(bundle / 'source'), 'Prepared source changed')
    source_guard(bundle / 'source')
    verify_images(plan['images'], plan['sha'])
    require(plan.get('nginxSha256') == digest(NGINX), 'Nginx changed since prepare')
    return plan


def current_env():
    active = STATE / 'active.json'
    if active.exists():
        private(active)
        state = json.loads(active.read_text())
        path = STATE / state['release'] / 'deployment.env'
        require(path.resolve() == path and path.parent.parent == STATE and
                digest(path) == state['envSha256'], 'Active native environment receipt mismatch')
        return path
    receipt = json.loads((ROOT / 'cutover-public-ready.json').read_text())
    attempt = json.loads((ROOT / 'cutover-promote-attempt.json').read_text())
    path = ROOT / 'production.env'
    require(receipt.get('phase') == 'public-ready' and attempt.get('phase') == 'promote-attempt' and
            receipt.get('images') == attempt.get('images') and receipt.get('dbIds') == attempt.get('dbIds') and
            digest(path) == attempt.get('envSha'), 'Original promotion environment changed')
    return path


def receipt_guard(live):
    active = STATE / 'active.json'
    if active.exists():
        state = json.loads(active.read_text())
        require(state.get('phase') == 'active', 'Active native receipt is incomplete')
        require(all(state['runtime'][name] == live[name] for name in DATABASES),
                'Database identities drifted from last successful update')
        require(all(state['images'][name] == live[name]['image'] for name in ('backend', 'client')),
                'Application image drifted from last successful update')
    else:
        receipt = json.loads((ROOT / 'cutover-public-ready.json').read_text())
        require(all(receipt['dbIds'][name] == live[name]['id'] for name in DATABASES) and
                all(receipt['images'][name] == live[name]['image'] for name in SERVICES),
                'Native runtime differs from promoted deployment')


def app_env(original, images, sha):
    # Preserve all credentials and correlation bytes; never source an env file.
    changes = {'WOTCV_BACKEND_IMAGE': images['backend'], 'WOTCV_CLIENT_IMAGE': images['client'],
               'SOURCE_CODE_URL': REMOTE + '/tree/' + sha}
    text = original.decode()
    for key, value in changes.items():
        pattern = re.compile(r'^' + key + r'=.*$', re.MULTILINE)
        require(len(pattern.findall(text)) == 1, 'Missing or duplicate image/source environment key')
        text = pattern.sub(key + "='" + value + "'", text)
    return text


def infrastructure_unchanged(before, after):
    require(all(before[name] == after[name] for name in DATABASES), 'Infrastructure identity/state changed')


def wait_ready(images):
    for _ in range(60):
        try:
            live = snapshot()
            require(all(live[name]['image'] == images[name] for name in ('backend', 'client')),
                    'Application image mismatch')
            require(all(live[name]['restarts'] == 0 for name in ('backend', 'client')),
                    'Application restarted during activation')
            readiness()
            return live
        except (Refused, urllib.error.URLError, TimeoutError, ValueError):
            time.sleep(2)
    raise Refused('Application readiness timed out')


def apply(bundle, ack):
    require(os.geteuid() == 0 and ack == ACK, 'Operator sudo and explicit native-update acknowledgment required')
    plan = load_plan(bundle)
    require(not (STATE / 'pending.json').exists(), 'Pending native transaction requires inspection; no automatic retry')
    before = snapshot()
    require(before == plan['before'], 'Runtime changed since prepare; prepare a new candidate')
    receipt_guard(before)
    old_env = current_env()
    private(old_env)
    old_model = config(old_env)
    model_guard(old_model, before)
    verify_model_live(old_model, before)
    readiness()
    STATE.mkdir(mode=0o700, exist_ok=True)
    require(not STATE.is_symlink() and STATE.stat().st_uid == 0 and STATE.stat().st_mode & 0o077 == 0,
            'Native updater state must be root-owned and private')
    transaction = STATE / bundle.name
    transaction.mkdir(mode=0o700)
    original = old_env.read_bytes()
    write(transaction / 'previous.env', original)
    candidate_env = transaction / 'deployment.env'
    write(candidate_env, app_env(original, plan['images'], plan['sha']))
    new_model = config(candidate_env)
    # The only allowed model differences are two image IDs and provenance URL.
    expected = json.loads(json.dumps(old_model))
    for name in ('backend', 'client'):
        expected['services'][name]['image'] = plan['images'][name]
    expected['services']['backend']['environment']['SOURCE_CODE_URL'] = REMOTE + '/tree/' + plan['sha']
    require(new_model == expected, 'Candidate changed runtime settings beyond application images/provenance')
    attempt = {'phase': 'activating', 'release': transaction.name, 'sha': plan['sha'],
               'before': before, 'previousEnv': str(old_env), 'images': plan['images']}
    record(STATE / 'pending.json', attempt)
    record(transaction / 'attempt.json', attempt)
    print('Activating only native backend/client; existing database containers and volumes are retained.', flush=True)
    logpath = transaction / 'activation.log'
    try:
        with os.fdopen(os.open(logpath, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as log:
            compose(candidate_env, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never',
                    'backend', 'client', timeout=240, log=log)
        after = wait_ready(plan['images'])
        infrastructure_unchanged(before, after)
        verify_model_live(new_model, after)
        require(digest(NGINX) == plan['nginxSha256'], 'Nginx changed during activation')
    except (Refused, OSError, ValueError, urllib.error.URLError):
        # Only application-image rollback: protected server/DDL bytes are equal.
        # No data restore is claimed. A persistent pending marker blocks retries.
        record(transaction / 'failure.json', {'phase': 'rollback-starting'})
        try:
            with os.fdopen(os.open(transaction / 'rollback.log', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as log:
                compose(transaction / 'previous.env', 'up', '-d', '--no-deps', '--no-build', '--pull', 'never',
                        'backend', 'client', timeout=240, log=log)
            restored = wait_ready({name: before[name]['image'] for name in ('backend', 'client')})
            infrastructure_unchanged(before, restored)
            verify_model_live(old_model, restored)
            record(transaction / 'failure.json', {'phase': 'application-images-restored', 'runtime': restored})
        except (Refused, OSError, ValueError, urllib.error.URLError):
            record(transaction / 'failure.json', {'phase': 'rollback-incomplete-manual-inspection-required'})
        raise Refused('Activation failed; inspect private transaction/rollback logs and pending marker before retry') from None
    receipt = {'phase': 'active', 'release': transaction.name, 'sha': plan['sha'], 'runtime': after,
               'envSha256': digest(candidate_env), 'previousEnv': str(old_env), 'images': plan['images']}
    record(transaction / 'success.json', receipt)
    record(STATE / 'active.json', receipt)
    # Keep completed attempt as history; only its active pending name is moved.
    os.replace(STATE / 'pending.json', transaction / 'completed-pending.json')
    print('UPDATED AND VERIFIED: ' + plan['sha'] + '; receipt: ' + str(transaction / 'success.json'))


def install(bundle, ack):
    require(os.geteuid() == 0 and ack == ACK, 'Operator sudo and acknowledgment required')
    load_plan(bundle)
    require(not INSTALLED.exists(), 'Native updater is already installed; inspect before replacing tooling')
    require(WRAPPER.is_file() and not WRAPPER.is_symlink() and WRAPPER.stat().st_uid == 0,
            'Unexpected existing root wrapper')
    # Finish nonmutating production preflight before replacing the old wrapper.
    live = snapshot()
    require(live == json.loads((bundle / 'plan.json').read_text())['before'], 'Runtime changed since prepare')
    receipt_guard(live)
    original_env = current_env()
    private(original_env)
    model = config(original_env)
    model_guard(model, live)
    verify_model_live(model, live)
    readiness()
    STATE.mkdir(mode=0o700, exist_ok=True)
    require(not STATE.is_symlink() and STATE.stat().st_uid == 0 and STATE.stat().st_mode & 0o077 == 0,
            'Native updater state must be root-owned and private')
    write(STATE / 'legacy-wrapper.backup.sh', WRAPPER.read_bytes())
    INSTALLED.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    require(not INSTALLED.parent.is_symlink() and INSTALLED.parent.stat().st_uid == 0 and
            INSTALLED.parent.stat().st_mode & 0o022 == 0, 'Unsafe installed tool directory')
    wrapper = ('#!/bin/bash\nset -Eeuo pipefail\n'
               'if (( EUID != 0 )); then echo "Run with sudo." >&2; exit 1; fi\n'
               'exec /usr/bin/python3 -I /usr/local/lib/wotcv-rybbit-native/update.py update "$@"\n')
    temp = WRAPPER.with_name('.update_rybbit_wotcv.sh.native-' + secrets.token_hex(4))
    write(temp, wrapper)
    os.chmod(temp, 0o755)
    run(['/bin/bash', '-n', str(temp)])
    # Do not replace the user's entrypoint until the exact prepared deployment
    # has passed activation verification. On failure only private transaction
    # evidence/backups remain; the original wrapper is still installed.
    print('Prepared exact native update; applying before switching the operator wrapper.', flush=True)
    apply(bundle, ack)
    write(INSTALLED, Path(__file__).read_bytes())
    os.chmod(INSTALLED, 0o644)
    os.replace(temp, WRAPPER)
    print('INSTALLED native updater; previous wrapper preserved. Future sudo wrapper runs target the native instance.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('prepare', 'check', 'install', 'update'))
    parser.add_argument('--expected-sha')
    parser.add_argument('--bundle', type=Path)
    parser.add_argument('--ack')
    args = parser.parse_args()
    if args.command == 'check':
        require(args.bundle is not None, '--bundle required')
        load_plan(args.bundle)
        require(snapshot() == json.loads((args.bundle / 'plan.json').read_text())['before'], 'Runtime changed')
        print('CHECK PASS: exact source, built images, native runtime unchanged. No startup/migration.')
        return
    root = args.command in ('install', 'update')
    require(not root or os.geteuid() == 0, 'Installation/update requires operator sudo')
    with locked(root=root):
        if args.command == 'prepare':
            prepare(args.expected_sha)
        elif args.command == 'install':
            require(args.bundle is not None, '--bundle required')
            install(args.bundle, args.ack)
        else:
            require(not (STATE / 'pending.json').exists(), 'Pending native transaction requires inspection')
            bundle = prepare(args.expected_sha)
            apply(bundle, ACK)


if __name__ == '__main__':
    try:
        main()
    except (Refused, OSError, ValueError, KeyError, tarfile.TarError, urllib.error.URLError):
        # Exception payloads/Compose output can contain credentials. Print only
        # safe refusal text we authored, never raw subprocess/JSON/path errors.
        error = sys.exc_info()[1]
        message = str(error) if isinstance(error, Refused) else 'Operation incomplete; inspect private state/logs'
        print('REFUSED: ' + message, file=sys.stderr)
        sys.exit(1)
