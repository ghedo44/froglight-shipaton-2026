// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workspacePath } from '@froglight/foundation';
import { mountFroglightApp, type WorkbenchMount } from '../workbench.js';
import { workspaceEvents as events } from '../ui-events.js';
import {
  createHarness,
  makeChoice,
  settle,
  until,
  type Harness,
} from './test-support.js';
import launcherStyles from './LauncherView.module.css';
import overlayStyles from './Overlays.module.css';
import previewStyles from './previews/FilePreview.module.css';
import workspaceStyles from './WorkspaceView.module.css';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let harness: Harness | null = null;
let mounted: WorkbenchMount | null = null;
let objectUrls: string[] = [];
let revokedUrls: string[] = [];

async function start(
  options: {
    beforeMount?: (h: Harness) => Promise<void>;
  } = {},
): Promise<Harness> {
  const h = await createHarness([makeChoice({ id: 'v1', name: 'My Vault' })]);
  harness = h;
  await options.beforeMount?.(h);
  const root = document.createElement('div');
  document.body.appendChild(root);
  h.root = root;
  await act(async () => {
    mounted = await mountFroglightApp(root, h.controller, h.adapter, h.ui);
  });
  await activateVault(h);
  return h;
}

async function activateVault(h: Harness): Promise<void> {
  const card = h.root.querySelector<HTMLElement>(
    `.${launcherStyles['recent-vault-card']}`,
  );
  await act(async () => {
    card!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
  });
  await until(() => h.controller.calls.initialize === 1);
}

function dispatchOnRoot(h: Harness, type: string, detail: unknown): void {
  act(() => {
    h.root.dispatchEvent(
      new CustomEvent(type, { detail, bubbles: true }),
    );
  });
}

function previewTabIds(h: Harness, viewId: string): string[] {
  return h.controller
    .paneStates()
    .flatMap((pane) => pane.tabs)
    .filter((tab) => tab.kind === 'view' && tab.viewId === viewId)
    .map((tab) => tab.id);
}

async function seedFile(h: Harness, path: string, bytes: Uint8Array): Promise<void> {
  const parent = path.split('/').slice(0, -1).join('/');
  if (parent !== '') {
    await h.vault.createDirectory(workspacePath(parent));
  }
  await h.vault.write(workspacePath(path), bytes);
}

beforeEach(() => {
  objectUrls = [];
  revokedUrls = [];
  let counter = 0;
  vi.stubGlobal(
    'URL',
    Object.assign(URL, {
      createObjectURL: vi.fn(() => {
        const url = `blob:mock-${(counter += 1)}`;
        objectUrls.push(url);
        return url;
      }),
      revokeObjectURL: vi.fn((url: string) => {
        revokedUrls.push(url);
      }),
    }),
  );
});

afterEach(async () => {
  if (mounted !== null) {
    await act(async () => {
      await mounted!.dispose();
    });
    mounted = null;
  }
  await harness?.dispose();
  harness = null;
  vi.unstubAllGlobals();
});

describe('raw-file previews (mount seam)', () => {
  it('opens a preview tab with the file-type icon and a live image render', async () => {
    const h = await start();
    await seedFile(
      h,
      'photos/trip.png',
      new Uint8Array([137, 80, 78, 71, 1, 2, 3]),
    );

    dispatchOnRoot(h, events.openPreview, { path: 'photos/trip.png' });
    await until(() => previewTabIds(h, 'preview:photos/trip.png').length === 1);

    const labels = [
      ...h.root.querySelectorAll(`.${workspaceStyles['fl-tab-label']}`),
    ].map((node) => node.textContent);
    expect(labels).toContain('trip.png');
    expect(
      h.root.querySelector(
        `.${workspaceStyles['fl-tab']} .icon-file-image`,
      ),
    ).not.toBeNull();
    await until(
      () =>
        h.root.querySelector(
          `.${previewStyles['file-preview-stage']}.${previewStyles['file-preview-image']} img`,
        ) !== null,
    );
    const img = h.root.querySelector<HTMLImageElement>(
      `.${previewStyles['file-preview-stage']}.${previewStyles['file-preview-image']} img`,
    );
    expect(img?.getAttribute('src')).toMatch(/^blob:/);
  });

  it('activates the existing tab instead of stacking a duplicate', async () => {
    const h = await start();
    await seedFile(h, 'a.png', new Uint8Array([1]));

    dispatchOnRoot(h, events.openPreview, { path: 'a.png' });
    await until(() => previewTabIds(h, 'preview:a.png').length === 1);

    dispatchOnRoot(h, events.openPreview, { path: 'a.png' });
    await settle();
    expect(previewTabIds(h, 'preview:a.png')).toHaveLength(1);
  });

  it('shows the file\u2019s current content on every activation, never stale bytes', async () => {
    const h = await start();
    await seedFile(h, 'notes.txt', new TextEncoder().encode('version one'));

    dispatchOnRoot(h, events.openPreview, { path: 'notes.txt' });
    await until(() => previewTabIds(h, 'preview:notes.txt').length === 1);
    await until(
      () =>
        h.root.querySelector(`.${previewStyles['file-preview-stage']} pre`) !==
        null,
    );
    expect(
      h.root.querySelector(`.${previewStyles['file-preview-stage']} pre`)
        ?.textContent,
    ).toBe('version one');

    const tabId = previewTabIds(h, 'preview:notes.txt')[0]!;
    await act(async () => {
      await h.controller.closeTab('main', tabId);
      await settle();
    });
    await seedFile(h, 'notes.txt', new TextEncoder().encode('version two'));

    dispatchOnRoot(h, events.openPreview, { path: 'notes.txt' });
    await until(() => previewTabIds(h, 'preview:notes.txt').length === 1);
    await until(
      () =>
        h.root.querySelector(`.${previewStyles['file-preview-stage']} pre`)
          ?.textContent === 'version two',
    );
  });

  it('disposes the view registration when its last tab closes and re-registers on reopen', async () => {
    const h = await start();
    await seedFile(h, 'a.png', new Uint8Array([1]));

    dispatchOnRoot(h, events.openPreview, { path: 'a.png' });
    await until(() => previewTabIds(h, 'preview:a.png').length === 1);
    expect(h.ui.views.get('preview:a.png')).toBeDefined();

    await act(async () => {
      await h.controller.closeTab('main', previewTabIds(h, 'preview:a.png')[0]!);
      await settle();
    });
    await until(() => h.ui.views.get('preview:a.png') === undefined);

    dispatchOnRoot(h, events.openPreview, { path: 'a.png' });
    await until(() => previewTabIds(h, 'preview:a.png').length === 1);
    expect(h.ui.views.get('preview:a.png')).toBeDefined();
  });

  it('re-registers views for preview tabs restored into the dock layout', async () => {
    const h = await start();
    expect(h.ui.views.get('preview:restored.png')).toBeUndefined();

    await act(async () => {
      h.controller.injectViewTab('main', 'preview:restored.png');
      await settle();
    });
    await until(() => h.ui.views.get('preview:restored.png') !== undefined);
  });

  it('moves preview tabs with the file on rename', async () => {
    const h = await start();
    await seedFile(h, 'old-name.png', new Uint8Array([1]));

    dispatchOnRoot(h, events.openPreview, { path: 'old-name.png' });
    await until(() => previewTabIds(h, 'preview:old-name.png').length === 1);

    dispatchOnRoot(h, events.previewMoved, {
      from: 'old-name.png',
      to: 'new-name.png',
    });
    await until(() => previewTabIds(h, 'preview:new-name.png').length === 1);
    await settle();
    expect(previewTabIds(h, 'preview:old-name.png')).toHaveLength(0);
  });

  it('offers Import as notebook in the raw-file menu and reuses the shared import flow', async () => {
    const h = await start({
      beforeMount: async (harness) => {
        await seedFile(
          harness,
          'doc.pdf',
          new TextEncoder().encode('%PDF-fake menu conversion'),
        );
      },
    });

    const row = h.root.querySelector<HTMLElement>(
      '[data-path="doc.pdf"]',
    );
    expect(row).not.toBeNull();
    await act(async () => {
      row!.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      );
      await settle();
    });

    const menuItem = [
      ...document.querySelectorAll(`.${overlayStyles['fl-menu-item']}`),
    ].find((node) => node.textContent?.includes('Import as notebook'));
    expect(menuItem).not.toBeNull();
    await act(async () => {
      menuItem!.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
      await settle();
    });

    // The shared page-selection prompt appears; confirming with the default
    // "all" runs the same controller import the toolbar button uses.
    await until(
      () =>
        document.querySelector(
          `.${overlayStyles['froglight-modal-actions']} [data-fl-component="button"][data-variant="primary"]`,
        ) !== null,
    );
    const confirm = document.querySelector<HTMLElement>(
      `.${overlayStyles['froglight-modal-actions']} [data-fl-component="button"][data-variant="primary"]`,
    );
    expect(confirm?.textContent).toBe('Import pages');
    await act(async () => {
      confirm!.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
      await settle();
    });

    await until(() => h.controller.calls.pdfImports.length === 1);
    expect(h.controller.calls.pdfImports[0]?.name).toBe('doc.pdf');
  });

  it('closes preview tabs when the file is deleted', async () => {
    const h = await start();
    await seedFile(h, 'doomed.png', new Uint8Array([1]));

    dispatchOnRoot(h, events.openPreview, { path: 'doomed.png' });
    await until(() => previewTabIds(h, 'preview:doomed.png').length === 1);

    dispatchOnRoot(h, events.previewDeleted, { path: 'doomed.png' });
    await until(() => previewTabIds(h, 'preview:doomed.png').length === 0);
  });
});
