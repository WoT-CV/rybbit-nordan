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
    local state
    if ! state="$(wotcv_maintenance_control status)"; then
      echo "WARNING: maintenance flag state is unknown after failure; do not assume traffic is gated. Verify the gate immediately (operation-owner=${WOTCV_MAINTENANCE_OWNER})." >&2
    elif [[ "${state}" == active ]]; then
      echo "Maintenance flag is verified active (operation-owner=${WOTCV_MAINTENANCE_OWNER}; current flag ownership is not attested); application recovery and readiness checks are required before reopening traffic." >&2
    elif [[ "${state:-}" == inactive ]]; then
      echo "WARNING: maintenance flag is inactive after a failed deployment/leave; traffic may already be open. Verify the gate and application readiness immediately (operation-owner=${WOTCV_MAINTENANCE_OWNER})." >&2
    else
      echo "WARNING: maintenance flag state is unknown after failure; do not assume traffic is gated. Verify the gate immediately (operation-owner=${WOTCV_MAINTENANCE_OWNER})." >&2
    fi
  fi
}

# Deployment state stores local image IDs for branch builds and registry manifest
# digests for pulls. Neither is a mutable tag, and neither runtime environment
# metadata nor the revision of today's tag is evidence for the previous image.
wotcv_resolve_recorded_image() {
  local repository="$1" identity="$2" revision="$3" kind="$4"
  local inspection image_id image_revision repo_digests reference
  [[ "${identity}" =~ ^sha256:[0-9a-f]{64}$ && "${revision}" =~ ^[0-9a-f]{40}$ ]] || {
    echo "Recorded image identity/revision is missing or invalid; refusing automatic rollback." >&2
    return 1
  }
  case "${kind}" in local-id|registry-digest|legacy) ;;
    *) echo "Unknown recorded image identity kind; refusing automatic rollback." >&2; return 1 ;;
  esac

  if [[ "${kind}" != registry-digest ]]; then
    if inspection="$(docker image inspect "${identity}" --format '{{.Id}}|{{index .Config.Labels "org.opencontainers.image.revision"}}')"; then
      IFS='|' read -r image_id image_revision <<<"${inspection}"
      if [[ "${inspection}" == "${identity}|${revision}" ]]; then
        WOTCV_RECORDED_IMAGE_REF="${identity}"
        WOTCV_RECORDED_IMAGE_ID="${identity}"
        return 0
      fi
      echo "Recorded local image does not match its exact ID and reviewed revision; refusing rollback." >&2
      return 1
    fi
    [[ "${kind}" == legacy ]] || {
      echo "Recorded local image is unavailable; a mutable tag cannot replace it." >&2
      return 1
    }
  fi

  reference="${repository}@${identity}"
  if ! docker image inspect "${reference}" >/dev/null 2>&1; then
    # A registry recovery may fetch ONLY the recorded manifest, never its tag.
    docker pull "${reference}" || return 1
  fi
  inspection="$(docker image inspect "${reference}" --format '{{.Id}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{join .RepoDigests ","}}')" || return 1
  IFS='|' read -r image_id image_revision repo_digests <<<"${inspection}"
  if [[ "${inspection}" == *$'\n'* || ! "${image_id}" =~ ^sha256:[0-9a-f]{64}$ ||
        "${image_revision}" != "${revision}" || ",${repo_digests}," != *",${reference},"* ]]; then
    echo "Registry image does not match the recorded digest and reviewed revision; refusing rollback." >&2
    return 1
  fi
  WOTCV_RECORDED_IMAGE_REF="${reference}"
  WOTCV_RECORDED_IMAGE_ID="${image_id}"
}

wotcv_resolve_recorded_applications() {
  local tag="$1" revision="$2" backend_identity="$3" client_identity="$4" kind="${5:-legacy}"
  [[ "${tag}" =~ ^sha-[0-9a-f]{7,40}$ && "${revision}" =~ ^[0-9a-f]{40}$ &&
     "${revision}" == "${tag#sha-}"* ]] || {
    echo "No valid previous deployment tag/revision recorded; rollback requires manual review." >&2
    return 1
  }
  wotcv_resolve_recorded_image "${BACKEND_IMAGE}" "${backend_identity}" "${revision}" "${kind}" || return 1
  WOTCV_RECORDED_BACKEND_REF="${WOTCV_RECORDED_IMAGE_REF}"
  WOTCV_RECORDED_BACKEND_ID="${WOTCV_RECORDED_IMAGE_ID}"
  wotcv_resolve_recorded_image "${CLIENT_IMAGE}" "${client_identity}" "${revision}" "${kind}" || return 1
  WOTCV_RECORDED_CLIENT_REF="${WOTCV_RECORDED_IMAGE_REF}"
  WOTCV_RECORDED_CLIENT_ID="${WOTCV_RECORDED_IMAGE_ID}"
}

wotcv_preserve_recorded_applications() {
  local tag="$1" revision="$2" backend_identity="$3" client_identity="$4" kind="${5:-legacy}"
  local service expected container_id inspection alias alias_inspection existing
  WOTCV_RETAINED_IMAGE_ALIASES=()
  WOTCV_RETAINED_IMAGE_IDS=()
  if [[ -z "${tag}${revision}${backend_identity}${client_identity}" ]]; then
    if [[ ! -e "${STATE_FILE}" && ! -L "${STATE_FILE}" ]] || [[ -f "${STATE_FILE}" && ! -L "${STATE_FILE}" && ! -s "${STATE_FILE}" ]]; then
      echo "First deployment: no last-good application state exists; automatic rollback is unavailable."
      return 0
    fi
    echo "Existing deployment state has no complete last-good identities; refusing build/pull." >&2
    return 1
  fi
  # Resolve BOTH records before adding a retention name to either. Nonempty but
  # incomplete/unavailable legacy state must never silently disable rollback.
  wotcv_resolve_recorded_applications "${tag}" "${revision}" "${backend_identity}" "${client_identity}" "${kind}" || return 1
  for service in backend client; do
    if [[ "${service}" == backend ]]; then expected="${WOTCV_RECORDED_BACKEND_ID}"; else expected="${WOTCV_RECORDED_CLIENT_ID}"; fi
    container_id="$("${COMPOSE[@]}" ps -a -q "${service}")" || return 1
    [[ -n "${container_id}" ]] || continue
    [[ "${container_id}" != *$'\n'* ]] || return 1
    inspection="$(docker inspect "${container_id}" --format '{{.Image}}|{{.State.Running}}|{{.State.Restarting}}|{{.State.Paused}}|{{.State.Status}}')" || return 1
    case "${inspection}" in
      "${expected}|true|false|false|running"|"${expected}|false|false|false|created"|"${expected}|false|false|false|exited"|"${expected}|false|false|false|dead") ;;
      *'|false|false|false|created'|*'|false|false|false|exited'|*'|false|false|false|dead')
        # A stopped failed candidate can differ from saved last-good state.
        [[ "${inspection%%|*}" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1 ;;
      *) echo "Active ${service} cannot be associated with recorded last-good state; review recovery before building/pulling." >&2; return 1 ;;
    esac
  done

  # Under the containerd store, moving the only tag can drop the old index even
  # while a container uses it (Compose v5.6.1 pkg/compose/images.go:84-89).
  # Unique local aliases retain the record; selection STILL uses the saved ID
  # or registry digest, never the alias. Keep aliases on every failure/rollback.
  for service in backend client; do
    if [[ "${service}" == backend ]]; then expected="${WOTCV_RECORDED_BACKEND_ID}"; alias="${BACKEND_IMAGE}"
    else expected="${WOTCV_RECORDED_CLIENT_ID}"; alias="${CLIENT_IMAGE}"; fi
    alias+=":wotcv-retained-${expected#sha256:}-${UID}-$$-${RANDOM}"
    existing="$(docker image ls --filter "reference=${alias}" --format '{{.ID}}')" || return 1
    if [[ -n "${existing}" ]]; then
      echo "Retention alias already exists; refusing to overwrite an unowned name." >&2
      return 1
    fi
    docker image tag "${expected}" "${alias}" || return 1
    WOTCV_RETAINED_IMAGE_ALIASES+=("${alias}")
    WOTCV_RETAINED_IMAGE_IDS+=("${expected}")
    alias_inspection="$(docker image inspect "${alias}" --format '{{.Id}}|{{index .Config.Labels "org.opencontainers.image.revision"}}')" || return 1
    [[ "${alias_inspection}" == "${expected}|${revision}" ]] || {
      echo "Retention alias does not preserve the recorded image/revision; refusing build/pull." >&2
      return 1
    }
  done
  echo "Both last-good application images are retained before candidate tag mutation."
}

wotcv_release_retained_applications() {
  local index alias actual
  for index in "${!WOTCV_RETAINED_IMAGE_ALIASES[@]}"; do
    alias="${WOTCV_RETAINED_IMAGE_ALIASES[index]}"
    actual="$(docker image inspect "${alias}" --format '{{.Id}}')" || return 1
    [[ "${actual}" == "${WOTCV_RETAINED_IMAGE_IDS[index]}" ]] || {
      echo "Retention alias changed ownership/identity; leaving it untouched." >&2
      return 1
    }
    # Remove only the unique alias minted here, never a raw ID or deploy tag.
    docker image rm -- "${alias}" || return 1
  done
}

wotcv_quiesce_applications() {
  local service container_id state
  for service in backend client; do
    container_id="$("${COMPOSE[@]}" ps -a -q "${service}")" || return 1
    # A failed create may leave no container for one service. No container means
    # no worker; multiple containers are not the reviewed single-instance stack.
    [[ -n "${container_id}" ]] || continue
    [[ "${container_id}" != *$'\n'* ]] || return 1
    state="$(docker inspect "${container_id}" --format '{{.State.Running}} {{.State.Restarting}} {{.State.Paused}} {{.State.Status}}')" || return 1
    case "${state}" in
      'false false false exited'|'false false false created'|'false false false dead') continue ;;
    esac
    echo "Stopping candidate ${service} before application-only recovery..."
    "${COMPOSE[@]}" stop --timeout 60 "${service}" || return 1
    state="$(docker inspect "${container_id}" --format '{{.State.Running}} {{.State.Restarting}} {{.State.Paused}} {{.State.Status}}')" || return 1
    case "${state}" in
      'false false false exited'|'false false false created'|'false false false dead') ;;
      *) echo "Cannot prove ${service} has no running/restarting/paused workers; refusing recovery." >&2; return 1 ;;
    esac
  done
}

wotcv_assert_application_images() {
  local backend_id="$1" client_id="$2" revision="$3" phase="$4"
  local service expected container_id inspection actual_image image_revision
  for service in backend client; do
    if [[ "${service}" == backend ]]; then expected="${backend_id}"; else expected="${client_id}"; fi
    container_id="$("${COMPOSE[@]}" ps -a -q "${service}")" || return 1
    [[ -n "${container_id}" && "${container_id}" != *$'\n'* && "${expected}" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
    inspection="$(docker inspect "${container_id}" --format '{{.Image}}|{{.State.Running}}|{{.State.Restarting}}|{{.State.Paused}}|{{.State.Status}}')" || return 1
    if [[ "${phase}" == created ]]; then
      [[ "${inspection}" == "${expected}|false|false|false|created" ]] || {
        echo "Created ${service} does not match the recorded image or is already active; refusing start." >&2
        return 1
      }
    elif [[ "${phase}" == running ]]; then
      [[ "${inspection}" == "${expected}|true|false|false|running" ]] || {
        echo "Running ${service} does not match the recorded image; refusing traffic." >&2
        return 1
      }
    else return 1
    fi
    actual_image="${inspection%%|*}"
    image_revision="$(docker image inspect "${actual_image}" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" || return 1
    [[ "${image_revision}" == "${revision}" ]] || {
      echo "Actual ${service} image revision differs from recorded state; refusing recovery." >&2
      return 1
    }
    if [[ "${service}" == backend ]]; then WOTCV_RECORDED_BACKEND_CONTAINER="${container_id}"
    else WOTCV_RECORDED_CLIENT_CONTAINER="${container_id}"; fi
  done
}

# Run in a subshell so temporary Compose overrides, runtime reporting variables,
# and cleanup traps cannot leak into the candidate deployment/state writer.
wotcv_restore_recorded_applications() (
  local tag="$1" revision="$2" build_time="$3" backend_identity="$4" client_identity="$5" kind="${6:-legacy}"
  local override postgres_id
  [[ "${WOTCV_MAINTENANCE_STARTED}" == 1 ]] || return 1
  wotcv_resolve_recorded_applications "${tag}" "${revision}" "${backend_identity}" "${client_identity}" "${kind}" || return 1
  postgres_id="$("${COMPOSE[@]}" ps -q postgres)" || return 1
  wotcv_auth_assert_rollback_safe "${WOTCV_RECORDED_BACKEND_REF}" "${postgres_id}" || return 1
  wotcv_quiesce_applications || return 1
  override="$(mktemp "${TMPDIR:-/tmp}/rybbit-wotcv-rollback.${UID}.XXXXXX.json")" || return 1
  trap 'rm -f -- "${override}"' EXIT
  python3 - "${override}" "${WOTCV_RECORDED_BACKEND_REF}" "${WOTCV_RECORDED_CLIENT_REF}" <<'PY' || return 1
import json
import sys

with open(sys.argv[1], "w", encoding="utf-8") as stream:
    json.dump({"services": {
        service: {"image": image, "pull_policy": "never"}
        for service, image in zip(("backend", "client"), sys.argv[2:])
    }}, stream)
PY
  COMPOSE+=(-f "${override}")
  export IMAGE_TAG="${tag}" WOTCV_GIT_SHA="${revision}" WOTCV_BUILD_TIME="${build_time:-unknown}"
  export WOTCV_DEPLOYED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  export BACKEND_IMAGE_DIGEST="${backend_identity}" CLIENT_IMAGE_DIGEST="${client_identity}"
  # Create without starting, then attest BOTH actual container image IDs and
  # image revisions before any recovered application process can execute.
  "${COMPOSE[@]}" up --no-start --no-deps --force-recreate --no-build --pull never --remove-orphans=false backend client || return 1
  wotcv_assert_application_images "${WOTCV_RECORDED_BACKEND_ID}" "${WOTCV_RECORDED_CLIENT_ID}" "${revision}" created || return 1
  docker start "${WOTCV_RECORDED_BACKEND_CONTAINER}" "${WOTCV_RECORDED_CLIENT_CONTAINER}" || return 1
)

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
