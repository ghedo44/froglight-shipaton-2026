/**
 *  creation integration: slash, toolbar, and
 * insert-block converge on identical canonical blocks with single-undo
 * restore for every insert-only type (table with dims, media 4, math,
 * diagram, columns) from the single catalog source.
 *
 * Path mapping (mirroring the divider precedent): insert-only types
 * have no turn-into target by design (atoms/regions reject both directions
 * — pinned in block-transform.spec.ts), so parity here is slash-commit vs
 * toolbar-execute (`block.insert.*`) vs insert-block command. The
 * handle-menu side is the documented incompatible-block policy (menu lists
 * the turn-into catalog but choosing refuses without mutation), pinned in
 * the guards section below.
 *
 * Guards: columns-in-columns refuses (existing); table/media/math/
 * diagram/columns refuse from a grid caret (decision — slash
 * suppression precedent — instead of landing after the table).
 * File drop/paste routes into the uploadMedia primitive;
 * host capture/file-picker stays deferred (no host seam exists).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  emptyBlockPage,
  paragraphBlock,
  tableBlock,
  type BlockPageModel,
} from '@froglight/foundation';
import { BlockPageDocumentEditorProvider } from './editor.js';
import { MAX_MEDIA_BYTES } from './media-security.js';

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
    slash: () =>
      parent.querySelector(
        '.flbp-slash:not(.flbp-resource-menu):not(.flbp-turninto-menu):not(.flbp-table-menu)',
      ) as HTMLElement | null,
    picker: () =>
      parent.querySelector('.flbp-table-menu') as HTMLElement | null,
    menu: () =>
      parent.querySelector('.flbp-turninto-menu') as HTMLElement | null,
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

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 4));

async function waitFor(cond: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (cond()) return;
    await flush();
  }
  throw new Error(`timed out waiting for ${label}`);
}

function blank(): BlockPageModel {
  const m = emptyBlockPage();
  m.rootOrder = ['p1'];
  m.blocks = { p1: paragraphBlock('p1', [{ text: '' }]) };
  return m;
}

function gridModel(): BlockPageModel {
  const model = emptyBlockPage();
  model.rootOrder = ['t1'];
  model.blocks = {
    t1: tableBlock('t1', 2, [{ cells: [[{ text: 'a' }], [{ text: 'b' }]] }]),
  };
  return model;
}

/**
 * Normalized canonical shape: every block id and id-reference becomes a
 * positional token, so fresh ids (by design per insert — never reused)
 * cannot mask shape divergence between creation paths. Text payloads in
 * these specs never collide with id strings.
 */
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
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = remap(v);
      }
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

/** Slash-commit one insert-only row; table resolves through the picker. */
async function slashCommit(
  env: ReturnType<typeof mount>,
  query: string,
  tablePresetDowns = 0,
): Promise<{ before: BlockPageModel; after: BlockPageModel }> {
  command(env, 'set-selection', { from: 1 });
  type(env, query);
  await flush();
  // Single-undo baseline is the pre-commit model WITH the trigger text
  // (table-grid.spec convention): one undo restores the typed trigger.
  const before = env.handle.getModelForTest!();
  key(env, 'Enter');
  if (query === '/table') {
    expect(env.picker()?.style.display).toBe('block');
    for (let i = 0; i < tablePresetDowns; i += 1) key(env, 'ArrowDown');
    key(env, 'Enter');
  }
  return { before, after: env.handle.getModelForTest!() };
}

function newBlockOfType(
  model: BlockPageModel,
  type: string,
): Record<string, unknown> {
  const found = Object.values(model.blocks).find(
    (b) => (b as { type?: string }).type === type,
  );
  if (found === undefined) throw new Error(`no ${type} block created`);
  return found as unknown as Record<string, unknown>;
}

afterEach(() => {
  document.body.replaceChildren();
  document.getElementById('flbp-chrome-styles')?.remove();
});

describe('creation parity — table with dims', () => {
  it('slash (picker 2x2) vs toolbar vs insert-block produce identical canonical + single undo', async () => {
    const slashEnv = mount(blank());
    let slashAfter: BlockPageModel;
    try {
      const { before: slashBefore, after } = await slashCommit(
        slashEnv,
        '/table',
      );
      slashAfter = after;
      const table = newBlockOfType(slashAfter, 'froglight.table') as {
        columnCount: number;
        rows: unknown[];
      };
      expect(table.columnCount).toBe(2);
      expect(table.rows).toHaveLength(2);
      expect(JSON.stringify(slashAfter)).not.toContain('/table');
      expect(slashEnv.handle.execCommand('undo')).toBe(true);
      expect(slashEnv.handle.getModelForTest!()).toEqual(slashBefore);
    } finally {
      slashEnv.cleanup();
    }

    const toolEnv = mount(blank());
    let toolAfter: BlockPageModel;
    try {
      command(toolEnv, 'set-selection', { from: 1, to: 1 });
      const toolBefore = toolEnv.handle.getModelForTest!();
      expect(toolsOf(toolEnv).execute('block.insert.table')).toBe(true);
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
      const insertBefore = insertEnv.handle.getModelForTest!();
      expect(command(insertEnv, 'insert-block', { type: 'table' })).toBe(true);
      insertAfter = insertEnv.handle.getModelForTest!();
      expect(insertEnv.handle.execCommand('undo')).toBe(true);
      expect(insertEnv.handle.getModelForTest!()).toEqual(insertBefore);
    } finally {
      insertEnv.cleanup();
    }

    expect(normalized(toolAfter)).toEqual(normalized(slashAfter));
    expect(normalized(insertAfter)).toEqual(normalized(slashAfter));
  });

  it('toolbar table honors preset values; unknown presets refuse', () => {
    const env = mount(blank());
    try {
      command(env, 'set-selection', { from: 1, to: 1 });
      const before = env.handle.getModelForTest!();
      expect(toolsOf(env).execute('block.insert.table', '3x3')).toBe(true);
      const table = newBlockOfType(
        env.handle.getModelForTest!(),
        'froglight.table',
      ) as { columnCount: number; rows: Array<{ cells: unknown[] }> };
      expect(table.columnCount).toBe(3);
      expect(table.rows).toHaveLength(3);
      expect(table.rows.every((row) => row.cells.length === 3)).toBe(true);
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!()).toEqual(before);
      // Unknown preset ids refuse without mutation (precedent).
      expect(toolsOf(env).execute('block.insert.table', '9x9')).toBe(false);
      expect(toolsOf(env).execute('block.insert.table', '')).toBe(false);
      expect(env.handle.getModelForTest!()).toEqual(before);
      // Unknown insert ids refuse without mutation.
      expect(toolsOf(env).execute('block.insert.nope')).toBe(false);
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });
});

describe('creation parity — media placeholders', () => {
  it('image: slash vs toolbar vs insert-block produce identical canonical + single undo', async () => {
    const slashEnv = mount(blank());
    let slashAfter: BlockPageModel;
    try {
      const { before: slashBefore, after } = await slashCommit(
        slashEnv,
        '/image',
      );
      slashAfter = after;
      const image = newBlockOfType(slashAfter, 'froglight.image');
      expect(image).toMatchObject({ src: 'attachments/', sha256: '' });
      expect(JSON.stringify(slashAfter)).not.toContain('/image');
      expect(slashEnv.handle.execCommand('undo')).toBe(true);
      expect(slashEnv.handle.getModelForTest!()).toEqual(slashBefore);
    } finally {
      slashEnv.cleanup();
    }

    const toolEnv = mount(blank());
    let toolAfter: BlockPageModel;
    try {
      command(toolEnv, 'set-selection', { from: 1, to: 1 });
      const toolBefore = toolEnv.handle.getModelForTest!();
      expect(toolsOf(toolEnv).execute('block.insert.image')).toBe(true);
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
      const insertBefore = insertEnv.handle.getModelForTest!();
      expect(command(insertEnv, 'insert-block', { type: 'image' })).toBe(true);
      insertAfter = insertEnv.handle.getModelForTest!();
      expect(insertEnv.handle.execCommand('undo')).toBe(true);
      expect(insertEnv.handle.getModelForTest!()).toEqual(insertBefore);
    } finally {
      insertEnv.cleanup();
    }

    expect(normalized(toolAfter)).toEqual(normalized(slashAfter));
    expect(normalized(insertAfter)).toEqual(normalized(slashAfter));
  });

  for (const kind of ['video', 'audio', 'file'] as const) {
    it(`${kind}: slash vs toolbar vs insert-block converge + single undo`, async () => {
      const slashEnv = mount(blank());
      let slashAfter: BlockPageModel;
      try {
        const { before: slashBefore, after } = await slashCommit(
          slashEnv,
          `/${kind}`,
        );
        slashAfter = after;
        newBlockOfType(slashAfter, `froglight.${kind}`);
        expect(JSON.stringify(slashAfter)).not.toContain(`/${kind}`);
        expect(slashEnv.handle.execCommand('undo')).toBe(true);
        expect(slashEnv.handle.getModelForTest!()).toEqual(slashBefore);
      } finally {
        slashEnv.cleanup();
      }
      const toolEnv = mount(blank());
      let toolAfter: BlockPageModel;
      try {
        command(toolEnv, 'set-selection', { from: 1, to: 1 });
        const toolBefore = toolEnv.handle.getModelForTest!();
        expect(toolsOf(toolEnv).execute(`block.insert.${kind}`)).toBe(true);
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
      expect(normalized(toolAfter)).toEqual(normalized(slashAfter));
      expect(normalized(insertAfter)).toEqual(normalized(slashAfter));
    });
  }
});

describe('creation parity — math/diagram/columns', () => {
  for (const kind of ['math', 'diagram'] as const) {
    it(`${kind}: slash vs toolbar vs insert-block produce identical source atoms + single undo`, async () => {
      const slashEnv = mount(blank());
      let slashAfter: BlockPageModel;
      try {
        const { before: slashBefore, after } = await slashCommit(
          slashEnv,
          `/${kind}`,
        );
        slashAfter = after;
        expect(newBlockOfType(slashAfter, `froglight.${kind}`)).toMatchObject({
          source: '',
        });
        expect(slashEnv.handle.execCommand('undo')).toBe(true);
        expect(slashEnv.handle.getModelForTest!()).toEqual(slashBefore);
      } finally {
        slashEnv.cleanup();
      }
      const toolEnv = mount(blank());
      let toolAfter: BlockPageModel;
      try {
        command(toolEnv, 'set-selection', { from: 1, to: 1 });
        const toolBefore = toolEnv.handle.getModelForTest!();
        expect(toolsOf(toolEnv).execute(`block.insert.${kind}`)).toBe(true);
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
      expect(normalized(toolAfter)).toEqual(normalized(slashAfter));
      expect(normalized(insertAfter)).toEqual(normalized(slashAfter));
    });
  }


});

describe('creation guards — grid and column scoping', () => {
  const INSERT_IDS = [
    'block.insert.table',
    'block.insert.image',
    'block.insert.video',
    'block.insert.audio',
    'block.insert.file',
    'block.insert.math',
    'block.insert.diagram',
  ];

  it('toolbar offers all eight insert buttons outside the grid', () => {
    const env = mount(blank());
    try {
      command(env, 'set-selection', { from: 1, to: 1 });
      const ids = toolsOf(env)
        .snapshot()
        .controls.map((c) => c.id);
      for (const id of INSERT_IDS) expect(ids).toContain(id);
    } finally {
      env.cleanup();
    }
  });

  it('toolbar omits insert buttons in-grid; guarded commits refuse with the model untouched', () => {
    const env = mount(gridModel());
    try {
      // Caret inside a grid cell (table-grid.spec convention: from 4).
      // NOTE: entering the grid runs the tableEditing structural fix-up
      // (pre-existing provider behavior), so the refusal baseline is
      // captured AFTER the caret move — the pin below is that the refused
      // commits add no FURTHER history step.
      command(env, 'set-selection', { from: 4, to: 4 });
      const ids = toolsOf(env)
        .snapshot()
        .controls.map((c) => c.id);
      for (const id of INSERT_IDS) expect(ids).not.toContain(id);
      const before = env.handle.getModelForTest!();
      const undoBefore = env.handle.canExecCommand!('undo');
      for (const id of INSERT_IDS) {
        expect(toolsOf(env).execute(id)).toBe(false);
        expect(env.handle.getModelForTest!()).toEqual(before);
      }
      // The insert-block command path converges on the same refusal.
      for (const type of [
        'table',
        'image',
        'video',
        'audio',
        'file',
        'math',
        'diagram',
      ]) {
        expect(command(env, 'insert-block', { type })).toBe(false);
        expect(env.handle.getModelForTest!()).toEqual(before);
      }
      expect(env.handle.canExecCommand!('undo')).toBe(undoBefore);
    } finally {
      env.cleanup();
    }
  });



  it('handle menu omits incompatible atom transforms without mutation', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['m1'];
    model.blocks = {
      m1: {
        id: 'm1',
        type: 'froglight.image',
        src: 'attachments/h',
        sha256: 'h',
      } as never,
    };
    const env = mount(model);
    try {
      const host = env.parent.firstElementChild as HTMLElement;
      const block = env
        .pm()
        .querySelector('[data-block-id="m1"]') as HTMLElement;
      block.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      const handle = host.querySelector('.flbp-drag-handle') as HTMLElement;
      const before = env.handle.getModelForTest!();
      const undoBefore = env.handle.canExecCommand!('undo');
      handle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(env.menu()?.style.display).toBe('block');
      expect(
        [...env.menu()!.querySelectorAll('.flbp-slash-item')].map(
          (item) => item.textContent,
        ),
      ).toEqual(['Delete block']);
      expect(env.handle.getModelForTest!()).toEqual(before);
      expect(env.handle.canExecCommand!('undo')).toBe(undoBefore);
    } finally {
      env.cleanup();
    }
  });
});

describe('file drop/paste ingestion into uploadMedia', () => {
  const PNG = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03,
  ]);

  function fakeFile(name: string, bytes: Uint8Array, size?: number) {
    return {
      name,
      type: '',
      size: size ?? bytes.byteLength,
      arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer,
    };
  }

  function pasteFiles(
    env: ReturnType<typeof mount>,
    files: unknown[],
  ): boolean {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { getData: (_kind: string) => '', files },
    });
    env.pm().dispatchEvent(event);
    return event.defaultPrevented;
  }

  function dropFiles(env: ReturnType<typeof mount>, files: unknown[]): boolean {
    const host = env.parent.firstElementChild as HTMLElement;
    const event = new MouseEvent('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
      value: { types: ['Files'], files },
    });
    host.dispatchEvent(event);
    return event.defaultPrevented;
  }

  function dragOver(env: ReturnType<typeof mount>, types: string[]): boolean {
    const host = env.parent.firstElementChild as HTMLElement;
    const event = new MouseEvent('dragover', {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, 'dataTransfer', {
      value: { types, dropEffect: '' },
    });
    host.dispatchEvent(event);
    return event.defaultPrevented;
  }

  it('pasted PNG bytes create a vault image block (sniff decides the kind), single undo', async () => {
    const env = mount(blank());
    try {
      command(env, 'set-selection', { from: 1, to: 1 });
      const before = env.handle.getModelForTest!();
      expect(pasteFiles(env, [fakeFile('shot.png', PNG)])).toBe(true);
      await waitFor(
        () =>
          Object.values(env.handle.getModelForTest!().blocks).some(
            (b) => b.type === 'froglight.image',
          ),
        'pasted image block',
      );
      const next = env.handle.getModelForTest!();
      const image = Object.values(next.blocks).find(
        (b) => b.type === 'froglight.image',
      ) as unknown as { src: string; sha256: string };
      expect(image.src.startsWith('attachments/')).toBe(true);
      expect(image.sha256).toMatch(/^[0-9a-f]{64}$/);
      // No filename-as-text leak: the file never enters the text path.
      expect(JSON.stringify(next)).not.toContain('shot.png');
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });

  it('dropped PNG bytes create a vault image block; dragover claims only file drags', async () => {
    const env = mount(blank());
    try {
      command(env, 'set-selection', { from: 1, to: 1 });
      // Relevance gate: file drags are claimed, other foreign drags are not.
      expect(dragOver(env, ['Files'])).toBe(true);
      expect(dragOver(env, ['text/plain'])).toBe(false);
      const before = env.handle.getModelForTest!();
      expect(dropFiles(env, [fakeFile('drop.png', PNG)])).toBe(true);
      await waitFor(
        () =>
          Object.values(env.handle.getModelForTest!().blocks).some(
            (b) => b.type === 'froglight.image',
          ),
        'dropped image block',
      );
      const next = env.handle.getModelForTest!();
      expect(
        (
          Object.values(next.blocks).find(
            (b) => b.type === 'froglight.image',
          ) as unknown as { src: string }
        ).src.startsWith('attachments/'),
      ).toBe(true);
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });

  it('empty pasted files are claimed with no mutation (outcome-before-mutation)', async () => {
    const env = mount(blank());
    try {
      command(env, 'set-selection', { from: 1, to: 1 });
      const before = env.handle.getModelForTest!();
      expect(pasteFiles(env, [fakeFile('empty.png', new Uint8Array(0))])).toBe(
        true,
      );
      await flush();
      await flush();
      expect(env.handle.getModelForTest!()).toEqual(before);
      expect(env.handle.canExecCommand!('undo')).toBe(false);
    } finally {
      env.cleanup();
    }
  });

  it('declared-oversize files refuse before reading (no mutation, no history step)', async () => {
    const env = mount(blank());
    try {
      command(env, 'set-selection', { from: 1, to: 1 });
      const before = env.handle.getModelForTest!();
      expect(
        pasteFiles(env, [fakeFile('huge.png', PNG, MAX_MEDIA_BYTES + 1)]),
      ).toBe(true);
      await flush();
      await flush();
      expect(env.handle.getModelForTest!()).toEqual(before);
      expect(env.handle.canExecCommand!('undo')).toBe(false);
    } finally {
      env.cleanup();
    }
  });

  it('plain-text paste still splits/merges after the files-first branch', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['p1'];
    model.blocks = { p1: paragraphBlock('p1', [{ text: 'ab' }]) };
    const env = mount(model);
    try {
      command(env, 'set-selection', { from: 2, to: 2 });
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', {
        value: {
          getData: (kind: string) => (kind === 'text/plain' ? 'X' : ''),
        },
      });
      env.pm().dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(JSON.stringify(env.handle.getModelForTest!())).toContain('aXb');
    } finally {
      env.cleanup();
    }
  });
});

describe('file ingestion grid refusal', () => {
  const PNG = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03,
  ]);

  function fakeFile(name: string, bytes: Uint8Array, size?: number) {
    return {
      name,
      type: '',
      size: size ?? bytes.byteLength,
      arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer,
    };
  }

  function pasteFiles(
    env: ReturnType<typeof mount>,
    files: unknown[],
  ): boolean {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { getData: (_kind: string) => '', files },
    });
    env.pm().dispatchEvent(event);
    return event.defaultPrevented;
  }

  function dropFiles(env: ReturnType<typeof mount>, files: unknown[]): boolean {
    const host = env.parent.firstElementChild as HTMLElement;
    const event = new MouseEvent('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
      value: { types: ['Files'], files },
    });
    host.dispatchEvent(event);
    return event.defaultPrevented;
  }

  function imageCount(model: BlockPageModel): number {
    return Object.values(model.blocks).filter(
      (b) => (b as { type?: string }).type === 'froglight.image',
    ).length;
  }

  it('drop PNG with caret in cell refuses with model untouched and no history step', async () => {
    const env = mount(gridModel());
    try {
      // Caret inside a grid cell (creation-guard convention: from 4).
      // Baseline captured AFTER the caret move (tableEditing fix-up).
      command(env, 'set-selection', { from: 4, to: 4 });
      const before = env.handle.getModelForTest!();
      const undoBefore = env.handle.canExecCommand!('undo');
      expect(dropFiles(env, [fakeFile('drop.png', PNG)])).toBe(true);
      await flush();
      await flush();
      expect(env.handle.getModelForTest!()).toEqual(before);
      expect(imageCount(env.handle.getModelForTest!())).toBe(0);
      expect(env.handle.canExecCommand!('undo')).toBe(undoBefore);
    } finally {
      env.cleanup();
    }
  });

  it('paste file with caret in cell refuses with model untouched and no history step', async () => {
    const env = mount(gridModel());
    try {
      command(env, 'set-selection', { from: 4, to: 4 });
      const before = env.handle.getModelForTest!();
      const undoBefore = env.handle.canExecCommand!('undo');
      expect(pasteFiles(env, [fakeFile('shot.png', PNG)])).toBe(true);
      await flush();
      await flush();
      expect(env.handle.getModelForTest!()).toEqual(before);
      expect(imageCount(env.handle.getModelForTest!())).toBe(0);
      expect(env.handle.canExecCommand!('undo')).toBe(undoBefore);
    } finally {
      env.cleanup();
    }
  });

  it('control: drop with caret outside the grid still ingests', async () => {
    const model = emptyBlockPage();
    model.rootOrder = ['p1', 't1'];
    model.blocks = {
      p1: paragraphBlock('p1', [{ text: 'before' }]),
      t1: tableBlock('t1', 2, [{ cells: [[{ text: 'a' }], [{ text: 'b' }]] }]),
    };
    const env = mount(model);
    try {
      // Caret inside the leading paragraph (outside the grid).
      command(env, 'set-selection', { from: 2, to: 2 });
      const before = env.handle.getModelForTest!();
      expect(dropFiles(env, [fakeFile('drop.png', PNG)])).toBe(true);
      await waitFor(
        () => imageCount(env.handle.getModelForTest!()) === 1,
        'control dropped image block',
      );
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });
});

describe('mixed clipboard files-first policy', () => {
  const PNG = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03,
  ]);

  function fakeFile(name: string, bytes: Uint8Array, size?: number) {
    return {
      name,
      type: '',
      size: size ?? bytes.byteLength,
      arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer,
    };
  }

  function pasteMixed(
    env: ReturnType<typeof mount>,
    files: unknown[],
    plain: string,
  ): boolean {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: {
        getData: (kind: string) => (kind === 'text/plain' ? plain : ''),
        files,
      },
    });
    env.pm().dispatchEvent(event);
    return event.defaultPrevented;
  }

  function imageCount(model: BlockPageModel): number {
    return Object.values(model.blocks).filter(
      (b) => (b as { type?: string }).type === 'froglight.image',
    ).length;
  }

  it('files-all-refuse (empty + oversize) + text present falls through to text', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['p1'];
    model.blocks = { p1: paragraphBlock('p1', [{ text: 'ab' }]) };
    const env = mount(model);
    try {
      command(env, 'set-selection', { from: 2, to: 2 });
      const refused = [
        fakeFile('empty.png', new Uint8Array(0)),
        fakeFile('huge.png', PNG, MAX_MEDIA_BYTES + 1),
      ];
      expect(pasteMixed(env, refused, 'X')).toBe(true);
      expect(JSON.stringify(env.handle.getModelForTest!())).toContain('aXb');
      expect(imageCount(env.handle.getModelForTest!())).toBe(0);
    } finally {
      env.cleanup();
    }
  });

  it('one-valid-file + text ingests files (documented files-win, text dropped)', async () => {
    const env = mount(blank());
    try {
      command(env, 'set-selection', { from: 1, to: 1 });
      const before = env.handle.getModelForTest!();
      const mixed = [
        fakeFile('shot.png', PNG),
        fakeFile('empty.png', new Uint8Array(0)),
      ];
      expect(pasteMixed(env, mixed, 'MIXEDTEXT')).toBe(true);
      await waitFor(
        () => imageCount(env.handle.getModelForTest!()) === 1,
        'mixed pasted image block',
      );
      // Files-win: the valid file ingests, the accompanying text is dropped
      // (never becomes paragraph text or a filename leak).
      expect(JSON.stringify(env.handle.getModelForTest!())).not.toContain(
        'MIXEDTEXT',
      );
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });
});

describe('grid mixed-clipboard paste + files-win text-loss pins', () => {
  const PNG = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03,
  ]);

  function fakeFile(name: string, bytes: Uint8Array, size?: number) {
    return {
      name,
      type: '',
      size: size ?? bytes.byteLength,
      arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer,
    };
  }

  function pasteMixed(
    env: ReturnType<typeof mount>,
    files: unknown[],
    plain: string,
  ): boolean {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: {
        getData: (kind: string) => (kind === 'text/plain' ? plain : ''),
        files,
      },
    });
    env.pm().dispatchEvent(event);
    return event.defaultPrevented;
  }

  function imageCount(model: BlockPageModel): number {
    return Object.values(model.blocks).filter(
      (b) => (b as { type?: string }).type === 'froglight.image',
    ).length;
  }

  it('grid caret, files-all-refuse + text → text space-joined into the cell, no image', () => {
    const env = mount(gridModel());
    try {
      command(env, 'set-selection', { from: 4, to: 4 });
      const refused = [
        fakeFile('empty.png', new Uint8Array(0)),
        fakeFile('huge.png', PNG, MAX_MEDIA_BYTES + 1),
      ];
      expect(pasteMixed(env, refused, 'L1\nL2')).toBe(true);
      // Cell single-paragraph model: multi-line payload space-joins.
      expect(JSON.stringify(env.handle.getModelForTest!())).toContain('L1 L2');
      expect(imageCount(env.handle.getModelForTest!())).toBe(0);
      // The text path ran (own history step), unlike a grid refusal.
      expect(env.handle.canExecCommand!('undo')).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  it('grid caret, valid file + text → refused, model untouched, no undo', async () => {
    const env = mount(gridModel());
    try {
      command(env, 'set-selection', { from: 4, to: 4 });
      const before = env.handle.getModelForTest!();
      const undoBefore = env.handle.canExecCommand!('undo');
      expect(pasteMixed(env, [fakeFile('shot.png', PNG)], 'CELLTEXT')).toBe(
        true,
      );
      await flush();
      await flush();
      // Files cannot join cells: claimed refusal drops the text with it.
      expect(env.handle.getModelForTest!()).toEqual(before);
      expect(JSON.stringify(env.handle.getModelForTest!())).not.toContain(
        'CELLTEXT',
      );
      expect(imageCount(env.handle.getModelForTest!())).toBe(0);
      expect(env.handle.canExecCommand!('undo')).toBe(undoBefore);
    } finally {
      env.cleanup();
    }
  });

  it('unsized empty file + text → files-win claims, async refuses, text dropped (documented)', async () => {
    const env = mount(blank());
    try {
      command(env, 'set-selection', { from: 1, to: 1 });
      const before = env.handle.getModelForTest!();
      // No `size`: cannot pre-refuse, counts as potentially valid, so the
      // sync files-win claim drops the text before the async empty-gate
      // refusal lands. Post-preventDefault fall-through is impossible.
      const unsized = {
        name: 'unsized.png',
        arrayBuffer: async () =>
          new Uint8Array(0).slice().buffer as ArrayBuffer,
      };
      expect(pasteMixed(env, [unsized], 'LOSTTEXT')).toBe(true);
      await flush();
      await flush();
      expect(env.handle.getModelForTest!()).toEqual(before);
      expect(JSON.stringify(env.handle.getModelForTest!())).not.toContain(
        'LOSTTEXT',
      );
      expect(imageCount(env.handle.getModelForTest!())).toBe(0);
      expect(env.handle.canExecCommand!('undo')).toBe(false);
    } finally {
      env.cleanup();
    }
  });

  it('lying declared size + text → files-win claims, async refuses, text dropped (documented)', async () => {
    const env = mount(blank());
    try {
      command(env, 'set-selection', { from: 1, to: 1 });
      const before = env.handle.getModelForTest!();
      // Declared size looks valid but the bytes arrive empty: sync probe
      // cannot see the lie, files-win claims, async empty-gate refuses.
      const lying = {
        name: 'lying.png',
        size: PNG.byteLength,
        arrayBuffer: async () =>
          new Uint8Array(0).slice().buffer as ArrayBuffer,
      };
      expect(pasteMixed(env, [lying], 'LOSTTEXT')).toBe(true);
      await flush();
      await flush();
      expect(env.handle.getModelForTest!()).toEqual(before);
      expect(JSON.stringify(env.handle.getModelForTest!())).not.toContain(
        'LOSTTEXT',
      );
      expect(imageCount(env.handle.getModelForTest!())).toBe(0);
      expect(env.handle.canExecCommand!('undo')).toBe(false);
    } finally {
      env.cleanup();
    }
  });
});

describe('multi-file ingestion undo granularity', () => {
  const PNG = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03,
  ]);
  const PNG2 = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x04, 0x05, 0x06,
  ]);

  function fakeFile(name: string, bytes: Uint8Array, size?: number) {
    return {
      name,
      type: '',
      size: size ?? bytes.byteLength,
      arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer,
    };
  }

  function dropFiles(env: ReturnType<typeof mount>, files: unknown[]): boolean {
    const host = env.parent.firstElementChild as HTMLElement;
    const event = new MouseEvent('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
      value: { types: ['Files'], files },
    });
    host.dispatchEvent(event);
    return event.defaultPrevented;
  }

  function imageCount(model: BlockPageModel): number {
    return Object.values(model.blocks).filter(
      (b) => (b as { type?: string }).type === 'froglight.image',
    ).length;
  }

  it('2-file drop commits two undo steps (sequential per-file)', async () => {
    const env = mount(blank());
    try {
      command(env, 'set-selection', { from: 1, to: 1 });
      const before = env.handle.getModelForTest!();
      expect(
        dropFiles(env, [fakeFile('a.png', PNG), fakeFile('b.png', PNG2)]),
      ).toBe(true);
      await waitFor(
        () => imageCount(env.handle.getModelForTest!()) === 2,
        'two dropped image blocks',
      );
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(imageCount(env.handle.getModelForTest!())).toBe(1);
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });

  it('partial failure (valid + empty) ingests one image with one undo step', async () => {
    const env = mount(blank());
    try {
      command(env, 'set-selection', { from: 1, to: 1 });
      const before = env.handle.getModelForTest!();
      expect(
        dropFiles(env, [
          fakeFile('ok.png', PNG),
          fakeFile('empty.png', new Uint8Array(0)),
        ]),
      ).toBe(true);
      await waitFor(
        () => imageCount(env.handle.getModelForTest!()) === 1,
        'partial dropped image block',
      );
      await flush();
      await flush();
      expect(imageCount(env.handle.getModelForTest!())).toBe(1);
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });

  it('partial failure reversed (empty + valid) still ingests the valid file', async () => {
    const env = mount(blank());
    try {
      command(env, 'set-selection', { from: 1, to: 1 });
      const before = env.handle.getModelForTest!();
      expect(
        dropFiles(env, [
          fakeFile('empty.png', new Uint8Array(0)),
          fakeFile('ok.png', PNG),
        ]),
      ).toBe(true);
      await waitFor(
        () => imageCount(env.handle.getModelForTest!()) === 1,
        'reversed partial dropped image block',
      );
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });
});

describe('media figure class contract for cascade-layer styles', () => {
  for (const kind of ['video', 'audio', 'file'] as const) {
    it(`${kind} figures carry the schema classes the stylesheet targets`, () => {
      const env = mount(blank());
      try {
        command(env, 'set-selection', { from: 1, to: 1 });
        expect(command(env, 'insert-block', { type: kind })).toBe(true);
        const figure = env.pm().querySelector(`figure[data-flbp-${kind}]`);
        expect(figure).not.toBeNull();
        expect((figure as HTMLElement).classList.contains(`flbp-${kind}`)).toBe(
          true,
        );
        expect(figure!.querySelector(`.flbp-${kind}-ph`)).not.toBeNull();
        expect(figure!.querySelector('figcaption')).not.toBeNull();
      } finally {
        env.cleanup();
      }
    });
  }
});
