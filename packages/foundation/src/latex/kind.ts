/**
 * LaTeX document kind `froglight.latex`.
 *
 * Canonical resources are UTF-8 `.tex` plain text; recognition additionally
 * accepts `.ltx`/`.latex` on import. Host- and editor-free: no CodeMirror,
 * DOM, or provider types.
 */

import { documentKindId, type DocumentKindId } from '../identity.js';
import type { DocumentKindDescriptor } from '../documents.js';
import type { LaTeXModel } from './model.js';
import { decodeLaTeX, encodeLaTeX } from './codec.js';
import { latexSearchAnchors, latexSearchText } from './search.js';
import { latexStarterTemplate } from './template.js';

export const latexKindId: DocumentKindId = documentKindId('froglight.latex');

const RECOGNIZED_EXTENSIONS = ['.tex', '.ltx', '.latex'];

export function isLaTeXPath(path: string): boolean {
  const lower = path.toLocaleLowerCase('en-US');
  return RECOGNIZED_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

export const latexKind: DocumentKindDescriptor<LaTeXModel> = {
  id: latexKindId,
  importExtensions: RECOGNIZED_EXTENSIONS,
  creation: {
    label: 'LaTeX',
    extension: '.tex',
    createInitialModel: latexStarterTemplate,
  },
  cloneTemplate: (model) => ({ ...model }),
  presentationModes: ['edit', 'split', 'reading'],
  recognize: (kindId) =>
    kindId === latexKindId ||
    (typeof kindId === 'string' && isLaTeXPath(kindId)),
  decode: (data, ref) => decodeLaTeX(data, ref),
  encode: (model, ref) => encodeLaTeX(model, ref),
  searchText: (model) => latexSearchText(model.raw),
  searchAnchors: (model) => latexSearchAnchors(model.raw),
};
