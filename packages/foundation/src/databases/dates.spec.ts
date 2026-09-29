import { expect, it } from 'vitest';
import { databaseDateInterval, moveDatabaseDate } from './dates.js';

it('moves intervals across month boundaries preserving duration and extension fields', () => {
  expect(
    moveDatabaseDate(
      { start: '2026-01-30', end: '2026-02-03', color: 'blue' },
      '2026-02-27',
    ),
  ).toEqual({ start: '2026-02-27', end: '2026-03-03', color: 'blue' });
  expect(moveDatabaseDate('2026-01-30T12:30:00Z', '2026-03-01')).toBe(
    '2026-03-01T12:30:00.000Z',
  );
  expect(moveDatabaseDate(null, '2026-03-01')).toBe('2026-03-01');
});

it('rejects invalid intervals and dates without silently replacing values', () => {
  expect(
    databaseDateInterval({ start: '2026-02-03', end: '2026-02-01' }),
  ).toBeNull();
  expect(() => moveDatabaseDate('opaque', '2026-03-01')).toThrow();
  expect(() => moveDatabaseDate(null, '2026-02-30')).toThrow();
});
