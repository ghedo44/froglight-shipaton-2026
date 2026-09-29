import type { DocumentPersistenceFactory } from './surface-persistence.js';
/**
 * The workspace service: identity records, sessions, and derived state.
 *
 *
 *
 * - canonical user files are authoritative; metadata/relationship indexes
 *   are rebuildable, while the workspace record retains stable identities
 *   and recoverable-trash tombstones;
 * - identity is opaque (`DocumentId`/`ResourceId`), never a path alias;
 * - the workspace owns sessions, save/autosave/recovery, revisions, and
 *   derived-state projection; editor engines stay out of this module.
 */

import type { DocumentId, DocumentKindId, ResourceId } from './identity.js';
import { generateDocumentId, generateResourceId } from './identity.js';
import type { WorkspacePath } from './paths.js';
import {
  isWorkspacePath,
  parentPath,
  ROOT_PATH,
  workspacePath,
} from './paths.js';
import type { VaultService } from './vault/contract.js';
import { ensureDirectory } from './vault/helpers.js';
import type {
  DocumentKindDescriptor,
  DocumentRef,
  DocumentRegistry,
} from './documents.js';
import type { MetadataService } from './metadata.js';
import type { RelationshipService } from './relationships.js';
import type { RevisionService } from './revisions.js';
import type { SearchService } from './search/service.js';
import { DocumentSessionImpl, type DocumentSession } from './session.js';
import {
  parseVersionedRecord,
  serializeVersionedRecord,
  type VersionedRecord,
} from './records.js';
import { FroglightError, isVaultError } from './errors.js';

const METADATA_DIR = '.froglight';
const WORKSPACE_RECORD_PATH: WorkspacePath =
  '.froglight/workspace.json' as WorkspacePath;
const WORKSPACE_FORMAT = 'froglight.workspace';
const WORKSPACE_VERSION = 1;
const WORKSPACE_KNOWN_KEYS = new Set([
  'format',
  'version',
  'workspaceId',
  'documents',
  'trash',
]);

/** Identity record for one document (persisted, derived from creation). */
export interface WorkspaceIdentityRecord {
  readonly documentId: DocumentId;
  readonly kindId: DocumentKindId;
  readonly resourceId: ResourceId;
  readonly primaryResource: WorkspacePath;
  readonly createdMillis: number;
}

/** A recoverable document removed from the active workspace. */
export interface WorkspaceTrashRecord {
  readonly documentId: DocumentId;
  readonly kindId: DocumentKindId;
  readonly resourceId: ResourceId;
  readonly originalResource: WorkspacePath;
  /** Internal canonical location while the document is in trash. */
  readonly trashedResource: WorkspacePath;
  readonly createdMillis: number;
  readonly trashedMillis: number;
  /** Unknown fields are retained when newer writers extend tombstones. */
  readonly [key: string]: unknown;
}

export interface CreateDocumentInput<TModel = unknown> {
  readonly kindId: DocumentKindId;
  readonly path: WorkspacePath;
  readonly initialModel: TModel;
}

export interface CreateDocumentFromTemplateInput<TModel = unknown> {
  readonly kindId: DocumentKindId;
  readonly path: WorkspacePath;
  readonly templateModel: TModel;
}

export interface WorkspaceProjection {
  project(ref: DocumentRef): Promise<void>;
  remove?(ref: DocumentRef): Promise<void> | void;
  resolveResource?(id: ResourceId): WorkspacePath | undefined;
}

export interface WorkspaceService {
  /** Owner-scoped supplemental projections, independent of document kinds. */
  registerProjection(projection: WorkspaceProjection): { dispose(): void };

  readonly workspaceId: string;
  readonly projectionErrors: readonly unknown[];
  /** Create a document: encode, write, register, flush. */
  createDocument<TModel>(
    input: CreateDocumentInput<TModel>,
  ): Promise<DocumentRef>;
  /** Clone provider-owned template content, then create the document. */
  createDocumentFromTemplate<TModel>(
    input: CreateDocumentFromTemplateInput<TModel>,
  ): Promise<DocumentRef>;
  /** Duplicate the latest canonical content with fresh document/resource identities. */
  duplicateDocument(
    documentId: DocumentId,
    path: WorkspacePath,
  ): Promise<DocumentRef>;
  /** Open a session for a document; tracks it until closed. */
  openDocument<TModel = unknown>(
    documentId: DocumentId,
  ): Promise<DocumentSession<TModel>>;
  /** Borrow an existing session without closing its editor or changing ownership. */
  getOpenDocument<TModel = unknown>(
    documentId: DocumentId,
  ): DocumentSession<TModel> | null;
  /** Decode a fresh read-only snapshot from canonical bytes without opening/replacing a session. */
  readDocument<TModel = unknown>(
    documentId: DocumentId,
  ): Promise<{ readonly ref: DocumentRef; readonly model: TModel }>;
  /** Close the open session for a document; no-op when none is open. */
  closeDocument(documentId: DocumentId): Promise<void>;
  /** Move a document's primary resource; updates the identity record. */
  moveDocument(documentId: DocumentId, to: WorkspacePath): Promise<void>;
  /** Move a document to recoverable trash. Kept for existing delete callers. */
  removeDocument(documentId: DocumentId): Promise<void>;
  /** Move a document and its stable identity to recoverable trash. */
  trashDocument(documentId: DocumentId): Promise<void>;
  /** Recoverable documents, sorted by document id. */
  listTrashedDocuments(): readonly WorkspaceTrashRecord[];
  /** Restore a trashed document, preserving document and resource identity. */
  restoreDocument(
    documentId: DocumentId,
    path?: WorkspacePath,
  ): Promise<DocumentRef>;
  /** Irreversibly remove a trashed document and its property sidecar. */
  permanentlyDeleteDocument(documentId: DocumentId): Promise<void>;
  /** Find a document by its primary resource path; `null` when absent. */
  findByResourcePath(path: WorkspacePath): DocumentRef | null;
  /** Resolve a resource id to its canonical path; throws `UNKNOWN_RESOURCE`. */
  resolveResourcePath(resourceId: ResourceId): WorkspacePath;
  /** All documents, sorted by documentId. */
  listDocuments(): readonly DocumentRef[];
  /** Observe successful canonical commits without opening or replacing a document session. */
  onDidCommit(listener: (documentId: DocumentId) => void): { dispose(): void };
  /** Observe completed derived-state updates, after all projections are ready. */
  onDidUpdateDerivedState?(listener: () => void): { dispose(): void };
  /** Rebuild metadata + relationships from canonical content. */
  rebuildDerivedState(): Promise<void>;
  /**
   * Re-read the workspace record after external vault changes (sync
   * remote-apply, another process). Adopts added records, drops removed
   * ones (closing their clean sessions and cleaning derived state), and
   * follows primary-resource moves. Sessions with unsaved edits are never
   * dropped or reloaded: their records are kept so a later save still
   * resolves. Performs no vault writes itself.
   */
  reloadFromVault(): Promise<void>;
  /** Close all sessions and release the service. */
  dispose(): Promise<void>;
}

export interface WorkspaceServiceDeps {
  readonly persistenceFactory?: DocumentPersistenceFactory;
  readonly vault: VaultService;
  readonly registry: DocumentRegistry;
  readonly metadata: MetadataService;
  readonly relationships: RelationshipService;
  /** Optional revision service; `null` disables persistent revisions. */
  readonly revisions: RevisionService | null;
  /** Optional search service (derived index); when provided, workspace projects/edits maintain and rebuild it. */
  readonly search?: SearchService | null;
  readonly workspaceId?: string;
  readonly clock?: () => number;
}

interface WorkspaceRecord extends VersionedRecord {
  readonly workspaceId: string;
  readonly documents: readonly WorkspaceIdentityRecord[];
  readonly trash: readonly WorkspaceTrashRecord[];
}

type WorkspaceRecordValue = WorkspaceRecord & Record<string, unknown>;

/** Aggregate error carrying per-document rebuild failures. */
export class WorkspaceRebuildError extends FroglightError {
  readonly errors: readonly unknown[];

  constructor(errors: readonly unknown[]) {
    super(
      'RECORD_CORRUPT',
      `rebuildDerivedState failed for ${errors.length} document(s)`,
    );
    this.errors = errors;
  }
}

export class WorkspaceServiceImpl implements WorkspaceService {
  readonly workspaceId: string;
  readonly #vault: VaultService;
  readonly #registry: DocumentRegistry;
  readonly #metadata: MetadataService;
  readonly #relationships: RelationshipService;
  readonly #revisions: RevisionService | null;
  readonly #persistenceFactory: DocumentPersistenceFactory | undefined;
  readonly #search: SearchService | null;
  readonly #now: () => number;
  readonly #records: WorkspaceIdentityRecord[] = [];
  readonly #trashRecords: WorkspaceTrashRecord[] = [];
  readonly #sessions = new Map<string, DocumentSession>();
  readonly #postCommitDisposers = new Map<string, { dispose(): void }>();
  readonly #projectionErrors: unknown[] = [];
  get projectionErrors(): readonly unknown[] {
    return [...this.#projectionErrors];
  }
  readonly #projections = new Set<WorkspaceProjection>();
  readonly #commitListeners = new Set<(documentId: DocumentId) => void>();
  readonly #derivedStateListeners = new Set<() => void>();
  #creationQueue: Promise<void> = Promise.resolve();
  /** Unknown top-level record fields, preserved across flushes (records.ts contract). */
  #extras: Readonly<Record<string, unknown>>;
  #disposed = false;

  private constructor(
    deps: WorkspaceServiceDeps,
    workspaceId: string,
    extras: Readonly<Record<string, unknown>> = {},
  ) {
    this.workspaceId = workspaceId;
    this.#extras = extras;
    this.#vault = deps.vault;
    this.#persistenceFactory = deps.persistenceFactory;
    this.#registry = deps.registry;
    this.#metadata = deps.metadata;
    this.#relationships = deps.relationships;
    this.#revisions = deps.revisions;
    this.#search = deps.search ?? null;
    this.#now = deps.clock ?? (() => Date.now());
  }

  /** Load (or initialize) the workspace record and return a ready service. */
  static async create(
    deps: WorkspaceServiceDeps,
  ): Promise<WorkspaceServiceImpl> {
    await ensureDirectory(deps.vault, ROOT_PATH);
    // The metadata directory hosts the workspace record; make sure it exists
    // before the first flush.
    await ensureDirectory(deps.vault, workspacePath(METADATA_DIR));
    const loaded = await loadWorkspaceRecord(deps.vault);
    const service = new WorkspaceServiceImpl(
      deps,
      loaded?.workspaceId ?? deps.workspaceId ?? `ws-${generateResourceId()}`,
      loaded?.extras ?? {},
    );
    if (loaded !== null) {
      service.#records.push(...loaded.documents);
      service.#trashRecords.push(...loaded.trash);
    } else {
      await service.#flush();
    }
    return service;
  }

  async createDocument<TModel>(
    input: CreateDocumentInput<TModel>,
  ): Promise<DocumentRef> {
    const prior = this.#creationQueue;
    let release: () => void = () => undefined;
    this.#creationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await this.#createDocument(input);
    } finally {
      release();
    }
  }

  async createDocumentFromTemplate<TModel>(
    input: CreateDocumentFromTemplateInput<TModel>,
  ): Promise<DocumentRef> {
    this.#assertActive();
    const kind = this.#registry.get(
      input.kindId,
    ) as DocumentKindDescriptor<TModel>;
    if (kind.cloneTemplate === undefined) {
      throw new Error(
        `Document kind does not support template cloning: ${input.kindId}`,
      );
    }
    const initialModel = kind.cloneTemplate(input.templateModel, {
      newInternalId: () => generateResourceId(),
    });
    return this.createDocument({
      kindId: input.kindId,
      path: input.path,
      initialModel,
    });
  }

  async duplicateDocument(
    documentId: DocumentId,
    path: WorkspacePath,
  ): Promise<DocumentRef> {
    this.#assertActive();
    const source = await this.readDocument(documentId);
    return this.createDocumentFromTemplate({
      kindId: source.ref.kindId,
      path,
      templateModel: source.model,
    });
  }

  async #createDocument<TModel>(
    input: CreateDocumentInput<TModel>,
  ): Promise<DocumentRef> {
    this.#assertActive();
    const kind = this.#registry.get(input.kindId);
    const documentId = generateDocumentId();
    const resourceId = generateResourceId();
    const ref: DocumentRef = {
      documentId,
      kindId: input.kindId,
      location: { resourceId },
    };
    const data = kind.encode(input.initialModel, ref);
    const parent = parentPath(input.path);
    if (parent !== null) {
      await ensureDirectory(this.#vault, parent);
    }
    try {
      await this.#vault.stat(input.path);
      throw new FroglightError(
        'ALREADY_EXISTS',
        `Document path already exists: ${input.path}`,
      );
    } catch (error) {
      if (!isVaultError(error) || error.code !== 'NOT_FOUND') throw error;
    }
    await this.#vault.write(input.path, data);
    const record: WorkspaceIdentityRecord = {
      documentId,
      kindId: input.kindId,
      resourceId,
      primaryResource: input.path,
      createdMillis: this.#now(),
    };
    this.#records.push(record);
    try {
      await this.#flush();
    } catch (error) {
      // Keep canonical state consistent: the file was written but the
      // record could not be persisted — remove the file again.
      this.#records.pop();
      try {
        await this.#vault.remove(input.path);
      } catch {
        // Best-effort rollback; the record is authoritative for recovery.
      }
      throw error;
    }
    await this.#notifyResourceChange(record);
    return ref;
  }

  registerProjection(projection: WorkspaceProjection): { dispose(): void } {
    this.#assertActive();
    this.#projections.add(projection);
    return {
      dispose: () => {
        this.#projections.delete(projection);
      },
    };
  }

  getOpenDocument<TModel = unknown>(
    documentId: DocumentId,
  ): DocumentSession<TModel> | null {
    this.#assertActive();
    return (
      (this.#sessions.get(documentId) as DocumentSession<TModel> | undefined) ??
      null
    );
  }

  async openDocument<TModel = unknown>(
    documentId: DocumentId,
  ): Promise<DocumentSession<TModel>> {
    this.#assertActive();
    const record = this.#recordFor(documentId);
    const kind = this.#registry.get(record.kindId);
    const ref: DocumentRef = {
      documentId: record.documentId,
      kindId: record.kindId,
      location: { resourceId: record.resourceId },
    };
    // One open session per document: a second open replaces the previous
    // session, which is closed first so no session can outlive the
    // workspace untracked.
    const existing = this.#sessions.get(documentId);
    if (existing !== undefined) {
      const existingDisposer = this.#postCommitDisposers.get(documentId);
      if (existingDisposer !== undefined) {
        existingDisposer.dispose();
        this.#postCommitDisposers.delete(documentId);
      }
      await existing.close();
    }
    const session = new DocumentSessionImpl({
      ref,
      kind,
      vault: this.#vault,
      revisions: this.#revisions,
      persistence: this.#persistenceFactory?.(this.workspaceId, ref, kind) ?? null,
      resolveResourcePath: (resourceId) => this.#pathFor(resourceId),
      clock: this.#now,
      onClosed: () => {
        // Only detach the session that actually closed: a stale session
        // for the same document must not evict its replacement.
        if (this.#sessions.get(documentId) === session) {
          this.#sessions.delete(documentId);
          const disposer = this.#postCommitDisposers.get(documentId);
          if (disposer !== undefined) {
            disposer.dispose();
            this.#postCommitDisposers.delete(documentId);
          }
        }
      },
    });
    this.#sessions.set(documentId, session);
    try {
      await session.open();
    } catch (error) {
      this.#sessions.delete(documentId);
      throw error;
    }
    // Post-commit incremental projection: keep derived state fresh without
    // a full rebuild. Large structured kinds provide a projection from the
    // exact encoded model, avoiding another full decode of every stroke.
    // Listener errors surface as session derivedError.
    // The disposer is owner-scoped and disposed when the session closes
    // or is replaced, satisfying AGENTS.md effect ownership.
    const postCommitDisposer = session.onPostCommit(async (result, committedData, projection) => {
      if (!result.committed || committedData === undefined) {
        return;
      }
      // Use the exact encoded model projection when available. Other kinds
      // still decode the committed bytes as their canonical projection.
      const needsDecode =
        projection === undefined ||
        (kind.searchText !== undefined && projection.searchText === undefined) ||
        (kind.searchAnchors !== undefined && projection.searchAnchors === undefined);
      const decoded = needsDecode ? kind.decode(committedData, ref) : undefined;
      const committedProjection = projection ?? decoded;
      if (committedProjection === undefined) return;
      this.#metadata.upsert(record.documentId, {
        createdMillis: record.createdMillis,
        ...committedProjection.metadata,
      });
      this.#relationships.removeBySource(record.resourceId);
      for (const relationship of committedProjection.relationships) {
        this.#relationships.add(relationship);
      }
      for (const projection of this.#projections) await projection.project(ref);
      if (this.#search !== null) {
        try {
          // Structured kinds project plain text; textual kinds fall back
          // to canonical bytes. Anchors keep results block-addressable.
          const text =
            projection?.searchText ??
            (kind.searchText !== undefined && decoded !== undefined
              ? kind.searchText(decoded.model)
              : new TextDecoder().decode(committedData));
          const anchors =
            projection?.searchAnchors ??
            (decoded === undefined ? undefined : kind.searchAnchors?.(decoded.model));
          this.#search.indexDocument(
            record.documentId,
            ref.location,
            text,
            anchors,
          );
        } catch {
          // Search indexing failure is derived-state only; commit already succeeded.
        }
      }
      for (const listener of this.#commitListeners) listener(record.documentId);
      this.#notifyDerivedStateListeners();
    });
    this.#postCommitDisposers.set(documentId, postCommitDisposer);
    // The caller asserts the expected model family via the type parameter;
    // runtime behavior is identical for every kind.
    return session as DocumentSession<TModel>;
  }

  async readDocument<TModel = unknown>(
    documentId: DocumentId,
  ): Promise<{ readonly ref: DocumentRef; readonly model: TModel }> {
    this.#assertActive();
    const record = this.#recordFor(documentId);
    const ref = this.#refFor(record);
    const kind = this.#registry.get(record.kindId);
    const data = await this.#vault.read(record.primaryResource);
    const decoded = kind.decodeAsync === undefined
      ? kind.decode(data, ref)
      : await kind.decodeAsync(data, ref, () => true);
    if (decoded === null) {
      throw new FroglightError('ABORTED', 'document read decode was cancelled');
    }
    return { ref, model: decoded.model as TModel };
  }

  async closeDocument(documentId: DocumentId): Promise<void> {
    this.#assertActive();
    const session = this.#sessions.get(documentId);
    if (session !== undefined) {
      await session.close();
    }
  }

  async moveDocument(documentId: DocumentId, to: WorkspacePath): Promise<void> {
    this.#assertActive();
    const record = this.#recordFor(documentId);
    const from = record.primaryResource;
    if (from === to) {
      return;
    }
    const parent = parentPath(to);
    if (parent !== null) {
      await ensureDirectory(this.#vault, parent);
    }
    await this.#vault.move(from, to);
    const previous = record.primaryResource;
    (record as { primaryResource: WorkspacePath }).primaryResource = to;
    try {
      await this.#flush();
    } catch (error) {
      // Roll the move back so the record and the tree stay consistent.
      (record as { primaryResource: WorkspacePath }).primaryResource = previous;
      try {
        await this.#vault.move(to, from);
      } catch {
        // Best-effort; the record is authoritative for recovery.
      }
      throw error;
    }
    await this.#notifyResourceChange(record);
  }

  /**
   * Project one record's derived state from canonical bytes (metadata,
   * relationships, search, projections) without firing commit listeners:
   * used when adopting externally added/moved records, where no local
   * commit happened.
   */
  async #projectRecord(record: WorkspaceIdentityRecord): Promise<void> {
    try {
      const kind = this.#registry.get(record.kindId);
      const ref = this.#refFor(record);
      const bytes = await this.#vault.read(record.primaryResource);
      const decoded = kind.decode(bytes, ref);
      this.#metadata.upsert(record.documentId, {
        createdMillis: record.createdMillis,
        ...decoded.metadata,
      });
      this.#relationships.removeBySource(record.resourceId);
      for (const relationship of decoded.relationships) {
        this.#relationships.add(relationship);
      }
      if (this.#search !== null) {
        try {
          const text =
            kind.searchText !== undefined
              ? kind.searchText(decoded.model)
              : new TextDecoder().decode(bytes);
          const anchors = kind.searchAnchors?.(decoded.model);
          this.#search.indexDocument(
            record.documentId,
            ref.location,
            text,
            anchors,
          );
        } catch {
          // Search indexing failure is derived-state only.
        }
      }
      for (const projection of this.#projections) {
        try {
          await projection.project(ref);
        } catch (error) {
          this.#projectionErrors.push(error);
        }
      }
    } catch (error) {
      this.#projectionErrors.push(error);
    }
  }

  async #notifyResourceChange(
    record: WorkspaceIdentityRecord,
    removed = false,
  ): Promise<void> {
    if (!removed) {
      try {
        const kind = this.#registry.get(record.kindId);
        const ref = this.#refFor(record);
        const bytes = await this.#vault.read(record.primaryResource);
        const decoded = kind.decode(bytes, ref);
        this.#metadata.upsert(record.documentId, {
          createdMillis: record.createdMillis,
          ...decoded.metadata,
        });
        this.#relationships.removeBySource(record.resourceId);
        for (const relationship of decoded.relationships)
          this.#relationships.add(relationship);
        this.#search?.indexDocument(
          record.documentId,
          ref.location,
          kind.searchText?.(decoded.model) ?? new TextDecoder().decode(bytes),
          kind.searchAnchors?.(decoded.model),
        );
      } catch (error) {
        this.#projectionErrors.push(error);
      }
    }
    for (const projection of this.#projections) {
      try {
        if (removed) await projection.remove?.(this.#refFor(record));
        else await projection.project(this.#refFor(record));
      } catch (error) {
        this.#projectionErrors.push(error);
      }
    }
    for (const listener of this.#commitListeners) {
      try {
        listener(record.documentId);
      } catch (error) {
        this.#projectionErrors.push(error);
      }
    }
    this.#notifyDerivedStateListeners();
  }

  async removeDocument(documentId: DocumentId): Promise<void> {
    await this.trashDocument(documentId);
  }

  async trashDocument(documentId: DocumentId): Promise<void> {
    this.#assertActive();
    const record = this.#recordFor(documentId);
    const index = this.#records.indexOf(record);
    const trashedResource = trashResourcePath(record.documentId);
    const tombstone: WorkspaceTrashRecord = {
      documentId: record.documentId,
      kindId: record.kindId,
      resourceId: record.resourceId,
      originalResource: record.primaryResource,
      trashedResource,
      createdMillis: record.createdMillis,
      trashedMillis: this.#now(),
    };

    // Close before moving the canonical bytes so post-commit hooks cannot
    // recreate active projections for a trashed document.
    const session = this.#sessions.get(documentId);
    if (session !== undefined) {
      await session.close();
    }
    await ensureDirectory(this.#vault, parentPath(trashedResource));
    await this.#vault.move(record.primaryResource, trashedResource);
    this.#records.splice(index, 1);
    this.#trashRecords.push(tombstone);
    try {
      await this.#flush();
    } catch (error) {
      this.#trashRecords.splice(this.#trashRecords.indexOf(tombstone), 1);
      this.#records.splice(Math.min(index, this.#records.length), 0, record);
      try {
        await this.#vault.move(trashedResource, record.primaryResource);
      } catch (rollbackError) {
        throw rollbackFailure(
          'trash failed and its canonical move could not be rolled back',
          error,
          rollbackError,
        );
      }
      throw error;
    }
    this.#metadata.remove(record.documentId);
    this.#relationships.removeBySource(record.resourceId);
    this.#search?.remove(record.documentId);
    await this.#notifyResourceChange(record, true);
  }

  listTrashedDocuments(): readonly WorkspaceTrashRecord[] {
    this.#assertActive();
    return [...this.#trashRecords].sort((a, b) =>
      a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : 0,
    );
  }

  async restoreDocument(
    documentId: DocumentId,
    path?: WorkspacePath,
  ): Promise<DocumentRef> {
    this.#assertActive();
    const tombstone = this.#trashRecordFor(documentId);
    const target = path ?? tombstone.originalResource;
    const record: WorkspaceIdentityRecord = {
      documentId: tombstone.documentId,
      kindId: tombstone.kindId,
      resourceId: tombstone.resourceId,
      primaryResource: target,
      createdMillis: tombstone.createdMillis,
    };
    await ensureDirectory(this.#vault, parentPath(target));
    await this.#vault.move(tombstone.trashedResource, target);
    const index = this.#trashRecords.indexOf(tombstone);
    this.#trashRecords.splice(index, 1);
    this.#records.push(record);
    try {
      await this.#flush();
    } catch (error) {
      this.#records.splice(this.#records.indexOf(record), 1);
      this.#trashRecords.splice(
        Math.min(index, this.#trashRecords.length),
        0,
        tombstone,
      );
      try {
        await this.#vault.move(target, tombstone.trashedResource);
      } catch (rollbackError) {
        throw rollbackFailure(
          'restore failed and its canonical move could not be rolled back',
          error,
          rollbackError,
        );
      }
      throw error;
    }
    await this.#notifyResourceChange(record);
    return this.#refFor(record);
  }

  async permanentlyDeleteDocument(documentId: DocumentId): Promise<void> {
    this.#assertActive();
    const tombstone = this.#trashRecordFor(documentId);
    const index = this.#trashRecords.indexOf(tombstone);
    const canonical = await this.#vault.read(tombstone.trashedResource);
    const sidecarPath = propertySidecarPath(tombstone.resourceId);
    const sidecar = await readOptional(this.#vault, sidecarPath);

    await this.#vault.remove(tombstone.trashedResource);
    try {
      if (sidecar !== null) await this.#vault.remove(sidecarPath);
    } catch (error) {
      await restoreBytesOrThrow(
        this.#vault,
        tombstone.trashedResource,
        canonical,
        error,
        'permanent delete failed and canonical trash could not be restored',
      );
      throw error;
    }

    this.#trashRecords.splice(index, 1);
    try {
      await this.#flush();
    } catch (error) {
      this.#trashRecords.splice(
        Math.min(index, this.#trashRecords.length),
        0,
        tombstone,
      );
      const failures: unknown[] = [];
      try {
        await this.#vault.write(tombstone.trashedResource, canonical);
      } catch (rollbackError) {
        failures.push(rollbackError);
      }
      if (sidecar !== null) {
        try {
          await this.#vault.write(sidecarPath, sidecar);
        } catch (rollbackError) {
          failures.push(rollbackError);
        }
      }
      if (failures.length > 0) {
        throw rollbackFailure(
          'permanent delete failed and deleted bytes could not be restored',
          error,
          ...failures,
        );
      }
      throw error;
    }
  }

  findByResourcePath(path: WorkspacePath): DocumentRef | null {
    this.#assertActive();
    const record = this.#records.find((r) => r.primaryResource === path);
    return record === undefined ? null : this.#refFor(record);
  }

  resolveResourcePath(resourceId: ResourceId): WorkspacePath {
    this.#assertActive();
    for (const projection of this.#projections) {
      const path = projection.resolveResource?.(resourceId);
      if (path !== undefined) return path;
    }
    return this.#pathFor(resourceId);
  }

  listDocuments(): readonly DocumentRef[] {
    this.#assertActive();
    return [...this.#records]
      .sort((a, b) =>
        a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : 0,
      )
      .map((record) => this.#refFor(record));
  }

  onDidCommit(listener: (documentId: DocumentId) => void): { dispose(): void } {
    this.#assertActive();
    this.#commitListeners.add(listener);
    return { dispose: () => this.#commitListeners.delete(listener) };
  }

  onDidUpdateDerivedState(listener: () => void): { dispose(): void } {
    this.#assertActive();
    this.#derivedStateListeners.add(listener);
    return { dispose: () => this.#derivedStateListeners.delete(listener) };
  }

  async reloadFromVault(): Promise<void> {
    this.#assertActive();
    let loaded: {
      workspaceId: string;
      documents: readonly WorkspaceIdentityRecord[];
      trash: readonly WorkspaceTrashRecord[];
      extras: Readonly<Record<string, unknown>>;
    } | null;
    try {
      loaded = await loadWorkspaceRecord(this.#vault);
    } catch {
      // An unreadable record (corrupt bytes mid-download) leaves
      // in-memory state untouched; the next reconcile retries.
      return;
    }
    if (loaded === null) return;
    const incoming = new Map(
      loaded.documents.map((doc) => [doc.documentId, doc]),
    );
    // Drop records the vault no longer lists (clean sessions only).
    for (const record of [...this.#records]) {
      const next = incoming.get(record.documentId);
      if (next !== undefined) continue;
      const session = this.#sessions.get(record.documentId);
      if (session !== undefined && session.dirty) continue;
      if (session !== undefined) {
        try {
          await session.close();
        } catch {
          // Best-effort: session teardown must not block the reload.
        }
      }
      const index = this.#records.indexOf(record);
      if (index >= 0) this.#records.splice(index, 1);
      this.#metadata.remove(record.documentId);
      this.#relationships.removeBySource(record.resourceId);
      this.#search?.remove(record.documentId);
      for (const projection of this.#projections) {
        try {
          await projection.remove?.(this.#refFor(record));
        } catch (error) {
          this.#projectionErrors.push(error);
        }
      }
    }
    // Adopt new records and follow moves.
    for (const doc of loaded.documents) {
      const known = this.#records.find((r) => r.documentId === doc.documentId);
      if (known === undefined) {
        this.#records.push({ ...doc });
        await this.#projectRecord({ ...doc });
        continue;
      }
      if (known.primaryResource !== doc.primaryResource) {
        (known as { primaryResource: WorkspacePath }).primaryResource =
          doc.primaryResource;
        await this.#projectRecord(known);
      }
    }
    // A dirty local session retains its active record until it can be saved
    // or closed; do not expose the same identity as both active and trashed.
    const retainedActiveIds = new Set(this.#records.map((r) => r.documentId));
    this.#trashRecords.splice(
      0,
      this.#trashRecords.length,
      ...loaded.trash
        .filter((entry) => !retainedActiveIds.has(entry.documentId))
        .map((entry) => ({ ...entry })),
    );
    this.#extras = loaded.extras;
    this.#notifyDerivedStateListeners();
  }

  async rebuildDerivedState(): Promise<void> {
    this.#assertActive();
    this.#metadata.clear();
    this.#relationships.clear();
    if (this.#search !== null) {
      this.#search.clear();
    }
    const failures: unknown[] = [];
    for (const record of this.#records) {
      try {
        const kind = this.#registry.get(record.kindId);
        const data = await this.#vault.read(record.primaryResource);
        const decoded = kind.decode(data, this.#refFor(record));
        this.#metadata.upsert(record.documentId, {
          createdMillis: record.createdMillis,
          ...decoded.metadata,
        });
        for (const relationship of decoded.relationships) {
          this.#relationships.add(relationship);
        }
        for (const projection of this.#projections)
          await projection.project(this.#refFor(record));
        if (this.#search !== null) {
          const text =
            kind.searchText !== undefined
              ? kind.searchText(decoded.model)
              : new TextDecoder().decode(data);
          const anchors = kind.searchAnchors?.(decoded.model);
          this.#search.indexDocument(
            record.documentId,
            this.#refFor(record).location,
            text,
            anchors,
          );
        }
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new WorkspaceRebuildError(failures);
    }
    this.#notifyDerivedStateListeners();
  }

  async dispose(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#projections.clear();
    for (const disposer of this.#postCommitDisposers.values()) {
      disposer.dispose();
    }
    this.#postCommitDisposers.clear();
    this.#commitListeners.clear();
    this.#derivedStateListeners.clear();
    await Promise.all(
      [...this.#sessions.values()].map((session) => session.close()),
    );
    this.#sessions.clear();
  }

  #recordFor(documentId: DocumentId): WorkspaceIdentityRecord {
    const record = this.#records.find((r) => r.documentId === documentId);
    if (record === undefined) {
      throw new FroglightError(
        'UNKNOWN_DOCUMENT',
        `no document with id ${documentId}`,
      );
    }
    return record;
  }

  #trashRecordFor(documentId: DocumentId): WorkspaceTrashRecord {
    const record = this.#trashRecords.find((r) => r.documentId === documentId);
    if (record === undefined) {
      throw new FroglightError(
        'UNKNOWN_DOCUMENT',
        `no trashed document with id ${documentId}`,
      );
    }
    return record;
  }

  #notifyDerivedStateListeners(): void {
    for (const listener of [...this.#derivedStateListeners]) {
      try {
        listener();
      } catch (error) {
        this.#projectionErrors.push(error);
      }
    }
  }

  #pathFor(resourceId: ResourceId): WorkspacePath {
    const record = this.#records.find((r) => r.resourceId === resourceId);
    if (record === undefined) {
      throw new FroglightError(
        'UNKNOWN_RESOURCE',
        `no resource with id ${resourceId}`,
      );
    }
    return record.primaryResource;
  }

  #refFor(record: WorkspaceIdentityRecord): DocumentRef {
    return {
      documentId: record.documentId,
      kindId: record.kindId,
      location: { resourceId: record.resourceId },
    };
  }

  async #flush(): Promise<void> {
    const record: WorkspaceRecordValue = {
      format: WORKSPACE_FORMAT,
      version: WORKSPACE_VERSION,
      workspaceId: this.workspaceId,
      documents: this.#records.map((r) => ({ ...r })),
      trash: this.#trashRecords.map((r) => ({ ...r })),
    };
    await this.#vault.write(
      WORKSPACE_RECORD_PATH,
      serializeVersionedRecord(record, this.#extras),
    );
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new FroglightError(
        'SERVICE_DISPOSED',
        'workspace service is disposed',
      );
    }
  }
}

async function loadWorkspaceRecord(vault: VaultService): Promise<{
  workspaceId: string;
  documents: readonly WorkspaceIdentityRecord[];
  trash: readonly WorkspaceTrashRecord[];
  extras: Readonly<Record<string, unknown>>;
} | null> {
  let data: Uint8Array;
  try {
    data = await vault.read(WORKSPACE_RECORD_PATH);
  } catch (error) {
    if (isVaultError(error) && error.code === 'NOT_FOUND') {
      return null;
    }
    throw error;
  }
  const { record, extras } = parseVersionedRecord<WorkspaceRecordValue>(
    data,
    WORKSPACE_FORMAT,
    [WORKSPACE_VERSION],
    WORKSPACE_KNOWN_KEYS,
  );
  if (
    typeof record.workspaceId !== 'string' ||
    !Array.isArray(record.documents)
  ) {
    throw new FroglightError(
      'RECORD_CORRUPT',
      'workspace record has invalid shape',
    );
  }
  const documents: WorkspaceIdentityRecord[] = [];
  for (const entry of record.documents) {
    if (!isIdentityRecord(entry)) {
      throw new FroglightError(
        'RECORD_CORRUPT',
        'workspace record has an invalid document entry',
      );
    }
    documents.push(entry);
  }
  if (!Array.isArray(record.trash)) {
    throw new FroglightError(
      'RECORD_CORRUPT',
      'workspace record has invalid trash',
    );
  }
  const trash: WorkspaceTrashRecord[] = [];
  for (const entry of record.trash) {
    if (!isTrashRecord(entry)) {
      throw new FroglightError(
        'RECORD_CORRUPT',
        'workspace record has an invalid trash entry',
      );
    }
    trash.push(entry);
  }
  assertUniqueWorkspaceIdentities(documents, trash);
  return { workspaceId: record.workspaceId, documents, trash, extras };
}

function isIdentityRecord(value: unknown): value is WorkspaceIdentityRecord {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.documentId === 'string' &&
    entry.documentId.length > 0 &&
    typeof entry.kindId === 'string' &&
    entry.kindId.length > 0 &&
    typeof entry.resourceId === 'string' &&
    entry.resourceId.length > 0 &&
    isWorkspacePath(entry.primaryResource) &&
    typeof entry.createdMillis === 'number' &&
    Number.isFinite(entry.createdMillis)
  );
}

function isTrashRecord(value: unknown): value is WorkspaceTrashRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.documentId === 'string' &&
    entry.documentId.length > 0 &&
    typeof entry.kindId === 'string' &&
    entry.kindId.length > 0 &&
    typeof entry.resourceId === 'string' &&
    entry.resourceId.length > 0 &&
    isWorkspacePath(entry.originalResource) &&
    isWorkspacePath(entry.trashedResource) &&
    entry.trashedResource ===
      trashResourcePath(entry.documentId as DocumentId) &&
    typeof entry.createdMillis === 'number' &&
    Number.isFinite(entry.createdMillis) &&
    typeof entry.trashedMillis === 'number' &&
    Number.isFinite(entry.trashedMillis)
  );
}

function assertUniqueWorkspaceIdentities(
  documents: readonly WorkspaceIdentityRecord[],
  trash: readonly WorkspaceTrashRecord[],
): void {
  const documentIds = new Set<string>();
  const resourceIds = new Set<string>();
  const activePaths = new Set<string>();
  const trashPaths = new Set<string>();
  for (const entry of documents) {
    if (
      documentIds.has(entry.documentId) ||
      resourceIds.has(entry.resourceId) ||
      activePaths.has(entry.primaryResource)
    ) {
      throw new FroglightError(
        'RECORD_CORRUPT',
        'workspace record contains duplicate active identities',
      );
    }
    documentIds.add(entry.documentId);
    resourceIds.add(entry.resourceId);
    activePaths.add(entry.primaryResource);
  }
  for (const entry of trash) {
    if (
      documentIds.has(entry.documentId) ||
      resourceIds.has(entry.resourceId) ||
      trashPaths.has(entry.trashedResource)
    ) {
      throw new FroglightError(
        'RECORD_CORRUPT',
        'workspace record contains duplicate trash identities',
      );
    }
    documentIds.add(entry.documentId);
    resourceIds.add(entry.resourceId);
    trashPaths.add(entry.trashedResource);
  }
}

function trashResourcePath(documentId: DocumentId): WorkspacePath {
  return workspacePath(
    `.froglight/trash/documents/${encodeURIComponent(documentId)}`,
  );
}

function propertySidecarPath(resourceId: ResourceId): WorkspacePath {
  return workspacePath(
    `.froglight/properties/${encodeURIComponent(resourceId)}.json`,
  );
}

async function readOptional(
  vault: VaultService,
  path: WorkspacePath,
): Promise<Uint8Array | null> {
  try {
    return await vault.read(path);
  } catch (error) {
    if (isVaultError(error) && error.code === 'NOT_FOUND') return null;
    throw error;
  }
}

async function restoreBytesOrThrow(
  vault: VaultService,
  path: WorkspacePath,
  bytes: Uint8Array,
  originalError: unknown,
  message: string,
): Promise<void> {
  try {
    await vault.write(path, bytes);
  } catch (rollbackError) {
    throw rollbackFailure(message, originalError, rollbackError);
  }
}

function rollbackFailure(
  message: string,
  ...errors: readonly unknown[]
): FroglightError {
  return new FroglightError('WORKSPACE_ROLLBACK_FAILED', message, {
    cause: new AggregateError(errors, message),
  });
}

/** Re-exported for consumers that need the record path. */
export { WORKSPACE_RECORD_PATH };
