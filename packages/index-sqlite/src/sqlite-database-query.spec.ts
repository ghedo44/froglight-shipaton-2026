import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  createDatabase,
  InMemoryDatabaseQueryProvider,
  resourceId,
  type DatabaseRow,
  type ResourcePropertyRowSource,
} from '@froglight/foundation';
import { createSqliteDatabaseQueryProvider } from './node-database-query.js';

it('matches the reference query across persisted reopen, rebuild, edits and invalid cells', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'froglight-database-'));
  const path = join(directory, 'derived.sqlite');
  const model = createDatabase('Contacts');
  model.properties = [
    { id: 'region', name: 'Region', type: 'text' },
    { id: 'count', name: 'Count', type: 'number' },
    {
      id: 'twice',
      name: 'Twice',
      type: 'formula',
      formula: 'prop("count") * 2',
    },
  ];
  model.membership = {
    mode: 'query',
    filters: [{ property: 'region', operator: 'eq', value: 'Europe' }],
  };
  const view = {
    ...model.views[0]!,
    sorts: [{ property: 'twice', descending: true }],
  };
  const rows: DatabaseRow[] = [
    {
      resourceId: resourceId('ada'),
      title: 'Ada',
      path: 'Ada.md',
      kindId: 'note',
      values: { region: 'Europe', count: 3 },
    },
    {
      resourceId: resourceId('grace'),
      title: 'Grace',
      path: 'Grace.md',
      kindId: 'note',
      values: { region: 'America', count: 9 },
    },
    {
      resourceId: resourceId('invalid'),
      title: 'Invalid',
      path: 'Invalid.md',
      kindId: 'note',
      values: { region: 'Europe', count: 'retained' },
    },
  ];
  const canonical = JSON.stringify({ model, rows });
  const reference = new InMemoryDatabaseQueryProvider();
  let provider = await createSqliteDatabaseQueryProvider(path, reference);
  try {
    const expected = reference.execute(model, view, rows);
    expect(await provider.execute(model, view, rows)).toEqual(expected);
    await provider.dispose();
    provider = await createSqliteDatabaseQueryProvider(path, reference);
    expect(await provider.execute(model, view, rows)).toEqual(expected);
    await provider.clear();
    expect(await provider.execute(model, view, rows)).toEqual(expected);
    expect(JSON.stringify({ model, rows })).toBe(canonical);
    const changed = rows
      .slice(0, 2)
      .map((row) => ({ ...row, values: { region: 'Europe', count: 7 } }));
    expect(await provider.execute(model, view, changed)).toEqual(
      reference.execute(model, view, changed),
    );
    const explicit = {
      ...model,
      membership: {
        mode: 'explicit' as const,
        resourceIds: [resourceId('grace'), resourceId('ada')],
      },
    };
    expect(await provider.execute(explicit, model.views[0]!, changed)).toEqual(
      reference.execute(explicit, model.views[0]!, changed),
    );
    model.membership = {
      mode: 'query',
      filters: [],
      where: {
        operator: 'or',
        filters: [
          { property: 'region', operator: 'eq', value: 'America' },
          { property: 'count', operator: 'gt', value: 5 },
        ],
      },
    };
    const narrowed = {
      ...view,
      where: { property: 'region', operator: 'eq', value: 'Europe' } as const,
    };
    expect(await provider.execute(model, narrowed, rows)).toEqual(
      reference.execute(model, narrowed, rows),
    );
  } finally {
    await provider.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

it('keeps relative date semantics in the shared evaluator', async () => {
  const reference = new InMemoryDatabaseQueryProvider();
  const provider = await createSqliteDatabaseQueryProvider(
    ':memory:',
    reference,
  );
  const model = createDatabase('Schedule');
  model.properties = [{ id: 'when', name: 'When', type: 'date' }];
  model.membership = {
    mode: 'query',
    filters: [{ property: 'when', operator: 'date-relative', value: 'today' }],
  };
  const view = model.views[0];
  if (!view) throw new Error('Default view unavailable');
  const rows: DatabaseRow[] = [
    {
      resourceId: resourceId('local-day'),
      title: 'Date only',
      path: 'local.md',
      kindId: 'note',
      values: { when: '2026-09-23' },
    },
    {
      resourceId: resourceId('utc-boundary'),
      title: 'UTC boundary',
      path: 'utc.md',
      kindId: 'note',
      values: { when: '2026-09-22T16:30:00.000Z' },
    },
    {
      resourceId: resourceId('outside'),
      title: 'Outside',
      path: 'outside.md',
      kindId: 'note',
      values: { when: '2026-09-22' },
    },
  ];
  const options = {
    evaluation: {
      nowMillis: Date.parse('2026-09-23T00:30:00.000Z'),
      timeZone: 'Asia/Tokyo',
    },
  };
  try {
    expect(await provider.execute(model, view, rows, '', options)).toEqual(
      reference.execute(model, view, rows, '', options),
    );
    expect(
      (await provider.execute(model, view, rows, '', options)).map(
        (row) => row.resourceId,
      ),
    ).toEqual([resourceId('local-day'), resourceId('utc-boundary')]);
  } finally {
    await provider.dispose();
  }
});

it('keeps bounded lazy lookup parity without materializing indexed candidates', async () => {
  const reference = new InMemoryDatabaseQueryProvider();
  const provider = await createSqliteDatabaseQueryProvider(
    ':memory:',
    reference,
  );
  const model = createDatabase('Lookup');
  model.membership = { mode: 'query', filters: [] };
  const view = model.views[0];
  if (!view) throw new Error('Default view unavailable');
  const rows = Array.from({ length: 200 }, (_, index) => ({
    resourceId: resourceId(`lookup-${index}`),
    title: `Lookup ${index}`,
    path: `${index}.md`,
    kindId: 'note',
    values: {},
  }));
  let yielded = 0;
  const source: ResourcePropertyRowSource = {
    revision: 1,
    scan: () =>
      (function* () {
        for (const row of rows) {
          yielded += 1;
          yield row;
        }
      })(),
    get: (id) => rows.find((row) => row.resourceId === id),
  };
  try {
    const options = { limit: 51 };
    expect(await provider.execute(model, view, source, '', options)).toEqual(
      reference.execute(model, view, source, '', options),
    );
    expect(yielded).toBe(102);
  } finally {
    await provider.dispose();
  }
});
