#!/usr/bin/env python3
"""Create protected native PG/Redis backups for the separate logging repair.

Default --check is read-only. --apply requires root, an owned maintenance gate
and a cleanly stopped backend. It never stops/starts applications, runs database
migrations, restores data or removes maintenance. Native verifiers use only the
already-running databases' exact local image IDs, with no network or writes.
"""

from __future__ import annotations

import argparse
from contextlib import ExitStack
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


SPEC = importlib.util.spec_from_file_location(
    "runtime_logging_backup_contract", Path(__file__).with_name("wotcv-reconcile-runtime-logging.py"))
RUNTIME = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNTIME)
ROOT = Path("/var/backups/wotcv-rybbit-runtime")
MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024


def stream_artifact(repo: Path, args: list[str], target: Path, *, data: bytes | None = None):
    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "wb") as output:
        # The native Docker CLI writes directly to this file; cap it BEFORE the
        # command starts, not after an unexpectedly large backup fills the disk.
        def limit_file_size():
            import resource
            resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_ARTIFACT_BYTES, MAX_ARTIFACT_BYTES))
        result = subprocess.run(args, cwd=repo, env=RUNTIME.environment(repo), input=data,
                                stdout=output, stderr=subprocess.DEVNULL, timeout=180,
                                preexec_fn=limit_file_size)
        output.flush()
        os.fsync(output.fileno())
    if result.returncode or not 0 < target.stat().st_size <= MAX_ARTIFACT_BYTES:
        raise RUNTIME.Refused("Native backup failed or exceeded its size bound; output remains private")


def native_verify(repo: Path, image: str, tool: str, artifact: Path, *arguments: str):
    if tool not in ("pg_restore", "redis-check-rdb") or not RUNTIME.IMAGE_ID.fullmatch(image):
        raise RUNTIME.Refused("Unsupported backup verification command")
    RUNTIME.command(repo, ["docker", "run", "--rm", "--pull", "never", "--network", "none",
                          "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
                          "--mount", f"type=bind,src={artifact},dst=/backup,readonly",
                          "--entrypoint", tool, image, *arguments, "/backup"], timeout=90)


def preflight(repo: Path, owner: str):
    RUNTIME.require_gate(owner)
    config, records, _ = RUNTIME.plan(repo)
    state = records["backend"]["State"]
    if state.get("Status") != "exited" or state.get("ExitCode") != 0:
        raise RUNTIME.Refused("Backend must already be cleanly stopped under the owned maintenance gate")
    return config, records


def require_root():
    if os.name != "posix" or os.geteuid() != 0:
        raise RUNTIME.Refused("Native runtime backup --apply requires Linux root")


def create(repo: Path, *, owner: str, apply=False, backup_root=ROOT):
    repo = repo.resolve(strict=True)
    if not apply:
        preflight(repo, owner)
        print("CHECK PASS: owned maintenance and stopped backend; no backups or other files created")
        return None
    require_root()
    if repo.stat().st_uid != RUNTIME.uid():
        raise RUNTIME.Refused("Repository must belong to the deployment user")
    locks = ((Path("/run/lock/wotcv-deploy.lock"), 0), (Path("/run/lock/wotcv-ops-install.lock"), 0),
             (Path("/var/log/wotcv-tools/rybbit/update.lock"), RUNTIME.uid()),
             (Path(f"/tmp/rybbit-wotcv-update-{RUNTIME.uid()}.lock"), RUNTIME.uid()))
    with ExitStack() as stack:
        for path, owner_uid in locks:
            stack.enter_context(RUNTIME.lock_file(path, owner_uid))
        config, records = preflight(repo, owner)
        postgres = RUNTIME.postgres_snapshot(repo, records["postgres"]["Id"])
        redis_before = RUNTIME.redis_snapshot(repo, records["redis"])
        RUNTIME.protected_directory(backup_root.parent, private=False)
        backup_root.mkdir(mode=0o700, exist_ok=True)
        RUNTIME.protected_directory(backup_root)
        # Repeat after an interrupted earlier attempt as well: existence does
        # not prove a prior mkdir's parent-directory fsync succeeded.
        RUNTIME.sync_directory(backup_root.parent, private=False)
        if shutil.disk_usage(backup_root).free < 3 * MAX_ARTIFACT_BYTES:
            raise RUNTIME.Refused("Insufficient free space for bounded protected native backups")
        directory = Path(tempfile.mkdtemp(prefix=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ-"), dir=backup_root))
        pg_dump = directory / "postgres.dump"
        globals_file = directory / "postgres-globals.sql"
        redis_dump = directory / "redis.rdb"
        print(f"Protected native backup: {directory}", flush=True)
        try:
            stream_artifact(repo, ["docker", "exec", records["postgres"]["Id"], "sh", "-ec",
                'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom'], pg_dump)
            stream_artifact(repo, ["docker", "exec", records["postgres"]["Id"], "sh", "-ec",
                'exec pg_dumpall -U "$POSTGRES_USER" --globals-only'], globals_file)
            cmd = records["redis"]["Config"]["Cmd"]
            # redis_snapshot already validates the explicit production auth setting.
            password = cmd[cmd.index("--requirepass") + 1]
            stream_artifact(repo, ["docker", "exec", "-i", records["redis"]["Id"], "sh", "-ec",
                'IFS= read -r REDISCLI_AUTH; export REDISCLI_AUTH; exec redis-cli --no-auth-warning --rdb -'],
                redis_dump, data=(password + "\n").encode())
            native_verify(repo, records["postgres"]["Image"], "pg_restore", pg_dump, "--list")
            native_verify(repo, records["redis"]["Image"], "redis-check-rdb", redis_dump)
            _, current = preflight(repo, owner)
            if RUNTIME.stable_runtime(current) != RUNTIME.stable_runtime(records):
                raise RUNTIME.Refused("Container state changed during native backups")
            pg_after = RUNTIME.postgres_snapshot(repo, current["postgres"]["Id"])
            redis_after = RUNTIME.redis_snapshot(repo, current["redis"])
            RUNTIME.compare_data(postgres, pg_after, redis_before, redis_after)
            value = {"schema": "wotcv-runtime-logging-backup-v1", "project": "rybbit",
                     "created_at": datetime.now(timezone.utc).isoformat()}
            for name, artifact, magic, verification in (
                ("postgres", pg_dump, b"PGDMP", "pg_restore --list"),
                ("redis", redis_dump, b"REDIS", "redis-check-rdb"),
            ):
                value[name] = {"container_id": records[name]["Id"], "image_id": records[name]["Image"],
                               "volume": f"rybbit_{name}-data", "verified_by": verification,
                               "archive": {"path": artifact.name, "sha256": RUNTIME.sha256_file(artifact, magic)}}
            value["postgres"]["system_identifier"] = postgres["system_identifier"]
            value["postgres"]["globals"] = {"path": globals_file.name,
                                             "sha256": RUNTIME.sha256_file(globals_file, b"")}
            manifest = directory / "manifest.json"
            pending_manifest = directory / "manifest.pending.json"
            RUNTIME.write_json(pending_manifest, value)
            # Reuse the consumer's independent native-archive and identity checks.
            RUNTIME.verify_backup(repo, pending_manifest, current, pg_after)
            os.replace(pending_manifest, manifest)
            RUNTIME.sync_directory(directory)
            RUNTIME.sync_directory(backup_root)
        except BaseException:
            # Publication is not successful until its directory entries have
            # been synced. Never leave the normal consumer path usable after
            # a late fsync failure, even when the rename already succeeded.
            published = directory / "manifest.json"
            if published.exists():
                os.replace(published, directory / "manifest.invalid.json")
            RUNTIME.write_json(directory / "failed.json", {"usableBackupManifest": False,
                               "maintenanceLeftActive": True, "noDataRestoreOrBackendStart": True})
            print("BACKUP FAILED: files remain private; do not use them for logging reconciliation", file=sys.stderr)
            raise
        print(f"VERIFIED native backup manifest: {manifest}")
        print("Native archive checks passed; this is not a full restore drill. Backend remains stopped; maintenance active.")
        return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path("/home/rybbit-wotcv"))
    parser.add_argument("--owner", required=True)
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--check", action="store_true")
    action.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    try:
        create(args.repo, owner=args.owner, apply=args.apply)
    except (RUNTIME.Refused, OSError, ValueError, TypeError, KeyError, IndexError, subprocess.SubprocessError) as error:
        print(f"REFUSED: {error}" if isinstance(error, RUNTIME.Refused)
              else "REFUSED: native backup failed; sensitive details withheld", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
