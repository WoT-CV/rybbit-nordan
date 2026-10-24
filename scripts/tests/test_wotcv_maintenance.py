"""Maintenance gate ownership, narrow installation and fixture-only file tests."""

from contextlib import contextmanager, nullcontext, redirect_stderr, redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import socket
import stat
import subprocess
import tempfile
import time
from types import SimpleNamespace
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("wotcv_maintenance", ROOT / "scripts/wotcv-maintenance.py")
GATE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GATE)


class GateTests(unittest.TestCase):
    def test_asset_matches_installer_and_retains_noindex(self):
        self.assertEqual((ROOT / "ops/nginx/wotcv-search-noindex.conf").read_text(), GATE.CONTENT.decode())
        self.assertEqual(GATE.CONTENT.count(b"return 410"), 2)
        self.assertIn(b'return 503 "Tracking maintenance;', GATE.CONTENT)
        self.assertIn(b"Retry-After $wotcv_maintenance_retry_after always", GATE.CONTENT)
        self.assertIn(b"Cache-Control $wotcv_maintenance_cache always", GATE.CONTENT)
        self.assertEqual(GATE.DIRECTORY, Path("/var/lib/wotcv-rybbit-maintenance"))
        self.assertIn(b"d /var/lib/wotcv-rybbit-maintenance 0755 wotcv wotcv -", GATE.TMPFILES_CONTENT)
        self.assertNotIn(b"/run/wotcv-rybbit-maintenance", GATE.CONTENT)

    def test_status_is_read_only_and_has_stable_machine_output(self):
        for existing, state in ((None, "inactive"), ({"owner": "test"}, "active")):
            with self.subTest(state=state), patch.object(GATE, "require_installed"), \
                    patch.object(GATE, "read_flag", return_value=existing), \
                    patch.object(GATE, "gate_lock") as lock, patch.object(GATE, "create_flag") as create, \
                    patch.object(GATE, "sync_directory") as sync, patch.object(GATE, "verify_active_origin") as canary, \
                    patch.object(GATE.os, "open") as opening, patch.object(Path, "unlink") as unlink, \
                    redirect_stdout(io.StringIO()) as output:
                GATE.manage("status")
                self.assertEqual(output.getvalue(), state + "\n")
                for mutation in (lock, create, sync, canary, opening, unlink):
                    mutation.assert_not_called()

    def test_failed_leave_reports_inactive_or_unknown_if_restoration_fails(self):
        existing = {"version": 1, "owner": "mine"}
        for current, error, expected in ((None, None, "flag is inactive; traffic may be open"),
                                         (None, OSError("unreadable"), "flag state is unknown"),
                                         (None, GATE.Refused("untrusted"), "flag state is unknown")):
            with self.subTest(expected=expected, error=error), \
                    patch.object(GATE, "create_flag", side_effect=OSError("cannot restore")), \
                    patch.object(GATE, "read_flag", return_value=current, side_effect=error), \
                    patch.object(GATE, "sync_directory") as sync, patch.object(Path, "unlink") as unlink, \
                    self.assertRaisesRegex(GATE.Refused, expected) as refused:
                GATE.refuse_failed_leave(existing)
            self.assertIn("Do not remove a flag blindly", str(refused.exception))
            self.assertNotIn("retained", str(refused.exception))
            sync.assert_not_called()
            unlink.assert_not_called()

    def test_failed_leave_preserves_a_competing_flag_instead_of_overwriting_it(self):
        existing = {"version": 1, "owner": "mine"}
        replacement = {"version": 1, "owner": "other"}
        with patch.object(GATE, "create_flag", side_effect=FileExistsError("a competing flag exists")) as create, \
                patch.object(GATE, "read_flag", return_value=replacement), \
                patch.object(GATE, "sync_directory") as sync, patch.object(Path, "unlink") as unlink, \
                self.assertRaisesRegex(GATE.Refused, "replacement maintenance flag is active and was preserved"):
            GATE.refuse_failed_leave(existing)
        create.assert_called_once_with(existing)
        sync.assert_not_called()
        unlink.assert_not_called()

    def test_failed_leave_does_not_claim_durability_when_restore_sync_fails(self):
        existing = {"version": 1, "owner": "mine"}
        with patch.object(GATE, "create_flag"), patch.object(GATE, "read_flag", return_value=existing), \
                patch.object(GATE, "sync_directory", side_effect=OSError("restore barrier failed")), \
                self.assertRaisesRegex(GATE.Refused, "currently active; durability and live origin gating are not confirmed"):
            GATE.refuse_failed_leave(existing)

    def test_other_owner_cannot_enter_or_leave(self):
        for action in ("enter", "leave"):
            with self.subTest(action=action), patch.object(GATE, "require_installed"), \
                    patch.object(GATE, "gate_lock", return_value=nullcontext()), \
                    patch.object(GATE, "read_flag", return_value={"owner": "other"}), \
                    self.assertRaisesRegex(GATE.Refused, "another operation"):
                GATE.manage(action, "mine")

    def test_invalid_owner_and_unowned_leave_fail_closed(self):
        for owner in (None, "", "../other", "a\nb", "x" * 81):
            with self.subTest(owner=owner), patch.object(GATE, "require_installed"), \
                    self.assertRaisesRegex(GATE.Refused, "token"):
                GATE.manage("enter", owner)
        with patch.object(GATE, "require_installed"), patch.object(GATE, "gate_lock", return_value=nullcontext()), \
                patch.object(GATE, "read_flag", return_value=None), self.assertRaisesRegex(GATE.Refused, "not active"):
            GATE.manage("leave", "mine")

    def test_same_owner_enter_is_idempotent(self):
        with patch.object(GATE, "require_installed"), patch.object(GATE, "gate_lock", return_value=nullcontext()), \
                patch.object(GATE, "read_flag", return_value={"owner": "mine"}), \
                patch.object(GATE.os, "open") as opening, patch.object(GATE, "sync_directory") as sync, \
                patch.object(GATE, "verify_active_origin"), patch("builtins.print"):
            GATE.manage("enter", "mine")
            opening.assert_not_called()
            sync.assert_called_once_with(GATE.DIRECTORY)

    def test_idempotent_enter_retries_directory_sync_before_confirming_gate(self):
        with patch.object(GATE, "require_installed"), patch.object(GATE, "gate_lock", return_value=nullcontext()), \
                patch.object(GATE, "read_flag", return_value={"owner": "mine"}), \
                patch.object(GATE, "sync_directory", side_effect=[OSError("transient sync failure"), None]) as sync, \
                patch.object(GATE, "verify_active_origin") as canary, patch("builtins.print"):
            with self.assertRaisesRegex(OSError, "transient sync failure"):
                GATE.manage("enter", "mine")
            canary.assert_not_called()
            GATE.manage("enter", "mine")
            self.assertEqual(sync.call_count, 2)
            canary.assert_called_once()

    def test_active_origin_canary_checks_status_and_required_headers(self):
        good = b"HTTP/2 503\r\nRetry-After: 15\r\nCache-Control: no-store\r\nX-Robots-Tag: noindex, nofollow\r\n\r\n"
        with patch.object(GATE, "command", return_value=good) as command:
            GATE.verify_active_origin()
            args = command.call_args.args[0]
            self.assertIn("--resolve", args)
            self.assertIn("--noproxy", args)
        for altered in (good.replace(b"503", b"200"), good.replace(b"no-store", b"public"),
                        good.replace(b"Retry-After: 15", b"Other: 15"), good.replace(b"noindex", b"index")):
            with patch.object(GATE, "command", return_value=altered), self.assertRaises(GATE.Refused):
                GATE.verify_active_origin()

    def test_failed_canary_does_not_remove_an_owned_gate(self):
        with patch.object(GATE, "require_installed"), patch.object(GATE, "gate_lock", return_value=nullcontext()), \
                patch.object(GATE, "read_flag", return_value={"owner": "mine"}), \
                patch.object(GATE, "sync_directory"), \
                patch.object(GATE, "verify_active_origin", side_effect=GATE.Refused("canary")), \
                patch.object(Path, "unlink") as unlink, self.assertRaisesRegex(GATE.Refused, "canary"):
            GATE.manage("enter", "mine")
        unlink.assert_not_called()

    def test_flag_rejects_symlink_writable_and_foreign_metadata(self):
        for mode, owner in ((stat.S_IFLNK | 0o777, 1000), (stat.S_IFREG | 0o666, 1000),
                            (stat.S_IFREG | 0o644, 1001)):
            with patch.object(GATE, "deployment_identity", return_value=(1000, 1000)), \
                    patch.object(Path, "lstat", return_value=SimpleNamespace(st_mode=mode, st_uid=owner)), \
                    patch.object(GATE, "regular_bytes") as reading, self.assertRaises(GATE.Refused):
                GATE.read_flag()
            reading.assert_not_called()

    def test_malformed_flag_is_preserved(self):
        metadata = SimpleNamespace(st_mode=stat.S_IFREG | 0o644, st_uid=1000)
        for payload in (b"not json", b"[]", b'{"version":2,"owner":"mine"}', b'{"version":1,"owner":"../bad"}'):
            with self.subTest(payload=payload), patch.object(GATE, "deployment_identity", return_value=(1000, 1000)), \
                    patch.object(Path, "lstat", return_value=metadata), \
                    patch.object(GATE, "regular_bytes", return_value=payload), self.assertRaises(GATE.Refused):
                GATE.read_flag()

    def test_install_requires_root_before_commands(self):
        with patch.object(GATE.os, "name", "posix"), patch.object(GATE.os, "geteuid", return_value=1000, create=True), \
                patch.object(GATE, "installation_plan") as plan, self.assertRaises(GATE.Refused):
            GATE.install()
        plan.assert_not_called()

    def test_readonly_install_check_creates_no_locks_or_backup(self):
        with patch.object(GATE.os, "name", "posix"), patch.object(GATE.os, "geteuid", return_value=0, create=True), \
                patch.object(GATE, "installation_plan", return_value=(GATE.BASE.encode(), None)), \
                patch.object(GATE, "install_lock") as lock, patch.object(GATE, "atomic_write") as writing, \
                patch("builtins.print"):
            GATE.install(check=True)
            lock.assert_not_called()
            writing.assert_not_called()

    def test_unknown_snippet_is_not_overwritten(self):
        with patch.object(GATE, "trusted_root_path"), patch.object(GATE, "regular_bytes", return_value=b"other"), \
                patch.object(GATE, "command") as command, self.assertRaisesRegex(GATE.Refused, "Unknown tracking"):
            GATE.installation_plan()
        command.assert_not_called()

    def test_vhost_must_match_reviewed_bytes_not_just_include_count(self):
        data = b"server { include /etc/nginx/snippets/wotcv-tracking-noindex.conf; }"
        with patch.object(Path, "resolve", return_value=Path("/etc/nginx/sites-available/tracking.wot-cv.com")), \
                patch.object(GATE, "trusted_root_path"), patch.object(GATE, "regular_bytes", return_value=data), \
                self.assertRaisesRegex(GATE.Refused, "reviewed isolated"):
            GATE.reviewed_vhost()

    @unittest.skipUnless(os.name == "posix", "Linux installer permission contract required")
    def test_installer_private_umask_and_failed_nginx_validation_rollback(self):
        for failed in (False, True):
            with self.subTest(failed=failed), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                snippet, tmpfiles = root / "snippet.conf", root / "tmpfiles.conf"
                snippet.write_bytes(GATE.BASE.encode())
                def command(args):
                    if failed and args[-1] == "-t" and snippet.read_bytes() == GATE.CONTENT:
                        raise GATE.Refused("fixture Nginx validation failed")
                    return b""
                previous_umask = os.umask(0o077)
                try:
                    with patch.object(GATE, "SNIPPET", snippet), patch.object(GATE, "TMPFILES", tmpfiles), \
                            patch.object(GATE, "DIRECTORY", root / "runtime"), patch.object(GATE, "BACKUPS", root / "backups"), \
                            patch.object(GATE.os, "geteuid", return_value=0), \
                            patch.object(GATE.os, "chown"), patch.object(GATE, "trusted_root_path"), \
                            patch.object(GATE, "require_installed"), patch.object(GATE, "install_lock", return_value=nullcontext()), \
                            patch.object(GATE, "installation_plan", return_value=(GATE.BASE.encode(), None)), \
                            patch.object(GATE, "deployment_identity", return_value=(os.getuid(), os.getgid())), \
                            patch.object(GATE, "command", side_effect=command), patch("builtins.print"):
                        if failed:
                            with self.assertRaisesRegex(GATE.Refused, "Nginx validation failed"):
                                GATE.install()
                            self.assertEqual(snippet.read_bytes(), GATE.BASE.encode())
                            self.assertFalse(tmpfiles.exists())
                        else:
                            GATE.install()
                            self.assertEqual(snippet.read_bytes(), GATE.CONTENT)
                            self.assertEqual(tmpfiles.read_bytes(), GATE.TMPFILES_CONTENT)
                        self.assertEqual(stat.S_IMODE((root / "runtime").stat().st_mode), 0o755)
                        audit = next((root / "backups").iterdir())
                        self.assertEqual((audit / "snippet.before.conf").read_bytes(), GATE.BASE.encode())
                        self.assertEqual(stat.S_IMODE((audit / "audit.json").stat().st_mode), 0o600)
                finally:
                    os.umask(previous_umask)

    @unittest.skipUnless(os.name == "posix", "Linux directory sync required")
    def test_existing_backup_root_retry_cannot_skip_parent_barrier(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            snippet = root / "snippet.conf"
            snippet.write_bytes(GATE.BASE.encode())
            backups = root / "backups"
            backups.mkdir(mode=0o700)
            with patch.object(GATE, "SNIPPET", snippet), patch.object(GATE, "TMPFILES", root / "tmpfiles.conf"), \
                    patch.object(GATE, "DIRECTORY", root / "runtime"), patch.object(GATE, "BACKUPS", backups), \
                    patch.object(GATE.os, "geteuid", return_value=0), patch.object(GATE, "trusted_root_path"), \
                    patch.object(GATE, "install_lock", return_value=nullcontext()), \
                    patch.object(GATE, "installation_plan", return_value=(GATE.BASE.encode(), None)), \
                    patch.object(GATE, "sync_directory", side_effect=OSError("retry parent sync failure")) as sync, \
                    patch.object(GATE, "command") as command, self.assertRaisesRegex(OSError, "parent sync failure"):
                GATE.install()
            sync.assert_called_once_with(root)
            self.assertEqual(list(backups.iterdir()), [])
            self.assertEqual(snippet.read_bytes(), GATE.BASE.encode())
            self.assertFalse((root / "tmpfiles.conf").exists())
            command.assert_not_called()

    @unittest.skipUnless(os.name == "posix", "Linux directory sync required")
    def test_failed_backup_directory_sync_prevents_config_change(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            snippet = root / "snippet.conf"
            snippet.write_bytes(GATE.BASE.encode())
            real_sync = GATE.sync_directory
            def sync(path):
                if path == root / "backups":
                    raise OSError("fixture directory sync failure")
                real_sync(path)
            with patch.object(GATE, "SNIPPET", snippet), patch.object(GATE, "TMPFILES", root / "tmpfiles.conf"), \
                    patch.object(GATE, "DIRECTORY", root / "runtime"), patch.object(GATE, "BACKUPS", root / "backups"), \
                    patch.object(GATE.os, "geteuid", return_value=0), patch.object(GATE, "trusted_root_path"), \
                    patch.object(GATE, "install_lock", return_value=nullcontext()), \
                    patch.object(GATE, "installation_plan", return_value=(GATE.BASE.encode(), None)), \
                    patch.object(GATE, "sync_directory", side_effect=sync), patch.object(GATE, "command") as command, \
                    self.assertRaisesRegex(OSError, "directory sync failure"):
                GATE.install()
            self.assertEqual(snippet.read_bytes(), GATE.BASE.encode())
            self.assertFalse((root / "tmpfiles.conf").exists())
            self.assertFalse((root / "runtime").exists())
            command.assert_not_called()

    @contextmanager
    def owned_flag_directory(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(GATE, "DIRECTORY", Path(temporary)), \
                patch.object(GATE, "require_installed"), patch.object(GATE, "verify_active_origin") as canary, \
                patch.object(GATE, "deployment_identity", return_value=(os.getuid(), os.getgid())):
            with redirect_stdout(io.StringIO()):
                GATE.manage("enter", "fixture-owner")
            canary.reset_mock()
            yield Path(temporary) / "active", canary

    @unittest.skipUnless(os.name == "posix", "Linux flag durability contract required")
    def test_failed_leave_after_unlink_restores_owned_flag_then_allows_safe_retry(self):
        with self.owned_flag_directory() as (active, canary):
            original = active.read_bytes()
            observed = []
            real_sync = GATE.sync_directory
            def sync(path):
                observed.append(active.exists())
                if len(observed) == 1:
                    raise OSError("fsync after unlink failed")
                real_sync(path)
            with patch.object(GATE, "sync_directory", side_effect=sync), redirect_stdout(io.StringIO()) as output, \
                    self.assertRaisesRegex(GATE.Refused, "owned maintenance flag was restored and directory-synced"):
                GATE.manage("leave", "fixture-owner")
            self.assertEqual(observed, [False, True])
            self.assertEqual(output.getvalue(), "")
            self.assertEqual(active.read_bytes(), original)
            canary.assert_not_called()
            with redirect_stdout(io.StringIO()) as output:
                GATE.manage("status")
            self.assertEqual(output.getvalue(), "active\n")
            with redirect_stdout(io.StringIO()):
                GATE.manage("enter", "fixture-owner")
                GATE.manage("leave", "fixture-owner")
            canary.assert_called_once()
            self.assertIsNone(GATE.read_flag())
            with self.assertRaisesRegex(GATE.Refused, "unowned leave"):
                GATE.manage("leave", "fixture-owner")

    @unittest.skipUnless(os.name == "posix", "Linux flag durability contract required")
    def test_failed_leave_with_failed_restore_reports_actual_inactive_state(self):
        with self.owned_flag_directory() as (active, _):
            with patch.object(GATE, "sync_directory", side_effect=OSError("unlink barrier failed")), \
                    patch.object(GATE, "create_flag", side_effect=OSError("restore creation failed")), \
                    patch.object(GATE.sys, "argv", ["maintenance.py", "leave", "--owner", "fixture-owner"]), \
                    redirect_stdout(io.StringIO()) as output, redirect_stderr(io.StringIO()) as errors:
                self.assertEqual(GATE.main(), 1)
            self.assertFalse(active.exists())
            self.assertEqual(output.getvalue(), "")
            self.assertIn("flag is inactive; traffic may be open", errors.getvalue())
            self.assertIn("Do not remove a flag blindly", errors.getvalue())
            with redirect_stdout(io.StringIO()) as output:
                GATE.manage("status")
            self.assertEqual(output.getvalue(), "inactive\n")
            with self.assertRaisesRegex(GATE.Refused, "unowned leave"):
                GATE.manage("leave", "fixture-owner")
            with redirect_stdout(io.StringIO()):
                GATE.manage("enter", "fixture-owner")
                GATE.manage("leave", "fixture-owner")

    @unittest.skipUnless(os.name == "posix", "Linux flag durability contract required")
    def test_restored_gate_with_unconfirmed_directory_durability_can_be_reentered(self):
        with self.owned_flag_directory() as (active, canary):
            original = active.read_bytes()
            with patch.object(GATE, "sync_directory", side_effect=OSError("persistent directory barrier failure")) as sync, \
                    self.assertRaisesRegex(GATE.Refused, "currently active; durability and live origin gating are not confirmed"):
                GATE.manage("leave", "fixture-owner")
            self.assertEqual(sync.call_count, 2)
            self.assertEqual(active.read_bytes(), original)
            canary.assert_not_called()
            with redirect_stdout(io.StringIO()):
                GATE.manage("enter", "fixture-owner")
            canary.assert_called_once()
            self.assertEqual(active.read_bytes(), original)

    @unittest.skipUnless(os.name == "posix", "Linux flag ownership contract required")
    def test_leave_rechecks_owner_and_preserves_changes_before_unlink(self):
        for replacement in (None, {"version": 1, "owner": "other"}):
            with self.subTest(replacement=replacement), self.owned_flag_directory() as (active, _):
                real_read = GATE.read_flag
                reads = 0
                def read():
                    nonlocal reads
                    reads += 1
                    if reads == 2:
                        active.unlink()
                        if replacement:
                            GATE.create_flag(replacement)
                    return real_read()
                with patch.object(GATE, "read_flag", side_effect=read), \
                        self.assertRaisesRegex(GATE.Refused, "changed before leave; no removal attempted"):
                    GATE.manage("leave", "fixture-owner")
                self.assertEqual(real_read(), replacement)

    @unittest.skipUnless(os.name == "posix", "Linux flag ownership contract required")
    def test_replacement_during_leave_is_never_removed_even_when_sync_fails(self):
        for fail_sync in (False, True):
            with self.subTest(fail_sync=fail_sync), self.owned_flag_directory() as (active, _):
                replacement = {"version": 1, "owner": "other"}
                def sync(path):
                    self.assertFalse(active.exists())
                    GATE.create_flag(replacement)
                    if fail_sync:
                        raise OSError("barrier failure with competing owner")
                with patch.object(GATE, "sync_directory", side_effect=sync), \
                        self.assertRaisesRegex(GATE.Refused, "preserved"):
                    GATE.manage("leave", "fixture-owner")
                self.assertEqual(GATE.read_flag(), replacement)
                with self.assertRaisesRegex(GATE.Refused, "another operation"):
                    GATE.manage("leave", "fixture-owner")

    @unittest.skipUnless(os.name == "posix", "Linux flag ownership contract required")
    def test_concurrent_unlink_failure_restores_ownership_instead_of_claiming_success(self):
        with self.owned_flag_directory() as (active, _):
            original = active.read_bytes()
            real_unlink = Path.unlink
            def unlink(path, *args, **kwargs):
                real_unlink(path, *args, **kwargs)
                raise FileNotFoundError("flag disappeared at unlink")
            with patch.object(Path, "unlink", unlink), \
                    self.assertRaisesRegex(GATE.Refused, "owned maintenance flag was restored"):
                GATE.manage("leave", "fixture-owner")
            self.assertEqual(active.read_bytes(), original)

    @unittest.skipUnless(os.name == "posix", "Linux flock ownership contract required")
    def test_cooperating_operations_cannot_enter_or_leave_while_gate_is_locked(self):
        with self.owned_flag_directory() as (active, canary):
            original = active.read_bytes()
            with GATE.gate_lock():
                for action in ("enter", "leave"):
                    with self.subTest(action=action), self.assertRaises(BlockingIOError):
                        GATE.manage(action, "fixture-owner")
                with redirect_stdout(io.StringIO()) as output:
                    GATE.manage("status")
                self.assertEqual(output.getvalue(), "active\n")
            self.assertEqual(active.read_bytes(), original)
            canary.assert_not_called()

    @unittest.skipUnless(os.name == "posix", "Linux ownership and O_NOFOLLOW required")
    def test_native_flag_create_read_leave_in_isolated_directory(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(GATE, "DIRECTORY", Path(temporary)), \
                patch.object(GATE, "require_installed"), \
                patch.object(GATE, "verify_active_origin"), \
                patch.object(GATE, "deployment_identity", return_value=(os.getuid(), os.getgid())):
            GATE.manage("enter", "fixture-owner")
            self.assertEqual(GATE.read_flag()["owner"], "fixture-owner")
            # A fresh interpreter/operation sees the persisted owner, rather
            # than relying on process memory or an ephemeral /run directory.
            self.assertEqual(json.loads((Path(temporary) / "active").read_bytes())["owner"], "fixture-owner")
            GATE.manage("enter", "fixture-owner")
            with self.assertRaises(GATE.Refused):
                GATE.manage("leave", "different-owner")
            GATE.manage("leave", "fixture-owner")
            self.assertIsNone(GATE.read_flag())

    @unittest.skipUnless(os.name == "posix" and shutil.which("nginx"), "Isolated Linux Nginx required")
    def test_native_nginx_inactive_active_and_recovery_preserve_noindex(self):
        # A separate non-root Nginx, ephemeral loopback port and temporary flag;
        # never reload or signal the host's production Nginx.
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            with socket.socket() as probe:
                probe.bind(("127.0.0.1", 0))
                port = probe.getsockname()[1]
            active = directory / "active"
            snippet = directory / "snippet.conf"
            snippet.write_bytes(GATE.CONTENT.replace(str(GATE.DIRECTORY / "active").encode(), str(active).encode()))
            config = directory / "nginx.conf"
            config.write_text(f'pid {directory}/nginx.pid;\nerror_log {directory}/error.log;\n'
                              f'events {{ worker_connections 32; }}\nhttp {{ access_log off;\n'
                              f'server {{ listen 127.0.0.1:{port};\ninclude {snippet};\n'
                              'location / { return 200 "ready"; }\n}}\n')
            executable = shutil.which("nginx")
            checked = subprocess.run([executable, "-t", "-p", temporary + "/", "-c", str(config)], capture_output=True)
            self.assertEqual(checked.returncode, 0, checked.stderr.decode())
            process = subprocess.Popen([executable, "-p", temporary + "/", "-c", str(config),
                                        "-g", "daemon off; master_process off;"],
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                for _ in range(60):
                    try:
                        urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=1).close()
                        break
                    except OSError:
                        time.sleep(0.05)
                else:
                    self.fail("Isolated Nginx did not start")
                def request(path, method="GET"):
                    try:
                        return urllib.request.urlopen(urllib.request.Request(f"http://127.0.0.1:{port}{path}", method=method), timeout=2)
                    except urllib.error.HTTPError as response:
                        return response
                for path in ("/robots.txt", "/sitemap.xml"):
                    for method in ("GET", "HEAD"):
                        with request(path, method) as response:
                            self.assertEqual(response.status, 410)
                            self.assertEqual(response.read(), b"")
                            self.assertEqual(response.headers["Cache-Control"], "no-store")
                active.write_text("fixture")
                with request("/api/health") as response:
                    self.assertEqual(response.status, 503)
                    self.assertEqual(response.headers["Retry-After"], "15")
                    self.assertEqual(response.headers["Cache-Control"], "no-store")
                    self.assertIn("noindex", response.headers["X-Robots-Tag"])
                active.unlink()
                with request("/api/health") as response:
                    self.assertEqual(response.status, 200)
                    self.assertIsNone(response.headers.get("Retry-After"))
                    self.assertIn("noindex", response.headers["X-Robots-Tag"])
            finally:
                process.terminate()
                process.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
