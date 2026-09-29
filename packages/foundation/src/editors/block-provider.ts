/**
 * Block-page-specific editor provider seam.
 *
 * Canonical plain-data model values cross this boundary; Tiptap/
 * ProseMirror types never do. The application workbench resolves the
 * generic DocumentEditorProvider by DocumentKindId and adapts it onto
 * this seam, exactly as for Markdown.
 */

import type { DocumentSession } from '../session.js';
import type { DocumentEditorHandle } from './registry.js';
import type { BlockPageModel } from '../blocks/model.js';
import type { BlockRegistry } from '../blocks/registry.js';
import type {
  CompositionRegistry,
  CompositionPresenter,
  ResourceResolver,
} from '../composition.js';
import type { ResourceTarget } from '../blocks/model.js';

export interface BlockPageEditorHandle extends DocumentEditorHandle {
  /** Refresh document metadata after a native property mutation. */
  applyDocumentMetadata?(meta: BlockPageModel['meta']): void;
  /** Model accessor for deterministic tests (not part of production UI). */
  getModelForTest?(): BlockPageModel;
  /**
   * Provider-specific structured command channel (interaction
   * set: indent/outdent/move-block/turn-into/insert-block/collapse).
   * Plain-data arguments only; undo/redo stay on execCommand.
   */
  blockCommand?(id: string, arg?: unknown): boolean;
}

/** One canonical request shape shared by every block-page editor provider. */
export interface BlockPageEditorInput {
  readonly session: DocumentSession<BlockPageModel>;
  readonly parent: unknown;
  readonly initialModel: BlockPageModel;
  readonly onDirtyModel: (model: BlockPageModel) => void;
  /** Trusted-tier registry feeding slash-menu inserters. */
  readonly blockRegistry?: BlockRegistry;
  /** Stable workspace-resource discovery for `[[` / `@` insertion. */
  readonly resourceResolver?: ResourceResolver;
  /** Provider-neutral preview/transclusion/linked-view rendering seam. */
  readonly compositionRegistry?: CompositionRegistry;
  readonly compositionPresenter?: CompositionPresenter;
  /** Workspace navigation for inline mentions and resource-link blocks. */
  readonly openResource?: (target: ResourceTarget) => void;
}

export interface BlockPageEditorProvider {
  /**
   * Create an editor instance bound to a block page session. The provider
   * translates editing into `onDirtyModel` carrying a fresh canonical
   * model value. `parent` is opaque host UI.
   */
  createEditor(input: BlockPageEditorInput): BlockPageEditorHandle;
}
