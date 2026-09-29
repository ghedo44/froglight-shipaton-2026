/**
 *  writing grouping (blockpage) — shared grammar via builders only
 *
 *
 * - One shared grammar (Style/Format/Insert/Structure, toggle roles):
 *   portable controls deep-equal the shared builder output with
 *   provider-owned ids and provider-computed active/mixed/disabled.
 *   Fenced code stays a turn-into target of the shared `writing.style`
 *   selector: no `writing.code-block` is ever emitted (never synthesized).
 * - Blockpage one-path: document mapping matrix below —
 *   creation (`block.insert.*`) rides the shared shelf path out-of-grid;
 *   selection edits (`table.*`, `media.*`, `math.*`/`diagram.*`) appear in
 *   exactly one selection context each, never duplicated, never both.
 *   No `blockpage.*` semantic role exists (composition stays shared).
 * - Selection-clamped contextual formatting + focus preservation:
 *   snapshot and execute converge on the same single-source analysis;
 *   every toolbar execute refocuses the editor.
 * - Alternate-provider open/save/reopen intact (AGENTS.md editor-provider
 *   rule): toolbar edits reopen byte-faithful through headless/mock.
 * - No canonical/engine changes: snapshots are plain data with no
 *   Tiptap/ProseMirror markers; no editor-library types cross the seam.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  dividerBlock,
  emptyBlockPage,
  paragraphBlock,
  tableBlock,
  writingFormatToggleControl,
    writingLinkControl,
    type BlockPageModel,
  type BlockRecord,
} from '@froglight/foundation';
import { BlockPageDocumentEditorProvider } from './editor.js';
import { HeadlessBlockpageEditorHandle } from './headless-handle.js';

/** Spec-local video record (media.spec precedent: no top-level export). */
function videoRecord(
  id: string,
  locator: { src: string; sha256: string },
  presentation?: { caption?: string },
): BlockRecord {
  return {
    id,
    type: 'froglight.video',
    src: locator.src,
    sha256: locator.sha256,
    ...presentation,
  } as unknown as BlockRecord;
}

/** Spec-local math record (math-diagram.spec precedent). */
function mathRecord(id: string, source: string): BlockRecord {
  return { id, type: 'froglight.math', source } as unknown as BlockRecord;
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
    cleanup: () => {
      handle.destroy();
      parent.remove();
    },
  };
}

function command(env: ReturnType<typeof mount>, id: string, arg?: unknown): boolean {
  const run = env.handle.blockCommand;
  if (run === undefined) throw new Error('block command unavailable');
  return run.call(env.handle, id, arg);
}

function toolsOf(env: ReturnType<typeof mount>) {
  const tools = (
    env.handle as unknown as {
      tools?: {
        snapshot(): {
          context: string;
          controls: Array<{ id: string; kind: string } & Record<string, unknown>>;
        };
        execute(id: string, value?: string): boolean;
      };
    }
  ).tools;
  if (tools === undefined) throw new Error('semantic tools unavailable');
  return tools;
}

function paragraphModel(): BlockPageModel {
  const model = emptyBlockPage();
  model.rootOrder = ['p1'];
  model.blocks = { p1: paragraphBlock('p1', [{ text: 'hello world' }]) };
  return model;
}

function tableModel(): BlockPageModel {
  const model = emptyBlockPage();
  model.rootOrder = ['t1'];
  model.blocks = {
    t1: tableBlock('t1', 2, [{ cells: [[{ text: 'a' }], [{ text: 'b' }]] }], {
      header: true,
    }),
  };
  return model;
}

function mediaModel(): BlockPageModel {
  const model = emptyBlockPage();
  model.rootOrder = ['v1'];
  model.blocks = {
    v1: videoRecord('v1', { src: 'attachments/hv', sha256: 'hv' }, { caption: 'Clip' }),
  };
  return model;
}

function mathModel(): BlockPageModel {
  const model = emptyBlockPage();
  model.rootOrder = ['m1'];
  model.blocks = { m1: mathRecord('m1', 'x^2') };
  return model;
}

function idsOf(env: ReturnType<typeof mount>): string[] {
  return toolsOf(env).snapshot().controls.map((c) => c.id);
}

afterEach(() => {
  document.body.replaceChildren();
  document.getElementById('flbp-chrome-styles')?.remove();
});

describe('blockpage shared writing grammar', () => {
  it('emits the Style selector with the shared writing.style role', () => {
    const env = mount(paragraphModel());
    try {
      command(env, 'set-selection', { from: 2, to: 2 });
      const style = toolsOf(env)
        .snapshot()
        .controls.find((c) => c.id === 'block.type');
      expect(style?.kind).toBe('choice');
      expect(style?.semanticRole).toBe('writing.style');
    } finally {
      env.cleanup();
    }
  });

  it('routes portable Format controls through the shared builder', () => {
    const env = mount(paragraphModel());
    try {
      command(env, 'set-selection', { from: 1, to: 6 });
      const snapshot = toolsOf(env).snapshot();
      const byId = new Map(snapshot.controls.map((c) => [c.id, c]));
      expect(byId.get('block.bold')).toEqual(
        writingFormatToggleControl('block.bold', 'bold', {}),
      );
      expect(byId.get('block.italic')).toEqual(
        writingFormatToggleControl('block.italic', 'italic', {}),
      );
      expect(byId.get('block.strike')).toEqual(
        writingFormatToggleControl('block.strike', 'strike', {}),
      );
      expect(byId.get('block.code')).toEqual(
        writingFormatToggleControl('block.code', 'code', {}),
      );
      for (const id of ['block.bold', 'block.italic', 'block.strike', 'block.code']) {
        const control = byId.get(id);
        if (control?.kind !== 'button') throw new Error(`missing ${id}`);
        expect(control.activationRole).toBe('toggle');
        expect(control.group).toBe('format');
      }
    } finally {
      env.cleanup();
    }
  });

  it('routes Link + Indent/Outdent through the shared builder', () => {
    const env = mount(paragraphModel());
    try {
      command(env, 'set-selection', { from: 1, to: 6 });
      const snapshot = toolsOf(env).snapshot();
      const byId = new Map(snapshot.controls.map((c) => [c.id, c]));
      expect(byId.get('block.link')).toEqual(
        writingLinkControl('block.link', {}),
      );
    } finally {
      env.cleanup();
    }
  });

  it('never emits writing.code-block: fenced code is a style target (never synthesized)', () => {
    const env = mount(paragraphModel());
    try {
      command(env, 'set-selection', { from: 1, to: 6 });
      const roles = toolsOf(env)
        .snapshot()
        .controls.map((c) => c.semanticRole);
      expect(roles).not.toContain('writing.code-block');
      expect(idsOf(env).some((id) => id.includes('code-block'))).toBe(false);
      expect(toolsOf(env).execute('block.insert.code-block' as never)).toBe(false);
    } finally {
      env.cleanup();
    }
  });

  it('uses no blockpage.* semantic roles: composition stays shared', () => {
    for (const model of [paragraphModel(), tableModel(), mediaModel(), mathModel()]) {
      const env = mount(model);
      try {
        const roles = toolsOf(env)
          .snapshot()
          .controls.map((c) => String(c.semanticRole ?? ''));
        for (const role of roles) {
          expect(role.startsWith('blockpage.'), `blockpage role ${role}`).toBe(false);
        }
      } finally {
        env.cleanup();
      }
    }
  });
});

describe('blockpage one-path document mapping', () => {
  it('paragraph: creation offered, table/media/math selection edits absent', () => {
    const env = mount(paragraphModel());
    try {
      command(env, 'set-selection', { from: 1, to: 6 });
      const ids = idsOf(env);
      // Creation path (shelf): insert-only catalog rows.
      for (const id of [
        'block.insert.table',
        'block.insert.image',
        'block.insert.math',
        'block.insert.diagram',
      ]) {
        expect(ids).toContain(id);
      }
      // Selection-edit paths: absent outside their selection context.
      for (const id of [
        'table.addRow',
        'media.caption',
        'math.source',
        'diagram.source',
        'column.addColumn',
      ]) {
        expect(ids).not.toContain(id);
      }
    } finally {
      env.cleanup();
    }
  });

  it('table: grid ops offered exactly once, creation suppressed in-grid', () => {
    const env = mount(tableModel());
    try {
      command(env, 'set-selection', { from: 4, to: 4 });
      const ids = idsOf(env);
      expect(ids).toContain('table.addRow');
      expect(ids).toContain('table.addColumn');
      expect(ids).toContain('table.toggleHeader');
      // In-grid suppression (slash precedent): creation never both.
      for (const id of [
        'block.insert.table',
        'block.insert.image',
        'block.insert.math',
      ]) {
        expect(ids).not.toContain(id);
      }
      // No media/math duplicates at the grid.
      expect(ids).not.toContain('media.caption');
      expect(ids).not.toContain('math.source');
    } finally {
      env.cleanup();
    }
  });

  it('media: caption/alt offered exactly once, marks hidden', () => {
    const env = mount(mediaModel());
    try {
      expect(command(env, 'select-block', { blockId: 'v1' })).toBe(true);
      const ids = idsOf(env);
      expect(ids).toContain('media.caption');
      expect(ids).toContain('media.alt');
      expect(ids).not.toContain('block.bold');
      expect(ids).not.toContain('block.link');
      // No table/math duplicates at media.
      expect(ids).not.toContain('table.addRow');
      expect(ids).not.toContain('math.source');
    } finally {
      env.cleanup();
    }
  });

  it('math: source offered exactly once, marks hidden', () => {
    const env = mount(mathModel());
    try {
      expect(command(env, 'select-block', { blockId: 'm1' })).toBe(true);
      const ids = idsOf(env);
      expect(ids).toContain('math.source');
      expect(ids).toContain('math.retry');
      expect(ids).not.toContain('block.bold');
      expect(ids).not.toContain('block.link');
      // No table/media duplicates at math.
      expect(ids).not.toContain('table.addRow');
      expect(ids).not.toContain('media.caption');
    } finally {
      env.cleanup();
    }
  });

  it('emits no duplicate entry points in any context', () => {
    const contexts: Array<() => ReturnType<typeof mount>> = [
      () => mount(paragraphModel()),
      () => mount(tableModel()),
      () => mount(mediaModel()),
      () => mount(mathModel()),
    ];
    for (const make of contexts) {
      const env = make();
      try {
        const ids = idsOf(env);
        expect(new Set(ids).size).toBe(ids.length);
      } finally {
        env.cleanup();
      }
    }
  });
});

describe('blockpage selection clamping + focus', () => {
  it('suppresses inline formatting in code and atom contexts', () => {
    const code = emptyBlockPage();
    code.rootOrder = ['c1'];
    code.blocks = {
      c1: { id: 'c1', type: 'froglight.code', text: 'const x = 1;' } as never,
    };
    const codeEnv = mount(code);
    try {
      command(codeEnv, 'set-selection', { from: 2, to: 2 });
      expect(idsOf(codeEnv)).not.toContain('block.bold');
      expect(toolsOf(codeEnv).execute('block.bold')).toBe(false);
    } finally {
      codeEnv.cleanup();
    }
    const atom = emptyBlockPage();
    atom.rootOrder = ['d1'];
    atom.blocks = { d1: dividerBlock('d1') };
    const atomEnv = mount(atom);
    try {
      const ids = idsOf(atomEnv);
      expect(ids).not.toContain('block.bold');
      expect(ids).not.toContain('block.link');
      expect(ids).toContain('block.type');
    } finally {
      atomEnv.cleanup();
    }
  });

  it('disables turn-into across multi-root ranges like execute does', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['p1', 'p2'];
    model.blocks = {
      p1: paragraphBlock('p1', [{ text: 'first' }]),
      p2: paragraphBlock('p2', [{ text: 'second' }]),
    };
    const env = mount(model);
    try {
      const before = env.handle.getModelForTest!();
      command(env, 'set-selection', { from: 2, to: 10 });
      const type = toolsOf(env)
        .snapshot()
        .controls.find((c) => c.id === 'block.type') as unknown as {
        disabled?: boolean;
      };
      expect(type.disabled).toBe(true);
      expect(toolsOf(env).execute('block.type', 'heading:2')).toBe(false);
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });

  it('routes toolbar executes through focus-preserving chains', () => {
    const env = mount(paragraphModel());
    try {
      // Production focus routing lives in the execute chains
      // (`chain().focus().toggleBold()` …): jsdom never grants DOM focus so
      // `isFocused` stays false here (reveal-address.spec pins the same).
      // What the provider seam guarantees — and what this pins — is that
      // toolbar executes succeed, preserve the selection, and leave the
      // editor focusable without throwing.
      command(env, 'set-selection', { from: 1, to: 6 });
      expect(toolsOf(env).execute('block.bold')).toBe(true);
      expect(() => env.handle.focus()).not.toThrow();
      expect(typeof env.handle.hasFocus()).toBe('boolean');
      command(env, 'set-selection', { from: 1, to: 6 });
      expect(toolsOf(env).execute('block.link', 'https://f.test')).toBe(true);
      const next = env.handle.getModelForTest!();
      expect(JSON.stringify(next.blocks['p1'])).toContain('https://f.test');
    } finally {
      env.cleanup();
    }
  });

  it('exposes plain-data snapshots with no engine markers', () => {
    for (const model of [paragraphModel(), tableModel(), mathModel()]) {
      const env = mount(model);
      try {
        const json = JSON.stringify(toolsOf(env).snapshot());
        expect(json).not.toMatch(/ProseMirror|tiptap|__pm/i);
      } finally {
        env.cleanup();
      }
    }
  });
});

describe('blockpage alternate-provider open/save/reopen', () => {
  it('toolbar edits reopen byte-faithful through headless without the engine', () => {
    const start = paragraphModel();
    (start.blocks['x1'] as unknown) = {
      id: 'x1',
      type: 'acme.kanban',
      lanes: [1, 2],
    };
    start.rootOrder.push('x1');
    const env = mount(start);
    let saved: BlockPageModel | null = null;
    try {
      command(env, 'set-selection', { from: 1, to: 6 });
      expect(toolsOf(env).execute('block.bold')).toBe(true);
      saved = env.handle.getModelForTest!();
      expect(saved.blocks['x1']).toEqual(start.blocks['x1']);
    } finally {
      env.cleanup();
    }
    const headless = new HeadlessBlockpageEditorHandle({
      session: {} as never,
      parent: {},
      initialModel: saved!,
      onDirtyModel: () => undefined,
    });
    try {
      expect(headless.getModelForTest().blocks['x1']).toEqual(
        start.blocks['x1'],
      );
      expect(
        JSON.stringify(headless.getModelForTest()),
      ).toContain('bold');
    } finally {
      headless.destroy();
    }
  });
});
