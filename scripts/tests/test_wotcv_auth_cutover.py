"""Auth cutover tests: fake Docker, temporary files, no live databases."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
BASH = shutil.which("bash") or ("C:/Program Files/Git/bin/bash.exe" if os.name == "nt" else None)

SCRIPT = r'''
set -Eeuo pipefail
ROOT_DIR="$1"
source "$ROOT_DIR/scripts/lib/wotcv-auth-cutover.sh"
python3() { "$TEST_PYTHON" "$@"; }
COMPOSE=(docker compose)
docker() {
  case "$1 $2" in
    'exec -i')
      local query
      query="$(cat)"
      [[ "${*: -1}" == *default_transaction_read_only=on* ]] || return 90
      [[ "${*: -1}" == *ON_ERROR_STOP=1* ]] || return 91
      if [[ "$query" == *to_regclass* ]]; then
        printf '%s\n' "${JOURNAL:-t}"
        [[ "${CASE:-}" != journal_error ]]
      elif [[ "$query" == *'SELECT CASE WHEN EXISTS'* ]]; then
        printf '%s\n' "${SCHEMA:-pending}"
        [[ "${CASE:-}" != history_error ]]
      else
        [[ "$query" == 'BEGIN READ ONLY;'* && "$query" == *'metadata::jsonb'* ]] || return 92
        [[ "$query" != *'CREATE TABLE'* ]] || return 93
        printf 'PREFLIGHT\n' >&2
        printf 'auth-preflight-ok\n'
        [[ "${CASE:-}" != preflight_error && ( "${CASE:-}" != after_stop_error || ! -e "$STOP_FILE" ) ]]
      fi ;;
    'compose ps') printf '%s\n' "${BACKENDS:-backend-id}" ;;
    'compose stop')
      printf 'STOP\n' >&2
      [[ "${CASE:-}" != stop_error ]] || return 9
      touch "$STOP_FILE" ;;
    'inspect backend-id')
      if [[ "$*" == *ExitCode* ]]; then printf '%s\n' "${STOP_STATE:-false 0}";
      else printf '%s\n' "${RUNNING:-true}"; fi ;;
    'exec backend-id'|'run --rm') printf '%s\n' "${VERSION:-1.7.3}" ;;
    *) echo "Unexpected Docker call: $*" >&2; return 99 ;;
  esac
}
# Intentionally use if: helpers must fail closed when errexit is suppressed.
if [[ "$ACTION" == rollback ]]; then
  if wotcv_auth_assert_rollback_safe test-image postgres; then exit 0; else exit 42; fi
elif [[ "$ACTION" == ack ]]; then
  if wotcv_auth_require_cutover_ack; then exit 0; else exit 42; fi
else
  if wotcv_auth_prepare_cutover postgres; then
    echo "READY started=$WOTCV_AUTH_CUTOVER_STARTED"
  else
    exit 42
  fi
fi
'''


@unittest.skipUnless(BASH and Path(BASH).exists(), "Bash required")
class AuthCutoverTests(unittest.TestCase):
    def run_case(self, **overrides):
        with tempfile.TemporaryDirectory(prefix="wotcv-auth-test-") as tmp:
            backup = Path(tmp) / "postgres.backup"
            backup.write_bytes(b"test fixture, not a real backup")
            if overrides.pop("STALE_BACKUP", False):
                os.utime(backup, (time.time() - 172800,) * 2)
            if overrides.pop("EMPTY_BACKUP", False):
                backup.write_bytes(b"")
            environment = {
                **os.environ,
                "ACTION": "prepare", "CASE": "", "SCHEMA": "pending", "JOURNAL": "t",
                "VERSION": "1.7.3", "RUNNING": "true", "STOP_STATE": "false 0",
                "BACKENDS": "backend-id", "TEST_PYTHON": sys.executable,
                "STOP_FILE": (Path(tmp) / "stopped").as_posix(),
                "WOTCV_AUTH_CUTOVER_ACK": "backup-verified-writers-reviewed",
                "WOTCV_AUTH_BACKUP_FILE": backup.as_posix(),
                **overrides,
            }
            return subprocess.run(
                [BASH, "-c", SCRIPT, "test", ROOT.as_posix()], env=environment,
                capture_output=True, text=True, timeout=20,
            )

    def test_cutover_checks_data_before_and_after_drain(self):
        result = self.run_case()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr.splitlines(), ["PREFLIGHT", "STOP", "PREFLIGHT"])
        self.assertIn("READY started=1", result.stdout)

    def test_current_schema_does_not_stop_workers(self):
        result = self.run_case(SCHEMA="current")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("READY started=0", result.stdout)
        self.assertNotIn("STOP", result.stderr)

    def test_current_schema_refuses_old_running_workers(self):
        result = self.run_case(SCHEMA="current", VERSION="1.6.25")
        self.assertEqual(result.returncode, 42)
        self.assertNotIn("STOP", result.stderr)

    def test_stopped_workers_allow_recovery_after_completed_migration(self):
        result = self.run_case(SCHEMA="current", RUNNING="false")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_database_errors_and_partial_output_fail_closed_before_stop(self):
        for case in ("journal_error", "history_error", "preflight_error"):
            with self.subTest(case=case):
                result = self.run_case(CASE=case)
                self.assertEqual(result.returncode, 42, result.stderr)
                self.assertNotIn("STOP", result.stderr)
                self.assertNotIn("READY", result.stdout)

    def test_unknown_history_and_multiple_backends_fail_closed(self):
        for inputs in ({"JOURNAL": "f"}, {"JOURNAL": ""}, {"SCHEMA": "diverged"},
                       {"SCHEMA": "current\npending"}, {"BACKENDS": "a\nb"}):
            with self.subTest(inputs=inputs):
                # Use explicit unexpected text rather than fake-shell defaults.
                if inputs == {"JOURNAL": ""}:
                    inputs = {"JOURNAL": "unexpected"}
                result = self.run_case(**inputs)
                self.assertEqual(result.returncode, 42, result.stderr)
                self.assertNotIn("STOP", result.stderr)

    def test_requires_explicit_ack_and_recent_nonempty_backup(self):
        for inputs in (
            {"WOTCV_AUTH_CUTOVER_ACK": ""},
            {"WOTCV_AUTH_BACKUP_FILE": ""},
            {"WOTCV_AUTH_BACKUP_FILE": "relative.backup"},
            {"STALE_BACKUP": True}, {"EMPTY_BACKUP": True},
        ):
            with self.subTest(inputs=inputs):
                result = self.run_case(**inputs)
                self.assertEqual(result.returncode, 42, result.stderr)
                self.assertNotIn("STOP", result.stderr)

    def test_drain_and_second_preflight_errors_block_migrations(self):
        for inputs in ({"CASE": "stop_error"}, {"STOP_STATE": "true 0"},
                       {"STOP_STATE": "false 137"}, {"STOP_STATE": "false unknown"},
                       {"CASE": "after_stop_error"}):
            with self.subTest(inputs=inputs):
                result = self.run_case(**inputs)
                self.assertEqual(result.returncode, 42, result.stderr)
                self.assertNotIn("READY", result.stdout)

    def test_rollback_never_crosses_auth_boundary(self):
        result = self.run_case(ACTION="rollback", SCHEMA="current", VERSION="1.6.25")
        self.assertEqual(result.returncode, 42, result.stderr)
        self.assertIn("BLOCKED", result.stderr)

    def test_rollback_to_reviewed_auth_version_is_allowed(self):
        result = self.run_case(ACTION="rollback", SCHEMA="current", VERSION="1.7.3")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_rollback_does_not_hide_database_failure(self):
        result = self.run_case(ACTION="rollback", CASE="history_error", SCHEMA="current")
        self.assertEqual(result.returncode, 42, result.stderr)

    def test_both_deploy_entrypoints_wire_cutover_before_migration(self):
        availability = (ROOT / "scripts/lib/wotcv-deployment-availability.sh").read_text()
        restore = availability[availability.index("wotcv_restore_recorded_applications() ("):
                               availability.index("\nwotcv_service_image()")]
        self.assertLess(restore.index("wotcv_auth_assert_rollback_safe"),
                        restore.index("wotcv_quiesce_applications"))
        self.assertLess(restore.index("wotcv_auth_assert_rollback_safe"),
                        restore.index("up --no-start"))
        self.assertLess(restore.index("wotcv_assert_application_images"),
                        restore.index("docker start"))
        for name in ("wotcv-branch-build-deploy.sh", "wotcv-deploy.sh"):
            with self.subTest(name=name):
                script = (ROOT / "scripts" / name).read_text()
                self.assertIn('source "${ROOT_DIR}/scripts/lib/wotcv-auth-cutover.sh"', script)
                prepare = script.index('wotcv_auth_prepare_cutover "$(')
                migrate = script.index("'npm run db:migrate'")
                self.assertLess(prepare, migrate)
                self.assertIn('wotcv_auth_schema_state "$(' , script[migrate:])
                rollback = script[script.index("rollback() {"):script.index("PREVIOUS_TAG=")]
                self.assertLess(rollback.index("wotcv_restore_recorded_applications"),
                                rollback.index("wotcv_wait_for_health"))


if __name__ == "__main__":
    unittest.main()
