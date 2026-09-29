// @vitest-environment jsdom
import { act } from 'react';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { ViewDef } from '../view-registry.js';
import { ViewSlot } from './ViewSlot.jsx';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(view: ViewDef | undefined): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(createElement(ViewSlot, { view }));
  });
  return host;
}

function unmount(): void {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
}

afterEach(unmount);

describe('ViewSlot', () => {
  it('renders the registered component', () => {
    const view: ViewDef = {
      id: 'component-view',
      area: 'pane',
      title: 'Component',
      icon: 'file-image',
      description: 'attachments/photo.png',
      component: () => createElement('p', null, 'rendered by component'),
    };

    const mounted = mount(view);
    expect(mounted.textContent).toBe('rendered by component');
  });

  it('renders an empty host when no view is registered', () => {
    const mounted = mount(undefined);
    expect(mounted.textContent).toBe('');
  });
});
