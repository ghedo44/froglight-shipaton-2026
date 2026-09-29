import {
  blockPageKind,
  databaseKind,
  inkPageKind,
  latexKind,
  markdownKind,
  notebookKind,
  whiteboardKind,
} from '@froglight/foundation';
import { noteKindOption } from '../note-kinds.js';

/** Test input for picker rendering; production choices come from registries. */
export const TEST_NOTE_KINDS = [
  markdownKind,
  blockPageKind,
  inkPageKind,
  whiteboardKind,
  notebookKind,
  latexKind,
  databaseKind,
].map((kind, index) => ({
  ...noteKindOption(kind)!,
  icon: ['markdown', 'blockpage', 'ink', 'canvas', 'notebook', 'file-latex', 'database'][index]!,
}));
