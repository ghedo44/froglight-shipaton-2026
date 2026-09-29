import { describe, expect, it } from 'vitest';
import { resourceId } from '../identity.js';
import type {
  ResourcePropertyRow,
  ResourcePropertyRowSource,
} from '../resource-properties/contract.js';
import { createDatabase } from './model.js';
import { InMemoryDatabaseQueryProvider } from './query.js';

function source(rows: readonly ResourcePropertyRow[]) {
  let yielded = 0;
  const value: ResourcePropertyRowSource = {
    revision: 1,
    scan() {
      return (function* () {
        for (const row of rows) {
          yielded += 1;
          yield row;
        }
      })();
    },
    get(id) {
      return rows.find((row) => row.resourceId === id);
    },
  };
  return { value, yielded: () => yielded };
}

describe('bounded database queries', () => {
  it('stops an unsorted lazy scan at the limit and resolves requested IDs', () => {
    const rows = Array.from({ length: 200 }, (_, index) => ({
      resourceId: resourceId(`row-${index}`),
      title: `Row ${index}`,
      path: `${index}.md`,
      kindId: 'note',
      values: {},
    }));
    const model = createDatabase('Rows');
    model.membership = { mode: 'query', filters: [] };
    const view = model.views[0];
    if (!view) throw new Error('Default view unavailable');
    const provider = new InMemoryDatabaseQueryProvider();
    const bounded = source(rows);

    expect(
      provider.execute(model, view, bounded.value, '', {
        limit: 51,
      }),
    ).toHaveLength(51);
    expect(bounded.yielded()).toBe(51);

    const withSelected = source(rows);
    const result = provider.execute(model, view, withSelected.value, '', {
      limit: 51,
      include: [resourceId('row-199')],
    });
    expect(result).toHaveLength(52);
    expect(result.at(-1)?.resourceId).toBe(resourceId('row-199'));
    expect(withSelected.yielded()).toBe(200);
  });

  it('observes cancellation before scanning', () => {
    const model = createDatabase('Rows');
    model.membership = { mode: 'query', filters: [] };
    const view = model.views[0];
    if (!view) throw new Error('Default view unavailable');
    const rows = source([]);
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      new InMemoryDatabaseQueryProvider().execute(model, view, rows.value, '', {
        limit: 1,
        signal: controller.signal,
      }),
    ).toThrow('Database query aborted');
    expect(rows.yielded()).toBe(0);
  });
});
