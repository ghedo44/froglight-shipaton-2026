/**
 * Document identity and kind contracts.
 *
 * `ResourceId` and `DocumentId` are opaque branded identifiers
 * — never path aliases. A document has one identity record (its
 * `DocumentId`) and may span one or more resources; a `DocumentRef` pins a
 * specific resource inside a document. Document kinds are registered through
 * the `DocumentRegistry` and provide codec functions so storage round-trips
 * are provider-neutral.
 */

import type { ResourceId, DocumentId, DocumentKindId } from './identity.js';
import { generateDocumentId, generateResourceId } from './identity.js';
import type { WorkspacePath } from './paths.js';
import { workspacePath } from './paths.js';
import { FroglightError } from './errors.js';
import type { RelationshipInput } from './relationships.js';
import type { PropertyValue } from './resource-properties/catalog.js';

/** A present null differs from a property that is absent. */
export type DocumentPropertyRead =
  | { readonly present: false }
  | { readonly present: true; readonly value: PropertyValue };

/** Canonical-model storage, implemented only by kinds that can mutate safely. */
export interface DocumentPropertyCapability<TModel> {
  /** Bind a schema identity to this format's physical field name. */
  key(propertyId: string, storageKey: string): string;
  read(model: TModel, key: string): DocumentPropertyRead;
  write(model: TModel, key: string, value: PropertyValue): void;
  unset(model: TModel, key: string): void;
}

/** Where a document's content lives: a resource and an optional address within it. */
export interface DocumentLocation {
  /** Canonical file resource. */
  readonly resourceId: ResourceId;
  /** Optional in-resource address (e.g. a cell path); absent for whole-resource documents. */
  readonly address?: string;
}

/** A reference to a specific resource of a specific document. */
export interface DocumentRef {
  readonly documentId: DocumentId;
  readonly kindId: DocumentKindId;
  readonly location: DocumentLocation;
}

/** Decoded document content, ready for product/UI use. */
export interface DocumentRecoveryWarning {
  readonly code: string;
  readonly pageId?: string;
}

export interface DecodedDocument<TModel = unknown> {
  readonly model: TModel;
  /** Derived metadata, already normalized into the metadata index shape. */
  readonly metadata: Readonly<Record<string, unknown>>;
  /** Derived relationships to re-index. */
  readonly relationships: readonly RelationshipInput[];
  /** Machine-readable partial-recovery warnings, when decoding degraded content. */
  readonly warnings?: readonly DocumentRecoveryWarning[];
  /**
   * Disposable open-time metadata (never persisted, never projected into
   * the metadata index): decode-derived seeds such as Surface Ink bounds
   * that let the opening editor skip redundant derivation passes. Keys
   * are namespaced by domain (e.g. `surface.seedBounds`). Absent when the
   * kind has nothing to seed.
   */
  readonly openMetadata?: Readonly<Record<string, unknown>>;
}

/** Small canonical projection prepared from the exact in-memory encode snapshot. */
export interface CommittedDocumentProjection {
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly relationships: readonly RelationshipInput[];
  readonly searchText?: string;
  readonly searchAnchors?: readonly DocumentSearchAnchor[];
}

/**
 * `openMetadata` key carrying the canonical content revision (FNV-1a hex
 * of the resource bytes, see `checksumOf`): the stable revision token for
 * the opened content, owned by the session layer — computed ONCE when
 * bytes enter `DocumentSession` (open/reload/save), never again inside
 * individual document-kind decoders. Derived caches (Surface reopen
 * cache, …) validate against this token.
 */
export const DOCUMENT_CONTENT_REVISION_KEY = 'document.contentRevision';

/** Per-block search anchor into a kind's `searchText` projection. */
export interface DocumentSearchAnchor {
  /** Portable in-document address (e.g. a block id). */
  readonly address: string;
  readonly start: number;
  readonly end: number;
}

/** Provider-owned context for cloning document content stored in a template. */
export interface DocumentTemplateCloneContext {
  /** Allocate a fresh identity for provider-owned blocks, pages, or objects. */
  readonly newInternalId: () => string;
}

/** Clone a canonical JSON-shaped value without serialization or coercion. */
export function cloneTemplateValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneTemplateValue(item)) as T;
  }
  if (typeof value === 'object' && value !== null) {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('Template content contains a non-portable value');
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        cloneTemplateValue(item),
      ]),
    ) as T;
  }
  if (
    value === undefined ||
    typeof value === 'function' ||
    typeof value === 'symbol' ||
    typeof value === 'bigint'
  ) {
    throw new Error('Template content contains a non-portable value');
  }
  return value;
}

/** Core presentation vocabulary. `reading` is labelled View by the shell. */
export type DocumentPresentationMode = 'edit' | 'split' | 'reading';

/** Omitted kind metadata retains the existing binary presentation. */
export const DEFAULT_DOCUMENT_PRESENTATION_MODES: readonly DocumentPresentationMode[] =
  Object.freeze(['edit', 'reading']);

/**
 * A registered document kind. `decode`/`encode` are the storage codec: the
 * registry never touches provider-specific types (no editor, DOM, or
 * filesystem types).
 */
export interface DocumentKindDescriptor<TModel = unknown> {
  readonly id: DocumentKindId;
  /** Optional blank-document creation; codecs alone do not imply creatability. */
  readonly creation?: {
    readonly label: string;
    readonly extension: string;
    readonly createInitialModel: (title: string) => TModel;
  };
  /** Additional file suffixes accepted on import, alongside `creation.extension`. */
  readonly importExtensions?: readonly string[];
  /**
   * Clone provider content stored in a database template.
   *
   * Providers remap identities they own and preserve explicit external
   * resource and asset references. A kind that cannot safely preserve all
   * content or dependencies must omit this hook (or throw) so creation fails
   * before a canonical resource is written.
   */
  readonly cloneTemplate?: (
    model: TModel,
    context: DocumentTemplateCloneContext,
  ) => TModel;
  /**
   * Provider-owned document title semantics. This changes the title stored in
   * canonical document content; it never renames the primary resource.
   * Kinds without a safe canonical title mutation omit the capability.
   */
  readonly documentTitle?: {
    readonly read: (model: TModel, ref: DocumentRef) => string | null;
    readonly write: (model: TModel, title: string, ref: DocumentRef) => void;
  };
  /** Optional native stored-property authority. Absence selects a sidecar. */
  readonly documentProperties?: DocumentPropertyCapability<TModel>;
  /** Supported presentations, independent of provider availability or authority. */
  readonly presentationModes?: readonly DocumentPresentationMode[];
  /** Optional recognition hook; defaults to matching the kind id. */
  readonly recognize?: (kindId: unknown) => boolean;
  /** Decode raw resource bytes into a document model. */
  readonly decode: (
    data: Uint8Array,
    ref: DocumentRef,
  ) => DecodedDocument<TModel>;
  /** Cooperative decoder for large resources; returns null when its owner cancels. */
  readonly decodeAsync?: (
    data: Uint8Array,
    ref: DocumentRef,
    isCurrent: () => boolean,
  ) => Promise<DecodedDocument<TModel> | null>;
  /** Encode a document model back into raw resource bytes. */
  readonly encode: (model: TModel, ref: DocumentRef) => Uint8Array;
  /**
   * Optional cooperative encoder for large canonical documents. It may read
   * a stable save snapshot across task yields and must return `null` when
   * `isCurrent` becomes false because its owner closed. New edits do not cancel
   * an admitted snapshot; they remain pending for the next publication.
   */
  readonly encodeAsync?: (
    model: TModel,
    ref: DocumentRef,
    isCurrent: () => boolean,
  ) => Promise<Uint8Array | null>;
  /**
   * Optional cheaper post-commit projection. Called synchronously immediately
   * after encoding succeeds, while the model still matches those bytes.
   */
  readonly projectCommitted?: (
    model: TModel,
    ref: DocumentRef,
  ) => CommittedDocumentProjection;
  /**
   * Plain-text projection for derived FTS. When present, the workspace
   * indexes this instead of raw canonical bytes (which for structured
   * formats would index JSON syntax). Defaults absent.
   */
  readonly searchText?: (model: TModel) => string;
  /** Anchors aligning `searchText` ranges to portable addresses; optional. */
  readonly searchAnchors?: (model: TModel) => readonly DocumentSearchAnchor[];
}

/** The document kind registry capability. */
export interface DocumentRegistry {
  /** Register a kind; throws `DUPLICATE_DOCUMENT_KIND` on id collision. */
  register<TModel>(kind: DocumentKindDescriptor<TModel>): Disposer;
  /** Get a kind by id; throws `UNKNOWN_DOCUMENT_KIND`. */
  get(kindId: DocumentKindId): DocumentKindDescriptor;
  /** All registered kinds. */
  list(): readonly DocumentKindDescriptor[];
  /** Resolve recognition for an arbitrary kind id. */
  recognize(kindId: unknown): DocumentKindDescriptor | null;
  /** Resolve a canonical importer from its accepted extension. */
  forImportExtension(extension: string): DocumentKindDescriptor | null;
  /** Observe creator/codec availability as plugins register and withdraw. */
  onDidChange(listener: () => void): Disposer;
}

/** A reversible registration. */
export interface Disposer {
  readonly dispose: () => void;
}

/** In-memory, runtime-owned registry. */
export class InMemoryDocumentRegistry implements DocumentRegistry {
  readonly #kinds = new Map<string, DocumentKindDescriptor>();
  readonly #listeners = new Set<() => void>();

  onDidChange(listener: () => void): Disposer {
    this.#listeners.add(listener);
    return {
      dispose: () => {
        this.#listeners.delete(listener);
      },
    };
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }

  register<TModel>(kind: DocumentKindDescriptor<TModel>): Disposer {
    if (this.#kinds.has(kind.id)) {
      throw new FroglightError(
        'DUPLICATE_DOCUMENT_KIND',
        `document kind already registered: ${kind.id}`,
      );
    }
    // Boundary cast: the map is keyed by kind id; the descriptor's model
    // type is resolved by the caller via `get`, which returns the generic
    // descriptor type.
    this.#kinds.set(
      kind.id,
      kind as unknown as DocumentKindDescriptor<unknown>,
    );
    this.#notify();
    return {
      dispose: () => {
        if (this.#kinds.delete(kind.id)) this.#notify();
      },
    };
  }

  get(kindId: DocumentKindId): DocumentKindDescriptor {
    const kind = this.#kinds.get(kindId);
    if (kind === undefined) {
      throw new FroglightError(
        'UNKNOWN_DOCUMENT_KIND',
        `unknown document kind: ${kindId}`,
      );
    }
    return kind;
  }

  list(): readonly DocumentKindDescriptor[] {
    return [...this.#kinds.values()];
  }

  recognize(kindId: unknown): DocumentKindDescriptor | null {
    if (typeof kindId !== 'string') {
      return null;
    }
    for (const kind of this.#kinds.values()) {
      if (kind.recognize ? kind.recognize(kindId) : kind.id === kindId) {
        return kind;
      }
    }
    return null;
  }

  forImportExtension(extension: string): DocumentKindDescriptor | null {
    const normalized = extension.toLowerCase();
    const matches = this.list().filter((kind) =>
      [...(kind.creation ? [kind.creation.extension] : []), ...(kind.importExtensions ?? [])]
        .some((accepted) => accepted.toLowerCase() === normalized),
    );
    if (matches.length > 1) throw new Error(`Multiple document kinds accept ${normalized}`);
    return matches[0] ?? null;
  }
}

/** Allocate a fresh document id. */
export function newDocumentId(): DocumentId {
  return generateDocumentId();
}

/** Allocate a fresh resource id. */
export function newResourceId(): ResourceId {
  return generateResourceId();
}

/** Convenience: build a `DocumentRef` for a whole-resource document. */
export function refFor(
  documentId: DocumentId,
  kindId: DocumentKindId,
  resourceId: ResourceId,
): DocumentRef {
  return { documentId, kindId, location: { resourceId } };
}

/** Convenience: build a `DocumentLocation` from a resource id. */
export function locationFor(resourceId: ResourceId): DocumentLocation {
  return { resourceId };
}

/**
 * Resolve the canonical `WorkspacePath` for a resource (identity → path).
 * The workspace service owns the mapping; this helper documents the
 * contract shape used by revision and session services.
 */
export function resolvePathFor(
  mapping: (resourceId: ResourceId) => WorkspacePath | undefined,
  resourceId: ResourceId,
): WorkspacePath {
  const path = mapping(resourceId);
  if (path === undefined) {
    throw new FroglightError(
      'UNKNOWN_RESOURCE',
      `no resource with id ${resourceId}`,
    );
  }
  return path;
}

/** Re-exported path constructor for consumers of this module. */
export { workspacePath };
