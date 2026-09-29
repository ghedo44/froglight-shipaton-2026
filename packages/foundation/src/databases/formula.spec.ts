import { expect, it } from 'vitest';
import { FormulaFunctions, parseFormula } from './formula.js';

const functions = new FormulaFunctions();
const evaluate = (source: string) =>
  functions.evaluate(parseFormula(source), (id) => {
    if (id === 'price') return 12;
    throw new Error(`Unknown property: ${id}`);
  });

it('supports precedence, grouping, typed comparisons and method calls', () => {
  expect(evaluate('prop("price") * (2 + 3)')).toBe(60);
  expect(evaluate('1 + 2 * 3 == 7 && !(4 < 2)')).toBe(true);
  expect(evaluate('"hello".upper().concat("!")')).toBe('HELLO!');
  expect(evaluate('[1, 2, 3].length()')).toBe(3);
  expect(parseFormula('prop("price") + prop("price")').dependencies).toEqual([
    'price',
  ]);
});

it('short circuits conditionals and boolean operators without coercion', () => {
  expect(evaluate('false && (1 / 0 > 1)')).toBe(false);
  expect(evaluate('true || prop("missing")')).toBe(true);
  expect(evaluate('prop("price") > 10 ? "large" : "small"')).toBe('large');
  expect(() => evaluate('1 && true')).toThrow(/boolean/);
  expect(() => evaluate('"1" + 2')).toThrow(/numeric/);
});

it('rejects executable code, member access and malformed expressions', () => {
  for (const source of [
    'globalThis.fetch("/")',
    '"x".constructor',
    '1; 2',
    '[1,]',
    '1 +',
    'random()',
  ]) {
    expect(() => evaluate(source)).toThrow();
  }
  expect(() => evaluate('('.repeat(40) + '1' + ')'.repeat(40))).toThrow(
    /limit/,
  );
});

it('composes generic text, list and numeric functions', () => {
  expect(evaluate('"Ada,Grace,Ada".split(",").unique().join(" / ")')).toBe(
    'Ada / Grace',
  );
  expect(evaluate('[1, 2, 3].sum() / [1, 2, 3].length()')).toBe(2);
  expect(evaluate('"hello world".contains("world")')).toBe(true);
  expect(evaluate('[1, 2].first() + [1, 2].last()')).toBe(3);
  expect(evaluate('round(2.7) + abs(-2)')).toBe(5);
  expect(evaluate('empty([])')).toBe(true);
  expect(() => evaluate('[1, "2"].sum()')).toThrow(/numeric/);
});

it('bounds expanded text and nested values from resource properties', () => {
  expect(() =>
    functions.evaluate(parseFormula('prop("text").concat(prop("text"))'), () =>
      'x'.repeat(40000),
    ),
  ).toThrow(/text limit/);
  expect(() =>
    functions.evaluate(parseFormula('prop("text").split("")'), () =>
      'x'.repeat(20000),
    ),
  ).toThrow(/list limit/);
  expect(() =>
    functions.evaluate(parseFormula('prop("rows")'), () =>
      Array.from({ length: 200 }, () => Array(200).fill(1)),
    ),
  ).toThrow(/size limit/);
});

it('evaluates scoped list expressions with pure, bounded iteration', () => {
  expect(
    evaluate(
      '[1, 2, 3].filter(current > 1).map(current * prop("price") + index)',
    ),
  ).toEqual([24, 37]);
  expect(evaluate('["Ada", "Grace"].map(current.upper()).join(", ")')).toBe(
    'ADA, GRACE',
  );
  expect(
    evaluate('[[1, 2], [3]].map(current.map(current + index).sum() + index)'),
  ).toEqual([4, 4]);
  expect(evaluate('[0, 1].some(current == 0 || 1 / current > 0)')).toBe(true);
  expect(evaluate('[1, 2].every(current > 0)')).toBe(true);
  expect(evaluate('[1, 2].find(current > 3)')).toBeNull();
  expect(evaluate('[1, 2].find(current > 1)')).toBe(2);
  expect(evaluate('[].every(current > 0)')).toBe(true);
  expect(() => evaluate('[1].filter(current)')).toThrow(/boolean/);
  expect(() => evaluate('current')).toThrow(/only available/);
  expect(() => evaluate('[1].map(current) + index')).toThrow(/only available/);
  expect(parseFormula('[1].map(current + prop("price"))').dependencies).toEqual(
    ['price'],
  );
  expect(() =>
    functions.evaluate(parseFormula('prop("items").map(current + index)'), () =>
      Array(2000).fill(1),
    ),
  ).toThrow(/evaluation limit/);
  expect(() => functions.register('map', () => null)).toThrow(/duplicate/);
});
