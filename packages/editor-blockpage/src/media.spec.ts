/**
 *  media blocks: vault upload flow +
 * preview/players for image/video/audio/file + opt-in remote locators
 * sandboxed with offline fallback.
 *
 * - engine-free pm-map round-trips for the new atoms (vault + remote +
 *   presentation + universal children)
 * - provider security mirrors: hash-before-preview,
 *   byte caps, content sniffing, SVG img-only, text-only captions,
 *   re-validate-before-fetch, redirect/downgrade/timeout/cap/pin policy,
 *   lazy click-to-load + disclosure, never fetch for indexing
 * - editor integration via semantic snapshot/execute only (no provider
 *   toolbar DOM): slash catalog, insert-block, turn-into atom rejects,
 *   caption/alt/name edits, remote opt-in/clear, retry, upload→hash→
 *   preview offline, drag with subtree, single-undo everywhere
 *
 * No real network in tests: every remote test injects a mocked fetch.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  emptyBlockPage,
  imageBlock,
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
import {
  MAX_MEDIA_BYTES,
  REMOTE_DISCLOSURE_TEXT,
  assertUploadableBytes,
  asVaultAssetPath,
  fetchRemoteMedia,
  isFetchableRemoteUrl,
  isSvgBytes,
  isUnsafeVaultSrc,
  prepareMediaUpload,
  sniffMediaBytes,
  vaultSrcForHash,
} from './media-security.js';
import { cloneModel } from './model-edit.js';
import { MEDIA_PICKED_EVENT } from './media-view.js';

const REMOTE_URL = 'https://cdn.example.com/clip.mp4';
const VALID_PIN = 'a'.repeat(64);

/** Local media constructors (shapes live in foundation model.ts but
 * the package root does not re-export them, so specs build the canonical
 * shapes inline — field order matches the model constructors). */
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

const videoBlock = videoRecord;
const audioBlock = audioRecord;
const fileBlock = fileRecord;

// --- fakes ---

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

type MockResponse = {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly url: string;
  arrayBuffer(): Promise<ArrayBuffer>;
};

function mockResponse(
  status: number,
  headers: Record<string, string>,
  body: Uint8Array,
  url: string,
): MockResponse {
  const lowered = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    status,
    headers: { get: (name: string) => lowered.get(name.toLowerCase()) ?? null },
    url,
    arrayBuffer: async () => body.slice().buffer as ArrayBuffer,
  };
}

function stubBlobUrls(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  if (
    typeof g['__flbpBlobStubbed'] === 'boolean' &&
    g['__flbpBlobStubbed'] === true
  )
    return;
  g['__flbpBlobStubbed'] = true;
  let counter = 0;
  const urls = new Map<string, unknown>();
  (URL as unknown as Record<string, unknown>)['createObjectURL'] = (
    blob: unknown,
  ) => {
    counter += 1;
    const url = `blob:mock-${counter}`;
    urls.set(url, blob);
    return url;
  };
  (URL as unknown as Record<string, unknown>)['revokeObjectURL'] = (
    url: unknown,
  ) => {
    urls.delete(String(url));
  };
}

function mount(
  model: BlockPageModel,
  options?: {
    readonly assets?: DocumentAssetStore | null;
    readonly fetchFn?: (
      url: string,
      init?: Record<string, unknown>,
    ) => Promise<MockResponse>;
  },
) {
  stubBlobUrls();
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  let latest: BlockPageModel | null = null;
  const provider = new BlockPageDocumentEditorProvider();
  const handle = provider.createEditor({
    session: {} as never,
    parent,
    initialModel: model,
    onDirtyModel: (next: BlockPageModel) => {
      latest = next;
    },
    ...(options?.assets !== undefined && options.assets !== null
      ? { assets: options.assets }
      : {}),
    ...(options?.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
  } as never);
  return {
    parent,
    handle,
    latest: () => latest as BlockPageModel | null,
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

function uploadOf(env: ReturnType<typeof mount>) {
  const handle = env.handle as unknown as {
    uploadMedia(
      blockId: string | null,
      source: Uint8Array,
      options?: { fileName?: string },
    ): Promise<boolean>;
  };
  if (typeof handle.uploadMedia !== 'function')
    throw new Error('no uploadMedia');
  return handle.uploadMedia.bind(handle);
}

function blank(): BlockPageModel {
  const m = emptyBlockPage();
  m.rootOrder = ['p1'];
  m.blocks = { p1: paragraphBlock('p1', [{ text: '' }]) };
  return m;
}

const flush = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

function waitForText(
  parent: ParentNode,
  selector: string,
  expected: RegExp,
): Promise<Element> {
  const findMatch = (): Element | null => {
    const element = parent.querySelector(selector);
    return element !== null && expected.test(element.textContent ?? '')
      ? element
      : null;
  };
  const current = findMatch();
  if (current !== null) return Promise.resolve(current);
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      const match = findMatch();
      if (match === null) return;
      observer.disconnect();
      resolve(match);
    });
    observer.observe(parent, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  });
}

afterEach(() => {
  document.body.replaceChildren();
  document.getElementById('flbp-chrome-styles')?.remove();
});

// --- engine-free mapping ---

describe('media pm-map round-trips (engine-free)', () => {
  it('round-trips video/audio/file vault locators with presentation', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['v', 'a', 'f'];
    model.blocks = {
      v: videoBlock(
        'v',
        { src: 'attachments/h1', sha256: 'h1' },
        { name: 'N', caption: 'C', alt: 'A' },
      ),
      a: audioBlock(
        'a',
        { src: 'attachments/h2', sha256: 'h2' },
        { caption: 'Song' },
      ),
      f: fileBlock(
        'f',
        { src: 'attachments/h3', sha256: 'h3' },
        { name: 'Deck' },
      ),
    };
    const rebuilt = pmDocToModel(modelToPmDoc(model));
    expect(rebuilt.warnings).toEqual([]);
    expect(rebuilt.model.blocks['v']).toEqual(model.blocks['v']);
    expect(rebuilt.model.blocks['a']).toEqual(model.blocks['a']);
    expect(rebuilt.model.blocks['f']).toEqual(model.blocks['f']);
  });

  it('round-trips opt-in remote locators with pins preserved', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['v', 'a'];
    model.blocks = {
      v: videoBlock(
        'v',
        { remote: { url: REMOTE_URL }, sha256: VALID_PIN },
        { caption: 'Clip' },
      ),
      a: audioBlock(
        'a',
        { remote: { url: 'https://cdn.example.com/s.mp3' } },
        { name: 'Theme' },
      ),
    };
    const doc = modelToPmDoc(model);
    expect(doc.content![0]!.attrs?.['remoteUrl']).toBe(REMOTE_URL);
    const rebuilt = pmDocToModel(doc);
    expect(rebuilt.model.blocks['v']).toEqual(model.blocks['v']);
    expect(rebuilt.model.blocks['a']).toEqual(model.blocks['a']);
  });

  it('preserves invalid remote shapes verbatim (codec warns, provider never normalizes)', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'videoBlock',
          attrs: {
            blockId: 'v',
            src: '',
            sha256: '',
            remoteUrl: 'http://cdn.example.com/evil.mp4',
          },
        },
      ],
    };
    const { model } = pmDocToModel(doc as never);
    expect(model.blocks['v']).toEqual({
      id: 'v',
      type: 'froglight.video',
      remote: { url: 'http://cdn.example.com/evil.mp4' },
    });
  });

  it('preserves image caption/name alongside alt', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['i1'];
    model.blocks = {
      i1: {
        ...imageBlock('i1', 'attachments/h', 'h', 'Alt'),
        caption: 'Cap',
        name: 'N',
      },
    };
    const rebuilt = pmDocToModel(modelToPmDoc(model));
    expect(rebuilt.model.blocks['i1']).toEqual(model.blocks['i1']);
  });

  it('carries universal children of media atoms through the overflow group', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['v'];
    model.blocks = {
      v: {
        ...videoBlock('v', { src: 'attachments/h', sha256: 'h' }),
        children: ['c1'],
      },
      c1: paragraphBlock('c1', [{ text: 'nested note' }]),
    };
    const doc = modelToPmDoc(model);
    expect(doc.content!.some((n) => n.type === 'blockGroup')).toBe(true);
    const rebuilt = pmDocToModel(doc);
    expect(rebuilt.model.blocks['v']).toEqual(model.blocks['v']);
    expect(rebuilt.model.blocks['c1']).toEqual(model.blocks['c1']);
  });
});

// --- security unit mirrors ---

describe('media security helpers', () => {
  it('sniffs magic bytes, never extensions or MIME claims', () => {
    expect(
      sniffMediaBytes(
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ).kind,
    ).toBe('png');
    expect(sniffMediaBytes(new Uint8Array([0xff, 0xd8, 0xff, 0x00])).kind).toBe(
      'jpeg',
    );
    expect(sniffMediaBytes(new TextEncoder().encode('GIF89a...')).kind).toBe(
      'gif',
    );
    expect(sniffMediaBytes(new TextEncoder().encode('%PDF-1.7...')).kind).toBe(
      'pdf',
    );
    expect(sniffMediaBytes(new TextEncoder().encode('hello world')).kind).toBe(
      'unknown',
    );
  });

  it('detects SVG structurally for the img-only rule', () => {
    expect(
      isSvgBytes(
        new TextEncoder().encode(
          '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
        ),
      ),
    ).toBe(true);
    expect(
      isSvgBytes(
        new TextEncoder().encode('  \n<?xml version="1.0"?><svg></svg>'),
      ),
    ).toBe(true);
    expect(isSvgBytes(new TextEncoder().encode('<div>not svg</div>'))).toBe(
      false,
    );
  });

  it('enforces the per-asset byte cap before hashing', () => {
    expect(() => assertUploadableBytes(new Uint8Array(0))).toThrow();
    expect(() =>
      assertUploadableBytes(new Uint8Array(MAX_MEDIA_BYTES + 1)),
    ).toThrow();
    expect(assertUploadableBytes(new Uint8Array([1, 2, 3])).kind).toBe(
      'unknown',
    );
  });

  it('prepares vault-relative src + sha256 (asset-store mirror, never blob:)', async () => {
    const bytes = new TextEncoder().encode('fake-png-bytes');
    const prepared = await prepareMediaUpload(bytes, {
      suggestedName: 'photo.png',
    });
    expect(prepared.src).toBe(`attachments/${prepared.sha256}`);
    expect(prepared.src).toBe(vaultSrcForHash(prepared.sha256));
    expect(prepared.sha256).toBe(await sha256Hex(bytes));
    expect(prepared.src.startsWith('blob:')).toBe(false);
    expect(prepared.src.startsWith('data:')).toBe(false);
  });
});

describe('remote URL mirror (codec fixtures)', () => {
  const bad = [
    'http://cdn.example.com/c.mp4',
    '//cdn.example.com/c.mp4',
    'data:video/mp4;base64,AAAA',
    'blob:https://example.com/uuid',
    'https://user@cdn.example.com/c.mp4',
    'https://cdn.example.com/cli\tp.mp4',
    'https://cdn.example.com/cli\np.mp4',
    'https://cdn.example.com/cli\rp.mp4',
    'https://cdn.example.com\\clip.mp4',
    'https:/example.com/x',
    'https:///path',
    'https://?q',
    `https://example.com/${'x'.repeat(4_096)}`,
    ` ${REMOTE_URL} `,
  ];
  for (const url of bad) {
    it(`rejects ${JSON.stringify(url).slice(0, 48)}`, () => {
      expect(isFetchableRemoteUrl(url)).toBe(false);
    });
  }

  it('accepts ordinary https locators (case-insensitive scheme)', () => {
    expect(isFetchableRemoteUrl(REMOTE_URL)).toBe(true);
    expect(isFetchableRemoteUrl('HTTPS://cdn.example.com/clip.mp4')).toBe(true);
    expect(isFetchableRemoteUrl('https://cdn.example.com/@user/clip.mp4')).toBe(
      true,
    );
  });
});

describe('remote fetch policy (mocked fetch only)', () => {
  const bytes = new TextEncoder().encode('media-bytes');

  function ok(url: string, body: Uint8Array = bytes): MockResponse {
    return mockResponse(200, { 'content-type': 'video/mp4' }, body, url);
  }

  it('sends no credentials and no referrer', async () => {
    let seen: Record<string, unknown> | undefined;
    const fetchFn = async (url: string, init?: Record<string, unknown>) => {
      seen = init;
      return ok(url);
    };
    const result = await fetchRemoteMedia(REMOTE_URL, fetchFn as never);
    expect(result.ok).toBe(true);
    expect(seen?.['credentials']).toBe('omit');
    expect(seen?.['referrerPolicy']).toBe('no-referrer');
    expect(seen?.['redirect']).toBe('manual');
  });

  it('re-validates every redirect hop and fails closed on http-downgrade', async () => {
    const fetchFn = async (url: string) => {
      if (url === REMOTE_URL) {
        return mockResponse(
          302,
          { location: 'https://cdn.example.com/step2.mp4' },
          new Uint8Array(),
          url,
        );
      }
      return mockResponse(
        302,
        { location: 'http://cdn.example.com/evil.mp4' },
        new Uint8Array(),
        url,
      );
    };
    const result = await fetchRemoteMedia(REMOTE_URL, fetchFn as never);
    expect(result).toEqual({ ok: false, reason: 'downgrade' });
  });

  it('caps redirects at ~5', async () => {
    const fetchFn = async (url: string) => {
      const n = Number(url.match(/step(\d+)/)?.[1] ?? 0);
      return mockResponse(
        302,
        { location: `https://cdn.example.com/step${n + 1}.mp4` },
        new Uint8Array(),
        url,
      );
    };
    const result = await fetchRemoteMedia(REMOTE_URL, fetchFn as never, {
      maxRedirects: 2,
    });
    expect(result).toEqual({ ok: false, reason: 'too-many-redirects' });
  });

  it('refuses before fetching when the start URL is invalid', async () => {
    let calls = 0;
    const fetchFn = async (url: string) => {
      calls += 1;
      return ok(url);
    };
    const result = await fetchRemoteMedia(
      'http://cdn.example.com/x.mp4',
      fetchFn as never,
    );
    expect(result).toEqual({ ok: false, reason: 'invalid-url' });
    expect(calls).toBe(0);
  });

  it('enforces byte caps on declared and actual sizes', async () => {
    const declared = async () =>
      mockResponse(
        200,
        { 'content-length': String(MAX_MEDIA_BYTES + 1) },
        bytes,
        REMOTE_URL,
      );
    expect(await fetchRemoteMedia(REMOTE_URL, declared as never)).toEqual({
      ok: false,
      reason: 'too-large',
    });
    const actual = async () =>
      ok(REMOTE_URL, new Uint8Array(MAX_MEDIA_BYTES + 1));
    expect(await fetchRemoteMedia(REMOTE_URL, actual as never)).toEqual({
      ok: false,
      reason: 'too-large',
    });
  });

  it('checks the integrity pin when present', async () => {
    const real = await sha256Hex(bytes);
    const good = await fetchRemoteMedia(
      REMOTE_URL,
      (async (url: string) => ok(url)) as never,
      {
        pin: real,
      },
    );
    expect(good.ok).toBe(true);
    const badPin = await fetchRemoteMedia(
      REMOTE_URL,
      (async (url: string) => ok(url)) as never,
      {
        pin: VALID_PIN,
      },
    );
    expect(badPin).toEqual({ ok: false, reason: 'pin-mismatch' });
  });

  it('fails closed on http errors and network throws', async () => {
    const http = await fetchRemoteMedia(REMOTE_URL, (async (url: string) =>
      mockResponse(404, {}, new Uint8Array(), url)) as never);
    expect(http).toEqual({ ok: false, reason: 'http-error' });
    const net = await fetchRemoteMedia(REMOTE_URL, (async () => {
      throw new Error('down');
    }) as never);
    expect(net).toEqual({ ok: false, reason: 'network-error' });
  });
});

// --- editor integration ---

describe('media slash/insert/turn-into/drag (catalog + atoms)', () => {
  it('slash catalog offers Video/Audio/File insert rows', async () => {
    const env = mount(blank());
    try {
      command(env, 'insert-text', { text: '/' });
      await flush();
      const labels = [
        ...env.parent
          .querySelector('.flbp-slash:not(.flbp-resource-menu)')!
          .querySelectorAll('.flbp-slash-item'),
      ].map((el) => el.textContent);
      expect(labels).toContain('Video');
      expect(labels).toContain('Audio');
      expect(labels).toContain('File');
    } finally {
      env.cleanup();
    }
  });

  for (const type of ['video', 'audio', 'file'] as const) {
    it(`${type}: insert-block carries a stable id and move-block finds it`, () => {
      const env = mount(blank());
      try {
        expect(command(env, 'insert-block', { type })).toBe(true);
        const next = env.handle.getModelForTest!();
        expect(next.rootOrder.length).toBe(2);
        const insertedId = next.rootOrder[1]!;
        expect(insertedId).not.toBe('');
        expect(next.blocks[insertedId]).toBeDefined();
        expect(
          command(env, 'move-block', { blockId: insertedId, index: 0 }),
        ).toBe(true);
        expect(env.handle.getModelForTest!().rootOrder[0]).toBe(insertedId);
      } finally {
        env.cleanup();
      }
    });
  }

  it('turn-into to/from media rejects without mutation (atom rule)', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['v', 'p1'];
    model.blocks = {
      v: videoBlock('v', { src: 'attachments/h', sha256: 'h' }),
      p1: paragraphBlock('p1', [{ text: 'body' }]),
    };
    const env = mount(model);
    try {
      // From media: focus the atom, every target refuses.
      expect(command(env, 'select-block', { blockId: 'v' })).toBe(true);
      const before = env.handle.getModelForTest!();
      for (const target of [
        { type: 'paragraph' },
        { type: 'heading', level: 2 },
        { type: 'bullet' },
        { type: 'code' },
      ]) {
        expect(command(env, 'turn-into', target)).toBe(false);
        expect(env.handle.getModelForTest!()).toEqual(before);
      }
      // To media: unknown target refuses from a paragraph.
      expect(command(env, 'select-block', { blockId: 'p1' })).toBe(true);
      expect(command(env, 'turn-into', { type: 'video' })).toBe(false);
      expect(env.handle.getModelForTest!()).toEqual(before);
      expect(env.handle.canExecCommand?.('undo')).toBe(false);
    } finally {
      env.cleanup();
    }
  });

  it('drag moves media with its subtree (universal children ride along)', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['p1', 'v'];
    model.blocks = {
      p1: paragraphBlock('p1', [{ text: 'tail' }]),
      v: {
        ...videoBlock('v', { src: 'attachments/h', sha256: 'h' }),
        children: ['c1'],
      },
      c1: paragraphBlock('c1', [{ text: 'nested' }]),
    };
    const env = mount(model);
    try {
      expect(command(env, 'move-block', { blockId: 'v', index: 0 })).toBe(true);
      const next = env.handle.getModelForTest!();
      expect(next.rootOrder).toEqual(['v', 'p1']);
      expect(next.blocks['c1']).toBeDefined();
      expect((next.blocks['v'] as { children?: string[] }).children).toEqual([
        'c1',
      ]);
    } finally {
      env.cleanup();
    }
  });
});

describe('media semantic controls (caption/alt/name + remote opt-in + retry)', () => {
  function mediaModel(): BlockPageModel {
    const model = emptyBlockPage();
    model.rootOrder = ['v'];
    model.blocks = {
      v: videoBlock(
        'v',
        { src: 'attachments/h', sha256: 'h' },
        { caption: 'Old' },
      ),
    };
    return model;
  }

  it('caption edit is text-only and single-undo', () => {
    const env = mount(mediaModel());
    try {
      expect(command(env, 'select-block', { blockId: 'v' })).toBe(true);
      const before = env.handle.getModelForTest!();
      const injected = '<img src=x onerror=alert(1)>Hello';
      expect(toolsOf(env).execute('media.caption', injected)).toBe(true);
      const next = env.handle.getModelForTest!();
      expect((next.blocks['v'] as { caption?: string }).caption).toBe(injected);
      // Rendered as text only: no element interpretation.
      const caption = env.parent.querySelector(
        'figure[data-flbp-video] figcaption',
      )!;
      expect(caption.textContent).toBe(injected);
      expect(caption.querySelector('img')).toBeNull();
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });

  it('alt/name edits work; image rejects name (parity with caption rule)', () => {
    const env = mount(mediaModel());
    try {
      expect(command(env, 'select-block', { blockId: 'v' })).toBe(true);
      expect(toolsOf(env).execute('media.alt', 'descriptive')).toBe(true);
      expect(
        (env.handle.getModelForTest!().blocks['v'] as { alt?: string }).alt,
      ).toBe('descriptive');
      expect(toolsOf(env).execute('media.name', 'Clip name')).toBe(true);
      expect(
        (env.handle.getModelForTest!().blocks['v'] as { name?: string }).name,
      ).toBe('Clip name');
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.execCommand('undo')).toBe(true);
    } finally {
      env.cleanup();
    }
    const img = emptyBlockPage();
    img.rootOrder = ['i1'];
    img.blocks = { i1: imageBlock('i1', 'attachments/h', 'h', 'A') };
    const env2 = mount(img);
    try {
      expect(command(env2, 'select-block', { blockId: 'i1' })).toBe(true);
      const ids = toolsOf(env2)
        .snapshot()
        .controls.map((c) => c.id);
      expect(ids).toContain('media.caption');
      expect(ids).toContain('media.alt');
      expect(ids).not.toContain('media.name');
      expect(ids).not.toContain('media.remoteUrl');
      expect(toolsOf(env2).execute('media.name', 'Nope')).toBe(false);
    } finally {
      env2.cleanup();
    }
  });

  it('media details save caption, name, and alt in one undo step', () => {
    const env = mount(mediaModel());
    try {
      expect(command(env, 'select-block', { blockId: 'v' })).toBe(true);
      const before = env.handle.getModelForTest!();
      expect(
        toolsOf(env).execute(
          'media.details',
          JSON.stringify({
            name: 'Clip',
            caption: 'New caption',
            alt: 'Descriptive',
          }),
        ),
      ).toBe(true);
      expect(env.handle.getModelForTest!().blocks['v']).toMatchObject({
        name: 'Clip',
        caption: 'New caption',
        alt: 'Descriptive',
      });
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });

  it('remote opt-in validates https-only and never defaults (explicit action)', () => {
    const env = mount(mediaModel());
    try {
      expect(command(env, 'select-block', { blockId: 'v' })).toBe(true);
      const before = env.handle.getModelForTest!();
      // No remote by default: snapshot offers opt-in, model has none.
      expect(
        (before.blocks['v'] as { remote?: unknown }).remote,
      ).toBeUndefined();
      expect(
        toolsOf(env).execute('media.remoteUrl', 'http://cdn.example.com/x.mp4'),
      ).toBe(false);
      expect(toolsOf(env).execute('media.remoteUrl', 'not a url')).toBe(false);
      expect(env.handle.getModelForTest!()).toEqual(before);
      expect(toolsOf(env).execute('media.remoteUrl', REMOTE_URL)).toBe(true);
      const next = env.handle.getModelForTest!();
      expect(next.blocks['v']).toMatchObject({ remote: { url: REMOTE_URL } });
      // PM holds both locators transiently for in-session fallback, but
      // canonical keeps remote-only on save (vault src dropped — the
      // opt-in is destructive; re-upload restores via dedupe).
      expect((next.blocks['v'] as { sha256?: string }).sha256).toBeDefined();
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });

  it('clear-remote refuses when it would orphan (no vault bytes)', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['v'];
    model.blocks = { v: videoBlock('v', { remote: { url: REMOTE_URL } }) };
    const env = mount(model);
    try {
      expect(command(env, 'select-block', { blockId: 'v' })).toBe(true);
      const before = env.handle.getModelForTest!();
      expect(toolsOf(env).execute('media.clearRemote')).toBe(false);
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });

  it('media controls are absent off-media and on multi-root ranges', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['p1'];
    model.blocks = { p1: paragraphBlock('p1', [{ text: 'plain' }]) };
    const env = mount(model);
    try {
      expect(command(env, 'select-block', { blockId: 'p1' })).toBe(true);
      expect(
        toolsOf(env)
          .snapshot()
          .controls.map((c) => c.id),
      ).not.toContain('media.caption');
      expect(toolsOf(env).execute('media.caption', 'X')).toBe(false);
    } finally {
      env.cleanup();
    }
  });
});

describe('vault upload flow (upload→hash→preview offline)', () => {
  const pngBytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01,
  ]);

  it('uploadMedia writes vault-relative src + sha256 and previews via blob: URL (never canonical)', async () => {
    const assets = memoryAssets();
    const env = mount(blank(), { assets });
    try {
      expect(command(env, 'insert-block', { type: 'image' })).toBe(true);
      const insertedId = env.handle.getModelForTest!().rootOrder[1]!;
      const before = env.handle.getModelForTest!();
      expect(
        await uploadOf(env)(insertedId, pngBytes, { fileName: 'photo.png' }),
      ).toBe(true);
      const next = env.handle.getModelForTest!();
      const record = next.blocks[insertedId] as unknown as {
        src: string;
        sha256: string;
      };
      expect(record.src).toBe(`attachments/${record.sha256}`);
      expect(record.sha256).toBe(await sha256Hex(pngBytes));
      expect(assets.files.has(record.src)).toBe(true);
      await flush(30);
      // Preview uses a runtime blob: URL; canonical holds the vault path.
      const img = env.parent.querySelector(
        'figure[data-flbp-image] img',
      ) as HTMLImageElement | null;
      expect(img).not.toBeNull();
      expect(img!.src.startsWith('blob:')).toBe(true);
      expect(JSON.stringify(next)).not.toContain('blob:');
      // Single undo restores the pre-upload placeholder.
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });

  it('flbp:media-picked routes the first file into uploadMedia (host wiring)', async () => {
    const assets = memoryAssets();
    const env = mount(blank(), { assets });
    try {
      expect(command(env, 'insert-block', { type: 'image' })).toBe(true);
      const insertedId = env.handle.getModelForTest!().rootOrder[1]!;
      const host = env.parent.querySelector('.flbp-host')!;
      // Mirror the skeleton exactly: the answer event is dispatched on the
      // host with { blockId, kind, capture, files }.
      host.dispatchEvent(
        new CustomEvent(MEDIA_PICKED_EVENT, {
          detail: {
            blockId: insertedId,
            kind: 'image',
            capture: false,
            files: [
              {
                arrayBuffer: async () => pngBytes.slice().buffer as ArrayBuffer,
                size: pngBytes.length,
                name: 'pixel.png',
                type: 'image/png',
              },
            ],
          },
          bubbles: true,
        }),
      );
      await flush(30);
      const next = env.handle.getModelForTest!();
      const record = next.blocks[insertedId] as unknown as {
        src: string;
        sha256: string;
      };
      expect(record.src).toBe(`attachments/${record.sha256}`);
      expect(record.sha256).toBe(await sha256Hex(pngBytes));
      expect(assets.files.has(record.src)).toBe(true);
      await flush(30);
      // The filled figure hydrates to a live runtime preview (same as the
      // direct-upload path — one ingestion primitive, no second path).
      const img = env.parent.querySelector(
        'figure[data-flbp-image] img',
      ) as HTMLImageElement | null;
      expect(img).not.toBeNull();
      expect(img!.src.startsWith('blob:')).toBe(true);
      // Malformed answers (missing blockId/files) are a no-op, never a throw.
      host.dispatchEvent(
        new CustomEvent(MEDIA_PICKED_EVENT, { detail: {}, bubbles: true }),
      );
      await flush(20);
      expect(env.handle.getModelForTest!()).toEqual(next);
    } finally {
      env.cleanup();
    }
  });

  it('upload rejects over-cap bytes without mutation', async () => {
    const assets = memoryAssets();
    const env = mount(blank(), { assets });
    try {
      expect(command(env, 'insert-block', { type: 'video' })).toBe(true);
      const insertedId = env.handle.getModelForTest!().rootOrder[1]!;
      const before = env.handle.getModelForTest!();
      const dirtyAfterInsert = env.latest();
      expect(
        await uploadOf(env)(insertedId, new Uint8Array(MAX_MEDIA_BYTES + 1)),
      ).toBe(false);
      expect(env.handle.getModelForTest!()).toEqual(before);
      // No new dirty signal: the failed upload dispatched nothing.
      expect(env.latest()).toBe(dirtyAfterInsert);
    } finally {
      env.cleanup();
    }
  });

  it('video/audio render offline players (preload metadata, no autoplay); file renders an attachment row', async () => {
    const assets = memoryAssets();
    const mp4 = new Uint8Array([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32,
    ]);
    const model = emptyBlockPage();
    model.rootOrder = ['v', 'a', 'f'];
    model.blocks = {
      v: videoBlock('v', { src: 'attachments/x', sha256: 'x' }),
      a: audioBlock('a', { src: 'attachments/y', sha256: 'y' }),
      f: fileBlock(
        'f',
        { src: 'attachments/z', sha256: 'z' },
        { name: 'Deck.pdf' },
      ),
    };
    const sha = async (b: Uint8Array) => await sha256Hex(b);
    const yBytes = new Uint8Array([0x49, 0x44, 0x33, 0x01]);
    const zBytes = new TextEncoder().encode('%PDF-1.7');
    assets.files.set('attachments/x', mp4);
    assets.files.set('attachments/y', yBytes);
    assets.files.set('attachments/z', zBytes);
    // Re-hash so integrity checks pass.
    (model.blocks['v'] as unknown as { sha256: string }).sha256 =
      await sha(mp4);
    (model.blocks['a'] as unknown as { sha256: string }).sha256 =
      await sha(yBytes);
    (model.blocks['f'] as unknown as { sha256: string }).sha256 =
      await sha(zBytes);
    const env = mount(model, { assets });
    try {
      await expect
        .poll(
          () =>
            env.parent.querySelectorAll(
              'figure[data-flbp-video] video, figure[data-flbp-audio] audio, figure[data-flbp-file] .flbp-media-file',
            ).length,
        )
        .toBe(3);
      const video = env.parent.querySelector(
        'figure[data-flbp-video] video',
      ) as HTMLVideoElement | null;
      expect(video).not.toBeNull();
      expect(video!.preload).toBe('metadata');
      expect(video!.autoplay).toBe(false);
      expect(video!.hasAttribute('controls')).toBe(true);
      const audio = env.parent.querySelector(
        'figure[data-flbp-audio] audio',
      ) as HTMLAudioElement | null;
      expect(audio).not.toBeNull();
      expect(audio!.preload).toBe('metadata');
      const row = env.parent.querySelector(
        'figure[data-flbp-file] .flbp-media-file',
      );
      expect(row).not.toBeNull();
      expect(row!.textContent).toContain('Deck.pdf');
      for (const [blockId, kind, liveSelector] of [
        ['v', 'video', 'video'],
        ['a', 'audio', 'audio'],
        ['f', 'file', '.flbp-media-file'],
      ] as const) {
        const figure = env.parent.querySelector(
          `figure[data-flbp-${kind}]`,
        ) as HTMLElement;
        expect(figure.dataset.flbpMediaHydrated).toBe('live');
        expect(figure.querySelector(':scope > .flbp-media-status')).toBeNull();
        const live = figure.querySelector(`:scope > ${liveSelector}`);
        const caption = figure.querySelector(':scope > figcaption');
        expect(live).not.toBeNull();
        expect(caption).not.toBeNull();
        expect([...figure.children].indexOf(live as Element)).toBeLessThan(
          [...figure.children].indexOf(caption as Element),
        );
        expect(command(env, 'select-block', { blockId })).toBe(true);
        expect(
          toolsOf(env)
            .snapshot()
            .controls.find((control) => control.id === 'media.replace'),
        ).toMatchObject({ label: `Replace ${kind}` });
      }
    } finally {
      env.cleanup();
    }
  });

  it('integrity mismatch never renders (placeholder, canonical preserved)', async () => {
    const assets = memoryAssets();
    assets.files.set('attachments/bad', new TextEncoder().encode('tampered'));
    const model = emptyBlockPage();
    model.rootOrder = ['i1'];
    model.blocks = {
      i1: imageBlock('i1', 'attachments/bad', 'wrong-hash', 'A'),
    };
    const env = mount(model, { assets });
    try {
      const status = await waitForText(
        env.parent,
        '.flbp-media-status',
        /integrity/i,
      );
      expect(
        env.parent.querySelector('figure[data-flbp-image] img'),
      ).toBeNull();
      expect(status.textContent).toMatch(/integrity/i);
      expect(env.handle.getModelForTest!().blocks['i1']).toEqual(
        model.blocks['i1'],
      );
    } finally {
      env.cleanup();
    }
  });
});

describe('opt-in remote rendering (gated + sandboxed + fallback + disclosure)', () => {
  const pngBytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01,
  ]);

  function remoteModel(): BlockPageModel {
    const model = emptyBlockPage();
    model.rootOrder = ['v'];
    model.blocks = {
      v: videoBlock('v', { remote: { url: REMOTE_URL } }, { caption: 'Clip' }),
    };
    return model;
  }

  it('never fetches on mount/index; gate shows disclosure + Load', async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls += 1;
      return mockResponse(200, {}, pngBytes, REMOTE_URL);
    };
    const env = mount(remoteModel(), { fetchFn: fetchFn as never });
    try {
      await flush(30);
      expect(calls).toBe(0);
      const status = env.parent.querySelector(
        'figure[data-flbp-video] .flbp-media-status',
      )!;
      expect(status.textContent).toContain(REMOTE_DISCLOSURE_TEXT);
      expect(status.querySelector('button')!.textContent).toMatch(
        /Load remote/,
      );
      expect(
        env.parent.querySelector('figure[data-flbp-video] video'),
      ).toBeNull();
    } finally {
      env.cleanup();
    }
  });

  it('Load click fetches once with policy, then previews sandboxed (no script, no autoplay)', async () => {
    const fetchFn = async (url: string) =>
      mockResponse(200, { 'content-type': 'video/mp4' }, pngBytes, url);
    const env = mount(remoteModel(), { fetchFn: fetchFn as never });
    try {
      await flush(20);
      const before = env.handle.getModelForTest!();
      (
        env.parent.querySelector(
          'figure[data-flbp-video] .flbp-media-action',
        ) as HTMLButtonElement
      ).click();
      await flush(30);
      const video = env.parent.querySelector('figure[data-flbp-video] video');
      expect(video).not.toBeNull();
      // Canonical bytes never rewritten by the fetch outcome.
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });

  it('offline/unreachable renders a placeholder with retry, canonical untouched', async () => {
    const fetchFn = async () => {
      throw new Error('offline');
    };
    const env = mount(remoteModel(), { fetchFn: fetchFn as never });
    try {
      await flush(20);
      const before = env.handle.getModelForTest!();
      (
        env.parent.querySelector(
          'figure[data-flbp-video] .flbp-media-action',
        ) as HTMLButtonElement
      ).click();
      await flush(30);
      const status = env.parent.querySelector(
        'figure[data-flbp-video] .flbp-media-status',
      )!;
      expect(status.textContent).toMatch(/unreachable|offline|preserved/i);
      expect(status.querySelector('button')!.textContent).toMatch(/Retry/);
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });

  it('remote SVG renders via <img> only, never inline', async () => {
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    );
    const model = emptyBlockPage();
    model.rootOrder = ['i1'];
    model.blocks = { i1: videoBlock('i1', { remote: { url: REMOTE_URL } }) };
    const fetchFn = async (url: string) =>
      mockResponse(200, { 'content-type': 'image/svg+xml' }, svg, url);
    const env = mount(model, { fetchFn: fetchFn as never });
    try {
      await flush(20);
      (
        env.parent.querySelector('.flbp-media-action') as HTMLButtonElement
      ).click();
      await flush(30);
      const figure = env.parent.querySelector('figure[data-flbp-video]')!;
      expect(figure.querySelector('svg')).toBeNull();
      // SVG bytes through an <img>/<video> element surface, never innerHTML.
      expect(figure.innerHTML).not.toContain('<svg');
    } finally {
      env.cleanup();
    }
  });
});

describe('headless/mock session equivalence for media mappings', () => {
  it('headless opens Tiptap-saved media byte-faithful and ingests identically', async () => {
    const assets = memoryAssets();
    const start = emptyBlockPage();
    start.rootOrder = ['v'];
    start.blocks = {
      v: videoBlock(
        'v',
        { remote: { url: REMOTE_URL }, sha256: VALID_PIN },
        { caption: 'Clip' },
      ),
    };
    let saved: BlockPageModel | null = null;
    const env = mount(start, { assets });
    try {
      saved = env.handle.getModelForTest!();
    } finally {
      env.cleanup();
    }
    const headless = new HeadlessBlockpageEditorHandle({
      session: {} as never,
      parent: {},
      initialModel: saved!,
      onDirtyModel: () => undefined,
      assets,
    });
    expect(headless.getModelForTest().blocks['v']).toEqual(start.blocks['v']);
    const bytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    expect(await headless.uploadMedia('v', bytes)).toBe(true);
    const record = headless.getModelForTest().blocks['v'] as unknown as {
      src: string;
      sha256: string;
    };
    expect(record.src).toBe(`attachments/${await sha256Hex(bytes)}`);
    headless.destroy();
  });

  it('Tiptap and headless ingestion converge on identical canonical bytes', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.7-bytes');
    const expected = await sha256Hex(bytes);
    const makeStart = (): BlockPageModel => {
      const m = emptyBlockPage();
      m.rootOrder = ['f'];
      m.blocks = { f: fileBlock('f', { src: 'attachments/', sha256: '' }) };
      return m;
    };
    const assets = memoryAssets();
    const env = mount(makeStart(), { assets });
    let tiptapRecord: unknown;
    try {
      expect(await uploadOf(env)('f', bytes)).toBe(true);
      tiptapRecord = cloneModel(env.handle.getModelForTest!()).blocks['f'];
    } finally {
      env.cleanup();
    }
    const headless = new HeadlessBlockpageEditorHandle({
      session: {} as never,
      parent: {},
      initialModel: makeStart(),
      onDirtyModel: () => undefined,
      assets: memoryAssets(),
    });
    expect(await headless.uploadMedia('f', bytes)).toBe(true);
    expect(headless.getModelForTest().blocks['f']).toEqual(tiptapRecord);
    expect((tiptapRecord as { src: string }).src).toBe(
      `attachments/${expected}`,
    );
    headless.destroy();
  });

  it('null-create converges: sniffed kind + presentation match Tiptap (modulo fresh id)', async () => {
    // R1: headless uploadMedia(null) must infer the block type from the
    // sniffed bytes exactly like the Tiptap null path (mime-prefix mapping)
    // and carry the same presentation defaults, so canonical records agree
    // byte-for-byte modulo the fresh null-create id.
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01,
    ]);
    const pdfBytes = new TextEncoder().encode('%PDF-1.7-bytes');
    const mp4Bytes = new Uint8Array([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32,
    ]);
    const audioBytes = new Uint8Array([0x49, 0x44, 0x33, 0x01]);
    const cases = [
      { bytes: pngBytes, type: 'froglight.image' },
      { bytes: pdfBytes, type: 'froglight.file' },
      { bytes: mp4Bytes, type: 'froglight.video' },
      { bytes: audioBytes, type: 'froglight.audio' },
    ] as const;
    const withoutId = (record: unknown): unknown => {
      const { id: _drop, ...rest } = record as Record<string, unknown>;
      void _drop;
      return rest;
    };
    for (const { bytes, type } of cases) {
      const expectedSha = await sha256Hex(bytes);
      let tiptapRecord: unknown;
      const env = mount(blank(), { assets: memoryAssets() });
      try {
        expect(await uploadOf(env)(null, bytes)).toBe(true);
        const model = cloneModel(env.handle.getModelForTest!());
        const insertedId = model.rootOrder[model.rootOrder.length - 1]!;
        tiptapRecord = model.blocks[insertedId];
        expect((tiptapRecord as { type: string }).type).toBe(type);
      } finally {
        env.cleanup();
      }
      const headless = new HeadlessBlockpageEditorHandle({
        session: {} as never,
        parent: {},
        initialModel: blank(),
        onDirtyModel: () => undefined,
        assets: memoryAssets(),
      });
      try {
        expect(await headless.uploadMedia(null, bytes)).toBe(true);
        const model = headless.getModelForTest();
        const insertedId = model.rootOrder[model.rootOrder.length - 1]!;
        const record = model.blocks[insertedId] as Record<string, unknown>;
        expect(record['type']).toBe(type);
        expect(record['src']).toBe(`attachments/${expectedSha}`);
        expect(record['sha256']).toBe(expectedSha);
        expect(withoutId(record)).toEqual(withoutId(tiptapRecord));
      } finally {
        headless.destroy();
      }
    }
  });

  it('headless null-create honors an explicit kind over the sniff (single undo)', async () => {
    const pdfBytes = new TextEncoder().encode('%PDF-1.7-bytes');
    const headless = new HeadlessBlockpageEditorHandle({
      session: {} as never,
      parent: {},
      initialModel: blank(),
      onDirtyModel: () => undefined,
      assets: memoryAssets(),
    });
    try {
      expect(
        await headless.uploadMedia(null, pdfBytes, { kind: 'image' }),
      ).toBe(true);
      const model = headless.getModelForTest();
      const insertedId = model.rootOrder[model.rootOrder.length - 1]!;
      const record = model.blocks[insertedId] as unknown as {
        type: string;
        alt: string;
      };
      expect(record.type).toBe('froglight.image');
      expect(record.alt).toBe('');
      // Single-undo preserved: one execCommand('undo') restores blank.
      expect(headless.execCommand('undo')).toBe(true);
      expect(headless.getModelForTest().rootOrder).toEqual(['p1']);
    } finally {
      headless.destroy();
    }
  });
});

// --- repair specs (taken optionals) ---

describe('vault src validation', () => {
  const pngBytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01,
  ]);
  const hostile = [
    '../notes/secret',
    '/notes/secret',
    '..\\notes\\secret',
    'attachments/../../secret',
    'attachments/',
  ];

  it('rejects traversal/absolute/backslash/bare srcs with a placeholder and never calls assets.read', async () => {
    const assets = memoryAssets();
    // Plant the "secret": even though hostile bytes exist in the store, a
    // hostile src must never reach `read` (no blob URL, no exfiltration).
    for (const key of hostile) assets.files.set(key, pngBytes);
    for (const src of hostile) {
      const model = emptyBlockPage();
      model.rootOrder = ['i1'];
      model.blocks = { i1: imageBlock('i1', src, 'a'.repeat(64), 'A') };
      const env = mount(model, { assets });
      try {
        await flush(30);
        expect(
          env.parent.querySelector('figure[data-flbp-image] img'),
        ).toBeNull();
        expect(
          env.parent.querySelector('.flbp-media-status')!.textContent,
        ).toMatch(/validation|not read/i);
        expect(
          (env.parent.querySelector('figure[data-flbp-image]') as HTMLElement)
            .dataset.flbpMediaReason,
        ).toBe('invalid-src');
      } finally {
        env.cleanup();
      }
    }
    expect(assets.reads).toEqual([]);
  });

  it('still hydrates a valid attachments/<hash> src', async () => {
    const assets = memoryAssets();
    const sha = await sha256Hex(pngBytes);
    assets.files.set(`attachments/${sha}`, pngBytes);
    const model = emptyBlockPage();
    model.rootOrder = ['i1'];
    model.blocks = { i1: imageBlock('i1', `attachments/${sha}`, sha, 'A') };
    const env = mount(model, { assets });
    try {
      await flush(30);
      const img = env.parent.querySelector(
        'figure[data-flbp-image] img',
      ) as HTMLImageElement | null;
      expect(img).not.toBeNull();
      expect(img!.src.startsWith('blob:')).toBe(true);
      expect(assets.reads).toEqual([`attachments/${sha}`]);
    } finally {
      env.cleanup();
    }
  });

  it('mirrors the foundation traversal rule (fixture pin)', () => {
    // Unsafe shapes per `isUnsafeAssetSrc` in foundation blocks/model.ts:
    // absolute, backslash anywhere, or a `..` segment. The provider mirror
    // must agree exactly — drift fails this spec.
    for (const bad of [
      '/a',
      '/attachments/x',
      'a\\b',
      '..',
      '../x',
      'a/../b',
      'a/..',
    ]) {
      expect(isUnsafeVaultSrc(bad)).toBe(true);
    }
    // '' carries no traversal (foundation returns false too) — the typed
    // path helper still refuses it for the missing attachments/ prefix.
    expect(isUnsafeVaultSrc('')).toBe(false);
    for (const good of ['attachments/abc', 'attachments/a/b']) {
      expect(isUnsafeVaultSrc(good)).toBe(false);
    }
    expect(asVaultAssetPath('attachments/abc')).toBe('attachments/abc');
    for (const bad of [
      '../x',
      '/x',
      'a\\b',
      'attachments/',
      'other/x',
      '',
      42,
      null,
    ]) {
      expect(asVaultAssetPath(bad)).toBeNull();
    }
  });
});

describe('empty integrity pin fails closed', () => {
  const pngBytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01,
  ]);
  const mp4Bytes = new Uint8Array([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32,
  ]);

  it('image + video with valid src but sha256 "" render the integrity placeholder, never media', async () => {
    const assets = memoryAssets();
    const shaPng = await sha256Hex(pngBytes);
    const shaMp4 = await sha256Hex(mp4Bytes);
    assets.files.set(`attachments/${shaPng}`, pngBytes);
    assets.files.set(`attachments/${shaMp4}`, mp4Bytes);
    const model = emptyBlockPage();
    model.rootOrder = ['i1', 'v'];
    model.blocks = {
      i1: imageBlock('i1', `attachments/${shaPng}`, '', 'A'),
      v: videoBlock('v', { src: `attachments/${shaMp4}`, sha256: '' }),
    };
    const env = mount(model, { assets });
    try {
      await flush(30);
      expect(
        env.parent.querySelector('figure[data-flbp-image] img'),
      ).toBeNull();
      expect(
        env.parent.querySelector('figure[data-flbp-video] video'),
      ).toBeNull();
      const statuses = [
        ...env.parent.querySelectorAll('.flbp-media-status'),
      ].map((el) => el.textContent);
      expect(statuses.length).toBe(2);
      for (const text of statuses) expect(text).toMatch(/integrity/i);
      const reasons = [
        ...env.parent.querySelectorAll(
          'figure[data-flbp-image], figure[data-flbp-video]',
        ),
      ].map((el) => (el as HTMLElement).dataset.flbpMediaReason);
      expect(reasons).toEqual(['integrity', 'integrity']);
      // Reads happened (offline bytes reachable); rendering refused.
      expect(assets.reads.length).toBe(2);
    } finally {
      env.cleanup();
    }
  });

  it('a correct pin still renders (no fail-closed regression)', async () => {
    const assets = memoryAssets();
    const sha = await sha256Hex(mp4Bytes);
    assets.files.set(`attachments/${sha}`, mp4Bytes);
    const model = emptyBlockPage();
    model.rootOrder = ['v'];
    model.blocks = {
      v: videoBlock('v', { src: `attachments/${sha}`, sha256: sha }),
    };
    const env = mount(model, { assets });
    try {
      await expect
        .poll(() => env.parent.querySelector('figure[data-flbp-video] video'))
        .not.toBeNull();
    } finally {
      env.cleanup();
    }
  });
});

describe('slash-insert placeholder prefix', () => {
  for (const type of ['image', 'video', 'audio', 'file'] as const) {
    it(`${type} placeholder src unifies on attachments/`, () => {
      const env = mount(blank());
      try {
        expect(command(env, 'insert-block', { type })).toBe(true);
        const next = env.handle.getModelForTest!();
        const insertedId = next.rootOrder[1]!;
        const record = next.blocks[insertedId] as unknown as {
          src: string;
          sha256: string;
        };
        expect(record.src).toBe('attachments/');
        expect(record.sha256).toBe('');
      } finally {
        env.cleanup();
      }
    });
  }
});

describe('upload commits the store-returned path', () => {
  const pngBytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01,
  ]);

  it('commits put-path (store owns naming), then hydrates from it', async () => {
    const hash = await sha256Hex(pngBytes);
    const renamed = `attachments/${hash}-renamed` as WorkspacePath;
    const files = new Map<string, Uint8Array>();
    const qualifying: DocumentAssetStore = {
      async put(data: Uint8Array) {
        const sha256 = await sha256Hex(data);
        files.set(renamed, data.slice());
        return { path: renamed, sha256 };
      },
      async read(path: WorkspacePath) {
        const hit = files.get(String(path));
        if (hit === undefined)
          throw Object.assign(new Error('not found'), { code: 'NOT_FOUND' });
        return hit.slice();
      },
    };
    const env = mount(blank(), { assets: qualifying });
    try {
      expect(command(env, 'insert-block', { type: 'image' })).toBe(true);
      const insertedId = env.handle.getModelForTest!().rootOrder[1]!;
      expect(await uploadOf(env)(insertedId, pngBytes)).toBe(true);
      const record = env.handle.getModelForTest!().blocks[
        insertedId
      ] as unknown as {
        src: string;
        sha256: string;
      };
      expect(record.src).toBe(renamed);
      expect(record.sha256).toBe(hash);
      await flush(30);
      const img = env.parent.querySelector(
        'figure[data-flbp-image] img',
      ) as HTMLImageElement | null;
      expect(img).not.toBeNull();
      expect(img!.src.startsWith('blob:')).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  it('refuses a hostile store locator (traversal path / bad pin) with no commit', async () => {
    const hostileReturns = [
      { path: '../../evil', sha256: 'zz' },
      { path: '../../evil', sha256: 'a'.repeat(64) },
      { path: `attachments/${'b'.repeat(64)}`, sha256: 'zz' },
    ];
    for (const hostile of hostileReturns) {
      const store: DocumentAssetStore = {
        async put() {
          return {
            path: hostile.path as WorkspacePath,
            sha256: hostile.sha256,
          };
        },
        async read() {
          throw Object.assign(new Error('not found'), { code: 'NOT_FOUND' });
        },
      };
      const env = mount(blank(), { assets: store });
      try {
        expect(command(env, 'insert-block', { type: 'image' })).toBe(true);
        const insertedId = env.handle.getModelForTest!().rootOrder[1]!;
        const before = cloneModel(env.handle.getModelForTest!());
        expect(await uploadOf(env)(insertedId, pngBytes)).toBe(false);
        expect(env.handle.getModelForTest!()).toEqual(before);
      } finally {
        env.cleanup();
      }
    }
  });

  it('headless refuses a hostile store locator with no model change', async () => {
    const start = emptyBlockPage();
    start.rootOrder = ['i1'];
    start.blocks = {
      i1: imageBlock(
        'i1',
        `attachments/${'c'.repeat(64)}`,
        'c'.repeat(64),
        'A',
      ),
    };
    const hostile: DocumentAssetStore = {
      async put() {
        return { path: '../../evil' as WorkspacePath, sha256: 'zz' };
      },
      async read() {
        throw Object.assign(new Error('not found'), { code: 'NOT_FOUND' });
      },
    };
    const headless = new HeadlessBlockpageEditorHandle({
      session: {} as never,
      parent: {},
      initialModel: start,
      onDirtyModel: () => undefined,
      assets: hostile,
    });
    try {
      const before = cloneModel(headless.getModelForTest());
      expect(await headless.uploadMedia('i1', pngBytes)).toBe(false);
      expect(headless.getModelForTest()).toEqual(before);
    } finally {
      headless.destroy();
    }
  });
});

describe('unbound store diagnostic', () => {
  it('vault block without a bound store renders the bind-storage placeholder with the unbound-store reason', async () => {
    const model = emptyBlockPage();
    model.rootOrder = ['v'];
    model.blocks = {
      v: videoBlock('v', { src: 'attachments/h', sha256: 'h' }),
    };
    const env = mount(model);
    try {
      await flush(30);
      const figure = env.parent.querySelector(
        'figure[data-flbp-video]',
      ) as HTMLElement;
      expect(figure.querySelector('video')).toBeNull();
      expect(figure.querySelector('.flbp-media-status')!.textContent).toMatch(
        /Bind storage/i,
      );
      expect(figure.dataset.flbpMediaReason).toBe('unbound-store');
    } finally {
      env.cleanup();
    }
  });
});

describe('media hardening optionals', () => {
  const pngBytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01,
  ]);

  it('sniffs M4A as audio and HEIC as image; unknown ftyp brands fall back to file', () => {
    const ftyp = (brand: string): Uint8Array => {
      const out = new Uint8Array([
        0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x00, 0x00, 0x00, 0x00,
      ]);
      for (let i = 0; i < 4; i += 1) out[8 + i] = brand.charCodeAt(i);
      return out;
    };
    expect(sniffMediaBytes(ftyp('mp42')).mime).toBe('video/mp4');
    expect(sniffMediaBytes(ftyp('M4A ')).mime).toBe('audio/mp4');
    expect(sniffMediaBytes(ftyp('heic')).mime).toBe('image/heic');
    const weird = sniffMediaBytes(ftyp('abcd'));
    expect(weird.kind).toBe('unknown');
    expect(weird.mime).toBe('application/octet-stream');
  });

  it('refuses declared oversize before reading the body', async () => {
    let calls = 0;
    const heavy = {
      size: MAX_MEDIA_BYTES + 1,
      arrayBuffer: async () => {
        calls += 1;
        return new Uint8Array([1]).buffer as ArrayBuffer;
      },
    };
    await expect(prepareMediaUpload(heavy)).rejects.toThrow(/cap/);
    expect(calls).toBe(0);
  });

  it('upload converts File-likes exactly once (single-read reuse)', async () => {
    let calls = 0;
    const file = {
      size: pngBytes.byteLength,
      arrayBuffer: async () => {
        calls += 1;
        return pngBytes.slice().buffer as ArrayBuffer;
      },
    };
    const assets = memoryAssets();
    const env = mount(blank(), { assets });
    try {
      expect(command(env, 'insert-block', { type: 'image' })).toBe(true);
      const insertedId = env.handle.getModelForTest!().rootOrder[1]!;
      expect(await uploadOf(env)(insertedId, file as never)).toBe(true);
      expect(calls).toBe(1);
      await flush(30);
      expect(
        env.parent.querySelector('figure[data-flbp-image] img'),
      ).not.toBeNull();
    } finally {
      env.cleanup();
    }
  });

  it('a body arriving after the deadline fails closed as a timeout', async () => {
    const late = new TextEncoder().encode('late-bytes');
    const fetchFn = async (url: string) => ({
      status: 200,
      headers: { get: (_name: string) => null },
      url,
      arrayBuffer: async () => {
        await new Promise((r) => setTimeout(r, 60));
        return late.slice().buffer as ArrayBuffer;
      },
    });
    const result = await fetchRemoteMedia(REMOTE_URL, fetchFn as never, {
      timeoutMs: 10,
    });
    expect(result).toEqual({ ok: false, reason: 'timeout' });
  });

  it('a stale gated fetch never renders over a newer locator (generation guard)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const fetchFn = async (url: string) => {
      await gate;
      return mockResponse(200, { 'content-type': 'video/mp4' }, pngBytes, url);
    };
    const model = emptyBlockPage();
    model.rootOrder = ['v'];
    model.blocks = { v: videoBlock('v', { remote: { url: REMOTE_URL } }) };
    const env = mount(model, { fetchFn: fetchFn as never });
    try {
      await flush(20);
      (
        env.parent.querySelector(
          'figure[data-flbp-video] .flbp-media-action',
        ) as HTMLButtonElement
      ).click();
      expect(command(env, 'select-block', { blockId: 'v' })).toBe(true);
      const next = 'https://cdn.example.com/other.mp4';
      expect(toolsOf(env).execute('media.remoteUrl', next)).toBe(true);
      release();
      await flush(30);
      // Stale bytes never render; the gate re-rendered for the new locator.
      expect(
        env.parent.querySelector('figure[data-flbp-video] video'),
      ).toBeNull();
      expect(
        env.parent.querySelector('figure[data-flbp-video] .flbp-media-status')!
          .textContent,
      ).toContain(next);
    } finally {
      env.cleanup();
    }
  });

  it('image creates omit the remote key', async () => {
    const assets = memoryAssets();
    const env = mount(blank(), { assets });
    try {
      expect(await uploadOf(env)(null, pngBytes)).toBe(true);
      const figure = env.parent.querySelector('figure[data-flbp-image]')!;
      expect(figure.hasAttribute('data-remote-url')).toBe(false);
    } finally {
      env.cleanup();
    }
  });

  it('file download sanitizes hostile names to basenames', async () => {
    const assets = memoryAssets();
    const zBytes = new TextEncoder().encode('%PDF-1.7');
    const sha = await sha256Hex(zBytes);
    assets.files.set(`attachments/${sha}`, zBytes);
    const model = emptyBlockPage();
    model.rootOrder = ['f'];
    model.blocks = {
      f: fileBlock(
        'f',
        { src: `attachments/${sha}`, sha256: sha },
        { name: '../../evil.pdf' },
      ),
    };
    const env = mount(model, { assets });
    try {
      await flush(30);
      const open = env.parent.querySelector(
        '.flbp-media-file-open',
      ) as HTMLAnchorElement | null;
      expect(open).not.toBeNull();
      expect(open!.getAttribute('download')).toBe('evil.pdf');
    } finally {
      env.cleanup();
    }
  });
});

describe('host-owned media picker', () => {
  const pngBytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01,
  ]);

  function gridModel(): BlockPageModel {
    const model = emptyBlockPage();
    model.rootOrder = ['t1'];
    model.blocks = {
      t1: tableBlock('t1', 2, [{ cells: [[{ text: 'a' }], [{ text: 'b' }]] }]),
    };
    return model;
  }

  for (const type of ['image', 'video', 'audio', 'file'] as const) {
    it(`${type} empty placeholder shows Add/Capture with picker attrs and never reads the store`, async () => {
      const assets = memoryAssets();
      const env = mount(blank(), { assets });
      try {
        expect(command(env, 'insert-block', { type })).toBe(true);
        await flush(30);
        const figure = env.parent.querySelector(
          `figure[data-flbp-${type}]`,
        ) as HTMLElement;
        expect(figure).not.toBeNull();
        expect(figure.dataset.flbpMediaReason).toBe('no-media');
        expect(figure.querySelector('.flbp-media-status')!.textContent).toMatch(
          /No media yet/,
        );
        const add = figure.querySelector<HTMLButtonElement>(
          '[data-flbp-media-pick="add"]',
        );
        const capture = figure.querySelector<HTMLButtonElement>(
          '[data-flbp-media-pick="capture"]',
        );
        expect(add).not.toBeNull();
        expect(capture).not.toBeNull();
        expect(add!.textContent).toBe('Add file');
        expect(capture!.textContent).toBe('Capture');
        expect(add!.getAttribute('data-kind')).toBe(type);
        expect(add!.getAttribute('data-capture')).toBe('false');
        expect(capture!.getAttribute('data-capture')).toBe('true');
        expect(add!.getAttribute('data-block-id')).toBe(
          figure.getAttribute('data-block-id'),
        );
        // Engine figures never own a file chooser (host-owns-input):
        // no input inside the figure; the single host slot lives at host level.
        expect(figure.querySelector('input[type="file"]')).toBeNull();
        // Empty locators never reach the store (no vault address to read).
        expect(assets.reads).toEqual([]);
      } finally {
        env.cleanup();
      }
    });
  }

  it('Add/Capture clicks dispatch flbp:pick-media with block detail and never mutate', async () => {
    const assets = memoryAssets();
    const env = mount(blank(), { assets });
    try {
      expect(command(env, 'insert-block', { type: 'image' })).toBe(true);
      await flush(30);
      const figure = env.parent.querySelector(
        'figure[data-flbp-image]',
      ) as HTMLElement;
      const blockId = figure.getAttribute('data-block-id')!;
      const seen: Array<{ blockId: string; kind: string; capture: boolean }> =
        [];
      env.parent.addEventListener('flbp:pick-media', (event) => {
        const detail = (event as CustomEvent).detail as {
          blockId: string;
          kind: string;
          capture: boolean;
        };
        seen.push(detail);
      });
      const before = env.handle.getModelForTest!();
      (
        figure.querySelector(
          '[data-flbp-media-pick="add"]',
        ) as HTMLButtonElement
      ).click();
      (
        figure.querySelector(
          '[data-flbp-media-pick="capture"]',
        ) as HTMLButtonElement
      ).click();
      expect(seen).toEqual([
        { blockId, kind: 'image', capture: false },
        { blockId, kind: 'image', capture: true },
      ]);
      // Requesting a pick never mutates canonical bytes (cancel is a no-op).
      expect(env.handle.getModelForTest!()).toEqual(before);
      expect(assets.reads).toEqual([]);
    } finally {
      env.cleanup();
    }
  });

  it('filled media exposes Replace through semantic tools, canonical untouched', async () => {
    const assets = memoryAssets();
    const sha = await sha256Hex(pngBytes);
    assets.files.set(`attachments/${sha}`, pngBytes);
    const model = emptyBlockPage();
    model.rootOrder = ['i1'];
    model.blocks = { i1: imageBlock('i1', `attachments/${sha}`, sha, 'A') };
    const env = mount(model, { assets });
    try {
      await flush(30);
      const figure = env.parent.querySelector(
        'figure[data-flbp-image]',
      ) as HTMLElement;
      expect(figure.querySelector('img')).not.toBeNull();
      expect(figure.querySelector('[data-flbp-media-pick="add"]')).toBeNull();
      expect(command(env, 'select-block', { blockId: 'i1' })).toBe(true);
      const replace = toolsOf(env)
        .snapshot()
        .controls.find((control) => control.id === 'media.replace');
      expect(replace).toMatchObject({
        kind: 'button',
        label: 'Replace image',
      });
      const seen: unknown[] = [];
      env.parent.addEventListener('flbp:pick-media', (event) => {
        seen.push((event as CustomEvent).detail);
      });
      const before = env.handle.getModelForTest!();
      expect(toolsOf(env).execute('media.replace')).toBe(true);
      expect(seen).toEqual([{ blockId: 'i1', kind: 'image', capture: false }]);
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });

  it('host picker slot exists once at host level (skeleton-owned, hidden)', async () => {
    const env = mount(blank(), { assets: memoryAssets() });
    try {
      await flush(10);
      const inputs = [
        ...env.parent.querySelectorAll('input[data-flbp-media-picker]'),
      ];
      expect(inputs).toHaveLength(1);
      const input = inputs[0] as HTMLInputElement;
      expect(input.type).toBe('file');
      expect(input.hidden).toBe(true);
      // The slot is a sibling of the ProseMirror surface, never figure content.
      expect(input.closest('figure')).toBeNull();
      expect(input.closest('.flbp-host')).not.toBeNull();
    } finally {
      env.cleanup();
    }
  });

  it('traversal placeholders keep Retry only (no picker) and never read', async () => {
    const assets = memoryAssets();
    assets.files.set('../notes/secret', pngBytes);
    const model = emptyBlockPage();
    model.rootOrder = ['i1'];
    model.blocks = {
      i1: imageBlock('i1', '../notes/secret', 'a'.repeat(64), 'A'),
    };
    const env = mount(model, { assets });
    try {
      await flush(30);
      const figure = env.parent.querySelector(
        'figure[data-flbp-image]',
      ) as HTMLElement;
      expect(figure.dataset.flbpMediaReason).toBe('invalid-src');
      expect(figure.querySelector('[data-flbp-media-pick]')).toBeNull();
      expect(figure.querySelector('.flbp-media-action')!.textContent).toBe(
        'Retry',
      );
      expect(assets.reads).toEqual([]);
    } finally {
      env.cleanup();
    }
  });

  it('null-create upload in-grid refuses before read/store (picker null path)', async () => {
    const assets = memoryAssets();
    const env = mount(gridModel(), { assets });
    try {
      command(env, 'set-selection', { from: 4, to: 4 });
      const before = env.handle.getModelForTest!();
      const undoBefore = env.handle.canExecCommand!('undo');
      expect(await uploadOf(env)(null, pngBytes)).toBe(false);
      expect(env.handle.getModelForTest!()).toEqual(before);
      expect(assets.files.size).toBe(0);
      expect(env.handle.canExecCommand!('undo')).toBe(undoBefore);
    } finally {
      env.cleanup();
    }
  });
});
