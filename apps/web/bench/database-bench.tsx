import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import {
  createDatabase,
  InMemoryDatabaseQueryProvider,
  resourceId,
  type DatabaseRow,
  type EvaluatedDatabaseRow,
} from '@froglight/foundation';
import { DatabaseContent } from '@froglight/ui/react';

interface Sample {
  rows: number;
  selected: number;
  mountedRows: number;
  firstUsableMs: number;
  warmRefreshP95Ms: number;
  queryP95Ms: number;
}

declare global {
  interface Window {
    __froglightDatabaseBench?: {
      done: boolean;
      samples: Sample[];
      error?: string;
    };
  }
}

const rootNode = document.getElementById('database-bench-root');
if (!rootNode) throw new Error('Database benchmark root unavailable');
const root = createRoot(rootNode);
const report = {
  done: false,
  samples: [] as Sample[],
  error: undefined as string | undefined,
};
window.__froglightDatabaseBench = report;

function percentile(values: readonly number[], ratio: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * ratio) - 1] ?? 0;
}

function frame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function run(size: number): Promise<Sample> {
  const model = createDatabase(`Profile ${size}`);
  model.membership = { mode: 'query', filters: [] };
  model.properties = [
    { id: 'status', name: 'Status', type: 'text' },
    { id: 'score', name: 'Score', type: 'number' },
    {
      id: 'double',
      name: 'Double',
      type: 'formula',
      formula: 'prop("score") * 2',
    },
  ];
  model.views[0] = {
    ...model.views[0]!,
    filters: [{ property: 'double', operator: 'gt', value: 10 }],
    sorts: [{ property: 'score', descending: true }, { property: '$title' }],
  };
  const rows: DatabaseRow[] = Array.from({ length: size }, (_, index) => ({
    resourceId: resourceId(`profile-${index}`),
    title: `Record ${String(index).padStart(5, '0')} with a realistic title`,
    kindId: index % 3 === 0 ? 'froglight.markdown' : 'froglight.block-page',
    path: `Notes/Record ${index}.md`,
    values: {
      ...(index % 9 === 0
        ? {}
        : { status: ['Todo', 'Doing', 'Done'][index % 3]! }),
      score: index % 11,
    },
  }));
  const query = new InMemoryDatabaseQueryProvider();
  const render = (result: readonly EvaluatedDatabaseRow[]) => {
    flushSync(() =>
      root.render(
        <DatabaseContent
          model={model}
          view={model.views[0]}
          rows={result}
          readOnly
          write={() => undefined}
          openResource={() => undefined}
        />,
      ),
    );
  };
  const firstStart = performance.now();
  const first = query.execute(model, model.views[0]!, rows);
  render(first);
  await frame();
  const firstUsableMs = performance.now() - firstStart;
  const mountedRows = rootNode.querySelectorAll('tbody tr').length;
  const querySamples: number[] = [];
  const refreshSamples: number[] = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const queryStart = performance.now();
    const result = query.execute(
      model,
      model.views[0]!,
      rows,
      attempt % 2 ? 'Record 0' : 'Record 1',
    );
    const queryEnd = performance.now();
    render(result);
    await frame();
    querySamples.push(queryEnd - queryStart);
    refreshSamples.push(performance.now() - queryStart);
  }
  return {
    rows: size,
    selected: first.length,
    mountedRows,
    firstUsableMs,
    warmRefreshP95Ms: percentile(refreshSamples, 0.95),
    queryP95Ms: percentile(querySamples, 0.95),
  };
}

void (async () => {
  try {
    for (const size of [100, 1_000, 10_000])
      report.samples.push(await run(size));
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  } finally {
    report.done = true;
  }
})();
