// @vitest-environment jsdom
// A throwing reading port must not let the
// mode-selector error escape the click handler; feedback lands in the
// existing toast live region and keyboard focus returns to the segment.
import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { mountFroglightApp, type WorkbenchMount } from '../../../workbench.js';
import {
  createHarness,
  makeChoice,
  settle,
  until,
  type Harness,
} from '../../test-support.js';
import launcherStyles from '../../LauncherView.module.css';

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

async function startWithThrowingSetTabMode(): Promise<Harness> {
  const h = await createHarness([makeChoice({ id: 'v1', name: 'My Vault' })]);
  const failing = {
    ...h.controller,
    setTabMode() {
      throw new Error('provider refused the mode change');
    },
  } as const;
  const root = document.createElement('div');
  document.body.appendChild(root);
  h.root = root;
  await act(async () => {
    mounted = await mountFroglightApp(
      root,
      failing as unknown as Harness['controller'],
      h.adapter,
      h.ui,
    );
  });
  await act(async () => {
    h.root
      .querySelector<HTMLElement>(`.${launcherStyles['recent-vault-card']}`)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
  });
  await until(() => h.controller.calls.initialize > 0);
  await until(
    () => h.root.querySelector('[data-fl-component="titlebar"]') !== null,
  );
  return h;
}

it('surfaces a thrown mode change in the toast and keeps focus on the control', async () => {
  const h = await startWithThrowingSetTabMode();
  const viewSegment = h.root.querySelector<HTMLElement>(
    '[aria-label="Document view: Edit"]',
  )!;

  await act(async () => {
    viewSegment.click();
  });
  const viewItem = h.root.querySelector<HTMLElement>(
    '[role="menuitemradio"]:last-child',
  )!;

  await act(async () => {
    viewItem.click();
    await settle();
  });

  const toast = h.root.querySelector('[role="status"]');
  expect(toast?.textContent).toContain('Mode change failed');
  expect(toast?.textContent).toContain('provider refused');

  expect(document.activeElement === viewSegment).toBe(true);
  // The controller never applied the mode.
  expect(h.controller.tabMode('main')).toBe('edit');
});
