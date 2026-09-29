import { describe, expect, it } from 'vitest';
import { resourceId } from '../identity.js';
import type {
  ResourcePropertyRow,
  ResourcePropertyRowSource,
} from '../resource-properties/contract.js';
import { createDatabase } from './model.js';
import { InMemoryDatabaseQueryProvider } from './query.js';
import {
  DATABASE_RELATION_CHOICE_LIMIT,
  databaseRelationChoices,
} from './relations.js';

function rows(count: number): readonly ResourcePropertyRow[] {
  return Array.from({ length: count }, (_, index) => ({
    resourceId: resourceId(`row-${index}`),
    title: `Row ${index}`,
    path: `${index}.md`,
    kindId: 'note',
    values: {},
  }));
}

function trackedSource(input: readonly ResourcePropertyRow[]) {
  let scanned = 0;
  let read = 0;
  const byId = new Map(input.map((row) => [row.resourceId, row]));
  const source: ResourcePropertyRowSource = {
    revision: 1,
    scan() {
      return (function* () {
        for (const row of input) {
          scanned += 1;
          yield row;
        }
      })();
    },
    get(id) {
      read += 1;
      return byId.get(id);
    },
  };
  return { source, scanned: () => scanned, read: () => read };
}

describe('bounded relation choices', () => {
  it('stops the ordinary scan at the limit and resolves eligible retained IDs', async () => {
    const input = rows(10_000);
    const tracked = trackedSource(input);
    const owner = createDatabase('Owner');
    const target = createDatabase('Target');
    target.membership = { mode: 'query', filters: [] };
    owner.properties = [
      {
        id: 'related',
        name: 'Related',
        type: 'relation',
        relation: { databaseId: 'target' },
      },
    ];

    const choices = await databaseRelationChoices(
      owner,
      new InMemoryDatabaseQueryProvider(),
      tracked.source,
      { get: (id) => (id === 'target' ? target : undefined) },
      {
        include: {
          related: [resourceId('row-9999'), resourceId('missing')],
        },
      },
    );

    expect(choices.related).toHaveLength(DATABASE_RELATION_CHOICE_LIMIT + 1);
    expect(choices.related?.at(-1)).toEqual({
      id: resourceId('row-9999'),
      title: 'Row 9999',
    });
    expect(choices.related?.some((choice) => choice.id === 'missing')).toBe(
      false,
    );
    expect(tracked.scanned()).toBe(DATABASE_RELATION_CHOICE_LIMIT);
    expect(tracked.read()).toBe(2);
  });

  it('bounds explicit membership by point reads and observes cancellation', async () => {
    const input = rows(10_000);
    const tracked = trackedSource(input);
    const owner = createDatabase('Owner');
    const target = createDatabase('Target');
    target.membership = {
      mode: 'explicit',
      resourceIds: input.map((row) => row.resourceId),
    };
    owner.properties = [
      {
        id: 'related',
        name: 'Related',
        type: 'relation',
        relation: { databaseId: 'target' },
      },
    ];
    const query = new InMemoryDatabaseQueryProvider();
    const definitions = {
      get: (id: string) => (id === 'target' ? target : undefined),
    };

    const choices = await databaseRelationChoices(
      owner,
      query,
      tracked.source,
      definitions,
      { include: { related: [resourceId('row-9999')] } },
    );
    expect(choices.related).toHaveLength(DATABASE_RELATION_CHOICE_LIMIT + 1);
    expect(tracked.scanned()).toBe(0);
    expect(tracked.read()).toBe(DATABASE_RELATION_CHOICE_LIMIT + 1);

    const abort = new AbortController();
    abort.abort();
    await expect(
      databaseRelationChoices(owner, query, tracked.source, definitions, {
        signal: abort.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(tracked.scanned()).toBe(0);
  });
});
