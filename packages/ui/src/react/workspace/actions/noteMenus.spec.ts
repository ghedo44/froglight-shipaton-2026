import { describe, expect, it, vi } from 'vitest';
import { buildNoteMenuEntries } from './noteMenus.js';

function context(
  overrides: Partial<Parameters<typeof buildNoteMenuEntries>[0]> = {},
) {
  return {
    documentId: 'doc-1',
    documentTitle: 'welcome.md',
    documentPath: 'notes/welcome.md',
    readingDefault: false,
    revealInExplorer: vi.fn(),
    writeClipboard: vi.fn().mockResolvedValue(undefined),
    onClipboardUnavailable: vi.fn(),
    makeCopy: vi.fn(),
    setReadingDefault: vi.fn(),
    applyReadingModeNow: vi.fn(),
    deleteDocument: vi.fn(),
    ...overrides,
  };
}

const labels = (entries: ReturnType<typeof buildNoteMenuEntries>) =>
  entries.map((entry) => (entry === 'separator' ? '---' : entry.label));

describe('buildNoteMenuEntries', () => {
  it('lists reveal, wiki-link, copy, reading default, and delete', () => {
    expect(labels(buildNoteMenuEntries(context()))).toEqual([
      'Reveal in file explorer',
      'Copy wiki-link',
      'Make a copy',
      '---',
      'Always open in reading view',
      '---',
      'Delete note',
    ]);
  });

  it('copies a wiki-link without the file extension', async () => {
    const ctx = context();
    const entries = buildNoteMenuEntries(ctx);
    const copy = entries.find(
      (entry) => entry !== 'separator' && entry.label === 'Copy wiki-link',
    )!;
    if (copy !== 'separator') copy.run?.();
    await Promise.resolve();
    expect(ctx.writeClipboard).toHaveBeenCalledWith('[[welcome]]');
  });

  it('falls back to the document id when the title is missing', async () => {
    const ctx = context({ documentTitle: null });
    const entries = buildNoteMenuEntries(ctx);
    const copy = entries.find(
      (entry) => entry !== 'separator' && entry.label === 'Copy wiki-link',
    )!;
    if (copy !== 'separator') copy.run?.();
    await Promise.resolve();
    expect(ctx.writeClipboard).toHaveBeenCalledWith('[[doc-1]]');
  });

  it('reports clipboard failures instead of throwing', async () => {
    const ctx = context({
      writeClipboard: vi.fn().mockRejectedValue(new Error('denied')),
    });
    const entries = buildNoteMenuEntries(ctx);
    const copy = entries.find(
      (entry) => entry !== 'separator' && entry.label === 'Copy wiki-link',
    )!;
    if (copy !== 'separator') copy.run?.();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ctx.onClipboardUnavailable).toHaveBeenCalledTimes(1);
  });

  it('suggests a copy path alongside the original', () => {
    const ctx = context();
    const entries = buildNoteMenuEntries(ctx);
    const makeCopy = entries.find(
      (entry) => entry !== 'separator' && entry.label === 'Make a copy',
    )!;
    if (makeCopy !== 'separator') makeCopy.run?.();
    expect(ctx.makeCopy).toHaveBeenCalledWith('notes/welcome copy.md');
  });

  it('toggles the reading default and applies reading mode when enabling', () => {
    const ctx = context();
    const entries = buildNoteMenuEntries(ctx);
    const toggle = entries.find(
      (entry) =>
        entry !== 'separator' && entry.label === 'Always open in reading view',
    )!;
    expect(toggle !== 'separator' && toggle.checked).toBe(false);
    if (toggle !== 'separator') toggle.run?.();
    expect(ctx.setReadingDefault).toHaveBeenCalledWith(true);
    expect(ctx.applyReadingModeNow).toHaveBeenCalledTimes(1);

    const ctxOn = context({ readingDefault: true });
    const entriesOn = buildNoteMenuEntries(ctxOn);
    const toggleOn = entriesOn.find(
      (entry) =>
        entry !== 'separator' && entry.label === 'Always open in reading view',
    )!;
    expect(toggleOn !== 'separator' && toggleOn.checked).toBe(true);
    if (toggleOn !== 'separator') toggleOn.run?.();
    expect(ctxOn.setReadingDefault).toHaveBeenCalledWith(false);
    expect(ctxOn.applyReadingModeNow).not.toHaveBeenCalled();
  });
});
