/**
 * Relationship graph over workspace documents.
 *
 * Relationships are derived state: the canonical source is the
 * document content; the graph is a projection that can be rebuilt from
 * `DocumentKindDescriptor.decode` output at any time. Consumers depend on
 * this service, never on provider-specific graph implementations.
 */

import type { DocumentId, ResourceId } from './identity.js';
import type { DocumentLocation, DocumentRef } from './documents.js';
import { FroglightError } from './errors.js';

/** Input for adding a relationship. */
export interface RelationshipInput {
  readonly type: string;
  readonly source: DocumentLocation;
  readonly target: DocumentRef;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** A stored relationship with a stable id. */
export interface Relationship {
  readonly id: string;
  readonly type: string;
  readonly source: DocumentLocation;
  readonly target: DocumentRef;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface RelationshipService {
  /** Add a relationship; returns its stable id. */
  add(input: RelationshipInput): string;
  /** Remove by id; throws `NOT_FOUND` when absent. */
  remove(id: string): void;
  /** Get by id; throws `NOT_FOUND` when absent. */
  get(id: string): Relationship;
  /** All relationships, in insertion order. */
  list(): readonly Relationship[];
  /** Relationships with the given source resource. */
  bySource(resourceId: ResourceId): readonly Relationship[];
  /** Relationships whose target is the given document (any resource). */
  byTarget(documentId: DocumentId): readonly Relationship[];
  /**
   * Remove all relationships whose source is the given resource; returns
   * the number removed. Used when re-indexing a document after a save.
   */
  removeBySource(resourceId: ResourceId): number;
  /** Remove all relationships; returns the number removed. */
  clear(): number;
}

let relationshipSequence = 0;

function nextRelationshipId(): string {
  relationshipSequence += 1;
  return `rel-${relationshipSequence}`;
}

/** In-memory relationship graph. */
export class InMemoryRelationshipService implements RelationshipService {
  readonly #relationships: Relationship[] = [];

  add(input: RelationshipInput): string {
    const id = nextRelationshipId();
    this.#relationships.push({
      id,
      type: input.type,
      source: { resourceId: input.source.resourceId, ...(input.source.address ? { address: input.source.address } : {}) },
      target: {
        documentId: input.target.documentId,
        kindId: input.target.kindId,
        location: {
          resourceId: input.target.location.resourceId,
          ...(input.target.location.address ? { address: input.target.location.address } : {}),
        },
      },
      metadata: input.metadata ?? {},
    });
    return id;
  }

  remove(id: string): void {
    const index = this.#relationships.findIndex((r) => r.id === id);
    if (index === -1) {
      throw new FroglightError('NOT_FOUND', `no relationship with id ${id}`);
    }
    this.#relationships.splice(index, 1);
  }

  get(id: string): Relationship {
    const relationship = this.#relationships.find((r) => r.id === id);
    if (relationship === undefined) {
      throw new FroglightError('NOT_FOUND', `no relationship with id ${id}`);
    }
    return { ...relationship };
  }

  list(): readonly Relationship[] {
    return this.#relationships.map((r) => ({ ...r }));
  }

  bySource(source: ResourceId): readonly Relationship[] {
    return this.#relationships.filter((r) => r.source.resourceId === source).map((r) => ({ ...r }));
  }

  byTarget(target: DocumentId): readonly Relationship[] {
    return this.#relationships
      .filter((r) => r.target.documentId === target)
      .map((r) => ({ ...r }));
  }

  removeBySource(source: ResourceId): number {
    const kept: Relationship[] = [];
    let removed = 0;
    for (const relationship of this.#relationships) {
      if (relationship.source.resourceId === source) {
        removed += 1;
      } else {
        kept.push(relationship);
      }
    }
    this.#relationships.length = 0;
    this.#relationships.push(...kept);
    return removed;
  }

  clear(): number {
    const count = this.#relationships.length;
    this.#relationships.length = 0;
    return count;
  }
}

