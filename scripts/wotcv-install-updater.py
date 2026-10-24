#!/usr/bin/env python3
"""Check or repair only the root-owned retained Rybbit updater, never run it.

Default --check is read-only and may run as wotcv. --apply requires root and
replaces only the inspected legacy utility (or accepts an identical candidate)
using the clean, committed origin/feat/wotcv source. This is a retained-utility
hotfix: payload-manifest.json stays the original release baseline, not a new
full-release attestation. A separate protected audit records old/new hashes.
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
from typing import NamedTuple


SOURCE_NAME = "scripts/update_rybbit_wotcv.sh"
RETAINED_NAME = "update_rybbit_wotcv.sh"
DEPLOY_USER = "wotcv"
LEGACY_SHA256 = "20a255b4be3301e7d0a761de5de884576bdf6e8d179347637b386438b70a2c85"
MANIFEST_ENTRY = "retained/update_rybbit_wotcv.sh"


class Paths(NamedTuple):
    repo: Path = Path("/home/rybbit-wotcv")
    ops: Path = Path("/opt/wotcv-ops")
    backups: Path = Path("/var/backups/wotcv-rybbit-updater")
    locks: tuple[Path, ...] = (
        Path("/run/lock/wotcv-deploy.lock"),
        Path("/run/lock/wotcv-ops-install.lock"),
    )


class Plan(NamedTuple):
    head: str
    source: bytes
    release: Path
    target: Path
    original: bytes
    original_mode: int
    baseline_manifest: bytes
    baseline_entry: str


class Refused(RuntimeError):
    pass


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def safe_environment() -> dict[str, str]:
    # In particular, do not inherit BASH_ENV, ENV, GIT_DIR, Git config injection
    # variables, user PATH entries, or sudo caller settings into root commands.
    return {
        "PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C", "LC_ALL": "C",
        "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_TERMINAL_PROMPT": "0", "GIT_OPTIONAL_LOCKS": "0",
    }


def command(args: list[str], *, data: bytes | None = None) -> bytes:
    result = subprocess.run(
        args, input=data, capture_output=True, timeout=30, env=safe_environment(),
    )
    if result.returncode:
        raise Refused("Validation command failed; native output withheld")
    return result.stdout


def deployment_uid() -> int:
    import pwd
    return pwd.getpwnam(DEPLOY_USER).pw_uid


def git(repo: Path, *args: str) -> bytes:
    owner_uid = deployment_uid()
    uid = os.geteuid()
    if uid not in (0, owner_uid):
        raise Refused("Run --check as wotcv, or --apply as root")
    prefix = ["/usr/sbin/runuser", "-u", DEPLOY_USER, "--"] if uid == 0 else []
    return command([
        *prefix, "/usr/bin/git", "--no-replace-objects", "-c", "core.hooksPath=/dev/null",
        "-c", "core.fsmonitor=false", "-C", str(repo), *args,
    ])


def regular_bytes(path: Path) -> bytes:
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "rb") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise Refused("Expected a regular file, not a symlink or special file")
        return stream.read()


def require_metadata(info, *, directory: bool) -> None:
    matches_type = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
    if not matches_type or info.st_uid != 0 or info.st_mode & 0o022:
        raise Refused("Operations path must be root-owned and not group/world writable")


def trusted_directory(path: Path) -> None:
    if not path.is_absolute():
        raise Refused("Operations path must be absolute")
    for item in reversed((path, *path.parents)):
        require_metadata(item.lstat(), directory=True)


def installed_target(paths: Paths) -> tuple[Path, Path, bytes, int]:
    trusted_directory(paths.ops / "releases")
    current = paths.ops / "current"
    link_info = current.lstat()
    if not stat.S_ISLNK(link_info.st_mode) or link_info.st_uid != 0:
        raise Refused("Operations current must be a root-owned release symlink")
    release = current.resolve(strict=True)
    if release.parent != paths.ops / "releases":
        raise Refused("Operations current must resolve to a direct releases child")
    target = release / "retained" / RETAINED_NAME
    trusted_directory(target.parent)
    info = target.lstat()
    require_metadata(info, directory=False)
    return release, target, regular_bytes(target), stat.S_IMODE(info.st_mode)


def manifest_snapshot(release: Path) -> tuple[bytes, str]:
    path = release / "payload-manifest.json"
    require_metadata(path.lstat(), directory=False)
    baseline = regular_bytes(path)
    value = json.loads(baseline)
    entry = value.get(MANIFEST_ENTRY) if isinstance(value, dict) else None
    if entry != LEGACY_SHA256:
        raise Refused("Release manifest must retain the inspected legacy updater baseline")
    return baseline, entry


def require_known_target(original: bytes, source: bytes) -> None:
    if digest(original) != LEGACY_SHA256 and original != source:
        raise Refused("Retained updater is neither the inspected legacy file nor the exact candidate")


def source_snapshot(repo: Path) -> tuple[str, bytes]:
    if git(repo, "status", "--porcelain=v1", "-z", "--untracked-files=all"):
        raise Refused("Source repository must be clean")
    top = Path(git(repo, "rev-parse", "--show-toplevel").decode().strip())
    if top.resolve() != repo.resolve():
        raise Refused("Expected the exact source repository root")
    head = git(repo, "rev-parse", "--verify", "HEAD").decode().strip()
    remote = git(repo, "rev-parse", "--verify", "refs/remotes/origin/feat/wotcv").decode().strip()
    if not re.fullmatch(r"[0-9a-f]{40}", head) or head != remote:
        raise Refused("Source HEAD must equal the fetched origin/feat/wotcv commit")
    entry = git(repo, "ls-tree", "-z", head, "--", SOURCE_NAME)
    fields = entry.rstrip(b"\0").split(b"\t")
    if (len(fields) != 2 or fields[1] != SOURCE_NAME.encode()
            or fields[0].split(b" ", 1)[0] not in (b"100644", b"100755")):
        raise Refused("Committed updater must be one regular tracked file")
    committed = git(repo, "show", f"{head}:{SOURCE_NAME}")
    source = regular_bytes(repo / SOURCE_NAME)
    if source != committed:
        raise Refused("Updater source differs from its committed HEAD blob")
    if git(repo, "status", "--porcelain=v1", "-z", "--untracked-files=all"):
        raise Refused("Source repository changed while reading the updater")
    command(["/bin/bash", "--noprofile", "--norc", "-n"], data=source)
    return head, source


def plan_install(paths: Paths) -> Plan:
    head, source = source_snapshot(paths.repo)
    release, target, original, mode = installed_target(paths)
    require_known_target(original, source)
    baseline, entry = manifest_snapshot(release)
    return Plan(head, source, release, target, original, mode, baseline, entry)


def require_platform(*, apply: bool) -> None:
    if os.name != "posix":
        raise Refused("This installer requires Linux")
    if apply and os.geteuid() != 0:
        raise Refused("--apply requires root; use sudo for this installer only")


def require_lock_metadata(info) -> None:
    # The existing operations CLI deliberately creates root:root 0660 locks.
    # Group root is trusted here; never relax the stricter payload/path policy.
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_gid != 0
            or info.st_mode & 0o002):
        raise Refused("Operations lock must be a root:root regular file without world write access")


@contextmanager
def lock_file(path: Path):
    import fcntl
    descriptor = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        require_lock_metadata(os.fstat(descriptor))
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise Refused("Another operations install/deployment holds the lock") from error
        yield
    finally:
        os.close(descriptor)


def sync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def protected_file(path: Path, value: bytes) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        os.fchmod(stream.fileno(), 0o600)
        stream.write(value)
        stream.flush()
        os.fsync(stream.fileno())


def archive(paths: Paths, plan: Plan) -> Path:
    trusted_directory(paths.backups.parent)
    paths.backups.mkdir(mode=0o700, exist_ok=True)
    trusted_directory(paths.backups)
    if paths.backups.lstat().st_mode & 0o077:
        raise Refused("Updater backup directory must be private (0700)")
    audit = Path(tempfile.mkdtemp(
        prefix=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ-"), dir=paths.backups,
    ))
    protected_file(audit / "updater.before.sh", plan.original)
    protected_file(audit / "updater.after.sh", plan.source)
    manifest = {
        "scope": "retained-updater-only; operations release manifest unchanged, not re-attested",
        "source": str(paths.repo / SOURCE_NAME), "sourceHead": plan.head,
        "release": str(plan.release), "target": str(plan.target),
        "beforeSha256": digest(plan.original), "afterSha256": digest(plan.source),
        "beforeMode": f"{plan.original_mode:04o}", "afterMode": "0755",
        "payloadManifest": str(plan.release / "payload-manifest.json"),
        "payloadManifestSha256": digest(plan.baseline_manifest),
        "payloadManifestEntry": {MANIFEST_ENTRY: plan.baseline_entry},
    }
    protected_file(audit / "payload-manifest.baseline.json", plan.baseline_manifest)
    protected_file(audit / "manifest.json", json.dumps(manifest, indent=2).encode())
    sync_directory(audit)
    sync_directory(paths.backups)
    return audit


def root_ownership(descriptor: int) -> None:
    os.fchown(descriptor, 0, 0)


def atomic_replace(path: Path, value: bytes, mode: int) -> None:
    descriptor, pending = tempfile.mkstemp(prefix=".rybbit-updater-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            root_ownership(stream.fileno())
            os.fchmod(stream.fileno(), mode)
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(pending, path)
        sync_directory(path.parent)
    finally:
        if os.path.exists(pending):
            os.unlink(pending)


def install(paths: Paths = Paths(), *, apply: bool = False) -> Path | None:
    require_platform(apply=apply)
    planned = plan_install(paths)
    print(f"Target: {planned.target}\nSource HEAD: {planned.head}")
    print(f"Updater SHA256: {digest(planned.original)} -> {digest(planned.source)}")
    if not apply:
        print("CHECK PASS: source and target validated; no files changed and no updater run")
        return None
    with ExitStack() as locks:
        for path in paths.locks:
            locks.enter_context(lock_file(path))
        if plan_install(paths) != planned:
            raise Refused("Source or operations release changed before the locks were acquired")
        if planned.original == planned.source and planned.original_mode == 0o755:
            print("ALREADY CURRENT: no files changed and no updater run")
            return None
        audit = archive(paths, planned)
        print(f"Protected backup: {audit}", flush=True)
        if plan_install(paths) != planned:
            raise Refused("Source or operations release changed while archiving; nothing installed")
        try:
            atomic_replace(planned.target, planned.source, 0o755)
            release, target, installed, mode = installed_target(paths)
            if ((release, target, installed, mode)
                    != (planned.release, planned.target, planned.source, 0o755)):
                raise Refused("Installed updater verification failed")
            if manifest_snapshot(release) != (planned.baseline_manifest, planned.baseline_entry):
                raise Refused("Original release manifest changed during the retained-utility hotfix")
            protected_file(audit / "success.json", json.dumps({
                "target": str(target), "sha256": digest(installed),
                "scope": "retained-updater-only", "updaterExecuted": False,
            }, indent=2).encode())
            sync_directory(audit)
        except Exception:
            # Never overwrite another actor's intervening edit during recovery.
            trusted_directory(planned.target.parent)
            require_metadata(planned.target.lstat(), directory=False)
            if regular_bytes(planned.target) == planned.source:
                atomic_replace(planned.target, planned.original, planned.original_mode)
                print("Installation failed; original updater restored from the protected snapshot", file=sys.stderr)
            else:
                print("Installation failed; target differs from our payload, so rollback was not attempted", file=sys.stderr)
            raise
    print("INSTALLED retained updater only; release manifest unchanged, not re-attested")
    print("No updater, deployment, restart or migration was run")
    return audit


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--check", action="store_true", help="Read-only validation (default)")
    action.add_argument("--apply", action="store_true", help="Root-only atomic repair of the retained utility")
    args = parser.parse_args()
    try:
        install(apply=args.apply)
    except (Refused, OSError, ValueError, TypeError, KeyError, subprocess.TimeoutExpired) as error:
        print(f"REFUSED: {error}" if isinstance(error, Refused)
              else "REFUSED: operation failed; native details withheld", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
