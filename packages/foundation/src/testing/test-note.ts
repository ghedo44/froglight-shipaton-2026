/**
 * Test document kind: a minimal, deterministic JSON document used by the
 * acceptance and adversarial suites.
 *
 * Exercises the full codec path: versioned records, unknown-field
 * preservation, derived metadata, and derived relationships.
 */

import type { DocumentId, DocumentKindId, ResourceId } from '../identity.js';
import { documentKindId } from '../identity.js';
import type { DocumentKindDescriptor, DecodedDocument } from '../documents.js';
import type { RelationshipInput } from '../relationships.js';
import { parseVersionedRecord, serializeVersionedRecord, type VersionedRecord } from '../records.js';
import { FroglightError } from '../errors.js';

export const testNoteKindId: DocumentKindId = documentKindId('froglight.test-note');
export const TEST_NOTE_FORMAT = 'froglight.test-note';
export const TEST_NOTE_VERSION = 1;
const TEST_NOTE_KNOWN_KEYS = new Set(['format', 'version', 'title', 'tags', 'text', 'links']);

export interface TestDocLink {
  readonly documentId: string;
  readonly kindId: string;
  readonly resourceId: string;
}

export interface TestDocModel {
  readonly title: string;
  readonly tags: readonly string[];
  readonly text: string;
  readonly links?: readonly TestDocLink[];
  /** Unknown fields preserved across round trips. */
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface TestNoteDecoded extends DecodedDocument<TestDocModel> {
  readonly metadata: {
    readonly title: string;
    readonly tags: readonly string[];
  };
}

type TestNoteRecord = VersionedRecord & {
  readonly title: string;
  readonly text: string;
  readonly tags?: unknown;
  readonly links?: unknown;
} & Record<string, unknown>;

/** Deterministic JSON codec for test notes. */
export const testNoteKind: DocumentKindDescriptor<TestDocModel> = {
  id: testNoteKindId,
  recognize: (kindId) => kindId === testNoteKindId,
  decode: (data, ref): TestNoteDecoded => {
    const { record, extras } = parseVersionedRecord<TestNoteRecord>(
      data,
      TEST_NOTE_FORMAT,
      [TEST_NOTE_VERSION],
      TEST_NOTE_KNOWN_KEYS,
    );
    if (typeof record.title !== 'string' || typeof record.text !== 'string') {
      throw new FroglightError('RECORD_CORRUPT', 'test note has invalid shape');
    }
    const tags = Array.isArray(record.tags) ? record.tags.filter((t): t is string => typeof t === 'string') : [];
    const links = Array.isArray(record.links) ? record.links.filter(isTestDocLink) : undefined;
    const model: TestDocModel = {
      title: record.title,
      tags,
      text: record.text,
      ...(links !== undefined && links.length > 0 ? { links } : {}),
      ...(Object.keys(extras).length > 0 ? { extra: extras } : {}),
    };
    const relationships: RelationshipInput[] = (links ?? []).map((link) => ({
      type: 'test-note.link',
      source: ref.location,
      target: {
        documentId: link.documentId as DocumentId,
        kindId: link.kindId as DocumentKindId,
        location: { resourceId: link.resourceId as ResourceId },
      },
    }));
    return { model, metadata: { title: model.title, tags: model.tags }, relationships };
  },
  encode: (model, _ref): Uint8Array => {
    void _ref;
    const record: TestNoteRecord = {
      format: TEST_NOTE_FORMAT,
      version: TEST_NOTE_VERSION,
      title: model.title,
      tags: [...model.tags],
      text: model.text,
      ...(model.links !== undefined && model.links.length > 0
        ? { links: model.links.map((link) => ({ ...link })) }
        : {}),
    };
    return serializeVersionedRecord(record, model.extra ?? {});
  },
};

function isTestDocLink(value: unknown): value is TestDocLink {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const link = value as Record<string, unknown>;
  return (
    typeof link.documentId === 'string' &&
    typeof link.kindId === 'string' &&
    typeof link.resourceId === 'string'
  );
}

/** Default initial model for a fresh test note. */
export function testNoteModel(title: string, text = ''): TestDocModel {
  return { title, tags: [], text };
}