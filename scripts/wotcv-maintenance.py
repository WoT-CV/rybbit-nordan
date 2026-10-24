#!/usr/bin/env python3
"""Install the tracking-only maintenance gate, or manage its owned runtime flag.

Only `install` writes root configuration. `status` is read-only; enter/leave
touch only the deployment user's flag. No deployment or database command runs.
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
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


SNIPPET = Path("/etc/nginx/snippets/wotcv-tracking-noindex.conf")
VHOST = Path("/etc/nginx/sites-enabled/tracking.wot-cv.com")
TMPFILES = Path("/etc/tmpfiles.d/wotcv-rybbit-maintenance.conf")
DIRECTORY = Path("/var/lib/wotcv-rybbit-maintenance")
BACKUPS = Path("/var/backups/wotcv-rybbit-maintenance")
VHOST_SHA256 = "56aecdb6e8c34f9a613af816e2d403a58862d809cbd2c7998069cf387736f0d9"
BASE = '''# Include only in the tracking application's HTTP/HTTPS server blocks.
add_header X-Robots-Tag "noindex, nofollow, nosnippet, noimageindex" always;
proxy_hide_header X-Robots-Tag;

# Retire the manifests without blocking crawlers from reading noindex responses.
location = /robots.txt {
    # Ignore inherited extension MIME mappings; default_type is only a fallback.
    types { }
    default_type text/plain;
    add_header X-Robots-Tag "noindex, nofollow, nosnippet, noimageindex" always;
    add_header Cache-Control "no-store" always;
    # A literal empty return would trigger Nginx's generated HTML error page.
    set $wotcv_empty_manifest "";
    return 410 $wotcv_empty_manifest;
}

location = /sitemap.xml {
    types { }
    default_type text/plain;
    add_header X-Robots-Tag "noindex, nofollow, nosnippet, noimageindex" always;
    add_header Cache-Control "no-store" always;
    set $wotcv_empty_manifest "";
    return 410 $wotcv_empty_manifest;
}
'''
GATE = '''
# WOTCV_TRACKING_MAINTENANCE_V1: only this application's dedicated snippet.
# Empty values do not add headers to ordinary responses. Return, not rewrite or
# proxying, makes the server-level condition safe even before upstreams exist.
set $wotcv_maintenance_retry_after "";
set $wotcv_maintenance_cache "";
if (-f /var/lib/wotcv-rybbit-maintenance/active) {
    set $wotcv_maintenance_retry_after "15";
    set $wotcv_maintenance_cache "no-store";
    return 503 "Tracking maintenance; retry shortly.\\n";
}
add_header Retry-After $wotcv_maintenance_retry_after always;
add_header Cache-Control $wotcv_maintenance_cache always;
'''
CONTENT = (BASE + GATE).encode()
TMPFILES_CONTENT = b"d /var/lib/wotcv-rybbit-maintenance 0755 wotcv wotcv -\n"
TOKEN = re.compile(r"[A-Za-z0-9_-]{1,80}\Z")


class Refused(RuntimeError):
    pass


def deployment_identity():
    import pwd
    user = pwd.getpwnam("wotcv")
    return user.pw_uid, user.pw_gid


def regular_bytes(path: Path, maximum=1024 * 1024) -> bytes:
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > maximum:
            raise Refused("Expected a bounded regular file")
        return stream.read(maximum + 1)


def trusted_root_path(path: Path, *, directory=False):
    for parent in reversed(path.parents):
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise Refused("Root configuration has an untrusted ancestor")
    info = path.lstat()
    expected = stat.S_ISDIR if directory else stat.S_ISREG
    if not expected(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise Refused("Root configuration must be regular, root-owned and protected")


def require_installed():
    uid, _ = deployment_identity()
    if os.geteuid() not in (0, uid):
        raise Refused("Use the deployment user wotcv or root")
    trusted_root_path(SNIPPET)
    trusted_root_path(TMPFILES)
    reviewed_vhost()
    if regular_bytes(SNIPPET) != CONTENT or regular_bytes(TMPFILES) != TMPFILES_CONTENT:
        raise Refused("Maintenance gate is not installed; see docs/WOTCV_DEPLOYMENT_AVAILABILITY.md")
    trusted_root_path(DIRECTORY.parent, directory=True)
    info = DIRECTORY.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != uid or stat.S_IMODE(info.st_mode) != 0o755:
        raise Refused("Maintenance runtime directory has unexpected ownership or mode")


def read_flag():
    path = DIRECTORY / "active"
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    uid, _ = deployment_identity()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != uid or info.st_mode & 0o022:
        raise Refused("Maintenance flag has untrusted metadata")
    try:
        value = json.loads(regular_bytes(path, 2048))
    except (ValueError, UnicodeError):
        raise Refused("Maintenance flag is malformed; preserve it for manual recovery") from None
    if not isinstance(value, dict) or value.get("version") != 1 or not TOKEN.fullmatch(str(value.get("owner", ""))):
        raise Refused("Maintenance flag is malformed; preserve it for manual recovery")
    return value


def reviewed_vhost():
    target = VHOST.resolve(strict=True)
    if target.parent != Path("/etc/nginx/sites-available"):
        raise Refused("Unexpected tracking vhost target")
    trusted_root_path(target)
    data = regular_bytes(target)
    # Pin the actually inspected two dedicated server blocks. Counts/regexes
    # alone cannot associate an include with the correct active server block.
    if hashlib.sha256(data).hexdigest() != VHOST_SHA256:
        raise Refused("Tracking vhost differs from the reviewed isolated configuration")
    return data.decode()


def verify_active_origin():
    headers = command(["/usr/bin/curl", "--silent", "--show-error", "--max-time", "5",
                       "--noproxy", "*", "--resolve", "tracking.wot-cv.com:443:127.0.0.1",
                       "--head", "https://tracking.wot-cv.com/api/health"]).decode().lower()
    if (not re.search(r"^http/\S+ 503(?:\s|$)", headers, re.M)
            or not re.search(r"^retry-after:\s*15\s*$", headers, re.M)
            or not re.search(r"^cache-control:\s*no-store\s*$", headers, re.M)
            or not re.search(r"^x-robots-tag:.*\bnoindex\b", headers, re.M)):
        raise Refused("Maintenance flag retained, but live origin gate was not confirmed; no deployment may continue")


@contextmanager
def gate_lock():
    import fcntl
    uid, gid = deployment_identity()
    descriptor = os.open(DIRECTORY / "lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(descriptor)
        if os.geteuid() == 0 and info.st_uid == 0:
            os.fchown(descriptor, uid, gid)
            info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != uid or info.st_mode & 0o077:
            raise Refused("Maintenance lock is not protected")
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(descriptor)


def create_flag(value):
    """Create an owned flag exclusively; never overwrite or clean up a rival."""
    uid, gid = deployment_identity()
    payload = json.dumps(value).encode() + b"\n"
    descriptor = os.open(DIRECTORY / "active", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
    with os.fdopen(descriptor, "wb") as stream:
        if os.geteuid() == 0:
            os.fchown(stream.fileno(), uid, gid)
        stream.write(payload)
        stream.flush()
        os.fsync(stream.fileno())


def refuse_failed_leave(existing):
    # Unlink takes effect before its directory durability barrier. Best-effort
    # restoration closes that window again, but must never replace a flag that
    # appeared meanwhile. Call only while holding gate_lock; leave a partial
    # restored file in place for manual recovery rather than silently removing it.
    restored = durable = False
    try:
        create_flag(existing)
        restored = True
        sync_directory(DIRECTORY)
        durable = True
    except (OSError, ValueError, Refused):
        pass
    try:
        current = read_flag()
    except (OSError, ValueError, Refused):
        state = "maintenance flag state is unknown; traffic gating and durability are unconfirmed"
    else:
        if current is None:
            state = "maintenance flag is inactive; traffic may be open and removal durability is unconfirmed"
        elif current != existing:
            state = "a replacement maintenance flag is active and was preserved; its ownership and durability need verification"
        elif restored and durable:
            state = "the owned maintenance flag was restored and directory-synced; live origin gating is not confirmed"
        else:
            state = "the owned maintenance flag is currently active; durability and live origin gating are not confirmed"
    raise Refused("Maintenance leave failed; " + state +
                  ". Verify status and the owner before recovery; re-enter the owned gate and repeat readiness checks before leave. "
                  "Do not remove a flag blindly.") from None


def manage(action: str, owner: str | None = None):
    require_installed()
    if action == "status":
        print("active" if read_flag() else "inactive")
        return
    if not owner or not TOKEN.fullmatch(owner):
        raise Refused("An explicit safe maintenance owner token is required")
    with gate_lock():
        existing = read_flag()
        if existing and existing["owner"] != owner:
            raise Refused("Maintenance belongs to another operation; refusing to adopt or remove it")
        if action == "enter" and not existing:
            create_flag({"version": 1, "owner": owner,
                         "createdAt": datetime.now(timezone.utc).isoformat()})
        elif action == "leave":
            if not existing:
                raise Refused("Maintenance is not active; refusing an unowned leave")
            # All cooperating operations hold gate_lock. Recheck immediately
            # before the destructive step as an additional guard against manual
            # changes; this is not exclusion against an admin bypassing the lock.
            if read_flag() != existing:
                raise Refused("Maintenance flag changed before leave; no removal attempted. Verify status and owner before recovery")
            try:
                (DIRECTORY / "active").unlink()
                sync_directory(DIRECTORY)
                if read_flag() is not None:
                    raise Refused("Maintenance flag appeared during leave and was preserved; verify status and owner before recovery")
            except OSError:
                refuse_failed_leave(existing)
        if action == "enter":
            # Retry this barrier even for an existing owned flag: a previous
            # enter may have stopped after file fsync but before directory fsync.
            sync_directory(DIRECTORY)
            # Also prove a previously loaded Nginx configuration actually gates
            # traffic. A marker file or unchanged config on disk is insufficient.
            verify_active_origin()
    print("active" if action == "enter" else "inactive")


def command(args):
    result = subprocess.run(args, capture_output=True, timeout=30,
                            env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C", "LC_ALL": "C"})
    if result.returncode:
        raise Refused("Configuration command failed; native output withheld")
    return result.stdout


def atomic_write(path: Path, data: bytes, mode=0o644):
    descriptor, temporary = tempfile.mkstemp(prefix=".wotcv-maintenance-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
        sync_directory(path.parent)
    finally:
        Path(temporary).unlink(missing_ok=True)


def sync_directory(path: Path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


@contextmanager
def install_lock():
    import fcntl
    path = Path("/run/lock/wotcv-deploy.lock")
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o002:
            raise Refused("Untrusted operations lock")
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(descriptor)


def installation_plan():
    trusted_root_path(SNIPPET)
    original = regular_bytes(SNIPPET)
    if original not in (BASE.encode(), CONTENT):
        raise Refused("Unknown tracking snippet changes; refusing replacement")
    vhost = reviewed_vhost()
    graph = command(["/usr/sbin/nginx", "-T"]).decode()
    includes = re.findall(r"^\s*include\s+/etc/nginx/snippets/wotcv-tracking-noindex\.conf\s*;", graph, re.M)
    if len(includes) != 2 or len(re.findall(r"^\s*include\s+" + re.escape(str(SNIPPET)) + r"\s*;", vhost, re.M)) != 2:
        raise Refused("Tracking snippet is not isolated to the two inspected server blocks")
    previous_tmpfiles = None
    if TMPFILES.exists() or TMPFILES.is_symlink():
        trusted_root_path(TMPFILES)
        previous_tmpfiles = regular_bytes(TMPFILES)
        if previous_tmpfiles != TMPFILES_CONTENT:
            raise Refused("Unknown tmpfiles configuration; refusing replacement")
    trusted_root_path(TMPFILES.parent, directory=True)
    if DIRECTORY.exists() or DIRECTORY.is_symlink():
        uid, _ = deployment_identity()
        info = DIRECTORY.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != uid or stat.S_IMODE(info.st_mode) != 0o755:
            raise Refused("Unknown maintenance runtime directory")
        if (DIRECTORY / "active").exists() or (DIRECTORY / "active").is_symlink():
            raise Refused("Do not install configuration during an active maintenance operation")
    return original, previous_tmpfiles


def install(check=False):
    if os.name != "posix" or os.geteuid() != 0:
        raise Refused("Gate installation/check needs sudo; runtime status/enter/leave do not")
    plan = installation_plan()
    if check:
        print("CHECK PASS: dedicated tracking gate can be installed; no files changed")
        return
    with install_lock():
        if installation_plan() != plan:
            raise Refused("Configuration changed during preflight")
        trusted_root_path(BACKUPS.parent, directory=True)
        BACKUPS.mkdir(mode=0o700, exist_ok=True)
        trusted_root_path(BACKUPS, directory=True)
        if stat.S_IMODE(BACKUPS.stat().st_mode) != 0o700:
            raise Refused("Maintenance backup directory must have mode 0700")
        sync_directory(BACKUPS.parent)
        backup = Path(tempfile.mkdtemp(prefix=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ-"), dir=BACKUPS))
        atomic_write(backup / "snippet.before.conf", plan[0], 0o600)
        atomic_write(backup / "snippet.after.conf", CONTENT, 0o600)
        atomic_write(backup / "audit.json", json.dumps({"version": 1, "snippet": str(SNIPPET),
                     "before": hashlib.sha256(plan[0]).hexdigest(), "after": hashlib.sha256(CONTENT).hexdigest(),
                     "servicesRestarted": False, "databaseCommandsRun": False}).encode(), 0o600)
        sync_directory(BACKUPS)
        uid, gid = deployment_identity()
        if not DIRECTORY.exists():
            DIRECTORY.mkdir(mode=0o755)
            os.chown(DIRECTORY, uid, gid)
            os.chmod(DIRECTORY, 0o755)
        # Also retry a mkdir barrier left incomplete by an earlier installation.
        sync_directory(DIRECTORY.parent)
        try:
            atomic_write(TMPFILES, TMPFILES_CONTENT)
            atomic_write(SNIPPET, CONTENT)
            command(["/usr/sbin/nginx", "-t"])
            command(["/usr/bin/systemctl", "reload", "nginx.service"])
            require_installed()
        except BaseException:
            if regular_bytes(SNIPPET) == CONTENT:
                atomic_write(SNIPPET, plan[0])
            if regular_bytes(TMPFILES) == TMPFILES_CONTENT:
                if plan[1] is None:
                    TMPFILES.unlink()
                    sync_directory(TMPFILES.parent)
                else:
                    atomic_write(TMPFILES, plan[1])
            command(["/usr/sbin/nginx", "-t"])
            command(["/usr/bin/systemctl", "reload", "nginx.service"])
            raise
        print(f"INSTALLED tracking-only maintenance gate; inactive. Backup: {backup}")
        print("Nginx reloaded; no application/container restart, deployment or migration was run")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    sub.add_parser("status")
    for name in ("enter", "leave"):
        action = sub.add_parser(name)
        action.add_argument("--owner", required=True)
    setup = sub.add_parser("install")
    setup.add_argument("--check", action="store_true")
    args = parser.parse_args()
    try:
        if args.action == "install":
            install(args.check)
        else:
            manage(args.action, getattr(args, "owner", None))
        return 0
    except (OSError, ValueError, Refused, subprocess.SubprocessError) as error:
        print(f"Maintenance refused: {error if isinstance(error, Refused) else 'system validation failed; details withheld'}", file=sys.stderr)
        if args.action == "enter":
            print("A maintenance flag may remain active; verify status and the owner before recovery. Do not remove it blindly.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
