/**
 * Markdown-specific editor provider seam.
 *
 * This is an adapter-level contract for Markdown editors. The application
 * workbench resolves the generic DocumentEditorProvider by DocumentKindId;
 * the Markdown adapter translates that generic request into this string-only
 * seam so CodeMirror details never escape the provider package.
 */

import type { DocumentSession } from '../session.js';
import type { ResourceResolver } from '../composition.js';
import type { DocumentEditorHandle } from './registry.js';

export interface MarkdownEditorHandle extends DocumentEditorHandle {
  /** Apply a canonical model edit to visible source through editor history. */
  replaceAll?(next: string): void;
  /** Text accessor for deterministic tests (not part of production UI). */
  getTextForTest?(): string;
}

export interface MarkdownEditorProvider {
  /**
   * Create an editor instance bound to a Markdown session.
   * The provider translates editor changes into `onDirtyText`; no editor
   * transaction type crosses this contract. `parent` is opaque host UI.
   */
  createEditor(input: {
    readonly session: DocumentSession<{ raw: string }>;
    readonly parent: unknown;
    readonly initialText: string;
    readonly onDirtyText: (text: string) => void;
    readonly resourceResolver?: ResourceResolver;
    readonly searchImageFiles?: (query: string) => Promise<readonly string[]>;
  }): MarkdownEditorHandle;
}
