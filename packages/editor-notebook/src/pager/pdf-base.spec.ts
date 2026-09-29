// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  sha256Hex,
  workspacePath,
  type PdfDocumentHandle,
  type PdfProvider,
} from '@froglight/foundation';
import { MockPdfProvider } from '@froglight/foundation/testing';
import {
  createPdfBaseManager,
  type PdfBaseEnvironment,
} from './pdf-base.js';

const PAGE_BOX = { widthPt: 300, heightPt: 200 };

function pageFixture() {
  return {
    geometry: { mediaBox: [0, 0, 300, 200] as const },
    text: [],
    links: [],
  };
}

async function assetFor(bytes: Uint8Array): Promise<{
  path: ReturnType<typeof workspacePath>;
  sha256: string;
  bytes: Uint8Array;
}> {
  const sha256 = await sha256Hex(bytes);
  return { path: workspacePath(`attachments/${sha256}`), sha256, bytes };
}

function baseEnv(
  overrides: Partial<PdfBaseEnvironment> & {
    bytes?: Uint8Array;
    provider?: PdfProvider;
  } = {},
): PdfBaseEnvironment & {
  prompts: Array<'required' | 'incorrect'>;
  externalLinks: string[];
  navigations: number[];
} {
  const prompts: Array<'required' | 'incorrect'> = [];
  const externalLinks: string[] = [];
  const navigations: number[] = [];
  const {
    bytes = new Uint8Array([37, 80, 68, 70]),
    provider,
    ...rest
  } = overrides;
  return {
    prompts,
    externalLinks,
    navigations,
    assets: {
      put: async () => {
        throw new Error('no puts in this fixture');
      },
      read: async () => bytes.slice(),
    },
    pdfProvider:
      provider ??
      new MockPdfProvider({
        pages: [pageFixture()],
        outline: [{ id: 'c1', title: 'Chapter one', pageIndex: 0, children: [] }],
      }),
    promptForPassword: async (reason) => {
      prompts.push(reason);
      return null;
    },
    openExternalLink: (url) => void externalLinks.push(url),
    resolveInternalLink: () => -1,
    navigateToPageIndex: (index) => void navigations.push(index),
    sourceInteraction: () => false,
    isActive: () => true,
    trackTask: (task) => task,
    ...rest,
  };
}

describe('pdf document pool', () => {
  it('opens once per content hash and reuses the handle', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const asset = await assetFor(bytes);
    let opens = 0;
    const inner = new MockPdfProvider({ pages: [pageFixture()] });
    const env = baseEnv({
      bytes,
      provider: {
        open: (input) => {
          opens += 1;
          return inner.open(input);
        },
      } as PdfProvider,
    });
    const manager = createPdfBaseManager(env);
    const first = await manager.openDocument(asset);
    const second = await manager.openDocument(asset);
    expect(second).toBe(first);
    expect(opens).toBe(1);
    manager.destroy();
  });

  it('rejects integrity failures and evicts the pooled attempt', async () => {
    const asset = await assetFor(new Uint8Array([1, 2, 3]));
    let opens = 0;
    const inner = new MockPdfProvider({ pages: [pageFixture()] });
    const env = baseEnv({
      bytes: new Uint8Array([9, 9, 9]),
      provider: {
        open: (input) => {
          opens += 1;
          return inner.open(input);
        },
      } as PdfProvider,
    });
    const manager = createPdfBaseManager(env);
    await expect(manager.openDocument(asset)).rejects.toThrow(
      'PDF_ASSET_INTEGRITY',
    );
    await expect(manager.openDocument(asset)).rejects.toThrow(
      'PDF_ASSET_INTEGRITY',
    );
    expect(opens).toBe(0);
    manager.destroy();
  });

  it('retries locked documents through the prompt callback', async () => {
    const bytes = new Uint8Array([7, 7, 7]);
    const asset = await assetFor(bytes);
    const passwords: Array<string | undefined> = [];
    const inner = new MockPdfProvider({
      pages: [pageFixture()],
      password: 'secret',
    });
    const env = baseEnv({
      bytes,
      provider: {
        open: (input: { bytes: Uint8Array; password?: string }) => {
          passwords.push(input.password);
          return inner.open(input);
        },
      } as unknown as PdfProvider,
      promptForPassword: async (reason) => {
        env.prompts.push(reason);
        return reason === 'required' ? 'wrong' : 'secret';
      },
    });
    const manager = createPdfBaseManager(env);
    const document = await manager.openDocument(asset);
    expect(document.pageCount).toBe(1);
    expect(passwords).toEqual([undefined, 'wrong', 'secret']);
    expect(env.prompts).toEqual(['required', 'incorrect']);
    manager.destroy();
  });

  it('surfaces cancellation without caching the failure', async () => {
    const bytes = new Uint8Array([7, 7, 7]);
    const asset = await assetFor(bytes);
    let opens = 0;
    const inner = new MockPdfProvider({
      pages: [pageFixture()],
      password: 'secret',
    });
    const env = baseEnv({
      bytes,
      provider: {
        open: (input) => {
          opens += 1;
          return inner.open(input);
        },
      } as PdfProvider,
    });
    const manager = createPdfBaseManager(env);
    await expect(manager.openDocument(asset)).rejects.toMatchObject({
      code: 'PDF_PASSWORD_REQUIRED',
    });
    expect(env.prompts).toEqual(['required']);
    await expect(manager.openDocument(asset)).rejects.toMatchObject({
      code: 'PDF_PASSWORD_REQUIRED',
    });
    expect(opens).toBe(2);
    manager.destroy();
  });
});

function mountStub(
  hooks: {
    onMount?: (scale: number, selecting: boolean) => void;
    destroyed?: string[];
  } = {},
): PdfProvider {
  return {
    async open(): Promise<PdfDocumentHandle> {
      return {
        pageCount: 1,
        getPageInfo: async () => ({
          pageIndex: 0,
          geometry: {
            effectiveBox: { minX: 0, minY: 0, maxX: 300, maxY: 200 },
            userUnit: 1,
            rotate: 0,
            pageBox: { ...PAGE_BOX },
          },
          hasSourceText: true,
        }),
        getPageText: async () => ({ kind: 'source', items: [] }),
        getOutline: async () => [],
        getLinks: async () => [],
        mountPage: async ({ parent, scale, sourceInteraction }) => {
          hooks.onMount?.(scale, sourceInteraction ?? false);
          const page = document.createElement('div');
          page.className = 'fl-pdf-page';
          (parent as HTMLElement).appendChild(page);
          return {
            setSourceInteractionEnabled: () => undefined,
            destroy: async () => {
              hooks.destroyed?.push('base');
              page.remove();
            },
          };
        },
        close: async () => undefined,
      };
    },
  };
}

async function settled(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function untilSettled(check: () => void, tries = 40): Promise<void> {
  let last: unknown = null;
  for (let i = 0; i < tries; i += 1) {
    try {
      check();
      return;
    } catch (error) {
      last = error;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }
  throw last;
}

describe('pdf base mounting', () => {
  it('renders the base layer and scales it to the shell', async () => {
    const asset = await assetFor(new Uint8Array([1]));
    const seen: number[] = [];
    const env = baseEnv({
      bytes: new Uint8Array([1]),
      provider: mountStub({ onMount: (scale) => seen.push(scale) }),
    });
    const manager = createPdfBaseManager(env);
    const host = document.createElement('div');
    host.style.width = '300px';
    document.body.appendChild(host);
    try {
      manager.mountBase(
        'p1',
        host,
        { asset, pageIndex: 0, pageBox: { ...PAGE_BOX } },
      );
      await untilSettled(() => {
        expect(host.querySelector('.fl-nb-pdf-base')).not.toBeNull();
        expect(host.querySelector('.fl-pdf-page')).not.toBeNull();
        expect(seen).toEqual([1]);
      });
      const rendered = host.querySelector<HTMLElement>('.fl-pdf-page')!;
      expect(rendered.style.transform).toBe('scale(1)');
    } finally {
      manager.destroy();
      host.remove();
    }
  });

  it('shows a placeholder when the provider cannot mount pages', async () => {
    const asset = await assetFor(new Uint8Array([1]));
    const env = baseEnv({ bytes: new Uint8Array([1]) });
    const manager = createPdfBaseManager(env);
    const host = document.createElement('div');
    host.style.width = '300px';
    document.body.appendChild(host);
    try {
      manager.mountBase(
        'p1',
        host,
        { asset, pageIndex: 0, pageBox: { ...PAGE_BOX } },
      );
      // The failure path resolves asynchronously; poll like the other
      // placeholder tests instead of assuming a fixed tick budget.
      await untilSettled(() => {
        expect(
          host.querySelector('[data-pdf-placeholder]')?.textContent,
        ).toContain('unavailable');
      });
    } finally {
      manager.destroy();
      host.remove();
    }
  });

  it('rejects mismatched geometry with a placeholder', async () => {
    const asset = await assetFor(new Uint8Array([1]));
    const env = baseEnv({
      bytes: new Uint8Array([1]),
      provider: mountStub(),
    });
    const manager = createPdfBaseManager(env);
    const host = document.createElement('div');
    host.style.width = '300px';
    document.body.appendChild(host);
    try {
      manager.mountBase('p1', host, {
        asset,
        pageIndex: 0,
        pageBox: { widthPt: 600, heightPt: 400 },
      });
      // Poll like the other async placeholder assertions: a fixed microtask
      // count flakes under parallel load before the placeholder commits.
      await untilSettled(() => {
        expect(
          host.querySelector('[data-pdf-placeholder]')?.textContent,
        ).toContain('unavailable');
        expect(host.querySelector('.fl-pdf-page')).toBeNull();
      });
    } finally {
      manager.destroy();
      host.remove();
    }
  });

  it('destroys the handle when unmounting a mounted base', async () => {
    const asset = await assetFor(new Uint8Array([1]));
    const destroyed: string[] = [];
    const env = baseEnv({
      bytes: new Uint8Array([1]),
      provider: mountStub({ destroyed }),
    });
    const manager = createPdfBaseManager(env);
    const host = document.createElement('div');
    host.style.width = '300px';
    document.body.appendChild(host);
    try {
      manager.mountBase(
        'p1',
        host,
        { asset, pageIndex: 0, pageBox: { ...PAGE_BOX } },
      );
      await untilSettled(() => {
        expect(host.querySelector('.fl-pdf-page')).not.toBeNull();
      });
      manager.unmountBase('p1');
      expect(destroyed).toEqual(['base']);
      expect(host.querySelector('.fl-nb-pdf-base')).toBeNull();
    } finally {
      manager.destroy();
      host.remove();
    }
  });

  it('aborts mid-flight mounts without creating a handle', async () => {
    const asset = await assetFor(new Uint8Array([1]));
    const destroyed: string[] = [];
    let mounted = 0;
    const env = baseEnv({
      bytes: new Uint8Array([1]),
      provider: mountStub({
        destroyed,
        onMount: () => {
          mounted += 1;
        },
      }),
    });
    const manager = createPdfBaseManager(env);
    const host = document.createElement('div');
    host.style.width = '300px';
    document.body.appendChild(host);
    try {
      manager.mountBase(
        'p1',
        host,
        { asset, pageIndex: 0, pageBox: { ...PAGE_BOX } },
      );
      manager.unmountBase('p1');
      await settled();
      expect(mounted).toBe(0);
      expect(destroyed).toEqual([]);
      expect(host.querySelector('.fl-nb-pdf-base')).toBeNull();
    } finally {
      manager.destroy();
      host.remove();
    }
  });

  it('routes external links out and internal links to pages', async () => {
    const asset = await assetFor(new Uint8Array([1]));
    const clicks: string[] = [];
    const env = baseEnv({
      bytes: new Uint8Array([1]),
      provider: {
        async open(): Promise<PdfDocumentHandle> {
          return {
            pageCount: 1,
            getPageInfo: async () => ({
              pageIndex: 0,
              geometry: {
                effectiveBox: { minX: 0, minY: 0, maxX: 300, maxY: 200 },
                userUnit: 1,
                rotate: 0,
                pageBox: { ...PAGE_BOX },
              },
              hasSourceText: false,
            }),
            getPageText: async () => ({ kind: 'source', items: [] }),
            getOutline: async () => [],
            getLinks: async () => [],
            mountPage: async ({ parent, onLinkActivate }) => {
              (parent as HTMLElement).appendChild(
                document.createElement('div'),
              ).className = 'fl-pdf-page';
              onLinkActivate?.({ kind: 'external', url: 'https://example.test' });
              onLinkActivate?.({ kind: 'page', pageIndex: 4 });
              return { destroy: async () => undefined };
            },
            close: async () => undefined,
          };
        },
      },
      resolveInternalLink: (sha, pageIndex) => {
        clicks.push(`${sha.slice(0, 4)}:${pageIndex}`);
        return 2;
      },
    });
    const manager = createPdfBaseManager(env);
    const host = document.createElement('div');
    host.style.width = '300px';
    document.body.appendChild(host);
    try {
      manager.mountBase(
        'p1',
        host,
        { asset, pageIndex: 0, pageBox: { ...PAGE_BOX } },
      );
      await untilSettled(() => {
        expect(env.externalLinks).toEqual(['https://example.test']);
      });
      expect(env.navigations).toEqual([2]);
      expect(clicks).toEqual([`${asset.sha256.slice(0, 4)}:4`]);
    } finally {
      manager.destroy();
      host.remove();
    }
  });

  it('flips base layers with the interaction mode', async () => {
    const asset = await assetFor(new Uint8Array([1]));
    let selecting = false;
    const env = baseEnv({
      bytes: new Uint8Array([1]),
      provider: mountStub(),
      sourceInteraction: () => selecting,
    });
    const manager = createPdfBaseManager(env);
    const host = document.createElement('div');
    host.style.width = '300px';
    document.body.appendChild(host);
    try {
      manager.mountBase(
        'p1',
        host,
        { asset, pageIndex: 0, pageBox: { ...PAGE_BOX } },
      );
      const layer = () =>
        host.querySelector<HTMLElement>('.fl-nb-pdf-base');
      await untilSettled(() => {
        expect(layer()?.style.pointerEvents).toBe('none');
      });
      selecting = true;
      manager.setBaseInteraction();
      expect(layer()?.style.pointerEvents).toBe('auto');
    } finally {
      manager.destroy();
      host.remove();
    }
  });
});

describe('pdf outline', () => {
  it('projects provider outlines onto notebook pages with depth', async () => {
    const asset = await assetFor(new Uint8Array([2]));
    const env = baseEnv({ bytes: new Uint8Array([2]) });
    const manager = createPdfBaseManager(env);
    try {
      const outline = await manager.loadOutline([
        { pageId: 'p1', asset, pageIndex: 0 },
        { pageId: 'p2', asset, pageIndex: 5 },
      ]);
      expect(outline).toEqual([{ pageId: 'p1', label: 'Chapter one' }]);
    } finally {
      manager.destroy();
    }
  });
});

describe('pdf base destroy', () => {
  it('closes pooled documents and drops the pool', async () => {
    const asset = await assetFor(new Uint8Array([3]));
    let closed = 0;
    const inner = new MockPdfProvider({ pages: [pageFixture()] });
    const env = baseEnv({
      bytes: new Uint8Array([3]),
      provider: {
        open: async (input) => {
          const document = await inner.open(input);
          return {
            ...document,
            close: async () => {
              closed += 1;
              await document.close();
            },
          };
        },
      } as PdfProvider,
    });
    const manager = createPdfBaseManager(env);
    await manager.openDocument(asset);
    manager.destroy();
    await settled(3);
    expect(closed).toBe(1);
  });

  it('remounts stale bases after layout changes settle', async () => {
    const asset = await assetFor(new Uint8Array([4]));
    let mounts = 0;
    const env = baseEnv({
      bytes: new Uint8Array([4]),
      provider: mountStub({
        onMount: () => {
          mounts += 1;
        },
      }),
    });
    const manager = createPdfBaseManager(env);
    const host = document.createElement('div');
    host.style.width = '300px';
    document.body.appendChild(host);
    try {
      manager.mountBase(
        'p1',
        host,
        { asset, pageIndex: 0, pageBox: { ...PAGE_BOX } },
      );
      await untilSettled(() => {
        expect(mounts).toBe(1);
      });
      host.style.width = '600px';
      manager.noteLayoutChanged(() => host);
      for (
        let attempt = 0;
        attempt < 20 && mounts < 2;
        attempt += 1
      ) {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
      expect(mounts).toBe(2);
    } finally {
      manager.destroy();
      host.remove();
    }
  });
});
