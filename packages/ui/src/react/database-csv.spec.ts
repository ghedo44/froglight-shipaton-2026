import { describe, expect, it } from 'vitest';
import { databaseRowsToCsv } from './database-csv.js';
import type {
  DatabaseProperty,
  EvaluatedDatabaseRow,
} from '@froglight/foundation';

describe('database CSV exchange', () => {
  it('keeps stable field IDs and distinct empty, false, zero and structured values', () => {
    const properties: DatabaseProperty[] = [
      { id: 'a', name: 'Status', type: 'text' },
      { id: 'b', name: 'Status', type: 'boolean' },
      { id: 'c', name: 'Count', type: 'number' },
      { id: 'd', name: 'Tags', type: 'multi-select' },
    ];
    const rows = [
      {
        resourceId: 'res-a',
        title: 'A, "test"',
        kindId: 'example.kind',
        path: 'a.md',
        values: { a: '', b: false, c: 0, d: ['one', 'two'] },
        diagnostics: {},
      },
    ] as unknown as EvaluatedDatabaseRow[];
    expect(databaseRowsToCsv(properties, rows, false)).toContain(
      '"Status [a]","Status [b]","Count [c]","Tags [d]"',
    );
    expect(databaseRowsToCsv(properties, rows, false)).toContain(
      '"A, ""test""","example.kind","a.md","","false","0","[""one"",""two""]"',
    );
  });

  it('only prefixes formula-like text when deliberately selected', () => {
    const properties: DatabaseProperty[] = [
      { id: 'a', name: '=Text', type: 'text' },
    ];
    const rows = [
      {
        resourceId: 'res-a',
        title: '=SUM(1,1)',
        kindId: 'example.kind',
        path: 'a.md',
        values: { a: ' \t+1' },
        diagnostics: {},
      },
    ] as unknown as EvaluatedDatabaseRow[];
    expect(databaseRowsToCsv(properties, rows, false)).toContain('"=SUM(1,1)"');
    expect(databaseRowsToCsv(properties, rows, true)).toContain(
      '"\t=SUM(1,1)"',
    );
    expect(databaseRowsToCsv(properties, rows, true)).toContain('"\t \t+1"');
    expect(databaseRowsToCsv(properties, rows, true)).toContain(
      '"\t=Text [a]"',
    );
    expect(
      databaseRowsToCsv(
        properties,
        rows.map((row) => ({ ...row, values: { a: '＝1+1' } })),
        true,
      ),
    ).toContain('"\t＝1+1"');
  });
});
