#!/usr/bin/env python3
"""Operator-only private phase: close signup and configure Grafana, NOT cutover.

Recreating the native backend invokes its migration entrypoint. Agents must not
execute --apply. No nginx, old stack, database flags, account or data deletion.
"""
import argparse
import copy
import importlib.util
import json
import os
from pathlib import Path
import sys
import time

ROOT = Path('/home/wotcv/rybbit-fresh-20261102.qYlV3CsP')
INSTALLER_HASH = 'a335cbc9767a0d86832e8f75a09790a4b90f5b40607955f52c825c4c7ba82a88'
CLOSED_IMAGE = 'sha256:38dbc984a2f9b80ad2782d5b8c74e7d3996654ee9d7081de11dc9b16a7d68a91'
ACK = 'close-private-signup-configure-correlation'
PROFILE = [{
    'siteIds': [1], 'requestOrigin': 'https://api.wot-cv.com',
    'grafanaUrl': 'https://dashboard.wot-cv.com', 'orgId': 1,
    'lokiDatasourceUid': 'bet3mn133whkwd', 'tempoDatasourceUid': 'df0rqhtz9e3uoa',
    'serviceName': 'wot-cv-be-prod', 'environment': 'prod', 'timePaddingMs': 120000,
}]


def compose(tool, *args):
    source = ROOT / 'source'
    return tool.docker('compose', '--project-name', tool.PROJECT, '--project-directory', str(source),
                       '--env-file', str(ROOT / 'private-closed.env'), '-f', str(source / 'docker-compose.yml'),
                       '-f', str(source / 'ops/minimal/compose.fresh.yml'), *args, timeout=180)


def validate_closed(tool, config, images, credentials):
    normalized = copy.deepcopy(config)
    backend = normalized['services']['backend']['environment']
    client = normalized['services']['client']['environment']
    tool.require(backend['DISABLE_SIGNUP'] == 'true' and client['NEXT_PUBLIC_DISABLE_SIGNUP'] == 'true',
                 'Signup must be closed in both services')
    tool.require(json.dumps(json.loads(backend['WOTCV_REPLAY_CORRELATION_JSON']), sort_keys=True) ==
                 json.dumps(PROFILE, sort_keys=True), 'Wrong correlation profile')
    # All other bootstrap isolation invariants stay unchanged, including private URLs.
    backend['DISABLE_SIGNUP'] = client['NEXT_PUBLIC_DISABLE_SIGNUP'] = 'false'
    tool.validate_model(normalized, images)
    tool.validate_credentials(config, credentials)


def account_guard(tool):
    sql = '''SELECT (SELECT count(*) FROM "user"),
    (SELECT count(*) FROM "user" WHERE role='admin'),
    (SELECT count(*) FROM organization),(SELECT count(*) FROM sites),
    (SELECT count(*) FROM member m JOIN "user" u ON u.id=m."userId"
       JOIN sites s ON s.organization_id=m."organizationId"
       WHERE u.role='admin' AND m.role='owner' AND s.site_id=1),
    (SELECT count(*) FROM sites WHERE site_id=1 AND id='776fb1633121'
       AND domain='wot-cv.com' AND NOT public AND NOT embed_enabled
       AND "sessionReplay" AND "webVitals" AND "trackErrors");'''
    value = tool.docker('exec', 'rybbit-wotcv-native-postgres-1', 'psql', '-X', '-U', 'frog',
                        '-d', 'analytics', '-At', '-c', sql).decode().strip()
    tool.require(value == '1|1|1|1|1|1',
                 'Expected one admin/owner/site and enabled Replay, Web Vitals, Errors; finish site settings first')
    return value


def snapshot(tool):
    result = {}
    for c in tool.containers():
        labels = c['Config'].get('Labels') or {}
        if labels.get('com.docker.compose.project') == tool.PROJECT:
            name = labels.get('com.docker.compose.service')
            tool.require(name in tool.SERVICES and name not in result, 'Unexpected private container')
            result[name] = c
    tool.require(set(result) == set(tool.SERVICES), 'Private stack must have exactly five containers')
    return result


def check_live(tool, live, images):
    for name, c in live.items():
        tool.require(c['Image'] == images[name] and c['State']['Status'] == 'running', 'Private image/state mismatch')
        if name != 'client':
            tool.require(c['State'].get('Health', {}).get('Status') == 'healthy', 'Private service is not healthy')
        mounts = c.get('Mounts', [])
        if name in tool.VOLUMES:
            key, target = tool.VOLUMES[name]
            tool.require(len(mounts) == 1 and mounts[0].get('Type') == 'volume' and
                         mounts[0].get('Name') == tool.PROJECT + '_' + key and
                         mounts[0].get('Destination') == target, 'Unexpected private storage')
        else:
            tool.require(not mounts, 'Unexpected application mount')


def probe_private_http(tool):
    import urllib.request
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open('http://127.0.0.1:13001/api/config', timeout=10) as response:
        tool.require(response.status == 200 and json.loads(response.read(65536))['disableSignup'] is True,
                     'Runtime API did not close signup')
    with opener.open('http://127.0.0.1:13001/api/site/tracking-config/1', timeout=10) as response:
        config = json.loads(response.read(65536))
        tool.require(all(config.get(k) is True for k in ('sessionReplay', 'webVitals', 'trackErrors')) and
                     (config.get('requestCorrelation') or {}).get('origins') == ['https://api.wot-cv.com'],
                     'Runtime tracking configuration is incomplete')
    with opener.open('http://127.0.0.1:13002/login', timeout=10) as response:
        tool.require(response.status == 200, 'Private frontend is not HTTP ready')


def execute(tool, state, apply, ack):
    tool.require(state['phase'] == 'bootstrap', 'Requires completed bootstrap phase')
    marker = ROOT / 'private-closed-receipt.json'
    tool.require(not marker.exists(), 'Private phase already attempted; inspect receipt instead of retrying')
    tool.check(ROOT, state)
    before = snapshot(tool)
    check_live(tool, before, state['images'])
    counts = account_guard(tool)
    image = tool.json_docker('image', 'inspect', CLOSED_IMAGE)[0]
    labels = image['Config'].get('Labels') or {}
    tool.require(image['Id'] == CLOSED_IMAGE and labels.get('org.opencontainers.image.revision') == tool.SOURCE and
                 labels.get('wotcv.fresh.kind') == 'client-private-closed', 'Wrong private closed-signup image')
    profile = json.dumps(PROFILE, separators=(',', ':'))
    js = "const m=await import('/app/dist/lib/replayCorrelation.js');m.parseReplayCorrelationProfiles(process.argv[1]);"
    tool.docker('exec', 'rybbit-wotcv-native-backend-1', 'node', '--input-type=module', '-e', js, profile)
    if not apply:
        print('CHECK PASS: account/site/roles/features, immutable closed client, parser and unchanged old stack. No files or services changed.')
        return
    tool.require(ack == ACK, 'Explicit private reconfiguration ACK required')
    credentials = json.loads((ROOT / 'secrets.json').read_text())
    images = {**state['images'], 'client': CLOSED_IMAGE}
    values = dict(credentials)
    values.update({'WOTCV_' + name.upper() + '_IMAGE': images[name] for name in tool.SERVICES})
    values.update({'WOTCV_FRONTEND_URL': 'http://127.0.0.1:13002',
                   'WOTCV_API_URL': 'http://127.0.0.1:13001', 'DISABLE_SIGNUP': 'true',
                   'WOTCV_BACKEND_RESTART': 'no', 'POSTGRES_DB': 'analytics', 'POSTGRES_USER': 'frog',
                   'CLICKHOUSE_DB': 'analytics',
                   'SOURCE_CODE_URL': 'https://github.com/WoT-CV/rybbit-wotcv/tree/' + tool.SOURCE,
                   'WOTCV_REPLAY_CORRELATION_JSON': profile})
    tool.private_write(ROOT / 'private-closed.env', tool.env_text(values))
    config = json.loads(compose(tool, 'config', '--format', 'json'))
    validate_closed(tool, config, images, credentials)
    tool.private_write(marker, json.dumps({'phase': 'applying', 'source': tool.SOURCE,
        'oldStack': state['legacy'], 'privateContainerIds': {k: c['Id'] for k, c in before.items()},
        'images': {k: images[k] for k in tool.SERVICES}, 'counts': counts,
        'envSha256': tool.digest(ROOT / 'private-closed.env')}, indent=2))
    # Operator executes native restart/init; main agent must not call --apply.
    compose(tool, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'backend', 'client')
    for _ in range(90):
        after = snapshot(tool)
        try:
            check_live(tool, after, images)
            break
        except tool.Refused:
            time.sleep(2)
    else:
        raise tool.Refused('Private phase not healthy; inspect retained receipt, do not retry or switch public traffic')
    tool.require(all(before[k]['Id'] == after[k]['Id'] for k in tool.VOLUMES), 'Database container unexpectedly changed')
    tool.require(tool.legacy_snapshot() == state['legacy'], 'Old stack unexpectedly changed')
    tool.require(account_guard(tool) == counts, 'Account/site invariants changed')
    backend_env = dict(x.split('=', 1) for x in after['backend']['Config']['Env'] if '=' in x)
    tool.require(backend_env.get('DISABLE_SIGNUP') == 'true' and
                 json.loads(backend_env.get('WOTCV_REPLAY_CORRELATION_JSON', 'null')) == PROFILE,
                 'Runtime closed-signup/correlation settings mismatch')
    probe_private_http(tool)
    tool.private_write(ROOT / 'private-closed-success.json', json.dumps({
        'status': 'private-closed', 'source': tool.SOURCE, 'images': {k: images[k] for k in tool.SERVICES},
        'oldStackUnchanged': True, 'databaseContainersUnchanged': True,
        'publicCutover': False, 'oldDataDeleted': False}, indent=2))
    print('PRIVATE READY: signup closed, Grafana profile configured, same account/site and databases. Public old Rybbit unchanged.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--ack')
    args = parser.parse_args()
    if not hasattr(os, 'geteuid') or os.geteuid() != 0:
        raise RuntimeError('Operator sudo required to verify root-owned bootstrap state')
    import hashlib
    installer = ROOT / 'wotcv-fresh-install.py'
    if installer.is_symlink() or hashlib.sha256(installer.read_bytes()).hexdigest() != INSTALLER_HASH:
        raise RuntimeError('Reviewed bootstrap installer differs')
    spec = importlib.util.spec_from_file_location('reviewed_fresh_install', installer)
    tool = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(tool)
    tool.state_root(str(ROOT))
    import fcntl
    fd = os.open('/home/wotcv/.rybbit-wotcv-native-install.lock',
                 os.O_CREAT | os.O_APPEND | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        execute(tool, tool.load(ROOT), args.apply, args.ack)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        message = str(error) if type(error).__name__ == 'Refused' else 'Private phase did not complete; inspect retained evidence'
        print('REFUSED: ' + message + '. No automatic cleanup/cutover.', file=sys.stderr)
        sys.exit(1)
