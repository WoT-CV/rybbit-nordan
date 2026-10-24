"""Hermetic hotfix provenance tests; never run cleanup, updater, SSH or real root writes."""

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
SPEC = importlib.util.spec_from_file_location("wotcv_ops_attestation", ROOT / "scripts/wotcv-attest-ops-hotfixes.py")
ATTEST = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ATTEST)
SOURCE = b"#!/usr/bin/env bash\n# reviewed fixture updater, never executed\n"
CLEAN_BASELINE = b"#!/usr/bin/env bash\n\nset -Eeuo pipefail\n# destructive fixture, never executed\n"
CLEAN_LIVE = ATTEST.SHEBANG + ATTEST.CLEAN_GUARD + CLEAN_BASELINE[len(ATTEST.SHEBANG):]


def metadata(mode, uid=0, gid=0):
    return SimpleNamespace(st_mode=mode, st_uid=uid, st_gid=gid)


class ProofTests(unittest.TestCase):
    def test_guard_is_exact_246_byte_prefix_insertion_and_not_executed(self):
        self.assertEqual(len(ATTEST.CLEAN_GUARD), 246)
        with patch.object(ATTEST, "CLEAN_BASELINE_SHA256", ATTEST.digest(CLEAN_BASELINE)), \
                patch.object(ATTEST, "CLEAN_LIVE_SHA256", ATTEST.digest(CLEAN_LIVE)), \
                patch.object(ATTEST.subprocess, "run") as run:
            proof = ATTEST.clean_guard_proof(CLEAN_LIVE)
        self.assertEqual(proof["reconstructedBaselineSha256"], ATTEST.digest(CLEAN_BASELINE))
        self.assertEqual(proof["insertedBytes"], 246)
        self.assertIn("zero-argument-cleanup-remains-destructive", proof["behavior"])
        run.assert_not_called()

    def test_guard_tampering_reordering_or_newlines_cannot_be_attested(self):
        variants = (
            CLEAN_BASELINE, CLEAN_LIVE.replace(b"exit 64", b"exit 0"),
            CLEAN_LIVE.replace(b"$# != 0", b"$# > 1"), CLEAN_LIVE + b"# unknown edit\n",
            CLEAN_LIVE.replace(b"fi\n\n\nset", b"fi\n\nset"),
            CLEAN_BASELINE + ATTEST.CLEAN_GUARD,
        )
        for value in variants:
            with self.subTest(value=value), \
                    patch.object(ATTEST, "CLEAN_BASELINE_SHA256", ATTEST.digest(CLEAN_BASELINE)), \
                    patch.object(ATTEST, "CLEAN_LIVE_SHA256", ATTEST.digest(value)):
                with self.assertRaises(ATTEST.Refused):
                    ATTEST.clean_guard_proof(value)

    def test_root_metadata_rejects_writable_nonroot_symlink_and_special_files(self):
        ATTEST.require_metadata(metadata(stat.S_IFREG | 0o755), directory=False)
        ATTEST.require_metadata(metadata(stat.S_IFDIR | 0o755), directory=True)
        for mode, uid, directory in (
            (stat.S_IFREG | 0o755, 1000, False), (stat.S_IFREG | 0o775, 0, False),
            (stat.S_IFREG | 0o757, 0, False), (stat.S_IFLNK | 0o777, 0, False),
            (stat.S_IFIFO | 0o600, 0, False), (stat.S_IFDIR | 0o777, 0, True),
            (stat.S_IFLNK | 0o755, 0, True),
        ):
            with self.subTest(mode=mode, uid=uid), self.assertRaises(ATTEST.Refused):
                ATTEST.require_metadata(metadata(mode, uid), directory=directory)

    def test_existing_root_group_0660_operations_locks_are_valid_but_other_owners_are_not(self):
        ATTEST.require_lock_metadata(metadata(stat.S_IFREG | 0o660))
        for value in (metadata(stat.S_IFREG | 0o662), metadata(stat.S_IFREG | 0o660, uid=1000),
                      metadata(stat.S_IFREG | 0o660, gid=1000), metadata(stat.S_IFLNK | 0o777)):
            with self.subTest(value=value), self.assertRaises(ATTEST.Refused):
                ATTEST.require_lock_metadata(value)

    def test_environment_omits_injected_shell_git_and_python_settings(self):
        with patch.dict(os.environ, {"BASH_ENV": "/bad", "GIT_DIR": "/bad", "GIT_CONFIG_COUNT": "1"}):
            environment = ATTEST.safe_environment()
        for key in ("BASH_ENV", "ENV", "GIT_DIR", "GIT_CONFIG_COUNT", "LD_PRELOAD", "PYTHONPATH"):
            self.assertNotIn(key, environment)
        self.assertEqual(environment["GIT_OPTIONAL_LOCKS"], "0")

    def test_source_commands_withhold_native_errors_and_use_sanitized_environment(self):
        failure = subprocess.CompletedProcess([], 1, stdout=b"secret-sentinel", stderr=b"secret-sentinel")
        with patch.object(ATTEST.subprocess, "run", return_value=failure) as run:
            with self.assertRaises(ATTEST.Refused) as error:
                ATTEST.command(["/usr/bin/git", "status"])
        self.assertNotIn("secret-sentinel", str(error.exception))
        self.assertEqual(run.call_args.kwargs["env"], ATTEST.safe_environment())

    def test_root_git_is_demoted_and_read_only_without_fetch_or_shell(self):
        with patch.object(ATTEST.os, "geteuid", return_value=0, create=True), \
                patch.object(ATTEST, "deployment_uid", return_value=1000), \
                patch.object(ATTEST, "command", return_value=b"ok") as command:
            ATTEST.git(Path("repo"), "show", f"{ATTEST.SOURCE_COMMIT}:{ATTEST.SOURCE_NAME}")
        args = command.call_args.args[0]
        self.assertEqual(args[:5], ["/usr/sbin/runuser", "-u", "wotcv", "--", "/usr/bin/git"])
        self.assertIn("core.hooksPath=/dev/null", args)
        self.assertIn("core.fsmonitor=false", args)
        self.assertNotIn("fetch", args)

    def test_nonroot_apply_is_refused_before_reads_or_writes(self):
        with patch.object(ATTEST.os, "name", "posix"), \
                patch.object(ATTEST.os, "O_NOFOLLOW", 0, create=True), \
                patch.object(ATTEST.os, "geteuid", return_value=1000, create=True), \
                patch.object(ATTEST, "plan_attestation") as plan:
            with self.assertRaisesRegex(ATTEST.Refused, "requires root"):
                ATTEST.attest(apply=True)
            plan.assert_not_called()

    def test_default_and_explicit_check_are_read_only_cli_actions(self):
        for arguments in (["attest"], ["attest", "--check"]):
            with self.subTest(arguments=arguments), \
                    patch.object(ATTEST.sys, "argv", arguments), \
                    patch.object(ATTEST, "attest") as attest:
                self.assertEqual(ATTEST.main(), 0)
                attest.assert_called_once_with(apply=False)

    def test_every_trusted_path_ancestor_is_checked_without_following_symlinks(self):
        target = ROOT / "fixture/retained"
        for bad in (target, target.parent, ROOT):
            with self.subTest(bad=bad), patch.object(Path, "lstat", lambda path:
                    metadata(stat.S_IFDIR | (0o775 if path == bad else 0o755))):
                with self.assertRaises(ATTEST.Refused):
                    ATTEST.trusted_directory(target)
        with patch.object(Path, "lstat", return_value=metadata(stat.S_IFLNK | 0o777)):
            with self.assertRaises(ATTEST.Refused):
                ATTEST.trusted_directory(target)


class FixtureTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.base = Path(self.directory.name)
        self.release = self.base / "ops/releases/reviewed"
        self.release.mkdir(parents=True)
        self.paths = ATTEST.Paths(self.base / "repo", self.base / "ops", self.base / "state/attestations", ())
        self.paths.repo.mkdir()
        files = {f"fixture-{i}.py": f"# baseline fixture {i}\n".encode() for i in range(31)}
        files[ATTEST.CLEAN_ENTRY] = CLEAN_LIVE
        files[ATTEST.UPDATER_ENTRY] = SOURCE
        self.baseline = {name: ATTEST.digest(value) for name, value in files.items()}
        self.baseline[ATTEST.CLEAN_ENTRY] = ATTEST.digest(CLEAN_BASELINE)
        self.baseline[ATTEST.UPDATER_ENTRY] = "b" * 64
        self.manifest = json.dumps(self.baseline, sort_keys=True).encode()
        for name, value in files.items():
            target = self.release.joinpath(*name.split("/"))
            target.parent.mkdir(exist_ok=True)
            target.write_bytes(value)
        (self.release / "payload-manifest.json").write_bytes(self.manifest)
        self.addCleanup(patch.stopall)
        patch.object(ATTEST, "MANIFEST_SHA256", ATTEST.digest(self.manifest)).start()
        patch.object(ATTEST, "UPDATER_BASELINE_SHA256", "b" * 64).start()
        patch.object(ATTEST, "UPDATER_LIVE_SHA256", ATTEST.digest(SOURCE)).start()
        patch.object(ATTEST, "CLEAN_BASELINE_SHA256", ATTEST.digest(CLEAN_BASELINE)).start()
        patch.object(ATTEST, "CLEAN_LIVE_SHA256", ATTEST.digest(CLEAN_LIVE)).start()
        patch.object(ATTEST, "trusted_directory").start()
        patch.object(ATTEST, "require_metadata").start()
        patch.object(ATTEST, "regular_bytes", side_effect=lambda path, **kwargs: path.read_bytes()).start()
        self.source = patch.object(ATTEST, "source_snapshot", return_value=(ATTEST.SOURCE_COMMIT, SOURCE)).start()

    def plan(self):
        original_resolve = Path.resolve
        original_lstat = Path.lstat
        current = self.paths.ops / "current"
        with patch.object(Path, "resolve", lambda path, **kwargs:
                          self.release if path == current else original_resolve(path, **kwargs)), \
                patch.object(Path, "lstat", lambda path:
                             metadata(stat.S_IFLNK | 0o777) if path == current else original_lstat(path)):
            return ATTEST.plan_attestation(self.paths)

    def test_all_33_entries_are_verified_and_receipt_clearly_has_bounded_scope(self):
        planned = self.plan()
        record = ATTEST.receipt_record(planned)
        self.assertEqual(len(record["files"]), 33)
        differences = [name for name, value in record["files"].items()
                       if value["baselineSha256"] != value["liveSha256"]]
        self.assertEqual(set(differences), {ATTEST.CLEAN_ENTRY, ATTEST.UPDATER_ENTRY})
        for key in ("payloadModified", "payloadExecuted", "unlistedFilesAttested"):
            self.assertFalse(record[key])
        self.assertTrue(record["manifestUnchanged"])
        self.assertIn("not-whole-release", record["scope"])

    def test_third_difference_or_missing_file_is_refused(self):
        target = self.release / "fixture-0.py"
        target.write_bytes(b"# unreviewed root edit\n")
        with self.assertRaisesRegex(ATTEST.Refused, "Unreviewed payload difference"):
            self.plan()
        target.unlink()
        with self.assertRaises(FileNotFoundError):
            self.plan()

    def test_baseline_restoration_of_either_protection_is_refused(self):
        (self.release / ATTEST.CLEAN_ENTRY).write_bytes(CLEAN_BASELINE)
        with self.assertRaisesRegex(ATTEST.Refused, "Unreviewed payload difference"):
            self.plan()
        (self.release / ATTEST.CLEAN_ENTRY).write_bytes(CLEAN_LIVE)
        (self.release / ATTEST.UPDATER_ENTRY).write_bytes(b"old unguarded updater")
        with self.assertRaisesRegex(ATTEST.Refused, "Unreviewed payload difference"):
            self.plan()

    def test_original_manifest_must_match_pinned_digest(self):
        (self.release / "payload-manifest.json").write_bytes(self.manifest + b"\n")
        with self.assertRaisesRegex(ATTEST.Refused, "pinned SHA256"):
            self.plan()

    def test_source_must_equal_the_retained_wrapper_even_if_provider_is_wrong(self):
        self.source.return_value = (ATTEST.SOURCE_COMMIT, SOURCE + b"# drift\n")
        with self.assertRaisesRegex(ATTEST.Refused, "exact reviewed source blob"):
            self.plan()

    def test_duplicate_unsafe_missing_or_malformed_manifest_entries_are_refused(self):
        cases = [self.manifest.replace(b'"fixture-0.py"', b'"../fixture-0.py"'),
                 self.manifest.replace(b'"fixture-0.py"', b'"/fixture-0.py"'),
                 self.manifest.replace(b'"fixture-0.py"', b'"a//fixture-0.py"'),
                 self.manifest.replace(b'"fixture-0.py"', b'"a\\\\fixture-0.py"'),
                 self.manifest.replace(b'"fixture-0.py"', b'"."'),
                 self.manifest.replace(b'"fixture-0.py"', b'"a\\u0000b"'),
                 b'{"a":"x","a":"y"}', b'[]', b'{}']
        bad = dict(self.baseline)
        bad[ATTEST.CLEAN_ENTRY] = "0" * 64
        cases.append(json.dumps(bad).encode())
        for value in cases:
            with self.subTest(value=value[:80]), \
                    patch.object(ATTEST, "MANIFEST_SHA256", ATTEST.digest(value)):
                with self.assertRaises(ATTEST.Refused):
                    ATTEST.parse_manifest(value)

    def test_current_must_be_root_symlink_to_direct_release_child(self):
        for info in (metadata(stat.S_IFREG | 0o755), metadata(stat.S_IFLNK | 0o777, uid=1000)):
            with self.subTest(info=info), patch.object(Path, "lstat", return_value=info):
                with self.assertRaisesRegex(ATTEST.Refused, "root-owned release symlink"):
                    ATTEST.plan_attestation(self.paths)
        for destination in (self.base / "untrusted", self.paths.ops / "releases", self.release / "nested"):
            with self.subTest(destination=destination), \
                    patch.object(Path, "lstat", return_value=metadata(stat.S_IFLNK | 0o777)), \
                    patch.object(Path, "resolve", return_value=destination):
                with self.assertRaisesRegex(ATTEST.Refused, "direct releases child"):
                    ATTEST.plan_attestation(self.paths)

    def test_check_creates_no_receipts_directories_or_locks(self):
        planned = self.plan()
        with patch.object(ATTEST, "require_platform"), \
                patch.object(ATTEST, "plan_attestation", return_value=planned), \
                patch.object(ATTEST, "lock_file") as lock, \
                patch.object(ATTEST, "write_receipt") as write:
            self.assertIsNone(ATTEST.attest(self.paths))
        lock.assert_not_called()
        write.assert_not_called()
        self.assertFalse(self.paths.attestations.parent.exists())

    def test_root_private_registry_fails_closed_after_payload_proof(self):
        planned = self.plan()
        with patch.object(ATTEST, "require_platform"), \
                patch.object(ATTEST, "plan_attestation", return_value=planned), \
                patch.object(ATTEST, "receipt_present", side_effect=PermissionError), \
                patch("builtins.print") as output, \
                patch.object(ATTEST, "write_receipt") as write:
            with self.assertRaisesRegex(ATTEST.Refused, "ROOT-ONLY RECEIPT REGISTRY UNVERIFIED"):
                ATTEST.attest(self.paths)
        self.assertTrue(any("Verified all 33" in call.args[0] for call in output.call_args_list))
        self.assertFalse(any("CHECK PASS" in call.args[0] for call in output.call_args_list))
        write.assert_not_called()

    def test_existing_receipt_requires_exact_record_and_timestamp(self):
        planned = self.plan()
        value = {"recordedAt": "2026-10-24T15:00:00Z", "attestation": ATTEST.receipt_record(planned)}
        ATTEST.validate_receipt(json.dumps(value).encode(), planned)
        for changed in (
            {**value, "extra": True}, {**value, "recordedAt": "not-a-date"},
            {**value, "recordedAt": "2026-10-24T1:0:0Z"},
            {**value, "recordedAt": None},
            {**value, "attestation": {**value["attestation"], "payloadExecuted": True}},
            {**value, "attestation": {**value["attestation"], "payloadExecuted": 0}},
        ):
            with self.subTest(changed=changed), self.assertRaises(ATTEST.Refused):
                ATTEST.validate_receipt(json.dumps(changed).encode(), planned)

    def test_apply_takes_both_locks_rechecks_and_only_writes_receipt(self):
        planned = self.plan()
        paths = self.paths._replace(locks=(self.base / "deploy.lock", self.base / "install.lock"))
        output = paths.attestations / f"{ATTEST.digest(self.manifest)}.json"
        with patch.object(ATTEST, "require_platform"), \
                patch.object(ATTEST, "plan_attestation", return_value=planned) as plan, \
                patch.object(ATTEST, "receipt_present", side_effect=[False, False, True]), \
                patch.object(ATTEST, "lock_file", side_effect=lambda path: nullcontext()) as lock, \
                patch.object(ATTEST, "write_receipt", return_value=output) as write:
            self.assertEqual(ATTEST.attest(paths, apply=True), output)
        self.assertEqual([call.args[0] for call in lock.call_args_list], list(paths.locks))
        self.assertEqual(plan.call_count, 3)
        write.assert_called_once_with(paths, planned)
        self.assertEqual((self.release / "payload-manifest.json").read_bytes(), self.manifest)
        self.assertEqual((self.release / ATTEST.CLEAN_ENTRY).read_bytes(), CLEAN_LIVE)
        self.assertEqual((self.release / ATTEST.UPDATER_ENTRY).read_bytes(), SOURCE)

    def test_apply_refuses_race_before_receipt_write(self):
        planned = self.plan()
        changed = planned._replace(source_commit="c" * 40)
        with patch.object(ATTEST, "require_platform"), \
                patch.object(ATTEST, "plan_attestation", side_effect=[planned, changed]), \
                patch.object(ATTEST, "receipt_present", return_value=False), \
                patch.object(ATTEST, "write_receipt") as write:
            with self.assertRaisesRegex(ATTEST.Refused, "before the locks"):
                ATTEST.attest(self.paths, apply=True)
        write.assert_not_called()

    def test_apply_is_idempotent_and_never_rewrites_a_valid_receipt(self):
        planned = self.plan()
        with patch.object(ATTEST, "require_platform"), \
                patch.object(ATTEST, "plan_attestation", return_value=planned), \
                patch.object(ATTEST, "receipt_present", return_value=True), \
                patch.object(ATTEST, "write_receipt") as write:
            self.assertIsNone(ATTEST.attest(self.paths, apply=True))
        write.assert_not_called()

    def test_receipt_publication_is_no_clobber_and_never_changes_payload(self):
        planned = self.plan()
        # Windows has no fchown/directory fsync or POSIX mode semantics. Exercise
        # the same JSON/no-clobber write path, with only these OS calls mocked.
        with patch.object(ATTEST.os, "fchown", create=True) as chown, \
                patch.object(ATTEST.os, "fchmod", create=True) as chmod, \
                patch.object(ATTEST, "sync_directory"), \
                patch.object(ATTEST, "receipt_directory", side_effect=lambda paths, **kwargs:
                             paths.attestations.mkdir(parents=True, exist_ok=True)):
            target = ATTEST.write_receipt(self.paths, planned)
            before = target.read_bytes()
            ATTEST.validate_receipt(before, planned)
            with self.assertRaises(FileExistsError):
                ATTEST.write_receipt(self.paths, planned)
        self.assertEqual(chown.call_args.args[1:], (0, 0))
        self.assertEqual(chmod.call_args.args[1:], (0o600,))
        self.assertEqual(target.read_bytes(), before)
        self.assertEqual(list(self.paths.attestations.iterdir()), [target])
        self.assertEqual((self.release / "payload-manifest.json").read_bytes(), self.manifest)
        self.assertEqual((self.release / ATTEST.CLEAN_ENTRY).read_bytes(), CLEAN_LIVE)
        self.assertEqual((self.release / ATTEST.UPDATER_ENTRY).read_bytes(), SOURCE)

    @unittest.skipUnless(os.name == "posix", "POSIX atomic publish required")
    def test_real_fixture_receipt_is_atomic_private_and_no_clobber(self):
        planned = self.plan()
        with patch.object(ATTEST.os, "fchown"):
            target = ATTEST.write_receipt(self.paths, planned)
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
            ATTEST.validate_receipt(target.read_bytes(), planned)
            before = target.read_bytes()
            with self.assertRaises(FileExistsError):
                ATTEST.write_receipt(self.paths, planned)
        self.assertEqual(target.read_bytes(), before)
        self.assertEqual(list(self.paths.attestations.iterdir()), [target])


class SourceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.repo = Path(self.directory.name)
        self.responses = [
            b"", str(self.repo).encode() + b"\n", b"a" * 40 + b"\n", b"a" * 40 + b"\n",
            b"", b"100644 blob " + b"b" * 40 + b"\t" + ATTEST.SOURCE_NAME.encode() + b"\0",
            SOURCE, SOURCE, b"",
        ]

    def snapshot(self, responses=None, working=SOURCE):
        with patch.object(ATTEST, "git", side_effect=responses or self.responses) as git, \
                patch.object(ATTEST, "regular_bytes", return_value=working), \
                patch.object(ATTEST, "UPDATER_LIVE_SHA256", ATTEST.digest(SOURCE)):
            result = ATTEST.source_snapshot(self.repo)
        return result, git

    def test_pinned_committed_blob_and_current_working_copy_are_exact(self):
        result, git = self.snapshot()
        self.assertEqual(result, (ATTEST.SOURCE_COMMIT, SOURCE))
        self.assertIn((self.repo, "show", f"{ATTEST.SOURCE_COMMIT}:{ATTEST.SOURCE_NAME}"),
                      [call.args for call in git.call_args_list])
        self.assertIn((self.repo, "merge-base", "--is-ancestor", ATTEST.SOURCE_COMMIT, "a" * 40),
                      [call.args for call in git.call_args_list])

    def test_dirty_stale_symlink_modified_or_nonreviewed_source_is_refused(self):
        cases = []
        for position, value in ((0, b"?? extra\0"), (3, b"c" * 40 + b"\n"),
                                (4, ATTEST.Refused("Pinned source commit is not an ancestor")),
                                (5, self.responses[5].replace(b"100644", b"120000")),
                                (6, SOURCE + b"# changed\n"), (7, SOURCE + b"# changed HEAD\n"),
                                (8, b" M source\0")):
            response = list(self.responses)
            response[position] = value
            cases.append(response)
        for response in cases:
            with self.subTest(response=response), self.assertRaises(ATTEST.Refused):
                self.snapshot(response)
        with self.assertRaises(ATTEST.Refused):
            self.snapshot(working=SOURCE + b"# changed\n")


if __name__ == "__main__":
    unittest.main()
