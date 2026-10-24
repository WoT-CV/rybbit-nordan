"""Exercise fixed log rotation with rendered JSON, without Docker or databases."""

import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "lib"))

from wotcv_logging import EXPECTED_LOGGING, SERVICES, validate_compose_logging  # noqa: E402


BASH = shutil.which("bash") or (
    "C:/Program Files/Git/bin/bash.exe" if os.name == "nt" else None
)
VALIDATOR = ROOT / "scripts" / "lib" / "wotcv_logging.py"


def valid_config():
    return {
        "services": {
            name: {"logging": copy.deepcopy(EXPECTED_LOGGING)} for name in SERVICES
        }
    }


class ComposeLoggingTests(unittest.TestCase):
    def test_accepts_all_five_services_without_changing_input(self):
        config = valid_config()
        config["services"]["caddy"] = {"image": "caddy:2.10.0"}
        before = copy.deepcopy(config)
        validate_compose_logging(config)
        self.assertEqual(config, before)

    def test_contract_has_exact_service_names_and_rotation_values(self):
        self.assertEqual(SERVICES, ("clickhouse", "postgres", "redis", "backend", "client"))
        self.assertEqual(EXPECTED_LOGGING, {
            "driver": "json-file", "options": {"max-size": "50m", "max-file": "5"},
        })

    def test_rejects_missing_or_malformed_services_object(self):
        for config in (None, [], "", {}, {"services": None}, {"services": []}):
            with self.subTest(config=config):
                with self.assertRaises(ValueError):
                    validate_compose_logging(config)

    def test_requires_every_service(self):
        for name in SERVICES:
            with self.subTest(service=name):
                config = valid_config()
                del config["services"][name]
                with self.assertRaisesRegex(ValueError, name):
                    validate_compose_logging(config)

    def test_rejects_malformed_service_or_logging_on_every_service(self):
        for name in SERVICES:
            for value in (None, [], "json-file", False):
                for field in ("service", "logging"):
                    with self.subTest(service=name, field=field, value=value):
                        config = valid_config()
                        if field == "service":
                            config["services"][name] = value
                        else:
                            config["services"][name]["logging"] = value
                        with self.assertRaisesRegex(ValueError, name):
                            validate_compose_logging(config)

    def test_rejects_missing_logging_and_changed_driver(self):
        for name in SERVICES:
            for driver in (None, "local", "journald", ""):
                with self.subTest(service=name, driver=driver):
                    config = valid_config()
                    if driver is None:
                        del config["services"][name]["logging"]
                    else:
                        config["services"][name]["logging"]["driver"] = driver
                    with self.assertRaisesRegex(ValueError, name):
                        validate_compose_logging(config)

    def test_rejects_changed_missing_numeric_or_extra_options(self):
        invalid_logging = [
            {},
            {"options": {"max-size": "50m", "max-file": "5"}},
            {"driver": "json-file"},
            {"driver": "json-file", "options": None},
            {"driver": "json-file", "options": []},
            {"driver": "json-file", "options": {"max-file": "5"}},
            {"driver": "json-file", "options": {"max-size": "50m"}},
            {"driver": "json-file", "options": {"max-size": "100m", "max-file": "5"}},
            {"driver": "json-file", "options": {"max-size": "50m", "max-file": "10"}},
            {"driver": "json-file", "options": {"max-size": "50m", "max-file": 5}},
            {"driver": "json-file", "options": {"max-size": 50, "max-file": "5"}},
            {"driver": "json-file", "options": {"max-size": "50m", "max-file": "5", "compress": "true"}},
            {**EXPECTED_LOGGING, "unexpected": True},
        ]
        for name in SERVICES:
            for logging in invalid_logging:
                with self.subTest(service=name, logging=logging):
                    config = valid_config()
                    config["services"][name]["logging"] = copy.deepcopy(logging)
                    with self.assertRaisesRegex(ValueError, name):
                        validate_compose_logging(config)


class ComposeLoggingCliTests(unittest.TestCase):
    def run_validator(self, content):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "compose.json"
            path.write_text(content, encoding="utf-8")
            return subprocess.run(
                [sys.executable, str(VALIDATOR), str(path)],
                capture_output=True, text=True, timeout=15,
            )

    def test_valid_json_file_passes(self):
        result = self.run_validator(json.dumps(valid_config()))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "Compose logging validation passed.")
        self.assertEqual(result.stderr, "")

    def test_invalid_logging_fails_without_disclosing_environment(self):
        config = valid_config()
        config["services"]["backend"]["environment"] = {"PASSWORD": "do-not-print-this"}
        config["services"]["backend"]["logging"]["options"]["max-size"] = "100m"
        result = self.run_validator(json.dumps(config))
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertIn("backend logging", result.stderr)
        self.assertNotIn("do-not-print-this", result.stdout + result.stderr)
        self.assertNotIn("Traceback", result.stderr)

    def test_invalid_json_fails_without_a_traceback(self):
        result = self.run_validator("not-json")
        self.assertEqual(result.returncode, 1)
        self.assertIn("Compose logging validation failed", result.stderr)
        self.assertNotIn("Traceback", result.stderr)

    def test_missing_file_fails_without_a_traceback(self):
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run(
                [sys.executable, str(VALIDATOR), str(Path(directory) / "missing.json")],
                capture_output=True, text=True, timeout=15,
            )
        self.assertEqual(result.returncode, 1)
        self.assertIn("Compose logging validation failed", result.stderr)
        self.assertNotIn("Traceback", result.stderr)

    @unittest.skipUnless(BASH and Path(BASH).exists(), "Bash required for shell regression test")
    def test_shell_helper_propagates_success_and_failure(self):
        for valid in (True, False):
            with self.subTest(valid=valid), tempfile.TemporaryDirectory() as directory:
                config = valid_config()
                if not valid:
                    config["services"]["redis"]["logging"]["options"]["max-file"] = "10"
                path = Path(directory) / "compose.json"
                path.write_text(json.dumps(config), encoding="utf-8")
                result = subprocess.run(
                    [BASH, "-c", 'source "$1/scripts/lib/wotcv-common.sh"; '
                     'task_test_python="$3"; python3() { "$task_test_python" "$@"; }; '
                     'wotcv_validate_compose_logging "$2"',
                     "test", ROOT.as_posix(), path.as_posix(), sys.executable.replace("\\", "/")],
                    capture_output=True, text=True, timeout=15,
                )
                self.assertEqual(result.returncode, 0 if valid else 1, result.stderr)


class ComposeLoggingEntrypointTests(unittest.TestCase):
    def test_image_deploy_checks_logging_before_image_or_container_mutations(self):
        source = (ROOT / "scripts/wotcv-deploy.sh").read_text(encoding="utf-8")
        guard = source.index('\nwotcv_validate_compose_logging "${COMPOSE_CONFIG_FILE}"')
        for mutation in ('\n"${COMPOSE[@]}" pull backend client',
                         '\nwotcv_auth_prepare_cutover "$(',
                         '\n"${COMPOSE[@]}" run --rm',
                         '\n"${COMPOSE[@]}" up -d'):
            self.assertLess(guard, source.index(mutation))

    def test_branch_deploy_checks_logging_before_infrastructure_or_build(self):
        source = (ROOT / "scripts/wotcv-branch-build-deploy.sh").read_text(encoding="utf-8")
        function = source.split("validate_compose_config() {", 1)[1].split("\n}", 1)[0]
        self.assertIn('wotcv_validate_compose_logging "${COMPOSE_CONFIG_FILE}"', function)
        validation = source.index("\nvalidate_compose_config\n")
        for mutation in ("\nensure_redis_internal_only\n",
                         '\n"${COMPOSE[@]}" "${BUILD_COMMAND[@]}" backend client',
                         "\nprepare_identity_infrastructure\n",
                         '\nif ! "${COMPOSE[@]}" up -d'):
            self.assertLess(validation, source.index(mutation))

    def test_identity_preflight_checks_the_same_rendered_config(self):
        source = (ROOT / "scripts/wotcv-identity-v2-preflight.sh").read_text(encoding="utf-8")
        ports = source.index('wotcv_validate_compose_ports "${compose_config}"')
        logging = source.index('wotcv_validate_compose_logging "${compose_config}"')
        self.assertLess(ports, logging)
        self.assertLess(logging, source.index('\necho "[2/7]'))

    def test_ci_checks_the_rendered_compose_config(self):
        source = (ROOT / ".github/workflows/build-wotcv-images.yml").read_text(encoding="utf-8")
        ports = source.index('wotcv_validate_compose_ports "${RUNNER_TEMP}/wotcv-compose.json"')
        logging = source.index('wotcv_validate_compose_logging "${RUNNER_TEMP}/wotcv-compose.json"')
        self.assertLess(ports, logging)
        self.assertLess(logging, source.index('python3 scripts/lib/wotcv_persistence.py validate-config'))


if __name__ == "__main__":
    unittest.main()
