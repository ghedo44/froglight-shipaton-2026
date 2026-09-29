import {
  generateDocumentId,
  generateResourceId,
  type Disposer,
  type DocumentEditorHandle,
  type DocumentEditorRegistry,
  type DocumentKindId,
  type DocumentRef,
  type DocumentSession,
  type DocumentSessionState,
  type SaveResult,
} from '@froglight/foundation';
import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import styles from './DatabaseView.module.css';

export interface ProviderTemplateEditorRef {
  readonly model: unknown;
  flush(): void;
}

class TemplateDocumentSession implements DocumentSession {
  readonly document: DocumentRef;
  readonly kindId: DocumentKindId;
  state: DocumentSessionState = 'open';
  dirty = false;
  readonly canRetrySave = false;
  readonly lastError = null;
  readonly lastDerivedError = null;
  readonly lastSavedRevision = null;
  readonly recoveryWarnings = [];
  readonly openMetadata = { 'document.editingContext': 'template' };
  readonly contentRevision = null;
  contentSequence = 0;
  readonly #stateListeners = new Set<(state: DocumentSessionState) => void>();
  readonly #dirtyListeners = new Set<(dirty: boolean) => void>();
  readonly #contentListeners = new Set<() => void>();
  readonly #commitListeners = new Set<
    (result: SaveResult) => void | Promise<void>
  >();

  constructor(
    kindId: DocumentKindId,
    readonly model: unknown,
    private readonly onDirty: () => void,
  ) {
    this.kindId = kindId;
    this.document = {
      documentId: generateDocumentId(),
      kindId,
      location: { resourceId: generateResourceId() },
    };
  }

  open(): Promise<void> {
    return Promise.resolve();
  }

  markDirty(): void {
    const changed = !this.dirty;
    this.dirty = true;
    this.contentSequence += 1;
    if (changed) this.#dirtyListeners.forEach((listener) => listener(true));
    this.#contentListeners.forEach((listener) => listener());
    this.onDirty();
  }

  async save(): Promise<SaveResult> {
    const result: SaveResult = {
      committed: true,
      revision: null,
      error: null,
      derivedError: null,
    };
    if (this.dirty) {
      this.dirty = false;
      this.#dirtyListeners.forEach((listener) => listener(false));
    }
    for (const listener of this.#commitListeners) await listener(result);
    return result;
  }

  async reload(): Promise<void> {
    throw new Error('Template drafts cannot reload from a workspace resource');
  }

  async close(): Promise<void> {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.#stateListeners.forEach((listener) => listener(this.state));
    this.#stateListeners.clear();
    this.#dirtyListeners.clear();
    this.#contentListeners.clear();
    this.#commitListeners.clear();
  }

  onStateChange(listener: (state: DocumentSessionState) => void): Disposer {
    return subscription(this.#stateListeners, listener);
  }

  onDidChangeDirty(listener: (dirty: boolean) => void): Disposer {
    return subscription(this.#dirtyListeners, listener);
  }

  onDidChangeContent(listener: () => void): Disposer {
    return subscription(this.#contentListeners, listener);
  }

  onPostCommit(
    listener: (result: SaveResult) => void | Promise<void>,
  ): Disposer {
    return subscription(this.#commitListeners, listener);
  }
}

function subscription<T>(listeners: Set<T>, listener: T): Disposer {
  listeners.add(listener);
  return { dispose: () => listeners.delete(listener) };
}

export function ProviderTemplateEditor({
  editors,
  kindId,
  templateId,
  model,
  editorRef,
  onAvailabilityChange,
  onDirty,
}: {
  editors: DocumentEditorRegistry;
  kindId: DocumentKindId;
  templateId: string;
  model: unknown;
  editorRef: MutableRefObject<ProviderTemplateEditorRef | null>;
  onAvailabilityChange(available: boolean): void;
  onDirty(): void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [registryRevision, setRegistryRevision] = useState(0);
  const [failure, setFailure] = useState('');

  useEffect(
    () =>
      editors.onDidChange((kindIds) => {
        if (kindIds.includes(kindId)) setRegistryRevision((value) => value + 1);
      }).dispose,
    [editors, kindId],
  );

  useEffect(() => {
    const host = hostRef.current;
    const provider = editors.get(kindId);
    if (!host || !provider) {
      editorRef.current = null;
      onAvailabilityChange(false);
      return;
    }
    let cancelled = false;
    let session: TemplateDocumentSession | null = null;
    let handle: DocumentEditorHandle | null = null;
    onAvailabilityChange(false);
    // Several providers synchronously commit a nested React root. Deferring
    // leaves this component's effect commit before their flushSync runs.
    queueMicrotask(() => {
      if (cancelled) return;
      session = new TemplateDocumentSession(kindId, model, onDirty);
      try {
        handle = provider.createEditor({
          session,
          parent: host,
          context: { kind: 'template', templateId },
        });
        editorRef.current = {
          model: session.model,
          flush: () => handle?.flush?.(),
        };
        setFailure('');
        onAvailabilityChange(true);
      } catch (error) {
        setFailure(error instanceof Error ? error.message : String(error));
        editorRef.current = null;
        onAvailabilityChange(false);
      }
    });
    return () => {
      cancelled = true;
      editorRef.current = null;
      const mountedHandle = handle;
      const mountedSession = session;
      // Provider teardown may synchronously unmount its nested React root.
      // Leave the parent root's cleanup commit before doing that work.
      queueMicrotask(() => {
        mountedHandle?.destroy();
        void mountedSession?.close();
      });
    };
  }, [
    editorRef,
    editors,
    kindId,
    model,
    onAvailabilityChange,
    onDirty,
    registryRevision,
    templateId,
  ]);

  const available = editors.get(kindId) !== null;
  return (
    <section className={styles.templateContent} aria-label="Template content">
      <div className={styles.templateSectionHeading}>
        <div>
          <strong>Document content</strong>
          <small>
            Edited by the document provider and saved in this template.
          </small>
        </div>
        {!available && <span>Editor unavailable</span>}
      </div>
      {failure && (
        <p className={styles.templateError} role="alert">
          The document editor could not open: {failure}
        </p>
      )}
      {!available && !failure && (
        <p className={styles.templateNotice} role="status">
          Install or enable an editor for this document kind to author its
          template content.
        </p>
      )}
      <div
        ref={hostRef}
        className={styles.templateProviderHost}
        hidden={!available || Boolean(failure)}
      />
    </section>
  );
}
