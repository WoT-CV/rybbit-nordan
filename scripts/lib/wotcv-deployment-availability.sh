#!/usr/bin/env bash

# Deployment orchestration only. These helpers never apply database migrations.
# Always propagate failures explicitly: rollback callers run in conditionals.

WOTCV_MAINTENANCE_STARTED=0
if [[ -v WOTCV_MAINTENANCE_OWNER ]]; then
  WOTCV_MAINTENANCE_EXPLICIT_OWNER=1
else
  WOTCV_MAINTENANCE_EXPLICIT_OWNER=0
  WOTCV_MAINTENANCE_OWNER="deploy-${UID}-$$-${RANDOM}"
fi

wotcv_maintenance_control() {
  python3 "${ROOT_DIR}/scripts/wotcv-maintenance.py" "$@"
}

wotcv_require_maintenance_gate() {
  local state
  [[ "${WOTCV_MAINTENANCE_OWNER}" =~ ^[A-Za-z0-9_-]{1,80}$ ]] || {
    echo "WOTCV_MAINTENANCE_OWNER must be a safe 1-80 character maintenance token." >&2
    return 1
  }
  if ! state="$(wotcv_maintenance_control status)"; then
    echo "A trusted maintenance gate must be installed before deploying; see docs/WOTCV_DEPLOYMENT_AVAILABILITY.md." >&2
    return 1
  fi
  case "${state}" in
    inactive) return 0 ;;
    active)
      if [[ "${WOTCV_MAINTENANCE_EXPLICIT_OWNER}" != 1 ]]; then
        echo "Maintenance is already active. Review recovery, then supply its WOTCV_MAINTENANCE_OWNER to resume." >&2
        return 1
      fi
      # The gate utility validates existing ownership; do not trust status alone
      # or adopt somebody else's active maintenance window.
      wotcv_maintenance_control enter --owner "${WOTCV_MAINTENANCE_OWNER}" || return 1
      WOTCV_MAINTENANCE_STARTED=1
      echo "Resuming the explicitly owned maintenance window; traffic stays gated until readiness passes."
      ;;
    *) echo "Unknown maintenance state; refusing deployment." >&2; return 1 ;;
  esac
}

wotcv_enter_maintenance() {
  [[ "${WOTCV_MAINTENANCE_STARTED}" == 0 ]] || return 0
  wotcv_maintenance_control enter --owner "${WOTCV_MAINTENANCE_OWNER}" || return 1
  WOTCV_MAINTENANCE_STARTED=1
  echo "Maintenance enabled: this single-instance deployment returns controlled HTTP 503 until readiness checks pass."
}

wotcv_leave_maintenance() {
  [[ "${WOTCV_MAINTENANCE_STARTED}" == 1 ]] || return 0
  wotcv_maintenance_control leave --owner "${WOTCV_MAINTENANCE_OWNER}" || return 1
  WOTCV_MAINTENANCE_STARTED=0
}

wotcv_maintenance_failure_notice() {
  if [[ "${WOTCV_MAINTENANCE_STARTED}" == 1 ]]; then
    echo "Maintenance remains enabled (owner=${WOTCV_MAINTENANCE_OWNER}); application recovery and readiness checks are required before reopening traffic." >&2
  fi
}

wotcv_service_image() {
  python3 - "$1" "$2" <<'PY'
import json
import sys

try:
    with open(sys.argv[1], encoding="utf-8") as stream:
        image = json.load(stream)["services"][sys.argv[2]]["image"]
    if not isinstance(image, str) or not image or any(c.isspace() for c in image):
        raise ValueError()
except (OSError, KeyError, TypeError, ValueError):
    raise SystemExit("Cannot determine the reviewed infrastructure image")
print(image)
PY
}

wotcv_prepare_infrastructure_image() {
  local service="$1" image
  image="$(wotcv_service_image "$2" "${service}")" || return 1
  if ! docker image inspect "${image}" >/dev/null 2>&1; then
    # Pulling a missing image is safe before opening the maintenance window.
    "${COMPOSE[@]}" pull "${service}" || return 1
    docker image inspect "${image}" >/dev/null || return 1
  fi
}

wotcv_service_config_digests() {
  python3 - "$1" "$2" <<'PY'
import hashlib
import json
from pathlib import Path
import sys

try:
    # This input is ONLY the normal interpolated Compose CLI JSON export.
    # Compose v5.6.1 cmd/compose/config.go escapes every dollar after JSON
    # serialization, including keys. Decode that byte boundary exactly once.
    raw = Path(sys.argv[1]).read_bytes()
    if b"$" in raw.replace(b"$$", b""):
        raise ValueError()
    config = json.loads(raw.replace(b"$$", b"$"))
    rows = []
    for mounted in config["services"][sys.argv[2]].get("configs", []):
        if not isinstance(mounted, dict):
            raise ValueError()
        target = mounted.get("target", "/" + mounted["source"])
        if not isinstance(target, str) or not target.startswith("/") or any(c in target for c in "\n\r\t"):
            raise ValueError()
        source = config["configs"][mounted["source"]]
        if source.get("external"):
            raise ValueError()
        if "content" in source:
            data = source["content"].encode("utf-8")
        elif "file" in source:
            data = Path(source["file"]).read_bytes()
        else:
            raise ValueError()
        rows.append((target, hashlib.sha256(data).hexdigest()))
except (OSError, KeyError, TypeError, AttributeError, ValueError):
    # Never dump rendered Compose configuration: it contains credentials.
    raise SystemExit("Cannot attest the reviewed infrastructure config contents")
for target, digest in rows:
    print(target + "\t" + digest)
PY
}

wotcv_check_service_recreation() {
  local service="$1" config_file="$2"
  local container_id image desired_image current expected_hash hash_service
  local current_image current_hash state config_digests target expected_digest actual_digest
  # Result lives in the caller, not stdout or an inverted exit status. A failed
  # inspect must never be confused with the ordinary 'unchanged' result.
  WOTCV_SERVICE_RECREATE=0
  container_id="$("${COMPOSE[@]}" ps -a -q "${service}")" || return 1
  if [[ -z "${container_id}" ]]; then
    WOTCV_SERVICE_RECREATE=1
    return 0
  fi
  [[ "${container_id}" != *$'\n'* ]] || {
    echo "Expected exactly one ${service} container; refusing an ambiguous deployment." >&2
    return 1
  }
  image="$(wotcv_service_image "${config_file}" "${service}")" || return 1
  desired_image="$(docker image inspect "${image}" --format '{{.Id}}')" || return 1
  current="$(docker inspect "${container_id}" --format '{{.Image}}|{{index .Config.Labels "com.docker.compose.config-hash"}}|{{.State.Status}}')" || return 1
  IFS='|' read -r current_image current_hash state <<<"${current}"
  [[ "${desired_image}" =~ ^sha256:[0-9a-f]{64}$ && "${current_image}" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
  case "${state}" in
    created|running|paused|restarting|removing|exited|dead) ;;
    *) echo "Cannot attest the ${service} container state." >&2; return 1 ;;
  esac
  expected_hash="$("${COMPOSE[@]}" config --hash "${service}")" || return 1
  [[ "${expected_hash}" != *$'\n'* ]] || return 1
  read -r hash_service expected_hash <<<"${expected_hash}"
  [[ "${hash_service}" == "${service}" && "${expected_hash}" =~ ^[0-9a-f]{64}$ ]] || {
    echo "Cannot attest the ${service} Compose configuration hash." >&2
    return 1
  }
  if [[ "${state}" != running || "${desired_image}" != "${current_image}" || "${expected_hash}" != "${current_hash}" ]]; then
    WOTCV_SERVICE_RECREATE=1
  fi

  # Compose's service hash is not sufficient evidence for mounted config bytes.
  # Compare the actual files too, including inline configs and file-based ones.
  config_digests="$(wotcv_service_config_digests "${config_file}" "${service}")" || return 1
  [[ -n "${config_digests}" && "${state}" == running ]] || return 0
  while IFS=$'\t' read -r target expected_digest; do
    actual_digest="$(docker exec "${container_id}" sh -c \
      'if [ -f "$1" ]; then sha256sum -- "$1"; else printf "missing\n"; fi' sh "${target}")" || return 1
    read -r actual_digest _ <<<"${actual_digest}"
    [[ "${actual_digest}" == missing || "${actual_digest}" =~ ^[0-9a-f]{64}$ ]] || return 1
    if [[ "${actual_digest}" != "${expected_digest}" ]]; then
      WOTCV_SERVICE_RECREATE=1
    fi
  done <<<"${config_digests}"
}

wotcv_plan_shared_infrastructure() {
  local config_file="$1"
  wotcv_prepare_infrastructure_image clickhouse "${config_file}" || return 1
  wotcv_prepare_infrastructure_image redis "${config_file}" || return 1
  wotcv_check_service_recreation clickhouse "${config_file}" || return 1
  WOTCV_CLICKHOUSE_RECREATE="${WOTCV_SERVICE_RECREATE}"
  wotcv_check_service_recreation redis "${config_file}" || return 1
  WOTCV_REDIS_RECREATE="${WOTCV_SERVICE_RECREATE}"
  printf 'Shared infrastructure change plan: clickhouse=%s redis=%s (0=unchanged, 1=recreate).\n' \
    "${WOTCV_CLICKHOUSE_RECREATE}" "${WOTCV_REDIS_RECREATE}"
}

wotcv_wait_for_service_health() {
  local service="$1" container_id state health attempt
  for ((attempt = 1; attempt <= 60; attempt++)); do
    container_id="$("${COMPOSE[@]}" ps -q "${service}")" || return 1
    if [[ -n "${container_id}" && "${container_id}" != *$'\n'* ]]; then
      state="$(docker inspect "${container_id}" --format '{{.State.Status}}')" || return 1
      health="$(docker inspect "${container_id}" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')" || return 1
      if [[ "${state}" == running && ("${health}" == healthy || "${health}" == none) ]]; then
        return 0
      fi
    fi
    sleep 2
  done
  echo "Service ${service} did not become healthy in time." >&2
  return 1
}

wotcv_apply_infrastructure_change() {
  local service="$1" required="$2"
  if [[ "${required}" == 0 ]]; then
    echo "Keeping unchanged ${service} container."
    wotcv_wait_for_service_health "${service}" || return 1
    return 0
  fi
  [[ "${required}" == 1 && "${WOTCV_MAINTENANCE_STARTED}" == 1 ]] || {
    echo "Refusing a shared-infrastructure change outside the deployment maintenance window." >&2
    return 1
  }
  wotcv_drain_backend || return 1
  echo "Recreating changed ${service} with backend workers drained..."
  "${COMPOSE[@]}" up -d --no-deps --force-recreate "${service}" || return 1
  wotcv_wait_for_service_health "${service}" || return 1
}

wotcv_drain_backend() {
  local container_id running stopped
  container_id="$("${COMPOSE[@]}" ps -a -q backend)" || return 1
  [[ -n "${container_id}" && "${container_id}" != *$'\n'* ]] || {
    echo "Expected exactly one existing backend before draining." >&2
    return 1
  }
  running="$(docker inspect "${container_id}" --format '{{.State.Running}}')" || return 1
  if [[ "${running}" == true ]]; then
    echo "Draining backend workers before replacing applications or shared infrastructure..."
    "${COMPOSE[@]}" stop --timeout 60 backend || return 1
  elif [[ "${running}" != false ]]; then
    return 1
  fi
  # An already-stopped backend may have exited abnormally or been stopped by
  # another helper. It must satisfy the same clean-drain invariant as above.
  stopped="$(docker inspect "${container_id}" --format '{{.State.Running}} {{.State.ExitCode}}')" || return 1
  if [[ "${stopped}" != 'false 0' ]]; then
    echo "Backend did not stop cleanly; shared infrastructure will not be changed." >&2
    return 1
  fi
}

wotcv_wait_for_client() {
  local url="${WOTCV_CLIENT_HEALTHCHECK_URL:-http://127.0.0.1:3002/login}"
  local attempts="${WOTCV_HEALTHCHECK_ATTEMPTS:-60}" attempt status
  [[ "${attempts}" =~ ^[1-9][0-9]*$ ]] || return 1
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    if status="$(curl --silent --show-error --max-time 5 --output /dev/null --write-out '%{http_code}' "${url}" 2>/dev/null)"; then
      if [[ "${status}" == 200 ]]; then
        return 0
      fi
    fi
    sleep 2
  done
  echo "Client did not return HTTP 200 before the readiness deadline." >&2
  return 1
}
