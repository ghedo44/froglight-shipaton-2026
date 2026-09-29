# Build and run

## Toolchain

Use Node.js 24 and pnpm 11.20.0, as pinned in
[CI](../.github/workflows/runtime.yml). The repository uses a pnpm workspace and
Nx; run the commands below from the repository root. Keep `pnpm-lock.yaml` and
both `.limrun` manifests: the remote Apple build script uses those variants.

```sh
pnpm install --frozen-lockfile
pnpm nx show projects
pnpm nx show project web
pnpm nx show project native
```

## Browser host

```sh
pnpm nx run web:build
pnpm --filter @froglight/web preview
```

Open the URL printed by Vite in a current browser with OPFS support, such as
Chromium. Create a new disposable local vault from the launcher, add a document,
edit it, then close and reopen it. Local use requires no account or environment
file. Test offline behavior using the production build; Vite development mode
is not an offline acceptance test.

After the initial build, use `pnpm --filter @froglight/web dev` for development.
See [web scripts](../apps/web/package.json) for the available commands.

## Native desktop host

Install Rust/Cargo and the appropriate operating-system dependencies for Tauri 2:
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).
Desktop builds need the platform SDK/toolchain and, on Linux, the required GTK
and WebKit development libraries.

```sh
pnpm nx run native:build
pnpm --filter @froglight/native native:run
```

The first command builds the native frontend;
`native:run` builds the frontend again before Cargo embeds it. For native
packaging, inspect [native scripts](../apps/native/package.json) and
[Tauri configuration](../apps/native/src-tauri/tauri.conf.json).

## iOS and iPadOS

The checked-in Xcode project, Swift plugins, CocoaPods configuration and
`apps/native/scripts/ios-xcode-build.sh` are included. Builds require an Apple
Xcode environment. The deployment target is iOS/iPadOS 15.0.

- [iOS guide](IOS_LIMRUN.md): remote Xcode builds, separate device and simulator
  artifacts, and installation/testing instructions.
- [Manual GitHub Actions workflow](../.github/workflows/ios-unsigned-ipa.yml):
  builds an unsigned device IPA on a macOS runner.

Remote Limrun builds require your own Limrun account. A simulator build cannot
verify physical Apple Pencil behavior. An unsigned device IPA requires signing
before installation; a paid store account is not a Next Gen submission requirement.

## Optional accounts, sync and purchases

Local editing works without these services. For native purchases, copy
[the environment template](../apps/native/.env.example) to `apps/native/.env`
and set `VITE_FROGLIGHT_REVENUECAT_PUBLIC_KEY` to your public RevenueCat Test Store
or app SDK key. Configure entitlement **`pro`**, offering **`default`** and its products.

For accounts and sync, supply the public Firebase settings in the native or
[web host environment](../apps/web/.env.example): API key, Auth domain, project ID,
bucket and app ID. Empty settings keep local editing available.

### Backend setup

See [Firebase setup](../infra/firebase/README.md) for the backend configuration,
emulator checks and purchase-to-sync troubleshooting.

Use your own Firebase and RevenueCat projects. Enable Email/Password Authentication,
create Firestore and Storage, and use a Firebase billing plan supporting Storage
and the RevenueCat extension. The extension region must match your deployment.

From `infra/firebase`, install the standalone dependencies and authenticate:

```sh
pnpm install --frozen-lockfile
pnpm exec firebase login
```

The [Firebase config](../infra/firebase/firebase.json) pins the extension;
[its parameters](../infra/firebase/extensions/firestore-revenuecat-purchases.env)
enable entitlement custom claims. Configure the RevenueCat Firebase integration,
store its webhook shared secret in Secret Manager, then deploy to your project:

```sh
pnpm exec firebase ext:secret:set REVENUECAT_SHARED_SECRET --project <project-id>
pnpm exec firebase deploy --only extensions --project <project-id>
pnpm exec firebase deploy --only firestore:rules,storage --project <project-id>
gcloud storage buckets update gs://<bucket> --cors-file=storage.cors.json --project <project-id>
```

Keep `SET_CUSTOM_CLAIMS=ENABLED` and event/customer collections empty. Verify the
installed extension's webhook secret. Apply bucket CORS to enable direct downloads;
pass your own project ID explicitly instead of using the checked-in CLI alias.

Account-bound purchases identify RevenueCat with the Firebase UID. After a test
purchase, verify `revenueCatEntitlements: ["pro"]`, refresh the Firebase token and
try sync between two disposable vault instances. A successful purchase alone does
not establish that the server claim has propagated.

With Java installed (CI uses Temurin 21), this directory also provides:

```sh
pnpm test:emulators
pnpm test:emulators:provider
```

Provider integration checks also need the root workspace dependencies.
Keep server credentials, webhook secrets and signing keys outside Git and frontend
configuration. Public SDK keys and Firebase client identifiers are the app inputs.

## Verification

Inspect Nx targets before selecting checks:

```sh
pnpm nx show project web
pnpm nx run web:typecheck
pnpm nx run web:test
```

Browser end-to-end tests require Playwright Chromium:

```sh
pnpm --filter @froglight/web exec playwright install chromium
pnpm nx run web:test:e2e
```

For focused production offline and recovery checks:

```sh
pnpm nx run web:test:e2e -- tests/offline-shell.spec.ts
pnpm nx run web:test:e2e -- tests/incremental-persistence.spec.ts
```

Use disposable vaults and emulator fixtures. Exercise create, edit, save and
reopen in the running product. Verify touch, pen and external-folder behavior on
an actual supported device; browser tests and simulator runs cover only their
respective environments. A frontend build does not verify a native device build.
