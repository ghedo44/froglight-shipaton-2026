// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountFroglightApp, type WorkbenchMount } from '../../workbench.js';
import { workspaceEvents as events } from '../../ui-events.js';
import {
  createHarness,
  makeChoice,
  settle,
  until,
  type Harness,
} from '../test-support.js';
import launcherStyles from '../LauncherView.module.css';

/**
 * Preview registration lifecycle at the mount seam: registrations survive
 * unrelated controller invalidations without being recreated, and the last
 * tab closing disposes its registration (effect-owned, no leaks).
 * Orphan / restore / reader-replacement / shared-tab planning is covered
 * purely in `model/previewLifecycle.spec.ts`.
 */
describe('preview registrations (mount seam)', () => {
  let harness: Harness | null = null;
  let mounted: WorkbenchMount | null = null;

  afterEach(async () => {
    if (mounted !== null) {
      await act(async () => {
        await mounted!.dispose();
      });
      mounted = null;
    }
    await harness?.dispose();
    harness = null;
  });

  async function start(): Promise<Harness> {
    const h = await createHarness([makeChoice({ id: 'v1', name: 'My Vault' })]);
    harness = h;
    const root = document.createElement('div');
    document.body.appendChild(root);
    h.root = root;
    await act(async () => {
      mounted = await mountFroglightApp(root, h.controller, h.adapter, h.ui);
    });
    await act(async () => {
      h.root
        .querySelector<HTMLElement>(
          `.${launcherStyles['recent-vault-card']}`,
        )
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
    });
    await until(() => h.controller.calls.initialize === 1);
    return h;
  }

  async function openPreview(h: Harness, path: string): Promise<void> {
    await act(async () => {
      h.root.dispatchEvent(
        new CustomEvent(events.openPreview, {
          detail: { path },
          bubbles: true,
        }),
      );
      await settle();
    });
    await until(
      () => h.ui.views.get(`preview:${path}`) !== undefined,
    );
  }

  it('keeps registrations stable across unrelated controller invalidations', async () => {
    const h = await start();
    const register = vi.spyOn(h.ui.views, 'register');
    await openPreview(h, 'notes/photo.png');
    expect(register).toHaveBeenCalledTimes(1);

    // An unrelated invalidation (focus notification → revision bump) must
    // not recreate registrations, timers, or preview handles.
    await act(async () => {
      h.controller.focusPane('main');
      await settle();
    });
    await act(async () => {
      h.controller.setPaneDirty('main', true);
      await settle();
    });
    expect(register).toHaveBeenCalledTimes(1);
    expect(h.ui.views.get('preview:notes/photo.png')).toBeDefined();
  });

  it('disposes the registration when its last preview tab closes', async () => {
    const h = await start();
    await openPreview(h, 'notes/photo.png');
    const tabId = h.controller
      .paneStates()
      .flatMap((pane) => pane.tabs)
      .find((tab) => tab.viewId === 'preview:notes/photo.png')?.id;
    expect(tabId).toBeDefined();
    await act(async () => {
      await h.controller.closeTab('main', tabId!);
      await settle();
    });
    await until(
      () => h.ui.views.get('preview:notes/photo.png') === undefined,
    );
  });
});
