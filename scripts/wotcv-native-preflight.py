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
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--expected-updater-sha256', required=True)
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
              'updaterSha256': actual_hash}
    try:
        live = native.snapshot()
        report['runtime'] = {n: {k: v for k, v in x.items()
                                 if k in ('id', 'image', 'started', 'restarts')}
                             for n, x in live.items()}
        report['pendingTransaction'] = (native.STATE / 'pending.json').exists()
        native.receipt_guard(live)
        report['receiptMatchesRuntime'] = True
        env = native.current_env()
        native.private(env)
        model = native.config(env)
        native.model_guard(model, live)
        native.verify_model_live(model, live)
        report['effectiveConfigurationMatchesRuntime'] = True
        report['configurationSha256'] = native.digest(env)
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
        print(json.dumps(report, indent=2))
        return 0 if not report['pendingTransaction'] and journal == expected else 1
    except Exception:
        # Never expose exception/subprocess text: it can include secret values.
        report['result'] = 'HOLD: receipt/configuration/journal verification failed; inspect privately'
        print(json.dumps(report, indent=2))
        return 1


if __name__ == '__main__':
    sys.dont_write_bytecode = True
    raise SystemExit(main())
