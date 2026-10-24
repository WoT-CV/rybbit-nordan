"""Historical continuation contracts; production interfaces remain mocked."""

import copy
from datetime import datetime, timedelta, timezone
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from test_wotcv_runtime_logging import fixture

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("runtime_resume_test", ROOT / "scripts/wotcv-resume-runtime-logging.py")
RESUME = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RESUME)
R = RESUME.RUNTIME


class HistoricalGuardTests(unittest.TestCase):
    def setUp(self):
        self.config, self.original = fixture()
        self.original["backend"]["State"].update(Status="exited", Running=False, ExitCode=0)
        for name in ("postgres", "redis", "clickhouse"):
            self.original[name]["State"]["Health"] = {"Status": "healthy"}
        self.original["postgres"]["Config"]["Env"].append("PRIVATE=literal-$X-$$Y=value")
        self.current = copy.deepcopy(self.original)
        self.current["postgres"]["Id"] = "a" * 64
        self.current["postgres"]["Config"]["Hostname"] = "a" * 12
        self.current["postgres"]["Config"]["Env"].reverse()
        self.current["postgres"]["HostConfig"]["LogConfig"] = copy.deepcopy(R.EXPECTED_RUNTIME_LOGGING)
        for field in ("Dns", "DnsOptions", "DnsSearch"):
            self.current["postgres"]["HostConfig"][field] = None
        self.pg = {"system_identifier": "123", "database": "analytics", "users": 1, "sites": 1, "aliases": 3, "alias": None}
        self.redis = {"timestamp_ms": 1000, "keys": {"key-digest": {"hash": "value-digest", "expires_at_ms": None}}}
        self.backup = {"schema": "wotcv-runtime-logging-backup-v1", "project": "rybbit",
                       "created_at": datetime.now(timezone.utc).isoformat()}
        self.artifact_hashes = {"postgres.dump": "b" * 64, "globals.sql": "c" * 64, "redis.rdb": "d" * 64}
        for name, verifier in (("postgres", "pg_restore --list"), ("redis", "redis-check-rdb")):
            filename = "postgres.dump" if name == "postgres" else "redis.rdb"
            self.backup[name] = {"container_id": self.original[name]["Id"], "image_id": self.original[name]["Image"],
                                 "volume": "rybbit_" + name + "-data", "verified_by": verifier,
                                 "archive": {"path": filename, "sha256": self.artifact_hashes[filename]}}
        self.backup["postgres"].update(system_identifier="123", globals={"path": "globals.sql", "sha256": "c" * 64})
        self.values = {"runtime.before.json": self.original, "postgres.before.json": self.pg,
                       "redis.before.json": self.redis, "backup-evidence.json": copy.deepcopy(self.backup),
                       "candidate.compose.json": {}, "failure.json": {"requiresOperatorReview": True,
                           "automaticDataOrConfigurationRestore": False},
                       "recovery.json": {"maintenanceOwner": "mine", "maintenanceMustRemainActive": True,
                           "backendMustRemainStopped": True, "requiredNativeEngine": R.NATIVE_ENGINE,
                           "requiredNativeCompose": R.NATIVE_COMPOSE}, "manifest.json": self.backup}
        self.patches = []
        def install(target, name, **kwargs):
            item = patch.object(target, name, **kwargs)
            value = item.start()
            self.addCleanup(item.stop)
            return value
        install(RESUME, "read_evidence", side_effect=self.read)
        install(Path, "exists", return_value=False)
        self.gate = install(R, "require_gate")
        install(R, "plan", side_effect=self.plan)
        install(R, "inspect_owned", side_effect=lambda *a: copy.deepcopy(self.current))
        install(R, "postgres_snapshot", side_effect=lambda *a: copy.deepcopy(self.pg))
        install(R, "redis_snapshot", side_effect=lambda *a: copy.deepcopy(self.redis))
        install(R, "sha256_file", side_effect=lambda path, magic: self.artifact_hashes[path.name])
        self.command = install(R, "command", side_effect=lambda *a, **kw: json.dumps(R.pinned_compose(self.config, self.original, rollback=False)).encode())
        self.identity = install(R, "verify_identity")

    def read(self, path):
        value = copy.deepcopy(self.values[path.name])
        return json.dumps(value, sort_keys=True).encode(), value

    def plan(self, *args):
        drift = tuple(name for name in R.SERVICES if self.current[name]["HostConfig"]["LogConfig"] != R.EXPECTED_RUNTIME_LOGGING)
        return copy.deepcopy(self.config), copy.deepcopy(self.current), drift

    def guard(self):
        return RESUME.HistoricalGuard(ROOT, Path("/protected-audit"), Path("/protected-backup/manifest.json"), "mine", "a" * 64)

    def call(self, guard, phase="initial"):
        return guard(copy.deepcopy(self.current), phase)

    def replace_redis(self):
        self.current["redis"]["Id"] = "f" * 64
        self.current["redis"]["Config"]["Hostname"] = "f" * 12
        self.current["redis"]["HostConfig"]["LogConfig"] = copy.deepcopy(R.EXPECTED_RUNTIME_LOGGING)
        for field in ("Dns", "DnsOptions", "DnsSearch"):
            self.current["redis"]["HostConfig"][field] = None

    def test_original_transition_is_proven_again_on_every_phase_and_final_identity_is_explicit(self):
        guard = self.guard()
        original = copy.deepcopy(self.original)
        current = copy.deepcopy(self.current)
        for phase in ("initial", "preflight", "before-redis"):
            result = self.call(guard, phase)
            self.assertTrue(result["originalDataInvariantsPreserved"])
            self.assertFalse(result["clickhouseReconnectionVerified"])
        self.identity.assert_not_called()
        self.assertEqual(self.original, original)
        self.assertEqual(self.current, current)
        self.replace_redis()
        result = self.call(guard, "after")
        self.assertTrue(result["clickhouseReconnectionVerified"])
        self.assertTrue(result["originalArtifactHashesVerified"])
        self.assertEqual(result["originalPostgresId"], self.original["postgres"]["Id"])
        self.assertEqual(result["acceptedPostgresId"], "a" * 64)
        self.assertEqual(result["originalRedisId"], self.original["redis"]["Id"])
        for field in ("backendStarted", "maintenanceRemoved", "dataRestored"):
            self.assertFalse(result[field])
        self.assertNotIn("literal-$X", json.dumps(result))
        self.identity.assert_called_once()

    def test_evidence_and_artifacts_cannot_change_after_initial_proof(self):
        guard = self.guard()
        self.call(guard)
        self.values["failure.json"]["additional"] = True
        with self.assertRaisesRegex(R.Refused, "Historical audit changed"):
            self.call(guard, "before-redis")
        del self.values["failure.json"]["additional"]
        self.artifact_hashes["redis.rdb"] = "e" * 64
        with self.assertRaisesRegex(R.Refused, "artifact changed"):
            self.call(guard, "before-redis")

    def test_postgres_and_untouched_services_are_frozen_across_resume(self):
        for service in ("postgres", "backend", "client", "clickhouse"):
            guard = self.guard()
            self.call(guard)
            old = self.current[service]["State"]["StartedAt"]
            self.current[service]["State"]["StartedAt"] = "changed"
            with self.subTest(service=service), self.assertRaises(R.Refused):
                self.call(guard, "before-redis")
            self.current[service]["State"]["StartedAt"] = old

    def test_postgres_exact_identity_values_counts_and_sample_remain_guarded(self):
        mutations = ((lambda: self.current["postgres"].update(Id="e" * 64)),
                     (lambda: self.current["postgres"]["Config"]["Env"].append("NEW=value")),
                     (lambda: self.current["postgres"]["HostConfig"].update(Memory=1048576)),
                     (lambda: self.pg.update(aliases=4)), (lambda: self.pg.update(alias={"private": "never-output"})))
        for mutate in mutations:
            before = copy.deepcopy(self.current)
            pg = copy.deepcopy(self.pg)
            guard = self.guard()
            mutate()
            with self.subTest(mutation=mutate), self.assertRaises(R.Refused):
                self.call(guard)
            self.current, self.pg = before, pg

    def test_redis_drift_and_identity_may_change_only_in_after_phase(self):
        guard = self.guard()
        self.call(guard)
        self.replace_redis()
        with self.assertRaisesRegex(R.Refused, "Redis-only"):
            self.call(guard, "before-redis")
        self.current["redis"]["Image"] = "sha256:" + "0" * 64
        with self.assertRaisesRegex(R.Refused, "Redis replacement"):
            self.call(guard, "after")

    def test_data_loss_is_not_hidden_by_fresh_backup(self):
        guard = self.guard()
        self.call(guard)
        self.redis = {"timestamp_ms": 1001, "keys": {}}
        with self.assertRaisesRegex(R.Refused, "protected key/value"):
            self.call(guard, "before-redis")

    def test_expiring_original_backup_refuses_without_extending_age(self):
        self.backup["created_at"] = (datetime.now(timezone.utc) - timedelta(hours=5, minutes=56)).isoformat()
        self.values["backup-evidence.json"] = copy.deepcopy(self.backup)
        guard = self.guard()
        with self.assertRaisesRegex(R.Refused, "freshness margin"):
            self.call(guard)

    def test_final_identity_failure_prevents_success(self):
        guard = self.guard()
        self.call(guard)
        self.replace_redis()
        self.identity.side_effect = R.Refused("Synthetic dictionary failure")
        with self.assertRaisesRegex(R.Refused, "dictionary failure"):
            self.call(guard, "after")


class ResumeFlowTests(unittest.TestCase):
    def test_default_never_checks_backups_or_runs_any_native_helper(self):
        with patch.object(RESUME, "HistoricalGuard") as guard, patch.object(RESUME.BACKUP, "create") as backup, \
                self.assertRaisesRegex(R.Refused, "apply-only"):
            RESUME.resume(ROOT, Path("audit"), Path("manifest"), "mine", "a" * 64, R.ACK)
        guard.assert_not_called()
        backup.assert_not_called()

    def test_apply_orders_authority_proof_native_verification_fresh_backup_and_guarded_reconcile(self):
        events = []
        class Guard:
            def __init__(self, *args): events.append("guard-created")
            def __call__(self, *args): events.append("initial-proof")
            def native_verify_original_archives(self, *args): events.append("native-original-verification")
        def authority(*args): events.append("authority")
        def gate(*args): events.append("gate")
        def backup(*args, **kwargs):
            events.append("fresh-backup")
            return Path("fresh-manifest")
        def reconcile(*args, **kwargs):
            events.append("guarded-reconcile")
            self.assertEqual(kwargs["backup_manifest"], Path("fresh-manifest"))
            self.assertIsInstance(kwargs["recovery_guard"], Guard)
            return Path("new-audit")
        with patch.object(R, "require_apply_authority", side_effect=authority), patch.object(R, "require_gate", side_effect=gate), \
                patch.object(RESUME, "HistoricalGuard", Guard), patch.object(R, "inspect_owned", return_value={}), \
                patch.object(RESUME.BACKUP, "create", side_effect=backup), patch.object(R, "reconcile", side_effect=reconcile), \
                patch("builtins.print"):
            RESUME.resume(ROOT, Path("audit"), Path("manifest"), "mine", "a" * 64, R.ACK, apply=True)
        self.assertEqual(events, ["authority", "gate", "guard-created", "initial-proof", "native-original-verification",
                                  "fresh-backup", "guarded-reconcile"])


if __name__ == "__main__":
    unittest.main()
