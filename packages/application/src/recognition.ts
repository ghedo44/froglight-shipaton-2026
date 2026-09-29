/**
 * Explicit handwriting recognition flow: collects stroke
 * queries from the notebook's canonical model, runs the profile-bound
 * recognizer, and merges derived lines into search indexing. Never
 * mutates canonical bytes; results vanish when the derived store clears
 * or the process restarts.
 */

import type { FroglightApp } from './index.js';
import {
  HandwritingAwareSearchService,
  notebookHandwritingQueries,
  notebookKindId,
  projectNotebookForSearch,
  type DocumentId,
  type NotebookModel,
  type RecognizedHandwritingLine,
} from '@froglight/foundation';

export interface RunRecognitionResult {
  /** Number of recognized lines merged into derived indexing. */
  readonly lines: number;
}

/**
 * Run handwriting recognition for one notebook document using the app's
 * bound recognizer. Throws when no recognizer is bound, the document is
 * not a notebook, or search is not recognition-aware.
 */
export async function runNotebookHandwritingRecognition(
  app: FroglightApp,
  documentId: string | DocumentId,
): Promise<RunRecognitionResult> {
  const recognizer = app.getHandwritingRecognizer();
  if (recognizer === null) {
    throw new Error('no handwriting recognizer is bound to this profile');
  }
  const workspace = app.getWorkspace();
  if (workspace === null) throw new Error('no active workspace');

  const identity = workspace
    .listDocuments()
    .find((record) => String(record.documentId) === String(documentId));
  if (identity === undefined || identity.kindId !== notebookKindId) {
    throw new Error(`document ${String(documentId)} is not a notebook`);
  }

  const session = await workspace.openDocument<NotebookModel>(identity.documentId);
  try {
    const queries = notebookHandwritingQueries(session.model);
    const recognized = await recognizer.recognize(queries);

    const search = app.getSearch();
    if (!(search instanceof HandwritingAwareSearchService)) {
      throw new Error('search service does not support derived handwriting projections');
    }
    const lines = recognized as readonly RecognizedHandwritingLine[];
    // Rebuild first so stale derived indexes and prior recognition results are
    // cleared, then overlay this explicit run back onto the document's base
    // projection without another clear.
    await workspace.rebuildDerivedState();
    search.setHandwriting(identity.documentId, lines);
    const projection = projectNotebookForSearch(session.model, '');
    search.indexDocument(
      identity.documentId,
      session.document.location,
      projection.body,
      projection.anchors,
    );
    return { lines: lines.length };
  } finally {
    await session.close();
  }
}
