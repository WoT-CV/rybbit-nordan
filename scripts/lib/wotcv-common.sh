#!/usr/bin/env bash

set -Eeuo pipefail

WOTCV_COMMON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WOTCV_PERSISTENCE_HELPER="${WOTCV_COMMON_DIR}/wotcv_persistence.py"
# Replay tables expire after 30 days. Protecting a fixed 29-day cohort leaves
# a full day before its oldest row can legitimately be removed by TTL.
WOTCV_REPLAY_PROTECTED_WINDOW_SECONDS=$((29 * 24 * 60 * 60))

wotcv_require_non_root() {
  if [[ "${EUID}" -eq 0 ]]; then
    echo "Run this script as the deployment user, without sudo." >&2
    return 1
  fi
}

wotcv_require_commands() {
  local command_name

  for command_name in "$@"; do
    command -v "${command_name}" >/dev/null 2>&1 || {
      echo "${command_name} is required." >&2
      return 1
    }
  done
}

wotcv_require_clean_worktree() {
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "Working tree must be clean before deployment." >&2
    return 1
  fi
}

wotcv_require_expected_compose_project() {
  local actual_project="$1"
  local expected_project="$2"

  if [[ -z "${expected_project}" ]]; then
    echo "WOTCV_EXPECTED_COMPOSE_PROJECT_NAME cannot be empty." >&2
    return 1
  fi

  if [[ "${actual_project}" != "${expected_project}" ]]; then
    echo "Refusing deployment: Compose project is '${actual_project}', expected '${expected_project}'." >&2
    return 1
  fi
}

wotcv_validate_compose_ports() {
  local config_file="$1"

  python3 - "${config_file}" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as stream:
    services = json.load(stream)["services"]

if services["redis"].get("ports"):
    raise SystemExit("Redis must not publish a host port")

for name in ("clickhouse", "postgres", "backend", "client"):
    for port in services[name].get("ports") or []:
        if port.get("host_ip") not in ("127.0.0.1", "::1"):
            raise SystemExit(f"{name} publishes outside loopback: {port}")

print("Compose port validation passed.")
PY
}

wotcv_validate_compose_logging() {
  local config_file="$1"

  python3 "${WOTCV_COMMON_DIR}/wotcv_logging.py" "${config_file}"
}

wotcv_validate_compose_persistence() {
  local config_file="$1"
  local expected_project="$2"
  local clickhouse_volume="$3"
  local postgres_volume="$4"
  local redis_volume="$5"

  python3 "${WOTCV_PERSISTENCE_HELPER}" validate-config \
    --config "${config_file}" \
    --expected-project "${expected_project}" \
    --clickhouse-volume "${clickhouse_volume}" \
    --postgres-volume "${postgres_volume}" \
    --redis-volume "${redis_volume}"
}

wotcv_require_named_volume() {
  local volume_name="$1"

  if ! docker volume inspect "${volume_name}" >/dev/null 2>&1; then
    echo "Refusing deployment: required external volume '${volume_name}' does not exist." >&2
    return 1
  fi
}

wotcv_validate_container_persistence() {
  local container_id="$1"
  local service_name="$2"
  local expected_project="$3"
  local expected_volume="$4"
  local target="$5"
  local actual_project
  local mounts_json

  if [[ -z "${container_id}" ]]; then
    echo "Refusing deployment: ${service_name} container does not exist." >&2
    return 1
  fi

  actual_project="$(docker inspect "${container_id}" \
    --format '{{index .Config.Labels "com.docker.compose.project"}}')" || return 1
  mounts_json="$(docker inspect "${container_id}" --format '{{json .Mounts}}')" || return 1

  python3 "${WOTCV_PERSISTENCE_HELPER}" validate-container \
    --service "${service_name}" \
    --actual-project "${actual_project}" \
    --expected-project "${expected_project}" \
    --expected-volume "${expected_volume}" \
    --target "${target}" \
    --mounts-json "${mounts_json}"
}

wotcv_clickhouse_event_invariants() {
  local container_id="$1"
  local replay_window_start_timestamp="${2:-}"
  local protected_cohort_end_timestamp="${3:-}"
  local core_invariants
  local query
  local snapshot_timestamp
  local v2_exists
  local v2_invariants
  local v2_sessions=0
  local v2_protected_sessions=0

  if [[ -z "${container_id}" ]]; then
    echo "Cannot read ClickHouse event invariants: container does not exist." >&2
    return 1
  fi

  snapshot_timestamp="$(printf '%s\n' 'SELECT toUnixTimestamp(now()) FORMAT TSVRaw' | \
    docker exec -i "${container_id}" sh -lc \
      'clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --database "$CLICKHOUSE_DB"')" || {
    echo "Cannot read ClickHouse snapshot timestamp." >&2
    return 1
  }
  if [[ ! "${snapshot_timestamp}" =~ ^[0-9]+$ ]]; then
    echo "Cannot read a valid ClickHouse invariant snapshot timestamp." >&2
    return 1
  fi

  if [[ -z "${replay_window_start_timestamp}" && -z "${protected_cohort_end_timestamp}" ]]; then
    protected_cohort_end_timestamp="${snapshot_timestamp}"
    replay_window_start_timestamp=$((protected_cohort_end_timestamp - WOTCV_REPLAY_PROTECTED_WINDOW_SECONDS))
  elif [[ -z "${replay_window_start_timestamp}" || -z "${protected_cohort_end_timestamp}" ]]; then
    echo "ClickHouse replay protection window requires both start and end timestamps." >&2
    return 1
  elif [[ ! "${replay_window_start_timestamp}" =~ ^[0-9]+$ ]] || \
    [[ ! "${protected_cohort_end_timestamp}" =~ ^[0-9]+$ ]]; then
    echo "ClickHouse replay protection window bounds must be integer timestamps." >&2
    return 1
  fi
  if (( protected_cohort_end_timestamp > snapshot_timestamp )); then
    echo "ClickHouse protected cohort cannot end after its snapshot." >&2
    return 1
  fi
  if (( replay_window_start_timestamp >= protected_cohort_end_timestamp )); then
    echo "ClickHouse replay protection window must start before its cohort end." >&2
    return 1
  fi

  query="SELECT
    (SELECT count() FROM events
      WHERE timestamp <= toDateTime(${protected_cohort_end_timestamp})),
    (SELECT if(count() = 0, 0, toUnixTimestamp(min(timestamp))) FROM events
      WHERE timestamp <= toDateTime(${protected_cohort_end_timestamp})),
    (SELECT if(count() = 0, 0, toUnixTimestamp(max(timestamp))) FROM events
      WHERE timestamp <= toDateTime(${protected_cohort_end_timestamp})),
    (SELECT uniqExact(tuple(site_id, session_id)) FROM events
      WHERE timestamp <= toDateTime(${protected_cohort_end_timestamp})),
    (SELECT uniqExact(tuple(site_id, toDate(timestamp), session_id)) FROM events
      WHERE timestamp <= toDateTime(${protected_cohort_end_timestamp})),
    toUInt64(${snapshot_timestamp}),
    toUInt64(${replay_window_start_timestamp}),
    toUInt64(${protected_cohort_end_timestamp}),
    (SELECT count() FROM session_replay_events),
    (SELECT uniqExact(tuple(site_id, session_id)) FROM session_replay_events),
    (SELECT uniqExact(tuple(site_id, session_id)) FROM session_replay_metadata FINAL),
    (SELECT count() FROM session_replay_events
      WHERE timestamp >= toDateTime(${replay_window_start_timestamp})
        AND timestamp <= toDateTime(${protected_cohort_end_timestamp})),
    (SELECT uniqExact(tuple(site_id, session_id)) FROM session_replay_events
      WHERE timestamp >= toDateTime(${replay_window_start_timestamp})
        AND timestamp <= toDateTime(${protected_cohort_end_timestamp})),
    (SELECT uniqExact(tuple(site_id, session_id)) FROM session_replay_metadata FINAL
      WHERE start_time >= toDateTime(${replay_window_start_timestamp})
        AND start_time <= toDateTime(${protected_cohort_end_timestamp}))
  FORMAT TSVRaw"
  core_invariants="$(printf '%s\n' "${query}" | docker exec -i "${container_id}" sh -lc \
    'clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --database "$CLICKHOUSE_DB"')" || {
    echo "Cannot read ClickHouse core invariants." >&2
    return 1
  }

  v2_exists="$(printf '%s\n' 'EXISTS TABLE session_replay_metadata_v2 FORMAT TSVRaw' | \
    docker exec -i "${container_id}" sh -lc \
      'clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --database "$CLICKHOUSE_DB"')" || {
    echo "Cannot check whether Replay v2 metadata exists." >&2
    return 1
  }
  if [[ "${v2_exists}" != "0" && "${v2_exists}" != "1" ]]; then
    echo "Invalid Replay v2 table existence response." >&2
    return 1
  fi
  if [[ "${v2_exists}" == "1" ]]; then
    v2_invariants="$(printf '%s\n' \
      "SELECT
        uniqExact(tuple(site_id, session_id)),
        uniqExactIf(
          tuple(site_id, session_id),
          start_time >= toDateTime(${replay_window_start_timestamp})
            AND start_time <= toDateTime(${protected_cohort_end_timestamp})
        )
      FROM session_replay_metadata_v2 FINAL
      FORMAT TSVRaw" | \
      docker exec -i "${container_id}" sh -lc \
        'clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --database "$CLICKHOUSE_DB"')" || {
      echo "Cannot read Replay v2 metadata invariants." >&2
      return 1
    }
    if [[ ! "${v2_invariants}" =~ ^[0-9]+[[:blank:]]+[0-9]+$ ]]; then
      echo "Invalid Replay v2 metadata invariants." >&2
      return 1
    fi
    read -r v2_sessions v2_protected_sessions <<<"${v2_invariants}"
  fi

  printf '%s\t%s\t%s\n' \
    "${core_invariants}" \
    "${v2_sessions}" \
    "${v2_protected_sessions}"
}

wotcv_clickhouse_replay_window_start() {
  local invariants="$1"
  local -a values

  read -r -a values <<<"${invariants}"
  if (( ${#values[@]} != 16 )) || [[ ! "${values[6]}" =~ ^[0-9]+$ ]]; then
    echo "Cannot extract ClickHouse replay protection window from malformed invariants." >&2
    return 1
  fi

  printf '%s\n' "${values[6]}"
}

wotcv_clickhouse_protected_cohort_end() {
  local invariants="$1"
  local -a values

  read -r -a values <<<"${invariants}"
  if (( ${#values[@]} != 16 )) || [[ ! "${values[7]}" =~ ^[0-9]+$ ]]; then
    echo "Cannot extract ClickHouse protected cohort end from malformed invariants." >&2
    return 1
  fi

  printf '%s\n' "${values[7]}"
}

wotcv_assert_clickhouse_event_invariants_not_decreased() {
  local before="$1"
  local after="$2"

  python3 "${WOTCV_PERSISTENCE_HELPER}" compare-events \
    --before "${before}" \
    --after "${after}"
}

wotcv_postgres_data_invariants() {
  local container_id="$1"
  local query

  if [[ -z "${container_id}" ]]; then
    echo "Cannot read PostgreSQL invariants: container does not exist." >&2
    return 1
  fi

  query='SELECT (SELECT count(*) FROM "user"), (SELECT count(*) FROM sites);'
  printf '%s\n' "${query}" | docker exec -i "${container_id}" sh -lc \
    'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F " "'
}

wotcv_assert_postgres_invariants_not_decreased() {
  local before="$1"
  local after="$2"

  python3 "${WOTCV_PERSISTENCE_HELPER}" compare-postgres \
    --before "${before}" \
    --after "${after}"
}

wotcv_read_state() {
  local state_file="$1"
  local key="$2"

  [[ -f "${state_file}" ]] || return 0
  sed -n "s/^${key}=//p" "${state_file}" | tail -n 1
}

wotcv_wait_for_health() {
  local healthcheck_url="$1"
  local expected_git_sha="${2:-}"
  local expected_image_tag="${3:-}"
  local attempts="${WOTCV_HEALTHCHECK_ATTEMPTS:-60}"
  local response
  local last_response=""

  for ((attempt = 1; attempt <= attempts; attempt++)); do
    if response="$(curl --fail --silent --show-error --max-time 5 "${healthcheck_url}" 2>/dev/null)"; then
      last_response="${response}"
      if [[ -z "${expected_git_sha}" || "${response}" == *"\"gitSha\":\"${expected_git_sha}\""* ]]; then
        if [[ -z "${expected_image_tag}" || "${response}" == *"\"imageTag\":\"${expected_image_tag}\""* ]]; then
          printf '%s\n' "${response}"
          return 0
        fi
      fi
    fi
    sleep 2
  done

  [[ -z "${last_response}" ]] || printf '%s\n' "${last_response}"
  return 1
}
