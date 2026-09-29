// @vitest-environment jsdom
import { act } from 'react';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VaultError } from '@froglight/foundation';
import { RawFilePreview } from './RawFilePreview.jsx';
import previewStyles from './FilePreview.module.css';
import type { RawFileReader } from './shared.js';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(element: React.ReactElement): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(element);
  });
  return host;
}

function unmount(): void {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

const blobSpy = {
  created: [] as string[],
  revoked: [] as string[],
  install() {
    let counter = 0;
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: vi.fn(() => {
          const url = `blob:mock-${(counter += 1)}`;
          this.created.push(url);
          return url;
        }),
        revokeObjectURL: vi.fn((url: string) => {
          this.revoked.push(url);
        }),
      }),
    );
  },
};

beforeEach(() => {
  blobSpy.created = [];
  blobSpy.revoked = [];
  blobSpy.install();
});
afterEach(() => {
  unmount();
  vi.unstubAllGlobals();
});

describe('RawFilePreview', () => {
  it('renders an image preview with an object URL and file name', async () => {
    const reader: RawFileReader = () =>
      Promise.resolve(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }));
    const mounted = mount(
      createElement(RawFilePreview, { path: 'photos/trip.png', reader }),
    );
    await settle();

    const img = mounted.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toMatch(/^blob:/);
    // The file name survives as the image's accessible name; the tab strip
    // and pane header already show it, so no in-preview title is rendered.
    expect(img?.getAttribute('alt')).toBe('trip.png');
    expect(mounted.querySelector('.file-preview-header')).toBeNull();
  });

  it('zooms the image around its fitted size', async () => {
    type ROCallback = (
      entries: Array<{ contentRect: { width: number; height: number } }>,
    ) => void;
    const roListeners: ROCallback[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ROCallback) {
          roListeners.push(callback);
        }
        observe(): void {
          // Driven manually below.
        }
        unobserve(): void {
          // Driven manually below.
        }
        disconnect(): void {
          // Driven manually below.
        }
      },
    );
    const reader: RawFileReader = () =>
      Promise.resolve(new Blob([new Uint8Array([1])], { type: 'image/png' }));
    const mounted = mount(
      createElement(RawFilePreview, { path: 'photos/big.png', reader }),
    );
    await settle();

    const img = mounted.querySelector(
      `.${previewStyles['image-viewer']} img`,
    ) as HTMLImageElement;
    Object.defineProperty(img, 'naturalWidth', {
      value: 1600,
      configurable: true,
    });
    Object.defineProperty(img, 'naturalHeight', {
      value: 1200,
      configurable: true,
    });
    await act(async () => {
      img.dispatchEvent(new Event('load'));
    });
    await act(async () => {
      for (const listener of roListeners) {
        listener([{ contentRect: { width: 800, height: 600 } }]);
      }
    });

    // Fit is min(800/1600, 600/1200) = 50%.
    expect(
      mounted.querySelector(`.${previewStyles['image-zoom-level']}`)?.textContent,
    ).toBe('50%');
    const zoomIn = [...mounted.querySelectorAll('button')].find(
      (button) => button.getAttribute('aria-label') === 'Zoom in',
    );
    expect(zoomIn).toBeDefined();
    await act(async () => {
      zoomIn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // One 1.25x step: 62.5% rounds to 63%.
    expect(
      mounted.querySelector(`.${previewStyles['image-zoom-level']}`)?.textContent,
    ).toBe('63%');
    expect(img.style.transform).toContain('scale(0.625)');
  });

  it('revokes the object URL when the preview unmounts', async () => {
    const reader: RawFileReader = () =>
      Promise.resolve(new Blob([new Uint8Array([1])], { type: 'image/png' }));
    mount(createElement(RawFilePreview, { path: 'a.png', reader }));
    await settle();
    expect(blobSpy.created.length).toBeGreaterThan(0);

    unmount();
    expect(blobSpy.revoked).toEqual(blobSpy.created);
  });

  it('truncates very large text with a notice and toggles wrapping', async () => {
    const big = 'x'.repeat(200_001);
    const reader: RawFileReader = () => Promise.resolve(new Blob([big]));
    const mounted = mount(
      createElement(RawFilePreview, { path: 'logs/huge.log', reader }),
    );
    await settle();

    expect(mounted.textContent).toContain('Truncated');
    const pre = mounted.querySelector('pre');
    expect(pre?.className).not.toContain('no-wrap');

    const toggle = [...mounted.querySelectorAll('button')].find((button) =>
      button.textContent?.toLowerCase().includes('wrap'),
    );
    expect(toggle).toBeDefined();
    act(() => {
      toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();
    expect(mounted.querySelector('pre')?.className).toContain('no-wrap');
  });

  it('offers a working download for unrenderable files', async () => {
    const reader: RawFileReader = () =>
      Promise.resolve(
        new Blob([new Uint8Array([9, 9])], { type: 'application/zip' }),
      );
    const mounted = mount(
      createElement(RawFilePreview, { path: 'exports/bundle.zip', reader }),
    );
    await settle();

    const link = mounted.querySelector<HTMLAnchorElement>('a[download]');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('download')).toBe('bundle.zip');
    expect(link?.getAttribute('href')).toMatch(/^blob:/);
    expect(mounted.textContent).toContain('application/zip');
  });

  it('embeds PDFs when the host supports iframe PDFs, else offers notebook import', async () => {
    const reader: RawFileReader = () =>
      Promise.resolve(
        new Blob([new Uint8Array([1])], { type: 'application/pdf' }),
      );

    const embedded = mount(
      createElement(RawFilePreview, {
        path: 'docs/paper.pdf',
        reader,
        canEmbedPdf: true,
      }),
    );
    await settle();
    expect(embedded.querySelector('iframe')).not.toBeNull();
    unmount();

    const fallback = mount(
      createElement(RawFilePreview, {
        path: 'docs/paper.pdf',
        reader,
        canEmbedPdf: false,
        onImportAsNotebook: () => undefined,
      }),
    );
    await settle();
    expect(fallback.querySelector('iframe')).toBeNull();
    expect(fallback.textContent).toContain('Import as notebook');

    const imported = vi.fn();
    const interactive = mount(
      createElement(RawFilePreview, {
        path: 'docs/paper.pdf',
        reader,
        canEmbedPdf: false,
        onImportAsNotebook: imported,
      }),
    );
    await settle();
    const button = [...interactive.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Import as notebook'),
    );
    act(() => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();
    expect(imported).toHaveBeenCalledTimes(1);
  });

  it('shows a loading state until the bytes resolve', async () => {
    let resolveReader: ((blob: Blob) => void) | null = null;
    const reader: RawFileReader = () =>
      new Promise((resolve) => {
        resolveReader = resolve;
      });
    const mounted = mount(
      createElement(RawFilePreview, { path: 'pending.png', reader }),
    );
    expect(mounted.textContent).toContain('Loading preview');

    await act(async () => {
      resolveReader?.(new Blob([new Uint8Array([1])], { type: 'image/png' }));
      await settle();
    });
    expect(mounted.querySelector('img')).not.toBeNull();
  });

  it('renders media controls for video and audio', async () => {
    const reader: RawFileReader = () => Promise.resolve(new Blob([new Uint8Array([1])]));
    const video = mount(
      createElement(RawFilePreview, { path: 'media/clip.mp4', reader }),
    );
    await settle();
    expect(video.querySelector('video[controls]')).not.toBeNull();
    unmount();

    const audio = mount(
      createElement(RawFilePreview, { path: 'media/song.mp3', reader }),
    );
    await settle();
    expect(audio.querySelector('audio[controls]')).not.toBeNull();
  });

  it('shows a retryable error state when the reader fails', async () => {
    const reader = vi.fn<RawFileReader>();
    reader.mockRejectedValueOnce(new Error('disk hiccup'));
    reader.mockResolvedValue(new Blob(['recovered text']));
    const mounted = mount(
      createElement(RawFilePreview, { path: 'notes.txt', reader }),
    );
    await settle();
    expect(mounted.textContent).toContain('disk hiccup');

    const retry = [...mounted.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Retry'),
    );
    expect(retry).toBeDefined();
    act(() => {
      retry!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();
    expect(mounted.textContent).toContain('recovered text');
  });

  it('distinguishes a deleted file from a generic failure', async () => {
    const reader: RawFileReader = () =>
      Promise.reject(new VaultError('NOT_FOUND', 'no such file'));
    const mounted = mount(
      createElement(RawFilePreview, { path: 'gone.png', reader }),
    );
    await settle();
    expect(mounted.textContent).toContain('File not found');
  });

  it('explains itself when no file reader is available', () => {
    const mounted = mount(
      createElement(RawFilePreview, { path: 'a.png', reader: null }),
    );
    expect(mounted.textContent).toContain('unavailable');
  });
});
