"""Offline safety tests for the private closed-signup operator phase.

Only pure configuration validation and mocked execution are exercised. Real
Docker, subprocesses, SSH, migrations and native startup are forbidden.
"""

from copy import deepcopy
import importlib.util
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import test_wotcv_fresh_install as bootstrap_tests


SCRIPT = Path(__file__).resolve().parents[1] / "wotcv-close-private-signup.py"
SPEC = importlib.util.spec_from_file_location("wotcv_private_phase_under_test", SCRIPT)
phase = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(phase)
installer = bootstrap_tests.installer


def closed_fixture():
    config, credentials = bootstrap_tests.CredentialTests.credential_fixture()
    _unused, images = bootstrap_tests.fixture()
    images["client"] = config["services"]["client"]["image"] = phase.CLOSED_IMAGE
    config["services"]["backend"]["environment"].update({
        "DISABLE_SIGNUP": "true",
        "WOTCV_REPLAY_CORRELATION_JSON": json.dumps(phase.PROFILE),
    })
    config["services"]["client"]["environment"]["NEXT_PUBLIC_DISABLE_SIGNUP"] = "true"
    return config, images, credentials


class OfflineTestCase(unittest.TestCase):
    def setUp(self):
        for name in ("docker", "run"):
            guard = patch.object(installer, name, side_effect=AssertionError("Real commands forbidden in tests"))
            guard.start()
            self.addCleanup(guard.stop)


class ClosedConfigurationTests(OfflineTestCase):
    def test_accepts_closed_private_config_without_mutating_input(self):
        config, images, credentials = closed_fixture()
        original = deepcopy(config)
        phase.validate_closed(installer, config, images, credentials)
        self.assertEqual(config, original)

    def test_both_signup_flags_must_be_literal_true(self):
        for service, field in (("backend", "DISABLE_SIGNUP"), ("client", "NEXT_PUBLIC_DISABLE_SIGNUP")):
            for bad in ("false", "TRUE", True, "", None):
                with self.subTest(service=service, value=bad):
                    config, images, credentials = closed_fixture()
                    config["services"][service]["environment"][field] = bad
                    with self.assertRaises(installer.Refused):
                        phase.validate_closed(installer, config, images, credentials)

    def test_profile_targets_exact_numeric_new_site_and_known_api_origin(self):
        self.assertEqual(len(phase.PROFILE), 1)
        self.assertEqual(phase.PROFILE[0]["siteIds"], [1])
        self.assertIs(type(phase.PROFILE[0]["siteIds"][0]), int)
        self.assertEqual(phase.PROFILE[0]["requestOrigin"], "https://api.wot-cv.com")
        self.assertEqual(phase.PROFILE[0]["grafanaUrl"], "https://dashboard.wot-cv.com")
        for field, bad in (("siteIds", [2]), ("siteIds", ["776fb1633121"]),
                           ("siteIds", ["1"]), ("siteIds", [True]), ("orgId", True),
                           ("requestOrigin", {"origin": "https://api.wot-cv.com"}),
                           ("requestOrigin", "https://api.wot-cv.com/private")):
            with self.subTest(field=field, value=bad):
                config, images, credentials = closed_fixture()
                profile = deepcopy(phase.PROFILE)
                profile[0][field] = bad
                config["services"]["backend"]["environment"]["WOTCV_REPLAY_CORRELATION_JSON"] = json.dumps(profile)
                with self.assertRaises(installer.Refused):
                    phase.validate_closed(installer, config, images, credentials)

    def test_rejects_public_origins_or_nonprivate_application_ports(self):
        for service, field in (("backend", "BASE_URL"), ("backend", "SERVER_URL"),
                               ("client", "NEXT_PUBLIC_BACKEND_URL")):
            with self.subTest(service=service, field=field):
                config, images, credentials = closed_fixture()
                config["services"][service]["environment"][field] = installer.PUBLIC
                with self.assertRaises(installer.Refused):
                    phase.validate_closed(installer, config, images, credentials)
        for service in ("backend", "client"):
            for field, bad in (("host_ip", "0.0.0.0"), ("published", "3001"), ("target", 9999)):
                with self.subTest(service=service, field=field):
                    config, images, credentials = closed_fixture()
                    config["services"][service]["ports"][0][field] = bad
                    with self.assertRaises(installer.Refused):
                        phase.validate_closed(installer, config, images, credentials)

    def test_rejects_mutable_or_unapproved_application_images(self):
        for service in ("backend", "client"):
            for bad in ("rybbit:latest", "sha256:" + "f" * 64):
                with self.subTest(service=service, image=bad):
                    config, images, credentials = closed_fixture()
                    config["services"][service]["image"] = bad
                    with self.assertRaises(installer.Refused):
                        phase.validate_closed(installer, config, images, credentials)
            config, images, credentials = closed_fixture()
            images[service] = config["services"][service]["image"] = "rybbit:latest"
            with self.assertRaises(installer.Refused):
                phase.validate_closed(installer, config, images, credentials)

    def test_normalization_does_not_bypass_credential_validation(self):
        config, images, credentials = closed_fixture()
        config["services"]["backend"]["environment"]["BETTER_AUTH_SECRET"] = "f" * 64
        with self.assertRaises(installer.Refused):
            phase.validate_closed(installer, config, images, credentials)


class ExecutePreflightTests(OfflineTestCase):
    def tool_fixture(self):
        tool = SimpleNamespace(
            require=installer.require, Refused=installer.Refused, SOURCE=installer.SOURCE,
            check=Mock(), private_write=Mock(side_effect=AssertionError("Unexpected filesystem write")),
            docker=Mock(return_value=b""),
            json_docker=Mock(return_value=[{
                "Id": phase.CLOSED_IMAGE,
                "Config": {"Labels": {
                    "org.opencontainers.image.revision": installer.SOURCE,
                    "wotcv.fresh.kind": "client-private-closed",
                }},
            }]),
        )
        _config, images = bootstrap_tests.fixture()
        return tool, {"phase": "bootstrap", "images": images, "legacy": [{"Id": "old-unchanged"}]}

    def test_account_guard_failure_precedes_all_writes_image_inspection_and_compose(self):
        tool, state = self.tool_fixture()
        original = deepcopy(state)
        with tempfile.TemporaryDirectory() as temp, patch.object(phase, "ROOT", Path(temp)), \
                patch.object(phase, "snapshot", return_value={}), patch.object(phase, "check_live"), \
                patch.object(phase, "account_guard", side_effect=installer.Refused("Unexpected account state")), \
                patch.object(phase, "compose") as compose:
            with self.assertRaisesRegex(installer.Refused, "Unexpected account state"):
                phase.execute(tool, state, True, phase.ACK)
            tool.check.assert_called_once()
            tool.private_write.assert_not_called()
            tool.json_docker.assert_not_called()
            tool.docker.assert_not_called()
            compose.assert_not_called()
            self.assertEqual(list(Path(temp).iterdir()), [])
        self.assertEqual(state, original)

    def test_check_only_leaves_state_files_and_services_unchanged(self):
        tool, state = self.tool_fixture()
        original = deepcopy(state)
        with tempfile.TemporaryDirectory() as temp, patch.object(phase, "ROOT", Path(temp)), \
                patch.object(phase, "snapshot", return_value={}), patch.object(phase, "check_live"), \
                patch.object(phase, "account_guard", return_value="1|1|1|1|1|1"), \
                patch.object(phase, "compose") as compose, patch("sys.stdout", new_callable=io.StringIO):
            phase.execute(tool, state, False, None)
            tool.private_write.assert_not_called()
            compose.assert_not_called()
            tool.docker.assert_called_once()
            # The only command here is a mocked pure parser in the existing backend,
            # never run/start/up/restart or its native entrypoint.
            self.assertEqual(tool.docker.call_args.args[:4],
                             ("exec", "rybbit-wotcv-native-backend-1", "node", "--input-type=module"))
            self.assertEqual(list(Path(temp).iterdir()), [])
        self.assertEqual(state, original)

    def test_wrong_closed_image_identity_revision_or_kind_cannot_reach_writes(self):
        for field, bad in (("Id", "sha256:" + "f" * 64),
                           ("org.opencontainers.image.revision", "old-source"),
                           ("wotcv.fresh.kind", "client-production")):
            with self.subTest(field=field):
                tool, state = self.tool_fixture()
                image = tool.json_docker.return_value[0]
                if field == "Id":
                    image[field] = bad
                else:
                    image["Config"]["Labels"][field] = bad
                with tempfile.TemporaryDirectory() as temp, patch.object(phase, "ROOT", Path(temp)), \
                        patch.object(phase, "snapshot", return_value={}), patch.object(phase, "check_live"), \
                        patch.object(phase, "account_guard", return_value="1|1|1|1|1|1"), \
                        patch.object(phase, "compose") as compose:
                    with self.assertRaises(installer.Refused):
                        phase.execute(tool, state, True, phase.ACK)
                    tool.private_write.assert_not_called()
                    tool.docker.assert_not_called()
                    compose.assert_not_called()

    def test_account_guard_requires_exact_single_owner_admin_site_and_enabled_features(self):
        for output in (b"1|1|1|1|1|1\n", b"2|1|1|1|1|1", b"1|1|1|1|1|0", b"", b"1|1|1|1|0|1"):
            with self.subTest(output=output):
                tool, _state = self.tool_fixture()
                tool.docker.return_value = output
                if output == b"1|1|1|1|1|1\n":
                    self.assertEqual(phase.account_guard(tool), "1|1|1|1|1|1")
                else:
                    with self.assertRaises(installer.Refused):
                        phase.account_guard(tool)


if __name__ == "__main__":
    unittest.main()
