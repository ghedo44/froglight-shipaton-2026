# Optional Firebase sync and RevenueCat setup

Local editing works without this backend. Firebase Auth provides account identity,
Firestore stores vault HEAD records, and Storage holds immutable manifests and
blobs. The RevenueCat extension maintains the server-issued
`revenueCatEntitlements` claim used by Security Rules. Sync is eventual file-level
replication and is not end-to-end encrypted.

## Emulator checks

This directory has its own package and lockfile. Install Node.js 24, pnpm 11 and
Java (CI uses Temurin 21), then run from this directory:

```sh
pnpm install --frozen-lockfile
pnpm test:emulators
```

The command uses `demo-froglight-sync-test` with Firestore and Storage emulators.
After installing dependencies at the repository root as well, run the provider
integration checks with `pnpm test:emulators:provider`. See the
[Firebase CI workflow](../../.github/workflows/firebase-rules.yml).

## Configure your own backend

Cloud setup requires your own Firebase and RevenueCat projects, and a Firebase
billing plan supporting Storage and the extension. Review service costs before
provisioning. From this directory, authenticate with `pnpm exec firebase login`.
Pass your own `--project <project-id>` explicitly; the checked-in CLI alias is not
a project supplied for public use.

1. Enable Firebase Email/Password Authentication and create Firestore and Storage.
2. Match the extension's `LOCATION` parameter to your deployment region.
3. Configure the RevenueCat Firebase integration and store its webhook shared secret
   in Secret Manager. Install the pinned extension and verify
   `SET_CUSTOM_CLAIMS=ENABLED`; leave event/customer collections empty.
4. Deploy the checked-in Firestore and Storage rules.
5. Apply bucket CORS so browser/WebView direct downloads work.

The checked-in [Firebase configuration](firebase.json) and
[extension parameters](extensions/firestore-revenuecat-purchases.env) provide the
non-secret configuration. The relevant commands are:

```sh
pnpm exec firebase ext:secret:set REVENUECAT_SHARED_SECRET --project <project-id>
pnpm exec firebase deploy --only extensions --project <project-id>
pnpm exec firebase deploy --only firestore:rules,storage --project <project-id>
gcloud storage buckets update gs://<bucket> --cors-file=storage.cors.json --project <project-id>
```

The CLI may prompt for extension secrets during installation; verify the configured
webhook secret in the installed instance. `gcloud` requires bucket-owner access.
The default [CORS policy](storage.cors.json) allows download requests; choose
origins appropriate to your deployed web host and native WebView.

## Configure the app and purchases

Copy the environment template to `.env` in each app host you use:
[native](../../apps/native/.env.example) or [web](../../apps/web/.env.example).
Supply the public Firebase configuration from your own project's web app:
API key, Auth domain, project ID, bucket and app ID. Empty configuration keeps
local editing available. The template in this directory is for local scripts;
Vite reads the host's environment file.

For native purchases, set `VITE_FROGLIGHT_REVENUECAT_PUBLIC_KEY` in
`apps/native/.env`. Use a public Test Store or app SDK key. Configure RevenueCat
entitlement **`pro`**, offering **`default`** and its products.

The account coordinator identifies RevenueCat with the Firebase UID before an
account-bound purchase. A Test Store purchase should update customer information,
then the Firebase extension should set `revenueCatEntitlements: ["pro"]`.
Refresh the Firebase token before expecting the new claim to authorize sync.
Enable sync for a disposable vault and verify changes on a second signed-in
instance before relying on it.

## Troubleshooting and credentials

| Symptom                                        | Check                                                             |
| ---------------------------------------------- | ----------------------------------------------------------------- |
| Pro purchase succeeds but sync write is denied | Refresh the ID token; inspect the extension claim and account UID |
| Extension logs an anonymous user ID            | Ensure account-bound purchases identify the Firebase UID first    |
| Downloads fail with CORS errors                | Apply `storage.cors.json` to the bucket actually used by the app  |
| Storage authorization fails                    | Confirm the app bucket, project, rules and entitlement agree      |
| Emulators do not start                         | Check Java and configured emulator ports                          |

Owners retain read/recovery access after entitlement expiry; writes require the
trusted Pro claim. Rules deny cloud deletion. Client purchase state alone does
not authorize backend writes.

Keep webhook secrets, service-account keys and Apple signing credentials out of
Git and frontend configuration. The extension `.env` contains only non-secret
parameters. Physical-device purchase behavior requires a separate device check.
