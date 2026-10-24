"""Hermetic runtime logging guard and narrowly scoped maintenance tests."""

import copy
from contextlib import contextmanager, nullcontext
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.util
import io
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
        record["Config"].update(copy.deepcopy(REPAIR.NATIVE_ATTACH_CONFIG))
        record["State"].update({"StartedAt": "2026-01-01T00:00:00Z", "FinishedAt": "0001-01-01T00:00:00Z"})
        record["RestartCount"] = 0
        record["HostConfig"].update({"PortBindings": {}, "NetworkMode": "rybbit_default",
                                   "RestartPolicy": {"Name": "unless-stopped", "MaximumRetryCount": 0}})
        record["HostConfig"].update(copy.deepcopy(REPAIR.NATIVE_HOST_CONFIG))
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


def images_for(records):
    fields = ("Env", "Cmd", "Entrypoint", "User", "WorkingDir", "ExposedPorts", "Volumes", "StopSignal")
    return {name: {"Id": records[name]["Image"], "Config": {
        key: copy.deepcopy(records[name]["Config"].get(key)) for key in fields}}
        for name in REPAIR.TARGETS}


def read_only_response(config, records, args):
    if args[:2] == ["docker", "version"]:
        return (REPAIR.NATIVE_ENGINE + "\n").encode()
    if args == ["docker", "compose", "version", "--short"]:
        return (REPAIR.NATIVE_COMPOSE + "\n").encode()
    if args[:3] == ["docker", "image", "inspect"]:
        images = images_for(records)
        image = next(image for image in images.values() if image["Id"] == args[3])
        return json.dumps([image]).encode()
    return json.dumps(config if "config" in args else list(records.values())).encode()


class ProbeDockerFixture:
    """Only implements never-started helper create/inspect/list/remove calls."""

    def __init__(self, events=None):
        self.helpers = {}
        self.calls = []
        self.events = events if events is not None else []
        self.poison = lambda record: None
        self.inspect_hook = lambda record, count: None
        self.inspect_count = 0
        self.create_failure = None
        self.lookup_failure = self.remove_failure = False

    def command(self, args):
        operation = args[args.index("docker"):] if args[:2] == ["/usr/bin/env", "-i"] and "docker" in args else args
        if operation[:2] == ["docker", "create"]:
            self.calls.append(args)
            if self.create_failure == "before":
                raise REPAIR.Refused("Synthetic create failure")
            name = operation[operation.index("--name") + 1]
            service = name.rsplit("-", 1)[1]
            identifier = "e" * 63 + ("1" if service == "postgres" else "2")
            label = operation[operation.index("--label") + 1].split("=", 1)
            target = operation[operation.index("--mount") + 1].split("dst=", 1)[1]
            host = copy.deepcopy(REPAIR.NATIVE_HOST_CONFIG)
            host.update(copy.deepcopy(REPAIR.PROBE_NATIVE_SPELLINGS))
            host.update(NetworkMode="none", RestartPolicy={"Name": "no", "MaximumRetryCount": 0},
                        Binds=None, PortBindings=None, Mounts=[{"Type": "tmpfs", "Target": target}],
                        LogConfig={"Type": "json-file", "Config": {}})
            record = {"Id": identifier, "Name": "/" + name, "Image": operation[-1],
                      "Config": dict(copy.deepcopy(REPAIR.NATIVE_ATTACH_CONFIG), Image=operation[-1],
                                     Labels={label[0]: label[1]}, Entrypoint=["/bin/true"]),
                      "HostConfig": host, "AppArmorProfile": "",
                      "State": {"Status": "created", "Running": False},
                      "NetworkSettings": {"Networks": {"none": {}}},
                      "Mounts": [{"Type": "tmpfs", "Source": "", "Destination": target,
                                  "Mode": "", "RW": True, "Propagation": ""}]}
            self.poison(record)
            self.helpers[identifier] = record
            self.events.append(("probe-create", service))
            if self.create_failure == "after":
                raise REPAIR.Refused("Synthetic create response failure")
            return b"not-an-id\n" if self.create_failure == "response" else (identifier + "\n").encode()
        if operation[:2] == ["docker", "inspect"] and len(operation) == 3 and operation[2] in self.helpers:
            self.calls.append(args)
            record = self.helpers[operation[2]]
            self.inspect_count += 1
            self.inspect_hook(record, self.inspect_count)
            return json.dumps([record]).encode()
        if operation[:2] == ["docker", "ps"]:
            self.calls.append(args)
            if self.lookup_failure:
                raise REPAIR.Refused("Synthetic helper lookup failure")
            filters = [operation[index + 1] for index, value in enumerate(operation) if value == "--filter"]
            found = []
            for identifier, record in self.helpers.items():
                matches = True
                for item in filters:
                    key, value = item.split("=", 1)
                    if key == "id":
                        matches &= identifier == value
                    elif key == "name":
                        matches &= record["Name"] == "/" + value
                    elif key == "label":
                        label, expected = value.split("=", 1)
                        matches &= record["Config"]["Labels"].get(label) == expected
                if matches:
                    found.append(identifier)
            return "\n".join(found).encode()
        if operation[:2] == ["docker", "rm"]:
            self.calls.append(args)
            if self.remove_failure:
                raise REPAIR.Refused("Synthetic helper removal failure")
            if len(operation) != 3 or operation[2] not in self.helpers:
                raise AssertionError("Only an exact owned fixture helper ID may be removed")
            record = self.helpers.pop(operation[2])
            self.events.append(("probe-remove", record["Name"].rsplit("-", 1)[1]))
            return (operation[2] + "\n").encode()
        return None


class RepairReadOnlyTests(unittest.TestCase):
    def test_default_check_only_renders_and_inspects_and_reports_live_drift(self):
        config, records = fixture()
        calls = []

        def command(repo, args, **kwargs):
            calls.append(args)
            return read_only_response(config, records, args)

        with tempfile.TemporaryDirectory() as directory, patch.object(REPAIR, "command", side_effect=command), \
                patch.object(REPAIR, "lock_file", side_effect=AssertionError("check must not create locks")), \
                patch.object(REPAIR, "write_json", side_effect=AssertionError("check must not write files")):
            with self.assertRaisesRegex(REPAIR.Refused, "postgres, redis"):
                REPAIR.reconcile(Path(directory))
            self.assertEqual(len(calls), 6)
            self.assertIn("config", calls[0])
            self.assertEqual(calls[1], ["docker", "inspect", *SERVICES])
            self.assertTrue(all("up" not in call and "create" not in call for call in calls))
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_check_passes_correct_hostconfig_and_can_audit_stopped_backend(self):
        config, records = fixture()
        for record in records.values():
            record["HostConfig"]["LogConfig"] = copy.deepcopy(EXPECTED_RUNTIME_LOGGING)
        records["backend"]["State"].update({"Status": "exited", "Running": False})
        with tempfile.TemporaryDirectory() as directory, patch.object(REPAIR, "command", side_effect=lambda _, args, **kw:
                read_only_response(config, records, args)):
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

    def test_check_rejects_unsupported_resource_or_execution_drift_without_stopping_backend_or_writes(self):
        for section, field, value in (("HostConfig", "Memory", 536870912),
                                      ("HostConfig", "ShmSize", 1073741824),
                                      ("Config", "Tty", True)):
            config, records = fixture()
            records["postgres"][section][field] = value
            with self.subTest(section=section, field=field), tempfile.TemporaryDirectory() as directory, \
                    patch.object(REPAIR, "command", side_effect=lambda _, args, **kw: read_only_response(config, records, args)) as docker, \
                    patch.object(REPAIR, "lock_file", side_effect=AssertionError("check must not lock")), \
                    patch.object(REPAIR, "write_json", side_effect=AssertionError("check must not write")), \
                    self.assertRaisesRegex(REPAIR.Refused, "unsupported"):
                REPAIR.reconcile(Path(directory))
            self.assertTrue(all("up" not in call.args[1] for call in docker.call_args_list))

    def test_check_requires_exact_database_images_available_locally_before_maintenance(self):
        config, records = fixture()

        def response(repo, args, **kwargs):
            if args[:3] == ["docker", "image", "inspect"]:
                return b"[]"
            return read_only_response(config, records, args)

        with tempfile.TemporaryDirectory() as directory, patch.object(REPAIR, "command", side_effect=response) as docker, \
                patch.object(REPAIR, "lock_file", side_effect=AssertionError("check must not lock")), \
                patch.object(REPAIR, "write_json", side_effect=AssertionError("check must not write")), \
                self.assertRaisesRegex(REPAIR.Refused, "unavailable locally; no pull"):
            REPAIR.reconcile(Path(directory))
        self.assertEqual(records["backend"]["State"]["Status"], "running")
        self.assertFalse(any("up" in call.args[1] or "pull" in call.args[1] for call in docker.call_args_list))


class RepairCliIsolationTests(unittest.TestCase):
    def test_source_environment_pins_lifecycle_controls_against_inherited_and_dotenv_poisoning(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            tag = "sha-" + "a" * 40
            (repo / ".wotcv-deployment.env").write_text("LAST_IMAGE_TAG=" + tag + "\n")
            poison = {"COMPOSE_REMOVE_ORPHANS": "true", "COMPOSE_IGNORE_ORPHANS": "false",
                      "COMPOSE_DISABLE_ENV_FILE": "false", "COMPOSE_ENV_FILES": "/outside/poison.env",
                      "COMPOSE_FILE": "/outside/poison.yml", "COMPOSE_PROJECT_NAME": "foreign",
                      "COMPOSE_PROFILES": "*", "COMPOSE_BAKE": "true", "DOCKER_CONTEXT": "remote",
                      "DOCKER_HOST": "tcp://untrusted:2375", "BASH_ENV": "/outside/poison.sh", "PATH": "/outside"}
            (repo / ".env").write_text("\n".join(f"{key}={value}" for key, value in poison.items()))
            with patch.dict(os.environ, poison), patch.object(REPAIR.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout=b"{}")) as run:
                REPAIR.command(repo, ["docker", "compose", "config"])
            actual = run.call_args.kwargs["env"]
            self.assertEqual(actual, dict(REPAIR.CLI_ENVIRONMENT, IMAGE_TAG=tag))
            self.assertEqual(actual["COMPOSE_REMOVE_ORPHANS"], "false")
            self.assertEqual(actual["COMPOSE_IGNORE_ORPHANS"], "true")
            self.assertEqual(actual["DOCKER_HOST"], "unix:///var/run/docker.sock")
            for field in ("COMPOSE_FILE", "COMPOSE_PROJECT_NAME", "DOCKER_CONTEXT", "BASH_ENV"):
                self.assertNotIn(field, actual)
            source = REPAIR.compose(repo)
            self.assertEqual(source[source.index("--env-file") + 1], str(repo / ".env"))

    def test_pinned_invocation_is_self_contained_for_candidate_and_operator_recovery(self):
        for filename in ("candidate.compose.json", "rollback.compose.json"):
            path = Path("/protected-audit/run") / filename
            with self.subTest(filename=filename), patch.dict(os.environ, {"COMPOSE_REMOVE_ORPHANS": "true", "DOCKER_CONTEXT": "foreign"}):
                args = REPAIR.pinned_compose_command(path)
            self.assertEqual(args[:2], ["/usr/bin/env", "-i"])
            assignments = dict(item.split("=", 1) for item in args[2:args.index("/bin/sh")])
            self.assertEqual(assignments, dict(REPAIR.CLI_ENVIRONMENT, DOCKER_CONFIG=str(path.parent)))
            self.assertEqual(args[args.index("--env-file") + 1], "/dev/null")
            self.assertEqual(args[args.index("--project-directory") + 1], str(path.parent))
            self.assertEqual(args[args.index("--project-name") + 1], "rybbit")
            self.assertEqual(args[args.index("-f") + 1], str(path))
            guard = args[args.index("-ec") + 1]
            self.assertIn(REPAIR.NATIVE_ENGINE, guard)
            self.assertIn(REPAIR.NATIVE_COMPOSE, guard)
            self.assertTrue(guard.endswith('exec docker compose "$@"'))

    def test_unknown_engine_platform_or_compose_version_refuses_instead_of_guessing_defaults(self):
        for engine, cli in (("29.9.3|linux|amd64", REPAIR.NATIVE_COMPOSE),
                            ("29.9.2|linux|arm64", REPAIR.NATIVE_COMPOSE),
                            (REPAIR.NATIVE_ENGINE, "5.6.2")):
            with self.subTest(engine=engine, cli=cli), patch.object(REPAIR, "command", side_effect=[engine.encode(), cli.encode()]), \
                    self.assertRaisesRegex(REPAIR.Refused, "reviewed native"):
                REPAIR.require_native_cli(Path("/repo"))

    @unittest.skipUnless(os.name == "posix", "POSIX shell required for isolated recovery guard fixture")
    def test_recovery_guard_never_executes_compose_when_native_version_probe_fails_or_drifts(self):
        guard = REPAIR.pinned_compose_command(Path("/protected/rollback.compose.json"))
        script = guard[guard.index("-ec") + 1]
        with tempfile.TemporaryDirectory() as directory:
            docker = Path(directory) / "docker"
            docker.write_text('#!/bin/sh\n'
                              'if [ "$1" = version ]; then printf "%s\\n" "$WOTCV_ENGINE"; exit "$WOTCV_PROBE_EXIT"; fi\n'
                              'if [ "$2" = version ]; then printf "%s\\n" "$WOTCV_COMPOSE"; exit 0; fi\n'
                              'printf "COMPOSE_MUTATION_REACHED\\n"\n')
            docker.chmod(0o700)
            for engine, compose, status, allowed in ((REPAIR.NATIVE_ENGINE, REPAIR.NATIVE_COMPOSE, "0", True),
                                                      ("unknown", REPAIR.NATIVE_COMPOSE, "0", False),
                                                      (REPAIR.NATIVE_ENGINE, "unknown", "0", False),
                                                      (REPAIR.NATIVE_ENGINE, REPAIR.NATIVE_COMPOSE, "1", False)):
                env = {"PATH": directory, "WOTCV_ENGINE": engine, "WOTCV_COMPOSE": compose, "WOTCV_PROBE_EXIT": status}
                result = subprocess.run(["/bin/sh", "-ec", script, "guard-fixture", "up"], env=env,
                                        capture_output=True, text=True, timeout=10)
                with self.subTest(engine=engine, compose=compose, status=status):
                    self.assertEqual("COMPOSE_MUTATION_REACHED" in result.stdout, allowed)
                    self.assertEqual(result.returncode == 0, allowed)


class RepairNativeDaemonProbeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.outer = Path(self.temp.name)
        self.config, self.records = fixture()
        self.docker = ProbeDockerFixture()
        self.counter = 0
        for name, replacement in (("require_gate", lambda *args: None), ("sync_directory", lambda *args: None),
                                  ("command", lambda repo, args, **kwargs: self.native_command(args))):
            mock = patch.object(REPAIR, name, side_effect=replacement)
            mock.start()
            self.addCleanup(mock.stop)
        mock = patch.object(REPAIR.os, "O_NOFOLLOW", getattr(os, "O_NOFOLLOW", 0), create=True)
        mock.start()
        self.addCleanup(mock.stop)

    def native_command(self, args):
        result = self.docker.command(args)
        if result is None:
            raise AssertionError("Probe attempted an unsupported operation")
        return result

    def run_probe(self):
        self.counter += 1
        audit = self.outer / ("audit-" + str(self.counter))
        audit.mkdir()
        REPAIR.probe_native_daemon(self.outer, audit, self.records, "fixture-owner")
        return audit

    def test_both_exact_images_are_created_never_started_isolated_and_removed_by_proven_id(self):
        before = copy.deepcopy(self.records)
        audit = self.run_probe()
        self.assertEqual(self.docker.events, [("probe-create", "postgres"), ("probe-remove", "postgres"),
                                            ("probe-create", "redis"), ("probe-remove", "redis")])
        self.assertEqual(self.records, before)
        self.assertEqual(self.docker.helpers, {})
        creates = [call for call in self.docker.calls if "create" in call]
        self.assertEqual([call[-1] for call in creates], [self.records[name]["Image"] for name in REPAIR.TARGETS])
        for call, spec in zip(creates, REPAIR.SPECS[1:]):
            self.assertEqual(call[:2], ["/usr/bin/env", "-i"])
            self.assertIn("DOCKER_CONFIG=" + str(audit), call)
            for flag, value in (("--pull", "never"), ("--entrypoint", "/bin/true"), ("--network", "none"),
                                ("--runtime", "runc"), ("--ipc", "private"), ("--cgroupns", "private"),
                                ("--shm-size", "67108864"), ("--mount", "type=tmpfs,dst=" + spec.target)):
                self.assertEqual(call[call.index(flag) + 1], value)
            self.assertEqual([call[index + 1] for index, value in enumerate(call) if value == "-a"], ["stdout", "stderr"])
            cleanup = json.loads((audit / ("probe-" + spec.service_name + ".cleanup.json")).read_text())
            self.assertTrue(cleanup["cleanupConfirmed"])
            self.assertFalse(cleanup["effectiveKernelPolicyProven"])
        for call in self.docker.calls:
            self.assertFalse(any(option in call for option in ("start", "run", "up", "--force", "--volumes", "--publish", "--volume")))
            if "rm" in call:
                self.assertTrue(REPAIR.CONTAINER_ID.fullmatch(call[-1]))

    def test_poisoned_daemon_defaults_refuse_and_cleanup_owned_never_started_helper(self):
        for field, value in (("Ulimits", [{"Name": "nofile", "Soft": 4096, "Hard": 4096}]),
                             ("SecurityOpt", ["no-new-privileges"]), ("Memory", 536870912),
                             ("OomKillDisable", True), ("FutureSecurityControl", None)):
            self.docker = ProbeDockerFixture()
            self.docker.poison = lambda record: record["HostConfig"].update({field: value})
            with self.subTest(field=field), self.assertRaisesRegex(REPAIR.Refused, "unsupported resource/security/runtime"):
                self.run_probe()
            self.assertEqual(self.docker.helpers, {})
            self.assertEqual(self.docker.events, [("probe-create", "postgres"), ("probe-remove", "postgres")])

    def test_probe_normalization_never_weakens_original_native_profile(self):
        self.run_probe()
        for field, alternative in REPAIR.PROBE_NATIVE_SPELLINGS.items():
            _, records = fixture()
            records["postgres"]["HostConfig"][field] = copy.deepcopy(alternative)
            with self.subTest(field=field), self.assertRaises(REPAIR.Refused):
                REPAIR.require_native_runtime_settings(records)

    def test_unknown_ownership_running_or_storage_surface_is_preserved_without_removal(self):
        def wrong_label(record):
            record["Config"]["Labels"][REPAIR.PROBE_LABEL] = "foreign"
        def running(record):
            record["State"].update(Status="running", Running=True)
        def wrong_mount(record):
            record["HostConfig"]["Mounts"] = [{"Type": "volume", "Source": "rybbit_postgres-data", "Target": "/data"}]
        for change in (wrong_label, running, wrong_mount,
                       lambda record: record.update(Image="sha256:" + "f" * 64),
                       lambda record: record.update(Name="/postgres")):
            self.docker = ProbeDockerFixture()
            self.docker.poison = change
            with self.subTest(change=change), self.assertRaisesRegex(REPAIR.Refused, "cleanup could not be proven"):
                self.run_probe()
            self.assertEqual(len(self.docker.helpers), 1)
            self.assertFalse(any("rm" in call for call in self.docker.calls))
            status = json.loads((self.outer / ("audit-" + str(self.counter)) / "probe-postgres.cleanup.json").read_text())
            self.assertFalse(status["cleanupConfirmed"])

    def test_incomplete_create_or_invalid_response_recovers_only_nonce_and_name_owned_helper(self):
        for failure in ("before", "after", "response"):
            self.docker = ProbeDockerFixture()
            self.docker.create_failure = failure
            with self.subTest(failure=failure), self.assertRaises(REPAIR.Refused):
                self.run_probe()
            self.assertEqual(self.docker.helpers, {})
            lookup = next(call for call in self.docker.calls if "ps" in call)
            self.assertTrue(any(value.startswith("label=" + REPAIR.PROBE_LABEL + "=") for value in lookup))
            self.assertTrue(any(value.startswith("name=wotcv-runtime-logging-probe-") for value in lookup))
            status = json.loads((self.outer / ("audit-" + str(self.counter)) / "probe-postgres.cleanup.json").read_text())
            self.assertEqual(status["cleanupConfirmed"], failure != "before")
            self.assertEqual(status["createOutcomeUncertain"], failure == "before")
            self.assertEqual(status["operatorReviewRequired"], failure == "before")

    def test_cleanup_rechecks_ownership_and_never_forces_running_or_changed_helpers(self):
        for field in ("owner", "running"):
            self.docker = ProbeDockerFixture()
            def change(record, count):
                if count == 2:
                    if field == "owner":
                        record["Config"]["Labels"][REPAIR.PROBE_LABEL] = "foreign"
                    else:
                        record["State"].update(Status="running", Running=True)
            self.docker.inspect_hook = change
            with self.subTest(field=field), self.assertRaisesRegex(REPAIR.Refused, "cleanup could not be proven"):
                self.run_probe()
            self.assertEqual(len(self.docker.helpers), 1)
            self.assertFalse(any("rm" in call for call in self.docker.calls))

    def test_uncertain_lookup_or_removal_fails_without_claiming_cleanup(self):
        for failure in ("lookup", "remove"):
            self.docker = ProbeDockerFixture()
            self.docker.create_failure = "after" if failure == "lookup" else None
            self.docker.lookup_failure = failure == "lookup"
            self.docker.remove_failure = failure == "remove"
            with self.subTest(failure=failure), self.assertRaisesRegex(REPAIR.Refused, "cleanup could not be proven"):
                self.run_probe()
            self.assertEqual(len(self.docker.helpers), 1)


class RepairDataAndPlanTests(unittest.TestCase):
    def images(self, records):
        return images_for(records)

    def test_exact_reviewed_native_defaults_are_accepted_without_mutating_runtime(self):
        config, records = fixture()
        before = copy.deepcopy(records)
        REPAIR.require_matching_command_environment(config, records, self.images(records))
        for rollback in (False, True):
            pinned = REPAIR.pinned_compose(config, records, rollback=rollback)
            for name in REPAIR.TARGETS:
                self.assertEqual({key: pinned["services"][name][key] for key in REPAIR.PINNED_NATIVE_FIELDS}, REPAIR.PINNED_NATIVE_FIELDS)
        self.assertEqual(records, before)

    def test_only_observed_present_empty_dns_fields_are_canonicalized_without_mutation(self):
        config, original = fixture()
        images = self.images(original)
        for fields in (("Dns",), ("DnsOptions",), ("DnsSearch",), ("Dns", "DnsOptions", "DnsSearch")):
            records = copy.deepcopy(original)
            for field in fields:
                records["postgres"]["HostConfig"][field] = None
            before = copy.deepcopy(records)
            with self.subTest(fields=fields):
                REPAIR.require_matching_command_environment(config, records, images)
                self.assertEqual(REPAIR.preserved_config(original["postgres"]), REPAIR.preserved_config(records["postgres"]))
                self.assertEqual(records, before)

    def test_dns_canonicalization_does_not_hide_missing_malformed_or_nonempty_settings(self):
        for field in ("Dns", "DnsOptions", "DnsSearch"):
            for kind, value in (("missing", None), ("nonempty", ["changed"]), ("string", ""),
                                ("boolean", False), ("number", 0), ("map", {})):
                _, records = fixture()
                original = copy.deepcopy(records["postgres"])
                if kind == "missing":
                    del records["postgres"]["HostConfig"][field]
                else:
                    records["postgres"]["HostConfig"][field] = value
                with self.subTest(field=field, kind=kind), self.assertRaises(REPAIR.Refused):
                    REPAIR.require_native_runtime_settings(records)
                self.assertNotEqual(REPAIR.preserved_config(original), REPAIR.preserved_config(records["postgres"]))
        for field, value in (("Devices", []), ("ExtraHosts", None), ("Memory", None), ("SecurityOpt", [])):
            _, records = fixture()
            records["postgres"]["HostConfig"][field] = value
            with self.subTest(field=field), self.assertRaises(REPAIR.Refused):
                REPAIR.require_native_runtime_settings(records)

    def test_unique_environment_order_is_benign_and_literal_values_are_unchanged(self):
        config, original = fixture()
        original["postgres"]["Config"]["Env"] += ["PATH=/literal/path", "LITERAL=one$two$$three=tail", "EMPTY="]
        records = copy.deepcopy(original)
        records["postgres"]["Config"]["Env"].reverse()
        before = copy.deepcopy(records)
        REPAIR.require_matching_command_environment(config, records, self.images(original))
        self.assertEqual(REPAIR.preserved_config(original["postgres"]), REPAIR.preserved_config(records["postgres"]))
        self.assertEqual(records, before)
        self.assertEqual(REPAIR.unique_environment(records["postgres"]["Config"]["Env"])["LITERAL"], "one$two$$three=tail")
        # This repair does not canonicalize other ordered execution metadata.
        for field in ("Cmd", "Entrypoint"):
            changed = copy.deepcopy(original["postgres"])
            changed["Config"][field] = ["second", "first"]
            baseline = copy.deepcopy(changed)
            baseline["Config"][field].reverse()
            with self.subTest(field=field):
                self.assertNotEqual(REPAIR.preserved_config(baseline), REPAIR.preserved_config(changed))

    def test_environment_parser_rejects_duplicates_and_malformed_entries_before_projection(self):
        invalid = [None, {}, "KEY=value", [None], ["MISSING_EQUALS"], ["=empty"], ["1BAD=value"],
                   ["BAD-NAME=value"], ["HAS SPACE=value"], ["BAD\nNAME=value"], ["KEY=bad\0value"],
                   ["TEST=do-not-print-this", "TEST=do-not-print-this"], ["TEST=first", "TEST=second"]]
        for value in invalid:
            config, records = fixture()
            images = self.images(records)
            records["postgres"]["Config"]["Env"] = value
            with self.subTest(value=value):
                with self.assertRaises(REPAIR.Refused):
                    REPAIR.unique_environment(value)
                with self.assertRaises(REPAIR.Refused):
                    REPAIR.preserved_config(records["postgres"])
                with self.assertRaises(REPAIR.Refused):
                    REPAIR.require_matching_command_environment(config, records, images)
        config, records = fixture()
        images = self.images(records)
        images["postgres"]["Config"]["Env"] += ["TEST=conflict"]
        with self.assertRaises(REPAIR.Refused):
            REPAIR.require_matching_command_environment(config, records, images)

    def test_environment_canonicalization_retains_value_addition_and_removal_drift(self):
        config, original = fixture()
        original["postgres"]["Config"]["Env"] += ["LITERAL=one$two$$three=tail"]
        images = self.images(original)
        for env in (["TEST=changed", "LITERAL=one$two$$three=tail"],
                    original["postgres"]["Config"]["Env"] + ["ADDED=value"],
                    ["TEST=do-not-print-this"],
                    ["TEST=do-not-print-this", "LITERAL=one$two$three=tail"]):
            records = copy.deepcopy(original)
            records["postgres"]["Config"]["Env"] = env
            with self.subTest(env=env):
                self.assertNotEqual(REPAIR.preserved_config(original["postgres"]), REPAIR.preserved_config(records["postgres"]))
                with self.assertRaisesRegex(REPAIR.Refused, "environment drift"):
                    REPAIR.require_matching_command_environment(config, records, images)

    def test_resource_security_and_unknown_runtime_fields_refuse_candidate_and_rollback_pre_up(self):
        changes = {"Memory": 536870912, "MemoryReservation": 104857600, "NanoCpus": 1000000000,
                   "ShmSize": 1073741824, "ReadonlyRootfs": True, "Privileged": True,
                   "CapAdd": ["NET_ADMIN"], "CapDrop": ["ALL"], "SecurityOpt": ["no-new-privileges"],
                   "Ulimits": [{"Name": "nofile", "Hard": 4096, "Soft": 4096}],
                   "Runtime": "custom", "IpcMode": "host", "CgroupnsMode": "host",
                   "MaskedPaths": [], "ReadonlyPaths": [], "OomKillDisable": True,
                   "Devices": [{"PathOnHost": "/dev/example"}], "UsernsMode": "host",
                   "MemorySwappiness": 0, "Init": True, "FutureSecurityControl": None}
        for name in REPAIR.TARGETS:
            for field, value in changes.items():
                config, records = fixture()
                images = self.images(records)
                records[name]["HostConfig"][field] = value
                with self.subTest(service=name, field=field), self.assertRaisesRegex(REPAIR.Refused, "unsupported resource/security/runtime"):
                    REPAIR.require_matching_command_environment(config, records, images)
                for rollback in (False, True):
                    with self.subTest(service=name, field=field, rollback=rollback), self.assertRaisesRegex(REPAIR.Refused, "unsupported resource/security/runtime"):
                        REPAIR.pinned_compose(config, records, rollback=rollback)
        config, records = fixture()
        records["postgres"]["HostConfig"]["Memory"] = False
        with self.assertRaises(REPAIR.Refused):
            REPAIR.require_native_runtime_settings(records)
        config, records = fixture()
        del records["postgres"]["HostConfig"]["Memory"]
        with self.assertRaises(REPAIR.Refused):
            REPAIR.require_native_runtime_settings(records)

    def test_unknown_or_nondefault_config_flags_and_image_port_volume_metadata_refuse(self):
        changes = {"AttachStdin": True, "AttachStdout": False, "AttachStderr": False,
                   "OpenStdin": True, "StdinOnce": True, "Tty": True, "StopTimeout": 40,
                   "NetworkDisabled": True, "Shell": ["/bin/custom"], "FutureExecutionControl": False,
                   "ExposedPorts": {"9999/tcp": {}}, "Volumes": {"/unrepresented": {}}}
        for field, value in changes.items():
            config, records = fixture()
            images = self.images(records)
            records["postgres"]["Config"][field] = value
            with self.subTest(field=field), self.assertRaises(REPAIR.Refused):
                REPAIR.require_matching_command_environment(config, records, images)
        config, records = fixture()
        for name, port in (("postgres", "5432/tcp"), ("redis", "6379/tcp")):
            records[name]["Config"]["ExposedPorts"] = {port: {}}
        records["postgres"]["Config"]["Volumes"] = {"/var/lib/postgresql/data": {}}
        REPAIR.require_matching_command_environment(config, records, self.images(records))

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
            self.assertEqual(rollback["services"][name]["logging"], {"driver": "json-file"})
            self.assertNotIn("depends_on", candidate["services"][name])
        config["services"]["postgres"]["build"] = {"context": "."}
        with self.assertRaisesRegex(REPAIR.Refused, "Unsupported"):
            REPAIR.pinned_compose(config, records, rollback=False)

    def test_rejects_environment_command_and_image_execution_drift(self):
        config, records = fixture()
        images = self.images(records)
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

    def test_redis_info_uses_explicit_raw_and_stdin_only_authentication(self):
        _, records = fixture()
        record = records["redis"]
        password = record["Config"]["Cmd"][record["Config"]["Cmd"].index("--requirepass") + 1]
        for section, header in (("persistence", "# Persistence"), ("keyspace", "# Keyspace")):
            for newline in ("\r\n", "\n"):
                value = header + newline + newline
                with self.subTest(section=section, newline=newline), \
                        patch.object(REPAIR, "command", return_value=value.encode()) as native:
                    self.assertEqual(REPAIR.redis_command(Path("."), record, "INFO", section), value)
                args = native.call_args.args[1]
                self.assertEqual(args[-3:], ["--raw", "INFO", section])
                self.assertNotIn("--json", args)
                self.assertIn('redis-cli --no-auth-warning -e "$@"', args[6])
                self.assertNotIn(password, " ".join(args))
                self.assertEqual(native.call_args.kwargs["data"], (password + "\n").encode())

    def test_redis_structured_replies_stay_json_without_raw_fallback(self):
        _, records = fixture()
        cases = ((('CONFIG', 'GET', 'appendonly'), b'{"appendonly":"yes"}', {"appendonly": "yes"}),
                 (('CONFIG', 'GET', 'appendonly'), b'["appendonly","yes"]', ["appendonly", "yes"]),
                 (('DBSIZE',), b'1\n', 1), (('EVAL_RO', 'return {}', '0'), b'["0",[]]', ["0", []]))
        for arguments, raw, expected in cases:
            with self.subTest(arguments=arguments), patch.object(REPAIR, "command", return_value=raw) as native:
                self.assertEqual(REPAIR.redis_command(Path("."), records["redis"], *arguments), expected)
                self.assertIn("--json", native.call_args.args[1])
                self.assertNotIn("--raw", native.call_args.args[1])
        with patch.object(REPAIR, "command", return_value=b'not-json'), self.assertRaises(json.JSONDecodeError):
            REPAIR.redis_command(Path("."), records["redis"], "DBSIZE")

    def test_redis_info_refuses_wrong_sections_errors_and_invalid_encoding(self):
        _, records = fixture()
        for raw in (b'', b'ERR not allowed\n', b'# Keyspace\r\n', b'# Persistence\r\n\xff'):
            with self.subTest(raw=raw), patch.object(REPAIR, "command", return_value=raw), \
                    self.assertRaises(REPAIR.Refused):
                REPAIR.redis_command(Path("."), records["redis"], "INFO", "persistence")

    def test_redis_snapshot_decodes_native_info_text_and_json_at_the_command_boundary(self):
        _, records = fixture()
        settings = {"appendonly": "yes", "appendfsync": "everysec", "dir": "/data", "appenddirname": "appendonlydir"}
        persistence = b"# Persistence\r\nloading:0\r\naof_enabled:1\r\naof_rewrite_in_progress:0\r\naof_last_write_status:ok\r\naof_last_bgrewrite_status:ok\r\n"
        responses = [json.dumps(settings).encode(), persistence, b"# Keyspace\r\ndb0:keys=1,expires=0\r\n", b"1\n",
                     json.dumps(["0", [["a" * 40, "b" * 40, -1]]]).encode()]
        with patch.object(REPAIR, "command", side_effect=responses) as native:
            snapshot = REPAIR.redis_snapshot(Path("."), records["redis"])
        self.assertEqual(snapshot["keys"], {"a" * 40: {"hash": "b" * 40, "expires_at_ms": None}})
        self.assertEqual(snapshot["aof"], settings)
        self.assertEqual(native.call_count, 5)
        self.assertEqual([call.args[1][-3:] for call in native.call_args_list[1:3]],
                         [["--raw", "INFO", "persistence"], ["--raw", "INFO", "keyspace"]])
        self.assertIn("EVAL_RO", native.call_args_list[-1].args[1])

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

    def test_redis_stream_snapshot_hashes_full_serialization_without_exporting_payload_or_raising_bounds(self):
        script = REPAIR.REDIS_SNAPSHOT
        self.assertIn("elseif kind == 'stream' then", script)
        self.assertIn("redis.call('DUMP', key)", script)
        self.assertIn("if #serialized > 1048576 then", script)
        self.assertIn("value = redis.sha1hex(serialized)", script)
        self.assertIn("redis.sha1hex(cjson.encode({kind, value}))", script)
        self.assertIn("redis.call('PTTL', key)", script)
        for mutation in ("RESTORE", "DEL", "XADD", "XREADGROUP", "XACK", "XGROUP"):
            self.assertNotIn("redis.call('" + mutation + "'", script)


@unittest.skipUnless(shutil.which("docker"), "Docker Compose CLI required for config-only serialization regression")
class RepairNativeComposeExportTests(unittest.TestCase):
    def test_native_pinned_candidate_and_rollback_roundtrips_with_poisoned_dotenv(self):
        docker = shutil.which("docker")
        available = subprocess.run([docker, "compose", "version", "--short"], capture_output=True, timeout=15)
        if available.returncode:
            self.skipTest("Docker Compose CLI plugin unavailable")
        config, records = fixture()
        with tempfile.TemporaryDirectory() as directory:
            outer = Path(directory)
            (outer / ".env").write_text("COMPOSE_REMOVE_ORPHANS=true\nCOMPOSE_PROFILES=*\nCOMPOSE_FILE=/poison.yml\n")
            args = [docker, "compose", "--project-name", "rybbit", "--project-directory", directory,
                    "--env-file", os.devnull, "-f", "-", "config", "--format", "json"]
            env = dict(os.environ, **REPAIR.CLI_ENVIRONMENT)

            def render(source):
                result = subprocess.run(args, input=json.dumps(source).encode(), cwd=outer,
                                        capture_output=True, env=env, timeout=20)
                self.assertEqual(result.returncode, 0, "Config-only native profile roundtrip failed; no up/run/pull requested")
                return REPAIR.decode_compose_export(result.stdout)

            # Generate from the CLI's canonical export, exactly as plan() does.
            canonical = render(config)
            for rollback in (False, True):
                pinned = REPAIR.pinned_compose(canonical, records, rollback=rollback)
                with self.subTest(rollback=rollback):
                    self.assertEqual(render(REPAIR.compose_literals(pinned)), pinned)

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
        self.probe_docker = ProbeDockerFixture(self.events)
        self.fail_service = None
        self.config_drift = False
        self.native_representations = False
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
        helper = self.probe_docker.command(args)
        if helper is not None:
            return helper
        if args[:2] in (["docker", "version"], ["docker", "inspect"], ["docker", "image"]) or args == ["docker", "compose", "version", "--short"]:
            return read_only_response(self.config, self.records, args)
        if "config" in args:
            if any("candidate.compose.json" in item for item in args):
                value = REPAIR.pinned_compose(self.config, self.records, rollback=False)
                return json.dumps(value).encode()
            if any("rollback.compose.json" in item for item in args):
                value = REPAIR.pinned_compose(self.config, self.records, rollback=True)
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
            if self.native_representations:
                for field in ("Dns", "DnsOptions", "DnsSearch"):
                    self.records[name]["HostConfig"][field] = None
                self.records[name]["Config"]["Env"].reverse()
            if self.config_drift:
                self.records[name]["Mounts"][0]["Name"] = "different-data"
            return b""
        raise AssertionError(args)

    def run_apply(self, **kwargs):
        return REPAIR.reconcile(self.repo, apply=True, owner="test-token-123", ack=REPAIR.ACK,
                                backup_manifest=self.outer / "manifest.json", audit_root=self.outer / "audit", **kwargs)

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
        recovery = json.loads((audit / "recovery.json").read_text())["configurationRollbackOnly"]
        self.assertEqual(recovery[:len(REPAIR.pinned_compose_command(audit / "rollback.compose.json"))],
                         REPAIR.pinned_compose_command(audit / "rollback.compose.json"))
        for call in (*mutations, recovery):
            self.assertEqual(call[:2], ["/usr/bin/env", "-i"])
            self.assertIn("COMPOSE_REMOVE_ORPHANS=false", call)
            self.assertIn("COMPOSE_IGNORE_ORPHANS=true", call)
            self.assertEqual(call[call.index("--env-file") + 1], "/dev/null")
            self.assertIn("--no-build", call)
            self.assertEqual(call[call.index("--pull") + 1], "never")
            self.assertNotIn("--remove-orphans", call)
        self.assertEqual(self.events[:3], [("sync", audit.parent.parent), ("sync", audit), ("sync", audit.parent)])
        lifecycle = [event for event in self.events if event[0] in ("probe-create", "probe-remove", "up")]
        self.assertEqual(lifecycle, [("probe-create", "postgres"), ("probe-remove", "postgres"),
                                     ("probe-create", "redis"), ("probe-remove", "redis"),
                                     ("up", "postgres"), ("up", "redis")])
        self.assertEqual(self.probe_docker.helpers, {})
        self.assertEqual(self.events[-2:], [("sync", audit), ("sync", audit.parent)])

    def test_apply_accepts_only_observed_dns_spelling_and_unique_environment_reordering(self):
        self.native_representations = True
        for name in REPAIR.TARGETS:
            self.records[name]["Config"]["Env"] += ["PATH=/literal/path", "LITERAL=one$two$$three=tail"]
        before = copy.deepcopy(self.records)
        audit = self.run_apply()
        self.assertEqual([call[-1] for call in self.calls if "up" in call], ["postgres", "redis"])
        for name in REPAIR.TARGETS:
            self.assertEqual(self.records[name]["Config"]["Env"], list(reversed(before[name]["Config"]["Env"])))
            self.assertEqual(REPAIR.preserved_config(before[name]), REPAIR.preserved_config(self.records[name]))
            self.assertTrue(all(self.records[name]["HostConfig"][field] is None for field in ("Dns", "DnsOptions", "DnsSearch")))
        self.assertTrue((audit / "success.json").exists())
        self.assertEqual(self.records["backend"], before["backend"])

    def test_historical_guard_runs_under_four_locks_in_order_and_archives_json_evidence(self):
        self.records["postgres"]["HostConfig"]["LogConfig"] = copy.deepcopy(EXPECTED_RUNTIME_LOGGING)
        self.native_representations = True
        self.records["redis"]["Config"]["Env"] += ["PATH=/literal/path"]
        active = set()
        phases = []

        @contextmanager
        def lock(path, owner):
            active.add(path)
            try:
                yield
            finally:
                active.remove(path)

        def guard(records, phase):
            self.assertEqual(len(active), 4)
            self.assertEqual(records["backend"]["State"]["Status"], "exited")
            self.assertIs(records["backend"]["State"]["Running"], False)
            phases.append(phase)
            replacements = [call[-1] for call in self.calls if "up" in call]
            self.assertEqual(replacements, ["redis"] if phase == "after" else [])
            records["postgres"]["Config"]["Env"] = ["MUTATED=must-not-reach-baseline"]
            return {"phase": phase, "historicalProof": True, "backendStarted": False}

        with patch.object(REPAIR, "lock_file", side_effect=lock):
            audit = self.run_apply(recovery_guard=guard)
        self.assertEqual(phases, ["preflight", "before-redis", "after"])
        self.assertEqual(active, set())
        for suffix, phase in (("before", "preflight"), ("before-redis", "before-redis"), ("after", "after")):
            evidence = json.loads((audit / ("historical-recovery." + suffix + ".json")).read_text())
            self.assertEqual(evidence, {"phase": phase, "historicalProof": True, "backendStarted": False})
        self.assertTrue((audit / "success.json").exists())
        self.assertNotIn("MUTATED=must-not-reach-baseline", self.records["postgres"]["Config"]["Env"])

    def test_historical_guard_refuses_any_drift_other_than_exactly_redis_including_none(self):
        baseline = copy.deepcopy(self.records)
        for drift in ((), ("postgres",), ("postgres", "redis"), ("client",), ("redis", "client")):
            self.records = copy.deepcopy(baseline)
            self.calls = []
            for name, record in self.records.items():
                record["HostConfig"]["LogConfig"] = copy.deepcopy(EXPECTED_RUNTIME_LOGGING)
                if name in drift:
                    record["HostConfig"]["LogConfig"]["Config"] = {}
            guard = unittest.mock.Mock(return_value={"proof": True})
            with self.subTest(drift=drift), self.assertRaises(REPAIR.Refused):
                self.run_apply(recovery_guard=guard)
            guard.assert_not_called()
            self.assertFalse(any("up" in call or "create" in call for call in self.calls))
            self.assertFalse((self.outer / "audit").exists())

    def test_historical_guard_requires_apply_and_callable_before_any_native_check(self):
        for apply, guard in ((False, lambda *args: {}), (True, "not-a-callable")):
            with self.subTest(apply=apply), self.assertRaisesRegex(REPAIR.Refused, "requires apply"):
                REPAIR.reconcile(self.repo, apply=apply, recovery_guard=guard)
            self.assertEqual(self.calls, [])

    def test_historical_guard_failure_never_skips_to_success_or_starts_backend(self):
        baseline = copy.deepcopy(self.records)
        for failed_phase in ("preflight", "before-redis", "after"):
            self.records = copy.deepcopy(baseline)
            self.records["postgres"]["HostConfig"]["LogConfig"] = copy.deepcopy(EXPECTED_RUNTIME_LOGGING)
            self.calls = []
            previous_audits = set((self.outer / "audit").iterdir()) if (self.outer / "audit").exists() else set()

            def guard(records, phase):
                if phase == failed_phase:
                    raise REPAIR.Refused("Synthetic historical proof failure")
                return {"phase": phase, "verified": True}

            with self.subTest(phase=failed_phase), self.assertRaisesRegex(REPAIR.Refused, "historical proof failure"):
                self.run_apply(recovery_guard=guard)
            replacements = [call[-1] for call in self.calls if "up" in call]
            self.assertEqual(replacements, ["redis"] if failed_phase == "after" else [])
            self.assertEqual(self.records["backend"], baseline["backend"])
            audits = set((self.outer / "audit").iterdir()) if (self.outer / "audit").exists() else set()
            if failed_phase == "preflight":
                self.assertEqual(audits, previous_audits)
            else:
                audit, = audits - previous_audits
                self.assertTrue((audit / "failure.json").exists())
                self.assertFalse((audit / "success.json").exists())

    def test_historical_guard_rejects_non_json_evidence_before_backup_or_replacement(self):
        self.records["postgres"]["HostConfig"]["LogConfig"] = copy.deepcopy(EXPECTED_RUNTIME_LOGGING)
        for evidence in ({"invalid": object()}, {"invalid": float("nan")}, {"invalid": float("inf")}):
            with self.subTest(evidence=evidence), patch.object(REPAIR, "verify_backup") as backup, \
                    self.assertRaisesRegex(REPAIR.Refused, "not JSON-safe"):
                self.run_apply(recovery_guard=lambda *args: evidence)
            backup.assert_not_called()
        self.assertFalse(any("up" in call or "create" in call for call in self.calls))
        self.assertFalse((self.outer / "audit").exists())

    def test_historical_guard_detects_running_backend_and_gate_loss_without_replacement(self):
        self.records["postgres"]["HostConfig"]["LogConfig"] = copy.deepcopy(EXPECTED_RUNTIME_LOGGING)
        self.records["backend"]["State"]["Running"] = True
        guard = unittest.mock.Mock(return_value={"proof": True})
        with self.assertRaises(REPAIR.Refused):
            self.run_apply(recovery_guard=guard)
        guard.assert_not_called()
        self.records["backend"]["State"]["Running"] = False
        gate_lost = False

        def lose_gate(records, phase):
            nonlocal gate_lost
            gate_lost = True
            return {"proof": True}

        def gate(owner):
            if gate_lost:
                raise REPAIR.Refused("Synthetic gate loss")

        with patch.object(REPAIR, "require_gate", side_effect=gate), self.assertRaisesRegex(REPAIR.Refused, "gate loss"):
            self.run_apply(recovery_guard=lose_gate)
        self.assertFalse(any("up" in call or "create" in call for call in self.calls))

    def test_historical_guard_refuses_success_if_backend_is_running_after_redis_replacement(self):
        self.records["postgres"]["HostConfig"]["LogConfig"] = copy.deepcopy(EXPECTED_RUNTIME_LOGGING)
        native = self.command
        phases = []

        def response(repo, args, **kwargs):
            result = native(repo, args, **kwargs)
            if "up" in args:
                self.records["backend"]["State"].update({"Status": "running", "Running": True})
            return result

        def guard(records, phase):
            phases.append(phase)
            return {"phase": phase}

        with patch.object(REPAIR, "command", side_effect=response), self.assertRaisesRegex(REPAIR.Refused, "cleanly stopped"):
            self.run_apply(recovery_guard=guard)
        self.assertEqual(phases, ["preflight", "before-redis"])
        self.assertEqual([call[-1] for call in self.calls if "up" in call], ["redis"])
        audit, = (self.outer / "audit").iterdir()
        self.assertTrue((audit / "failure.json").exists())
        self.assertFalse((audit / "success.json").exists())

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

    def test_runtime_resource_security_and_execution_drift_refuses_before_any_recreation_or_audit(self):
        for section, field, value in (("HostConfig", "Memory", 536870912), ("HostConfig", "ShmSize", 1073741824),
                                      ("HostConfig", "SecurityOpt", ["no-new-privileges"]),
                                      ("HostConfig", "Privileged", True), ("Config", "Tty", True)):
            self.config, self.records = fixture()
            self.records["backend"]["State"].update({"Status": "exited", "Running": False})
            self.records["postgres"][section][field] = value
            self.calls = []
            with self.subTest(section=section, field=field), self.assertRaisesRegex(REPAIR.Refused, "unsupported"):
                self.run_apply()
            self.assertFalse(any("up" in call for call in self.calls))
            self.assertFalse((self.outer / "audit").exists())

    def test_daemon_default_poisoning_refuses_before_any_database_recreation(self):
        for service in REPAIR.TARGETS:
            self.probe_docker = ProbeDockerFixture(self.events)
            def poison(record):
                if record["Name"].endswith("-" + service):
                    record["HostConfig"]["Ulimits"] = [{"Name": "nofile", "Soft": 4096, "Hard": 4096}]
            self.probe_docker.poison = poison
            self.calls = []
            with self.subTest(service=service), self.assertRaisesRegex(REPAIR.Refused, "unsupported resource/security/runtime"):
                self.run_apply()
            self.assertFalse(any("up" in call for call in self.calls))
            self.assertEqual(self.probe_docker.helpers, {})
            self.assertEqual(self.records["backend"]["State"]["Status"], "exited")

    def test_gate_loss_at_first_probe_refuses_without_claiming_maintenance_or_backend_state(self):
        checks = 0
        def gate(owner):
            nonlocal checks
            checks += 1
            if checks == 3:
                raise REPAIR.Refused("Synthetic gate loss at first daemon probe")
        errors = io.StringIO()
        with patch.object(REPAIR, "require_gate", side_effect=gate), patch.object(REPAIR.sys, "stderr", errors), \
                self.assertRaisesRegex(REPAIR.Refused, "gate loss at first daemon probe"):
            self.run_apply()
        self.assertEqual(checks, 3)
        self.assertFalse(any("up" in call or "create" in call for call in self.calls))
        self.assertEqual(self.probe_docker.helpers, {})
        audit = next((self.outer / "audit").iterdir())
        failure = json.loads((audit / "failure.json").read_text())
        self.assertFalse(failure["maintenanceRemovalAttempted"])
        self.assertFalse(failure["backendStartAttempted"])
        self.assertTrue(failure["maintenanceStatusUnconfirmed"])
        self.assertTrue(failure["backendStatusUnconfirmed"])
        self.assertNotIn("maintenanceLeftActive", failure)
        self.assertNotIn("backendStarted", failure)
        self.assertIn("maintenance/backend status is unconfirmed", errors.getvalue())
        self.assertNotIn("maintenance remains active", errors.getvalue())
        self.assertNotIn("backend remains stopped", errors.getvalue().lower())

    def test_resource_drift_between_replacements_prevents_redis_recreation(self):
        native = self.command

        def response(repo, args, **kwargs):
            result = native(repo, args, **kwargs)
            if "up" in args and args[-1] == "postgres":
                self.records["redis"]["HostConfig"]["Memory"] = 536870912
            return result

        with patch.object(REPAIR, "command", side_effect=response), self.assertRaisesRegex(REPAIR.Refused, "unsupported resource/security/runtime"):
            self.run_apply()
        self.assertEqual([call[-1] for call in self.calls if "up" in call], ["postgres"])
        self.assertEqual(self.records["redis"]["HostConfig"]["Memory"], 536870912)
        self.assertEqual(self.records["backend"]["State"]["Status"], "exited")

    def test_rollback_export_source_change_prevents_any_replacement(self):
        native = self.command

        def response(repo, args, **kwargs):
            result = native(repo, args, **kwargs)
            if "config" in args and any("rollback.compose.json" in item for item in args):
                changed = json.loads(result)
                changed["services"]["postgres"]["runtime"] = "changed"
                return json.dumps(changed).encode()
            return result

        with patch.object(REPAIR, "command", side_effect=response), self.assertRaisesRegex(REPAIR.Refused, "Rollback Compose export/source roundtrip"):
            self.run_apply()
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
                self.assertFalse(failure["maintenanceRemovalAttempted"])
                self.assertTrue(failure["maintenanceStatusUnconfirmed"])
                self.assertFalse(failure["backendStartAttempted"])

    def test_data_loss_failure_does_not_attempt_database_restore_or_start_backend(self):
        with patch.object(REPAIR, "compare_data", side_effect=REPAIR.Refused("Synthetic key loss")), self.assertRaises(REPAIR.Refused):
            self.run_apply()
        self.assertEqual([call[-1] for call in self.calls if "up" in call], ["postgres", "redis"])
        self.assertFalse(any("restore" in str(call) or "migrate" in str(call) for call in self.calls))
        self.assertEqual(self.records["backend"]["State"]["Status"], "exited")


if __name__ == "__main__":
    unittest.main()
