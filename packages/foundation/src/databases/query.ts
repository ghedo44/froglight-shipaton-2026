import type {
  ResourcePropertyRow,
  ResourcePropertyRowSource,
} from '../resource-properties/contract.js';
import type { ResourceId } from '../identity.js';
import {
  aggregate,
  FormulaFunctions,
  parseFormula,
  type ParsedFormula,
} from './formula.js';
import { databaseDateInterval } from './dates.js';
import {
  type DatabaseFilter,
  type DatabaseFilterExpression,
  type DatabaseModel,
  type DatabaseRelativeDatePeriod,
  type DatabaseView,
  type PropertyValue,
} from './model.js';
import { PropertyCatalog } from '../resource-properties/catalog.js';
import type { DatabaseDefinitions } from './definitions.js';
import type { RelationshipService } from '../relationships.js';

export type DatabaseRow = ResourcePropertyRow;
export interface EvaluatedDatabaseRow extends DatabaseRow {
  readonly diagnostics: Readonly<Record<string, string>>;
}
export type DatabaseRowInput =
  | readonly DatabaseRow[]
  | ResourcePropertyRowSource;
export interface DatabaseQueryOptions {
  readonly signal?: AbortSignal;
  /** Maximum ordinary results. Requested IDs are returned in addition. */
  readonly limit?: number;
  readonly include?: readonly ResourceId[];
  readonly evaluation?: DatabaseEvaluationContext;
}
export interface DatabaseEvaluationContext {
  /** Stable epoch milliseconds captured by the caller for this evaluation. */
  readonly nowMillis: number;
  /** IANA timezone name, such as `Europe/Rome` or `UTC`. */
  readonly timeZone: string;
}
/** Capture ambient time once at an operation boundary, before pure evaluation. */
export function captureDatabaseEvaluationContext(): DatabaseEvaluationContext {
  return {
    nowMillis: Date.now(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}
export interface DatabaseQueryProvider {
  execute(
    database: DatabaseModel,
    view: DatabaseView,
    rows: DatabaseRowInput,
    search?: string,
    options?: DatabaseQueryOptions,
  ): readonly EvaluatedDatabaseRow[] | Promise<readonly EvaluatedDatabaseRow[]>;
}
export function throwIfDatabaseQueryAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error('Database query aborted');
  error.name = 'AbortError';
  throw error;
}
function rowAccess(rows: DatabaseRowInput): {
  scan(): Iterable<DatabaseRow>;
  get(id: ResourceId): DatabaseRow | undefined;
} {
  if (!Array.isArray(rows)) return rows as ResourcePropertyRowSource;
  const byId = new Map(rows.map((row) => [row.resourceId, row]));
  return { scan: () => rows, get: (id) => byId.get(id) };
}
function valueOf(row: DatabaseRow, key: string): PropertyValue {
  if (key === '$title') return row.title;
  if (key === '$kind') return row.kindId;
  if (key === '$path') return row.path;
  return Object.hasOwn(row.values, key) ? row.values[key]! : null;
}
const relativeDatePeriods = new Set<DatabaseRelativeDatePeriod>([
  'today',
  'yesterday',
  'tomorrow',
  'past-7-days',
  'next-7-days',
]);
function localCalendarDate(millis: number, timeZone: string): string {
  if (!Number.isFinite(millis)) throw new Error('Invalid evaluation time');
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(millis));
  } catch {
    throw new Error(`Invalid evaluation timezone: ${timeZone}`);
  }
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  const year = value('year'),
    month = value('month'),
    day = value('day');
  if (!year || !month || !day) throw new Error('Calendar date unavailable');
  return `${year}-${month}-${day}`;
}
function shiftCalendarDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
function relativeDateRange(
  period: DatabaseRelativeDatePeriod,
  context: DatabaseEvaluationContext | undefined,
): readonly [string, string] {
  if (!context)
    throw new Error('Relative date filter requires an evaluation context');
  const today = localCalendarDate(context.nowMillis, context.timeZone);
  switch (period) {
    case 'today':
      return [today, today];
    case 'yesterday': {
      const day = shiftCalendarDate(today, -1);
      return [day, day];
    }
    case 'tomorrow': {
      const day = shiftCalendarDate(today, 1);
      return [day, day];
    }
    case 'past-7-days':
      return [shiftCalendarDate(today, -6), today];
    case 'next-7-days':
      return [today, shiftCalendarDate(today, 6)];
  }
}
function calendarEndpoint(value: string, context: DatabaseEvaluationContext) {
  return value.length === 10
    ? value
    : localCalendarDate(Date.parse(value), context.timeZone);
}
function matchesRelativeDate(
  value: PropertyValue,
  period: PropertyValue,
  context: DatabaseEvaluationContext | undefined,
): boolean {
  if (
    typeof period !== 'string' ||
    !relativeDatePeriods.has(period as DatabaseRelativeDatePeriod)
  )
    throw new Error('Invalid relative date period');
  if (!context)
    throw new Error('Relative date filter requires an evaluation context');
  const interval = databaseDateInterval(value);
  if (!interval) return false;
  const [expectedStart, expectedEnd] = relativeDateRange(
    period as DatabaseRelativeDatePeriod,
    context,
  );
  const start = calendarEndpoint(interval.start, context);
  const end = calendarEndpoint(interval.end, context);
  return start <= expectedEnd && end >= expectedStart;
}
export function nextDatabaseDayBoundary(
  context: DatabaseEvaluationContext,
): number {
  const current = localCalendarDate(context.nowMillis, context.timeZone);
  let low = Math.floor(context.nowMillis) + 1;
  let high = low + 48 * 60 * 60 * 1000;
  if (localCalendarDate(high, context.timeZone) === current)
    throw new Error('Next calendar day boundary unavailable');
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (localCalendarDate(middle, context.timeZone) === current)
      low = middle + 1;
    else high = middle;
  }
  return low;
}
export function matchesDatabaseFilters(
  row: DatabaseRow,
  filters: readonly DatabaseFilter[],
  evaluation?: DatabaseEvaluationContext,
): boolean {
  return filters.every((filter) => {
    const value = valueOf(row, filter.property);
    const expected = filter.value ?? null;
    switch (filter.operator) {
      case 'empty':
        return (
          value === null ||
          value === '' ||
          (Array.isArray(value) && value.length === 0)
        );
      case 'date-relative':
        return matchesRelativeDate(value, expected, evaluation);
      case 'eq':
        return JSON.stringify(value) === JSON.stringify(expected);
      case 'neq':
        return JSON.stringify(value) !== JSON.stringify(expected);
      case 'contains':
        return typeof value === 'string' && typeof expected === 'string'
          ? value.includes(expected)
          : Array.isArray(value) &&
              value.some(
                (item) => JSON.stringify(item) === JSON.stringify(expected),
              );
      case 'gt':
        return typeof value === 'number' && typeof expected === 'number'
          ? value > expected
          : typeof value === 'string' &&
              typeof expected === 'string' &&
              value > expected;
      case 'lt':
        return typeof value === 'number' && typeof expected === 'number'
          ? value < expected
          : typeof value === 'string' &&
              typeof expected === 'string' &&
              value < expected;
      default:
        throw new Error('Query operator unavailable');
    }
  });
}

export function filterLeaves(
  expression: DatabaseFilterExpression,
): readonly DatabaseFilter[] {
  return 'filters' in expression
    ? expression.filters.flatMap(filterLeaves)
    : [expression];
}

export function matchesDatabaseFilterExpression(
  row: DatabaseRow,
  expression: DatabaseFilterExpression,
  evaluation?: DatabaseEvaluationContext,
): boolean {
  if (!('filters' in expression))
    return matchesDatabaseFilters(row, [expression], evaluation);
  return expression.operator === 'and'
    ? expression.filters.every((child) =>
        matchesDatabaseFilterExpression(row, child, evaluation),
      )
    : expression.filters.some((child) =>
        matchesDatabaseFilterExpression(row, child, evaluation),
      );
}

export function conjoinDatabaseFilterExpressions(
  left?: DatabaseFilterExpression,
  right?: DatabaseFilterExpression,
): DatabaseFilterExpression | undefined {
  if (!left) return right;
  if (!right) return left;
  return { operator: 'and', filters: [left, right] };
}

/** Deterministic reference provider; all output is disposable derived state. */
export class InMemoryDatabaseQueryProvider implements DatabaseQueryProvider {
  constructor(
    readonly functions = new FormulaFunctions(),
    readonly catalog = new PropertyCatalog(),
    readonly definitions?: DatabaseDefinitions,
    readonly relationships?: RelationshipService,
  ) {}
  execute(
    database: DatabaseModel,
    view: DatabaseView,
    rows: DatabaseRowInput,
    search = '',
    options: DatabaseQueryOptions = {},
  ): readonly EvaluatedDatabaseRow[] {
    throwIfDatabaseQueryAborted(options.signal);
    if (
      options.limit !== undefined &&
      (!Number.isSafeInteger(options.limit) || options.limit < 1)
    )
      throw new Error('Database query limit must be a positive integer');
    const limit = options.limit;
    const sourceRows = rowAccess(rows);
    const known = new Set([
      '$title',
      '$kind',
      '$path',
      ...database.properties.map((property) => property.id),
    ]);
    const filters = [
      ...(database.membership.mode === 'query'
        ? database.membership.filters
        : []),
      ...(view.filters ?? []),
      ...(database.membership.mode === 'query' && database.membership.where
        ? filterLeaves(database.membership.where)
        : []),
      ...(view.where ? filterLeaves(view.where) : []),
    ];
    for (const filter of filters) {
      if (!known.has(filter.property))
        throw new Error(`Filter property unavailable: ${filter.property}`);
      if (filter.operator === 'date-relative') {
        const property = database.properties.find(
          (item) => item.id === filter.property,
        );
        if (
          !property ||
          !['date', 'created', 'updated'].includes(property.type)
        )
          throw new Error('Relative date filter requires a date property');
        matchesRelativeDate(null, filter.value ?? null, options.evaluation);
      }
    }
    let contextId = 0;
    const contexts = new Map<
      DatabaseModel,
      {
        id: number;
        schema: Map<string, DatabaseModel['properties'][number]>;
        formulas: Map<string, ParsedFormula | Error>;
        evaluated: Map<ResourceId, EvaluatedDatabaseRow>;
      }
    >();
    const context = (model: DatabaseModel) => {
      let entry = contexts.get(model);
      if (entry) return entry;
      const formulas = new Map<string, ParsedFormula | Error>();
      for (const property of model.properties) {
        if (property.type !== 'formula') continue;
        try {
          formulas.set(property.id, parseFormula(property.formula ?? ''));
        } catch (error) {
          formulas.set(
            property.id,
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      }
      entry = {
        id: contextId++,
        schema: new Map(
          model.properties.map((property) => [property.id, property]),
        ),
        formulas,
        evaluated: new Map(),
      };
      contexts.set(model, entry);
      return entry;
    };
    const sources = sourceRows;
    let inverseEdges: Map<string, ResourceId[]> | undefined;
    const inverseSources = (
      target: ResourceId,
      property: string,
    ): ResourceId[] => {
      if (!this.relationships)
        throw new Error('Relationship provider unavailable');
      if (!inverseEdges) {
        inverseEdges = new Map();
        for (const edge of this.relationships.list()) {
          if (
            edge.type !== 'database-relation' ||
            typeof edge.metadata.propertyId !== 'string'
          )
            continue;
          const key = JSON.stringify([
            edge.target.location.resourceId,
            edge.metadata.propertyId,
          ]);
          const ids = inverseEdges.get(key) ?? [];
          ids.push(edge.source.resourceId);
          inverseEdges.set(key, ids);
        }
      }
      return [
        ...new Set(inverseEdges.get(JSON.stringify([target, property])) ?? []),
      ].sort();
    };
    const visiting = new Set<string>();
    let operations = 0;
    const read = (
      row: DatabaseRow,
      id: string,
      model = database,
    ): PropertyValue => {
      if (++operations > 1_000_000)
        throw new Error('Database evaluation limit exceeded');
      if (operations % 256 === 0) throwIfDatabaseQueryAborted(options.signal);
      const { schema, formulas, evaluated, id: scope } = context(model);
      const property = schema.get(id);
      if (!property) {
        if (['$title', '$kind', '$path'].includes(id)) return valueOf(row, id);
        throw new Error(`Unknown property: ${id}`);
      }
      let target = evaluated.get(row.resourceId);
      if (!target) {
        target = {
          ...row,
          values: Object.create(null),
          diagnostics: { ...row.diagnostics },
        };
        evaluated.set(row.resourceId, target);
      }
      if (Object.hasOwn(target.diagnostics, id))
        throw new Error(target.diagnostics[id]);
      if (Object.hasOwn(target.values, id)) return target.values[id]!;
      const key = JSON.stringify([scope, row.resourceId, id]);
      if (visiting.has(key) || visiting.size >= 128)
        throw new Error(
          `Formula/rollup dependency cycle or depth limit: ${id}`,
        );
      visiting.add(key);
      try {
        let value: PropertyValue;
        if (property.type === 'formula') {
          const parsed = formulas.get(id)!;
          if (parsed instanceof Error) throw parsed;
          // Validate all dependencies, including untaken conditional branches.
          for (const dependency of parsed.dependencies)
            read(row, dependency, model);
          value = this.functions.evaluate(parsed, (dependency) =>
            read(row, dependency, model),
          );
        } else if (property.type === 'rollup') {
          const rollup = property.rollup;
          if (!rollup) throw new Error('Missing rollup definition');
          const relation = schema.get(rollup.relation);
          if (relation?.type !== 'relation')
            throw new Error('Rollup requires a relation property');
          const targetModel = relation.relation?.databaseId
            ? this.definitions?.get(relation.relation.databaseId as ResourceId)
            : model;
          if (!targetModel) throw new Error('Related database unavailable');
          const targetProperty = context(targetModel).schema.get(
            rollup.property,
          );
          if (!targetProperty)
            throw new Error(`Related property unavailable: ${rollup.property}`);
          if (targetProperty.type === 'rollup')
            throw new Error('Rollup-of-rollup is not supported');
          const relations = read(row, rollup.relation, model);
          if (relations !== null && !Array.isArray(relations))
            throw new Error('Rollup requires a relation list');
          const values = (relations ?? []).map((id) => {
            if (typeof id !== 'string') throw new Error('Invalid relation ID');
            const source = sources.get(id as ResourceId);
            if (!source) throw new Error(`Missing related resource: ${id}`);
            // A configured target database constrains the relation's resource set.
            if (relation.relation?.databaseId) {
              const membership = targetModel.membership;
              if (membership.mode === 'explicit') {
                if (!membership.resourceIds.includes(source.resourceId))
                  throw new Error(`Related resource is not a member: ${id}`);
              } else {
                const values = { ...source.values };
                for (const filter of [
                  ...membership.filters,
                  ...(membership.where ? filterLeaves(membership.where) : []),
                ])
                  values[filter.property] = read(
                    source,
                    filter.property,
                    targetModel,
                  );
                if (
                  !matchesDatabaseFilters(
                    { ...source, values },
                    membership.filters,
                    options.evaluation,
                  ) ||
                  (membership.where &&
                    !matchesDatabaseFilterExpression(
                      { ...source, values },
                      membership.where,
                      options.evaluation,
                    ))
                )
                  throw new Error(`Related resource is not a member: ${id}`);
              }
            }
            return read(source, rollup.property, targetModel);
          });
          value = aggregate(values, rollup.aggregation);
        } else if (property.type === 'relation' && property.relation?.inverse) {
          if (!this.relationships || !property.relation.inversePropertyId)
            throw new Error(
              'Inverse relation provider or property unavailable',
            );
          const forwardModel = this.definitions?.get(
            property.relation.databaseId as ResourceId,
          );
          const forward = forwardModel?.properties.find(
            (item) => item.id === property.relation?.inversePropertyId,
          );
          if (forward?.type !== 'relation' || forward.relation?.inverse)
            throw new Error(
              'Inverse relation requires a stored forward relation',
            );
          if (forward.relation?.inversePropertyId !== property.id)
            throw new Error(
              'Inverse relation does not match its forward property',
            );
          value = inverseSources(row.resourceId, forward.id);
        } else if (property.type === 'created' || property.type === 'updated') {
          const millis =
            property.type === 'created' ? row.createdMillis : row.updatedMillis;
          value = millis === undefined ? null : new Date(millis).toISOString();
        } else {
          value = valueOf(row, id);
          const diagnostic = this.catalog.diagnostic(property, value);
          if (diagnostic) throw new Error(diagnostic);
        }
        (target.values as Record<string, PropertyValue>)[id] = value;
        return value;
      } catch (error) {
        (target.values as Record<string, PropertyValue>)[id] = null;
        (target.diagnostics as Record<string, string>)[id] =
          error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        visiting.delete(key);
      }
    };
    const selected =
      database.membership.mode === 'explicit'
        ? database.membership.resourceIds
            .map((id) => sources.get(id))
            .filter((row): row is DatabaseRow => row !== undefined)
        : sourceRows.scan();
    const result: EvaluatedDatabaseRow[] = [];
    const included: EvaluatedDatabaseRow[] = [];
    const remainingIncludes = new Set(options.include ?? []);
    const canStopEarly = limit !== undefined && (view.sorts?.length ?? 0) === 0;
    for (const row of selected) {
      throwIfDatabaseQueryAborted(options.signal);
      for (const property of database.properties) {
        try {
          read(row, property.id);
        } catch {
          /* Per-cell diagnostics retain the other usable values. */
        }
      }
      const entry = context(database).evaluated.get(row.resourceId) ?? {
        ...row,
        diagnostics: { ...row.diagnostics },
      };
      const projected = {
        ...entry,
        values: { ...row.values, ...entry.values },
      };
      if (
        database.membership.mode === 'query' &&
        !matchesDatabaseFilters(
          projected,
          database.membership.filters,
          options.evaluation,
        )
      )
        continue;
      if (
        database.membership.mode === 'query' &&
        database.membership.where &&
        !matchesDatabaseFilterExpression(
          projected,
          database.membership.where,
          options.evaluation,
        )
      )
        continue;
      if (
        !matchesDatabaseFilters(
          projected,
          view.filters ?? [],
          options.evaluation,
        )
      )
        continue;
      if (
        view.where &&
        !matchesDatabaseFilterExpression(
          projected,
          view.where,
          options.evaluation,
        )
      )
        continue;
      if (
        search &&
        ![row.title, ...Object.values(projected.values)]
          .join(' ')
          .toLowerCase()
          .includes(search.toLowerCase())
      )
        continue;
      if (remainingIncludes.delete(projected.resourceId))
        included.push(projected);
      if (!canStopEarly || result.length < (limit ?? Number.MAX_SAFE_INTEGER))
        result.push(projected);
      if (
        canStopEarly &&
        result.length >= (limit ?? Number.MAX_SAFE_INTEGER) &&
        remainingIncludes.size === 0
      )
        break;
    }
    const sorted = result.sort((a, b) => {
      for (const sort of view.sorts ?? []) {
        const av = valueOf(a, sort.property),
          bv = valueOf(b, sort.property);
        const comparison =
          av === bv
            ? 0
            : av === null
              ? 1
              : bv === null
                ? -1
                : typeof av === 'number' && typeof bv === 'number'
                  ? av - bv
                  : String(av) < String(bv)
                    ? -1
                    : 1;
        if (comparison) return sort.descending ? -comparison : comparison;
      }
      return (view.sorts?.length ?? 0) > 0
        ? a.resourceId.localeCompare(b.resourceId)
        : 0;
    });
    const visible = limit === undefined ? sorted : sorted.slice(0, limit);
    return [
      ...visible,
      ...included.filter(
        (row) => !visible.some((item) => item.resourceId === row.resourceId),
      ),
    ];
  }
}

export function resolveDatabaseView(
  database: DatabaseModel,
  viewId: string,
  overrides: Partial<DatabaseView> = {},
): DatabaseView {
  const source = database.views.find((view) => view.id === viewId);
  if (!source) throw new Error(`Saved view unavailable: ${viewId}`);
  return {
    ...source,
    ...overrides,
    id: source.id,
    filters: [...(source.filters ?? []), ...(overrides.filters ?? [])],
    where: conjoinDatabaseFilterExpressions(source.where, overrides.where),
  };
}
