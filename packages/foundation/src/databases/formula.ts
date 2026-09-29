import type { Aggregation, PropertyValue } from './model.js';

export type FormulaExpression =
  | { readonly literal: PropertyValue }
  | { readonly variable: 'current' | 'index' }
  | { readonly call: string; readonly args: readonly FormulaExpression[] };
export interface ParsedFormula {
  readonly expression: FormulaExpression;
  readonly dependencies: readonly string[];
}
export const FORMULA_LIMITS = {
  source: 8192,
  depth: 32,
  operations: 4096,
  text: 65536,
  list: 10000,
} as const;

export function parseFormula(source: string): ParsedFormula {
  if (source.length > FORMULA_LIMITS.source)
    throw new Error('Formula is too long');
  let offset = 0;
  const dependencies = new Set<string>();
  const space = () => {
    while (/\s/.test(source[offset] ?? '') && offset < source.length) offset++;
  };
  const consume = (token: string) => {
    space();
    if (!source.startsWith(token, offset)) return false;
    offset += token.length;
    return true;
  };
  const expect = (token: string) => {
    if (!consume(token)) throw new Error(`Expected ${token} at ${offset}`);
  };
  const call = (name: string, args: FormulaExpression[]): FormulaExpression => {
    if (name === 'prop') {
      const arg = args[0];
      if (
        args.length !== 1 ||
        !arg ||
        !('literal' in arg) ||
        typeof arg.literal !== 'string'
      )
        throw new Error('prop requires a literal property ID');
      dependencies.add(arg.literal);
    }
    return { call: name, args };
  };
  const operators: Readonly<Record<string, readonly [number, string]>> = {
    '||': [1, 'or'],
    '&&': [2, 'and'],
    '==': [3, 'equal'],
    '!=': [3, 'unequal'],
    '<=': [4, 'lessEqual'],
    '>=': [4, 'greaterEqual'],
    '<': [4, 'less'],
    '>': [4, 'greater'],
    '+': [5, 'add'],
    '-': [5, 'subtract'],
    '*': [6, 'multiply'],
    '/': [6, 'divide'],
    '%': [6, 'mod'],
  };
  const argumentsUntil = (end: string, depth: number): FormulaExpression[] => {
    const args: FormulaExpression[] = [];
    if (consume(end)) return args;
    do {
      args.push(parse(depth + 1));
    } while (consume(','));
    expect(end);
    return args;
  };
  const parse = (depth: number, minimum = 0): FormulaExpression => {
    if (depth > FORMULA_LIMITS.depth)
      throw new Error('Formula nesting limit exceeded');
    space();
    let expression: FormulaExpression;
    if (consume('!')) expression = call('not', [parse(depth + 1, 7)]);
    else if (consume('-'))
      expression = call('subtract', [{ literal: 0 }, parse(depth + 1, 7)]);
    else if (consume('(')) {
      expression = parse(depth + 1);
      expect(')');
    } else if (consume('['))
      expression = call('list', argumentsUntil(']', depth));
    else {
      const rest = source.slice(offset);
      const literal =
        /^(?:"(?:[^"\\\r\n]|\\.)*"|(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true\b|false\b|null\b)/.exec(
          rest,
        )?.[0];
      if (literal !== undefined) {
        offset += literal.length;
        const value: PropertyValue = JSON.parse(literal);
        if (typeof value === 'number' && !Number.isFinite(value))
          throw new Error('Number is not finite');
        expression = { literal: value };
      } else if (/^(current|index)\b/.test(rest)) {
        const variable = rest.startsWith('current') ? 'current' : 'index';
        offset += variable.length;
        expression = { variable };
      } else {
        const name = /^[A-Za-z_][A-Za-z_0-9.]*/.exec(rest)?.[0];
        if (!name) throw new Error(`Expected expression at ${offset}`);
        offset += name.length;
        expect('(');
        expression = call(name, argumentsUntil(')', depth));
      }
    }
    for (;;) {
      space();
      if (consume('.')) {
        const method = /^[A-Za-z_][A-Za-z_0-9]*/.exec(
          source.slice(offset),
        )?.[0];
        if (!method || method === 'prop')
          throw new Error(`Expected method at ${offset}`);
        offset += method.length;
        expect('(');
        expression = call(method, [expression, ...argumentsUntil(')', depth)]);
        continue;
      }
      const operator = Object.keys(operators).find((token) =>
        source.startsWith(token, offset),
      );
      const definition = operator ? operators[operator] : undefined;
      if (!operator || !definition || definition[0] < minimum) break;
      offset += operator.length;
      expression = call(definition[1], [
        expression,
        parse(depth + 1, definition[0] + 1),
      ]);
    }
    if (minimum === 0 && consume('?')) {
      const yes = parse(depth + 1);
      expect(':');
      expression = call('if', [expression, yes, parse(depth + 1)]);
    }
    return expression;
  };
  const expression = parse(0);
  space();
  if (offset !== source.length)
    throw new Error(`Unexpected input at ${offset}`);
  return { expression, dependencies: [...dependencies] };
}

export type FormulaFunction = (args: readonly PropertyValue[]) => PropertyValue;
const numbers = (args: readonly PropertyValue[]): number[] =>
  args.map((value) => {
    if (typeof value !== 'number' || !Number.isFinite(value))
      throw new Error('Expected numeric arguments');
    return value;
  });
const strings = (args: readonly PropertyValue[]): string[] =>
  args.map((value) => {
    if (typeof value !== 'string') throw new Error('Expected text arguments');
    return value;
  });
function arity(args: readonly PropertyValue[], count: number): void {
  if (args.length !== count) throw new Error(`Expected ${count} arguments`);
}
const builtins: Readonly<Record<string, FormulaFunction>> = {
  add: (args) => numbers(args).reduce((a, b) => a + b, 0),
  multiply: (args) => numbers(args).reduce((a, b) => a * b, 1),
  subtract: (args) => {
    arity(args, 2);
    const [a, b] = numbers(args);
    return a! - b!;
  },
  divide: (args) => {
    arity(args, 2);
    const [a, b] = numbers(args);
    if (b === 0) throw new Error('Division by zero');
    return a! / b!;
  },
  concat: (args) => joinText(strings(args), ''),
  lower: (args) => {
    arity(args, 1);
    return strings(args)[0]!.toLowerCase();
  },
  upper: (args) => {
    arity(args, 1);
    return strings(args)[0]!.toUpperCase();
  },
  list: (args) => [...args],
  sum: (args) => {
    arity(args, 1);
    return aggregate(list(args[0]), 'sum');
  },
  average: (args) => {
    arity(args, 1);
    return aggregate(list(args[0]), 'average');
  },
  min: (args) => {
    arity(args, 1);
    return aggregate(list(args[0]), 'min');
  },
  max: (args) => {
    arity(args, 1);
    return aggregate(list(args[0]), 'max');
  },
  unique: (args) => {
    arity(args, 1);
    return aggregate(list(args[0]), 'unique');
  },
  first: (args) => {
    arity(args, 1);
    return list(args[0])[0] ?? null;
  },
  last: (args) => {
    arity(args, 1);
    return list(args[0]).at(-1) ?? null;
  },
  abs: (args) => {
    arity(args, 1);
    return Math.abs(numbers(args)[0]!);
  },
  round: (args) => {
    arity(args, 1);
    return Math.round(numbers(args)[0]!);
  },
  floor: (args) => {
    arity(args, 1);
    return Math.floor(numbers(args)[0]!);
  },
  ceil: (args) => {
    arity(args, 1);
    return Math.ceil(numbers(args)[0]!);
  },
  empty: (args) => {
    arity(args, 1);
    const value = args[0];
    return (
      value === null ||
      value === '' ||
      (Array.isArray(value) && value.length === 0)
    );
  },
  contains: (args) => {
    arity(args, 2);
    const [value, needle] = args;
    if (typeof value === 'string' && typeof needle === 'string')
      return value.includes(needle);
    return list(value).some(
      (item) => JSON.stringify(item) === JSON.stringify(needle),
    );
  },
  split: (args) => {
    arity(args, 2);
    const [value, separator] = strings(args);
    return value!.split(separator!, FORMULA_LIMITS.list + 1);
  },
  join: (args) => {
    arity(args, 2);
    const values = strings(list(args[0]));
    const separator = strings([args[1]!])[0]!;
    return joinText(values, separator);
  },
  length: (args) => {
    arity(args, 1);
    const value = args[0];
    if (typeof value !== 'string' && !Array.isArray(value))
      throw new Error('Expected text or list');
    return value.length;
  },
  equal: (args) => {
    arity(args, 2);
    return JSON.stringify(args[0]) === JSON.stringify(args[1]);
  },
  unequal: (args) => {
    arity(args, 2);
    return JSON.stringify(args[0]) !== JSON.stringify(args[1]);
  },
  less: (args) => compare(args) < 0,
  lessEqual: (args) => compare(args) <= 0,
  greater: (args) => compare(args) > 0,
  greaterEqual: (args) => compare(args) >= 0,
  mod: (args) => {
    arity(args, 2);
    const [a, b] = numbers(args);
    if (b === 0) throw new Error('Division by zero');
    return a! % b!;
  },
  not: (args) => {
    arity(args, 1);
    if (typeof args[0] !== 'boolean') throw new Error('Expected boolean');
    return !args[0];
  },
  dateAdd: (args) => {
    arity(args, 2);
    const [date, days] = args;
    if (
      typeof date !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      typeof days !== 'number' ||
      !Number.isInteger(days)
    )
      throw new Error('Expected date and integer days');
    const millis = Date.parse(date);
    if (
      !Number.isFinite(millis) ||
      new Date(millis).toISOString().slice(0, 10) !== date
    )
      throw new Error('Invalid date');
    return new Date(millis + days * 86400000).toISOString().slice(0, 10);
  },
};

function list(value: PropertyValue | undefined): readonly PropertyValue[] {
  if (!Array.isArray(value)) throw new Error('Expected list');
  return value;
}

function joinText(values: readonly string[], separator: string): string {
  const length =
    values.reduce((size, value) => size + value.length, 0) +
    Math.max(0, values.length - 1) * separator.length;
  if (length > FORMULA_LIMITS.text)
    throw new Error('Formula text limit exceeded');
  return values.join(separator);
}

function boundedValue(
  value: PropertyValue,
  depth = 0,
  budget = { remaining: FORMULA_LIMITS.list as number },
): void {
  if (--budget.remaining < 0)
    throw new Error('Formula value size limit exceeded');
  if (depth > FORMULA_LIMITS.depth)
    throw new Error('Formula result nesting limit exceeded');
  if (typeof value === 'number' && !Number.isFinite(value))
    throw new Error('Formula result is not finite');
  if (typeof value === 'string' && value.length > FORMULA_LIMITS.text)
    throw new Error('Formula text limit exceeded');
  if (Array.isArray(value)) {
    if (value.length > FORMULA_LIMITS.list)
      throw new Error('Formula list limit exceeded');
    for (const item of value) boundedValue(item, depth + 1, budget);
  } else if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value))
      boundedValue(item, depth + 1, budget);
  }
}

function compare(args: readonly PropertyValue[]): number {
  arity(args, 2);
  const [a, b] = args;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string')
    return a === b ? 0 : a < b ? -1 : 1;
  throw new Error('Comparison requires two numbers or two text values');
}

/** Only trusted pure functions may be registered; this is not a sandbox. */
export class FormulaFunctions {
  readonly #functions = new Map<string, FormulaFunction>(
    Object.entries(builtins),
  );
  register(name: string, fn: FormulaFunction): { dispose(): void } {
    if (
      !/^[A-Za-z_][A-Za-z_0-9.]*$/.test(name) ||
      [
        'prop',
        'if',
        'and',
        'or',
        'map',
        'filter',
        'some',
        'every',
        'find',
        'current',
        'index',
      ].includes(name) ||
      /^(current|index)\./.test(name) ||
      this.#functions.has(name)
    )
      throw new Error(`Invalid or duplicate formula function: ${name}`);
    this.#functions.set(name, fn);
    return {
      dispose: () => {
        if (this.#functions.get(name) === fn) this.#functions.delete(name);
      },
    };
  }
  evaluate(
    parsed: ParsedFormula,
    property: (id: string) => PropertyValue,
  ): PropertyValue {
    let operations = 0;
    const visit = (
      node: FormulaExpression,
      depth = 0,
      scope?: { current: PropertyValue; index: number },
    ): PropertyValue => {
      if (
        ++operations > FORMULA_LIMITS.operations ||
        depth > FORMULA_LIMITS.depth
      )
        throw new Error('Formula evaluation limit exceeded');
      if ('literal' in node) return node.literal;
      if ('variable' in node) {
        if (!scope)
          throw new Error(
            `${node.variable} is only available inside a list expression`,
          );
        return scope[node.variable];
      }
      if (node.call === 'prop') {
        const value = property((node.args[0] as { literal: string }).literal);
        boundedValue(value);
        return value;
      }
      if (['map', 'filter', 'some', 'every', 'find'].includes(node.call)) {
        if (node.args.length !== 2)
          throw new Error(`${node.call} requires a list and an expression`);
        const input = list(visit(node.args[0]!, depth + 1, scope));
        const output: PropertyValue[] = [];
        for (const [index, current] of input.entries()) {
          const value = visit(node.args[1]!, depth + 1, { current, index });
          if (node.call === 'map') output.push(value);
          else {
            if (typeof value !== 'boolean')
              throw new Error(`${node.call} requires a boolean expression`);
            if (node.call === 'some' && value) return true;
            if (node.call === 'every' && !value) return false;
            if (node.call === 'find' && value) return current;
            if (node.call === 'filter' && value) output.push(current);
          }
        }
        if (node.call === 'some') return false;
        if (node.call === 'every') return true;
        if (node.call === 'find') return null;
        boundedValue(output);
        return output;
      }
      if (node.call === 'and' || node.call === 'or') {
        if (node.args.length !== 2)
          throw new Error('Boolean operators require two arguments');
        const left = visit(node.args[0]!, depth + 1, scope);
        if (typeof left !== 'boolean') throw new Error('Expected boolean');
        if (node.call === 'and' ? !left : left) return left;
        const right = visit(node.args[1]!, depth + 1, scope);
        if (typeof right !== 'boolean') throw new Error('Expected boolean');
        return right;
      }
      if (node.call === 'if') {
        if (node.args.length !== 3)
          throw new Error('if requires three arguments');
        const condition = visit(node.args[0]!, depth + 1, scope);
        if (typeof condition !== 'boolean')
          throw new Error('if requires a boolean condition');
        return visit(node.args[condition ? 1 : 2]!, depth + 1, scope);
      }
      const fn = this.#functions.get(node.call);
      if (!fn) throw new Error(`Unknown formula function: ${node.call}`);
      const result = fn(node.args.map((arg) => visit(arg, depth + 1, scope)));
      boundedValue(result);
      return result;
    };
    return visit(parsed.expression);
  }
}

export function aggregate(
  values: readonly PropertyValue[],
  operation: Aggregation,
): PropertyValue {
  const present = values.filter((value) => value !== null);
  if (operation === 'count') return present.length;
  if (operation === 'list') return [...present];
  if (operation === 'unique')
    return [
      ...new Map(
        present.map((value) => [JSON.stringify(value), value]),
      ).values(),
    ];
  const input = numbers(present);
  if (input.length === 0) return operation === 'sum' ? 0 : null;
  const sum = input.reduce((a, b) => a + b, 0);
  const result =
    operation === 'sum'
      ? sum
      : operation === 'average'
        ? sum / input.length
        : input.reduce((a, b) =>
            operation === 'min' ? Math.min(a, b) : Math.max(a, b),
          );
  if (!Number.isFinite(result))
    throw new Error('Aggregation result is not finite');
  return result;
}
