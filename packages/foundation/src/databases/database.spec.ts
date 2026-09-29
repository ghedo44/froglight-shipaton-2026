import { describe, expect, it } from 'vitest';
import { documentId, resourceId } from '../identity.js';
import { utf8Encode } from '../encoding.js';
import { databaseKind, databaseKindId } from './kind.js';
import {
  createDatabase,
  propertyDiagnostic,
  type DatabaseModel,
} from './model.js';
import { FormulaFunctions, parseFormula } from './formula.js';
import {
  InMemoryDatabaseQueryProvider,
  resolveDatabaseView,
  type DatabaseRow,
} from './query.js';

const ref = {
  documentId: documentId('db'),
  kindId: databaseKindId,
  location: { resourceId: resourceId('db-resource') },
};
const row = (id: string, values: DatabaseRow['values']): DatabaseRow => ({
  resourceId: resourceId(id),
  title: id,
  kindId: 'froglight.markdown',
  path: `${id}.md`,
  values,
});

describe('database canonical format', () => {
  it('starts as an empty general collection, without workflow properties or templates', () => {
    const model = createDatabase('Contacts');
    expect(model.properties).toEqual([]);
    expect(model.templates).toEqual([]);
    expect(model.membership).toEqual({ mode: 'explicit', resourceIds: [] });
    expect(model.views).toEqual([
      { id: 'table', name: 'Table', type: 'table' },
    ]);
  });
  it('round-trips unknown nested plugin configuration and stable identities', () => {
    const model = {
      ...createDatabase('Projects'),
      plugin: { opaque: [1, null] },
    };
    model.views.push({
      id: 'future',
      name: 'Future',
      type: 'plugin.map',
      camera: { x: 7 },
    });
    model.properties.push({
      id: 'opaque',
      name: 'Opaque',
      type: 'plugin.value',
      settings: { preserve: true },
    });
    const bytes = databaseKind.encode(model, ref);
    expect(databaseKind.decode(bytes, ref).model).toEqual(model);
    expect(
      databaseKind.encode(databaseKind.decode(bytes, ref).model, ref),
    ).toEqual(bytes);
  });
  it('round-trips shared inspector ordering, sections, and empty visibility', () => {
    const model = createDatabase('Projects');
    model.properties.push(
      { id: 'status', name: 'Status', type: 'text' },
      { id: 'owner', name: 'Owner', type: 'text' },
    );
    model.propertyPresentation = {
      order: ['owner', 'status'],
      hideWhenEmpty: ['owner'],
      sections: [{ name: 'Planning', propertyIds: ['status'] }],
    };
    expect(
      databaseKind.decode(databaseKind.encode(model, ref), ref).model,
    ).toEqual(model);
  });
  it('accepts only the current format version', () => {
    for (const version of [0, 2, 3]) {
      expect(() =>
        databaseKind.decode(
          utf8Encode(JSON.stringify({ ...createDatabase('Legacy'), version })),
          ref,
        ),
      ).toThrow('Unsupported database format/version');
    }
  });
  it('rejects corrupt records, duplicate IDs, unsupported versions and malformed views', () => {
    for (const value of [
      null,
      {},
      { ...createDatabase(), version: 4 },
      {
        ...createDatabase(),
        views: [{ id: 'x', name: 'X', type: 'table', sorts: [null] }],
      },
      {
        ...createDatabase(),
        membership: { mode: 'explicit', resourceIds: ['x', 'x'] },
      },
      {
        ...createDatabase(),
        propertyPresentation: { order: ['status', 'status'] },
      },
      {
        ...createDatabase(),
        properties: [{ id: 'label', name: 'Label', type: 'text' }],
        views: [
          {
            id: 'table',
            name: 'Table',
            type: 'table',
            filters: [
              {
                property: 'label',
                operator: 'date-relative',
                value: 'today',
              },
            ],
          },
        ],
      },
      {
        ...createDatabase(),
        properties: [{ id: 'due', name: 'Due', type: 'date' }],
        views: [
          {
            id: 'table',
            name: 'Table',
            type: 'table',
            filters: [
              {
                property: 'due',
                operator: 'date-relative',
                value: 'this-week',
              },
            ],
          },
        ],
      },
    ]) {
      expect(() =>
        databaseKind.decode(utf8Encode(JSON.stringify(value)), ref),
      ).toThrow();
    }
  });
  it('validates calendar dates, options, finite numbers and safe URL protocols', () => {
    expect(
      propertyDiagnostic({ id: 'x', name: 'X', type: 'date' }, '2026-02-30'),
    ).not.toBeNull();
    expect(
      propertyDiagnostic({ id: 'x', name: 'X', type: 'date' }, '2026-09-07'),
    ).toBeNull();
    expect(
      propertyDiagnostic(
        { id: 'x', name: 'X', type: 'url' },
        'javascript:alert(1)',
      ),
    ).not.toBeNull();
    expect(
      propertyDiagnostic({ id: 'x', name: 'X', type: 'number' }, Infinity),
    ).not.toBeNull();
  });
});

describe('pure formulas', () => {
  const functions = new FormulaFunctions();
  it('parses dependencies and supports typed arithmetic, text, dates, lists and lazy logic', () => {
    const formula = parseFormula(
      'if(equal(prop("status"), "todo"), add(2, 3), divide(1, 0))',
    );
    expect(formula.dependencies).toEqual(['status']);
    expect(functions.evaluate(formula, () => 'todo')).toBe(5);
    expect(
      functions.evaluate(parseFormula('dateAdd("2026-09-07", 2)'), () => null),
    ).toBe('2026-09-09');
    expect(
      functions.evaluate(parseFormula('length(list(1, 2, 3))'), () => null),
    ).toBe(3);
    expect(
      functions.evaluate(parseFormula('upper(concat("a", "b"))'), () => null),
    ).toBe('AB');
  });
  it('rejects ambient authority, nonliteral dependencies, coercion and unbounded syntax', () => {
    for (const source of ['window.fetch("x")', 'add("2", 3)', 'divide(1, 0)'])
      expect(() =>
        functions.evaluate(parseFormula(source), () => null),
      ).toThrow();
    for (const source of [
      'prop(concat("a", "b"))',
      '1; alert(1)',
      'add('.repeat(40) + '1' + ')'.repeat(40),
      '1e999',
    ])
      expect(() => parseFormula(source)).toThrow();
  });
  it('removes extension functions on disposal and permits reactivation', () => {
    const register = () =>
      functions.register('example.double', (args) => Number(args[0]) * 2);
    const expression = parseFormula('example.double(3)');
    const first = register();
    expect(functions.evaluate(expression, () => null)).toBe(6);
    first.dispose();
    expect(() => functions.evaluate(expression, () => null)).toThrow(
      'Unknown formula',
    );
    const next = register();
    first.dispose();
    expect(functions.evaluate(expression, () => null)).toBe(6);
    next.dispose();
  });
});

describe('shared database query engine', () => {
  const provider = new InMemoryDatabaseQueryProvider();
  function database(): DatabaseModel {
    const model = createDatabase('Projects');
    model.properties.push(
      { id: 'cost', name: 'Cost', type: 'number' },
      {
        id: 'double',
        name: 'Double',
        type: 'formula',
        formula: 'multiply(prop("cost"), 2)',
      },
      { id: 'related', name: 'Related', type: 'relation' },
      {
        id: 'total',
        name: 'Total',
        type: 'rollup',
        rollup: { relation: 'related', property: 'cost', aggregation: 'sum' },
      },
    );
    return model;
  }
  it('uses stable resource IDs, preserves explicit order and recomputes formulas and rollups', () => {
    const model = database();
    model.membership = {
      mode: 'explicit',
      resourceIds: [resourceId('b'), resourceId('a')],
    };
    const rows = [row('a', { cost: 3, related: ['b'] }), row('b', { cost: 7 })];
    const result = provider.execute(model, model.views[0]!, rows);
    expect(result.map((item) => item.resourceId)).toEqual(['b', 'a']);
    expect(result[1]?.values).toMatchObject({ double: 6, total: 7 });
    expect(
      provider.execute(model, model.views[0]!, [
        rows[0]!,
        row('b', { cost: 9 }),
      ])[1]?.values.total,
    ).toBe(9);
  });
  it('filters query membership and narrows linked views without mutating the saved view', () => {
    const model = database();
    model.membership = {
      mode: 'query',
      filters: [{ property: 'cost', operator: 'gt', value: 2 }],
    };
    const original = JSON.stringify(model);
    const linked = resolveDatabaseView(model, 'table', {
      filters: [{ property: 'cost', operator: 'lt', value: 5 }],
    });
    expect(
      provider
        .execute(model, linked, [row('a', { cost: 3 }), row('b', { cost: 7 })])
        .map((item) => item.resourceId),
    ).toEqual(['a']);
    expect(JSON.stringify(model)).toBe(original);
    expect(() => resolveDatabaseView(model, 'deleted')).toThrow(
      'Saved view unavailable',
    );
  });
  it('rejects a missing filter field and breaks equal sort values by resource ID', () => {
    const model = database();
    model.membership = {
      mode: 'query',
      filters: [{ property: 'removed-field', operator: 'empty' }],
    };
    expect(() =>
      provider.execute(model, model.views[0]!, [row('a', {})]),
    ).toThrow('Filter property unavailable: removed-field');
    model.membership = { mode: 'query', filters: [] };
    model.views[0] = { ...model.views[0]!, sorts: [{ property: 'cost' }] };
    expect(
      provider
        .execute(model, model.views[0]!, [
          row('z', { cost: 1 }),
          row('a', { cost: 1 }),
        ])
        .map((item) => item.resourceId),
    ).toEqual(['a', 'z']);
  });
  it('evaluates bounded AND/OR groups and narrows linked overrides', () => {
    const model = database();
    model.membership = {
      mode: 'query',
      filters: [],
      where: {
        operator: 'or',
        filters: [
          { property: 'cost', operator: 'gt', value: 5 },
          { property: '$title', operator: 'eq', value: 'a' },
        ],
      },
    };
    model.views[0] = {
      ...model.views[0]!,
      where: { property: 'cost', operator: 'lt', value: 10 },
    };
    const linked = resolveDatabaseView(model, 'table', {
      where: { property: 'cost', operator: 'gt', value: 2 },
    });
    const rows = [
      row('a', { cost: 3 }),
      row('b', { cost: 7 }),
      row('c', { cost: 12 }),
      row('d', { cost: 1 }),
    ];
    expect(
      provider.execute(model, linked, rows).map((item) => item.resourceId),
    ).toEqual(['a', 'b']);
    expect(() =>
      databaseKind.encode(
        {
          ...model,
          membership: {
            mode: 'query',
            filters: [],
            where: {
              operator: 'or',
              filters: [],
            },
          },
        },
        ref,
      ),
    ).toThrow('Invalid query membership expression');
  });
  it('reports transitive cycles and incompatible source values without deleting them', () => {
    const model = database();
    model.membership = { mode: 'query', filters: [] };
    model.properties.push(
      { id: 'a', name: 'A', type: 'formula', formula: 'prop("b")' },
      { id: 'b', name: 'B', type: 'formula', formula: 'prop("a")' },
    );
    const source = row('x', { cost: 'preserve me' });
    const result = provider.execute(model, model.views[0]!, [source])[0]!;
    expect(result.diagnostics.a).toContain('cycle');
    expect(result.diagnostics.b).toContain('cycle');
    expect(result.diagnostics.cost).toContain('number');
    expect(source.values.cost).toBe('preserve me');
  });
});
