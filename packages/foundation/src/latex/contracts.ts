/**
 * LaTeX render-provider contracts.
 *
 * One replaceable render capability: providers turn entry source plus
 * resolver inputs into preview HTML and diagnostics. Compile-to-PDF is a
 * future separate capability token (deliberately absent here). Provider
 * library types never cross this boundary; Froglight owns the resolver,
 * the preview host, and the security boundary.
 */

import { FroglightError } from '../errors.js';

/** Baseline limits; configuration-revisable.*/
export const LATEX_LIMITS = {
  maxIncludeDepth: 16,
  maxFileBytes: 1024 * 1024,
  maxFlattenedBytes: 4 * 1024 * 1024,
  maxAssetBytes: 16 * 1024 * 1024,
  renderTimeoutMillis: 5_000,
  maxActiveRendersPerDocument: 1,
} as const;

export type LaTeXErrorCode =
  | 'LATEX_PARSE_ERROR'
  | 'LATEX_UNSUPPORTED_COMMAND'
  | 'LATEX_UNSUPPORTED_PACKAGE'
  | 'LATEX_RESOLVE_DENIED'
  | 'LATEX_RESOLVE_MISSING'
  | 'LATEX_CYCLE'
  | 'LATEX_RESOURCE_LIMIT'
  | 'LATEX_RENDER_CANCELLED'
  | 'LATEX_PROVIDER_UNAVAILABLE';

/** Stable, user-visible provider/resolver diagnostics (not canonical data). */
export interface LaTeXDiagnostic {
  readonly code: LaTeXErrorCode | 'LATEX_INFO';
  readonly message: string;
  /** Workspace-relative path of the source file, when known. */
  readonly path?: string;
  /** Zero-based source line within `path`, when known. */
  readonly line?: number;
}

export function latexError(
  code: LaTeXErrorCode,
  message: string,
): FroglightError {
  return new FroglightError(code, message);
}

/**
 * Froglight-owned resolution surface handed to providers.
 * Implementations enforce workspace scoping, traversal rejection, and size
 * limits inside one auditable boundary; providers never see host paths.
 */
export interface LaTeXSourceResolver {
  /** Read a workspace-relative text file as UTF-8 (`.tex`, `.bib`, ...). */
  readFile(path: string): Promise<string>;
  /**
   * Resolve a workspace-relative asset (image) to a URL loadable inside the
   * preview host (e.g. a blob: URL). Denials reject with `LATEX_RESOLVE_DENIED`.
   */
  assetUrl(path: string): Promise<string>;
}

/** Mapping from one flattened output line back to its source provenance. */
export interface LaTeXSourceMapping {
  /** Zero-based line in the flattened source. */
  readonly outputLine: number;
  /** Workspace-relative source path. */
  readonly path: string;
  /** Zero-based line within that source file. */
  readonly sourceLine: number;
}

export interface LaTeXRenderResult {
  /**
   * Complete HTML document serialization for the sandboxed preview host.
   * Providers return a string; Froglight owns mounting, sandboxing, and CSP.
   */
  readonly html: string;
  readonly diagnostics: readonly LaTeXDiagnostic[];
  /** Reserved for future position-aware providers; absent means unsupported. */
  readonly sourceMap?: readonly LaTeXSourceMapping[];
}

export interface LaTeXDocumentHandle {
  render(request?: { readonly signal?: AbortSignal }): Promise<LaTeXRenderResult>;
  close(): Promise<void>;
}

export interface LaTeXProvider {
  open(input: {
    /** Entry document source text (the session's canonical model). */
    readonly entry: string;
    readonly resolve: LaTeXSourceResolver;
    readonly signal?: AbortSignal;
  }): Promise<LaTeXDocumentHandle>;
}
