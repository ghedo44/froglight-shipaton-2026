import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createTauriWindowChrome } from './window-chrome.js';

const TAURI_CONF = JSON.parse(
  readFileSync(
    new URL('../src-tauri/tauri.conf.json', import.meta.url),
    'utf8',
  ),
) as {
  app: {
    windows: Array<{
      label: string;
      decorations?: boolean;
      dragDropEnabled?: boolean;
    }>;
  };
};

const MACOS_CONF = JSON.parse(
  readFileSync(
    new URL('../src-tauri/tauri.macos.conf.json', import.meta.url),
    'utf8',
  ),
) as {
  app: {
    windows: Array<{
      label: string;
      decorations?: boolean;
      titleBarStyle?: string;
    }>;
  };
};

const CAPABILITIES = JSON.parse(
  readFileSync(
    new URL('../src-tauri/capabilities/window.json', import.meta.url),
    'utf8',
  ),
) as { permissions: string[] };

describe('native window chrome contract', () => {
  it('draws its own titlebar: the main window is undecorated', () => {
    const win = TAURI_CONF.app.windows.find(
      (candidate) => candidate.label === 'main',
    );
    expect(win).toBeDefined();
    expect(win!.decorations).toBe(false);
  });

  it('disables native drag/drop so HTML5 file drops reach the WebView', () => {
    // Tauri enables native drag/drop by default; on Windows (WebView2)
    // that disables the frontend HTML5 DnD APIs Froglight's file explorer
    // and internal tree drag depend on. The browser path stays primary on
    // every desktop host; native file ingress arrives through the
    // froglight.file-drop capability (Android) instead.
    const win = TAURI_CONF.app.windows.find(
      (candidate) => candidate.label === 'main',
    );
    expect(win).toBeDefined();
    expect(win!.dragDropEnabled).toBe(false);
  });

  it('keeps native traffic lights on macOS via an overlay titlebar', () => {
    const win = MACOS_CONF.app.windows.find(
      (candidate) => candidate.label === 'main',
    );
    expect(win).toBeDefined();
    expect(win!.decorations).toBe(true);
    expect(win!.titleBarStyle).toBe('Overlay');
  });

  it('keeps capabilities limited to window controls and user-approved storage', () => {
    const required = [
      'core:window:allow-show',
      'core:window:allow-hide',
      'core:window:allow-close',
      'core:window:allow-minimize',
      'core:window:allow-toggle-maximize',
      'core:window:allow-start-dragging',
      'core:window:allow-internal-toggle-maximize',
      'core:window:allow-is-maximized',
      'core:event:allow-listen',
      'froglight-vault-storage:default',
      // Overlay keyboard control: two narrow IME commands, no
      // filesystem/shell/env authority.
      'froglight-keyboard-inset:default',
      // Stylus accessory events: events-only plugin, no commands.
      'froglight-stylus:default',
      // Purchases/entitlements: seven narrow commerce commands,
      // no filesystem/shell/env authority.
      'froglight-purchases:default',
      // External file ingress: two narrow token commands (read/release),
      // no general filesystem grant — the plugin owns temp URI authority.
      'froglight-file-drop:default',
    ];
    for (const permission of required) {
      expect(CAPABILITIES.permissions).toContain(permission);
    }
    // No broad fs, shell, env, or http grants: vault access stays picker-bound.
    for (const permission of CAPABILITIES.permissions) {
      expect(
        permission.startsWith('core:') ||
          permission === 'froglight-vault-storage:default' ||
          permission === 'froglight-keyboard-inset:default' ||
          permission === 'froglight-stylus:default' ||
          permission === 'froglight-purchases:default' ||
          permission === 'froglight-file-drop:default',
      ).toBe(true);
    }
  });

  it('returns null outside Tauri (node test runtime has no window internals)', () => {
    expect(createTauriWindowChrome()).toBeNull();
  });
});
