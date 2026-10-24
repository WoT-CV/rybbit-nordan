#!/usr/bin/env python3
"""Validate the fixed WoT-CV log-rotation contract without Docker or dependencies."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Mapping


SERVICES = ("clickhouse", "postgres", "redis", "backend", "client")
EXPECTED_LOGGING = {
    "driver": "json-file",
    "options": {"max-size": "50m", "max-file": "5"},
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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", type=Path, help="Rendered Compose JSON file")
    args = parser.parse_args()
    try:
        config = json.loads(args.config.read_text(encoding="utf-8"))
        validate_compose_logging(config)
    except (OSError, UnicodeError, ValueError) as error:
        print(f"Compose logging validation failed: {error}", file=sys.stderr)
        return 1
    print("Compose logging validation passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
