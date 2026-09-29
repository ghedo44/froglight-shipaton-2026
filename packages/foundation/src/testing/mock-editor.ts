/**
 * Deterministic mock Markdown editor provider for exercising session and
 * persistence behavior without mounting CodeMirror.
 *
 * No DOM, no @codemirror/*, deterministic history, same session.save()
 * bytes as the real provider.
 */

import type { DocumentSession } from '../session.js';
import type { MarkdownEditorHandle, MarkdownEditorProvider } from '../editors/provider.js';

export class MockMarkdownEditorHandle implements MarkdownEditorHandle {
  readonly #session: DocumentSession<{ raw: string }>;
  #text: string;
  #history: string[] = [];
  #future: string[] = [];
  #destroyed = false;
  #onDirtyText: (text: string) => void;
  #focused = false;

  constructor(session: DocumentSession<{ raw: string }>, initialText: string, onDirtyText: (text: string) => void) {
    // Keep reference for future extension; accessed via diagnostics if needed.
    this.#session = session;
    void this.#session;
    this.#text = initialText;
    this.#onDirtyText = onDirtyText;
  }

  /** Simulate user typing: replace entire text (deterministic). */
  replaceAll(next: string): void {
    this.#assertAlive();
    if (next === this.#text) {
      return;
    }
    this.#history.push(this.#text);
    this.#future.length = 0;
    this.#text = next;
    this.#onDirtyText(next);
  }

  /** Insert at position (for finer test control). */
  insertText(at: number, text: string): void {
    this.#assertAlive();
    const next = this.#text.slice(0, at) + text + this.#text.slice(at);
    this.replaceAll(next);
  }

  /** Delete range. */
  deleteRange(from: number, to: number): void {
    this.#assertAlive();
    const next = this.#text.slice(0, from) + this.#text.slice(to);
    this.replaceAll(next);
  }

  getTextForTest(): string {
    return this.#text;
  }

  getUndoDepth(): number {
    return this.#history.length;
  }

  getRedoDepth(): number {
    return this.#future.length;
  }

  focus(): void {
    this.#assertAlive();
    this.#focused = true;
  }

  hasFocus(): boolean {
    return this.#focused;
  }

  canExecCommand(id: 'undo' | 'redo'): boolean {
    if (id === 'undo') {
      return this.#history.length > 0;
    }
    return this.#future.length > 0;
  }

  execCommand(id: 'undo' | 'redo'): boolean {
    this.#assertAlive();
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

  #assertAlive(): void {
    if (this.#destroyed) {
      throw new Error('MockMarkdownEditorHandle is destroyed');
    }
  }
}

export class MockMarkdownEditorProvider implements MarkdownEditorProvider {
  createEditor(input: {
    readonly session: DocumentSession<{ raw: string }>;
    readonly parent: unknown;
    readonly initialText: string;
    readonly onDirtyText: (text: string) => void;
  }): MarkdownEditorHandle {
    // Parent is ignored — no DOM.
    void input.parent;
    return new MockMarkdownEditorHandle(input.session, input.initialText, input.onDirtyText);
  }
}
