import type { DocumentId } from './identity.js';
import type { DocumentRegistry } from './documents.js';
import type { DocumentSession } from './session.js';
import type { WorkspaceService } from './workspace.js';

export type DocumentTitleUnavailableReason =
  | 'unsupported-kind'
  | 'document-unavailable'
  | 'open-document'
  | 'dirty-document'
  | 'invalid-title';

export class DocumentTitleUnavailableError extends Error {
  constructor(
    readonly reason: DocumentTitleUnavailableReason,
    message: string,
  ) {
    super(message);
    this.name = 'DocumentTitleUnavailableError';
  }
}

export interface DocumentTitleUpdateResult {
  /** True once canonical bytes contain the new title. */
  readonly committed: boolean;
  /** Exact canonical write failure. The operation session retains the edit. */
  readonly error: unknown;
  /** Projection/revision failure after a successful canonical write. */
  readonly derivedError: unknown;
  /** Retry the retained edit without reopening or decoding the document. */
  retry(): Promise<DocumentTitleUpdateResult>;
  /** Close the retained operation session and discard its uncommitted edit. */
  discard(): Promise<void>;
}

function retainedTitleOperation(session: DocumentSession): {
  retry(): Promise<DocumentTitleUpdateResult>;
  discard(): Promise<void>;
} {
  let closed = false;
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <Result>(operation: () => Promise<Result>) => {
    const running = tail.then(operation, operation);
    tail = running.catch(() => undefined);
    return running;
  };
  const discard = () =>
    serialize(async () => {
      if (closed) return;
      closed = true;
      await session.close();
    });
  const retry = () =>
    serialize(async () => {
      if (closed) throw new Error('This document title edit was discarded.');
      const save = await session.save();
      if (save.committed) {
        closed = true;
        await session.close();
      }
      return {
        committed: save.committed,
        error: save.error,
        derivedError: save.derivedError,
        retry,
        discard,
      };
    });
  return { retry, discard };
}

/**
 * Update the provider-owned canonical title of a closed document.
 *
 * Open documents are deliberately refused: their mounted provider owns any
 * buffered input and undo history, so an out-of-band model mutation could be
 * overwritten by the next editor change. The caller can focus/close the tab
 * and retry. A session created here remains open only after a failed write so
 * its retry closure can commit the same in-memory edit without data loss.
 */
export async function updateDocumentTitle(input: {
  readonly workspace: WorkspaceService;
  readonly documents: DocumentRegistry;
  readonly documentId: DocumentId;
  readonly title: string;
}): Promise<DocumentTitleUpdateResult> {
  const title = input.title.trim();
  if (title === '')
    throw new DocumentTitleUnavailableError(
      'invalid-title',
      'Document title cannot be empty.',
    );
  const ref = input.workspace
    .listDocuments()
    .find((item) => item.documentId === input.documentId);
  if (!ref)
    throw new DocumentTitleUnavailableError(
      'document-unavailable',
      'Document unavailable.',
    );
  const existing = input.workspace.getOpenDocument(ref.documentId);
  if (existing)
    throw new DocumentTitleUnavailableError(
      existing.dirty ? 'dirty-document' : 'open-document',
      existing.dirty
        ? 'This document has unsaved edits. Save and close its tab before changing its title.'
        : 'Close this document before changing its title.',
    );
  const kind = input.documents.get(ref.kindId);
  if (!kind.documentTitle)
    throw new DocumentTitleUnavailableError(
      'unsupported-kind',
      'This document type does not support title editing.',
    );
  const session = await input.workspace.openDocument(ref.documentId);
  try {
    kind.documentTitle.write(session.model, title, ref);
    session.markDirty();
    return await retainedTitleOperation(session).retry();
  } catch (error) {
    await session.close();
    throw error;
  }
}
