/**
 * The workspace shell's DOM event contract: every custom event name the
 * shell exchanges with sidebar views and editor providers, with their typed
 * detail shapes. Dispatchers and listeners must use these constants — the
 * string literals appear nowhere else.
 */

export const workspaceEvents = {
  /** Open a document in the target pane. */
  open: 'froglight:open',
  /** Open a registered view in the focused pane. */
  openView: 'froglight:open-view',
  /** Open a document or view in an idle pane (else split right). */
  openBackground: 'froglight:open-background',
  /** Resolve a wiki-link destination. */
  openLink: 'froglight:open-link',
  /** Preview a raw (non-document) vault file by path. */
  openPreview: 'froglight:open-preview',
  /** Import an external PDF as a notebook. */
  importPdf: 'froglight:import-pdf',
  /** Open the settings modal. */
  openSettings: 'froglight:open-settings',
  /** Open workspace search from a sidebar or another workspace surface. */
  openSearch: 'froglight:open-search',
  /** Publish the focused pane's active document to sidebar views. */
  activeDocument: 'froglight:active-document',
  /** A raw file moved from one vault path to another. */
  previewMoved: 'froglight:preview-moved',
  /** A raw file was deleted from the vault. */
  previewDeleted: 'froglight:preview-deleted',
  /**
   * Canonical documents were deleted outside the workbench controller (the
   * file-explorer service removes workspace bytes directly). The shell
   * prunes dangling tabs; the payload carries ids when known (single-file
   * deletes) and is empty for folder deletes where the shell diffs instead.
   */
  documentsDeleted: 'froglight:documents-deleted',
} as const;

export type WorkspaceEventName =
  (typeof workspaceEvents)[keyof typeof workspaceEvents];

export interface OpenEventDetail {
  readonly documentId: string;
  readonly address?: string;
}

export interface OpenBackgroundEventDetail {
  readonly documentId?: string;
  readonly viewId?: string;
  readonly address?: string;
}

export interface OpenViewEventDetail {
  readonly viewId: string;
}

export interface OpenLinkEventDetail {
  readonly destination: string;
}

export interface OpenPreviewEventDetail {
  readonly path: string;
}

export interface ImportPdfEventDetail {
  readonly name: string;
  readonly bytes: Uint8Array;
}

export interface ActiveDocumentEventDetail {
  readonly documentId?: string | null;
  /** Vault path of the active raw-file preview (non-document files). */
  readonly previewPath?: string | null;
  readonly reveal?: boolean;
}

export interface PreviewMovedEventDetail {
  readonly from: string;
  readonly to: string;
}

export interface PreviewDeletedEventDetail {
  readonly path: string;
}

export interface DocumentsDeletedEventDetail {
  readonly documentIds?: readonly string[];
  readonly folder?: string;
}

/** Extract the typed detail of a workspace event, or null for foreign events. */
export function workspaceEventDetail<T>(event: Event): T | null {
  return event instanceof CustomEvent
    ? ((event.detail ?? null) as T | null)
    : null;
}
