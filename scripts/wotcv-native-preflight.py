#!/usr/bin/env python3
"""Read-only operator preflight for the existing native installation.

Print only runtime identities, configuration equality, migration hashes and
backup availability. No credentials, user records, raw logs or environment.
Does not install tooling, start services, apply migrations or create backups.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sys


def safe_identity(snapshot):
    result = {}
    for field, pattern in [('id', r'[0-9a-f]{64}'), ('image', r'sha256:[0-9a-f]{64}'),
                           ('started', r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z')]:
        value = snapshot.get(field)
        result[field] = value if isinstance(value, str) and re.fullmatch(pattern, value) else '[invalid]'
    value = snapshot.get('restarts')
    result['restarts'] = value if type(value) is int and 0 <= value <= 1000000000 else '[invalid]'
    return result


def compare_receipt(receipt, live):
    """Only closed field names and validated identities may leave private state."""
    fields = ('id', 'image', 'mounts', 'volume', 'started', 'restarts')
    result = {'phaseActive': receipt.get('phase') == 'active', 'databases': {}, 'applications': {}}
    stored = receipt.get('runtime')
    images = receipt.get('images')
    result['runtimeObjectValid'] = isinstance(stored, dict)
    result['imagesObjectValid'] = isinstance(images, dict)
    for name in ('postgres', 'clickhouse', 'redis'):
        before = stored.get(name) if isinstance(stored, dict) else None
        if not isinstance(before, dict):
            result['databases'][name] = {'snapshotObjectValid': False}
            continue
        actual = live[name]
        result['databases'][name] = {
            'snapshotObjectValid': True, 'exactMatch': before == actual,
            'differentFields': [key for key in fields if before.get(key) != actual.get(key)],
            'missingFieldCount': len(set(actual) - set(before)),
            'extraFieldCount': len(set(before) - set(actual)),
            'recorded': safe_identity(before), 'current': safe_identity(actual),
        }
    for name in ('backend', 'client'):
        value = images.get(name) if isinstance(images, dict) else None
        result['applications'][name] = {
            'imageMatches': value == live[name]['image'],
            'recordedImage': value if isinstance(value, str) and re.fullmatch(r'sha256:[0-9a-f]{64}', value) else '[invalid]',
            'currentImage': safe_identity(live[name])['image'],
        }
    return result


def private_receipt_directory(path):
    if path.is_symlink() or not path.is_dir() or path.resolve() != path:
        raise ValueError('unexpected receipt directory')
    metadata = path.stat()
    if metadata.st_uid != 0 or metadata.st_mode & 0o077:
        raise ValueError('unexpected receipt directory ownership/mode')


def receipt_diagnostic(native, live):
    active = native.STATE / 'active.json'
    result = {'activeReceiptExists': active.exists()}
    if not active.exists():
        result['code'] = 'receipt.promotion_branch_requires_inspection'
        return result
    try:
        private_receipt_directory(native.STATE)
        native.private(active)
        if active.stat().st_uid != 0 or active.stat().st_size > 2000000:
            raise ValueError('unexpected receipt file')
        receipt = json.loads(active.read_bytes())
        if not isinstance(receipt, dict):
            raise ValueError('unexpected receipt structure')
        result.update(compare_receipt(receipt, live))
        result['code'] = 'receipt.active.compared'
        release = receipt.get('release')
        if isinstance(release, str) and re.fullmatch(r'rybbit-native-update-[0-9]{8}T[0-9]{6}Z\.[0-9a-f]{8}', release):
            directory = native.STATE / release
            private_receipt_directory(directory)
            success = directory / 'success.json'
            native.private(success)
            if success.stat().st_uid != 0 or success.stat().st_size > 2000000:
                raise ValueError('unexpected success receipt')
            result['successReceiptMatchesActive'] = json.loads(success.read_bytes()) == receipt
        else:
            result['successReceiptMatchesActive'] = False
    except Exception:
        result['inspectionComplete'] = False
        result['code'] = 'receipt.active.private_file_or_structure_check_failed'
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--expected-updater-sha256', required=True)
    parser.add_argument('--diagnose-receipt', action='store_true',
                        help='Report private receipt comparisons and independent read-only checks; never clears HOLD')
    args = parser.parse_args()
    if not hasattr(os, 'geteuid') or os.geteuid() != 0:
        print('HOLD: run the reviewed preflight with operator sudo')
        return 1
    tool = Path('/usr/local/lib/wotcv-rybbit-native/update.py')
    if (tool.is_symlink() or tool.stat().st_uid != 0 or
            tool.stat().st_mode & 0o022):
        print('HOLD: installed updater ownership/mode is unexpected')
        return 1
    actual_hash = hashlib.sha256(tool.read_bytes()).hexdigest()
    if (len(args.expected_updater_sha256) != 64 or
            actual_hash != args.expected_updater_sha256):
        print('HOLD: installed updater differs from the reviewed digest; no import executed')
        return 1
    spec = importlib.util.spec_from_file_location('native_readonly', tool)
    native = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(native)
    report = {'operation': 'readonly-preflight',
              'updaterSha256': actual_hash, 'readyForActivation': False}
    stage = 'snapshot'
    try:
        live = native.snapshot()
        report['runtime'] = {n: {k: v for k, v in x.items()
                                 if k in ('id', 'image', 'started', 'restarts')}
                             for n, x in live.items()}
        report['pendingTransaction'] = (native.STATE / 'pending.json').exists()
        stage = 'receipt'
        try:
            native.receipt_guard(live)
            report['receiptMatchesRuntime'] = True
        except Exception:
            report['receiptMatchesRuntime'] = False
            if not args.diagnose_receipt:
                raise
        if args.diagnose_receipt:
            report['diagnosticOnly'] = True
            report['receiptDiagnostic'] = receipt_diagnostic(native, live)
        stage = 'configuration'
        env = native.current_env()
        native.private(env)
        model = native.config(env)
        native.model_guard(model, live)
        native.verify_model_live(model, live)
        report['effectiveConfigurationMatchesRuntime'] = True
        report['configurationSha256'] = native.digest(env)
        stage = 'migration-journal'
        # Container-local environment is consumed only by psql authentication.
        # It is neither expanded on the host nor included in argv/output.
        command = ['exec', live['postgres']['id'], 'sh', '-ec',
                   'export PGPASSWORD="$POSTGRES_PASSWORD"; '
                   'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" '
                   '-d "$POSTGRES_DB" -At -c '
                   '"SELECT created_at, hash FROM drizzle.__drizzle_migrations ORDER BY created_at, id"']
        output = native.docker(*command, timeout=30).decode()
        journal = []
        for line in output.splitlines():
            created, digest = line.split('|')
            if not (created.isdecimal() and len(digest) == 64 and
                    all(c in '0123456789abcdef' for c in digest)):
                raise ValueError('unexpected journal format')
            journal.append({'createdAt': created, 'sha256': digest})
        report['postgresAppliedMigrations'] = journal
        # No row data: hashes of SQL files and their migration timestamps only.
        js = ("const f=require('fs'),h=require('crypto');"
              "const j=JSON.parse(f.readFileSync('/app/drizzle/meta/_journal.json'));"
              "console.log(JSON.stringify(j.entries.map(e=>({createdAt:String(e.when),"
              "sha256:h.createHash('sha256').update(f.readFileSync('/app/drizzle/'+e.tag+'.sql')).digest('hex')}))))")
        output = native.docker('exec', live['backend']['id'], 'node', '-e', js, timeout=30)
        expected = json.loads(output)
        report['runtimeMigrationFiles'] = expected
        report['migrationJournalMatchesRuntimeFiles'] = journal == expected
        report['backupEvidence'] = 'NOT_VERIFIED: inspect native database artifacts and isolated restore evidence'
        report['readyForActivation'] = False
        report['next'] = ('verify backups/restore and the reviewed release contract; '
                          'this preflight never authorizes or activates a release')
        if not report['receiptMatchesRuntime']:
            report['result'] = 'HOLD: receipt mismatch remains; independent read-only checks do not approve activation'
        print(json.dumps(report, indent=2))
        return 0 if report['receiptMatchesRuntime'] and not report['pendingTransaction'] and journal == expected else 1
    except Exception:
        # Never expose exception/subprocess text: it can include secret values.
        report['result'] = 'HOLD: receipt/configuration/journal verification failed; inspect privately'
        report['failedStage'] = stage
        print(json.dumps(report, indent=2))
        return 1


if __name__ == '__main__':
    sys.dont_write_bytecode = True
    raise SystemExit(main())
