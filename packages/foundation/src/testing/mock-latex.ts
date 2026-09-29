/**
 * Deterministic mock `LaTeXProvider`.
 *
 * Proves document open/save/reopen and provider replacement without any
 * renderer, DOM, or LaTeX.js dependency — the same discipline as
 * `MockPdfProvider`.
 */

import { latexError, type LaTeXDiagnostic, type LaTeXDocumentHandle, type LaTeXProvider, type LaTeXRenderResult, type LaTeXSourceResolver } from '../latex/contracts.js';

export interface MockLaTeXFixture {
  readonly html?: string;
  readonly diagnostics?: readonly LaTeXDiagnostic[];
  /** Fail `open` with this stable error code. */
  readonly openErrorCode?: 'LATEX_PARSE_ERROR' | 'LATEX_RESOURCE_LIMIT' | 'LATEX_PROVIDER_UNAVAILABLE';
  /** Fail `render` with this stable error code. */
  readonly renderErrorCode?: 'LATEX_PARSE_ERROR' | 'LATEX_RESOURCE_LIMIT' | 'LATEX_RENDER_CANCELLED';
  /** Cross an async boundary on render so tests can close/abort deterministically. */
  readonly renderDelayMillis?: number;
}

export class MockLaTeXProvider implements LaTeXProvider {
  readonly #fixture: MockLaTeXFixture;
  #activeHandles = 0;

  constructor(fixture: MockLaTeXFixture = {}) {
    this.#fixture = fixture;
  }

  activeHandleCountForTest(): number {
    return this.#activeHandles;
  }

  async open(input: {
    readonly entry: string;
    readonly resolve: LaTeXSourceResolver;
    readonly signal?: AbortSignal;
  }): Promise<LaTeXDocumentHandle> {
    if (input.signal?.aborted === true) {
      throw latexError('LATEX_RENDER_CANCELLED', 'open was cancelled');
    }
    if (this.#fixture.openErrorCode !== undefined) {
      throw latexError(this.#fixture.openErrorCode, 'mock provider open failure');
    }
    this.#activeHandles += 1;
    let closed = false;
    const fixture = this.#fixture;
    return {
      render: async (request?: { readonly signal?: AbortSignal }): Promise<LaTeXRenderResult> => {
        if (closed) throw latexError('LATEX_RENDER_CANCELLED', 'handle is closed');
        if (request?.signal?.aborted === true) {
          throw latexError('LATEX_RENDER_CANCELLED', 'render was cancelled');
        }
        if (fixture.renderErrorCode !== undefined) {
          throw latexError(fixture.renderErrorCode, 'mock provider render failure');
        }
        // Always cross an async boundary for deterministic close/abort tests.
        await Promise.resolve();
        if (closed) throw latexError('LATEX_RENDER_CANCELLED', 'handle is closed');
        return {
          html: fixture.html ?? '<!DOCTYPE html><html><body><p>mock</p></body></html>',
          diagnostics: fixture.diagnostics ?? [],
        };
      },
      close: async () => {
        if (closed) return;
        closed = true;
        this.#activeHandles -= 1;
      },
    };
  }
}
