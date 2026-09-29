// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { latexModel, type DocumentSession, type LaTeXDocumentHandle, type LaTeXRenderResult } from '@froglight/foundation';
import { LatexDocumentReaderProvider } from './latex-reader.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const result = (html: string): LaTeXRenderResult => ({ html, diagnostics: [] });
function renderHandle() {
  const rendered = deferred<LaTeXRenderResult>();
  const closed = deferred<void>();
  const handle = { render: vi.fn(() => rendered.promise), close: vi.fn(() => closed.promise) };
  return { handle, rendered, closed };
}
function setup() {
  const opens: ReturnType<typeof deferred<LaTeXDocumentHandle>>[] = [];
  const model = latexModel('first');
  const open = vi.fn(() => { const next = deferred<LaTeXDocumentHandle>(); opens.push(next); return next.promise; });
  const deps = { latexProvider: () => ({ open }), resolveDocumentPath: () => 'paper.tex', createResolver: () => ({ readFile: async () => '', assetUrl: async () => '' }), renderDebounceMillis: 100 };
  const parent = document.createElement('div');
  document.body.append(parent);
  const reader = new LatexDocumentReaderProvider(deps).createReader({ session: { model } as unknown as DocumentSession, parent });
  const frame = parent.querySelector('iframe')!;
  return { reader, frame, model, opens, deps, open };
}
const tick = () => vi.advanceTimersByTimeAsync(100);
const settle = () => vi.advanceTimersByTimeAsync(0);

describe('LaTeX reader generation ownership', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });

  it('reverse-order opens never adopt or render the stale handle', async () => {
    const s = setup(); await tick(); s.reader.update(); await tick();
    const old = renderHandle(), fresh = renderHandle();
    s.opens[1]!.resolve(fresh.handle); await settle(); fresh.rendered.resolve(result('newest')); await settle();
    s.opens[0]!.resolve(old.handle); await settle();
    expect(old.handle.render).not.toHaveBeenCalled();
    expect(old.handle.close).toHaveBeenCalledTimes(1);
    expect(fresh.handle.close).not.toHaveBeenCalled();
    expect(s.frame.srcdoc).toBe('newest');
    s.reader.destroy(); expect(fresh.handle.close).toHaveBeenCalledTimes(1);
    old.closed.resolve(); fresh.closed.resolve(); await settle();
  });

  it.each(['resolve', 'reject'] as const)('invalidates pending renders immediately during debounce (%s)', async (completion) => {
    const s = setup(); const old = renderHandle(); await tick(); s.opens[0]!.resolve(old.handle); await settle();
    (s.model as { raw: string }).raw = 'second'; s.reader.update();
    if (completion === 'resolve') old.rendered.resolve(result('stale')); else old.rendered.reject(new Error('stale error'));
    await settle(); expect(s.frame.srcdoc).not.toContain('stale');
    old.closed.resolve(); await tick(); const fresh = renderHandle(); s.opens[1]!.resolve(fresh.handle); await settle();
    fresh.rendered.resolve(result('second')); await settle(); expect(s.frame.srcdoc).toBe('second');
    expect(old.handle.close).toHaveBeenCalledTimes(1); s.reader.destroy(); fresh.closed.resolve(); await settle();
  });

  it('a pending previous close cannot resume an obsolete render or close a newer handle', async () => {
    const s = setup(); const a = renderHandle(), b = renderHandle(), c = renderHandle();
    await tick(); s.opens[0]!.resolve(a.handle); await settle(); a.rendered.resolve(result('a')); await settle();
    s.reader.update(); await tick(); s.opens[1]!.resolve(b.handle); await settle();
    s.reader.update(); await tick(); s.opens[2]!.resolve(c.handle); await settle();
    b.closed.resolve(); await settle(); c.rendered.resolve(result('c')); await settle();
    a.closed.resolve(); await settle();
    expect(b.handle.render).not.toHaveBeenCalled(); expect(b.handle.close).toHaveBeenCalledTimes(1);
    expect(c.handle.close).not.toHaveBeenCalled(); expect(s.frame.srcdoc).toBe('c');
    s.reader.destroy(); c.closed.resolve(); await settle();
  });

  it('reverse-order render completions publish only the newest', async () => {
    const s = setup(); const a = renderHandle(), b = renderHandle();
    await tick(); s.opens[0]!.resolve(a.handle); await settle(); s.reader.update(); await tick();
    s.opens[1]!.resolve(b.handle); a.closed.resolve(); await settle(); b.rendered.resolve(result('b')); await settle();
    a.rendered.resolve(result('a')); await settle();
    expect(s.frame.srcdoc).toBe('b'); expect(a.handle.close).toHaveBeenCalledTimes(1); expect(b.handle.close).not.toHaveBeenCalled();
    s.reader.destroy(); b.closed.resolve(); await settle();
  });

  it.each(['open', 'render'] as const)('destroy during pending %s closes late handles exactly once and never publishes', async (phase) => {
    const s = setup(); const a = renderHandle(); await tick();
    if (phase === 'render') { s.opens[0]!.resolve(a.handle); await settle(); }
    const before = s.frame.srcdoc; s.reader.destroy(); s.reader.destroy();
    if (phase === 'open') s.opens[0]!.resolve(a.handle);
    a.rendered.resolve(result('late')); await settle();
    expect(s.frame.srcdoc).toBe(before); expect(a.handle.close).toHaveBeenCalledTimes(1);
    a.closed.resolve(); await settle(); expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores stale open errors, shows current open errors, and cancels an unstarted timer', async () => {
    const s = setup(); await tick(); s.reader.update(); await tick();
    s.opens[0]!.reject(new Error('obsolete open')); await settle();
    expect(s.frame.srcdoc).not.toContain('obsolete open');
    s.opens[1]!.reject(new Error('current open')); await settle();
    expect(s.frame.srcdoc).toContain('current open');
    s.reader.update(); s.reader.destroy(); await tick();
    expect(s.open).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });

  it('a rejected close does not prevent a current render or escape destroy', async () => {
    const s = setup(); const a = renderHandle(), b = renderHandle();
    await tick(); s.opens[0]!.resolve(a.handle); await settle(); a.rendered.resolve(result('a')); await settle();
    s.reader.update(); await tick(); s.opens[1]!.resolve(b.handle); await settle();
    a.closed.reject(new Error('cleanup')); await settle(); b.rendered.resolve(result('b')); await settle();
    expect(s.frame.srcdoc).toBe('b'); expect(a.handle.close).toHaveBeenCalledTimes(1);
    s.reader.destroy(); b.closed.reject(new Error('destroy cleanup')); await settle();
    expect(b.handle.close).toHaveBeenCalledTimes(1);
  });

  it.each(['empty', 'error', 'unavailable'] as const)('replaces stale success with an honest %s placeholder and recovers', async (failure) => {
    const s = setup(); const a = renderHandle(); await tick(); s.opens[0]!.resolve(a.handle); await settle(); a.rendered.resolve(result('previous success')); await settle();
    if (failure === 'unavailable') vi.spyOn(s.deps, 'latexProvider').mockReturnValue(null as never);
    s.reader.update(); await tick(); a.closed.resolve();
    const b = renderHandle();
    if (failure !== 'unavailable') { s.opens[1]!.resolve(b.handle); await settle(); if (failure === 'empty') b.rendered.resolve(result('')); else b.rendered.reject(new Error('current failure')); }
    await settle(); expect(s.frame.srcdoc).not.toContain('previous success'); expect(s.frame.srcdoc).toMatch(/unavailable|failed/);
    expect(a.handle.close).toHaveBeenCalledTimes(1); b.closed.resolve();
    vi.restoreAllMocks(); s.reader.update(); await tick(); const c = renderHandle(); s.opens.at(-1)!.resolve(c.handle); await settle(); c.rendered.resolve(result('recovered')); await settle();
    expect(s.frame.srcdoc).toBe('recovered'); s.reader.destroy(); c.closed.resolve(); await settle();
  });
});
