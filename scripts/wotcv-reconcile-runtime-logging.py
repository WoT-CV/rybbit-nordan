#!/usr/bin/env python3
"""Check actual container logging; explicitly reconcile only PostgreSQL/Redis.

Default --check has no writes, lock creation, restart, pull or database mutation.
--apply is a separate root-only maintenance operation, NEVER an updater hook.
It requires the caller-owned maintenance gate, a stopped backend, the explicit
acknowledgment and recent protected native-backup evidence. It never starts the
backend (whose entrypoint runs migrations), restores data, or leaves maintenance.
Original pinned configuration and recovery instructions are archived before any
replacement. A failure stays closed for operator-reviewed configuration rollback.
"""

from __future__ import annotations

import argparse
from contextlib import ExitStack, contextmanager
from datetime import datetime, timezone
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))
from wotcv_logging import (  # noqa: E402
    EXPECTED_RUNTIME_LOGGING, SERVICES, runtime_containers,
    validate_compose_logging,
)
from wotcv_persistence import (  # noqa: E402
    VolumeSpec, validate_compose_config, validate_container_mounts,
)
MAINTENANCE_SPEC = importlib.util.spec_from_file_location(
    "runtime_logging_maintenance_contract", Path(__file__).with_name("wotcv-maintenance.py"))
MAINTENANCE = importlib.util.module_from_spec(MAINTENANCE_SPEC)
MAINTENANCE_SPEC.loader.exec_module(MAINTENANCE)


PROJECT = "rybbit"
DEPLOY_USER = "wotcv"
ACK = "maintenance-window-backup-verified"
GATE = MAINTENANCE.DIRECTORY / "active"
TARGETS = ("postgres", "redis")
SPECS = (
    VolumeSpec("clickhouse-data", "clickhouse", "/var/lib/clickhouse", "rybbit_clickhouse-data"),
    VolumeSpec("postgres-data", "postgres", "/var/lib/postgresql/data", "rybbit_postgres-data"),
    VolumeSpec("redis-data", "redis", "/data", "rybbit_redis-data"),
)
IMAGE_ID = re.compile(r"sha256:[0-9a-f]{64}\Z")
CONTAINER_ID = re.compile(r"[0-9a-f]{64}\Z")
SHA256 = re.compile(r"[0-9a-f]{64}\Z")
MAX_BACKUP_AGE = 6 * 60 * 60
# This is a bounded, one-off repair for the inspected native production
# profile, NOT a portable Docker-defaults table. Any other engine/CLI or new
# inspect field requires review before a database can be replaced or rolled
# back. In particular, never infer a missing/unknown setting from a falsey
# value: an unrepresented security/resource control must fail before `up`.
NATIVE_ENGINE = "29.9.2|linux|amd64"
NATIVE_COMPOSE = "5.6.1"
ENGINE_FORMAT = "{{.Server.Version}}|{{.Server.Os}}|{{.Server.Arch}}"
CLI_ENVIRONMENT = {
    "PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C", "LC_ALL": "C",
    "DOCKER_HOST": "unix:///var/run/docker.sock",
    "COMPOSE_REMOVE_ORPHANS": "false", "COMPOSE_IGNORE_ORPHANS": "true",
    "COMPOSE_DISABLE_ENV_FILE": "true", "COMPOSE_ENV_FILES": "",
    "COMPOSE_PROFILES": "", "COMPOSE_BAKE": "false", "COMPOSE_MENU": "false",
    "COMPOSE_EXPERIMENTAL": "false", "COMPOSE_PARALLEL_LIMIT": "1",
}
NATIVE_HOST_CONFIG = {
    "AutoRemove": False, "BlkioDeviceReadBps": None, "BlkioDeviceReadIOps": None,
    "BlkioDeviceWriteBps": None, "BlkioDeviceWriteIOps": None, "BlkioWeight": 0,
    "BlkioWeightDevice": None, "CapAdd": None, "CapDrop": None, "Cgroup": "",
    "CgroupParent": "", "CgroupnsMode": "private", "ConsoleSize": [0, 0],
    "ContainerIDFile": "", "CpuCount": 0, "CpuPercent": 0, "CpuPeriod": 0,
    "CpuQuota": 0, "CpuRealtimePeriod": 0, "CpuRealtimeRuntime": 0, "CpuShares": 0,
    "CpusetCpus": "", "CpusetMems": "", "DeviceCgroupRules": None,
    "DeviceRequests": None, "Devices": None, "Dns": [], "DnsOptions": [],
    "DnsSearch": [], "ExtraHosts": [], "GroupAdd": None, "IOMaximumBandwidth": 0,
    "IOMaximumIOps": 0, "IpcMode": "private", "Isolation": "", "Links": None,
    "MaskedPaths": ["/proc/acpi", "/proc/asound", "/proc/interrupts", "/proc/kcore",
                    "/proc/keys", "/proc/latency_stats", "/proc/sched_debug", "/proc/scsi",
                    "/proc/timer_list", "/proc/timer_stats", "/sys/devices/virtual/powercap",
                    "/sys/firmware"],
    "Memory": 0, "MemoryReservation": 0, "MemorySwap": 0, "MemorySwappiness": None,
    "NanoCpus": 0, "OomKillDisable": None, "OomScoreAdj": 0, "PidMode": "",
    "PidsLimit": None, "Privileged": False, "PublishAllPorts": False,
    "ReadonlyPaths": ["/proc/bus", "/proc/fs", "/proc/irq", "/proc/sys", "/proc/sysrq-trigger"],
    "ReadonlyRootfs": False, "Runtime": "runc", "SecurityOpt": None,
    "ShmSize": 67108864, "UTSMode": "", "Ulimits": None, "UsernsMode": "",
    "VolumeDriver": "", "VolumesFrom": None,
}
# These are represented and independently compared to the candidate below.
REPRESENTED_HOST_FIELDS = {"Binds", "Mounts", "PortBindings", "NetworkMode", "RestartPolicy", "LogConfig"}
NATIVE_ATTACH_CONFIG = {"AttachStdin": False, "AttachStdout": True, "AttachStderr": True,
                        "OpenStdin": False, "StdinOnce": False, "Tty": False}
PINNED_NATIVE_FIELDS = {"runtime": "runc", "ipc": "private", "cgroup": "private", "shm_size": "67108864"}
REPRESENTED_CONFIG_FIELDS = {
    "Cmd", "Domainname", "Entrypoint", "Env", "ExposedPorts", "Healthcheck", "Hostname",
    "Image", "Labels", "StopSignal", "User", "Volumes", "WorkingDir",
}
PROBE_LABEL = "io.wotcv.runtime-logging-probe"
# Additional `docker create` spellings on the reviewed Engine/CLI. Normalize
# ONLY these probe-copy alternatives; canonical_host_config separately handles
# the three observed empty-DNS spellings for production and probe records.
PROBE_NATIVE_SPELLINGS = {
    "BlkioDeviceReadBps": [], "BlkioDeviceReadIOps": [], "BlkioDeviceWriteBps": [],
    "BlkioDeviceWriteIOps": [], "BlkioWeightDevice": [], "Devices": [],
    "ExtraHosts": None, "OomKillDisable": False,
}
PG_SNAPSHOT = '''SELECT json_build_object(
 'system_identifier', (SELECT system_identifier::text FROM pg_control_system()),
 'database', current_database(), 'users', (SELECT count(*) FROM "user"),
 'sites', (SELECT count(*) FROM sites), 'aliases', (SELECT count(*) FROM user_aliases),
 'alias', (SELECT row_to_json(a) FROM (SELECT site_id, anonymous_id, user_id
 FROM user_aliases ORDER BY id DESC LIMIT 1) a));'''
REDIS_SNAPSHOT = '''local scan = redis.call('SCAN', ARGV[1], 'COUNT', 256)
local out = {}
for _, key in ipairs(scan[2]) do
  local kind = redis.call('TYPE', key).ok
  if kind ~= 'none' then
    if redis.call('MEMORY', 'USAGE', key) > 1048576 then
      return redis.error_reply('Maintenance key size bound exceeded')
    end
    local value
    if kind == 'string' then value = redis.call('GET', key)
    elseif kind == 'list' then value = redis.call('LRANGE', key, 0, -1)
    elseif kind == 'zset' then value = redis.call('ZRANGE', key, 0, -1, 'WITHSCORES')
    elseif kind == 'set' then value = redis.call('SMEMBERS', key); table.sort(value)
    elseif kind == 'hash' then
      local fields = redis.call('HKEYS', key); table.sort(fields); value = {}
      for _, field in ipairs(fields) do
        table.insert(value, field); table.insert(value, redis.call('HGET', key, field))
      end
    elseif kind == 'stream' then
      -- DUMP includes stream/group/pending state, unlike XRANGE alone. Keep
      -- binary payload inside Redis; export only its digest and compare under
      -- the same pinned image. Expiry is checked independently via PTTL.
      -- Serialization is deliberately strict, not promised canonical: an
      -- equivalent reload may refuse and needs review, never skipped fields.
      local serialized = redis.call('DUMP', key)
      if type(serialized) ~= 'string' then
        return redis.error_reply('Maintenance stream serialization is invalid')
      end
      if #serialized > 1048576 then
        return redis.error_reply('Maintenance serialized key size bound exceeded')
      end
      value = redis.sha1hex(serialized)
    else return redis.error_reply('Unsupported maintenance key type') end
    table.insert(out, {redis.sha1hex(key), redis.sha1hex(cjson.encode({kind, value})), redis.call('PTTL', key)})
  end
end
return {scan[1], out}'''


class Refused(RuntimeError):
    """Only fixed, credential-free messages may be surfaced to the operator."""


def environment(repo: Path) -> dict[str, str]:
    # Never inherit Docker contexts, Compose overrides, BASH_ENV or user PATH
    # into a root maintenance operation. Read .env only through Compose.
    # Shell values win over .env; pin lifecycle controls even while rendering
    # the original explicit --env-file (which may contain Compose controls).
    env = dict(CLI_ENVIRONMENT)
    state = repo / ".wotcv-deployment.env"
    if state.exists():
        tags = [line.split("=", 1)[1] for line in state.read_text().splitlines()
                if line.startswith("LAST_IMAGE_TAG=")]
        if tags and re.fullmatch(r"sha-[0-9a-f]{40}", tags[-1]):
            env["IMAGE_TAG"] = tags[-1]
    if "IMAGE_TAG" not in env:
        raise Refused("A deployed immutable LAST_IMAGE_TAG is required; no image tag is guessed")
    return env


def command(repo: Path, args: list[str], *, data: bytes | None = None, stdin=None, timeout=90) -> bytes:
    result = subprocess.run(args, cwd=repo, env=environment(repo), input=data,
                            stdin=stdin, capture_output=True, timeout=timeout)
    if result.returncode:
        raise Refused("Maintenance command failed; native output withheld")
    return result.stdout


def compose(repo: Path) -> list[str]:
    return ["docker", "compose", "--project-directory", str(repo), "--env-file", str(repo / ".env"),
            "--project-name", PROJECT, "-f", str(repo / "docker-compose.yml"),
            "-f", str(repo / "docker-compose.wotcv.yml")]


def pinned_compose_command(path: Path) -> list[str]:
    """The same self-contained, poison-resistant argv is archived for recovery.

    Explicit /dev/null prevents both cwd and project dotenv discovery. env -i
    also protects a later operator invocation, outside command()'s clean env.
    The protected audit directory contains no Docker client config/proxy file.
    A version guard keeps this reviewed native profile bounded on rollback too.
    """
    env = dict(CLI_ENVIRONMENT, DOCKER_CONFIG=str(path.parent))
    guard = (f"wotcv_engine=$(docker version --format '{ENGINE_FORMAT}'); "
             f'test "$wotcv_engine" = "{NATIVE_ENGINE}"; '
             'wotcv_compose=$(docker compose version --short); '
             f'test "$wotcv_compose" = "{NATIVE_COMPOSE}"; '
             'exec docker compose "$@"')
    return ["/usr/bin/env", "-i", *(f"{key}={value}" for key, value in env.items()),
            "/bin/sh", "-ec", guard, "wotcv-runtime-logging",
            "--project-directory", str(path.parent), "--env-file", "/dev/null",
            "--project-name", PROJECT, "-f", str(path)]


def isolated_docker_command(audit: Path, args: list[str]) -> list[str]:
    env = dict(CLI_ENVIRONMENT, DOCKER_CONFIG=str(audit))
    return ["/usr/bin/env", "-i", *(f"{key}={value}" for key, value in env.items()), "docker", *args]


def require_native_cli(repo: Path) -> None:
    engine = command(repo, ["docker", "version", "--format", ENGINE_FORMAT]).decode().strip()
    cli = command(repo, ["docker", "compose", "version", "--short"]).decode().strip()
    if engine != NATIVE_ENGINE or cli != NATIVE_COMPOSE:
        raise Refused("Database logging repair requires the reviewed native Docker/Compose versions")


def canonical_host_config(value: dict) -> dict:
    """Normalize only proven empty-DNS spellings, retaining absent fields.

    On the reviewed native Engine/Compose, database recreation changed these
    three explicitly empty DNS fields from [] to null. Both mean no requested
    override. No other null/empty, missing-field or security/resource setting
    is interchangeable; keep all of those visible to the strict guards.
    """
    result = copy.deepcopy(value)
    for field in ("Dns", "DnsOptions", "DnsSearch"):
        if field in result and result[field] is None:
            result[field] = []
    return result


def require_native_runtime_record(record: dict, *, probe=False) -> None:
    native = {key: value for key, value in canonical_host_config(record["HostConfig"]).items()
              if key not in REPRESENTED_HOST_FIELDS}
    if probe:
        native = copy.deepcopy(native)
        for field, alternative in PROBE_NATIVE_SPELLINGS.items():
            if field in native and type(native[field]) is type(alternative) and native[field] == alternative:
                native[field] = copy.deepcopy(NATIVE_HOST_CONFIG[field])
    # JSON comparison is type-strict (False must not accidentally equal 0).
    if json.dumps(native, sort_keys=True) != json.dumps(NATIVE_HOST_CONFIG, sort_keys=True):
        raise Refused("Database HostConfig has unsupported resource/security/runtime settings; nothing recreated")
    native = {key: value for key, value in record["Config"].items() if key not in REPRESENTED_CONFIG_FIELDS}
    if json.dumps(native, sort_keys=True) != json.dumps(NATIVE_ATTACH_CONFIG, sort_keys=True):
        raise Refused("Database Config has unsupported execution/attachment settings; nothing recreated")


def require_native_runtime_settings(records: dict) -> None:
    for name in TARGETS:
        require_native_runtime_record(records[name])


def database_images(repo: Path, records: dict) -> dict:
    images = {}
    for name in TARGETS:
        image = json.loads(command(repo, ["docker", "image", "inspect", records[name]["Image"]]))
        if len(image) != 1 or image[0].get("Id") != records[name]["Image"]:
            raise Refused("Exact database image is unavailable locally; no pull is allowed")
        images[name] = image[0]
    return images


def inspect_native_probe(repo: Path, audit: Path, identifier: str) -> dict:
    values = json.loads(command(repo, isolated_docker_command(audit, ["inspect", identifier])))
    if not isinstance(values, list) or len(values) != 1 or not isinstance(values[0], dict):
        raise Refused("Native daemon probe inspection is ambiguous; operator review required")
    return values[0]


def require_owned_native_probe(record: dict, expected: dict, identifier: str) -> None:
    if (record.get("Id") != identifier or not CONTAINER_ID.fullmatch(identifier)
            or record.get("Name") != "/" + expected["name"] or record.get("Image") != expected["image"]
            or record.get("Config", {}).get("Image") != expected["image"]
            or record.get("Config", {}).get("Labels", {}).get(PROBE_LABEL) != expected["nonce"]
            or record.get("State", {}).get("Status") != "created"
            or record.get("State", {}).get("Running") is not False):
        raise Refused("Native daemon probe ownership or never-started state is unproven; no removal allowed")


def require_isolated_native_probe(record: dict, target: str) -> None:
    host = record["HostConfig"]
    mount = {"Type": "tmpfs", "Source": "", "Destination": target, "Mode": "", "RW": True, "Propagation": ""}
    networks = record.get("NetworkSettings", {}).get("Networks") or {}
    if (record.get("Config", {}).get("Entrypoint") != ["/bin/true"]
            or host.get("NetworkMode") != "none" or set(networks) - {"none"}
            or host.get("Binds") not in (None, []) or host.get("PortBindings") not in (None, {})
            or host.get("RestartPolicy") != {"Name": "no", "MaximumRetryCount": 0}
            or host.get("Mounts") != [{"Type": "tmpfs", "Target": target}]
            or record.get("Mounts") != [mount]):
        raise Refused("Native daemon probe is not the exact isolated tmpfs-only helper; operator review required")


def cleanup_native_probe(repo: Path, audit: Path, expected: dict, identifier: str | None) -> str | None:
    if identifier is None:
        # A CLI failure/timeout may happen after creation. Discover only the
        # unique name AND unguessable operation label, never a production name.
        raw = command(repo, isolated_docker_command(audit, ["ps", "--all", "--no-trunc",
            "--filter", f"label={PROBE_LABEL}={expected['nonce']}",
            "--filter", "name=" + expected["name"], "--format", "{{.ID}}"])).decode().splitlines()
        if not raw:
            return None
        if len(raw) != 1 or not CONTAINER_ID.fullmatch(raw[0]):
            raise Refused("Native daemon probe recovery is ambiguous; no removal allowed")
        identifier = raw[0]
    record = inspect_native_probe(repo, audit, identifier)
    write_json(audit / ("probe-" + expected["service"] + ".cleanup-inspect.json"), record)
    require_owned_native_probe(record, expected, identifier)
    require_isolated_native_probe(record, expected["target"])
    # No --force, --volumes, prune, start, or name-based removal is allowed.
    command(repo, isolated_docker_command(audit, ["rm", identifier]))
    remaining = command(repo, isolated_docker_command(audit, ["ps", "--all", "--no-trunc",
        "--filter", "id=" + identifier, "--format", "{{.ID}}"])).strip()
    if remaining:
        raise Refused("Native daemon probe removal was not confirmed; operator review required")
    return identifier


def probe_native_daemon(repo: Path, audit: Path, records: dict, owner: str) -> None:
    """Exercise current daemon create defaults, NEVER a database or process.

    Docker documents `create` as never starting the container. Explicit tmpfs
    covers the image data directory and prevents anonymous image-volume
    allocation. This pre-start inspection does NOT prove active kernel policy
    (notably AppArmor/seccomp); no helper entrypoint or image CMD is ever run.
    https://docs.docker.com/reference/cli/docker/container/create/
    https://docs.docker.com/engine/storage/tmpfs/
    """
    for spec in SPECS[1:]:
        require_gate(owner)
        nonce = secrets.token_hex(16)
        expected = {"service": spec.service_name, "target": spec.target, "nonce": nonce,
                    "name": f"wotcv-runtime-logging-probe-{nonce}-{spec.service_name}",
                    "image": records[spec.service_name]["Image"]}
        if not IMAGE_ID.fullmatch(expected["image"]):
            raise Refused("Native daemon probe requires the exact inspected immutable database image")
        prefix = "probe-" + spec.service_name
        write_json(audit / (prefix + ".request.json"), expected)
        sync_directory(audit)
        identifier = None
        try:
            raw = command(repo, isolated_docker_command(audit, ["create", "--name", expected["name"],
                "--label", f"{PROBE_LABEL}={nonce}", "--pull", "never", "--entrypoint", "/bin/true",
                "--network", "none", "-a", "stdout", "-a", "stderr", "--runtime", "runc", "--ipc", "private",
                "--cgroupns", "private", "--shm-size", "67108864", "--mount", f"type=tmpfs,dst={spec.target}",
                expected["image"]])).decode().strip()
            if not CONTAINER_ID.fullmatch(raw):
                raise Refused("Native daemon probe create response is unproven; database replacement refused")
            identifier = raw
            record = inspect_native_probe(repo, audit, identifier)
            write_json(audit / (prefix + ".inspect.json"), record)
            require_owned_native_probe(record, expected, identifier)
            require_isolated_native_probe(record, spec.target)
            require_native_runtime_record(record, probe=True)
            if record.get("AppArmorProfile") != "":
                raise Refused("Native daemon probe pre-start AppArmor metadata differs from the reviewed profile")
        finally:
            try:
                removed = cleanup_native_probe(repo, audit, expected, identifier)
            except BaseException:
                try:
                    write_json(audit / (prefix + ".cleanup.json"), {"cleanupConfirmed": False, "operatorReviewRequired": True})
                    sync_directory(audit)
                except BaseException:
                    pass
                raise Refused("Native daemon probe cleanup could not be proven; review the protected audit before recovery") from None
            # An unanswered create can still finish in the daemon after an
            # empty lookup. Absence at that instant is not a cleanup proof.
            write_json(audit / (prefix + ".cleanup.json"), {"cleanupConfirmed": removed is not None,
                       "removedHelperId": removed, "createOutcomeUncertain": removed is None,
                       "operatorReviewRequired": removed is None, "effectiveKernelPolicyProven": False})
            sync_directory(audit)


def inspect_owned(repo: Path) -> dict:
    records = json.loads(command(repo, ["docker", "inspect", *SERVICES]))
    # The maintenance tool, unlike a deployment guard, accepts a stopped backend.
    # All ownership checks still apply; only this one service can be stopped.
    backends = [r for r in records if r.get("Name") == "/backend"]
    if len(backends) != 1:
        raise Refused("Exactly one backend container is required")
    backend = backends[0]
    stopped = backend.get("State", {}).get("Status") == "exited"
    if stopped:
        labels = backend.get("Config", {}).get("Labels", {})
        if (labels.get("com.docker.compose.project") != PROJECT
                or labels.get("com.docker.compose.service") != "backend"
                or labels.get("com.docker.compose.oneoff", "False") not in ("False", "false")
                or backend["State"].get("Running") is not False):
            raise Refused("Stopped backend ownership is invalid")
        selected = tuple(name for name in SERVICES if name != "backend")
        found = dict(runtime_containers([r for r in records if r is not backend], PROJECT, selected))
        found["backend"] = backend
    else:
        found = dict(runtime_containers(records, PROJECT))
    for name, record in found.items():
        if (record.get("Name") != "/" + name or not CONTAINER_ID.fullmatch(record.get("Id", ""))
                or not IMAGE_ID.fullmatch(record.get("Image", ""))):
            raise Refused("Container name or immutable identity is invalid")
        health = record.get("State", {}).get("Health", {}).get("Status")
        if name != "backend" and health not in (None, "healthy"):
            raise Refused("A required service is not healthy")
    return found


def port_bindings(service: dict) -> dict:
    result = {}
    for port in service.get("ports") or []:
        if port.get("host_ip") not in ("127.0.0.1", "::1"):
            raise Refused("Compose publishes a port outside loopback")
        key = str(port["target"]) + "/" + port.get("protocol", "tcp")
        result.setdefault(key, []).append({"HostIp": port["host_ip"], "HostPort": str(port["published"])})
    return result


def validate_storage_and_ports(config: dict, records: dict) -> None:
    validate_compose_logging(config)
    validate_compose_config(config, PROJECT, SPECS)
    for spec in SPECS:
        validate_container_mounts(spec.service_name, PROJECT, PROJECT, spec.expected_name,
                                  spec.target, records[spec.service_name].get("Mounts", []))
    for name in SERVICES:
        desired = port_bindings(config["services"][name])
        if name == "redis" and desired:
            raise Refused("Redis must not publish any host port")
        if (records[name]["HostConfig"].get("PortBindings") or {}) != desired:
            raise Refused("Live and declared port bindings differ; logging-only repair refused")
    validate_database_mounts(config, records)


def validate_database_mounts(config: dict, records: dict) -> None:
    """The candidate must not introduce a bind, subpath, readonly or nocopy change."""
    for spec in SPECS[1:]:
        if (config["services"][spec.service_name].get("container_name") != spec.service_name
                or records[spec.service_name].get("Name") != "/" + spec.service_name):
            raise Refused("Database container names must remain the exact inspected service names")
        declaration = config["volumes"][spec.logical_name]
        if declaration != {"name": spec.expected_name, "external": True}:
            raise Refused("Database external volume declaration has unsupported options")
        mounts = config["services"][spec.service_name].get("volumes")
        if not isinstance(mounts, list) or len(mounts) != 1 or not isinstance(mounts[0], dict):
            raise Refused("Database must declare exactly one data-volume mount")
        mount = mounts[0]
        options = mount.get("volume", {})
        if (set(mount) - {"type", "source", "target", "read_only", "volume"}
                or mount.get("type") != "volume" or mount.get("source") != spec.logical_name
                or mount.get("target") != spec.target or mount.get("read_only", False) is not False
                or not isinstance(options, dict) or set(options) - {"nocopy"} or options.get("nocopy", False) is not False):
            raise Refused("Database declared mount differs from the exact writable data-volume contract")
        actual = records[spec.service_name]
        validate_container_mounts(spec.service_name, PROJECT, PROJECT, spec.expected_name,
                                  spec.target, actual.get("Mounts", []))
        if (len(actual["Mounts"]) != 1 or actual["Mounts"][0].get("Mode", "") not in ("", "rw")
                or actual["Mounts"][0].get("Propagation", "") != ""):
            raise Refused("Database live mount has additional mounts or unsupported options")
        runtime_mounts = actual["HostConfig"].get("Mounts") or []
        if len(runtime_mounts) > 1:
            raise Refused("Database has multiple live HostConfig mounts")
        for runtime_mount in runtime_mounts:
            options = runtime_mount.get("VolumeOptions", {})
            if (set(runtime_mount) - {"Type", "Source", "Target", "ReadOnly", "VolumeOptions"}
                    or runtime_mount.get("Type") != "volume" or runtime_mount.get("Source") != spec.expected_name
                    or runtime_mount.get("Target") != spec.target or runtime_mount.get("ReadOnly", False) is not False
                    or not isinstance(options, dict) or set(options) - {"NoCopy"} or options.get("NoCopy", False) is not False):
                raise Refused("Database live mount options cannot be preserved by this narrow repair")
        binds = actual["HostConfig"].get("Binds") or []
        if binds and binds not in ([f"{spec.expected_name}:{spec.target}"], [f"{spec.expected_name}:{spec.target}:rw"]):
            raise Refused("Database live bind options cannot be preserved by this narrow repair")


def plan(repo: Path) -> tuple[dict, dict, tuple[str, ...]]:
    config = decode_compose_export(command(repo, [*compose(repo), "config", "--format", "json"]))
    records = inspect_owned(repo)
    validate_storage_and_ports(config, records)
    # Do the same read-only eligibility check before an operator stops backend,
    # not only after entering the acknowledged maintenance apply path.
    require_native_cli(repo)
    require_native_runtime_settings(records)
    images = database_images(repo, records)
    require_matching_command_environment(config, records, images)
    pinned_compose(config, records, rollback=False)
    pinned_compose(config, records, rollback=True)
    drift = tuple(name for name in SERVICES
                  if records[name]["HostConfig"].get("LogConfig") != EXPECTED_RUNTIME_LOGGING)
    return config, records, drift


def uid() -> int:
    import pwd
    return pwd.getpwnam(DEPLOY_USER).pw_uid


def require_gate(owner: str) -> None:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", owner or ""):
        raise Refused("An explicit valid maintenance owner token is required")
    info = GATE.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != uid() or info.st_mode & 0o022):
        raise Refused("Maintenance gate must be a protected deployment-user-owned regular file")
    descriptor = os.open(GATE, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "r", encoding="utf-8") as stream:
        opened = os.fstat(stream.fileno())
        if (not stat.S_ISREG(opened.st_mode) or opened.st_uid != uid() or opened.st_mode & 0o022):
            raise Refused("Maintenance gate metadata changed while opening it")
        raw = stream.read(2049)
        if len(raw) > 2048:
            raise Refused("Maintenance gate JSON exceeds its size bound")
        value = json.loads(raw)
    if not isinstance(value, dict) or value.get("version") != 1 or value.get("owner") != owner:
        raise Refused("Maintenance gate is inactive or owned by another operation")
    try:
        MAINTENANCE.require_installed()
        MAINTENANCE.verify_active_origin()
    except MAINTENANCE.Refused as error:
        raise Refused("Trusted installed maintenance gate and live origin 503 were not confirmed") from error


def protected_directory(path: Path, *, private=True) -> None:
    if not path.is_absolute():
        raise Refused("Backup and audit paths must be absolute")
    for part in reversed((path, *path.parents)):
        info = part.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise Refused("Backup/audit ancestors must be root-owned directories without writable aliases")
    if private and path.stat().st_mode & 0o077:
        raise Refused("Backup/audit directory must be private (0700)")


def sync_directory(path: Path, *, private=True) -> None:
    """Persist protected audit/backup directory entries before trusting evidence."""
    protected_directory(path, private=private)
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & (0o077 if private else 0o022):
            raise Refused("Cannot sync an unprotected audit/backup directory")
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def protected_open(path: Path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    stream = os.fdopen(descriptor, "rb")
    info = os.fstat(stream.fileno())
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077 or info.st_size == 0:
        stream.close()
        raise Refused("Backup evidence must be nonempty root-owned private regular files")
    return stream


def sha256_file(path: Path, magic: bytes) -> str:
    checksum = hashlib.sha256()
    with protected_open(path) as stream:
        first = stream.read(1024 * 1024)
        if magic and not first.startswith(magic):
            raise Refused("Native backup file has invalid magic")
        checksum.update(first)
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            checksum.update(chunk)
    return checksum.hexdigest()


def verify_backup(repo: Path, path: Path, records: dict, postgres: dict) -> bytes:
    protected_directory(path.parent)
    if (path.parent / "failed.json").exists():
        raise Refused("Backup directory records a failed verification; do not use its artifacts")
    with protected_open(path) as stream:
        raw = stream.read(65537)
    if len(raw) > 65536:
        raise Refused("Backup manifest is too large")
    value = json.loads(raw)
    created = datetime.fromisoformat(value["created_at"].replace("Z", "+00:00"))
    age = (datetime.now(timezone.utc) - created).total_seconds()
    if (value.get("schema") != "wotcv-runtime-logging-backup-v1" or value.get("project") != PROJECT
            or age < 0 or age > MAX_BACKUP_AGE):
        raise Refused("Native backup evidence is invalid, future-dated or older than six hours")
    for name, magic, verification in (("postgres", b"PGDMP", "pg_restore --list"),
                                      ("redis", b"REDIS", "redis-check-rdb")):
        item = value[name]
        if (item["container_id"] != records[name]["Id"] or item["image_id"] != records[name]["Image"]
                or item["volume"] != "rybbit_" + name + "-data" or item["verified_by"] != verification):
            raise Refused("Backup evidence does not match the current database containers")
        for key in (("archive", "globals") if name == "postgres" else ("archive",)):
            artifact = item[key]
            filename = artifact["path"]
            if (not isinstance(filename, str) or Path(filename).name != filename
                    or filename in ("", ".", "..") or not SHA256.fullmatch(artifact["sha256"])):
                raise Refused("Backup artifact must be a direct filename with an exact SHA256")
            if sha256_file(path.parent / filename, magic if key == "archive" else b"") != artifact["sha256"]:
                raise Refused("Native backup artifact checksum mismatch")
        if name == "postgres":
            if item["system_identifier"] != postgres["system_identifier"]:
                raise Refused("Backup PostgreSQL cluster identity differs")
            with protected_open(path.parent / item["archive"]["path"]) as stream:
                command(repo, ["docker", "exec", "-i", records[name]["Id"], "pg_restore", "--list"], stdin=stream)
    return raw


@contextmanager
def lock_file(path: Path, owner: int):
    import fcntl
    try:
        descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        if owner:
            os.fchown(descriptor, owner, -1)
    except FileExistsError:
        descriptor = os.open(path, os.O_RDWR | os.O_NOFOLLOW)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid not in (0, owner) or info.st_mode & 0o002:
            raise Refused("Deployment lock has unsafe ownership or permissions")
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise Refused("Another updater/deployment/operations install holds a shared lock") from error
        yield
    finally:
        os.close(descriptor)


def postgres_snapshot(repo: Path, identifier: str) -> dict:
    result = json.loads(command(repo, ["docker", "exec", "-i", identifier, "sh", "-ec",
        'exec psql -X -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At'],
        data=("BEGIN READ ONLY;\n" + PG_SNAPSHOT + "\nCOMMIT;\n").encode()))
    if (not re.fullmatch(r"[0-9]+", result["system_identifier"])
            or any(not isinstance(result[key], int) or result[key] < 0 for key in ("users", "sites", "aliases"))):
        raise Refused("PostgreSQL invariant response is invalid")
    return result


def redis_command(repo: Path, record: dict, *args: str):
    cmd = record["Config"]["Cmd"]
    if not isinstance(cmd, list) or cmd.count("--requirepass") != 1:
        raise Refused("Redis runtime command does not contain one explicit authentication setting")
    password = cmd[cmd.index("--requirepass") + 1]
    if not isinstance(password, str) or not password or any(c in password for c in "\r\n\x00"):
        raise Refused("Redis password cannot be safely supplied through the private input channel")
    # redis-cli formats INFO as section text even under --json. Select raw
    # explicitly for these two known replies; never hide a malformed structured
    # response behind a generic JSON-to-text fallback.
    info_headers = {("INFO", "persistence"): "# Persistence", ("INFO", "keyspace"): "# Keyspace"}
    header = info_headers.get(args)
    raw = command(repo, ["docker", "exec", "-i", record["Id"], "sh", "-ec",
        'IFS= read -r REDISCLI_AUTH; export REDISCLI_AUTH; exec redis-cli --no-auth-warning -e "$@"',
        "sh", "--raw" if header else "--json", *args], data=(password + "\n").encode())
    if header:
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError as error:
            raise Refused("Redis INFO response is not valid UTF-8") from error
        if not text.startswith((header + "\r\n", header + "\n")):
            raise Refused("Redis INFO response has an invalid section header")
        return text
    return json.loads(raw)


def redis_snapshot(repo: Path, record: dict) -> dict:
    settings = redis_command(repo, record, "CONFIG", "GET", "appendonly", "appendfsync", "dir", "appenddirname")
    if isinstance(settings, list):
        settings = dict(zip(settings[::2], settings[1::2]))
    if settings != {"appendonly": "yes", "appendfsync": "everysec", "dir": "/data", "appenddirname": "appendonlydir"}:
        raise Refused("Redis durable AOF configuration differs from the production contract")
    persistence = dict(line.split(":", 1) for line in redis_command(repo, record, "INFO", "persistence").splitlines()
                       if ":" in line and not line.startswith("#"))
    for key, expected in {"loading": "0", "aof_enabled": "1", "aof_rewrite_in_progress": "0",
                          "aof_last_write_status": "ok", "aof_last_bgrewrite_status": "ok"}.items():
        if persistence.get(key) != expected:
            raise Refused("Redis AOF is not stable and healthy")
    keyspace = redis_command(repo, record, "INFO", "keyspace")
    if any(line.startswith("db") and not line.startswith("db0:") for line in keyspace.splitlines()):
        raise Refused("Redis contains another database; this DB0-only maintenance tool refuses it")
    if redis_command(repo, record, "DBSIZE") > 100000:
        raise Refused("Redis key count exceeds the bounded maintenance snapshot limit")
    started = int(time.time() * 1000)
    keys = {}
    cursor = "0"
    for _ in range(1000):
        observed = int(time.time() * 1000)
        cursor, rows = redis_command(repo, record, "EVAL_RO", REDIS_SNAPSHOT, "0", cursor)
        for key, checksum, ttl in rows:
            if (not re.fullmatch(r"[0-9a-f]{40}", key) or not re.fullmatch(r"[0-9a-f]{40}", checksum)
                    or not isinstance(ttl, int) or ttl < -1):
                raise Refused("Redis key snapshot is invalid")
            keys[key] = {"hash": checksum, "expires_at_ms": None if ttl == -1 else observed + ttl}
        if len(keys) > 100000 or int(time.time() * 1000) - started > 60000:
            raise Refused("Redis snapshot exceeded its time/key safety bound")
        if str(cursor) == "0":
            return {"timestamp_ms": int(time.time() * 1000), "keys": keys, "aof": settings}
        cursor = str(cursor)
    raise Refused("Redis SCAN did not finish within its bounded iteration limit")


def compare_data(before_pg: dict, after_pg: dict, before_redis: dict, after_redis: dict) -> None:
    if (any(before_pg[key] != after_pg[key] for key in ("system_identifier", "database"))
            or any(after_pg[key] < before_pg[key] for key in ("users", "sites", "aliases"))):
        raise Refused("PostgreSQL cluster identity or data-count invariant failed")
    for key, previous in before_redis["keys"].items():
        expires = previous["expires_at_ms"]
        if expires is not None and expires <= after_redis["timestamp_ms"] + 2000:
            continue  # Natural TTL expiry is not lost durable state.
        current = after_redis["keys"].get(key)
        if current is None or current["hash"] != previous["hash"]:
            raise Refused("Redis protected key/value invariant failed")
        now_expires = current["expires_at_ms"]
        if ((expires is None) != (now_expires is None)
                or expires is not None and abs(expires - now_expires) > 2000):
            raise Refused("Redis protected key expiry invariant failed")


def preserved_config(record: dict) -> dict:
    config = copy.deepcopy(record["Config"])
    config.pop("Image", None)
    if config.get("Hostname") == record["Id"][:12]:
        config.pop("Hostname")
    config["Labels"] = non_compose_labels(config.get("Labels"))
    if "Env" in config:
        config["Env"] = [key + "=" + value for key, value in sorted(unique_environment(config["Env"]).items())]
    host = canonical_host_config(record["HostConfig"])
    host.pop("LogConfig", None)
    networks = {name: {key: value.get(key) for key in ("NetworkID", "Aliases", "IPAMConfig")}
                for name, value in record["NetworkSettings"]["Networks"].items()}
    return {"image": record["Image"], "config": config, "host": host,
            "mounts": record["Mounts"], "networks": networks}


def stable_runtime(records: dict) -> dict:
    # Inspect health probe timestamps/output change naturally every few seconds.
    # Runtime identity/configuration/start/restarts must not change instead.
    return {name: {"id": record["Id"], "config": preserved_config(record),
                   "logging": record["HostConfig"].get("LogConfig"),
                   "restarts": record.get("RestartCount"),
                   "state": {key: record["State"].get(key)
                             for key in ("Status", "Running", "StartedAt", "FinishedAt")}}
            for name, record in records.items()}


def pinned_compose(config: dict, records: dict, *, rollback: bool) -> dict:
    require_native_runtime_settings(records)
    validate_database_mounts(config, records)
    allowed = {"image", "container_name", "environment", "volumes", "healthcheck", "restart", "ports",
               "command", "entrypoint", "logging", "networks", "labels", *PINNED_NATIVE_FIELDS}
    result = {"name": PROJECT, "services": {},
              "volumes": {key: copy.deepcopy(config["volumes"][key]) for key in ("postgres-data", "redis-data")},
              "networks": {"default": copy.deepcopy(config.get("networks", {}).get("default", {}))}}
    for name in TARGETS:
        service = copy.deepcopy(config["services"][name])
        if set(service) - allowed:
            raise Refused("Unsupported database Compose fields; a general deployment is not permitted")
        if any(field in service and service[field] != value for field, value in PINNED_NATIVE_FIELDS.items()):
            raise Refused("Database Compose runtime settings differ from the reviewed native profile")
        # Preserve version-sensitive representable defaults explicitly instead
        # of relying on the current daemon's default runtime/namespace/shm size.
        service.update(PINNED_NATIVE_FIELDS)
        service["image"] = records[name]["Image"]
        actual = records[name]["HostConfig"]["LogConfig"]
        if rollback:
            if not isinstance(actual.get("Type"), str) or not isinstance(actual.get("Config"), dict):
                raise Refused("Original logging cannot be represented safely for configuration rollback")
            service["logging"] = {"driver": actual["Type"]}
            # Compose 5.6.1 canonically omits an empty options map. Keep the
            # exact export/source roundtrip strict for rollback as well.
            if actual["Config"]:
                service["logging"]["options"] = actual["Config"]
        result["services"][name] = service
    return result


def non_compose_labels(labels) -> dict:
    if labels is None:
        return {}
    if not isinstance(labels, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in labels.items()):
        raise Refused("Container labels are malformed")
    return {key: value for key, value in labels.items() if not key.startswith("com.docker.compose.")}


def unique_environment(value) -> dict[str, str]:
    """Parse literal inspect entries without losing duplicate-key semantics."""
    if not isinstance(value, list):
        raise Refused("Database environment is malformed")
    result = {}
    for entry in value:
        if not isinstance(entry, str) or "=" not in entry or "\0" in entry:
            raise Refused("Database environment is malformed")
        key, setting = entry.split("=", 1)
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key) or key in result:
            raise Refused("Database environment has malformed or duplicate variable names")
        result[key] = setting
    return result


def canonical_healthcheck(value) -> dict:
    fields = {"Test": [], "Interval": 0, "Timeout": 0, "Retries": 0, "StartPeriod": 0, "StartInterval": 0}
    if value is None:
        return fields
    if not isinstance(value, dict) or set(value) - set(fields):
        raise Refused("Unsupported inherited/runtime database health-check configuration")
    fields.update(value)
    return fields


def effective_healthcheck(desired: dict, image: dict) -> dict:
    health = canonical_healthcheck(image.get("Healthcheck"))
    declared = desired.get("healthcheck") or {}
    if not isinstance(declared, dict) or set(declared) - {"test", "interval", "timeout", "retries", "start_period", "start_interval"}:
        raise Refused("Unsupported database health-check configuration")
    for field, runtime_field in (("test", "Test"), ("retries", "Retries"), ("interval", "Interval"),
                                 ("timeout", "Timeout"), ("start_period", "StartPeriod"), ("start_interval", "StartInterval")):
        if field not in declared:
            continue
        value = declared[field]
        if field not in ("test", "retries") and isinstance(value, str):
            match = re.fullmatch(r"([0-9]+)(ns|us|ms|s|m|h)", value)
            if not match:
                raise Refused("Unsupported health-check duration; logging-only repair refused")
            value = int(match[1]) * {"ns": 1, "us": 1000, "ms": 10**6, "s": 10**9, "m": 60 * 10**9, "h": 3600 * 10**9}[match[2]]
        if (field == "test" and (not isinstance(value, list) or any(not isinstance(item, str) for item in value))
                or field != "test" and (not isinstance(value, int) or isinstance(value, bool) or value < 0)):
            raise Refused("Malformed database health-check configuration")
        # Docker's image merge inherits zero-valued duration/retry fields too.
        if value not in (0, []):
            health[runtime_field] = value
    return health


def require_matching_command_environment(config: dict, records: dict, image_configs: dict) -> None:
    require_native_runtime_settings(records)
    for name in TARGETS:
        desired = config["services"][name]
        actual = records[name]["Config"]
        image = image_configs[name]["Config"]
        env = unique_environment(image.get("Env", []))
        env.update(desired.get("environment", {}))
        if unique_environment(actual.get("Env", [])) != env:
            raise Refused("Database environment drift would change more than logging")
        # Rendered Compose includes explicit nulls: null inherits the image,
        # whereas []/'' clears an instruction. A non-null entrypoint also
        # suppresses image CMD unless Compose supplies its own command.
        declared_entrypoint = desired.get("entrypoint")
        expected_entrypoint = image.get("Entrypoint") if declared_entrypoint is None else declared_entrypoint
        expected_command = desired.get("command")
        if expected_command is None and declared_entrypoint is None:
            expected_command = image.get("Cmd")
        if actual.get("Entrypoint") != expected_entrypoint or actual.get("Cmd") != expected_command:
            raise Refused("Database entrypoint/command drift would change more than logging")
        if ((actual.get("User") or "") != (image.get("User") or "")
                or (actual.get("WorkingDir") or "") != (image.get("WorkingDir") or "")
                or actual.get("StopSignal") != image.get("StopSignal")
                or actual.get("Domainname", "") != image.get("Domainname", "")
                or actual.get("Hostname") != records[name]["Id"][:12]
                or records[name]["HostConfig"]["RestartPolicy"] != {"Name": desired.get("restart", "no"), "MaximumRetryCount": 0}):
            raise Refused("Database execution settings differ from the pinned image/Compose")
        exposed = copy.deepcopy(image.get("ExposedPorts") or {})
        exposed.update({key: {} for key in port_bindings(desired)})
        if ((actual.get("ExposedPorts") or {}) != exposed
                or actual.get("Volumes") != image.get("Volumes")):
            raise Refused("Database image port/volume metadata drift would change more than logging")
        if canonical_healthcheck(actual.get("Healthcheck")) != effective_healthcheck(desired, image):
            raise Refused("Database declared/inherited health-check drift would change more than logging")
        labels = non_compose_labels(image.get("Labels"))
        declared_labels = desired.get("labels") or {}
        if non_compose_labels(declared_labels) != declared_labels:
            raise Refused("Declared labels must not override the generated Compose namespace")
        labels.update(declared_labels)
        if non_compose_labels(actual.get("Labels")) != labels:
            raise Refused("Database custom/image label drift would change more than logging")
        networks = desired.get("networks", {"default": None})
        definition = copy.deepcopy(config.get("networks", {}).get("default", {}))
        # CLI 5.6.1 exports the default as ipam:{} even when no IPAM was
        # requested. Normalize ONLY this comparison copy; retain the canonical
        # exported candidate model unchanged for the exact source roundtrip.
        if definition.get("ipam") is None or definition.get("ipam") == {}:
            definition.pop("ipam", None)
        network_name = PROJECT + "_default"
        if (networks != {"default": None} or definition not in ({"name": network_name}, {"name": network_name, "external": True})
                or set(records[name]["NetworkSettings"]["Networks"]) != {network_name}
                or records[name]["HostConfig"].get("NetworkMode") != network_name
                or any(value is not None for value in networks.values())
                or any(value.get("IPAMConfig") is not None or value.get("Links") or value.get("DriverOpts") or value.get("GwPriority", 0)
                       or set(value.get("Aliases") or []) != {name}
                       for value in records[name]["NetworkSettings"]["Networks"].values())):
            raise Refused("Database network drift/static addressing requires a separate reviewed maintenance plan")


def write_json(path: Path, value) -> None:
    data = json.dumps(value, indent=2, sort_keys=True).encode() + b"\n"
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def compose_literals(value):
    """Encode semantic literal VALUES for exactly one Compose source pass.

    Compose interpolation does not apply to mapping keys. This encoder consumes
    the decoded semantic model, never the escaped bytes of `compose config`.
    """
    if isinstance(value, str):
        return value.replace("$", "$$")
    if isinstance(value, list):
        return [compose_literals(item) for item in value]
    if isinstance(value, dict):
        return {key: compose_literals(item) for key, item in value.items()}
    return value


def decode_compose_export(data: bytes):
    """Decode ONLY proven `docker compose config --format json` responses.

    Docker Compose v5.6.1 cmd/compose/config.go:182-184 doubles every dollar in
    the final serialized JSON bytes, including mapping KEYS. Undo that export
    encoding once BEFORE JSON parsing. Never use this on Docker inspect, image
    metadata, native backups or already-decoded values: genuine runtime `$$`
    must remain two dollars. Odd dollar runs refuse an unsupported CLI contract.
    Source: https://github.com/docker/compose/blob/v5.6.1/cmd/compose/config.go
    """
    if not isinstance(data, bytes) or b"$" in data.replace(b"$$", b""):
        raise Refused("Unsupported Compose JSON export dollar encoding; literal values were not guessed")
    return json.loads(data.replace(b"$$", b"$"))


def verify_identity(repo: Path, records: dict, sample) -> None:
    prefix = ["docker", "exec", "-i", records["clickhouse"]["Id"], "sh", "-ec",
              'exec clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" '
              '--database "$CLICKHOUSE_DB" --format TSVRaw --multiquery "$@"', "sh"]
    command(repo, prefix, data=b"SYSTEM DROP DNS CACHE; SYSTEM RELOAD DICTIONARY user_identity_dict;\n")
    result = command(repo, prefix, data=b"SELECT count() FROM system.dictionaries WHERE name = 'user_identity_dict' AND status = 'LOADED' AND last_exception = '';\n")
    if result.strip() != b"1":
        raise Refused("ClickHouse identity dictionary did not reconnect to PostgreSQL")
    if sample:
        value = command(repo, [*prefix, "--param_site_id", str(sample["site_id"]),
                              "--param_anonymous_id", sample["anonymous_id"]],
            data=b"SELECT dictGetOrDefault('user_identity_dict', 'user_id', tuple({site_id:UInt64}, {anonymous_id:String}), '');\n")
        if value.decode().rstrip("\n") != sample["user_id"]:
            raise Refused("ClickHouse identity sample resolution changed after PostgreSQL recreation")


def require_apply_authority(repo: Path, ack: str, backup_manifest: Path | None) -> None:
    if os.name != "posix" or os.geteuid() != 0:
        raise Refused("--apply requires Linux root; normal updater/deploy must not run this repair")
    if repo.stat().st_uid != uid() or ack != ACK or backup_manifest is None:
        raise Refused("--apply requires deployment-user repository ownership, acknowledgment and backup manifest")


def historical_recovery_evidence(guard, records: dict, phase: str, owner: str):
    """Run a trusted Python caller's historical proof under maintenance.

    This is intentionally not a CLI plug-in mechanism. The caller owns the
    original protected-audit proof; the normal repair keeps owning lifecycle,
    locks, fresh-backup validation and fail-closed audit writes. Give the guard
    a copy so that it cannot rewrite the repair's comparison baseline.
    """
    require_gate(owner)
    backend = records["backend"]["State"]
    if (backend.get("Status") != "exited" or backend.get("ExitCode") != 0
            or backend.get("Running") is not False):
        raise Refused("Historical recovery requires the backend to remain cleanly stopped")
    evidence = guard(copy.deepcopy(records), phase)
    require_gate(owner)
    try:
        # Freeze a JSON-safe copy now; do not retain a caller-owned mutable
        # evidence object until the protected audit is written later.
        return json.loads(json.dumps(evidence, allow_nan=False))
    except (TypeError, ValueError, OverflowError):
        raise Refused("Historical recovery guard returned evidence that is not JSON-safe") from None


def reconcile(repo: Path, *, apply=False, owner="", ack="", backup_manifest: Path | None = None,
              audit_root=Path("/var/backups/wotcv-runtime-logging"), recovery_guard=None) -> Path | None:
    repo = repo.resolve(strict=True)
    if recovery_guard is not None and (not apply or not callable(recovery_guard)):
        raise Refused("Historical recovery requires apply and a trusted Python guard")
    if not apply:
        _, _, drift = plan(repo)
        if drift:
            raise Refused("Runtime log rotation drift: " + ", ".join(drift)
                          + "; no changes made; arrange separate approved PostgreSQL/Redis maintenance; "
                            "daemon-default creation probe is apply-only and was not run")
        print("CHECK PASS: all five actual containers use json-file 50m x 5; no changes made; "
              "daemon-default creation probe is apply-only and was not run")
        return None
    require_apply_authority(repo, ack, backup_manifest)
    require_gate(owner)
    locks = ((Path("/run/lock/wotcv-deploy.lock"), 0), (Path("/run/lock/wotcv-ops-install.lock"), 0),
             (Path("/var/log/wotcv-tools/rybbit/update.lock"), uid()),
             (Path(f"/tmp/rybbit-wotcv-update-{uid()}.lock"), uid()))
    with ExitStack() as stack:
        for path, lock_owner in locks:
            stack.enter_context(lock_file(path, lock_owner))
        require_gate(owner)
        config, records, drift = plan(repo)
        if (records["backend"]["State"].get("Status") != "exited"
                or records["backend"]["State"].get("ExitCode") != 0):
            raise Refused("Cleanly stop backend (exit 0) under maintenance before backup/repair; it will NEVER be started here")
        if any(name not in TARGETS for name in drift):
            raise Refused("Logging drift exists outside PostgreSQL/Redis; this narrow repair refuses it")
        if recovery_guard is not None and drift != ("redis",):
            raise Refused("Historical recovery requires exactly Redis logging drift; no containers recreated")
        if not drift:
            print("ALREADY CURRENT: no containers changed; backend remains stopped and maintenance active")
            return None
        historical_before = None
        if recovery_guard is not None:
            historical_before = historical_recovery_evidence(recovery_guard, records, "preflight", owner)
        pg_before = postgres_snapshot(repo, records["postgres"]["Id"])
        redis_before = redis_snapshot(repo, records["redis"])
        backup = verify_backup(repo, backup_manifest, records, pg_before)
        images = database_images(repo, records)
        require_matching_command_environment(config, records, images)
        candidate = pinned_compose(config, records, rollback=False)
        rollback = pinned_compose(config, records, rollback=True)
        protected_directory(audit_root.parent, private=False)
        audit_root.mkdir(mode=0o700, exist_ok=True)
        protected_directory(audit_root)
        # Idempotent retries must also close a previously failed mkdir barrier.
        sync_directory(audit_root.parent, private=False)
        audit = Path(tempfile.mkdtemp(prefix=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ-"), dir=audit_root))
        for filename, value in (("runtime.before.json", records), ("candidate.compose.json", compose_literals(candidate)),
                                ("rollback.compose.json", compose_literals(rollback)), ("postgres.before.json", pg_before),
                                ("redis.before.json", redis_before), ("backup-evidence.json", json.loads(backup))):
            write_json(audit / filename, value)
        if recovery_guard is not None:
            write_json(audit / "historical-recovery.before.json", historical_before)
        write_json(audit / "recovery.json", {
            "maintenanceOwner": owner, "maintenanceMustRemainActive": True, "backendMustRemainStopped": True,
            "configurationRollbackOnly": [*pinned_compose_command(audit / "rollback.compose.json"),
                "up", "-d", "--no-deps", "--no-build", "--pull", "never", "--force-recreate", *drift],
            "requiredNativeEngine": NATIVE_ENGINE, "requiredNativeCompose": NATIVE_COMPOSE,
            "warning": "Operator must verify current pinned images, mounts and data before configuration rollback. "
                       "Never restore database data automatically. Never start backend here: entrypoint runs migrations.",
        })
        sync_directory(audit)
        sync_directory(audit_root)
        print(f"Protected runtime/rollback audit: {audit}", flush=True)
        rendered_candidate = decode_compose_export(command(repo, [*pinned_compose_command(audit / "candidate.compose.json"),
            "config", "--format", "json"]))
        if rendered_candidate != candidate:
            raise Refused("Candidate Compose export/source roundtrip changed the effective configuration")
        require_matching_command_environment(rendered_candidate, records, images)
        validate_database_mounts(rendered_candidate, records)
        if any(rendered_candidate["services"][name]["image"] != records[name]["Image"] for name in TARGETS):
            raise Refused("Candidate Compose interpolation changed a pinned database image")
        rendered_rollback = decode_compose_export(command(repo, [*pinned_compose_command(audit / "rollback.compose.json"),
            "config", "--format", "json"]))
        if rendered_rollback != rollback:
            raise Refused("Rollback Compose export/source roundtrip changed the effective configuration")
        require_matching_command_environment(rendered_rollback, records, images)
        validate_database_mounts(rendered_rollback, records)
        # The fresh snapshot closes the gap after backup verification and local
        # image validation. Shared locks cannot prevent arbitrary docker commands.
        fresh_config, fresh_records, fresh_drift = plan(repo)
        if (fresh_config != config or fresh_drift != drift
                or stable_runtime(fresh_records) != stable_runtime(records)):
            raise Refused("Compose or containers changed during preflight; nothing recreated")
        try:
            # Live container config can predate daemon-default changes. Both
            # isolated never-started probes must pass and be cleaned before any
            # production database recreation is attempted.
            probe_native_daemon(repo, audit, records, owner)
            for name in drift:
                require_gate(owner)
                current = inspect_owned(repo)
                if (current["backend"]["State"].get("Status") != "exited"
                        or current["backend"]["State"].get("ExitCode") != 0):
                    raise Refused("Backend was restarted during maintenance; further replacement refused")
                require_matching_command_environment(config, current, images)
                if (current[name]["Id"] != records[name]["Id"]
                        or preserved_config(current[name]) != preserved_config(records[name])):
                    raise Refused("Database configuration changed immediately before replacement; nothing further recreated")
                if recovery_guard is not None:
                    evidence = historical_recovery_evidence(recovery_guard, current, "before-redis", owner)
                    write_json(audit / "historical-recovery.before-redis.json", evidence)
                    sync_directory(audit)
                command(repo, [*pinned_compose_command(audit / "candidate.compose.json"),
                    "up", "-d", "--no-deps", "--no-build", "--pull", "never",
                    "--force-recreate", "--wait", "--wait-timeout", "120", name], timeout=150)
                after = inspect_owned(repo)
                validate_storage_and_ports(config, after)
                if (after[name]["Id"] == records[name]["Id"] or preserved_config(after[name]) != preserved_config(records[name])
                        or after[name]["HostConfig"].get("LogConfig") != EXPECTED_RUNTIME_LOGGING):
                    raise Refused("Recreated database changed more than logging or was not replaced")
                for untouched in SERVICES:
                    if untouched not in drift[:drift.index(name) + 1] and after[untouched] != records[untouched]:
                        # Health timestamps may change naturally; compare the
                        # actual container identity, start, restarts and config.
                        a, b = after[untouched], records[untouched]
                        if any(a.get(key) != b.get(key) for key in ("Id", "Image", "RestartCount")) or a["State"].get("StartedAt") != b["State"].get("StartedAt"):
                            raise Refused("An out-of-scope container changed during logging repair")
            after = inspect_owned(repo)
            pg_after = postgres_snapshot(repo, after["postgres"]["Id"])
            redis_after = redis_snapshot(repo, after["redis"])
            compare_data(pg_before, pg_after, redis_before, redis_after)
            if "postgres" in drift:
                verify_identity(repo, after, pg_before["alias"])
            if recovery_guard is not None:
                evidence = historical_recovery_evidence(recovery_guard, after, "after", owner)
                write_json(audit / "historical-recovery.after.json", evidence)
            require_gate(owner)
            for filename, value in (("runtime.after.json", after), ("postgres.after.json", pg_after),
                                    ("redis.after.json", redis_after), ("success.json", {"recreated": drift,
                                     "backendStarted": False, "maintenanceLeftActive": True, "dataRestored": False})):
                write_json(audit / filename, value)
            sync_directory(audit)
            sync_directory(audit_root)
        except Exception:
            if (audit / "success.json").exists():
                os.replace(audit / "success.json", audit / "success.invalid.json")
            write_json(audit / "failure.json", {"maintenanceRemovalAttempted": False, "maintenanceStatusUnconfirmed": True,
                       "backendStartAttempted": False, "backendStatusUnconfirmed": True,
                       "automaticDataOrConfigurationRestore": False, "requiresOperatorReview": True})
            sync_directory(audit)
            sync_directory(audit_root)
            print("FAILED CLOSED: no maintenance removal or backend start was attempted; "
                  f"maintenance/backend status is unconfirmed. Review {audit}/recovery.json", file=sys.stderr)
            raise
        print("RECONCILED PostgreSQL/Redis logging only; pinned images, volumes and data verified. "
              "Backend remains stopped; maintenance remains active. No migrations or data restore run.")
        return audit


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path("/home/rybbit-wotcv"))
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--check", action="store_true", help="Read-only check (default)")
    action.add_argument("--apply", action="store_true", help="Root-only, acknowledged PostgreSQL/Redis maintenance")
    parser.add_argument("--owner", default="")
    parser.add_argument("--ack", choices=(ACK,))
    parser.add_argument("--backup-manifest", type=Path)
    parser.add_argument("--audit-root", type=Path, default=Path("/var/backups/wotcv-runtime-logging"))
    args = parser.parse_args()
    try:
        reconcile(args.repo, apply=args.apply, owner=args.owner, ack=args.ack,
                  backup_manifest=args.backup_manifest, audit_root=args.audit_root)
    except (Refused, OSError, ValueError, TypeError, KeyError, AttributeError, IndexError, subprocess.TimeoutExpired) as error:
        print(f"REFUSED: {error}" if isinstance(error, Refused)
              else "REFUSED: operation failed; native details withheld", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
