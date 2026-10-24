"""Native backup safety contracts; all production interfaces are mocked."""

from contextlib import nullcontext
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("wotcv_runtime_backup", ROOT / "scripts/wotcv-create-runtime-backup.py")
BACKUP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BACKUP)
RUNTIME = BACKUP.RUNTIME


class BackupTests(unittest.TestCase):
    def test_native_verifier_is_pinned_offline_readonly_and_bypasses_entrypoint(self):
        image = "sha256:" + "a" * 64
        with patch.object(RUNTIME, "command") as command:
            BACKUP.native_verify(Path("repo"), image, "pg_restore", Path("/private/postgres.dump"), "--list")
        args = command.call_args.args[1]
        self.assertEqual(args[:5], ["docker", "run", "--rm", "--pull", "never"])
        for value in ("none", "--read-only", "ALL", "no-new-privileges", "--entrypoint", "pg_restore", image):
            self.assertIn(value, args)
        self.assertIn(f"type=bind,src={Path('/private/postgres.dump')},dst=/backup,readonly", args)
        self.assertEqual(args[-2:], ["--list", "/backup"])
        for image, tool in (("postgres:latest", "pg_restore"), (image, "sh")):
            with self.assertRaises(RUNTIME.Refused):
                BACKUP.native_verify(Path("repo"), image, tool, Path("/private/dump"))

    def test_preflight_requires_matching_gate_and_cleanly_stopped_backend(self):
        for state in ({"Status": "running", "ExitCode": 0}, {"Status": "exited", "ExitCode": 143}):
            with patch.object(RUNTIME, "require_gate") as gate, \
                    patch.object(RUNTIME, "plan", return_value=({}, {"backend": {"State": state}}, ())), \
                    self.assertRaisesRegex(RUNTIME.Refused, "cleanly stopped"):
                BACKUP.preflight(Path("repo"), "mine")
            gate.assert_called_once_with("mine")

    def test_check_has_no_locks_directories_or_database_backup(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(BACKUP, "preflight"), \
                patch.object(RUNTIME, "lock_file") as lock, patch.object(BACKUP, "stream_artifact") as backup, \
                patch.object(Path, "mkdir") as mkdir, patch("builtins.print"):
            BACKUP.create(Path(temporary), owner="mine", apply=False)
        lock.assert_not_called()
        backup.assert_not_called()
        mkdir.assert_not_called()

    def test_apply_refuses_nonroot_before_any_snapshot(self):
        with patch.object(BACKUP.os, "name", "posix"), \
                patch.object(BACKUP.os, "geteuid", return_value=1000, create=True), \
                self.assertRaisesRegex(RUNTIME.Refused, "root"):
            BACKUP.require_root()
        with tempfile.TemporaryDirectory() as temporary, \
                patch.object(BACKUP, "require_root", side_effect=RUNTIME.Refused("requires root")), \
                patch.object(BACKUP, "preflight") as preflight, self.assertRaises(RUNTIME.Refused):
            BACKUP.create(Path(temporary), owner="mine", apply=True)
            preflight.assert_not_called()

    def test_output_limit_is_installed_before_native_command_and_stderr_is_not_captured(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(BACKUP.os, "O_NOFOLLOW", 0, create=True), \
                patch.object(RUNTIME, "environment", return_value={}), \
                patch.object(BACKUP.subprocess, "run") as run:
            run.return_value.returncode = 0
            def fake_command(*args, **kwargs):
                kwargs["stdout"].write(b"PGDMP")
                return subprocess.CompletedProcess(args, 0)
            run.side_effect = fake_command
            BACKUP.stream_artifact(Path(temporary), ["fake-native-backup"], Path(temporary) / "dump")
            self.assertTrue(callable(run.call_args.kwargs["preexec_fn"]))
            self.assertEqual(run.call_args.kwargs["stderr"], subprocess.DEVNULL)
            self.assertEqual(run.call_args.kwargs["timeout"], 180)

    def test_success_publishes_contract_only_after_independent_verification(self):
        self.backup_flow(fail_verification=False)

    def test_failed_verification_never_publishes_usable_manifest(self):
        self.backup_flow(fail_verification=True)

    def test_late_directory_sync_failure_invalidates_published_manifest(self):
        self.backup_flow(fail_verification=False, fail_publication=True)

    def test_new_backup_root_parent_sync_failure_prevents_native_backups(self):
        for existing in (False, True):
            with self.subTest(existing=existing):
                self.backup_flow(fail_verification=False, fail_parent=True, existing_root=existing)

    def backup_flow(self, *, fail_verification, fail_publication=False, fail_parent=False, existing_root=False):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            if existing_root:
                (root / "backups").mkdir()
            records = {name: {"Id": str(index) * 64, "Image": "sha256:" + str(index) * 64,
                             "Config": {"Cmd": ["redis-server", "--requirepass", "not-in-output"]}}
                       for index, name in enumerate(("postgres", "redis"), 1)}
            pg = {"system_identifier": "123"}
            def write_artifact(repo, args, path, **kwargs):
                path.write_bytes(b"PGDMP fixture" if path.suffix == ".dump" else
                                 b"REDIS fixture" if path.suffix == ".rdb" else b"private globals")
            def checksum(path, magic):
                return hashlib.sha256(path.read_bytes()).hexdigest()
            def verify(repo, path, current, snapshot):
                self.assertEqual(path.name, "manifest.pending.json")
                self.assertFalse(path.with_name("manifest.json").exists())
                if fail_verification:
                    raise RUNTIME.Refused("native verification failure")
                return path.read_bytes()
            def sync_directory(path, **kwargs):
                if fail_parent and path == root:
                    self.assertIs(kwargs.get("private"), False)
                    raise OSError("fixture parent sync failure")
                if fail_publication and (path / "manifest.json").exists():
                    raise OSError("fixture fsync failure")
            with patch.object(BACKUP, "require_root"), \
                    patch.object(BACKUP.os, "O_NOFOLLOW", 0, create=True), \
                    patch.object(RUNTIME, "uid", return_value=root.stat().st_uid), \
                    patch.object(RUNTIME, "lock_file", side_effect=lambda *args: nullcontext()), \
                    patch.object(BACKUP, "preflight", return_value=({}, records)), \
                    patch.object(RUNTIME, "postgres_snapshot", return_value=pg), \
                    patch.object(RUNTIME, "redis_snapshot", return_value={}), \
                    patch.object(RUNTIME, "protected_directory") as protected, \
                    patch.object(RUNTIME, "stable_runtime", return_value={}), \
                    patch.object(RUNTIME, "compare_data"), \
                    patch.object(RUNTIME, "sha256_file", side_effect=checksum), \
                    patch.object(RUNTIME, "verify_backup", side_effect=verify), \
                    patch.object(RUNTIME, "sync_directory", side_effect=sync_directory, create=True), \
                    patch.object(BACKUP, "stream_artifact", side_effect=write_artifact) as stream, \
                    patch.object(BACKUP, "native_verify") as native, \
                    patch.object(BACKUP.shutil, "disk_usage", return_value=type("Disk", (), {"free": 4 * 1024**3})()), \
                    patch("builtins.print"):
                if fail_parent:
                    with self.assertRaisesRegex(OSError, "parent sync failure"):
                        BACKUP.create(root, owner="mine", apply=True, backup_root=root / "backups")
                    stream.assert_not_called()
                    native.assert_not_called()
                    self.assertEqual(list((root / "backups").iterdir()), [])
                elif fail_verification or fail_publication:
                    error = OSError if fail_publication else RUNTIME.Refused
                    with self.assertRaisesRegex(error, "fsync failure" if fail_publication else "verification failure"):
                        BACKUP.create(root, owner="mine", apply=True, backup_root=root / "backups")
                    directory = next((root / "backups").iterdir())
                    self.assertTrue((directory / "failed.json").exists())
                    self.assertFalse((directory / "manifest.json").exists())
                    if fail_publication:
                        self.assertTrue((directory / "manifest.invalid.json").exists())
                else:
                    manifest = BACKUP.create(root, owner="mine", apply=True, backup_root=root / "backups")
                    value = json.loads(manifest.read_text())
                    self.assertEqual(value["schema"], "wotcv-runtime-logging-backup-v1")
                    self.assertEqual(value["postgres"]["verified_by"], "pg_restore --list")
                    self.assertEqual(value["redis"]["verified_by"], "redis-check-rdb")
                    self.assertEqual(value["postgres"]["system_identifier"], "123")
                    self.assertNotIn("not-in-output", manifest.read_text())
                    self.assertEqual(native.call_count, 2)
                protected.assert_any_call(root, private=False)

    @unittest.skipUnless(os.name == "posix", "Linux RLIMIT_FSIZE required")
    def test_native_file_size_limit_stops_oversized_fixture(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(RUNTIME, "environment", return_value=dict(os.environ)), \
                patch.object(BACKUP, "MAX_ARTIFACT_BYTES", 16384):
            target = Path(temporary) / "oversized.dump"
            with self.assertRaises(RUNTIME.Refused):
                BACKUP.stream_artifact(Path(temporary), [sys.executable, "-c", "import sys;sys.stdout.buffer.write(b'x'*131072)"], target)
            self.assertLessEqual(target.stat().st_size, 16384)


if __name__ == "__main__":
    unittest.main()
