// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FILE_TREE_DRAG_MIME,
  describeDropTransfer,
  importExternalCandidates,
  isExternalFileDrag,
  isExternalFileDrop,
  isInternalNodeDrag,
  resolveExternalDropTarget,
  type ExternalImportCandidate,
} from './file-explorer.js';

function candidate(
  name: string,
  bytesOrError: Uint8Array | Error,
): ExternalImportCandidate {
  return {
    name,
    readBytes: async () => {
      if (bytesOrError instanceof Error) throw bytesOrError;
      return bytesOrError;
    },
  };
}

describe('importExternalCandidates (shared browser/native import seam)', () => {
  it('imports a single candidate into the target folder', async () => {
    const seen: Array<{ folder: string; name: string; bytes: Uint8Array }> =
      [];
    const service = {
      importFile: vi.fn(
        async (folder: string, name: string, data: Uint8Array) => {
          seen.push({ folder, name, bytes: data });
        },
      ),
    };
    const result = await importExternalCandidates(
      service,
      [candidate('a.md', new Uint8Array([1, 2, 3]))],
      'notes',
    );
    expect(result).toEqual({ imported: 1, failed: 0, errors: [] });
    expect(service.importFile).toHaveBeenCalledTimes(1);
    expect(seen[0]).toMatchObject({ folder: 'notes', name: 'a.md' });
    expect([...seen[0]!.bytes]).toEqual([1, 2, 3]);
  });

  it('imports multiple candidates and keeps going after a read failure', async () => {
    const imported: string[] = [];
    const service = {
      importFile: vi.fn(async (_folder: string, name: string) => {
        imported.push(name);
      }),
    };
    const result = await importExternalCandidates(
      service,
      [
        candidate('ok-one.md', new Uint8Array([1])),
        candidate('broken.md', new Error('unreadable')),
        candidate('ok-two.png', new Uint8Array([2])),
      ],
      '',
    );
    expect(result.imported).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(imported).toEqual(['ok-one.md', 'ok-two.png']);
  });

  it('reports importFile failures without stopping later candidates', async () => {
    const service = {
      importFile: vi.fn(async (_f: string, name: string) => {
        if (name === 'bad.md') throw new Error('decode blew up');
      }),
    };
    const result = await importExternalCandidates(
      service,
      [
        candidate('bad.md', new Uint8Array([9])),
        candidate('good.md', new Uint8Array([7])),
      ],
      'inbox',
    );
    expect(result).toEqual({
      imported: 1,
      failed: 1,
      errors: [expect.any(Error)],
    });
  });

  it('imports nothing for an empty candidate list', async () => {
    const service = { importFile: vi.fn(async () => undefined) };
    const result = await importExternalCandidates(service, [], '');
    expect(result).toEqual({ imported: 0, failed: 0, errors: [] });
    expect(service.importFile).not.toHaveBeenCalled();
  });
});

describe('isExternalFileDrag / isExternalFileDrop (WebKit-compatible guards)', () => {
  it('accepts dragover with types=["Files"] even when files is empty', () => {
    // WebKit protected drag-data phase: files is empty during dragover.
    expect(isExternalFileDrag({ types: ['Files'] })).toBe(true);
    expect(isExternalFileDrag({ types: ['Files', 'text/plain'] })).toBe(true);
  });

  it('rejects dragover without the Files type', () => {
    expect(isExternalFileDrag({ types: [] })).toBe(false);
    expect(
      isExternalFileDrag({ types: ['application/x-froglight-node'] }),
    ).toBe(false);
    expect(isExternalFileDrag(null)).toBe(false);
  });

  it('requires files at drop time', () => {
    expect(
      isExternalFileDrop({ types: ['Files'], files: [{} as File] }),
    ).toBe(true);
    expect(isExternalFileDrop({ types: ['Files'], files: [] })).toBe(false);
    // Internal drags never carry files; the MIME alone must not import.
    expect(
      isExternalFileDrop({
        types: ['application/x-froglight-node'],
        files: [],
      }),
    ).toBe(false);
    expect(isExternalFileDrop(null)).toBe(false);
  });

  it('accepts files even when the engine omits the Files type', () => {
    // Regression (Linux WebKitGTK): the drop carries real files but
    // `types` lists only e.g. text/uri-list. Files present means external.
    expect(
      isExternalFileDrop({ types: ['text/uri-list'], files: [{} as File] }),
    ).toBe(true);
    expect(isExternalFileDrop({ types: [], files: [{} as File] })).toBe(true);
  });

  it('describes unrecognized drops for engine diagnostics', () => {
    expect(describeDropTransfer(null)).toEqual({ types: [], fileCount: 0 });
    expect(
      describeDropTransfer({ types: ['text/uri-list'], files: [] }),
    ).toEqual({ types: ['text/uri-list'], fileCount: 0 });
    expect(
      describeDropTransfer({ types: ['Files'], files: [{}, {}] }),
    ).toEqual({ types: ['Files'], fileCount: 2 });
  });
});

describe('isInternalNodeDrag (Linux/WebKitGTK-compatible guard)', () => {
  /** DOMStringList shape (Firefox, some WebKitGTK builds): no `.includes`. */
  function domStringList(...items: string[]): unknown {
    return {
      length: items.length,
      item: (index: number): string | null => items[index] ?? null,
      contains: (type: string): boolean => items.includes(type),
      ...Object.fromEntries(items.map((type, index) => [index, type])),
    };
  }

  it('exposes the stable internal drag MIME type', () => {
    expect(FILE_TREE_DRAG_MIME).toBe('application/x-froglight-node');
  });

  it('accepts array types carrying the node MIME', () => {
    expect(isInternalNodeDrag({ types: [FILE_TREE_DRAG_MIME] })).toBe(true);
    expect(
      isInternalNodeDrag({ types: ['text/plain', FILE_TREE_DRAG_MIME] }),
    ).toBe(true);
  });

  it('accepts DOMStringList types without throwing (Linux block-pointer bug)', () => {
    // Regression: the view called `types.includes(...)` directly, which
    // throws on DOMStringList. The dragover handler died before
    // `preventDefault()`, so Linux showed a block pointer and drops no-oped.
    expect(() =>
      isInternalNodeDrag({ types: domStringList(FILE_TREE_DRAG_MIME) as never }),
    ).not.toThrow();
    expect(
      isInternalNodeDrag({ types: domStringList(FILE_TREE_DRAG_MIME) as never }),
    ).toBe(true);
    expect(
      isInternalNodeDrag({ types: domStringList('text/plain') as never }),
    ).toBe(false);
  });

  it('rejects external and empty drags', () => {
    expect(isInternalNodeDrag({ types: ['Files'] })).toBe(false);
    expect(isInternalNodeDrag({ types: [] })).toBe(false);
    expect(isInternalNodeDrag(null)).toBe(false);
  });
});

describe('resolveExternalDropTarget (native coordinate → folder seam)', () => {
  function setup(dom: string): HTMLElement {
    document.body.innerHTML = dom;
    return document.querySelector('[data-testid="file-explorer"]') as HTMLElement;
  }

  function mockHit(element: Element | null): void {
    const doc = document as Document & {
      elementFromPoint?: (x: number, y: number) => Element | null;
    };
    if (typeof doc.elementFromPoint !== 'function') {
      Object.defineProperty(doc, 'elementFromPoint', {
        value: vi.fn(),
        configurable: true,
        writable: true,
      });
    }
    vi.mocked(doc.elementFromPoint as (...args: unknown[]) => Element | null)
      .mockReturnValueOnce(element);
  }

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  function pointAt(element: Element | null): { x: number; y: number } {
    // elementFromPoint is stubbed per test; coordinates are opaque.
    void element;
    return { x: 10, y: 10 };
  }

  it('resolves a folder row to its path', () => {
    const root = setup(
      `<div data-testid="file-explorer"><div class="explorer-tree">` +
        `<div data-path="notes" data-kind="folder"><button>notes</button></div>` +
        `</div></div>`,
    );
    const folder = root.querySelector('[data-path="notes"]')!;
    mockHit(folder);
    const { x, y } = pointAt(folder);
    expect(resolveExternalDropTarget(root, x, y)).toBe('notes');
  });

  it('resolves a file row to its parent folder', () => {
    const root = setup(
      `<div data-testid="file-explorer"><div class="explorer-tree">` +
        `<div data-path="notes/welcome.md" data-kind="file"><button>welcome</button></div>` +
        `</div></div>`,
    );
    const file = root.querySelector('[data-path="notes/welcome.md"]')!;
    const inner = file.querySelector('button')!;
    mockHit(inner);
    const { x, y } = pointAt(inner);
    expect(resolveExternalDropTarget(root, x, y)).toBe('notes');
  });

  it('resolves a root-level file to the vault root', () => {
    const root = setup(
      `<div data-testid="file-explorer"><div class="explorer-tree">` +
        `<div data-path="todo.md" data-kind="file"><button>todo</button></div>` +
        `</div></div>`,
    );
    const file = root.querySelector('[data-path="todo.md"]')!;
    mockHit(file);
    const { x, y } = pointAt(file);
    expect(resolveExternalDropTarget(root, x, y)).toBe('');
  });

  it('resolves tree body whitespace to the vault root', () => {
    const root = setup(
      `<div data-testid="file-explorer"><div class="explorer-tree"><div class="explorer-empty">empty</div></div></div>`,
    );
    const empty = root.querySelector('.explorer-empty')!;
    mockHit(empty);
    const { x, y } = pointAt(empty);
    expect(resolveExternalDropTarget(root, x, y)).toBe('');
  });

  it('rejects drops outside the explorer', () => {
    const root = setup(
      `<div data-testid="file-explorer"><div class="explorer-tree"></div></div><div id="outside">x</div>`,
    );
    const outside = document.querySelector('#outside')!;
    mockHit(outside);
    const { x, y } = pointAt(outside);
    expect(resolveExternalDropTarget(root, x, y)).toBeNull();
  });

  it('rejects when no element is hit', () => {
    const root = setup(
      `<div data-testid="file-explorer"><div class="explorer-tree"></div></div>`,
    );
    mockHit(null);
    expect(resolveExternalDropTarget(root, 9999, 9999)).toBeNull();
  });
});
