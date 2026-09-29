/**
 * Block Page conformance fixtures for canonical records with
 * remote-capable media (`froglight.video`/`froglight.audio`/`froglight.file`),
 * source-only math/diagram and
 * canonical media layout, preservation and validation behavior.
 *
 * Engine-free: plain-data fixtures only, no editor provider is instantiated.
 */

import { describe, expect, it } from 'vitest';
import type { DocumentRef } from '../documents.js';
import { refFor, newDocumentId, newResourceId } from '../documents.js';
import { utf8Encode, utf8Decode } from '../encoding.js';
import { blockPageKindId } from './kind.js';
import { decodeBlockPage, encodeBlockPage } from './codec.js';
import {
  BLOCK_PAGE_BLOCK_TYPES as T,
  audioBlock,
  diagramBlock,
  fileBlock,
  isCoreBlockType,
  isValidCoreRecord,
  mathBlock,
  paragraphBlock,
  videoBlock,
  type BlockRecord,
} from './model.js';
import { extractBlockPageMetadata } from './metadata.js';
import { extractBlockPageRelationships } from './relationships.js';
import { projectBlockPageForSearch } from './search.js';
import {
  exportBlockPageToMarkdown,
  importMarkdownToBlockPage,
} from './conversion.js';
import { documentId } from '../identity.js';

function makeRef(): DocumentRef {
  return refFor(newDocumentId(), blockPageKindId, newResourceId());
}

/** Canonical serialization of a literal document (matches §6 serializer rules). */
function canonical(value: unknown): Uint8Array {
  return utf8Encode(`${JSON.stringify(value, null, 2)}\n`);
}

function decode(value: unknown) {
  return decodeBlockPage(canonical(value), makeRef());
}

function expectErrorCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect((error as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`expected error with code ${code}`);
}

const VALID_PIN = 'a'.repeat(64);
const REMOTE_URL = 'https://cdn.example.com/clip.mp4';

describe('Block Page media core type registration', () => {
  it('recognizes the media core type ids', () => {
    expect(T.video).toBe('froglight.video');
    expect(T.audio).toBe('froglight.audio');
    expect(T.file).toBe('froglight.file');
    expect(T.math).toBe('froglight.math');
    expect(T.diagram).toBe('froglight.diagram');
    for (const id of [
      T.video,
      T.audio,
      T.file,
      T.math,
      T.diagram,
    ]) {
      expect(isCoreBlockType(id)).toBe(true);
    }
  });

  it('emits canonical field order from constructors (spec §4)', () => {
    expect(
      Object.keys(
        videoBlock(
          'v',
          { src: 'a.mp4', sha256: 'h' },
          { name: 'N', caption: 'C', alt: 'A' },
        ),
      ),
    ).toEqual(['id', 'type', 'src', 'sha256', 'name', 'caption', 'alt']);
    expect(Object.keys(videoBlock('v', { src: 'a.mp4', sha256: 'h' }))).toEqual(
      ['id', 'type', 'src', 'sha256'],
    );
    expect(
      Object.keys(
        audioBlock(
          'a',
          { remote: { url: REMOTE_URL }, sha256: VALID_PIN },
          { name: 'N' },
        ),
      ),
    ).toEqual(['id', 'type', 'remote', 'sha256', 'name']);
    expect(
      Object.keys(fileBlock('f', { remote: { url: REMOTE_URL } })),
    ).toEqual(['id', 'type', 'remote']);
    expect(Object.keys(mathBlock('m', 'x^2'))).toEqual([
      'id',
      'type',
      'source',
    ]);
    expect(Object.keys(diagramBlock('d', 'graph TD'))).toEqual([
      'id',
      'type',
      'source',
    ]);
  });

  it('constructs valid canonical records', () => {
    const records = [
      videoBlock(
        'v',
        { src: 'assets/clip.mp4', sha256: 'h' },
        { caption: 'C' },
      ),
      audioBlock('a', { remote: { url: REMOTE_URL } }),
      fileBlock(
        'f',
        { remote: { url: REMOTE_URL }, sha256: VALID_PIN },
        { name: 'N' },
      ),
      mathBlock('m', '\\frac{1}{2}'),
      diagramBlock('d', 'graph TD; A-->B;'),
    ];
    for (const record of records) expect(isValidCoreRecord(record)).toBe(true);
  });
});

describe('Block Page media shape validation', () => {
  it('accepts vault identity mirroring image (src + required sha256)', () => {
    expect(
      isValidCoreRecord({
        id: 'v',
        type: T.video,
        src: 'assets/clip.mp4',
        sha256: 'any-string',
      }),
    ).toBe(true);
    // sha256 is required for new media: missing or empty fails.
    expect(
      isValidCoreRecord({ id: 'v', type: T.video, src: 'assets/clip.mp4' }),
    ).toBe(false);
    expect(
      isValidCoreRecord({
        id: 'v',
        type: T.video,
        src: 'assets/clip.mp4',
        sha256: '',
      }),
    ).toBe(false);
    expect(isValidCoreRecord({ id: 'v', type: T.video, sha256: 'h' })).toBe(
      false,
    );
    expect(
      isValidCoreRecord({ id: 'v', type: T.video, src: 42, sha256: 'h' }),
    ).toBe(false);
  });

  it('rejects vault path escapes in single-record validation', () => {
    for (const src of ['../outside.mp4', '/absolute.mp4', 'back\\slash.mp4']) {
      expect(
        isValidCoreRecord({ id: 'v', type: T.video, src, sha256: 'h' }),
      ).toBe(false);
    }
  });

  it('treats name/caption/alt as optional presentation strings only', () => {
    expect(
      isValidCoreRecord({
        id: 'f',
        type: T.file,
        src: 'assets/d.pdf',
        sha256: 'h',
        name: 'N',
        caption: 'C',
        alt: 'A',
      }),
    ).toBe(true);
    expect(
      isValidCoreRecord({
        id: 'f',
        type: T.file,
        src: 'assets/d.pdf',
        sha256: 'h',
        caption: 7,
      }),
    ).toBe(false);
    expect(
      isValidCoreRecord({
        id: 'a',
        type: T.audio,
        src: 'assets/s.mp3',
        sha256: 'h',
        name: null,
      }),
    ).toBe(false);
  });

  it('requires exactly one locator: never both, never neither', () => {
    const both: BlockRecord = {
      id: 'v',
      type: T.video,
      src: 'assets/c.mp4',
      sha256: 'h',
      remote: { url: REMOTE_URL },
    };
    expect(isValidCoreRecord(both)).toBe(false);
    expect(isValidCoreRecord({ id: 'v', type: T.video, name: 'orphan' })).toBe(
      false,
    );
  });

  it('accepts opt-in remote without a pin (availability-only by design)', () => {
    expect(
      isValidCoreRecord({
        id: 'a',
        type: T.audio,
        remote: { url: REMOTE_URL },
      }),
    ).toBe(true);
  });

  it('verifies pin format when present: lowercase-hex sha256 only', () => {
    const pinned = {
      id: 'a',
      type: T.audio,
      remote: { url: REMOTE_URL },
      sha256: VALID_PIN,
    };
    expect(isValidCoreRecord(pinned)).toBe(true);
    for (const badPin of [
      'A'.repeat(64),
      'a'.repeat(63),
      'a'.repeat(65),
      'g'.repeat(64),
      '',
      'any-string',
      null,
      123,
      {},
      [],
    ]) {
      expect(
        isValidCoreRecord({
          id: 'a',
          type: T.audio,
          remote: { url: REMOTE_URL },
          sha256: badPin,
        }),
      ).toBe(false);
    }
  });

  it('rejects non-https remote schemes (codec side)', () => {
    for (const url of [
      'http://cdn.example.com/clip.mp4',
      '//cdn.example.com/clip.mp4',
      'data:video/mp4;base64,AAAA',
      'blob:https://example.com/uuid',
      'ftp://cdn.example.com/clip.mp4',
      'not a url',
      '',
    ]) {
      expect(
        isValidCoreRecord({ id: 'v', type: T.video, remote: { url } }),
        url,
      ).toBe(false);
    }
    expect(
      isValidCoreRecord({
        id: 'v',
        type: T.video,
        remote: { url: REMOTE_URL },
      }),
    ).toBe(true);
  });

  it('rejects userinfo in remote authorities (codec side)', () => {
    for (const url of [
      'https://user@cdn.example.com/clip.mp4',
      'https://user:pass@cdn.example.com/clip.mp4',
      'https://:pass@cdn.example.com/clip.mp4',
      'https://@cdn.example.com/clip.mp4',
    ]) {
      expect(
        isValidCoreRecord({ id: 'v', type: T.video, remote: { url } }),
        url,
      ).toBe(false);
    }
    // `@` in the path (not the authority) is not userinfo and stays valid.
    expect(
      isValidCoreRecord({
        id: 'v',
        type: T.video,
        remote: { url: 'https://cdn.example.com/@user/clip.mp4' },
      }),
    ).toBe(true);
  });

  it('rejects control bytes, single-slash authorities, and empty hosts (canonical/fetch divergence)', () => {
    // WHATWG strips embedded tab/newline and trims leading C0/space, so
    // any control/space byte anywhere means canonical !== fetch input
    // (codec side).
    for (const url of [
      'https://cdn.example.com/cli\tp.mp4',
      'https://cdn.example.com/cli\np.mp4',
      'https://cdn.example.com/cli\rp.mp4',
      'https://cdn.example.com/\u0000p.mp4',
      'https://cdn.example.com/\u007Fp.mp4',
      'https://cdn.example.com/a b.mp4',
    ]) {
      expect(
        isValidCoreRecord({ id: 'v', type: T.video, remote: { url } }),
        JSON.stringify(url),
      ).toBe(false);
    }
    // WHATWG rewrites `\` to `/` for special schemes (`https:`), so a
    // backslash anywhere means canonical !== fetch input.
    expect(
      isValidCoreRecord({
        id: 'v',
        type: T.video,
        remote: { url: 'https://cdn.example.com\\clip.mp4' },
      }),
      'backslash',
    ).toBe(false);
    // Single-slash `https:/host` parses as `https://host`: canonical bytes
    // must carry the explicit double-slash authority opener.
    expect(
      isValidCoreRecord({
        id: 'v',
        type: T.video,
        remote: { url: 'https:/example.com/x' },
      }),
    ).toBe(false);
    // Empty authorities: the parser recovers some of these into a fetchable
    // host (`https:///path` → host `path`) instead of throwing, so the raw
    // authority form is rejected, not just the parsed hostname.
    for (const url of [
      'https:///path',
      'https://?q',
      'https://#f',
      'https://',
    ]) {
      expect(
        isValidCoreRecord({ id: 'v', type: T.video, remote: { url } }),
        url,
      ).toBe(false);
    }
    // Positive control: an ordinary https locator stays valid.
    expect(
      isValidCoreRecord({
        id: 'v',
        type: T.video,
        remote: { url: REMOTE_URL },
      }),
    ).toBe(true);
    // Scheme match is case-insensitive: uppercase `HTTPS://` stays valid.
    expect(
      isValidCoreRecord({
        id: 'v',
        type: T.video,
        remote: { url: 'HTTPS://cdn.example.com/clip.mp4' },
      }),
    ).toBe(true);
  });

  it('enforces the 4096-unit remote URL cap (spec §8 address precedent)', () => {
    const base = 'https://example.com/';
    const atCap = base + 'x'.repeat(4_096 - base.length);
    expect(atCap.length).toBe(4_096);
    expect(
      isValidCoreRecord({ id: 'v', type: T.video, remote: { url: atCap } }),
    ).toBe(true);
    expect(
      isValidCoreRecord({
        id: 'v',
        type: T.video,
        remote: { url: `${atCap}x` },
      }),
    ).toBe(false);
  });

  it('rejects padded or malformed remote shapes without normalizing them', () => {
    expect(
      isValidCoreRecord({
        id: 'v',
        type: T.video,
        remote: { url: ` ${REMOTE_URL} ` },
      }),
    ).toBe(false);
    expect(
      isValidCoreRecord({
        id: 'v',
        type: T.video,
        remote: 'https://cdn.example.com/x',
      }),
    ).toBe(false);
    expect(isValidCoreRecord({ id: 'v', type: T.video, remote: {} })).toBe(
      false,
    );
  });
});

describe('Block Page math/diagram shape validation', () => {
  it('accepts string sources, including empty (renders a placeholder)', () => {
    expect(isValidCoreRecord(mathBlock('m', '\\sum x'))).toBe(true);
    expect(isValidCoreRecord(mathBlock('m', ''))).toBe(true);
    expect(
      isValidCoreRecord(diagramBlock('d', 'sequenceDiagram; A->>B: hi')),
    ).toBe(true);
    expect(isValidCoreRecord({ id: 'm', type: T.math, source: 42 })).toBe(
      false,
    );
    expect(isValidCoreRecord({ id: 'd', type: T.diagram })).toBe(false);
  });


});

describe('Block Page codec round-trip and recovery', () => {
  it('round-trips every new type byte-stably with no warnings', () => {
    const doc = {
      formatVersion: 1,
      meta: {},
      rootOrder: ['v', 'a', 'f', 'm', 'd'],
      blocks: {
        v: videoBlock(
          'v',
          { src: 'assets/clip.mp4', sha256: 'h' },
          { caption: 'Launch' },
        ),
        a: audioBlock(
          'a',
          { remote: { url: REMOTE_URL }, sha256: VALID_PIN },
          { name: 'Theme' },
        ),
        f: fileBlock('f', {
          remote: { url: 'https://files.example.com/deck.pdf' },
        }),
        m: mathBlock('m', '\\frac{1}{2}'),
        d: diagramBlock('d', 'graph TD; A-->B;'),
      },
    };
    const bytes = canonical(doc);
    const decoded = decodeBlockPage(bytes, makeRef());
    expect(decoded.warnings).toEqual([]);
    expect(utf8Decode(encodeBlockPage(decoded.model, makeRef()))).toBe(
      utf8Decode(bytes),
    );
  });

  it('preserves invalid vault media verbatim as opaque with a warning', () => {
    const bytes = canonical({
      formatVersion: 1,
      meta: {},
      rootOrder: ['v'],
      blocks: {
        v: { id: 'v', type: 'froglight.video', src: 'assets/clip.mp4' },
      },
    });
    const decoded = decodeBlockPage(bytes, makeRef());
    expect(decoded.warnings).toEqual([
      { code: 'INVALID_CORE_BLOCK_OPAQUE', blockId: 'v' },
    ]);
    expect(utf8Decode(encodeBlockPage(decoded.model, makeRef()))).toBe(
      utf8Decode(bytes),
    );
  });

  it('reports invalid remotes as REMOTE_URL_REJECTED and never normalizes them', () => {
    const cases: Array<[string, unknown]> = [
      [
        'downgrade scheme',
        {
          id: 'v',
          type: 'froglight.video',
          remote: { url: 'http://cdn.example.com/c.mp4' },
        },
      ],
      [
        'protocol-relative',
        {
          id: 'v',
          type: 'froglight.video',
          remote: { url: '//cdn.example.com/c.mp4' },
        },
      ],
      [
        'data url',
        {
          id: 'v',
          type: 'froglight.audio',
          remote: { url: 'data:audio/mp3;base64,AAAA' },
        },
      ],
      [
        'userinfo',
        {
          id: 'v',
          type: 'froglight.video',
          remote: { url: 'https://user@cdn.example.com/c.mp4' },
        },
      ],
      // WHATWG strips these before fetching, so canonical !== fetch input.
      [
        'embedded tab',
        {
          id: 'v',
          type: 'froglight.video',
          remote: { url: 'https://cdn.example.com/cli\tp.mp4' },
        },
      ],
      [
        'embedded newline',
        {
          id: 'v',
          type: 'froglight.video',
          remote: { url: 'https://cdn.example.com/cli\np.mp4' },
        },
      ],
      [
        'embedded cr',
        {
          id: 'v',
          type: 'froglight.video',
          remote: { url: 'https://cdn.example.com/cli\rp.mp4' },
        },
      ],
      // Single-slash authorities parse as double-slash; empty authorities
      // may recover into a fetchable host instead of throwing.
      [
        'single-slash authority',
        {
          id: 'v',
          type: 'froglight.video',
          remote: { url: 'https:/example.com/x' },
        },
      ],
      [
        'backslash rewrites to slash',
        {
          id: 'v',
          type: 'froglight.video',
          remote: { url: 'https://cdn.example.com\\clip.mp4' },
        },
      ],
      [
        'empty host path',
        { id: 'v', type: 'froglight.file', remote: { url: 'https:///path' } },
      ],
      [
        'empty host query',
        { id: 'v', type: 'froglight.audio', remote: { url: 'https://?q' } },
      ],
      [
        'over-long',
        {
          id: 'v',
          type: 'froglight.file',
          remote: { url: `https://example.com/${'x'.repeat(4_096)}` },
        },
      ],
      [
        'bad pin',
        {
          id: 'v',
          type: 'froglight.audio',
          remote: { url: REMOTE_URL },
          sha256: 'not-a-pin',
        },
      ],
      [
        'ambiguous locators',
        {
          id: 'v',
          type: 'froglight.video',
          src: 'assets/c.mp4',
          sha256: 'h',
          remote: { url: REMOTE_URL },
        },
      ],
      [
        'malformed remote',
        {
          id: 'v',
          type: 'froglight.video',
          remote: 'https://cdn.example.com/c.mp4',
        },
      ],
    ];
    for (const [name, block] of cases) {
      const bytes = canonical({
        formatVersion: 1,
        meta: {},
        rootOrder: ['v'],
        blocks: { v: block },
      });
      const decoded = decodeBlockPage(bytes, makeRef());
      expect(decoded.warnings, name).toEqual([
        { code: 'REMOTE_URL_REJECTED', blockId: 'v' },
      ]);
      // Invalid remote bytes survive verbatim: nothing is rewritten into a
      // fetchable shape, nothing is dropped.
      expect(utf8Decode(encodeBlockPage(decoded.model, makeRef())), name).toBe(
        utf8Decode(bytes),
      );
    }
  });

  it('rejects media vault path escapes as a hard security error (mirror-image rule)', () => {
    for (const badSrc of [
      '../outside.mp4',
      '/absolute.mp4',
      'back\\slash.mp4',
    ]) {
      const bytes = canonical({
        formatVersion: 1,
        meta: {},
        rootOrder: ['v'],
        blocks: {
          v: { id: 'v', type: 'froglight.video', src: badSrc, sha256: 'h' },
        },
      });
      expectErrorCode(
        () => decodeBlockPage(bytes, makeRef()),
        'FORMAT_LIMIT_EXCEEDED',
      );
    }
  });

  it('accepts https remote at rest; downgrade/redirect handling stays provider-side (codec side)', () => {
    // The codec guarantees downgrade-at-rest is impossible (http: is never a
    // valid canonical locator) and preserves the https locator byte-stable.
    // Following — or refusing — server redirects (https→http) is a provider
    // fetch-time duty; the codec never fetches.
    const bytes = canonical({
      formatVersion: 1,
      meta: {},
      rootOrder: ['v'],
      blocks: {
        v: {
          id: 'v',
          type: 'froglight.video',
          remote: { url: REMOTE_URL },
          sha256: VALID_PIN,
        },
      },
    });
    const decoded = decodeBlockPage(bytes, makeRef());
    expect(decoded.warnings).toEqual([]);
    expect(utf8Decode(encodeBlockPage(decoded.model, makeRef()))).toBe(
      utf8Decode(bytes),
    );
    const downgrade = canonical({
      formatVersion: 1,
      meta: {},
      rootOrder: ['v'],
      blocks: {
        v: {
          id: 'v',
          type: 'froglight.video',
          remote: { url: 'http://cdn.example.com/c.mp4' },
        },
      },
    });
    expect(decodeBlockPage(downgrade, makeRef()).warnings).toEqual([
      { code: 'REMOTE_URL_REJECTED', blockId: 'v' },
    ]);
  });
});

describe('Block Page opaque round-trip', () => {
  it('preserves retired side-by-side records and their children as unknown data', () => {
    const doc = {
      formatVersion: 1,
      meta: {},
      rootOrder: ['layout'],
      blocks: {
        layout: { id: 'layout', type: 'froglight.columnList', widths: [2, 1], children: ['left', 'right'] },
        left: { id: 'left', type: 'froglight.column', children: ['text'] },
        right: { id: 'right', type: 'froglight.column' },
        text: paragraphBlock('text', [{ text: 'Retained' }]),
      },
    };
    const bytes = canonical(doc);
    const result = decode(doc);
    expect(result.warnings).toEqual([]);
    expect(utf8Decode(encodeBlockPage(result.model, makeRef()))).toBe(utf8Decode(bytes));
  });

  it('preserves damaged core records through the opaque path with warnings, byte-stable', () => {
    // Damaged core records retain their original remote and source
    // payloads, with INVALID_CORE_BLOCK_OPAQUE or REMOTE_URL_REJECTED warnings.
    // The bytes survive verbatim through the public decode/encode path.
    const cases: Array<{ name: string; block: unknown; code: string }> = [
      {
        name: 'video remote with embedded tab',
        block: {
          id: 'v',
          type: 'froglight.video',
          remote: { url: 'https://cdn.example.com/cli\tp.mp4' },
        },
        code: 'REMOTE_URL_REJECTED',
      },
      {
        name: 'audio remote with malformed pin',
        block: {
          id: 'a',
          type: 'froglight.audio',
          remote: { url: REMOTE_URL },
          sha256: 'not-a-pin',
        },
        code: 'REMOTE_URL_REJECTED',
      },
      {
        name: 'file with ambiguous dual locators',
        block: {
          id: 'f',
          type: 'froglight.file',
          src: 'assets/deck.pdf',
          sha256: 'h',
          remote: { url: REMOTE_URL },
        },
        code: 'REMOTE_URL_REJECTED',
      },
      {
        name: 'math with non-string source',
        block: { id: 'm', type: 'froglight.math', source: 42 },
        code: 'INVALID_CORE_BLOCK_OPAQUE',
      },
      {
        name: 'diagram with missing source',
        block: { id: 'd', type: 'froglight.diagram' },
        code: 'INVALID_CORE_BLOCK_OPAQUE',
      },
    ];
    for (const { name, block, code } of cases) {
      const record = block as { id?: string };
      const bytes = canonical({
        formatVersion: 1,
        meta: {},
        rootOrder: [record.id],
        blocks: {
          [record.id as string]: block,
        },
      });
      const decoded = decodeBlockPage(bytes, makeRef());
      expect(decoded.warnings, name).toEqual([{ code, blockId: record.id }]);
      expect(utf8Decode(encodeBlockPage(decoded.model, makeRef())), name).toBe(
        utf8Decode(bytes),
      );
    }
  });

  it('preserves unknown block types byte-stable, nested content intact', () => {
    // Unknown type ids remain opaque through the public codec. Their
    // preservation is warning-free, and nested content remains intact.
    const asUnknownType = (record: BlockRecord): BlockRecord => ({
      ...record,
      type: (record.type as string).replace(/^froglight\./, 'extension.'),
    });
    const doc = {
      formatVersion: 1,
      meta: { title: 'mixed' },
      rootOrder: ['v', 'a', 'f', 'm', 'd'],
      blocks: {
        v: asUnknownType(
          videoBlock('v', { remote: { url: REMOTE_URL } }, { caption: 'Clip' }),
        ),
        a: asUnknownType(
          audioBlock(
            'a',
            { remote: { url: REMOTE_URL }, sha256: VALID_PIN },
            { name: 'Theme' },
          ),
        ),
        f: asUnknownType(
          fileBlock('f', { src: 'assets/deck.pdf', sha256: 'h' }),
        ),
        m: asUnknownType(mathBlock('m', 'E = mc^2')),
        d: asUnknownType(diagramBlock('d', 'graph TD; A-->B;')),
      },
    };
    for (const id of ['v', 'a', 'f', 'm', 'd']) {
      // Guard: these ids must actually traverse the unknown-type path.
      expect(
        isCoreBlockType((doc.blocks as Record<string, BlockRecord>)[id]?.type),
      ).toBe(false);
    }
    const bytes = canonical(doc);
    const decoded = decodeBlockPage(bytes, makeRef());
    expect(decoded.warnings).toEqual([]);
    expect(utf8Decode(encodeBlockPage(decoded.model, makeRef()))).toBe(
      utf8Decode(bytes),
    );
  });
});

describe('Block Page projections', () => {
  it('indexes media name/caption and math/diagram source, never locator bytes', () => {
    const model = {
      formatVersion: 1 as const,
      meta: {},
      rootOrder: ['v', 'a', 'm', 'd'],
      blocks: {
        v: videoBlock(
          'v',
          {
            src: 'assets/secret-path-clip.mp4',
            sha256: 'deadbeef-secret-hash',
          },
          {
            name: 'Launch trailer name',
            caption: 'Launch caption text',
            alt: 'alt-hint-unindexed',
          },
        ),
        a: audioBlock(
          'a',
          { remote: { url: 'https://cdn.example.com/secret-track.mp3' } },
          { name: 'Theme name', caption: 'Theme caption text' },
        ),
        m: mathBlock('m', 'E = mc^2 unique-source'),
        d: diagramBlock('d', 'graph TD; Unique-->Diagram;'),
      },
    };
    const projection = projectBlockPageForSearch(model, 'doc-1');
    for (const text of [
      'Launch trailer name',
      'Launch caption text',
      'Theme name',
      'Theme caption text',
      'E = mc^2 unique-source',
      'graph TD; Unique-->Diagram;',
    ]) {
      expect(projection.body, text).toContain(text);
    }
    for (const secret of [
      'secret-path-clip.mp4',
      'deadbeef-secret-hash',
      'secret-track.mp3',
      'alt-hint-unindexed',
    ]) {
      expect(projection.body, secret).not.toContain(secret);
      expect(projection.indexText, secret).not.toContain(secret);
    }
  });



  it('emits no relationship edges from media locators or sources', () => {
    const model = {
      formatVersion: 1 as const,
      meta: {},
      rootOrder: ['v', 'a', 'm', 'd', 'l'],
      blocks: {
        v: videoBlock(
          'v',
          { remote: { url: REMOTE_URL } },
          { caption: 'Clip' },
        ),
        a: audioBlock('a', { src: 'assets/s.mp3', sha256: 'h' }),
        m: mathBlock('m', 'x'),
        d: diagramBlock('d', 'graph TD'),
      },
    };
    const edges = extractBlockPageRelationships({
      source: { resourceId: 'res-1' as never },
      model,
    });
    expect(edges).toEqual([]);
  });

  it('leaves document metadata extraction unaffected by new blocks', () => {
    const model = {
      formatVersion: 1 as const,
      meta: { title: 'Doc', tags: ['t'] },
      rootOrder: ['v'],
      blocks: {
        v: videoBlock(
          'v',
          { remote: { url: REMOTE_URL } },
          { caption: 'Clip' },
        ),
      },
    };
    expect(
      extractBlockPageMetadata({ documentId: documentId('d1'), model }),
    ).toEqual({
      title: 'Doc',
      tags: ['t'],
    });
  });
});

describe('Block Page Markdown conversion', () => {
  it('exports media/math/diagram as explicit approximations with loss warnings', () => {
    const model = {
      formatVersion: 1 as const,
      meta: {},
      rootOrder: ['v', 'a', 'f', 'm', 'd'],
      blocks: {
        v: videoBlock(
          'v',
          { src: 'assets/clip.mp4', sha256: 'h' },
          { caption: 'Launch clip' },
        ),
        a: audioBlock('a', { remote: { url: REMOTE_URL } }, { name: 'Theme' }),
        f: fileBlock('f', { src: 'assets/deck.pdf', sha256: 'h' }),
        m: mathBlock('m', 'E = mc^2'),
        d: diagramBlock('d', 'graph TD; A-->B;'),
      },
    };
    const exported = exportBlockPageToMarkdown(model);
    expect(exported.status).toBe('lossy');
    expect(exported.markdown).toContain('![Launch clip](assets/clip.mp4)');
    expect(exported.markdown).toContain(`[Theme](${REMOTE_URL})`);
    expect(exported.markdown).toContain('[file](assets/deck.pdf)');
    expect(exported.markdown).toContain('```math\nE = mc^2\n```');
    expect(exported.markdown).toContain('```mermaid\ngraph TD; A-->B;\n```');
    expect(exported.warnings).toContain(
      'video "v" approximated as an image link; media type and integrity pin are not representable',
    );
    expect(
      exported.warnings.some((warning) => warning.startsWith('math "m"')),
    ).toBe(true);
    expect(
      exported.warnings.some((warning) => warning.startsWith('diagram "d"')),
    ).toBe(true);
  });

  it('never emits an invalid remote locator as a fetchable Markdown link', () => {
    const model = {
      formatVersion: 1 as const,
      meta: {},
      rootOrder: ['v'],
      blocks: {
        v: {
          id: 'v',
          type: 'froglight.video',
          remote: { url: 'http://cdn.example.com/evil.mp4' },
        },
      },
    };
    const exported = exportBlockPageToMarkdown(model);
    expect(exported.markdown).not.toContain('http://cdn.example.com/evil.mp4');
    expect(exported.warnings).toContain(
      'video "v" has no usable locator; omitted from export',
    );
  });

  it('imports fenced math/mermaid blocks back to source blocks losslessly', () => {
    const raw = [
      '```math',
      'E = mc^2',
      '```',
      '',
      '```mermaid',
      'graph TD; A-->B;',
      '```',
    ].join('\n');
    const result = importMarkdownToBlockPage(raw);
    expect(result.status).toBe('lossless');
    const blocks = Object.values(result.model.blocks);
    expect(blocks.map((block) => block.type)).toEqual([
      'froglight.math',
      'froglight.diagram',
    ]);
    expect(blocks[0]?.source).toBe('E = mc^2\n');
    expect(blocks[1]?.source).toBe('graph TD; A-->B;\n');
  });
});
