"""Exercise the shell capture path without Docker, credentials or a database."""
import os
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
BASH = shutil.which("bash") or (
    "C:/Program Files/Git/bin/bash.exe" if os.name == "nt" else None
)

SCRIPT = r'''
source "$1/scripts/lib/wotcv-common.sh"
docker() {
  local query
  query="$(cat)"
  if [[ "$query" == 'SELECT toUnixTimestamp(now()) FORMAT TSVRaw' ]]; then
    printf '%s\n' 1800000000
    [[ "$CASE" != timestamp_error ]]
  elif [[ "$query" == 'EXISTS TABLE session_replay_metadata_v2 FORMAT TSVRaw' ]]; then
    case "$CASE" in
      exists_error) return 9 ;;
      exists_invalid) printf '%s\n' unexpected ;;
      missing_v2) printf '%s\n' 0 ;;
      *) printf '%s\n' 1 ;;
    esac
  elif [[ "$query" == *'FROM session_replay_metadata_v2 FINAL'* ]]; then
    case "$CASE" in
      v2_error) printf '8\t7\n'; return 9 ;;
      v2_invalid) printf '8\t7\t6\n' ;;
      *) printf '8\t7\n' ;;
    esac
  else
    printf '100\t1000\t1799999000\t10\t11\t1800000000\t1797494400\t1800000000\t1000\t10\t10\t900\t9\t9\n'
    [[ "$CASE" != core_error ]]
  fi
}
# Bash disables errexit in an if/command-substitution context. The helper must
# explicitly propagate every database failure, including valid partial output.
if captured="$(wotcv_clickhouse_event_invariants fake-container)"; then
  printf '%s\n' "$captured"
else
  exit 42
fi
'''


@unittest.skipUnless(BASH and Path(BASH).exists(), "Bash required for shell regression tests")
class ClickHouseCaptureTests(unittest.TestCase):
    def capture(self, case):
        return subprocess.run(
            [BASH, "-c", SCRIPT, "test", ROOT.as_posix()],
            env={**os.environ, "CASE": case},
            capture_output=True, text=True, timeout=15,
        )

    def test_valid_v2_has_sixteen_values(self):
        result = self.capture("valid")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(result.stdout.split()), 16)
        self.assertEqual(result.stdout.split()[-2:], ["8", "7"])

    def test_only_confirmed_missing_v2_uses_zero(self):
        result = self.capture("missing_v2")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.split()[-2:], ["0", "0"])

    def test_database_failures_never_become_successful_baselines(self):
        for case in ("timestamp_error", "core_error", "exists_error", "exists_invalid", "v2_error", "v2_invalid"):
            with self.subTest(case=case):
                result = self.capture(case)
                self.assertEqual(result.returncode, 42, result.stderr)
                self.assertEqual(result.stdout, "")


@unittest.skipUnless(BASH and Path(BASH).exists(), "Bash required for shell regression tests")
class ComposePortTests(unittest.TestCase):
    def validate(self, config):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "compose.json"
            path.write_text(json.dumps(config), encoding="utf-8")
            return subprocess.run(
                [BASH, "-c", 'source "$1/scripts/lib/wotcv-common.sh"; '
                 'task_test_python="$3"; python3() { "$task_test_python" "$@"; }; '
                 'wotcv_validate_compose_ports "$2"',
                 "test", ROOT.as_posix(), path.as_posix(), sys.executable.replace("\\", "/")],
                capture_output=True, text=True, timeout=15,
            )

    def config(self):
        return {"services": {
            name: {"ports": [] if name == "redis" else [{"host_ip": "127.0.0.1", "target": 3001}]}
            for name in ("redis", "clickhouse", "postgres", "backend", "client")
        }}

    def test_loopback_ipv4_and_ipv6_pass(self):
        for host in ("127.0.0.1", "::1"):
            config = self.config()
            config["services"]["backend"]["ports"][0]["host_ip"] = host
            result = self.validate(config)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_published_redis_fails_even_on_loopback(self):
        config = self.config()
        config["services"]["redis"]["ports"] = [{"host_ip": "127.0.0.1", "target": 6379}]
        result = self.validate(config)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Redis must not publish", result.stderr)

    def test_every_application_and_database_port_is_guarded(self):
        for service in ("clickhouse", "postgres", "backend", "client"):
            for host in (None, "", "0.0.0.0", "::", "192.0.2.1"):
                with self.subTest(service=service, host=host):
                    config = self.config()
                    port = config["services"][service]["ports"][0]
                    if host is None:
                        port.pop("host_ip")
                    else:
                        port["host_ip"] = host
                    result = self.validate(config)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("outside loopback", result.stderr)

    def test_all_deployment_entrypoints_use_port_guard_before_mutation(self):
        image_deploy = (ROOT / "scripts/wotcv-deploy.sh").read_text(encoding="utf-8")
        self.assertLess(image_deploy.index("\nwotcv_require_non_root\n"),
                        image_deploy.index('echo "Pulling immutable application images..."'))
        self.assertLess(image_deploy.index('wotcv_validate_compose_ports "${COMPOSE_CONFIG_FILE}"'),
                        image_deploy.index('echo "Pulling immutable application images..."'))
        self.assertLess(image_deploy.index('bash scripts/wotcv-identity-v2-preflight.sh'),
                        image_deploy.index('cat >"${STATE_FILE}.tmp"'))
        self.assertIn('export WOTCV_GIT_SHA="${TARGET_REVISION}"', image_deploy)
        branch = (ROOT / "scripts/wotcv-branch-build-deploy.sh").read_text(encoding="utf-8")
        self.assertIn('wotcv_validate_compose_ports "${COMPOSE_CONFIG_FILE}"', branch)
        preflight = (ROOT / "scripts/wotcv-identity-v2-preflight.sh").read_text(encoding="utf-8")
        self.assertIn('wotcv_validate_compose_ports "${compose_config}"', preflight)

    def test_env_example_uses_complete_loopback_port_mappings(self):
        example = (ROOT / ".env.example").read_text(encoding="utf-8")
        self.assertIn("HOST_BACKEND_PORT=127.0.0.1:3001:3001", example)
        self.assertIn("HOST_CLIENT_PORT=127.0.0.1:3002:3002", example)


if __name__ == "__main__":
    unittest.main()
