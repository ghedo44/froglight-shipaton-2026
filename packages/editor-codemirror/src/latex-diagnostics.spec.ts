// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  latexModel,
  type DocumentSession,
  type DocumentEditorHandle,
  type LaTeXSourceResolver,
} from '@froglight/foundation';
import { MockLaTeXProvider } from '@froglight/foundation/testing';
import { LatexDocumentEditorProvider } from './latex.js';

function makeSession(initialRaw: string) {
  const model = latexModel(initialRaw);
  const dirty = { count: 0 };
  const session = {
    model,
    markDirty: () => {
      dirty.count += 1;
    },
  };
  return { session: session as unknown as DocumentSession, model, dirty };
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    latexProvider: () => new MockLaTeXProvider({ html: '<p>unused</p>' }),
    createResolver: ((_documentPath: string) => ({
      readFile: async () => '',
      assetUrl: async () => 'blob:mock',
    })) as (documentPath: string) => LaTeXSourceResolver,
    resolveDocumentPath: () => 'papers/thesis.tex',
    renderDebounceMillis: 5,
    ...overrides,
  };
}

type LatexTestHandle = DocumentEditorHandle & {
  replaceTextForTest(next: string): void;
  getTextForTest(): string;
};

const rangePrototype = (
  globalThis as unknown as { Range?: { prototype: Record<string, unknown> } }
).Range?.prototype;
if (
  rangePrototype !== undefined &&
  typeof rangePrototype['getClientRects'] !== 'function'
) {
  rangePrototype['getClientRects'] = () => [] as unknown as DOMRectList;
}

function makeHandle(
  initialRaw: string,
  overrides: Record<string, unknown> = {},
): { parent: HTMLElement; handle: LatexTestHandle } {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const { session } = makeSession(initialRaw);
  const provider = new LatexDocumentEditorProvider(makeDeps(overrides));
  const handle = provider.createEditor({ session, parent }) as LatexTestHandle;
  return { parent, handle };
}

function diagnosticsOf(handle: LatexTestHandle) {
  const tools = handle.tools;
  if (tools === undefined) throw new Error('missing tools');
  const control = tools
    .snapshot()
    .controls.find((c) => c.id === 'latex.diagnostics');
  if (control?.kind !== 'diagnostics') throw new Error('missing diagnostics');
  return control;
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

describe('LaTeX diagnostics truthfulness (review slice 6)', () => {
  it('starts pending, not clean, when analysis is available', () => {
    const { parent, handle } = makeHandle('\\section{One}\n');
    const diagnostics = diagnosticsOf(handle);
    expect(diagnostics.state).toBe('pending');
    expect(diagnostics.label).toContain('analyzing');
    handle.destroy();
    parent.remove();
  });

  it('remains unavailable when the provider cannot perform analysis', async () => {
    const { parent, handle } = makeHandle('\\section{One}\n', {
      latexProvider: () => null,
    });
    expect(diagnosticsOf(handle).state).toBe('unavailable');
    await flush();
    await flush();
    expect(diagnosticsOf(handle).state).toBe('unavailable');
    handle.destroy();
    parent.remove();
  });

  it('returns to pending immediately after source changes', async () => {
    const { parent, handle } = makeHandle('\\section{One}\n');
    await flush();
    await flush();
    expect(diagnosticsOf(handle).state).toBe('clean');
    handle.replaceTextForTest('\\section{One}\nnew line\n');
    // Synchronous reset before the debounced render runs.
    expect(diagnosticsOf(handle).state).toBe('pending');
    await flush();
    await flush();
    expect(diagnosticsOf(handle).state).toBe('clean');
    handle.destroy();
    parent.remove();
  });

  it('computes totals from the full set while capping visible entries', async () => {
    const diagnostics = Array.from({ length: 60 }, (_, index) =>
      index === 51
        ? {
            code: 'LATEX_UNSUPPORTED_COMMAND' as const,
            message: `error at ${index}`,
            path: 'document.tex' as const,
            line: index,
          }
        : {
            code: 'LATEX_INFO' as const,
            message: `note ${index}`,
            path: 'document.tex' as const,
          },
    );
    const { parent, handle } = makeHandle('\\section{One}\n', {
      latexProvider: () => new MockLaTeXProvider({ html: '', diagnostics }),
    });
    await flush();
    await flush();
    const control = diagnosticsOf(handle);
    // Error after entry 50 still surfaces in summary.
    expect(control.state).toBe('errors');
    expect(control.errorCount).toBe(1);
    expect(control.noteCount).toBe(59);
    expect(control.entries).toHaveLength(50);
    expect(control.truncated).toBe(true);
    expect(control.totalCount).toBe(60);
    handle.destroy();
    parent.remove();
  });

  it('stale async generations cannot overwrite the latest result', async () => {
    // First render slow (error), second fast (clean). Final must be clean.
    let calls = 0;
    const provider = {
      open: async ({ entry }: { entry: string }) => {
        calls += 1;
        const mine = calls;
        return {
          render: async () => {
            if (mine === 1) await new Promise((r) => setTimeout(r, 50));
            else await Promise.resolve();
            if (entry.includes('second')) return { html: '', diagnostics: [] };
            return {
              html: '',
              diagnostics: [
                {
                  code: 'LATEX_UNSUPPORTED_COMMAND',
                  message: 'stale error',
                  path: 'document.tex',
                  line: 0,
                },
              ],
            };
          },
          close: async () => undefined,
        };
      },
    };
    const { parent, handle } = makeHandle('first\n', {
      latexProvider: () => provider,
      renderDebounceMillis: 5,
    });
    // Trigger first debounced render, then quickly replace with second.
    await new Promise((r) => setTimeout(r, 10));
    handle.replaceTextForTest('second\n');
    await new Promise((r) => setTimeout(r, 100));
    const control = diagnosticsOf(handle);
    expect(control.state).toBe('clean');
    expect(control.errorCount).toBe(0);
    handle.destroy();
    parent.remove();
  });

  it('a stale open that resolves after the latest never replaces its handle', async () => {
    // Render A starts, render B starts, B open resolves first and becomes
    // active, A resolves afterward and must close itself immediately.
    let opens = 0;
    let closedA = 0;
    const provider = {
      open: async ({ entry }: { entry: string }) => {
        opens += 1;
        const mine = opens;
        if (mine === 1) await new Promise((r) => setTimeout(r, 40));
        const closed = { count: 0 };
        return {
          render: async () => ({ html: '', diagnostics: [] }),
          close: async () => {
            closed.count += 1;
            if (mine === 1) closedA += 1;
          },
        };
      },
    };
    const { parent, handle } = makeHandle('first\n', {
      latexProvider: () => provider,
      renderDebounceMillis: 5,
    });
    await new Promise((r) => setTimeout(r, 10));
    handle.replaceTextForTest('second\n');
    await new Promise((r) => setTimeout(r, 100));
    expect(opens).toBe(2);
    expect(closedA).toBe(1);
    // Latest handle survived: diagnostics still resolve clean.
    expect(diagnosticsOf(handle).state).toBe('clean');
    handle.destroy();
    parent.remove();
  });

  it('a render waiting on previous close yields to a newer generation', async () => {
    // H0 installed. A opens, installs HA, and waits closing H0 (gated).
    // B opens meanwhile, installs HB (closing HA), and renders. When the
    // gate releases, A must not render or publish.
    let opens = 0;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const rendered: string[] = [];
    const provider = {
      open: async () => {
        opens += 1;
        const mine = opens;
        if (mine === 1) {
          return {
            render: async () => ({ html: '', diagnostics: [] }),
            close: async () => {
              await gate;
            },
          };
        }
        return {
          render: async () => {
            rendered.push(`h${mine}`);
            return { html: '', diagnostics: [] };
          },
          close: async () => undefined,
        };
      },
    };
    const { parent, handle } = makeHandle('v0\n', {
      latexProvider: () => provider,
      renderDebounceMillis: 5,
    });
    await new Promise((r) => setTimeout(r, 20));
    handle.replaceTextForTest('vA\n');
    await new Promise((r) => setTimeout(r, 15));
    handle.replaceTextForTest('vB\n');
    await new Promise((r) => setTimeout(r, 60));
    // Only B's handle rendered; A never did.
    expect(rendered).toEqual(['h3']);
    expect(diagnosticsOf(handle).state).toBe('clean');
    releaseGate();
    await new Promise((r) => setTimeout(r, 30));
    expect(rendered).toEqual(['h3']);
    expect(diagnosticsOf(handle).state).toBe('clean');
    handle.destroy();
    parent.remove();
  });

  it('destroy during a pending open closes the handle without publishing', async () => {    let opened = 0;
    let closed = 0;
    const provider = {
      open: async () => {
        opened += 1;
        await new Promise((r) => setTimeout(r, 30));
        return {
          render: async () => ({ html: '', diagnostics: [] }),
          close: async () => {
            closed += 1;
          },
        };
      },
    };
    const { parent, handle } = makeHandle('v0\n', {
      latexProvider: () => provider,
      renderDebounceMillis: 5,
    });
    await new Promise((r) => setTimeout(r, 10));
    handle.destroy();
    await new Promise((r) => setTimeout(r, 60));
    expect(opened).toBeGreaterThan(0);
    expect(closed).toBe(opened);
    parent.remove();
  });

  it('destroy during a pending render closes the handle without publishing', async () => {    let releaseRender!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseRender = resolve;
    });
    let rendered = 0;
    let closed = 0;
    const provider = {
      open: async () => ({
        render: async () => {
          rendered += 1;
          await gate;
          return { html: '', diagnostics: [] };
        },
        close: async () => {
          closed += 1;
        },
      }),
    };
    const { parent, handle } = makeHandle('v0\n', {
      latexProvider: () => provider,
      renderDebounceMillis: 5,
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(rendered).toBe(1);
    handle.destroy();
    releaseRender();
    await new Promise((r) => setTimeout(r, 20));
    expect(closed).toBe(1);
    parent.remove();
  });

  it('a stale generation closes its own handle when nothing newer installed yet', async () => {
    // H0 installed. A installs HA and waits closing H0 (gated). B's open
    // is slow, so when the gate releases, A is stale with HA still
    // installed: A must close HA itself instead of leaking it.
    let opens = 0;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const closedBy: string[] = [];
    const rendered: string[] = [];
    const provider = {
      open: async () => {
        opens += 1;
        const mine = opens;
        if (mine === 1) {
          return {
            render: async () => ({ html: '', diagnostics: [] }),
            close: async () => {
              await gate;
            },
          };
        }
        if (mine === 2) {
          return {
            render: async () => {
              rendered.push('h2');
              return { html: '', diagnostics: [] };
            },
            close: async () => {
              closedBy.push('h2');
            },
          };
        }
        await new Promise((r) => setTimeout(r, 40));
        return {
          render: async () => {
            rendered.push('h3');
            return { html: '', diagnostics: [] };
          },
          close: async () => undefined,
        };
      },
    };
    const { parent, handle } = makeHandle('v0\n', {
      latexProvider: () => provider,
      renderDebounceMillis: 5,
    });
    await new Promise((r) => setTimeout(r, 20));
    handle.replaceTextForTest('vA\n');
    await new Promise((r) => setTimeout(r, 15));
    handle.replaceTextForTest('vB\n');
    await new Promise((r) => setTimeout(r, 10));
    releaseGate();
    await new Promise((r) => setTimeout(r, 80));
    // A never rendered; its installed handle was closed exactly once.
    expect(rendered).toEqual(['h3']);
    expect(closedBy).toEqual(['h2']);
    expect(diagnosticsOf(handle).state).toBe('clean');
    handle.destroy();
    parent.remove();
  });
});
