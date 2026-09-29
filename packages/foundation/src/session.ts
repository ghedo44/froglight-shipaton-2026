import {
  drainSurfaceDocumentWork,
  retrySurfaceDocumentWork,
} from './surfaces/transactions.js';
import {
  mergeSurfaceDocumentDeltas,
  SurfaceDeltaCollector,
  type DocumentPersistence,
  type SurfaceDocumentDelta,
} from './surface-persistence.js';
/**
 * `DocumentSession` — the editor-neutral session contract.
 *
 * A session binds one open document to its storage: it owns the model
 * instance, tracks dirty/saving/error state, and performs save/reload/close
 * through the vault. It deliberately contains no editor types (no
 * CodeMirror/Tiptap/DOM/Canvas/PDF), no multi-view sync, and no universal
 * transaction model — undo/redo stays provider-local.
 *
 * Save semantics:
 *
 * - `save()` publishes a stable snapshot and records a revision by default.
 *   Later edits remain dirty; automatic publication can omit revisions.
 * - Surface edits advance an independent local journal and durability sequence.
 * - A storage failure never rejects `save()`: the session transitions to
 *   `error` and reports the failure via `lastError`/`lastDerivedError`.
 * - Post-commit listener failures are captured as `derivedError` (the
 *   commit itself succeeded).
 * - `onStateChange` listener errors propagate to the caller of the
 *   operation that triggered the transition.
 */

import type { DocumentKindId, ResourceId } from './identity.js';
import type {
  DocumentRef,
  DocumentKindDescriptor,
  DocumentRecoveryWarning,
  CommittedDocumentProjection,
} from './documents.js';
import { DOCUMENT_CONTENT_REVISION_KEY } from './documents.js';
import { checksumOfAsync } from './revisions.js';
import type { WorkspacePath } from './paths.js';
import type { VaultService } from './vault/contract.js';
import type { RevisionService, RevisionRecord } from './revisions.js';
import { FroglightError, isFroglightError } from './errors.js';

export type DocumentSessionState =
  | 'closed'
  | 'opening'
  | 'open'
  | 'saving'
  | 'error'
  | 'closing';

export interface SaveResult {
  /** True when the canonical resource was written. */
  committed: boolean;
  /** Persistent revision recorded for this save; `null` when revisions are disabled. */
  revision: RevisionRecord | null;
  /** Failure of the commit itself (storage); present only when `committed` is false. */
  error: unknown;
  /** Failure of a post-commit step (revision recording, listeners); the commit still succeeded. */
  derivedError: unknown;
}

export interface DocumentSession<TModel = unknown> {
  readonly document: DocumentRef;
  readonly kindId: DocumentKindId;
  readonly state: DocumentSessionState;
  /** True when the in-memory model differs from the stored resource. */
  readonly dirty: boolean;
  /** True only when a failed write permits retaining edits and retrying save. */
  readonly canRetrySave?: boolean;
  /** The live model instance. */
  readonly model: TModel;
  /** Last commit failure; `null` when the last save committed. */
  readonly lastError: unknown;
  /** Last post-commit failure; `null` when the last save was fully clean. */
  readonly lastDerivedError: unknown;
  /** Revision id of the last successful save; `null` before the first save. */
  readonly lastSavedRevision: string | null;
  /** Machine-readable warnings from the most recent partial-recovery decode. */
  readonly recoveryWarnings: readonly DocumentRecoveryWarning[];
  /**
   * Disposable open-time metadata from the most recent decode (never
   * persisted, never projected): decode-derived seeds such as Surface Ink
   * bounds that let the mounting editor skip redundant derivation passes. Empty
   * when the kind supplied none. Refreshed on every `open`/`reload`.
   * Always carries the session-owned canonical content revision
   * (`DOCUMENT_CONTENT_REVISION_KEY`) as derived session identity.
   */
  readonly openMetadata: Readonly<Record<string, unknown>>;
  /**
   * Canonical content revision of the opened bytes (FNV-1a hex): the
   * stable revision token for derived-cache validation, computed ONCE
   * when bytes enter this layer (`open`/`reload`/successful `save`) —
   * document-kind decoders must use this instead of rescanning the whole
   * byte buffer themselves. `null` before the first successful open.
   *
   * Stable across in-place edits by design: it only advances when bytes
   * are (re)read or committed. Pair it with `contentSequence` for a
   * dirty-aware derived-cache key.
   */
  readonly contentRevision: string | null;
  /**
   * Monotonic content-commit sequence for dirty-aware derived-cache keys.
   *
   * Starts at `0` for a fresh session and increments on every `markDirty`
   * (including repeated edits while dirty or saving). `save`/`reload`/
   * `open` never reset it within the session lifetime, so
   * `${contentRevision}:${contentSequence}` is stable when content is
   * unchanged and advances on every in-place commit. Never persisted,
   * never projected: combine it with `contentRevision` at the call site.
   */
  readonly contentSequence: number;
  readonly localJournalEnabled?: boolean;
  readonly editedSeq?: number;
  readonly durableSeq?: number;
  readonly publishedSeq?: number;
  readonly persistenceError?: unknown;
  onDidChangePersistence?(listener: () => void): Disposer;

  /** Open the session: decode the stored resource into the model. */
  open(): Promise<void>;
  /** Mark the model dirty (called by the editor integration on change). */
  markDirty(): void;
  /** Save the model; retry transient write failures without reopening/discarding it. */
  save(options?: { readonly recordRevision?: boolean }): Promise<SaveResult>;
  /** Explicitly authorize publication over the current external version. */
  resolvePublicationConflict?(): Promise<SaveResult>;
  /** Reload from the canonical resource, discarding unsaved changes. */
  reload(): Promise<void>;
  /** Close the session; idempotent. */
  close(): Promise<void>;
  /** Subscribe to state transitions; listener errors propagate to the triggering operation. */
  onStateChange(listener: (state: DocumentSessionState) => void): Disposer;
  /** Subscribe to dirty-flag changes; fires when the flag actually flips. */
  onDidChangeDirty(listener: (dirty: boolean) => void): Disposer;
  /**
   * Application-facing content invalidation after each markDirty, including
   * repeated edits while dirty or saving. Listener errors propagate to caller.
   * Does not replace dirty edges or post-commit notifications.
   */
  onDidChangeContent(listener: () => void): Disposer;
  /**
   * Subscribe to post-commit notifications; listener errors become
   * `derivedError`. Callbacks receive the exact committed bytes and, when the
   * kind provides one, a projection prepared from that same model state.
   */
  onPostCommit(
    listener: (
      result: SaveResult,
      committedData?: Uint8Array,
      projection?: CommittedDocumentProjection,
    ) => void | Promise<void>,
  ): Disposer;
}

export interface Disposer {
  readonly dispose: () => void;
}

export interface DocumentSessionDeps<TModel = unknown> {
  readonly persistence?: DocumentPersistence | null;
  readonly ref: DocumentRef;
  readonly kind: DocumentKindDescriptor<TModel>;
  readonly vault: VaultService;
  /** Optional revision service; `null` disables persistent revisions. */
  readonly revisions: RevisionService | null;
  /** Identity → canonical path resolver for the session's resource. */
  readonly resolveResourcePath: (
    resourceId: ResourceId,
  ) => WorkspacePath | undefined;
  /** Clock for revision timestamps; defaults to `Date.now`. */
  readonly clock?: () => number;
  /** Invoked once when the session reaches `closed`. */
  readonly onClosed?: () => void;
}

export class DocumentSessionImpl<TModel = unknown>
  implements DocumentSession<TModel>
{
  readonly document: DocumentRef;
  readonly kindId: DocumentKindId;
  readonly #kind: DocumentKindDescriptor<TModel>;
  readonly #vault: VaultService;
  readonly #revisions: RevisionService | null;
  readonly #resolveResourcePath: (
    resourceId: ResourceId,
  ) => WorkspacePath | undefined;
  readonly #onClosed: (() => void) | undefined;

  readonly #persistence: DocumentPersistence | null;
  #collector: SurfaceDeltaCollector | null = null;
  #captureScheduled = false;
  #durableSeq = 0;
  #publishedSeq = 0;
  #persistenceError: unknown = null;
  #journal: Array<{ sequence: number; delta: SurfaceDocumentDelta }> = [];
  #journalPump: Promise<void> | null = null;
  readonly #persistenceListeners = new Set<() => void>();
  #state: DocumentSessionState = 'closed';
  #dirty = false;
  #editGeneration = 0;
  #decodeGeneration = 0;
  #pendingSave: Promise<SaveResult> | null = null;
  #pendingWrite: Promise<void> | null = null;
  #closingPromise: Promise<void> | null = null;
  // Eligibility belongs to a failed canonical write, never to error state alone.
  #retryableSaveFailure = false;
  #model: TModel;
  #lastError: unknown = null;
  #lastDerivedError: unknown = null;
  #lastSavedRevision: string | null = null;
  #recoveryWarnings: readonly DocumentRecoveryWarning[] = [];
  #openMetadata: Readonly<Record<string, unknown>> = {};
  #contentRevision: string | null = null;
  #savingChecksum: string | null = null;
  #publishedChecksum: string | null = null;
  readonly #stateListeners = new Set<(state: DocumentSessionState) => void>();
  readonly #contentListeners = new Set<() => void>();
  readonly #dirtyListeners = new Set<(dirty: boolean) => void>();
  readonly #postCommitListeners = new Set<
    (
      result: SaveResult,
      committedData?: Uint8Array,
      projection?: CommittedDocumentProjection,
    ) => void | Promise<void>
  >();

  constructor(deps: DocumentSessionDeps<TModel>) {
    this.#persistence = deps.persistence ?? null;
    this.document = deps.ref;
    this.kindId = deps.ref.kindId;
    this.#kind = deps.kind;
    this.#vault = deps.vault;
    this.#revisions = deps.revisions;
    this.#resolveResourcePath = deps.resolveResourcePath;
    this.#onClosed = deps.onClosed;
    this.#model = undefined as TModel;
  }

  get state(): DocumentSessionState {
    return this.#state;
  }

  get canRetrySave(): boolean {
    return this.#state === 'error' && this.#retryableSaveFailure;
  }

  get dirty(): boolean {
    return this.#dirty;
  }

  get model(): TModel {
    return this.#model;
  }

  get lastError(): unknown {
    return this.#lastError;
  }

  get lastDerivedError(): unknown {
    return this.#lastDerivedError;
  }

  get lastSavedRevision(): string | null {
    return this.#lastSavedRevision;
  }

  get recoveryWarnings(): readonly DocumentRecoveryWarning[] {
    return this.#recoveryWarnings;
  }

  get openMetadata(): Readonly<Record<string, unknown>> {
    return this.#openMetadata;
  }

  get contentRevision(): string | null {
    return this.#contentRevision;
  }

  get contentSequence(): number {
    return this.#editGeneration;
  }

  get localJournalEnabled(): boolean {
    return this.#persistence !== null;
  }
  get editedSeq(): number {
    return this.#editGeneration;
  }
  get durableSeq(): number {
    return this.#durableSeq;
  }
  get publishedSeq(): number {
    return this.#publishedSeq;
  }
  get persistenceError(): unknown {
    return this.#persistenceError;
  }
  onDidChangePersistence(listener: () => void): Disposer {
    this.#persistenceListeners.add(listener);
    return {
      dispose: () => {
        this.#persistenceListeners.delete(listener);
      },
    };
  }
  #emitPersistence(): void {
    for (const listener of this.#persistenceListeners) listener();
  }

  #capture(): void {
    if (!this.#captureScheduled || this.#collector === null) return;
    this.#captureScheduled = false;
    const transaction = {
      sequence: this.#editGeneration,
      delta: this.#collector.take(),
    };
    if (this.#journal.length > 1) {
      const previous = this.#journal.pop()!;
      this.#journal.push({
        sequence: transaction.sequence,
        delta: mergeSurfaceDocumentDeltas(previous.delta, transaction.delta),
      });
    } else this.#journal.push(transaction);
  }
  #pumpJournal(): Promise<void> {
    if (this.#journalPump !== null) return this.#journalPump;
    const pumping = (async () => {
      const target = this.#journal.at(-1)?.sequence ?? this.#durableSeq;
      while (this.#journal.length > 0 && this.#durableSeq < target) {
        const transaction = this.#journal[0]!;
        await this.#persistence!.commit(
          transaction.sequence,
          transaction.delta,
        );
        this.#journal.shift();
        this.#durableSeq = transaction.sequence;
        this.#persistenceError = null;
        this.#emitPersistence();
      }
    })();
    this.#journalPump = pumping;
    void pumping.then(
      () => {
        this.#journalPump = null;
        if (this.#journal.length > 0 && this.#state !== 'closed')
          void this.#pumpJournal().catch(() => undefined);
      },
      (error) => {
        this.#journalPump = null;
        this.#persistenceError = error;
        this.#emitPersistence();
      },
    );
    return pumping;
  }

  async #flushJournal(sequence: number): Promise<void> {
    while (this.#durableSeq < sequence) await this.#pumpJournal();
  }

  async open(): Promise<void> {
    if (this.#state !== 'closed') {
      return;
    }
    this.#retryableSaveFailure = false;
    this.#closingPromise = null;
    this.#setState('opening');
    const generation = ++this.#decodeGeneration;
    const isCurrent = () =>
      this.#state === 'opening' && this.#decodeGeneration === generation;
    try {
      const path = this.#resourcePath();
      let data = await this.#vault.read(path);
      let recovered = false;
      let publicationConflict = false;
      if (this.#persistence !== null) {
        const local = await this.#persistence.open(data);
        if (!isCurrent()) return;
        this.#editGeneration = Math.max(this.#editGeneration, local.sequence);
        this.#durableSeq = local.sequence;
        this.#publishedSeq = local.publishedSequence;
        this.#publishedChecksum = local.baseChecksum;
        publicationConflict = local.conflict === true;
        recovered = local.recoveredData !== undefined;
        if (local.recoveredData !== undefined) data = local.recoveredData;
      }
      if (!isCurrent()) return;
      const decoded =
        this.#kind.decodeAsync === undefined
          ? this.#kind.decode(data, this.document)
          : await this.#kind.decodeAsync(data, this.document, isCurrent);
      if (decoded === null || !isCurrent()) return;
      const contentRevision = await checksumOfAsync(data);
      if (!isCurrent()) return;
      this.#collector?.dispose();
      this.#model = decoded.model;
      if (this.#persistence !== null) {
        this.#collector = new SurfaceDeltaCollector(
          this.#model,
          this.kindId === 'froglight.notebook',
          () => this.markDirty(),
        );
        this.#collector.seed();
      }
      this.#recoveryWarnings = decoded.warnings ?? [];
      this.#openMetadata = withContentRevision(
        decoded.openMetadata,
        contentRevision,
      );
      this.#contentRevision = this.#openMetadata[
        DOCUMENT_CONTENT_REVISION_KEY
      ] as string;
      this.#dirty = recovered;
      this.#lastError = publicationConflict
        ? new FroglightError(
            'CONFLICT',
            'Vault file changed; local edits are retained',
          )
        : null;
      this.#lastDerivedError = null;
      this.#setState('open');
    } catch (error) {
      if (!isCurrent()) return;
      this.#lastError = error;
      this.#setState('error');
      throw error;
    }
  }

  markDirty(): void {
    if (
      this.#state !== 'saving' &&
      this.#state !== 'closing' &&
      !(this.#persistence !== null && this.#state === 'error')
    )
      this.#assertSaveable();
    if (this.#state === 'error' && this.#persistence !== null)
      this.#retryableSaveFailure = true;
    this.#editGeneration += 1;
    if (this.#persistence !== null && !this.#captureScheduled) {
      this.#captureScheduled = true;
      void drainSurfaceDocumentWork(this.#model)
        .then(() => {
          this.#capture();
          if (this.#journal.length > 0)
            void this.#pumpJournal().catch(() => undefined);
        })
        .catch((error) => {
          this.#captureScheduled = false;
          this.#persistenceError = error;
          this.#emitPersistence();
        });
    }
    if (this.#persistence !== null) this.#emitPersistence();
    if (!this.#dirty) {
      this.#dirty = true;
      this.#emitDirty();
    }
    for (const listener of [...this.#contentListeners]) listener();
  }

  async save(options?: {
    readonly recordRevision?: boolean;
  }): Promise<SaveResult> {
    const requestedSequence = this.#editGeneration;
    if (this.#pendingSave !== null) {
      const result = await this.#pendingSave;
      if (!result.committed || this.#publishedSeq >= requestedSequence)
        return result;
      return this.save(options);
    }
    this.#assertSaveable();
    const pending = this.#saveSnapshot(options?.recordRevision !== false);
    this.#pendingSave = pending;
    try {
      return await pending;
    } finally {
      this.#pendingSave = null;
    }
  }

  async #saveSnapshot(recordRevision: boolean): Promise<SaveResult> {
    let generation = this.#editGeneration;
    this.#retryableSaveFailure = false;
    this.#setState('saving');
    const result: SaveResult = {
      committed: false,
      revision: null,
      error: null,
      derivedError: null,
    };
    let data: Uint8Array;
    let projection: CommittedDocumentProjection | undefined;
    let projectionError: unknown = null;
    try {
      retrySurfaceDocumentWork(this.#model);
      await drainSurfaceDocumentWork(this.#model);
      let snapshotModel: TModel | undefined;
      if (this.#persistence !== null) {
        this.#capture();
        // Drain the captured transaction prefix. Edits arriving while storage
        // runs remain journalled independently; the worker snapshots its own
        // immutable version in FIFO order.
        await this.#flushJournal(this.#editGeneration);
        generation = this.#durableSeq;
        const snapshot = await this.#persistence.snapshot(generation);
        generation = snapshot.sequence;
        data = snapshot.data;
        projection = snapshot.projection;
        this.#savingChecksum = snapshot.checksum;
      } else {
        generation = this.#editGeneration;
        snapshotModel = cloneSaveModel(this.#model);
        const encoded =
          this.#kind.encodeAsync === undefined
            ? this.#kind.encode(snapshotModel, this.document)
            : await this.#kind.encodeAsync(
                snapshotModel,
                this.document,
                () => this.#state === 'saving',
              );
        if (encoded === null)
          throw new FroglightError('ABORTED', 'save cancelled');
        data = encoded;
        try {
          projection = this.#kind.projectCommitted?.(
            snapshotModel,
            this.document,
          );
        } catch (error) {
          projectionError = error;
        }
      }
      if (this.#state !== 'saving')
        throw new FroglightError('ABORTED', 'save cancelled');
    } catch (error) {
      if (this.#state !== 'saving') {
        result.error = new FroglightError(
          'ABORTED',
          'save was cancelled by session close',
        );
        return result;
      }
      result.error = error;
      this.#lastError = error;
      this.#retryableSaveFailure =
        !isFroglightError(error) ||
        ['IO', 'QUOTA_EXCEEDED', 'ABORTED'].includes(error.code);
      this.#setState('error');
      return result;
    }
    try {
      const path = this.#resourcePath();
      try {
        if (
          this.#persistence !== null &&
          this.#vault.writeIfUnchanged === undefined
        ) {
          const current = await this.#vault.read(path);
          if ((await checksumOfAsync(current)) !== this.#publishedChecksum)
            throw new FroglightError(
              'CONFLICT',
              'Vault file changed; local edits are retained',
            );
        }
        const writing =
          this.#persistence !== null &&
          this.#vault.writeIfUnchanged !== undefined
            ? this.#vault.writeIfUnchanged(path, data, this.#publishedChecksum!)
            : this.#vault.write(path, data);
        this.#pendingWrite = writing;
        try {
          await writing;
        } finally {
          if (this.#pendingWrite === writing) this.#pendingWrite = null;
        }
      } catch (error) {
        // Untyped storage failures are used by portable/test providers. Typed
        // conflicts and other semantic failures require explicit recovery, not
        // a blind retry against a possibly changed base/resource.
        this.#retryableSaveFailure =
          !isFroglightError(error) ||
          ['IO', 'QUOTA_EXCEEDED', 'ABORTED'].includes(error.code);
        throw error;
      }
      result.committed = true;
      // The saved bytes are the new canonical content: refresh the
      // revision token from the bytes already in hand (no rescan later).
      this.#contentRevision =
        this.#savingChecksum ?? (await checksumOfAsync(data));
      this.#savingChecksum = null;
      this.#publishedSeq = generation;
      this.#publishedChecksum = this.#contentRevision;
      if (this.#persistence === null) this.#durableSeq = generation;
      else {
        try {
          await this.#persistence.published(generation, this.#contentRevision);
        } catch (error) {
          this.#persistenceError = error;
          result.derivedError = error;
        }
      }
      this.#emitPersistence();
      this.#openMetadata = {
        ...this.#openMetadata,
        [DOCUMENT_CONTENT_REVISION_KEY]: this.#contentRevision,
      };
      if (this.#state === 'saving') {
        const wasDirty = this.#dirty;
        this.#dirty = this.#editGeneration !== generation;
        if (wasDirty !== this.#dirty) this.#emitDirty();
        this.#lastError = null;
        result.derivedError = projectionError ?? result.derivedError;
        this.#lastDerivedError = result.derivedError;
      }
    } catch (error) {
      result.error = error;
      if (this.#state === 'saving') {
        this.#lastError = error;
        this.#setState('error');
      }
      return result;
    }

    // Post-commit: persistent revision (best-effort, never fails the save).
    if (recordRevision && this.#revisions !== null) {
      try {
        const revision = await this.#revisions.recordRevision({
          documentId: this.document.documentId,
          sourceResourceId: this.document.location.resourceId,
          data,
          checksum: this.#contentRevision ?? undefined,
        });
        result.revision = revision;
        this.#lastSavedRevision = revision.revisionId;
      } catch (error) {
        result.derivedError = error;
        this.#lastDerivedError = error;
      }
    }

    // Post-commit: listeners; their errors are derived, never fatal.
    for (const listener of this.#state === 'saving'
      ? [...this.#postCommitListeners]
      : []) {
      try {
        await listener(result, data, projection);
      } catch (error) {
        result.derivedError = error;
        this.#lastDerivedError = error;
      }
    }

    if (this.#state === 'saving') this.#setState('open');
    return result;
  }

  async resolvePublicationConflict(): Promise<SaveResult> {
    if (
      this.#persistence === null ||
      !isFroglightError(this.#lastError) ||
      this.#lastError.code !== 'CONFLICT'
    ) {
      throw new FroglightError(
        'CONFLICT',
        'No publication conflict to resolve',
      );
    }
    if (this.#pendingSave !== null) await this.#pendingSave;
    const checksum = await checksumOfAsync(
      await this.#vault.read(this.#resourcePath()),
    );
    if (this.#state === 'closed' || this.#state === 'closing')
      throw new FroglightError('ABORTED', 'Session closed');
    await this.#persistence.rebase(checksum);
    this.#publishedChecksum = checksum;
    this.#lastError = null;
    this.#setState('open');
    return this.save();
  }

  async reload(): Promise<void> {
    this.#assertOpen();
    this.#retryableSaveFailure = false;
    this.#setState('opening');
    const generation = ++this.#decodeGeneration;
    const isCurrent = () =>
      this.#state === 'opening' && this.#decodeGeneration === generation;
    try {
      const path = this.#resourcePath();
      let data = await this.#vault.read(path);
      let recovered = false;
      let publicationConflict = false;
      if (this.#persistence !== null) {
        this.#capture();
        await this.#flushJournal(this.#editGeneration);
        const local = await this.#persistence.reset(data, this.#editGeneration);
        if (!isCurrent()) return;
        this.#editGeneration = Math.max(this.#editGeneration, local.sequence);
        this.#durableSeq = local.sequence;
        this.#publishedSeq = local.publishedSequence;
        this.#publishedChecksum = local.baseChecksum;
        publicationConflict = local.conflict === true;
        recovered = local.recoveredData !== undefined;
        if (local.recoveredData !== undefined) data = local.recoveredData;
      }
      if (!isCurrent()) return;
      const decoded =
        this.#kind.decodeAsync === undefined
          ? this.#kind.decode(data, this.document)
          : await this.#kind.decodeAsync(data, this.document, isCurrent);
      if (decoded === null || !isCurrent()) return;
      const contentRevision = await checksumOfAsync(data);
      if (!isCurrent()) return;
      this.#collector?.dispose();
      this.#model = decoded.model;
      if (this.#persistence !== null) {
        this.#collector = new SurfaceDeltaCollector(
          this.#model,
          this.kindId === 'froglight.notebook',
          () => this.markDirty(),
        );
        this.#collector.seed();
      }
      this.#recoveryWarnings = decoded.warnings ?? [];
      this.#openMetadata = withContentRevision(
        decoded.openMetadata,
        contentRevision,
      );
      this.#contentRevision = this.#openMetadata[
        DOCUMENT_CONTENT_REVISION_KEY
      ] as string;
      this.#dirty = recovered;
      this.#lastError = publicationConflict
        ? new FroglightError(
            'CONFLICT',
            'Vault file changed; local edits are retained',
          )
        : null;
      this.#setState('open');
    } catch (error) {
      if (!isCurrent()) return;
      this.#lastError = error;
      this.#setState('error');
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#state === 'closed') {
      return;
    }
    if (this.#closingPromise !== null) return this.#closingPromise;
    this.#retryableSaveFailure = false;
    this.#setState('closing');
    // A write that entered the vault before close must finish before owners
    // move or remove the canonical resource. Encoding still observes closing
    // and exits without starting a new write.
    const pendingWrite = this.#pendingWrite;
    this.#closingPromise = (async () => {
      await drainSurfaceDocumentWork(this.#model);
      this.#capture();
      const closingSequence = this.#editGeneration;
      await pendingWrite?.catch(() => undefined);
      if (this.#persistence !== null) await this.#flushJournal(closingSequence);
      this.#collector?.dispose();
      this.#persistence?.dispose();
      this.#setState('closed');
      this.#dirty = false;
      this.#onClosed?.();
    })().catch((error) => {
      this.#closingPromise = null;
      this.#lastError = error;
      this.#retryableSaveFailure = true;
      this.#setState('error');
      throw error;
    });
    return this.#closingPromise;
  }

  onDidChangeContent(listener: () => void): Disposer {
    this.#contentListeners.add(listener);
    return {
      dispose: () => {
        this.#contentListeners.delete(listener);
      },
    };
  }

  onDidChangeDirty(listener: (dirty: boolean) => void): Disposer {
    this.#dirtyListeners.add(listener);
    return {
      dispose: () => {
        this.#dirtyListeners.delete(listener);
      },
    };
  }

  #emitDirty(): void {
    for (const listener of [...this.#dirtyListeners]) {
      listener(this.#dirty);
    }
  }

  onStateChange(listener: (state: DocumentSessionState) => void): Disposer {
    this.#stateListeners.add(listener);
    return {
      dispose: () => {
        this.#stateListeners.delete(listener);
      },
    };
  }

  onPostCommit(
    listener: (
      result: SaveResult,
      committedData?: Uint8Array,
      projection?: CommittedDocumentProjection,
    ) => void | Promise<void>,
  ): Disposer {
    this.#postCommitListeners.add(listener);
    return {
      dispose: () => {
        this.#postCommitListeners.delete(listener);
      },
    };
  }

  #resourcePath(): WorkspacePath {
    const path = this.#resolveResourcePath(this.document.location.resourceId);
    if (path === undefined) {
      throw new FroglightError(
        'UNKNOWN_RESOURCE',
        `no resource with id ${this.document.location.resourceId}`,
      );
    }
    return path;
  }

  #setState(state: DocumentSessionState): void {
    this.#state = state;
    for (const listener of [...this.#stateListeners]) {
      listener(state);
    }
  }

  #assertSaveable(): void {
    if (this.#state === 'error' && this.#retryableSaveFailure) return;
    this.#assertOpen();
  }

  #assertOpen(): void {
    if (this.#state !== 'open') {
      throw new FroglightError(
        'SESSION_BUSY',
        `session is not open (state: ${this.#state})`,
      );
    }
  }
}

/**
 * Merge the session-owned canonical content revision into decode-provided
 * open metadata. The revision is computed ONCE from the bytes already in
 * hand — document-kind decoders must read this token instead of
 * rescanning the whole buffer with their own checksum pass. A kind that
 * (legacy) already sets the key keeps its value; the session never
 * overrides an explicit kind-provided revision.
 */
function withContentRevision(
  decoded: Readonly<Record<string, unknown>> | undefined,
  revision: string,
): Readonly<Record<string, unknown>> {
  const base = decoded ?? {};
  if (typeof base[DOCUMENT_CONTENT_REVISION_KEY] === 'string') return base;
  return { ...base, [DOCUMENT_CONTENT_REVISION_KEY]: revision };
}

/** Copy codec data once, including optional fields and binary source models. */
function cloneSaveModel<T>(value: T): T {
  if (value instanceof Uint8Array) return value.slice() as T;
  if (Array.isArray(value))
    return value.map((item) => cloneSaveModel(item)) as T;
  if (typeof value === 'object' && value !== null) {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null)
      throw new Error('Document model is not snapshot data');
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneSaveModel(item)]),
    ) as T;
  }
  if (typeof value === 'function' || typeof value === 'symbol')
    throw new Error('Document model is not snapshot data');
  return value;
}
