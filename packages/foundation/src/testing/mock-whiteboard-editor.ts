/**
 * Deterministic mock Whiteboard editor provider — the replaceability proof
 * for the generic editor registry path (spec #52). No DOM, no
 * Canvas: edits operate on canonical plain data through snapshot history,
 * mirroring the production adapter's gesture-level history unit, and the
 * handle speaks the provider-neutral Document Tools seam like production.
 *
 * Link-reveal asymmetry: this mock has no `revealAddress`
 * seam, so controller links opened through it always degrade to
 * document-open-only (`revealed: false`). Exact-reveal assertions need a
 * resolve-aware test double or a production provider; like the notebook
 * and ink mocks, this one only proves the degrade path, never exactness.
 */

import type {
  DocumentEditorHandle,
  DocumentEditorProvider,
} from '../editors/registry.js';
import type { DocumentSession } from '../session.js';
import { inkStrokeObject, type SurfaceModel } from '../surfaces/model.js';
import { whiteboardKindId } from '../whiteboard/kind.js';
import {
  createMockSurfaceTools,
  MOCK_WHITEBOARD_DRAW_TOOLS,
} from './mock-surface-tools.js';

export class MockWhiteboardEditorHandle implements DocumentEditorHandle {
  #destroyed = false;
  #model: SurfaceModel;
  #strokeCounter = 0;
  readonly #undo: string[] = [];
  readonly #redo: string[] = [];
  readonly #onDirtyModel: (model: SurfaceModel) => void;
  readonly tools = createMockSurfaceTools({
    context: 'Whiteboard',
    prefix: 'whiteboard',
    drawTools: MOCK_WHITEBOARD_DRAW_TOOLS,
  });

  constructor(model: SurfaceModel, onDirtyModel: (model: SurfaceModel) => void) {
    this.#model = JSON.parse(JSON.stringify(model)) as SurfaceModel;
    this.#onDirtyModel = onDirtyModel;
  }

  /** Simulate one pen gesture committing a deterministic stroke. */
  addStroke(x: number, y: number): void {
    this.requireAlive();
    const id = `mock-stroke-${++this.#strokeCounter}`;
    const next = JSON.parse(JSON.stringify(this.#model)) as SurfaceModel;
    next.objects[id] = inkStrokeObject(id, {
      points: [
        { x, y },
        { x: x + 10, y: y + 10 },
      ],
      width: 3,
    });
    next.order.push(id);
    this.commit(next);
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
      this.#redo.push(JSON.stringify(this.#model));
      this.#model = JSON.parse(previous) as SurfaceModel;
    } else {
      const next = this.#redo.pop();
      if (next === undefined) return false;
      this.#undo.push(JSON.stringify(this.#model));
      this.#model = JSON.parse(next) as SurfaceModel;
    }
    this.#onDirtyModel(this.#model);
    return true;
  }

  destroy(): void {
    this.#destroyed = true;
  }

  getModelForTest(): SurfaceModel {
    return this.#model;
  }

  private commit(next: SurfaceModel): void {
    this.#undo.push(JSON.stringify(this.#model));
    this.#redo.length = 0;
    this.#model = next;
    this.#onDirtyModel(next);
  }

  private requireAlive(): void {
    if (this.#destroyed) throw new Error('editor handle is destroyed');
  }
}

export class MockWhiteboardEditorProvider implements DocumentEditorProvider {
  readonly id = 'mock-whiteboard';
  readonly kindIds = [whiteboardKindId] as const;

  createEditor(input: {
    session: DocumentSession;
    parent: unknown;
  }): MockWhiteboardEditorHandle {
    void input.parent;
    const whiteboardSession = input.session as DocumentSession<SurfaceModel>;
    return new MockWhiteboardEditorHandle(
      whiteboardSession.model,
      (model) => {
        Object.assign(whiteboardSession.model as object, model);
        whiteboardSession.markDirty();
      },
    );
  }
}
