#!/bin/sh
# Run the provider-firebase Emulator Suite integration spec under the
# emulators started from infra/firebase (owns firebase.json).
# Invoked by `pnpm test:emulators:provider` via `emulators:exec`, which
# supplies FIRESTORE_/STORAGE_/AUTH_EMULATOR_HOST for the demo project.
set -eu
cd "$(dirname "$0")/../.."
exec pnpm --filter @froglight/provider-firebase exec vitest run src/sync-remote.emulator.spec.ts
