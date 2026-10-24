#!/usr/bin/env python3
"""Attest two reviewed retained-utility hotfixes without altering their payload.

Default --check is read-only. Root-only --apply adds a protected receipt for the
33 files listed by one pinned release manifest. It never rewrites that manifest,
runs cleanup or an updater, or claims to re-attest unlisted/generated files.
"""

from __future__ import annotations

import argparse
from contextlib import ExitStack, contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
import tempfile
from typing import NamedTuple


MANIFEST_SHA256 = "f53c1809abfef98bc79727a2ce9d303af3f4640e867979d1ec97b40d70bd2890"
MANIFEST_COUNT = 33
UPDATER_ENTRY = "retained/update_rybbit_wotcv.sh"
CLEAN_ENTRY = "retained/clean.sh"
UPDATER_BASELINE_SHA256 = "20a255b4be3301e7d0a761de5de884576bdf6e8d179347637b386438b70a2c85"
UPDATER_LIVE_SHA256 = "0f45d79e05d57bf953b2c6f6615f02af30e2bfe9038da46fd74b9732940eaed7"
CLEAN_BASELINE_SHA256 = "083e3b23adad14a7b7a40fafc097eb0a773d10bcb22adb0912bf36c2c644b1bf"
CLEAN_LIVE_SHA256 = "bba24ef31a3235cf61e5e59df7dd6ff693572907d9180d554b9b51daf7ebe4b0"
SOURCE_COMMIT = "d3eb3fca8a5bc5c13c728567ada47969df5e0613"
SOURCE_NAME = "scripts/update_rybbit_wotcv.sh"
DEPLOY_USER = "wotcv"
SHEBANG = b"#!/usr/bin/env bash\n"
CLEAN_GUARD = (
    b"# WOTCV_AUDIT_20261024_LEGACY_CLEAN_ARGS_GUARD\n"
    b"# This legacy entry point has no argument parser. Fail before all operations.\n"
    b"if (( $# != 0 )); then\n"
    b"  printf '%s\\n' 'Legacy cleanup accepts no arguments; refusing all operations.' >&2\n"
    b"  exit 64\n"
    b"fi\n\n"
)
SCOPE = "33-manifest-listed-files-with-two-reviewed-hotfixes; not-whole-release-reattestation"
MAX_FILE_BYTES = 8 * 1024 * 1024


class Paths(NamedTuple):
    repo: Path = Path("/home/rybbit-wotcv")
    ops: Path = Path("/opt/wotcv-ops")
    attestations: Path = Path("/var/lib/wotcv-ops/attestations")
    locks: tuple[Path, ...] = (
        Path("/run/lock/wotcv-deploy.lock"),
        Path("/run/lock/wotcv-ops-install.lock"),
    )


class Plan(NamedTuple):
    release: Path
    manifest: bytes
    baseline: dict[str, str]
    live: dict[str, str]
    source_commit: str
    source: bytes
    clean_proof: dict


class Refused(RuntimeError):
    pass


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def require_metadata(info, *, directory: bool) -> None:
    matches = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
    if not matches or info.st_uid != 0 or info.st_mode & 0o022:
        raise Refused("Operations path must be root-owned, nonsymlink and not group/world writable")


def trusted_directory(path: Path) -> None:
    if not path.is_absolute():
        raise Refused("Trusted paths must be absolute")
    for item in reversed((path, *path.parents)):
        require_metadata(item.lstat(), directory=True)


def regular_bytes(path: Path, *, root_owned: bool = False) -> bytes:
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_FILE_BYTES:
            raise Refused("Expected a bounded regular file, not a symlink or special file")
        if root_owned:
            require_metadata(info, directory=False)
        value = stream.read(MAX_FILE_BYTES + 1)
        if len(value) > MAX_FILE_BYTES:
            raise Refused("File grew beyond the validation limit")
        return value


def protected_bytes(path: Path) -> bytes:
    trusted_directory(path.parent)
    require_metadata(path.lstat(), directory=False)
    return regular_bytes(path, root_owned=True)


def unique_object(pairs):
    result = {}
    for name, value in pairs:
        if name in result:
            raise Refused("Duplicate JSON keys are not permitted")
        result[name] = value
    return result


def parse_manifest(value: bytes) -> dict[str, str]:
    if digest(value) != MANIFEST_SHA256:
        raise Refused("Original release manifest does not match the pinned SHA256")
    manifest = json.loads(value, object_pairs_hook=unique_object)
    if not isinstance(manifest, dict) or len(manifest) != MANIFEST_COUNT:
        raise Refused("Expected exactly 33 manifest-listed payload files")
    for name, checksum in manifest.items():
        path = PurePosixPath(name)
        if (not name or not path.parts or path.is_absolute() or path.as_posix() != name
                or ".." in path.parts or "." in path.parts or "\\" in name
                or any(ord(character) < 32 or ord(character) == 127 for character in name)
                or not isinstance(checksum, str) or not re.fullmatch(r"[0-9a-f]{64}", checksum)):
            raise Refused("Manifest contains an unsafe path or invalid SHA256")
    if (manifest.get(UPDATER_ENTRY) != UPDATER_BASELINE_SHA256
            or manifest.get(CLEAN_ENTRY) != CLEAN_BASELINE_SHA256):
        raise Refused("Manifest does not retain both inspected legacy baselines")
    return manifest


def clean_guard_proof(live: bytes) -> dict:
    if digest(live) != CLEAN_LIVE_SHA256 or not live.startswith(SHEBANG + CLEAN_GUARD):
        raise Refused("Legacy cleanup is not the exact reviewed guarded file")
    reconstructed = SHEBANG + live[len(SHEBANG + CLEAN_GUARD):]
    if digest(reconstructed) != CLEAN_BASELINE_SHA256:
        raise Refused("Removing only the exact cleanup guard does not reconstruct the baseline")
    return {
        "kind": "exact-insertion-after-shebang",
        "insertedBytes": len(CLEAN_GUARD),
        "insertedSha256": digest(CLEAN_GUARD),
        "reconstructedBaselineSha256": digest(reconstructed),
        "validation": "byte-and-hash-proof-only; cleanup-never-executed",
        "behavior": "rejects-any-arguments-with-exit-64; zero-argument-cleanup-remains-destructive",
    }


def safe_environment() -> dict[str, str]:
    return {
        "PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C", "LC_ALL": "C",
        "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_TERMINAL_PROMPT": "0", "GIT_OPTIONAL_LOCKS": "0",
    }


def command(args: list[str]) -> bytes:
    result = subprocess.run(args, capture_output=True, timeout=30, env=safe_environment())
    if result.returncode:
        raise Refused("Source validation command failed; native output withheld")
    return result.stdout


def deployment_uid() -> int:
    import pwd
    return pwd.getpwnam(DEPLOY_USER).pw_uid


def git(repo: Path, *args: str) -> bytes:
    uid = os.geteuid()
    if uid not in (0, deployment_uid()):
        raise Refused("Run --check as wotcv, or --apply as root")
    prefix = ["/usr/sbin/runuser", "-u", DEPLOY_USER, "--"] if uid == 0 else []
    return command([
        *prefix, "/usr/bin/git", "--no-replace-objects", "-c", "core.hooksPath=/dev/null",
        "-c", "core.fsmonitor=false", "-C", str(repo), *args,
    ])


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
    git(repo, "merge-base", "--is-ancestor", SOURCE_COMMIT, head)
    entry = git(repo, "ls-tree", "-z", SOURCE_COMMIT, "--", SOURCE_NAME)
    fields = entry.rstrip(b"\0").split(b"\t")
    if (len(fields) != 2 or fields[1] != SOURCE_NAME.encode()
            or fields[0].split(b" ", 1)[0] not in (b"100644", b"100755")):
        raise Refused("Pinned committed updater must be one regular tracked file")
    committed = git(repo, "show", f"{SOURCE_COMMIT}:{SOURCE_NAME}")
    current_committed = git(repo, "show", f"{head}:{SOURCE_NAME}")
    working = regular_bytes(repo / SOURCE_NAME)
    if committed != working or current_committed != committed or digest(committed) != UPDATER_LIVE_SHA256:
        raise Refused("Updater must equal the exact reviewed committed source blob")
    if git(repo, "status", "--porcelain=v1", "-z", "--untracked-files=all"):
        raise Refused("Source repository changed during validation")
    return SOURCE_COMMIT, committed


def plan_attestation(paths: Paths) -> Plan:
    trusted_directory(paths.ops / "releases")
    current = paths.ops / "current"
    info = current.lstat()
    if not stat.S_ISLNK(info.st_mode) or info.st_uid != 0:
        raise Refused("Operations current must be a root-owned release symlink")
    release = current.resolve(strict=True)
    if release.parent != paths.ops / "releases":
        raise Refused("Operations current must resolve to a direct releases child")
    trusted_directory(release)
    manifest_bytes = protected_bytes(release / "payload-manifest.json")
    baseline = parse_manifest(manifest_bytes)
    source_commit, source = source_snapshot(paths.repo)
    live = {}
    proof = None
    for name, baseline_sha in sorted(baseline.items()):
        value = protected_bytes(release.joinpath(*PurePosixPath(name).parts))
        checksum = digest(value)
        expected = {UPDATER_ENTRY: UPDATER_LIVE_SHA256, CLEAN_ENTRY: CLEAN_LIVE_SHA256}.get(name, baseline_sha)
        if checksum != expected:
            raise Refused(f"Unreviewed payload difference: {name}")
        if name == UPDATER_ENTRY and value != source:
            raise Refused("Retained updater differs from the exact reviewed source blob")
        if name == CLEAN_ENTRY:
            proof = clean_guard_proof(value)
        live[name] = checksum
    if protected_bytes(release / "payload-manifest.json") != manifest_bytes:
        raise Refused("Original release manifest changed during validation")
    if current.resolve(strict=True) != release:
        raise Refused("Operations current changed during validation")
    return Plan(release, manifest_bytes, baseline, live, source_commit, source, proof)


def receipt_record(plan: Plan) -> dict:
    return {
        "schemaVersion": 1,
        "scope": SCOPE,
        "release": str(plan.release),
        "payloadManifestSha256": digest(plan.manifest),
        "manifestFileCount": len(plan.baseline),
        "manifestUnchanged": True,
        "payloadModified": False,
        "payloadExecuted": False,
        "unlistedFilesAttested": False,
        "source": {"commit": plan.source_commit, "path": SOURCE_NAME, "sha256": digest(plan.source)},
        "cleanupGuardProof": plan.clean_proof,
        "files": {name: {"baselineSha256": checksum, "liveSha256": plan.live[name]}
                  for name, checksum in sorted(plan.baseline.items())},
    }


def validate_receipt(value: bytes, plan: Plan) -> None:
    receipt = json.loads(value, object_pairs_hook=unique_object)
    if not isinstance(receipt, dict) or set(receipt) != {"recordedAt", "attestation"}:
        raise Refused("Existing receipt has an unrecognized format")
    timestamp = receipt["recordedAt"]
    if not isinstance(timestamp, str):
        raise Refused("Existing receipt lacks a valid UTC timestamp")
    try:
        parsed = datetime.strptime(timestamp, "%Y-%m-%dT%H:%M:%SZ")
        if parsed.strftime("%Y-%m-%dT%H:%M:%SZ") != timestamp:
            raise ValueError("Noncanonical timestamp")
    except ValueError as error:
        raise Refused("Existing receipt lacks a valid UTC timestamp") from error
    # Python treats 0/False and 1/True as equal; receipt JSON must preserve types.
    if json.dumps(receipt["attestation"], sort_keys=True) != json.dumps(receipt_record(plan), sort_keys=True):
        raise Refused("Existing receipt does not match the complete reviewed attestation")


def receipt_directory(paths: Paths, *, create: bool = False) -> bool:
    parent = paths.attestations.parent
    trusted_directory(parent.parent)
    for directory in (parent, paths.attestations):
        try:
            info = directory.lstat()
        except FileNotFoundError:
            if not create:
                return False
            directory.mkdir(mode=0o700)
            info = directory.lstat()
        require_metadata(info, directory=True)
    if stat.S_IMODE(paths.attestations.lstat().st_mode) != 0o700:
        raise Refused("Attestation directory must be private (0700)")
    return True


def receipt_present(paths: Paths, plan: Plan) -> bool:
    if not receipt_directory(paths):
        return False
    path = paths.attestations / f"{digest(plan.manifest)}.json"
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    require_metadata(info, directory=False)
    if stat.S_IMODE(info.st_mode) != 0o600:
        raise Refused("Attestation receipt must be private (0600)")
    validate_receipt(protected_bytes(path), plan)
    return True


def require_platform(*, apply: bool) -> None:
    if os.name != "posix" or not hasattr(os, "O_NOFOLLOW"):
        raise Refused("This utility requires Linux/POSIX no-follow file operations")
    if apply and os.geteuid() != 0:
        raise Refused("--apply requires root; use --check for read-only verification")


def require_lock_metadata(info) -> None:
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_gid != 0
            or info.st_mode & 0o002):
        raise Refused("Operations lock must be root:root, regular and not world writable")


@contextmanager
def lock_file(path: Path):
    import fcntl
    trusted_directory(path.parent.parent)
    parent = path.parent.lstat()
    # /run/lock is root-owned 1777 on the inspected host. Sticky-bit protection
    # plus root-owned, no-follow lock files is the existing operations contract.
    if (not stat.S_ISDIR(parent.st_mode) or parent.st_uid != 0
            or (parent.st_mode & 0o022 and not parent.st_mode & stat.S_ISVTX)):
        raise Refused("Operations lock directory must be root-owned, nonsymlink and protected")
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


def write_receipt(paths: Paths, plan: Plan) -> Path:
    receipt_directory(paths, create=True)
    target = paths.attestations / f"{digest(plan.manifest)}.json"
    record = {
        "recordedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "attestation": receipt_record(plan),
    }
    descriptor, pending = tempfile.mkstemp(prefix=".ops-attestation-", dir=paths.attestations)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            os.fchown(stream.fileno(), 0, 0)
            os.fchmod(stream.fileno(), 0o600)
            stream.write((json.dumps(record, indent=2, sort_keys=True) + "\n").encode())
            stream.flush()
            os.fsync(stream.fileno())
        # Atomic no-clobber publish: never overwrite an existing protected receipt.
        os.link(pending, target, follow_symlinks=False)
        sync_directory(paths.attestations)
    finally:
        os.unlink(pending)
    return target


def attest(paths: Paths = Paths(), *, apply: bool = False) -> Path | None:
    require_platform(apply=apply)
    planned = plan_attestation(paths)
    print(f"Release: {planned.release}\nOriginal manifest SHA256: {digest(planned.manifest)}")
    print("Verified all 33 manifest files: 31 unchanged; exact updater replacement and additive cleanup guard")
    print("Guard proof: removed exactly 246 inserted bytes to recover the original cleanup SHA256; never executed", flush=True)
    try:
        present = receipt_present(paths, planned)
    except PermissionError as error:
        raise Refused(
            "ROOT-ONLY RECEIPT REGISTRY UNVERIFIED: payload proof passed, but run read-only --check as root "
            "to verify the protected registry; no full CHECK PASS and no files changed"
        ) from error
    if not apply:
        print(f"CHECK PASS: receipt {'verified' if present else 'absent'}; no files changed or payload executed")
        print("Scope is manifest-listed files only, not a whole-release re-attestation")
        return None
    with ExitStack() as locks:
        for path in paths.locks:
            locks.enter_context(lock_file(path))
        if plan_attestation(paths) != planned:
            raise Refused("Source or operations release changed before the locks were acquired")
        if receipt_present(paths, planned):
            print("ALREADY ATTESTED: protected receipt verified; no files changed")
            return None
        target = write_receipt(paths, planned)
        if plan_attestation(paths) != planned or not receipt_present(paths, planned):
            raise Refused("Post-write verification failed; inspect the additive receipt, payload was not modified")
    print(f"ATTESTED: {target}; original manifest, updater and cleanup left unchanged")
    return target


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--check", action="store_true", help="Read-only verification (default)")
    action.add_argument("--apply", action="store_true", help="Root-only additive protected receipt; no payload changes")
    args = parser.parse_args()
    try:
        attest(apply=args.apply)
    except (Refused, OSError, ValueError, TypeError, KeyError, subprocess.TimeoutExpired) as error:
        print(f"REFUSED: {error}" if isinstance(error, Refused)
              else "REFUSED: verification failed; native details withheld", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
