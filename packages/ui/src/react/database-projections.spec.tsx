// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { createDatabase, resourceId } from '@froglight/foundation';
import { Cell, DatabaseContent } from './DatabaseContent.js';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

it('presents relation titles while committing stable IDs and retaining unavailable targets', async () => {
  const parent = document.createElement('div');
  document.body.append(parent);
  const root = createRoot(parent);
  const onWrite = vi.fn();
  const property = { id: 'related', name: 'Contacts', type: 'relation' };
  const choices = [{ id: resourceId('ada'), title: 'Ada Lovelace' }];
  try {
    await act(async () =>
      root.render(
        <Cell
          property={property}
          value={['missing']}
          choices={choices}
          readOnly={false}
          onWrite={onWrite}
        />,
      ),
    );
    const select = parent.querySelector('select')!;
    expect([...select.options].map((option) => option.text)).toEqual([
      'Ada Lovelace',
      'Unavailable resource (missing)',
    ]);
    await act(async () => {
      select.options[0]!.selected = true;
      select.options[1]!.selected = false;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onWrite).toHaveBeenCalledWith(['ada']);
    await act(async () =>
      root.render(
        <Cell
          property={property}
          value={['ada']}
          choices={choices}
          readOnly
          onWrite={onWrite}
        />,
      ),
    );
    expect(parent.textContent).toBe('Ada Lovelace');
  } finally {
    await act(async () => root.unmount());
    parent.remove();
  }
});

it('preserves unknown property values without exposing an unsafe fallback editor', async () => {
  const parent = document.createElement('div');
  document.body.append(parent);
  const root = createRoot(parent);
  const onWrite = vi.fn();
  try {
    await act(async () =>
      root.render(
        <Cell
          property={{ id: 'custom', name: 'Custom', type: 'plugin.custom' }}
          value={{ retained: true }}
          readOnly={false}
          onWrite={onWrite}
        />,
      ),
    );
    expect(parent.querySelector('input, select')).toBeNull();
    expect(parent.textContent).toBe('{"retained":true}');
    expect(parent.querySelector('span')?.title).toBe(
      'Property editor unavailable for plugin.custom',
    );
    expect(onWrite).not.toHaveBeenCalled();
    const model = createDatabase('Custom properties');
    model.properties.push({
      id: 'custom',
      name: 'Custom',
      type: 'plugin.custom',
    });
    await act(async () =>
      root.render(
        <DatabaseContent
          model={model}
          view={model.views[0]}
          rows={[
            {
              resourceId: resourceId('custom-row'),
              title: 'Custom row',
              path: 'Custom.md',
              kindId: 'froglight.markdown',
              values: { custom: { retained: true } },
              diagnostics: {},
            },
          ]}
          readOnly={false}
          write={onWrite}
          openResource={() => undefined}
        />,
      ),
    );
    expect(parent.querySelector('[aria-label^="Edit Custom:"]')).toBeNull();
    expect(parent.textContent).toContain('{"retained":true}');
  } finally {
    await act(async () => root.unmount());
    parent.remove();
  }
});

it('renders interval duration and a keyboard schedule path with hidden fields', async () => {
  const model = createDatabase('Publication');
  model.properties.push({
    id: 'dates',
    name: 'Publication window',
    type: 'date',
  });
  const view = {
    id: 'timeline',
    name: 'Timeline',
    type: 'timeline',
    dateProperty: 'dates',
    visibleProperties: [],
  };
  const id = resourceId('article');
  const rows = [
    {
      resourceId: id,
      title: 'Article',
      path: 'Article.md',
      kindId: 'froglight.markdown',
      values: { dates: { start: '2026-09-02', end: '2026-09-05' } },
      diagnostics: {},
    },
  ];
  const write = vi.fn();
  const parent = document.createElement('div');
  document.body.append(parent);
  const root = createRoot(parent);
  try {
    await act(async () =>
      root.render(
        <DatabaseContent
          model={model}
          view={view}
          rows={rows}
          readOnly={false}
          write={write}
          openResource={() => undefined}
        />,
      ),
    );
    const interval = parent.querySelector<HTMLElement>(
      '[aria-label="Article: 2026-09-02 to 2026-09-05"]',
    );
    expect(interval?.style.gridColumn).toBe('3 / 7');
    const schedule = parent.querySelector<HTMLInputElement>(
      '[aria-label="Schedule Article"]',
    )!;
    expect(schedule.disabled).toBe(false);
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(schedule, '2026-09-10');
      schedule.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(write).toHaveBeenCalledWith(id, 'dates', {
      start: '2026-09-10',
      end: '2026-09-13',
    });
    await act(async () =>
      root.render(
        <DatabaseContent
          model={model}
          view={view}
          rows={rows}
          readOnly
          write={write}
          openResource={() => undefined}
        />,
      ),
    );
    expect(
      parent.querySelector<HTMLInputElement>('[aria-label="Schedule Article"]')
        ?.disabled,
    ).toBe(true);
  } finally {
    await act(async () => root.unmount());
    parent.remove();
  }
});

it('keeps a keyboard board move control when the grouping property is hidden', async () => {
  const model = createDatabase('Contacts');
  model.properties.push({
    id: 'region',
    name: 'Region',
    type: 'select',
    options: [
      { id: 'eu', name: 'Europe' },
      { id: 'us', name: 'America' },
    ],
  });
  const view = {
    id: 'board',
    name: 'Regions',
    type: 'board',
    groupBy: 'region',
    visibleProperties: [],
  };
  const id = resourceId('contact');
  const write = vi.fn();
  const parent = document.createElement('div');
  document.body.append(parent);
  const root = createRoot(parent);
  try {
    await act(async () =>
      root.render(
        <DatabaseContent
          model={model}
          view={view}
          rows={[
            {
              resourceId: id,
              title: 'Ada',
              path: 'Ada.md',
              kindId: 'froglight.markdown',
              values: { region: 'eu' },
              diagnostics: {},
            },
          ]}
          readOnly={false}
          write={write}
          openResource={() => undefined}
        />,
      ),
    );
    const select = parent.querySelector<HTMLSelectElement>(
      '[aria-label="Move Ada to Region"]',
    )!;
    await act(async () => {
      select.value = 'us';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(write).toHaveBeenCalledWith(id, 'region', 'us');
  } finally {
    await act(async () => root.unmount());
    parent.remove();
  }
});

it('bounds each board lane independently so later groups are not empty', async () => {
  const model = createDatabase('Projects');
  model.properties.push({
    id: 'status',
    name: 'Status',
    type: 'select',
    options: [
      { id: 'todo', name: 'To do' },
      { id: 'done', name: 'Done' },
    ],
  });
  const view = {
    id: 'board',
    name: 'Status board',
    type: 'board',
    groupBy: 'status',
    visibleProperties: [],
  };
  const rows = ['todo', 'done'].flatMap((status) =>
    Array.from({ length: 110 }, (_, index) => ({
      resourceId: resourceId(`${status}-${index}`),
      title: `${status} ${index}`,
      path: `${status}/${index}.md`,
      kindId: 'froglight.markdown',
      values: { status },
      diagnostics: {},
    })),
  );
  const parent = document.createElement('div');
  document.body.append(parent);
  const root = createRoot(parent);
  try {
    await act(async () =>
      root.render(
        <DatabaseContent
          model={model}
          view={view}
          rows={rows}
          readOnly={false}
          write={() => undefined}
          openResource={() => undefined}
        />,
      ),
    );
    const lanes = [...parent.querySelectorAll('section')];
    const todo = lanes.find((lane) => lane.textContent?.startsWith('To do'))!;
    const done = lanes.find((lane) => lane.textContent?.startsWith('Done'))!;
    expect(todo.querySelectorAll('article')).toHaveLength(100);
    expect(done.querySelectorAll('article')).toHaveLength(100);
    expect(done.textContent).toContain('done 0');
    expect(done.textContent).toContain('Done (110)');
    const more = [...done.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Show 10 more in Done'),
    )!;
    await act(async () => more.click());
    expect(done.querySelectorAll('article')).toHaveLength(110);
  } finally {
    await act(async () => root.unmount());
    parent.remove();
  }
});

it('starts board dragging only from the drag handle and keeps controls selectable', async () => {
  const model = createDatabase('Projects');
  model.properties.push({
    id: 'status',
    name: 'Status',
    type: 'select',
    options: [{ id: 'todo', name: 'To do' }],
  });
  const parent = document.createElement('div');
  document.body.append(parent);
  const root = createRoot(parent);
  try {
    await act(async () =>
      root.render(
        <DatabaseContent
          model={model}
          view={{
            id: 'board',
            name: 'Status board',
            type: 'board',
            groupBy: 'status',
            visibleProperties: [],
          }}
          rows={[
            {
              resourceId: resourceId('project'),
              title: 'Project',
              path: 'Project.md',
              kindId: 'froglight.markdown',
              values: { status: 'todo' },
              diagnostics: {},
            },
          ]}
          readOnly={false}
          write={() => undefined}
          openResource={() => undefined}
        />,
      ),
    );
    const card = parent.querySelector('article')!;
    const move = parent.querySelector<HTMLSelectElement>(
      '[aria-label="Move Project to Status"]',
    )!;
    const handle = parent.querySelector<HTMLElement>(
      '[title="Drag Project to another Status lane"]',
    )!;
    expect(card.draggable).toBe(false);
    expect(move.draggable).toBe(false);
    expect(handle.draggable).toBe(true);
    expect(move.tabIndex).toBe(0);
  } finally {
    await act(async () => root.unmount());
    parent.remove();
  }
});

it('reconciles a rejected board move and reports the failure on its card', async () => {
  const model = createDatabase('Projects');
  model.properties.push({
    id: 'status',
    name: 'Status',
    type: 'select',
    options: [
      { id: 'todo', name: 'To do' },
      { id: 'done', name: 'Done' },
    ],
  });
  const id = resourceId('project');
  const writeCell = vi.fn().mockRejectedValue(new Error('injected failure'));
  const parent = document.createElement('div');
  document.body.append(parent);
  const root = createRoot(parent);
  try {
    await act(async () =>
      root.render(
        <DatabaseContent
          model={model}
          view={{
            id: 'board',
            name: 'Status board',
            type: 'board',
            groupBy: 'status',
            visibleProperties: [],
          }}
          rows={[
            {
              resourceId: id,
              title: 'Project',
              path: 'Project.md',
              kindId: 'froglight.markdown',
              values: { status: 'todo' },
              diagnostics: {},
            },
          ]}
          readOnly={false}
          write={() => undefined}
          writeCell={writeCell}
          openResource={() => undefined}
        />,
      ),
    );
    const move = parent.querySelector<HTMLSelectElement>(
      '[aria-label="Move Project to Status"]',
    )!;
    await act(async () => {
      move.value = 'done';
      move.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(writeCell).toHaveBeenCalledWith(id, 'status', 'done', 'todo');
    expect(move.value).toBe('todo');
    expect(parent.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not move: injected failure',
    );
    const todoLane = [...parent.querySelectorAll('section')].find((lane) =>
      lane.textContent?.startsWith('To do'),
    )!;
    expect(todoLane.textContent).toContain('Project');
  } finally {
    await act(async () => root.unmount());
    parent.remove();
  }
});
