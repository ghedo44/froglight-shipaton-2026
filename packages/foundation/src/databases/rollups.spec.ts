import { expect, it } from 'vitest';
import type { ResourcePropertyRow } from '../resource-properties/contract.js';
import { resourceId } from '../identity.js';
import { PropertyCatalog } from '../resource-properties/catalog.js';
import { createDatabase } from './model.js';
import { FormulaFunctions } from './formula.js';
import { InMemoryDatabaseQueryProvider } from './query.js';

it('evaluates rollups using the related database schema and rejects rollup-of-rollup', () => {
  const contacts = createDatabase('Contacts');
  contacts.membership = {
    mode: 'explicit',
    resourceIds: [resourceId('contact')],
  };
  contacts.properties = [
    {
      id: 'deals',
      name: 'Deals',
      type: 'relation',
      relation: { databaseId: 'sales' },
    },
    {
      id: 'revenue',
      name: 'Revenue',
      type: 'rollup',
      rollup: { relation: 'deals', property: 'net', aggregation: 'sum' },
    },
  ];
  const sales = createDatabase('Sales');
  sales.membership = { mode: 'explicit', resourceIds: [resourceId('deal')] };
  sales.properties = [
    { id: 'gross', name: 'Gross', type: 'number' },
    { id: 'net', name: 'Net', type: 'formula', formula: 'prop("gross") * 0.8' },
  ];
  const provider = new InMemoryDatabaseQueryProvider(
    new FormulaFunctions(),
    new PropertyCatalog(),
    { get: (id) => (id === 'sales' ? sales : undefined) },
  );
  const rows: ResourcePropertyRow[] = [
    {
      resourceId: resourceId('contact'),
      title: 'Ada',
      kindId: 'note',
      path: 'Ada.md',
      values: { deals: ['deal'] },
    },
    {
      resourceId: resourceId('deal'),
      title: 'Contract',
      kindId: 'note',
      path: 'Contract.md',
      values: { gross: 100 },
    },
  ];
  expect(
    provider.execute(contacts, contacts.views[0]!, rows)[0]?.values.revenue,
  ).toBe(80);
  sales.properties[1] = {
    id: 'net',
    name: 'Nested total',
    type: 'rollup',
    rollup: { relation: 'missing', property: 'gross', aggregation: 'sum' },
  };
  expect(
    provider.execute(contacts, contacts.views[0]!, rows)[0]?.diagnostics
      .revenue,
  ).toMatch(/rollup-of-rollup/i);
  sales.membership = { mode: 'explicit', resourceIds: [] };
  sales.properties[1] = { id: 'net', name: 'Net', type: 'number' };
  expect(
    provider.execute(contacts, contacts.views[0]!, rows)[0]?.diagnostics
      .revenue,
  ).toMatch(/member/i);
});

it('does not let failed computed cells participate using obsolete stored values', () => {
  const model = createDatabase();
  model.membership = {
    mode: 'query',
    filters: [{ property: 'computed', operator: 'gt', value: 0 }],
  };
  model.properties = [
    { id: 'computed', name: 'Computed', type: 'formula', formula: '1 / 0' },
  ];
  const rows = [
    {
      resourceId: resourceId('r'),
      title: 'Row',
      path: 'Row.md',
      kindId: 'note',
      values: { computed: 10 },
    },
  ];
  expect(
    new InMemoryDatabaseQueryProvider().execute(model, model.views[0]!, rows),
  ).toEqual([]);
  expect(rows[0]?.values.computed).toBe(10);
});
