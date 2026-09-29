/**
 * LaTeX document model.
 *
 * The canonical model is raw UTF-8 source text so round-tripping is
 * byte-identical and `.tex` bytes stay portable plain text independent of
 * any preview provider.
 */

export interface LaTeXModel {
  readonly raw: string;
}

export function latexModel(raw: string): LaTeXModel {
  return { raw };
}
