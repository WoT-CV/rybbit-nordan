#!/bin/bash
# Operator handoff for exactly this reviewed bundle; not a production updater.
set -Eeuo pipefail
if (( EUID != 0 )); then
  builtin printf '%s\n' 'Run this first-initialization handoff explicitly with sudo bash.' >&2
  exit 1
fi
if ! /usr/bin/sha256sum --check --status <<'REVIEWED_HASHES'
a335cbc9767a0d86832e8f75a09790a4b90f5b40607955f52c825c4c7ba82a88  /home/wotcv/rybbit-fresh-20261102.qYlV3CsP/wotcv-fresh-install.py
061b690566288c7e3921d46a9338777cda27299c3388bbea6090379598020ff8  /home/wotcv/rybbit-fresh-20261102.qYlV3CsP/state.json
REVIEWED_HASHES
then
  builtin printf '%s\n' 'REFUSED: reviewed script/state differs or initialization was already attempted. Do not bypass or retry; inspect the bundle.' >&2
  exit 1
fi
builtin printf '%s\n' \
  'Initializing NEW isolated Rybbit databases (native schema initialization).' \
  'Old application, old volumes and public nginx routing remain unchanged.'
exec /usr/bin/python3 -B \
  /home/wotcv/rybbit-fresh-20261102.qYlV3CsP/wotcv-fresh-install.py \
  start-bootstrap \
  --release /home/wotcv/rybbit-fresh-20261102.qYlV3CsP \
  --expected-state-sha256 061b690566288c7e3921d46a9338777cda27299c3388bbea6090379598020ff8 \
  --ack initialize-empty-rybbit-only
