/**
 * Shared snapshot-history scaffolding for the deterministic block-page
 * editor test providers. Both the mock and the Tiptap stub keep full-page
 * snapshots for undo/redo; only their native edit operations differ.
 * Test-only: never part of the production surface.
 */

import type { BlockPageModel } from '../blocks/model.js';

export abstract class SnapshotHandleBase {
  #destroyed = false;
  readonly #undo: string[] = [];
  readonly #redo: string[] = [];
  #model: BlockPageModel;
  readonly #onDirtyModel: (model: BlockPageModel) => void;

  protected constructor(model: BlockPageModel, onDirtyModel: (model: BlockPageModel) => void) {
    this.#model = model;
    this.#onDirtyModel = onDirtyModel;
  }

  protected get model(): BlockPageModel {
    return this.#model;
  }

  /** Commit a freshly computed canonical model as one history step. */
  protected commit(next: BlockPageModel): void {
    this.requireAlive();
    this.#undo.push(JSON.stringify(this.#model));
    this.#redo.length = 0;
    this.#model = next;
    this.#onDirtyModel(next);
  }

  protected requireAlive(): void {
    if (this.#destroyed) throw new Error('editor handle is destroyed');
  }

  getModelForTest(): BlockPageModel {
    return this.#model;
  }

  getUndoDepth(): number {
    return this.#undo.length;
  }

  getRedoDepth(): number {
    return this.#redo.length;
  }

  focus(): void {
    this.requireAlive();
  }

  hasFocus(): boolean {
    return !this.#destroyed;
  }

  canExecCommand(id: 'undo' | 'redo'): boolean {
    return id === 'undo' ? this.#undo.length > 0 : this.#redo.length > 0;
  }

  execCommand(id: 'undo' | 'redo'): boolean {
    this.requireAlive();
    if (id === 'undo' && this.#undo.length > 0) {
      const previous = JSON.parse(this.#undo.pop()!) as BlockPageModel;
      this.#redo.push(JSON.stringify(this.#model));
      this.#model = previous;
      this.#onDirtyModel(previous);
      return true;
    }
    if (id === 'redo' && this.#redo.length > 0) {
      const next = JSON.parse(this.#redo.pop()!) as BlockPageModel;
      this.#undo.push(JSON.stringify(this.#model));
      this.#model = next;
      this.#onDirtyModel(next);
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
