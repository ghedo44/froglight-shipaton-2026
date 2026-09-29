import { describe, expect, it, vi } from 'vitest';
import {
  downloadExportedFile,
  requestMarkdownPrint,
  requestNotebookExport,
  revealDocumentAddress,
} from './rightSidebarActions.js';

describe('revealDocumentAddress', () => {
  it('delegates to the controller without touching the DOM', () => {
    const revealAddress = vi.fn().mockReturnValue(true);
    revealDocumentAddress({ revealAddress }, 'main', 'some-heading');
    expect(revealAddress).toHaveBeenCalledWith('main', 'some-heading');
  });
});

describe('requestMarkdownPrint', () => {
  const options = { pageSize: 'a4', margins: 'normal', includeTitle: true } as const;

  it('prints through the injected printer', () => {
    const print = vi.fn();
    expect(
      requestMarkdownPrint({ title: 'Note', markdown: '# hi', options, print }),
    ).toEqual({ ok: true });
    expect(print).toHaveBeenCalledWith({
      title: 'Note',
      markdown: '# hi',
      options,
    });
  });

  it('reports unavailable for document types without a text projection', () => {
    expect(
      requestMarkdownPrint({
        title: 'Note',
        markdown: null,
        options,
        print: vi.fn(),
      }),
    ).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('reports printer failures with their message', () => {
    expect(
      requestMarkdownPrint({
        title: 'Note',
        markdown: '# hi',
        options,
        print: vi.fn().mockImplementation(() => {
          throw new Error('no print');
        }),
      }),
    ).toEqual({ ok: false, reason: 'Error: no print' });
  });
});

describe('requestNotebookExport', () => {
  const options = { mode: 'preserve' } as const;

  it('passes the export result through', async () => {
    const result = {
      bytes: new Uint8Array([9]),
      filename: 'note.pdf',
      warnings: [],
    };
    const exportPdf = vi.fn().mockResolvedValue(result);
    await expect(
      requestNotebookExport({ exportPdf, pane: 'main', options }),
    ).resolves.toEqual({ ok: true, result });
    expect(exportPdf).toHaveBeenCalledWith(options, 'main');
  });

  it('reports unavailable profiles distinctly from failures', async () => {
    await expect(
      requestNotebookExport({ pane: 'main', options }),
    ).resolves.toEqual({ ok: false, reason: 'unavailable' });
    const exportPdf = vi.fn().mockRejectedValue(new Error('bad pdf'));
    await expect(
      requestNotebookExport({ exportPdf, pane: 'main', options }),
    ).resolves.toEqual({ ok: false, reason: 'bad pdf' });
  });
});

describe('downloadExportedFile', () => {
  it('creates an object URL, clicks a download anchor, and revokes it', () => {
    const env = {
      createObjectUrl: vi.fn().mockReturnValue('blob:url'),
      revokeObjectUrl: vi.fn(),
      clickAnchor: vi.fn(),
      schedule: vi.fn(),
    };
    downloadExportedFile(
      { bytes: new Uint8Array([1]), filename: 'note.pdf' },
      env,
    );
    expect(env.createObjectUrl).toHaveBeenCalledTimes(1);
    const blob = env.createObjectUrl.mock.calls[0]![0] as Blob;
    expect(blob.type).toBe('application/pdf');
    expect(env.clickAnchor).toHaveBeenCalledWith('blob:url', 'note.pdf');
    expect(env.schedule).toHaveBeenCalledTimes(1);
    env.schedule.mock.calls[0]![0]!();
    expect(env.revokeObjectUrl).toHaveBeenCalledWith('blob:url');
  });
});
