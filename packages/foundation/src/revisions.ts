/**
 * Persistent document revisions over the vault.
 *
 * Revisions live under `.froglight/revisions/<documentId>/`:
 *
 * - `index.json`: versioned record listing the document's revisions
 *   (newest first is derived by sorting on `createdAtMillis`/id);
 * - `<revisionId>.bin`: raw byte content of the resource at that revision.
 *
 * The index is a versioned, unknown-field-tolerant record: it is
 * readable without the application database, and future revisions of the
 * record format can migrate without losing data. The index is authoritative;
 * a content blob without an index entry is an orphan, never surfaced.
 */

import type { DocumentId, ResourceId } from './identity.js';
import type { WorkspacePath } from './paths.js';
import { joinPath, ROOT_PATH } from './paths.js';
import type { VaultService } from './vault/contract.js';
import { ensureDirectory } from './vault/helpers.js';
import { parseVersionedRecord, serializeVersionedRecord, type VersionedRecord } from './records.js';
import { FroglightError, isVaultError } from './errors.js';

const REVISIONS_DIR_SEGMENTS = ['.froglight', 'revisions'] as const;

export interface RevisionRecord {
  readonly revisionId: string;
  readonly documentId: DocumentId;
  readonly sourceResourceId: ResourceId;
  readonly createdAtMillis: number;
  readonly byteLength: number;
  /** FNV-1a 32-bit checksum, hex-encoded, for corruption detection. */
  readonly checksum: string;
}

export interface RecordRevisionInput {
  readonly documentId: DocumentId;
  readonly sourceResourceId: ResourceId;
  readonly data: Uint8Array;
  readonly checksum?: string;
}

export interface RevisionService {
  /**
   * Record a revision: writes the content blob first, then the index.
   * Returns the stored record. Throws `INVALID_ID` when the document id is
   * not a valid document id.
   */
  recordRevision(input: RecordRevisionInput): Promise<RevisionRecord>;
  /** Revisions for a document, newest first. */
  listRevisions(documentId: DocumentId): Promise<readonly RevisionRecord[]>;
  /** Read a revision's content; throws `RECORD_CORRUPT` on checksum mismatch. */
  readRevision(revisionId: string): Promise<Uint8Array>;
  /** Restore a revision's content onto its source resource. */
  restoreRevision(revisionId: string): Promise<void>;
  /** Remove all revisions for a document (used when a document is deleted). */
  removeDocumentRevisions(documentId: DocumentId): Promise<void>;
}

export interface VaultRevisionServiceOptions {
  readonly vault: VaultService;
  /** Identity → canonical path resolver; `undefined` = unknown resource. */
  readonly resolveResource: (resourceId: ResourceId) => WorkspacePath | undefined;
  /** Clock for `createdAtMillis`; defaults to `Date.now`. */
  readonly clock?: () => number;
}

const INDEX_FORMAT = 'froglight.revision-index';
const INDEX_VERSION = 1;
const INDEX_KNOWN_KEYS = new Set(['format', 'version', 'revisions']);

interface RevisionIndexEntry {
  readonly revisionId: string;
  readonly documentId: string;
  readonly sourceResourceId: string;
  readonly createdAtMillis: number;
  readonly byteLength: number;
  readonly checksum: string;
}

type RevisionIndexRecord = VersionedRecord & {
  readonly revisions: readonly RevisionIndexEntry[];
} & Record<string, unknown>;

/** FNV-1a 32-bit over the bytes, hex-encoded. */
export function checksumOf(data: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < data.byteLength; i++) {
    hash ^= data[i] as number;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Hash large resources in bounded tasks so input can run during persistence. */
export async function checksumOfAsync(data: Uint8Array): Promise<string> {
  const chunkBytes = 1024 * 1024;
  if (data.byteLength <= chunkBytes) return checksumOf(data);
  let hash = 0x811c9dc5;
  for (let start = 0; start < data.byteLength; start += chunkBytes) {
    const end = Math.min(start + chunkBytes, data.byteLength);
    for (let i = start; i < end; i++) {
      hash ^= data[i] as number;
      hash = Math.imul(hash, 0x01000193);
    }
    if (end < data.byteLength) {
      const scope = globalThis as unknown as {
        scheduler?: { yield?: () => Promise<void> };
        setTimeout(task: () => void, delayMs: number): unknown;
      };
      if (scope.scheduler?.yield !== undefined) await scope.scheduler.yield();
      else await new Promise<void>((resolve) => scope.setTimeout(resolve, 0));
    }
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Persistent revision service over a `VaultService`. */
export class VaultRevisionService implements RevisionService {
  readonly #vault: VaultService;
  readonly #resolveResource: (resourceId: ResourceId) => WorkspacePath | undefined;
  readonly #now: () => number;
  #sequence = 0;
  readonly #preparedDocuments = new Set<DocumentId>();

  constructor(options: VaultRevisionServiceOptions) {
    this.#vault = options.vault;
    this.#resolveResource = options.resolveResource;
    this.#now = options.clock ?? (() => Date.now());
  }

  async recordRevision(input: RecordRevisionInput): Promise<RevisionRecord> {
    if (input.documentId.length === 0 || input.documentId.includes('\0')) {
      throw new FroglightError('INVALID_ID', `invalid document id: ${input.documentId}`);
    }
    const dir = this.#documentDir(input.documentId);
    if (!this.#preparedDocuments.has(input.documentId)) {
      await ensureDirectory(this.#vault, dir);
      this.#preparedDocuments.add(input.documentId);
    }
    const createdAtMillis = this.#now();
    let revisionId = `rev-${createdAtMillis}-${this.#sequence}`;
    this.#sequence += 1;

    const existing = await this.#readIndex(input.documentId);
    // Ensure uniqueness against already-stored ids.
    const used = new Set(existing.entries.map((e) => e.revisionId));
    while (used.has(revisionId)) {
      revisionId = `rev-${createdAtMillis}-${this.#sequence}`;
      this.#sequence += 1;
    }

    const record: RevisionRecord = {
      revisionId,
      documentId: input.documentId,
      sourceResourceId: input.sourceResourceId,
      createdAtMillis,
      byteLength: input.data.byteLength,
      checksum: input.checksum ?? await checksumOfAsync(input.data),
    };

    // Content blob first, index second: a failure between the two leaves an
    // orphan blob, never an index entry without content.
    try {
      await this.#vault.write(joinPath(dir, `${revisionId}.bin`), input.data);
    } catch (error) {
      if (!isVaultError(error) || error.code !== 'NOT_FOUND') throw error;
      this.#preparedDocuments.delete(input.documentId);
      await ensureDirectory(this.#vault, dir);
      await this.#vault.write(joinPath(dir, `${revisionId}.bin`), input.data);
      this.#preparedDocuments.add(input.documentId);
    }
    const entry: RevisionIndexEntry = {
      revisionId,
      documentId: input.documentId,
      sourceResourceId: input.sourceResourceId,
      createdAtMillis,
      byteLength: record.byteLength,
      checksum: record.checksum,
    };
    const expired = existing.entries.slice(0, Math.max(0, existing.entries.length - 99));
    await this.#writeIndex(input.documentId, { ...existing, entries: existing.entries.slice(-99) }, entry);
    // Prune only after the new index commits; interrupted cleanup leaves safe orphans.
    for (const old of expired) {
      try { await this.#vault.remove(joinPath(dir, `${old.revisionId}.bin`)); }
      catch (error) { if (!isVaultError(error) || error.code !== 'NOT_FOUND') throw error; }
    }
    return record;
  }

  async listRevisions(documentId: DocumentId): Promise<readonly RevisionRecord[]> {
    const index = await this.#readIndex(documentId);
    if (index.entries.length === 0) {
      return [];
    }
    return [...index.entries]
      .sort((a, b) =>
        a.createdAtMillis !== b.createdAtMillis
          ? b.createdAtMillis - a.createdAtMillis
          : a.revisionId < b.revisionId
            ? 1
            : -1,
      )
      .map((entry) => ({ ...entry, documentId: entry.documentId as DocumentId, sourceResourceId: entry.sourceResourceId as ResourceId }));
  }

  async readRevision(revisionId: string): Promise<Uint8Array> {
    const location = await this.#locate(revisionId);
    if (location === null) {
      throw new FroglightError('NOT_FOUND', `no revision with id ${revisionId}`);
    }
    const data = await this.#vault.read(joinPath(location.dir, `${revisionId}.bin`));
    const expected = location.entry.checksum;
    const actual = await checksumOfAsync(data);
    if (expected !== actual) {
      throw new FroglightError(
        'RECORD_CORRUPT',
        `revision ${revisionId} failed its checksum (stored ${expected}, computed ${actual})`,
      );
    }
    return data;
  }

  async restoreRevision(revisionId: string): Promise<void> {
    const location = await this.#locate(revisionId);
    if (location === null) {
      throw new FroglightError('NOT_FOUND', `no revision with id ${revisionId}`);
    }
    const data = await this.readRevision(revisionId);
    const path = this.#resolveResource(location.entry.sourceResourceId as ResourceId);
    if (path === undefined) {
      throw new FroglightError(
        'UNKNOWN_RESOURCE',
        `cannot restore ${revisionId}: unknown source resource ${location.entry.sourceResourceId}`,
      );
    }
    await this.#vault.write(path, data);
  }

  async removeDocumentRevisions(documentId: DocumentId): Promise<void> {
    this.#preparedDocuments.delete(documentId);
    const dir = this.#documentDir(documentId);
    try {
      await removeTree(this.#vault, dir);
    } catch (error) {
      if (!(isVaultError(error) && error.code === 'NOT_FOUND')) {
        throw error;
      }
    }
  }

  #documentDir(documentId: DocumentId): WorkspacePath {
    return joinPath(ROOT_PATH, ...REVISIONS_DIR_SEGMENTS, documentId);
  }

  async #readIndex(documentId: DocumentId): Promise<{ entries: readonly RevisionIndexEntry[]; extras: Readonly<Record<string, unknown>> }> {
    const indexPath = joinPath(this.#documentDir(documentId), 'index.json');
    let data: Uint8Array;
    try {
      data = await this.#vault.read(indexPath);
    } catch (error) {
      if (isVaultError(error) && error.code === 'NOT_FOUND') {
        return { entries: [], extras: {} };
      }
      throw error;
    }
    const { record, extras } = parseVersionedRecord<RevisionIndexRecord>(
      data,
      INDEX_FORMAT,
      [INDEX_VERSION],
      INDEX_KNOWN_KEYS,
    );
    const revisions = record.revisions;
    if (!Array.isArray(revisions) || revisions.some((r) => !isIndexEntry(r))) {
      throw new FroglightError('RECORD_CORRUPT', `revision index has invalid entries: ${indexPath}`);
    }
    return { entries: revisions as RevisionIndexEntry[], extras };
  }

  async #writeIndex(
    documentId: DocumentId,
    prior: { entries: readonly RevisionIndexEntry[]; extras: Readonly<Record<string, unknown>> },
    entry: RevisionIndexEntry,
  ): Promise<void> {
    const record: RevisionIndexRecord = {
      format: INDEX_FORMAT,
      version: INDEX_VERSION,
      revisions: [...prior.entries, entry],
    };
    await this.#vault.write(
      joinPath(this.#documentDir(documentId), 'index.json'),
      serializeVersionedRecord(record, prior.extras),
    );
  }

  async #locate(revisionId: string): Promise<{ dir: WorkspacePath; entry: RevisionIndexEntry } | null> {
    // Scan per-document indexes. A global index or query service can
    // replace this if scale demands it.
    const revisionsRoot = joinPath(ROOT_PATH, ...REVISIONS_DIR_SEGMENTS);
    let documents: readonly string[];
    try {
      const listing = await this.#vault.list(revisionsRoot);
      documents = listing.filter((e) => e.kind === 'directory').map((e) => e.name);
    } catch (error) {
      if (isVaultError(error) && error.code === 'NOT_FOUND') {
        return null;
      }
      throw error;
    }
    for (const docId of documents) {
      const index = await this.#readIndex(docId as DocumentId);
      const entry = index.entries.find((e) => e.revisionId === revisionId);
      if (entry !== undefined) {
        return { dir: joinPath(revisionsRoot, docId), entry };
      }
    }
    return null;
  }
}

function isIndexEntry(value: unknown): value is RevisionIndexEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.revisionId === 'string' &&
    typeof entry.documentId === 'string' &&
    typeof entry.sourceResourceId === 'string' &&
    typeof entry.createdAtMillis === 'number' &&
    typeof entry.byteLength === 'number' &&
    typeof entry.checksum === 'string'
  );
}

async function removeTree(vault: VaultService, path: WorkspacePath): Promise<void> {
  let stat;
  try {
    stat = await vault.stat(path);
  } catch {
    return;
  }
  if (stat.kind === 'directory') {
    for (const entry of await vault.list(path)) {
      await removeTree(vault, joinPath(path, entry.name));
    }
  }
  await vault.remove(path);
}
