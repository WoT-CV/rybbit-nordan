#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${ROOT_DIR}/scripts/lib/wotcv-common.sh"
source "${ROOT_DIR}/scripts/lib/wotcv-auth-cutover.sh"
STATE_FILE="${ROOT_DIR}/.wotcv-deployment.env"
HEALTHCHECK_URL="${WOTCV_HEALTHCHECK_URL:-http://127.0.0.1:3001/api/health}"
TARGET_TAG="${1:-${IMAGE_TAG:-}}"
BACKEND_IMAGE="ghcr.io/wot-cv/rybbit-wotcv-backend"
CLIENT_IMAGE="ghcr.io/wot-cv/rybbit-wotcv-client"
COMPOSE_PROJECT_NAME="${WOTCV_COMPOSE_PROJECT_NAME:-${COMPOSE_PROJECT_NAME:-rybbit}}"
EXPECTED_COMPOSE_PROJECT_NAME="${WOTCV_EXPECTED_COMPOSE_PROJECT_NAME:-rybbit}"
CLICKHOUSE_VOLUME_NAME="${WOTCV_CLICKHOUSE_VOLUME_NAME:-rybbit_clickhouse-data}"
POSTGRES_VOLUME_NAME="${WOTCV_POSTGRES_VOLUME_NAME:-rybbit_postgres-data}"
REDIS_VOLUME_NAME="${WOTCV_REDIS_VOLUME_NAME:-rybbit_redis-data}"
COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.wotcv.yml)
COMPOSE_CONFIG_FILE=""
CLICKHOUSE_EVENT_BASELINE=""
CLICKHOUSE_REPLAY_WINDOW_START=""
CLICKHOUSE_PROTECTED_COHORT_END=""
POSTGRES_DATA_BASELINE=""

cleanup() {
  local code=$?
  if [[ "${code}" != 0 && "${WOTCV_AUTH_CUTOVER_STARTED}" == 1 ]]; then
    echo "Auth cutover did not complete. Do not restart a 1.6 image blindly; see docs/WOTCV_AUTH_CUTOVER.md." >&2
  fi
  [[ -z "${COMPOSE_CONFIG_FILE}" ]] || rm -f "${COMPOSE_CONFIG_FILE}"
}

trap cleanup EXIT

cd "${ROOT_DIR}"
export COMPOSE_PROJECT_NAME

if [[ -z "${TARGET_TAG}" ]]; then
  echo "Usage: IMAGE_TAG=sha-<commit> ./scripts/wotcv-deploy.sh" >&2
  exit 1
fi

if [[ ! "${TARGET_TAG}" =~ ^sha-[0-9a-f]{7,40}$ ]]; then
  echo "IMAGE_TAG must be an immutable sha-* tag." >&2
  exit 1
fi

wotcv_require_non_root
wotcv_require_expected_compose_project "${COMPOSE_PROJECT_NAME}" "${EXPECTED_COMPOSE_PROJECT_NAME}"
wotcv_require_commands git docker curl python3
wotcv_require_clean_worktree

image_digest() {
  local image="$1"
  docker image inspect "${image}:${TARGET_TAG}" --format '{{index .RepoDigests 0}}' | awk -F@ '{print $2}'
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

rollback() {
  local previous_tag="$1"
  local previous_backend_digest="$2"
  local previous_client_digest="$3"
  local rollback_deployed_at
  local rollback_response

  if [[ -z "${previous_tag}" ]]; then
    echo "No previous deployment tag recorded; rollback must be performed manually." >&2
    return 1
  fi

  echo "Rolling back to ${previous_tag}..." >&2
  rollback_deployed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  IMAGE_TAG="${previous_tag}" \
  BACKEND_IMAGE_DIGEST="${previous_backend_digest:-unknown}" \
  CLIENT_IMAGE_DIGEST="${previous_client_digest:-unknown}" \
  WOTCV_DEPLOYED_AT="${rollback_deployed_at}" \
    "${COMPOSE[@]}" pull backend client || return 1
  wotcv_auth_assert_rollback_safe "${BACKEND_IMAGE}:${previous_tag}" "$("${COMPOSE[@]}" ps -q postgres)" || return 1
  IMAGE_TAG="${previous_tag}" \
  BACKEND_IMAGE_DIGEST="${previous_backend_digest:-unknown}" \
  CLIENT_IMAGE_DIGEST="${previous_client_digest:-unknown}" \
  WOTCV_DEPLOYED_AT="${rollback_deployed_at}" \
    "${COMPOSE[@]}" up -d --no-deps --force-recreate backend client || return 1

  validate_persistent_storage || return 1
  validate_clickhouse_event_baseline || return 1
  validate_postgres_data_baseline || return 1

  if ! rollback_response="$(wotcv_wait_for_health "${HEALTHCHECK_URL}" "" "${previous_tag}")"; then
    echo "Rollback health check failed; manual intervention is required." >&2
    return 1
  fi

  if [[ "${rollback_response}" != *"\"imageTag\":\"${previous_tag}\""* ]]; then
    echo "Rollback returned an unexpected image tag: ${rollback_response}" >&2
    return 1
  fi

  echo "Rollback completed: ${previous_tag}" >&2
}

PREVIOUS_TAG="$(wotcv_read_state "${STATE_FILE}" LAST_IMAGE_TAG)"
PREVIOUS_BACKEND_DIGEST="$(wotcv_read_state "${STATE_FILE}" BACKEND_IMAGE_DIGEST)"
PREVIOUS_CLIENT_DIGEST="$(wotcv_read_state "${STATE_FILE}" CLIENT_IMAGE_DIGEST)"
WOTCV_DEPLOYED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

export IMAGE_TAG="${TARGET_TAG}"
export WOTCV_DEPLOYED_AT

echo "Validating Compose configuration for ${IMAGE_TAG}..."
COMPOSE_CONFIG_FILE="$(mktemp "${TMPDIR:-/tmp}/rybbit-wotcv-deploy-compose.${UID}.XXXXXX.json")"
"${COMPOSE[@]}" config --format json >"${COMPOSE_CONFIG_FILE}"
wotcv_validate_compose_ports "${COMPOSE_CONFIG_FILE}"
wotcv_validate_compose_logging "${COMPOSE_CONFIG_FILE}"
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

echo "Pulling immutable application images..."
"${COMPOSE[@]}" pull backend client

# Database preflight must come from exactly the revision being deployed.
TARGET_REVISION="$(docker image inspect "${BACKEND_IMAGE}:${TARGET_TAG}" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
if [[ "${TARGET_REVISION}" != "$(git rev-parse HEAD)" ]]; then
  echo "Check out the target image revision before deploying: local migration preflight must match the image." >&2
  exit 1
fi
CLIENT_REVISION="$(docker image inspect "${CLIENT_IMAGE}:${TARGET_TAG}" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
if [[ "${CLIENT_REVISION}" != "${TARGET_REVISION}" ]]; then
  echo "Client and backend images must come from the same reviewed revision." >&2
  exit 1
fi
export WOTCV_GIT_SHA="${TARGET_REVISION}"
if [[ "$(wotcv_auth_image_version "${BACKEND_IMAGE}:${TARGET_TAG}")" != 1.7.3 ]]; then
  echo "This deployment script supports the reviewed Better Auth 1.7.3 images only." >&2
  exit 1
fi
wotcv_auth_prepare_cutover "$("${COMPOSE[@]}" ps -q postgres)"
echo "Applying PostgreSQL migrations with old auth workers drained when required..."
"${COMPOSE[@]}" run --rm --no-deps --entrypoint sh backend -lc 'npm run db:migrate'
[[ "$(wotcv_auth_schema_state "$("${COMPOSE[@]}" ps -q postgres)")" == current ]]
validate_persistent_storage
validate_postgres_data_baseline

BACKEND_IMAGE_DIGEST="$(image_digest "${BACKEND_IMAGE}")"
CLIENT_IMAGE_DIGEST="$(image_digest "${CLIENT_IMAGE}")"
export BACKEND_IMAGE_DIGEST CLIENT_IMAGE_DIGEST

echo "Starting backend and client..."
"${COMPOSE[@]}" up -d --no-deps --force-recreate backend client
validate_persistent_storage
validate_clickhouse_event_baseline
validate_postgres_data_baseline

if ! HEALTH_RESPONSE="$(wotcv_wait_for_health "${HEALTHCHECK_URL}" "" "${IMAGE_TAG}")"; then
  echo "Health check failed. Recent logs:" >&2
  "${COMPOSE[@]}" logs --since=10m backend client >&2 || true
  rollback "${PREVIOUS_TAG}" "${PREVIOUS_BACKEND_DIGEST}" "${PREVIOUS_CLIENT_DIGEST}" || true
  exit 1
fi

if [[ "${HEALTH_RESPONSE}" != *"\"imageTag\":\"${IMAGE_TAG}\""* ]]; then
  echo "Health endpoint returned an unexpected image tag: ${HEALTH_RESPONSE}" >&2
  rollback "${PREVIOUS_TAG}" "${PREVIOUS_BACKEND_DIGEST}" "${PREVIOUS_CLIENT_DIGEST}" || true
  exit 1
fi

echo "Running Identity Resolution v2 post-deployment preflight..."
if ! bash scripts/wotcv-identity-v2-preflight.sh; then
  echo "Identity preflight failed. Attempting application rollback..." >&2
  rollback "${PREVIOUS_TAG}" "${PREVIOUS_BACKEND_DIGEST}" "${PREVIOUS_CLIENT_DIGEST}" || true
  exit 1
fi

cat >"${STATE_FILE}.tmp" <<EOF
LAST_IMAGE_TAG=${IMAGE_TAG}
BACKEND_IMAGE_DIGEST=${BACKEND_IMAGE_DIGEST}
CLIENT_IMAGE_DIGEST=${CLIENT_IMAGE_DIGEST}
DEPLOYED_AT=${WOTCV_DEPLOYED_AT}
EOF
mv "${STATE_FILE}.tmp" "${STATE_FILE}"

echo "Deployment completed."
echo "Tag: ${IMAGE_TAG}"
echo "Backend digest: ${BACKEND_IMAGE_DIGEST}"
echo "Client digest: ${CLIENT_IMAGE_DIGEST}"
echo "Health: ${HEALTH_RESPONSE}"
