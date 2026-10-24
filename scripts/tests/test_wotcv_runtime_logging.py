"""Hermetic runtime logging guard and narrowly scoped maintenance tests."""

import copy
from contextlib import nullcontext
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "lib"))
from wotcv_logging import (  # noqa: E402
    EXPECTED_RUNTIME_LOGGING, SERVICES, runtime_containers,
    runtime_logging_drift, validate_runtime_logging,
)
_SPEC = importlib.util.spec_from_file_location("wotcv_runtime_reconcile", ROOT / "scripts/wotcv-reconcile-runtime-logging.py")
REPAIR = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(REPAIR)


def runtime_records(services=SERVICES):
    return [{
        "Id": str(index + 1) * 64,
        "Name": "/" + name,
        "Image": "sha256:" + str(index + 1) * 64,
        "Config": {"Labels": {
            "com.docker.compose.project": "rybbit",
            "com.docker.compose.service": name,
            "com.docker.compose.oneoff": "False",
        }, "Env": ["PASSWORD=do-not-print-this"]},
        "State": {"Status": "running", "Running": True, "ExitCode": 0},
        "HostConfig": {"LogConfig": copy.deepcopy(EXPECTED_RUNTIME_LOGGING)},
    } for index, name in enumerate(services)]


class RuntimeLoggingTests(unittest.TestCase):
    def test_accepts_exact_runtime_and_does_not_mutate_records(self):
        records = runtime_records()
        before = copy.deepcopy(records)
        validate_runtime_logging(records)
        self.assertEqual(runtime_logging_drift(records), ())
        self.assertEqual(set(runtime_containers(records)), set(SERVICES))
        self.assertEqual(records, before)

    def test_empty_options_are_runtime_drift_despite_declared_settings(self):
        records = runtime_records()
        for record in records:
            if record["Name"] in ("/postgres", "/redis"):
                record["HostConfig"]["LogConfig"]["Config"] = {}
        self.assertEqual(runtime_logging_drift(records), ("postgres", "redis"))
        with self.assertRaisesRegex(ValueError, "postgres, redis"):
            validate_runtime_logging(records)

    def test_selected_infrastructure_can_be_checked_without_apps(self):
        selected = ("clickhouse", "postgres", "redis")
        validate_runtime_logging(runtime_records(selected), "rybbit", selected)

    def test_changed_missing_numeric_and_extra_actual_options_fail(self):
        invalid = [
            None, {}, {"Type": "journald", "Config": {}},
            {"Type": "json-file", "Config": {}},
            {"Type": "json-file", "Config": {"max-size": "100m", "max-file": "5"}},
            {"Type": "json-file", "Config": {"max-size": "50m", "max-file": 5}},
            {"Type": "json-file", "Config": {"max-size": "50m", "max-file": "5", "compress": "true"}},
        ]
        for actual in invalid:
            for name in SERVICES:
                with self.subTest(service=name, actual=actual):
                    records = runtime_records()
                    record = next(record for record in records if record["Name"] == "/" + name)
                    record["HostConfig"]["LogConfig"] = actual
                    with self.assertRaisesRegex(ValueError, name):
                        validate_runtime_logging(records)

    def test_rejects_missing_duplicate_stopped_foreign_or_unlabelled_containers(self):
        cases = []
        missing = runtime_records()[1:]
        cases.append(missing)
        cases.append(runtime_records() + runtime_records()[:1])
        for field, value in (("Status", "exited"), ("Running", False)):
            records = runtime_records()
            records[0]["State"][field] = value
            cases.append(records)
        for label, value in (
            ("com.docker.compose.project", "unrelated"),
            ("com.docker.compose.service", "caddy"),
            ("com.docker.compose.oneoff", "True"),
            ("com.docker.compose.oneoff", True),
        ):
            records = runtime_records()
            records[0]["Config"]["Labels"][label] = value
            cases.append(records)
        records = runtime_records()
        del records[0]["Config"]["Labels"]
        cases.append(records)
        records = runtime_records()
        records[1]["Id"] = records[0]["Id"]
        cases.append(records)
        for records in cases:
            with self.subTest(records=records):
                with self.assertRaises(ValueError):
                    validate_runtime_logging(records)

    def test_malformed_inspect_or_selection_fails_closed(self):
        for records in (None, {}, "", [], [None], [[]], ["invalid"]):
            with self.subTest(records=records):
                with self.assertRaises(ValueError):
                    validate_runtime_logging(records)
        for project, selected in (("", SERVICES), (None, SERVICES), ("rybbit", ()),
                                  ("rybbit", ("postgres", "postgres")), ("rybbit", ("caddy",))):
            with self.subTest(project=project, selected=selected):
                with self.assertRaises(ValueError):
                    validate_runtime_logging(runtime_records(), project, selected)

    def test_preflight_checks_all_live_services_before_identity_queries(self):
        source = (ROOT / "scripts/wotcv-identity-v2-preflight.sh").read_text(encoding="utf-8")
        guard = source.index('\nwotcv_validate_runtime_logging "${EXPECTED_COMPOSE_PROJECT_NAME}"')
        self.assertLess(source.index('\nfor service in postgres clickhouse redis backend client; do'), guard)
        self.assertLess(guard, source.index('\necho "[3/7]'))
        call = source[guard:source.index('\nwotcv_validate_container_persistence', guard)]
        for service in SERVICES:
            self.assertIn(f'ps -q {service})', call)


class RuntimeLoggingCliTests(unittest.TestCase):
    def invoke(self, records, *options):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "inspect.json"
            path.write_text(json.dumps(records), encoding="utf-8")
            return subprocess.run([
                sys.executable, str(ROOT / "scripts/lib/wotcv_logging.py"),
                "--runtime-json", str(path), *options,
            ], capture_output=True, text=True, timeout=15)

    def test_cli_accepts_inspect_json_and_service_selection(self):
        result = self.invoke(runtime_records(("postgres", "redis")), "--services", "postgres", "redis")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "Runtime logging validation passed.")

    def test_cli_failure_is_sanitized(self):
        records = runtime_records()
        records[1]["HostConfig"]["LogConfig"] = {"Type": "json-file", "Config": {}}
        result = self.invoke(records)
        self.assertEqual(result.returncode, 1)
        self.assertIn("Runtime log rotation drift: postgres", result.stderr)
        self.assertNotIn("do-not-print-this", result.stdout + result.stderr)
        self.assertNotIn("Traceback", result.stderr)


def fixture():
    config = {"name": "rybbit", "services": {}, "volumes": {},
              "networks": {"default": {"name": "rybbit_default"}}}
    records = {record["Name"][1:]: record for record in runtime_records()}
    for name, record in records.items():
        spec = next((spec for spec in REPAIR.SPECS if spec.service_name == name), None)
        service = {"image": name + ":fixed", "container_name": name,
                   "environment": {"TEST": "do-not-print-this"}, "restart": "unless-stopped",
                   "logging": {"driver": "json-file", "options": {"max-size": "50m", "max-file": "5"}},
                   "networks": {"default": None}}
        record["Config"].update({"Env": ["TEST=do-not-print-this"], "Cmd": [name], "Entrypoint": ["entrypoint"],
                                 "User": "", "WorkingDir": "", "Hostname": record["Id"][:12], "Image": name + ":fixed"})
        record["State"].update({"StartedAt": "2026-01-01T00:00:00Z", "FinishedAt": "0001-01-01T00:00:00Z"})
        record["RestartCount"] = 0
        record["HostConfig"].update({"PortBindings": {}, "NetworkMode": "rybbit_default",
                                   "RestartPolicy": {"Name": "unless-stopped", "MaximumRetryCount": 0}})
        record["Mounts"] = []
        record["NetworkSettings"] = {"Networks": {"rybbit_default": {
            "NetworkID": "network1", "Aliases": [name, name], "IPAMConfig": None, "IPAddress": "172.1.0.1"}}}
        if spec:
            config["volumes"][spec.logical_name] = {"name": spec.expected_name, "external": True}
            service["volumes"] = [{"type": "volume", "source": spec.logical_name, "target": spec.target}]
            record["Mounts"] = [{"Type": "volume", "Name": spec.expected_name,
                "Source": "/var/lib/docker/volumes/" + spec.expected_name + "/_data", "Destination": spec.target,
                "Driver": "local", "RW": True, "Mode": "rw", "Propagation": ""}]
        config["services"][name] = service
    config["services"]["redis"]["command"] = ["redis-server", "--requirepass", "do-not-print-this"]
    records["redis"]["Config"]["Cmd"] = config["services"]["redis"]["command"][:]
    for name in REPAIR.TARGETS:
        records[name]["HostConfig"]["LogConfig"]["Config"] = {}
    return config, records


class RepairReadOnlyTests(unittest.TestCase):
    def test_default_check_only_renders_and_inspects_and_reports_live_drift(self):
        config, records = fixture()
        calls = []

        def command(repo, args, **kwargs):
            calls.append(args)
            return json.dumps(config if "config" in args else list(records.values())).encode()

        with tempfile.TemporaryDirectory() as directory, patch.object(REPAIR, "command", side_effect=command), \
                patch.object(REPAIR, "lock_file", side_effect=AssertionError("check must not create locks")), \
                patch.object(REPAIR, "write_json", side_effect=AssertionError("check must not write files")):
            with self.assertRaisesRegex(REPAIR.Refused, "postgres, redis"):
                REPAIR.reconcile(Path(directory))
            self.assertEqual(len(calls), 2)
            self.assertIn("config", calls[0])
            self.assertEqual(calls[1], ["docker", "inspect", *SERVICES])
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_check_passes_correct_hostconfig_and_can_audit_stopped_backend(self):
        config, records = fixture()
        for record in records.values():
            record["HostConfig"]["LogConfig"] = copy.deepcopy(EXPECTED_RUNTIME_LOGGING)
        records["backend"]["State"].update({"Status": "exited", "Running": False})
        with tempfile.TemporaryDirectory() as directory, patch.object(REPAIR, "command", side_effect=lambda _, args, **kw:
                json.dumps(config if "config" in args else list(records.values())).encode()):
            self.assertIsNone(REPAIR.reconcile(Path(directory)))

    def test_no_root_apply_fails_before_any_docker_or_gate_action(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(REPAIR, "command") as docker, \
                patch.object(REPAIR, "require_gate") as gate:
            with patch.object(REPAIR.os, "geteuid", return_value=1000, create=True):
                with self.assertRaisesRegex(REPAIR.Refused, "requires Linux root"):
                    REPAIR.reconcile(Path(directory), apply=True)
            docker.assert_not_called()
            gate.assert_not_called()

    def test_rejects_live_port_or_volume_drift(self):
        for kind in ("ports", "mounts", "extra_mount"):
            config, records = fixture()
            if kind == "ports":
                records["redis"]["HostConfig"]["PortBindings"] = {"6379/tcp": [{"HostIp": "0.0.0.0", "HostPort": "6379"}]}
            elif kind == "mounts":
                records["postgres"]["Mounts"][0]["Name"] = "empty-new-volume"
            else:
                records["redis"]["Mounts"].append(copy.deepcopy(records["redis"]["Mounts"][0]))
            with self.subTest(kind=kind), self.assertRaises((ValueError, REPAIR.Refused)):
                REPAIR.validate_storage_and_ports(config, records)


class RepairDataAndPlanTests(unittest.TestCase):
    def images(self, records):
        return {name: {"Config": {key: copy.deepcopy(records[name]["Config"].get(key))
                                   for key in ("Env", "Cmd", "Entrypoint", "User", "WorkingDir")}}
                for name in REPAIR.TARGETS}

    def test_container_name_drift_or_missing_name_refuses_before_candidate(self):
        for name in REPAIR.TARGETS:
            for changed in (None, "other-container", "", "postgres-not-the-current-container"):
                config, records = fixture()
                if changed is None:
                    config["services"][name].pop("container_name")
                else:
                    config["services"][name]["container_name"] = changed
                with self.subTest(service=name, changed=changed), self.assertRaisesRegex(REPAIR.Refused, "container names"):
                    REPAIR.validate_storage_and_ports(config, records)
                with self.subTest(service=name, changed=changed), self.assertRaisesRegex(REPAIR.Refused, "container names"):
                    REPAIR.pinned_compose(config, records, rollback=False)

    def test_rendered_null_command_and_entrypoint_inherit_image_defaults(self):
        config, records = fixture()
        images = self.images(records)
        for name in REPAIR.TARGETS:
            config["services"][name].update(command=None, entrypoint=None)
            images[name]["Config"].pop("User")
            images[name]["Config"].pop("WorkingDir")
        REPAIR.require_matching_command_environment(config, records, images)
        for field in ("command", "entrypoint"):
            for empty in ([], ""):
                changed = copy.deepcopy(config)
                changed["services"]["postgres"][field] = empty
                with self.subTest(field=field, empty=empty), self.assertRaisesRegex(REPAIR.Refused, "entrypoint/command drift"):
                    REPAIR.require_matching_command_environment(changed, records, images)

    def test_nonnull_entrypoint_does_not_accidentally_inherit_image_command(self):
        config, records = fixture()
        images = self.images(records)
        config["services"]["postgres"].update(entrypoint=["custom-entrypoint"], command=None)
        records["postgres"]["Config"]["Entrypoint"] = ["custom-entrypoint"]
        with self.assertRaisesRegex(REPAIR.Refused, "entrypoint/command drift"):
            REPAIR.require_matching_command_environment(config, records, images)
        records["postgres"]["Config"]["Cmd"] = None
        REPAIR.require_matching_command_environment(config, records, images)
        for field, value in (("User", "different-user"), ("WorkingDir", "/different-directory")):
            changed = copy.deepcopy(records)
            changed["postgres"]["Config"][field] = value
            with self.subTest(field=field), self.assertRaisesRegex(REPAIR.Refused, "execution settings"):
                REPAIR.require_matching_command_environment(config, changed, images)

    def test_rejects_extra_declared_mount_and_every_unsupported_volume_option_before_candidate(self):
        for name in REPAIR.TARGETS:
            for kind in ("extra_bind", "read_only", "subpath", "nocopy", "bind", "consistency", "external_options", "live_nocopy"):
                config, records = fixture()
                mount = config["services"][name]["volumes"][0]
                if kind == "extra_bind":
                    config["services"][name]["volumes"].append({"type": "bind", "source": "/tmp", "target": "/extra"})
                elif kind == "read_only":
                    mount["read_only"] = True
                elif kind in ("subpath", "nocopy"):
                    mount["volume"] = {kind: "nested" if kind == "subpath" else True}
                elif kind == "bind":
                    mount["type"] = "bind"
                elif kind == "consistency":
                    mount["consistency"] = "cached"
                elif kind == "external_options":
                    config["volumes"][name + "-data"]["driver_opts"] = {"device": "/elsewhere"}
                elif kind == "live_nocopy":
                    records[name]["HostConfig"]["Mounts"] = [{"Type": "volume", "Source": "rybbit_" + name + "-data",
                        "Target": mount["target"], "VolumeOptions": {"NoCopy": True}}]
                with self.subTest(service=name, kind=kind), self.assertRaises(REPAIR.Refused):
                    REPAIR.pinned_compose(config, records, rollback=False)

    def test_healthcheck_compares_inherited_defaults_and_partial_declarations(self):
        config, records = fixture()
        images = self.images(records)
        inherited = {"Test": ["CMD", "healthcheck"], "Interval": 3_000_000_000, "Timeout": 5_000_000_000,
                     "Retries": 5, "StartPeriod": 10_000_000_000}
        images["postgres"]["Config"]["Healthcheck"] = copy.deepcopy(inherited)
        records["postgres"]["Config"]["Healthcheck"] = copy.deepcopy(inherited)
        REPAIR.require_matching_command_environment(config, records, images)
        config["services"]["postgres"]["healthcheck"] = {"timeout": "6s"}
        records["postgres"]["Config"]["Healthcheck"]["Timeout"] = 6_000_000_000
        REPAIR.require_matching_command_environment(config, records, images)
        for field in inherited:
            changed = copy.deepcopy(records)
            changed["postgres"]["Config"]["Healthcheck"][field] = ["NONE"] if field == "Test" else 7
            with self.subTest(field=field), self.assertRaisesRegex(REPAIR.Refused, "health-check drift"):
                REPAIR.require_matching_command_environment(config, changed, images)
        config["services"]["postgres"].pop("healthcheck")
        records["postgres"]["Config"].pop("Healthcheck")
        with self.assertRaisesRegex(REPAIR.Refused, "health-check drift"):
            REPAIR.require_matching_command_environment(config, records, images)

    def test_network_options_aliases_and_custom_hostnames_refuse_before_up(self):
        for kind in ("network_driver_opts", "network_ipam", "service_alias", "live_alias", "live_links", "live_driver_opts",
                     "live_static_ip", "live_network_mode", "custom_hostname"):
            config, records = fixture()
            images = self.images(records)
            network = records["postgres"]["NetworkSettings"]["Networks"]["rybbit_default"]
            if kind == "network_driver_opts":
                config["networks"]["default"]["driver_opts"] = {"test": "changed"}
            elif kind == "network_ipam":
                config["networks"]["default"]["ipam"] = {"config": [{"subnet": "192.0.2.0/24"}]}
            elif kind == "service_alias":
                config["services"]["postgres"]["networks"]["default"] = {"aliases": ["other"]}
            elif kind == "live_alias":
                network["Aliases"].append("other")
            elif kind == "live_links":
                network["Links"] = ["other:other"]
            elif kind == "live_driver_opts":
                network["DriverOpts"] = {"test": "changed"}
            elif kind == "live_static_ip":
                network["IPAMConfig"] = {"IPv4Address": "192.0.2.4"}
            elif kind == "live_network_mode":
                records["postgres"]["HostConfig"]["NetworkMode"] = "host"
            else:
                records["postgres"]["Config"]["Hostname"] = "custom-db-host"
            with self.subTest(kind=kind), self.assertRaises(REPAIR.Refused):
                REPAIR.require_matching_command_environment(config, records, images)

    def test_default_empty_ipam_export_is_benign_without_changing_canonical_candidate(self):
        for value in ("absent", None, {}):
            config, records = fixture()
            if value != "absent":
                config["networks"]["default"]["ipam"] = value
            before = copy.deepcopy(config)
            with self.subTest(value=value):
                REPAIR.require_matching_command_environment(config, records, self.images(records))
                self.assertEqual(config, before)
                self.assertEqual(REPAIR.pinned_compose(config, records, rollback=False)["networks"], before["networks"])
        for value in ({"config": [{"subnet": "192.0.2.0/24"}]}, {"driver": "default"}, [], False, ""):
            config, records = fixture()
            config["networks"]["default"]["ipam"] = value
            with self.subTest(value=value), self.assertRaises(REPAIR.Refused):
                REPAIR.require_matching_command_environment(config, records, self.images(records))

    def test_non_compose_labels_are_checked_pre_up_and_preserved_in_post_comparison(self):
        config, records = fixture()
        images = self.images(records)
        records["postgres"]["Config"]["Labels"]["custom.label"] = "keep-me"
        with self.assertRaisesRegex(REPAIR.Refused, "label drift"):
            REPAIR.require_matching_command_environment(config, records, images)
        config["services"]["postgres"]["labels"] = {"custom.label": "keep-me"}
        REPAIR.require_matching_command_environment(config, records, images)
        self.assertEqual(REPAIR.pinned_compose(config, records, rollback=False)["services"]["postgres"]["labels"], {"custom.label": "keep-me"})
        changed = copy.deepcopy(records["postgres"])
        changed["Config"]["Labels"].pop("custom.label")
        self.assertNotEqual(REPAIR.preserved_config(records["postgres"]), REPAIR.preserved_config(changed))
        changed = copy.deepcopy(records["postgres"])
        changed["Config"]["Labels"]["com.docker.compose.config-hash"] = "generated-change"
        self.assertEqual(REPAIR.preserved_config(records["postgres"]), REPAIR.preserved_config(changed))
        images["postgres"]["Config"]["Labels"] = {"inherited.image.label": "same"}
        records["postgres"]["Config"]["Labels"]["inherited.image.label"] = "same"
        REPAIR.require_matching_command_environment(config, records, images)

    def test_compose_artifacts_escape_literal_dollars_without_changing_dictionary_keys(self):
        original = {"PASSWORD": "one$two${THREE}$$", "command": ["redis-server", "$literal"],
                    "volumes": [{"source": "same", "read_only": True}], "$mapping_key": None}
        encoded = REPAIR.compose_literals(original)
        self.assertEqual(encoded["PASSWORD"], "one$$two$${THREE}$$$$")
        self.assertEqual(encoded["command"][1], "$$literal")
        self.assertIn("$mapping_key", encoded)
        self.assertEqual(encoded["volumes"], original["volumes"])
        self.assertEqual(original["PASSWORD"], "one$two${THREE}$$")

    def test_compose_export_decoder_restores_keys_and_values_once_without_losing_real_double_dollars(self):
        literals = {"$key": "runtime$", "$$key": "runtime$$", "healthcheck": {"test": ["CMD-SHELL", 'echo "$VAR" $$$$']},
                    "command": ["redis-server", "--requirepass", "one$two$$three${FOUR}"], "entrypoint": None}
        # The CLI escapes FINAL serialized bytes, not just JSON string values.
        raw_export = json.dumps(literals).encode().replace(b"$", b"$$")
        decoded = REPAIR.decode_compose_export(raw_export)
        self.assertEqual(decoded, literals)
        self.assertEqual(set(decoded) & {"$key", "$$key"}, {"$key", "$$key"})
        self.assertEqual(decoded["$$key"], "runtime$$")
        self.assertNotEqual(decoded["command"][2], decoded["command"][2].replace("$$", "$"))
        for raw in (b'{"value":"$"}', b'{"value":"$$$"}', b'{"value":"$$$$$"}',
                    b'{"$key":"safe"}', {"already_decoded": "runtime$$"}):
            with self.subTest(raw=raw), self.assertRaisesRegex(REPAIR.Refused, "export dollar encoding"):
                REPAIR.decode_compose_export(raw)

    def test_decoded_health_environment_and_arguments_match_literal_inspect_without_decoding_it(self):
        config, records = fixture()
        images = self.images(records)
        password = "first$second$$third${FOUR}$"
        config["services"]["redis"]["environment"] = {"TEST": password}
        records["redis"]["Config"]["Env"] = ["TEST=" + password]
        config["services"]["redis"]["command"] = ["redis-server", "--requirepass", password]
        records["redis"]["Config"]["Cmd"] = ["redis-server", "--requirepass", password]
        config["services"]["postgres"]["healthcheck"] = {"test": ["CMD-SHELL", 'pg_isready -U "$POSTGRES_USER" $$']}
        records["postgres"]["Config"]["Healthcheck"] = {"Test": ["CMD-SHELL", 'pg_isready -U "$POSTGRES_USER" $$']}
        decoded = REPAIR.decode_compose_export(json.dumps(config).encode().replace(b"$", b"$$"))
        before = copy.deepcopy(records)
        REPAIR.require_matching_command_environment(decoded, records, images)
        self.assertEqual(records, before)
        changed = copy.deepcopy(records)
        changed["redis"]["Config"]["Env"] = ["TEST=" + password.replace("$$", "$")]
        with self.assertRaisesRegex(REPAIR.Refused, "environment drift"):
            REPAIR.require_matching_command_environment(decoded, changed, images)

    def test_pins_exact_images_and_has_no_app_other_volume_or_dependency_recreation(self):
        config, records = fixture()
        config["volumes"]["caddy_data"] = {"name": "unused-volume"}
        candidate = REPAIR.pinned_compose(config, records, rollback=False)
        rollback = REPAIR.pinned_compose(config, records, rollback=True)
        self.assertEqual(set(candidate["services"]), {"postgres", "redis"})
        self.assertEqual(set(candidate["volumes"]), {"postgres-data", "redis-data"})
        for name in REPAIR.TARGETS:
            self.assertEqual(candidate["services"][name]["image"], records[name]["Image"])
            self.assertEqual(rollback["services"][name]["logging"], {"driver": "json-file", "options": {}})
            self.assertNotIn("depends_on", candidate["services"][name])
        config["services"]["postgres"]["build"] = {"context": "."}
        with self.assertRaisesRegex(REPAIR.Refused, "Unsupported"):
            REPAIR.pinned_compose(config, records, rollback=False)

    def test_rejects_environment_command_and_image_execution_drift(self):
        config, records = fixture()
        images = {name: {"Config": {key: copy.deepcopy(records[name]["Config"].get(key))
                                   for key in ("Env", "Cmd", "Entrypoint", "User", "WorkingDir")}}
                  for name in REPAIR.TARGETS}
        REPAIR.require_matching_command_environment(config, records, images)
        for field in ("Env", "Cmd", "Entrypoint", "User", "WorkingDir"):
            changed = copy.deepcopy(records)
            changed["postgres"]["Config"][field] = ["changed"] if field in ("Env", "Cmd", "Entrypoint") else "changed"
            if field == "Env":
                changed["postgres"]["Config"][field] = ["SECRET=changed"]
            with self.subTest(field=field), self.assertRaises(REPAIR.Refused):
                REPAIR.require_matching_command_environment(config, changed, images)

    def test_stable_fingerprint_ignores_probe_noise_but_not_restart_logging_or_data_mount(self):
        _, records = fixture()
        after = copy.deepcopy(records)
        after["postgres"]["State"]["Health"] = {"Status": "healthy", "Log": [{"End": "changed"}]}
        self.assertEqual(REPAIR.stable_runtime(records), REPAIR.stable_runtime(after))
        for field in ("Image", "RestartCount", "HostConfig", "Mounts"):
            changed = copy.deepcopy(after)
            if field == "RestartCount":
                changed["postgres"][field] += 1
            elif field == "HostConfig":
                changed["postgres"][field]["LogConfig"] = copy.deepcopy(EXPECTED_RUNTIME_LOGGING)
            elif field == "Mounts":
                changed["postgres"][field][0]["Name"] = "other"
            else:
                changed["postgres"][field] = "sha256:" + "f" * 64
            with self.subTest(field=field):
                self.assertNotEqual(REPAIR.stable_runtime(records), REPAIR.stable_runtime(changed))

    def test_data_preserves_pg_identity_counts_and_redis_values_and_ttl(self):
        pg = {"system_identifier": "123", "database": "analytics", "users": 2, "sites": 3, "aliases": 4}
        redis = {"timestamp_ms": 1000, "keys": {"a": {"hash": "v", "expires_at_ms": None},
                                                "b": {"hash": "b", "expires_at_ms": 20000},
                                                "c": {"hash": "c", "expires_at_ms": 2000}}}
        after = copy.deepcopy(redis)
        after["timestamp_ms"] = 5000
        del after["keys"]["c"]  # legitimately expired while maintenance ran
        REPAIR.compare_data(pg, pg, redis, after)
        cases = []
        for field in ("system_identifier", "database", "users", "sites", "aliases"):
            changed = copy.deepcopy(pg)
            changed[field] = 0 if isinstance(changed[field], int) else "different"
            cases.append((changed, after))
        for field, value in (("hash", "other"), ("expires_at_ms", None), ("expires_at_ms", 999999)):
            changed = copy.deepcopy(after)
            changed["keys"]["b"][field] = value
            cases.append((pg, changed))
        changed = copy.deepcopy(after)
        del changed["keys"]["a"]
        cases.append((pg, changed))
        for after_pg, after_redis in cases:
            with self.subTest(pg=after_pg, redis=after_redis), self.assertRaises(REPAIR.Refused):
                REPAIR.compare_data(pg, after_pg, redis, after_redis)

    def test_redis_snapshot_uses_readonly_lua_and_validates_aof_and_other_databases(self):
        _, records = fixture()
        persistence = "loading:0\naof_enabled:1\naof_rewrite_in_progress:0\naof_last_write_status:ok\naof_last_bgrewrite_status:ok\n"
        settings = {"appendonly": "yes", "appendfsync": "everysec", "dir": "/data", "appenddirname": "appendonlydir"}
        responses = [settings, persistence, "db0:keys=1\n", 1, ["0", [["a" * 40, "b" * 40, -1]]]]
        with patch.object(REPAIR, "redis_command", side_effect=responses) as redis:
            result = REPAIR.redis_snapshot(Path("."), records["redis"])
            self.assertEqual(result["keys"], {"a" * 40: {"hash": "b" * 40, "expires_at_ms": None}})
            self.assertEqual(redis.call_args_list[-1].args[2], "EVAL_RO")
        for changes in ([settings, persistence.replace("aof_enabled:1", "aof_enabled:0")],
                        [settings, persistence, "db1:keys=1\n"], [settings, persistence, "", 100001]):
            with self.subTest(changes=changes), patch.object(REPAIR, "redis_command", side_effect=changes), self.assertRaises(REPAIR.Refused):
                REPAIR.redis_snapshot(Path("."), records["redis"])


@unittest.skipUnless(shutil.which("docker"), "Docker Compose CLI required for config-only serialization regression")
class RepairNativeComposeExportTests(unittest.TestCase):
    def test_native_config_only_export_source_roundtrip_preserves_all_literal_dollars_and_keys(self):
        docker = shutil.which("docker")
        available = subprocess.run([docker, "compose", "version", "--short"], capture_output=True, timeout=15)
        if available.returncode:
            self.skipTest("Docker Compose CLI plugin unavailable")
        literals = 'literal-$ALPHA-${BETA}-$$GAMMA-$$$$-tail$'
        raw_source = {"services": {"probe": {"image": "busybox:synthetic-no-pull", "environment": {
            "LITERAL$KEY": "${WOTCV_SERIALIZER_SENTINEL}"}, "command": ["echo", "${WOTCV_SERIALIZER_SENTINEL}"],
            "entrypoint": ["entry", "${WOTCV_SERIALIZER_SENTINEL}"],
            "healthcheck": {"test": ["CMD-SHELL", "echo ${WOTCV_SERIALIZER_SENTINEL}"]},
            "labels": {"review.$KEY": "${WOTCV_SERIALIZER_SENTINEL}", "review.$$KEY": "$$literal"}}}}
        env = dict(os.environ, WOTCV_SERIALIZER_SENTINEL=literals)
        with tempfile.TemporaryDirectory() as directory:
            args = [docker, "compose", "--project-name", "wotcv-literal-config-test", "--project-directory", directory,
                    "--env-file", os.devnull, "-f", "-", "config", "--format", "json"]

            def render(source):
                result = subprocess.run(args, input=json.dumps(source).encode(), capture_output=True, env=env, timeout=20)
                self.assertEqual(result.returncode, 0, "Config-only synthetic fixture failed; no container operation requested")
                return REPAIR.decode_compose_export(result.stdout)

            first = render(raw_source)
            service = first["services"]["probe"]
            self.assertEqual(service["environment"]["LITERAL$KEY"], literals)
            self.assertEqual(service["command"][1], literals)
            self.assertEqual(service["entrypoint"][1], literals)
            self.assertEqual(service["healthcheck"]["test"][1], "echo " + literals)
            self.assertEqual(service["labels"]["review.$KEY"], literals)
            self.assertEqual(service["labels"]["review.$$KEY"], "$literal")
            second = render(REPAIR.compose_literals(first))
            self.assertEqual(second, first)


class RepairBackupTests(unittest.TestCase):
    def test_manifest_checks_identity_age_checksum_magic_and_native_pg_archive(self):
        _, records = fixture()
        pg = {"system_identifier": "123"}
        with tempfile.TemporaryDirectory() as directory:
            outer = Path(directory)
            files = {"postgres.dump": b"PGDMParchive", "postgres-globals.sql": b"-- roles", "redis.rdb": b"REDIS0012snapshot"}
            for name, content in files.items():
                (outer / name).write_bytes(content)
            manifest = {"schema": "wotcv-runtime-logging-backup-v1", "project": "rybbit",
                        "created_at": datetime.now(timezone.utc).isoformat()}
            for name, archive, verifier in (("postgres", "postgres.dump", "pg_restore --list"), ("redis", "redis.rdb", "redis-check-rdb")):
                item = {"container_id": records[name]["Id"], "image_id": records[name]["Image"],
                        "volume": "rybbit_" + name + "-data", "verified_by": verifier,
                        "archive": {"path": archive, "sha256": hashlib.sha256(files[archive]).hexdigest()}}
                if name == "postgres":
                    item.update(system_identifier="123", globals={"path": "postgres-globals.sql", "sha256": hashlib.sha256(files["postgres-globals.sql"]).hexdigest()})
                manifest[name] = item
            path = outer / "manifest.json"

            def verify(value):
                path.write_text(json.dumps(value))
                with patch.object(REPAIR, "protected_directory"), \
                        patch.object(REPAIR, "protected_open", side_effect=lambda value: value.open("rb")), \
                        patch.object(REPAIR, "command", return_value=b"Archive entries\n") as native:
                    result = REPAIR.verify_backup(outer, path, records, pg)
                    native.assert_called_once()
                    self.assertEqual(native.call_args.args[1][-2:], ["pg_restore", "--list"])
                    return result

            self.assertEqual(json.loads(verify(manifest)), manifest)
            invalids = []
            for field, value in (("container_id", "f" * 64), ("image_id", "sha256:" + "e" * 64),
                                 ("volume", "new-volume"), ("verified_by", "trust-me"), ("system_identifier", "999")):
                changed = copy.deepcopy(manifest)
                changed["postgres"][field] = value
                invalids.append(changed)
            for field, value in (("path", "../outside.rdb"), ("sha256", "a" * 64)):
                changed = copy.deepcopy(manifest)
                changed["redis"]["archive"][field] = value
                invalids.append(changed)
            for timestamp in (datetime.now(timezone.utc) - timedelta(hours=7), datetime.now(timezone.utc) + timedelta(hours=1)):
                changed = copy.deepcopy(manifest)
                changed["created_at"] = timestamp.isoformat()
                invalids.append(changed)
            for invalid in invalids:
                with self.subTest(invalid=invalid), self.assertRaises(REPAIR.Refused):
                    verify(invalid)
            # A marker invalidates otherwise exact, recent, natively verified
            # evidence too (including a late directory-sync publication failure).
            (outer / "failed.json").write_text('{"usableBackupManifest":false}')
            with self.assertRaisesRegex(REPAIR.Refused, "failed verification"):
                verify(manifest)


class RepairDirectorySyncTests(unittest.TestCase):
    def test_directory_fsync_requires_root_private_directory_and_nofollow(self):
        path = Path("/protected-audit")
        info = SimpleNamespace(st_mode=stat.S_IFDIR | 0o700, st_uid=0)
        with patch.object(REPAIR, "protected_directory") as trusted, \
                patch.object(REPAIR.os, "O_DIRECTORY", 1024, create=True), patch.object(REPAIR.os, "O_NOFOLLOW", 2048, create=True), \
                patch.object(REPAIR.os, "open", return_value=99) as opened, patch.object(REPAIR.os, "fstat", return_value=info), \
                patch.object(REPAIR.os, "fsync") as synced, patch.object(REPAIR.os, "close") as closed:
            REPAIR.sync_directory(path)
            trusted.assert_called_once_with(path, private=True)
            self.assertEqual(opened.call_args.args[1] & (1024 | 2048), 1024 | 2048)
            synced.assert_called_once_with(99)
            closed.assert_called_once_with(99)
        for info in (SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_uid=0),
                     SimpleNamespace(st_mode=stat.S_IFREG | 0o700, st_uid=0),
                     SimpleNamespace(st_mode=stat.S_IFDIR | 0o700, st_uid=1000)):
            with self.subTest(info=info), patch.object(REPAIR, "protected_directory"), \
                    patch.object(REPAIR.os, "O_DIRECTORY", 1024, create=True), patch.object(REPAIR.os, "O_NOFOLLOW", 2048, create=True), \
                    patch.object(REPAIR.os, "open", return_value=99), patch.object(REPAIR.os, "fstat", return_value=info), \
                    patch.object(REPAIR.os, "fsync") as synced, patch.object(REPAIR.os, "close"), self.assertRaises(REPAIR.Refused):
                REPAIR.sync_directory(path)
            synced.assert_not_called()


class RepairGateTests(unittest.TestCase):
    def invoke(self, value, *, owner="test-token-123", installed_error=False, origin_error=False, metadata=None):
        with tempfile.TemporaryDirectory() as directory:
            flag = Path(directory) / "active"
            flag.write_text(json.dumps(value), encoding="utf-8")
            info = metadata or SimpleNamespace(st_mode=stat.S_IFREG | 0o644, st_uid=1000)
            with patch.object(REPAIR, "GATE", flag), patch.object(REPAIR, "uid", return_value=1000), \
                    patch.object(Path, "lstat", return_value=info), patch.object(REPAIR.os, "fstat", return_value=info), \
                    patch.object(REPAIR.os, "O_NOFOLLOW", getattr(os, "O_NOFOLLOW", 0), create=True), \
                    patch.object(REPAIR.MAINTENANCE, "require_installed", side_effect=REPAIR.MAINTENANCE.Refused("not installed") if installed_error else None) as installed, \
                    patch.object(REPAIR.MAINTENANCE, "verify_active_origin", side_effect=REPAIR.MAINTENANCE.Refused("not gated") if origin_error else None) as origin:
                REPAIR.require_gate(owner)
                return installed.call_count, origin.call_count

    def test_owned_gate_requires_installed_trusted_config_and_live_origin_503(self):
        self.assertEqual(self.invoke({"version": 1, "owner": "test-token-123"}), (1, 1))
        for failure in ("installed", "origin"):
            with self.subTest(failure=failure), self.assertRaisesRegex(REPAIR.Refused, "live origin 503"):
                self.invoke({"version": 1, "owner": "test-token-123"},
                            installed_error=failure == "installed", origin_error=failure == "origin")

    def test_token_contract_matches_maintenance_cli_and_foreign_owner_or_unsafe_metadata_refuses(self):
        for token in ("x", "a" * 80, "A0_a-b"):
            with self.subTest(token=token):
                self.assertEqual(self.invoke({"version": 1, "owner": token}, owner=token), (1, 1))
        for token in ("", "a" * 81, "has:colon", "has.dot", "has space", "newline\n"):
            with self.subTest(token=token), self.assertRaises(REPAIR.Refused):
                self.invoke({"version": 1, "owner": token}, owner=token)
        for value in ({"version": 1, "owner": "other-owner"}, {"version": 2, "owner": "test-token-123"}, [], {}):
            with self.subTest(value=value), self.assertRaises(REPAIR.Refused):
                self.invoke(value)
        for info in (SimpleNamespace(st_mode=stat.S_IFREG | 0o666, st_uid=1000),
                     SimpleNamespace(st_mode=stat.S_IFLNK | 0o644, st_uid=1000),
                     SimpleNamespace(st_mode=stat.S_IFREG | 0o644, st_uid=999)):
            with self.subTest(info=info), self.assertRaises(REPAIR.Refused):
                self.invoke({"version": 1, "owner": "test-token-123"}, metadata=info)


class RepairApplyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.outer = Path(self.temp.name)
        self.repo = self.outer / "repo"
        self.repo.mkdir()
        self.config, self.records = fixture()
        self.records["backend"]["State"].update({"Status": "exited", "Running": False})
        self.calls = []
        self.events = []
        self.fail_service = None
        self.config_drift = False
        self.pg = {"system_identifier": "123", "database": "analytics", "users": 2, "sites": 3, "aliases": 4, "alias": None}
        self.redis = {"timestamp_ms": 1000, "keys": {"a": {"hash": "v", "expires_at_ms": None}}}
        for name, replacement in (
            ("require_apply_authority", lambda *a: None), ("uid", lambda: 1000),
            ("require_gate", lambda *a: None), ("lock_file", lambda *a: nullcontext()),
            ("protected_directory", lambda *a, **kw: None),
            ("sync_directory", lambda path, **kwargs: self.events.append(("sync", path))),
            ("verify_backup", lambda *a: b'{"schema":"wotcv-runtime-logging-backup-v1"}'),
            ("postgres_snapshot", lambda *a: copy.deepcopy(self.pg)),
            ("redis_snapshot", lambda *a: copy.deepcopy(self.redis)),
            ("verify_identity", lambda *a: None), ("command", self.command),
        ):
            mock = patch.object(REPAIR, name, side_effect=replacement)
            mock.start()
            self.addCleanup(mock.stop)
        nofollow = patch.object(REPAIR.os, "O_NOFOLLOW", getattr(os, "O_NOFOLLOW", 0), create=True)
        nofollow.start()
        self.addCleanup(nofollow.stop)

    def command(self, repo, args, **kwargs):
        self.calls.append(args)
        if args[:3] == ["docker", "image", "inspect"]:
            record = next(record for record in self.records.values() if record["Image"] == args[3])
            return json.dumps([{ "Id": record["Image"], "Config": {key: record["Config"].get(key)
                                for key in ("Env", "Cmd", "Entrypoint", "User", "WorkingDir")}}]).encode()
        if args[:2] == ["docker", "inspect"]:
            return json.dumps(list(self.records.values())).encode()
        if "config" in args:
            if any("candidate.compose.json" in item for item in args):
                value = REPAIR.pinned_compose(self.config, self.records, rollback=False)
                return json.dumps(value).encode()
            return json.dumps(self.config).encode()
        if "up" in args:
            name = args[-1]
            self.events.append(("up", name))
            if name == self.fail_service:
                raise REPAIR.Refused("Synthetic replacement failure")
            self.records[name]["Id"] = "a" * 63 + ("1" if name == "postgres" else "2")
            self.records[name]["Config"]["Hostname"] = self.records[name]["Id"][:12]
            self.records[name]["HostConfig"]["LogConfig"] = copy.deepcopy(EXPECTED_RUNTIME_LOGGING)
            self.records[name]["State"]["StartedAt"] = "2026-10-24T12:00:00Z"
            self.records[name]["NetworkSettings"]["Networks"]["rybbit_default"]["IPAddress"] = "172.1.0.9"
            if self.config_drift:
                self.records[name]["Mounts"][0]["Name"] = "different-data"
            return b""
        raise AssertionError(args)

    def run_apply(self):
        return REPAIR.reconcile(self.repo, apply=True, owner="test-token-123", ack=REPAIR.ACK,
                                backup_manifest=self.outer / "manifest.json", audit_root=self.outer / "audit")

    def test_apply_recreates_only_drifted_databases_and_leaves_backend_stopped_gate_active(self):
        before = copy.deepcopy(self.records)
        audit = self.run_apply()
        mutations = [call for call in self.calls if "up" in call]
        self.assertEqual([call[-1] for call in mutations], ["postgres", "redis"])
        for call in mutations:
            for option in ("--no-deps", "--no-build", "--force-recreate", "--wait"):
                self.assertIn(option, call)
            self.assertEqual(call[call.index("--pull") + 1], "never")
            self.assertNotIn("run", call)
        for name in ("backend", "client", "clickhouse"):
            self.assertEqual(self.records[name], before[name])
        self.assertEqual(json.loads((audit / "success.json").read_text())["backendStarted"], False)
        self.assertTrue((audit / "rollback.compose.json").exists())
        self.assertTrue((audit / "recovery.json").exists())
        self.assertEqual(self.events[:4], [("sync", audit.parent.parent), ("sync", audit), ("sync", audit.parent), ("up", "postgres")])
        self.assertEqual(self.events[-2:], [("sync", audit), ("sync", audit.parent)])

    def test_directory_sync_failure_prevents_any_container_replacement(self):
        for fail_at, existing in ((1, False), (2, False), (3, False), (1, True), (2, True), (3, True)):
            count = 0
            synced = []

            def sync(path, **kwargs):
                nonlocal count
                synced.append(path)
                count += 1
                if count == fail_at:
                    raise OSError("Synthetic directory fsync failure")

            self.calls = []
            # An earlier interrupted mkdir must not bypass its parent barrier
            # merely because its directory now exists on a retry.
            audit_root = self.outer / f"audit-failure-{fail_at}-{existing}"
            if existing:
                audit_root.mkdir()
            with self.subTest(fail_at=fail_at, existing=existing), patch.object(REPAIR, "sync_directory", side_effect=sync), self.assertRaises(OSError):
                REPAIR.reconcile(self.repo, apply=True, owner="test-token-123", ack=REPAIR.ACK,
                                 backup_manifest=self.outer / "manifest.json", audit_root=audit_root)
            self.assertFalse(any("up" in call for call in self.calls))
            self.assertEqual(synced[0], self.outer)

    def test_late_success_sync_failure_records_failure_and_invalidates_success_claim(self):
        def sync(path, **kwargs):
            if (path / "success.json").exists():
                raise OSError("Synthetic late fsync failure")

        with patch.object(REPAIR, "sync_directory", side_effect=sync), self.assertRaises(OSError):
            self.run_apply()
        audit = next((self.outer / "audit").iterdir())
        self.assertFalse((audit / "success.json").exists())
        self.assertTrue((audit / "success.invalid.json").exists())
        self.assertTrue((audit / "failure.json").exists())

    def test_already_current_never_recreates_or_writes_audit(self):
        for name in REPAIR.TARGETS:
            self.records[name]["HostConfig"]["LogConfig"] = copy.deepcopy(EXPECTED_RUNTIME_LOGGING)
        self.assertIsNone(self.run_apply())
        self.assertFalse((self.outer / "audit").exists())
        self.assertFalse(any("up" in call for call in self.calls))

    def test_running_backend_other_service_drift_gate_or_backup_failure_prevents_recreation(self):
        for reason in ("backend", "unclean", "other", "gate", "backup"):
            with self.subTest(reason=reason):
                config, records = fixture()
                records["backend"]["State"].update({"Status": "exited", "Running": False})
                if reason == "backend":
                    records["backend"]["State"].update({"Status": "running", "Running": True})
                if reason == "unclean":
                    records["backend"]["State"]["ExitCode"] = 143
                if reason == "other":
                    records["client"]["HostConfig"]["LogConfig"]["Config"] = {}
                self.records, self.config, self.calls = records, config, []
                failing = "require_gate" if reason == "gate" else "verify_backup"
                context = patch.object(REPAIR, failing, side_effect=REPAIR.Refused("Refused safety prerequisite")) if reason in ("gate", "backup") else nullcontext()
                with context, self.assertRaises(REPAIR.Refused):
                    self.run_apply()
                self.assertFalse(any("up" in call for call in self.calls))

    def test_replacement_or_data_volume_failure_stops_further_work_without_auto_restart_restore(self):
        for reason in ("replacement", "volume"):
            with self.subTest(reason=reason):
                self.config, self.records = fixture()
                self.records["backend"]["State"].update({"Status": "exited", "Running": False})
                self.calls = []
                self.fail_service = "postgres" if reason == "replacement" else None
                self.config_drift = reason == "volume"
                with self.assertRaises((ValueError, REPAIR.Refused)):
                    self.run_apply()
                mutations = [call for call in self.calls if "up" in call]
                self.assertEqual([call[-1] for call in mutations], ["postgres"])
                self.assertEqual(self.records["backend"]["State"]["Status"], "exited")
                audit = sorted((self.outer / "audit").iterdir())[-1]
                failure = json.loads((audit / "failure.json").read_text())
                self.assertFalse(failure["automaticDataOrConfigurationRestore"])
                self.assertTrue(failure["maintenanceLeftActive"])

    def test_data_loss_failure_does_not_attempt_database_restore_or_start_backend(self):
        with patch.object(REPAIR, "compare_data", side_effect=REPAIR.Refused("Synthetic key loss")), self.assertRaises(REPAIR.Refused):
            self.run_apply()
        self.assertEqual([call[-1] for call in self.calls if "up" in call], ["postgres", "redis"])
        self.assertFalse(any("restore" in str(call) or "migrate" in str(call) for call in self.calls))
        self.assertEqual(self.records["backend"]["State"]["Status"], "exited")


if __name__ == "__main__":
    unittest.main()
