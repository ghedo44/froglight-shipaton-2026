// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createDatabase,
  InMemoryDatabaseQueryProvider,
  PropertyCatalog,
  type DatabaseController,
  type DatabaseProperty,
  type ResourceId,
} from '@froglight/foundation';
import { DatabasePropertyCreator } from './DatabasePropertyCreator.js';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: { remove(): void }[] = [];
afterEach(() => {
  for (const parent of mounted.splice(0)) parent.remove();
});

function setup(formula = '') {
  const model = createDatabase('Research');
  const resourceId = 'sample-row' as ResourceId;
  model.membership = { mode: 'explicit', resourceIds: [resourceId] };
  const price: DatabaseProperty = {
    id: 'price',
    name: 'Price',
    type: 'number',
  };
  const existing: DatabaseProperty = {
    id: 'total',
    name: 'Total',
    type: 'formula',
    formula,
  };
  model.properties.push(price, existing);
  const saveProperty = vi.fn(async () => undefined);
  const rows = vi.fn(async () => [
    {
      resourceId,
      title: 'Sample note',
      path: 'Sample.md',
      kindId: 'froglight.markdown',
      values: { price: 20 },
      diagnostics: {},
    },
  ]);
  const controller = {
    model,
    properties: { catalog: new PropertyCatalog(), rows },
    query: new InMemoryDatabaseQueryProvider(),
    saveProperty,
  } as unknown as DatabaseController;
  const mutate = vi.fn(async (operation: () => Promise<unknown>) => {
    await operation();
  });
  const parent = document.createElement('div');
  document.body.append(parent);
  mounted.push(parent);
  const root = createRoot(parent);
  return { controller, existing, mutate, parent, price, root, saveProperty };
}

function changeFormula(input: HTMLTextAreaElement, value: string): void {
  Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value',
  )!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

it('inserts a named property as its stable ID and previews the sample row', async () => {
  const { controller, existing, mutate, parent, price, root } = setup();
  await act(async () => {
    root.render(
      <DatabasePropertyCreator
        controller={controller}
        existing={existing}
        disabled={false}
        mutate={mutate}
      />,
    );
  });
  const property = parent.querySelector<HTMLSelectElement>(
    '[aria-label="Insert formula property"]',
  )!;
  expect(property.textContent).toContain('Price');
  await act(async () => {
    property.value = 'price';
    property.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(
    parent.querySelector<HTMLTextAreaElement>(
      '[aria-label="Formula expression"]',
    )!.value,
  ).toBe('prop("price")');
  await act(async () => undefined);
  expect(parent.textContent).toContain('Preview · Sample note: 20');
  controller.model.properties[0] = { ...price, name: 'Cost' };
  await act(async () => {
    root.render(
      <DatabasePropertyCreator
        controller={controller}
        existing={existing}
        disabled={false}
        mutate={mutate}
      />,
    );
  });
  expect(property.textContent).toContain('Cost');
  expect(
    parent.querySelector<HTMLTextAreaElement>(
      '[aria-label="Formula expression"]',
    )!.value,
  ).toBe('prop("price")');
  await act(async () => root.unmount());
});

it('inserts a valid function template around the current selection', async () => {
  const { controller, existing, mutate, parent, root } = setup('prop("price")');
  await act(async () => {
    root.render(
      <DatabasePropertyCreator
        controller={controller}
        existing={existing}
        disabled={false}
        mutate={mutate}
      />,
    );
  });
  const formula = parent.querySelector<HTMLTextAreaElement>(
    '[aria-label="Formula expression"]',
  )!;
  formula.setSelectionRange(0, formula.value.length);
  const functions = parent.querySelector<HTMLSelectElement>(
    '[aria-label="Insert formula function"]',
  )!;
  await act(async () => {
    functions.value = 'round';
    functions.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(formula.value).toBe('round(prop("price"))');
  expect(functions.textContent).toContain('dateAdd(date, days)');
  await act(async () => root.unmount());
});

it('reports syntax and missing dependencies inline and saves only a valid formula', async () => {
  const { controller, existing, mutate, parent, root, saveProperty } = setup();
  await act(async () => {
    root.render(
      <DatabasePropertyCreator
        controller={controller}
        existing={existing}
        disabled={false}
        mutate={mutate}
      />,
    );
  });
  const formula = parent.querySelector<HTMLTextAreaElement>(
    '[aria-label="Formula expression"]',
  )!;
  const save = [...parent.querySelectorAll('button')].find(
    (button) => button.textContent === 'Save property',
  )!;
  await act(async () => {
    changeFormula(formula, 'prop("missing")');
  });
  expect(parent.textContent).toContain('Unavailable property: missing');
  expect(save.disabled).toBe(true);
  await act(async () => {
    changeFormula(formula, 'prop("price") * 2');
  });
  expect(save.disabled).toBe(false);
  await act(async () => save.click());
  expect(mutate).toHaveBeenCalledOnce();
  expect(saveProperty).toHaveBeenCalledWith(
    expect.objectContaining({
      id: 'total',
      formula: 'prop("price") * 2',
    }),
  );
  await act(async () => root.unmount());
});

it('previews a rollup from a related sample row before saving', async () => {
  const { controller, mutate, parent, root } = setup();
  const source = 'sample-row' as ResourceId;
  const target = 'related-row' as ResourceId;
  controller.model.membership = {
    mode: 'explicit',
    resourceIds: [source, target],
  };
  controller.model.properties.push({
    id: 'related',
    name: 'Related',
    type: 'relation',
  });
  const rollup: DatabaseProperty = {
    id: 'total-related',
    name: 'Related total',
    type: 'rollup',
    rollup: { relation: 'related', property: 'price', aggregation: 'sum' },
  };
  controller.model.properties.push(rollup);
  vi.mocked(controller.properties.rows).mockResolvedValue([
    {
      resourceId: source,
      title: 'Sample note',
      path: 'Sample.md',
      kindId: 'froglight.markdown',
      values: { related: [target] },
      diagnostics: {},
    },
    {
      resourceId: target,
      title: 'Related note',
      path: 'Related.md',
      kindId: 'froglight.markdown',
      values: { price: 12 },
      diagnostics: {},
    },
  ]);
  await act(async () => {
    root.render(
      <DatabasePropertyCreator
        controller={controller}
        existing={rollup}
        disabled={false}
        mutate={mutate}
      />,
    );
  });
  await act(async () => undefined);
  expect(parent.textContent).toContain('Preview · Sample note: 12');
  await act(async () => root.unmount());
});
