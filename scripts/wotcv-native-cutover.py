#!/usr/bin/env python3
"""Operator-only staged native cutover. Agents must not execute promote/rollback.

Native application recreation invokes its unchanged migration entrypoint.
Only explicit cleanup deletes the three approved legacy test volumes. No global
prune, account writes, native data deletion or FE deployment is performed.
"""
import argparse
import copy
import hashlib
from html.parser import HTMLParser
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import time
import urllib.error
import urllib.request

ROOT = Path('/home/wotcv/rybbit-fresh-20261102.qYlV3CsP')
VHOST = Path('/etc/nginx/sites-available/tracking.wot-cv.com')
ENABLED = Path('/etc/nginx/sites-enabled/tracking.wot-cv.com')
ORIGINAL_SHA = '56aecdb6e8c34f9a613af816e2d403a58862d809cbd2c7998069cf387736f0d9'
INSTALLER_SHA = 'a335cbc9767a0d86832e8f75a09790a4b90f5b40607955f52c825c4c7ba82a88'
PRIVATE_SHA = '8eab9ad3cdc8802c938c337ffcaf26e237f22d554c55091a8a936c10211a9c99'
PUBLIC_CLIENT = 'sha256:e8a36b60e2d6b6ca622a51f017a7d421dd501d22c8a2c6d09a2b42de385ab2b7'
PREFIX = '/api'
PUBLIC = 'https://tracking.wot-cv.com'
SITE = '776fb1633121'
ACKS = {'promote': 'promote-native-keep-old-data',
        'retire': 'stop-five-legacy-rybbit-containers',
        'cleanup': 'delete-three-approved-legacy-test-volumes',
        'rollback': 'restore-legacy-routing-keep-native-data'}
NOINDEX = 'noindex, nofollow, nosnippet, noimageindex'
SNIPPET = Path('/etc/nginx/snippets/wotcv-tracking-noindex.conf')
SNIPPET_SHA = 'a6eb19874cde2047b629ebcf07ab0952b52bf80409e3a6a814c7fde13496f61a'


def load_module(name, path, expected):
    if path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
        raise RuntimeError('Reviewed dependency changed')
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def nginx_candidate(original, public=False):
    """Only the hash-pinned dedicated vhost is transformed; TLS/noindex retained."""
    if hashlib.sha256(original.encode()).hexdigest() != ORIGINAL_SHA:
        raise ValueError('Original nginx configuration changed')
    if not public:
        return original
    # Native canonical paths: cache isolation uses the native ?siteId= URL,
    # not a permanent deployment-specific API namespace.
    block = r'''
    location ~ ^/api/(script\.js|replay\.js)$ {
        proxy_pass http://127.0.0.1:13001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_hide_header Cache-Control;
        add_header Cache-Control "no-store" always;
        add_header X-Robots-Tag "noindex, nofollow, nosnippet, noimageindex" always;
    }
    # Only the fresh site may read tracker config; cached old clients stop here.
    location ^~ /api/site/tracking-config/ {
        if ($uri !~ "^/api/site/tracking-config/(1|776fb1633121)$") { return 410; }
        proxy_pass http://127.0.0.1:13001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_hide_header Cache-Control;
        add_header Cache-Control "no-store" always;
        add_header X-Robots-Tag "noindex, nofollow, nosnippet, noimageindex" always;
    }
    location ^~ /api/session-replay/record/ {
        if ($uri !~ "^/api/session-replay/record/(1|776fb1633121)$") { return 410; }
        # Native replay accepts JSON, not the former custom gzip transport.
        if ($http_content_encoding !~* "^(|identity)$") { return 415; }
        client_max_body_size 50M;
        client_body_timeout 120s;
        proxy_pass http://127.0.0.1:13001;
        proxy_http_version 1.1;
        proxy_request_buffering off;
        proxy_buffering off;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 60s;
        proxy_send_timeout 120s;
        proxy_read_timeout 120s;
        proxy_hide_header Cache-Control;
        add_header Cache-Control "no-store" always;
        add_header X-Robots-Tag "noindex, nofollow, nosnippet, noimageindex" always;
    }
'''
    anchor = '    location ^~ /api/session-replay/record/ {'
    if original.count(anchor) != 1:
        raise ValueError('Unexpected nginx structure')
    result, count = re.subn(r'    location \^~ /api/session-replay/record/ \{.*?\n    \}\n', lambda _m: block + '\n', original, flags=re.S)
    if count != 1:
        raise ValueError('Missing legacy replay location')
    result = result.replace('http://127.0.0.1:3001', 'http://127.0.0.1:13001')
    result = result.replace('http://127.0.0.1:3002', 'http://127.0.0.1:13002')
    return result


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def http(url, method='GET', data=None, headers=None):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    request = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        response = opener.open(request, timeout=15)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        body = response.read(2 * 1024 * 1024 + 1)
        if len(body) > 2 * 1024 * 1024:
            raise RuntimeError('HTTP response exceeded bounded probe')
        return response.status, body, response.headers


def journal(tool, phase, **fields):
    path = ROOT / ('cutover-' + phase + '.json')
    tool.private_write(path, json.dumps({'phase': phase, 'at': time.time(), **fields}, indent=2))


def compose(tool, env, *args):
    source = ROOT / 'source'
    return tool.docker('compose', '--project-name', tool.PROJECT, '--project-directory', str(source),
                       '--env-file', str(ROOT / env), '-f', str(source / 'docker-compose.yml'),
                       '-f', str(source / 'ops/minimal/compose.fresh.yml'), *args, timeout=240)


def validate_public(tool, private, config, images, credentials):
    normalized = copy.deepcopy(config)
    backend = normalized['services']['backend']
    env = backend['environment']
    client_env = normalized['services']['client']['environment']
    tool.require(env.get('BASE_URL') == PUBLIC and env.get('SERVER_URL') == PUBLIC and
                 client_env.get('NEXT_PUBLIC_BACKEND_URL') == PUBLIC and
                 backend.get('restart') == 'unless-stopped', 'Public origins/restart mismatch')
    env.update({'BASE_URL': 'http://127.0.0.1:13002', 'SERVER_URL': 'http://127.0.0.1:13001'})
    client_env['NEXT_PUBLIC_BACKEND_URL'] = 'http://127.0.0.1:13001'
    backend['restart'] = 'no'
    private.validate_closed(tool, normalized, images, credentials)


def paths_guard(tool):
    tool.require(not VHOST.is_symlink() and ENABLED.is_symlink() and ENABLED.resolve() == VHOST,
                 'Unexpected nginx vhost/symlink')
    tool.require(not SNIPPET.is_symlink() and tool.digest(SNIPPET) == SNIPPET_SHA,
                 'Noindex/maintenance snippet changed; review before proceeding')
    tool.require(not Path('/var/lib/wotcv-rybbit-maintenance/active').exists(),
                 'An existing maintenance owner is active; do not override it')


def replace_nginx(tool, content):
    """Atomic dedicated vhost replace; restore on syntax/reload failure."""
    paths_guard(tool)
    before = VHOST.read_bytes()
    reviewed = original_config(tool)
    tool.require(before in (reviewed.encode(), nginx_candidate(reviewed, public=True).encode()),
                 'Concurrent/unreviewed nginx change; refusing overwrite')
    info = VHOST.stat()
    candidate = VHOST.with_name('.tracking.wot-cv.com.native-tmp')
    tool.require(not candidate.exists() and not candidate.is_symlink(), 'Nginx temp already exists')
    def install(data):
        fd = os.open(candidate, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, info.st_mode & 0o777)
        with os.fdopen(fd, 'wb') as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chown(candidate, info.st_uid, info.st_gid)
        os.replace(candidate, VHOST)
    install(content.encode())
    try:
        tool.run(['/usr/sbin/nginx', '-t'])
        tool.run(['/usr/bin/systemctl', 'reload', 'nginx'])
    except Exception:
        tool.require(VHOST.read_bytes() == content.encode(), 'Concurrent nginx change during failed reload; manual recovery required')
        install(before)
        tool.run(['/usr/sbin/nginx', '-t'])
        tool.run(['/usr/bin/systemctl', 'reload', 'nginx'])
        raise


def original_config(tool):
    backup = ROOT / 'nginx-original.conf'
    tool.require(backup.is_file() and not backup.is_symlink() and tool.digest(backup) == ORIGINAL_SHA,
                 'Missing reviewed nginx backup')
    return backup.read_text()


def legacy_volumes(tool):
    return {key: {field: value.get(field) for field in ('Name', 'CreatedAt', 'Mountpoint', 'Driver', 'Options', 'Labels')}
            for key, _ in tool.VOLUMES.values()
            for value in tool.json_docker('volume', 'inspect', 'rybbit_' + key)}


def private_guard(tool, private, state):
    success = json.loads((ROOT / 'private-closed-success.json').read_text())
    receipt = json.loads((ROOT / 'private-closed-receipt.json').read_text())
    tool.require(success.get('status') == 'private-closed' and success.get('source') == tool.SOURCE and
                 success.get('oldStackUnchanged') is True and success.get('databaseContainersUnchanged') is True,
                 'Private phase not completed')
    tool.require(tool.digest(ROOT / 'private-closed.env') == receipt.get('envSha256'), 'Private environment changed')
    live = private.snapshot(tool)
    private.check_live(tool, live, success['images'])
    private.account_guard(tool)
    tool.require(all(live[k]['Id'] == receipt['privateContainerIds'][k] for k in tool.VOLUMES),
                 'Private database identity changed')
    tool.require(tool.legacy_snapshot() == state['legacy'], 'Legacy identities changed')
    private.probe_private_http(tool)
    return live, success['images']


def producer_probe(tool):
    code, body, headers = http(PUBLIC + PREFIX + '/site/tracking-config/' + SITE,
                               headers={'Origin': 'https://wot-cv.com'})
    tool.require(code == 200 and headers.get('Access-Control-Allow-Origin') == 'https://wot-cv.com',
                 'Native public tracker config/CORS not available')
    config = json.loads(body)
    tool.require(all(config.get(k) is True for k in ('sessionReplay', 'webVitals', 'trackErrors')) and
                 config.get('requestCorrelation', {}).get('origins') == ['https://api.wot-cv.com'],
                 'Incomplete native tracker config')
    for asset in ('script.js?siteId=' + SITE, 'replay.js'):
        code, body, headers = http(PUBLIC + PREFIX + '/' + asset)
        tool.require(code == 200 and len(body) > 1000 and 'no-store' in headers.get('Cache-Control', '') and
                     'noindex' in headers.get('X-Robots-Tag', ''), 'Native tracker asset/cache/noindex failure')


def producer_html_guard(tool):
    code, body, _ = http('https://wot-cv.com/')
    class Scripts(HTMLParser):
        def __init__(self):
            super().__init__()
            self.tags = []
        def handle_starttag(self, tag, attrs):
            if tag == 'script':
                # Ambiguous duplicate attributes are not acceptable evidence.
                keys = [key for key, _ in attrs]
                if len(keys) == len(set(keys)):
                    self.tags.append(dict(attrs))
    parser = Scripts()
    parser.feed(body.decode())
    tags = parser.tags
    expected = PUBLIC + PREFIX + '/script.js?siteId=' + SITE
    matching = [tag for tag in tags if tag.get('src') == expected and
                tag.get('type', '').lower() in ('', 'text/javascript', 'application/javascript')]
    tool.require(code == 200 and len(matching) == 1 and matching[0].get('data-site-id') == SITE and
                 not any(tag.get('src', '').startswith(PUBLIC + '/api/script.js') and tag not in matching for tag in tags),
                 'Deploy the prepared WoT-CV frontend first; native producer not live')


def native_data_guard(tool):
    # Counts alone do not prove playback. The operator ACK separately attests UI/Grafana acceptance.
    js = """const {clickhouse}=await import('/app/dist/db/clickhouse/client.js');
for (const table of ['events','session_replay_events','session_replay_metadata_v2']) {
const r=await clickhouse.query({query:'SELECT count() AS n FROM analytics.'+table+' WHERE site_id=1',format:'JSONEachRow'});
const rows=await r.json();if(Number(rows[0]?.n)<1)process.exit(4);}
await clickhouse.close();"""
    tool.docker('exec', 'rybbit-wotcv-native-backend-1', 'node', '--input-type=module', '-e', js)


def public_probe(tool):
    producer_probe(tool)
    code, body, headers = http(PUBLIC + '/api/health')
    tool.require(code == 200 and body == b'OK' and 'noindex' in headers.get('X-Robots-Tag', ''), 'Public native health failure')
    code, body, _ = http(PUBLIC + '/api/config')
    tool.require(code == 200 and json.loads(body).get('disableSignup') is True, 'Signup is not closed')
    for path in ('/', '/login'):
        code, _, headers = http(PUBLIC + path)
        tool.require(code == 200 and 'noindex' in headers.get('X-Robots-Tag', ''), 'Public panel/noindex failure')
    for path in ('/api/site/tracking-config/3e894930d08d', '/api/site/tracking-config/2',
                 '/api/session-replay/record/3e894930d08d', '/api/session-replay/record/2', '/robots.txt', '/sitemap.xml'):
        code, _, headers = http(PUBLIC + path)
        tool.require(code == 410 and 'no-store' in headers.get('Cache-Control', '') and
                     'noindex' in headers.get('X-Robots-Tag', ''), 'Legacy endpoint/manifest not retired')
    code, _, _ = http(PUBLIC + '/api/session-replay/record/' + SITE, method='POST', data=b'{}',
                       headers={'Content-Type': 'application/json', 'Content-Encoding': 'gzip'})
    tool.require(code == 415, 'Legacy encoded replay was not rejected before native parsing')
    code, _, headers = http(PUBLIC + '/api/sites/1/session-replay/correlation-config')
    tool.require(code == 403 and 'no-store' in headers.get('Cache-Control', ''), 'Anonymous profile access not denied')


def verify_public_live(tool, private, images, db_ids):
    live = private.snapshot(tool)
    private.check_live(tool, live, images)
    tool.require(all(live[k]['Id'] == db_ids[k] for k in tool.VOLUMES), 'Native DB was replaced')
    private.account_guard(tool)
    env = dict(x.split('=', 1) for x in live['backend']['Config']['Env'] if '=' in x)
    tool.require(env.get('BASE_URL') == PUBLIC and env.get('SERVER_URL') == PUBLIC and env.get('DISABLE_SIGNUP') == 'true',
                 'Runtime public origins/signup mismatch')
    client_env = dict(x.split('=', 1) for x in live['client']['Config']['Env'] if '=' in x)
    tool.require(client_env.get('NEXT_PUBLIC_BACKEND_URL') == PUBLIC and client_env.get('NEXT_PUBLIC_DISABLE_SIGNUP') == 'true' and
                 json.dumps(json.loads(env.get('WOTCV_REPLAY_CORRELATION_JSON', 'null')), sort_keys=True) ==
                 json.dumps(private.PROFILE, sort_keys=True),
                 'Runtime client/correlation profile mismatch')
    tool.require(live['backend']['HostConfig']['RestartPolicy']['Name'] == 'unless-stopped', 'Backend restart policy mismatch')
    return live


def execute(tool, private, command, apply, ack, accepted):
    tool.require(command in ACKS, 'Unknown cutover operation')
    state = tool.load(ROOT)
    paths_guard(tool)
    if apply:
        tool.require(ack == ACKS.get(command), 'Explicit operation acknowledgement required')
    if command == 'promote':
        tool.require(not (ROOT / 'cutover-rollback-attempt.json').exists(), 'Rollback already attempted; prepare a newly reviewed transaction')
        before, images = private_guard(tool, private, state)
        tool.require(tool.digest(VHOST) == ORIGINAL_SHA, 'Original vhost changed')
        original = VHOST.read_text()
        tool.require(not (ROOT / 'cutover-promote-attempt.json').exists(), 'Promotion already attempted; inspect receipt, do not retry')
        image = tool.json_docker('image', 'inspect', PUBLIC_CLIENT)[0]
        labels = image['Config'].get('Labels') or {}
        tool.require(image['Id'] == PUBLIC_CLIENT and labels.get('org.opencontainers.image.revision') == tool.SOURCE and
                     labels.get('wotcv.fresh.kind') == 'client-production', 'Wrong public client image')
        if not apply:
            print('CHECK PASS: private account/features/images ready. Promotion requires private login and FE release readiness; collection waits for FE deployment.')
            return
        tool.require(accepted == 'private-login-verified-frontend-ready', 'Confirm private login and prepared FE release before promotion')
        tool.private_write(ROOT / 'nginx-original.conf', VHOST.read_bytes())
        credentials = json.loads((ROOT / 'secrets.json').read_text())
        images = {**images, 'client': PUBLIC_CLIENT}
        values = dict(credentials)
        values.update({'WOTCV_' + name.upper() + '_IMAGE': images[name] for name in tool.SERVICES})
        values.update({'WOTCV_FRONTEND_URL': PUBLIC, 'WOTCV_API_URL': PUBLIC, 'DISABLE_SIGNUP': 'true',
                       'WOTCV_BACKEND_RESTART': 'unless-stopped', 'POSTGRES_DB': 'analytics', 'POSTGRES_USER': 'frog',
                       'CLICKHOUSE_DB': 'analytics', 'SOURCE_CODE_URL': 'https://github.com/WoT-CV/rybbit-wotcv/tree/' + tool.SOURCE,
                       'WOTCV_REPLAY_CORRELATION_JSON': json.dumps(private.PROFILE, separators=(',', ':'))})
        tool.private_write(ROOT / 'production.env', tool.env_text(values))
        validate_public(tool, private, json.loads(compose(tool, 'production.env', 'config', '--format', 'json')), images, credentials)
        db_ids = {k: before[k]['Id'] for k in tool.VOLUMES}
        journal(tool, 'promote-attempt', images=images, dbIds=db_ids, envSha=tool.digest(ROOT / 'production.env'),
                legacyVolumes=legacy_volumes(tool),
                oldRestart={c['name']: tool.json_docker('inspect', c['id'])[0]['HostConfig']['RestartPolicy'] for c in state['legacy']})
        # Explicit operator native entrypoint (includes native migrations); never invoked by an agent.
        compose(tool, 'production.env', 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'backend', 'client')
        for _ in range(90):
            try:
                verify_public_live(tool, private, images, db_ids)
                break
            except tool.Refused:
                time.sleep(2)
        else:
            raise tool.Refused('Native public apps not ready; do not retire old stack; use reviewed rollback')
        replace_nginx(tool, nginx_candidate(original, public=True))
        public_probe(tool)
        journal(tool, 'public-ready', images=images, dbIds=db_ids, nginxSha=tool.digest(VHOST), producerVerified=False)
        print('PUBLIC READY: native canonical panel/API active. Deploy prepared WoT-CV FE now; old-site tracking is refused. Verify real login/replay/Grafana before retirement.')
        return
    original = original_config(tool)
    if command == 'retire':
        tool.require(not (ROOT / 'cutover-rollback-attempt.json').exists(), 'Rollback attempted; retirement refused')
        receipt = json.loads((ROOT / 'cutover-public-ready.json').read_text())
        tool.require(VHOST.read_text() == nginx_candidate(original, public=True), 'Public nginx changed')
        verify_public_live(tool, private, receipt['images'], receipt['dbIds'])
        public_probe(tool)
        producer_html_guard(tool)
        native_data_guard(tool)
        tool.require(tool.legacy_snapshot() == state['legacy'], 'Legacy target identities changed')
        tool.require(not (ROOT / 'cutover-retire-attempt.json').exists(), 'Retirement already attempted; inspect transaction')
        if not apply:
            print('CHECK PASS: only five exact old containers will stop; restart disabled, old volumes retained.')
            return
        tool.require(accepted == 'public-login-replay-grafana-verified', 'Verify real public login/replay/Grafana before retirement')
        journal(tool, 'retire-attempt', targets=state['legacy'])
        # Stop applications/workers before their databases. No force, rm or volume deletion.
        ordered = sorted(state['legacy'], key=lambda c: ('backend', 'client', 'redis', 'clickhouse', 'postgres').index(c['name']))
        for old in ordered:
            tool.docker('update', '--restart=no', old['id'])
            tool.docker('stop', '--time', '60', old['id'], timeout=90)
            live = tool.json_docker('inspect', old['id'])[0]
            tool.require(live['Id'] == old['id'] and live['State']['Status'] == 'exited' and
                         live['HostConfig']['RestartPolicy']['Name'] == 'no' and live['State']['ExitCode'] == 0,
                         'Legacy shutdown was not clean; stop and inspect, no cleanup')
        public_probe(tool)
        journal(tool, 'legacy-retired', oldDataDeleted=False, oldVolumesRetained=True)
        print('LEGACY RETIRED: five old containers stopped with restart=no; native public stack healthy. Old volumes retained, not deleted.')
        return
    if command == 'rollback':
        tool.require(not (ROOT / 'cutover-cleanup-attempt.json').exists(), 'Cleanup started: legacy rollback is no longer available')
        tool.require(not (ROOT / 'cutover-rollback-attempt.json').exists(), 'Rollback already attempted; inspect transaction')
        # Canonical routing rollback requires a coordinated producer FE rollback.
        tool.require(VHOST.read_text() in (nginx_candidate(original), nginx_candidate(original, public=True)), 'Unknown nginx version; refuse rollback')
        tool.require(tool.legacy_snapshot() == state['legacy'], 'Legacy rollback targets changed')
        if not apply:
            print('CHECK PASS: restores original canonical routing; native DATA retained, coordinated FE rollback required. No changes.')
            return
        journal(tool, 'rollback-attempt')
        promotion = json.loads((ROOT / 'cutover-promote-attempt.json').read_text()) if (ROOT / 'cutover-promote-attempt.json').exists() else None
        for old in state['legacy']:
            if promotion:
                policy = promotion['oldRestart'][old['name']]
                name = policy['Name'] or 'no'
                if name == 'on-failure' and policy.get('MaximumRetryCount'):
                    name += ':' + str(int(policy['MaximumRetryCount']))
                tool.docker('update', '--restart=' + name, old['id'])
            tool.docker('start', old['id'])
        for _ in range(60):
            cs = [tool.json_docker('inspect', c['id'])[0] for c in state['legacy']]
            if all(c['State']['Status'] == 'running' and (c['Name'] == '/client' or
                   c['State'].get('Health', {}).get('Status') == 'healthy') for c in cs):
                break
            time.sleep(2)
        else:
            raise tool.Refused('Legacy rollback stack not healthy; routing not changed')
        if promotion:
            for old in state['legacy']:
                actual = tool.json_docker('inspect', old['id'])[0]['HostConfig']['RestartPolicy']
                tool.require(actual == promotion['oldRestart'][old['name']], 'Legacy restart policy was not restored')
        replace_nginx(tool, original)
        code, body, _ = http(PUBLIC + '/api/health')
        tool.require(code == 200 and json.loads(body).get('gitSha') == tool.LEGACY, 'Rollback runtime revision mismatch')
        journal(tool, 'rolled-back', nativeProducerKept=False, databasesDeleted=False, frontendRollbackRequired=True)
        print('ROLLED BACK: original canonical routing active; native data retained. Coordinate old site ID in WoT-CV FE; new producer does not collect through legacy routing.')
        return
    if command == 'cleanup':
        tool.require((ROOT / 'cutover-legacy-retired.json').is_file() and
                     not (ROOT / 'cutover-rollback-attempt.json').exists() and
                     not (ROOT / 'cutover-rolled-back.json').exists() and
                     not (ROOT / 'cutover-cleanup-attempt.json').exists(), 'Cleanup requires verified retirement, no rollback or earlier deletion attempt')
        receipt = json.loads((ROOT / 'cutover-public-ready.json').read_text())
        tool.require(VHOST.read_text() == nginx_candidate(original, public=True), 'Public vhost changed')
        verify_public_live(tool, private, receipt['images'], receipt['dbIds'])
        producer_html_guard(tool)
        public_probe(tool)
        tool.require(tool.legacy_snapshot() == state['legacy'], 'Approved old storage/consumer identities changed')
        approved_volumes = json.loads((ROOT / 'cutover-promote-attempt.json').read_text())['legacyVolumes']
        tool.require(legacy_volumes(tool) == approved_volumes, 'Old physical volume metadata changed')
        for old in state['legacy']:
            c = tool.json_docker('inspect', old['id'])[0]
            tool.require(c['State']['Status'] == 'exited' and c['State']['ExitCode'] == 0 and
                         c['HostConfig']['RestartPolicy']['Name'] == 'no', 'Legacy target is not cleanly retired')
        if not apply:
            print('CHECK PASS: deletes only five stopped old containers and three old test volumes. Native volumes and backups excluded.')
            return
        tool.require(accepted == 'new-production-accepted-old-test-data-discarded', 'Final production acceptance required before irreversible deletion')
        journal(tool, 'cleanup-attempt', targets=state['legacy'], irreversible=True)
        for old in state['legacy']:
            tool.docker('rm', old['id'])
            journal(tool, 'removed-' + old['name'], id=old['id'])
        for key, _target in tool.VOLUMES.values():
            name = 'rybbit_' + key
            v = tool.json_docker('volume', 'inspect', name)[0]
            labels = v.get('Labels') or {}
            tool.require({field: v.get(field) for field in approved_volumes[key]} == approved_volumes[key] and
                         v.get('Driver') == 'local' and not v.get('Options') and
                         labels.get('com.docker.compose.project') == 'rybbit' and
                         labels.get('com.docker.compose.volume') == key and
                         not any(m.get('Name') == name for c in tool.containers() for m in c.get('Mounts', [])),
                         'Old volume changed or has another consumer; deletion refused')
            tool.docker('volume', 'rm', name)
            journal(tool, 'removed-volume-' + key, name=name)
        verify_public_live(tool, private, receipt['images'], receipt['dbIds'])
        public_probe(tool)
        journal(tool, 'cleanup-complete', oldDataDeleted=True, nativeDataPreserved=True)
        print('CLEANUP COMPLETE: five old containers and exactly three old test volumes removed. Not recoverable without a separately verified backup; no backup was removed.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=tuple(ACKS))
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--ack')
    parser.add_argument('--acceptance')
    args = parser.parse_args()
    if not hasattr(os, 'geteuid') or os.geteuid() != 0:
        raise RuntimeError('Interactive operator sudo required')
    tool = load_module('sealed_native_installer', ROOT / 'wotcv-fresh-install.py', INSTALLER_SHA)
    private = load_module('sealed_private_phase', ROOT / 'wotcv-close-private-signup.py', PRIVATE_SHA)
    tool.state_root(str(ROOT))
    import fcntl
    fd = os.open('/home/wotcv/.rybbit-wotcv-native-install.lock', os.O_CREAT | os.O_APPEND | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        execute(tool, private, args.command, args.apply, args.ack, args.acceptance)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        message = str(error) if type(error).__name__ == 'Refused' else 'Cutover phase did not complete; inspect retained evidence'
        print('REFUSED: ' + message + '. No automatic data deletion or retry.', file=sys.stderr)
        sys.exit(1)
