#!/bin/sh
set -eu
if [ "${WOTCV_CANDIDATE_START_ACK:-}" != "empty-isolated-candidate-approved" ]; then
  printf '%s\n' 'HOLD: candidate startup was not approved for empty isolated storage. Native startup runs migrations.' >&2
  exit 78
fi
exec /app/docker-entrypoint.sh "$@"
