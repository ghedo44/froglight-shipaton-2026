/**
 * Document sidebar context adapter.
 *
 * A plain adapter, not a hook: it produces the plain focused-document
 * context plus portable actions that panels receive. Address reveals,
 * Markdown print projection, and notebook export all delegate to the
 * `actions/rightSidebarActions` adapters — no DOM traversal and no
 * per-kind branching. The optional `text` projection is part of the
 * designed `RightSidebarContext` interface panels filter on.
 *
 */

import { useEffect } from 'react';
import type { PaneView, WorkbenchDocumentView } from '../../../workbench.js';
import type {
  WorkbenchImportExportPort,
  WorkbenchEditorToolsPort,
  WorkbenchReadingPort,
} from '../../../workbench-ports.js';
import { projectDocumentInspector } from '../../../document-inspector.js';
import type {
  NotebookPdfExportOptions,
  PdfExportOptions,
  RightSidebarContext,
  RightSidebarOutlineEntry,
} from '../../../right-sidebar-registry.js';
import { printMarkdownPdf } from '../../../pdf-export.js';
import {
  downloadExportedFile,
  requestMarkdownPrint,
  requestNotebookExport,
  revealDocumentAddress,
} from '../actions/rightSidebarActions.js';
import type { Notify } from './useToast.js';

/** One plain outline row as produced by an outline registry. */
export interface SidebarOutlineRowLike {
  readonly id: string;
  readonly address: string;
  readonly level: number;
  readonly label: string;
}

/**
 * Structural outline-registry contract, owned by the workbench.
 *
 * Mirrors `OutlineRegistry.getOutline` / `invalidate` without importing
 * `@froglight/application`: `kindId` passes through verbatim (no per-kind
 * UI fork), `model` is opaque plain data, `revision` compares with `===`
 * and returns the same frozen row reference on a hit, `documentIdentity`
 * scopes the slot to one document. `getOutline` throws a structured error
 * with `code === 'UNKNOWN_OUTLINE_KIND'` when the kind is absent; the
 * adapter treats that as an unsupported outline (tab hidden) without
 * logging, while any other extractor error is warned (see builder).
 *
 * Shell callers pass a document identity. Structured models supply their
 * session revision; text projections let the registry derive a content key.
 * Rows are frozen; the registry never mutates caller-owned models.
 */
export interface SidebarOutlineRegistryLike {
  supports?(kindId: string): boolean;
  getOutline(
    kindId: string,
    model: unknown,
    revision?: string | number,
    input?: { readonly documentIdentity?: string },
  ): readonly SidebarOutlineRowLike[];
  invalidate(kindId?: string, documentIdentity?: string): void;
}

/**
 * Translated ui-local entries, cached by registry-row reference.
 *
 * The registry returns the same frozen array reference on a revision
 * hit; translating 1:1 through this WeakMap preserves that stability so
 * the panel memo skips rebuilds across keystrokes at a stable revision.
 * Translated rows are frozen plain `{ id, address, level, label }` data —
 * never mutated by the panel.
 */
const translatedOutlineCache = new WeakMap<
  readonly SidebarOutlineRowLike[],
  readonly RightSidebarOutlineEntry[]
>();

function translateOutlineRows(
  rows: readonly SidebarOutlineRowLike[],
): readonly RightSidebarOutlineEntry[] {
  const cached = translatedOutlineCache.get(rows);
  if (cached !== undefined) return cached;
  const translated = Object.freeze(
    rows.map((row) =>
      Object.freeze({
        id: row.id,
        address: row.address,
        level: row.level,
        label: row.label,
      }),
    ),
  ) as readonly RightSidebarOutlineEntry[];
  translatedOutlineCache.set(rows, translated);
  return translated;
}

function errorCodeOf(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

/**
 * Effect-owned outline invalidation. The panel owns this lifecycle.
 *
 * Call from the shell with the focused kind + document identity: when the
 * focused document changes or the shell unmounts, the previous document's
 * slot is dropped so closed documents do not linger in the bounded cache.
 * Fail-closed: invalidation never throws into the shell.
 */
export function useSidebarOutlineInvalidation(
  registry: SidebarOutlineRegistryLike | null | undefined,
  kindId: string | null,
  documentIdentity: string | null,
): void {
  useEffect(() => {
    if (registry === null || registry === undefined) return;
    if (kindId === null || documentIdentity === null) return;
    if (kindId === '' || documentIdentity === '') return;
    const capturedKind = kindId;
    const capturedIdentity = documentIdentity;
    return () => {
      try {
        registry.invalidate(capturedKind, capturedIdentity);
      } catch {
        // Invalidation is best-effort cache hygiene; never break unmount.
      }
    };
  }, [registry, kindId, documentIdentity]);
}

export function buildRightSidebarContext(input: {
  readonly reading: WorkbenchReadingPort;
  readonly pdf: WorkbenchImportExportPort;
  readonly tools?: WorkbenchEditorToolsPort;
  readonly focusedPane: string;
  readonly openDocument: RightSidebarContext['openDocument'];
  readonly focusedState: PaneView;
  readonly focusedDocument: WorkbenchDocumentView | null;
  readonly notify: Notify;
  /**
   * Structural outline registry (compatible, shell-owned).
   *
   * The shell uses the workbench-owned registry; `undefined`/`null` disables outlines.
   * The builder never creates or caches a registry itself, so
   * direct callers and the shell share one path with no module-singleton
   * funnel. `getOutline` is a bounded cache read; the builder never calls
   * `invalidate` during render (effect-owned via
   * `useSidebarOutlineInvalidation`).
   */
  readonly outlineRegistry?: SidebarOutlineRegistryLike | null;
  /**
   * Explicit outline model for the focused document. When `undefined` the
   * adapter derives the model from the pane text projection (`string` for
   * Markdown-like families, `null` otherwise); pass a structured model
   * (block/notebook/...) to outline non-text families through the same
   * generic path with no per-kind UI fork.
   */
  readonly outlineModel?: unknown;
  /** Content revision key for the outline cache; compared with `===`. */
  readonly outlineRevision?: string | number;
  /** Stable document identity scoping the cache slot; defaults to documentId. */
  readonly outlineDocumentIdentity?: string;
}): RightSidebarContext | null {
  const {
    reading,
    pdf,
    focusedPane,
    focusedState,
    focusedDocument,
    notify,
    outlineRegistry,
    outlineModel,
    outlineRevision,
    outlineDocumentIdentity,
  } = input;

  if (focusedState.documentId === null || focusedDocument === null) {
    return null;
  }
  const documentId = focusedState.documentId;
  const kindId = focusedDocument.kindId ?? '';
  const text = reading.getPaneText(focusedPane);
  const toolSnapshot = input.tools?.editorToolSnapshot(focusedPane) ?? null;
  const inspector = projectDocumentInspector(toolSnapshot);
  const pngExport = toolSnapshot?.controls.find(
    (control) => control.semanticRole === 'ink.canvas.export',
  );
  const documentIdentity =
    outlineDocumentIdentity === undefined || outlineDocumentIdentity === ''
      ? documentId
      : outlineDocumentIdentity;
  // `undefined` means "derive from text"; any other value (including null)
  // is an explicit model override for structured families.
  const hasExplicitModel = 'outlineModel' in input;
  const effectiveModel: unknown = hasExplicitModel ? outlineModel : text;

  let outline: readonly RightSidebarOutlineEntry[] | null = null;
  // text-derived outlines (no explicit `outlineModel`) are keyed
  // by content, never by the global shell revision. Passing the shell
  // counter as the revision would recompute on every background-document
  // bump; omitting it lets the registry fall back to `stableKeyOf(text)`,
  // so only a text change recomputes while background bumps hit.
  const textDerivedRevision: string | number | undefined = hasExplicitModel
    ? outlineRevision
    : undefined;
  let effectiveRevision: string | number | undefined = textDerivedRevision;
  const registry = outlineRegistry;
  const registryDisabled = registry === null || registry === undefined;
  let outlineSupported =
    !registryDisabled && kindId !== '' && registry.supports?.(kindId) === true;
  if (
    !registryDisabled &&
    effectiveModel !== null &&
    effectiveModel !== undefined &&
    kindId !== ''
  ) {
    try {
      const rows = (registry as SidebarOutlineRegistryLike).getOutline(
        kindId,
        effectiveModel,
        textDerivedRevision,
        {
          documentIdentity,
        },
      );
      outline = translateOutlineRows(rows);
      outlineSupported = true;
      effectiveRevision = textDerivedRevision;
    } catch (error) {
      if (errorCodeOf(error) === 'UNKNOWN_OUTLINE_KIND') {
        // Unknown kinds fail closed silently (tab hidden): an absent
        // extractor is an expected routing outcome, not a fault.
        outline = null;
        effectiveRevision = undefined;
      } else {
        // Unexpected extractor failures also fail closed so one bad
        // provider never breaks the shell, but stay visible for diagnosis
        // (never swallowed identically to unknown kinds).
        console.warn(
          `[right-sidebar-context] outline extractor failed for kind "${kindId}":`,
          error,
        );
        outline = null;
        effectiveRevision = undefined;
      }
    }
  }
  return {
    pane: focusedPane,
    documentId,
    kindId,
    title: focusedState.title ?? focusedDocument.title,
    path: focusedState.path ?? focusedDocument.path,
    mode: focusedState.mode,
    availableModes: reading.availableTabModes(
      focusedPane,
      focusedState.activeTab ?? undefined,
    ),
    dirty: focusedState.dirty,
    text,
    inspector,
    executeInspectorControl(id, value) {
      void input.tools?.executeEditorTool(focusedPane, id, value);
    },
    ...(pngExport !== undefined
      ? {
          exportPng() {
            void input.tools?.executeEditorTool(focusedPane, pngExport.id);
          },
        }
      : {}),
    outlineSupported,
    ...(outline !== null ? { outline } : {}),
    ...(outline !== null && effectiveRevision !== undefined
      ? { outlineRevision: effectiveRevision }
      : {}),
    openDocument: input.openDocument,
    revealAddress(address) {
      revealDocumentAddress(reading, focusedPane, address);
    },
    setMode(mode) {
      if (focusedState.activeTab === null) return;
      reading.setTabMode(focusedPane, focusedState.activeTab, mode);
    },
    exportPdf(options: PdfExportOptions) {
      const outcome = requestMarkdownPrint({
        title: focusedState.title ?? focusedDocument.title,
        markdown: reading.getPaneText(focusedPane),
        options,
        print: printMarkdownPdf,
      });
      if (outcome.ok) return;
      if (outcome.reason === 'unavailable') {
        notify('PDF export is unavailable for this document type', 'error');
      } else {
        notify(`PDF export failed: ${outcome.reason}`, 'error');
      }
    },
    exportNotebookPdf(options: NotebookPdfExportOptions) {
      if (pdf.exportNotebookPdf === undefined) {
        notify('Notebook PDF export is unavailable in this profile', 'error');
        return;
      }
      const exportPdf = pdf.exportNotebookPdf.bind(pdf);
      void requestNotebookExport({
        exportPdf,
        pane: focusedPane,
        options,
      }).then((outcome) => {
        if (!outcome.ok) {
          if (outcome.reason === 'unavailable') {
            notify(
              'Notebook PDF export is unavailable in this profile',
              'error',
            );
          } else {
            notify(`Notebook PDF export failed: ${outcome.reason}`, 'error');
          }
          return;
        }
        const { result } = outcome;
        downloadExportedFile(result);
        if (result.warnings.length === 0) notify('Notebook PDF exported');
        else
          notify(
            `Notebook PDF exported with ${result.warnings.length} fidelity warning${result.warnings.length === 1 ? '' : 's'}`,
          );
      });
    },
  };
}
