import { describe, expect, it } from 'vitest';
import { MockLaTeXProvider } from './mock-latex.js';
import { latexError } from '../latex/contracts.js';
import type { LaTeXSourceResolver } from '../latex/contracts.js';

const resolver: LaTeXSourceResolver = {
  readFile: async () => '',
  assetUrl: async () => 'blob:mock',
};

describe('MockLaTeXProvider', () => {
  it('renders fixture html and diagnostics, closing cleanly', async () => {
    const provider = new MockLaTeXProvider({
      html: '<!DOCTYPE html><html><body><h2 id="sec-1">1 One</h2></body></html>',
      diagnostics: [{ code: 'LATEX_INFO', message: 'mock' }],
    });
    const handle = await provider.open({ entry: '\\begin{document}\\end{document}', resolve: resolver });
    const result = await handle.render();
    expect(result.html).toContain('id="sec-1"');
    expect(result.diagnostics).toHaveLength(1);
    expect(provider.activeHandleCountForTest()).toBe(1);
    await handle.close();
    expect(provider.activeHandleCountForTest()).toBe(0);
    await expect(handle.render()).rejects.toMatchObject({ code: 'LATEX_RENDER_CANCELLED' });
  });

  it('rejects open with the configured structured error', async () => {
    const provider = new MockLaTeXProvider({ openErrorCode: 'LATEX_RESOURCE_LIMIT' });
    await expect(provider.open({ entry: 'x', resolve: resolver })).rejects.toMatchObject({
      code: 'LATEX_RESOURCE_LIMIT',
    });
  });

  it('rejects render after abort', async () => {
    const provider = new MockLaTeXProvider();
    const controller = new AbortController();
    const handle = await provider.open({ entry: 'x', resolve: resolver, signal: controller.signal });
    controller.abort();
    await expect(handle.render({ signal: controller.signal })).rejects.toMatchObject({
      code: 'LATEX_RENDER_CANCELLED',
    });
    await handle.close();
  });
});

describe('latexError', () => {
  it('creates FroglightErrors with stable LaTeX codes', () => {
    expect(latexError('LATEX_PARSE_ERROR', 'bad')).toMatchObject({
      code: 'LATEX_PARSE_ERROR',
      message: 'bad',
    });
  });
});
