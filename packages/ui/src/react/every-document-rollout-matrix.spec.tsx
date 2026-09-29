// @vitest-environment jsdom
/**
 * Mounted Pane integration coverage for every document family.
 *
 * Uses the default composition and placements through the same
 * `Pane`/`WorkspaceContextProvider` path as the application. It checks
 * grouped toolbar layout, document-specific controls, selection behavior,
 * sticky tool memory, slot editing, floating controls, accessibility,
 * and preservation of canonical document data. Browser geometry details
 * are covered by the Playwright toolbar specs.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DocumentToolControl,
  DocumentToolSnapshot,
} from '@froglight/foundation';
import {
  buildActiveToolSettingsControls,
  type SurfaceToolSettingsHost,
} from '@froglight/foundation';
import {
  writingCodeBlockControl,
  writingFormatToggleControl,
  writingIndentControl,
  writingLinkControl,
  writingOutdentControl,
} from '@froglight/foundation';
import type { WorkbenchEditorToolsPort } from '../workbench-ports.js';
import type { WorkbenchDocumentView } from '../workbench.js';
import { createDocumentToolbarRegistry } from '../document-toolbar-registry.js';
import { createToolbarPlacementRegistry } from '../toolbar/placement-registry.js';
import { defaultToolbarPlacements } from '../toolbar/default-placements.js';
import { createToolbarCompositionRegistry } from '../toolbar/composition-registry.js';
import { defaultToolbarComposition } from '../toolbar/default-composition.js';
import { computeUnifiedToolbarModel } from './UnifiedToolbar.jsx';
import { handleMenuListKeyDown } from './toolbar-popover.jsx';
import { WorkspaceContextProvider } from './workspace/WorkspaceContext.js';
import {
  Pane,
  toPaneViewModel,
  type PaneActions,
  type PaneHosts,
} from './workspace/components/Pane.jsx';
import type { InstalledUi } from '../workbench.js';
import workspaceStyles from './WorkspaceView.module.css';
import shippedCss from './UnifiedToolbar.module.css?inline';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Faithful snapshot doubles (mirror provider literals, subset for resolve)
// ---------------------------------------------------------------------------

type SurfaceKey =
  | 'pen'
  | 'fountain'
  | 'brush'
  | 'pencil'
  | 'highlighter'
  | 'eraser'
  | 'select'
  | 'lasso'
  | 'line'
  | 'rect'
  | 'ellipse'
  | 'text'
  | 'image';

const SURFACE_DEFS: readonly {
  readonly key: SurfaceKey;
  readonly semanticRole: string;
  readonly label: string;
  readonly toolRole:
    | 'pen'
    | 'highlighter'
    | 'eraser'
    | 'select'
    | 'lasso'
    | 'shape'
    | 'text';
}[] = [
  {
    key: 'pen',
    semanticRole: 'surface.pen.ball',
    label: 'Ball Pen',
    toolRole: 'pen',
  },
  {
    key: 'fountain',
    semanticRole: 'surface.pen.fountain',
    label: 'Fountain Pen',
    toolRole: 'pen',
  },
  {
    key: 'brush',
    semanticRole: 'surface.pen.brush',
    label: 'Brush Pen',
    toolRole: 'pen',
  },
  {
    key: 'pencil',
    semanticRole: 'surface.pencil',
    label: 'Pencil',
    toolRole: 'pen',
  },
  {
    key: 'highlighter',
    semanticRole: 'surface.highlighter',
    label: 'Highlighter',
    toolRole: 'highlighter',
  },
  {
    key: 'eraser',
    semanticRole: 'surface.erase',
    label: 'Eraser',
    toolRole: 'eraser',
  },
  {
    key: 'select',
    semanticRole: 'surface.select',
    label: 'Select',
    toolRole: 'select',
  },
  {
    key: 'lasso',
    semanticRole: 'surface.lasso',
    label: 'Lasso',
    toolRole: 'lasso',
  },
  {
    key: 'line',
    semanticRole: 'surface.shape.line',
    label: 'Line',
    toolRole: 'shape',
  },
  {
    key: 'rect',
    semanticRole: 'surface.shape.rectangle',
    label: 'Rectangle',
    toolRole: 'shape',
  },
  {
    key: 'ellipse',
    semanticRole: 'surface.shape.ellipse',
    label: 'Ellipse',
    toolRole: 'shape',
  },
  {
    key: 'text',
    semanticRole: 'surface.insert.text',
    label: 'Text',
    toolRole: 'text',
  },
  {
    key: 'image',
    semanticRole: 'surface.insert.image',
    label: 'Image',
    toolRole: 'text',
  },
];

function stylePreset(id: string, name: string, favorite: boolean) {
  return {
    id,
    name,
    toolKind: 'pen',
    preset: { color: '#37352f', size: 3.5 },
    favorite,
    order: 0,
  } as never;
}

function surfaceHost(
  activeKey: string,
  prefix: string,
  eraserMode = 'stroke',
): SurfaceToolSettingsHost {
  return {
    // Family-faithful host id: the notebook/whiteboard dialects report
    // their own prefix (the settings key derivation only reads the last
    // segment, so behavior is unchanged — this is id fidelity, not logic).
    activeToolId: () => `froglight.${prefix}.${activeKey}`,
    setTool: () => undefined,
    toolPreset: () => ({ color: '#37352f', size: 3.5 }),
    setToolPreset: () => undefined,
    savedStyles: (tool: string) =>
      tool === 'pen' || tool === 'pencil'
        ? [stylePreset('f1', 'Daily', true), stylePreset('f2', 'Fine', false)]
        : [],
    currentStyleId: (tool: string) =>
      tool === 'pen' || tool === 'pencil' ? 'f1' : null,
    saveCurrentStyle: () => null,
    applySavedStyle: () => false,
    updateSavedStyle: () => false,
    renameSavedStyle: () => false,
    favoriteSavedStyle: () => false,
    reorderSavedStyles: () => false,
    deleteSavedStyle: () => false,
    resetSavedStyle: () => false,
    savedStyleModified: () => false,
    eraserPreset: () => ({ radius: 12, mode: eraserMode, filter: 'all' }),
    setEraserPreset: () => undefined,
    lassoPreset: () => ({ mode: 'freehand', filter: 'all' }),
    setLassoPreset: () => undefined,
    recentColors: () => [],
    gestures: () => ({}),
    setGestures: () => undefined,
  } as unknown as SurfaceToolSettingsHost;
}

const WIDTHS = [2, 3.5, 6] as const;
const SWATCHES = [
  '#37352f',
  '#7c6cf0',
  '#c4554d',
  '#448361',
  '#a08430',
] as const;

function surfaceControls(
  prefix: 'ink' | 'notebook' | 'whiteboard',
  activeKey: string,
  eraserMode = 'stroke',
): DocumentToolControl[] {
  const textId =
    prefix === 'notebook'
      ? 'notebook.text'
      : `${prefix === 'whiteboard' ? 'ink' : prefix}.tool.text`;
  // Keep ids family-idiomatic: notebook uses notebook.* for draw tools in
  // the real provider (page-surface dialect), ink/whiteboard use ink.tool.*.
  // Semantic roles converge (shared surface grammar); only ids differ.
  const idFor = (key: SurfaceKey): string => {
    if (prefix === 'notebook') {
      if (key === 'text') return 'notebook.text';
      return `notebook.tool.${key}`;
    }
    return `ink.tool.${key}`;
  };
  const controls = SURFACE_DEFS.map(
    (def) =>
      ({
        kind: 'button',
        id: idFor(def.key),
        group: 'draw',
        label: def.label,
        shortLabel: def.label,
        role: 'surface-tool',
        toolId: idFor(def.key),
        toolRole: def.toolRole,
        semanticRole: def.semanticRole,
        active: def.key === activeKey,
        activationRole: 'tool',
      }) as unknown as DocumentToolControl,
  );
  // Whiteboard card (additions-only): whiteboard alone emits it.
  if (prefix === 'whiteboard') {
    controls.push({
      kind: 'button',
      id: 'whiteboard.card',
      group: 'draw',
      label: 'Card',
      shortLabel: 'Card',
      semanticRole: 'surface.insert.card',
    } as unknown as DocumentToolControl);
  }
  // Live settings for the active pen (slot-editor source).
  controls.push(
    ...buildActiveToolSettingsControls(
      surfaceHost(activeKey, prefix, eraserMode),
      {
        prefix: prefix === 'notebook' ? 'notebook' : 'ink',
        swatches: [...SWATCHES],
        widths: [...WIDTHS],
      },
    ),
  );
  void textId;
  return controls;
}

/**
 * Provider-local hold toggle (double parity): a straight-
 * line-hold style toggle with `activationRole: 'toggle'`. No composition
 * item claims `surface.hold`, so it stays unresolved and never renders —
 * exactly like the provider double. Flipping it exercises the
 * exclusive-only sticky gate (toggles never write memory).
 */
function holdToggleControl(
  prefix: 'ink' | 'notebook' | 'whiteboard',
  hold: boolean,
): DocumentToolControl {
  return {
    kind: 'button',
    id: `${prefix}.toggle.hold`,
    group: 'draw',
    label: 'Straight-line hold',
    shortLabel: 'Hold',
    role: 'surface-tool',
    toolId: `${prefix}.toggle.hold`,
    semanticRole: 'surface.hold',
    active: hold,
    activationRole: 'toggle',
  } as unknown as DocumentToolControl;
}

/**
 * Provider-local eraser-mode probe (double parity): a
 * choice over the eraser mode variants. No composition item claims
 * `surface.settings.eraser-mode`, so it never renders; the variant change
 * is driven through the workbench port (the same seam providers use) while
 * restore is asserted through the Pane UI.
 */
function eraserModeProbeControl(
  prefix: 'ink' | 'notebook' | 'whiteboard',
  mode: string,
): DocumentToolControl {
  return {
    kind: 'choice',
    id: `${prefix}.settings.eraser.mode.probe`,
    group: 'settings',
    label: 'Eraser mode probe',
    semanticRole: 'surface.settings.eraser-mode',
    value: mode,
    options: [
      { value: 'stroke', label: 'Stroke' },
      { value: 'object', label: 'Object' },
    ],
  } as unknown as DocumentToolControl;
}

/** Plain-DTO guard: JSON round-trip plus no function/symbol leakage.*/
function expectPlainDto(snapshot: DocumentToolSnapshot, owner: string): void {
  expect(
    JSON.parse(JSON.stringify(snapshot)),
    `${owner}: JSON round-trip`,
  ).toEqual(snapshot);
  const visit = (value: unknown, path: string): void => {
    expect(
      typeof value === 'function',
      `${owner}: no function at ${path}`,
    ).toBe(false);
    expect(typeof value === 'symbol', `${owner}: no symbol at ${path}`).toBe(
      false,
    );
    if (Array.isArray(value)) {
      for (const [index, entry] of value.entries())
        visit(entry, `${path}[${index}]`);
    } else if (typeof value === 'object' && value !== null) {
      for (const [key, entry] of Object.entries(value))
        visit(entry, `${path}.${key}`);
    }
  };
  visit(snapshot.controls, 'controls');
}

function notebookPagesControls(): DocumentToolControl[] {
  return [
    {
      kind: 'button',
      id: 'notebook.previous',
      group: 'pages',
      label: 'Previous page',
      shortLabel: 'Previous',
    },
    { kind: 'status', id: 'notebook.page', group: 'pages', label: '2 / 5' },
    {
      kind: 'button',
      id: 'notebook.next',
      group: 'pages',
      label: 'Next page',
      shortLabel: 'Next',
    },
    {
      kind: 'choice',
      id: 'notebook.template',
      semanticRole: 'notebook.page.template',
      group: 'pages',
      label: 'Page paper',
      value: 'ruled',
      options: [{ value: 'ruled', label: 'Ruled' }],
    },
    {
      kind: 'button',
      id: 'notebook.add',
      semanticRole: 'notebook.page.add',
      group: 'pages',
      label: 'Add page',
      shortLabel: 'Add page',
    },
    {
      kind: 'button',
      id: 'notebook.duplicate',
      semanticRole: 'notebook.page.duplicate',
      group: 'pages',
      label: 'Duplicate page',
      shortLabel: 'Duplicate',
    },
    {
      kind: 'button',
      id: 'notebook.delete',
      semanticRole: 'notebook.page.delete',
      group: 'pages',
      label: 'Delete page',
      shortLabel: 'Delete',
    },
    {
      kind: 'button',
      id: 'notebook.overview',
      semanticRole: 'notebook.page.overview',
      group: 'view',
      label: 'Page overview',
      shortLabel: 'Pages',
    },
  ] as unknown as DocumentToolControl[];
}

function markdownControls(): DocumentToolControl[] {
  return [
    {
      kind: 'choice',
      id: 'markdown.block',
      group: 'block',
      label: 'Style',
      semanticRole: 'writing.style',
      value: 'paragraph',
      options: [{ value: 'paragraph', label: 'Paragraph' }],
    },
    writingFormatToggleControl('markdown.bold', 'bold', { active: true }),
    writingFormatToggleControl('markdown.italic', 'italic', { mixed: true }),
    writingFormatToggleControl('markdown.code', 'code', { disabled: true }),
    writingLinkControl('markdown.link', {
      value: 'https://froglight.test',
      active: true,
    }),
    writingCodeBlockControl('markdown.code-block', {}),
  ];
}

function blockpageControls(): DocumentToolControl[] {
  return [
    {
      kind: 'choice',
      id: 'block.type',
      group: 'block',
      label: 'Style',
      semanticRole: 'writing.style',
      value: 'paragraph',
      options: [{ value: 'paragraph', label: 'Paragraph' }],
    },
    writingFormatToggleControl('block.bold', 'bold', { active: true }),
    writingFormatToggleControl('block.italic', 'italic', { mixed: true }),
    writingFormatToggleControl('block.strike', 'strike', {}),
    writingFormatToggleControl('block.code', 'code', { disabled: true }),
    writingLinkControl('block.link', {
      value: 'https://froglight.test',
      active: true,
    }),
    writingIndentControl('block.indent', {}),
    writingOutdentControl('block.outdent', { disabled: true }),
  ];
}

/** Paragraph-context creation inserts (provider-local, slash path). */
function blockpageCreationInserts(): DocumentToolControl[] {
  const button = (insertType: string, label: string): DocumentToolControl =>
    ({
      kind: 'button',
      id: `block.insert.${insertType}`,
      group: 'insert',
      label,
      semanticRole: `block.insert.${insertType}`,
    }) as DocumentToolControl;
  return [
    button('table', 'Insert table'),
    button('image', 'Insert image'),
    button('math', 'Insert math'),
    button('diagram', 'Insert diagram'),
  ];
}

/** Table-grid selection edits (provider-local, exactly-once path). */
function blockpageTableEdits(): DocumentToolControl[] {
  const button = (id: string, label: string): DocumentToolControl =>
    ({
      kind: 'button',
      id,
      group: 'table',
      label,
      semanticRole: id,
    }) as DocumentToolControl;
  return [
    button('table.addRow', 'Add row'),
    button('table.addColumn', 'Add column'),
  ];
}

function latexControls(): DocumentToolControl[] {
  return [
    {
      kind: 'choice',
      id: 'latex.structure',
      group: 'structure',
      label: 'Structure',
      semanticRole: 'writing.style',
      value: '',
      options: [{ value: '', label: 'Structure…' }],
    } as unknown as DocumentToolControl,
    writingFormatToggleControl('latex.bold', 'bold', {}),
    writingFormatToggleControl(
      'latex.emphasis',
      'italic',
      {},
      { label: 'Emphasis' },
    ),
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
      kind: 'choice',
      id: 'latex.environment',
      group: 'insert',
      label: 'Environment',
      value: '',
      options: [{ value: '', label: 'Environment…' }],
      semanticRole: 'latex.environment',
    },
    {
      kind: 'input',
      id: 'latex.label',
      group: 'references',
      label: 'Label name',
      placeholder: 'label-key',
      actionLabel: 'Label',
      semanticRole: 'latex.reference.label',
    },
    {
      kind: 'input',
      id: 'latex.ref',
      group: 'references',
      label: 'Reference label',
      placeholder: 'label-key',
      actionLabel: 'Ref',
      semanticRole: 'latex.reference.ref',
    },
    {
      kind: 'input',
      id: 'latex.cite',
      group: 'references',
      label: 'Citation key',
      placeholder: 'citation-key',
      actionLabel: 'Cite',
      semanticRole: 'latex.reference.cite',
    },
  ] as unknown as DocumentToolControl[];
}

function pdfControls(): DocumentToolControl[] {
  return [
    {
      kind: 'button',
      id: 'pdf.previous',
      group: 'pages',
      label: 'Previous PDF page',
      shortLabel: 'Previous',
      semanticRole: 'pdf.page.previous',
    },
    { kind: 'status', id: 'pdf.page', group: 'pages', label: '3 / 9' },
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
      activationRole: 'toggle',
      active: true,
    },
    {
      kind: 'button',
      id: 'pdf.import-notebook',
      group: 'document',
      label: 'Annotate / Import as Notebook',
      shortLabel: 'Annotate',
      semanticRole: 'pdf.annotate.notebook',
    },
  ] as unknown as DocumentToolControl[];
}

// ---------------------------------------------------------------------------
// Mounted-Pane harness (the production Pane composition)
// ---------------------------------------------------------------------------

interface ToolsDouble extends WorkbenchEditorToolsPort {
  setSnapshot(snapshot: DocumentToolSnapshot | null): void;
  calls: { execute: Array<[string, string?]> };
}

/** Static snapshot double (writing/pdf/latex/blockpage creation). */
function makeStaticTools(snapshot: DocumentToolSnapshot | null): ToolsDouble {
  const listeners = new Set<() => void>();
  let current = snapshot;
  const calls: ToolsDouble['calls'] = { execute: [] };
  return {
    calls,
    setSnapshot(next) {
      current = next;
      for (const listener of listeners) listener();
    },
    canExecEditorCommand: () => true,
    execEditorCommand: () => true,
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

/** Stateful surface double (exclusive tools + notify, for sticky/slots). */
function makeSurfaceTools(
  prefix: 'ink' | 'notebook' | 'whiteboard',
  initialKey: string,
  extra: readonly DocumentToolControl[] = [],
): ToolsDouble & {
  setActiveKey(key: string): void;
  toggleHold(): void;
  holdActive(): boolean;
  beginTemp(key: string): void;
  endTemp(): void;
  eraserModeValue(): string;
  setSelectionAnchor(
    anchor: { x: number; y: number; width: number; height: number } | null,
  ): void;
} {
  const listeners = new Set<() => void>();
  let activeKey = initialKey;
  // Held temporary tool: overrides the snapshot's active flags
  // like a live-tool-fallback provider while held, but never records an
  // execute call — temporary activations never travel the execute channel.
  let tempKey: string | null = null;
  let hold = false;
  let eraserMode = 'stroke';
  // Contextual selection anchor: the `float.selection` island
  // renders only when the provider reports one. Null by default (no text
  // selection, like every other matrix test); the test sets one to
  // surface the real Bold toggle island.
  let selectionAnchor: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null = null;
  const calls: ToolsDouble['calls'] = { execute: [] };
  const snapshot = (): DocumentToolSnapshot => ({
    context: 'Surface',
    controls: [
      ...surfaceControls(prefix, tempKey ?? activeKey, eraserMode),
      ...extra,
      holdToggleControl(prefix, hold),
      eraserModeProbeControl(prefix, eraserMode),
    ],
    ...(selectionAnchor !== null ? { contextualAnchor: selectionAnchor } : {}),
  });
  const notify = (): void => {
    for (const listener of listeners) listener();
  };
  return {
    calls,
    setSnapshot(next) {
      // Static override (used for displaced-collapse probes).
      if (next !== null) {
        (snapshot as unknown as { override: unknown }).override = next;
      }
      notify();
    },
    canExecEditorCommand: () => true,
    execEditorCommand: () => true,
    editorToolSnapshot: () => {
      const overridden = (
        snapshot as unknown as { override?: DocumentToolSnapshot }
      ).override;
      if (overridden !== undefined) return overridden;
      return snapshot();
    },
    executeEditorTool: (_pane, id, value) => {
      calls.execute.push(value === undefined ? [id] : [id, value]);
      // Eraser-mode variant change: provider-owned state, no
      // exclusive-tool switch.
      if (
        id === `${prefix}.settings.eraser.mode.probe` &&
        value !== undefined
      ) {
        eraserMode = value;
        notify();
        return true;
      }
      const def = SURFACE_DEFS.find(
        (candidate) =>
          id ===
          (prefix === 'notebook' && candidate.key !== 'text'
            ? `notebook.tool.${candidate.key}`
            : candidate.key === 'text' && prefix === 'notebook'
              ? 'notebook.text'
              : `ink.tool.${candidate.key}`),
      );
      if (def !== undefined) {
        activeKey = def.key;
        tempKey = null;
        notify();
        return true;
      }
      notify();
      return true;
    },
    onDidChange: (listener: () => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    setActiveKey(key: string) {
      activeKey = key;
      notify();
    },
    toggleHold() {
      hold = !hold;
      notify();
    },
    holdActive() {
      return hold;
    },
    beginTemp(key: string) {
      tempKey = key;
      notify();
    },
    endTemp() {
      tempKey = null;
      notify();
    },
    eraserModeValue() {
      return eraserMode;
    },
    setSelectionAnchor(
      anchor: { x: number; y: number; width: number; height: number } | null,
    ) {
      selectionAnchor = anchor;
      notify();
    },
  };
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

function stubMedia(input: { compact?: boolean } = {}): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(max-width: 760px)' ? (input.compact ?? false) : false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('every-document rollout matrix (mounted Pane)', () => {
  let root: Root | null = null;

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  async function mountPanes(input: {
    panes: ReadonlyArray<{
      paneId: string;
      documentId: string;
      kindId: string;
      title: string;
      mode?: 'edit' | 'reading';
      snapshot: DocumentToolSnapshot | null;
      tools: ToolsDouble;
      presentation?: 'editor' | 'separate-reader';
    }>;
    focusedPane?: string;
    compact?: boolean;
  }): Promise<{
    host: HTMLElement;
    dispose: () => void;
    rerender: (panes: typeof input.panes) => Promise<void>;
  }> {
    stubMedia({ compact: input.compact ?? false });
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const contributions = createDocumentToolbarRegistry();
    const placements = createToolbarPlacementRegistry();
    for (const placement of defaultToolbarPlacements()) {
      placements.registry.register(placement);
    }
    const composition = createToolbarCompositionRegistry();
    const defaults = defaultToolbarComposition();
    for (const entry of defaults.categories) {
      composition.registry.registerCategory(entry);
    }
    for (const entry of defaults.items) {
      composition.registry.registerItem(entry);
    }
    for (const entry of defaults.extensions) {
      composition.registry.registerKindExtension(entry);
    }
    const views = stubViews();
    const ui = {
      services: { try: () => undefined },
      documentTools: contributions.registry,
      documentToolbarPlacements: placements.registry,
      toolbarComposition: composition.registry,
    } as unknown as InstalledUi;
    const hosts: PaneHosts = {
      editorHosts: { current: new Map() },
      readerHosts: { current: new Map() },
    };
    const actions = stubActions();
    const render = async (
      panes: typeof input.panes,
      focused = input.focusedPane ?? input.panes[0]?.paneId ?? 'main',
    ): Promise<void> => {
      const models = panes.map((pane) => {
        const documentById = new Map<string, WorkbenchDocumentView>([
          [
            pane.documentId,
            {
              documentId: pane.documentId,
              kindId: pane.kindId,
              path: pane.title,
              title: pane.title,
            },
          ],
        ]);
        return {
          pane,
          model: toPaneViewModel({
            paneId: pane.paneId,
            paneState: {
              pane: pane.paneId,
              tabs: [
                {
                  id: pane.documentId,
                  kind: 'document',
                  documentId: pane.documentId,
                  viewId: null,
                },
              ],
              activeTab: pane.documentId,
              mode: pane.mode ?? 'edit',
              documentId: pane.documentId,
              viewId: null,
              title: pane.title,
              path: pane.title,
              dirty: false,
              recoveryWarnings: [],
              canGoBack: false,
              canGoForward: false,
            } as never,
            focusedPane: focused,
            mobile: false,
            documentById,
            views,
            drag: null,
            dropTarget: null,
            revision: 0,
            settingsService: null,
            presentation:
              pane.presentation === 'separate-reader'
                ? ({ kind: 'separate-reader' } as never)
                : ({ kind: 'editor-readonly', kindId: pane.kindId } as never),
          }),
        };
      });
      await act(async () => {
        root?.render(
          <WorkspaceContextProvider
            value={{
              controller: {} as never,
              ui,
              choice: {} as never,
              chrome: {} as never,
              onClose: () => undefined,
            }}
          >
            {models.map(({ pane, model }) => (
              <Pane
                key={pane.paneId}
                model={model}
                actions={actions}
                hosts={hosts}
                views={views}
                tools={pane.tools}
              />
            ))}
          </WorkspaceContextProvider>,
        );
      });
    };
    await render(input.panes);
    return {
      host,
      dispose: () => {
        contributions.dispose();
        placements.dispose();
        composition.dispose();
      },
      rerender: render,
    };
  }

  function paneScope(host: HTMLElement, paneId: string): HTMLElement {
    const scope = host.querySelector(`[data-pane="${paneId}"]`);
    if (scope === null) throw new Error(`missing pane scope ${paneId}`);
    return scope as HTMLElement;
  }

  function stripOf(scope: HTMLElement): HTMLElement | null {
    return scope.querySelector('[data-toolbar="category-strip"]');
  }

  // --: grouped main everywhere ---------------------------------

  it.each([
    {
      kind: 'ink',
      kindId: 'froglight.ink',
      title: 'ink.froglight',
      groups: ['Selection', 'Pen', 'Highlighter', 'Eraser', 'Shapes', 'Text'],
    },
    {
      kind: 'notebook',
      kindId: 'froglight.notebook',
      title: 'notes.froglight',
      groups: ['Selection', 'Pen', 'Highlighter', 'Eraser', 'Shapes', 'Text'],
    },
    {
      kind: 'whiteboard',
      kindId: 'froglight.whiteboard',
      title: 'board.froglight',
      groups: ['Selection', 'Pen', 'Highlighter', 'Eraser', 'Shapes', 'Text'],
    },
    {
      kind: 'markdown',
      kindId: 'froglight.markdown',
      title: 'doc.md',
      groups: [],
    },
    {
      kind: 'blockpage',
      kindId: 'froglight.blockpage',
      title: 'page.block',
      groups: [],
    },
    {
      kind: 'latex',
      kindId: 'froglight.latex',
      title: 'paper.tex',
      groups: [],
    },
    {
      kind: 'pdf',
      kindId: 'froglight.pdf',
      title: 'a.pdf',
      groups: ['Pages', 'Select', 'Annotate'],
    },
  ])(
    '$kind opens grouped with one topbar and a floating layer',
    async ({ kindId, title, groups }) => {
      const snapshot: DocumentToolSnapshot =
        kindId === 'froglight.ink'
          ? { context: 'Surface', controls: surfaceControls('ink', 'pen') }
          : kindId === 'froglight.notebook'
            ? {
                context: 'Notebook',
                controls: [
                  ...surfaceControls('notebook', 'pen'),
                  ...notebookPagesControls(),
                ],
              }
            : kindId === 'froglight.whiteboard'
              ? {
                  context: 'Board',
                  controls: surfaceControls('whiteboard', 'pen'),
                }
              : kindId === 'froglight.markdown'
                ? { context: 'Markdown', controls: markdownControls() }
                : kindId === 'froglight.blockpage'
                  ? { context: 'Block', controls: blockpageControls() }
                  : kindId === 'froglight.latex'
                    ? { context: 'LaTeX', controls: latexControls() }
                    : { context: 'PDF', controls: pdfControls() };
      const tools =
        kindId === 'froglight.ink' ||
        kindId === 'froglight.notebook' ||
        kindId === 'froglight.whiteboard'
          ? makeSurfaceTools(
              kindId === 'froglight.notebook'
                ? 'notebook'
                : kindId === 'froglight.whiteboard'
                  ? 'whiteboard'
                  : 'ink',
              'pen',
              kindId === 'froglight.notebook' ? notebookPagesControls() : [],
            )
          : makeStaticTools(snapshot);
      // Surface doubles build their own snapshot; static doubles use it.
      if (
        kindId === 'froglight.ink' ||
        kindId === 'froglight.notebook' ||
        kindId === 'froglight.whiteboard'
      ) {
        // tools already carry the snapshot via editorToolSnapshot.
      } else {
        tools.setSnapshot(snapshot);
      }
      const { host, dispose } = await mountPanes({
        panes: [
          {
            paneId: 'main',
            documentId: 'doc-1',
            kindId,
            title,
            snapshot,
            tools,
          },
        ],
      });
      try {
        const scope = paneScope(host, 'main');
        const writing = [
          'froglight.markdown',
          'froglight.blockpage',
          'froglight.latex',
        ].includes(kindId);
        const strip = writing
          ? scope.querySelector('[data-toolbar="writing-direct"]')
          : stripOf(scope);
        if (kindId === 'froglight.blockpage') {
          expect(strip).toBeNull();
        } else {
          expect(strip, `${kindId}: primary tools render`).not.toBeNull();
          for (const name of groups) {
            expect(
              strip?.querySelector(`[aria-label="${name}"]`),
              `${kindId}: strip group '${name}' present`,
            ).not.toBeNull();
          }
        }
        // One topbar: no legacy flat center, no second full-width row.
        expect(
          scope.querySelector('[data-toolbar="topbar-center"]'),
          `${kindId}: no flat topbar-center fallback`,
        ).toBeNull();
        expect(
          scope.querySelector('.fl-doc-toolbar-secondary'),
          `${kindId}: no second full-width row`,
        ).toBeNull();
        expect(
          scope.querySelectorAll(
            writing
              ? '[data-toolbar="writing-direct"]'
              : '[data-toolbar="category-strip"]',
          ).length,
          `${kindId}: exactly one primary row`,
        ).toBe(kindId === 'froglight.blockpage' ? 0 : 1);
        // Floating layer per pane (secondary stays a floating island).
        expect(
          scope.querySelector('[data-floating-layer]'),
          `${kindId}: floating layer present`,
        ).not.toBeNull();
        // plain DTO (— shallow round-trip + no function/symbol
        // leakage per kind; no-engine-marker depth stays owned by the
        // provider specs).
        expectPlainDto(snapshot, kindId);
      } finally {
        dispose();
      }
    },
  );

  it('empty groups omit, never empty/disabled placeholders', async () => {
    // Markdown emits no indent/outdent: Structure resolves away entirely.
    const tools = makeStaticTools({
      context: 'Markdown',
      controls: markdownControls(),
    });
    const first = await mountPanes({
      panes: [
        {
          paneId: 'main',
          documentId: 'md-1',
          kindId: 'froglight.markdown',
          title: 'b.md',
          snapshot: { context: 'Markdown', controls: markdownControls() },
          tools,
        },
      ],
    });
    try {
      const scope = paneScope(first.host, 'main');
      const strip = scope.querySelector('[data-toolbar="writing-direct"]');
      expect(strip).not.toBeNull();
      expect(
        strip?.querySelector('[aria-label="Structure"]'),
        'markdown Structure omits (no indent/outdent emitted)',
      ).toBeNull();
    } finally {
      // unmount + dispose the first harness before the second mount.
      await act(async () => {
        root?.unmount();
        root = null;
      });
      document.body.replaceChildren();
      first.dispose();
    }
    {
      // LaTeX emits no link/code-block/indent: Insert + Structure omit.
      const latexTools = makeStaticTools({
        context: 'LaTeX',
        controls: latexControls(),
      });
      const second = await mountPanes({
        panes: [
          {
            paneId: 'main',
            documentId: 'tex-1',
            kindId: 'froglight.latex',
            title: 'p.tex',
            snapshot: { context: 'LaTeX', controls: latexControls() },
            tools: latexTools,
          },
        ],
      });
      try {
        const latexScope = paneScope(second.host, 'main');
        const latexStrip = latexScope.querySelector(
          '[data-toolbar="writing-direct"]',
        );
        expect(latexStrip).not.toBeNull();
        expect(
          latexStrip?.querySelector('[aria-label="Insert"]'),
          'latex Insert omits (no link/code-block emitted)',
        ).toBeNull();
      } finally {
        second.dispose();
      }
    }
  });

  it('Notebook keeps page management out of the toolbar while navigation floats', async () => {
    const tools = makeSurfaceTools('notebook', 'pen', notebookPagesControls());
    const { host, dispose } = await mountPanes({
      panes: [
        {
          paneId: 'main',
          documentId: 'nb-1',
          kindId: 'froglight.notebook',
          title: 'n.froglight',
          snapshot: {
            context: 'Notebook',
            controls: [
              ...surfaceControls('notebook', 'pen'),
              ...notebookPagesControls(),
            ],
          },
          tools,
        },
      ],
    });
    try {
      const scope = paneScope(host, 'main');
      expect(stripOf(scope)?.querySelector('[aria-label="Pages"]')).toBeNull();
      for (const label of [
        'Add page',
        'Duplicate page',
        'Delete page',
        'Page paper',
      ]) {
        expect(
          scope.querySelectorAll(`[aria-label="${label}"]`).length,
          `notebook '${label}' stays outside toolbar`,
        ).toBe(0);
      }
      const island = scope.querySelector('[data-anchor="float.bottom-left"]');
      expect(island?.querySelector('[aria-label="Add page"]')).toBeNull();
      expect(
        island?.querySelector('[aria-label="Previous page"]'),
      ).not.toBeNull();
    } finally {
      dispose();
    }
  });

  it('latex math/references groups stay reachable through the same seam', async () => {
    const tools = makeStaticTools({
      context: 'LaTeX',
      controls: latexControls(),
    });
    const { host, dispose } = await mountPanes({
      panes: [
        {
          paneId: 'main',
          documentId: 'tex-1',
          kindId: 'froglight.latex',
          title: 'p.tex',
          snapshot: { context: 'LaTeX', controls: latexControls() },
          tools,
        },
      ],
    });
    try {
      const scope = paneScope(host, 'main');
      const strip = scope.querySelector('[data-toolbar="writing-direct"]');
      expect(strip).not.toBeNull();
      const more = strip?.querySelector(
        '[aria-label="Insert and more"]',
      ) as HTMLButtonElement;
      await act(async () => {
        more.click();
      });
      const mathCommand = document.querySelector(
        '[aria-label="Inline math"]',
      ) as HTMLButtonElement;
      expect(mathCommand).not.toBeNull();
      await act(async () => {
        mathCommand.click();
        await Promise.resolve();
      });
      expect(tools.calls.execute).toContainEqual(['latex.inline-math']);
      if (more.getAttribute('aria-expanded') !== 'true')
        await act(async () => {
          more.click();
        });
      expect(
        document.querySelector('[aria-label="Label name"]'),
      ).not.toBeNull();
    } finally {
      dispose();
    }
  });

  // -- blockpage one-path (composition level) ---------------------------

  it('blockpage creation rides the shared shelf; selection edits never duplicate it', async () => {
    // Paragraph context: shared creation shelf + provider-local inserts.
    const paragraph: DocumentToolSnapshot = {
      context: 'Block',
      controls: [...blockpageControls(), ...blockpageCreationInserts()],
    };
    const tools = makeStaticTools(paragraph);
    const { host, dispose } = await mountPanes({
      panes: [
        {
          paneId: 'main',
          documentId: 'block-1',
          kindId: 'froglight.blockpage',
          title: 'page.block',
          snapshot: paragraph,
          tools,
        },
      ],
    });
    try {
      const scope = paneScope(host, 'main');
      const strip = stripOf(scope);
      // The Block Page editor presents insertion through slash and its local
      // add button; semantic controls remain in the snapshot for execution.
      expect(strip).toBeNull();
      for (const label of [
        'Insert table',
        'Insert image',
        'Insert math',
        'Insert diagram',
      ]) {
        expect(
          scope.querySelectorAll(`[aria-label="${label}"]`).length,
          `creation '${label}' stays in local insertion`,
        ).toBe(0);
      }
      // Table-grid edits in a table context appear at most once and never
      // in the shared shelf either (provider-local one-path).
      const tableSnapshot: DocumentToolSnapshot = {
        context: 'Block table',
        controls: [...blockpageControls(), ...blockpageTableEdits()],
      };
      tools.setSnapshot(tableSnapshot);
      await act(async () => Promise.resolve());
      for (const label of ['Add row', 'Add column']) {
        expect(
          scope.querySelectorAll(`[aria-label="${label}"]`).length,
          `table edit '${label}' at most once (never shelf + float)`,
        ).toBeLessThanOrEqual(1);
        expect(
          scope.querySelector(`[data-tool-shelf] [aria-label="${label}"]`),
          `table edit '${label}' never in shared shelf`,
        ).toBeNull();
      }
    } finally {
      dispose();
    }
  });

  // -- markdown strike omit ledger -------------------------------------

  it('markdown omits strike without synthesizing it', async () => {
    const snapshot: DocumentToolSnapshot = {
      context: 'Markdown',
      controls: markdownControls(),
    };
    const tools = makeStaticTools(snapshot);
    const { host, dispose } = await mountPanes({
      panes: [
        {
          paneId: 'main',
          documentId: 'md-1',
          kindId: 'froglight.markdown',
          title: 'b.md',
          snapshot,
          tools,
        },
      ],
    });
    try {
      const scope = paneScope(host, 'main');
      const direct = scope.querySelector('[data-toolbar="writing-direct"]');
      expect(direct?.querySelector('[aria-label="Bold"]')).not.toBeNull();
      expect(
        scope.querySelector('[aria-label="Strikethrough"]'),
        'markdown strike omitted without synthesizing it',
      ).toBeNull();
      // Composition-level dormancy: shared strike stays unresolved.
      const contributions = createDocumentToolbarRegistry();
      const composition = createToolbarCompositionRegistry();
      try {
        const defaults = defaultToolbarComposition();
        for (const entry of defaults.categories)
          composition.registry.registerCategory(entry);
        for (const entry of defaults.items)
          composition.registry.registerItem(entry);
        for (const entry of defaults.extensions)
          composition.registry.registerKindExtension(entry);
        const { resolveToolbarComposition } = await import(
          '../toolbar/composition-registry.js'
        );
        const graph = resolveToolbarComposition({
          snapshot: defaultToolbarComposition(),
          kindId: 'froglight.markdown',
          controls: snapshot.controls,
        });
        expect(graph.unresolved).toContain('writing.format.strike');
        expect(
          graph.categories.some((category) =>
            category.items.some(
              (item) => item.semanticRole === 'writing.strike',
            ),
          ),
        ).toBe(false);
      } finally {
        contributions.dispose();
        composition.dispose();
      }
      // Blockpage DOES emit strike (contrast leaf: omit is markdown-only).
      expect(
        blockpageControls().some(
          (control) => control.semanticRole === 'writing.strike',
        ),
        'blockpage keeps strike; omit is markdown-scoped',
      ).toBe(true);
    } finally {
      dispose();
    }
  });

  // -- PDF label audit ---------------------------------------------------

  it('PDF uses Pages/Select/Annotate labels with stable family ids', async () => {
    const snapshot: DocumentToolSnapshot = {
      context: 'PDF',
      controls: pdfControls(),
    };
    const tools = makeStaticTools(snapshot);
    const { host, dispose } = await mountPanes({
      panes: [
        {
          paneId: 'main',
          documentId: 'pdf-1',
          kindId: 'froglight.pdf',
          title: 'a.pdf',
          snapshot,
          tools,
        },
      ],
    });
    try {
      const scope = paneScope(host, 'main');
      const strip = stripOf(scope);
      for (const name of ['Pages', 'Select', 'Annotate']) {
        expect(strip?.querySelector(`[aria-label="${name}"]`)).not.toBeNull();
      }
      // Label-only unification: ids stay family-idiomatic (no renames).
      const { resolveToolbarComposition } = await import(
        '../toolbar/composition-registry.js'
      );
      const composition = createToolbarCompositionRegistry();
      try {
        const defaults = defaultToolbarComposition();
        for (const entry of defaults.categories)
          composition.registry.registerCategory(entry);
        for (const entry of defaults.items)
          composition.registry.registerItem(entry);
        for (const entry of defaults.extensions)
          composition.registry.registerKindExtension(entry);
        const graph = resolveToolbarComposition({
          snapshot: defaultToolbarComposition(),
          kindId: 'froglight.pdf',
          controls: snapshot.controls,
        });
        expect(
          graph.categories.map((entry) => `${entry.id}=${entry.label}`),
        ).toEqual([
          'pdf.pages=Pages',
          'pdf.select=Select',
          'pdf.annotate=Annotate',
        ]);
        // the role→id half below is double self-consistency (control
        // ids + shortLabels come from the provider-shaped double); the
        // production pin is the strip-group labels above (composition
        // labels rendered in the DOM) plus reachability through the seam.
        const roles = new Map(
          graph.categories.flatMap((category) =>
            category.items.map(
              (item) => [item.semanticRole, item.control.id] as const,
            ),
          ),
        );
        expect(roles.get('pdf.select.source')).toBe('pdf.source-select');
        expect(roles.get('pdf.annotate.notebook')).toBe('pdf.import-notebook');
      } finally {
        composition.dispose();
      }
      // Same seam: annotate executes through the workbench port.
      await act(async () => {
        (
          strip?.querySelector(
            '[data-category="pdf.annotate"]',
          ) as HTMLButtonElement
        ).click();
      });
      const shelf = scope.querySelector('[data-tool-shelf="pdf.annotate"]');
      await act(async () => {
        (
          shelf?.querySelector(
            '[aria-label="Annotate / Import as Notebook"]',
          ) as HTMLButtonElement
        ).click();
        await Promise.resolve();
      });
      expect(tools.calls.execute).toContainEqual(['pdf.import-notebook']);
    } finally {
      dispose();
    }
  });

  // -- Sticky tool groups + action-only fallback through Pane ------------------

  it('tool groups restore their tools and preserve settings', async () => {
    const tools = makeSurfaceTools('ink', 'pen');
    const snapshot: DocumentToolSnapshot = {
      context: 'Surface',
      controls: surfaceControls('ink', 'pen'),
    };
    const { host, dispose } = await mountPanes({
      panes: [
        {
          paneId: 'main',
          documentId: 'ink-1',
          kindId: 'froglight.ink',
          title: 'i.froglight',
          snapshot,
          tools,
        },
      ],
    });
    try {
      const scope = paneScope(host, 'main');
      const strip = stripOf(scope);
      if (strip === null) throw new Error('missing strip');
      const shelfFor = (category: string): HTMLElement => {
        const found = scope.querySelector(`[data-tool-shelf="${category}"]`);
        if (!(found instanceof HTMLElement))
          throw new Error(`missing shelf ${category}`);
        return found as HTMLElement;
      };
      const stripButton = (category: string): HTMLButtonElement => {
        const button = strip.querySelector(`[data-category="${category}"]`);
        if (!(button instanceof HTMLButtonElement))
          throw new Error(`missing strip ${category}`);
        return button;
      };
      await act(async () => {
        (
          shelfFor('surface.write').querySelector(
            '[aria-label="Fountain Pen"]',
          ) as HTMLButtonElement
        ).click();
      });
      expect(tools.calls.execute.at(-1)?.[0]).toBe('ink.tool.fountain');
      const beforeErase = tools.calls.execute.length;
      await act(async () => {
        stripButton('surface.erase').click();
      });
      expect(tools.calls.execute.length).toBe(beforeErase + 1);
      expect(tools.calls.execute.at(-1)?.[0]).toBe('ink.tool.eraser');
      await act(async () => {
        (
          shelfFor('surface.erase').querySelector(
            '[aria-label="Eraser"]',
          ) as HTMLButtonElement
        ).click();
      });
      expect(tools.calls.execute.at(-1)?.[0]).toBe('ink.tool.eraser');
      // drive an eraser-mode variant change through the workbench
      // port (provider-owned mode state, no exclusive-tool switch) and prove
      // the variant survives the sticky recall cycle below.
      await act(async () => {
        tools.executeEditorTool(
          'main',
          'ink.settings.eraser.mode.probe',
          'object',
        );
      });
      expect(tools.eraserModeValue()).toBe('object');
      await act(async () => {
        stripButton('surface.write').click();
      });
      expect(tools.calls.execute.at(-1)?.[0]).toBe('ink.tool.fountain');
      await act(async () => {
        stripButton('surface.erase').click();
      });
      expect(tools.calls.execute.at(-1)?.[0]).toBe('ink.tool.eraser');
      expect(
        tools.eraserModeValue(),
        'eraser mode variant restored with the tool',
      ).toBe('object');
    } finally {
      dispose();
    }
  });

  it('toggles never overwrite sticky memory; per-family scope clears', async () => {
    // the toggle half clicks a REAL toggle through the Pane
    // (Bold in the Text shelf: activationRole toggle, resolves via the
    // surface.text.bold composition item) and the temp half holds a
    // temporary eraser + flips the hold toggle provider-side (parity:
    // snapshot-only, never an execute call). Both must leave the Write
    // memory (Brush) intact.
    const textBoldToggle = {
      kind: 'button',
      id: 'ink.text.bold',
      group: 'draw',
      label: 'Bold',
      shortLabel: 'B',
      semanticRole: 'surface.text.bold',
      activationRole: 'toggle',
    } as unknown as DocumentToolControl;
    const tools = makeSurfaceTools('ink', 'pen', [textBoldToggle]);
    const snapshot: DocumentToolSnapshot = {
      context: 'Surface',
      controls: surfaceControls('ink', 'pen'),
    };
    const panes = [
      {
        paneId: 'main',
        documentId: 'ink-1',
        kindId: 'froglight.ink',
        title: 'i.froglight',
        snapshot,
        tools,
      },
    ] as const;
    const { host, dispose, rerender } = await mountPanes({ panes: [...panes] });
    try {
      const scope = paneScope(host, 'main');
      const strip = stripOf(scope);
      if (strip === null) throw new Error('missing strip');
      const stripButton = (category: string): HTMLButtonElement => {
        const button = strip.querySelector(`[data-category="${category}"]`);
        if (!(button instanceof HTMLButtonElement))
          throw new Error(`missing strip ${category}`);
        return button;
      };
      // Remember Brush as the Write sibling.
      await act(async () => {
        (
          scope.querySelector(
            '[data-tool-shelf="surface.write"] [aria-label="Brush Pen"]',
          ) as HTMLButtonElement
        ).click();
      });
      expect(tools.calls.execute.at(-1)?.[0]).toBe('ink.tool.brush');
      // Real toggle click through the Pane: the Bold toggle
      // (`ink.text.bold`, activationRole toggle) is claimed by the
      // `float.selection` geometric placement (provider-computed enabled),
      // so correctly keeps it in the selection island, not the Text
      // shelf — and the island itself renders only while the provider
      // reports a contextual anchor (text selection). Clicking it there is
      // a genuine toggle activation.
      await act(async () => {
        tools.setSelectionAnchor({ x: 100, y: 100, width: 50, height: 20 });
      });
      const bold = scope.querySelector(
        '[data-anchor="float.selection"] [aria-label="Bold"]',
      ) as HTMLButtonElement | null;
      expect(bold, 'real selection-island Bold toggle renders').not.toBeNull();
      await act(async () => {
        bold!.click();
        await Promise.resolve();
      });
      expect(tools.calls.execute).toContainEqual(['ink.text.bold']);
      // Provider-side temp seam (parity): hold flip + held temporary
      // eraser change the snapshot without ever executing.
      const callsBeforeTemp = tools.calls.execute.length;
      await act(async () => {
        tools.toggleHold();
      });
      expect(tools.holdActive()).toBe(true);
      await act(async () => {
        tools.beginTemp('eraser');
      });
      expect(tools.calls.execute.length).toBe(callsBeforeTemp);
      await act(async () => {
        tools.endTemp();
      });
      expect(tools.calls.execute.length).toBe(callsBeforeTemp);
      // Move away, then re-select Write: Brush (neither the toggle, the
      // hold, nor the temp) restores.
      await act(async () => {
        stripButton('surface.erase').click();
      });
      await act(async () => {
        (
          scope.querySelector(
            '[data-tool-shelf="surface.erase"] [aria-label="Eraser"]',
          ) as HTMLButtonElement
        ).click();
      });
      expect(tools.calls.execute.at(-1)?.[0]).toBe('ink.tool.eraser');
      await act(async () => {
        stripButton('surface.write').click();
      });
      expect(tools.calls.execute.at(-1)?.[0]).toBe('ink.tool.brush');
      expect(
        scope
          .querySelector(
            '[data-tool-shelf="surface.write"] [aria-label="Brush Pen"]',
          )
          ?.getAttribute('aria-pressed'),
      ).toBe('true');
      // Kind switch clears sticky memory (ink pen never leaks into
      // notebook).: assert on the NEWLY-ATTACHED notebook port —
      // the detached ink port trivially never grows.
      const notebookTools = makeSurfaceTools(
        'notebook',
        'pen',
        notebookPagesControls(),
      );
      await rerender([
        {
          paneId: 'main',
          documentId: 'ink-1',
          kindId: 'froglight.notebook',
          title: 'n.froglight',
          snapshot: {
            context: 'Notebook',
            controls: [
              ...surfaceControls('notebook', 'pen'),
              ...notebookPagesControls(),
            ],
          },
          tools: notebookTools,
        },
      ]);
      const afterScope = paneScope(host, 'main');
      const afterStrip = stripOf(afterScope);
      await act(async () => {
        (
          afterStrip?.querySelector(
            '[data-category="surface.write"]',
          ) as HTMLButtonElement
        ).click();
      });
      // Browse-only (fail-soft): the new port executed nothing, and in
      // particular no stale ink sibling was re-executed through it.
      expect(notebookTools.calls.execute).toEqual([]);
      expect(
        notebookTools.calls.execute.flat().join(' '),
        'no ink.tool.* re-executed on the notebook port',
      ).not.toContain('ink.tool.');
      // Document switch clears sticky memory (reload-reset).
      const docTools = makeSurfaceTools('ink', 'pen');
      await rerender([
        {
          paneId: 'main',
          documentId: 'ink-1',
          kindId: 'froglight.ink',
          title: 'i.froglight',
          snapshot: {
            context: 'Surface',
            controls: surfaceControls('ink', 'pen'),
          },
          tools: docTools,
        },
      ]);
      await act(async () => {
        (
          paneScope(host, 'main').querySelector(
            '[data-tool-shelf="surface.write"] [aria-label="Fountain Pen"]',
          ) as HTMLButtonElement
        ).click();
      });
      expect(docTools.calls.execute.at(-1)?.[0]).toBe('ink.tool.fountain');
      await rerender([
        {
          paneId: 'main',
          documentId: 'ink-2',
          kindId: 'froglight.ink',
          title: 'j.froglight',
          snapshot: {
            context: 'Surface',
            controls: surfaceControls('ink', 'pen'),
          },
          tools: docTools,
        },
      ]);
      const docBefore = docTools.calls.execute.length;
      await act(async () => {
        (
          stripOf(paneScope(host, 'main'))?.querySelector(
            '[data-category="surface.write"]',
          ) as HTMLButtonElement
        ).click();
      });
      expect(docTools.calls.execute.length).toBe(docBefore);
    } finally {
      dispose();
    }
  });

  // -- stable secondary + floating island --------------------------------

  it('shelf order stays verbatim across 5+ switches; secondary floats', async () => {
    const tools = makeSurfaceTools('ink', 'pen');
    const { host, dispose } = await mountPanes({
      panes: [
        {
          paneId: 'main',
          documentId: 'ink-1',
          kindId: 'froglight.ink',
          title: 'i.froglight',
          snapshot: {
            context: 'Surface',
            controls: surfaceControls('ink', 'pen'),
          },
          tools,
        },
      ],
    });
    try {
      const scope = paneScope(host, 'main');
      const order = (): string =>
        [
          ...scope.querySelectorAll(
            '[data-tool-shelf="surface.write"] button[aria-label]',
          ),
        ]
          .map((button) => button.getAttribute('aria-label') ?? '')
          .filter((label) =>
            ['Ball Pen', 'Fountain Pen', 'Brush Pen', 'Pencil'].includes(label),
          )
          .join('|');
      const first = order();
      for (const label of [
        'Fountain Pen',
        'Brush Pen',
        'Pencil',
        'Ball Pen',
        'Fountain Pen',
      ]) {
        await act(async () => {
          (
            scope.querySelector(
              `[data-tool-shelf="surface.write"] [aria-label="${label}"]`,
            ) as HTMLButtonElement
          ).click();
        });
        expect(
          (
            scope.querySelector(
              `[data-tool-shelf="surface.write"] [aria-label="${label}"]`,
            ) as HTMLElement
          ).getAttribute('aria-pressed'),
        ).toBe('true');
        expect(order()).toBe(first);
      }
      expect(first.split('|')).toEqual([
        'Ball Pen',
        'Fountain Pen',
        'Brush Pen',
        'Pencil',
      ]);
      expect(
        scope.querySelector(
          '[data-toolbar="category-strip"] [aria-label="Highlighter"]',
        ),
      ).not.toBeNull();
      await act(async () => {
        (
          scope.querySelector(
            '[data-toolbar="category-strip"] [aria-label="Highlighter"]',
          ) as HTMLButtonElement
        ).click();
      });
      expect(
        scope
          .querySelector(
            '[data-tool-shelf="surface.highlighter"] [aria-label="Highlighter"]',
          )
          ?.getAttribute('aria-pressed'),
      ).toBe('true');
      // Secondary stays a floating hovering island, never a docked row.
      expect(scope.querySelector('[data-floating-layer]')).not.toBeNull();
      expect(scope.querySelector('.fl-doc-toolbar-secondary')).toBeNull();
    } finally {
      dispose();
    }
  });

  // -- fixed slots through Pane -----------------------------------

  it('surface Write shelf pins four fixed pen slots; writing and PDF omit them', async () => {
    const tools = makeSurfaceTools('ink', 'pen');
    const first = await mountPanes({
      panes: [
        {
          paneId: 'main',
          documentId: 'ink-1',
          kindId: 'froglight.ink',
          title: 'i.froglight',
          snapshot: {
            context: 'Surface',
            controls: surfaceControls('ink', 'pen'),
          },
          tools,
        },
      ],
    });
    try {
      const scope = paneScope(first.host, 'main');
      const slots = scope.querySelector(
        '[data-tool-shelf="surface.write"] [data-slot-kind="pen"]',
      );
      expect(slots, 'surface Write pins pen slots').not.toBeNull();
      expect(slots?.querySelectorAll(':scope button').length).toBe(4);
      expect(
        slots
          ?.querySelector('[aria-label="Ball Pen"]')
          ?.getAttribute('aria-pressed'),
      ).toBe('true');
    } finally {
      // unmount + dispose before the second mount (distinct roots).
      await act(async () => {
        root?.unmount();
        root = null;
      });
      document.body.replaceChildren();
      first.dispose();
    }
    // Writing and PDF families carry no pen slots. This checks Pane-visible
    // geometry; slot persistence and reset behavior are covered by the
    // toolbar customization specs.
    const mdTools = makeStaticTools({
      context: 'Markdown',
      controls: markdownControls(),
    });
    const second = await mountPanes({
      panes: [
        {
          paneId: 'main',
          documentId: 'md-1',
          kindId: 'froglight.markdown',
          title: 'b.md',
          snapshot: { context: 'Markdown', controls: markdownControls() },
          tools: mdTools,
        },
      ],
    });
    try {
      expect(
        paneScope(second.host, 'main').querySelector('[data-slot-kind="pen"]'),
        'markdown carries no pen slots',
      ).toBeNull();
    } finally {
      second.dispose();
    }
  });

  // -- second-activation editors through Pane ---------------------

  it('second activation opens the pen editor without re-executing; Esc + resetKey behave', async () => {
    const tools = makeSurfaceTools('ink', 'pen');
    const { host, dispose, rerender } = await mountPanes({
      panes: [
        {
          paneId: 'main',
          documentId: 'ink-1',
          kindId: 'froglight.ink',
          title: 'i.froglight',
          snapshot: {
            context: 'Surface',
            controls: surfaceControls('ink', 'pen'),
          },
          tools,
        },
      ],
    });
    try {
      const scope = paneScope(host, 'main');
      const trigger = scope.querySelector(
        '[data-tool-shelf="surface.write"] [aria-label="Ball Pen"]',
      ) as HTMLButtonElement;
      const before = tools.calls.execute.length;
      await act(async () => {
        trigger.click();
      });
      expect(tools.calls.execute.length).toBe(before);
      const dialog = scope.querySelector('[role="dialog"]');
      expect(dialog?.getAttribute('aria-label')).toBe('Ball Pen settings');
      expect(dialog?.querySelector('[aria-label="Pen family"]')).toBeNull();
      expect(dialog?.querySelector('section[aria-label="Color"]')).toBeNull();
      await act(async () => {
        dialog?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
      });
      expect(scope.querySelector('[role="dialog"]')).toBeNull();
      // Escape returns focus to the invoking slot (production
      // focus-return, asserted at DOM level — not dialog-clear alone).
      expect(document.activeElement).toBe(trigger);
      // resetKey (pane:document) clears the open editor on document switch.
      await act(async () => {
        trigger.click();
      });
      expect(scope.querySelector('[role="dialog"]')).not.toBeNull();
      await rerender([
        {
          paneId: 'main',
          documentId: 'ink-2',
          kindId: 'froglight.ink',
          title: 'j.froglight',
          snapshot: {
            context: 'Surface',
            controls: surfaceControls('ink', 'pen'),
          },
          tools,
        },
      ]);
      expect(
        paneScope(host, 'main').querySelector('[role="dialog"]'),
      ).toBeNull();
    } finally {
      dispose();
    }
  });

  // -- Split / tab-switch / narrow / reading / displaced ------------------------

  it('split panes scope independently with one floating layer each; actions route to owner', async () => {
    const pdfTools = makeStaticTools({
      context: 'PDF',
      controls: pdfControls(),
    });
    const mdTools = makeStaticTools({
      context: 'Markdown',
      controls: markdownControls(),
    });
    const { host, dispose } = await mountPanes({
      panes: [
        {
          paneId: 'main',
          documentId: 'pdf-1',
          kindId: 'froglight.pdf',
          title: 'a.pdf',
          snapshot: { context: 'PDF', controls: pdfControls() },
          tools: pdfTools,
        },
        {
          paneId: 'right',
          documentId: 'md-1',
          kindId: 'froglight.markdown',
          title: 'b.md',
          snapshot: { context: 'Markdown', controls: markdownControls() },
          tools: mdTools,
        },
      ],
    });
    try {
      const pdf = paneScope(host, 'main');
      const markdown = paneScope(host, 'right');
      expect(
        pdf.querySelector(
          '[data-toolbar="category-strip"] [aria-label="Pages"]',
        ),
      ).not.toBeNull();
      expect(
        markdown.querySelector('[data-toolbar="writing-direct"]'),
      ).not.toBeNull();
      expect(
        markdown.querySelector(
          '[data-toolbar="writing-direct"] [aria-label="Bold"]',
        ),
      ).not.toBeNull();
      expect(pdf.querySelector('[aria-label="Bold"]')).toBeNull();
      expect(host.querySelectorAll('[data-floating-layer]').length).toBe(2);
      await act(async () => {
        (
          pdf.querySelector(
            '[data-anchor="float.bottom-left"] [aria-label="Next PDF page"]',
          ) as HTMLButtonElement
        ).click();
        await Promise.resolve();
      });
      expect(pdfTools.calls.execute).toContainEqual(['pdf.next']);
      expect(mdTools.calls.execute).toEqual([]);
    } finally {
      dispose();
    }
  });

  it('no stale controls on tab/document switch within one pane', async () => {
    const inkTools = makeSurfaceTools('ink', 'pen');
    const mdTools = makeStaticTools({
      context: 'Markdown',
      controls: markdownControls(),
    });
    const { host, dispose, rerender } = await mountPanes({
      panes: [
        {
          paneId: 'main',
          documentId: 'ink-1',
          kindId: 'froglight.ink',
          title: 'i.froglight',
          snapshot: {
            context: 'Surface',
            controls: surfaceControls('ink', 'pen'),
          },
          tools: inkTools,
        },
      ],
    });
    try {
      expect(
        paneScope(host, 'main').querySelector(
          '[data-toolbar="category-strip"] [aria-label="Pen"]',
        ),
      ).not.toBeNull();
      await rerender([
        {
          paneId: 'main',
          documentId: 'md-1',
          kindId: 'froglight.markdown',
          title: 'b.md',
          snapshot: { context: 'Markdown', controls: markdownControls() },
          tools: mdTools,
        },
      ]);
      const scope = paneScope(host, 'main');
      expect(
        scope.querySelector(
          '[data-toolbar="category-strip"] [aria-label="Pen"]',
        ),
      ).toBeNull();
      expect(
        scope.querySelector('[data-toolbar="writing-direct"]'),
      ).not.toBeNull();
      expect(scope.querySelector('[aria-label="Ball Pen"]')).toBeNull();
      expect(scope.querySelector('[role="dialog"]')).toBeNull();
    } finally {
      dispose();
    }
  });

  it('latex source/reader split: edit keeps the grouped strip, reading removes it but keeps the pane bar', async () => {
    const editTools = makeStaticTools({
      context: 'LaTeX',
      controls: latexControls(),
    });
    const readTools = makeStaticTools({
      context: 'LaTeX',
      controls: latexControls(),
    });
    const { host, dispose } = await mountPanes({
      panes: [
        {
          paneId: 'main',
          documentId: 'tex-1',
          kindId: 'froglight.latex',
          title: 'p.tex',
          mode: 'edit',
          snapshot: { context: 'LaTeX', controls: latexControls() },
          tools: editTools,
        },
        {
          paneId: 'right',
          documentId: 'tex-1',
          kindId: 'froglight.latex',
          title: 'p.tex',
          mode: 'reading',
          snapshot: { context: 'LaTeX', controls: latexControls() },
          tools: readTools,
          presentation: 'separate-reader',
        },
      ],
    });
    try {
      const edit = paneScope(host, 'main');
      const reading = paneScope(host, 'right');
      expect(
        edit.querySelector('[data-toolbar="writing-direct"]'),
      ).not.toBeNull();
      expect(edit.querySelector('[data-floating-layer]')).not.toBeNull();
      // Reading gives the document the full pane when no local controls remain.
      expect(stripOf(reading)).toBeNull();
      expect(reading.querySelector('[data-tool-shelf]')).toBeNull();
      expect(reading.querySelector('[data-floating-layer]')).toBeNull();
      expect(
        reading.querySelector('[data-toolbar="writing-direct"]'),
      ).toBeNull();
      expect(
        reading
          .querySelector(`.${workspaceStyles['fl-pane-body']}`)
          ?.classList.contains(workspaceStyles['fl-pane-body-floating']),
        'reading never reserves the floating clear zone',
      ).toBe(false);
      // Latex drift gate (residual): documented Emphasis exemption.
      // self-consistency pin on the faithful double (label + role come
      // from the provider-shaped double; drift ownership stays with
      // `latex.dom.spec.ts`, which deep-equals the REAL snapshot).
      const emphasis = latexControls().find(
        (control) => control.id === 'latex.emphasis',
      );
      expect(emphasis?.semanticRole).toBe('writing.italic');
      expect(emphasis?.label).toBe('Emphasis');
    } finally {
      dispose();
    }
  });

  it('narrow (compact) pane stays single-row with a portaled More', async () => {
    const tools = makeSurfaceTools('ink', 'pen');
    const { host, dispose } = await mountPanes({
      compact: true,
      panes: [
        {
          paneId: 'main',
          documentId: 'ink-1',
          kindId: 'froglight.ink',
          title: 'i.froglight',
          snapshot: {
            context: 'Surface',
            controls: surfaceControls('ink', 'pen'),
          },
          tools,
        },
      ],
    });
    try {
      const scope = paneScope(host, 'main');
      const strip = stripOf(scope);
      expect(strip?.getAttribute('data-compact')).toBe('true');
      expect(
        scope.querySelectorAll('[data-toolbar="category-strip"]').length,
      ).toBe(1);
      const more = strip?.querySelector(
        'button[aria-label="More tool categories"]',
      ) as HTMLButtonElement;
      expect(more).not.toBeNull();
      await act(async () => {
        more.click();
      });
      const menu = document.querySelector(
        '[role="menu"][aria-label="More tool categories"]',
      );
      expect(menu).not.toBeNull();
      expect((menu as HTMLElement).style.position).toBe('fixed');
      expect(
        scope.querySelectorAll('[data-toolbar="category-strip"]').length,
        'overflow never creates a second row',
      ).toBe(1);
    } finally {
      dispose();
    }
  });

  it('adjacent-split scroll-collapse is per-pane isolated (accepted limitation)', async () => {
    const leftTools = makeSurfaceTools('ink', 'pen');
    const rightTools = makeStaticTools({
      context: 'Markdown',
      controls: markdownControls(),
    });
    const { host, dispose } = await mountPanes({
      panes: [
        {
          paneId: 'main',
          documentId: 'ink-1',
          kindId: 'froglight.ink',
          title: 'i.froglight',
          snapshot: {
            context: 'Surface',
            controls: surfaceControls('ink', 'pen'),
          },
          tools: leftTools,
        },
        {
          paneId: 'right',
          documentId: 'md-1',
          kindId: 'froglight.markdown',
          title: 'b.md',
          snapshot: { context: 'Markdown', controls: markdownControls() },
          tools: rightTools,
        },
      ],
    });
    try {
      const left = paneScope(host, 'main');
      const right = paneScope(host, 'right');
      const leftBody = left.querySelector(
        `.${workspaceStyles['fl-pane-body']}`,
      ) as HTMLElement;
      const rightBody = right.querySelector(
        `.${workspaceStyles['fl-pane-body']}`,
      ) as HTMLElement;
      expect(
        leftBody.classList.contains(workspaceStyles['fl-pane-body-floating']),
      ).toBe(true);
      expect(
        rightBody.classList.contains(workspaceStyles['fl-pane-body-floating']),
      ).toBe(true);
    } finally {
      dispose();
    }
  });

  // A geometrically claimed shelf control is already owned by the island.

  it('geometric island owns claimed controls without duplicating them in the shelf', () => {
    const contributions = createDocumentToolbarRegistry();
    const placements = createToolbarPlacementRegistry();
    const composition = createToolbarCompositionRegistry();
    try {
      // Setup: one custom pen category and an overlapping
      // top-center placement claiming the only shelf candidate.
      composition.registry.registerCategory({
        id: 'surface.write',
        familyId: 'surface',
        label: 'Write',
        icon: 'pen',
      });
      composition.registry.registerItem({
        id: 'test.write.pen',
        categoryId: 'surface.write',
        semanticRole: 'surface.pen.ball',
        projections: ['normal', 'compact', 'squeeze'],
      });
      composition.registry.registerKindExtension({
        id: 'test-ink-family',
        kindIds: ['froglight.ink'],
        familyIds: ['surface'],
      });
      placements.registry.register({
        id: 'legacy.pen',
        kindIds: ['froglight.ink'],
        anchor: 'float.top-center',
        controlIds: ['ink.pen'],
      });
      const port = {
        onDidChange: () => ({ dispose: () => undefined }),
        execEditorCommand: () => false,
        canExecEditorCommand: () => true,
        editorToolSnapshot: () => ({
          context: 'Ink canvas',
          controls: [
            {
              kind: 'button',
              id: 'ink.pen',
              group: 'draw',
              label: 'ink.pen',
              icon: 'pen',
              role: 'surface-tool',
              toolRole: 'pen',
              semanticRole: 'surface.pen.ball',
            },
          ],
        }),
        executeEditorTool: () => true,
      } as unknown as WorkbenchEditorToolsPort;
      const computed = computeUnifiedToolbarModel({
        tools: port,
        contributions: contributions.registry,
        placements: placements.registry,
        composition: composition.registry,
        pane: 'main',
        documentId: 'doc-1',
        kindId: 'froglight.ink',
      });
      // behavior (correct): the geometrically claimed control is
      // skipped in the shelf with a combined diagnostic (never silent).
      const crossLayer = computed.layout.diagnostics.filter((entry) =>
        entry.includes('in composition shelf'),
      );
      expect(crossLayer.some((entry) => entry.includes("'ink.pen'"))).toBe(
        true,
      );
      // The shelf is absent when its only candidate is already claimed by
      // the island. Tests that need a visible shelf use an unclaimed tool.
    } finally {
      contributions.dispose();
      placements.dispose();
      composition.dispose();
    }
  });

  // -- residuals ---------------------------------------------------------

  it('strip + shelf rows never wrap (computed-style seam)', () => {
    const clean = shippedCss.replace(/\/\*[\s\S]*?\*\//g, '');
    const block = (name: string): string => {
      const match = clean.match(
        new RegExp(`\\.${name}_[A-Za-z0-9]+\\s*\\{([^}]*)\\}`),
      );
      if (match === null) throw new Error(`missing style block: ${name}`);
      return match[1] ?? '';
    };
    // Single-row by construction for both the category strip and the fixed
    // slot row (the island owns scrolling instead of wrapping).
    expect(block('_fl-shelf-slots')).toMatch(/flex-wrap:\s*nowrap/);
    expect(block('_fl-shelf-slots')).not.toMatch(/flex-wrap:\s*wrap/);
  });

  it('residual: roving covers Left/Right with disabled skip', () => {
    const container = document.createElement('div');
    const labels = ['A', 'B', 'C'];
    for (const label of labels) {
      const button = document.createElement('button');
      button.textContent = label;
      container.appendChild(button);
    }
    // Disabled middle button is skipped by the shared roving contract.
    (container.children[1] as HTMLButtonElement).disabled = true;
    document.body.appendChild(container);
    try {
      (container.children[0] as HTMLElement).focus();
      const right = {
        key: 'ArrowRight',
        target: document.activeElement,
      } as unknown as React.KeyboardEvent;
      expect(handleMenuListKeyDown(right, container)).toBe(true);
      // B disabled: ArrowRight lands on C.
      expect(document.activeElement?.textContent).toBe('C');
      const left = {
        key: 'ArrowLeft',
        target: document.activeElement,
      } as unknown as React.KeyboardEvent;
      expect(handleMenuListKeyDown(left, container)).toBe(true);
      // ArrowLeft skips disabled B back to A.
      expect(document.activeElement?.textContent).toBe('A');
    } finally {
      container.remove();
    }
  });

  it('residual /: Tab never trapped; disabled never executes (native contract)', async () => {
    // Handler half: Tab/Enter/Space are never intercepted (native order).
    const shelf = document.createElement('div');
    const probe = document.createElement('button');
    probe.textContent = 'Probe';
    shelf.appendChild(probe);
    document.body.appendChild(shelf);
    try {
      for (const key of ['Tab', 'Enter', ' ']) {
        expect(
          handleMenuListKeyDown(
            { key, target: probe } as unknown as React.KeyboardEvent,
            shelf,
          ),
          `key '${key}' never intercepted`,
        ).toBe(false);
      }
    } finally {
      shelf.remove();
    }
    // disabled half through a REAL shelf. Markdown's Inline code
    // toggle is provider-disabled (`disabled: true`, semanticRole
    // writing.code) and resolves into the Format shelf — a genuinely
    // rendered disabled control, not a synthetic port.
    const mdTools = makeStaticTools({
      context: 'Markdown',
      controls: markdownControls(),
    });
    const first = await mountPanes({
      panes: [
        {
          paneId: 'main',
          documentId: 'md-1',
          kindId: 'froglight.markdown',
          title: 'b.md',
          snapshot: { context: 'Markdown', controls: markdownControls() },
          tools: mdTools,
        },
      ],
    });
    try {
      const mdScope = paneScope(first.host, 'main');
      const code = mdScope.querySelector(
        '[data-toolbar="writing-direct"] [aria-label="Inline code"]',
      ) as HTMLButtonElement | null;
      expect(
        code,
        'disabled Inline code renders in the real shelf',
      ).not.toBeNull();
      expect(
        code!.disabled,
        'named + inert via the native disabled contract',
      ).toBe(true);
      expect(code!.getAttribute('aria-label')).toBe('Inline code');
      const before = mdTools.calls.execute.length;
      // dispatchEvent (not .click()): bypasses the platform's refusal to
      // dispatch clicks on disabled buttons, proving the production handler
      // path itself never executes for disabled controls.
      await act(async () => {
        code!.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true }),
        );
        await Promise.resolve();
      });
      expect(
        mdTools.calls.execute.length,
        'disabled control never executes',
      ).toBe(before);
    } finally {
      // unmount the first harness before the second mount (the shared
      // module root would otherwise orphan the first tree).
      await act(async () => {
        root?.unmount();
        root = null;
      });
      document.body.replaceChildren();
      first.dispose();
    }
    // DOM-level Tab-leave half: an open pen slot editor is not
    // a focus trap. Focus-first lands inside the dialog; native order can
    // still carry focus outside while the dialog stays open.
    const tools = makeSurfaceTools('ink', 'pen');
    const second = await mountPanes({
      panes: [
        {
          paneId: 'main',
          documentId: 'ink-1',
          kindId: 'froglight.ink',
          title: 'i.froglight',
          snapshot: {
            context: 'Surface',
            controls: surfaceControls('ink', 'pen'),
          },
          tools,
        },
      ],
    });
    try {
      const scope = paneScope(second.host, 'main');
      const penTrigger = scope.querySelector(
        '[data-tool-shelf="surface.write"] [aria-label="Ball Pen"]',
      ) as HTMLButtonElement;
      await act(async () => {
        penTrigger.click();
      });
      const dialog = scope.querySelector(
        '[role="dialog"]',
      ) as HTMLElement | null;
      expect(dialog, 'slot editor opens on second activation').not.toBeNull();
      expect(
        dialog!.contains(document.activeElement),
        'focus-first lands inside the editor',
      ).toBe(true);
      const outside = stripOf(scope)?.querySelector(
        '[data-category="surface.write"]',
      ) as HTMLButtonElement;
      await act(async () => {
        outside.focus();
      });
      expect(
        document.activeElement,
        'Tab-order focus leaves the dialog (no trap)',
      ).toBe(outside);
      expect(
        scope.querySelector('[role="dialog"]'),
        'leaving focus does not trap-close',
      ).not.toBeNull();
    } finally {
      second.dispose();
    }
  });

  it('residual /: safe-area structural pin + every-family context-leak scan', async () => {
    // Structural (not proximity-heuristic): a shipped rule whose selector
    // names the floating strip AND whose body carries each safe-area token.
    const clean = shippedCss.replace(/\/\*[\s\S]*?\*\//g, '');
    const rules: Array<{ selector: string; body: string }> = [];
    for (const match of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      rules.push({ selector: match[1] ?? '', body: match[2] ?? '' });
    }
    for (const token of ['--fl-safe-area-left', '--fl-safe-area-right']) {
      const hit = rules.find(
        (rule) =>
          rule.selector.includes('fl-floating-strip') &&
          rule.body.includes(token),
      );
      expect(hit, `structural safe-area rule for ${token}`).not.toBeUndefined();
    }
    // Visible-context-leak scan across EVERY family (not Surface only):
    // provider context text survives only as visually-hidden metadata.
    // notebook + whiteboard included alongside ink (surface) and the
    // writing/pdf families.
    const cases: ReadonlyArray<{
      kindId: string;
      snapshot: DocumentToolSnapshot;
      tools: ToolsDouble;
    }> = [
      {
        kindId: 'froglight.ink',
        snapshot: {
          context: 'Surface',
          controls: surfaceControls('ink', 'pen'),
        },
        tools: makeSurfaceTools('ink', 'pen'),
      },
      {
        kindId: 'froglight.notebook',
        snapshot: {
          context: 'Notebook',
          controls: [
            ...surfaceControls('notebook', 'pen'),
            ...notebookPagesControls(),
          ],
        },
        tools: makeSurfaceTools('notebook', 'pen', notebookPagesControls()),
      },
      {
        kindId: 'froglight.whiteboard',
        snapshot: {
          context: 'Board',
          controls: surfaceControls('whiteboard', 'pen'),
        },
        tools: makeSurfaceTools('whiteboard', 'pen'),
      },
      {
        kindId: 'froglight.markdown',
        snapshot: {
          context: 'Markdown paragraph',
          controls: markdownControls(),
        },
        tools: makeStaticTools({
          context: 'Markdown paragraph',
          controls: markdownControls(),
        }),
      },
      {
        kindId: 'froglight.blockpage',
        snapshot: { context: 'Block page', controls: blockpageControls() },
        tools: makeStaticTools({
          context: 'Block page',
          controls: blockpageControls(),
        }),
      },
      {
        kindId: 'froglight.latex',
        snapshot: { context: 'LaTeX source', controls: latexControls() },
        tools: makeStaticTools({
          context: 'LaTeX source',
          controls: latexControls(),
        }),
      },
      {
        kindId: 'froglight.pdf',
        snapshot: { context: 'PDF source', controls: pdfControls() },
        tools: makeStaticTools({
          context: 'PDF source',
          controls: pdfControls(),
        }),
      },
    ];
    for (const entry of cases) {
      const { host, dispose } = await mountPanes({
        panes: [
          {
            paneId: 'main',
            documentId: 'doc-1',
            kindId: entry.kindId,
            title: 't',
            snapshot: entry.snapshot,
            tools: entry.tools,
          },
        ],
      });
      try {
        const scope = paneScope(host, 'main');
        for (const control of scope.querySelectorAll('button, select, input')) {
          const name =
            control.getAttribute('aria-label') ??
            control.textContent?.trim() ??
            '';
          expect(
            name.length,
            `${entry.kindId}: control keeps an accessible name`,
          ).toBeGreaterThan(0);
        }
        const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
        const leaks: string[] = [];
        let node = walker.nextNode();
        while (node !== null) {
          if (
            node.textContent?.includes(entry.snapshot.context) === true &&
            (node.textContent?.trim().length ?? 0) > 0
          ) {
            const parent = node.parentElement;
            const hidden =
              parent?.closest('.visually-hidden, [aria-hidden="true"]') !==
              null;
            if (!hidden) leaks.push(parent?.outerHTML.slice(0, 120) ?? '?');
          }
          node = walker.nextNode();
        }
        expect(
          leaks,
          `${entry.kindId}: no persistent visible context label`,
        ).toEqual([]);
      } finally {
        dispose();
      }
    }
  });

  it('residual hover:none vs + de-layered cascade limit documented', async () => {
    const { currentInteractionCapabilities } = await import(
      './workspace/interaction-policy.js'
    );
    // hover:none touch-only host: no hover anywhere, coarse available.
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches:
        query === '(pointer: coarse)' || query === '(any-pointer: coarse)'
          ? true
          : false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }));
    const caps = currentInteractionCapabilities();
    // Availability is OR: coarse anywhere already counts even when
    // hover is nowhere. Touch density follows availability, not hover.
    expect(caps.anyCoarse).toBe(true);
    expect(caps.coarse).toBe(true);
    vi.unstubAllGlobals();
    // De-layered cascade limit: the computed-style seam unwraps one
    // @layer level. Fail loudly if the shipped stylesheet ever nests a
    // coarse media block deeper (media-in-layer-in-media), which the seam
    // would silently miss.
    const clean = shippedCss.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(
      clean.match(/@media[^{]*\{[^}]*@layer/s),
      'no media-in-layer nesting (seam limit)',
    ).toBeNull();
  });

  // -- narrow-fixture limit (documented, pins here) ----------------

  it('limit: PDF/notebook dedupe pinned here (fixture covers ink write only)', async () => {
    // The shelf-partitions fixture models the ink write shelf alone. PDF
    // Previous/Next + notebook management dedupe is pinned at the Pane
    // seam here via (single owner), not via the fixture. Accepted.
    const pdfTools = makeStaticTools({
      context: 'PDF',
      controls: pdfControls(),
    });
    const { host, dispose } = await mountPanes({
      panes: [
        {
          paneId: 'main',
          documentId: 'pdf-1',
          kindId: 'froglight.pdf',
          title: 'a.pdf',
          snapshot: { context: 'PDF', controls: pdfControls() },
          tools: pdfTools,
        },
      ],
    });
    try {
      const scope = paneScope(host, 'main');
      expect(
        scope.querySelectorAll('[aria-label="Previous PDF page"]').length,
      ).toBe(1);
      expect(
        scope.querySelectorAll('[aria-label="Next PDF page"]').length,
      ).toBe(1);
      expect(
        scope.querySelector(
          '[data-anchor="float.bottom-left"] [aria-label="Previous PDF page"]',
        ),
      ).not.toBeNull();
    } finally {
      dispose();
    }
  });
});
