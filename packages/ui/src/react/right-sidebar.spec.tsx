// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { mountFroglightApp, type WorkbenchMount } from '../workbench.js';
import { extractHeadings } from '@froglight/foundation';
import type { RightSidebarContext } from '../right-sidebar-registry.js';
import { workspaceSettingsToken } from '../workspace-settings.js';
import {
  actClick,
  createHarness,
  makeChoice,
  settle,
  until,
  type Harness,
} from './test-support.js';
import launcherStyles from './LauncherView.module.css';
import panelStyles from './RightSidebarPanels.module.css';
import workspaceStyles from './WorkspaceView.module.css';

const mounts: WorkbenchMount[] = [];

afterEach(async () => {
  for (const mount of mounts.splice(0)) await mount.dispose();
  document.body.innerHTML = '';
});

async function start(
  width = 1280,
  text = '# Field notes\n\n## Habitat\n\n### Shade\n\n## Calls',
): Promise<{ h: Harness; root: HTMLElement }> {
  const originalWidth = window.innerWidth;
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: width,
  });
  const choice = makeChoice({ id: 'v', name: 'My Vault' });
  const h = await createHarness(
    [choice],
    [
      {
        documentId: 'doc-1',
        path: 'notes/field-notes.md',
        text,
      },
    ],
  );
  Object.assign(h.controller, {
    outlineRegistry: {
      getOutline(_kindId: string, model: unknown) {
        return extractHeadings(model as string).map((heading) => ({
          id: heading.slug,
          address: heading.slug,
          level: heading.level,
          label: heading.text,
        }));
      },
      invalidate: () => undefined,
    },
  });
  const root = document.body.appendChild(document.createElement('div'));
  h.root = root;
  await act(async () => {
    mounts.push(await mountFroglightApp(root, h.controller, h.adapter, h.ui));
  });
  await act(async () => {
    root
      .querySelector<HTMLElement>(`.${launcherStyles['recent-vault-card']}`)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
  });
  await until(() => h.controller.calls.initialize > 0);
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: originalWidth,
  });
  return { h, root };
}

describe('document right sidebar', () => {
  it('renders the focused Markdown outline and reveals portable addresses', async () => {
    const { h, root } = await start();
    const sidebar = root.querySelector('#document-sidebar')!;
    expect(
      root.querySelector(
        '[data-fl-component="titlebar"] [aria-label="Toggle document sidebar"]',
      ),
    ).not.toBeNull();
    expect(
      root.querySelector(
        `.${workspaceStyles['fl-pane-header']} [aria-label="Toggle document sidebar"]`,
      ),
    ).toBeNull();
    expect(
      sidebar.querySelector('[aria-label="Close document sidebar"]'),
    ).toBeNull();
    expect(sidebar.classList.contains(workspaceStyles.closed)).toBe(true);
    await actClick(
      root.querySelector<HTMLElement>(
        '[aria-label="Toggle document sidebar"]',
      )!,
    );
    expect(sidebar.classList.contains(workspaceStyles.open)).toBe(true);
    expect(
      [...sidebar.querySelectorAll(`.${panelStyles['outline-entry']}`)].map(
        (entry) => entry.textContent,
      ),
    ).toEqual(['Field notes', 'Habitat', 'Shade', 'Calls']);

    await actClick(
      [
        ...sidebar.querySelectorAll<HTMLElement>(
          `.${panelStyles['outline-entry']}`,
        ),
      ].find((entry) => entry.textContent === 'Shade')!,
    );
    expect(h.controller.calls.reveals).toEqual([
      { pane: 'main', address: 'shade' },
    ]);
  });

  it('keeps an empty Outline tab for a document with no headings', async () => {
    const { root } = await start(1280, 'plain body without headings\n');
    const sidebar = root.querySelector('#document-sidebar')!;
    expect([
      ...sidebar.querySelectorAll(`.${panelStyles['outline-entry']}`),
    ]).toEqual([]);
    const tab = root.querySelector<HTMLElement>('[data-right-panel="outline"]');
    expect(tab).not.toBeNull();
    await actClick(tab!);
    expect(sidebar.querySelector('.outline-panel')?.textContent).toBe('');
    expect(
      root.querySelector('[data-right-panel="document-settings"]'),
    ).not.toBeNull();
  });

  it('switches to document settings with persisted view and PDF controls', async () => {
    const { h, root } = await start();
    await actClick(
      root.querySelector<HTMLElement>(
        '[data-right-panel="document-settings"]',
      )!,
    );

    const sidebar = root.querySelector('#document-sidebar')!;
    expect(sidebar.textContent).toContain('Open behavior');
    expect(sidebar.textContent).toContain('PDF export');
    expect(
      sidebar.querySelector<HTMLButtonElement>(
        `.${panelStyles['document-export-button']}`,
      )?.disabled,
    ).toBe(false);

    const reading = [...sidebar.querySelectorAll('label')]
      .find((label) => label.textContent?.includes('Open in reading view'))
      ?.querySelector<HTMLInputElement>('input');
    expect(reading).not.toBeNull();
    await act(async () => {
      // Real toggles arrive as clicks; a bare synthetic change event is not
      // a user interaction React honors.
      reading!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
    });
    expect(
      h.ui.services.try(workspaceSettingsToken)?.get('note.doc-1.view', false),
    ).toBe(true);
  });

  it('accepts and reverses plugin-contributed panels without a shell patch', async () => {
    const { h, root } = await start();
    let registration!: { dispose(): void };
    await act(async () => {
      registration = h.ui.rightSidebar.register({
        id: 'test.references',
        title: 'References',
        icon: 'link',
        order: 15,
        component: function ReferencesPanel(props: {
          readonly context: RightSidebarContext;
        }) {
          return createElement(
            'p',
            null,
            `References for ${props.context.title}`,
          );
        },
      });
      await settle();
    });
    const tab = root.querySelector<HTMLElement>(
      '[data-right-panel="test.references"]',
    );
    expect(tab).not.toBeNull();
    await actClick(tab!);
    expect(root.querySelector('#document-sidebar')?.textContent).toContain(
      'References for field-notes.md',
    );

    await act(async () => {
      registration.dispose();
      await settle();
    });
    expect(
      root.querySelector('[data-right-panel="test.references"]'),
    ).toBeNull();
  });

  it('keeps plugin panels reachable when inspector tabs overflow', async () => {
    const { h, root } = await start();
    const registrations: { dispose(): void }[] = [];
    await act(async () => {
      for (let index = 0; index < 6; index += 1) {
        registrations.push(
          h.ui.rightSidebar.register({
            id: `test.panel-${index}`,
            title: `Plugin panel ${index}`,
            icon: 'link',
            order: 100 + index,
            component: () => createElement('p', null, `Panel content ${index}`),
          }),
        );
      }
      await settle();
    });
    const sidebar = root.querySelector('#document-sidebar')!;
    await actClick(
      root.querySelector<HTMLElement>(
        '[aria-label="Toggle document sidebar"]',
      )!,
    );
    await actClick(
      sidebar.querySelector<HTMLElement>(
        '[aria-label="More document panels"]',
      )!,
    );
    await actClick(
      [...sidebar.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (item) => item.textContent === 'Plugin panel 5',
      )!,
    );
    expect(sidebar.textContent).toContain('Panel content 5');
    expect(
      sidebar.querySelector('[data-right-panel="test.panel-5"]'),
    ).not.toBeNull();
    expect(sidebar.querySelector('[role="menu"]')).toBeNull();
    await act(async () => {
      for (const registration of registrations) registration.dispose();
      await settle();
    });
  });

  it('opens and dismisses the document drawer on phones', async () => {
    const { root } = await start(390);
    const sidebar = root.querySelector('#document-sidebar')!;
    expect(sidebar.classList.contains(workspaceStyles.closed)).toBe(true);
    await actClick(
      root.querySelector<HTMLElement>(
        '[aria-label="Toggle document sidebar"]',
      )!,
    );
    expect(sidebar.classList.contains(workspaceStyles.open)).toBe(true);
    expect(
      sidebar.querySelector('[aria-label="Close document sidebar"]'),
    ).toBeNull();
    expect(
      root
        .querySelector(`.${workspaceStyles['fl-backdrop']}`)
        ?.classList.contains(workspaceStyles.visible),
    ).toBe(true);
    const backdrop = root.querySelector<HTMLElement>(
      `.${workspaceStyles['fl-backdrop']}`,
    );
    expect(backdrop).not.toBeNull();
    if (backdrop) await actClick(backdrop);
    expect(sidebar.classList.contains(workspaceStyles.closed)).toBe(true);
  });

  it('docks the inspector on the way to mobile and restores it on the way back', async () => {
    const { root } = await start(1280);
    const sidebar = root.querySelector('#document-sidebar')!;
    const layout = root.querySelector(`[data-fl-component="workspace"]`)!;
    expect(sidebar.classList.contains(workspaceStyles.closed)).toBe(true);
    await actClick(
      root.querySelector<HTMLElement>(
        '[aria-label="Toggle document sidebar"]',
      )!,
    );
    expect(sidebar.classList.contains(workspaceStyles.open)).toBe(true);

    await act(async () => {
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: 700,
      });
      window.dispatchEvent(new Event('resize'));
      await settle();
    });
    expect(sidebar.classList.contains(workspaceStyles.open)).toBe(false);
    expect(
      root
        .querySelector(`.${workspaceStyles['fl-backdrop']}`)
        ?.classList.contains(workspaceStyles.visible),
    ).toBe(false);

    await act(async () => {
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: 1280,
      });
      window.dispatchEvent(new Event('resize'));
      await settle();
    });
    // The breakpoint flip snaps instead of sliding a phantom drawer.
    expect(
      layout.classList.contains(workspaceStyles['sidebar-switching']),
    ).toBe(true);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(sidebar.classList.contains(workspaceStyles.open)).toBe(true);
    expect(
      layout.classList.contains(workspaceStyles['sidebar-switching']),
    ).toBe(false);
  });

  it('drops the phone drawer backdrop on the way back to desktop', async () => {
    const { root } = await start(390);
    await actClick(
      root.querySelector<HTMLElement>('[aria-label="Open sidebar"]')!,
    );
    expect(
      root
        .querySelector(`.${workspaceStyles['fl-backdrop']}`)
        ?.classList.contains(workspaceStyles.visible),
    ).toBe(true);

    await act(async () => {
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: 1280,
      });
      window.dispatchEvent(new Event('resize'));
      await settle();
    });
    expect(
      root
        .querySelector(`.${workspaceStyles['fl-backdrop']}`)
        ?.classList.contains(workspaceStyles.visible),
    ).toBe(false);
  });
});
