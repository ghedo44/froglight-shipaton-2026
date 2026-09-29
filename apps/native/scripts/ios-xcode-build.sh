#!/bin/sh
set -eu

APP_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
REPO_ROOT=$(CDPATH= cd -- "$APP_DIR/../.." && pwd)

# Limrun flow: `lim xcode build` is run with `--ignore` on the standard
# JS workspace files so the server does not misread this Tauri+Xcode tree as
# a React Native monorepo. The `.limrun` variants are restored here only for
# the duration of this script (pnpm install needs them) and removed on exit —
# including on failure — so the next build's server-side layout detection
# sees a clean tree again. Only files restored by this script are removed;
# pre-existing files are never touched.
RESTORED_PACKAGE_JSON=false
RESTORED_PNPM_WORKSPACE=false
cleanup_limrun_workspace() {
  if [ "$RESTORED_PACKAGE_JSON" = true ]; then
    rm -f "$REPO_ROOT/package.json"
  fi
  if [ "$RESTORED_PNPM_WORKSPACE" = true ]; then
    rm -f "$REPO_ROOT/pnpm-workspace.yaml"
  fi
}
trap cleanup_limrun_workspace EXIT

if [ ! -f "$REPO_ROOT/package.json" ] && [ -f "$REPO_ROOT/package.limrun.json" ]; then
  cp "$REPO_ROOT/package.limrun.json" "$REPO_ROOT/package.json"
  RESTORED_PACKAGE_JSON=true
fi

if [ ! -f "$REPO_ROOT/pnpm-workspace.yaml" ] && [ -f "$REPO_ROOT/pnpm-workspace.limrun.yaml" ]; then
  cp "$REPO_ROOT/pnpm-workspace.limrun.yaml" "$REPO_ROOT/pnpm-workspace.yaml"
  RESTORED_PNPM_WORKSPACE=true
fi

if [ -f "$HOME/.cargo/env" ]; then
  . "$HOME/.cargo/env"
fi

if ! command -v cargo >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --profile minimal
  . "$HOME/.cargo/env"
fi

case "${PLATFORM_NAME:-iphonesimulator}" in
  iphoneos)
    RUST_TARGET=aarch64-apple-ios
    ;;
  iphonesimulator)
    RUST_TARGET=aarch64-apple-ios-sim
    ;;
  *)
    printf 'Unsupported Apple platform: %s\n' "${PLATFORM_NAME:-unknown}" >&2
    exit 2
    ;;
esac

if ! rustup target list --installed | grep -qx "$RUST_TARGET"; then
  rustup target add "$RUST_TARGET"
fi

run_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    pnpm "$@"
  else
    npx -y pnpm@11.20.0 "$@"
  fi
}

if [ ! -x "$APP_DIR/node_modules/.bin/vite" ]; then
  cd "$REPO_ROOT"
  run_pnpm install --frozen-lockfile
fi

# Xcode owns the native iOS build. Build only the frontend assets here;
# invoking the package `build` script would run `tauri build` recursively.
cd "$APP_DIR"
run_pnpm exec vite build

PROFILE=debug
CARGO_PROFILE=
case "${CONFIGURATION:-debug}" in
  release | Release)
    PROFILE=release
    CARGO_PROFILE=--release
    ;;
esac

export IPHONEOS_DEPLOYMENT_TARGET=15.0
if [ "$RUST_TARGET" = "aarch64-apple-ios" ]; then
  export CFLAGS_aarch64_apple_ios="-isysroot ${SDKROOT:?}"
  export CXXFLAGS_aarch64_apple_ios="$CFLAGS_aarch64_apple_ios"
  export OBJC_INCLUDE_PATH_aarch64_apple_ios="$SDKROOT/usr/include"
else
  export CFLAGS_aarch64_apple_ios_sim="-isysroot ${SDKROOT:?}"
  export CXXFLAGS_aarch64_apple_ios_sim="$CFLAGS_aarch64_apple_ios_sim"
  export OBJC_INCLUDE_PATH_aarch64_apple_ios_sim="$SDKROOT/usr/include"
fi

SWIFT_WRAPPER_DIR="$REPO_ROOT/.limrun-tools"
mkdir -p "$SWIFT_WRAPPER_DIR"
cat > "$SWIFT_WRAPPER_DIR/swift" <<'SWIFT_WRAPPER'
#!/bin/sh
if [ "${1:-}" = "build" ]; then
  shift
  exec /usr/bin/xcrun swift build --disable-sandbox "$@"
fi
exec /usr/bin/xcrun swift "$@"
SWIFT_WRAPPER
chmod +x "$SWIFT_WRAPPER_DIR/swift"
export PATH="$SWIFT_WRAPPER_DIR:$PATH"

cargo build \
  --manifest-path "$APP_DIR/src-tauri/Cargo.toml" \
  --target-dir "$APP_DIR/src-tauri/target" \
  --target "$RUST_TARGET" \
  --lib \
  $CARGO_PROFILE

OUTPUT_DIR="$APP_DIR/src-tauri/gen/apple/Externals/arm64/$PROFILE"
mkdir -p "$OUTPUT_DIR"
cp "$APP_DIR/src-tauri/target/$RUST_TARGET/$PROFILE/libfroglight_native_lib.a" \
  "$OUTPUT_DIR/libapp.a"
