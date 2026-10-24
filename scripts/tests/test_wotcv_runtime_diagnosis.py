"""The partial-repair diagnostic is read-only and never prints inspected values."""

import copy
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

from test_wotcv_runtime_logging import fixture

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("runtime_diagnosis_test", ROOT / "scripts/wotcv-diagnose-runtime-logging.py")
DIAG = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DIAG)


class RuntimeDiagnosisTests(unittest.TestCase):
    def test_difference_paths_never_include_values_and_keep_type_changes(self):
        self.assertEqual(DIAG.changed_paths({"Env": ["SECRET=old-secret"]}, {"Env": ["SECRET=new-secret"]}), ["/Env/0"])
        self.assertEqual(DIAG.changed_paths({"Dns": []}, {"Dns": None}), ["/Dns"])
        self.assertEqual(DIAG.changed_paths(False, 0), ["/"])
        self.assertLessEqual(len(DIAG.changed_paths(list(range(1000)), list(range(1, 1001)))), 128)

    def test_environment_mapping_preserves_values_but_refuses_duplicate_or_malformed_names(self):
        value = "literal-$A-$$B=tail"
        self.assertEqual(DIAG.unique_environment({"Config": {"Env": ["TOKEN=" + value]}}), {"TOKEN": value})
        for env in (None, ["BAD"], ["=value"], ["A=x", "A=x"], ["A=x", "A=y"], [42]):
            with self.subTest(env=env), self.assertRaises(DIAG.RUNTIME.Refused):
                DIAG.unique_environment({"Config": {"Env": env}})

    def test_partial_repair_reports_projection_and_original_data_without_resume_authority(self):
        _, before = fixture()
        before["backend"]["State"].update(Status="exited", Running=False, ExitCode=0)
        before["postgres"]["Config"]["Env"] += ["PRIVATE=never-print-this"]
        after = copy.deepcopy(before)
        after["postgres"]["Id"] = "a" * 64
        after["postgres"]["Config"]["Hostname"] = "a" * 12
        after["postgres"]["Config"]["Env"].reverse()
        after["postgres"]["State"].update(Running=True, Health={"Status": "healthy"})
        for key in ("Dns", "DnsOptions", "DnsSearch"):
            after["postgres"]["HostConfig"][key] = None
        pg = {"system_identifier": "123", "database": "analytics", "users": 1, "sites": 1, "aliases": 3, "alias": None}
        redis = {"timestamp_ms": 1, "keys": {}}
        evidence = {"runtime.before.json": before, "postgres.before.json": pg, "redis.before.json": redis,
                    "recovery.json": {"maintenanceOwner": "mine"}, "failure.json": {}}
        original_copy = copy.deepcopy(before)
        after_copy = copy.deepcopy(after)
        with patch.object(DIAG, "require_root"), \
                patch.object(DIAG, "read_private_json", side_effect=lambda path: evidence[path.name]), \
                patch.object(Path, "exists", return_value=False), patch.object(DIAG.RUNTIME, "require_gate"), \
                patch.object(DIAG.RUNTIME, "inspect_owned", return_value=after), \
                patch.object(DIAG.RUNTIME, "postgres_snapshot", return_value=pg), \
                patch.object(DIAG.RUNTIME, "redis_snapshot", return_value=redis), \
                patch.object(DIAG.RUNTIME, "command") as native:
            result = DIAG.diagnose(ROOT, Path("/protected-audit"), "mine")
        self.assertTrue(result["diagnosisCompleted"])
        self.assertTrue(result["originalDataInvariantsPreserved"])
        self.assertTrue(result["postgresUniqueEnvironmentMappingsEqual"])
        self.assertEqual(result["remainingPathsAfterDnsAndEnvOrderProjection"], [])
        self.assertEqual(result["unexpectedOtherServiceChanges"], [])
        self.assertFalse(result["resumeAuthorized"])
        for field in ("containersRecreated", "backendStarted", "maintenanceRemoved", "clickhouseReconnectionVerified", "backupArtifactsReverified"):
            self.assertFalse(result[field])
        self.assertNotIn("never-print-this", json.dumps(result))
        self.assertEqual(before, original_copy)
        self.assertEqual(after, after_copy)
        native.assert_not_called()


if __name__ == "__main__":
    unittest.main()
