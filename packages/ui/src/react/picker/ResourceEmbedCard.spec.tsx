// @vitest-environment jsdom
// Activation action specs (V3): every action is pointer- and
// keyboard-reachable, remove deletes only the reference, copy-link
// round-trips to the same location.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { ResourceTarget } from '@froglight/foundation';
import {
  ResourceEmbedCard,
  type SurfaceEmbedActivationRecord,
} from './ResourceEmbedCard.jsx';
import { formatResourceLink, parseResourceLink } from './resource-link.js';
import { resolveSurfaceEmbedPresentation } from './embed-presentation.js';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(node: React.ReactElement): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(node);
  });
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function record(
  overrides: Partial<SurfaceEmbedActivationRecord> = {},
): SurfaceEmbedActivationRecord {
  return {
    id: 'embed-1',
    type: 'froglight.resource-embed',
    target: {
      documentId: 'docA',
      kindId: 'froglight.markdown',
      resourceId: 'resA',
    },
    cachedTitle: 'Source doc',
    ...overrides,
  };
}

function buttonsOf(mounted: HTMLElement): HTMLButtonElement[] {
  return [...mounted.querySelectorAll('button')] as HTMLButtonElement[];
}

function buttonNamed(mounted: HTMLElement, name: RegExp): HTMLButtonElement {
  const found = buttonsOf(mounted).find((button) =>
    name.test(button.textContent ?? ''),
  );
  if (!found) throw new Error(`missing button ${String(name)}`);
  return found;
}

describe('embed presentation tolerance (defensive read)', () => {
  it('defaults absent presentation to preview and never crashes on unknown', () => {
    expect(resolveSurfaceEmbedPresentation(record()).mode).toBe('preview');
    expect(resolveSurfaceEmbedPresentation(record()).unknown).toBe(false);
    const unknown = resolveSurfaceEmbedPresentation(
      record({ presentation: { mode: 'hologram' } }),
    );
    expect(unknown.mode).toBe('preview');
    expect(unknown.unknown).toBe(true);
    expect(unknown.raw).toEqual({ mode: 'hologram' });
    expect(resolveSurfaceEmbedPresentation(record({ presentation: 'link' })).mode).toBe(
      'link',
    );
  });

  // parity matrix: keep identical across ui (here), whiteboard
  // `resource-embed.spec.ts`, and notebook `resource-embed.spec.ts`.
  it.each([
    [{}, 'preview', false],
    [{ presentation: 'preview' }, 'preview', false],
    [{ presentation: 'link' }, 'link', false],
    [{ presentation: { mode: 'preview' } }, 'preview', false],
    [{ presentation: { mode: 'link' } }, 'link', false],
    [{ presentation: 'hologram' }, 'preview', true],
    [{ presentation: { mode: 'hologram' } }, 'preview', true],
    [{ presentation: 42 }, 'preview', true],
    [{ presentation: null }, 'preview', true],
    [{ presentation: ['preview'] }, 'preview', true],
  ] as Array<[Record<string, unknown>, string, boolean]>)(
    'parity %j -> %s (unknown=%s)',
    (extra, mode, unknown) => {
      const resolved = resolveSurfaceEmbedPresentation(record({ ...extra }));
      expect(resolved.mode).toBe(mode);
      expect(resolved.unknown).toBe(unknown);
      if (unknown) expect(resolved.raw).toEqual(extra.presentation);
    },
  );
});

describe('ResourceEmbedCard activation', () => {
  it('exposes open / open-beside / copy-link / replace / remove as buttons', () => {
    const mounted = mount(
      createElement(ResourceEmbedCard, {
        record: record(),
        openResource: () => undefined,
        onReplace: () => undefined,
        onRemove: () => undefined,
      }),
    );
    const labels = buttonsOf(mounted).map((button) => button.textContent);
    for (const expected of ['Open', 'Open beside', 'Copy link', 'Replace', 'Remove']) {
      expect(labels.some((label) => label?.includes(expected))).toBe(true);
    }
    for (const button of buttonsOf(mounted)) {
      expect(button.tagName.toLowerCase()).toBe('button');
      expect(button.disabled).toBe(false);
    }
  });

  it('routes open and open-beside to the stable target identity', () => {
    const opened: ResourceTarget[] = [];
    const beside: ResourceTarget[] = [];
    const mounted = mount(
      createElement(ResourceEmbedCard, {
        record: record(),
        openResource: (target) => void opened.push(target),
        openBeside: (target) => void beside.push(target),
        onReplace: () => undefined,
        onRemove: () => undefined,
      }),
    );
    act(() => {
      buttonNamed(mounted, /^Open$/).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    act(() => {
      buttonNamed(mounted, /Open beside/).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    expect(opened).toEqual([
      { documentId: 'docA', kindId: 'froglight.markdown', resourceId: 'resA' },
    ]);
    expect(beside).toEqual([
      { documentId: 'docA', kindId: 'froglight.markdown', resourceId: 'resA' },
    ]);
  });

  it('falls back to open when no open-beside handler is wired', () => {
    const opened: ResourceTarget[] = [];
    const mounted = mount(
      createElement(ResourceEmbedCard, {
        record: record(),
        openResource: (target) => void opened.push(target),
        onReplace: () => undefined,
        onRemove: () => undefined,
      }),
    );
    act(() => {
      buttonNamed(mounted, /Open beside/).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    expect(opened).toHaveLength(1);
  });

  it('copy-link resolves to the same location via the stable codec', async () => {
    const seen: ResourceTarget[] = [];
    const mounted = mount(
      createElement(ResourceEmbedCard, {
        record: record(),
        openResource: () => undefined,
        onReplace: () => undefined,
        onRemove: () => undefined,
        copyLink: (target) => {
          seen.push(target);
          const text = formatResourceLink(target);
          expect(parseResourceLink(text)).toEqual(target);
          return true;
        },
      }),
    );
    await act(async () => {
      buttonNamed(mounted, /Copy link/).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    expect(seen).toEqual([
      { documentId: 'docA', kindId: 'froglight.markdown', resourceId: 'resA' },
    ]);
  });

  it('remove reports only the reference id and never auto-deletes dangling frames', () => {
    const removed: string[] = [];
    const mounted = mount(
      createElement(ResourceEmbedCard, {
        record: record(),
        dangling: true,
        openResource: () => undefined,
        onReplace: () => undefined,
        onRemove: (id) => void removed.push(id),
      }),
    );
    // Dangling renders a distinct dashed placeholder with replace/remove.
    const card = mounted.querySelector('[data-fl-component="resource-embed-card"]');
    expect(card?.getAttribute('data-dangling')).toBe('true');
    expect(mounted.querySelector('[role="status"]')?.textContent).toMatch(
      /kept|unavailable/i,
    );
    expect(removed).toEqual([]);
    act(() => {
      buttonNamed(mounted, /Remove/).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    expect(removed).toEqual(['embed-1']);
  });

  it('replace reports the reference id for picker reopen', () => {
    const replaced: string[] = [];
    const mounted = mount(
      createElement(ResourceEmbedCard, {
        record: record(),
        openResource: () => undefined,
        onReplace: (id) => void replaced.push(id),
        onRemove: () => undefined,
      }),
    );
    act(() => {
      buttonNamed(mounted, /Replace/).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    expect(replaced).toEqual(['embed-1']);
  });

  it('link presentation renders a chip with no preview mount and one open action', () => {
    const opened: ResourceTarget[] = [];
    const mounted = mount(
      createElement(ResourceEmbedCard, {
        record: record({ presentation: 'link' }),
        openResource: (target) => void opened.push(target),
        onReplace: () => undefined,
        onRemove: () => undefined,
      }),
    );
    const card = mounted.querySelector('[data-fl-component="resource-embed-card"]');
    expect(card?.getAttribute('data-presentation')).toBe('link');
    const chip = mounted.querySelector('.embed-chip, [class*="embed-chip"]');
    expect(chip).not.toBeNull();
    act(() => {
      (chip as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(opened).toHaveLength(1);
  });

  it('keeps every action keyboard-focusable with a visible focus target', () => {    const mounted = mount(
      createElement(ResourceEmbedCard, {
        record: record(),
        openResource: () => undefined,
        onReplace: () => undefined,
        onRemove: () => undefined,
      }),
    );
    for (const button of buttonsOf(mounted)) {
      expect(button.tabIndex).toBeGreaterThanOrEqual(0);
      button.focus();
      expect(document.activeElement).toBe(button);
    }
  });

  it('disables link-branch actions when the target is null', () => {
    const opened: ResourceTarget[] = [];
    const mounted = mount(
      createElement(ResourceEmbedCard, {
        record: record({ target: undefined, presentation: 'link' }),
        openResource: (target) => void opened.push(target),
        onReplace: () => undefined,
        onRemove: () => undefined,
      }),
    );
    const card = mounted.querySelector('[data-fl-component="resource-embed-card"]');
    expect(card?.getAttribute('data-presentation')).toBe('link');
    // Link branch mirrors the preview-branch null-target states: the chip
    // and every target-bound action disable; replace/remove stay live.
    const chip = mounted.querySelector(
      '.embed-chip, [class*="embed-chip"]',
    ) as HTMLButtonElement | null;
    expect(chip).not.toBeNull();
    expect(chip!.disabled).toBe(true);
    expect(buttonNamed(mounted, /Open beside/).disabled).toBe(true);
    expect(buttonNamed(mounted, /Copy link/).disabled).toBe(true);
    expect(buttonNamed(mounted, /Replace/).disabled).toBe(false);
    expect(buttonNamed(mounted, /Remove/).disabled).toBe(false);
    act(() => {
      chip!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(opened).toEqual([]);
  });

  it('renders a recoverable placeholder when the registry open throws', () => {
    const mounted = mount(
      createElement(ResourceEmbedCard, {
        record: record(),
        compositionRegistry: {
          open: () => {
            throw new Error('provider exploded');
          },
        } as never,
        openResource: () => undefined,
        onReplace: () => undefined,
        onRemove: () => undefined,
      }),
    );
    // The catch sets placeholder state: never stuck on permanent loading.
    expect(mounted.textContent).not.toMatch(/Loading preview/);
    const status = mounted.querySelector('[role="status"]');
    expect(status?.textContent).toMatch(/Preview unavailable/);
    expect(
      buttonsOf(mounted).some((button) => /Open source/.test(button.textContent ?? '')),
    ).toBe(true);
  });
});
