#!/bin/bash
# Compatibility entry point for the retained legacy updater, not a deployer.
# Keep this refusal independent of arguments, environment and legacy libraries.
builtin printf '%s\n' \
  'HOLD: legacy -> minimal transition requires a reviewed fresh installer and isolated startup verification.' \
  'HOLD: przejscie ze starej produkcji wymaga gotowego instalatora pustej instancji i testu uruchomienia.' \
  'Deployment refused. Existing production data must not be opened by native startup or migrations.' \
  'Wdrozenie zablokowane. Nie uruchamiaj natywnego startu ani migracji na starych danych produkcyjnych.' \
  'No build, maintenance, startup, migration or deployment-state update was performed by this bridge.' \
  'Ten most nie aktywuje nowej wersji. See docs/WOTCV_FRESH_INSTALL.md; release remains HOLD.' >&2
builtin exit 78
