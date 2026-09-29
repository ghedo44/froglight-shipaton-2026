/**
 * Math and diagram source blocks.
 *
 * - engine-free pm-map round-trips for the source-only atoms (source +
 *   universal children; invalid shapes verbatim; rendered output never
 *   canonical; no invented display flags)
 * - editor integration via semantic snapshot/execute only (no provider
 *   toolbar DOM): slash catalog + slash commit, insert-block, turn-into
 *   atom rejects both directions, source edits with single undo,
 *   outcome-before-mutation, readOnly refusal, over-cap refusal, drag
 *   (move-block) with subtree
 * - lazy safe preview: debounced settled-source rendering (one render for
 *   rapid commits), source + typed error on invalid, source fallback on
 *   missing renderer, caps enforced without touching a renderer, inert
 *   fixtures (script-bearing sources render inert), real KaTeX default
 *   renderer (trust:false — hostile hrefs never render), DOMPurify SVG
 *   sanitizer unit-pinned, headless/mock session equivalence
 *
 * No network in tests: renderer stubs are injected through the test seam;
 * only the KaTeX default path exercises a real local dependency (no fetch).
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  emptyBlockPage,
  paragraphBlock,
  type BlockPageModel,
  type BlockRecord,
} from '@froglight/foundation';
import { BlockPageDocumentEditorProvider } from './editor.js';
import { HeadlessBlockpageEditorHandle } from './headless-handle.js';
import { modelToPmDoc, pmDocToModel, type PmNode } from './pm-map.js';
import {
  MATH_DIAGRAM_SETTLE_MS,
  MAX_MATH_DIAGRAM_SOURCE_BYTES,
  __setMathDiagramTestHooks,
  closeMathDiagramOverlay,
  isMathDiagramOverlayOpen,
  markMathDiagramVisible,
  openMathDiagramOverlay,
  sanitizeKatexHtml,
  sanitizeMermaidSvg,
  syncMathDiagramViews,
  type MathDiagramOutcome,
} from './math-diagram-view.js';

function mathRecord(id: string, source: unknown): BlockRecord {
  return { id, type: 'froglight.math', source } as unknown as BlockRecord;
}

function diagramRecord(id: string, source: unknown): BlockRecord {
  return { id, type: 'froglight.diagram', source } as unknown as BlockRecord;
}

function mount(model: BlockPageModel) {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  let latest: BlockPageModel | null = null;
  const handle = new BlockPageDocumentEditorProvider().createEditor({
    session: {} as never,
    parent,
    initialModel: model,
    onDirtyModel: (next) => {
      latest = next;
    },
  });
  return {
    parent,
    handle,
    latest: () => latest as BlockPageModel | null,
    pm: () => parent.querySelector('.ProseMirror')!,
    mathFigure: () =>
      parent.querySelector('figure[data-flbp-math]') as HTMLElement | null,
    diagramFigure: () =>
      parent.querySelector('figure[data-flbp-diagram]') as HTMLElement | null,
    cleanup: () => {
      handle.destroy();
      parent.remove();
    },
  };
}

function command(
  env: ReturnType<typeof mount>,
  id: string,
  arg?: unknown,
): boolean {
  const run = env.handle.blockCommand;
  if (run === undefined) throw new Error('no blockCommand');
  return run.call(env.handle, id, arg);
}

function toolsOf(env: ReturnType<typeof mount>) {
  const tools = (
    env.handle as unknown as {
      tools?: {
        snapshot(): {
          context: string;
          controls: Array<
            { id: string; kind: string } & Record<string, unknown>
          >;
        };
        execute(id: string, value?: string): boolean;
      };
    }
  ).tools;
  if (tools === undefined) throw new Error('semantic tools unavailable');
  return tools;
}

function type(env: ReturnType<typeof mount>, text: string): void {
  if (!command(env, 'insert-text', { text }))
    throw new Error('insert-text failed');
}

function key(env: ReturnType<typeof mount>, k: string): void {
  env
    .pm()
    .dispatchEvent(
      new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }),
    );
}

function blank(): BlockPageModel {
  const m = emptyBlockPage();
  m.rootOrder = ['p1'];
  m.blocks = { p1: paragraphBlock('p1', [{ text: '' }]) };
  return m;
}

function modelWithMath(source = 'x^2'): BlockPageModel {
  const m = emptyBlockPage();
  m.rootOrder = ['m1'];
  m.blocks = { m1: mathRecord('m1', source) };
  return m;
}

const flush = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const okMathStub = async (): Promise<MathDiagramOutcome> => ({
  ok: true,
  html: '<span class="stub-katex">rendered-math</span>',
});

const okDiagramStub = async (): Promise<MathDiagramOutcome> => ({
  ok: true,
  html: '<svg xmlns="http://www.w3.org/2000/svg"><g><text>rendered-diagram</text></g></svg>',
});

afterEach(() => {
  __setMathDiagramTestHooks(null);
  document.body.replaceChildren();
  document.getElementById('flbp-chrome-styles')?.remove();
});

// --- pm-map: source-only round-trips (engine-free) ---

describe('pm-map math/diagram source-only mapping', () => {
  it('encodes math/diagram to source atoms and decodes back source-only', () => {
    const m = emptyBlockPage();
    m.rootOrder = ['m1', 'd1'];
    m.blocks = {
      m1: mathRecord('m1', 'x^2'),
      d1: diagramRecord('d1', 'graph TD; A-->B'),
    };
    const doc = modelToPmDoc(m);
    expect(doc.type).toBe('doc');
    const math = doc.content?.find((n) => n.type === 'mathBlock');
    const diagram = doc.content?.find((n) => n.type === 'diagramBlock');
    expect(math?.attrs).toEqual({ blockId: 'm1', source: 'x^2' });
    expect(diagram?.attrs).toEqual({
      blockId: 'd1',
      source: 'graph TD; A-->B',
    });
    const { model, warnings } = pmDocToModel(doc, {
      formatVersion: m.formatVersion,
      meta: m.meta,
    });
    expect(warnings).toEqual([]);
    expect(model.blocks['m1']).toEqual({
      id: 'm1',
      type: 'froglight.math',
      source: 'x^2',
    });
    expect(model.blocks['d1']).toEqual({
      id: 'd1',
      type: 'froglight.diagram',
      source: 'graph TD; A-->B',
    });
    expect(model.rootOrder).toEqual(['m1', 'd1']);
  });

  it('preserves invalid shapes verbatim for codec reporting; missing source defaults to empty', () => {
    const doc: PmNode = {
      type: 'doc',
      content: [
        { type: 'mathBlock', attrs: { blockId: 'm', source: 42 } },
        { type: 'diagramBlock', attrs: { blockId: 'd' } },
      ],
    };
    const { model } = pmDocToModel(doc, { formatVersion: 1, meta: {} });
    // Non-string sources ride verbatim (media remoteUrl precedent) so the
    // codec — not the provider — reports the shape violation.
    expect(model.blocks['m']).toEqual({
      id: 'm',
      type: 'froglight.math',
      source: 42,
    });
    expect(model.blocks['d']).toEqual({
      id: 'd',
      type: 'froglight.diagram',
      source: '',
    });
    // And encoding preserves the verbatim shape back.
    const round = modelToPmDoc(model);
    expect(round.content?.[0]?.attrs?.['source']).toBe(42);
  });

  it('never serializes rendered output or invented presentation flags', () => {
    const doc: PmNode = {
      type: 'doc',
      content: [
        {
          type: 'mathBlock',
          attrs: {
            blockId: 'm',
            source: 'x^2',
            html: '<span class="katex">evil</span>',
            display: true,
          },
        },
      ],
    };
    const { model } = pmDocToModel(doc, { formatVersion: 1, meta: {} });
    expect(model.blocks['m']).toEqual({
      id: 'm',
      type: 'froglight.math',
      source: 'x^2',
    });
    const m = emptyBlockPage();
    m.rootOrder = ['m'];
    m.blocks = {
      m: {
        id: 'm',
        type: 'froglight.math',
        source: 'x^2',
        display: true,
        html: 'x',
      } as unknown as BlockRecord,
    };
    const encoded = modelToPmDoc(m);
    expect(encoded.content?.[0]?.attrs).toEqual({
      blockId: 'm',
      source: 'x^2',
      // Canonical unknowns remain inert preservation data. They never
      // become renderer input or first-class PM presentation attrs.
      preserved: { display: true, html: 'x' },
    });
  });

  it('carries universal children through the overflow group', () => {
    const m = emptyBlockPage();
    m.rootOrder = ['m1'];
    m.blocks = {
      m1: { ...mathRecord('m1', 'x^2'), children: ['c1'] } as BlockRecord,
      c1: paragraphBlock('c1', [{ text: 'note' }]),
    };
    const doc = modelToPmDoc(m);
    expect(doc.content?.map((n) => n.type)).toEqual([
      'mathBlock',
      'blockGroup',
    ]);
    const { model } = pmDocToModel(doc, {
      formatVersion: m.formatVersion,
      meta: m.meta,
    });
    expect(model.rootOrder).toEqual(['m1']);
    expect(model.blocks['m1']).toEqual({
      id: 'm1',
      type: 'froglight.math',
      source: 'x^2',
      children: ['c1'],
    });
    expect(model.blocks['c1']).toEqual(
      paragraphBlock('c1', [{ text: 'note' }]),
    );
  });
});

// --- slash catalog + slash commit ---

describe('slash catalog math/diagram rows', () => {
  it('/math narrows to the Math row; Enter commits a source block with the trigger removed', async () => {
    const env = mount(blank());
    try {
      type(env, '/math');
      await flush();
      const items = [
        ...(env.parent
          .querySelector('.flbp-slash:not(.flbp-resource-menu)')
          ?.querySelectorAll('.flbp-slash-item') ?? []),
      ].map((el) => el.textContent);
      expect(items).toEqual(['Math']);
      key(env, 'Enter');
      const next = env.latest()!;
      expect(JSON.stringify(next)).not.toContain('/math');
      const insertedId = next.rootOrder[1]!;
      expect(next.blocks[insertedId]).toEqual({
        id: insertedId,
        type: 'froglight.math',
        source: '',
      });
      // Fused commit: one undo removes the block (trigger text returns).
      expect(env.handle.execCommand('undo')).toBe(true);
      const undone = env.handle.getModelForTest!();
      expect(undone.rootOrder).toEqual(['p1']);
      expect(
        Object.values(undone.blocks).some((b) => b.type === 'froglight.math'),
      ).toBe(false);
    } finally {
      env.cleanup();
    }
  });

  it('/mermaid narrows to the Diagram row; keyword /latex matches Math', async () => {
    const env = mount(blank());
    try {
      type(env, '/mermaid');
      await flush();
      const items = [
        ...(env.parent
          .querySelector('.flbp-slash:not(.flbp-resource-menu)')
          ?.querySelectorAll('.flbp-slash-item') ?? []),
      ].map((el) => el.textContent);
      expect(items).toEqual(['Diagram']);
    } finally {
      env.cleanup();
    }
    const env2 = mount(blank());
    try {
      type(env2, '/latex');
      await flush();
      const items2 = [
        ...(env2.parent
          .querySelector('.flbp-slash:not(.flbp-resource-menu)')
          ?.querySelectorAll('.flbp-slash-item') ?? []),
      ].map((el) => el.textContent);
      expect(items2).toEqual(['Math']);
    } finally {
      env2.cleanup();
    }
  });
});

// --- insert-block + turn-into atom rule + move-block ---

describe('insert-block / turn-into / move-block', () => {
  it('insert-block math/diagram carry stable ids and move-block finds them', () => {
    for (const kind of ['math', 'diagram'] as const) {
      const env = mount(blank());
      try {
        expect(command(env, 'insert-block', { type: kind })).toBe(true);
        const next = env.handle.getModelForTest!();
        expect(next.rootOrder.length).toBe(2);
        const insertedId = next.rootOrder[1]!;
        expect(next.blocks[insertedId]?.type).toBe(`froglight.${kind}`);
        expect(
          command(env, 'move-block', { blockId: insertedId, index: 0 }),
        ).toBe(true);
        expect(env.handle.getModelForTest!().rootOrder[0]).toBe(insertedId);
      } finally {
        env.cleanup();
      }
    }
  });

  it('turn-into to math/diagram rejects without mutation (atom rule)', () => {
    const env = mount(blank());
    try {
      expect(command(env, 'turn-into', { type: 'math' })).toBe(false);
      expect(command(env, 'turn-into', { type: 'diagram' })).toBe(false);
      expect(env.latest()).toBeNull();
      expect(env.handle.getModelForTest!().blocks['p1']?.type).toBe(
        'froglight.paragraph',
      );
    } finally {
      env.cleanup();
    }
  });

  it('turn-into from math/diagram rejects without mutation (atom rule)', () => {
    const env = mount(modelWithMath());
    try {
      expect(command(env, 'select-block', { blockId: 'm1' })).toBe(true);
      expect(command(env, 'turn-into', { type: 'paragraph' })).toBe(false);
      expect(command(env, 'turn-into', { type: 'heading', level: 1 })).toBe(
        false,
      );
      const next = env.handle.getModelForTest!();
      expect(next.blocks['m1']).toEqual({
        id: 'm1',
        type: 'froglight.math',
        source: 'x^2',
      });
    } finally {
      env.cleanup();
    }
  });

  it('move-block carries a math block with its overflow children', () => {
    const m = emptyBlockPage();
    m.rootOrder = ['p1', 'm1'];
    m.blocks = {
      p1: paragraphBlock('p1', [{ text: 'lead' }]),
      m1: { ...mathRecord('m1', 'x^2'), children: ['c1'] } as BlockRecord,
      c1: paragraphBlock('c1', [{ text: 'note' }]),
    };
    const env = mount(m);
    try {
      expect(command(env, 'move-block', { blockId: 'm1', index: 0 })).toBe(
        true,
      );
      const next = env.handle.getModelForTest!();
      expect(next.rootOrder[0]).toBe('m1');
      expect(next.blocks['m1']).toMatchObject({
        type: 'froglight.math',
        children: ['c1'],
      });
      expect(next.blocks['c1']).toEqual(
        paragraphBlock('c1', [{ text: 'note' }]),
      );
    } finally {
      env.cleanup();
    }
  });
});

// --- semantic snapshot/execute for source editing ---

describe('math/diagram semantic source controls', () => {
  it('snapshot at a math block offers the source control; marks stay hidden', () => {
    const env = mount(modelWithMath('a+b'));
    try {
      expect(command(env, 'select-block', { blockId: 'm1' })).toBe(true);
      const snapshot = toolsOf(env).snapshot();
      expect(snapshot.context).toBe('Math');
      const ids = snapshot.controls.map((c) => c.id);
      expect(ids).toContain('math.edit');
      expect(ids).toContain('math.source');
      expect(ids).toContain('math.retry');
      expect(ids).not.toContain('block.bold');
      expect(ids).not.toContain('block.link');
      const source = snapshot.controls.find((c) => c.id === 'math.source')!;
      expect(source.kind).toBe('input');
      expect(source['value']).toBe('a+b');
    } finally {
      env.cleanup();
    }
  });

  it('snapshot at a diagram block offers the diagram source control', () => {
    const m = emptyBlockPage();
    m.rootOrder = ['d1'];
    m.blocks = { d1: diagramRecord('d1', 'graph TD; A-->B') };
    const env = mount(m);
    try {
      expect(command(env, 'select-block', { blockId: 'd1' })).toBe(true);
      const snapshot = toolsOf(env).snapshot();
      expect(snapshot.context).toBe('Diagram');
      const ids = snapshot.controls.map((c) => c.id);
      expect(ids).toContain('diagram.source');
      expect(ids).toContain('diagram.retry');
    } finally {
      env.cleanup();
    }
  });

  it('execute sets the source in one undo step; empty clears to the empty placeholder', async () => {
    __setMathDiagramTestHooks({ math: okMathStub, debounceMs: 0 });
    const env = mount(modelWithMath('a'));
    try {
      expect(command(env, 'select-block', { blockId: 'm1' })).toBe(true);
      expect(toolsOf(env).execute('math.source', 'x^2')).toBe(true);
      expect(env.latest()!.blocks['m1']).toEqual({
        id: 'm1',
        type: 'froglight.math',
        source: 'x^2',
      });
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!().blocks['m1']).toEqual({
        id: 'm1',
        type: 'froglight.math',
        source: 'a',
      });
      expect(command(env, 'select-block', { blockId: 'm1' })).toBe(true);
      expect(toolsOf(env).execute('math.source', '')).toBe(true);
      expect(env.handle.getModelForTest!().blocks['m1']).toEqual({
        id: 'm1',
        type: 'froglight.math',
        source: '',
      });
    } finally {
      env.cleanup();
    }
  });

  it('execute refuses without mutation when read-only, valueless, off-atom, or over-cap', () => {
    const env = mount(modelWithMath('a'));
    try {
      expect(command(env, 'select-block', { blockId: 'm1' })).toBe(true);
      // Valueless submit refuses.
      expect(toolsOf(env).execute('math.source')).toBe(false);
      // Cross-kind control refuses on a math root.
      expect(toolsOf(env).execute('diagram.source', 'x')).toBe(false);
      // Over-cap refuses (preview could never render it).
      const huge = 'x'.repeat(MAX_MATH_DIAGRAM_SOURCE_BYTES + 1);
      expect(toolsOf(env).execute('math.source', huge)).toBe(false);
      // Read-only refuses.
      expect(env.handle.setReadOnly).toBeDefined();
      env.handle.setReadOnly!(true);
      expect(toolsOf(env).execute('math.source', 'x^2')).toBe(false);
      env.handle.setReadOnly!(false);
      expect(env.handle.getModelForTest!().blocks['m1']).toEqual({
        id: 'm1',
        type: 'froglight.math',
        source: 'a',
      });
      // Off-atom selection refuses (paragraph root).
      const env2 = mount(blank());
      try {
        expect(toolsOf(env2).execute('math.source', 'x^2')).toBe(false);
        expect(env2.latest()).toBeNull();
      } finally {
        env2.cleanup();
      }
    } finally {
      env.cleanup();
    }
  });

  it('retry re-hydrates with no canonical mutation and no history step', async () => {
    __setMathDiagramTestHooks({ math: okMathStub, debounceMs: 0 });
    const env = mount(modelWithMath('x^2'));
    try {
      expect(command(env, 'select-block', { blockId: 'm1' })).toBe(true);
      const before = JSON.stringify(env.handle.getModelForTest!());
      // select-block itself is a test-only selection dispatch (pre-existing
      // channel); pin only that RETRY adds nothing on top of it.
      const undoBefore = env.handle.canExecCommand?.('undo');
      expect(toolsOf(env).execute('math.retry')).toBe(true);
      await flush(20);
      expect(JSON.stringify(env.handle.getModelForTest!())).toBe(before);
      expect(env.handle.canExecCommand?.('undo')).toBe(undoBefore);
    } finally {
      env.cleanup();
    }
  });
});

// --- lazy safe preview ---

describe('math/diagram preview hydration', () => {
  it('valid sources render into the sandbox host; canonical stays source-only', async () => {
    __setMathDiagramTestHooks({
      math: okMathStub,
      diagram: okDiagramStub,
      debounceMs: 0,
    });
    const m = emptyBlockPage();
    m.rootOrder = ['m1', 'd1'];
    m.blocks = {
      m1: mathRecord('m1', 'x^2'),
      d1: diagramRecord('d1', 'graph TD; A-->B'),
    };
    const env = mount(m);
    try {
      await waitFor(
        () =>
          env.mathFigure()?.dataset.flbpMdHydrated === 'live' &&
          env.diagramFigure()?.dataset.flbpMdHydrated === 'live',
      );
      const mathPreview = env.mathFigure()!.querySelector('.flbp-md-preview')!;
      expect(mathPreview.innerHTML).toContain('rendered-math');
      expect(mathPreview.classList.contains('flbp-md-sandbox')).toBe(true);
      // Source stays inspectable in data-source but hidden while live.
      expect(env.mathFigure()!.getAttribute('data-source')).toBe('x^2');
      expect(
        (env.mathFigure()!.querySelector('.flbp-md-src') as HTMLElement).hidden,
      ).toBe(true);
      // Rendered output never reaches canonical bytes.
      const model = env.handle.getModelForTest!();
      expect(model.blocks['m1']).toEqual({
        id: 'm1',
        type: 'froglight.math',
        source: 'x^2',
      });
      expect(model.blocks['d1']).toEqual({
        id: 'd1',
        type: 'froglight.diagram',
        source: 'graph TD; A-->B',
      });
      expect(JSON.stringify(model)).not.toContain('rendered-');
    } finally {
      env.cleanup();
    }
  });

  it('invalid source shows source plus the typed error (no exception text leak)', async () => {
    __setMathDiagramTestHooks({
      math: async () => ({ ok: false, error: 'invalid-source' }),
      diagram: async () => ({ ok: false, error: 'timeout' }),
      debounceMs: 0,
    });
    const m = emptyBlockPage();
    m.rootOrder = ['m1', 'd1'];
    m.blocks = {
      m1: mathRecord('m1', '\\oops{'),
      d1: diagramRecord('d1', '%%%bad'),
    };
    const env = mount(m);
    try {
      await waitFor(
        () =>
          env.mathFigure()?.dataset.flbpMdHydrated === 'source' &&
          env.diagramFigure()?.dataset.flbpMdHydrated === 'source',
      );
      const mathSrc = env.mathFigure()!.querySelector('.flbp-md-src')!;
      expect(mathSrc.textContent).toBe('\\oops{');
      expect(
        env.mathFigure()!.querySelector('.flbp-md-status')!.textContent,
      ).toBe(
        'LaTeX math could not be rendered. The source is preserved below.',
      );
      expect(
        env.diagramFigure()!.querySelector('.flbp-md-status')!.textContent,
      ).toBe(
        'Mermaid diagram preview timed out. The source is preserved below.',
      );
      expect(env.mathFigure()!.dataset.flbpMdReason).toBe('invalid-source');
    } finally {
      env.cleanup();
    }
  });

  it('missing renderer degrades to the source-text fallback; canonical intact', async () => {
    __setMathDiagramTestHooks({ math: null, diagram: null, debounceMs: 0 });
    const env = mount(modelWithMath('x^2'));
    try {
      await waitFor(
        () => env.mathFigure()?.dataset.flbpMdHydrated === 'source',
      );
      expect(env.mathFigure()!.querySelector('.flbp-md-src')!.textContent).toBe(
        'x^2',
      );
      expect(
        env.mathFigure()!.querySelector('.flbp-md-status')!.textContent,
      ).toBe(
        'LaTeX math preview is unavailable. The source is preserved below.',
      );
      expect(env.handle.getModelForTest!().blocks['m1']).toEqual({
        id: 'm1',
        type: 'froglight.math',
        source: 'x^2',
      });
    } finally {
      env.cleanup();
    }
  });

  it('empty source renders the empty placeholder without calling a renderer', async () => {
    let calls = 0;
    __setMathDiagramTestHooks({
      math: async () => {
        calls += 1;
        return okMathStub();
      },
      debounceMs: 0,
    });
    const env = mount(modelWithMath(''));
    try {
      await waitFor(() => env.mathFigure()?.dataset.flbpMdHydrated === 'empty');
      expect(calls).toBe(0);
      expect(
        env.mathFigure()!.querySelector('.flbp-md-status')!.textContent,
      ).toBe('Empty math block. Set the source to preview it.');
    } finally {
      env.cleanup();
    }
  });

  it('over-cap source renders the typed error without calling a renderer', async () => {
    let calls = 0;
    __setMathDiagramTestHooks({
      math: async () => {
        calls += 1;
        return okMathStub();
      },
      debounceMs: 0,
    });
    const env = mount(
      modelWithMath('x'.repeat(MAX_MATH_DIAGRAM_SOURCE_BYTES + 1)),
    );
    try {
      await waitFor(
        () => env.mathFigure()?.dataset.flbpMdReason === 'too-large',
      );
      expect(calls).toBe(0);
      expect(
        env.mathFigure()!.querySelector('.flbp-md-status')!.textContent,
      ).toBe(
        'LaTeX math source exceeds the 64 KB preview cap and was not rendered. It is preserved.',
      );
      expect(
        (
          env.handle.getModelForTest!().blocks['m1'] as unknown as {
            source: string;
          }
        ).source.length,
      ).toBe(MAX_MATH_DIAGRAM_SOURCE_BYTES + 1);
    } finally {
      env.cleanup();
    }
  });

  it('settled sources render once: rapid commits collapse into a single render', async () => {
    const seen: string[] = [];
    // Default debounce (no override): rapid re-syncs reschedule one timer.
    __setMathDiagramTestHooks({
      math: async (source: string) => {
        seen.push(source);
        return okMathStub();
      },
    });
    expect(MATH_DIAGRAM_SETTLE_MS).toBeGreaterThan(0);
    const env = mount(modelWithMath('a'));
    try {
      expect(command(env, 'select-block', { blockId: 'm1' })).toBe(true);
      expect(toolsOf(env).execute('math.source', 'b')).toBe(true);
      expect(command(env, 'select-block', { blockId: 'm1' })).toBe(true);
      expect(toolsOf(env).execute('math.source', 'c')).toBe(true);
      await waitFor(() => env.mathFigure()?.dataset.flbpMdHydrated === 'live');
      await flush(MATH_DIAGRAM_SETTLE_MS + 50);
      expect(seen).toEqual(['c']);
    } finally {
      env.cleanup();
    }
  });

  it('deferred figures render on the deferred-to-visible transition (identical sig)', async () => {
    // the sync signature covers kind+source only, so the
    // observer re-sync after visibility recomputes an identical sig. That
    // re-sync must fall through to the debounced render — never pin the
    // figure on the deferred source state. jsdom has no
    // IntersectionObserver, so the transition is driven directly
    // (markMathDiagramVisible + re-sync), mirroring the tiptap-handle
    // observer callback.
    let calls = 0;
    __setMathDiagramTestHooks({
      math: async () => {
        calls += 1;
        return okMathStub();
      },
      debounceMs: 0,
    });
    const host = document.createElement('div');
    host.innerHTML = '<figure data-flbp-math data-source="x^2"></figure>';
    document.body.appendChild(host);
    try {
      const observer = {
        observe: vi.fn(),
        unobserve: vi.fn(),
        disconnect: vi.fn(),
      } as unknown as IntersectionObserver;
      await syncMathDiagramViews(host, { observer });
      const figure = host.querySelector('figure')!;
      // Off-screen: inspectable deferred source, renderer untouched.
      expect(figure.dataset.flbpMdHydrated).toBe('deferred');
      expect(figure.dataset.flbpMdReason).toBe('deferred');
      expect(calls).toBe(0);
      // Observer fires: mark + re-sync with an IDENTICAL kind+source
      // signature must still render and clear the deferred marker.
      markMathDiagramVisible(figure);
      await syncMathDiagramViews(host, { observer });
      await waitFor(() => figure.dataset.flbpMdHydrated === 'live');
      expect(calls).toBe(1);
      expect(figure.dataset.flbpMdReason).toBeUndefined();
      expect(figure.querySelector('.flbp-md-preview')!.innerHTML).toContain(
        'rendered-math',
      );
      // Genuinely settled re-syncs still skip (no render storm).
      await syncMathDiagramViews(host, { observer });
      await flush(20);
      expect(calls).toBe(1);
    } finally {
      host.remove();
    }
  });

  it('script-bearing stub output renders inert (sweep removes script/handlers/dangerous hrefs)', async () => {
    __setMathDiagramTestHooks({
      math: async () => ({
        ok: true,
        html: '<span class="stub">t</span><script>alert(1)</script><a href="javascript:alert(1)" onclick="evil()">x</a>',
      }),
      diagram: async () => ({
        ok: true,
        html: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><foreignObject><body xmlns="http://www.w3.org/1999/xhtml">x</body></foreignObject><g onload="evil()"><text>ok</text></g></svg>',
      }),
      debounceMs: 0,
    });
    const m = emptyBlockPage();
    m.rootOrder = ['m1', 'd1'];
    m.blocks = { m1: mathRecord('m1', 'x'), d1: diagramRecord('d1', 'y') };
    const env = mount(m);
    try {
      await waitFor(
        () =>
          env.mathFigure()?.dataset.flbpMdHydrated === 'live' &&
          env.diagramFigure()?.dataset.flbpMdHydrated === 'live',
      );
      for (const figure of [env.mathFigure()!, env.diagramFigure()!]) {
        expect(figure.querySelector('script')).toBeNull();
        expect(figure.querySelector('foreignObject')).toBeNull();
        expect(figure.querySelector('[onclick]')).toBeNull();
        expect(figure.querySelector('[onload]')).toBeNull();
        expect(figure.innerHTML).not.toContain('javascript:');
      }
      // Benign content survives the sweep.
      expect(env.mathFigure()!.querySelector('.stub')).not.toBeNull();
      expect(env.diagramFigure()!.querySelector('text')?.textContent).toBe(
        'ok',
      );
    } finally {
      env.cleanup();
    }
  });
});

// --- sanitizers (pinned directly) ---

describe('preview sanitizers', () => {
  it('sanitizeKatexHtml strips handlers and dangerous URLs; fails closed on script elements', () => {
    expect(
      sanitizeKatexHtml(
        document,
        '<span class="katex"><a href="javascript:alert(1)" onclick="e()">x</a></span>',
      ),
    ).toBe('<span class="katex"><a>x</a></span>');
    expect(
      sanitizeKatexHtml(
        document,
        '<span class="katex">x</span><script>alert(1)</script>',
      ),
    ).toBeNull();
    expect(
      sanitizeKatexHtml(
        document,
        '<span class="katex"><a href="https://example.com/x">ok</a></span>',
      ),
    ).toContain('href="https://example.com/x"');
  });

  it('sanitizeKatexHtml strips control-char-smuggled schemes, srcset/style URLs, and hardens links', () => {
    const tab = String.fromCharCode(9);
    const lf = String.fromCharCode(10);
    // Embedded TAB/LF must not smuggle a scheme past the prefix compare
    // strip-throughout, not trim-start-only.
    expect(
      sanitizeKatexHtml(
        document,
        '<span class="katex"><a href="java' +
          tab +
          'script:alert(1)">x</a></span>',
      ),
    ).toBe('<span class="katex"><a>x</a></span>');
    expect(
      sanitizeKatexHtml(
        document,
        '<span class="katex"><a href="java' +
          lf +
          'script:alert(1)">x</a></span>',
      ),
    ).toBe('<span class="katex"><a>x</a></span>');
    // srcset candidates and style url() payloads are covered too.
    expect(
      sanitizeKatexHtml(
        document,
        '<span><img srcset="x.png 1x, javascript:alert(1) 2x"></span>',
      ),
    ).toBe('<span><img></span>');
    expect(
      sanitizeKatexHtml(
        document,
        '<span style="background: url(javascript:alert(1))">x</span>',
      ),
    ).toBe('<span>x</span>');
    // Benign declarations survive; preserved https links gain noopener.
    expect(
      sanitizeKatexHtml(document, '<span style="fill: #fff">x</span>'),
    ).toBe('<span style="fill: #fff">x</span>');
    const kept = sanitizeKatexHtml(
      document,
      '<span class="katex"><a href="https://example.com/x">ok</a></span>',
    );
    expect(kept).toContain('href="https://example.com/x"');
    expect(kept).toContain('rel="noopener"');
  });

  it('keeps Mermaid node shadows and SVG labels while stripping active filter content', async () => {
    const clean = await sanitizeMermaidSvg(
      document,
      '<svg xmlns="http://www.w3.org/2000/svg"><defs><filter id="shadow"><feDropShadow dx="2" dy="2" stdDeviation="0" flood-opacity="0.06" onload="evil()"/><script>evil()</script></filter></defs><g filter="url(#shadow)"><rect width="80" height="40"/><text>Start</text></g><foreignObject><div>hidden HTML</div></foreignObject></svg>',
    );
    expect(clean).not.toBeNull();
    const host = document.createElement('div');
    host.innerHTML = clean!;
    const shadow = host.querySelector('filter')?.firstElementChild;
    expect(shadow?.localName.toLowerCase()).toBe('fedropshadow');
    expect(shadow?.getAttribute('dx')).toBe('2');
    expect(host.querySelector('text')?.textContent).toBe('Start');
    expect(host.querySelector('g')?.getAttribute('filter')).toBe(
      'url(#shadow)',
    );
    expect(host.querySelector('script, foreignObject, [onload]')).toBeNull();
  });

  it('sanitizeMermaidSvg rejects data: URLs to match the sweep contract', async () => {
    // DOMPurify keeps data:image hrefs on <image>, so the
    // re-verify must fail closed (null → typed error) exactly where the
    // post-insert sweep would strip — the composed DOM never holds a
    // data: URL either way.
    expect(
      await sanitizeMermaidSvg(
        document,
        '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,iVBORw0KGgo="></image></svg>',
      ),
    ).toBeNull();
  });

  it('sanitizeMermaidSvg strips threats and keeps benign SVG (fail-closed backstop stays armed)', async () => {
    const clean = await sanitizeMermaidSvg(
      document,
      '<svg xmlns="http://www.w3.org/2000/svg"><g><text>hi</text></g></svg>',
    );
    expect(clean).not.toBeNull();
    expect(clean!).toContain('<svg');
    expect(clean!).toContain('hi');
    // DOMPurify strips each threat class; the SVG shell survives sanitized.
    // (The DOM re-verification behind this helper stays armed as a
    // fail-closed backstop — null when a threat ever survives — but with
    // DOMPurify healthy every threat below is removed, never passed through.)
    expect(
      await sanitizeMermaidSvg(
        document,
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      ),
    ).toBe('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(
      await sanitizeMermaidSvg(
        document,
        '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><body xmlns="http://www.w3.org/1999/xhtml">x</body></foreignObject></svg>',
      ),
    ).toBe('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(
      await sanitizeMermaidSvg(
        document,
        '<svg xmlns="http://www.w3.org/2000/svg"><g onload="evil()"><text>hi</text></g></svg>',
      ),
    ).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg"><g><text>hi</text></g></svg>',
    );
    const anchor = await sanitizeMermaidSvg(
      document,
      '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><text>hi</text></a></svg>',
    );
    expect(anchor).not.toBeNull();
    expect(anchor!).toContain('hi');
    expect(anchor!).not.toContain('javascript:');
  });
});

// --- real KaTeX default renderer (local dependency, no network) ---

describe('KaTeX default renderer', () => {
  it('renders valid LaTeX through the real local KaTeX', async () => {
    __setMathDiagramTestHooks({ debounceMs: 0 });
    const env = mount(modelWithMath('x^2'));
    try {
      await waitFor(() => env.mathFigure()?.dataset.flbpMdHydrated === 'live');
      expect(
        env.mathFigure()!.querySelector('.flbp-md-preview')!.innerHTML,
      ).toContain('katex');
      expect(env.mathFigure()!.innerHTML).not.toContain('javascript:');
    } finally {
      env.cleanup();
    }
  });

  it('hostile href LaTeX renders inert: no link, no javascript: URL, no leak', async () => {
    // Pinned against real KaTeX with trust:false: `\href` renders as inert
    // red fallback TEXT (`<mtext>\href</mtext>`) — no `href` attribute is
    // ever emitted, so the javascript: URL cannot reach the DOM. The
    // post-scan is the second layer; the test pins the composed outcome.
    __setMathDiagramTestHooks({ debounceMs: 0 });
    const env = mount(modelWithMath('\\href{javascript:alert(1)}{x}'));
    try {
      await waitFor(() => env.mathFigure()?.dataset.flbpMdHydrated === 'live');
      // No link element is ever emitted for the untrusted href …
      expect(env.mathFigure()!.querySelector('a[href]')).toBeNull();
      // … and no href/src attribute anywhere in the figure carries a
      // javascript: URL. (The inert MathML `<annotation>` text legitimately
      // echoes the source for assistive tooling — text, never markup — so
      // the assertion is scoped to URL ATTRIBUTES, not raw text.)
      const urls: string[] = [];
      for (const el of env.mathFigure()!.querySelectorAll('*')) {
        for (const attr of [...el.attributes]) {
          const name = attr.name.toLowerCase();
          if (name === 'href' || name === 'src' || name.endsWith(':href')) {
            const normalized = attr.value.trimStart().toLowerCase();
            if (
              normalized.startsWith('javascript:') ||
              normalized.startsWith('data:') ||
              normalized.startsWith('vbscript:')
            ) {
              urls.push(attr.value);
            }
          }
        }
      }
      expect(urls).toEqual([]);
      // The source text itself stays inspectable in data-source (canonical).
      expect(env.mathFigure()!.getAttribute('data-source')).toBe(
        '\\href{javascript:alert(1)}{x}',
      );
    } finally {
      env.cleanup();
    }
  });

  it('invalid LaTeX fails to the typed error with no exception text leak', async () => {
    __setMathDiagramTestHooks({ debounceMs: 0 });
    const env = mount(modelWithMath('\\notacommand{'));
    try {
      await waitFor(
        () => env.mathFigure()?.dataset.flbpMdHydrated === 'source',
      );
      expect(
        env.mathFigure()!.querySelector('.flbp-md-status')!.textContent,
      ).toBe(
        'LaTeX math could not be rendered. The source is preserved below.',
      );
      expect(env.mathFigure()!.innerHTML).not.toContain('ParseError');
      expect(env.mathFigure()!.innerHTML).not.toContain('KaTeX parse error');
    } finally {
      env.cleanup();
    }
  });
});

// --- headless/mock session equivalence (replaceability) ---

describe('headless session equivalence', () => {
  it('headless round-trips math/diagram sources with no preview and no loss', () => {
    const m = emptyBlockPage();
    m.rootOrder = ['m1', 'd1'];
    m.blocks = {
      m1: mathRecord('m1', 'x^2'),
      d1: diagramRecord('d1', 'graph TD; A-->B'),
    };
    let latest: BlockPageModel | null = null;
    const handle = new HeadlessBlockpageEditorHandle({
      session: {} as never,
      parent: {} as never,
      initialModel: m,
      onDirtyModel: (next) => {
        latest = next;
      },
    });
    try {
      handle.appendParagraph('tail');
      expect(handle.getModelForTest().blocks['m1']).toEqual({
        id: 'm1',
        type: 'froglight.math',
        source: 'x^2',
      });
      expect(handle.getModelForTest().blocks['d1']).toEqual({
        id: 'd1',
        type: 'froglight.diagram',
        source: 'graph TD; A-->B',
      });
      expect(handle.execCommand('undo')).toBe(true);
      expect(handle.getModelForTest()).toEqual(
        latest as unknown as BlockPageModel,
      );
      expect(handle.getModelForTest().blocks['m1']).toEqual({
        id: 'm1',
        type: 'froglight.math',
        source: 'x^2',
      });
      expect(handle.revealAddress!('m1')).toBe(true);
      expect(handle.revealAddress!('missing')).toBe(false);
    } finally {
      handle.destroy();
    }
  });
});

// --- engine-owned source overlay ---
//
// Drive-first harness pins (no endless suites): open/type/commit/cancel,
// Enter-commit/Esc-dismiss with selection preserved (mousedown
// preventDefault), byte-cap refusal without renderer touch, single
// closeHistory commit via the semantic control, sandboxed failure-as-value
// preview, lazy settled render, 44px + focus return, headless fallback.

describe('math/diagram source overlay (drive-first)', () => {
  function overlayHost(): { host: HTMLElement; cleanup: () => void } {
    const host = document.createElement('div');
    host.className = 'flbp-host';
    document.body.appendChild(host);
    return {
      host,
      cleanup: () => {
        closeMathDiagramOverlay(host);
        host.remove();
      },
    };
  }

  it('opens anchored with slash-chrome semantics; mousedown preserves selection except in inputs', () => {
    const { host, cleanup } = overlayHost();
    try {
      const anchor = document.createElement('figure');
      anchor.setAttribute('data-flbp-math', '');
      host.appendChild(anchor);
      let commits = 0;
      const handle = openMathDiagramOverlay(
        host,
        anchor,
        { kind: 'math', blockId: 'm1', initialSource: 'x^2' },
        { onCommit: () => ((commits += 1), true) },
      );
      expect(handle).not.toBeNull();
      expect(isMathDiagramOverlayOpen(host)).toBe(true);
      const el = host.querySelector('.flbp-md-overlay') as HTMLElement;
      expect(el.getAttribute('role')).toBe('dialog');
      // Live caret anchoring: absolute position resolved to px near the anchor.
      expect(el.style.left).toMatch(/px$/);
      expect(el.style.top).toMatch(/px$/);
      expect(handle!.textarea.value).toBe('x^2');
      // Chrome mousedown is cancelled (PM selection preserved) …
      const chromeDown = new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
      });
      el.dispatchEvent(chromeDown);
      expect(chromeDown.defaultPrevented).toBe(true);
      // … but textarea/buttons keep default focus/activation.
      const editorDown = new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
      });
      handle!.textarea.dispatchEvent(editorDown);
      expect(editorDown.defaultPrevented).toBe(false);
      const saveDown = new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
      });
      handle!.saveButton.dispatchEvent(saveDown);
      expect(saveDown.defaultPrevented).toBe(false);
      expect(commits).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('Enter commits once via math.source with single undo; Esc returns focus without mutation', async () => {
    __setMathDiagramTestHooks({ math: okMathStub, debounceMs: 0 });
    const env = mount(modelWithMath('a'));
    try {
      expect(command(env, 'select-block', { blockId: 'm1' })).toBe(true);
      const host = env.parent.querySelector('.flbp-host') as HTMLElement;
      const anchor = env.mathFigure()!;
      const focusedBefore = document.activeElement as HTMLElement | null;
      let commitCalls = 0;
      const overlay = openMathDiagramOverlay(
        host,
        anchor,
        { kind: 'math', blockId: 'm1', initialSource: 'a' },
        {
          // The handle owns the single undo event; the overlay calls the
          // semantic control at most once.
          onCommit: (source) => {
            commitCalls += 1;
            expect(command(env, 'select-block', { blockId: 'm1' })).toBe(true);
            return toolsOf(env).execute('math.source', source);
          },
        },
      );
      expect(overlay).not.toBeNull();
      overlay!.textarea.value = 'x^2';
      overlay!.textarea.dispatchEvent(new Event('input', { bubbles: true }));
      // Enter (no Shift) commits.
      overlay!.textarea.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(commitCalls).toBe(1);
      expect(isMathDiagramOverlayOpen(host)).toBe(false);
      expect(env.handle.getModelForTest!().blocks['m1']).toEqual({
        id: 'm1',
        type: 'froglight.math',
        source: 'x^2',
      });
      // One closeHistory commit: a single undo restores the pre-commit source.
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!().blocks['m1']).toEqual({
        id: 'm1',
        type: 'froglight.math',
        source: 'a',
      });
      // Second Enter after close is a no-op (no double commit).
      overlay!.textarea.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(commitCalls).toBe(1);

      // Esc dismisses without mutation and returns focus.
      expect(command(env, 'select-block', { blockId: 'm1' })).toBe(true);
      let dismissed = 0;
      const overlay2 = openMathDiagramOverlay(
        host,
        anchor,
        { kind: 'math', blockId: 'm1', initialSource: 'a' },
        {
          onCommit: () => {
            throw new Error('dismiss must not commit');
          },
          onDismiss: () => {
            dismissed += 1;
          },
        },
      );
      expect(overlay2).not.toBeNull();
      overlay2!.textarea.value = 'changed';
      overlay2!.textarea.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(dismissed).toBe(1);
      expect(isMathDiagramOverlayOpen(host)).toBe(false);
      expect(env.handle.getModelForTest!().blocks['m1']).toEqual({
        id: 'm1',
        type: 'froglight.math',
        source: 'a',
      });
      expect(focusedBefore).not.toBeNull();
    } finally {
      env.cleanup();
    }
  });

  it('Shift+Enter keeps a newline; outside pointerdown dismisses without loss', () => {
    const { host, cleanup } = overlayHost();
    try {
      const anchor = document.createElement('figure');
      host.appendChild(anchor);
      let commits = 0;
      let dismissed = 0;
      const handle = openMathDiagramOverlay(
        host,
        anchor,
        { kind: 'diagram', blockId: 'd1', initialSource: 'graph TD; A-->B' },
        {
          onCommit: () => ((commits += 1), true),
          onDismiss: () => {
            dismissed += 1;
          },
        },
      );
      expect(handle).not.toBeNull();
      const before = handle!.textarea.value;
      handle!.textarea.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(commits).toBe(0);
      expect(isMathDiagramOverlayOpen(host)).toBe(true);
      expect(handle!.textarea.value).toBe(before);
      // Outside pointerdown dismisses (no preventDefault — scroll unaffected).
      document.body.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, cancelable: true }),
      );
      expect(dismissed).toBe(1);
      expect(commits).toBe(0);
      expect(isMathDiagramOverlayOpen(host)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('over-cap source refuses commit, disables Save, and never touches a renderer', async () => {
    let calls = 0;
    __setMathDiagramTestHooks({
      math: async () => {
        calls += 1;
        return okMathStub();
      },
      debounceMs: 0,
    });
    const { host, cleanup } = overlayHost();
    try {
      const huge = 'x'.repeat(MAX_MATH_DIAGRAM_SOURCE_BYTES + 1);
      let commits = 0;
      const handle = openMathDiagramOverlay(
        host,
        null,
        { kind: 'math', blockId: 'm1', initialSource: huge },
        { onCommit: () => ((commits += 1), true) },
      );
      expect(handle).not.toBeNull();
      await waitFor(() => handle!.status.textContent !== '');
      expect(handle!.status.textContent).toBe(
        'LaTeX math source exceeds the 64 KB preview cap and was not rendered. It is preserved.',
      );
      expect(handle!.saveButton.disabled).toBe(true);
      expect(calls).toBe(0);
      // Commit refuses with the overlay kept open (no loss).
      handle!.textarea.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(commits).toBe(0);
      expect(isMathDiagramOverlayOpen(host)).toBe(true);
      handle!.saveButton.click();
      expect(commits).toBe(0);
      expect(isMathDiagramOverlayOpen(host)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('invalid source previews failure-as-value with no exception leak; hostile output stays inert', async () => {
    __setMathDiagramTestHooks({
      math: async () => ({ ok: false, error: 'invalid-source' }),
      diagram: async () => ({
        ok: true,
        html: '<span class="stub">t</span><script>alert(1)</script><a href="javascript:alert(1)" onclick="evil()">x</a>',
      }),
      debounceMs: 0,
    });
    const { host, cleanup } = overlayHost();
    try {
      const bad = openMathDiagramOverlay(
        host,
        null,
        { kind: 'math', blockId: 'm1', initialSource: '\\oops{' },
        { onCommit: () => true },
      );
      expect(bad).not.toBeNull();
      await waitFor(() => bad!.status.textContent !== '');
      expect(bad!.status.textContent).toBe(
        'LaTeX math could not be rendered. The source is preserved below.',
      );
      expect(bad!.preview.innerHTML).not.toContain('ParseError');
      closeMathDiagramOverlay(host);
      expect(isMathDiagramOverlayOpen(host)).toBe(false);

      const hostile = openMathDiagramOverlay(
        host,
        null,
        { kind: 'diagram', blockId: 'd1', initialSource: 'graph TD; A-->B' },
        { onCommit: () => true },
      );
      expect(hostile).not.toBeNull();
      await waitFor(() => hostile!.preview.innerHTML !== '');
      expect(hostile!.preview.querySelector('script')).toBeNull();
      expect(hostile!.preview.querySelector('[onclick]')).toBeNull();
      expect(hostile!.preview.innerHTML).not.toContain('javascript:');
      expect(hostile!.preview.querySelector('.stub')).not.toBeNull();
      // Sandbox host marker survives.
      expect(hostile!.preview.classList.contains('flbp-md-sandbox')).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('settled overlay previews render once: rapid typing collapses to a single render', async () => {
    const seen: string[] = [];
    __setMathDiagramTestHooks({
      math: async (source: string) => {
        seen.push(source);
        return okMathStub();
      },
    });
    expect(MATH_DIAGRAM_SETTLE_MS).toBeGreaterThan(0);
    const { host, cleanup } = overlayHost();
    try {
      const handle = openMathDiagramOverlay(
        host,
        null,
        { kind: 'math', blockId: 'm1', initialSource: 'a' },
        { onCommit: () => true },
      );
      expect(handle).not.toBeNull();
      // Rapid keystrokes reschedule one settled preview (lazy, not per keystroke).
      handle!.textarea.value = 'b';
      handle!.textarea.dispatchEvent(new Event('input', { bubbles: true }));
      handle!.textarea.value = 'c';
      handle!.textarea.dispatchEvent(new Event('input', { bubbles: true }));
      await waitFor(() => handle!.preview.innerHTML !== '');
      await flush(MATH_DIAGRAM_SETTLE_MS + 50);
      expect(seen).toEqual(['c']);
    } finally {
      cleanup();
    }
  });

  it('touch contract holds: 44px coarse actions, manipulation only, scroll keeps the overlay open', async () => {
    const css = fs.readFileSync(
      path.resolve(__dirname, 'styles/prose-mirror.css'),
      'utf8',
    );
    // Coarse 44px targets for overlay actions + editor floor.
    expect(css).toMatch(
      /\.flbp-md-action\s*\{[^}]*touch-action:\s*manipulation/,
    );
    expect(css).toMatch(/min-height:\s*44px/);
    // The overlay container never disables touch scrolling on the page.
    const overlayBlocks = [
      ...css.matchAll(/\.flbp-md-overlay\s*\{[^}]*\}/g),
    ].map((m) => m[0]);
    expect(overlayBlocks.length).toBeGreaterThan(0);
    for (const block of overlayBlocks) {
      expect(block).not.toMatch(/touch-action\s*:\s*none/);
    }
    expect(css).toMatch(
      /\.flbp-md-overlay\s*\{[^}]*overscroll-behavior:\s*contain/,
    );
    // --fl-* only on overlay selectors (no hardcoded palette).
    const overlayCss = css
      .split('/* Slash menu. */')[0]
      ?.split('.flbp-md-status')[1];
    expect(overlayCss ?? '').not.toMatch(/var\(\s*--(?!fl-)/);
    expect(
      overlayCss?.replace(/url\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\)/g, 'url()') ??
        '',
    ).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);

    // Live overlay survives host scroll (passive reposition, no dismiss).
    const { host, cleanup } = overlayHost();
    try {
      const anchor = document.createElement('figure');
      host.appendChild(anchor);
      const handle = openMathDiagramOverlay(
        host,
        anchor,
        { kind: 'math', blockId: 'm1', initialSource: 'x' },
        { onCommit: () => true },
      );
      expect(handle).not.toBeNull();
      host.dispatchEvent(new Event('scroll', { bubbles: true }));
      expect(isMathDiagramOverlayOpen(host)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('headless/detached fallback returns null without throw; canonical stays intact', () => {
    // Detached host refuses (fallback to the semantic control).
    const detached = document.createElement('div');
    expect(
      openMathDiagramOverlay(
        detached,
        null,
        { kind: 'math', blockId: 'm1', initialSource: 'x' },
        { onCommit: () => true },
      ),
    ).toBeNull();
    // ReadOnly refuses without mutation.
    const { host, cleanup } = overlayHost();
    try {
      expect(
        openMathDiagramOverlay(
          host,
          null,
          { kind: 'math', blockId: 'm1', initialSource: 'x', readOnly: true },
          { onCommit: () => true },
        ),
      ).toBeNull();
      expect(isMathDiagramOverlayOpen(host)).toBe(false);
      // Closing when none is open is a no-op (never throws).
      expect(() => closeMathDiagramOverlay(host)).not.toThrow();
    } finally {
      cleanup();
    }
    // Headless canonical still round-trips (existing replaceability path).
    const m = emptyBlockPage();
    m.rootOrder = ['m1'];
    m.blocks = { m1: mathRecord('m1', 'x^2') };
    const handle = new HeadlessBlockpageEditorHandle({
      session: {} as never,
      parent: {} as never,
      initialModel: m,
      onDirtyModel: () => undefined,
    });
    try {
      expect(handle.getModelForTest().blocks['m1']).toEqual({
        id: 'm1',
        type: 'froglight.math',
        source: 'x^2',
      });
    } finally {
      handle.destroy();
    }
  });

  it('slash math/diagram still commits with the overlay closed (no regression)', async () => {
    const env = mount(blank());
    try {
      expect(isMathDiagramOverlayOpen(env.parent)).toBe(false);
      type(env, '/math');
      await flush();
      const items = [
        ...(env.parent
          .querySelector('.flbp-slash:not(.flbp-resource-menu)')
          ?.querySelectorAll('.flbp-slash-item') ?? []),
      ].map((el) => el.textContent);
      expect(items).toEqual(['Math']);
      key(env, 'Enter');
      const next = env.latest()!;
      const insertedId = next.rootOrder[1]!;
      expect(next.blocks[insertedId]).toEqual({
        id: insertedId,
        type: 'froglight.math',
        source: '',
      });
    } finally {
      env.cleanup();
    }
  });
});
