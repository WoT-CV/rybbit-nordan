"""Retained updater repair: pure checks and isolated fixtures, no real root writes."""

from contextlib import nullcontext
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("wotcv_updater_install", ROOT / "scripts/wotcv-install-updater.py")
INSTALLER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(INSTALLER)
SHA = "a" * 40
SOURCE = b"#!/usr/bin/env bash\nset -Eeuo pipefail\n# reviewed updater, not executed\n"
BASELINE_MANIFEST = json.dumps({INSTALLER.MANIFEST_ENTRY: INSTALLER.LEGACY_SHA256}).encode()


def metadata(mode, uid=0, gid=0):
    return SimpleNamespace(st_mode=mode, st_uid=uid, st_gid=gid)


class ValidationTests(unittest.TestCase):
    def test_unknown_root_customizations_are_not_replaced(self):
        with self.assertRaisesRegex(INSTALLER.Refused, "neither the inspected legacy"):
            INSTALLER.require_known_target(b"unknown administrator edit", SOURCE)
        INSTALLER.require_known_target(SOURCE, SOURCE)
        with patch.object(INSTALLER, "digest", return_value=INSTALLER.LEGACY_SHA256):
            INSTALLER.require_known_target(b"fixture for inspected legacy bytes", SOURCE)

    def test_payload_manifest_must_keep_the_known_baseline_entry(self):
        with patch.object(INSTALLER, "require_metadata"), \
                patch.object(Path, "lstat", return_value=metadata(stat.S_IFREG | 0o644)), \
                patch.object(INSTALLER, "regular_bytes", return_value=BASELINE_MANIFEST):
            self.assertEqual(INSTALLER.manifest_snapshot(Path("release")),
                             (BASELINE_MANIFEST, INSTALLER.LEGACY_SHA256))
        for content in (b"{}", b"[]", json.dumps({INSTALLER.MANIFEST_ENTRY: "f" * 64}).encode()):
            with self.subTest(content=content), \
                    patch.object(INSTALLER, "require_metadata"), \
                    patch.object(Path, "lstat", return_value=metadata(stat.S_IFREG | 0o644)), \
                    patch.object(INSTALLER, "regular_bytes", return_value=content):
                with self.assertRaisesRegex(INSTALLER.Refused, "inspected legacy updater baseline"):
                    INSTALLER.manifest_snapshot(Path("release"))

    def test_environment_discards_shell_and_git_injection(self):
        with patch.dict(os.environ, {"BASH_ENV": "/bad", "GIT_DIR": "/bad", "GIT_CONFIG_COUNT": "1", "PATH": "/bad"}):
            environment = INSTALLER.safe_environment()
        for name in ("BASH_ENV", "ENV", "GIT_DIR", "GIT_CONFIG_COUNT", "LD_PRELOAD", "PYTHONPATH"):
            self.assertNotIn(name, environment)
        self.assertEqual(environment["PATH"], "/usr/sbin:/usr/bin:/sbin:/bin")
        self.assertEqual(environment["GIT_OPTIONAL_LOCKS"], "0")

    def test_commands_use_only_sanitized_environment_and_withhold_errors(self):
        result = subprocess.CompletedProcess([], 1, stdout=b"secret-sentinel", stderr=b"secret-sentinel")
        with patch.object(INSTALLER.subprocess, "run", return_value=result) as run:
            with self.assertRaises(INSTALLER.Refused) as error:
                INSTALLER.command(["/bin/bash", "-n"], data=SOURCE)
        self.assertNotIn("secret-sentinel", str(error.exception))
        self.assertEqual(run.call_args.kwargs["input"], SOURCE)
        self.assertEqual(run.call_args.kwargs["env"], INSTALLER.safe_environment())

    def test_root_git_runs_as_deployment_user_without_fetch_or_hooks(self):
        with patch.object(INSTALLER.os, "geteuid", return_value=0, create=True), \
                patch.object(INSTALLER, "deployment_uid", return_value=1000), \
                patch.object(INSTALLER, "command", return_value=b"ok") as run:
            INSTALLER.git(Path("/home/rybbit-wotcv"), "status", "--porcelain")
        args = run.call_args.args[0]
        self.assertEqual(args[:5], ["/usr/sbin/runuser", "-u", "wotcv", "--", "/usr/bin/git"])
        self.assertIn("core.hooksPath=/dev/null", args)
        self.assertIn("core.fsmonitor=false", args)
        self.assertNotIn("fetch", args)

    def test_nonroot_git_check_is_limited_to_deployment_user(self):
        with patch.object(INSTALLER.os, "geteuid", return_value=1000, create=True), \
                patch.object(INSTALLER, "deployment_uid", return_value=1000), \
                patch.object(INSTALLER, "command", return_value=b"ok") as run:
            INSTALLER.git(Path("/repo"), "status")
            self.assertEqual(run.call_args.args[0][0], "/usr/bin/git")
        with patch.object(INSTALLER.os, "geteuid", return_value=1001, create=True), \
                patch.object(INSTALLER, "deployment_uid", return_value=1000), \
                patch.object(INSTALLER, "command") as run:
            with self.assertRaises(INSTALLER.Refused):
                INSTALLER.git(Path("/repo"), "status")
            run.assert_not_called()

    def test_apply_requires_root_before_planning(self):
        with patch.object(INSTALLER.os, "name", "posix"), \
                patch.object(INSTALLER.os, "geteuid", return_value=1000, create=True), \
                patch.object(INSTALLER, "plan_install") as plan:
            with self.assertRaisesRegex(INSTALLER.Refused, "requires root"):
                INSTALLER.install(apply=True)
            plan.assert_not_called()

    def test_metadata_rejects_nonroot_writable_symlink_and_special_targets(self):
        INSTALLER.require_metadata(metadata(stat.S_IFREG | 0o755), directory=False)
        INSTALLER.require_metadata(metadata(stat.S_IFDIR | 0o755), directory=True)
        for mode, uid, directory in (
            (stat.S_IFREG | 0o755, 1000, False), (stat.S_IFREG | 0o775, 0, False),
            (stat.S_IFREG | 0o757, 0, False), (stat.S_IFLNK | 0o777, 0, False),
            (stat.S_IFIFO | 0o600, 0, False), (stat.S_IFDIR | 0o777, 0, True),
            (stat.S_IFLNK | 0o755, 0, True),
        ):
            with self.subTest(mode=mode, uid=uid), self.assertRaises(INSTALLER.Refused):
                INSTALLER.require_metadata(metadata(mode, uid), directory=directory)

    def test_existing_root_group_0660_operations_lock_is_valid(self):
        for mode in (0o600, 0o640, 0o660):
            INSTALLER.require_lock_metadata(metadata(stat.S_IFREG | mode))
        for mode, uid, gid in ((0o662, 0, 0), (0o660, 1000, 0), (0o660, 0, 1000)):
            with self.subTest(mode=mode, uid=uid, gid=gid), self.assertRaises(INSTALLER.Refused):
                INSTALLER.require_lock_metadata(metadata(stat.S_IFREG | mode, uid, gid))
        with self.assertRaises(INSTALLER.Refused):
            INSTALLER.require_lock_metadata(metadata(stat.S_IFLNK | 0o777))

    @unittest.skipUnless(os.name == "posix", "POSIX paths required")
    def test_every_operations_ancestor_is_checked(self):
        def information(path):
            return metadata(stat.S_IFDIR | (0o775 if path == Path("/opt") else 0o755))
        with patch.object(Path, "lstat", information):
            with self.assertRaises(INSTALLER.Refused):
                INSTALLER.trusted_directory(Path("/opt/wotcv-ops/releases/release/retained"))

    @unittest.skipUnless(os.name == "posix", "POSIX paths required")
    def test_current_symlink_must_resolve_to_one_direct_release(self):
        paths = INSTALLER.Paths()
        for destination in (Path("/tmp/release"), paths.ops / "releases", paths.ops / "releases/deep/release"):
            with self.subTest(destination=destination), \
                    patch.object(INSTALLER, "trusted_directory"), \
                    patch.object(Path, "lstat", return_value=metadata(stat.S_IFLNK | 0o777)), \
                    patch.object(Path, "resolve", return_value=destination):
                with self.assertRaisesRegex(INSTALLER.Refused, "direct releases child"):
                    INSTALLER.installed_target(paths)


class SourceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.repo = Path(self.directory.name)
        (self.repo / "scripts").mkdir()
        (self.repo / INSTALLER.SOURCE_NAME).write_bytes(SOURCE)
        self.responses = [
            b"", str(self.repo).encode() + b"\n", SHA.encode() + b"\n", SHA.encode() + b"\n",
            b"100644 blob " + b"b" * 40 + b"\t" + INSTALLER.SOURCE_NAME.encode() + b"\0",
            SOURCE, b"",
        ]
        self.addCleanup(patch.stopall)
        patch.object(INSTALLER, "regular_bytes", side_effect=lambda path: path.read_bytes()).start()

    def snapshot(self, responses=None):
        with patch.object(INSTALLER, "git", side_effect=responses or self.responses), \
                patch.object(INSTALLER, "command", return_value=b"") as syntax:
            result = INSTALLER.source_snapshot(self.repo)
        return result, syntax

    def test_clean_exact_committed_source_is_checked_only_with_bash_n(self):
        result, syntax = self.snapshot()
        self.assertEqual(result, (SHA, SOURCE))
        syntax.assert_called_once_with(["/bin/bash", "--noprofile", "--norc", "-n"], data=SOURCE)

    def test_dirty_stale_changed_or_symlink_source_is_refused(self):
        cases = []
        for position, value in ((0, b"?? extra\0"), (3, b"c" * 40 + b"\n"),
                                (4, self.responses[4].replace(b"100644", b"120000")),
                                (5, SOURCE + b"# different\n"), (6, b" M updater\0")):
            responses = self.responses.copy()
            responses[position] = value
            cases.append(responses)
        for responses in cases:
            with self.subTest(position=cases.index(responses)), self.assertRaises(INSTALLER.Refused):
                self.snapshot(responses)


class InstallFlowTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        outer = Path(self.directory.name)
        release = outer / "ops/releases/release"
        target = release / "retained" / INSTALLER.RETAINED_NAME
        target.parent.mkdir(parents=True)
        target.write_bytes(b"old updater\n")
        self.audit = outer / "audit"
        self.audit.mkdir()
        self.paths = INSTALLER.Paths(outer / "repo", outer / "ops", outer / "backups", (outer / "deploy.lock", outer / "install.lock"))
        self.plan = INSTALLER.Plan(SHA, SOURCE, release, target, target.read_bytes(), 0o755,
                                   BASELINE_MANIFEST, INSTALLER.LEGACY_SHA256)
        self.addCleanup(patch.stopall)
        patch.object(INSTALLER, "require_platform").start()
        self.planner = patch.object(INSTALLER, "plan_install", return_value=self.plan).start()
        self.locks = patch.object(INSTALLER, "lock_file", side_effect=lambda _: nullcontext()).start()
        self.archive = patch.object(INSTALLER, "archive", return_value=self.audit).start()
        self.atomic = patch.object(INSTALLER, "atomic_replace", side_effect=lambda path, data, mode: path.write_bytes(data)).start()
        self.inspection = patch.object(INSTALLER, "installed_target", return_value=(release, target, SOURCE, 0o755)).start()
        self.protected = patch.object(INSTALLER, "protected_file").start()
        patch.object(INSTALLER, "sync_directory").start()
        patch.object(INSTALLER, "require_metadata").start()
        patch.object(INSTALLER, "trusted_directory").start()
        patch.object(INSTALLER, "manifest_snapshot", return_value=(BASELINE_MANIFEST, INSTALLER.LEGACY_SHA256)).start()
        patch.object(INSTALLER, "regular_bytes", side_effect=lambda path: path.read_bytes()).start()
        patch("builtins.print").start()

    def test_default_check_creates_no_locks_backups_or_changes(self):
        self.assertIsNone(INSTALLER.install(self.paths))
        self.locks.assert_not_called()
        self.archive.assert_not_called()
        self.atomic.assert_not_called()
        self.assertEqual(self.plan.target.read_bytes(), self.plan.original)

    def test_apply_holds_both_locks_rechecks_and_installs_only_one_file(self):
        audit = INSTALLER.install(self.paths, apply=True)
        self.assertEqual(audit, self.audit)
        self.assertEqual([call.args[0] for call in self.locks.call_args_list], list(self.paths.locks))
        self.assertEqual(self.planner.call_count, 3)
        self.atomic.assert_called_once_with(self.plan.target, SOURCE, 0o755)
        self.assertEqual(self.plan.target.read_bytes(), SOURCE)
        self.assertEqual(self.protected.call_args.args[0], self.audit / "success.json")
        self.assertFalse(json.loads(self.protected.call_args.args[1])["updaterExecuted"])

    def test_changed_source_release_or_old_content_refuses_before_write(self):
        changed = [self.plan._replace(head="b" * 40), self.plan._replace(source=SOURCE + b"# changed"),
                   self.plan._replace(release=self.plan.release.parent / "other"),
                   self.plan._replace(original=b"intervening edit")]
        for candidate in changed:
            for during_archive in (False, True):
                with self.subTest(candidate=candidate, during_archive=during_archive):
                    self.planner.side_effect = [self.plan, self.plan, candidate] if during_archive else [self.plan, candidate]
                    with self.assertRaises(INSTALLER.Refused):
                        INSTALLER.install(self.paths, apply=True)
                    self.atomic.assert_not_called()

    def test_busy_lock_and_failed_backup_never_write_target(self):
        self.locks.side_effect = INSTALLER.Refused("busy")
        with self.assertRaisesRegex(INSTALLER.Refused, "busy"):
            INSTALLER.install(self.paths, apply=True)
        self.locks.side_effect = lambda _: nullcontext()
        self.archive.side_effect = OSError("synthetic storage failure")
        with self.assertRaises(OSError):
            INSTALLER.install(self.paths, apply=True)
        self.atomic.assert_not_called()

    def test_verification_failure_restores_only_our_payload(self):
        self.inspection.return_value = (self.plan.release, self.plan.target, SOURCE, 0o700)
        with self.assertRaisesRegex(INSTALLER.Refused, "verification failed"):
            INSTALLER.install(self.paths, apply=True)
        self.assertEqual(self.plan.target.read_bytes(), self.plan.original)
        self.assertEqual(self.atomic.call_count, 2)
        self.assertEqual(self.atomic.call_args.args, (self.plan.target, self.plan.original, 0o755))

    def test_intervening_edit_is_not_overwritten_by_rollback(self):
        def intervening(_):
            self.plan.target.write_bytes(b"another actor's update\n")
            raise INSTALLER.Refused("verification failed")
        self.inspection.side_effect = intervening
        with self.assertRaises(INSTALLER.Refused):
            INSTALLER.install(self.paths, apply=True)
        self.atomic.assert_called_once()
        self.assertEqual(self.plan.target.read_bytes(), b"another actor's update\n")

    def test_failure_before_replace_preserves_original_without_rollback(self):
        self.atomic.side_effect = OSError("synthetic write failure")
        with self.assertRaises(OSError):
            INSTALLER.install(self.paths, apply=True)
        self.atomic.assert_called_once()
        self.assertEqual(self.plan.target.read_bytes(), self.plan.original)

    def test_already_current_is_a_noop(self):
        self.planner.return_value = self.plan._replace(original=SOURCE)
        self.assertIsNone(INSTALLER.install(self.paths, apply=True))
        self.archive.assert_not_called()
        self.atomic.assert_not_called()


@unittest.skipUnless(os.name == "posix", "Linux file descriptors, flock and ownership semantics required")
class NativeFixtureTests(unittest.TestCase):
    def test_atomic_replace_and_protected_archive_in_isolated_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            outer = Path(directory)
            target = outer / "updater.sh"
            target.write_bytes(b"old\n")
            paths = INSTALLER.Paths(outer / "repo", outer / "ops", outer / "backups", ())
            plan = INSTALLER.Plan(SHA, SOURCE, outer / "release", target, b"old\n", 0o755,
                                   BASELINE_MANIFEST, INSTALLER.LEGACY_SHA256)
            with patch.object(INSTALLER, "trusted_directory"):
                audit = INSTALLER.archive(paths, plan)
            self.assertEqual(audit.stat().st_mode & 0o777, 0o700)
            for filename in ("updater.before.sh", "updater.after.sh", "manifest.json", "payload-manifest.baseline.json"):
                self.assertEqual((audit / filename).stat().st_mode & 0o777, 0o600)
            manifest = json.loads((audit / "manifest.json").read_bytes())
            self.assertEqual(manifest["beforeSha256"], INSTALLER.digest(b"old\n"))
            self.assertEqual(manifest["afterSha256"], INSTALLER.digest(SOURCE))
            self.assertEqual(manifest["payloadManifestSha256"], INSTALLER.digest(BASELINE_MANIFEST))
            self.assertEqual(manifest["payloadManifestEntry"], {INSTALLER.MANIFEST_ENTRY: INSTALLER.LEGACY_SHA256})
            with patch.object(INSTALLER, "root_ownership"):
                INSTALLER.atomic_replace(target, SOURCE, 0o755)
            self.assertEqual(target.read_bytes(), SOURCE)
            self.assertEqual(target.stat().st_mode & 0o777, 0o755)
            self.assertFalse(list(outer.glob(".rybbit-updater-*")))

    def test_lock_contention_and_symlink_reads_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            outer = Path(directory)
            with patch.object(INSTALLER, "require_lock_metadata"):
                with INSTALLER.lock_file(outer / "lock"):
                    with self.assertRaisesRegex(INSTALLER.Refused, "holds the lock"):
                        with INSTALLER.lock_file(outer / "lock"):
                            self.fail("Second lock must not be acquired")
            target = outer / "target"
            target.write_bytes(SOURCE)
            link = outer / "link"
            link.symlink_to(target)
            with self.assertRaises(OSError):
                INSTALLER.regular_bytes(link)


if __name__ == "__main__":
    unittest.main()
