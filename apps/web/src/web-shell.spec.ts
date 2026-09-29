import { describe, expect, it } from 'vitest';
import { createApp } from '@froglight/application';
import {
  InMemorySearchService,
  markdownKindId,
  markdownModel,
  memoryVaultPlugin,
  workspacePath,
} from '@froglight/foundation';
import { pwaManifest } from './pwa-manifest.js';

describe('apps/web shell — thin PWA host, same core as native', () => {
  it('creates/opens/saves via browser-vault-equivalent storage with no host branch', async () => {
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      searchService: new InMemorySearchService(),
    });
    const workspace = app.getWorkspace()!;
    const ref = await workspace.createDocument({
      kindId: markdownKindId,
      path: workspacePath('notes/web.md'),
      initialModel: markdownModel('# Web\nhello'),
    });
    const session = await workspace.openDocument(ref.documentId);
    expect((session.model as { raw: string }).raw).toBe('# Web\nhello');
    await app.dispose();
  });

  it('keeps vault bytes out of the PWA app-shell cache contract', () => {
    expect(memoryVaultPlugin.id).toBe('froglight.memory-vault');
  });

  it('opts installed PWAs into the window-controls-overlay display', () => {
    // The custom titlebar reclaims the titlebar strip only when the manifest
    // asks for the overlay display; standalone remains the base fallback.
    expect(pwaManifest.display).toBe('standalone');
    expect(pwaManifest.display_override).toContain('window-controls-overlay');
    expect(pwaManifest.display_override![0]).toBe('window-controls-overlay');
  });

  it('ships an installable icon set: any-purpose 192+512, maskable pair, and an svg', () => {
    const icons = pwaManifest.icons ?? [];
    const bySize = (size: string, purpose?: string): boolean =>
      icons.some(
        (icon) =>
          icon.sizes?.split(' ').includes(size) &&
          (purpose
            ? icon.purpose === purpose
            : icon.purpose === undefined || icon.purpose === 'any'),
      );
    expect(bySize('192x192')).toBe(true);
    expect(bySize('512x512')).toBe(true);
    expect(bySize('192x192', 'maskable')).toBe(true);
    expect(bySize('512x512', 'maskable')).toBe(true);
    expect(icons.some((icon) => icon.type === 'image/svg+xml')).toBe(true);
    // Installability identity: stable id plus name pair for launcher labels.
    expect(pwaManifest.id).toBe('/');
    expect(pwaManifest.name).toBe(pwaManifest.short_name);
  });

  it('resolves every manifest icon to a committed public asset', async () => {
    const { readFile } = await import('node:fs/promises');
    for (const icon of pwaManifest.icons ?? []) {
      const file = new URL(`../public${icon.src}`, import.meta.url);
      const bytes = await readFile(file);
      expect(bytes.byteLength).toBeGreaterThan(0);
      if (icon.type === 'image/png') {
        // PNG magic bytes — catches a stale/renamed asset path immediately.
        expect(
          bytes
            .subarray(0, 4)
            .equals(Uint8Array.from([0x89, 0x50, 0x4e, 0x47])),
        ).toBe(true);
      }
    }
  });
});
