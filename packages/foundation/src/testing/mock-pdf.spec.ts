import { describe, expect, it } from 'vitest';
import { MockPdfProvider } from './mock-pdf.js';

const fixture = {
  pages: [
    {
      geometry: { mediaBox: [0, 0, 612, 792] as const },
      text: [{ text: 'Selectable source text' }],
      links: [{ kind: 'page' as const, pageIndex: 1 }],
    },
    {
      geometry: { mediaBox: [0, 0, 792, 612] as const, rotate: 90 },
      text: [],
      links: [],
    },
  ],
  outline: [{ id: 'intro', title: 'Intro', pageIndex: 0, children: [] }],
  password: 'secret',
};

describe('MockPdfProvider', () => {
  it('normalizes password failures and forgets credentials on close', async () => {
    const provider = new MockPdfProvider(fixture);
    await expect(provider.open({ bytes: new Uint8Array([1]) })).rejects.toMatchObject({
      code: 'PDF_PASSWORD_REQUIRED',
    });
    await expect(
      provider.open({ bytes: new Uint8Array([1]), password: 'wrong' }),
    ).rejects.toMatchObject({ code: 'PDF_PASSWORD_INCORRECT' });
    const handle = await provider.open({ bytes: new Uint8Array([1]), password: 'secret' });
    expect(provider.activeCredentialCountForTest()).toBe(1);
    await handle.close();
    expect(provider.activeCredentialCountForTest()).toBe(0);
  });

  it('exposes source text honestly and validates zero-based page ranges', async () => {
    const provider = new MockPdfProvider({ ...fixture, password: undefined });
    const handle = await provider.open({ bytes: new Uint8Array([1]) });
    expect(handle.pageCount).toBe(2);
    expect(await handle.getPageText(0)).toMatchObject({ kind: 'source' });
    expect(await handle.getPageText(1)).toEqual({ kind: 'source', items: [] });
    await expect(handle.getPageInfo(2)).rejects.toMatchObject({
      code: 'PDF_PAGE_OUT_OF_RANGE',
    });
  });

  it('cancels outstanding work when its handle closes', async () => {
    const provider = new MockPdfProvider({
      ...fixture,
      password: undefined,
      operationDelayMillis: 50,
    });
    const handle = await provider.open({ bytes: new Uint8Array([1]) });
    const pending = handle.getPageText(0);
    await handle.close();
    await expect(pending).rejects.toMatchObject({ code: 'PDF_RENDER_CANCELLED' });
  });
});
