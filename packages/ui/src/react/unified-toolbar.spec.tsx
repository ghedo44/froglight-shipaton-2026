// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DocumentToolControl,
  DocumentToolSnapshot,
} from '@froglight/foundation';
import type {
  WorkbenchEditorToolsPort,
  WorkbenchReadingPresentation,
} from '../workbench-ports.js';
import type { WorkbenchDocumentView } from '../workbench.js';
import { createDocumentToolbarRegistry } from '../document-toolbar-registry.js';
import {
  createToolbarPlacementRegistry,
  type ToolbarPlacementContribution,
} from '../toolbar/placement-registry.js';
import { defaultToolbarPlacements } from '../toolbar/default-placements.js';
import { createToolbarCompositionRegistry } from '../toolbar/composition-registry.js';
import { defaultToolbarComposition } from '../toolbar/default-composition.js';
import { WorkspaceContextProvider } from './workspace/WorkspaceContext.js';
import {
  Pane,
  toPaneViewModel,
  type PaneActions,
  type PaneHosts,
} from './workspace/components/Pane.jsx';
import type { InstalledUi } from '../workbench.js';
import workspaceStyles from './WorkspaceView.module.css';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function markdownSnapshot(): DocumentToolSnapshot {
  // writing tools carry semanticRoles; the composition graph is the
  // sole primary source, geometric placements keep only utilities.
  return {
    context: 'Markdown heading 2',
    controls: [
      {
        kind: 'choice',
        id: 'markdown.block',
        group: 'block',
        label: 'Line style',
        value: 'heading:2',
        options: [
          { value: 'paragraph', label: 'Paragraph' },
          { value: 'heading:2', label: 'Heading 2' },
        ],
        semanticRole: 'writing.style',
      },
      {
        kind: 'button',
        id: 'markdown.bold',
        group: 'format',
        label: 'Bold',
        shortLabel: 'B',
        semanticRole: 'writing.bold',
        activationRole: 'toggle',
      },
      {
        kind: 'button',
        id: 'markdown.italic',
        group: 'format',
        label: 'Italic',
        shortLabel: 'I',
        semanticRole: 'writing.italic',
        activationRole: 'toggle',
      },
      {
        kind: 'button',
        id: 'markdown.code',
        group: 'format',
        label: 'Inline code',
        shortLabel: 'Code',
        semanticRole: 'writing.code',
        activationRole: 'toggle',
      },
      {
        kind: 'input',
        id: 'markdown.link',
        group: 'insert',
        label: 'Link destination',
        actionLabel: 'Link',
        semanticRole: 'writing.link',
      },
      {
        kind: 'button',
        id: 'markdown.code-block',
        group: 'insert',
        label: 'Code block',
        shortLabel: 'Code block',
        semanticRole: 'writing.code-block',
      },
    ] as DocumentToolSnapshot['controls'],
  };
}

function blockpageSnapshot(
  overrides?: Partial<Record<string, Partial<DocumentToolControl>>>,
): DocumentToolSnapshot {
  const button = (
    id: string,
    label: string,
    extra: Record<string, unknown> = {},
  ): DocumentToolControl =>
    ({
      kind: 'button',
      id,
      group:
        id === 'block.indent' || id === 'block.outdent'
          ? 'structure'
          : 'format',
      label,
      shortLabel: label,
      ...(overrides?.[id] ?? {}),
      ...extra,
    }) as DocumentToolControl;
  // semanticRoles drive composition resolution (sole primary source).
  const roleFor = (id: string): string => {
    if (id === 'block.bold') return 'writing.bold';
    if (id === 'block.italic') return 'writing.italic';
    if (id === 'block.strike') return 'writing.strike';
    if (id === 'block.code') return 'writing.code';
    if (id === 'block.indent') return 'writing.indent';
    if (id === 'block.outdent') return 'writing.outdent';
    return 'writing.bold';
  };
  const markButton = (id: string, label: string): DocumentToolControl =>
    button(id, label, {
      semanticRole: roleFor(id),
      activationRole: 'toggle',
    });
  return {
    context: 'Paragraph',
    controls: [
      {
        kind: 'choice',
        id: 'block.type',
        group: 'block',
        label: 'Block type',
        value: 'paragraph',
        options: [
          { value: 'paragraph', label: 'Paragraph' },
          { value: 'heading:1', label: 'Heading 1' },
          { value: 'heading:2', label: 'Heading 2' },
          { value: 'heading:3', label: 'Heading 3' },
          { value: 'quote', label: 'Quote' },
          { value: 'code', label: 'Code block' },
          { value: 'toggle', label: 'Toggle' },
          { value: 'callout', label: 'Callout' },
        ],
        semanticRole: 'writing.style',
        ...(overrides?.['block.type'] ?? {}),
      } as DocumentToolControl,
      markButton('block.bold', 'Bold'),
      markButton('block.italic', 'Italic'),
      markButton('block.strike', 'Strikethrough'),
      markButton('block.code', 'Inline code'),
      {
        kind: 'input',
        id: 'block.link',
        group: 'format',
        label: 'Link destination',
        placeholder: 'https://…',
        actionLabel: 'Link',
        icon: 'link',
        semanticRole: 'writing.link',
        ...(overrides?.['block.link'] ?? {}),
      } as DocumentToolControl,
      button('block.indent', 'Indent block', {
        semanticRole: 'writing.indent',
      }),
      button('block.outdent', 'Outdent block', {
        semanticRole: 'writing.outdent',
      }),
    ],
  };
}

function pdfSnapshot(): DocumentToolSnapshot {
  // source actions resolve through composition; page navigation
  // keeps its geometric bottom-center island.
  return {
    context: 'PDF source',
    controls: [
      {
        kind: 'button',
        id: 'pdf.previous',
        group: 'pages',
        label: 'Previous PDF page',
        shortLabel: 'Previous',
        semanticRole: 'pdf.page.previous',
      },
      {
        kind: 'status',
        id: 'pdf.page',
        group: 'pages',
        label: '3 / 9',
      },
      {
        kind: 'button',
        id: 'pdf.next',
        group: 'pages',
        label: 'Next PDF page',
        shortLabel: 'Next',
        semanticRole: 'pdf.page.next',
      },
      {
        kind: 'button',
        id: 'pdf.source-select',
        group: 'interaction',
        label: 'Select and copy source text',
        shortLabel: 'Source Select',
        semanticRole: 'pdf.select.source',
      },
      {
        kind: 'button',
        id: 'pdf.import-notebook',
        group: 'document',
        label: 'Annotate / Import as Notebook',
        shortLabel: 'Annotate',
        semanticRole: 'pdf.annotate.notebook',
      },
    ] as DocumentToolSnapshot['controls'],
  };
}

function latexSnapshot(
  diagnostics?: Extract<DocumentToolControl, { kind: 'diagnostics' }>,
): DocumentToolSnapshot {
  // LaTeX tools resolve through composition; diagnostics keep the
  // geometric top-right island.
  return {
    context: 'LaTeX',
    controls: [
      {
        kind: 'choice',
        id: 'latex.structure',
        group: 'structure',
        label: 'Structure',
        value: '',
        options: [
          { value: '', label: 'Structure…' },
          { value: 'section', label: 'Section' },
        ],
        semanticRole: 'writing.style',
      },
      {
        kind: 'button',
        id: 'latex.bold',
        group: 'format',
        label: 'Bold',
        shortLabel: 'B',
        semanticRole: 'writing.bold',
        activationRole: 'toggle',
      },
      {
        kind: 'button',
        id: 'latex.emphasis',
        group: 'format',
        label: 'Emphasis',
        shortLabel: 'I',
        semanticRole: 'writing.italic',
        activationRole: 'toggle',
      },
      {
        kind: 'button',
        id: 'latex.inline-math',
        group: 'math',
        label: 'Inline math',
        shortLabel: '$x$',
        semanticRole: 'latex.math.inline',
      },
      {
        kind: 'button',
        id: 'latex.display-math',
        group: 'math',
        label: 'Display math',
        shortLabel: '\\[x\\]',
        semanticRole: 'latex.math.display',
      },
      {
        kind: 'button',
        id: 'latex.environment.itemize',
        group: 'insert',
        label: 'Bulleted list',
        semanticRole: 'latex.environment.itemize',
      },
      {
        kind: 'input',
        id: 'latex.label',
        group: 'references',
        label: 'Label name',
        actionLabel: 'Label',
        semanticRole: 'latex.reference.label',
      },
      {
        kind: 'input',
        id: 'latex.ref',
        group: 'references',
        label: 'Reference label',
        actionLabel: 'Ref',
        semanticRole: 'latex.reference.ref',
      },
      {
        kind: 'input',
        id: 'latex.cite',
        group: 'references',
        label: 'Citation key',
        actionLabel: 'Cite',
        semanticRole: 'latex.reference.cite',
      },
      diagnostics ?? {
        kind: 'diagnostics',
        id: 'latex.diagnostics',
        group: 'diagnostics',
        label: 'LaTeX 1 issue',
        state: 'errors',
        errorCount: 1,
        noteCount: 0,
        entries: [
          {
            id: '0',
            message: 'unknown macro: \\foobar',
            code: 'LATEX_UNSUPPORTED_COMMAND',
            path: 'document.tex',
            line: 0,
            navigable: true,
          },
        ],
      },
    ],
  };
}

interface ToolsDouble extends WorkbenchEditorToolsPort {
  setSnapshot(snapshot: DocumentToolSnapshot | null): void;
  calls: {
    execute: Array<[string, string?]>;
    commands: Array<'undo' | 'redo'>;
  };
}

function makeTools(snapshot: DocumentToolSnapshot | null): ToolsDouble {
  const listeners = new Set<() => void>();
  let current = snapshot;
  const calls: ToolsDouble['calls'] = { execute: [], commands: [] };
  return {
    calls,
    setSnapshot(next) {
      current = next;
      for (const listener of listeners) listener();
    },
    canExecEditorCommand: () => true,
    execEditorCommand: (command) => {
      calls.commands.push(command);
      return true;
    },
    editorToolSnapshot: () => current,
    executeEditorTool: (_pane, id, value) => {
      calls.execute.push(value === undefined ? [id] : [id, value]);
      for (const listener of listeners) listener();
      return true;
    },
    onDidChange: (listener: () => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
}

function paneState(mode: 'edit' | 'reading', documentId: string) {
  return {
    pane: 'main',
    tabs: [{ id: documentId, kind: 'document', documentId, viewId: null }],
    activeTab: documentId,
    mode,
    documentId,
    viewId: null,
    title: 'welcome.md',
    path: 'notes/welcome.md',
    dirty: false,
    recoveryWarnings: [],
    canGoBack: true,
    canGoForward: false,
  } as const;
}

function stubActions(): PaneActions {
  const noop = (): void => undefined;
  return {
    onPointerDownPane: noop,
    onActivateTab: noop,
    onCloseTab: noop,
    onFocusPane: noop,
    onOpenSwitcher: noop,
    onCreateNote: noop,
    onTabPointerDown: noop,
    onTabContextMenu: noop,
    onGoBack: noop,
    onGoForward: noop,
    onSplitRight: noop,
    onSplitDown: noop,
    onSetMode: noop,
    onOpenNoteMenu: noop,
    onPaneContextMenu: noop,
    onZoneEnter: noop,
    onZoneLeave: noop,
  };
}

function stubViews(): InstalledUi['views'] {
  return {
    get: () => undefined,
    list: () => [],
    onDidChange: () => ({ dispose: () => undefined }),
  } as unknown as InstalledUi['views'];
}

describe('unified document toolbar (mounted Pane)', () => {
  let root: Root | null = null;

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  async function mountPane(input: {
    mode?: 'edit' | 'reading';
    documentId?: string;
    kindId?: string;
    snapshot?: DocumentToolSnapshot | null;
    seedPlacements?: readonly ToolbarPlacementContribution[];
    useComposition?: boolean;
  }): Promise<{
    host: HTMLElement;
    tools: ToolsDouble;
    contributions: ReturnType<typeof createDocumentToolbarRegistry>;
    placements: ReturnType<typeof createToolbarPlacementRegistry>;
    switchDocument: (documentId: string) => Promise<void>;
  }> {
    const {
      mode = 'edit',
      documentId = 'doc-1',
      kindId = 'froglight.markdown',
      snapshot = markdownSnapshot(),
      seedPlacements = defaultToolbarPlacements(),
      // production installs the default composition alongside
      // geometric placements; primary tools resolve through it.
      useComposition = true,
    } = input;
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const tools = makeTools(snapshot);
    const contributions = createDocumentToolbarRegistry();
    const placements = createToolbarPlacementRegistry();
    const composition = createToolbarCompositionRegistry();
    for (const placement of seedPlacements)
      placements.registry.register(placement);
    if (useComposition) {
      const defaults = defaultToolbarComposition();
      defaults.categories.forEach((entry) =>
        composition.registry.registerCategory(entry),
      );
      defaults.items.forEach((entry) =>
        composition.registry.registerItem(entry),
      );
      defaults.extensions.forEach((entry) =>
        composition.registry.registerKindExtension(entry),
      );
    }
    const presentation: WorkbenchReadingPresentation = {
      kind: 'editor-readonly',
      kindId: kindId as never,
    };
    const hosts: PaneHosts = {
      editorHosts: { current: new Map() },
      readerHosts: { current: new Map() },
    };
    const ui = {
      services: { try: () => undefined },
      documentTools: contributions.registry,
      documentToolbarPlacements: placements.registry,
      ...(useComposition ? { toolbarComposition: composition.registry } : {}),
    } as unknown as InstalledUi;
    const mountedRoot = root;
    if (mountedRoot === null) throw new Error('missing React root');
    const renderPane = async (docId: string): Promise<void> => {
      const documentById = new Map<string, WorkbenchDocumentView>([
        [
          docId,
          {
            documentId: docId,
            kindId,
            path: 'notes/welcome.md',
            title: 'welcome.md',
          },
        ],
      ]);
      const model = toPaneViewModel({
        paneId: 'main',
        paneState: { ...paneState(mode, docId) },
        focusedPane: 'main',
        mobile: false,
        documentById,
        views: stubViews(),
        drag: null,
        dropTarget: null,
        revision: 0,
        settingsService: null,
        presentation,
      });
      await act(async () => {
        mountedRoot.render(
          <WorkspaceContextProvider
            value={{
              controller: {} as never,
              ui,
              choice: {} as never,
              chrome: {} as never,
              onClose: () => undefined,
            }}
          >
            <Pane
              model={model}
              actions={stubActions()}
              hosts={hosts}
              views={stubViews()}
              tools={tools}
            />
          </WorkspaceContextProvider>,
        );
      });
    };
    await renderPane(documentId);
    return {
      host,
      tools,
      contributions,
      placements,
      switchDocument: renderPane,
    };
  }

  it('presents Markdown formatting directly and routes edits to its provider', async () => {
    const { host, tools } = await mountPane({});
    const toolbar = host.querySelector('[data-toolbar="writing-direct"]');
    expect(toolbar).not.toBeNull();
    expect(host.querySelector('[data-toolbar="category-strip"]')).toBeNull();
    expect(
      toolbar?.querySelector('select[aria-label="Line style"]'),
    ).not.toBeNull();
    await act(async () => {
      (
        toolbar?.querySelector('[aria-label="Bold"]') as HTMLButtonElement
      ).click();
      await Promise.resolve();
    });
    expect(tools.calls.execute).toContainEqual(['markdown.bold']);
  });

  it('keeps the direct writing link popover scoped to the pane', async () => {
    const { host, tools, switchDocument } = await mountPane({});
    const trigger = host.querySelector(
      '[data-toolbar="writing-direct"] [aria-label="Link destination"]',
    ) as HTMLButtonElement;
    await act(async () => trigger.click());
    const dialog = host.querySelector(
      '[role="dialog"][aria-label="Link destination"]',
    );
    expect(dialog?.closest('[data-popover-layer]')).not.toBeNull();
    expect(dialog?.closest('[data-pane="main"]')).not.toBeNull();
    expect(tools.calls.execute).not.toContainEqual(['markdown.link']);
    await switchDocument('doc-2');
    expect(
      host.querySelector('[role="dialog"][aria-label="Link destination"]'),
    ).toBeNull();
  });

  it('presents LaTeX math directly and keeps references in More', async () => {
    const { host, tools } = await mountPane({
      kindId: 'froglight.latex',
      snapshot: latexSnapshot(),
    });
    const toolbar = host.querySelector('[data-toolbar="writing-direct"]');
    expect(toolbar).not.toBeNull();
    await act(async () => {
      (
        toolbar?.querySelector(
          '[aria-label="Inline math"]',
        ) as HTMLButtonElement
      ).click();
      await Promise.resolve();
    });
    expect(tools.calls.execute).toContainEqual(['latex.inline-math']);
    await act(async () =>
      (
        toolbar?.querySelector(
          '[aria-label="Insert and more"]',
        ) as HTMLButtonElement
      ).click(),
    );
    expect(
      host.querySelector(
        '[data-tool-shelf="writing.secondary"] [aria-label="Label name"]',
      ),
    ).not.toBeNull();
    expect(
      host.querySelector(
        '[data-tool-shelf="writing.secondary"] [aria-label^="Move active tool menu"]',
      ),
    ).not.toBeNull();
  });

  it('keeps Block Page writing marks in the primary toolbar', async () => {
    const { host, tools } = await mountPane({
      kindId: 'froglight.blockpage',
      snapshot: blockpageSnapshot(),
    });
    const toolbar = host.querySelector('[role="toolbar"][aria-label="Writing format"]');
    expect(toolbar).not.toBeNull();
    expect(toolbar?.querySelector('select[aria-label="Block type"]')).toBeNull();
    await act(async () => {
      (
        toolbar?.querySelector('[aria-label="Bold"]') as HTMLButtonElement
      ).click();
      await Promise.resolve();
    });
    expect(tools.calls.execute).toContainEqual(['block.bold']);
    expect(toolbar?.querySelector('[aria-label="Italic"]')).not.toBeNull();
    expect(toolbar?.querySelector('[aria-label="Insert and more"]')).toBeNull();
  });

  it('removes document editing tools in reading mode but keeps the pane bar', async () => {
    const { host } = await mountPane({ mode: 'reading' });
    expect(
      host.querySelectorAll(`.${workspaceStyles['fl-pane-header']}`).length,
    ).toBe(1);
    expect(host.querySelector('[data-toolbar="topbar-center"]')).toBeNull();
    expect(host.querySelector('[data-floating-layer]')).toBeNull();
  });

  it('reserves the floating clear zone for edit-mode documents', async () => {
    const { host, contributions, placements } = await mountPane({});
    // Edit mode: the pane body carries the top reserve so no floating
    // island can cover the first document lines.
    expect(
      host
        .querySelector(`.${workspaceStyles['fl-pane-body']}`)
        ?.classList.contains(workspaceStyles['fl-pane-body-floating']),
    ).toBe(true);
    contributions.dispose();
    placements.dispose();
  });

  it('keeps the unreserved pane body in reading mode', async () => {
    const { host, contributions, placements } = await mountPane({
      mode: 'reading',
    });
    expect(
      host
        .querySelector(`.${workspaceStyles['fl-pane-body']}`)
        ?.classList.contains(workspaceStyles['fl-pane-body-floating']),
    ).toBe(false);
    contributions.dispose();
    placements.dispose();
  });

  it('owns reversible semantic contributions through placement', async () => {
    // Placement-lifecycle isolation: no composition, so the topbar-center
    // fallback renders explicit placements.
    const { host, contributions, placements } = await mountPane({
      seedPlacements: [],
      useComposition: false,
    });
    const contribution = {
      id: 'acme.cite',
      when: ({ kindId }: { kindId: string }) => kindId === 'froglight.markdown',
      controls: () => [
        {
          kind: 'button',
          id: 'acme.cite',
          group: 'references',
          label: 'Insert citation',
        } satisfies DocumentToolControl,
      ],
      execute: () => true,
    };
    const placement: ToolbarPlacementContribution = {
      id: 'acme.cite-placement',
      kindIds: ['froglight.markdown'],
      anchor: 'topbar-center',
      controlIds: ['acme.cite'],
    };
    let contributionHandle: { dispose(): void } | null = null;
    let placementHandle: { dispose(): void } | null = null;
    // activate → one registration.
    await act(async () => {
      contributionHandle = contributions.registry.register(contribution);
      placementHandle = placements.registry.register(placement);
    });
    expect(host.querySelector('[aria-label="Insert citation"]')).not.toBeNull();
    // dispose → zero registrations.
    await act(async () => {
      contributionHandle?.dispose();
    });
    expect(host.querySelector('[aria-label="Insert citation"]')).toBeNull();
    // reactivate → one registration.
    await act(async () => {
      contributionHandle = contributions.registry.register(contribution);
    });
    expect(host.querySelector('[aria-label="Insert citation"]')).not.toBeNull();
    await act(async () => {
      contributionHandle?.dispose();
      placementHandle?.dispose();
    });
    contributions.dispose();
    placements.dispose();
  });

  it('registers, shadows, disposes, and restores placement contributions', async () => {
    // Placement-lifecycle isolation: no composition fallback interference.
    const { host, contributions, placements } = await mountPane({
      seedPlacements: [],
      useComposition: false,
    });
    // No placements: empty top bar, history-only floating layer.
    expect(host.querySelector('[data-toolbar="topbar-center"]')).toBeNull();

    let handle: { dispose(): void } | null = null;
    await act(async () => {
      handle = placements.registry.register({
        id: 'test.bold',
        kindIds: ['froglight.markdown'],
        anchor: 'topbar-center',
        controlIds: ['markdown.bold'],
      });
    });
    expect(
      host.querySelector('[data-toolbar="topbar-center"] [aria-label="Bold"]'),
    ).not.toBeNull();

    // Same-id shadowing replaces; disposal restores the previous placement.
    let shadow: { dispose(): void } | null = null;
    await act(async () => {
      shadow = placements.registry.register({
        id: 'test.bold',
        kindIds: ['froglight.markdown'],
        anchor: 'float.top-center',
        controlIds: ['markdown.bold'],
      });
    });
    expect(
      host.querySelector('[data-toolbar="topbar-center"] [aria-label="Bold"]'),
    ).toBeNull();
    expect(
      host.querySelector(
        '[data-anchor="float.top-center"] [aria-label="Bold"]',
      ),
    ).not.toBeNull();
    await act(async () => shadow?.dispose());
    expect(
      host.querySelector('[data-toolbar="topbar-center"] [aria-label="Bold"]'),
    ).not.toBeNull();
    await act(async () => handle?.dispose());
    expect(host.querySelector('[data-toolbar="topbar-center"]')).toBeNull();
    contributions.dispose();
    placements.dispose();
  });

  it('renders one visible owner and reports conflicting placements', async () => {
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const { host, placements } = await mountPane({
      seedPlacements: [],
      useComposition: false,
    });
    await act(async () => {
      placements.registry.register({
        id: 'a-first',
        kindIds: ['froglight.markdown'],
        anchor: 'topbar-center',
        order: 1,
        controlIds: ['markdown.bold'],
      });
      placements.registry.register({
        id: 'b-second',
        kindIds: ['froglight.markdown'],
        anchor: 'float.top-center',
        order: 2,
        controlIds: ['markdown.bold'],
      });
    });
    expect(host.querySelectorAll('[aria-label="Bold"]').length).toBe(1);
    expect(
      host.querySelector('[data-toolbar="topbar-center"] [aria-label="Bold"]'),
    ).not.toBeNull();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("duplicate toolbar control 'markdown.bold'"),
    );
    placements.dispose();
  });

  it('owns quick properties in the shelf without a legacy island (Repair 1)', async () => {
    // legacy `float.top-center` property islands are deleted; the
    // composition shelf owns quick colors/widths/eraser-size. Different ids,
    // same user-facing property still count as one presenter.
    const penActive: DocumentToolSnapshot = {
      context: 'Ink canvas',
      controls: [
        {
          kind: 'button',
          id: 'ink.tool.froglight.ink.pen',
          group: 'draw',
          label: 'Pen',
          active: true,
          activationRole: 'tool',
          semanticRole: 'surface.pen.ball',
        },
        {
          kind: 'button',
          id: 'ink.tool.froglight.ink.eraser',
          group: 'draw',
          label: 'Eraser',
          active: false,
          activationRole: 'tool',
          semanticRole: 'surface.erase',
        },
        // Legacy quick controls (placement-orphaned after).
        {
          kind: 'color',
          id: 'ink.color',
          group: 'style',
          label: 'Stroke color',
          value: '#37352f',
          options: ['#37352f'],
          semanticRole: 'surface.style.color',
        },
        {
          kind: 'range',
          id: 'ink.eraser-radius',
          group: 'style',
          label: 'Eraser size',
          value: 10,
          min: 2,
          max: 40,
          step: 1,
          semanticRole: 'surface.erase.size',
        },
        // Shelf settings for the active pen (the single visible presenters).
        {
          kind: 'color',
          id: 'ink.settings.pen.color',
          group: 'settings',
          label: 'Color',
          value: '#37352f',
          options: ['#37352f'],
          semanticRole: 'surface.settings.color',
        },
        {
          kind: 'choice',
          id: 'ink.settings.pen.size',
          group: 'settings',
          label: 'Size',
          value: '3.5',
          options: [{ value: '3.5', label: '3.5 px' }],
          semanticRole: 'surface.settings.size',
        },
      ] as DocumentToolSnapshot['controls'],
    };
    const { host, tools, contributions, placements } = await mountPane({
      kindId: 'froglight.ink',
      snapshot: penActive,
    });
    const shelf = () => host.querySelector('[data-tool-shelf="surface.write"]');
    const legacyIsland = () =>
      [...host.querySelectorAll('[data-anchor="float.top-center"]')].find(
        (element) => !element.hasAttribute('data-tool-shelf'),
      ) ?? null;
    // Shelf owns the pen quicks; no legacy island stacks beneath it.
    expect(
      shelf()?.querySelector('[aria-label="Quick colors"]'),
    ).not.toBeNull();
    expect(
      shelf()?.querySelector('[aria-label="Quick widths"]'),
    ).not.toBeNull();
    expect(legacyIsland()).toBeNull();
    // Exactly one visible color presenter (the shelf quick, not the legacy
    // `ink.color` island control).
    expect(host.querySelectorAll('[aria-label="Stroke color"]').length).toBe(0);

    // Switching to the eraser swaps the shelf to eraser quicks.
    await act(async () => {
      tools.setSnapshot({
        context: 'Ink canvas',
        controls: [
          {
            kind: 'button',
            id: 'ink.tool.froglight.ink.pen',
            group: 'draw',
            label: 'Pen',
            active: false,
            activationRole: 'tool',
            semanticRole: 'surface.pen.ball',
          },
          {
            kind: 'button',
            id: 'ink.tool.froglight.ink.eraser',
            group: 'draw',
            label: 'Eraser',
            active: true,
            activationRole: 'tool',
            semanticRole: 'surface.erase',
          },
          {
            kind: 'color',
            id: 'ink.color',
            group: 'style',
            label: 'Stroke color',
            value: '#37352f',
            options: ['#37352f'],
            semanticRole: 'surface.style.color',
          },
          {
            kind: 'range',
            id: 'ink.eraser-radius',
            group: 'style',
            label: 'Eraser size',
            value: 10,
            min: 2,
            max: 40,
            step: 1,
            semanticRole: 'surface.erase.size',
          },
          {
            kind: 'range',
            id: 'ink.settings.eraser.radius',
            group: 'settings',
            label: 'Eraser size',
            value: 12,
            min: 2,
            max: 40,
            step: 1,
            semanticRole: 'surface.settings.eraser-size',
          },
        ] as DocumentToolSnapshot['controls'],
      });
    });
    const eraserShelf = () =>
      host.querySelector('[data-tool-shelf="surface.erase"]');
    expect(
      eraserShelf()?.querySelector('[aria-label="Eraser size"]'),
    ).not.toBeNull();
    expect(
      eraserShelf()?.querySelector('[aria-label="Quick colors"]'),
    ).toBeNull();
    expect(legacyIsland()).toBeNull();
    contributions.dispose();
    placements.dispose();
  });

  it('keeps PDF navigation and import actions executable after migration', async () => {
    const { host, tools } = await mountPane({
      kindId: 'froglight.pdf',
      snapshot: pdfSnapshot(),
    });
    // source actions live in the composition shelf (Annotate
    // category); page navigation keeps its geometric bottom-left island.
    await act(async () => {
      (
        host.querySelector(
          '[data-toolbar="category-strip"] [data-category="pdf.annotate"]',
        ) as HTMLButtonElement
      ).click();
    });
    expect(
      host.querySelector(
        '[data-tool-shelf="pdf.annotate"] [aria-label="Annotate / Import as Notebook"]',
      ),
    ).not.toBeNull();
    const pages = host.querySelector('[data-anchor="float.bottom-left"]');
    expect(
      pages?.querySelector('[aria-label="Previous PDF page"]'),
    ).not.toBeNull();
    expect(pages?.querySelector('[aria-label="Next PDF page"]')).not.toBeNull();
    await act(async () => {
      (
        pages?.querySelector(
          '[aria-label="Next PDF page"]',
        ) as HTMLButtonElement
      ).click();
      await Promise.resolve();
    });
    expect(tools.calls.execute).toContainEqual(['pdf.next']);
    await act(async () => {
      (
        host.querySelector(
          '[data-tool-shelf="pdf.annotate"] [aria-label="Annotate / Import as Notebook"]',
        ) as HTMLButtonElement
      ).click();
      await Promise.resolve();
    });
    expect(tools.calls.execute).toContainEqual(['pdf.import-notebook']);
  });

  it('renders provider controls once when a contribution claims the same id', async () => {
    // Bold resolves through composition (sole primary source);
    // provider wins the owned pool and the shelf renders it exactly once.
    const { host, contributions, placements } = await mountPane({
      snapshot: {
        context: 'Markdown paragraph',
        controls: [
          {
            kind: 'button',
            id: 'markdown.bold',
            group: 'format',
            label: 'Bold',
            shortLabel: 'B',
            semanticRole: 'writing.bold',
            activationRole: 'toggle',
          } satisfies DocumentToolControl,
        ],
      },
    });
    await act(async () => {
      contributions.registry.register({
        id: 'acme.bold-override',
        controls: () => [
          {
            kind: 'button',
            id: 'markdown.bold',
            group: 'format',
            label: 'Bold',
            shortLabel: 'B',
          },
        ],
        execute: () => true,
      });
    });
    // Provider wins the pool; the placement renders it exactly once.
    expect(host.querySelectorAll('[aria-label="Bold"]').length).toBe(1);
    contributions.dispose();
    placements.dispose();
  });

  it('opens LaTeX diagnostics on demand and routes jumps to the provider', async () => {
    const { host, tools } = await mountPane({
      kindId: 'froglight.latex',
      snapshot: latexSnapshot(),
    });
    const trigger = host.querySelector(
      '[data-anchor="float.top-right"] [aria-label="LaTeX 1 issue"]',
    ) as HTMLButtonElement;
    await act(async () => {
      trigger.click();
    });
    const dialog = host.querySelector(
      '[role="dialog"][aria-label="LaTeX 1 issue"]',
    );
    expect(dialog).not.toBeNull();
    const entry = dialog?.querySelector(
      '[data-diagnostic-entry="0"]',
    ) as HTMLButtonElement;
    expect(entry.tagName.toLowerCase()).toBe('button');
    expect(entry.textContent).toContain('foobar');
    await act(async () => {
      entry.click();
      await Promise.resolve();
    });
    expect(tools.calls.execute).toContainEqual(['latex.diagnostics', '0']);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });

  it('dismisses LaTeX diagnostics with Escape without executing', async () => {
    const { host, tools } = await mountPane({
      kindId: 'froglight.latex',
      snapshot: latexSnapshot(),
    });
    const trigger = host.querySelector(
      '[data-anchor="float.top-right"] [aria-label="LaTeX 1 issue"]',
    ) as HTMLButtonElement;
    await act(async () => {
      trigger.click();
    });
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    const entry = host.querySelector(
      '[role="dialog"] [data-diagnostic-entry="0"]',
    ) as HTMLElement;
    await act(async () => {
      entry.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    // Escape on an entry cancels the popover like the input popover does.
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(tools.calls.execute).toEqual([]);
    expect(document.activeElement).toBe(trigger);
  });

  it('distinguishes LaTeX diagnostic states accessibly', async () => {
    const clean = await mountPane({
      kindId: 'froglight.latex',
      snapshot: latexSnapshot({
        kind: 'diagnostics',
        id: 'latex.diagnostics',
        group: 'diagnostics',
        label: 'LaTeX no issues',
        state: 'clean',
        errorCount: 0,
        noteCount: 0,
        entries: [],
      }),
    });
    expect(
      clean.host
        .querySelector(
          '[data-anchor="float.top-right"] [aria-label="LaTeX no issues"]',
        )
        ?.getAttribute('data-diagnostics-state'),
    ).toBe('clean');

    const unavailable = await mountPane({
      kindId: 'froglight.latex',
      snapshot: latexSnapshot({
        kind: 'diagnostics',
        id: 'latex.diagnostics',
        group: 'diagnostics',
        label: 'LaTeX preview unavailable',
        state: 'unavailable',
        errorCount: 0,
        noteCount: 0,
        entries: [],
      }),
    });
    expect(
      unavailable.host
        .querySelector(
          '[data-anchor="float.top-right"] [aria-label="LaTeX preview unavailable"]',
        )
        ?.getAttribute('data-diagnostics-state'),
    ).toBe('unavailable');
  });

  it('removes LaTeX editing tools in reading mode but keeps the pane bar', async () => {
    const { host } = await mountPane({
      mode: 'reading',
      kindId: 'froglight.latex',
      snapshot: latexSnapshot(),
    });
    expect(host.querySelector('[data-toolbar="topbar-center"]')).toBeNull();
    expect(host.querySelector('[data-floating-layer]')).toBeNull();
  });

  it('removes Block Page editing tools in reading mode but keeps the pane bar', async () => {
    const { host } = await mountPane({
      mode: 'reading',
      kindId: 'froglight.blockpage',
      snapshot: blockpageSnapshot(),
    });
    expect(host.querySelector('[data-toolbar="topbar-center"]')).toBeNull();
    expect(host.querySelector('[data-floating-layer]')).toBeNull();
  });
});
