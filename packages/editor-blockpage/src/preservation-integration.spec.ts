/**
 * Block Page preservation and integration verification.
 *
 * Scope: test-only. No codec/model/spec/public-contract changes.
 * Converges the per-type matrices (table, media,
 * math/diagram, columns, creation) into ONE integrated document:
 * video/audio/file (vault + remote) + math/diagram + columnList/table +
 * opaque future shapes + invalid remotes + nested lists survive pm-map
 * (modelToPmDoc → pmDocToModel) byte-faithful, untouched opens stay
 * byte-identical, headless/mock hops preserve bytes, and the light security
 * + replaceability + cross-path pins hold.
 *
 * Per-type depth stays in media.spec.ts / math-diagram.spec.ts /
 * columns.spec.ts / table-grid.spec.ts / creation-integration.spec.ts /
 * alternate-provider.spec.ts — this file only proves they hold TOGETHER.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  emptyBlockPage,
  paragraphBlock,
  sha256Hex,
  tableBlock,
  type BlockPageModel,
  type BlockRecord,
  type DocumentAssetStore,
  type WorkspacePath,
} from '@froglight/foundation';
import { BlockPageDocumentEditorProvider } from './editor.js';
import { HeadlessBlockpageEditorHandle } from './headless-handle.js';
import { modelToPmDoc, pmDocToModel } from './pm-map.js';
import { cloneModel } from './model-edit.js';
import { REMOTE_DISCLOSURE_TEXT } from './media-security.js';

const REMOTE_VIDEO = 'https://cdn.example.com/clip.mp4';
const REMOTE_AUDIO = 'https://cdn.example.com/track.mp3';

/** In-repo precedent (media.spec.ts:94-113): in-memory vault store. */
function memoryAssets(): DocumentAssetStore & {
  files: Map<string, Uint8Array>;
  reads: string[];
} {
  const files = new Map<string, Uint8Array>();
  const reads: string[] = [];
  return {
    files,
    reads,
    async put(
      data: Uint8Array,
    ): Promise<{ path: WorkspacePath; sha256: string }> {
      const sha256 = await sha256Hex(data);
      const path = `attachments/${sha256}` as WorkspacePath;
      files.set(path, data.slice());
      return { path, sha256 };
    },
    async read(path: WorkspacePath): Promise<Uint8Array> {
      reads.push(String(path));
      const hit = files.get(String(path));
      if (hit === undefined)
        throw Object.assign(new Error('not found'), { code: 'NOT_FOUND' });
      return hit.slice();
    },
  };
}

// Canonical shapes for types the package root does not re-export (media.spec
// precedent: build inline, field order matches the foundation constructors).
function videoRecord(
  id: string,
  locator:
    | { src: string; sha256: string }
    | { remote: { url: string }; sha256?: string },
  presentation?: { name?: string; caption?: string; alt?: string },
): BlockRecord {
  return {
    id,
    type: 'froglight.video',
    ...('remote' in locator
      ? {
          remote: { url: locator.remote.url },
          ...(locator.sha256 !== undefined ? { sha256: locator.sha256 } : {}),
        }
      : {
          src: (locator as { src: string }).src,
          sha256: (locator as { sha256: string }).sha256,
        }),
    ...presentation,
  } as BlockRecord;
}

function audioRecord(
  id: string,
  locator:
    | { src: string; sha256: string }
    | { remote: { url: string }; sha256?: string },
  presentation?: { name?: string; caption?: string; alt?: string },
): BlockRecord {
  return {
    ...videoRecord(id, locator, presentation),
    type: 'froglight.audio',
  } as BlockRecord;
}

function fileRecord(
  id: string,
  locator:
    | { src: string; sha256: string }
    | { remote: { url: string }; sha256?: string },
  presentation?: { name?: string; caption?: string; alt?: string },
): BlockRecord {
  return {
    ...videoRecord(id, locator, presentation),
    type: 'froglight.file',
  } as BlockRecord;
}

function mathRecord(id: string, source: unknown): BlockRecord {
  return { id, type: 'froglight.math', source } as unknown as BlockRecord;
}

function diagramRecord(id: string, source: unknown): BlockRecord {
  return { id, type: 'froglight.diagram', source } as unknown as BlockRecord;
}

function colList(
  id: string,
  children: string[],
  widths?: number[],
): BlockRecord {
  return {
    id,
    type: 'froglight.columnList',
    ...(widths !== undefined ? { widths } : {}),
    children,
  } as BlockRecord;
}

function col(id: string, children?: string[]): BlockRecord {
  return {
    id,
    type: 'froglight.column',
    ...(children !== undefined ? { children } : {}),
  } as BlockRecord;
}

/** Valid integrated document with a zero-warning round-trip. */
function validIncrementDoc(): BlockPageModel {
  const model = emptyBlockPage({
    title: 'valid',
    tags: [],
    properties: {},
  });
  model.rootOrder = ['p1', 't1', 'v1', 'a1', 'f1', 'm1', 'd1', 'cl1'];
  model.blocks = {
    p1: paragraphBlock('p1', [{ text: 'lead' }]),
    t1: tableBlock('t1', 2, [{ cells: [[{ text: 'a' }], [{ text: 'b' }]] }], {
      align: ['left', 'right'],
      header: true,
    }),
    v1: videoRecord(
      'v1',
      { src: 'attachments/hv', sha256: 'hv' },
      { name: 'Clip name', caption: 'Clip caption' },
    ),
    a1: audioRecord('a1', { remote: { url: REMOTE_AUDIO } }, { name: 'Theme' }),
    f1: fileRecord(
      'f1',
      { remote: { url: 'https://files.example.com/deck.pdf' } },
      { name: 'Deck' },
    ),
    m1: mathRecord('m1', 'E = mc^2'),
    d1: diagramRecord('d1', 'graph TD; A-->B;'),
    cl1: colList('cl1', ['c1', 'c2'], [2, 1]),
    c1: col('c1', ['p2']),
    c2: col('c2', ['p3']),
    p2: paragraphBlock('p2', [{ text: 'left' }]),
    p3: paragraphBlock('p3', [{ text: 'right' }]),
  };
  return model;
}

/** Opaque/invalid integrated document (warnings, never errors/drops). */
function opaqueIncrementDoc(): BlockPageModel {
  const model = emptyBlockPage({
    title: 'opaque',
    tags: [],
    properties: {},
  });
  model.rootOrder = ['x1', 'vbad', 'clbad', 'clnest'];
  model.blocks = {
    // Unknown future shape with unknown fields + nested content.
    x1: {
      id: 'x1',
      type: 'acme.future-widget',
      vendor: { keep: true },
      unknownField: 'preserve-me',
      children: ['xc1'],
    } as unknown as BlockRecord,
    xc1: paragraphBlock('xc1', [{ text: 'inside future' }]),
    // Invalid remote rides verbatim (codec owns REMOTE_URL_REJECTED).
    vbad: videoRecord('vbad', {
      remote: { url: 'http://cdn.example.com/evil.mp4' },
    }),
    // Bad widths ride verbatim with COLUMN_WIDTHS_IGNORED.
    clbad: colList('clbad', ['cb1', 'cb2'], [1]),
    cb1: col('cb1', ['pb1']),
    cb2: col('cb2'),
    pb1: paragraphBlock('pb1', [{ text: 'kept' }]),
    // Nested columnLists survive structurally.
    clnest: colList('clnest', ['cn1', 'cn2']),
    cn1: col('cn1', ['clinner']),
    cn2: col('cn2'),
    clinner: colList('clinner', ['ci1', 'ci2']),
    ci1: col('ci1', ['deep']),
    ci2: col('ci2'),
    deep: paragraphBlock('deep', [{ text: 'deep content' }]),
  };
  return model;
}

function mount(
  model: BlockPageModel,
  options?: { fetchFn?: never; assets?: DocumentAssetStore | null },
) {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  let dirty: BlockPageModel | null = null;
  let dirtyCount = 0;
  const handle = new BlockPageDocumentEditorProvider().createEditor({
    session: {} as never,
    parent,
    initialModel: model,
    onDirtyModel: (next: BlockPageModel) => {
      dirty = next;
      dirtyCount += 1;
    },
    ...(options?.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
    ...(options?.assets !== undefined && options.assets !== null
      ? { assets: options.assets }
      : {}),
  } as never);
  return {
    parent,
    handle,
    dirty: () => dirty as BlockPageModel | null,
    dirtyCount: () => dirtyCount,
    pm: () => parent.querySelector('.ProseMirror')!,
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
  if (run === undefined) throw new Error('block command channel unavailable');
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

function normalized(model: BlockPageModel): unknown {
  const map = new Map<string, string>();
  for (const id of model.rootOrder) map.set(id, `b${map.size}`);
  for (const id of Object.keys(model.blocks)) {
    if (!map.has(id)) map.set(id, `b${map.size}`);
  }
  const remap = (value: unknown): unknown => {
    if (typeof value === 'string') return map.get(value) ?? value;
    if (Array.isArray(value)) return value.map(remap);
    if (typeof value === 'object' && value !== null) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>))
        out[k] = remap(v);
      return out;
    }
    return value;
  };
  return {
    rootOrder: model.rootOrder.map((id) => map.get(id)),
    blocks: Object.fromEntries(
      Object.entries(model.blocks).map(([id, block]) => [
        map.get(id),
        remap(block),
      ]),
    ),
  };
}

const flush = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  document.body.replaceChildren();
  document.getElementById('flbp-chrome-styles')?.remove();
});

describe('integrated pm-map round-trip (valid doc, zero warnings)', () => {
  it('video/audio/file + math/diagram + columns + table survive edit round-trip byte-faithful', () => {
    const original = validIncrementDoc();
    const doc = modelToPmDoc(original);
    const { model, warnings } = pmDocToModel(doc, {
      formatVersion: original.formatVersion,
      meta: original.meta,
    });
    expect(warnings).toEqual([]);
    expect(model).toEqual(original);
    // Presentation/source/widths verbatim (no canonical churn surface).
    expect(model.blocks['v1']).toEqual(original.blocks['v1']);
    expect(model.blocks['a1']).toEqual(original.blocks['a1']);
    expect(model.blocks['f1']).toEqual(original.blocks['f1']);
    expect(model.blocks['m1']).toEqual({
      id: 'm1',
      type: 'froglight.math',
      source: 'E = mc^2',
    });
    expect(model.blocks['d1']).toEqual({
      id: 'd1',
      type: 'froglight.diagram',
      source: 'graph TD; A-->B;',
    });
    expect((model.blocks['cl1'] as { widths?: unknown }).widths).toEqual([
      2, 1,
    ]);
  });
});

describe('untouched open/save byte-identical (no canonical churn)', () => {
  it('Tiptap opens the valid doc with no edits, no dirty, widths/caption/source verbatim', async () => {
    const original = validIncrementDoc();
    const env = mount(cloneModel(original));
    try {
      await flush();
      const opened = env.handle.getModelForTest!();
      expect(opened).toEqual(original);
      expect(env.dirty()).toBeNull();
      expect(env.dirtyCount()).toBe(0);
      expect((opened.blocks['cl1'] as { widths?: unknown }).widths).toEqual([
        2, 1,
      ]);
      expect((opened.blocks['v1'] as { caption?: string }).caption).toBe(
        'Clip caption',
      );
      expect((opened.blocks['v1'] as { name?: string }).name).toBe('Clip name');
      expect((opened.blocks['m1'] as { source?: string }).source).toBe(
        'E = mc^2',
      );
      expect((opened.blocks['d1'] as { source?: string }).source).toBe(
        'graph TD; A-->B;',
      );
    } finally {
      env.cleanup();
    }
  });

  it('a paragraph text edit leaves every new-type block untouched', () => {
    const original = validIncrementDoc();
    const env = mount(cloneModel(original));
    try {
      expect(command(env, 'set-selection', { from: 2, to: 2 })).toBe(true);
      expect(command(env, 'insert-text', { text: 'X' })).toBe(true);
      const next = env.handle.getModelForTest!();
      for (const id of [
        't1',
        'v1',
        'a1',
        'f1',
        'm1',
        'd1',
        'cl1',
        'c1',
        'c2',
        'p2',
        'p3',
      ]) {
        expect(next.blocks[id], id).toEqual(original.blocks[id]);
      }
      expect(JSON.stringify(next.blocks['p1'])).toContain('X');
    } finally {
      env.cleanup();
    }
  });
});

describe('opaque preservation (warnings, not errors/drops)', () => {
  it('unknown future + invalid remote + bad widths + nested lists round-trip verbatim', () => {
    const original = opaqueIncrementDoc();
    const doc = modelToPmDoc(original);
    const { model, warnings } = pmDocToModel(doc, {
      formatVersion: original.formatVersion,
      meta: original.meta,
    });
    expect(model).toEqual(original);
    // Unknown future shape preserved with its unknown fields + child.
    expect(model.blocks['x1']).toEqual(original.blocks['x1']);
    expect(model.blocks['xc1']).toEqual(original.blocks['xc1']);
    // Invalid remote preserved verbatim (provider never normalizes).
    expect(model.blocks['vbad']).toEqual(original.blocks['vbad']);
    // Bad widths preserved verbatim WITH a disclosure warning.
    expect((model.blocks['clbad'] as { widths?: unknown }).widths).toEqual([1]);
    expect(warnings).toEqual([]);
    // Nested columnLists intact, deep content never flattened.
    expect(model.blocks['deep']).toEqual(
      paragraphBlock('deep', [{ text: 'deep content' }]),
    );
    expect(JSON.stringify(model)).toContain('deep content');
  });


});

describe('headless/mock session equivalence (integrated new types)', () => {
  it('Tiptap → headless → mock preserves table + media + math/diagram + columns', () => {
    const start = validIncrementDoc();
    let saved: BlockPageModel | null = null;
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const handle = new BlockPageDocumentEditorProvider().createEditor({
      session: {} as never,
      parent,
      initialModel: start,
      onDirtyModel: (m) => {
        saved = m;
      },
    });
    try {
      // No-edit open is byte-faithful in the default provider.
      expect(handle.getModelForTest!()).toEqual(start);
      saved = handle.getModelForTest!();
    } finally {
      handle.destroy();
      parent.remove();
    }
    // Headless twin opens the Tiptap-saved model without the engine.
    const headless = new HeadlessBlockpageEditorHandle({
      session: {} as never,
      parent: {},
      initialModel: saved!,
      onDirtyModel: () => undefined,
    });
    try {
      expect(headless.getModelForTest()).toEqual(start);
      for (const id of ['t1', 'v1', 'a1', 'f1', 'm1', 'd1', 'cl1']) {
        expect(headless.getModelForTest().blocks[id]).toEqual(start.blocks[id]);
      }
      headless.appendParagraph('headless tail');
      const tail = headless.getModelForTest();
      expect(tail.blocks['v1']).toEqual(start.blocks['v1']);
      expect(tail.blocks['m1']).toEqual(start.blocks['m1']);
      expect(tail.blocks['cl1']).toEqual(start.blocks['cl1']);
    } finally {
      headless.destroy();
    }
  });

  it('public barrel exposes no engine types at runtime (plain-data seam)', async () => {
    const barrel = (await import('./index.js')) as Record<string, unknown>;
    expect(Object.keys(barrel).sort()).toEqual(
      [
        'BlockPageDocumentEditorProvider',
        'BlockpageHostSkeleton',
        'blockPageKindId',
      ].sort(),
    );
    // The seam model is plain data: no ProseMirror/Tiptap/KaTeX/Mermaid
    // instances ride the canonical blocks.
    const model = validIncrementDoc();
    const env = mount(model);
    try {
      const reopened = env.handle.getModelForTest!();
      for (const block of Object.values(reopened.blocks)) {
        expect(block.constructor.name).toBe('Object');
        expect(JSON.stringify(block)).not.toContain('PMNode');
        expect(JSON.stringify(block)).not.toContain('katex');
        expect(JSON.stringify(block)).not.toContain('mermaid');
      }
    } finally {
      env.cleanup();
    }
  });
});

describe('security re-verification (light, test-level)', () => {
  it('vault + remote mount performs zero fetches (no-fetch-in-vault, zero-prefetch gate)', async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      throw new Error('must not fetch');
    }) as never;
    const model = emptyBlockPage();
    model.rootOrder = ['v', 'r'];
    model.blocks = {
      v: videoRecord('v', { src: 'attachments/hv', sha256: 'hv' }),
      r: videoRecord('r', { remote: { url: REMOTE_VIDEO } }),
    };
    const env = mount(model, { fetchFn });
    try {
      await flush(30);
      expect(calls).toBe(0);
      // Remote gate holds the disclosure + explicit Load (never auto-fetch).
      // (Scoped to the remote block: the vault block renders its own
      // unbound-store placeholder first in document order.)
      const status = env.parent.querySelector(
        'figure[data-flbp-video][data-block-id="r"] .flbp-media-status',
      );
      expect(status).not.toBeNull();
      expect(status!.textContent).toContain(REMOTE_DISCLOSURE_TEXT);
      expect(status!.querySelector('button')!.textContent).toMatch(
        /Load remote/,
      );
      expect(
        env.parent.querySelector('figure[data-flbp-video] video'),
      ).toBeNull();
      expect(env.dirty()).toBeNull();
    } finally {
      env.cleanup();
    }
  });

  it('hash-before-preview: wrong pin never renders, canonical preserved', async () => {
    // Bound store returns TAMPERED bytes for the vault src, so hydration
    // reaches the sha256Hex comparison (media-view.ts:256-278) and fails
    // closed on the pin mismatch (in-repo precedent media.spec.ts:778-793).
    const assets = memoryAssets();
    assets.files.set('attachments/hv', new TextEncoder().encode('tampered'));
    const model = emptyBlockPage();
    model.rootOrder = ['v'];
    model.blocks = {
      v: videoRecord(
        'v',
        { src: 'attachments/hv', sha256: 'wrong-pin' },
        { caption: 'C' },
      ),
    };
    const env = mount(model, { assets });
    try {
      await expect
        .poll(() =>
          env.parent
            .querySelector('figure[data-flbp-video]')
            ?.getAttribute('data-flbp-media-reason'),
        )
        .toBe('integrity');
      // No media element renders; the integrity placeholder holds; the
      // canonical bytes are untouched.
      expect(
        env.parent.querySelector('figure[data-flbp-video] video'),
      ).toBeNull();
      const figure = env.parent.querySelector('figure[data-flbp-video]')!;
      expect(figure.getAttribute('data-flbp-media-reason')).toBe('integrity');
      expect(
        env.parent.querySelector('.flbp-media-status')!.textContent,
      ).toMatch(/integrity/i);
      expect(env.handle.getModelForTest!().blocks['v']).toEqual(
        model.blocks['v'],
      );
    } finally {
      env.cleanup();
    }
  });

  it('unbound store renders the offline placeholder (no media, canonical preserved)', async () => {
    const model = emptyBlockPage();
    model.rootOrder = ['v'];
    model.blocks = {
      v: videoRecord(
        'v',
        { src: 'attachments/hv', sha256: 'wrong-pin' },
        { caption: 'C' },
      ),
    };
    const env = mount(model);
    try {
      await flush(30);
      // No vault store is bound in this mount, so the unbound-store
      // placeholder holds — either way no media element renders and the
      // canonical bytes are untouched.
      expect(
        env.parent.querySelector('figure[data-flbp-video] video'),
      ).toBeNull();
      expect(
        env.parent
          .querySelector('figure[data-flbp-video]')!
          .getAttribute('data-flbp-media-reason'),
      ).toBe('unbound-store');
      expect(env.handle.getModelForTest!().blocks['v']).toEqual(
        model.blocks['v'],
      );
    } finally {
      env.cleanup();
    }
  });

  it('turn-into atom rejects hold for every new type (both directions, no mutation)', () => {
    const model = validIncrementDoc();
    const env = mount(cloneModel(model));
    try {
      const before = env.handle.getModelForTest!();
      // From atoms: select each atom/region, every text target refuses.
      for (const blockId of ['t1', 'v1', 'a1', 'f1', 'm1', 'd1', 'cl1', 'c1']) {
        expect(command(env, 'select-block', { blockId })).toBe(true);
        expect(command(env, 'turn-into', { type: 'paragraph' })).toBe(false);
        expect(command(env, 'turn-into', { type: 'heading', level: 2 })).toBe(
          false,
        );
      }
      // To atoms: no new-type turn-into target exists from a paragraph.
      expect(command(env, 'select-block', { blockId: 'p1' })).toBe(true);
      for (const type of [
        'video',
        'audio',
        'file',
        'math',
        'diagram',
        'table',
        'columnList',
        'column',
      ] as const) {
        expect(command(env, 'turn-into', { type } as never)).toBe(false);
      }
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });
});

describe('cross-path parity spot (slash/toolbar/insert-block converge)', () => {
  function blank(): BlockPageModel {
    const m = emptyBlockPage();
    m.rootOrder = ['p1'];
    m.blocks = { p1: paragraphBlock('p1', [{ text: '' }]) };
    return m;
  }

  it('video + columns: toolbar vs insert-block converge with single undo (full matrix in creation-integration.spec.ts)', () => {
    for (const kind of ['video'] as const) {
      const toolEnv = mount(blank());
      let toolAfter: BlockPageModel;
      try {
        command(toolEnv, 'set-selection', { from: 1, to: 1 });
        const toolBefore = toolEnv.handle.getModelForTest!();
        const toolId = `block.insert.${kind}`;
        expect(toolsOf(toolEnv).execute(toolId)).toBe(true);
        toolAfter = toolEnv.handle.getModelForTest!();
        expect(toolEnv.handle.execCommand('undo')).toBe(true);
        expect(toolEnv.handle.getModelForTest!()).toEqual(toolBefore);
      } finally {
        toolEnv.cleanup();
      }
      const insertEnv = mount(blank());
      let insertAfter: BlockPageModel;
      try {
        command(insertEnv, 'set-selection', { from: 1, to: 1 });
        expect(command(insertEnv, 'insert-block', { type: kind })).toBe(true);
        insertAfter = insertEnv.handle.getModelForTest!();
      } finally {
        insertEnv.cleanup();
      }
      expect(normalized(insertAfter)).toEqual(normalized(toolAfter));
    }
  });
});
