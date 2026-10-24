"""Known-drift reconciliation: no production Docker, credentials or databases."""

from contextlib import nullcontext
import copy
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
SPEC = importlib.util.spec_from_file_location("wotcv_reconcile", ROOT / "scripts/wotcv-reconcile-compose.py")
RECONCILE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RECONCILE)
ROTATION = b"    logging:\n      driver: json-file\n      options:\n        max-size: 50m\n        max-file: '5'\n"


def files():
    head, current = {}, {}
    for name, count in RECONCILE.COUNTS.items():
        entries = [f"  service{i}:\n    image: example:test\n".encode() for i in range(count)]
        head[name] = b"services:\n" + b"".join(entries)
        current[name] = b"services:\n" + b"".join(entry + ROTATION for entry in entries)
    return head, current


def config():
    return {
        "name": "rybbit",
        "services": {name: {"logging": copy.deepcopy(RECONCILE.EXPECTED_LOGGING), "ports": [], "volumes": []}
                     for name in RECONCILE.SERVICES},
        "volumes": {name: {"name": "rybbit_" + name, "external": True}
                    for name in ("clickhouse-data", "postgres-data", "redis-data")},
    }


class KnownDriftTests(unittest.TestCase):
    def test_accepts_only_the_inspected_exact_additions(self):
        head, current = files()
        RECONCILE.known_drift(head, current)
        for name in RECONCILE.FILES:
            for change in (b"# unrelated\n", b"    ports: [\"0.0.0.0:6379:6379\"]\n"):
                altered = {**current, name: current[name] + change}
                with self.subTest(file=name), self.assertRaises(RECONCILE.Refused):
                    RECONCILE.known_drift(head, altered)

    def test_rejects_missing_duplicate_changed_or_reformatted_rotations(self):
        head, current = files()
        name = RECONCILE.FILES[0]
        for value in (head[name], current[name] + ROTATION,
                      current[name].replace(b"50m", b"100m"),
                      current[name].replace(b"'5'", b"10"),
                      current[name].replace(b"json-file", b"journald")):
            with self.subTest(value=value), self.assertRaises(RECONCILE.Refused):
                RECONCILE.known_drift(head, {**current, name: value})

    def test_status_refuses_staged_extra_untracked_or_missing_changes(self):
        valid = b"\0".join(b" M " + name.encode() for name in RECONCILE.FILES) + b"\0"
        RECONCILE.require_known_status(valid)
        for value in (b"", valid.replace(b" M ", b"M  ", 1), valid + b"?? extra\0",
                      valid + b" M tracked.txt\0", valid.replace(b" M ", b"MM ", 1)):
            with self.subTest(value=value), self.assertRaises(RECONCILE.Refused):
                RECONCILE.require_known_status(value)

    def test_logging_contract_matches_the_shared_validator(self):
        sys.path.insert(0, str(ROOT / "scripts/lib"))
        from wotcv_logging import EXPECTED_LOGGING, SERVICES
        self.assertEqual(RECONCILE.EXPECTED_LOGGING, EXPECTED_LOGGING)
        self.assertEqual(RECONCILE.SERVICES, SERVICES)

    def test_target_requires_exact_rotation_on_every_service(self):
        RECONCILE.validate_config(config())
        for name in RECONCILE.SERVICES:
            for size in ("100m", None):
                candidate = config()
                if size:
                    candidate["services"][name]["logging"]["options"]["max-size"] = size
                else:
                    candidate["services"][name].pop("logging")
                with self.subTest(service=name), self.assertRaises(RECONCILE.Refused):
                    RECONCILE.validate_config(candidate)

    def test_legacy_image_chain_can_lack_logs_but_target_cannot(self):
        candidate = config()
        candidate["services"]["backend"].pop("logging")
        RECONCILE.validate_config(candidate, require_logging=False)
        with self.assertRaises(RECONCILE.Refused):
            RECONCILE.validate_config(candidate)

    def test_rejects_exposed_ports_project_and_volume_drift(self):
        candidates = []
        for name in RECONCILE.SERVICES:
            value = config()
            value["services"][name]["ports"] = [{"host_ip": "0.0.0.0", "target": 1234}]
            candidates.append(value)
        for field, value in (("name", "wrong"), ("external", False)):
            candidate = config()
            candidate["volumes"]["postgres-data"][field] = value
            candidates.append(candidate)
        candidate = config()
        candidate["name"] = "wrong"
        candidates.append(candidate)
        for candidate in candidates:
            with self.subTest(candidate=candidate), self.assertRaises(RECONCILE.Refused):
                RECONCILE.validate_config(candidate)

    def test_effective_mount_and_port_changes_are_refused(self):
        before = config()
        RECONCILE.require_same_storage_and_ports(before, copy.deepcopy(before))
        for field in ("ports", "volumes", "networks", "container_name"):
            candidate = copy.deepcopy(before)
            candidate["services"]["postgres"][field] = "changed"
            with self.subTest(field=field), self.assertRaises(RECONCILE.Refused):
                RECONCILE.require_same_storage_and_ports(before, candidate)

    def test_command_failure_does_not_echo_secrets(self):
        result = subprocess.CompletedProcess([], 1, stdout=b"password=sentinel", stderr=b"password=sentinel")
        with patch.object(RECONCILE.subprocess, "run", return_value=result):
            with self.assertRaises(RECONCILE.Refused) as error:
                RECONCILE.command(ROOT, ["docker", "compose"])
        self.assertNotIn("sentinel", str(error.exception))

    def test_target_must_not_track_environment_or_deployment_state(self):
        for name in (".env", ".env.production", "client/.env.local", ".wotcv-deployment.env"):
            with self.subTest(name=name), patch.object(RECONCILE, "git", side_effect=[name.encode() + b"\0", b""]):
                with self.assertRaisesRegex(RECONCILE.Refused, "protected environment/state"):
                    RECONCILE.require_safe_target_files(ROOT, "a" * 40)

    def test_target_must_not_overwrite_an_existing_ignored_file(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            (repo / "ignored.txt").write_text("keep me")
            with patch.object(RECONCILE, "git", side_effect=[b"ignored.txt\0", b""]):
                with self.assertRaisesRegex(RECONCILE.Refused, "existing untracked/ignored"):
                    RECONCILE.require_safe_target_files(repo, "a" * 40)
            self.assertEqual((repo / "ignored.txt").read_text(), "keep me")

    def test_target_compose_paths_must_not_be_symlinks(self):
        names = b"\0".join(name.encode() for name in RECONCILE.FILES) + b"\0"
        for bad in RECONCILE.FILES:
            entries = b"\0".join(
                (b"120000" if name == bad else b"100644") + b" blob " + b"a" * 40 + b"\t" + name.encode()
                for name in RECONCILE.FILES
            ) + b"\0"
            with self.subTest(file=bad), patch.object(RECONCILE, "git", side_effect=[names, names, entries]):
                with self.assertRaisesRegex(RECONCILE.Refused, "regular tracked files"):
                    RECONCILE.require_safe_target_files(ROOT, "a" * 40)


@unittest.skipUnless(os.name == "posix", "Linux required for real Git/atomic-file reconciliation fixtures")
class ReconcileIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.outer = Path(self.directory.name)
        self.repo = self.outer / "repository"
        self.repo.mkdir()
        self.backups = self.outer / "backups"
        self.git("init", "-b", "feat/wotcv")
        self.git("config", "user.name", "Isolated test")
        self.git("config", "user.email", "isolated@example.invalid")
        self.git("config", "core.autocrlf", "false")
        (self.repo / ".gitignore").write_text(".env\n.wotcv-deployment.env\n")
        (self.repo / ".env").write_text("FAKE_SECRET=never-print\n")
        self.head_files, self.originals = files()
        for name, data in self.head_files.items():
            (self.repo / name).write_bytes(data)
        self.git("add", ".")
        self.git("commit", "-m", "isolated baseline")
        self.head = self.git("rev-parse", "HEAD").strip()
        self.git("switch", "-c", "candidate")
        (self.repo / RECONCILE.FILES[1]).write_bytes(self.head_files[RECONCILE.FILES[1]] + b"# repaired target\n")
        self.git("commit", "-am", "isolated target")
        self.target = self.git("rev-parse", "HEAD").strip()
        self.git("update-ref", "refs/remotes/origin/feat/wotcv", self.target)
        self.git("switch", "feat/wotcv")
        for name, data in self.originals.items():
            (self.repo / name).write_bytes(data)
        self.hook_flag = self.outer / "hook-ran"
        hook = self.repo / ".git/hooks/post-merge"
        hook.write_text(f"#!/bin/sh\ntouch '{self.hook_flag}'\n")
        hook.chmod(0o700)
        self.addCleanup(patch.stopall)
        patch.object(RECONCILE, "require_owner_platform").start()
        patch.object(RECONCILE, "lock_file", side_effect=lambda _: nullcontext()).start()
        patch.object(RECONCILE, "render", side_effect=lambda *args, **kwargs: config()).start()
        patch.object(RECONCILE, "runtime", return_value={"synthetic": "unchanged"}).start()
        patch.object(RECONCILE, "health", return_value={"status": "ok", "gitSha": "unchanged"}).start()

    def git(self, *args):
        return subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", *args],
                              cwd=self.repo, check=True, capture_output=True, text=True).stdout

    def test_check_retains_all_dirty_files_and_protects_backup(self):
        audit = RECONCILE.reconcile(self.repo, self.backups, self.target, False, False)
        self.assertEqual(self.git("rev-parse", "HEAD").strip(), self.head)
        self.assertEqual(audit.stat().st_mode & 0o777, 0o700)
        for name, data in self.originals.items():
            self.assertEqual((self.repo / name).read_bytes(), data)
            self.assertEqual((audit / "original" / name).read_bytes(), data)
            self.assertEqual((audit / "original" / name).stat().st_mode & 0o777, 0o600)
        self.assertNotIn("never-print", (audit / "manifest.json").read_text())

    def test_apply_fast_forwards_without_running_hooks_or_altering_env(self):
        environment = (self.repo / ".env").read_bytes()
        audit = RECONCILE.reconcile(self.repo, self.backups, self.target, True, False)
        self.assertEqual(self.git("rev-parse", "HEAD").strip(), self.target)
        self.assertEqual(self.git("status", "--porcelain"), "")
        self.assertEqual((self.repo / ".env").read_bytes(), environment)
        self.assertFalse(self.hook_flag.exists())
        self.assertTrue((audit / "success.json").exists())

    def test_failed_fast_forward_restores_original_drift(self):
        original_git = RECONCILE.git
        def fail_merge(repo, *args):
            if args[0] == "-c":
                raise RECONCILE.Refused("Synthetic merge failure")
            return original_git(repo, *args)
        with patch.object(RECONCILE, "git", side_effect=fail_merge):
            with self.assertRaisesRegex(RECONCILE.Refused, "Synthetic merge failure"):
                RECONCILE.reconcile(self.repo, self.backups, self.target, True, False)
        for name, data in self.originals.items():
            self.assertEqual((self.repo / name).read_bytes(), data)
        self.assertEqual(self.git("rev-parse", "HEAD").strip(), self.head)

    def test_unpublished_target_and_extra_files_are_refused_without_mutation(self):
        with self.assertRaises(RECONCILE.Refused):
            RECONCILE.reconcile(self.repo, self.backups, self.head, True, False)
        (self.repo / "unexpected.txt").write_text("keep me")
        with self.assertRaises(RECONCILE.Refused):
            RECONCILE.reconcile(self.repo, self.backups, self.target, True, False)
        self.assertEqual((self.repo / "unexpected.txt").read_text(), "keep me")
        for name, data in self.originals.items():
            self.assertEqual((self.repo / name).read_bytes(), data)

    def test_environment_change_during_preflight_prevents_restore(self):
        def changed_health():
            (self.repo / ".env").write_text("changed by other actor\n")
            return {"status": "ok"}
        with patch.object(RECONCILE, "health", side_effect=changed_health):
            with self.assertRaisesRegex(RECONCILE.Refused, "changed during preflight"):
                RECONCILE.reconcile(self.repo, self.backups, self.target, True, False)
        for name, data in self.originals.items():
            self.assertEqual((self.repo / name).read_bytes(), data)

    def test_backup_only_never_calls_docker_or_health(self):
        with patch.object(RECONCILE, "render", side_effect=AssertionError("must not render")), \
             patch.object(RECONCILE, "runtime", side_effect=AssertionError("must not inspect")), \
             patch.object(RECONCILE, "health", side_effect=AssertionError("must not probe")):
            audit = RECONCILE.reconcile(self.repo, self.backups, None, False, True)
        self.assertTrue((audit / "manifest.json").exists())
        self.assertEqual(self.git("rev-parse", "HEAD").strip(), self.head)
        for name, data in self.originals.items():
            self.assertEqual((self.repo / name).read_bytes(), data)

    def test_partial_restore_failure_recovers_all_three_originals(self):
        original_replace = RECONCILE.replace_file
        calls = 0
        def fail_once(path, data):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("Synthetic write failure")
            return original_replace(path, data)
        with patch.object(RECONCILE, "replace_file", side_effect=fail_once):
            with self.assertRaisesRegex(OSError, "Synthetic write failure"):
                RECONCILE.reconcile(self.repo, self.backups, self.target, True, False)
        self.assertEqual(self.git("rev-parse", "HEAD").strip(), self.head)
        for name, data in self.originals.items():
            self.assertEqual((self.repo / name).read_bytes(), data)

    def test_real_git_target_cannot_force_track_ignored_environment(self):
        self.git("read-tree", self.target)
        self.git("add", "-f", ".env")
        tree = self.git("write-tree").strip()
        unsafe = self.git("commit-tree", tree, "-p", self.target, "-m", "isolated unsafe target").strip()
        self.git("read-tree", "HEAD")
        self.git("update-ref", "refs/remotes/origin/feat/wotcv", unsafe)
        with self.assertRaisesRegex(RECONCILE.Refused, "protected environment/state"):
            RECONCILE.reconcile(self.repo, self.backups, unsafe, True, False)
        self.assertEqual((self.repo / ".env").read_text(), "FAKE_SECRET=never-print\n")
        self.assertEqual(self.git("rev-parse", "HEAD").strip(), self.head)


if __name__ == "__main__":
    unittest.main()
