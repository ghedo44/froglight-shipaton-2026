/**
 * Deterministic mock notebook editor provider — the replaceability proof
 * for the generic editor registry path. No DOM, no Canvas:
 * page operations operate on canonical plain data through snapshot
 * history, mirroring the production adapter's gesture-level history unit.
 */

import type { DocumentEditorHandle, DocumentEditorProvider } from '../editors/registry.js';
import type { DocumentSession } from '../session.js';
import {
  inkStrokeObject,
  boundedFrame,
  emptySurface,
} from '../surfaces/model.js';
import { notebookKindId } from '../notebooks/kind.js';
import {
  appendPage,
  emptyNotebook,
  notebookPage,
  type NotebookModel,
} from '../notebooks/model.js';
import { createMockSurfaceTools, MOCK_NOTEBOOK_DRAW_TOOLS } from './mock-surface-tools.js';

export class MockNotebookEditorHandle implements DocumentEditorHandle {
  #destroyed = false;
  readonly #session: DocumentSession<NotebookModel>;
  readonly #undo: string[] = [];
  readonly #redo: string[] = [];
  #counter = 0;
  readonly tools = createMockSurfaceTools({
    context: 'Notebook page',
    prefix: 'notebook',
    drawTools: MOCK_NOTEBOOK_DRAW_TOOLS,
  });

  constructor(session: DocumentSession<NotebookModel>) {
    this.#session = session;
  }

  /** Simulate one pen gesture committing a stroke to the first page. */
  addStrokeToFirstPage(x = 0, y = 0): void {
    this.requireAlive();
    const model = this.#session.model;
    const target = model.pageOrder[0];
    if (target === undefined) throw new Error('mock notebook has no pages');
    this.commit(() => {
      const page = model.pages[target]!;
      if (page.kind !== 'page') return;
      const id = `mock-stroke-${++this.#counter}`;
      page.surface.objects[id] = inkStrokeObject(id, {
        points: [
          { x, y },
          { x: x + 10, y: y + 10 },
        ],
        width: 3,
      });
      page.surface.order.push(id);
    });
  }

  /** Append a blank page at the end of the canonical order. */
  addPage(templateId?: string): string {
    this.requireAlive();
    let id = '';
    this.commit(() => {
      id = `page-${++this.#counter}`;
      appendPage(this.#session.model, notebookPage(id, { template: templateId }));
    });
    return id;
  }

  /** Reorder one page id to a new index in the canonical order. */
  reorder(pageId: string, toIndex: number): void {
    this.requireAlive();
    this.commit(() => {
      const order = this.#session.model.pageOrder;
      const from = order.indexOf(pageId);
      if (from === -1) return;
      order.splice(from, 1);
      order.splice(Math.max(0, Math.min(order.length, toIndex)), 0, pageId);
    });
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
    if (id === 'undo') {
      const previous = this.#undo.pop();
      if (previous === undefined) return false;
      this.#redo.push(JSON.stringify(this.#session.model));
      restoreModel(this.#session.model, previous);
    } else {
      const next = this.#redo.pop();
      if (next === undefined) return false;
      this.#undo.push(JSON.stringify(this.#session.model));
      restoreModel(this.#session.model, next);
    }
    this.#session.markDirty();
    return true;
  }

  destroy(): void {
    this.#destroyed = true;
  }

  get destroyed(): boolean {
    return this.#destroyed;
  }

  getModelForTest(): NotebookModel {
    return this.#session.model;
  }

  private commit(mutate: () => void): void {
    this.#undo.push(JSON.stringify(this.#session.model));
    this.#redo.length = 0;
    mutate();
    this.#session.markDirty();
  }

  private requireAlive(): void {
    if (this.#destroyed) throw new Error('notebook editor handle is destroyed');
  }
}

function restoreModel(target: NotebookModel, snapshotJson: string): void {
  const record = target as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) delete record[key];
  Object.assign(record, JSON.parse(snapshotJson));
}

export class MockNotebookEditorProvider implements DocumentEditorProvider {
  readonly id = 'mock-notebook';
  readonly kindIds = [notebookKindId] as const;

  createEditor(input: { session: DocumentSession; parent: unknown }): MockNotebookEditorHandle {
    void input.parent;
    const session = input.session as DocumentSession<NotebookModel>;
    // Seed a minimal navigable shape for sessions opened on empty models.
    if (session.model.pageOrder.length === 0) {
      const seed = emptyNotebook();
      appendPage(seed, notebookPage('seed-1', { surface: emptySurface(boundedFrame(800, 600)) }));
      Object.assign(session.model as object, JSON.parse(JSON.stringify(seed)));
    }
    return new MockNotebookEditorHandle(session);
  }
}
