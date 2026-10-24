#!/usr/bin/env python3
"""Read-only, credential-free diagnosis of a partially completed logging repair.

This is not a repair/resume authorization. It never recreates containers, writes
evidence, restores data, reloads dictionaries, starts backend or removes a gate.
"""

from __future__ import annotations

import argparse
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

SPEC = importlib.util.spec_from_file_location(
    "runtime_logging_diagnostic_contract", Path(__file__).with_name("wotcv-reconcile-runtime-logging.py"))
RUNTIME = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNTIME)


def read_private_json(path: Path):
    RUNTIME.protected_directory(path.parent)
    with RUNTIME.protected_open(path) as stream:
        raw = stream.read(8 * 1024 * 1024 + 1)
    if len(raw) > 8 * 1024 * 1024:
        raise RUNTIME.Refused("Protected diagnostic input exceeds its bound")
    return json.loads(raw)


def changed_paths(before, after, path="", limit=128):
    """Report structural paths only, never values from inspected secrets."""
    result = []
    def visit(a, b, prefix):
        if len(result) >= limit:
            return
        if type(a) is not type(b):
            result.append(prefix or "/")
        elif isinstance(a, dict):
            for key in sorted(set(a) | set(b)):
                child = prefix + "/" + str(key).replace("~", "~0").replace("/", "~1")
                if key not in a or key not in b:
                    result.append(child)
                else:
                    visit(a[key], b[key], child)
                if len(result) >= limit:
                    break
        elif isinstance(a, list):
            if len(a) != len(b):
                result.append(prefix + "/length")
            for index, (left, right) in enumerate(zip(a, b)):
                visit(left, right, prefix + "/" + str(index))
        elif a != b:
            result.append(prefix or "/")
    visit(before, after, path)
    return result[:limit]


def unique_environment(record):
    entries = record["Config"].get("Env")
    if not isinstance(entries, list):
        raise RUNTIME.Refused("Diagnostic environment is not a list")
    result = {}
    for entry in entries:
        if not isinstance(entry, str) or "=" not in entry:
            raise RUNTIME.Refused("Diagnostic environment contains a malformed entry")
        name, value = entry.split("=", 1)
        if not name or name in result:
            raise RUNTIME.Refused("Diagnostic environment contains an empty or duplicate name")
        result[name] = value
    return result


def require_root():
    if os.name != "posix" or os.geteuid() != 0:
        raise RUNTIME.Refused("Protected logging diagnosis requires Linux root")


def diagnose(repo: Path, audit: Path, owner: str):
    require_root()
    repo = repo.resolve(strict=True)
    RUNTIME.require_gate(owner)
    original = read_private_json(audit / "runtime.before.json")
    pg_before = read_private_json(audit / "postgres.before.json")
    redis_before = read_private_json(audit / "redis.before.json")
    recovery = read_private_json(audit / "recovery.json")
    if recovery.get("maintenanceOwner") != owner:
        raise RUNTIME.Refused("Original audit belongs to another maintenance owner")
    if (audit / "success.json").exists():
        raise RUNTIME.Refused("Audit records success, not the expected partial failure")
    read_private_json(audit / "failure.json")
    current = RUNTIME.inspect_owned(repo)
    backend = current["backend"]["State"]
    if backend.get("Status") != "exited" or backend.get("Running") is not False or backend.get("ExitCode") != 0:
        raise RUNTIME.Refused("Backend must remain cleanly stopped for diagnosis")
    before = RUNTIME.preserved_config(original["postgres"])
    after = RUNTIME.preserved_config(current["postgres"])
    projected = copy.deepcopy(current)
    dns = []
    for field in ("Dns", "DnsOptions", "DnsSearch"):
        old = original["postgres"]["HostConfig"]
        new = projected["postgres"]["HostConfig"]
        if field in old and field in new and old[field] == [] and new[field] is None:
            new[field] = []
            dns.append(field)
    env_before = unique_environment(original["postgres"])
    env_after = unique_environment(current["postgres"])
    remaining = changed_paths(before, RUNTIME.preserved_config(projected["postgres"]))
    # This extra projection is diagnostic ONLY, not a relaxed production guard.
    env_projection = copy.deepcopy(projected["postgres"])
    if env_before == env_after:
        env_projection["Config"]["Env"] = copy.deepcopy(original["postgres"]["Config"]["Env"])
    other_changes = [name for name in RUNTIME.SERVICES if name != "postgres" and
                     RUNTIME.stable_runtime({name: original[name]}) != RUNTIME.stable_runtime({name: current[name]})]
    pg_after = RUNTIME.postgres_snapshot(repo, current["postgres"]["Id"])
    redis_after = RUNTIME.redis_snapshot(repo, current["redis"])
    try:
        RUNTIME.compare_data(pg_before, pg_after, redis_before, redis_after)
        data_preserved = True
    except RUNTIME.Refused:
        data_preserved = False
    stable = RUNTIME.stable_runtime(current) == RUNTIME.stable_runtime(RUNTIME.inspect_owned(repo))
    RUNTIME.require_gate(owner)
    return {
        "diagnosisCompleted": True, "readOnly": True, "resumeAuthorized": False,
        "postgresIdentityChanged": original["postgres"]["Id"] != current["postgres"]["Id"],
        "postgresSameImage": original["postgres"]["Image"] == current["postgres"]["Image"],
        "postgresRunningHealthy": current["postgres"]["State"].get("Running") is True and
                                   current["postgres"]["State"].get("Health", {}).get("Status") == "healthy",
        "postgresLoggingCorrect": current["postgres"]["HostConfig"].get("LogConfig") == RUNTIME.EXPECTED_RUNTIME_LOGGING,
        "rawPostgresChangedPaths": changed_paths(before, after),
        "emptyDnsListToNullFields": dns,
        "remainingPathsAfterDnsProjection": remaining,
        "postgresUniqueEnvironmentMappingsEqual": env_before == env_after,
        "remainingPathsAfterDnsAndEnvOrderProjection": changed_paths(before, RUNTIME.preserved_config(env_projection)),
        "unexpectedOtherServiceChanges": other_changes,
        "originalDataInvariantsPreserved": data_preserved,
        "postgresCountsExactlyEqual": all(pg_before[key] == pg_after[key] for key in ("users", "sites", "aliases")),
        "postgresAliasSampleEqual": pg_before.get("alias") == pg_after.get("alias"),
        "runtimeUnchangedDuringDiagnosis": stable,
        "clickhouseReconnectionVerified": False,
        "backupArtifactsReverified": False,
        "containersRecreated": False, "backendStarted": False, "maintenanceRemoved": False,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path("/home/rybbit-wotcv"))
    parser.add_argument("--audit", type=Path, required=True)
    parser.add_argument("--owner", required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(diagnose(args.repo, args.audit, args.owner), indent=2, sort_keys=True))
    except (RUNTIME.Refused, OSError, ValueError, TypeError, KeyError, IndexError, subprocess.SubprocessError) as error:
        print("REFUSED: " + (str(error) if isinstance(error, RUNTIME.Refused)
                              else "read-only logging diagnosis failed; sensitive details withheld"), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
