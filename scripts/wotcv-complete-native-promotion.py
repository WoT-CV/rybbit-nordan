#!/usr/bin/env python3
"""Verify an already-switched native promotion and seal its missing receipt.

No compose up/start/restart, nginx writes/reload, migration or deletion.
Only --apply writes one missing public-ready JSON receipt after all checks.
The attempted cutover artifact is kept immutable for transaction provenance.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys

ROOT = Path('/home/wotcv/rybbit-fresh-20261102.qYlV3CsP')
CUTOVER_SHA = '3fce76407cd5ecb4768e6080813b370cad09f8df5ca162af902593ca8e0a472a'
ACK = 'verify-existing-native-promotion'


def execute(tool, private, cutover, apply=False, ack=None):
    if apply:
        tool.require(ack == ACK, 'Explicit receipt-completion ACK required')
    state = tool.load(ROOT)
    tool.require(state.get('phase') == 'bootstrap', 'Unexpected original bootstrap phase')
    cutover.paths_guard(tool)
    forbidden = ('public-ready', 'rollback-attempt', 'rolled-back', 'retire-attempt',
                 'legacy-retired', 'cleanup-attempt', 'cleanup-complete')
    tool.require(not any((ROOT / ('cutover-' + name + '.json')).exists() for name in forbidden),
                 'Another completion/recovery/retirement phase already exists; inspect, do not overwrite')
    attempt_path = ROOT / 'cutover-promote-attempt.json'
    tool.require(attempt_path.is_file(), 'No promotion attempt to verify')
    attempt = json.loads(attempt_path.read_text())
    success = json.loads((ROOT / 'private-closed-success.json').read_text())
    previous = json.loads((ROOT / 'private-closed-receipt.json').read_text())
    tool.require(attempt.get('phase') == 'promote-attempt' and success.get('status') == 'private-closed' and
                 success.get('source') == tool.SOURCE and success.get('oldStackUnchanged') is True and
                 success.get('databaseContainersUnchanged') is True, 'Unexpected transaction provenance')
    expected = {name: state['images'][name] for name in tool.SERVICES}
    expected['client'] = cutover.PUBLIC_CLIENT
    tool.require(attempt.get('images') == expected and set(attempt.get('dbIds', {})) == set(tool.VOLUMES) and
                 all(attempt['dbIds'][name] == previous['privateContainerIds'][name] for name in tool.VOLUMES),
                 'Promotion images/database identities differ from original fresh state')
    environment = ROOT / 'production.env'
    tool.require(environment.is_file() and not environment.is_symlink() and environment.stat().st_mode & 0o077 == 0 and
                 tool.digest(environment) == attempt.get('envSha'), 'Production environment differs from attempted promotion')
    config = json.loads(cutover.compose(tool, 'production.env', 'config', '--format', 'json'))
    credentials = json.loads((ROOT / 'secrets.json').read_text())
    cutover.validate_public(tool, private, config, expected, credentials)
    original = cutover.original_config(tool)
    canonical = cutover.nginx_candidate(original, public=True)
    tool.require(cutover.VHOST.read_bytes() == canonical.encode(), 'Current nginx is not the exact reviewed public candidate')
    tool.require(tool.legacy_snapshot() == state['legacy'] and
                 cutover.legacy_volumes(tool) == attempt.get('legacyVolumes'),
                 'Legacy container or physical volume identities changed')
    tool.require(set(attempt.get('oldRestart', {})) == {item['name'] for item in state['legacy']},
                 'Original legacy restart receipt incomplete')
    for old in state['legacy']:
        current = tool.json_docker('inspect', old['id'])[0]
        tool.require(current['State']['Status'] == 'running' and
                     current['HostConfig']['RestartPolicy'] == attempt['oldRestart'][old['name']],
                     'Legacy service/restart policy changed during partial promotion')
    live = cutover.verify_public_live(tool, private, expected, attempt['dbIds'])
    for name, container in live.items():
        host = container['HostConfig']
        bindings = host.get('PortBindings') or {}
        required = ({('3001' if name == 'backend' else '3002') + '/tcp':
                     [{'HostIp': '127.0.0.1', 'HostPort': '13001' if name == 'backend' else '13002'}]}
                    if name in ('backend', 'client') else {})
        tool.require(bindings == required and
                     set(container.get('NetworkSettings', {}).get('Networks', {})) == {tool.PROJECT + '_default'},
                     'Actual container network/loopback isolation mismatch')
        tool.require(host.get('LogConfig') == {'Type': 'json-file', 'Config': {'max-size': '50m', 'max-file': '5'}},
                     'Runtime log rotation differs from reviewed configuration')
        actual_env = dict(item.split('=', 1) for item in container['Config'].get('Env', []) if '=' in item)
        tool.require(all(actual_env.get(key) == value for key, value in
                         config['services'][name].get('environment', {}).items()),
                     'Actual runtime environment differs from validated effective model')
    for name in ('backend', 'client'):
        image = tool.json_docker('image', 'inspect', expected[name])[0]
        labels = image['Config'].get('Labels') or {}
        tool.require(labels.get('org.opencontainers.image.revision') == tool.SOURCE,
                     'Runtime application image source label mismatch')
        tool.require(live[name].get('RestartCount') == 0, 'Unexpected application restart; investigate before sealing receipt')
    # Existing live instance only; includes a deliberately rejected gzip probe.
    cutover.public_probe(tool)
    cutover.producer_html_guard(tool)
    if not apply:
        print('CHECK PASS: existing public promotion, images, unchanged databases/legacy, env, nginx, CORS and frontend snippet verified. No files or services changed.')
        return
    cutover.journal(tool, 'public-ready', images=expected, dbIds=attempt['dbIds'],
                    nginxSha=tool.digest(cutover.VHOST), producerVerified=False,
                    frontendSnippetVerified=True, recoveredFrom='promote-attempt',
                    originalAttemptSha=tool.digest(attempt_path), cutoverArtifactSha=CUTOVER_SHA,
                    verificationArtifactSha=tool.digest(Path(__file__).resolve()))
    print('PUBLIC READY VERIFIED: existing native promotion confirmed; only missing receipt written. No restart, nginx reload, migration or data deletion. Real playback/Grafana acceptance still required.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--ack')
    args = parser.parse_args()
    if not hasattr(os, 'geteuid') or os.geteuid() != 0:
        raise RuntimeError('Operator sudo required to verify root-owned transaction receipts')
    # Import only the exact cutover artifact that performed the original attempt.
    path = ROOT / 'wotcv-native-cutover.py'
    if path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest() != CUTOVER_SHA:
        raise RuntimeError('Attempted cutover artifact changed; review provenance')
    import importlib.util
    spec = importlib.util.spec_from_file_location('attempted_native_cutover', path)
    cutover = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(cutover)
    tool = cutover.load_module('sealed_native_installer', ROOT / 'wotcv-fresh-install.py', cutover.INSTALLER_SHA)
    private = cutover.load_module('sealed_private_phase', ROOT / 'wotcv-close-private-signup.py', cutover.PRIVATE_SHA)
    tool.state_root(str(ROOT))
    import fcntl
    fd = os.open('/home/wotcv/.rybbit-wotcv-native-install.lock', os.O_CREAT | os.O_APPEND | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        execute(tool, private, cutover, args.apply, args.ack)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        message = str(error) if type(error).__name__ == 'Refused' else 'Verification did not complete; inspect preserved transaction evidence'
        print('REFUSED: ' + message + '. No automatic restart, reload or deletion.', file=sys.stderr)
        sys.exit(1)
