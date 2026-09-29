import { describe, expect, it } from 'vitest';
import { resourceId } from '../identity.js';
import { createDatabase, type DatabaseFilter } from './model.js';
import {
  InMemoryDatabaseQueryProvider,
  nextDatabaseDayBoundary,
  type DatabaseEvaluationContext,
  type DatabaseRow,
} from './query.js';

const context: DatabaseEvaluationContext = {
  nowMillis: Date.parse('2026-09-23T00:30:00.000Z'),
  timeZone: 'Asia/Tokyo',
};

function filter(period: DatabaseFilter['value']): DatabaseFilter {
  return { property: 'due', operator: 'date-relative', value: period };
}

describe('relative date filters', () => {
  const model = createDatabase('Schedule');
  model.properties = [{ id: 'due', name: 'Due', type: 'date' }];
  model.membership = { mode: 'query', filters: [] };
  const rows: DatabaseRow[] = [
    {
      resourceId: resourceId('date-only'),
      title: 'Date only',
      path: 'date.md',
      kindId: 'note',
      values: { due: '2026-09-23' },
    },
    {
      resourceId: resourceId('instant'),
      title: 'Instant',
      path: 'instant.md',
      kindId: 'note',
      values: { due: '2026-09-22T16:30:00.000Z' },
    },
    {
      resourceId: resourceId('range'),
      title: 'Range',
      path: 'range.md',
      kindId: 'note',
      values: { due: { start: '2026-09-20', end: '2026-09-23' } },
    },
    {
      resourceId: resourceId('old'),
      title: 'Old',
      path: 'old.md',
      kindId: 'note',
      values: { due: '2026-09-15' },
    },
  ];
  const view = model.views[0];
  if (!view) throw new Error('Default view unavailable');

  it('uses explicit timezone calendar days and range overlap', () => {
    const provider = new InMemoryDatabaseQueryProvider();
    expect(
      provider
        .execute(model, { ...view, filters: [filter('today')] }, rows, '', {
          evaluation: context,
        })
        .map((row) => row.resourceId),
    ).toEqual([
      resourceId('date-only'),
      resourceId('instant'),
      resourceId('range'),
    ]);
    expect(
      provider
        .execute(
          model,
          { ...view, filters: [filter('past-7-days')] },
          rows,
          '',
          { evaluation: context },
        )
        .map((row) => row.resourceId),
    ).toEqual([
      resourceId('date-only'),
      resourceId('instant'),
      resourceId('range'),
    ]);
  });

  it('fails without context and computes DST-aware next boundaries', () => {
    expect(() =>
      new InMemoryDatabaseQueryProvider().execute(
        model,
        { ...view, filters: [filter('today')] },
        rows,
      ),
    ).toThrow('requires an evaluation context');
    expect(
      nextDatabaseDayBoundary({
        nowMillis: Date.parse('2026-03-29T00:30:00.000Z'),
        timeZone: 'Europe/Rome',
      }),
    ).toBe(Date.parse('2026-03-29T22:00:00.000Z'));
    expect(() =>
      nextDatabaseDayBoundary({
        nowMillis: context.nowMillis,
        timeZone: 'Not/A_Timezone',
      }),
    ).toThrow('Invalid evaluation timezone');
  });
});
