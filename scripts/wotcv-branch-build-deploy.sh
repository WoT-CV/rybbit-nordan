#!/bin/bash
# Compatibility entry point for the retained legacy updater, not a deployer.
# Keep this refusal independent of arguments, environment and legacy libraries.
builtin printf '%s\n' \
  'HOLD: legacy -> minimal transition requires a separate data decision and approved isolated rehearsal.' \
  'HOLD: przejscie ze starej produkcji wymaga osobnej decyzji o danych i zatwierdzonej izolowanej proby.' \
  'Deployment refused. Existing production data must not be opened by native startup or migrations.' \
  'Wdrozenie zablokowane. Nie uruchamiaj natywnego startu ani migracji na starych danych produkcyjnych.' \
  'No build, maintenance, startup, migration or deployment-state update was performed by this bridge.' \
  'Ten most nie aktywuje nowej wersji. See docs/WOTCV_MINIMAL_DEPLOYMENT.md; release remains HOLD.' >&2
builtin exit 78
