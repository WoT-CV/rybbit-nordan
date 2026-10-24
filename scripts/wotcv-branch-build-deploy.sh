#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${ROOT_DIR}/scripts/lib/wotcv-common.sh"
source "${ROOT_DIR}/scripts/lib/wotcv-auth-cutover.sh"
STATE_FILE="${ROOT_DIR}/.wotcv-deployment.env"
DEPLOY_BRANCH="${WOTCV_BRANCH:-feat/wotcv}"
DEPLOY_REMOTE="${WOTCV_REMOTE:-origin}"
EXPECTED_GIT_SHA="${WOTCV_EXPECTED_SHA:-}"
HEALTHCHECK_URL="${WOTCV_HEALTHCHECK_URL:-http://127.0.0.1:3001/api/health}"
BACKEND_IMAGE="ghcr.io/wot-cv/rybbit-wotcv-backend"
CLIENT_IMAGE="ghcr.io/wot-cv/rybbit-wotcv-client"
COMPOSE_PROJECT_NAME="${WOTCV_COMPOSE_PROJECT_NAME:-${COMPOSE_PROJECT_NAME:-rybbit}}"
EXPECTED_COMPOSE_PROJECT_NAME="${WOTCV_EXPECTED_COMPOSE_PROJECT_NAME:-rybbit}"
CLICKHOUSE_VOLUME_NAME="${WOTCV_CLICKHOUSE_VOLUME_NAME:-rybbit_clickhouse-data}"
POSTGRES_VOLUME_NAME="${WOTCV_POSTGRES_VOLUME_NAME:-rybbit_postgres-data}"
REDIS_VOLUME_NAME="${WOTCV_REDIS_VOLUME_NAME:-rybbit_redis-data}"
COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.wotcv.yml -f docker-compose.wotcv.branch-build.yml)
COMPOSE_CONFIG_FILE=""
CLICKHOUSE_EVENT_BASELINE=""
CLICKHOUSE_REPLAY_WINDOW_START=""
CLICKHOUSE_PROTECTED_COHORT_END=""
POSTGRES_DATA_BASELINE=""

cleanup() {
  local code=$?
  if [[ "${code}" != 0 && "${WOTCV_AUTH_CUTOVER_STARTED}" == 1 ]]; then
    echo "Auth cutover did not complete. Old workers were stopped; do not restart a 1.6 image blindly. See docs/WOTCV_AUTH_CUTOVER.md." >&2
  fi
  [[ -z "${COMPOSE_CONFIG_FILE}" ]] || rm -f "${COMPOSE_CONFIG_FILE}"
}

trap cleanup EXIT

cd "${ROOT_DIR}"
export COMPOSE_PROJECT_NAME

wotcv_require_non_root
wotcv_require_expected_compose_project "${COMPOSE_PROJECT_NAME}" "${EXPECTED_COMPOSE_PROJECT_NAME}"
wotcv_require_commands git docker curl python3
wotcv_require_clean_worktree

image_id() {
  local image="$1"
  local tag="$2"
  docker image inspect "${image}:${tag}" --format '{{.Id}}'
}

validate_runtime_images() {
  docker run --rm --entrypoint node "${BACKEND_IMAGE}:${IMAGE_TAG}" \
    --input-type=module --eval 'await import("@rybbit/shared")'
  docker run --rm --entrypoint node "${CLIENT_IMAGE}:${IMAGE_TAG}" \
    --check /app/client/server.js
  if [[ "$(wotcv_auth_image_version "${BACKEND_IMAGE}:${IMAGE_TAG}")" != 1.7.3 ]]; then
    echo "This deployment script supports the reviewed Better Auth 1.7.3 images only." >&2
    return 1
  fi
}

validate_compose_config() {
  wotcv_validate_compose_ports "${COMPOSE_CONFIG_FILE}"
  wotcv_validate_compose_logging "${COMPOSE_CONFIG_FILE}"
}

require_persistent_volumes() {
  wotcv_require_named_volume "${CLICKHOUSE_VOLUME_NAME}"
  wotcv_require_named_volume "${POSTGRES_VOLUME_NAME}"
  wotcv_require_named_volume "${REDIS_VOLUME_NAME}"
}

validate_persistent_storage() {
  local clickhouse_id postgres_id redis_id
  clickhouse_id="$("${COMPOSE[@]}" ps -q clickhouse)" || return 1
  postgres_id="$("${COMPOSE[@]}" ps -q postgres)" || return 1
  redis_id="$("${COMPOSE[@]}" ps -q redis)" || return 1
  wotcv_validate_container_persistence \
    "${clickhouse_id}" \
    clickhouse \
    "${EXPECTED_COMPOSE_PROJECT_NAME}" \
    "${CLICKHOUSE_VOLUME_NAME}" \
    /var/lib/clickhouse || return 1
  wotcv_validate_container_persistence \
    "${postgres_id}" \
    postgres \
    "${EXPECTED_COMPOSE_PROJECT_NAME}" \
    "${POSTGRES_VOLUME_NAME}" \
    /var/lib/postgresql/data || return 1
  wotcv_validate_container_persistence \
    "${redis_id}" \
    redis \
    "${EXPECTED_COMPOSE_PROJECT_NAME}" \
    "${REDIS_VOLUME_NAME}" \
    /data || return 1
}

capture_clickhouse_event_baseline() {
  local container_id
  container_id="$("${COMPOSE[@]}" ps -q clickhouse)" || return 1
  CLICKHOUSE_EVENT_BASELINE="$(wotcv_clickhouse_event_invariants "${container_id}")" || return 1
  CLICKHOUSE_REPLAY_WINDOW_START="$(wotcv_clickhouse_replay_window_start "${CLICKHOUSE_EVENT_BASELINE}")" || return 1
  CLICKHOUSE_PROTECTED_COHORT_END="$(wotcv_clickhouse_protected_cohort_end "${CLICKHOUSE_EVENT_BASELINE}")" || return 1
  printf 'ClickHouse event baseline: %s\n' "${CLICKHOUSE_EVENT_BASELINE}"
}

capture_postgres_data_baseline() {
  local container_id
  container_id="$("${COMPOSE[@]}" ps -q postgres)" || return 1
  POSTGRES_DATA_BASELINE="$(wotcv_postgres_data_invariants "${container_id}")" || return 1
  printf 'PostgreSQL data baseline: %s\n' "${POSTGRES_DATA_BASELINE}"
}

validate_clickhouse_event_baseline() {
  local current_invariants container_id
  container_id="$("${COMPOSE[@]}" ps -q clickhouse)" || return 1

  current_invariants="$(wotcv_clickhouse_event_invariants \
    "${container_id}" \
    "${CLICKHOUSE_REPLAY_WINDOW_START}" \
    "${CLICKHOUSE_PROTECTED_COHORT_END}")" || return 1
  wotcv_assert_clickhouse_event_invariants_not_decreased \
    "${CLICKHOUSE_EVENT_BASELINE}" \
    "${current_invariants}"
}

validate_postgres_data_baseline() {
  local current_invariants container_id
  container_id="$("${COMPOSE[@]}" ps -q postgres)" || return 1

  current_invariants="$(wotcv_postgres_data_invariants "${container_id}")" || return 1
  wotcv_assert_postgres_invariants_not_decreased \
    "${POSTGRES_DATA_BASELINE}" \
    "${current_invariants}"
}

validate_infrastructure() {
  local service
  local container_id
  local state
  local health
  local port_bindings

  for service in postgres clickhouse redis; do
    container_id="$("${COMPOSE[@]}" ps -q "${service}")"
    if [[ -z "${container_id}" ]]; then
      echo "Required infrastructure service ${service} is not created." >&2
      return 1
    fi

    state="$(docker inspect "${container_id}" --format '{{.State.Status}}')"
    health="$(docker inspect "${container_id}" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')"
    if [[ "${state}" != "running" || ("${health}" != "healthy" && "${health}" != "none") ]]; then
      echo "Required infrastructure service ${service} is not ready (state=${state}, health=${health})." >&2
      return 1
    fi

    port_bindings="$(docker inspect "${container_id}" --format '{{json .HostConfig.PortBindings}}')"
    python3 - "${service}" "${port_bindings}" <<'PY'
import json
import sys

service_name = sys.argv[1]
bindings = json.loads(sys.argv[2]) or {}

if service_name == "redis" and bindings:
    raise SystemExit(f"Running Redis container publishes host ports: {bindings}")

for container_port, published_ports in bindings.items():
    for published_port in published_ports or []:
        if published_port.get("HostIp") not in ("127.0.0.1", "::1"):
            raise SystemExit(
                f"Running {service_name} container publishes {container_port} outside loopback: {published_port}"
            )
PY
  done
}

wait_for_service_health() {
  local service="$1"
  local container_id
  local state
  local health

  for _ in {1..60}; do
    container_id="$("${COMPOSE[@]}" ps -q "${service}")"
    if [[ -n "${container_id}" ]]; then
      state="$(docker inspect "${container_id}" --format '{{.State.Status}}')"
      health="$(docker inspect "${container_id}" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')"
      if [[ "${state}" == "running" && ("${health}" == "healthy" || "${health}" == "none") ]]; then
        return 0
      fi
    fi
    sleep 2
  done

  echo "Service ${service} did not become healthy in time." >&2
  return 1
}

ensure_redis_internal_only() {
  local container_id
  local port_bindings

  container_id="$("${COMPOSE[@]}" ps -q redis)"
  if [[ -n "${container_id}" ]]; then
    port_bindings="$(docker inspect "${container_id}" --format '{{json .HostConfig.PortBindings}}')"
    if python3 - "${port_bindings}" <<'PY'
import json
import sys

raise SystemExit(0 if not (json.loads(sys.argv[1]) or {}) else 1)
PY
    then
      wait_for_service_health redis
      return 0
    fi

    echo "Redis still publishes a host port; recreating it on the internal Compose network..."
  else
    echo "Redis is not created; starting it on the internal Compose network..."
  fi

  # Recreating the container preserves the named redis-data volume while
  # applying the effective Compose configuration without a host port binding.
  "${COMPOSE[@]}" up -d --no-deps --force-recreate redis
  wait_for_service_health redis
}

prepare_identity_infrastructure() {
  wotcv_auth_prepare_cutover "$("${COMPOSE[@]}" ps -q postgres)"
  echo "Applying PostgreSQL migrations before loading the identity dictionary..."
  "${COMPOSE[@]}" run --rm --no-deps --entrypoint sh backend -lc 'npm run db:migrate'
  [[ "$(wotcv_auth_schema_state "$("${COMPOSE[@]}" ps -q postgres)")" == current ]]
  validate_persistent_storage
  validate_postgres_data_baseline

  echo "Recreating ClickHouse with the PostgreSQL-backed identity dictionary..."
  "${COMPOSE[@]}" up -d --no-deps --force-recreate clickhouse
  wait_for_service_health clickhouse
  validate_persistent_storage
  validate_clickhouse_event_baseline
  validate_postgres_data_baseline

  printf '%s\n' "SELECT dictGetOrDefault('user_identity_dict', 'user_id', tuple(toUInt64(0), ''), '')" | \
    docker exec -i clickhouse sh -lc \
      'clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --database "$CLICKHOUSE_DB"' \
      >/dev/null
}

switch_to_branch() {
  local remote_sha

  git fetch "${DEPLOY_REMOTE}" --prune

  remote_sha="$(git rev-parse "${DEPLOY_REMOTE}/${DEPLOY_BRANCH}")"
  if [[ -n "${EXPECTED_GIT_SHA}" && "${remote_sha}" != "${EXPECTED_GIT_SHA}" ]]; then
    echo "Refusing deployment: ${DEPLOY_REMOTE}/${DEPLOY_BRANCH} is ${remote_sha}, expected ${EXPECTED_GIT_SHA}." >&2
    return 1
  fi

  if git show-ref --verify --quiet "refs/heads/${DEPLOY_BRANCH}"; then
    git switch "${DEPLOY_BRANCH}"
  else
    git switch --track -c "${DEPLOY_BRANCH}" "${DEPLOY_REMOTE}/${DEPLOY_BRANCH}"
  fi

  git merge --ff-only "${DEPLOY_REMOTE}/${DEPLOY_BRANCH}"

  if [[ -n "${EXPECTED_GIT_SHA}" && "$(git rev-parse HEAD)" != "${EXPECTED_GIT_SHA}" ]]; then
    echo "Refusing deployment: checked out HEAD does not match ${EXPECTED_GIT_SHA}." >&2
    return 1
  fi
}

rollback() {
  local previous_tag="$1"
  local previous_git_sha="$2"
  local previous_build_time="$3"
  local previous_backend_digest="$4"
  local previous_client_digest="$5"
  local rollback_deployed_at
  local rollback_response

  if [[ -z "${previous_tag}" || -z "${previous_git_sha}" ]]; then
    echo "No previous local build recorded; rollback must be performed manually." >&2
    return 1
  fi

  if ! docker image inspect "${BACKEND_IMAGE}:${previous_tag}" >/dev/null 2>&1; then
    echo "Previous backend image ${BACKEND_IMAGE}:${previous_tag} is not present locally." >&2
    return 1
  fi

  if ! docker image inspect "${CLIENT_IMAGE}:${previous_tag}" >/dev/null 2>&1; then
    echo "Previous client image ${CLIENT_IMAGE}:${previous_tag} is not present locally." >&2
    return 1
  fi

  echo "Rolling back to ${previous_tag}..." >&2
  wotcv_auth_assert_rollback_safe "${BACKEND_IMAGE}:${previous_tag}" "$("${COMPOSE[@]}" ps -q postgres)" || return 1
  rollback_deployed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  IMAGE_TAG="${previous_tag}" \
  WOTCV_GIT_SHA="${previous_git_sha}" \
  WOTCV_BUILD_TIME="${previous_build_time:-unknown}" \
  WOTCV_DEPLOYED_AT="${rollback_deployed_at}" \
  BACKEND_IMAGE_DIGEST="${previous_backend_digest:-unknown}" \
  CLIENT_IMAGE_DIGEST="${previous_client_digest:-unknown}" \
    "${COMPOSE[@]}" up -d --no-deps --force-recreate backend client || return 1

  validate_persistent_storage || return 1
  validate_clickhouse_event_baseline || return 1
  validate_postgres_data_baseline || return 1

  if ! rollback_response="$(wotcv_wait_for_health "${HEALTHCHECK_URL}" "${previous_git_sha}" "${previous_tag}")"; then
    echo "Rollback health check failed; manual intervention is required." >&2
    return 1
  fi

  if [[ "${rollback_response}" != *"\"gitSha\":\"${previous_git_sha}\""* ]]; then
    echo "Rollback returned an unexpected git SHA: ${rollback_response}" >&2
    return 1
  fi

  echo "Rollback completed: ${previous_tag}" >&2
}

PREVIOUS_TAG="$(wotcv_read_state "${STATE_FILE}" LAST_IMAGE_TAG)"
PREVIOUS_GIT_SHA="$(wotcv_read_state "${STATE_FILE}" LAST_GIT_SHA)"
PREVIOUS_BUILD_TIME="$(wotcv_read_state "${STATE_FILE}" BUILD_TIME)"
PREVIOUS_BACKEND_DIGEST="$(wotcv_read_state "${STATE_FILE}" BACKEND_IMAGE_DIGEST)"
PREVIOUS_CLIENT_DIGEST="$(wotcv_read_state "${STATE_FILE}" CLIENT_IMAGE_DIGEST)"

echo "Fetching and fast-forwarding ${DEPLOY_REMOTE}/${DEPLOY_BRANCH}..."
SCRIPT_START_SHA="$(git rev-parse HEAD)"
switch_to_branch

# A fast-forward can replace this script while an older Bash process is
# already reading it. Restart from the checked-out copy before any validation,
# build, migration, or container operation.
CURRENT_GIT_SHA="$(git rev-parse HEAD)"
if [[ "${SCRIPT_START_SHA}" != "${CURRENT_GIT_SHA}" ]]; then
  echo "Deployment script changed during fast-forward; restarting at ${CURRENT_GIT_SHA}..."
  exec bash "${ROOT_DIR}/scripts/wotcv-branch-build-deploy.sh"
fi

WOTCV_GIT_SHA="$(git rev-parse HEAD)"
IMAGE_TAG="sha-${WOTCV_GIT_SHA}"
WOTCV_BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
WOTCV_DEPLOYED_AT="${WOTCV_BUILD_TIME}"

export IMAGE_TAG WOTCV_GIT_SHA WOTCV_BUILD_TIME WOTCV_DEPLOYED_AT
export BACKEND_IMAGE_DIGEST=unknown
export CLIENT_IMAGE_DIGEST=unknown

echo "Validating Compose configuration for ${DEPLOY_BRANCH} at ${WOTCV_GIT_SHA}..."
COMPOSE_CONFIG_FILE="$(mktemp "${TMPDIR:-/tmp}/rybbit-wotcv-branch-build-compose.${UID}.XXXXXX.json")"
"${COMPOSE[@]}" config --format json >"${COMPOSE_CONFIG_FILE}"
validate_compose_config
wotcv_validate_compose_persistence \
  "${COMPOSE_CONFIG_FILE}" \
  "${EXPECTED_COMPOSE_PROJECT_NAME}" \
  "${CLICKHOUSE_VOLUME_NAME}" \
  "${POSTGRES_VOLUME_NAME}" \
  "${REDIS_VOLUME_NAME}"
require_persistent_volumes
validate_persistent_storage
capture_clickhouse_event_baseline
capture_postgres_data_baseline
ensure_redis_internal_only
validate_infrastructure
validate_persistent_storage
validate_clickhouse_event_baseline
validate_postgres_data_baseline

BUILD_COMMAND=(build)
if [[ "${WOTCV_BUILD_PULL:-0}" == "1" ]]; then
  BUILD_COMMAND+=(--pull)
fi

echo "Building backend and client locally from ${DEPLOY_BRANCH}..."
"${COMPOSE[@]}" "${BUILD_COMMAND[@]}" backend client

echo "Validating runtime contents of backend and client images..."
validate_runtime_images

prepare_identity_infrastructure
validate_infrastructure
validate_persistent_storage
validate_clickhouse_event_baseline
validate_postgres_data_baseline

BACKEND_IMAGE_DIGEST="$(image_id "${BACKEND_IMAGE}" "${IMAGE_TAG}")"
CLIENT_IMAGE_DIGEST="$(image_id "${CLIENT_IMAGE}" "${IMAGE_TAG}")"
export BACKEND_IMAGE_DIGEST CLIENT_IMAGE_DIGEST

echo "Starting backend and client..."
if ! "${COMPOSE[@]}" up -d --no-deps --force-recreate backend client; then
  echo "Compose startup failed. Attempting rollback..." >&2
  rollback "${PREVIOUS_TAG}" "${PREVIOUS_GIT_SHA}" "${PREVIOUS_BUILD_TIME}" "${PREVIOUS_BACKEND_DIGEST}" "${PREVIOUS_CLIENT_DIGEST}" || true
  exit 1
fi

validate_persistent_storage
validate_clickhouse_event_baseline
validate_postgres_data_baseline

if ! HEALTH_RESPONSE="$(wotcv_wait_for_health "${HEALTHCHECK_URL}" "${WOTCV_GIT_SHA}" "${IMAGE_TAG}")"; then
  echo "Health check failed. Recent logs:" >&2
  "${COMPOSE[@]}" logs --since=10m backend client >&2 || true
  rollback "${PREVIOUS_TAG}" "${PREVIOUS_GIT_SHA}" "${PREVIOUS_BUILD_TIME}" "${PREVIOUS_BACKEND_DIGEST}" "${PREVIOUS_CLIENT_DIGEST}" || true
  exit 1
fi

if [[ "${HEALTH_RESPONSE}" != *"\"gitSha\":\"${WOTCV_GIT_SHA}\""* ]]; then
  echo "Health endpoint returned an unexpected git SHA: ${HEALTH_RESPONSE}" >&2
  rollback "${PREVIOUS_TAG}" "${PREVIOUS_GIT_SHA}" "${PREVIOUS_BUILD_TIME}" "${PREVIOUS_BACKEND_DIGEST}" "${PREVIOUS_CLIENT_DIGEST}" || true
  exit 1
fi

if [[ "${HEALTH_RESPONSE}" != *"\"imageTag\":\"${IMAGE_TAG}\""* ]]; then
  echo "Health endpoint returned an unexpected image tag: ${HEALTH_RESPONSE}" >&2
  rollback "${PREVIOUS_TAG}" "${PREVIOUS_GIT_SHA}" "${PREVIOUS_BUILD_TIME}" "${PREVIOUS_BACKEND_DIGEST}" "${PREVIOUS_CLIENT_DIGEST}" || true
  exit 1
fi

echo "Running Identity Resolution v2 post-deployment preflight..."
if ! bash scripts/wotcv-identity-v2-preflight.sh; then
  echo "Identity preflight failed. Attempting application rollback..." >&2
  rollback "${PREVIOUS_TAG}" "${PREVIOUS_GIT_SHA}" "${PREVIOUS_BUILD_TIME}" "${PREVIOUS_BACKEND_DIGEST}" "${PREVIOUS_CLIENT_DIGEST}" || true
  exit 1
fi

cat >"${STATE_FILE}.tmp" <<EOF
LAST_BRANCH=${DEPLOY_BRANCH}
LAST_GIT_SHA=${WOTCV_GIT_SHA}
LAST_IMAGE_TAG=${IMAGE_TAG}
BACKEND_IMAGE_DIGEST=${BACKEND_IMAGE_DIGEST}
CLIENT_IMAGE_DIGEST=${CLIENT_IMAGE_DIGEST}
BUILD_TIME=${WOTCV_BUILD_TIME}
DEPLOYED_AT=${WOTCV_DEPLOYED_AT}
EOF
mv "${STATE_FILE}.tmp" "${STATE_FILE}"

echo "Branch build deployment completed."
echo "Branch: ${DEPLOY_BRANCH}"
echo "Git SHA: ${WOTCV_GIT_SHA}"
echo "Image tag: ${IMAGE_TAG}"
echo "Backend image ID: ${BACKEND_IMAGE_DIGEST}"
echo "Client image ID: ${CLIENT_IMAGE_DIGEST}"
echo "Health: ${HEALTH_RESPONSE}"
