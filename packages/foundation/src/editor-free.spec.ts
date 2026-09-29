/**
 * Editor-free and host-portable contract checks.
 *
 *  contracts must never leak editor-engine or host types:
 * identities, refs, records, sessions, and derived entries are plain,
 * JSON-serializable data shaped only by Froglight-owned types. This suite
 * pins those properties with type-level checks (via `@ts-expect-error`) and
 * runtime round trips.
 */

import { describe, expect, it } from 'vitest';
import { documentId, documentKindId, resourceId, type DocumentId, type ResourceId } from './identity.js';
import { workspacePath } from './paths.js';
import { refFor } from './documents.js';
import { serializeVersionedRecord, type VersionedRecord } from './records.js';
import { utf8Decode, utf8Encode } from './encoding.js';
import { testNoteKind, testNoteModel } from './testing/test-note.js';

describe('brand disjointness (type-level)', () => {
  it('ResourceId is not assignable to DocumentId without a cast', () => {
    const r: ResourceId = resourceId('res-1');
    // @ts-expect-error — brands must stay distinct.
    const _cross: DocumentId = r;
    void _cross;
    expect(typeof r).toBe('string');
  });

  it('document ids are not interchangeable with resource ids', () => {
    const d: DocumentId = documentId('doc-1');
    // @ts-expect-error — document ids are never resource ids.
    const _cross: ResourceId = d;
    void _cross;
    expect(typeof d).toBe('string');
  });
});

describe('JSON serializability (no host types)', () => {
  it('document refs are plain JSON data', () => {
    const ref = refFor(documentId('doc-1'), documentKindId('froglight.test-note'), resourceId('res-1'));
    expect(JSON.parse(JSON.stringify(ref))).toEqual(ref);
  });

  it('workspace paths and ids survive JSON round trips', () => {
    const path = workspacePath('notes/a.md');
    const roundTripped: unknown = JSON.parse(JSON.stringify(path));
    expect(roundTripped).toBe(path);
    expect(roundTripped).toBe('notes/a.md');
  });

  it('identity records are plain JSON data', () => {
    const record = {
      documentId: documentId('doc-1'),
      kindId: documentKindId('froglight.test-note'),
      resourceId: resourceId('res-1'),
      primaryResource: workspacePath('notes/a.md'),
      createdMillis: 1234,
    };
    expect(JSON.parse(JSON.stringify(record))).toEqual(record);
  });
});

describe('canonical serialization determinism', () => {
  it('encode produces byte-identical output for the same model', () => {
    const ref = refFor(documentId('doc-1'), documentKindId('froglight.test-note'), resourceId('res-1'));
    const model = testNoteModel('Title', 'body');
    const a = testNoteKind.encode(model, ref);
    const b = testNoteKind.encode(model, ref);
    expect(utf8Decode(a)).toBe(utf8Decode(b));
  });

  it('encode output is UTF-8 JSON that any host can decode', () => {
    const ref = refFor(documentId('doc-1'), documentKindId('froglight.test-note'), resourceId('res-1'));
    const bytes = testNoteKind.encode(testNoteModel('Tïtle', 'bödÿ'), ref);
    const parsed: unknown = JSON.parse(utf8Decode(bytes));
    expect((parsed as { title: string }).title).toBe('Tïtle');
  });

  it('versioned records serialize to bytes without host-specific types', () => {
    const record: VersionedRecord & Record<string, unknown> = {
      format: 'froglight.test',
      version: 1,
      marker: { nested: [1, true, 'x'] },
    };
    const bytes = serializeVersionedRecord(record, {});
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(utf8Decode(bytes)).toContain('"marker"');
    // And the bytes themselves are JSON — no TextEncoder-only structures.
    expect(JSON.parse(utf8Decode(bytes))).toEqual({ format: 'froglight.test', marker: { nested: [1, true, 'x'] }, version: 1 });
  });
});

describe('byte encoding helpers', () => {
  it('utf8Encode/utf8Decode round-trip non-ASCII text', () => {
    const text = 'héllo wörld — 中文 🎉';
    expect(utf8Decode(utf8Encode(text))).toBe(text);
  });

  it('encoded bytes match the UTF-8 encoding', () => {
    expect(utf8Encode('é')).toEqual(new Uint8Array([0xc3, 0xa9]));
  });
});