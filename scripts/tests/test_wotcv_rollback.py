"""Run only extracted rollback functions against fakes, never deployment entrypoints."""
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
BASH = shutil.which("bash") or (
    "C:/Program Files/Git/bin/bash.exe" if os.name == "nt" else None
)
REVISION = "a" * 40
TAG = "sha-" + REVISION
BACKEND_ID = "sha256:" + "b" * 64
CLIENT_ID = "sha256:" + "c" * 64
BACKEND_DIGEST = "sha256:" + "e" * 64
CLIENT_DIGEST = "sha256:" + "f" * 64
REAL_HELPERS = (ROOT / "scripts/lib/wotcv-deployment-availability.sh").read_text(encoding="utf-8")
REAL_AUTH_HELPERS = (ROOT / "scripts/lib/wotcv-auth-cutover.sh").read_text(encoding="utf-8")


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
FIXTURE_TAG=sha-$FIXTURE_SHA
BACKEND_ID=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
CLIENT_ID=sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
CANDIDATE_ID=sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd
BACKEND_DIGEST=sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
CLIENT_DIGEST=sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff
WOTCV_MAINTENANCE_STARTED=1
IMAGE_TAG=candidate-tag
WOTCV_GIT_SHA=candidate-sha
WOTCV_BUILD_TIME=candidate-build-time
python3() { "$TEST_PYTHON" "$@"; }
docker() {
  printf 'docker %s\n' "$*" >>"${TRACE:-/dev/null}"
  local reference="${3:-}" service image revision="$FIXTURE_SHA" digests phase
  case "$1" in
    pull)
      [[ "$CASE" != pull ]] || return 11
      [[ "$2" == fixture-backend@* || "$2" == fixture-client@* ]] || return 98
      touch "$PULLED" ;;
    image)
      if [[ "$2" == ls ]]; then
        [[ "$CASE" != retention_ls_error ]] || return 11
        [[ "$CASE" != alias_collision ]] || printf '%s\n' "$CANDIDATE_ID"
        return 0
      elif [[ "$2" == tag ]]; then
        [[ "$CASE" != retention_tag_error ]] || return 11
        printf '%s|%s\n' "$4" "$3" >>"$ALIASES"
        return 0
      elif [[ "$2" == rm ]]; then [[ "$CASE" != retention_rm_error ]]; return;
      fi
      [[ "$CASE" != image_inspect_error ]] || return 11
      [[ "$CASE" != missing_local || "$reference" != "$BACKEND_ID" ]] || return 11
      [[ "$CASE" != missing_client || "$reference" != "$CLIENT_ID" ]] || return 11
      case "$reference" in
        *:wotcv-retained-*)
          image=
          if [[ -f "$ALIASES" ]]; then
            while IFS='|' read -r saved_alias saved_id; do
              [[ "$saved_alias" != "$reference" ]] || image="$saved_id"
            done <"$ALIASES"
          fi
          [[ -n "$image" ]] || return 11
          [[ "$CASE" != alias_inspect_error ]] || return 11
          if [[ "$reference" == fixture-backend:* ]]; then service=backend; else service=client; fi
          if [[ "$CASE" == alias_wrong_id || ("$CASE" == alias_changed_before_cleanup && "${*: -1}" == '{{.Id}}') ]]; then image="$CANDIDATE_ID"; fi
          digests= ;;
        "$BACKEND_ID"|fixture-backend@*) service=backend; image="$BACKEND_ID"; digests="fixture-backend@$BACKEND_DIGEST" ;;
        "$CLIENT_ID"|fixture-client@*) service=client; image="$CLIENT_ID"; digests="fixture-client@$CLIENT_DIGEST" ;;
        fixture-backend:*|fixture-client:*) image="$CANDIDATE_ID"; service=rebound-tag; digests= ;;
        "$CANDIDATE_ID") image="$CANDIDATE_ID"; service=candidate; digests= ;;
        *) return 11 ;;
      esac
      if [[ "$CASE" == containerd_prune && -f "$BUILT" && ("$reference" == "$BACKEND_ID" || "$reference" == "$CLIENT_ID") && ! -f "$ALIASES" ]]; then return 11; fi
      if [[ "$CASE" == pull || "$CASE" == registry_pull ]]; then
        [[ "$reference" != *@* || -f "$PULLED" ]] || return 11
      fi
      [[ "$CASE" != image_label ]] || revision=unknown
      [[ "$CASE" != "${service}_revision" ]] || revision=9999999999999999999999999999999999999999
      if [[ "$CASE" == wrong_digest || "$CASE" == "${service}_wrong_digest" ]]; then
        digests="fixture-$service@sha256:0000000000000000000000000000000000000000000000000000000000000000"
      fi
      case "${*: -1}" in
        '{{.Id}}') printf '%s\n' "$image" ;;
        '{{index .Config.Labels "org.opencontainers.image.revision"}}') printf '%s\n' "$revision" ;;
        *RepoDigests*) printf '%s|%s|%s\n' "$image" "$revision" "$digests" ;;
        *'{{.Id}}|'*) printf '%s|%s\n' "$image" "$revision" ;;
        *) printf '%s\n' "$image" ;;
      esac
      [[ "$CASE" != partial_image_inspect_error ]] || return 11 ;;
    inspect)
      service="${2#fixture-}"
      if [[ -f "$PHASE" ]]; then read -r phase <"$PHASE"; else phase=candidate; fi
      if [[ "${*: -1}" == *'{{.Image}}|'* ]]; then
        if [[ "$service" == backend ]]; then image="$BACKEND_ID"; else image="$CLIENT_ID"; fi
        [[ "$CASE" != "${phase}_${service}_mismatch" ]] || image="$CANDIDATE_ID"
        if [[ "$CASE" == stopped_other_id && "$phase" == candidate ]]; then printf '%s|false|false|false|exited\n' "$CANDIDATE_ID";
        elif [[ "$phase" == created ]]; then printf '%s|false|false|false|created\n' "$image";
        else printf '%s|true|false|false|running\n' "$image"; fi
      elif [[ "${*: -1}" == *ExitCode* ]]; then printf 'false 1\n';
      elif [[ "${*: -1}" == '{{.State.Running}}' ]]; then printf 'false\n';
      elif [[ "$CASE" == exited1 || -f "$STOPPED-$service" ]]; then
        if [[ "$CASE" == quiescence ]]; then printf 'false true false restarting\n';
        else printf 'false false false exited\n'; fi
      else printf 'true false false running\n'; fi
      [[ "$CASE" != container_inspect_error ]] || return 11 ;;
    start)
      [[ "$CASE" != start ]] || return 11
      [[ "$*" == 'start fixture-backend fixture-client' ]] || return 98
      printf 'running\n' >"$PHASE" ;;
    *) return 99 ;;
  esac
}
mock_compose() {
  local override=
  while [[ "$1" == -f ]]; do override="$2"; shift 2; done
  printf 'compose %s\n' "$*" >>"${TRACE:-/dev/null}"
  if [[ "$1" == ps ]]; then printf 'fixture-%s\n' "${*: -1}"; [[ "$CASE" != ps_error ]]; return; fi
  if [[ "$CASE" == "$1" ]]; then return 21; fi
  case "$1" in
    build) touch "$BUILT" ;;
    stop) touch "$STOPPED-${*: -1}" ;;
    up)
      [[ "$*" == 'up --no-start --no-deps --force-recreate --no-build --pull never --remove-orphans=false backend client' ]] || return 98
      python3 - "$override" "$TRACE" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as stream:
    services = json.load(stream)["services"]
with open(sys.argv[2], "a", encoding="utf-8") as stream:
    for name in ("backend", "client"):
        assert services[name]["pull_policy"] == "never"
        stream.write("override " + name + "=" + services[name]["image"] + "\n")
PY
      printf 'created\n' >"$PHASE" ;;
    *) return 99 ;;
  esac
}
wotcv_auth_schema_state() { printf 'current\n'; }
wotcv_auth_image_version() {
  printf 'auth-image %s\n' "$1" >>"$TRACE"
  if [[ "$CASE" == auth ]]; then printf '1.6.0\n'; else printf '1.7.3\n'; fi
}
wotcv_wait_for_client() { [[ "$CASE" != client ]]; }
wotcv_leave_maintenance() {
  [[ "$CASE" != maintenance ]] || return 1
  printf '%s\n' maintenance-released
}
bash() {
  [[ "$CASE" != preflight ]] || return 1
  [[ "$IMAGE_TAG" == "$FIXTURE_TAG" && "$WOTCV_GIT_SHA" == "$FIXTURE_SHA" ]]
}
validate_persistent_storage() { [[ "$CASE" != persistence ]]; }
validate_clickhouse_event_baseline() { [[ "$CASE" != clickhouse ]]; }
validate_postgres_data_baseline() { [[ "$CASE" != postgres ]]; }
wotcv_wait_for_health() {
  [[ "$CASE" != health ]] || return 1
  if [[ "$CASE" == wrong_revision ]]; then printf '%s\n' '{}';
  else printf '{"imageTag":"%s","gitSha":"%s"}\n' "$FIXTURE_TAG" "$FIXTURE_SHA"; fi
}
'''


@unittest.skipUnless(BASH and Path(BASH).exists(), "Bash required for shell regression tests")
class RollbackTests(unittest.TestCase):
    def run_rollback(self, script, case, kind="local-id", **overrides):
        # Invoke in an if: errexit is deliberately disabled inside rollback.
        harness = REAL_HELPERS + "\n" + REAL_AUTH_HELPERS + "\n" + FAKES + "\n" + function(script, "rollback") + r'''
if [[ "$IDENTITY_KIND" == registry-digest ]]; then
  backend_identity="$BACKEND_DIGEST"; client_identity="$CLIENT_DIGEST"
else backend_identity="$BACKEND_ID"; client_identity="$CLIENT_ID"; fi
backend_identity="${RECORDED_BACKEND:-$backend_identity}"
client_identity="${RECORDED_CLIENT:-$client_identity}"
if [[ "$ACTION" == strict ]]; then
  if wotcv_drain_backend; then exit 0; else exit 42; fi
fi
if [[ "$ACTION" == preserve* ]]; then
  if [[ "${EMPTY_IDENTITIES:-0}" == 1 ]]; then
    if wotcv_preserve_recorded_applications '' '' '' '' legacy; then exit 0; else exit 42; fi
  fi
  if ! wotcv_preserve_recorded_applications "$FIXTURE_TAG" "$FIXTURE_SHA" "$backend_identity" "$client_identity" "$IDENTITY_KIND"; then exit 42; fi
  if [[ "$ACTION" == preserve-release ]]; then
    if wotcv_release_retained_applications; then exit 0; else exit 42; fi
  fi
  [[ "$ACTION" != preserve ]] || exit 0
  mock_compose build backend client
elif [[ "$ACTION" == build-without-retention ]]; then mock_compose build backend client
fi
if rollback "$FIXTURE_TAG" "${RECORDED_REVISION:-$FIXTURE_SHA}" fixture-time "$backend_identity" "$client_identity" "$IDENTITY_KIND"; then
  [[ "$IMAGE_TAG" == candidate-tag && "$WOTCV_GIT_SHA" == candidate-sha && "$WOTCV_BUILD_TIME" == candidate-build-time ]] || exit 97
  printf '%s\n' rollback-success
else
  printf '%s\n' rollback-failed >&2
  exit 42
fi
'''
        with tempfile.TemporaryDirectory(prefix="wotcv-rollback-test-") as directory:
            path = Path(directory)
            state = path / "deployment.env"
            previous_state = "" if overrides.get("EMPTY_STATE") == "1" else f"LAST_GIT_SHA={REVISION}\nBACKEND_IMAGE_DIGEST={BACKEND_ID}\nCLIENT_IMAGE_DIGEST={CLIENT_ID}\n"
            state.write_text(previous_state, encoding="utf-8")
            result = subprocess.run(
                [BASH, "-s"], input=harness, env={
                    **os.environ, "CASE": case, "IDENTITY_KIND": kind,
                    "TEST_PYTHON": sys.executable, "ACTION": "rollback",
                    "TRACE": (path / "trace").as_posix(), "PHASE": (path / "phase").as_posix(),
                    "STOPPED": (path / "stopped").as_posix(), "PULLED": (path / "pulled").as_posix(),
                    "STATE_FILE": state.as_posix(),
                    "ALIASES": (path / "aliases").as_posix(), "BUILT": (path / "built").as_posix(),
                    "TMPDIR": path.as_posix(), **overrides,
                }, capture_output=True, text=True, timeout=15,
            )
            result.trace = (path / "trace").read_text() if (path / "trace").exists() else ""
            self.assertEqual(list(path.glob("rybbit-wotcv-rollback.*.json")), [])
            self.assertEqual(state.read_text(encoding="utf-8"), previous_state)
            return result

    def test_all_rollback_failures_propagate_in_conditional_context(self):
        for script in ("wotcv-deploy.sh", "wotcv-branch-build-deploy.sh"):
            cases = ["auth", "up", "persistence", "clickhouse", "postgres", "health", "wrong_revision",
                     "stop", "quiescence", "client", "preflight", "maintenance", "image_inspect_error",
                     "partial_image_inspect_error", "image_label", "start", "container_inspect_error", "ps_error"]
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

    def test_rebound_tag_and_same_revision_rebuild_restore_recorded_local_ids(self):
        # The fake mutable tag now names a DIFFERENT ID at the SAME git SHA.
        # Runtime metadata/health also reports the old SHA, so neither can attest it.
        for script in ("wotcv-deploy.sh", "wotcv-branch-build-deploy.sh"):
            with self.subTest(script=script):
                result = self.run_rollback(script, "same_sha_rebuild")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("override backend=" + BACKEND_ID, result.trace)
                self.assertIn("override client=" + CLIENT_ID, result.trace)
                self.assertNotIn("fixture-backend:" + TAG, result.trace)
                self.assertNotIn("fixture-client:" + TAG, result.trace)
                self.assertIn("auth-image " + BACKEND_ID, result.trace)
                self.assertLess(result.trace.index("{{.Image}}"), result.trace.index("docker start"))
                self.assertEqual(result.trace.count("docker start fixture-backend fixture-client"), 1)

    def test_wrong_actual_backend_or_client_id_never_starts_either_created_application(self):
        for script in ("wotcv-deploy.sh", "wotcv-branch-build-deploy.sh"):
            for service in ("backend", "client"):
                with self.subTest(script=script, service=service):
                    result = self.run_rollback(script, "created_" + service + "_mismatch")
                    self.assertEqual(result.returncode, 42, result.stderr)
                    self.assertNotIn("docker start", result.trace)
                    self.assertNotIn("maintenance-released", result.stdout)

    def test_wrong_running_identity_cannot_reopen_traffic_even_with_spoofed_health_sha(self):
        for script in ("wotcv-deploy.sh", "wotcv-branch-build-deploy.sh"):
            for service in ("backend", "client"):
                with self.subTest(script=script, service=service):
                    result = self.run_rollback(script, "running_" + service + "_mismatch")
                    self.assertEqual(result.returncode, 42, result.stderr)
                    self.assertIn("docker start", result.trace)
                    self.assertNotIn("maintenance-released", result.stdout)

    def test_missing_recorded_local_id_never_uses_the_rebound_tag(self):
        for case in ("missing_local", "missing_client"):
            for script in ("wotcv-deploy.sh", "wotcv-branch-build-deploy.sh"):
                with self.subTest(case=case, script=script):
                    result = self.run_rollback(script, case)
                    self.assertEqual(result.returncode, 42, result.stderr)
                    self.assertNotIn("compose up", result.trace)
                    self.assertNotIn("docker pull", result.trace)

    def test_registry_recovery_uses_only_recorded_digest_and_revision_for_both_images(self):
        for script in ("wotcv-deploy.sh", "wotcv-branch-build-deploy.sh"):
            with self.subTest(script=script):
                result = self.run_rollback(script, "registry_pull", kind="registry-digest")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("docker pull fixture-backend@" + BACKEND_DIGEST, result.trace)
                self.assertIn("override backend=fixture-backend@" + BACKEND_DIGEST, result.trace)
                self.assertIn("override client=fixture-client@" + CLIENT_DIGEST, result.trace)
                self.assertNotIn("compose pull", result.trace)
                self.assertNotIn("fixture-backend:" + TAG, result.trace)
            for case in ("pull", "wrong_digest", "client_wrong_digest", "backend_revision", "client_revision", "image_label"):
                with self.subTest(script=script, case=case):
                    result = self.run_rollback(script, case, kind="registry-digest")
                    self.assertEqual(result.returncode, 42, result.stderr)
                    self.assertNotIn("compose up", result.trace)
                    self.assertNotIn("docker start", result.trace)
                    self.assertNotIn("maintenance-released", result.stdout)

    def test_local_revision_and_invalid_legacy_identity_fail_before_recovery(self):
        for script in ("wotcv-deploy.sh", "wotcv-branch-build-deploy.sh"):
            for case in ("backend_revision", "client_revision"):
                with self.subTest(script=script, case=case):
                    result = self.run_rollback(script, case)
                    self.assertEqual(result.returncode, 42, result.stderr)
                    self.assertNotIn("compose up", result.trace)
            for changes in ({"RECORDED_BACKEND": "unknown"}, {"RECORDED_CLIENT": "invalid"},
                            {"RECORDED_REVISION": "unknown"}):
                with self.subTest(script=script, changes=changes):
                    result = self.run_rollback(script, "success", kind="legacy", **changes)
                    self.assertEqual(result.returncode, 42, result.stderr)
                    self.assertNotIn("compose up", result.trace)
                    self.assertNotIn("docker start", result.trace)
            result = self.run_rollback(script, "success", kind="legacy")
            self.assertEqual(result.returncode, 0, result.stderr)
            result = self.run_rollback(script, "success", kind="unknown")
            self.assertEqual(result.returncode, 42, result.stderr)
            self.assertNotIn("compose up", result.trace)

    def test_exited_failed_candidate_allows_app_only_recovery_but_not_shared_infra_drain(self):
        for script in ("wotcv-deploy.sh", "wotcv-branch-build-deploy.sh"):
            with self.subTest(script=script):
                result = self.run_rollback(script, "exited1")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertNotIn("compose stop", result.trace)
                self.assertIn("docker start fixture-backend fixture-client", result.trace)
                self.assertIn("maintenance-released", result.stdout)
                result = self.run_rollback(script, "exited1", ACTION="strict")
                self.assertEqual(result.returncode, 42, result.stderr)
                self.assertNotIn("compose up", result.trace)
                self.assertIn("shared infrastructure will not be changed", result.stderr)

    def test_legacy_state_can_resolve_exact_registry_digests_or_mixed_known_identities(self):
        for backend in (BACKEND_ID, BACKEND_DIGEST):
            with self.subTest(backend=backend):
                result = self.run_rollback(
                    "wotcv-deploy.sh", "success", kind="legacy",
                    RECORDED_BACKEND=backend, RECORDED_CLIENT=CLIENT_DIGEST,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("override client=fixture-client@" + CLIENT_DIGEST, result.trace)
                self.assertNotIn("compose pull", result.trace)

    def test_registry_state_records_the_expected_repository_digest_not_an_arbitrary_first_entry(self):
        harness = r'''
set -Eeuo pipefail
TARGET_TAG=sha-fixture
docker() {
  printf '%s\n' unrelated@sha256:1111111111111111111111111111111111111111111111111111111111111111
  [[ "$CASE" == missing ]] || printf '%s\n' fixture-backend@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
  [[ "$CASE" != partial_error ]]
}
''' + "\n" + function("wotcv-deploy.sh", "image_digest") + r'''
if image_digest fixture-backend; then exit 0; else exit 42; fi
'''
        for case in ("success", "missing", "partial_error"):
            with self.subTest(case=case):
                result = subprocess.run(
                    [BASH, "-s"], input=harness, env={**os.environ, "CASE": case},
                    capture_output=True, text=True, timeout=15,
                )
                self.assertEqual(result.returncode, 0 if case == "success" else 42, result.stderr)
                if case == "success":
                    self.assertEqual(result.stdout.strip(), BACKEND_DIGEST)
                else:
                    self.assertEqual(result.stdout, "")

    def test_retention_prevents_same_sha_containerd_index_gc_and_survives_rollback(self):
        for script in ("wotcv-deploy.sh", "wotcv-branch-build-deploy.sh"):
            with self.subTest(script=script):
                result = self.run_rollback(script, "containerd_prune", ACTION="build-without-retention")
                self.assertEqual(result.returncode, 42, result.stderr)
                self.assertNotIn("docker start", result.trace)
                result = self.run_rollback(script, "containerd_prune", ACTION="preserve-build-rollback")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.trace.count("docker image tag "), 2)
                self.assertIn("docker image tag " + BACKEND_ID + " fixture-backend:wotcv-retained-", result.trace)
                self.assertIn("docker image tag " + CLIENT_ID + " fixture-client:wotcv-retained-", result.trace)
                self.assertLess(result.trace.rindex("docker image tag "), result.trace.index("compose build"))
                self.assertIn("docker start fixture-backend fixture-client", result.trace)
                self.assertNotIn("docker image rm", result.trace)

    def test_invalid_or_unavailable_previous_state_never_silently_disables_retention(self):
        for case, changes in (
            ("missing_local", {}), ("missing_client", {}),
            ("backend_revision", {}), ("client_revision", {}),
            ("success", {"RECORDED_BACKEND": "unknown"}),
            ("success", {"RECORDED_CLIENT": "unknown"}),
            ("success", {"EMPTY_IDENTITIES": "1"}),
        ):
            with self.subTest(case=case, changes=changes):
                result = self.run_rollback("wotcv-branch-build-deploy.sh", case, ACTION="preserve-build-rollback", **changes)
                self.assertEqual(result.returncode, 42, result.stderr)
                self.assertNotIn("docker image tag", result.trace)
                self.assertNotIn("compose build", result.trace)
                self.assertNotIn("compose up", result.trace)

    def test_first_deployment_empty_state_is_explicit_and_does_not_invent_retention(self):
        result = self.run_rollback(
            "wotcv-branch-build-deploy.sh", "success", ACTION="preserve", EMPTY_STATE="1", EMPTY_IDENTITIES="1",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("First deployment", result.stdout)
        self.assertIn("automatic rollback is unavailable", result.stdout)
        self.assertEqual(result.trace, "")

    def test_retention_refuses_unassociated_active_images_but_accepts_stopped_failed_candidate(self):
        for service in ("backend", "client"):
            with self.subTest(service=service):
                result = self.run_rollback("wotcv-branch-build-deploy.sh", "candidate_" + service + "_mismatch", ACTION="preserve")
                self.assertEqual(result.returncode, 42, result.stderr)
                self.assertNotIn("docker image tag", result.trace)
        result = self.run_rollback("wotcv-branch-build-deploy.sh", "stopped_other_id", ACTION="preserve")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.trace.count("docker image tag "), 2)

    def test_retention_tag_lookup_tagging_or_alias_attestation_errors_abort_before_build(self):
        for case in ("retention_ls_error", "alias_collision", "retention_tag_error", "alias_inspect_error", "alias_wrong_id"):
            with self.subTest(case=case):
                result = self.run_rollback("wotcv-branch-build-deploy.sh", case, ACTION="preserve-build-rollback")
                self.assertEqual(result.returncode, 42, result.stderr)
                self.assertNotIn("compose build", result.trace)
                self.assertNotIn("compose up", result.trace)
                self.assertNotIn("docker image rm", result.trace)
                if case in ("retention_ls_error", "alias_collision"):
                    self.assertNotIn("docker image tag", result.trace)

    def test_success_cleanup_removes_only_minted_aliases_and_never_changed_names(self):
        result = self.run_rollback("wotcv-branch-build-deploy.sh", "success", ACTION="preserve-release")
        self.assertEqual(result.returncode, 0, result.stderr)
        removals = [line for line in result.trace.splitlines() if line.startswith("docker image rm")]
        self.assertEqual(len(removals), 2)
        self.assertTrue(all(":wotcv-retained-" in line for line in removals))
        self.assertNotIn("docker image rm -- sha256:", result.trace)
        result = self.run_rollback("wotcv-branch-build-deploy.sh", "alias_changed_before_cleanup", ACTION="preserve-release")
        self.assertEqual(result.returncode, 42, result.stderr)
        self.assertNotIn("docker image rm", result.trace)

    def test_entrypoints_retain_after_reexec_before_tag_mutation_and_release_only_on_forward_success(self):
        for script in ("wotcv-deploy.sh", "wotcv-branch-build-deploy.sh"):
            text = (ROOT / "scripts" / script).read_text(encoding="utf-8")
            top_level = text[text.index('PREVIOUS_TAG="$(wotcv_read_state'):]
            preserve = top_level.index("\nwotcv_preserve_recorded_applications ")
            if script == "wotcv-branch-build-deploy.sh":
                self.assertLess(top_level.index('exec bash "${ROOT_DIR}/scripts/wotcv-branch-build-deploy.sh"'), preserve)
                mutation = top_level.index('"${COMPOSE[@]}" "${BUILD_COMMAND[@]}" backend client')
            else:
                mutation = top_level.index('"${COMPOSE[@]}" pull backend client')
            self.assertLess(preserve, mutation)
            self.assertLess(top_level.index('mv "${STATE_FILE}.tmp"'), top_level.index("wotcv_leave_maintenance"))
            self.assertLess(top_level.index("wotcv_leave_maintenance"), top_level.index("wotcv_release_retained_applications"))
            self.assertIn('wotcv_release_retained_applications || echo "Warning:', top_level)
            self.assertNotIn("wotcv_release_retained_applications", function(script, "rollback"))

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
                        [BASH, "-s"], input=harness, env={**os.environ, "CASE": failed_service},
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
                            [BASH, "-s"], input=harness, env={**os.environ, "CASE": failed_read},
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
                    [BASH, "-s"], input=harness, env={**os.environ, "CASE": failed_read},
                    capture_output=True, text=True, timeout=15,
                )
                self.assertEqual(result.returncode, 42, result.stderr)
                self.assertNotIn("validator-was-called", result.stdout)


if __name__ == "__main__":
    unittest.main()
