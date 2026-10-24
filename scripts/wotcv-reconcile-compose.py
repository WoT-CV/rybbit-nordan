#!/usr/bin/env python3
"""Archive known log-rotation drift and fast-forward config, never deploy.

Run as the repository owner, from a copy OUTSIDE the production checkout.
First fetch origin manually; --target must be its complete feat/wotcv SHA.
Default is a check. --backup-only can archive the known drift before the
repair is published. --apply refuses a target without all five 50m x 5 limits.
No stash, index flags, reset, database operation or container restart is used.
"""

from __future__ import annotations

import argparse
from contextlib import ExitStack, contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
from typing import Any
from urllib.request import urlopen


FILES = ("docker-compose.yml", "docker-compose.wotcv.yml", "docker-compose.wotcv.branch-build.yml")
COUNTS = dict(zip(FILES, (1, 2, 2)))
SERVICES = ("clickhouse", "postgres", "redis", "backend", "client")
EXPECTED_LOGGING = {"driver": "json-file", "options": {"max-size": "50m", "max-file": "5"}}
# This is deliberately not a general-purpose dirty-tree/stash reconciler.
# Only the exact previously inspected addition may be removed from HEAD files.
ROTATION_BLOCK = re.compile(
    rb"(?m)^    logging:\n      driver: json-file\n      options:\n"
    rb"        max-size: 50m\n        max-file: '5'\n"
)


class Refused(RuntimeError):
    pass


def command(repo: Path, args: list[str], *, env=None, ok=(0,)) -> bytes:
    result = subprocess.run(args, cwd=repo, env=env, capture_output=True, timeout=90)
    if result.returncode not in ok:
        # Compose and Git diagnostics can include interpolated credentials.
        raise Refused(f"Command failed: {args[0]} {args[1]} (exit {result.returncode}); output withheld")
    return result.stdout


def git(repo: Path, *args: str) -> bytes:
    return command(repo, ["git", *args])


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def protected_file(path: Path, data: bytes) -> None:
    with path.open("xb") as stream:
        os.chmod(path, 0o600)
        stream.write(data)


def known_drift(head: dict[str, bytes], current: dict[str, bytes]) -> None:
    for name in FILES:
        stripped, count = ROTATION_BLOCK.subn(b"", current[name])
        if count != COUNTS[name] or stripped != head[name]:
            raise Refused(f"Unreviewed Compose change in {name}; nothing restored")


def status(repo: Path) -> bytes:
    return git(repo, "status", "--porcelain=v1", "-z", "--untracked-files=all")


def require_known_status(value: bytes) -> None:
    entries = value.rstrip(b"\0").split(b"\0") if value else []
    expected = {b" M " + name.encode() for name in FILES}
    if len(entries) != len(FILES) or set(entries) != expected:
        raise Refused("Expected only the three unstaged Compose changes; staged, extra or untracked files refused")


def regular_bytes(path: Path) -> bytes:
    if not stat.S_ISREG(path.lstat().st_mode):
        raise Refused(f"Not a regular file: {path.name}")
    return path.read_bytes()


def state_hashes(repo: Path) -> dict[str, str | None]:
    return {
        name: digest(regular_bytes(repo / name)) if (repo / name).exists() else None
        for name in (".env", ".wotcv-deployment.env")
    }


def archive(repo: Path, root: Path, head: str, originals: dict[str, bytes], baseline: dict[str, bytes]) -> Path:
    root = root.resolve()
    if root == repo or repo in root.parents:
        raise Refused("Backups must be outside the repository")
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = root.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise Refused("Backup root must be an owned private directory (0700)")
    audit = Path(tempfile.mkdtemp(prefix=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ-"), dir=root))
    for group, contents in (("original", originals), ("head", baseline)):
        directory = audit / group
        directory.mkdir(mode=0o700)
        for name, data in contents.items():
            protected_file(directory / name, data)
    protected_file(audit / "changes.patch", git(repo, "diff", "--binary", "--", *FILES))
    manifest = {
        "repository": str(repo), "head": head,
        "originalSha256": {name: digest(data) for name, data in originals.items()},
        "headSha256": {name: digest(data) for name, data in baseline.items()},
        "stateSha256": state_hashes(repo), "desiredLogging": EXPECTED_LOGGING,
    }
    protected_file(audit / "manifest.json", json.dumps(manifest, indent=2).encode())
    return audit


def validate_config(config: dict[str, Any], *, require_logging: bool = True) -> None:
    if config.get("name") != "rybbit":
        raise Refused("Compose project must remain rybbit")
    services = config.get("services", {})
    for name in SERVICES:
        service = services.get(name, {})
        if require_logging and service.get("logging") != EXPECTED_LOGGING:
            raise Refused(f"{name}: published target must retain json-file 50m x 5")
        for port in service.get("ports") or []:
            if name == "redis" or port.get("host_ip") not in ("127.0.0.1", "::1"):
                raise Refused(f"{name}: unsafe published port")
    expected_volumes = {"clickhouse-data": "rybbit_clickhouse-data", "postgres-data": "rybbit_postgres-data", "redis-data": "rybbit_redis-data"}
    for key, expected_name in expected_volumes.items():
        volume = config.get("volumes", {}).get(key, {})
        if volume.get("external") is not True or volume.get("name") != expected_name:
            raise Refused(f"{key}: external production volume identity must not change")


def require_same_storage_and_ports(before, after) -> None:
    if before.get("volumes") != after.get("volumes"):
        raise Refused("Effective volume declarations changed")
    for name in SERVICES:
        for field in ("ports", "volumes", "networks", "container_name"):
            if before["services"][name].get(field) != after["services"][name].get(field):
                raise Refused(f"{name}: effective {field} changed")


def render(repo: Path, directory: Path, count: int, env: dict[str, str], *, require_logging: bool = True) -> dict:
    args = ["docker", "compose", "--project-directory", str(repo), "--env-file", str(repo / ".env"), "--project-name", "rybbit"]
    for name in FILES[:count]:
        args += ["-f", str(directory / name)]
    value = command(repo, [*args, "config", "--format", "json"], env=env)
    protected_file(directory / f"effective-{count}.json", value)
    try:
        config = json.loads(value)
        validate_config(config, require_logging=require_logging)
        return config
    except (ValueError, TypeError, AttributeError) as exc:
        raise Refused("Effective Compose JSON is invalid or unsafe; details withheld") from exc


def runtime(repo: Path) -> dict:
    raw = command(repo, ["docker", "inspect", "--format", "{{json .}}", *SERVICES])
    containers = [json.loads(line) for line in raw.splitlines()]
    result = {}
    for container in containers:
        result[container["Name"]] = {
            "id": container["Id"], "image": container["Image"],
            "startedAt": container["State"]["StartedAt"], "restartCount": container["RestartCount"],
            "status": container["State"]["Status"], "logs": container["HostConfig"]["LogConfig"],
            "mounts": container["Mounts"], "ports": container["HostConfig"]["PortBindings"],
        }
    return result


def health() -> dict:
    with urlopen("http://127.0.0.1:3001/api/health", timeout=10) as response:
        data = response.read(65537)
        if response.status != 200 or len(data) > 65536:
            raise Refused("Local health response is invalid")
    value = json.loads(data)
    if value.get("status") != "ok":
        raise Refused("Local health is not ok")
    return value


@contextmanager
def lock_file(path: Path):
    import fcntl
    descriptor = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
            raise Refused("Update lock is not an owned regular file")
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise Refused("Another update/reconciliation holds the lock") from exc
        yield
    finally:
        os.close(descriptor)


def replace_file(path: Path, data: bytes) -> None:
    mode = stat.S_IMODE(path.stat().st_mode)
    descriptor, name = tempfile.mkstemp(prefix=".compose-reconcile-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            os.fchmod(stream.fileno(), mode)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def require_owner_platform() -> None:
    if os.name != "posix" or os.getuid() == 0:
        raise Refused("Run on Linux as the repository owner, without sudo")


def reconcile(repo: Path, backup_root: Path, target: str | None, apply: bool, backup_only: bool) -> Path:
    repo = repo.resolve(strict=True)
    require_owner_platform()
    if Path(git(repo, "rev-parse", "--show-toplevel").decode().strip()).resolve() != repo:
        raise Refused("Expected the exact repository root")
    if not backup_only and (target is None or not re.fullmatch(r"[0-9a-f]{40}", target)):
        raise Refused("--target must be a full published 40-character commit SHA")
    with ExitStack() as locks:
        # The installed legacy entrypoint and the current repository wrapper
        # use different locks. Hold both; do not run the updater from here.
        for path in (Path("/var/log/wotcv-tools/rybbit/update.lock"), Path(f"/tmp/rybbit-wotcv-update-{os.getuid()}.lock")):
            locks.enter_context(lock_file(path))
        if git(repo, "branch", "--show-current").decode().strip() != "feat/wotcv":
            raise Refused("Repository must be on feat/wotcv")
        for marker in ("MERGE_HEAD", "rebase-merge", "rebase-apply", "index.lock"):
            location = Path(git(repo, "rev-parse", "--git-path", marker).decode().strip())
            if (location if location.is_absolute() else repo / location).exists():
                raise Refused("Another Git operation is in progress")
        initial_status = status(repo)
        require_known_status(initial_status)
        head = git(repo, "rev-parse", "HEAD").decode().strip()
        originals = {name: regular_bytes(repo / name) for name in FILES}
        baseline = {name: git(repo, "show", f"HEAD:{name}") for name in FILES}
        known_drift(baseline, originals)
        initial_state = state_hashes(repo)
        audit = archive(repo, backup_root, head, originals, baseline)
        print(f"Protected backup: {audit}", flush=True)
        if backup_only:
            print("BACKUP ONLY: repository and running containers unchanged")
            return audit
        if git(repo, "rev-parse", "refs/remotes/origin/feat/wotcv").decode().strip() != target:
            raise Refused("Fetch origin first; --target must equal origin/feat/wotcv")
        command(repo, ["git", "merge-base", "--is-ancestor", head, target])
        candidate = audit / "target"
        candidate.mkdir(mode=0o700)
        for name in FILES:
            protected_file(candidate / name, git(repo, "show", f"{target}:{name}"))
        env = os.environ.copy()
        env.update(IMAGE_TAG=f"sha-{target}", WOTCV_GIT_SHA=target, WOTCV_BUILD_TIME="1970-01-01T00:00:00Z", COMPOSE_PROJECT_NAME="rybbit")
        for count in (2, 3):
            # Legacy image deployments did not yet declare application logging
            # in the two-file chain. The new target must fix BOTH chains.
            before = render(repo, audit / "original", count, env, require_logging=count == 3)
            after = render(repo, candidate, count, env)
            require_same_storage_and_ports(before, after)
        before_runtime, before_health = runtime(repo), health()
        protected_file(audit / "runtime-before.json", json.dumps(before_runtime, indent=2).encode())
        protected_file(audit / "health-before.json", json.dumps(before_health, indent=2).encode())
        if not apply:
            print(f"CHECK PASS: both Compose chains preserve 50m x 5, ports and volumes; target {target}; no checkout changed")
            return audit
        if (git(repo, "rev-parse", "HEAD").decode().strip() != head or status(repo) != initial_status
                or state_hashes(repo) != initial_state
                or any(regular_bytes(repo / name) != originals[name] for name in FILES)
                or git(repo, "rev-parse", "refs/remotes/origin/feat/wotcv").decode().strip() != target):
            raise Refused("Repository/environment changed during preflight")
        try:
            for name in FILES:
                replace_file(repo / name, baseline[name])
            if status(repo):
                raise Refused("Restoring the three reviewed files did not produce a clean worktree")
            # Configuration cleanup must not activate an arbitrary post-merge
            # hook or a configured autostash. This only moves an existing ref.
            git(repo, "-c", "core.hooksPath=/dev/null", "merge", "--ff-only", "--no-edit", "--no-autostash", target)
        except Exception:
            if git(repo, "rev-parse", "HEAD").decode().strip() == head:
                for name in FILES:
                    replace_file(repo / name, originals[name])
                print("Restored the original three Compose files; backup retained", file=sys.stderr)
            raise
        if git(repo, "rev-parse", "HEAD").decode().strip() != target or status(repo):
            raise Refused("Unexpected post-fast-forward Git state; inspect the protected backup")
        if state_hashes(repo) != initial_state or runtime(repo) != before_runtime or health() != before_health:
            raise Refused("Runtime/environment changed; no container rollback was attempted")
        protected_file(audit / "success.json", json.dumps({"head": target, "runtimeUnchanged": True, "stateSha256": initial_state}, indent=2).encode())
        print(f"RECONCILED: clean checkout at {target}; containers, health and .env unchanged; no deployment run")
        return audit


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path("/home/rybbit-wotcv"))
    parser.add_argument("--backup-root", type=Path, default=Path("/home/wotcv/rybbit-compose-backups"))
    parser.add_argument("--target")
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--apply", action="store_true")
    action.add_argument("--check", action="store_true")
    action.add_argument("--backup-only", action="store_true")
    args = parser.parse_args()
    try:
        reconcile(args.repo, args.backup_root, args.target, args.apply, args.backup_only)
    except (Refused, OSError, ValueError, TypeError, KeyError, AttributeError, subprocess.TimeoutExpired) as exc:
        # Only our errors are safe to print. Native exceptions/JSON/URL errors
        # may contain response data or credentials.
        print(f"REFUSED: {exc}" if isinstance(exc, Refused) else "REFUSED: operation failed; native details withheld", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
