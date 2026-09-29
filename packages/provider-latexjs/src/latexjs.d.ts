/**
 * Ambient module declaration for `latex.js` (0.12.6).
 *
 * The published package ships no TypeScript declarations. Only the surface
 * this adapter uses is declared; everything else stays inside the adapter.
 */
declare module 'latex.js' {
  export interface LatexJsParserLocation {
    readonly start?: { readonly line?: number; readonly column?: number };
    readonly end?: { readonly line?: number; readonly column?: number };
  }

  export interface LatexJsGeneratorOptions {
    readonly documentClass?: string;
    readonly CustomMacros?: unknown;
    readonly hyphenate?: boolean;
    readonly styles?: readonly string[];
  }

  export class HtmlGenerator {
    constructor(options?: LatexJsGeneratorOptions);
    /** Full standalone HTML document; `baseURL` anchors scripts/stylesheets. */
    htmlDocument(baseURL?: string): Document;
    /** Reset before generating a second document with the same instance. */
    reset(): void;
    documentTitle(): string;
  }

  export interface LatexJsParseError extends Error {
    readonly name: string;
    readonly location?: LatexJsParserLocation;
  }

  export function parse(
    latex: string,
    options: { generator: HtmlGenerator },
  ): HtmlGenerator;

  export const SyntaxError: unknown;
}
