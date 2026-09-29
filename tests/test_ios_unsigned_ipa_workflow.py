"""Regression checks for unsigned iOS/iPadOS IPA workflow and native iOS build script."""

from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
WORKFLOW_PATH = REPO_ROOT / ".github" / "workflows" / "ios-unsigned-ipa.yml"
IOS_BUILD_SCRIPT_PATH = REPO_ROOT / "apps" / "native" / "scripts" / "ios-xcode-build.sh"
PBXPROJ_PATH = (
    REPO_ROOT
    / "apps"
    / "native"
    / "src-tauri"
    / "gen"
    / "apple"
    / "froglight-native.xcodeproj"
    / "project.pbxproj"
)


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


# Workflow trigger + runner + toolchain requirements
# Slow packaging job: manual + path-filtered PR/push, never a required merge gate.
# Fast PR checks live in runtime.yml; this workflow must stay focused on the IPA.
def test_workflow_supports_manual_and_relevant_pushes() -> None:
    workflow = _read(WORKFLOW_PATH)

    assert "workflow_dispatch:" in workflow
    assert "push:" in workflow
    assert "- main" in workflow
    assert "- ios" in workflow
    # Path-filtered PR validation for native changes (non-blocking, see runtime.yml
    # for required fast checks).
    assert "pull_request:" in workflow
    assert "apps/native/**" in workflow
    assert "runs-on: macos-15" in workflow
    assert "targets: aarch64-apple-ios" in workflow
    assert (
        "XCODE_PROJECT: apps/native/src-tauri/gen/apple/froglight-native.xcodeproj"
        in workflow
    )
    assert "DERIVED_DATA_PATH: /tmp/froglight-derived-data" in workflow
    assert "PACKAGE_PATH: /tmp/froglight-ipa" in workflow
    assert "runner.temp" not in workflow


# Keep the slow IPA job focused on device packaging. Fast verification
# (lint/typecheck/test/build, pytest, Rust checks, OPFS contracts) lives in
# runtime.yml and is the required merge gate. The IPA workflow must not duplicate
# workspace verification, which would couple slow macOS packaging to every merge.
def test_workspace_verification_does_not_run_native_desktop_build() -> None:
    workflow = _read(WORKFLOW_PATH)

    assert "pnpm nx run-many -t lint,typecheck,test" not in workflow
    assert "pnpm nx run-many -t lint,typecheck,test,build" not in workflow


# The checked-in Apple project is not authoritative for mobile plugin linkage.
# Tauri iOS initialization must synchronize Swift/mobile plugin dependencies
# before the direct xcodebuild invocation used by the unsigned IPA job.
def test_workflow_synchronizes_tauri_ios_project_before_xcodebuild() -> None:
    workflow = _read(WORKFLOW_PATH)

    sync = "pnpm exec tauri ios init --ci --skip-targets-install"
    assert sync in workflow
    assert workflow.index(sync) < workflow.index("xcodebuild build")


# Unsigned device build assertions
def test_workflow_builds_unsigned_release_for_iphoneos() -> None:
    workflow = _read(WORKFLOW_PATH)

    assert "xcodebuild build" in workflow
    assert "-configuration release" in workflow
    assert "-sdk iphoneos" in workflow
    assert "-destination 'generic/platform=iOS'" in workflow
    assert "CODE_SIGNING_ALLOWED=NO" in workflow
    assert "CODE_SIGNING_REQUIRED=NO" in workflow
    assert "CODE_SIGN_IDENTITY=''" in workflow
    assert "DEVELOPMENT_TEAM=''" in workflow


# IPA packaging and artifact upload checks
def test_workflow_packages_payload_and_uploads_ipa_plus_sha() -> None:
    workflow = _read(WORKFLOW_PATH)

    assert "IPA_NAME: Froglight-iOS-iPadOS-arm64-unsigned.ipa" in workflow
    assert 'mkdir -p "$PACKAGE_PATH/Payload"' in workflow
    assert 'ditto "$APP_PATH" "$PACKAGE_PATH/Payload/Froglight.app"' in workflow
    assert "rm -rf \"$PACKAGE_PATH/Payload/Froglight.app/_CodeSignature\"" in workflow
    assert "rm -f \"$PACKAGE_PATH/Payload/Froglight.app/embedded.mobileprovision\"" in workflow
    assert "/usr/bin/zip -qry \"$IPA_NAME\" Payload" in workflow
    assert "shasum -a 256 \"$IPA_PATH\" | tee \"$IPA_PATH.sha256\"" in workflow
    assert "uses: actions/upload-artifact@v4" in workflow
    assert "${{ env.PACKAGE_PATH }}/${{ env.IPA_NAME }}" in workflow
    assert "${{ env.PACKAGE_PATH }}/${{ env.IPA_NAME }}.sha256" in workflow


# IPA verification rules (bundle id, arch, family, signature)
def test_workflow_verification_checks_match_requirements() -> None:
    workflow = _read(WORKFLOW_PATH)

    assert "CFBundleIdentifier" in workflow
    assert "= 'app.froglight.app'" in workflow
    assert "UIDeviceFamily" in workflow
    assert "grep -q '1'" in workflow
    assert "grep -q '2'" in workflow
    assert "lipo -info" in workflow
    assert "grep -q 'arm64'" in workflow
    assert "if codesign -dv \"$APP_PATH\" >/dev/null 2>&1; then" in workflow


# Ensure no Apple signing secrets are required
def test_workflow_does_not_require_apple_secrets() -> None:
    workflow = _read(WORKFLOW_PATH).lower()

    assert "secrets." not in workflow
    assert "apple_id" not in workflow
    assert "app_store_connect" not in workflow
    assert "match_password" not in workflow
    assert "fastlane_session" not in workflow


# Build script device vs simulator Rust target selection
def test_ios_build_script_selects_device_and_simulator_targets() -> None:
    script = _read(IOS_BUILD_SCRIPT_PATH)

    assert 'case "${PLATFORM_NAME:-iphonesimulator}" in' in script
    assert "iphoneos)" in script
    assert "RUST_TARGET=aarch64-apple-ios" in script
    assert "iphonesimulator)" in script
    assert "RUST_TARGET=aarch64-apple-ios-sim" in script
    assert "Unsupported Apple platform" in script
    assert "run_pnpm exec vite build" in script
    assert "\nrun_pnpm build\n" not in script


# Xcode project should keep required app identity and iPhone+iPad targeting
def test_xcode_project_bundle_id_and_device_families() -> None:
    pbxproj = _read(PBXPROJ_PATH)

    assert "PRODUCT_BUNDLE_IDENTIFIER = app.froglight.app;" in pbxproj
    assert 'TARGETED_DEVICE_FAMILY = "1,2";' in pbxproj
    assert "VALID_ARCHS = arm64;" in pbxproj
