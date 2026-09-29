import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SWIFT_PLUGIN = readFileSync(
  new URL(
    '../src-tauri/plugins/froglight-vault-storage/ios/Sources/VaultStoragePlugin.swift',
    import.meta.url,
  ),
  'utf8',
);
const SWIFT_SUPPORT = readFileSync(
  new URL(
    '../src-tauri/plugins/froglight-vault-storage/ios/Sources/VaultStorageSupport.swift',
    import.meta.url,
  ),
  'utf8',
);
const ANDROID_PLUGIN = readFileSync(
  new URL(
    '../src-tauri/plugins/froglight-vault-storage/android/src/main/java/VaultStoragePlugin.kt',
    import.meta.url,
  ),
  'utf8',
);
const CARGO_TOML = readFileSync(
  new URL('../src-tauri/Cargo.toml', import.meta.url),
  'utf8',
);
const CAPABILITIES = readFileSync(
  new URL('../src-tauri/capabilities/window.json', import.meta.url),
  'utf8',
);
const XCODE_BUILD = readFileSync(
  new URL('../scripts/ios-xcode-build.sh', import.meta.url),
  'utf8',
);
const IPA_WORKFLOW = readFileSync(
  new URL('../../../.github/workflows/ios-unsigned-ipa.yml', import.meta.url),
  'utf8',
);

describe('FrogLight-owned iOS vault storage', () => {
  it('selects a folder and verifies it is writable before accepting it', () => {
    expect(SWIFT_PLUGIN).toContain(
      'UIDocumentPickerViewController(forOpeningContentTypes: [.folder], asCopy: false)',
    );
    expect(SWIFT_PLUGIN).toContain('try self.writeProbe(at: url)');
    expect(SWIFT_PLUGIN).toContain('.froglight-write-probe-');
  });

  it('coordinates external File Provider reads and writes', () => {
    expect(SWIFT_PLUGIN).toContain('NSFileCoordinator(filePresenter: nil)');
    expect(SWIFT_PLUGIN).toContain('coordinatedContainerWrite(at: parent)');
    expect(SWIFT_PLUGIN).toContain('options: .forDeleting');
    expect(SWIFT_PLUGIN).toContain('options: .forMoving');
  });

  it('returns file bytes as compact base64 instead of a JSON number per byte', () => {
    expect(SWIFT_PLUGIN).toContain('struct ReadFileResponseDTO: Encodable { let data: String }');
    expect(SWIFT_PLUGIN).toContain('data: data.base64EncodedString()');
    expect(ANDROID_PLUGIN).toContain('Base64.encodeToString(bytes, Base64.NO_WRAP)');
  });

  it('persists iOS directory bookmarks and reopens security scope per operation', () => {
    expect(SWIFT_PLUGIN).toContain('options: .minimalBookmark');
    expect(SWIFT_PLUGIN).toContain('options: .withoutUI');
    expect(SWIFT_PLUGIN).toContain('startAccessingSecurityScopedResource()');
    expect(SWIFT_PLUGIN).toContain('stopAccessingSecurityScopedResource()');
    expect(SWIFT_PLUGIN).not.toContain('.withSecurityScope');
  });

  it('keeps native permission diagnostics instead of collapsing the error', () => {
    for (const field of [
      'operation=',
      'domain=',
      'nativeCode=',
      'securityScopeStarted=',
      'bookmarkStale=',
    ]) {
      expect(SWIFT_SUPPORT).toContain(field);
    }
  });

  it('uses only the owned plugin and has no dependency-patch build hook', () => {
    expect(CARGO_TOML).toContain(
      'froglight-vault-storage = { path = "plugins/froglight-vault-storage" }',
    );
    expect(CARGO_TOML).not.toContain('tauri-plugin-scoped-storage');
    expect(CAPABILITIES).toContain('froglight-vault-storage:default');
    expect(CAPABILITIES).not.toContain('scoped-storage:default');
    expect(XCODE_BUILD).not.toContain('patch-scoped-storage-ios.sh');
    expect(IPA_WORKFLOW).not.toContain('patch-scoped-storage-ios.sh');
  });
});
