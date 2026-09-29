/**
 * Minimal CodeMirror provider stub for the replaceable-editor contract.
 *
 * This is intentionally *not* a real CodeMirror integration — it
 * demonstrates the ownership seam without pulling `@codemirror/*` into
 * the foundation package (lint would fail `rg "@codemirror" packages/foundation`).
 * The real `editor-codemirror` package will implement the same
 * `MarkdownEditorProvider` token with an actual `EditorView`.
 *
 * For the vertical slice we prove replaceability by swapping between
 * `MockMarkdownEditorProvider` and this stub; both produce identical
 * canonical bytes via the same `onDirtyText → session.model.raw` path.
 */

import type { DocumentSession } from '../session.js';
import type { MarkdownEditorHandle, MarkdownEditorProvider } from '../editors/provider.js';

class StubHandle implements MarkdownEditorHandle {
  #text: string;
  #history: string[] = [];
  #future: string[] = [];
  #onDirtyText: (text: string) => void;
  #focused = false;
  #destroyed = false;

  constructor(initialText: string, onDirtyText: (text: string) => void) {
    this.#text = initialText;
    this.#onDirtyText = onDirtyText;
  }

  replaceAll(next: string): void {
    if (next === this.#text) {
      return;
    }
    this.#history.push(this.#text);
    this.#future.length = 0;
    this.#text = next;
    this.#onDirtyText(next);
  }

  getTextForTest(): string {
    return this.#text;
  }

  focus(): void {
    this.#focused = true;
  }

  hasFocus(): boolean {
    return this.#focused;
  }

  canExecCommand(id: 'undo' | 'redo'): boolean {
    return id === 'undo' ? this.#history.length > 0 : this.#future.length > 0;
  }

  execCommand(id: 'undo' | 'redo'): boolean {
    if (id === 'undo' && this.#history.length > 0) {
      const prev = this.#history.pop()!;
      this.#future.push(this.#text);
      this.#text = prev;
      this.#onDirtyText(prev);
      return true;
    }
    if (id === 'redo' && this.#future.length > 0) {
      const next = this.#future.pop()!;
      this.#history.push(this.#text);
      this.#text = next;
      this.#onDirtyText(next);
      return true;
    }
    return false;
  }

  destroy(): void {
    this.#destroyed = true;
  }

  get destroyed(): boolean {
    return this.#destroyed;
  }
}

/**
 * Stub that mimics the real CodeMirror provider's contract but without
 * importing `@codemirror/*`. Replaceable with the real implementation by
 * binding a different provider to `markdownEditorProviderToken`.
 */
export class CodemirrorStubProvider implements MarkdownEditorProvider {
  createEditor(input: {
    readonly session: DocumentSession<{ raw: string }>;
    readonly parent: unknown;
    readonly initialText: string;
    readonly onDirtyText: (text: string) => void;
  }): MarkdownEditorHandle {
    void input.parent;
    return new StubHandle(input.initialText, input.onDirtyText) as unknown as MarkdownEditorHandle;
  }
}
