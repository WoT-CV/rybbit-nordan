"""Isolated availability helpers only: all Docker, Compose and HTTP calls are fake."""

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
BASH = shutil.which("bash") or ("C:/Program Files/Git/bin/bash.exe" if os.name == "nt" else None)
IMAGE = "sha256:" + "a" * 64
OTHER_IMAGE = "sha256:" + "b" * 64
HASH = "c" * 64
CONFIG = "<clickhouse>reviewed fixture</clickhouse>\n"
DIGEST = hashlib.sha256(CONFIG.encode()).hexdigest()

HARNESS = r'''
set -Eeuo pipefail
source "$1/scripts/lib/wotcv-deployment-availability.sh"
python3() { "$TEST_PYTHON" "$@"; }
COMPOSE=(mock_compose)
wotcv_maintenance_control() {
  printf 'maintenance %s\n' "$*" >>"$TRACE"
  [[ "$CASE" != "maintenance_$1" ]] || return 19
  case "$1" in
    status)
      if [[ "$CASE" == partial_status_error ]]; then printf 'inactive\n'; return 19; fi
      if [[ -f "$GATE_ENTERED" ]]; then printf 'active\n'; else printf '%s\n' "$MAINTENANCE_STATE"; fi ;;
    enter)
      [[ "$CASE" != wrong_owner || "${*: -1}" == gate-real-owner ]] || return 19
      touch "$GATE_ENTERED" ;;
    leave) rm -f -- "$GATE_ENTERED" ;;
    *) return 99 ;;
  esac
}
mock_compose() {
  printf 'compose %s\n' "$*" >>"$TRACE"
  case "$1" in
    ps) printf '%s\n' "$CONTAINER"; [[ "$CASE" != ps_error ]] ;;
    config) printf '%s %s\n' "${*: -1}" "$DESIRED_HASH"; [[ "$CASE" != hash_error ]] ;;
    stop) [[ "$CASE" != stop_error ]] || return 19; touch "$QUIESCED" ;;
    pull) touch "$PULLED" ;;
    up) [[ "$CASE" != up_error ]] ;;
    *) printf 'Unexpected compose: %s\n' "$*" >&2; return 99 ;;
  esac
}
docker() {
  printf 'docker %s\n' "$*" >>"$TRACE"
  case "$1" in
    image)
      [[ "$CASE" != image_error ]] || { printf '%s\n' "$DESIRED_IMAGE"; return 11; }
      [[ "$CASE" != missing_image || -f "$PULLED" ]] || return 12
      printf '%s\n' "$DESIRED_IMAGE" ;;
    inspect)
      if [[ "$*" == *'ExitCode'* ]]; then
        printf '%s\n' "$STOPPED"
        [[ "$CASE" != stopped_inspect_error ]] || return 11
      elif [[ "$*" == *'State.Restarting'* ]]; then
        if [[ -f "$QUIESCED" ]]; then printf '%s\n' "$QUIESCENCE_STOPPED";
        else printf '%s\n' "$QUIESCENCE_INITIAL"; fi
      elif [[ "$*" == *'State.Running'* ]]; then printf '%s\n' "$RUNNING";
      elif [[ "${*: -1}" == '{{.State.Status}}' ]]; then printf '%s\n' "$STATE";
      elif [[ "${*: -1}" == *'.State.Health'* ]]; then printf '%s\n' "$HEALTH";
      else printf '%s|%s|%s\n' "$CURRENT_IMAGE" "$CURRENT_HASH" "$STATE"; fi
      [[ "$CASE" != inspect_error ]] ;;
    exec)
      printf '%s  /etc/clickhouse-server/fixture.xml\n' "$MOUNTED_DIGEST"
      [[ "$CASE" != config_read_error ]] ;;
    *) printf 'Unexpected docker: %s\n' "$*" >&2; return 99 ;;
  esac
}
curl() {
  printf 'curl %s\n' "$*" >>"$TRACE"
  local count=0
  [[ ! -f "$HTTP_COUNT" ]] || read -r count <"$HTTP_COUNT"
  count=$((count + 1))
  printf '%s\n' "$count" >"$HTTP_COUNT"
  if [[ "$count" -ge "$HTTP_READY_AT" ]]; then printf '%s' "$HTTP_SUCCESS";
  else printf '%s' "$HTTP_FAILURE"; fi
  [[ "$CASE" != curl_error ]]
}
sleep() { printf 'sleep %s\n' "$*" >>"$TRACE"; }
case "$ACTION" in
  check)
    if wotcv_check_service_recreation clickhouse "$2"; then
      printf 'recreate=%s\n' "$WOTCV_SERVICE_RECREATE"
    else exit 42; fi ;;
  digests) if wotcv_service_config_digests "$2" clickhouse; then :; else exit 42; fi ;;
  prepare) if wotcv_prepare_infrastructure_image clickhouse "$2"; then :; else exit 42; fi ;;
  drain) if wotcv_drain_backend; then :; else exit 42; fi ;;
  quiesce) if wotcv_quiesce_applications; then :; else exit 42; fi ;;
  client) if wotcv_wait_for_client; then :; else exit 42; fi ;;
  gate)
    if ! wotcv_require_maintenance_gate; then exit 42; fi
    if ! wotcv_enter_maintenance || ! wotcv_enter_maintenance; then exit 42; fi
    if [[ "$CASE" == after_enter_error ]]; then
      wotcv_maintenance_failure_notice; exit 42
    fi
    if ! wotcv_leave_maintenance || ! wotcv_leave_maintenance; then
      wotcv_maintenance_failure_notice; exit 42
    fi ;;
  notice)
    WOTCV_MAINTENANCE_STARTED=1
    wotcv_maintenance_failure_notice
    exit 42 ;;
  apply)
    WOTCV_MAINTENANCE_STARTED="$APPLY_MAINTENANCE"
    if wotcv_apply_infrastructure_change clickhouse "$REQUIRED"; then :; else exit 42; fi ;;
  plan)
    if ! wotcv_plan_shared_infrastructure "$2"; then exit 42; fi
    printf 'clickhouse=%s redis=%s\n' "$WOTCV_CLICKHOUSE_RECREATE" "$WOTCV_REDIS_RECREATE" ;;
  *) exit 99 ;;
esac
'''


@unittest.skipUnless(BASH and Path(BASH).exists(), "Bash required for isolated shell tests")
class AvailabilityTests(unittest.TestCase):
    def run_case(self, config=None, raw_config=None, **overrides):
        with tempfile.TemporaryDirectory(prefix="wotcv-availability-test-") as directory:
            path = Path(directory)
            fixture = path / "compose.json"
            if config is None:
                config = {
                    "services": {"clickhouse": {
                        "image": "fixture:immutable",
                        "configs": [{"source": "fixture", "target": "/etc/clickhouse-server/fixture.xml"}],
                    }},
                    "configs": {"fixture": {"content": CONFIG}},
                }
            # Compose escapes all dollar bytes AFTER JSON serialization.
            # Literal runtime $$ must therefore be exported as $$$$.
            fixture.write_bytes(
                json.dumps(config).encode("utf-8").replace(b"$", b"$$") if raw_config is None else raw_config
            )
            environment = {
                **{name: value for name, value in os.environ.items() if name != "WOTCV_MAINTENANCE_OWNER"},
                "ACTION": "check", "CASE": "", "TEST_PYTHON": sys.executable,
                "CONTAINER": "fixture-container", "STATE": "running",
                "DESIRED_IMAGE": IMAGE, "CURRENT_IMAGE": IMAGE,
                "DESIRED_HASH": HASH, "CURRENT_HASH": HASH,
                "MOUNTED_DIGEST": DIGEST, "RUNNING": "true", "STOPPED": "false 0",
                "HEALTH": "healthy", "MAINTENANCE_STATE": "inactive", "APPLY_MAINTENANCE": "1", "REQUIRED": "1",
                "TRACE": (path / "trace").as_posix(), "PULLED": (path / "pulled").as_posix(),
                "QUIESCED": (path / "quiesced").as_posix(), "GATE_ENTERED": (path / "gate-entered").as_posix(),
                "QUIESCENCE_INITIAL": "true false false running", "QUIESCENCE_STOPPED": "false false false exited",
                "HTTP_COUNT": (path / "http-count").as_posix(), "HTTP_FAILURE": "503",
                "HTTP_SUCCESS": "200", "HTTP_READY_AT": "1", "WOTCV_HEALTHCHECK_ATTEMPTS": "3",
                **overrides,
            }
            result = subprocess.run(
                [BASH, "-c", HARNESS, "test", ROOT.as_posix(), fixture.as_posix()],
                env=environment, capture_output=True, text=True, timeout=20,
            )
            trace = (path / "trace").read_text() if (path / "trace").exists() else ""
            return result, trace

    def test_unchanged_image_service_hash_and_config_bytes_do_not_restart_clickhouse(self):
        result, trace = self.run_case()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("recreate=0", result.stdout)
        self.assertNotIn("compose up", trace)
        self.assertNotIn("compose stop", trace)

    def test_image_service_hash_or_config_bytes_change_requires_one_planned_recreation(self):
        for changes in ({"CURRENT_IMAGE": OTHER_IMAGE}, {"CURRENT_HASH": "d" * 64},
                        {"MOUNTED_DIGEST": "e" * 64}, {"MOUNTED_DIGEST": "missing"},
                        {"STATE": "exited"}, {"CONTAINER": ""}, {"CURRENT_HASH": "<no value>"}):
            with self.subTest(changes=changes):
                result, trace = self.run_case(**changes)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("recreate=1", result.stdout)
                # A plan is read-only, even when it discovers changed infrastructure.
                self.assertNotIn("compose up", trace)
                self.assertNotIn("compose stop", trace)

    def test_inspection_errors_and_valid_partial_output_never_become_unchanged(self):
        for case in ("ps_error", "image_error", "inspect_error", "hash_error", "config_read_error"):
            with self.subTest(case=case):
                result, trace = self.run_case(CASE=case)
                self.assertEqual(result.returncode, 42, result.stderr)
                self.assertNotIn("recreate=", result.stdout)
                self.assertNotIn("compose up", trace)

    def test_ambiguous_or_malformed_attestation_fails_closed(self):
        for changes in ({"CONTAINER": "one\ntwo"}, {"CURRENT_IMAGE": "bad"},
                        {"DESIRED_HASH": "bad"}, {"DESIRED_HASH": HASH + "\nclickhouse " + HASH},
                        {"MOUNTED_DIGEST": "bad"}, {"STATE": "unknown"}):
            with self.subTest(changes=changes):
                result, _ = self.run_case(**changes)
                self.assertEqual(result.returncode, 42, result.stderr)

    def test_unsupported_config_source_is_not_silently_ignored(self):
        for source in ({"external": True}, {"environment": "CREDENTIALS"}, {}, {"content": 12}):
            with self.subTest(source=source):
                config = {"services": {"clickhouse": {
                    "image": "fixture:immutable", "configs": [{"source": "fixture", "target": "/safe.xml"}],
                }}, "configs": {"fixture": source}}
                result, _ = self.run_case(config=config)
                self.assertEqual(result.returncode, 42, result.stderr)

    def test_service_without_mounted_configs_can_remain_unchanged(self):
        result, trace = self.run_case(config={"services": {"clickhouse": {"image": "fixture:immutable"}}})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("recreate=0", result.stdout)
        self.assertNotIn("docker exec", trace)

    def test_file_config_content_is_attested_too(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = Path(directory) / "mounted.xml"
            fixture.write_bytes(CONFIG.encode())
            config = {"services": {"clickhouse": {
                "image": "fixture:immutable", "configs": [{"source": "fixture", "target": "/safe.xml"}],
            }}, "configs": {"fixture": {"file": fixture.as_posix()}}}
            result, _ = self.run_case(config=config)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("recreate=0", result.stdout)

    def test_compose_dollar_export_decodes_once_before_inline_content_hashing(self):
        source = "fixture$literal$$"
        target = "/etc/clickhouse-server/$settings$$.xml"
        for content in ("${POSTGRES_USER}\n", "literal$dollar\n", "genuine$$pair\n",
                        "${VALUE} $ $$ $$$ $$$$ $$$$$\n"):
            with self.subTest(content=content):
                config = {"services": {"clickhouse": {
                    "image": "fixture:immutable", "configs": [{"source": source, "target": target}],
                }}, "configs": {source: {"content": content}}}
                result, trace = self.run_case(
                    config=config, MOUNTED_DIGEST=hashlib.sha256(content.encode()).hexdigest(),
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("recreate=0", result.stdout)
                self.assertIn("sh " + target, trace)
                self.assertNotIn("compose up", trace)
                self.assertNotIn("compose stop", trace)

    def test_genuine_runtime_double_dollars_are_not_collapsed_during_comparison(self):
        config = {"services": {"clickhouse": {
            "image": "fixture:immutable", "configs": [{"source": "fixture", "target": "/safe.xml"}],
        }}, "configs": {"fixture": {"content": "runtime$$literal\n"}}}
        result, _ = self.run_case(
            config=config, MOUNTED_DIGEST=hashlib.sha256(b"runtime$literal\n").hexdigest(),
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("recreate=1", result.stdout)

    def test_file_config_dollar_bytes_and_filename_are_not_treated_as_export_content(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = Path(directory) / "mounted$actual$$.xml"
            content = b"${POSTGRES_USER} $ literal$$ $$$\n"
            fixture.write_bytes(content)
            config = {"services": {"clickhouse": {
                "image": "fixture:immutable", "configs": [{"source": "fixture", "target": "/safe.xml"}],
            }}, "configs": {"fixture": {"file": fixture.as_posix()}}}
            result, _ = self.run_case(config=config, MOUNTED_DIGEST=hashlib.sha256(content).hexdigest())
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("recreate=0", result.stdout)
            self.assertEqual(fixture.read_bytes(), content)

    def test_unpaired_dollar_export_is_rejected_without_config_or_secret_output(self):
        for raw_config in (
            b'{"services":{"clickhouse":{"configs":[]}},"private$credential":"never-print"}',
            b'{"services":{"clickhouse":{"configs":[]}},"unused":"private${VALUE}"}',
            b'{"services":{"clickhouse":{"configs":[]}},"unused":"private$$$credential"}',
        ):
            with self.subTest(raw_config=raw_config):
                result, trace = self.run_case(ACTION="digests", raw_config=raw_config)
                self.assertEqual(result.returncode, 42, result.stderr)
                self.assertEqual(result.stdout, "")
                self.assertIn("Cannot attest", result.stderr)
                self.assertNotIn("private", result.stderr)
                self.assertNotIn("never-print", result.stderr)
                self.assertNotIn("docker ", trace)

    def test_missing_infrastructure_image_is_prepared_without_container_changes(self):
        result, trace = self.run_case(ACTION="prepare", CASE="missing_image")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(trace.count("compose pull clickhouse"), 1)
        self.assertNotIn("compose up", trace)
        self.assertNotIn("compose stop", trace)
        result, trace = self.run_case(ACTION="prepare")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("compose pull", trace)

    def test_backend_clean_drain_is_confirmed_before_returning(self):
        result, trace = self.run_case(ACTION="drain")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("compose stop --timeout 60 backend", trace)
        self.assertIn(".State.ExitCode", trace)
        self.assertLess(trace.index("compose stop"), trace.index(".State.ExitCode"))

    def test_unclean_or_failed_drain_fails_even_in_a_conditional(self):
        for changes in ({"STOPPED": "false 137"}, {"STOPPED": "false 1"},
                        {"STOPPED": "true 0"}, {"CASE": "stop_error"}, {"CASE": "inspect_error"},
                        {"CONTAINER": ""}, {"CONTAINER": "one\ntwo"}, {"RUNNING": "unexpected"}):
            with self.subTest(changes=changes):
                result, trace = self.run_case(ACTION="drain", **changes)
                self.assertEqual(result.returncode, 42, result.stderr)
                self.assertNotIn("compose up", trace)

    def test_already_stopped_backend_is_not_started_or_stopped_again(self):
        result, trace = self.run_case(ACTION="drain", RUNNING="false")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("compose stop", trace)
        self.assertNotIn("compose up", trace)
        self.assertEqual(trace.count(".State.ExitCode"), 1)

    def test_already_stopped_backend_must_have_a_confirmed_zero_exit_code(self):
        for stopped in ("false 137", "false 143", "false 1", "false -1", "false", "true 0", "false unknown"):
            with self.subTest(stopped=stopped):
                result, trace = self.run_case(ACTION="drain", RUNNING="false", STOPPED=stopped)
                self.assertEqual(result.returncode, 42, result.stderr)
                self.assertIn(".State.ExitCode", trace)
                self.assertNotIn("compose stop", trace)
                self.assertNotIn("compose up", trace)

    def test_already_stopped_backend_rejects_valid_partial_output_from_failed_exit_inspect(self):
        result, trace = self.run_case(ACTION="drain", RUNNING="false", STOPPED="false 0", CASE="stopped_inspect_error")
        self.assertEqual(result.returncode, 42, result.stderr)
        self.assertIn(".State.ExitCode", trace)
        self.assertNotIn("compose stop", trace)
        self.assertNotIn("compose up", trace)

    def test_app_only_quiescence_allows_stopped_failed_candidates_without_relaxing_strict_drain(self):
        result, trace = self.run_case(ACTION="quiesce", QUIESCENCE_INITIAL="false false false exited", STOPPED="false 1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("compose stop", trace)
        self.assertNotIn("ExitCode", trace)
        self.assertEqual(trace.count(".State.Restarting"), 2)
        result, trace = self.run_case(ACTION="drain", RUNNING="false", STOPPED="false 1")
        self.assertEqual(result.returncode, 42, result.stderr)
        self.assertNotIn("compose up", trace)

    def test_app_only_quiescence_stops_and_verifies_both_applications(self):
        result, trace = self.run_case(ACTION="quiesce")
        self.assertEqual(result.returncode, 0, result.stderr)
        # This fixture shares one stopped flag; the second service is already
        # quiescent when checked. Both still get their own inspected snapshots.
        self.assertIn("compose stop --timeout 60 backend", trace)
        self.assertIn("compose ps -a -q client", trace)
        self.assertEqual(trace.count(".State.Restarting"), 3)

    def test_app_only_quiescence_rejects_running_restarting_paused_or_uncertain_workers(self):
        for changes in (
            {"QUIESCENCE_STOPPED": "true false false running"},
            {"QUIESCENCE_STOPPED": "false true false restarting"},
            {"QUIESCENCE_STOPPED": "false false true paused"},
            {"QUIESCENCE_STOPPED": "false false false unknown"},
            {"CASE": "stop_error"}, {"CASE": "inspect_error"},
            {"CONTAINER": "one\ntwo"},
        ):
            with self.subTest(changes=changes):
                result, trace = self.run_case(ACTION="quiesce", **changes)
                self.assertEqual(result.returncode, 42, result.stderr)
                self.assertNotIn("compose up", trace)

    def test_frontend_requires_exact_200_and_retries_transient_failures(self):
        for failure in ("000", "301", "302", "404", "500", "503"):
            with self.subTest(status=failure):
                result, trace = self.run_case(ACTION="client", HTTP_FAILURE=failure, HTTP_READY_AT="2")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(trace.count("curl "), 2)
                self.assertIn("http://127.0.0.1:3002/login", trace)

    def test_frontend_connection_failure_or_non_200_never_passes_readiness(self):
        for changes in ({"HTTP_SUCCESS": "301"}, {"HTTP_SUCCESS": "503"}, {"CASE": "curl_error"}):
            with self.subTest(changes=changes):
                result, trace = self.run_case(ACTION="client", **changes)
                self.assertEqual(result.returncode, 42, result.stderr)
                self.assertEqual(trace.count("curl "), 3)

    def test_frontend_honors_explicit_probe_url_and_rejects_invalid_deadline(self):
        result, trace = self.run_case(ACTION="client", WOTCV_CLIENT_HEALTHCHECK_URL="http://127.0.0.1:9999/login")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("http://127.0.0.1:9999/login", trace)
        result, trace = self.run_case(ACTION="client", WOTCV_HEALTHCHECK_ATTEMPTS="0")
        self.assertEqual(result.returncode, 42, result.stderr)
        self.assertNotIn("curl ", trace)

    def test_missing_unknown_or_existing_gate_fails_before_any_mutation(self):
        for changes in ({"CASE": "maintenance_status"}, {"MAINTENANCE_STATE": "active"},
                        {"MAINTENANCE_STATE": "unknown"}):
            with self.subTest(changes=changes):
                result, trace = self.run_case(ACTION="gate", **changes)
                self.assertEqual(result.returncode, 42, result.stderr)
                self.assertNotIn("maintenance enter", trace)
                self.assertNotIn("compose ", trace)
                self.assertNotIn("docker ", trace)

    def test_gate_is_entered_and_released_once_with_the_same_owner(self):
        result, trace = self.run_case(ACTION="gate")
        self.assertEqual(result.returncode, 0, result.stderr)
        operations = trace.splitlines()
        self.assertEqual(len(operations), 3)
        self.assertEqual(operations[0], "maintenance status")
        self.assertTrue(operations[1].startswith("maintenance enter --owner deploy-"))
        self.assertEqual(operations[1].replace(" enter ", " leave "), operations[2])

    def test_failure_never_implicitly_releases_maintenance(self):
        for case in ("maintenance_enter", "after_enter_error", "maintenance_leave"):
            with self.subTest(case=case):
                result, trace = self.run_case(ACTION="gate", CASE=case)
                self.assertEqual(result.returncode, 42, result.stderr)
                if case != "maintenance_leave":
                    self.assertNotIn("maintenance leave", trace)
                if case != "maintenance_enter":
                    self.assertIn("Maintenance flag is verified active", result.stderr)

    def test_active_gate_can_only_resume_with_its_explicit_verified_owner(self):
        result, trace = self.run_case(
            ACTION="gate", MAINTENANCE_STATE="active", WOTCV_MAINTENANCE_OWNER="gate-real-owner",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(trace.splitlines(), [
            "maintenance status", "maintenance enter --owner gate-real-owner",
            "maintenance leave --owner gate-real-owner",
        ])
        self.assertIn("Resuming the explicitly owned maintenance window", result.stdout)

    def test_wrong_owner_or_tampered_gate_cannot_be_adopted(self):
        for changes in ({"CASE": "wrong_owner"}, {"CASE": "maintenance_status"}):
            with self.subTest(changes=changes):
                result, trace = self.run_case(
                    ACTION="gate", MAINTENANCE_STATE="active", WOTCV_MAINTENANCE_OWNER="not-the-owner", **changes,
                )
                self.assertEqual(result.returncode, 42, result.stderr)
                self.assertNotIn("maintenance leave", trace)
                self.assertNotIn("Resuming", result.stdout)

    def test_invalid_explicit_owner_is_rejected_before_gate_or_runtime_calls(self):
        for owner in ("", "has spaces", "x" * 81, "bad;token", "line\nbreak", "../token"):
            with self.subTest(owner=owner):
                result, trace = self.run_case(ACTION="gate", WOTCV_MAINTENANCE_OWNER=owner)
                self.assertEqual(result.returncode, 42, result.stderr)
                self.assertEqual(trace, "")

    def test_resumed_failure_keeps_gate_with_original_owner(self):
        result, trace = self.run_case(
            ACTION="gate", MAINTENANCE_STATE="active", WOTCV_MAINTENANCE_OWNER="gate-real-owner",
            CASE="after_enter_error",
        )
        self.assertEqual(result.returncode, 42, result.stderr)
        self.assertIn("Maintenance flag is verified active (operation-owner=gate-real-owner; current flag ownership is not attested)", result.stderr)
        self.assertNotIn("maintenance leave", trace)

    def test_failure_notice_reports_observed_marker_state_and_never_trusts_partial_error_output(self):
        for changes, expected in (
            ({"MAINTENANCE_STATE": "active"}, "flag is verified active"),
            ({"MAINTENANCE_STATE": "inactive"}, "traffic may already be open"),
            ({"MAINTENANCE_STATE": "unknown"}, "do not assume traffic is gated"),
            ({"CASE": "maintenance_status"}, "do not assume traffic is gated"),
            ({"CASE": "partial_status_error"}, "do not assume traffic is gated"),
        ):
            with self.subTest(changes=changes):
                result, trace = self.run_case(ACTION="notice", **changes)
                self.assertEqual(result.returncode, 42, result.stderr)
                self.assertIn(expected, result.stderr)
                self.assertNotIn("remains enabled", result.stderr)
                self.assertEqual(trace, "maintenance status\n")

    def test_changed_shared_infrastructure_requires_gate_and_verified_clean_drain(self):
        result, trace = self.run_case(ACTION="apply")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(trace.count("compose up -d --no-deps --force-recreate clickhouse"), 1)
        self.assertLess(trace.index("compose stop --timeout 60 backend"), trace.index("compose up"))
        self.assertLess(trace.index(".State.ExitCode"), trace.index("compose up"))
        for changes in ({"APPLY_MAINTENANCE": "0"}, {"STOPPED": "false 137"},
                        {"STOPPED": "false 1"}, {"CASE": "stop_error"},
                        {"RUNNING": "false", "STOPPED": "false 137"},
                        {"RUNNING": "false", "STOPPED": "false 143"}):
            with self.subTest(changes=changes):
                result, trace = self.run_case(ACTION="apply", **changes)
                self.assertEqual(result.returncode, 42, result.stderr)
                self.assertNotIn("compose up", trace)

    def test_unchanged_shared_infrastructure_is_only_health_checked(self):
        result, trace = self.run_case(ACTION="apply", REQUIRED="0", APPLY_MAINTENANCE="0")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("compose stop", trace)
        self.assertNotIn("compose up", trace)
        self.assertIn(".State.Health", trace)

    def test_failed_shared_start_or_health_fails_closed(self):
        for changes in ({"CASE": "up_error"}, {"HEALTH": "unhealthy"}):
            with self.subTest(changes=changes):
                result, _ = self.run_case(ACTION="apply", **changes)
                self.assertEqual(result.returncode, 42, result.stderr)

    def test_plan_attests_both_shared_services_without_restarting_them(self):
        config = {"services": {name: {"image": "fixture:immutable"} for name in ("clickhouse", "redis")}}
        result, trace = self.run_case(ACTION="plan", config=config)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("clickhouse=0 redis=0", result.stdout)
        self.assertIn("compose config --hash clickhouse", trace)
        self.assertIn("compose config --hash redis", trace)
        self.assertNotIn("compose stop", trace)
        self.assertNotIn("compose up", trace)

    def test_entrypoints_check_gate_before_mutation_and_enter_only_after_image_preparation(self):
        for script in ("wotcv-branch-build-deploy.sh", "wotcv-deploy.sh"):
            with self.subTest(script=script):
                text = (ROOT / "scripts" / script).read_text()
                top_level = text[text.index('PREVIOUS_TAG="$(wotcv_read_state'):]
                self.assertIn('source "${ROOT_DIR}/scripts/lib/wotcv-deployment-availability.sh"', text)
                self.assertLess(text.index("\nwotcv_require_maintenance_gate\n"), text.index('PREVIOUS_TAG="$(wotcv_read_state'))
                self.assertLess(top_level.index("wotcv_plan_shared_infrastructure"), top_level.index("wotcv_enter_maintenance"))
                self.assertLess(top_level.index("wotcv_enter_maintenance"), top_level.index("Starting backend and client"))
                self.assertLess(top_level.index("if ! wotcv_wait_for_client"), top_level.index('mv "${STATE_FILE}.tmp"'))
                self.assertLess(top_level.index('mv "${STATE_FILE}.tmp"'), top_level.index("wotcv_leave_maintenance"))
                self.assertNotIn("--force-recreate clickhouse", text)
                if script == "wotcv-branch-build-deploy.sh":
                    self.assertLess(top_level.index("validate_runtime_images\n"), top_level.index("wotcv_enter_maintenance"))
                else:
                    self.assertLess(top_level.index("pull backend client"), top_level.index("wotcv_enter_maintenance"))
                    self.assertIn('wotcv_wait_for_health "${HEALTHCHECK_URL}" "${TARGET_REVISION}" "${IMAGE_TAG}"', top_level)


if __name__ == "__main__":
    unittest.main()
