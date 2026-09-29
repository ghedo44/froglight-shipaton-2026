/**
 * Starter content for freshly created LaTeX documents.
 *
 * The title is user-provided free text, so characters that would break TeX
 * grouping or commands are stripped before splicing into the template.
 */

import { latexModel, type LaTeXModel } from './model.js';

export function latexStarterTemplate(title: string): LaTeXModel {
  const safeTitle = title.replace(/[\\{}%$&#^_~]/g, '').trim();
  const heading = safeTitle === '' ? 'Untitled' : safeTitle;
  return latexModel(
    [
      '\\documentclass{article}',
      `\\title{${heading}}`,
      '\\begin{document}',
      '\\maketitle',
      `\\section{${heading}}`,
      '',
      '\\end{document}',
    ].join('\n') + '\n',
  );
}
