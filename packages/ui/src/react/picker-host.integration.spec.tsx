// @vitest-environment jsdom
/**
 * Picker → host integration through the public UI React entry. Hosts
 * (whiteboard/notebook) consume the picker model,
 * dialog, link codec, presentation helper, and activation card through
 * `@froglight/ui/react` only — never deep paths — so this spec imports the
 * whole flow from `./index.js` (the react barrel): a dialog pick produces a
 * stable `ResourceTarget` that the host inserts at the expected position,
 * and a dangling target renders the placeholder card with identity kept.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  emptySurface,
  infiniteFrame,
  resourceEmbedObject,
  type ResourceSuggestion,
} from '@froglight/foundation';
import {
  activeSuggestion,
  filterSuggestions,
  formatResourceLink,
  parseResourceLink,
  ResourceEmbedCard,
  ResourcePicker,
} from './index.js';

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

function unmount(): void {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
}

afterEach(() => {
  unmount();
});

const SUGGESTIONS: readonly ResourceSuggestion[] = [
  {
    target: {
      documentId: 'docA',
      kindId: 'froglight.markdown',
      resourceId: 'resA',
    },
    label: 'Source doc',
  },
  {
    target: {
      documentId: 'docB',
      kindId: 'froglight.markdown',
      resourceId: 'resB',
    },
    label: 'Other doc',
  },
];

function buttonsOf(mounted: HTMLElement): HTMLButtonElement[] {
  return [...mounted.querySelectorAll('button')] as HTMLButtonElement[];
}

describe('picker → host integration (public react entry)', () => {
  it('a dialog pick yields a stable target the host inserts at the expected position', () => {
    // The host resolves the pick through the shared model contract first.
    const visible = filterSuggestions('', SUGGESTIONS);
    expect(activeSuggestion(visible, 0)?.label).toBe('Source doc');

    // The dialog commits through a real option button (pointer/touch path).
    const picked: ResourceSuggestion[] = [];
    const mounted = mount(
      createElement(ResourcePicker, {
        suggestions: SUGGESTIONS,
        onPick: (suggestion) => void picked.push(suggestion),
        onClose: () => undefined,
      }),
    );
    const option = buttonsOf(mounted).find(
      (button) => button.getAttribute('role') === 'option' && button.textContent === 'Source doc',
    );
    if (option === undefined) throw new Error('missing Source doc option');
    act(() => {
      option.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(picked).toHaveLength(1);
    const target = picked[0]!.target;

    // The host inserts the picked target at the expected surface position
    // with stable identity only (never a browser URL).
    const model = emptySurface(infiniteFrame());
    const id = 'embed-1';
    model.objects[id] = resourceEmbedObject(id, {
      x: 120,
      y: 80,
      width: 480,
      height: 320,
      target: { ...target },
      cachedTitle: picked[0]!.label,
    });
    model.order.push(id);
    expect(model.order).toContain(id);
    expect(model.objects[id]).toMatchObject({
      type: 'froglight.resource-embed',
      x: 120,
      y: 80,
      target,
    });
    expect(JSON.stringify(model.objects[id])).not.toContain('http');

    // Copy-link round-trips to the same location (stable identity only).
    expect(parseResourceLink(formatResourceLink(target))).toEqual(target);
  });

  it('a dangling target renders the placeholder card with identity kept', () => {
    const removed: string[] = [];
    const mounted = mount(
      createElement(ResourceEmbedCard, {
        record: {
          id: 'embed-1',
          type: 'froglight.resource-embed',
          target: {
            documentId: 'docA',
            kindId: 'froglight.markdown',
            resourceId: 'resA',
          },
          cachedTitle: 'Source doc',
        },
        dangling: true,
        openResource: () => undefined,
        onReplace: () => undefined,
        onRemove: (id) => void removed.push(id),
      }),
    );
    const card = mounted.querySelector(
      '[data-fl-component="resource-embed-card"]',
    );
    expect(card?.getAttribute('data-dangling')).toBe('true');
    // Identity is kept for the placeholder: the cached title still labels
    // the reference and the kept-link message is shown.
    expect(card?.textContent).toContain('Source doc');
    expect(mounted.querySelector('[role="status"]')?.textContent).toMatch(
      /kept/,
    );
    // Remove reports only the reference id (never target content).
    expect(removed).toEqual([]);
    act(() => {
      const remove = buttonsOf(mounted).find(
        (button) => button.textContent === 'Remove',
      );
      if (remove === undefined) throw new Error('missing Remove button');
      remove.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(removed).toEqual(['embed-1']);
  });
});
