/**
 * Notebook-specific editor provider seam.
 *
 * Canonical plain-data model values cross this boundary; the editor
 * mutates the session model in place and signals dirtiness, exactly like
 * the ink seam. Canvas/DOM types never cross this contract — `parent` is
 * opaque host UI.
 */

import type { DocumentSession } from '../session.js';
import type { DocumentEditorHandle } from './registry.js';
import type { NotebookModel } from '../notebooks/model.js';
import type { DocumentAssetStore } from '../assets.js';
import type { PdfProvider } from '../pdf/contracts.js';
import type { SettingsService } from '../settings.js';
import type { StylusInputPolicy } from '../stylus/contract.js';

export interface NotebookEditorHandle extends DocumentEditorHandle {
  /** Model accessor for deterministic tests (not part of production UI). */
  getModelForTest?(): NotebookModel;
}

/** One canonical request shape shared by every notebook editor provider. */
export interface NotebookEditorInput {
  readonly session: DocumentSession<NotebookModel>;
  readonly parent: unknown;
  readonly stylusInput?: StylusInputPolicy;
  /** Asset ingestion for image placement; absent in headless hosts. */
  readonly assets?: DocumentAssetStore;
  /**
   * Application settings backing for per-tool presets (repair pass item
   * 7): pages sharing one service share user defaults — selected Pen
   * subtype, colors, sizes, brush tuning, eraser/lasso — across page
   * changes, close/reopen, and restart. Absent keeps memory-only presets.
   */
  readonly presetSettings?: SettingsService;
  /** Immutable PDF page-base rendering/extraction; absent yields placeholders. */
  readonly pdfProvider?: PdfProvider;
  /** Application-owned atomic PDF insertion operation. */
  readonly importPdf?: (
    notebook: NotebookModel,
    bytes: Uint8Array,
    at: number,
    selectedPageIndexes?: readonly number[],
    password?: string,
  ) => Promise<void>;
}

export interface NotebookEditorProvider {
  createEditor(input: NotebookEditorInput): NotebookEditorHandle;
}
