/**
 * Derived metadata index over workspace documents.
 *
 * Metadata is derived state: the canonical source is document
 * content. This service is an in-memory projection rebuilt from decoded
 * documents; it is sorted deterministically by `documentId`.
 */

import type { DocumentId } from './identity.js';
import { FroglightError } from './errors.js';

/** JSON-safe metadata value. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

/** Normalized metadata for one document. */
export interface NormalizedMetadata {
  readonly documentId: DocumentId;
  readonly title?: string;
  readonly tags?: readonly string[];
  readonly createdMillis?: number;
  readonly modifiedMillis?: number;
  /** Kind-specific properties, preserved verbatim. */
  readonly properties?: Readonly<Record<string, JsonValue>>;
}

export interface MetadataService {
  /** An owned overlay; disposing it reveals canonical document metadata again. */
  propertyProjection(): {
    set(
      documentId: DocumentId,
      properties: Readonly<Record<string, JsonValue>>,
    ): void;
    remove(documentId: DocumentId): void;
    dispose(): void;
  };
  /** Upsert normalized metadata for a document. */
  upsert(
    documentId: DocumentId,
    metadata: Omit<NormalizedMetadata, 'documentId'>,
  ): void;
  /** Remove metadata for a document; no-op when absent. */
  remove(documentId: DocumentId): void;
  /** Get metadata; throws `NOT_FOUND` when absent. */
  get(documentId: DocumentId): NormalizedMetadata;
  /** All entries, sorted deterministically by documentId. */
  list(): readonly NormalizedMetadata[];
  /** Remove all entries; returns the count removed. */
  clear(): number;
}

/** In-memory metadata index, sorted by documentId. */
export class InMemoryMetadataService implements MetadataService {
  readonly #entries = new Map<string, NormalizedMetadata>();
  readonly #projections = new Set<
    Map<DocumentId, Readonly<Record<string, JsonValue>>>
  >();

  propertyProjection(): ReturnType<MetadataService['propertyProjection']> {
    const entries = new Map<DocumentId, Readonly<Record<string, JsonValue>>>();
    this.#projections.add(entries);
    return {
      set: (id, properties) => {
        if (!this.#projections.has(entries))
          throw new Error('Metadata projection disposed');
        entries.set(id, properties);
      },
      remove: (id) => {
        entries.delete(id);
      },
      dispose: () => {
        this.#projections.delete(entries);
        entries.clear();
      },
    };
  }

  upsert(
    documentId: DocumentId,
    metadata: Omit<NormalizedMetadata, 'documentId'>,
  ): void {
    const entry: NormalizedMetadata = {
      documentId,
      ...(metadata.title !== undefined ? { title: metadata.title } : {}),
      ...(metadata.tags !== undefined ? { tags: metadata.tags } : {}),
      ...(metadata.createdMillis !== undefined
        ? { createdMillis: metadata.createdMillis }
        : {}),
      ...(metadata.modifiedMillis !== undefined
        ? { modifiedMillis: metadata.modifiedMillis }
        : {}),
      ...(metadata.properties !== undefined
        ? { properties: metadata.properties }
        : {}),
    };
    this.#entries.set(documentId, entry);
  }

  remove(documentId: DocumentId): void {
    this.#entries.delete(documentId);
    for (const projection of this.#projections) projection.delete(documentId);
  }

  get(documentId: DocumentId): NormalizedMetadata {
    const entry = this.#entries.get(documentId);
    if (entry === undefined) {
      throw new FroglightError(
        'NOT_FOUND',
        `no metadata for document ${documentId}`,
      );
    }
    let properties = entry.properties;
    for (const projection of this.#projections) {
      const overlay = projection.get(documentId);
      if (overlay) properties = { ...properties, ...overlay };
    }
    return { ...entry, ...(properties ? { properties } : {}) };
  }

  list(): readonly NormalizedMetadata[] {
    return [...this.#entries.values()]
      .sort((a, b) =>
        a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : 0,
      )
      .map((entry) => this.get(entry.documentId));
  }

  clear(): number {
    const count = this.#entries.size;
    this.#entries.clear();
    for (const projection of this.#projections) projection.clear();
    return count;
  }
}
