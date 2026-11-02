"""Standard-library, offline installer safety regression tests.

Run: python -m unittest discover -s scripts/tests -p test_wotcv_fresh_install.py
Every subprocess/Docker entry point is blocked; initialization is mocked only.
"""

from copy import deepcopy
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "wotcv-fresh-install.py"
SPEC = importlib.util.spec_from_file_location("wotcv_fresh_install_under_test", SCRIPT)
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


def fixture():
    """Representative docker compose config --format json, without credentials."""
    images = {name: "sha256:" + f"{index:064x}" for index, name in enumerate(installer.SERVICES, 1)}
    config = {
        "name": installer.PROJECT,
        "services": {},
        "volumes": {},
        "networks": {"default": {"name": installer.PROJECT + "_default"}},
    }
    for name in installer.SERVICES:
        service = {
            "image": images[name],
            "pull_policy": "never",
            "networks": {"default": None},
            "restart": "no" if name == "backend" else "unless-stopped",
            "logging": {"driver": "json-file", "options": {"max-size": "50m", "max-file": "5"}},
        }
        if name in installer.VOLUMES:
            key, target = installer.VOLUMES[name]
            service["volumes"] = [{"type": "volume", "source": key, "target": target,
                                    "volume": {}}]
            service["healthcheck"] = {"test": ["CMD", "native-healthcheck"], "interval": 3000000000}
            config["volumes"][key] = {"name": installer.PROJECT + "_" + key}
        else:
            published, target = (13001, 3001) if name == "backend" else (13002, 3002)
            service["ports"] = [{"mode": "ingress", "host_ip": "127.0.0.1", "target": target,
                                 "published": str(published), "protocol": "tcp"}]
        config["services"][name] = service
    config["services"]["backend"].update({
        "depends_on": {name: {"condition": "service_healthy", "required": True}
                       for name in installer.VOLUMES},
        "environment": {
            "BASE_URL": "http://127.0.0.1:13002", "SERVER_URL": "http://127.0.0.1:13001",
            "DISABLE_SIGNUP": "false", "CLOUD": "false", "DISABLE_TELEMETRY": "true",
            "CLUSTER_WORKERS": "0", "RESEND_API_KEY": "", "GOOGLE_CLIENT_ID": "",
            "GOOGLE_CLIENT_SECRET": "", "OPENROUTER_API_KEY": "",
        },
    })
    config["services"]["client"]["environment"] = {
        "NEXT_PUBLIC_BACKEND_URL": "http://127.0.0.1:13001", "NEXT_PUBLIC_DISABLE_SIGNUP": "false",
        "NEXT_PUBLIC_CLOUD": "false",
    }
    config["services"]["redis"]["command"] = [
        "redis-server", "--requirepass", "synthetic-redis-password", "--appendonly", "yes",
        "--appendfsync", "everysec", "--maxmemory-policy", "noeviction",
    ]
    return config, images


def archive_bytes(name, kind=tarfile.REGTYPE, linkname=""):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w") as archive:
        info = tarfile.TarInfo(name)
        info.type = kind
        info.linkname = linkname
        contents = b"offline fixture"
        if kind == tarfile.REGTYPE:
            info.size = len(contents)
            archive.addfile(info, io.BytesIO(contents))
        else:
            archive.addfile(info)
    return stream.getvalue()


class OfflineTestCase(unittest.TestCase):
    def setUp(self):
        # Hard guard: test mistakes cannot invoke Docker or any subprocess.
        for name in ("docker", "run"):
            guard = patch.object(installer, name, side_effect=AssertionError("Real commands forbidden in tests"))
            guard.start()
            self.addCleanup(guard.stop)


class ValidateModelTests(OfflineTestCase):
    def test_accepts_exact_five_isolated_native_services(self):
        config, images = fixture()
        installer.validate_model(config, images)

    def test_disabled_caddy_does_not_count_as_active(self):
        config, images = fixture()
        config["services"]["caddy"] = {"profiles": ["unused-fresh-webserver"]}
        installer.validate_model(config, images)

    def test_rejects_missing_or_additional_active_services(self):
        for missing in (False, True):
            with self.subTest(missing=missing):
                config, images = fixture()
                if missing:
                    del config["services"]["client"]
                else:
                    config["services"]["caddy"] = {}
                with self.assertRaises(installer.Refused):
                    installer.validate_model(config, images)

    def test_rejects_wrong_project(self):
        config, images = fixture()
        config["name"] = "rybbit"
        with self.assertRaises(installer.Refused):
            installer.validate_model(config, images)

    def test_rejects_mutable_or_mismatched_images(self):
        for image in ("postgres:17.4", "sha256:" + "a" * 63, "sha256:" + "G" * 64,
                      "sha256:" + "a" * 64):
            with self.subTest(image=image):
                config, images = fixture()
                config["services"]["postgres"]["image"] = image
                with self.assertRaises(installer.Refused):
                    installer.validate_model(config, images)
        config, images = fixture()
        images["postgres"] = config["services"]["postgres"]["image"] = "postgres:17.4"
        with self.assertRaises(installer.Refused):
            installer.validate_model(config, images)

    def test_rejects_wrong_app_port_target_host_protocol_or_merged_ports(self):
        for name in ("backend", "client"):
            for field, bad in (("target", 9999), ("published", "3001"), ("host_ip", "0.0.0.0"),
                               ("protocol", "udp"), ("extra", None)):
                with self.subTest(service=name, field=field):
                    config, images = fixture()
                    ports = config["services"][name]["ports"]
                    if field == "extra":
                        ports.append(deepcopy(ports[0]))
                    else:
                        ports[0][field] = bad
                    with self.assertRaises(installer.Refused):
                        installer.validate_model(config, images)

    def test_rejects_shared_external_bind_or_wrong_database_mount(self):
        for name, (key, _) in installer.VOLUMES.items():
            for mutation in ("external", "physical-name", "driver-opts", "bind", "target", "source", "port"):
                with self.subTest(service=name, mutation=mutation):
                    config, images = fixture()
                    service = config["services"][name]
                    if mutation == "external":
                        config["volumes"][key]["external"] = True
                    elif mutation == "physical-name":
                        config["volumes"][key]["name"] = "rybbit_" + key
                    elif mutation == "driver-opts":
                        config["volumes"][key]["driver_opts"] = {"device": "/old/data"}
                    elif mutation == "port":
                        service["ports"] = [{"published": "5432", "target": 5432}]
                    else:
                        field = {"bind": "type", "target": "target", "source": "source"}[mutation]
                        service["volumes"][0][field] = "bind" if mutation == "bind" else "/old/data"
                    with self.assertRaises(installer.Refused):
                        installer.validate_model(config, images)

    def test_rejects_shared_or_external_network(self):
        for mutation in ("name", "external", "driver_opts", "service-network"):
            with self.subTest(mutation=mutation):
                config, images = fixture()
                if mutation == "service-network":
                    config["services"]["backend"]["networks"] = {"old-network": None}
                else:
                    config["networks"]["default"][mutation] = {
                        "name": "rybbit_default", "external": True, "driver_opts": {"bridge": "old"},
                    }[mutation]
                with self.assertRaises(installer.Refused):
                    installer.validate_model(config, images)

    def test_rejects_unhealthy_database_dependency(self):
        for name in installer.VOLUMES:
            with self.subTest(service=name):
                config, images = fixture()
                config["services"]["backend"]["depends_on"][name]["condition"] = "service_started"
                with self.assertRaises(installer.Refused):
                    installer.validate_model(config, images)

    def test_rejects_wrong_logging_for_every_service(self):
        for name in installer.SERVICES:
            with self.subTest(service=name):
                config, images = fixture()
                config["services"][name]["logging"]["options"]["max-size"] = "100m"
                with self.assertRaises(installer.Refused):
                    installer.validate_model(config, images)

    def test_rejects_wrong_backend_env_or_bootstrap_restart(self):
        for key, bad in (("BASE_URL", installer.PUBLIC), ("SERVER_URL", installer.PUBLIC),
                         ("DISABLE_SIGNUP", "true"), ("CLOUD", "true"), ("DISABLE_TELEMETRY", "false"),
                         ("RESEND_API_KEY", "not-a-real-secret"), ("GOOGLE_CLIENT_ID", "client"),
                         ("GOOGLE_CLIENT_SECRET", "not-a-real-secret"), ("OPENROUTER_API_KEY", "key")):
            with self.subTest(key=key):
                config, images = fixture()
                config["services"]["backend"]["environment"][key] = bad
                with self.assertRaises(installer.Refused):
                    installer.validate_model(config, images)
        config, images = fixture()
        config["services"]["backend"]["restart"] = "unless-stopped"
        with self.assertRaises(installer.Refused):
            installer.validate_model(config, images)

    def test_rejects_wrong_client_env_or_worker_count(self):
        for service, key, bad in (("client", "NEXT_PUBLIC_BACKEND_URL", installer.PUBLIC),
                                  ("client", "NEXT_PUBLIC_DISABLE_SIGNUP", "true"),
                                  ("client", "NEXT_PUBLIC_CLOUD", "true"),
                                  ("backend", "CLUSTER_WORKERS", "4")):
            with self.subTest(service=service, key=key):
                config, images = fixture()
                config["services"][service]["environment"][key] = bad
                with self.assertRaises(installer.Refused):
                    installer.validate_model(config, images)

    def test_rejects_nonpersistent_infrastructure_restart(self):
        for name in ("postgres", "clickhouse", "redis", "client"):
            with self.subTest(service=name):
                config, images = fixture()
                config["services"][name]["restart"] = "no"
                with self.assertRaises(installer.Refused):
                    installer.validate_model(config, images)

    def test_rejects_pull_policy_drift_for_all_five_services(self):
        for name in installer.SERVICES:
            for policy in (None, "always", "missing", "build"):
                with self.subTest(service=name, policy=policy):
                    config, images = fixture()
                    config["services"][name]["pull_policy"] = policy
                    with self.assertRaises(installer.Refused):
                        installer.validate_model(config, images)

    def test_rejects_entrypoints_on_every_service_and_nonnative_commands(self):
        for name in installer.SERVICES:
            with self.subTest(service=name, field="entrypoint"):
                config, images = fixture()
                config["services"][name]["entrypoint"] = ["/bin/sh", "-c", "echo altered"]
                with self.assertRaises(installer.Refused):
                    installer.validate_model(config, images)
            if name != "redis":
                with self.subTest(service=name, field="command"):
                    config, images = fixture()
                    config["services"][name]["command"] = ["echo", "altered"]
                    with self.assertRaises(installer.Refused):
                        installer.validate_model(config, images)
        config, images = fixture()
        installer.validate_model(config, images)  # Native Redis command is expected.

    def test_rejects_additional_privileges_mounts_hosts_and_hooks(self):
        unsafe = {
            "cap_add": ["SYS_ADMIN"], "devices": ["/dev/sda:/dev/sda"],
            "device_cgroup_rules": ["a *:* rwm"], "secrets": [{"source": "old-secret"}],
            "env_file": [{"path": "/old/.env", "required": True}],
            "extra_hosts": ["old-db:host-gateway"], "security_opt": ["seccomp:unconfined"],
            "userns_mode": "host", "develop": {"watch": []},
            "post_start": [{"command": "echo altered"}], "pre_stop": [{"command": "echo altered"}],
        }
        for name in installer.SERVICES:
            for field, bad in unsafe.items():
                with self.subTest(service=name, field=field):
                    config, images = fixture()
                    config["services"][name][field] = bad
                    with self.assertRaises(installer.Refused):
                        installer.validate_model(config, images)


class EnvironmentAndArchiveTests(OfflineTestCase):
    def test_environment_excludes_ambient_secrets_compose_docker_git_and_shell_injection(self):
        safe = {"PATH": "/usr/bin", "HOME": "/home/wotcv", "USER": "wotcv", "LANG": "C.UTF-8",
                "SSH_AUTH_SOCK": "/run/synthetic-agent.sock"}
        unsafe = {
            key: "synthetic-ambient-value" for key in (
                "POSTGRES_PASSWORD", "CLICKHOUSE_PASSWORD", "CLICKHOUSE_QUERY_PASSWORD", "REDIS_PASSWORD",
                "BETTER_AUTH_SECRET", "WOTCV_BACKEND_IMAGE", "WOTCV_CLIENT_IMAGE", "WOTCV_POSTGRES_IMAGE",
                "WOTCV_CLICKHOUSE_IMAGE", "WOTCV_REDIS_IMAGE", "WOTCV_FRONTEND_URL", "BASE_URL", "DISABLE_SIGNUP",
                "COMPOSE_PROJECT_NAME", "COMPOSE_FILE", "COMPOSE_PROFILES", "DOCKER_HOST", "DOCKER_CONTEXT",
                "DOCKER_CONFIG", "GIT_CONFIG_COUNT", "GIT_SSH_COMMAND", "GIT_DIR", "GIT_WORK_TREE",
                "BASH_ENV", "ENV", "SHELLOPTS", "BASH_FUNC_docker%%", "LD_PRELOAD", "LD_LIBRARY_PATH",
                "PYTHONPATH", "NODE_OPTIONS", "npm_config_script_shell", "IFS", "CDPATH",
            )
        }
        with patch.dict(installer.os.environ, {**safe, **unsafe}, clear=True):
            self.assertEqual(installer.environment(), safe)

    def test_env_text_sorts_and_single_quotes_safe_values(self):
        self.assertEqual(installer.env_text({"Z": 'a"b # =', "A": ""}), 'A=\'\'\nZ=\'a"b # =\'\n')

    def test_env_text_rejects_newlines_dollars_single_quotes_backslash_and_nul(self):
        for value in ("a\nb", "a\rb", "a\0b", "$EXPAND", "${EXPAND}", "a'b", "a\\b", 42):
            with self.subTest(value=repr(value)):
                with self.assertRaises(installer.Refused):
                    installer.env_text({"SAFE": value})
        for key in ("lower", "A=B", "A\nB", "", "A-B"):
            with self.subTest(key=repr(key)):
                with self.assertRaises(installer.Refused):
                    installer.env_text({key: "safe"})

    def test_safe_archive_extracts_only_regular_fixture(self):
        with tempfile.TemporaryDirectory() as temp:
            installer.safe_archive(archive_bytes("nested/safe.txt"), Path(temp))
            self.assertEqual((Path(temp) / "nested/safe.txt").read_bytes(), b"offline fixture")

    def test_safe_archive_rejects_traversal_absolute_symlinks_and_hardlinks(self):
        for name, kind, link in (("../outside", tarfile.REGTYPE, ""),
                                 ("nested/../../outside", tarfile.REGTYPE, ""),
                                 ("/absolute", tarfile.REGTYPE, ""),
                                 ("..\\outside", tarfile.REGTYPE, ""),
                                 ("link", tarfile.SYMTYPE, "../../outside"),
                                 ("hardlink", tarfile.LNKTYPE, "safe.txt")):
            with self.subTest(name=name, kind=kind):
                with tempfile.TemporaryDirectory() as temp:
                    with self.assertRaises(installer.Refused):
                        installer.safe_archive(archive_bytes(name, kind, link), Path(temp))
                    self.assertEqual(list(Path(temp).iterdir()), [])


class CredentialTests(OfflineTestCase):
    @staticmethod
    def credential_fixture():
        config, _images = fixture()
        fresh = {key: f"{index:064x}" for index, key in enumerate((
            "BETTER_AUTH_SECRET", "POSTGRES_PASSWORD", "CLICKHOUSE_PASSWORD",
            "CLICKHOUSE_QUERY_PASSWORD", "REDIS_PASSWORD",
        ), 100)}
        config["services"]["backend"]["environment"].update(fresh)
        config["services"]["postgres"]["environment"] = {"POSTGRES_PASSWORD": fresh["POSTGRES_PASSWORD"]}
        config["services"]["clickhouse"]["environment"] = {"CLICKHOUSE_PASSWORD": fresh["CLICKHOUSE_PASSWORD"]}
        config["services"]["redis"]["command"][2] = fresh["REDIS_PASSWORD"]
        return config, fresh

    def test_accepts_generated_credentials_shared_only_with_their_own_services(self):
        config, fresh = self.credential_fixture()
        installer.validate_credentials(config, fresh)

    def test_rejects_any_backend_secret_or_query_password_drift(self):
        _config, keys = self.credential_fixture()
        for key in keys:
            with self.subTest(key=key):
                config, fresh = self.credential_fixture()
                config["services"]["backend"]["environment"][key] = "f" * 64
                with self.assertRaises(installer.Refused):
                    installer.validate_credentials(config, fresh)

    def test_rejects_database_password_drift(self):
        for name, key in (("postgres", "POSTGRES_PASSWORD"), ("clickhouse", "CLICKHOUSE_PASSWORD")):
            with self.subTest(service=name):
                config, fresh = self.credential_fixture()
                config["services"][name]["environment"][key] = "f" * 64
                with self.assertRaises(installer.Refused):
                    installer.validate_credentials(config, fresh)

    def test_rejects_invalid_generated_secret_format(self):
        for bad in (None, "", "short", "g" * 64, "a" * 63, "A" * 64):
            with self.subTest(value=bad):
                config, fresh = self.credential_fixture()
                fresh["BETTER_AUTH_SECRET"] = bad
                config["services"]["backend"]["environment"]["BETTER_AUTH_SECRET"] = bad
                with self.assertRaises(installer.Refused):
                    installer.validate_credentials(config, fresh)

    def test_rejects_redis_credential_drift_missing_or_duplicate_password_flag(self):
        for command in ([], "redis-server", ["redis-server", "--requirepass", "old-password"],
                        ["redis-server", "--requirepass"],
                        ["redis-server", "--requirepass", "old", "--requirepass", "old"]):
            with self.subTest(command=command):
                config, fresh = self.credential_fixture()
                config["services"]["redis"]["command"] = command
                with self.assertRaises(installer.Refused):
                    installer.validate_credentials(config, fresh)


class OperatorStartTests(OfflineTestCase):
    def test_failed_build_persists_building_before_docker_and_cannot_retry_prepared(self):
        state = {"phase": "prepared", "legacy": []}
        persisted = []

        def persist(_root, value):
            persisted.append(deepcopy(value))

        def fail_build(*_args, **_kwargs):
            self.assertEqual(state["phase"], "building")
            self.assertTrue(persisted)
            self.assertEqual(persisted[-1]["phase"], "building")
            raise installer.Refused("synthetic build failure")

        with tempfile.TemporaryDirectory() as temp, \
                patch.object(installer, "legacy_snapshot", return_value=[]), \
                patch.object(installer, "empty_target"), \
                patch.object(installer, "write_state", side_effect=persist), \
                patch.object(installer, "docker", side_effect=fail_build) as docker:
            with self.assertRaises(installer.Refused):
                installer.build(Path(temp), state)
            self.assertEqual(state["phase"], "building")
            docker.assert_called_once()
            docker.reset_mock()
            with self.assertRaises(installer.Refused):
                installer.build(Path(temp), state)
            docker.assert_not_called()

    def test_nonroot_cannot_reach_checks_or_compose(self):
        with patch.object(installer.os, "geteuid", return_value=1000, create=True), \
                patch.object(installer, "check") as check, patch.object(installer, "compose") as compose:
            with self.assertRaises(installer.Refused):
                installer.start(Path("unused"), {"phase": "built"}, installer.ACK)
            check.assert_not_called()
            compose.assert_not_called()

    def test_missing_ack_cannot_reach_checks_or_compose(self):
        with patch.object(installer.os, "geteuid", return_value=0, create=True), \
                patch.object(installer, "check") as check, patch.object(installer, "compose") as compose:
            for ack in (None, "", "yes"):
                with self.subTest(ack=ack), self.assertRaises(installer.Refused):
                    installer.start(Path("unused"), {"phase": "built"}, ack)
            check.assert_not_called()
            compose.assert_not_called()

    def test_failed_initialization_persists_starting_and_cannot_retry_as_built(self):
        state = {"phase": "built"}
        with patch.object(installer.os, "geteuid", return_value=0, create=True), \
                patch.object(installer, "check") as check, patch.object(installer, "empty_target"), \
                patch.object(installer, "write_state") as write_state, \
                patch.object(installer, "compose", side_effect=installer.Refused("mock initialization failure")) as compose:
            with self.assertRaises(installer.Refused):
                installer.start(Path("unused"), state, installer.ACK)
            self.assertEqual(state["phase"], "starting")
            write_state.assert_called_once()
            compose.assert_called_once()
            check.reset_mock()
            compose.reset_mock()
            with self.assertRaises(installer.Refused):
                installer.start(Path("unused"), state, installer.ACK)
            check.assert_not_called()
            compose.assert_not_called()

    def test_failed_phase_cannot_be_rebuilt_or_initialized(self):
        with patch.object(installer.os, "geteuid", return_value=0, create=True), \
                patch.object(installer, "check") as check, patch.object(installer, "compose") as compose:
            for phase in ("starting", "bootstrap", "failed"):
                with self.subTest(phase=phase):
                    with self.assertRaises(installer.Refused):
                        installer.build(Path("unused"), {"phase": phase})
                    with self.assertRaises(installer.Refused):
                        installer.start(Path("unused"), {"phase": phase}, installer.ACK)
            check.assert_not_called()
            compose.assert_not_called()


if __name__ == "__main__":
    unittest.main()
