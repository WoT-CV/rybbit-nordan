#!/usr/bin/env python3
"""Explicitly continue the reviewed PG-complete/Redis-pending logging repair.

Apply-only, root-only and maintenance-owned. Original evidence is never edited.
A fresh backup is created only after historical continuity is proven, and the
same proof is rechecked under the repair locks immediately before Redis changes.
This never starts backend, leaves maintenance, restores data or runs migrations.
"""

from __future__ import annotations

import argparse
import copy
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

SPEC = importlib.util.spec_from_file_location(
    "runtime_logging_resume_backup", Path(__file__).with_name("wotcv-create-runtime-backup.py"))
BACKUP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BACKUP)
RUNTIME = BACKUP.RUNTIME
AUDIT_FILES = ("runtime.before.json", "postgres.before.json", "redis.before.json", "backup-evidence.json",
               "candidate.compose.json", "recovery.json", "failure.json")


def read_evidence(path: Path):
    RUNTIME.protected_directory(path.parent)
    with RUNTIME.protected_open(path) as stream:
        raw = stream.read(8 * 1024 * 1024 + 1)
    if len(raw) > 8 * 1024 * 1024:
        raise RUNTIME.Refused("Historical recovery evidence exceeds its size bound")
    return raw, json.loads(raw)


def equal(left, right):
    return json.dumps(left, sort_keys=True, allow_nan=False) == json.dumps(right, sort_keys=True, allow_nan=False)


class HistoricalGuard:
    def __init__(self, repo: Path, audit: Path, manifest: Path, owner: str, postgres_id: str):
        if not RUNTIME.CONTAINER_ID.fullmatch(postgres_id):
            raise RUNTIME.Refused("An exact accepted replacement PostgreSQL ID is required")
        self.repo, self.audit, self.manifest, self.owner = repo, audit, manifest, owner
        self.postgres_id = postgres_id
        self.frozen = None
        self.hashes = {}
        self.values = {}
        self.implementation_paths = {"resume": Path(__file__), "runtime": Path(RUNTIME.__file__),
                                     "backup": Path(BACKUP.__file__)}
        self.implementation_hashes = {name: hashlib.sha256(path.read_bytes()).hexdigest()
                                      for name, path in self.implementation_paths.items()}
        for name in AUDIT_FILES:
            raw, value = read_evidence(audit / name)
            self.hashes[name] = hashlib.sha256(raw).hexdigest()
            self.values[name] = value
        raw, self.backup = read_evidence(manifest)
        self.manifest_hash = hashlib.sha256(raw).hexdigest()
        self.original = self.values["runtime.before.json"]
        self.pg_before = self.values["postgres.before.json"]
        self.redis_before = self.values["redis.before.json"]
        recovery = self.values["recovery.json"]
        failure = self.values["failure.json"]
        if (set(self.original) != set(RUNTIME.SERVICES)
                or recovery.get("maintenanceOwner") != owner
                or recovery.get("maintenanceMustRemainActive") is not True
                or recovery.get("backendMustRemainStopped") is not True
                or recovery.get("requiredNativeEngine") != RUNTIME.NATIVE_ENGINE
                or recovery.get("requiredNativeCompose") != RUNTIME.NATIVE_COMPOSE
                or failure.get("requiresOperatorReview") is not True
                or failure.get("automaticDataOrConfigurationRestore") is not False
                or not equal(self.backup, self.values["backup-evidence.json"])):
            raise RUNTIME.Refused("Historical failed-audit/backup provenance does not match this operation")
        if self.original["postgres"]["Id"] == postgres_id:
            raise RUNTIME.Refused("Continuation requires the explicitly accepted PostgreSQL replacement")

    def verify_evidence(self, *, before_replacement=True):
        for name, path in self.implementation_paths.items():
            if hashlib.sha256(path.read_bytes()).hexdigest() != self.implementation_hashes[name]:
                raise RUNTIME.Refused("Reviewed continuation implementation changed during recovery")
        if ((self.audit / "success.json").exists() or (self.manifest.parent / "failed.json").exists()):
            raise RUNTIME.Refused("Historical evidence records success or failed backup; continuation refused")
        for name, checksum in self.hashes.items():
            raw, _ = read_evidence(self.audit / name)
            if hashlib.sha256(raw).hexdigest() != checksum:
                raise RUNTIME.Refused("Historical audit changed during recovery")
        raw, value = read_evidence(self.manifest)
        if hashlib.sha256(raw).hexdigest() != self.manifest_hash or not equal(value, self.backup):
            raise RUNTIME.Refused("Original backup manifest changed during recovery")
        created = datetime.fromisoformat(value["created_at"].replace("Z", "+00:00"))
        age = (datetime.now(timezone.utc) - created).total_seconds()
        # Reserve a short freshness margin BEFORE replacement, not a longer age
        # allowance. The original six-hour limit is never increased.
        maximum_age = RUNTIME.MAX_BACKUP_AGE - (300 if before_replacement else 0)
        if (value.get("schema") != "wotcv-runtime-logging-backup-v1" or value.get("project") != RUNTIME.PROJECT
                or age < 0 or age > maximum_age):
            raise RUNTIME.Refused("Original backup is invalid, expired or lacks the pre-replacement freshness margin")
        for name, magic, verifier in (("postgres", b"PGDMP", "pg_restore --list"), ("redis", b"REDIS", "redis-check-rdb")):
            item = value[name]
            before = self.original[name]
            if (item["container_id"] != before["Id"] or item["image_id"] != before["Image"]
                    or item["volume"] != "rybbit_" + name + "-data" or item["verified_by"] != verifier):
                raise RUNTIME.Refused("Original backup is not bound to the original database runtime")
            for field in (("archive", "globals") if name == "postgres" else ("archive",)):
                artifact = item[field]
                filename = artifact["path"]
                if (not isinstance(filename, str) or filename in ("", ".", "..") or Path(filename).name != filename
                        or not isinstance(artifact["sha256"], str) or not RUNTIME.SHA256.fullmatch(artifact["sha256"])):
                    raise RUNTIME.Refused("Original backup artifact is not a direct hashed filename")
                if RUNTIME.sha256_file(self.manifest.parent / filename, magic if field == "archive" else b"") != artifact["sha256"]:
                    raise RUNTIME.Refused("Original backup artifact changed during recovery")
        if value["postgres"]["system_identifier"] != self.pg_before["system_identifier"]:
            raise RUNTIME.Refused("Original backup PostgreSQL cluster identity differs from the original audit")

    def __call__(self, supplied: dict, phase: str):
        if phase not in ("initial", "preflight", "before-redis", "after"):
            raise RUNTIME.Refused("Unknown historical recovery phase")
        RUNTIME.require_gate(self.owner)
        state = supplied["backend"]["State"]
        if state.get("Status") != "exited" or state.get("Running") is not False or state.get("ExitCode") != 0:
            raise RUNTIME.Refused("Historical recovery requires backend to remain cleanly stopped")
        self.verify_evidence(before_replacement=phase != "after")
        config, current, drift = RUNTIME.plan(self.repo)
        if not equal(RUNTIME.stable_runtime(supplied), RUNTIME.stable_runtime(current)):
            raise RUNTIME.Refused("Runtime changed at the historical recovery boundary")
        if drift != (() if phase == "after" else ("redis",)):
            raise RUNTIME.Refused("Historical continuation permits exactly Redis-only logging repair")
        pg = current["postgres"]
        if (pg["Id"] != self.postgres_id or pg["Image"] != self.original["postgres"]["Image"]
                or not equal(RUNTIME.preserved_config(pg), RUNTIME.preserved_config(self.original["postgres"]))
                or pg["HostConfig"].get("LogConfig") != RUNTIME.EXPECTED_RUNTIME_LOGGING
                or pg["State"].get("Running") is not True
                or pg["State"].get("Health", {}).get("Status") != "healthy"):
            raise RUNTIME.Refused("Accepted PostgreSQL transition changed more than the reviewed representation/logging")
        for name in ("backend", "client", "clickhouse"):
            if not equal(RUNTIME.stable_runtime({name: current[name]}), RUNTIME.stable_runtime({name: self.original[name]})):
                raise RUNTIME.Refused("An untouched application or ClickHouse runtime changed since the original audit")
        frozen_names = ("postgres", "backend", "client", "clickhouse")
        frozen = RUNTIME.stable_runtime({name: current[name] for name in frozen_names})
        if self.frozen is not None and not equal(self.frozen, frozen):
            raise RUNTIME.Refused("PostgreSQL or an untouched service changed during continuation")
        redis = current["redis"]
        old_redis = self.original["redis"]
        if phase != "after":
            if not equal(RUNTIME.stable_runtime({"redis": redis}), RUNTIME.stable_runtime({"redis": old_redis})):
                raise RUNTIME.Refused("Redis changed before its explicitly authorized replacement")
        elif (redis["Id"] == old_redis["Id"] or redis["Image"] != old_redis["Image"]
                or not equal(RUNTIME.preserved_config(redis), RUNTIME.preserved_config(old_redis))
                or redis["HostConfig"].get("LogConfig") != RUNTIME.EXPECTED_RUNTIME_LOGGING
                or redis["State"].get("Running") is not True
                or redis["State"].get("Health", {}).get("Status") != "healthy"):
            raise RUNTIME.Refused("Redis replacement changed more than the reviewed logging transition")
        rendered = RUNTIME.decode_compose_export(RUNTIME.command(self.repo, [
            *RUNTIME.pinned_compose_command(self.audit / "candidate.compose.json"), "config", "--format", "json"]))
        if not equal(rendered, RUNTIME.pinned_compose(config, self.original, rollback=False)):
            raise RUNTIME.Refused("Compose configuration changed since the original repair plan")
        pg_now = RUNTIME.postgres_snapshot(self.repo, pg["Id"])
        redis_now = RUNTIME.redis_snapshot(self.repo, redis)
        RUNTIME.compare_data(self.pg_before, pg_now, self.redis_before, redis_now)
        if (any(pg_now[key] != self.pg_before[key] for key in ("users", "sites", "aliases"))
                or not equal(pg_now.get("alias"), self.pg_before.get("alias"))):
            raise RUNTIME.Refused("PostgreSQL counts or identity sample changed during the stopped-backend window")
        dictionary_verified = False
        if phase == "after":
            # This is operator-authorized apply, not a read-only diagnostic.
            # Close the pending PG/CH DNS/dictionary reconnection explicitly.
            RUNTIME.verify_identity(self.repo, current, self.pg_before["alias"])
            dictionary_verified = True
        RUNTIME.require_gate(self.owner)
        if not equal(RUNTIME.stable_runtime(current), RUNTIME.stable_runtime(RUNTIME.inspect_owned(self.repo))):
            raise RUNTIME.Refused("Runtime changed during historical data/identity verification")
        if self.frozen is None:
            self.frozen = copy.deepcopy(frozen)
        return {"schema": "wotcv-runtime-logging-historical-continuation-v1", "phase": phase,
                "historicalAudit": str(self.audit), "originalBackupManifest": str(self.manifest),
                "historicalAuditFileHashes": copy.deepcopy(self.hashes), "originalBackupManifestSha256": self.manifest_hash,
                "implementationSha256": copy.deepcopy(self.implementation_hashes),
                "originalPostgresId": self.original["postgres"]["Id"], "acceptedPostgresId": self.postgres_id,
                "originalRedisId": old_redis["Id"], "currentRedisId": redis["Id"],
                "originalArtifactHashesVerified": True, "originalDataInvariantsPreserved": True,
                "postgresCountsAndAliasPreserved": True, "untouchedServicesPreserved": True,
                "clickhouseReconnectionVerified": dictionary_verified,
                "backendStarted": False, "maintenanceRemoved": False, "dataRestored": False}

    def native_verify_original_archives(self, records):
        # Never target the removed PostgreSQL container. Same-image identity and
        # original hashes were proven by the initial guard before these checks.
        with RUNTIME.protected_open(self.manifest.parent / self.backup["postgres"]["archive"]["path"]) as stream:
            RUNTIME.command(self.repo, ["docker", "exec", "-i", records["postgres"]["Id"], "pg_restore", "--list"], stdin=stream)
        BACKUP.native_verify(self.repo, records["redis"]["Image"], "redis-check-rdb",
                             self.manifest.parent / self.backup["redis"]["archive"]["path"])


def resume(repo: Path, audit: Path, manifest: Path, owner: str, postgres_id: str, ack: str, *, apply=False):
    if not apply:
        raise RUNTIME.Refused("Continuation is apply-only; use the separate read-only diagnosis first")
    repo = repo.resolve(strict=True)
    RUNTIME.require_apply_authority(repo, ack, manifest)
    RUNTIME.require_gate(owner)
    guard = HistoricalGuard(repo, audit, manifest, owner, postgres_id)
    records = RUNTIME.inspect_owned(repo)
    guard(records, "initial")
    guard.native_verify_original_archives(records)
    # New directory/manifest, never a rewritten historical container ID. The
    # original transition is rechecked under reconcile's locks after this gap.
    fresh_manifest = BACKUP.create(repo, owner=owner, apply=True)
    result = RUNTIME.reconcile(repo, apply=True, owner=owner, ack=ack,
                               backup_manifest=fresh_manifest, recovery_guard=guard)
    print(f"HISTORICAL CONTINUATION VERIFIED: {result}")
    print("PostgreSQL was not recreated; Redis logging and original data/identity invariants verified. "
          "Backend remains stopped and maintenance active. No migration, data restore or application deployment run.")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path("/home/rybbit-wotcv"))
    parser.add_argument("--audit", type=Path, required=True)
    parser.add_argument("--backup-manifest", type=Path, required=True)
    parser.add_argument("--owner", required=True)
    parser.add_argument("--expected-postgres-id", required=True)
    parser.add_argument("--ack", choices=(RUNTIME.ACK,), required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    try:
        resume(args.repo, args.audit, args.backup_manifest, args.owner, args.expected_postgres_id, args.ack, apply=args.apply)
    except (RUNTIME.Refused, OSError, ValueError, TypeError, KeyError, AttributeError, IndexError, subprocess.SubprocessError) as error:
        print("REFUSED: " + (str(error) if isinstance(error, RUNTIME.Refused)
                              else "historical continuation failed; sensitive details withheld"), file=sys.stderr)
        print("No backend start or maintenance removal was attempted; verify their current state before any recovery.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
