import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  documentId,
  pdfKindId,
  resourceId,
  type PdfDocumentHandle,
  type PdfProvider,
} from '@froglight/foundation';
import { PdfDocumentEditorProvider, type PdfReaderHandle } from './editor.js';
import { PdfJsProvider } from './pdf-provider.js';

async function fixture(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const first = document.addPage([612, 792]);
  first.drawText('Froglight selectable source', {
    x: 72,
    y: 700,
    size: 18,
    font,
  });
  const second = document.addPage([792, 612]);
  second.setRotation({ type: 'degrees', angle: 90 } as never);
  second.drawText('Landscape page', { x: 72, y: 520, size: 18, font });
  return document.save({ useObjectStreams: false });
}

describe('PdfDocumentEditorProvider', () => {
  it('opens standalone PDFs through the generic editor seam and returns page-addressed search hits', async () => {
    const bytes = await fixture();
    const provider = new PdfDocumentEditorProvider({
      pdfProvider: new PdfJsProvider(),
    });
    const editor = provider.createEditor({
      session: {
        model: { bytes },
        ref: {
          documentId: documentId('pdf-doc'),
          kindId: pdfKindId,
          location: { resourceId: resourceId('pdf-resource') },
        },
      } as never,
      parent: {},
    }) as PdfReaderHandle;
    expect(provider.kindIds).toEqual([pdfKindId]);
    expect(await editor.searchSource('landscape')).toEqual([
      { pageIndex: 1, address: '1', text: 'Landscape page' },
    ]);
    expect(await editor.getOutline()).toEqual([]);
    expect(await editor.getLinks(0)).toEqual([]);
    editor.destroy();
  });

  it('re-prompts after an incorrect password until the user succeeds or cancels', async () => {
    const attempts: Array<string | undefined> = [];
    const reasons: string[] = [];
    const handle: PdfDocumentHandle = {
      pageCount: 1,
      getPageInfo: async () => ({
        pageIndex: 0,
        geometry: {
          effectiveBox: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
          userUnit: 1,
          rotate: 0,
          pageBox: { widthPt: 100, heightPt: 100 },
        },
      }),
      getPageText: async () => ({
        kind: 'source',
        items: [{ text: 'unlocked' }],
      }),
      getOutline: async () => [],
      getLinks: async () => [],
      close: async () => undefined,
    };
    const locked: PdfProvider = {
      async open({ password }) {
        attempts.push(password);
        if (password === undefined)
          throw Object.assign(new Error('required'), {
            code: 'PDF_PASSWORD_REQUIRED',
          });
        if (password !== 'correct')
          throw Object.assign(new Error('incorrect'), {
            code: 'PDF_PASSWORD_INCORRECT',
          });
        return handle;
      },
    };
    const passwords = ['wrong', 'correct'];
    const provider = new PdfDocumentEditorProvider({
      pdfProvider: locked,
      promptForPassword: async (reason) => {
        reasons.push(reason);
        return passwords.shift() ?? null;
      },
    });
    const editor = provider.createEditor({
      session: { model: { bytes: new Uint8Array([1]) } } as never,
      parent: {},
    }) as PdfReaderHandle;
    expect(await editor.searchSource('unlocked')).toHaveLength(1);
    expect(attempts).toEqual([undefined, 'wrong', 'correct']);
    expect(reasons).toEqual(['required', 'incorrect']);
    editor.destroy();
  });

  it('keeps cancelled encrypted bytes retryable through wrong and correct passwords', async () => {
    const source = new Uint8Array([7, 8, 9]);
    const attempts: Array<{
      readonly bytes: Uint8Array;
      readonly password: string | undefined;
    }> = [];
    const reasons: Array<'required' | 'incorrect'> = [];
    const answers: Array<string | null> = [null, 'wrong', 'correct'];
    const unlocked: PdfDocumentHandle = {
      pageCount: 1,
      getPageInfo: async () => ({
        pageIndex: 0,
        geometry: {
          effectiveBox: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
          userUnit: 1,
          rotate: 0,
          pageBox: { widthPt: 100, heightPt: 100 },
        },
      }),
      getPageText: async () => ({
        kind: 'source',
        items: [{ text: 'unlocked after retry' }],
      }),
      getOutline: async () => [],
      getLinks: async () => [],
      close: async () => undefined,
    };
    const locked: PdfProvider = {
      async open({ bytes, password }) {
        attempts.push({ bytes, password });
        if (password === undefined) {
          throw Object.assign(new Error('required'), {
            code: 'PDF_PASSWORD_REQUIRED',
          });
        }
        if (password !== 'correct') {
          throw Object.assign(new Error('incorrect'), {
            code: 'PDF_PASSWORD_INCORRECT',
          });
        }
        return unlocked;
      },
    };
    const provider = new PdfDocumentEditorProvider({
      pdfProvider: locked,
      promptForPassword: async (reason) => {
        reasons.push(reason);
        return answers.shift() ?? null;
      },
    });
    const editor = provider.createEditor({
      session: { model: { bytes: source } } as never,
      parent: {},
    }) as PdfReaderHandle;

    await expect(editor.searchSource('unlocked')).rejects.toMatchObject({
      code: 'PDF_PASSWORD_REQUIRED',
    });
    expect(
      editor.tools?.snapshot().controls.find(({ id }) => id === 'pdf.page'),
    ).toMatchObject({ label: 'PDF locked' });
    expect(
      editor.tools?.snapshot().controls.find(({ id }) => id === 'pdf.retry'),
    ).toMatchObject({ label: 'Unlock PDF', disabled: false });

    expect(editor.tools?.execute('pdf.retry')).toBe(true);
    expect(await editor.searchSource('unlocked')).toHaveLength(1);
    expect(attempts.map(({ password }) => password)).toEqual([
      undefined,
      undefined,
      'wrong',
      'correct',
    ]);
    expect(reasons).toEqual(['required', 'required', 'incorrect']);
    for (const attempt of attempts) {
      expect(attempt.bytes).not.toBe(source);
      expect(Array.from(attempt.bytes)).toEqual([7, 8, 9]);
    }
    expect(Array.from(source)).toEqual([7, 8, 9]);
    expect(
      editor.tools?.snapshot().controls.find(({ id }) => id === 'pdf.page'),
    ).toMatchObject({ label: '1 / 1' });
    expect(
      editor.tools?.snapshot().controls.find(({ id }) => id === 'pdf.retry'),
    ).toBeUndefined();
    editor.destroy();
  });

  it('does not resume a pending password retry after the reader is destroyed', async () => {
    let resolveRetryPrompt: ((password: string | null) => void) | null = null;
    const attempts: Array<string | undefined> = [];
    let promptCount = 0;
    const locked: PdfProvider = {
      async open({ password }) {
        attempts.push(password);
        throw Object.assign(new Error('required'), {
          code: 'PDF_PASSWORD_REQUIRED',
        });
      },
    };
    const provider = new PdfDocumentEditorProvider({
      pdfProvider: locked,
      promptForPassword: async () => {
        promptCount += 1;
        if (promptCount === 1) return null;
        return new Promise<string | null>((resolve) => {
          resolveRetryPrompt = resolve;
        });
      },
    });
    const editor = provider.createEditor({
      session: { model: { bytes: new Uint8Array([1]) } } as never,
      parent: {},
    }) as PdfReaderHandle;

    await expect(editor.searchSource('anything')).rejects.toMatchObject({
      code: 'PDF_PASSWORD_REQUIRED',
    });
    expect(editor.tools?.execute('pdf.retry')).toBe(true);
    for (let turn = 0; turn < 10 && resolveRetryPrompt === null; turn += 1) {
      await Promise.resolve();
    }
    const resolve = resolveRetryPrompt as
      | ((password: string | null) => void)
      | null;
    expect(resolve).not.toBeNull();
    if (resolve === null) throw new Error('retry prompt was not reached');
    editor.destroy();
    resolve('correct');
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    expect(attempts).toEqual([undefined, undefined]);
  });

  it('reports non-password failures truthfully and retries them', async () => {
    let attempts = 0;
    const recovered: PdfDocumentHandle = {
      pageCount: 1,
      getPageInfo: async () => ({
        pageIndex: 0,
        geometry: {
          effectiveBox: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
          userUnit: 1,
          rotate: 0,
          pageBox: { widthPt: 100, heightPt: 100 },
        },
      }),
      getPageText: async () => ({
        kind: 'source',
        items: [{ text: 'recovered' }],
      }),
      getOutline: async () => [],
      getLinks: async () => [],
      close: async () => undefined,
    };
    const provider = new PdfDocumentEditorProvider({
      pdfProvider: {
        async open() {
          attempts += 1;
          if (attempts === 1) throw new Error('temporary failure');
          return recovered;
        },
      },
    });
    const editor = provider.createEditor({
      session: { model: { bytes: new Uint8Array([5]) } } as never,
      parent: {},
    }) as PdfReaderHandle;

    await expect(editor.searchSource('recovered')).rejects.toThrow(
      'temporary failure',
    );
    expect(
      editor.tools?.snapshot().controls.find(({ id }) => id === 'pdf.page'),
    ).toMatchObject({ label: 'PDF unavailable' });
    expect(
      editor.tools?.snapshot().controls.find(({ id }) => id === 'pdf.retry'),
    ).toMatchObject({ label: 'Retry PDF' });
    expect(editor.tools?.execute('pdf.previous')).toBe(false);
    expect(editor.tools?.execute('pdf.next')).toBe(false);
    expect(editor.tools?.execute('pdf.source-select')).toBe(false);
    expect(editor.tools?.execute('pdf.retry')).toBe(true);
    expect(await editor.searchSource('recovered')).toHaveLength(1);
    editor.destroy();
  });
});
