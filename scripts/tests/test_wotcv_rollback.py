"""Run only extracted rollback functions against fakes, never deployment entrypoints."""
import os
from pathlib import Path
import re
import shutil
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[2]
BASH = shutil.which("bash") or (
    "C:/Program Files/Git/bin/bash.exe" if os.name == "nt" else None
)


def function(script, name):
    text = (ROOT / "scripts" / script).read_text(encoding="utf-8")
    match = re.search(r"^" + name + r"\(\) \{\n.*?^\}", text, re.M | re.S)
    if not match:
        raise AssertionError(f"Missing function {name} in {script}")
    return match.group()


FAKES = r'''
set -Eeuo pipefail
COMPOSE=(mock_compose)
BACKEND_IMAGE=fixture-backend
CLIENT_IMAGE=fixture-client
HEALTHCHECK_URL=http://fixture.invalid
ROOT_DIR=/fixture-never-executed
FIXTURE_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
docker() {
  [[ "$CASE" != image_inspect_error ]] || return 11
  if [[ "$CASE" == image_label ]]; then printf '%s\n' unknown;
  else printf '%s\n' "$FIXTURE_SHA"; fi
}
mock_compose() {
  if [[ "$1" == ps ]]; then printf '%s\n' fixture-container; return 0; fi
  if [[ "$CASE" == "$1" ]]; then return 21; fi
}
wotcv_auth_assert_rollback_safe() { [[ "$CASE" != auth ]]; }
wotcv_drain_backend() { [[ "$CASE" != drain ]]; }
wotcv_wait_for_client() { [[ "$CASE" != client ]]; }
wotcv_leave_maintenance() {
  [[ "$CASE" != maintenance ]] || return 1
  printf '%s\n' maintenance-released
}
bash() {
  [[ "$CASE" != preflight ]] || return 1
  [[ "$IMAGE_TAG" == sha-prev && "$WOTCV_GIT_SHA" == "$FIXTURE_SHA" ]]
}
validate_persistent_storage() { [[ "$CASE" != persistence ]]; }
validate_clickhouse_event_baseline() { [[ "$CASE" != clickhouse ]]; }
validate_postgres_data_baseline() { [[ "$CASE" != postgres ]]; }
wotcv_wait_for_health() {
  [[ "$CASE" != health ]] || return 1
  if [[ "$CASE" == wrong_revision ]]; then printf '%s\n' '{}';
  else printf '{"imageTag":"sha-prev","gitSha":"%s"}\n' "$FIXTURE_SHA"; fi
}
'''


@unittest.skipUnless(BASH and Path(BASH).exists(), "Bash required for shell regression tests")
class RollbackTests(unittest.TestCase):
    def run_rollback(self, script, case):
        # Invoke in an if: errexit is deliberately disabled inside rollback.
        harness = FAKES + "\n" + function(script, "rollback") + r'''
if rollback sha-prev "$FIXTURE_SHA" fixture-time fixture-backend fixture-client; then
  printf '%s\n' rollback-success
else
  printf '%s\n' rollback-failed >&2
  exit 42
fi
'''
        return subprocess.run(
            [BASH, "-c", harness], env={**os.environ, "CASE": case},
            capture_output=True, text=True, timeout=15,
        )

    def test_all_rollback_failures_propagate_in_conditional_context(self):
        for script in ("wotcv-deploy.sh", "wotcv-branch-build-deploy.sh"):
            cases = ["auth", "up", "persistence", "clickhouse", "postgres", "health", "wrong_revision",
                     "drain", "client", "preflight", "maintenance", "image_inspect_error"]
            if script == "wotcv-deploy.sh":
                cases.extend(["pull", "image_label"])
            for case in cases:
                with self.subTest(script=script, case=case):
                    result = self.run_rollback(script, case)
                    self.assertEqual(result.returncode, 42, result.stderr)
                    self.assertNotIn("Rollback completed", result.stderr)
                    self.assertNotIn("rollback-success", result.stdout)
                    self.assertNotIn("maintenance-released", result.stdout)

    def test_success_is_reported_only_after_all_checks(self):
        for script in ("wotcv-deploy.sh", "wotcv-branch-build-deploy.sh"):
            result = self.run_rollback(script, "success")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("Rollback completed", result.stderr)
            self.assertIn("maintenance-released", result.stdout)

    def test_storage_validator_cannot_hide_first_or_second_mount_failure(self):
        for script in ("wotcv-deploy.sh", "wotcv-branch-build-deploy.sh"):
            for failed_service in ("clickhouse", "postgres", "redis"):
                with self.subTest(script=script, service=failed_service):
                    harness = FAKES + r'''
EXPECTED_COMPOSE_PROJECT_NAME=fixture
CLICKHOUSE_VOLUME_NAME=fixture-ch
POSTGRES_VOLUME_NAME=fixture-pg
REDIS_VOLUME_NAME=fixture-redis
wotcv_validate_container_persistence() {
  [[ "$2" != "$CASE" ]]
}
''' + "\n" + function(script, "validate_persistent_storage") + r'''
if validate_persistent_storage; then exit 0; else exit 42; fi
'''
                    result = subprocess.run(
                        [BASH, "-c", harness], env={**os.environ, "CASE": failed_service},
                        capture_output=True, text=True, timeout=15,
                    )
                    self.assertEqual(result.returncode, 42, result.stderr)

    def test_baseline_capture_and_validation_reject_partial_output_from_failed_read(self):
        for script in ("wotcv-deploy.sh", "wotcv-branch-build-deploy.sh"):
            for name in ("capture_postgres_data_baseline", "capture_clickhouse_event_baseline",
                         "validate_postgres_data_baseline", "validate_clickhouse_event_baseline"):
                for failed_read in ("ps", "query"):
                    with self.subTest(script=script, function=name, read=failed_read):
                        harness = r'''
set -Eeuo pipefail
COMPOSE=(mock_compose)
CLICKHOUSE_EVENT_BASELINE=fixture
CLICKHOUSE_REPLAY_WINDOW_START=1
CLICKHOUSE_PROTECTED_COHORT_END=2
POSTGRES_DATA_BASELINE='100 200'
mock_compose() {
  printf '%s\n' fixture-container
  [[ "$CASE" != ps ]]
}
read_invariants() {
  printf '%s\n' '100 200'
  [[ "$CASE" != query ]]
}
wotcv_postgres_data_invariants() { read_invariants; }
wotcv_clickhouse_event_invariants() { read_invariants; }
wotcv_clickhouse_replay_window_start() { printf '%s\n' 1; }
wotcv_clickhouse_protected_cohort_end() { printf '%s\n' 2; }
wotcv_assert_postgres_invariants_not_decreased() { printf '%s\n' comparator-was-called; }
wotcv_assert_clickhouse_event_invariants_not_decreased() { printf '%s\n' comparator-was-called; }
''' + "\n" + function(script, name) + f"\nif {name}; then exit 0; else exit 42; fi\n"
                        result = subprocess.run(
                            [BASH, "-c", harness], env={**os.environ, "CASE": failed_read},
                            capture_output=True, text=True, timeout=15,
                        )
                        self.assertEqual(result.returncode, 42, result.stderr)
                        self.assertNotIn("comparator-was-called", result.stdout)
                        self.assertNotIn("data baseline:", result.stdout)

    def test_persistence_validator_rejects_valid_partial_docker_inspect_output(self):
        for failed_read in ("project", "mounts"):
            with self.subTest(read=failed_read):
                harness = r'''
set -Eeuo pipefail
WOTCV_PERSISTENCE_HELPER=unused-fixture-helper
docker() {
  if [[ "$*" == *Mounts* ]]; then
    printf '%s\n' '[{"Type":"volume","Name":"fixture","Destination":"/data"}]'
    [[ "$CASE" != mounts ]]
  else
    printf '%s\n' fixture
    [[ "$CASE" != project ]]
  fi
}
python3() { printf '%s\n' validator-was-called; }
''' + "\n" + function("lib/wotcv-common.sh", "wotcv_validate_container_persistence") + r'''
if wotcv_validate_container_persistence fixture-container redis fixture fixture /data; then
  exit 0
else
  exit 42
fi
'''
                result = subprocess.run(
                    [BASH, "-c", harness], env={**os.environ, "CASE": failed_read},
                    capture_output=True, text=True, timeout=15,
                )
                self.assertEqual(result.returncode, 42, result.stderr)
                self.assertNotIn("validator-was-called", result.stdout)


if __name__ == "__main__":
    unittest.main()
