// @vitest-environment jsdom
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { InstalledUi } from '../../../workbench.js';
import { PaneHeader, type PaneHeaderActions } from './PaneHeader.jsx';

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

function views(): InstalledUi['views'] {
  return {
    get: () => undefined,
    list: () => [],
    onDidChange: () => ({ dispose: () => undefined }),
  } as unknown as InstalledUi['views'];
}

function baseModel(): {
  mode: 'edit' | 'split' | 'reading';
  availableModes: readonly ('edit' | 'split' | 'reading')[];
  canGoBack: boolean;
  canGoForward: boolean;
  isDocument: boolean;
  hasActiveTab: boolean;
} {
  return {
    mode: 'edit',
    availableModes: ['edit', 'reading'],
    canGoBack: false,
    canGoForward: false,
    isDocument: true,
    hasActiveTab: true,
  };
}

function actions(): PaneHeaderActions {
  return {
    onGoBack: () => undefined,
    onGoForward: () => undefined,
    onPaneContextMenu: () => undefined,
    onSetMode: () => undefined,
    onOpenNoteMenu: () => undefined,
  };
}

function renderHeader(
  model: ReturnType<typeof baseModel> = baseModel(),
  acts: PaneHeaderActions = actions(),
): HTMLElement {
  return mount(
    createElement(
      Fragment,
      null,
      createElement(PaneHeader, {
        model,
        actions: acts,
        views: views(),
        allowVisibleSplit: true,
      }),
    ),
  );
}

function group(): HTMLElement | null {
  return host?.querySelector('[role="group"]') ?? null;
}

function buttons(): HTMLButtonElement[] {
  return [
    ...(host?.querySelectorAll<HTMLButtonElement>('[role="group"] button') ??
      []),
  ];
}

describe('PaneHeader', () => {
  it('groups document presentation and actions in the pane toolbar', () => {
    renderHeader();
    expect(group()).toBeNull();
    expect(buttons()).toEqual([]);
    expect(host?.querySelector('[aria-label="Note actions"]')).not.toBeNull();
    expect(
      host?.querySelector('[aria-label="Document view: Edit"]'),
    ).not.toBeNull();
  });

  it('omits the strip when a view has no document controls or history', () => {
    renderHeader({ ...baseModel(), isDocument: false });
    expect(
      host?.querySelector('[data-fl-component="document-toolbar"]'),
    ).toBeNull();
  });
});
