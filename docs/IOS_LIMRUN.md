# Build iOS and iPadOS

Froglight targets iOS/iPadOS **15.0+** with bundle ID `app.froglight.app`.
Builds use the `froglight-native_iOS` scheme and produce `Froglight.app`.
Device (`iphoneos`) and simulator (`iphonesimulator`) binaries are separate.

## GitHub Actions

After publishing the repository, run the manual
[iOS unsigned IPA workflow](../.github/workflows/ios-unsigned-ipa.yml) from GitHub
Actions. It installs the toolchain, refreshes Tauri's generated Apple project,
builds on macOS and uploads the unsigned device IPA as a workflow artifact.
Download it, then sign and install it using Sideloadly or your own Apple signing
setup. An unsigned IPA cannot be installed directly on a physical device.

## Remote Xcode with Limrun

This optional path requires your own Limrun account and CLI. From the repository
root, install and authenticate:

```sh
npm install --global lim
lim login
```

The [Xcode pre-build script](../apps/native/scripts/ios-xcode-build.sh) installs
workspace dependencies, builds the frontend and selects the appropriate Rust
target. Keep `package.limrun.json` and `pnpm-workspace.limrun.yaml`: the ignore
flags below exclude the standard manifests during remote project detection, and
the script restores temporary copies from these variants.

### Device IPA

```sh
lim xcode build . \
  --project apps/native/src-tauri/gen/apple/froglight-native.xcodeproj \
  --scheme froglight-native_iOS \
  --configuration Debug \
  --sdk iphoneos \
  --artifact-name Froglight.app \
  --ignore '^package\.json$' \
  --ignore '^pnpm-workspace\.yaml$' \
  --build-setting CODE_SIGNING_ALLOWED=NO \
  --build-setting CODE_SIGNING_REQUIRED=NO \
  --build-setting 'CODE_SIGN_IDENTITY=' \
  --build-setting 'DEVELOPMENT_TEAM=' \
  --build-setting COMPILER_INDEX_STORE_ENABLE=NO \
  --upload Froglight-iOS-iPadOS-arm64-debug-unsigned.ipa
```

Download the IPA from the artifact URL printed by Limrun, then sign it before
installing it on an iPhone/iPad. Use `Debug` or `Release` with this capitalization.

### Simulator

```sh
lim xcode build . \
  --project apps/native/src-tauri/gen/apple/froglight-native.xcodeproj \
  --scheme froglight-native_iOS \
  --configuration Debug \
  --sdk iphonesimulator \
  --ignore '^package\.json$' \
  --ignore '^pnpm-workspace\.yaml$'

lim ios create --attach --model ipad --inactivity-timeout 1h --no-open
lim ios launch-app app.froglight.app --mode RelaunchIfRunning
lim ios screenshot froglight.png
```

Use the stream URL printed by Limrun to interact with the simulator. Rebuilding
while it is attached installs the new simulator build. Do not pass the device
signing flags or install the device IPA into the simulator.

## Build files and troubleshooting

The [checked-in Apple project](../apps/native/src-tauri/gen/apple/project.yml)
and native plugin linkage must be refreshed when Tauri plugin topology changes.
The GitHub workflow performs this refresh; the Limrun commands use the checked-in
project. Keep the deployment target aligned with the Podfile and build script.

For missing artifacts, retain `--artifact-name Froglight.app`. For wrong remote
project detection, retain both `--ignore` flags and `.limrun` manifests. For CLI
option changes, inspect `lim xcode build --help` and `lim ios --help`, or consult
[Limrun documentation](https://docs.limrun.com/docs/ios/build-with-xcode).
A simulator run does not verify physical Apple Pencil or external-folder behavior.
