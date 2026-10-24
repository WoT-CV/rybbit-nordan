# WoT-CV: maintenance, runtime logging and reviewed operations hotfixes

## Scope and non-goals

The 2026-10-24 audit confirmed Rybbit 2.9.1 at `d3eb3fca` was healthy, but
PostgreSQL/Redis still had unbounded Docker logging options, the updater recreated
unchanged ClickHouse while the old backend was serving, and two retained utilities
differed from their original operations manifest. The optional AppSumo lookup
also queried a cloud-only schema in self-hosted installations.

These changes do not increase HTTP/body limits, introduce a body archive,
remove historic replay bodies, or change the metadata/gzip rollout. They do not
promise zero downtime: this single-instance installation uses a bounded,
explicit maintenance response, not a blue/green database deployment.

Code and production state are different. Source changes must be reviewed and
published separately. A prepared script, successful unit test, or `--check`
does not mean the root installation, database-container recreation, or new
application images have been deployed.

## Deployment sequence

1. Validate the installed tracking-only maintenance gate and its ownership.
   Refuse another operation's active gate. An explicitly supplied
   `WOTCV_MAINTENANCE_OWNER` can resume only that same owned gate.
2. Validate clean Git state, effective ports, external storage and both declared
   **and actual infrastructure-container** log rotation. Refuse logging drift
   before building images or changing containers; do not recreate a database
   automatically to fix it.
3. Build/pull and validate application images while the old application serves.
4. Compare ClickHouse/Redis immutable image IDs, Compose hashes and mounted
   configuration bytes. Leave unchanged infrastructure running.
5. Enter the owned maintenance gate. The origin must actually respond with
   HTTP 503, `Retry-After: 15`, `Cache-Control: no-store` and `noindex` before
   any application drain or infrastructure replacement is allowed.
6. Preserve Better Auth cutover checks and drain the backend cleanly. A forced
   stop/nonzero exit refuses shared-infrastructure changes.
7. Perform the deployment's existing reviewed migration step, then apply only
   required infrastructure changes and replace the application containers.
8. Require the expected backend SHA/tag, client `/login` **HTTP 200**, data and
   storage invariants, Identity Resolution and actual all-five logging checks.
9. Write deployment state and only then remove the same owned gate. Verified
   rollback must pass equivalent readiness checks. An unverified failure keeps
   maintenance active for explicit recovery.

Repository guidance forbids the agent from running database migration scripts.
The implementation preserves the existing operator-run deployment step; tests
fake deployment commands. Agent validation must not execute a real updater.

## One-time root setup (does not restart application containers)

Only after review/publication, fast-forward the clean server checkout to the
reviewed `origin/feat/wotcv` without invoking the updater. Preserve all unrelated
local changes; never use `reset --hard`, `assume-unchanged` or `skip-worktree`.

```bash
cd /home/rybbit-wotcv
git status --short --branch
git fetch origin
git merge --ff-only origin/feat/wotcv

sudo python3 scripts/wotcv-maintenance.py install --check
sudo python3 scripts/wotcv-maintenance.py install
sudo python3 scripts/wotcv-attest-ops-hotfixes.py --check
sudo python3 scripts/wotcv-attest-ops-hotfixes.py --apply
```

The gate installer accepts only the exact inspected tracking vhost and its
dedicated noindex snippet. It retains both 410 manifests and noindex headers,
creates a protected backup under `/var/backups/wotcv-rybbit-maintenance`, tests
Nginx and reloads **Nginx only**. Unknown vhost/snippet edits are refused rather
than overwritten. `/etc/tmpfiles.d/wotcv-rybbit-maintenance.conf` re-creates the
deployment-owned runtime flag directory after reboot; an active flag is not
silently deleted by a failed operation. The flag is stored persistently under
`/var/lib/wotcv-rybbit-maintenance`, not ephemeral `/run`; restarting the host
must not silently reopen a failed maintenance window. Enter/leave and directory
creation include directory durability barriers. Recovery still requires the
explicit original owner and application readiness checks.

The operations attestation keeps the original manifest unchanged. It proves the
exact cleanup argument guard by reconstructing the original file hash and checks
the updater against its committed reviewed source. Only the two known hotfixes
are accepted; any additional difference is refused. The additive root-private
receipt covers manifest-listed files only, not generated/unlisted files. The
legacy cleanup program is **never executed** for verification.

## Separate PostgreSQL/Redis logging maintenance

This operation needs an approved maintenance window and an operator present.
It stops collection until the application update has succeeded. Do not run it
concurrently with deployments, cleanup or manual Docker operations. The tools
take the existing global deployment/install and both updater locks, but those
locks cannot prevent someone bypassing them with a raw Docker command.

First confirm setup and read the check result:

```bash
cd /home/rybbit-wotcv
python3 scripts/wotcv-maintenance.py status
python3 scripts/wotcv-reconcile-runtime-logging.py --check
```

If and only if the check identifies the reviewed PostgreSQL/Redis logging drift:

```bash
python3 scripts/wotcv-maintenance.py enter --owner logs-20261024
docker stop --timeout 60 backend
docker inspect backend --format '{{.State.Running}} {{.State.ExitCode}}'
```

The last command must report `false 0`; otherwise stop and diagnose the drain.
Do not force a failed backend stop through the checks.

```bash
sudo python3 scripts/wotcv-create-runtime-backup.py --apply --owner logs-20261024
```

This creates a new root-private backup directory and prints the **exact** path
to `manifest.json`. PostgreSQL custom-format dump and globals plus a Redis RDB
snapshot are hashed and checked with native tools from the exact existing local
images. Verification helpers have no network, no writable filesystem, no
capabilities and no database startup entrypoint. Backup output is size/time
bounded. This is native archive verification, **not a full restore rehearsal**.

Use the printed path, not a guessed path or a previous cutover's backup:

```bash
sudo python3 scripts/wotcv-reconcile-runtime-logging.py --apply \
  --owner logs-20261024 \
  --ack maintenance-window-backup-verified \
  --backup-manifest /var/backups/wotcv-rybbit-runtime/EXACT-PRINTED-DIRECTORY/manifest.json
```

The tool verifies fresh backups, unchanged live configuration, exact local image
IDs, the existing external volumes, ports, PostgreSQL cluster/count invariants,
Redis durable AOF/logical values/expirations and ClickHouse identity reconnection.
It can recreate **only PostgreSQL and/or Redis**. It never pulls/builds images,
restores database data, runs migrations, starts the backend, or opens maintenance.
Original runtime and a pinned configuration-only rollback plan are retained in
the printed root-private audit directory. An invariant failure stops immediately
and requires operator review, not automatic restoration over current data.

The preflight compares effective runtime values, not just the JSON's spelling.
Compose `command: null` / `entrypoint: null` inherit image defaults; empty
instructions are different. See the [official service contract](https://docs.docker.com/reference/compose-file/services/#command).
The inspected Compose 5.6.1 also doubles dollar signs in its entire serialized
`config --format json` output, including mapping keys, as implemented in
[the CLI exporter](https://github.com/docker/compose/blob/v5.6.1/cmd/compose/config.go#L182).
Only known config-export bytes are decoded once. Docker inspect, backup records
and actual mounted file bytes are never decoded. Candidate/rollback sources
escape literal values once, are rendered again without creating containers, and
must match the original runtime values. Genuine `$` and `$$` in credentials,
commands, health checks and labels must survive unchanged.

Resume the reviewed updater with the **same** explicit owner. This command is
operator-run; it executes the updater's existing application deployment and
migration flow, unlike the logging-only tools above:

```bash
sudo env WOTCV_MAINTENANCE_OWNER=logs-20261024 \
  bash /home/wotcv/tools/update_rybbit_wotcv.sh
```

Only a verified successful deployment/rollback removes that owner's gate. If it
fails, keep maintenance active, retain all backups/audits and inspect the actual
log. Do not `docker start backend` blindly: its normal entrypoint runs migrations.
Do not remove the flag simply to make a health probe green.

## AppSumo, artifact provenance and remaining functional evidence

Both actual AppSumo license-query boundaries return without a query outside
cloud mode. Custom plans, `appsumo-*`/Stripe-plan overrides, cloud lookup errors
and subscription precedence remain unchanged and have regression tests. No
AppSumo tables are created for self-hosted Rybbit.

The separate WoT-CV Java backend was running `fb52882a` while its filesystem
checkout was the older `75b763ae`. This is not an outdated runtime. Audit the
running JAR's opened file descriptor and `git.properties`, then use the exact
runtime Git commit for source review. Do not overwrite a deployment checkout,
ignored configuration, running JAR or another deployment's checkout merely to
silence a diagnostic warning. A matching diagnostic source worktree can be
created separately and is not an application deployment. The audit worktree
created during this repair is:

```text
/home/wotcv/runtime-sources/wot-cv-be/fb52882a56304a7ad561659bbfbf3ec4b5dd3634
```

`audit-replay-runtime.mjs --live` resolves the running artifact to a full existing
Git commit without fetching and inspects only that commit's exact diagnostic
path. It checks the common Git directory, HEAD, nonsymlink path and clean state,
including untracked files. `runtimeSourceVerified: true` means matching clean
diagnostic source, not a new Java deployment. The canonical checkout still
truthfully reports `provenance: "mismatch"` while its SHA remains older.

Neither gzip capability/config/CORS nor matching correlation IDs establish the
compressed bytes actually sent by a browser or complete durable body coverage.
The accepted no-archive variant still explicitly omits oversized bodies. Finish
with logged-in replay/export smoke, a physical iPhone seek/speed check and a
specific Grafana link after deployment. Do not mark those checks PASS based on
an anonymous health endpoint.
