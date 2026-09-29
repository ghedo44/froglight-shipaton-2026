import { FroglightError } from '../errors.js';
import {
  PDF_LIMITS,
  normalizePdfPageGeometry,
  type PdfDocumentHandle,
  type PdfLink,
  type PdfOutlineEntry,
  type PdfPageInfo,
  type PdfPageText,
  type PdfProvider,
  type PdfSourceGeometry,
  type PdfTextItem,
} from '../pdf/index.js';

export interface MockPdfPageFixture {
  readonly geometry: PdfSourceGeometry;
  readonly text: readonly PdfTextItem[];
  readonly links: readonly PdfLink[];
}

export interface MockPdfFixture {
  readonly pages: readonly MockPdfPageFixture[];
  readonly outline?: readonly PdfOutlineEntry[];
  readonly password?: string;
  readonly operationDelayMillis?: number;
}

function pdfError(code: 'PDF_PASSWORD_REQUIRED' | 'PDF_PASSWORD_INCORRECT' | 'PDF_RESOURCE_LIMIT' | 'PDF_PAGE_OUT_OF_RANGE' | 'PDF_RENDER_CANCELLED', message: string): FroglightError {
  return new FroglightError(code, message);
}

async function waitForOperation(
  _delayMillis: number,
  ownedSignal: AbortSignal,
  callerSignal?: AbortSignal,
): Promise<void> {
  if (ownedSignal.aborted || Boolean(callerSignal?.aborted)) {
    throw pdfError('PDF_RENDER_CANCELLED', 'PDF operation was cancelled');
  }
  // Always cross an async boundary so tests can deterministically close or
  // abort a handle while provider work is outstanding, without depending on
  // timers or host-specific scheduling APIs in the portable package.
  await Promise.resolve();
  if (ownedSignal.aborted || Boolean(callerSignal?.aborted)) {
    throw pdfError('PDF_RENDER_CANCELLED', 'PDF operation was cancelled');
  }
}

export class MockPdfProvider implements PdfProvider {
  readonly #fixture: MockPdfFixture;
  readonly #credentials = new Set<symbol>();

  constructor(fixture: MockPdfFixture) {
    this.#fixture = fixture;
  }

  activeCredentialCountForTest(): number {
    return this.#credentials.size;
  }

  async open(input: {
    readonly bytes: Uint8Array;
    readonly password?: string;
    readonly signal?: AbortSignal;
  }): Promise<PdfDocumentHandle> {
    if (input.bytes.byteLength > PDF_LIMITS.maxSourceBytes || this.#fixture.pages.length > PDF_LIMITS.maxPages) {
      throw pdfError('PDF_RESOURCE_LIMIT', 'PDF exceeds configured resource limits');
    }
    if (this.#fixture.password !== undefined && input.password === undefined) {
      throw pdfError('PDF_PASSWORD_REQUIRED', 'PDF requires a password');
    }
    if (this.#fixture.password !== undefined && input.password !== this.#fixture.password) {
      throw pdfError('PDF_PASSWORD_INCORRECT', 'PDF password is incorrect');
    }
    if (input.signal?.aborted === true) {
      throw pdfError('PDF_RENDER_CANCELLED', 'PDF open was cancelled');
    }
    const credential = this.#fixture.password === undefined ? null : Symbol('credential');
    if (credential !== null) this.#credentials.add(credential);
    const owned = new AbortController();
    let closed = false;
    const fixture = this.#fixture;
    const operation = async <T>(value: () => T, signal?: AbortSignal): Promise<T> => {
      if (closed) throw pdfError('PDF_RENDER_CANCELLED', 'PDF handle is closed');
      await waitForOperation(fixture.operationDelayMillis ?? 0, owned.signal, signal);
      if (closed) throw pdfError('PDF_RENDER_CANCELLED', 'PDF handle is closed');
      return value();
    };
    const page = (pageIndex: number): MockPdfPageFixture => {
      if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= fixture.pages.length) {
        throw pdfError('PDF_PAGE_OUT_OF_RANGE', `PDF page ${pageIndex} is out of range`);
      }
      return fixture.pages[pageIndex]!;
    };
    return {
      pageCount: fixture.pages.length,
      getPageInfo: (pageIndex, signal) => operation<PdfPageInfo>(() => {
        const source = page(pageIndex);
        return {
          pageIndex,
          geometry: normalizePdfPageGeometry(source.geometry),
          hasSourceText: source.text.length > 0,
        };
      }, signal),
      getPageText: (pageIndex, signal) => operation<PdfPageText>(() => {
        const items = page(pageIndex).text;
        const characterCount = items.reduce((total, item) => total + item.text.length, 0);
        if (items.length > PDF_LIMITS.maxTextItemsPerPage || characterCount > PDF_LIMITS.maxTextCharactersPerPage) {
          throw pdfError('PDF_RESOURCE_LIMIT', 'PDF page text exceeds configured limits');
        }
        return { kind: 'source', items: [...items] };
      }, signal),
      getOutline: (signal) => operation(() => [...(fixture.outline ?? [])], signal),
      getLinks: (pageIndex, signal) => operation(() => {
        const links = page(pageIndex).links;
        if (links.length > PDF_LIMITS.maxLinksPerPage) {
          throw pdfError('PDF_RESOURCE_LIMIT', 'PDF page links exceed configured limits');
        }
        return [...links];
      }, signal),
      close: async () => {
        if (closed) return;
        closed = true;
        owned.abort();
        if (credential !== null) this.#credentials.delete(credential);
      },
    };
  }
}
