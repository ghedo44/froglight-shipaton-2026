// @vitest-environment jsdom
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { Runtime, definePlugin } from '@froglight/runtime';
import {
  blockPageKindId,
  markdownKindId,
  notebookKindId,
} from '@froglight/foundation';
import {
  rightSidebarRegistryPlugin,
  rightSidebarRegistryToken,
  type RightSidebarContext,
  type RightSidebarRegistry,
} from '../right-sidebar-registry.js';
import {
  documentOutlinePlugin,
  documentSettingsPanelPlugin,
} from '../right-sidebar-panels.js';
import {
  workspaceSettingsToken,
  type WorkspaceSettingsService,
  type WorkspaceSettingsValue,
} from '../workspace-settings.js';
import { DocumentSettingsPanel, OutlinePanel } from './RightSidebarPanels.jsx';
import panelStyles from './RightSidebarPanels.module.css';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(node: ReactElement): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(node);
  });
  return host;
}

function unmount(): void {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
}

afterEach(unmount);

function stubSettings(
  initial: Record<string, WorkspaceSettingsValue> = {},
): WorkspaceSettingsService & {
  written(): Record<string, WorkspaceSettingsValue>;
} {
  const values = new Map<string, WorkspaceSettingsValue>(
    Object.entries(initial),
  );
  const service: WorkspaceSettingsService = {
    get(key, defaultValue) {
      const value = values.get(key);
      return value === undefined
        ? defaultValue
        : (value as typeof defaultValue);
    },
    set(key, value) {
      values.set(key, value);
    },
    onChange() {
      return { dispose: () => undefined };
    },
  };
  return Object.assign(service, {
    written() {
      return Object.fromEntries(values);
    },
  });
}

async function registerWorkspaceSettings(
  runtime: Runtime,
  settings: WorkspaceSettingsService = stubSettings(),
): Promise<void> {
  await runtime.registerSlot({
    id: 'workspace-settings-source',
    plugin: definePlugin({
      id: 'test.workspace-settings-source',
      activate: (ctx) => ctx.provide(workspaceSettingsToken, settings),
    }),
  });
}

function outlineContext(
  overrides: Partial<RightSidebarContext> = {},
): RightSidebarContext {
  return {
    pane: 'main',
    documentId: 'doc-1',
    kindId: String(markdownKindId),
    title: 'field-notes.md',
    path: 'notes/field-notes.md',
    mode: 'edit',
    availableModes: ['edit', 'reading'],
    dirty: false,
    text: '# Field notes\n\n## Habitat\n\n### Shade\n\n## Calls',
    // Generic outline path: rows arrive from the outline registry
    // via the shell context builder — the panel never derives them from
    // `text`. Tests drive the panel with explicit provider rows.
    outline: [
      {
        id: 'field-notes',
        address: 'field-notes',
        level: 1,
        label: 'Field notes',
      },
      { id: 'habitat', address: 'habitat', level: 2, label: 'Habitat' },
      { id: 'shade', address: 'shade', level: 3, label: 'Shade' },
      { id: 'calls', address: 'calls', level: 2, label: 'Calls' },
    ],
    outlineRevision: 'rev-1',
    openDocument: () => undefined,
    revealAddress: () => undefined,
    setMode: () => undefined,
    exportPdf: () => undefined,
    ...overrides,
  };
}

function settingsContext(
  overrides: Partial<RightSidebarContext> = {},
): RightSidebarContext {
  return {
    pane: 'main',
    documentId: 'doc-1',
    kindId: String(markdownKindId),
    title: 'field-notes.md',
    path: 'notes/field-notes.md',
    mode: 'edit',
    availableModes: ['edit', 'reading'],
    dirty: false,
    text: '# Field notes\nHello.',
    openDocument: () => undefined,
    revealAddress: () => undefined,
    setMode: () => undefined,
    exportPdf: () => undefined,
    ...overrides,
  };
}

function setSelectValue(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLSelectElement.prototype,
    'value',
  )?.set;
  if (setter !== undefined) setter.call(select, value);
  else select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

async function changeSelect(
  select: HTMLSelectElement,
  value: string,
): Promise<void> {
  await act(async () => {
    setSelectValue(select, value);
  });
}

async function changeCheckbox(input: HTMLInputElement): Promise<void> {
  // Real toggles always arrive as clicks (mouse, keyboard, assistive tech);
  // a bare synthetic change event is not a user interaction React honors.
  await act(async () => {
    input.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
  });
}

async function captureRegistry(
  runtime: Runtime,
): Promise<RightSidebarRegistry> {
  let captured: RightSidebarRegistry | null = null;
  const probeId = `test.capture-${Math.random().toString(36).slice(2)}`;
  await runtime.registerSlot({
    id: probeId,
    plugin: definePlugin({
      id: probeId,
      requirements: { requires: [rightSidebarRegistryToken] },
      activate: (ctx) => {
        captured = ctx.require(rightSidebarRegistryToken);
      },
    }),
  });
  if (captured === null) throw new Error('registry failed to activate');
  return captured;
}

describe('right sidebar panels (React conversion)', () => {
  it('maps every asserted class through the CSS module', () => {
    for (const name of [
      'right-sidebar-panel',
      'right-sidebar-heading',
      'right-sidebar-empty',
      'outline-tree',
      'outline-entry',
      'document-settings-group',
      'document-setting-row',
      'document-setting-value',
      'document-export-button',
      'readonly',
    ]) {
      expect(panelStyles[name], `module class ${name}`).toMatch(/\S/);
    }
  });

  describe('outline panel', () => {
    it('renders the focused Markdown outline entries in document order', () => {
      const mounted = mount(
        createElement(OutlinePanel, { context: outlineContext() }),
      );
      expect(
        mounted.querySelector(
          `.${panelStyles['right-sidebar-panel']}.outline-panel`,
        ),
      ).not.toBeNull();
      expect(
        mounted.querySelector(`.${panelStyles['right-sidebar-heading']}`)
          ?.textContent,
      ).toBe('Outline');
      expect(
        [...mounted.querySelectorAll(`.${panelStyles['outline-entry']}`)].map(
          (entry) => entry.textContent,
        ),
      ).toEqual(['Field notes', 'Habitat', 'Shade', 'Calls']);
    });

    it('keeps datasets, depth style, titles, and nav labelling', () => {
      const mounted = mount(
        createElement(OutlinePanel, { context: outlineContext() }),
      );
      const tree = mounted.querySelector(`.${panelStyles['outline-tree']}`);
      expect(tree?.getAttribute('aria-label')).toBe('Document outline');
      const entries = [
        ...mounted.querySelectorAll<HTMLButtonElement>(
          `.${panelStyles['outline-entry']}`,
        ),
      ];
      expect(entries.map((entry) => entry.dataset.level)).toEqual([
        '1',
        '2',
        '3',
        '2',
      ]);
      expect(
        entries.map((entry) =>
          entry.style.getPropertyValue('--_outline-depth'),
        ),
      ).toEqual(['0', '1', '2', '1']);
      expect(entries.map((entry) => entry.title)).toEqual([
        'Field notes',
        'Habitat',
        'Shade',
        'Calls',
      ]);
      for (const entry of entries) expect(entry.type).toBe('button');
    });

    it('reveals portable addresses on click', async () => {
      const revealed: string[] = [];
      const mounted = mount(
        createElement(OutlinePanel, {
          context: outlineContext({
            openDocument: () => undefined,
            revealAddress: (address) => revealed.push(address),
          }),
        }),
      );
      const shade = [
        ...mounted.querySelectorAll<HTMLElement>(
          `.${panelStyles['outline-entry']}`,
        ),
      ].find((entry) => entry.textContent === 'Shade')!;
      await click(shade);
      expect(revealed).toEqual(['shade']);
    });

    it('leaves empty or absent outlines blank', () => {
      const emptyOutline = mount(
        createElement(OutlinePanel, {
          context: outlineContext({ outline: [], outlineRevision: 'rev-1' }),
        }),
      );
      expect(emptyOutline.textContent).toBe('');
      expect(
        emptyOutline.querySelector(`.${panelStyles['outline-tree']}`),
      ).toBeNull();
      unmount();
      // No provider rows (text alone never populates the panel): the same
      // kind-neutral empty state, never a Markdown-derived fallback.
      const noProvider = mount(
        createElement(OutlinePanel, {
          context: outlineContext({
            outline: undefined,
            outlineRevision: undefined,
            text: 'plain body',
          }),
        }),
      );
      expect(noProvider.textContent).toBe('');
      expect(
        noProvider.querySelector(`.${panelStyles['outline-tree']}`),
      ).toBeNull();
    });
  });

  describe('document settings panel (markdown)', () => {
    it('renders details, open behavior, and PDF export structure', () => {
      const mounted = mount(
        createElement(DocumentSettingsPanel, {
          context: settingsContext(),
          settings: stubSettings(),
        }),
      );
      expect(
        mounted.querySelector(
          `.${panelStyles['right-sidebar-panel']}.document-settings-panel`,
        ),
      ).not.toBeNull();
      expect(
        mounted.querySelector(`.${panelStyles['right-sidebar-heading']}`)
          ?.textContent,
      ).toBe('Document');
      expect(mounted.textContent).toContain('Open behavior');
      expect(mounted.textContent).toContain('PDF export');
      const groups = [
        ...mounted.querySelectorAll(
          `.${panelStyles['document-settings-group']} h3`,
        ),
      ].map((h) => h.textContent);
      expect(groups).toEqual(['Details', 'Open behavior', 'PDF export']);
      const readonlyRows = [
        ...mounted.querySelectorAll(
          `.${panelStyles['document-setting-row']}.${panelStyles.readonly}`,
        ),
      ];
      expect(readonlyRows.length).toBe(3);
      expect(
        readonlyRows[0]?.querySelector(
          `.${panelStyles['document-setting-value']}`,
        )?.textContent,
      ).toBe('field-notes.md');
      expect(
        readonlyRows[0]
          ?.querySelector(`.${panelStyles['document-setting-value']}`)
          ?.getAttribute('title'),
      ).toBe('field-notes.md');
      expect(
        readonlyRows[1]?.querySelector(
          `.${panelStyles['document-setting-value']}`,
        )?.textContent,
      ).toBe('notes/field-notes.md');
      expect(
        readonlyRows[2]?.querySelector(
          `.${panelStyles['document-setting-value']}`,
        )?.textContent,
      ).toBe('markdown');
    });

    it('switches views and persists the reading-view toggle', async () => {
      const modes: string[] = [];
      const settings = stubSettings();
      const mounted = mount(
        createElement(DocumentSettingsPanel, {
          context: settingsContext({ setMode: (mode) => modes.push(mode) }),
          settings,
        }),
      );
      const viewSelect = mounted.querySelector<HTMLSelectElement>(
        'select[aria-label="Current view"]',
      )!;
      expect(viewSelect.value).toBe('edit');
      await changeSelect(viewSelect, 'reading');
      expect(modes).toEqual(['reading']);
      act(() =>
        root!.render(
          createElement(DocumentSettingsPanel, {
            context: settingsContext({ mode: 'reading' }),
            settings,
          }),
        ),
      );
      expect(viewSelect.value).toBe('reading');
      expect([...viewSelect.options].map((option) => option.value)).toEqual([
        'edit',
        'reading',
      ]);
      act(() =>
        root!.render(
          createElement(DocumentSettingsPanel, {
            context: settingsContext({
              mode: 'split',
              availableModes: ['edit', 'split', 'reading'],
            }),
            settings,
          }),
        ),
      );
      expect(viewSelect.value).toBe('split');
      expect([...viewSelect.options].map((option) => option.value)).toEqual([
        'edit',
        'split',
        'reading',
      ]);

      const readingLabel = [...mounted.querySelectorAll('label')].find(
        (label) => label.textContent?.includes('Open in reading view'),
      );
      const reading =
        readingLabel?.querySelector<HTMLInputElement>('input') ?? null;
      expect(reading).not.toBeNull();
      if (reading === null) throw new Error('missing reading toggle');
      await changeCheckbox(reading);
      expect(settings.written()['note.doc-1.view']).toBe(true);
    });

    it('exports markdown PDF with the latest paper, margin, and title choices', async () => {
      const exported: unknown[] = [];
      const settings = stubSettings();
      const mounted = mount(
        createElement(DocumentSettingsPanel, {
          context: settingsContext({
            exportPdf: (options) => exported.push(options),
          }),
          settings,
        }),
      );
      const button = mounted.querySelector<HTMLButtonElement>(
        `.${panelStyles['document-export-button']}`,
      )!;
      expect(button.disabled).toBe(false);
      expect(button.textContent).toBe('Export as PDF…');
      expect(button.title).toBe(
        'Open the system print dialog to save this document as PDF',
      );
      await changeSelect(
        mounted.querySelector<HTMLSelectElement>(
          'select[aria-label="Paper size"]',
        )!,
        'letter',
      );
      await changeSelect(
        mounted.querySelector<HTMLSelectElement>(
          'select[aria-label="Margins"]',
        )!,
        'narrow',
      );
      const titleLabel = [...mounted.querySelectorAll('label')].find((label) =>
        label.textContent?.includes('Include document title'),
      );
      const titleToggle =
        titleLabel?.querySelector<HTMLInputElement>('input') ?? null;
      if (titleToggle === null) throw new Error('missing title toggle');
      await changeCheckbox(titleToggle);
      await click(button);
      expect(exported).toEqual([
        { pageSize: 'letter', margins: 'narrow', includeTitle: false },
      ]);
      expect(settings.written()['note.doc-1.pdfPageSize']).toBe('letter');
      expect(settings.written()['note.doc-1.pdfMargins']).toBe('narrow');
      expect(settings.written()['note.doc-1.pdfIncludeTitle']).toBe(false);
    });

    it('omits the PDF section when the family exposes no text', () => {
      const mounted = mount(
        createElement(DocumentSettingsPanel, {
          context: settingsContext({ kindId: 'froglight.ink', text: null }),
          settings: stubSettings(),
        }),
      );
      expect(mounted.textContent).toContain('Open behavior');
      expect(mounted.textContent).not.toContain('PDF export');
      expect(
        mounted.querySelector(`.${panelStyles['document-export-button']}`),
      ).toBeNull();
    });
  });

  describe('document settings panel (notebook)', () => {
    it('renders notebook output controls with the flattening warning', () => {
      const mounted = mount(
        createElement(DocumentSettingsPanel, {
          context: settingsContext({
            kindId: String(notebookKindId),
            text: null,
            exportNotebookPdf: () => undefined,
          }),
          settings: stubSettings(),
        }),
      );
      expect(mounted.textContent).toContain('PDF export');
      expect(
        mounted.querySelector(`.${panelStyles['document-setting-hint']}`)
          ?.textContent,
      ).toBe(
        'Flattened output rasterizes every page, so selectable text, vectors, links, and outlines are lost.',
      );
      const button = mounted.querySelector<HTMLButtonElement>(
        `.${panelStyles['document-export-button']}`,
      )!;
      expect(button.textContent).toBe('Export notebook as PDF…');
      expect(button.disabled).toBe(false);
    });

    it('disables the notebook button without a provider and sends flatten dpi when chosen', async () => {
      const disabledHost = mount(
        createElement(DocumentSettingsPanel, {
          context: settingsContext({
            kindId: String(notebookKindId),
            text: null,
          }),
          settings: stubSettings(),
        }),
      );
      expect(
        disabledHost.querySelector<HTMLButtonElement>(
          `.${panelStyles['document-export-button']}`,
        )?.disabled,
      ).toBe(true);
      unmount();

      const exported: unknown[] = [];
      const settings = stubSettings();
      const mounted = mount(
        createElement(DocumentSettingsPanel, {
          context: settingsContext({
            kindId: String(notebookKindId),
            text: null,
            exportNotebookPdf: (options) => exported.push(options),
          }),
          settings,
        }),
      );
      await changeSelect(
        mounted.querySelector<HTMLSelectElement>(
          'select[aria-label="Output"]',
        )!,
        'flatten',
      );
      await changeSelect(
        mounted.querySelector<HTMLSelectElement>(
          'select[aria-label="Flattened quality"]',
        )!,
        '300',
      );
      await click(
        mounted.querySelector<HTMLButtonElement>(
          `.${panelStyles['document-export-button']}`,
        )!,
      );
      expect(exported).toEqual([{ mode: 'flatten', rasterDpi: 300 }]);
      expect(settings.written()['note.doc-1.notebookPdfMode']).toBe('flatten');
      expect(settings.written()['note.doc-1.notebookPdfDpi']).toBe('300');
    });

    it('sends a preserve notebook export without raster dpi', async () => {
      const exported: unknown[] = [];
      const mounted = mount(
        createElement(DocumentSettingsPanel, {
          context: settingsContext({
            kindId: String(notebookKindId),
            text: null,
            exportNotebookPdf: (options) => exported.push(options),
          }),
          settings: stubSettings(),
        }),
      );
      await click(
        mounted.querySelector<HTMLButtonElement>(
          `.${panelStyles['document-export-button']}`,
        )!,
      );
      expect(exported).toEqual([{ mode: 'preserve' }]);
    });
  });

  describe('registration, when-gating, and bridge', () => {
    it('gates outline by provider rows only and keeps settings always available', async () => {
      const runtime = new Runtime();
      await runtime.registerSlot({
        id: 'right-sidebar-registry',
        plugin: rightSidebarRegistryPlugin,
      });
      await runtime.registerSlot({
        id: 'outline',
        plugin: documentOutlinePlugin,
      });
      await registerWorkspaceSettings(runtime);
      await runtime.registerSlot({
        id: 'settings',
        plugin: documentSettingsPanelPlugin,
      });
      const registry = await captureRegistry(runtime);
      const withRows = settingsContext({
        kindId: String(markdownKindId),
        outline: [{ id: 'a', address: 'a', level: 1, label: 'A' }],
        outlineRevision: 'rev-1',
      });
      const markdownWithoutRows = settingsContext({
        kindId: String(markdownKindId),
        outline: [],
      });
      const notebook = settingsContext({
        kindId: String(notebookKindId),
        text: null,
        outlineSupported: true,
      });
      expect(registry.list(withRows).map((panel) => panel.id)).toEqual([
        'outline',
        'document-settings',
      ]);
      // A defined empty outline still has a tab.
      expect(
        registry.list(markdownWithoutRows).map((panel) => panel.id),
      ).toEqual(['outline', 'document-settings']);
      expect(registry.list(notebook).map((panel) => panel.id)).toEqual([
        'outline',
        'document-settings',
      ]);
      expect(registry.get('outline')?.when?.(withRows)).toBe(true);
      expect(registry.get('outline')?.when?.(notebook)).toBe(true);
      expect(registry.get('document-settings')?.when).toBeUndefined();
      await runtime.dispose();
    });

    it('keeps the Outline tab for supported empty blockpages and notebooks', async () => {
      const runtime = new Runtime();
      await runtime.registerSlot({
        id: 'right-sidebar-registry',
        plugin: rightSidebarRegistryPlugin,
      });
      await runtime.registerSlot({
        id: 'outline',
        plugin: documentOutlinePlugin,
      });
      await registerWorkspaceSettings(runtime);
      await runtime.registerSlot({
        id: 'settings',
        plugin: documentSettingsPanelPlugin,
      });
      const registry = await captureRegistry(runtime);
      const outlineWhen = registry.get('outline')?.when;
      expect(outlineWhen).toBeDefined();
      for (const kindId of [String(blockPageKindId), String(notebookKindId)]) {
        const emptyRows = settingsContext({
          kindId,
          outline: [],
          outlineRevision: 'rev-1',
        });
        const absentRows = settingsContext({
          kindId,
          text: null,
          outlineSupported: true,
        });
        const withRows = settingsContext({
          kindId,
          outline: [{ id: 'a', address: 'a', level: 1, label: 'A' }],
          outlineRevision: 'rev-1',
        });
        // Empty or not-yet-loaded rows keep the supported tab available.
        expect(registry.list(emptyRows).map((panel) => panel.id)).toEqual([
          'outline',
          'document-settings',
        ]);
        expect(registry.list(absentRows).map((panel) => panel.id)).toEqual([
          'outline',
          'document-settings',
        ]);
        expect(registry.list(withRows).map((panel) => panel.id)).toEqual([
          'outline',
          'document-settings',
        ]);
        expect(outlineWhen?.(emptyRows)).toBe(true);
        expect(outlineWhen?.(absentRows)).toBe(true);
        expect(outlineWhen?.(withRows)).toBe(true);
      }
      await runtime.dispose();
    });

    it('registers through an owner scope and cleans up on deactivate/reactivate', async () => {
      const runtime = new Runtime();
      await runtime.registerSlot({
        id: 'right-sidebar-registry',
        plugin: rightSidebarRegistryPlugin,
      });
      await runtime.registerSlot({
        id: 'outline',
        plugin: documentOutlinePlugin,
      });
      const registry = await captureRegistry(runtime);
      const withRows = settingsContext({
        outline: [{ id: 'a', address: 'a', level: 1, label: 'A' }],
      });
      expect(registry.list(withRows).map((panel) => panel.id)).toEqual([
        'outline',
      ]);
      await runtime.removeSlot('outline');
      expect(registry.list(withRows).map((panel) => panel.id)).toEqual([]);
      await runtime.registerSlot({
        id: 'outline',
        plugin: documentOutlinePlugin,
      });
      expect(registry.list(withRows).map((panel) => panel.id)).toEqual([
        'outline',
      ]);
      await runtime.dispose();
    });

    it('follows workspace settings withdrawal and reactivation with the current service', async () => {
      const runtime = new Runtime();
      await runtime.registerSlot({
        id: 'right-sidebar-registry',
        plugin: rightSidebarRegistryPlugin,
      });
      await runtime.registerSlot({
        id: 'settings-panel',
        plugin: documentSettingsPanelPlugin,
      });
      const registry = await captureRegistry(runtime);
      expect(registry.get('document-settings')).toBeUndefined();

      const first = stubSettings();
      await registerWorkspaceSettings(runtime, first);
      expect(registry.get('document-settings')).toBeDefined();
      await runtime.removeSlot('workspace-settings-source');
      expect(registry.get('document-settings')).toBeUndefined();

      const current = stubSettings();
      await registerWorkspaceSettings(runtime, current);
      const Panel = registry.get('document-settings')?.component;
      if (Panel === undefined)
        throw new Error('settings panel did not reactivate');
      const mounted = mount(
        createElement(Panel, { context: settingsContext() }),
      );
      await click(
        mounted.querySelector<HTMLInputElement>('input[type="checkbox"]')!,
      );
      expect(current.written()['note.doc-1.view']).toBe(true);
      expect(first.written()['note.doc-1.view']).toBeUndefined();
      // The panel host stays mounted while tabs switch. Preferences belong
      // to the document, so local form state must restart for that identity.
      act(() => {
        root!.render(
          createElement(Panel, {
            context: settingsContext({ documentId: 'doc-2' }),
          }),
        );
      });
      expect(
        mounted.querySelector<HTMLInputElement>('input[type="checkbox"]')!
          .checked,
      ).toBe(false);
      act(() => {
        root!.render(createElement(Panel, { context: settingsContext() }));
      });
      expect(
        mounted.querySelector<HTMLInputElement>('input[type="checkbox"]')!
          .checked,
      ).toBe(true);
      await runtime.dispose();
    });

    it('mounts panel components and disposes on unmount', async () => {
      const runtime = new Runtime();
      await runtime.registerSlot({
        id: 'right-sidebar-registry',
        plugin: rightSidebarRegistryPlugin,
      });
      await runtime.registerSlot({
        id: 'outline',
        plugin: documentOutlinePlugin,
      });
      await runtime.registerSlot({
        id: 'settings',
        plugin: documentSettingsPanelPlugin,
      });
      const registry = await captureRegistry(runtime);
      const outline = registry.get('outline')!;
      const OutlineComponent = outline.component;
      expect(OutlineComponent).toBeDefined();
      const container = document.createElement('div');
      document.body.appendChild(container);
      const slotRoot = createRoot(container);
      await act(async () => {
        slotRoot.render(
          createElement(OutlineComponent!, { context: outlineContext() }),
        );
      });
      expect(
        [...container.querySelectorAll(`.${panelStyles['outline-entry']}`)].map(
          (entry) => entry.textContent,
        ),
      ).toEqual(['Field notes', 'Habitat', 'Shade', 'Calls']);
      await act(async () => {
        slotRoot.unmount();
      });
      expect(
        container.querySelector(`.${panelStyles['outline-entry']}`),
      ).toBeNull();
      container.remove();
      await runtime.dispose();
    });
  });
});
