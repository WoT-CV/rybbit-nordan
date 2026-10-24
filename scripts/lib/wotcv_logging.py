#!/usr/bin/env python3
"""Validate declared AND inspected WoT-CV logging without Docker dependencies."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Mapping, Sequence


SERVICES = ("clickhouse", "postgres", "redis", "backend", "client")
EXPECTED_LOGGING = {
    "driver": "json-file",
    "options": {"max-size": "50m", "max-file": "5"},
}
EXPECTED_RUNTIME_LOGGING = {
    "Type": "json-file",
    "Config": {"max-size": "50m", "max-file": "5"},
}


def validate_compose_logging(config: Mapping[str, Any]) -> None:
    """Reject missing or changed logging settings without printing config secrets."""
    if not isinstance(config, Mapping):
        raise ValueError("Compose configuration must be a JSON object.")
    services = config.get("services")
    if not isinstance(services, Mapping):
        raise ValueError("Compose services must be a JSON object.")

    for name in SERVICES:
        service = services.get(name)
        if not isinstance(service, Mapping):
            raise ValueError(f"Compose service {name} must be a JSON object.")
        logging = service.get("logging")
        if not isinstance(logging, Mapping) or logging != EXPECTED_LOGGING:
            raise ValueError(
                f"{name} logging must use json-file with exactly "
                'max-size="50m" and max-file="5".'
            )


def runtime_containers(
    records: Sequence[Mapping[str, Any]],
    expected_project: str = "rybbit",
    services: Sequence[str] = SERVICES,
) -> dict[str, Mapping[str, Any]]:
    """Resolve exactly one live, project-labelled container per selected service.

    Names alone are not ownership evidence. In particular, a stopped leftover
    container or a container from another Compose project must not pass a live
    deployment guard. Never include arbitrary inspect values in diagnostics:
    Config.Env, health output and command arguments can contain credentials.
    """
    if (not isinstance(expected_project, str) or not expected_project
            or not services or len(set(services)) != len(services)
            or any(name not in SERVICES for name in services)):
        raise ValueError("Invalid runtime logging project or service selection.")
    if not isinstance(records, list):
        raise ValueError("Docker inspect must contain a JSON array.")
    found: dict[str, Mapping[str, Any]] = {}
    identifiers: set[str] = set()
    for record in records:
        if not isinstance(record, Mapping):
            raise ValueError("Docker inspect contains an invalid container record.")
        config = record.get("Config")
        labels = config.get("Labels") if isinstance(config, Mapping) else None
        if not isinstance(labels, Mapping):
            raise ValueError("Docker inspect container has no Compose ownership labels.")
        name = labels.get("com.docker.compose.service")
        if name not in services:
            raise ValueError("Docker inspect includes an unexpected Compose service.")
        if labels.get("com.docker.compose.project") != expected_project:
            raise ValueError(f"{name}: running container belongs to a different Compose project.")
        oneoff = labels.get("com.docker.compose.oneoff", "False")
        if not isinstance(oneoff, str) or oneoff.lower() != "false":
            raise ValueError(f"{name}: a Compose one-off container is not a running service.")
        identifier = record.get("Id")
        if not isinstance(identifier, str) or not identifier or identifier in identifiers or name in found:
            raise ValueError(f"{name}: ambiguous or missing running container identity.")
        state = record.get("State")
        if (not isinstance(state, Mapping) or state.get("Status") != "running"
                or state.get("Running", True) is not True):
            raise ValueError(f"{name}: container is not running.")
        found[name] = record
        identifiers.add(identifier)
    for name in services:
        if name not in found:
            raise ValueError(f"{name}: running container is missing.")
    return found


def runtime_logging_drift(
    records: Sequence[Mapping[str, Any]],
    expected_project: str = "rybbit",
    services: Sequence[str] = SERVICES,
) -> tuple[str, ...]:
    """Return drift from immutable HostConfig.LogConfig, never from Compose."""
    found = runtime_containers(records, expected_project, services)
    drift = []
    for name in services:
        host_config = found[name].get("HostConfig")
        actual = host_config.get("LogConfig") if isinstance(host_config, Mapping) else None
        if actual != EXPECTED_RUNTIME_LOGGING:
            drift.append(name)
    return tuple(drift)


def validate_runtime_logging(
    records: Sequence[Mapping[str, Any]],
    expected_project: str = "rybbit",
    services: Sequence[str] = SERVICES,
) -> None:
    """Reject actual container drift even when rendered Compose is correct."""
    drift = runtime_logging_drift(records, expected_project, services)
    if drift:
        raise ValueError(
            "Runtime log rotation drift: " + ", ".join(drift) + ". "
            'Expected json-file with exactly max-size="50m" and max-file="5". '
            "Run the separate runtime-logging reconciliation check and arrange "
            "an explicitly approved maintenance window; a normal deploy does not repair databases."
        )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", type=Path, nargs="?", help="Rendered Compose JSON file")
    parser.add_argument("--runtime-json", type=Path, help="Docker inspect JSON array (read-only)")
    parser.add_argument("--expected-project", default="rybbit")
    parser.add_argument("--services", nargs="+", choices=SERVICES, default=list(SERVICES))
    args = parser.parse_args()
    if (args.config is None) == (args.runtime_json is None):
        parser.error("supply either the Compose JSON file or --runtime-json, not both")
    runtime = args.runtime_json is not None
    try:
        config = json.loads((args.runtime_json if runtime else args.config).read_text(encoding="utf-8"))
        if runtime:
            validate_runtime_logging(config, args.expected_project, args.services)
        else:
            validate_compose_logging(config)
    except (OSError, UnicodeError, ValueError) as error:
        print(f"{'Runtime' if runtime else 'Compose'} logging validation failed: {error}", file=sys.stderr)
        return 1
    print(f"{'Runtime' if runtime else 'Compose'} logging validation passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
