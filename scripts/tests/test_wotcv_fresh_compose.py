"""Read-only regression checks for the fresh Compose overlay (requires PyYAML).

Run: python -m unittest discover -s scripts/tests -p test_wotcv_fresh_compose.py
No images are built, services started, or migrations executed by these tests.
The final effective model must additionally be checked with the target Compose CLI.
"""

from pathlib import Path
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[2]
OVERLAY = ROOT / "ops" / "minimal" / "compose.fresh.yml"


class ComposeLoader(yaml.SafeLoader):
    """Parse Compose tags while recording their merge intent separately."""


def compose_tag(loader, node):
    if isinstance(node, yaml.MappingNode):
        value = loader.construct_mapping(node, deep=True)
    elif isinstance(node, yaml.SequenceNode):
        value = loader.construct_sequence(node, deep=True)
    else:
        value = loader.construct_scalar(node)
    return {"__compose_tag__": node.tag, "value": value}


ComposeLoader.add_constructor("!reset", compose_tag)
ComposeLoader.add_constructor("!override", compose_tag)


def value(node):
    return node["value"] if isinstance(node, dict) and "__compose_tag__" in node else node


class FreshComposeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.overlay = yaml.load(OVERLAY.read_text(encoding="utf-8"), Loader=ComposeLoader)
        cls.base = yaml.safe_load((ROOT / "docker-compose.yml").read_text(encoding="utf-8"))
        cls.services = cls.overlay["services"]

    def assert_tag(self, node, tag):
        self.assertEqual(node["__compose_tag__"], tag)

    def test_exact_project_and_services(self):
        self.assertEqual(self.overlay["name"], "rybbit-wotcv-native")
        self.assertEqual(set(self.services), {"backend", "client", "postgres", "clickhouse", "redis", "caddy"})

    def test_upstream_container_names_are_cleared(self):
        for service in self.services.values():
            self.assert_tag(service["container_name"], "!reset")

    def test_only_loopback_application_ports_are_published(self):
        for name, port in (("backend", "13001:3001"), ("client", "13002:3002")):
            self.assert_tag(self.services[name]["ports"], "!override")
            self.assertEqual(value(self.services[name]["ports"]), [f"127.0.0.1:{port}"])
        for name in ("postgres", "clickhouse", "redis", "caddy"):
            self.assert_tag(self.services[name]["ports"], "!reset")
            self.assertEqual(value(self.services[name]["ports"]), [])

    def test_local_images_are_required_and_compose_cannot_build_or_pull_them(self):
        for name, env in (
            ("backend", "WOTCV_BACKEND_IMAGE"),
            ("client", "WOTCV_CLIENT_IMAGE"),
            ("postgres", "WOTCV_POSTGRES_IMAGE"),
            ("clickhouse", "WOTCV_CLICKHOUSE_IMAGE"),
            ("redis", "WOTCV_REDIS_IMAGE"),
        ):
            service = self.services[name]
            self.assertTrue(service["image"].startswith("${" + env + ":?"))
            self.assertEqual(service["pull_policy"], "never")
        for name in ("backend", "client"):
            service = self.services[name]
            self.assert_tag(service["build"], "!reset")
        # Image-ID syntax is enforced by the installer against the resolved model,
        # not by Compose variable interpolation (which has no regex facility).

    def test_native_infrastructure_tag_sources_are_pinned_in_upstream(self):
        # The builder resolves these native tags once to local immutable .Id values.
        for name, image in (
            ("postgres", "postgres:17.4"),
            ("clickhouse", "clickhouse/clickhouse-server:26.3.62.3"),
            ("redis", "redis:8.6.4-alpine"),
        ):
            self.assertEqual(self.base["services"][name]["image"], image)

    def test_native_backend_entrypoint_is_preserved(self):
        for name in ("backend", "client"):
            for key in ("entrypoint", "command"):
                self.assertNotIn(key, self.services[name])
                self.assertNotIn(key, self.base["services"][name])
            self.assert_tag(self.services[name]["volumes"], "!reset")
            self.assertEqual(value(self.services[name]["volumes"]), [])

    def test_only_new_project_scoped_named_data_volumes(self):
        for name, source, target in (
            ("postgres", "postgres-data", "/var/lib/postgresql/data"),
            ("clickhouse", "clickhouse-data", "/var/lib/clickhouse"),
            ("redis", "redis-data", "/data"),
        ):
            self.assert_tag(self.services[name]["volumes"], "!override")
            self.assertEqual(value(self.services[name]["volumes"]), [f"{source}:{target}"])
            self.assertFalse(self.base["volumes"][source])
        self.assertNotIn("volumes", self.overlay)  # No external or explicit reused names.

    def test_log_rotation_is_identical_for_every_service(self):
        expected = {"driver": "json-file", "options": {"max-size": "50m", "max-file": "5"}}
        for name, service in self.services.items():
            with self.subTest(service=name):
                self.assertEqual(service["logging"], expected)

    def test_restart_policy_defaults_to_single_bootstrap_attempt(self):
        self.assertEqual(self.services["backend"]["restart"], "${WOTCV_BACKEND_RESTART:-no}")
        for name in ("client", "postgres", "clickhouse", "redis", "caddy"):
            self.assertEqual(self.services[name]["restart"], "unless-stopped")

    def test_backend_waits_for_all_three_database_healthchecks(self):
        depends_on = self.services["backend"]["depends_on"]
        self.assert_tag(depends_on, "!override")
        self.assertEqual(value(depends_on), {
            name: {"condition": "service_healthy"} for name in ("postgres", "clickhouse", "redis")
        })
        for name in ("postgres", "clickhouse", "redis"):
            self.assertTrue(self.base["services"][name]["healthcheck"]["test"])

    def test_runtime_origins_signup_and_self_hosting_are_explicit(self):
        backend = value(self.services["backend"]["environment"])
        client = value(self.services["client"]["environment"])
        for name in ("backend", "client"):
            self.assert_tag(self.services[name]["environment"], "!override")
        self.assertEqual(backend["CLOUD"], "false")
        self.assertEqual(backend["DISABLE_TELEMETRY"], "true")
        self.assertEqual(backend["CLUSTER_WORKERS"], "0")
        self.assertTrue(backend["BASE_URL"].startswith("${WOTCV_FRONTEND_URL:?"))
        self.assertTrue(backend["SERVER_URL"].startswith("${WOTCV_API_URL:?"))
        self.assertEqual(client["NEXT_PUBLIC_BACKEND_URL"], backend["SERVER_URL"])
        self.assertEqual(client["NEXT_PUBLIC_DISABLE_SIGNUP"], backend["DISABLE_SIGNUP"])
        self.assertTrue(backend["DISABLE_SIGNUP"].startswith("${DISABLE_SIGNUP:?"))
        self.assertEqual(client["NEXT_PUBLIC_CLOUD"], "false")

    def test_optional_features_are_explicitly_off_for_bootstrap(self):
        backend = value(self.services["backend"]["environment"])
        for key in ("RESEND_API_KEY", "EMAIL_FROM", "EMAIL_REPLY_TO", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI", "OPENROUTER_API_KEY", "OPENROUTER_MODEL"):
            self.assertEqual(backend[key], "")
        self.assertEqual(backend["MAPBOX_TOKEN"], "${MAPBOX_TOKEN:-}")
        self.assertEqual(backend["WOTCV_REPLAY_CORRELATION_JSON"], "${WOTCV_REPLAY_CORRELATION_JSON:-[]}")
        self.assertTrue(backend["SOURCE_CODE_URL"].startswith("${SOURCE_CODE_URL:?"))

    def test_caddy_is_disabled_and_cannot_inherit_bind_mounts(self):
        caddy = self.services["caddy"]
        self.assert_tag(caddy["profiles"], "!override")
        self.assertEqual(value(caddy["profiles"]), ["unused-fresh-webserver"])
        self.assert_tag(caddy["volumes"], "!reset")
        self.assertEqual(value(caddy["volumes"]), [])


if __name__ == "__main__":
    unittest.main()
