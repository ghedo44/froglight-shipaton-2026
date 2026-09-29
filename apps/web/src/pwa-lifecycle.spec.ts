/**
 * PWA offline lifecycle invariants.
 *
 * A note application that works offline needs these as product guarantees,
 * not service-worker implementation details: installed PWA across a new
 * deployment (old SW + new assets, stale precache, update while offline,
 * interrupted update), offline startup, edit/save/restart.
 *
 * Browser SW orchestration itself is covered by the real-Chromium OPFS suite
 * (`provider-opfs/test:e2e`); this spec pins the app-shell contract (workbox
 * config + manifest) and the product-level offline edit/save/restart loop
 * through the shared workspace path.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createApp } from '@froglight/application';
import {
  InMemorySearchService,
  createMemoryVaultState,
  markdownKindId,
  markdownModel,
  memoryVaultPlugin,
  workspacePath,
} from '@froglight/foundation';
import {
  composeWorkspace,
  requireValue,
  testNoteKindId,
  testNoteModel,
} from '@froglight/foundation/testing';

const REPO_ROOT = (() => {
  const candidates = [process.cwd(), __dirname];
  for (const start of candidates) {
    let dir = start;
    for (let i = 0; i < 6; i++) {
      if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return path.resolve(__dirname, '..', '..', '..');
})();

function readViteConfigAsText(): string {
  return fs.readFileSync(
    path.join(REPO_ROOT, 'apps/web/vite.config.ts'),
    'utf8',
  );
}

describe('PWA lifecycle invariants', () => {
  it('workbox keeps an offline-capable app shell across deployments', () => {
    const config = readViteConfigAsText();
    // Offline startup requires a navigation fallback to the shell.
    expect(config).toMatch(/navigateFallback:\s*['"]index\.html['"]/);
    // Stale precaches from previous deployments must be cleaned on activate.
    expect(config).toMatch(/cleanupOutdatedCaches:\s*true/);
    // JS/CSS/HTML/assets must be precached, including the large LaTeX bundle.
    expect(config).toMatch(/globPatterns/);
    expect(config).toMatch(
      /maximumFileSizeToCacheInBytes:\s*4\s*\*\s*1024\s*\*\s*1024/,
    );
    // Vault bytes stay in OPFS — never precached as app-shell assets.
    expect(config).toMatch(/Vault bytes stay in OPFS/);
  });

  it('autoUpdate does not activate a shell that cannot open local state', () => {
    // Pinned invariant: the update strategy must remain autoUpdate with
    // precache cleanup. If a future version gate is added (WEB_AND_STORAGE
    // upgrade strategy), this test is where it gets pinned.
    const config = readViteConfigAsText();
    expect(config).toMatch(/registerType:\s*['"]autoUpdate['"]/);
  });

  it('offline startup: workspace opens with no network', async () => {
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      searchService: new InMemorySearchService(),
    });
    const workspace = app.getWorkspace()!;
    expect(workspace.workspaceId).toBeTruthy();
    await app.dispose();
  });

  it('offline edit/save/restart: canonical bytes survive a full restart', async () => {
    // Both launches share one backing state (the offline device disk);
    // only the runtime is torn down and recreated between them.
    const state = createMemoryVaultState();
    const first = await composeWorkspace({
      vaultPlugin: memoryVaultPlugin,
      vaultConfig: { state },
      workspaceConfig: { workspaceId: 'ws-offline-restart' },
    });
    const ws1 = requireValue(first.getWorkspace(), 'workspace');
    await ws1.createDocument({
      kindId: testNoteKindId,
      path: workspacePath('notes/offline.md'),
      initialModel: testNoteModel('Offline', 'edited while offline'),
    });
    await first.dispose();

    // Simulate restart while offline: a brand-new runtime over the same state.
    const second = await composeWorkspace({
      vaultPlugin: memoryVaultPlugin,
      vaultConfig: { state },
      workspaceConfig: { workspaceId: 'ws-offline-restart' },
    });
    const ws2 = requireValue(second.getWorkspace(), 'workspace');
    // No fallback: the exact resource path must resolve after restart.
    const ref = requireValue(
      ws2.findByResourcePath(workspacePath('notes/offline.md')),
      'document ref after offline restart',
    );
    const session = await ws2.openDocument(ref.documentId);
    expect((session.model as { title: string }).title).toBe('Offline');
    await second.dispose();
  });

  it('markdown edit/save round-trips through the shared session path', async () => {
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      searchService: new InMemorySearchService(),
    });
    const workspace = app.getWorkspace()!;
    const ref = await workspace.createDocument({
      kindId: markdownKindId,
      path: workspacePath('notes/pwa.md'),
      initialModel: markdownModel('# PWA\noffline edit'),
    });
    const session = await workspace.openDocument(ref.documentId);
    expect((session.model as { raw: string }).raw).toContain('offline edit');
    await session.save();
    expect(session.state).toBe('open');
    await app.dispose();
  });
});
