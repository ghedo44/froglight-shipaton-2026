import type { DocumentPresentationMode, DocumentRecoveryWarning } from '@froglight/foundation';

/**
 * Pure workbench view contracts.
 *
 * Presentation snapshots owned by the shell — no runtime, no React, no
 * editor internals. Extracted from `workbench.ts` without behavior change
 * so the composer stays thin and these contracts remain substitutable.
 * `workbench.ts` re-exports these contracts as the public UI entry point.
 */

export interface WorkbenchDocumentView {
  readonly documentId: string;
  readonly kindId?: string;
  readonly path: string;
  readonly title: string;
}

/**
 * Optional structured outline model on a document view.
 *
 * Narrow optional structural port for the shell outline seam: a document
 * view may carry an opaque plain-data outline model under `outlineModel`
 * (preferred) or `model` (legacy). The shell reads it through this port —
 * never via ad-hoc duck-typing — and forwards it verbatim to the
 * outline registry. Absent means "derive from the pane text projection".
 */
export interface WorkbenchOutlineDocumentLike extends WorkbenchDocumentView {
  readonly outlineModel?: unknown;
  readonly model?: unknown;
}

/** One plain outline row as produced by an outline registry. */
export interface WorkbenchOutlineRowLike {
  readonly id: string;
  readonly address: string;
  readonly level: number;
  readonly label: string;
}

/**
 * Structural outline-registry contract (UI-owned, compatible).
 *
 * Satisfied structurally without importing `@froglight/application`:
 * `kindId` passes through verbatim (no per-kind UI fork), `model` is
 * opaque plain data, `revision` compares with `===` and returns the same
 * frozen row reference on a hit, `documentIdentity` scopes the slot to one
 * document. `getOutline` throws a structured error with
 * `code === 'UNKNOWN_OUTLINE_KIND'` when the kind is absent.
 *
 * The workbench owns extraction and caching. Shell callers pass a stable
 * document identity; the registry derives a content key when no revision
 * is available for a text projection.
 */
export interface WorkbenchOutlineRegistryLike {
  getOutline(
    kindId: string,
    model: unknown,
    revision?: string | number,
    input?: { readonly documentIdentity?: string },
  ): readonly WorkbenchOutlineRowLike[];
  invalidate(kindId?: string, documentIdentity?: string): void;
}

/**
 * Narrow optional outline-provider seam on the workbench controller
 *
 *
 * Read through this port — never via inline `as unknown as {...}`
 * duck-types — so the seam stays declared and substitutable. An injected
 * `outlineRegistry` is supplied by the workbench controller. `getOutlineModel` is an
 * interim seam returning either a raw plain-data model or a
 * `{ model, revision }` wrapper for the focused document; a missing or
 * throwing provider means "no structured model".
 */
export interface WorkbenchOutlineProviderLike {
  readonly outlineRegistry?: WorkbenchOutlineRegistryLike;
  getOutlineModel?: (
    documentId: string,
  ) =>
    | { readonly model: unknown; readonly revision?: string | number }
    | unknown;
}

export interface WorkbenchStateView {
  readonly activeDocumentId: string | null;
  readonly activeDocumentTitle: string | null;
  readonly activeDocumentPath: string | null;
  readonly dirty: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

/** Edit/reading presentation of one tab. */
export type PaneModeView = DocumentPresentationMode;

/** One tab in a pane's strip: a document or a workspace view instance. */
export interface DockTabView {
  readonly id: string;
  readonly kind: 'document' | 'view';
  readonly documentId: string | null;
  readonly viewId: string | null;
  /** Transient session state, including inactive tabs with pending saves. */
  readonly dirty?: boolean;
  readonly saveError?: boolean;
  readonly saveStatus?: string;
}

/** Snapshot of one pane: its tab strip, active tab, and live session state. */
export interface PaneView {
  readonly pane: string;
  readonly tabs: readonly DockTabView[];
  readonly activeTab: string | null;
  /** Presentation mode of the active tab. */
  readonly mode: PaneModeView;
  readonly documentId: string | null;
  readonly viewId: string | null;
  readonly title: string | null;
  readonly path: string | null;
  readonly dirty: boolean;
  readonly recoveryWarnings: readonly DocumentRecoveryWarning[];
  readonly editorAvailable?: boolean;
  /** True while the active document's required editor is being attached. */
  readonly editorLoading?: boolean;
  /** This pane's own history trail (per-pane back/forward). */
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

export interface OpenLinkResultView {
  readonly created: boolean;
  readonly documentId: string;
}

/** Target of a tab move: an existing pane, or a fresh split beside one. */
export type DockMoveTargetView =
  | { readonly kind: 'pane'; readonly pane: string; readonly index?: number }
  | {
      readonly kind: 'split';
      readonly pane: string;
      readonly direction: 'right' | 'down' | 'left' | 'up';
    };
