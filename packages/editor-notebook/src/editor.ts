/**
 * Notebook editor provider: binds the pager to a
 * `DocumentSession` behind the generic editor registry seam, with a
 * headless fallback for environments without Canvas 2D and a lazy asset
 * store resolved at creation time (vaults activate after providers).
 */

import { createDerivedCachePackWorker } from '@froglight/editor-ink';
import {
  type StylusInputPolicy,
  buildActiveToolSettingsControls,
  buildSurfaceArrangeControls,
  buildSurfaceDrawControls,
  buildSurfaceExportControl,
  buildSurfaceFitControl,
  buildSurfaceImageControl,
  buildSurfaceStyleControls,
  buildSurfaceTextControls,
  buildSurfaceZoomControls,
  createSharedSurfaceDrawTools,
  createSharedSurfaceEraserTools,
  executeSurfaceTextControl,
  executeSurfaceToolbarControl,
  executeSurfaceToolSettingsControl,
  DerivedReopenStore,
  defaultPaperSpacingForTemplate,
  orientationOf,
  NOTEBOOK_PAGE_SIZES,
  PAPER_SPACING_MAX,
  PAPER_SPACING_MIN,
  surfaceTextControlIds,
} from '@froglight/foundation';
import type {
  DerivedCacheStoragePort,
  DocumentEditorHandle,
  DocumentEditorTools,
  DocumentEditorProvider,
  DocumentAssetStore,
  NotebookEditorInput,
  NotebookModel,
  PdfProvider,
  SettingsService,
  SurfaceReopenBinding,
  SurfaceToolbarDrawTool,
  SurfaceToolbarHost,
  SurfaceToolSettingsHost,
} from '@froglight/foundation';
import { NOTEBOOK_TEMPLATES, documentKindId } from '@froglight/foundation';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import {
  mountNotebook,
  NOTEBOOK_INK_COLORS,
  NOTEBOOK_INK_WIDTHS,
  NOTEBOOK_PAPER_COLORS,
  NOTEBOOK_PAPER_LABELS,
  NOTEBOOK_PAGE_SIZE_LABELS,
  type NotebookPagerHandle,
  type NotebookPagerSkeleton,
} from './pager.js';
import { PAGE_TOOL_IDS } from './page-surface.js';
import { NotebookChrome } from './react/NotebookChrome.jsx';

const NOTEBOOK_KIND_ID = documentKindId('froglight.notebook');

/**
 * Declared Notebook draw profile for the shared surface builder. Only the
 * engine-id dialect is Notebook-local (page tool ids and the Notebook
 * text id), with the single eraser replaced by two fixed-mode tools.
 * Labels, icons, groups, coarse roles, semantic roles, and ordering
 * come from the shared family tables so Notebook cannot diverge from Ink or
 * Whiteboard. Pages, PDF insertion, and paper stay provider-local additions.
 * The `surface.erase.tool` composition id itself is never renamed — it stays
 * dormant for persisted overrides/old hosts while providers emit the two
 * fixed-mode tools over the single eraser engine.
 */
const NOTEBOOK_DRAW_BASE: readonly SurfaceToolbarDrawTool[] =
  createSharedSurfaceDrawTools({
    pen: PAGE_TOOL_IDS.pen,
    fountain: PAGE_TOOL_IDS.fountain,
    brush: PAGE_TOOL_IDS.brush,
    pencil: PAGE_TOOL_IDS.pencil,
    highlighter: PAGE_TOOL_IDS.highlighter,
    eraser: PAGE_TOOL_IDS.eraser,
    select: PAGE_TOOL_IDS.select,
    lasso: PAGE_TOOL_IDS.lasso,
    line: PAGE_TOOL_IDS.line,
    rectangle: PAGE_TOOL_IDS.rect,
    triangle: PAGE_TOOL_IDS.triangle,
    diamond: PAGE_TOOL_IDS.diamond,
    ellipse: PAGE_TOOL_IDS.ellipse,
    text: PAGE_TOOL_IDS.text,
  });

const NOTEBOOK_DRAW_TOOLS: readonly SurfaceToolbarDrawTool[] = [
  ...NOTEBOOK_DRAW_BASE.slice(0, 5),
  ...createSharedSurfaceEraserTools(PAGE_TOOL_IDS.eraser),
  ...NOTEBOOK_DRAW_BASE.slice(6),
];

/**
 * Grouped surface-text execute (shared helper).
 *
 * Thin `notebook` dialect over the shared `executeSurfaceTextControl`
 * (foundation owns the additive `setSelectionStyle` mapping; the shared
 * engine owns selection mutation and the pending style for newly placed text.
 */
export function executeNotebookTextControl(
  pager: Pick<NotebookPagerHandle, 'textSelectionState' | 'setTextStyle'>,
  id: string,
  value: unknown,
): boolean {
  return executeSurfaceTextControl(
    {
      textSelectionState: () => pager.textSelectionState(),
      setSelectionStyle: (style) => pager.setTextStyle(style),
    },
    'notebook',
    id,
    value,
  );
}

function hasCanvas2d(): boolean {
  try {
    if (typeof document === 'undefined') return false;
    const probe = document.createElement('canvas');
    const probeCtx = probe.getContext('2d');
    if (probeCtx === null || probeCtx === undefined) return false;
    return typeof (probeCtx as { fillRect?: unknown }).fillRect === 'function';
  } catch {
    return false;
  }
}

interface SessionBridge {
  readonly model: NotebookModel;
  readonly openMetadata?: Readonly<Record<string, unknown>>;
  readonly document?: { readonly documentId?: unknown };
  /** Live session revision (property read at each cache use). */
  readonly contentRevision?: string | null;
  /** Live session dirty flag (property read at each cache use). */
  readonly dirty?: boolean;
  markDirty(): void;
}

/** Headless fallback handle: open/save/reopen work; editing input does not. */
export class HeadlessNotebookEditorHandle implements DocumentEditorHandle {
  #destroyed = false;
  constructor(_session: { markDirty(): void }) {
    void _session;
  }
  focus(): void {
    this.#requireAlive();
  }
  hasFocus(): boolean {
    return !this.#destroyed;
  }
  setReadOnly(readOnly: boolean): void {
    this.#requireAlive();
    void readOnly;
  }
  canExecCommand(id: 'undo' | 'redo'): boolean {
    void id;
    return false;
  }
  execCommand(id: 'undo' | 'redo'): boolean {
    void id;
    return false;
  }
  revealAddress(address: string): void {
    void address;
  }
  destroy(): void {
    this.#destroyed = true;
  }
  #requireAlive(): void {
    if (this.#destroyed) throw new Error('notebook editor handle is destroyed');
  }
}

class NotebookCanvasEditorHandle implements DocumentEditorHandle {
  #destroyed = false;
  readonly #pager: NotebookPagerHandle;
  readonly #root: Root;
  readonly tools: DocumentEditorTools;
  readonly #previews = new Map<string, string>();
  readonly #previewPending = new Set<string>();
  readonly #previewListeners = new Set<() => void>();
  readonly #previewAbort = new AbortController();
  #previewGeneration = 0;

  #requestPreview(pageId: string): boolean {
    if (
      this.#destroyed ||
      this.#previews.has(pageId) ||
      this.#previewPending.has(pageId)
    )
      return false;
    if (!this.#pager.pageSummaries().some((page) => page.id === pageId))
      return false;
    const generation = this.#previewGeneration;
    this.#previewPending.add(pageId);
    void this.#pager
      .renderPageImage(pageId, 24, this.#previewAbort.signal)
      .then(
        (bytes) =>
          new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(
              new Blob([bytes.slice().buffer as ArrayBuffer], {
                type: 'image/png',
              }),
            );
          }),
      )
      .then((image) => {
        if (
          this.#destroyed ||
          this.#previewAbort.signal.aborted ||
          generation !== this.#previewGeneration
        )
          return;
        if (!this.#pager.pageSummaries().some((page) => page.id === pageId))
          return;
        this.#previews.set(pageId, image);
        for (const listener of this.#previewListeners) listener();
      })
      .catch(() => undefined)
      .finally(() => {
        this.#previewPending.delete(pageId);
        if (generation !== this.#previewGeneration && !this.#destroyed)
          for (const listener of this.#previewListeners) listener();
      });
    return true;
  }

  constructor(
    session: SessionBridge,
    parent: HTMLElement,
    assets: DocumentAssetStore | null,
    pdfProvider: PdfProvider | null,
    importPdf: NotebookEditorInput['importPdf'] | null,
    openExternalLink?: (url: string) => void | Promise<void>,
    selectPdfPages?: () => Promise<readonly number[] | undefined | null>,
    promptForPdfPassword?: (
      reason: 'required' | 'incorrect',
    ) => Promise<string | null>,
    presetSettings?: SettingsService | null,
    reopen?: SurfaceReopenBinding | null,
    stylusInput?: StylusInputPolicy,
  ) {
    // One narrowly contained synchronous commit: the engine
    // needs the actual pager chrome elements immediately, and createEditor
    // is synchronous. Never during normal rendering or engine updates.
    const chromeRef: { current: NotebookPagerSkeleton | null } = {
      current: null,
    };
    const root = createRoot(parent);
    flushSync(() => {
      root.render(createElement(NotebookChrome, { chromeRef }));
    });
    const skeleton = chromeRef.current;
    if (skeleton === null) throw new Error('notebook chrome failed to commit');
    this.#root = root;
    this.#pager = mountNotebook({
      model: session.model,
      markDirty: () => {
        session.markDirty();
        this.#previewGeneration += 1;
        this.#previews.clear();
      },
      host: skeleton,
      stylusInput,
      assets,
      pdfProvider,
      ...(session.openMetadata !== undefined
        ? { openMetadata: session.openMetadata }
        : {}),
      // Derived reopen cache: the pager resolves each page's
      // seeds and packed vectors through it at mount; decode seeds always
      // fill gaps. The live binding carries session revision/dirty
      // accessors so revision changes are honored without remounting.
      ...(reopen !== undefined && reopen !== null
        ? {
            derivedStore: reopen.store,
            documentId: reopen.documentId,
            derivedSession: {
              getContentRevision: () => reopen.getContentRevision(),
              isDirty: () => reopen.isDirty(),
            },
          }
        : {}),
      ...(importPdf !== null ? { importPdf } : {}),
      ...(openExternalLink !== undefined ? { openExternalLink } : {}),
      ...(selectPdfPages !== undefined ? { selectPdfPages } : {}),
      ...(promptForPdfPassword !== undefined ? { promptForPdfPassword } : {}),
      ...(presetSettings != null ? { presetSettings } : {}),
    });
    this.tools = {
      snapshot: () => {
        const pageCount = this.#pager.pageCount();
        const pageIndex = this.#pager.currentPageIndex();
        const pageSize = this.#pager.currentPageSize();
        const pdfBacked = this.#pager.currentBaseKind() === 'pdf-page';
        const sourceOutline = this.#pager.sourceOutline();
        const host = this.#surfaceHost();
        const zoomDisabled = pageCount === 0;
        // Slice 10 paper/ruler ergonomics: derived display values only —
        // canonical paper lives on the page base, the ruler is ephemeral.
        const paper = this.#pager.paperOptions();
        const templateId = this.#pager.currentTemplate();
        const ruler = this.#pager.rulerState();
        const rulerVisible = ruler !== null && ruler.visible === true;
        const contextualAnchor = this.#pager.selectionViewportBounds();
        const orientation =
          pageSize === null ? 'portrait' : orientationOf(pageSize);
        const sizePreset =
          pageSize === null
            ? 'custom'
            : ((
                Object.keys(
                  NOTEBOOK_PAGE_SIZES,
                ) as (keyof typeof NOTEBOOK_PAGE_SIZES)[]
              ).find(
                (id) =>
                  NOTEBOOK_PAGE_SIZES[id].width === pageSize.width &&
                  NOTEBOOK_PAGE_SIZES[id].height === pageSize.height,
              ) ?? 'custom');
        return {
          context: 'Notebook page',
          pages: this.#pager.pageSummaries().map((page) => ({
            ...page,
            ...(this.#previews.has(page.id)
              ? { thumbnail: this.#previews.get(page.id)! }
              : {}),
          })),
          ...(contextualAnchor !== null ? { contextualAnchor } : {}),
          controls: [
            ...buildSurfaceDrawControls(host, {
              prefix: 'notebook',
              tools: NOTEBOOK_DRAW_TOOLS,
              // PDF source-select policy only: the explicit
              // override applies solely on pdf-backed pages, where Select
              // honestly reflects the source interaction mode while the
              // engine still holds the pen. Everywhere else the option is
              // omitted so the host default (settled comparison, uniform
              // with Ink/Whiteboard) applies — template pages never diverge.
              ...(pdfBacked
                ? {
                    isActive: (toolId: string) =>
                      toolId === PAGE_TOOL_IDS.select
                        ? this.#pager.sourceInteractionMode() ===
                          'source-select'
                        : this.#pager.sourceInteractionMode() ===
                            'surface-authoring' &&
                          (this.#pager.settledActiveToolId?.() ??
                            this.#pager.activeToolId()) === toolId,
                  }
                : {}),
            }),
            ...buildSurfaceArrangeControls(host, {
              prefix: 'notebook',
              idPrefix: 'selection.',
              swatches: NOTEBOOK_INK_COLORS,
              widths: NOTEBOOK_INK_WIDTHS,
            }),
            // Grouped surface-text controls: honest
            // selected-text state when available, otherwise the pending
            // creation style — shared with Ink/Whiteboard.
            ...buildSurfaceTextControls(
              surfaceTextControlIds('notebook'),
              this.#pager.textSelectionState(),
            ),
            ...buildSurfaceStyleControls(host, {
              prefix: 'notebook',
              swatches: NOTEBOOK_INK_COLORS,
              widths: NOTEBOOK_INK_WIDTHS,
            }),
            {
              kind: 'button',
              id: 'notebook.previous',
              icon: 'arrow-back',
              group: 'pages',
              label: 'Previous page',
              shortLabel: 'Previous',
              disabled: pageIndex <= 0,
            },
            {
              kind: 'status',
              id: 'notebook.page',
              group: 'pages',
              label:
                pageCount === 0
                  ? 'No pages'
                  : `${pageIndex + 1} / ${pageCount}`,
            },
            {
              kind: 'button',
              id: 'notebook.next',
              icon: 'arrow-forward',
              group: 'pages',
              label: 'Next page',
              shortLabel: 'Next',
              disabled: pageIndex >= pageCount - 1,
            },
            ...(sourceOutline.length === 0
              ? []
              : [
                  {
                    kind: 'choice' as const,
                    id: 'notebook.source-outline',
                    group: 'pages',
                    label: 'PDF outline',
                    value:
                      sourceOutline.find(
                        (entry) => entry.pageId === this.#pager.currentPageId(),
                      )?.pageId ?? '',
                    options: [
                      { value: '', label: 'PDF outline…' },
                      ...sourceOutline.map((entry) => ({
                        value: entry.pageId,
                        label: entry.label,
                      })),
                    ],
                  },
                ]),
            {
              kind: 'choice',
              id: 'notebook.template',
              semanticRole: 'notebook.page.template',
              group: 'pages',
              label: 'Page paper',
              value: this.#pager.currentTemplate(),
              options: NOTEBOOK_TEMPLATES.map((template) => ({
                value: template,
                label: NOTEBOOK_PAPER_LABELS[template] ?? template,
              })),
              disabled: pdfBacked,
            },
            {
              kind: 'number',
              id: 'notebook.go-to-page',
              semanticRole: 'notebook.page.jump',
              group: 'pages',
              label: 'Go to page',
              value: pageCount === 0 ? 0 : pageIndex + 1,
              min: 1,
              max: Math.max(1, pageCount),
              step: 1,
              disabled: pageCount === 0,
            },
            {
              kind: 'number',
              id: 'notebook.paper-spacing',
              semanticRole: 'notebook.paper.spacing',
              group: 'pages',
              label: 'Rule spacing',
              value:
                paper?.spacing ?? defaultPaperSpacingForTemplate(templateId),
              min: PAPER_SPACING_MIN,
              max: PAPER_SPACING_MAX,
              step: 1,
              suffix: 'px',
              disabled: pdfBacked || pageCount === 0,
            },
            {
              kind: 'color',
              id: 'notebook.paper-color',
              semanticRole: 'notebook.paper.color',
              group: 'pages',
              label: 'Paper color',
              value: paper?.paperColor ?? '#ffffff',
              options: [...NOTEBOOK_PAPER_COLORS],
              disabled: pdfBacked || pageCount === 0,
            },
            {
              kind: 'button',
              id: 'notebook.paper-reset',
              semanticRole: 'notebook.paper.reset',
              group: 'pages',
              label: 'Reset paper',
              shortLabel: 'Reset paper',
              disabled: pdfBacked || paper === undefined,
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
              disabled: pageCount === 0,
            },
            {
              kind: 'button',
              id: 'notebook.delete',
              semanticRole: 'notebook.page.delete',
              group: 'pages',
              label: 'Delete page',
              shortLabel: 'Delete',
              disabled: pageCount <= 1,
            },
            {
              kind: 'button',
              id: 'notebook.ruler',
              group: 'view',
              label: rulerVisible ? 'Hide ruler' : 'Show ruler',
              shortLabel: 'Ruler',
              active: rulerVisible,
              disabled: pageCount === 0,
            },
            {
              kind: 'number',
              id: 'notebook.ruler-angle',
              group: 'view',
              label: 'Ruler angle',
              value:
                ruler === null ? 0 : Math.round((ruler.angle * 180) / Math.PI),
              min: -90,
              max: 90,
              step: 1,
              suffix: '°',
              disabled: !rulerVisible,
            },
            {
              kind: 'button',
              id: 'notebook.ruler-center',
              group: 'view',
              label: 'Center ruler on current page',
              shortLabel: 'Center ruler',
              disabled: pageCount === 0,
            },
            buildSurfaceImageControl(host, {
              prefix: 'notebook',
              icon: 'image',
            }),
            {
              kind: 'button',
              id: 'notebook.insert-pdf-before',
              semanticRole: 'notebook.insert.pdf.before',
              group: 'insert',
              label: 'Insert PDF before current page',
              shortLabel: 'PDF before',
              disabled: !this.#pager.canInsertPdf(),
            },
            {
              kind: 'button',
              id: 'notebook.insert-pdf-after',
              semanticRole: 'notebook.insert.pdf.after',
              group: 'insert',
              label: 'Insert PDF after current page',
              shortLabel: 'PDF after',
              disabled: !this.#pager.canInsertPdf(),
            },
            ...buildSurfaceZoomControls(host, {
              prefix: 'notebook',
              label: 'Notebook zoom',
              sliderLabel: 'Notebook zoom slider',
              resetLabel: (zoom) =>
                `Notebook zoom ${zoom}%, activate to reset to 100%`,
              disabled: zoomDisabled,
            }),
            buildSurfaceFitControl({
              prefix: 'notebook',
              label: 'Fit notebook pages',
              shortLabel: 'Fit',
            }),
            ...(pageSize === null || pdfBacked
              ? []
              : [
                  {
                    kind: 'choice' as const,
                    id: 'notebook.page-size-preset',
                    semanticRole: 'notebook.page.size',
                    group: 'page-size',
                    label: 'Page size',
                    value: sizePreset,
                    options: [
                      ...(
                        Object.keys(
                          NOTEBOOK_PAGE_SIZE_LABELS,
                        ) as (keyof typeof NOTEBOOK_PAGE_SIZE_LABELS)[]
                      ).map((id) => ({
                        value: id as string,
                        label: NOTEBOOK_PAGE_SIZE_LABELS[id] ?? (id as string),
                      })),
                      { value: 'custom', label: 'Custom' },
                    ],
                  },
                  {
                    kind: 'choice' as const,
                    id: 'notebook.orientation',
                    semanticRole: 'notebook.page.orientation',
                    group: 'page-size',
                    label: 'Orientation',
                    value: orientation,
                    options: [
                      { value: 'portrait', label: 'Portrait' },
                      { value: 'landscape', label: 'Landscape' },
                    ],
                  },
                  {
                    kind: 'number' as const,
                    id: 'notebook.page-width',
                    semanticRole: 'notebook.page.width',
                    group: 'page-size',
                    label: 'Page width',
                    value: pageSize.width,
                    min: 64,
                    max: 20_000,
                    step: 1,
                    suffix: 'px',
                  },
                  {
                    kind: 'number' as const,
                    id: 'notebook.page-height',
                    semanticRole: 'notebook.page.height',
                    group: 'page-size',
                    label: 'Page height',
                    value: pageSize.height,
                    min: 64,
                    max: 20_000,
                    step: 1,
                    suffix: 'px',
                  },
                ]),
            buildSurfaceExportControl({
              prefix: 'notebook',
              group: 'export',
              label: 'Export current page as PNG',
              shortLabel: 'Page PNG',
            }),
            buildSurfaceExportControl({
              prefix: 'notebook',
              id: 'export-all',
              group: 'export',
              label: 'Export all pages as PNG',
              shortLabel: 'All PNG',
            }),
            // Second-tap settings (slice 8): active-tool property
            // controls for the popover, served by the pager over the
            // active page. Unplaced by design — the shared UI reunites
            // them with the active tool button.
            ...buildActiveToolSettingsControls(this.#settingsHost(), {
              prefix: 'notebook',
              swatches: NOTEBOOK_INK_COLORS,
              widths: NOTEBOOK_INK_WIDTHS,
            }),
          ],
        };
      },
      execute: (id, value) => {
        if (id === 'notebook.page.preview' && value !== undefined) {
          return this.#requestPreview(value);
        }
        if (id === 'notebook.page.reorder' && value !== undefined) {
          const [sourceId, targetId] = value.split('|');
          const ids = this.#pager.pageSummaries().map((page) => page.id);
          const from = ids.indexOf(sourceId ?? '');
          const to = ids.indexOf(targetId ?? '');
          if (from < 0 || to < 0) return false;
          this.#pager.reorderPage(from, to);
          return true;
        }
        if (id === 'notebook.page.add-before' && value !== undefined) {
          const index = this.#pager
            .pageSummaries()
            .findIndex((page) => page.id === value);
          if (index < 0) return false;
          this.#pager.jumpToPage(index);
          this.#pager.addPage(this.#pager.currentTemplate(), index - 1);
          return true;
        }
        if (id === 'notebook.page.add-after' && value !== undefined) {
          const index = this.#pager
            .pageSummaries()
            .findIndex((page) => page.id === value);
          if (index < 0) return false;
          this.#pager.jumpToPage(index);
          this.#pager.addPage(this.#pager.currentTemplate(), index);
          return true;
        }
        if (id === 'notebook.page.delete-selected' && value !== undefined) {
          const selected = new Set(value.split('|'));
          const indexes = this.#pager
            .pageSummaries()
            .flatMap((page, index) => (selected.has(page.id) ? [index] : []))
            .reverse();
          for (const index of indexes) this.#pager.deletePage(index);
          return indexes.length > 0;
        }
        if (id === 'notebook.page.duplicate-selected' && value !== undefined) {
          const selected = new Set(value.split('|'));
          const indexes = this.#pager
            .pageSummaries()
            .flatMap((page, index) => (selected.has(page.id) ? [index] : []))
            .reverse();
          for (const index of indexes) this.#pager.duplicatePage(index);
          return indexes.length > 0;
        }
        // Second-tap popover actions (slice 8) route before the main
        // toolbar controls.
        if (
          executeSurfaceToolSettingsControl(
            this.#settingsHost(),
            {
              prefix: 'notebook',
              swatches: NOTEBOOK_INK_COLORS,
              widths: NOTEBOOK_INK_WIDTHS,
            },
            id,
            value,
          )
        ) {
          return true;
        }
        if (
          executeSurfaceToolbarControl(
            this.#surfaceHost(),
            {
              prefix: 'notebook',
              tools: NOTEBOOK_DRAW_TOOLS,
              arrangeIdPrefix: 'selection.',
            },
            id,
            value,
          )
        ) {
          return true;
        }
        // Grouped surface-text write path: additive
        // role/appearance mutation onto `froglight.text` via the shared
        // engine (one history gesture for a selection, or the pending
        // creation style when no text is selected).
        // H1/H2 write `role: 'heading'` + H1/H2 size (outline feed: the
        // headings-only extractor consumes `textRoleOf === 'heading'`);
        // Body writes `role: 'body'` leaving size alone; bold/italic toggle
        // additively without normalizing unknowns; align sets verbatim;
        // wrap toggles the fixed default (never measured widths).
        if (id.startsWith('notebook.text.')) {
          return executeNotebookTextControl(this.#pager, id, value);
        }
        if (
          id === 'notebook.source-outline' &&
          value !== undefined &&
          value !== ''
        ) {
          this.#pager.jumpToAddress(value);
          return true;
        }
        if (id === 'notebook.source-select') {
          this.#pager.setSourceInteractionMode('source-select');
          return true;
        }
        if (id === 'notebook.previous') this.#pager.scrollByPages(-1);
        else if (id === 'notebook.next') this.#pager.scrollByPages(1);
        else if (id === 'notebook.go-to-page' && value !== undefined) {
          const target = Number(value);
          if (Number.isFinite(target))
            this.#pager.jumpToPage(Math.trunc(target) - 1);
        } else if (id === 'notebook.template' && value !== undefined)
          this.#pager.setTemplate(this.#pager.currentPageIndex(), value);
        else if (id === 'notebook.paper-spacing' && value !== undefined) {
          const spacing = Number(value);
          if (Number.isFinite(spacing)) {
            const current = this.#pager.paperOptions() ?? {};
            this.#pager.setPaperOptions({ ...current, spacing });
          }
        } else if (id === 'notebook.paper-color' && value !== undefined)
          this.#pager.setPaperOptions({
            ...(this.#pager.paperOptions() ?? {}),
            paperColor: value,
          });
        else if (id === 'notebook.paper-reset')
          this.#pager.setPaperOptions(undefined);
        else if (id === 'notebook.page-size-preset' && value !== undefined) {
          if (value !== 'custom') this.#pager.applyPageSize(value);
        } else if (id === 'notebook.orientation' && value !== undefined) {
          if (value === 'portrait' || value === 'landscape')
            this.#pager.setPageOrientation(value);
        } else if (id === 'notebook.ruler') {
          if (this.#pager.rulerState()?.visible === true)
            this.#pager.setRuler(null);
          else this.#pager.centerRuler();
        } else if (id === 'notebook.ruler-angle' && value !== undefined) {
          const degrees = Number(value);
          const current = this.#pager.rulerState();
          if (Number.isFinite(degrees) && current !== null) {
            this.#pager.setRuler({
              ...current,
              visible: true,
              angle: (degrees * Math.PI) / 180,
            });
          }
        } else if (id === 'notebook.ruler-center') this.#pager.centerRuler();
        else if (id === 'notebook.add')
          this.#pager.addPage(this.#pager.currentTemplate());
        else if (id === 'notebook.duplicate')
          this.#pager.duplicatePage(this.#pager.currentPageIndex());
        else if (id === 'notebook.delete')
          this.#pager.deletePage(this.#pager.currentPageIndex());
        else if (id === 'notebook.insert-pdf-before')
          this.#pager.choosePdf('before');
        else if (id === 'notebook.insert-pdf-after')
          this.#pager.choosePdf('after');
        else if (id === 'notebook.page-width' && value !== undefined) {
          const size = this.#pager.currentPageSize();
          if (size !== null)
            this.#pager.resizeCurrentPage(Number(value), size.height);
        } else if (id === 'notebook.page-height' && value !== undefined) {
          const size = this.#pager.currentPageSize();
          if (size !== null)
            this.#pager.resizeCurrentPage(size.width, Number(value));
        } else if (id === 'notebook.export') this.#pager.exportCurrentPagePng();
        else if (id === 'notebook.export-all') this.#pager.exportNotebookPng();
        else return false;
        return true;
      },
      onDidChange: (listener) => {
        const pager = this.#pager.onDidChange(listener);
        this.#previewListeners.add(listener);
        return {
          dispose: () => {
            pager.dispose();
            this.#previewListeners.delete(listener);
          },
        };
      },
    };
  }

  /**
   * Bridges the pager to the shared surface toolbar builder. Tool selection
   * keeps the PDF source-select policy; fit maps to the pager zoom reset.
   */
  #surfaceHost(): SurfaceToolbarHost {
    return {
      activeToolId: () => this.#pager.activeToolId(),
      // Settled-first: the pager has no temporary seam, so
      // settled equals live; forwarded for family-uniform reconciliation.
      settledActiveToolId: () =>
        this.#pager.settledActiveToolId?.() ?? this.#pager.activeToolId(),
      setTool: (toolId) => {
        if (
          toolId === PAGE_TOOL_IDS.select &&
          this.#pager.currentBaseKind() === 'pdf-page'
        ) {
          this.#pager.setSourceInteractionMode('source-select');
        } else {
          this.#pager.setTool(toolId);
        }
      },
      penColor: () => this.#pager.penColor(),
      setPenColor: (color) => this.#pager.setPenColor(color),
      penWidth: () => this.#pager.penWidth(),
      setPenWidth: (width) => this.#pager.setPenWidth(width),
      toolPreset: (tool) => this.#pager.toolPreset(tool),
      setToolPreset: (tool, patch) => this.#pager.setToolPreset(tool, patch),
      selectionIds: () => this.#pager.selectionIds(),
      selectionContext: () => this.#pager.selectionContext(),
      moveSelectionBy: (delta) => this.#pager.moveSelectionBy(delta),
      scaleSelection: (factor) => this.#pager.scaleSelection(factor),
      rotateSelection: (deltaRadians) =>
        this.#pager.rotateSelection(deltaRadians),
      setSelectionStyle: (style) => this.#pager.setSelectionStyle(style),
      alignSelection: (edge) => this.#pager.alignSelection(edge),
      distributeSelection: (axis) => this.#pager.distributeSelection(axis),
      reorderSelection: (where) => this.#pager.reorderSelection(where),
      setLocked: (ids, locked) => this.#pager.setLocked(ids, locked),
      groupSelection: () => this.#pager.groupSelection(),
      ungroupSelection: () => this.#pager.ungroupSelection(),
      duplicateSelection: () => this.#pager.duplicateSelection(),
      deleteSelection: () => this.#pager.deleteSelection(),
      connectSelected: () => this.#pager.connectSelected(),
      eraserRadius: () => this.#pager.eraserRadius(),
      setEraserRadius: (radius) => this.#pager.setEraserRadius(radius),
      eraserMode: () => this.#pager.eraserMode(),
      setEraserMode: (mode) => this.#pager.setEraserMode(mode),
      zoomFactor: () => this.#pager.zoomFactor(),
      setZoomFactor: (zoom) => this.#pager.setZoomFactor(zoom),
      canInsertImage: () => this.#pager.canInsertImage(),
      chooseImage: () => this.#pager.chooseImage(),
      fitToView: () => this.#pager.zoomReset(),
    };
  }

  /**
   * Bridges the pager to the slice 8 settings schema. The type selector
   * only produces pen-family engine ids, so the PDF source-select policy
   * never triggers here — plain pager tool selection applies.
   */
  #settingsHost(): SurfaceToolSettingsHost {
    return {
      activeToolId: () => this.#pager.activeToolId(),
      // Settled-first: the pager has no
      // temporary seam, so settled equals live; forwarded for
      // family-uniform schema selection.
      settledActiveToolId: () =>
        this.#pager.settledActiveToolId?.() ?? this.#pager.activeToolId(),
      setTool: (toolId) => this.#pager.setTool(toolId),
      toolPreset: (tool) => this.#pager.toolPreset(tool),
      setToolPreset: (tool, patch) => this.#pager.setToolPreset(tool, patch),
      savedStyles: (tool) => this.#pager.savedStyles(tool),
      currentStyleId: (tool) => this.#pager.currentStyleId(tool),
      saveCurrentStyle: (tool, name) =>
        this.#pager.saveCurrentStyle(tool, name),
      applySavedStyle: (id) => this.#pager.applySavedStyle(id),
      updateSavedStyle: (id) => this.#pager.updateSavedStyle(id),
      renameSavedStyle: (id, name) => this.#pager.renameSavedStyle(id, name),
      favoriteSavedStyle: (id, favorite) =>
        this.#pager.favoriteSavedStyle(id, favorite),
      reorderSavedStyles: (tool, ids) =>
        this.#pager.reorderSavedStyles(tool, ids),
      deleteSavedStyle: (id) => this.#pager.deleteSavedStyle(id),
      resetSavedStyle: (tool) => this.#pager.resetSavedStyle(tool),
      savedStyleModified: (tool) => this.#pager.savedStyleModified(tool),
      cornerRadius: () => this.#pager.cornerRadius(),
      setCornerRadius: value => this.#pager.setCornerRadius(value),
      shapeAppearance: () => this.#pager.shapeAppearance(),
      setShapeAppearance: (value) => this.#pager.setShapeAppearance(value),
      lineArrows: () => this.#pager.lineArrows(),
      setLineArrows: (arrows) => this.#pager.setLineArrows(arrows),
      eraserPreset: () => this.#pager.eraserPreset(),
      setEraserPreset: (patch) => this.#pager.setEraserPreset(patch),
      lassoPreset: () => this.#pager.lassoPreset(),
      setLassoPreset: (patch) => this.#pager.setLassoPreset(patch),
      recentColors: () => this.#pager.recentColors(),
      gestures: () => this.#pager.gestures(),
      setGestures: (patch) => this.#pager.setGestures(patch),
    };
  }

  focus(): void {
    this.#requireAlive();
    (
      this.#pager.root.querySelector('.fl-nb-scroll') as HTMLElement | null
    )?.focus();
  }

  hasFocus(): boolean {
    return !this.#destroyed && this.#pager.root.isConnected;
  }

  setReadOnly(readOnly: boolean): void {
    this.#requireAlive();
    this.#pager.setReadOnly(readOnly);
  }

  canExecCommand(id: 'undo' | 'redo'): boolean {
    return id === 'undo' ? this.#pager.canUndo() : this.#pager.canRedo();
  }

  execCommand(id: 'undo' | 'redo'): boolean {
    this.#requireAlive();
    return id === 'undo' ? this.#pager.undo() : this.#pager.redo();
  }

  flush(): void {
    this.#requireAlive();
    this.#pager.flush();
  }

  revealAddress(address: string): void {
    this.#requireAlive();
    this.#pager.jumpToAddress(address);
  }

  renderPageImage(
    address: string,
    dpi: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    this.#requireAlive();
    return this.#pager.renderPageImage(address, dpi, signal);
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#previewAbort.abort();
    this.#previewListeners.clear();
    this.#previews.clear();
    // Unmount first so React cleanly removes the chrome it owns; the
    // engine teardown below then runs against detached nodes (its own
    // root.remove() becomes a harmless no-op). Reversing the order yanks
    // React-managed DOM out from under the root and corrupts teardown.
    this.#root.unmount();
    this.#pager.destroy();
  }

  /** Test-only selection writer (never used by production UI). */
  setSelectionForTest(ids: readonly string[]): void {
    this.#requireAlive();
    this.#pager.setSelection(ids);
  }

  #requireAlive(): void {
    if (this.#destroyed) throw new Error('notebook editor handle is destroyed');
  }
}

export interface NotebookDocumentEditorDeps {
  /** Lazy asset-store resolution; vaults bind after provider construction. */
  readonly assets?: () => DocumentAssetStore | null;
  readonly pdfProvider?: () => PdfProvider | null;
  /** Lazy application settings for shared tool presets.*/
  readonly presetSettings?: () => SettingsService | null;
  readonly openExternalLink?: (url: string) => void | Promise<void>;
  readonly selectPdfPages?: () => Promise<readonly number[] | undefined | null>;
  readonly promptForPdfPassword?: (
    reason: 'required' | 'incorrect',
  ) => Promise<string | null>;
  /**
   * Host-owned durable derived-cache storage (Tauri cache dir / OPFS /
   * in-memory in tests). Absent keeps the provider memory-only.
   */
  readonly derivedCacheStorage?: DerivedCacheStoragePort | null;
}

export class NotebookDocumentEditorProvider implements DocumentEditorProvider {
  readonly id = 'notebook';
  readonly kindIds = [NOTEBOOK_KIND_ID] as const;

  readonly #deps: NotebookDocumentEditorDeps;
  /**
   * Derived reopen cache pool: spans opens from this provider
   * instance so a document reopen reuses validated bounds/geometry.
   * Bounded, revision-keyed, dirty-gated, and backed by host-owned
   * durable storage when supplied; never authoritative.
   */
  readonly #reopen: DerivedReopenStore;

  constructor(deps: NotebookDocumentEditorDeps = {}) {
    this.#deps = deps;
    this.#reopen = new DerivedReopenStore(
      undefined,
      deps.derivedCacheStorage ?? null,
      { createPacker: createDerivedCachePackWorker },
    );
  }

  createEditor(input: NotebookEditorInput): DocumentEditorHandle {
    const session = input.session as SessionBridge;
    const parentOk =
      typeof input.parent === 'object' &&
      input.parent !== null &&
      typeof (input.parent as HTMLElement).appendChild === 'function';
    if (!hasCanvas2d() || !parentOk) {
      return new HeadlessNotebookEditorHandle(session);
    }
    let assets: DocumentAssetStore | null = input.assets ?? null;
    let pdfProvider: PdfProvider | null = input.pdfProvider ?? null;
    let presetSettings: SettingsService | null = input.presetSettings ?? null;
    if (assets === null) {
      try {
        assets = this.#deps.assets?.() ?? null;
      } catch {
        assets = null;
      }
    }
    if (pdfProvider === null) {
      try {
        pdfProvider = this.#deps.pdfProvider?.() ?? null;
      } catch {
        pdfProvider = null;
      }
    }
    if (presetSettings === null) {
      try {
        presetSettings = this.#deps.presetSettings?.() ?? null;
      } catch {
        presetSettings = null;
      }
    }
    return new NotebookCanvasEditorHandle(
      session,
      input.parent as HTMLElement,
      assets,
      pdfProvider,
      input.importPdf ?? null,
      this.#deps.openExternalLink,
      this.#deps.selectPdfPages,
      this.#deps.promptForPdfPassword,
      presetSettings,
      // Derived reopen cache: document identity scopes cache
      // entries; absent without a real session (fakes fall back to seeds).
      // Live revision/dirty accessors keep the cache tied to the saved
      // bytes across save/reopen within the same provider lifetime.
      typeof session.document?.documentId === 'string' &&
      session.document.documentId.length > 0
        ? {
            store: this.#reopen,
            documentId: session.document.documentId,
            getContentRevision: () => session.contentRevision ?? null,
            isDirty: () => session.dirty === true,
          }
        : null,
      input.stylusInput,
    );
  }
}
