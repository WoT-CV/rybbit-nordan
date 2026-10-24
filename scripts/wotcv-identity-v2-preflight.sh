#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${ROOT_DIR}/scripts/lib/wotcv-common.sh"
STATE_FILE="${ROOT_DIR}/.wotcv-deployment.env"
HEALTHCHECK_URL="${WOTCV_HEALTHCHECK_URL:-http://127.0.0.1:3001/api/health}"
COMPOSE_PROJECT_NAME="${WOTCV_COMPOSE_PROJECT_NAME:-${COMPOSE_PROJECT_NAME:-rybbit}}"
EXPECTED_COMPOSE_PROJECT_NAME="${WOTCV_EXPECTED_COMPOSE_PROJECT_NAME:-rybbit}"
CLICKHOUSE_VOLUME_NAME="${WOTCV_CLICKHOUSE_VOLUME_NAME:-rybbit_clickhouse-data}"
POSTGRES_VOLUME_NAME="${WOTCV_POSTGRES_VOLUME_NAME:-rybbit_postgres-data}"
REDIS_VOLUME_NAME="${WOTCV_REDIS_VOLUME_NAME:-rybbit_redis-data}"
COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.wotcv.yml)

cd "${ROOT_DIR}"
export COMPOSE_PROJECT_NAME

wotcv_require_non_root
wotcv_require_expected_compose_project "${COMPOSE_PROJECT_NAME}" "${EXPECTED_COMPOSE_PROJECT_NAME}"
wotcv_require_commands docker curl python3

IMAGE_TAG="${IMAGE_TAG:-$(wotcv_read_state "${STATE_FILE}" LAST_IMAGE_TAG)}"
WOTCV_GIT_SHA="${WOTCV_GIT_SHA:-$(wotcv_read_state "${STATE_FILE}" LAST_GIT_SHA)}"
: "${IMAGE_TAG:?IMAGE_TAG is unavailable; deploy once or export IMAGE_TAG}"
export IMAGE_TAG

wait_for_container_ready() {
  local service="$1"
  local attempts="${WOTCV_PREFLIGHT_READY_ATTEMPTS:-60}"
  local container_id=""
  local state="missing"
  local health="unknown"

  for ((attempt = 1; attempt <= attempts; attempt++)); do
    container_id="$("${COMPOSE[@]}" ps -q "${service}")"
    if [[ -n "${container_id}" ]]; then
      state="$(docker inspect "${container_id}" --format '{{.State.Status}}')"
      health="$(docker inspect "${container_id}" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')"

      if [[ "${state}" == "running" && ("${health}" == "healthy" || "${health}" == "none") ]]; then
        return 0
      fi

      if [[ "${state}" == "exited" || "${state}" == "dead" ]]; then
        echo "${service} stopped while waiting for readiness (state=${state}, health=${health})." >&2
        return 1
      fi
    fi

    sleep 2
  done

  echo "${service} did not become ready (state=${state}, health=${health})." >&2
  return 1
}

echo "[1/7] Validating effective Compose ports and persistence..."
compose_config="$(mktemp "${TMPDIR:-/tmp}/rybbit-identity-preflight.${UID}.XXXXXX.json")"
trap 'rm -f "${compose_config}"' EXIT
"${COMPOSE[@]}" config --format json >"${compose_config}"
wotcv_validate_compose_ports "${compose_config}"
wotcv_validate_compose_logging "${compose_config}"
wotcv_validate_compose_persistence \
  "${compose_config}" \
  "${EXPECTED_COMPOSE_PROJECT_NAME}" \
  "${CLICKHOUSE_VOLUME_NAME}" \
  "${POSTGRES_VOLUME_NAME}" \
  "${REDIS_VOLUME_NAME}"
wotcv_require_named_volume "${CLICKHOUSE_VOLUME_NAME}"
wotcv_require_named_volume "${POSTGRES_VOLUME_NAME}"
wotcv_require_named_volume "${REDIS_VOLUME_NAME}"

echo "[2/7] Verifying running containers, storage, and Redis isolation..."
for service in postgres clickhouse redis backend client; do
  wait_for_container_ready "${service}"
done
wotcv_validate_runtime_logging "${EXPECTED_COMPOSE_PROJECT_NAME}" \
  clickhouse "$("${COMPOSE[@]}" ps -q clickhouse)" \
  postgres "$("${COMPOSE[@]}" ps -q postgres)" \
  redis "$("${COMPOSE[@]}" ps -q redis)" \
  backend "$("${COMPOSE[@]}" ps -q backend)" \
  client "$("${COMPOSE[@]}" ps -q client)"

wotcv_validate_container_persistence \
  "$("${COMPOSE[@]}" ps -q clickhouse)" \
  clickhouse \
  "${EXPECTED_COMPOSE_PROJECT_NAME}" \
  "${CLICKHOUSE_VOLUME_NAME}" \
  /var/lib/clickhouse
wotcv_validate_container_persistence \
  "$("${COMPOSE[@]}" ps -q postgres)" \
  postgres \
  "${EXPECTED_COMPOSE_PROJECT_NAME}" \
  "${POSTGRES_VOLUME_NAME}" \
  /var/lib/postgresql/data
wotcv_validate_container_persistence \
  "$("${COMPOSE[@]}" ps -q redis)" \
  redis \
  "${EXPECTED_COMPOSE_PROJECT_NAME}" \
  "${REDIS_VOLUME_NAME}" \
  /data

redis_id="$("${COMPOSE[@]}" ps -q redis)"
redis_bindings="$(docker inspect "${redis_id}" --format '{{json .HostConfig.PortBindings}}')"
python3 - "${redis_bindings}" <<'PY'
import json
import sys

bindings = json.loads(sys.argv[1]) or {}
if bindings:
    raise SystemExit(f"Running Redis publishes host ports: {bindings}")
PY
docker exec backend sh -lc 'getent hosts redis >/dev/null && nc -zvw3 redis 6379'

echo "[3/7] Verifying PostgreSQL identity schema..."
column_count="$(printf '%s\n' \
  "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'user_aliases' AND column_name IN ('source', 'updated_at')" | \
  docker exec -i postgres sh -lc 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At')"
[[ "${column_count}" == "2" ]] || { echo "Identity migration columns are missing." >&2; exit 1; }

constraint_count="$(printf '%s\n' \
  "SELECT count(*) FROM pg_constraint WHERE conname IN ('user_aliases_site_anon_unique', 'user_aliases_source_check')" | \
  docker exec -i postgres sh -lc 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At')"
[[ "${constraint_count}" == "2" ]] || { echo "Identity constraints are missing." >&2; exit 1; }

echo "[4/7] Loading and checking the ClickHouse dictionary..."
printf '%s\n' "SELECT dictGetOrDefault('user_identity_dict', 'user_id', tuple(toUInt64(0), ''), '')" | \
  docker exec -i clickhouse sh -lc \
    'clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --database "$CLICKHOUSE_DB"' \
    >/dev/null

dictionary_status="$(printf '%s\n' "SELECT status FROM system.dictionaries WHERE name = 'user_identity_dict'" | \
  docker exec -i clickhouse sh -lc \
    'clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --database "$CLICKHOUSE_DB" --format TSVRaw')"
[[ "${dictionary_status}" == "LOADED" ]] || {
  echo "Identity dictionary status is ${dictionary_status:-missing}." >&2
  exit 1
}

echo "[5/7] Comparing a PostgreSQL alias with ClickHouse resolution..."
sample_alias="$(printf '%s\n' \
  "SELECT row_to_json(sample) FROM (SELECT site_id, anonymous_id, user_id FROM user_aliases ORDER BY updated_at DESC, id DESC LIMIT 1) AS sample" | \
  docker exec -i postgres sh -lc 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At')"
if [[ -n "${sample_alias}" ]]; then
  sample_site_id="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["site_id"])' "${sample_alias}")"
  sample_anonymous_id="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["anonymous_id"])' "${sample_alias}")"
  sample_user_id="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["user_id"])' "${sample_alias}")"
  resolved_user_id="$(printf '%s\n' \
    "SELECT dictGetOrDefault('user_identity_dict', 'user_id', tuple({site_id:UInt64}, {anonymous_id:String}), '')" | \
    docker exec -i clickhouse sh -lc \
      'clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --database "$CLICKHOUSE_DB" --format TSVRaw --param_site_id "$1" --param_anonymous_id "$2"' \
      sh "${sample_site_id}" "${sample_anonymous_id}")"
  [[ "${resolved_user_id}" == "${sample_user_id}" ]] || {
    echo "Dictionary resolved '${resolved_user_id}' instead of '${sample_user_id}'." >&2
    exit 1
  }
else
  echo "No aliases exist yet; sample lookup skipped."
fi

echo "[6/7] Checking for legacy identity mutations..."
pending_mutations="$(printf '%s\n' \
  "SELECT count() FROM system.mutations WHERE is_done = 0 AND command LIKE '%identified_user_id%'" | \
  docker exec -i clickhouse sh -lc \
    'clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --database "$CLICKHOUSE_DB" --format TSVRaw')"
if [[ "${pending_mutations}" != "0" ]]; then
  echo "WARNING: ${pending_mutations} legacy identified_user_id mutation(s) are still running." >&2
fi

echo "[7/7] Verifying backend health and deployed revision..."
health_response="$(curl --fail --silent --show-error --max-time 5 "${HEALTHCHECK_URL}")"
if [[ -n "${WOTCV_GIT_SHA}" && "${health_response}" != *"\"gitSha\":\"${WOTCV_GIT_SHA}\""* ]]; then
  echo "Health endpoint reports an unexpected git SHA: ${health_response}" >&2
  exit 1
fi
if [[ "${health_response}" != *"\"imageTag\":\"${IMAGE_TAG}\""* ]]; then
  echo "Health endpoint reports an unexpected image tag: ${health_response}" >&2
  exit 1
fi

echo "Identity Resolution v2 preflight passed."
echo "Health: ${health_response}"
