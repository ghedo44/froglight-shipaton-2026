// @vitest-environment jsdom
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import {
  createDatabase,
  type CompositionPresentationHandle,
  type CompositionSnapshot,
  type JsonRecord,
} from '@froglight/foundation';
import { createDatabaseCompositionPresenter } from './DatabaseComposition.js';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

it('recovers a missing saved view through host configuration and keeps member writes source-owned', async () => {
  const model = createDatabase('Contacts');
  model.properties.push({
    id: 'region',
    name: 'Region',
    type: 'select',
    options: [{ id: 'eu', name: 'Europe' }],
  });
  model.properties.push({ id: 'priority', name: 'Priority', type: 'number' });
  const overrides = {
    vendor: { retained: true },
    filters: [{ property: '$title', operator: 'eq', value: 'Ada' }],
  };
  const data: JsonRecord = JSON.parse(
    JSON.stringify({ model, viewId: 'missing', overrides, rows: [] }),
  );
  const presentation = { type: 'froglight.database', data };
  const snapshot: CompositionSnapshot = {
    state: 'placeholder',
    reason: 'missing-view',
    message: 'The saved view was removed.',
    recoverable: true,
    presentation,
  };
  const parent = document.createElement('div');
  document.body.append(parent);
  const configure = vi.fn();
  const invoke = vi.fn(async () => undefined);
  let handle: CompositionPresentationHandle | null = null;
  try {
    await act(async () => {
      handle = createDatabaseCompositionPresenter().mount({
        parent,
        snapshot,
        readOnly: false,
        configure,
        invoke,
      });
    });
    expect(parent.textContent).toContain('The saved view was removed.');
    const saved = parent.querySelector<HTMLSelectElement>(
      '[aria-label="Linked saved view"]',
    )!;
    await act(async () => {
      saved.value = 'table';
      saved.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(configure).toHaveBeenLastCalledWith({ viewId: 'table' });
    expect(invoke).not.toHaveBeenCalled();
    const readyData: JsonRecord = JSON.parse(
      JSON.stringify({
        ...data,
        viewId: 'table',
        view: model.views[0]!,
        rows: [
          {
            resourceId: 'ada',
            title: 'Ada',
            path: 'Ada.md',
            kindId: 'froglight.markdown',
            values: {},
            diagnostics: {},
          },
        ],
      }),
    );
    const ready: CompositionSnapshot = {
      state: 'ready',
      presentation: { ...presentation, data: readyData },
    };
    await act(async () => handle!.update(ready, false));
    const column = parent.querySelector<HTMLSelectElement>(
      '[aria-label="Region column options"]',
    )!;
    await act(async () => {
      column.value = 'right';
      column.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(configure).toHaveBeenLastCalledWith({
      overrides: { ...overrides, visibleProperties: ['priority', 'region'] },
    });
    const resize = parent.querySelector<HTMLButtonElement>(
      '[aria-label="Resize Region column"]',
    )!;
    await act(async () => {
      resize.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      );
    });
    expect(configure).toHaveBeenLastCalledWith({
      overrides: { ...overrides, columnWidths: { region: 216 } },
    });
    expect(invoke).not.toHaveBeenCalled();
    const layout = [...parent.querySelectorAll('select')].find((select) =>
      select.parentElement?.textContent?.startsWith('Local layout'),
    )!;
    await act(async () => {
      layout.value = 'gallery';
      layout.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(configure).toHaveBeenLastCalledWith({
      overrides: { ...overrides, type: 'gallery' },
    });
    await act(async () => {
      parent
        .querySelector<HTMLButtonElement>('[aria-label^="Edit Region:"]')!
        .click();
    });
    const region = parent.querySelector<HTMLSelectElement>(
      '[aria-label="Region"]',
    )!;
    configure.mockClear();
    await act(async () => {
      region.value = 'eu';
      region.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(invoke).toHaveBeenCalledWith('write-property', {
      resourceId: 'ada',
      propertyId: 'region',
      value: 'eu',
      expectedValue: null,
    });
    expect(configure).not.toHaveBeenCalled();
    await act(async () => handle!.update(ready, true));
    expect(
      parent.querySelector<HTMLSelectElement>(
        '[aria-label="Linked saved view"]',
      )!.disabled,
    ).toBe(true);
    expect(parent.querySelector('[aria-label="Region"]')).toBeNull();
  } finally {
    await act(async () => {
      handle?.dispose();
      handle?.dispose();
    });
    parent.remove();
  }
});

it('preserves the focused multiselect through pending linked writes and the next edit', async () => {
  const model = createDatabase('Topics');
  model.properties.push({
    id: 'tags',
    name: 'Tags',
    type: 'multi-select',
    options: [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ],
  });
  const snapshot = (tags: string[]): CompositionSnapshot => ({
    state: 'ready',
    presentation: {
      type: 'froglight.database',
      data: JSON.parse(
        JSON.stringify({
          model,
          view: model.views[0],
          viewId: 'table',
          rows: [
            {
              resourceId: 'note',
              title: 'Note',
              path: 'Note.md',
              kindId: 'note',
              values: { tags },
              diagnostics: {},
            },
          ],
        }),
      ),
    },
  });
  const releases: (() => void)[] = [];
  const invoke = vi.fn(
    () => new Promise<void>((resolve) => releases.push(resolve)),
  );
  const parent = document.createElement('div');
  document.body.append(parent);
  let handle: CompositionPresentationHandle | null = null;
  try {
    await act(async () => {
      handle = createDatabaseCompositionPresenter().mount({
        parent,
        snapshot: snapshot([]),
        readOnly: false,
        invoke,
      });
    });
    await act(async () => {
      parent
        .querySelector<HTMLButtonElement>('[aria-label^="Edit Tags:"]')!
        .click();
    });
    const select = parent.querySelector<HTMLSelectElement>(
      '[aria-label="Tags"]',
    )!;
    select.focus();
    await act(async () => {
      select.options[0]!.selected = true;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(parent.querySelector('[aria-label="Tags"]')).toBe(select);
    expect(document.activeElement).toBe(select);
    await act(async () => {
      handle!.update(snapshot(['a']), false);
      releases.shift()!();
    });
    expect(document.activeElement).toBe(select);
    await act(async () => {
      select.options[1]!.selected = true;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(invoke).toHaveBeenLastCalledWith('write-property', {
      resourceId: 'note',
      propertyId: 'tags',
      value: ['a', 'b'],
      expectedValue: ['a'],
    });
    expect(document.activeElement).toBe(select);
    await act(async () => {
      releases.shift()!();
    });
  } finally {
    await act(async () => handle?.dispose());
    parent.remove();
  }
});

it('retains a failed cell draft and retries the same source write', async () => {
  const model = createDatabase('Notes');
  model.properties.push({ id: 'summary', name: 'Summary', type: 'text' });
  const snapshot: CompositionSnapshot = {
    state: 'ready',
    presentation: {
      type: 'froglight.database',
      data: JSON.parse(
        JSON.stringify({
          model,
          view: model.views[0],
          viewId: 'table',
          rows: [
            {
              resourceId: 'note',
              title: 'Note',
              path: 'Note.md',
              kindId: 'froglight.markdown',
              values: { summary: 'Before' },
              diagnostics: {},
            },
          ],
        }),
      ),
    },
  };
  const invoke = vi
    .fn()
    .mockRejectedValueOnce(new Error('injected save failure'))
    .mockResolvedValue(undefined);
  const parent = document.createElement('div');
  document.body.append(parent);
  let handle: CompositionPresentationHandle | null = null;
  try {
    await act(async () => {
      handle = createDatabaseCompositionPresenter().mount({
        parent,
        snapshot,
        readOnly: false,
        invoke,
      });
    });
    await act(async () => {
      parent
        .querySelector<HTMLButtonElement>('[aria-label^="Edit Summary:"]')!
        .click();
    });
    const input = parent.querySelector<HTMLInputElement>(
      '[aria-label="Summary"]',
    )!;
    await act(async () => {
      input.value = 'Retained draft';
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(parent.textContent).toContain(
      'Could not save: injected save failure',
    );
    expect(
      parent.querySelector<HTMLInputElement>('[aria-label="Summary"]')?.value,
    ).toBe('Retained draft');
    await act(async () => {
      [...parent.querySelectorAll('button')]
        .find((button) => button.textContent === 'Retry')
        ?.click();
    });
    expect(invoke).toHaveBeenLastCalledWith('write-property', {
      resourceId: 'note',
      propertyId: 'summary',
      value: 'Retained draft',
      expectedValue: 'Before',
    });
    expect(parent.textContent).not.toContain('Could not save');
  } finally {
    await act(async () => handle?.dispose());
    parent.remove();
  }
});

it('bounds rendered rows while allowing keyboard and touch users to reveal more', async () => {
  const model = createDatabase('Large collection');
  const rows = Array.from({ length: 5_000 }, (_, index) => ({
    resourceId: `note-${index}`,
    title: `Note ${index}`,
    path: `Notes/${index}.md`,
    kindId: 'froglight.markdown',
    values: {},
    diagnostics: {},
  }));
  const snapshot: CompositionSnapshot = {
    state: 'ready',
    presentation: {
      type: 'froglight.database',
      data: JSON.parse(
        JSON.stringify({ model, view: model.views[0], viewId: 'table', rows }),
      ),
    },
  };
  const parent = document.createElement('div');
  document.body.append(parent);
  let handle: CompositionPresentationHandle | null = null;
  try {
    await act(async () => {
      handle = createDatabaseCompositionPresenter().mount({
        parent,
        snapshot,
        readOnly: true,
        invoke: vi.fn(async () => undefined),
      });
    });
    expect(parent.querySelectorAll('tbody tr')).toHaveLength(100);
    const more = [...parent.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Show 100 more'),
    )!;
    await act(async () => more.click());
    expect(parent.querySelectorAll('tbody tr')).toHaveLength(200);
    expect(parent.textContent).toContain('Showing 200 of 5000 documents');
  } finally {
    await act(async () => handle?.dispose());
    parent.remove();
  }
});

it('edits typed local filters and ordered presentation controls without writing the source', async () => {
  const model = createDatabase('Projects');
  model.properties.push(
    { id: 'priority', name: 'Priority', type: 'number' },
    {
      id: 'status',
      name: 'Status',
      type: 'select',
      options: [
        { id: 'todo', name: 'To do' },
        { id: 'done', name: 'Done' },
      ],
    },
    { id: 'starts', name: 'Starts', type: 'date' },
    { id: 'ends', name: 'Ends', type: 'date' },
  );
  model.views[0] = {
    ...model.views[0]!,
    type: 'timeline',
    sorts: [{ property: '$title' }],
  };
  const overrides = {
    vendor: { retained: true },
    filters: [{ property: 'status', operator: 'eq', value: 'todo' }],
  };
  const snapshot: CompositionSnapshot = {
    state: 'ready',
    presentation: {
      type: 'froglight.database',
      data: JSON.parse(
        JSON.stringify({
          model,
          view: model.views[0],
          viewId: 'table',
          overrides,
          rows: [],
        }),
      ),
    },
  };
  const configure = vi.fn();
  const invoke = vi.fn(async () => undefined);
  const parent = document.createElement('div');
  document.body.append(parent);
  let handle: CompositionPresentationHandle | null = null;
  try {
    await act(async () => {
      handle = createDatabaseCompositionPresenter().mount({
        parent,
        snapshot,
        readOnly: false,
        configure,
        invoke,
      });
    });
    expect(parent.textContent).toContain('Status is To do');
    await act(async () => {
      parent
        .querySelector<HTMLButtonElement>('[aria-label="Edit local filter 1"]')!
        .click();
    });
    const property = parent.querySelector<HTMLSelectElement>(
      '[aria-label="Local filter property"]',
    )!;
    await act(async () => {
      property.value = 'starts';
      property.dispatchEvent(new Event('change', { bubbles: true }));
    });
    let operator = parent.querySelector<HTMLSelectElement>(
      '[aria-label="Local filter operator"]',
    )!;
    expect([...operator.options].map((option) => option.value)).toContain(
      'date-relative',
    );
    await act(async () => {
      operator.value = 'date-relative';
      operator.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const relative = parent.querySelector<HTMLSelectElement>(
      '[aria-label="Local filter value"]',
    )!;
    await act(async () => {
      relative.value = 'next-7-days';
      relative.dispatchEvent(new Event('change', { bubbles: true }));
      relative
        .closest('form')!
        .dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        );
    });
    expect(configure).toHaveBeenLastCalledWith({
      overrides: {
        ...overrides,
        filters: [
          {
            property: 'starts',
            operator: 'date-relative',
            value: 'next-7-days',
          },
        ],
      },
    });
    configure.mockClear();
    await act(async () => {
      parent
        .querySelector<HTMLButtonElement>('[aria-label="Edit local filter 1"]')!
        .click();
    });
    const numericProperty = parent.querySelector<HTMLSelectElement>(
      '[aria-label="Local filter property"]',
    )!;
    await act(async () => {
      numericProperty.value = 'priority';
      numericProperty.dispatchEvent(new Event('change', { bubbles: true }));
    });
    operator = parent.querySelector<HTMLSelectElement>(
      '[aria-label="Local filter operator"]',
    )!;
    expect([...operator.options].map((option) => option.value)).toEqual([
      'eq',
      'neq',
      'gt',
      'lt',
      'empty',
    ]);
    const value = parent.querySelector<HTMLInputElement>(
      '[aria-label="Local filter value"]',
    )!;
    await act(async () => {
      operator.value = 'gt';
      operator.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(value, '3');
      value.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      value
        .closest('form')!
        .dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        );
    });
    expect(configure).toHaveBeenLastCalledWith({
      overrides: {
        ...overrides,
        filters: [{ property: 'priority', operator: 'gt', value: 3 }],
      },
    });
    configure.mockClear();
    const descending = parent.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )!;
    await act(async () => {
      descending.click();
    });
    expect(configure).toHaveBeenLastCalledWith({
      overrides: {
        ...overrides,
        sorts: [{ property: '$title', descending: true }],
      },
    });
    const grouping = parent.querySelector<HTMLSelectElement>(
      '[aria-label="Local grouping"]',
    )!;
    await act(async () => {
      grouping.value = 'status';
      grouping.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(configure).toHaveBeenLastCalledWith({
      overrides: { ...overrides, groupBy: 'status' },
    });
    const start = parent.querySelector<HTMLSelectElement>(
      '[aria-label="Local start date"]',
    )!;
    await act(async () => {
      start.value = 'starts';
      start.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(configure).toHaveBeenLastCalledWith({
      overrides: { ...overrides, dateProperty: 'starts' },
    });
    await act(async () => {
      [...parent.querySelectorAll('button')]
        .find((button) => button.textContent === 'Add condition group')
        ?.click();
    });
    const match = [...parent.querySelectorAll('select')].find((select) =>
      select.parentElement?.textContent?.startsWith('Match'),
    )!;
    await act(async () => {
      match.value = 'or';
      match.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
      [...parent.querySelectorAll('button')]
        .find((button) => button.textContent === 'Save local condition groups')
        ?.click();
    });
    expect(configure).toHaveBeenLastCalledWith({
      overrides: {
        ...overrides,
        where: {
          operator: 'or',
          filters: [{ property: '$title', operator: 'eq', value: '' }],
        },
      },
    });
    expect(invoke).not.toHaveBeenCalled();
  } finally {
    await act(async () => handle?.dispose());
    parent.remove();
  }
});

it('keeps two linked instances independent and offers recovery from empty local results', async () => {
  const model = createDatabase('Reading list');
  const makeSnapshot = (type: string): CompositionSnapshot => ({
    state: 'ready',
    presentation: {
      type: 'froglight.database',
      data: JSON.parse(
        JSON.stringify({
          model,
          view: { ...model.views[0], type },
          viewId: 'table',
          overrides: {
            type,
            filters: [{ property: '$title', operator: 'eq', value: 'Missing' }],
          },
          rows: [],
        }),
      ),
    },
  });
  const firstParent = document.createElement('div');
  const secondParent = document.createElement('div');
  document.body.append(firstParent, secondParent);
  const firstConfigure = vi.fn();
  const secondConfigure = vi.fn();
  const invoke = vi.fn(async () => undefined);
  let first: CompositionPresentationHandle | null = null;
  let second: CompositionPresentationHandle | null = null;
  try {
    await act(async () => {
      first = createDatabaseCompositionPresenter().mount({
        parent: firstParent,
        snapshot: makeSnapshot('table'),
        readOnly: false,
        configure: firstConfigure,
        invoke,
      });
      second = createDatabaseCompositionPresenter().mount({
        parent: secondParent,
        snapshot: makeSnapshot('gallery'),
        readOnly: false,
        configure: secondConfigure,
        invoke,
      });
    });
    expect(
      firstParent.querySelector<HTMLSelectElement>(
        '[aria-label="Local layout"]',
      )?.value,
    ).toBe('table');
    expect(
      secondParent.querySelector<HTMLSelectElement>(
        '[aria-label="Local layout"]',
      )?.value,
    ).toBe('gallery');
    const clear = [...firstParent.querySelectorAll('button')].find(
      (button) =>
        button.textContent === 'Clear local filters' &&
        button.closest('details') === null,
    )!;
    await act(async () => clear.click());
    expect(firstConfigure).toHaveBeenCalledWith({
      overrides: { type: 'table', filters: [] },
    });
    expect(secondConfigure).not.toHaveBeenCalled();
  } finally {
    await act(async () => {
      first?.dispose();
      second?.dispose();
    });
    firstParent.remove();
    secondParent.remove();
  }
});
