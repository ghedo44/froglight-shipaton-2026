// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { ViewDef } from '../view-registry.js';
import type { SearchUiResult } from '../search-ui.js';
import { SearchView } from './SearchView.jsx';
import { ViewSlot } from './ViewSlot.jsx';
import styles from './SearchView.module.css';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

interface SearchHarness {
  readonly onSearchCalls: string[];
  readonly opened: { id: string; address?: string }[];
  readonly backgroundOpened: { id: string; address?: string }[];
  onSearch: (query: string) => Promise<readonly SearchUiResult[]>;
  onOpen: (id: string, address?: string) => void;
  onOpenBackground: (id: string, address?: string) => void;
}

const FIXTURE_RESULTS: readonly SearchUiResult[] = [
  {
    documentId: 'doc-1',
    title: 'The quick brown fox',
    excerpt: 'lives in notes/welcome.md',
    matchedIn: 'content',
  },
  {
    documentId: 'doc-2',
    title: 'todo.md',
    excerpt: 'todo.md',
    matchedIn: 'filename',
  },
];

function stubHarness(
  resolveWith: readonly SearchUiResult[] = FIXTURE_RESULTS,
): SearchHarness {
  const harness: SearchHarness = {
    onSearchCalls: [],
    opened: [],
    backgroundOpened: [],
    onSearch: async (query: string) => {
      harness.onSearchCalls.push(query);
      return resolveWith;
    },
    onOpen: (id: string, address?: string) => {
      harness.opened.push(
        address === undefined ? { id } : { id, address },
      );
    },
    onOpenBackground: (id: string, address?: string) => {
      harness.backgroundOpened.push(
        address === undefined ? { id } : { id, address },
      );
    },
  };
  return harness;
}

function searchView(harness: SearchHarness): ViewDef {
  return {
    id: 'search',
    area: 'sidebar',
    title: 'Search',
    component: () =>
      createElement(SearchView, {
        // Late-bound: specs replace harness.onSearch between queries.
        onSearch: (query: string) => harness.onSearch(query),
        onOpen: harness.onOpen,
        onOpenBackground: harness.onOpenBackground,
      }),
  };
}

async function mountSearch(harness: SearchHarness): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(createElement(ViewSlot, { view: searchView(harness) }));
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

function queryInput(): HTMLInputElement {
  const input = host?.querySelector<HTMLInputElement>(
    `.${styles['search-field']} input`,
  );
  if (input === null || input === undefined)
    throw new Error('search input missing');
  return input;
}

async function setQuery(value: string): Promise<void> {
  const input = queryInput();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )?.set;
    if (setter === undefined) throw new Error('no input value setter');
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function settleSearch(ms = 220): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  });
}

async function pressKey(key: string): Promise<void> {
  const input = queryInput();
  await act(async () => {
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true }),
    );
  });
}

async function clickSelector(selector: string): Promise<HTMLElement> {
  const element = host?.querySelector<HTMLElement>(selector);
  if (element === null || element === undefined)
    throw new Error(`no element matches ${selector}`);
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  return element;
}

describe('search React view (ViewSlot seam)', () => {
  it('maps every asserted class through the CSS module', () => {
    for (const name of [
      'search-panel',
      'explorer-header',
      'sidebar-heading',
      'search-field',
      'search-field-icon',
      'search-clear',
      'search-results',
      'search-count',
      'search-section',
      'result',
      'title',
      'excerpt',
      'search-empty',
      'search-hint',
      'visible',
      'selected',
    ]) {
      expect(styles[name], `module class ${name}`).toMatch(/\S/);
    }
  });

  it('renders the frozen panel structure with hint and hidden clear', async () => {
    const harness = stubHarness();
    const mounted = await mountSearch(harness);
    expect(
      mounted.querySelector(
        `.${styles['search-panel']} .${styles['explorer-header']} .${styles['sidebar-heading']}`,
      )?.textContent,
    ).toBe('Search');
    const field = mounted.querySelector(`.${styles['search-field']}`);
    expect(field).not.toBeNull();
    expect(
      field?.querySelector(`.${styles['search-field-icon']} svg`),
    ).not.toBeNull();
    const input = mounted.querySelector<HTMLInputElement>(
      `.${styles['search-field']} input`,
    );
    expect(input?.placeholder).toBe('Search files and content…');
    expect(input?.getAttribute('aria-label')).toBe('Search workspace');
    expect(input?.autocomplete).toBe('off');
    expect(input?.spellcheck).toBe(false);
    const clear = mounted.querySelector(`.${styles['search-clear']}`);
    expect(clear?.getAttribute('aria-label')).toBe('Clear search');
    expect(clear?.classList.contains(styles.visible)).toBe(false);
    expect(
      mounted.querySelector(
        `.${styles['search-results']} .${styles['search-hint']}`,
      )?.textContent,
    ).toContain('Middle-click opens a note in a new tab');
  });

  it('reveals the clear button while typing and clears on click', async () => {
    const harness = stubHarness([]);
    await mountSearch(harness);
    await setQuery('hello');
    expect(
      host
        ?.querySelector(`.${styles['search-clear']}`)
        ?.classList.contains(styles.visible),
    ).toBe(true);
    await clickSelector(`.${styles['search-clear']}`);
    expect(queryInput().value).toBe('');
    expect(
      host
        ?.querySelector(`.${styles['search-clear']}`)
        ?.classList.contains(styles.visible),
    ).toBe(false);
    expect(host?.querySelector(`.${styles['search-empty']}`)).toBeNull();
    expect(host?.querySelector(`.${styles['search-count']}`)).toBeNull();
  });

  it('debounces input and renders count, sections, and rows in order', async () => {
    const harness = stubHarness();
    await mountSearch(harness);
    await setQuery('quick');
    expect(harness.onSearchCalls).toEqual([]);
    await settleSearch();
    expect(harness.onSearchCalls).toEqual(['quick']);
    expect(
      host?.querySelector(`.${styles['search-count']}`)?.textContent,
    ).toBe('2 results in this vault');
    const sections = [
      ...host!.querySelectorAll(`.${styles['search-section']}`),
    ].map((element) => element.textContent);
    expect(sections).toEqual(['Content', 'File names']);
    const rows = host!.querySelectorAll(
      `.${styles['search-panel']} .${styles.result}`,
    );
    expect(rows.length).toBe(2);
    expect(
      rows[0]?.querySelector(`.${styles.title}`)?.innerHTML,
    ).toBe('The <mark>quick</mark> brown fox');
  });

  it('coalesces rapid keystrokes into a single trimmed search', async () => {
    const harness = stubHarness([]);
    await mountSearch(harness);
    await setQuery('  a');
    await setQuery('  ab  ');
    await settleSearch();
    expect(harness.onSearchCalls).toEqual(['ab']);
  });

  it('renders the empty state with an escaped query', async () => {
    const harness = stubHarness([]);
    await mountSearch(harness);
    await setQuery('a & b <c>');
    await settleSearch();
    const empty = host?.querySelector(`.${styles['search-empty']}`);
    expect(empty?.innerHTML).toBe(
      'No results for <strong>a &amp; b &lt;c&gt;</strong>',
    );
  });

  it('marks matches and escapes HTML like highlightMatches', async () => {
    const harness = stubHarness([
      {
        documentId: 'doc-html',
        title: '<img src=x onerror=y>',
        excerpt: 'a & b',
        matchedIn: 'content',
      },
    ]);
    harness.onSearch = async (query: string) => {
      harness.onSearchCalls.push(query);
      return [
        {
          documentId: 'doc-html',
          title: '<img src=x onerror=y>',
          excerpt: 'a & b',
          matchedIn: 'content' as const,
        },
      ];
    };
    await mountSearch(harness);
    await setQuery('img');
    await settleSearch();
    const titleHtml = host?.querySelector(
      `.${styles.result} .${styles.title}`,
    )?.innerHTML;
    expect(titleHtml).toContain('&lt;<mark>img</mark>');
    expect(titleHtml).not.toContain('<img');
    await clickSelector(`.${styles['search-clear']}`);
    harness.onSearch = async (query: string) => {
      harness.onSearchCalls.push(query);
      return [
        {
          documentId: 'doc-amp',
          title: 'a & b',
          excerpt: 'a & b',
          matchedIn: 'content' as const,
        },
      ];
    };
    await setQuery('& b');
    await settleSearch();
    expect(
      host?.querySelector(`.${styles.result} .${styles.title}`)?.innerHTML,
    ).toBe('a <mark>&amp;</mark> <mark>b</mark>');
  });

  it('opens on click with address and background-opens on middle-click', async () => {
    const results: readonly SearchUiResult[] = [
      {
        documentId: 'doc-9',
        title: 'Notebook',
        excerpt: 'excerpt',
        address: 'page-2',
        matchedIn: 'content',
      },
    ];
    const harness = stubHarness(results);
    await mountSearch(harness);
    await setQuery('note');
    await settleSearch();
    await clickSelector(`.${styles['search-panel']} .${styles.result}`);
    expect(harness.opened).toEqual([{ id: 'doc-9', address: 'page-2' }]);
    const row = host?.querySelector<HTMLElement>(
      `.${styles['search-panel']} .${styles.result}`,
    );
    if (row === null || row === undefined)
      throw new Error('result row missing');
    await act(async () => {
      row.dispatchEvent(
        new MouseEvent('auxclick', { bubbles: true, button: 1 }),
      );
    });
    expect(harness.backgroundOpened).toEqual([
      { id: 'doc-9', address: 'page-2' },
    ]);
  });

  it('navigates with arrows and opens over Enter without an address', async () => {
    const results: readonly SearchUiResult[] = [
      {
        documentId: 'doc-a',
        title: 'Alpha note',
        excerpt: 'alpha',
        address: 'page-a',
        matchedIn: 'content',
      },
      {
        documentId: 'doc-b',
        title: 'Beta note',
        excerpt: 'beta',
        address: 'page-b',
        matchedIn: 'content',
      },
    ];
    const harness = stubHarness(results);
    await mountSearch(harness);
    await setQuery('note');
    await settleSearch();
    await pressKey('ArrowDown');
    expect(
      host
        ?.querySelectorAll(`.${styles['search-panel']} .${styles.result}`)[0]
        ?.classList.contains(styles.selected),
    ).toBe(true);
    await pressKey('ArrowDown');
    expect(
      host
        ?.querySelectorAll(`.${styles['search-panel']} .${styles.result}`)[1]
        ?.classList.contains(styles.selected),
    ).toBe(true);
    await pressKey('ArrowUp');
    expect(
      host
        ?.querySelectorAll(`.${styles['search-panel']} .${styles.result}`)[0]
        ?.classList.contains(styles.selected),
    ).toBe(true);
    await pressKey('Enter');
    expect(harness.opened).toEqual([{ id: 'doc-a' }]);
  });

  it('clears and blurs on Escape', async () => {
    const harness = stubHarness([]);
    await mountSearch(harness);
    await setQuery('hello');
    queryInput().focus();
    await pressKey('Escape');
    expect(queryInput().value).toBe('');
    expect(document.activeElement).not.toBe(queryInput());
    expect(
      host
        ?.querySelector(`.${styles['search-clear']}`)
        ?.classList.contains(styles.visible),
    ).toBe(false);
  });

  it('mounts through the component seam with focus and dispose', async () => {
    const harness = stubHarness([]);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const slotRoot = createRoot(container);
    await act(async () => {
      slotRoot.render(
        createElement(ViewSlot, {
          view: {
            id: 'search',
            area: 'sidebar',
            title: 'Search',
            component: () =>
              createElement(SearchView, {
                onSearch: (query: string) => harness.onSearch(query),
                onOpen: harness.onOpen,
                onOpenBackground: harness.onOpenBackground,
              }),
          },
        }),
      );
    });
    expect(
      container.querySelector(
        `.${styles['search-panel']} .${styles['explorer-header']} .${styles['sidebar-heading']}`,
      )?.textContent,
    ).toBe('Search');
    expect(
      container.querySelector(
        `.${styles['search-results']} .${styles['search-hint']}`,
      ),
    ).not.toBeNull();
    const input = container.querySelector<HTMLInputElement>(
      `.${styles['search-field']} input`,
    );
    await act(async () => {
      input?.focus();
    });
    expect(document.activeElement).toBe(input);
    await act(async () => {
      slotRoot.unmount();
    });
    container.remove();
  });
});
