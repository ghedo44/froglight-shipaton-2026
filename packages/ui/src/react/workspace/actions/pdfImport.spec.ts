import { describe, expect, it, vi } from 'vitest';
import { importPdfAsNotebookFlow } from './pdfImport.js';

const input = { name: 'paper.pdf', bytes: new Uint8Array([1, 2, 3]) };

function deps(
  overrides: Partial<Parameters<typeof importPdfAsNotebookFlow>[0]> = {},
) {
  return {
    focusedPane: 'main',
    selectPages: vi.fn().mockResolvedValue([0, 1]),
    promptPassword: vi.fn().mockResolvedValue('secret'),
    toast: vi.fn(),
    closeDrawers: vi.fn(),
    ...overrides,
  };
}

const passwordError = (code: string) =>
  Object.assign(new Error(code), { code });

describe('importPdfAsNotebookFlow', () => {
  it('reports when PDF import is unavailable in the profile', async () => {
    const ctx = deps({ importPdfAsNotebook: undefined });
    await importPdfAsNotebookFlow(ctx, input);
    expect(ctx.toast).toHaveBeenCalledWith(
      'PDF import is unavailable in this profile',
      'error',
    );
    expect(ctx.selectPages).not.toHaveBeenCalled();
  });

  it('aborts silently when page selection is dismissed', async () => {
    const importPdfAsNotebook = vi.fn();
    const ctx = deps({
      importPdfAsNotebook,
      selectPages: vi.fn().mockResolvedValue(null),
    });
    await importPdfAsNotebookFlow(ctx, input);
    expect(importPdfAsNotebook).not.toHaveBeenCalled();
    expect(ctx.toast).not.toHaveBeenCalled();
  });

  it('imports and closes drawers on success', async () => {
    const importPdfAsNotebook = vi.fn().mockResolvedValue({ pageCount: 2 });
    const ctx = deps({ importPdfAsNotebook });
    await importPdfAsNotebookFlow(ctx, input);
    expect(importPdfAsNotebook).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'paper.pdf' }),
      { pane: 'main' },
    );
    expect(ctx.toast).toHaveBeenCalledWith(
      'Imported 2 PDF pages as a notebook',
    );
    expect(ctx.closeDrawers).toHaveBeenCalledTimes(1);
  });

  it('retries with the entered password when the PDF is locked', async () => {
    const importPdfAsNotebook = vi
      .fn()
      .mockRejectedValueOnce(passwordError('PDF_PASSWORD_REQUIRED'))
      .mockResolvedValue({ pageCount: 1 });
    const ctx = deps({ importPdfAsNotebook });
    await importPdfAsNotebookFlow(ctx, input);
    expect(ctx.promptPassword).toHaveBeenCalledWith(false);
    expect(importPdfAsNotebook).toHaveBeenLastCalledWith(
      expect.objectContaining({ password: 'secret' }),
      { pane: 'main' },
    );
    expect(ctx.toast).toHaveBeenCalledWith(
      'Imported 1 PDF page as a notebook',
    );
  });

  it('reprompts after an incorrect password and aborts on dismissal', async () => {
    const importPdfAsNotebook = vi
      .fn()
      .mockRejectedValueOnce(passwordError('PDF_PASSWORD_REQUIRED'))
      .mockRejectedValueOnce(passwordError('PDF_PASSWORD_INCORRECT'));
    const ctx = deps({
      importPdfAsNotebook,
      promptPassword: vi
        .fn()
        .mockResolvedValueOnce('wrong')
        .mockResolvedValueOnce(null),
    });
    await importPdfAsNotebookFlow(ctx, input);
    expect(ctx.promptPassword).toHaveBeenNthCalledWith(1, false);
    expect(ctx.promptPassword).toHaveBeenNthCalledWith(2, true);
    expect(ctx.toast).not.toHaveBeenCalled();
  });

  it('reports page-selection failures', async () => {
    const importPdfAsNotebook = vi.fn();
    const ctx = deps({
      importPdfAsNotebook,
      selectPages: vi.fn().mockRejectedValue(new Error('unreadable')),
    });
    await importPdfAsNotebookFlow(ctx, input);
    expect(importPdfAsNotebook).not.toHaveBeenCalled();
    expect(ctx.toast).toHaveBeenCalledWith('unreadable', 'error');
  });

  it('reports unexpected failures', async () => {
    const importPdfAsNotebook = vi
      .fn()
      .mockRejectedValue(new Error('boom'));
    const ctx = deps({ importPdfAsNotebook });
    await importPdfAsNotebookFlow(ctx, input);
    expect(ctx.toast).toHaveBeenCalledWith('PDF import failed: boom', 'error');
  });
});
