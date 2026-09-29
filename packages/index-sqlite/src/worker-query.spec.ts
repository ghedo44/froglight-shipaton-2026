import { expect, it, vi } from 'vitest';
import {
  createMemoryVault,
  createDatabase,
  InMemoryDatabaseQueryProvider,
  resourceId,
  type ResourcePropertyRowSource,
} from '@froglight/foundation';
import {
  WorkerDatabaseQueryProvider,
  DATABASE_INDEX_PATH,
} from './worker-query.js';
import type {
  DatabaseWorkerRequest,
  DatabaseWorkerResponse,
} from './database-worker.js';

function transport(
  reply: (request: DatabaseWorkerRequest) => DatabaseWorkerResponse | undefined,
) {
  const port = {
    onmessage: null as
      | ((event: { data: DatabaseWorkerResponse }) => void)
      | null,
    onerror: null as ((event: { message: string }) => void) | null,
    postMessage(request: DatabaseWorkerRequest) {
      const response = reply(request);
      if (response)
        queueMicrotask(() =>
          port.onmessage?.(new MessageEvent('message', { data: response })),
        );
    },
    terminate: vi.fn(),
  };
  return { port, worker: port as unknown as Worker };
}

it('keeps semantic results during cache quota failures and retries persistence without another edit', async () => {
  let fail = true;
  const { vault } = createMemoryVault({
    fail: (operation) =>
      operation === 'write' && fail ? new Error('quota exhausted') : null,
  });
  let queries = 0;
  const bytes = new Uint8Array([1, 2, 3]);
  const { worker, port } = transport((request) =>
    request.type === 'query'
      ? { id: request.id, ids: ['ada'], ...(queries++ === 0 ? { bytes } : {}) }
      : { id: request.id },
  );
  const provider = new WorkerDatabaseQueryProvider(
    worker,
    vault,
    new InMemoryDatabaseQueryProvider(),
  );
  const model = createDatabase('Contacts');
  model.membership = { mode: 'explicit', resourceIds: [resourceId('ada')] };
  model.properties.push({
    id: 'score',
    name: 'Score',
    type: 'formula',
    formula: '2 + 3',
  });
  const rows = [
    {
      resourceId: resourceId('ada'),
      title: 'Ada',
      path: 'Ada.md',
      kindId: 'note',
      values: {},
    },
  ];
  await provider.open('bundled.wasm');
  const first = await provider.execute(model, model.views[0]!, rows);
  expect(first[0]?.values.score).toBe(5);
  expect(first[0]?.diagnostics.$index).toContain('quota exhausted');
  fail = false;
  expect(
    (await provider.execute(model, model.views[0]!, rows))[0]?.diagnostics
      .$index,
  ).toBeUndefined();
  expect(await vault.read(DATABASE_INDEX_PATH)).toEqual(bytes);
  await provider.dispose();
  await provider.dispose();
  expect(port.terminate).toHaveBeenCalledTimes(1);
  await expect(provider.execute(model, model.views[0]!, rows)).rejects.toThrow(
    /disposed/,
  );
});

it('keeps relative date semantics outside worker candidate selection', async () => {
  const { vault } = createMemoryVault();
  const rows = [
    {
      resourceId: resourceId('today'),
      title: 'Today',
      path: 'today.md',
      kindId: 'note',
      values: { when: '2026-09-23' },
    },
    {
      resourceId: resourceId('outside'),
      title: 'Outside',
      path: 'outside.md',
      kindId: 'note',
      values: { when: '2026-09-22' },
    },
  ];
  const { worker } = transport((request) =>
    request.type === 'query'
      ? { id: request.id, ids: rows.map((row) => row.resourceId) }
      : { id: request.id },
  );
  const provider = new WorkerDatabaseQueryProvider(
    worker,
    vault,
    new InMemoryDatabaseQueryProvider(),
  );
  const model = createDatabase('Schedule');
  model.properties = [{ id: 'when', name: 'When', type: 'date' }];
  model.membership = {
    mode: 'query',
    filters: [{ property: 'when', operator: 'date-relative', value: 'today' }],
  };
  const view = model.views[0];
  if (!view) throw new Error('Default view unavailable');
  await provider.open('bundled.wasm');
  try {
    const result = await provider.execute(model, view, rows, '', {
      evaluation: {
        nowMillis: Date.parse('2026-09-23T12:00:00.000Z'),
        timeZone: 'UTC',
      },
    });
    expect(result.map((row) => row.resourceId)).toEqual([resourceId('today')]);
  } finally {
    await provider.dispose();
  }
});

it('rejects pending and subsequent operations after worker failure and releases its owner', async () => {
  const { vault } = createMemoryVault();
  const { worker, port } = transport(() => undefined);
  const posted = vi.spyOn(port, 'postMessage');
  const provider = new WorkerDatabaseQueryProvider(
    worker,
    vault,
    new InMemoryDatabaseQueryProvider(),
  );
  const pending = provider.open('bundled.wasm');
  // Wait until the initial cache read has completed and the open request is pending.
  await vi.waitFor(() => expect(posted).toHaveBeenCalled());
  port.onerror?.({ message: 'worker stopped' });
  await expect(pending).rejects.toThrow('worker stopped');
  const model = createDatabase();
  await expect(provider.execute(model, model.views[0]!, [])).rejects.toThrow(
    'worker stopped',
  );
  await provider.dispose();
  expect(port.terminate).toHaveBeenCalledTimes(1);
});

it('keeps bounded lookups on the lazy semantic source instead of cloning all rows', async () => {
  const { vault } = createMemoryVault();
  const requests: DatabaseWorkerRequest[] = [];
  const { worker } = transport((request) => {
    requests.push(request);
    return { id: request.id };
  });
  const provider = new WorkerDatabaseQueryProvider(
    worker,
    vault,
    new InMemoryDatabaseQueryProvider(),
  );
  await provider.open('bundled.wasm');
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

  expect(
    await provider.execute(model, view, source, '', { limit: 51 }),
  ).toHaveLength(51);
  expect(yielded).toBe(51);
  expect(requests.filter((request) => request.type === 'query')).toHaveLength(
    0,
  );
  await provider.dispose();
});
