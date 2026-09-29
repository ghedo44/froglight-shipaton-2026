// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '@froglight/application';
import {
  InMemorySearchService,
  markdownKindId,
  markdownModel,
  memoryVaultPlugin,
  workspacePath,
} from '@froglight/foundation';
import { createTauriWindowChrome } from './window-chrome.js';

describe('apps/native shell — thin Tauri host, same core as web', () => {
  it('creates/opens/saves through the same application composition', async () => {
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      searchService: new InMemorySearchService(),
    });
    const workspace = app.getWorkspace()!;
    const ref = await workspace.createDocument({
      kindId: markdownKindId,
      path: workspacePath('notes/native.md'),
      initialModel: markdownModel('# Native\nhello'),
    });
    const session = await workspace.openDocument(ref.documentId);
    expect((session.model as { raw: string }).raw).toBe('# Native\nhello');
    await app.dispose();
  });
});

describe('native window chrome adapter', () => {
  it('exposes a Tauri chrome that routes window ops through the Tauri IPC', async () => {
    const invoke = vi.fn().mockResolvedValue(null);
    installTauriInternals(invoke);
    try {
      const chrome = createTauriWindowChrome();
      expect(chrome).not.toBeNull();
      expect(chrome!.kind).toBe('tauri');
      expect(chrome!.dragRegion).toBe(true);
      // happy-dom presents a non-mac platform: the app draws its own controls.
      expect(chrome!.appControls).toBe(true);
      expect(chrome!.inset()).toEqual({ left: 0, right: 0 });

      await chrome!.minimize();
      await chrome!.toggleMaximize();
      await chrome!.close();
      const commands = invoke.mock.calls.map(([command]) => command as string);
      expect(commands.some((command) => command.includes('minimize'))).toBe(
        true,
      );
      expect(
        commands.some((command) => command.includes('toggle_maximize')),
      ).toBe(true);
      expect(commands.some((command) => command.includes('close'))).toBe(true);
    } finally {
      delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    }
  });

  it('defers to native traffic lights on macOS and reserves their inset', () => {
    const invoke = vi.fn().mockResolvedValue(null);
    installTauriInternals(invoke);
    const originalPlatform = Object.getOwnPropertyDescriptor(
      Navigator.prototype,
      'platform',
    );
    Object.defineProperty(Navigator.prototype, 'platform', {
      value: 'MacIntel',
      configurable: true,
    });
    try {
      const chrome = createTauriWindowChrome();
      expect(chrome).not.toBeNull();
      // macOS keeps the native traffic lights: no app-drawn controls, but the
      // bar must pad itself clear of them.
      expect(chrome!.appControls).toBe(false);
      expect(chrome!.dragRegion).toBe(true);
      expect(chrome!.inset().left).toBeGreaterThan(0);
      expect(chrome!.inset().right).toBe(0);
    } finally {
      delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
      if (originalPlatform) {
        Object.defineProperty(
          Navigator.prototype,
          'platform',
          originalPlatform,
        );
      }
    }
  });

  it('treats iPad as mobile Apple chrome, not macOS traffic lights', () => {
    const invoke = vi.fn().mockResolvedValue(null);
    installTauriInternals(invoke);
    const originalPlatform = Object.getOwnPropertyDescriptor(
      Navigator.prototype,
      'platform',
    );
    Object.defineProperty(Navigator.prototype, 'platform', {
      value: 'iPad',
      configurable: true,
    });
    try {
      const chrome = createTauriWindowChrome();
      expect(chrome).not.toBeNull();
      expect(chrome!.appControls).toBe(false);
      expect(chrome!.dragRegion).toBe(false);
      expect(chrome!.inset()).toEqual({ left: 0, right: 0 });
    } finally {
      delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
      if (originalPlatform) {
        Object.defineProperty(
          Navigator.prototype,
          'platform',
          originalPlatform,
        );
      }
    }
  });

  it('returns null outside Tauri (plain-browser dev server)', () => {
    expect(createTauriWindowChrome()).toBeNull();
  });

  it('dispose releases the resize listener (zero registrations after it)', async () => {
    const invoke = vi.fn().mockResolvedValue(null);
    installTauriInternals(invoke);
    try {
      const chrome = createTauriWindowChrome()!;
      // Let the onResized subscription settle before tearing down.
      await new Promise((resolve) => setTimeout(resolve, 0));
      chrome.dispose!();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const commands = invoke.mock.calls.map(([command]) => command as string);
      expect(commands.some((command) => command.includes('unlisten'))).toBe(
        true,
      );
    } finally {
      delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    }
  });
});

/** Minimal `__TAURI_INTERNALS__` stub good enough for @tauri-apps/api/window. */
function installTauriInternals(invoke: ReturnType<typeof vi.fn>): void {
  (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' } },
    transformCallback: () => 1,
    invoke,
  };
  (
    window as { __TAURI_EVENT_PLUGIN_INTERNALS__?: unknown }
  ).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: () => undefined,
  };
}
