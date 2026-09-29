import type { ResourceId } from '../identity.js';
import type { RelationshipService } from '../relationships.js';
import type { ResourcePropertyService } from '../resource-properties/contract.js';
import type { WorkspaceService } from '../workspace.js';
import type { DatabaseDefinitions } from './definitions.js';
import type {
  DatabaseFilterExpression,
  DatabaseModel,
  DatabaseProperty,
  PropertyValue,
} from './model.js';
import {
  captureDatabaseEvaluationContext,
  type DatabaseEvaluationContext,
  type DatabaseQueryProvider,
  throwIfDatabaseQueryAborted,
} from './query.js';
import type {
  ResourcePropertyRow,
  ResourcePropertyRowSource,
} from '../resource-properties/contract.js';

export interface DatabaseRelationChoice {
  readonly id: ResourceId;
  readonly title: string;
}
export const DATABASE_RELATION_CHOICE_LIMIT = 50;
export interface DatabaseRelationChoiceOptions {
  readonly signal?: AbortSignal;
  readonly limit?: number;
  /** Referenced IDs to resolve in addition to the bounded ordinary results. */
  readonly include?: Readonly<Record<string, readonly ResourceId[]>>;
  readonly evaluation?: DatabaseEvaluationContext;
}

function relationValues(value: PropertyValue | undefined): ResourceId[] {
  if (typeof value === 'string') return [value as ResourceId];
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item as ResourceId);
}

function filterRelationValues(
  expression: DatabaseFilterExpression | undefined,
  relationIds: ReadonlySet<string>,
  add: (property: string, value: PropertyValue | undefined) => void,
): void {
  if (!expression) return;
  if ('filters' in expression) {
    for (const child of expression.filters)
      filterRelationValues(child, relationIds, add);
    return;
  }
  if (relationIds.has(expression.property))
    add(expression.property, expression.value);
}

/** Collect retained relation references whose labels must survive a bounded lookup. */
export function databaseRelationChoiceIncludes(
  model: DatabaseModel,
  rows: Iterable<Pick<ResourcePropertyRow, 'values'>>,
): Readonly<Record<string, readonly ResourceId[]>> {
  const relationIds = new Set(
    model.properties
      .filter((property) => property.type === 'relation')
      .map((property) => property.id),
  );
  const values = new Map<string, Set<ResourceId>>();
  const add = (property: string, value: PropertyValue | undefined) => {
    if (!relationIds.has(property)) return;
    let selected = values.get(property);
    if (!selected) values.set(property, (selected = new Set()));
    for (const id of relationValues(value)) selected.add(id);
  };
  for (const row of rows)
    for (const property of relationIds) add(property, row.values[property]);
  for (const template of model.templates)
    for (const property of relationIds)
      add(property, template.defaults[property]);
  for (const view of model.views) {
    for (const filter of view.filters ?? [])
      if (relationIds.has(filter.property)) add(filter.property, filter.value);
    filterRelationValues(view.where, relationIds, add);
  }
  return Object.fromEntries(
    [...values].map(([property, selected]) => [property, [...selected]]),
  );
}

function rowAccess(
  rows: readonly ResourcePropertyRow[] | ResourcePropertyRowSource,
): {
  scan(): Iterable<ResourcePropertyRow>;
  get(id: ResourceId): ResourcePropertyRow | undefined;
} {
  if (!Array.isArray(rows)) return rows as ResourcePropertyRowSource;
  const byId = new Map(rows.map((row) => [row.resourceId, row]));
  return { scan: () => rows, get: (id) => byId.get(id) };
}

function addChoice(
  choices: DatabaseRelationChoice[],
  seen: Set<ResourceId>,
  row: ResourcePropertyRow,
): void {
  if (seen.has(row.resourceId)) return;
  seen.add(row.resourceId);
  choices.push({ id: row.resourceId, title: row.title });
}

export async function databaseRelationChoices(
  model: DatabaseModel,
  query: DatabaseQueryProvider,
  rows: readonly ResourcePropertyRow[] | ResourcePropertyRowSource,
  definitions?: DatabaseDefinitions,
  options: DatabaseRelationChoiceOptions = {},
): Promise<Readonly<Record<string, readonly DatabaseRelationChoice[]>>> {
  const limit = options.limit ?? DATABASE_RELATION_CHOICE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error('Relation choice limit must be a positive integer');
  throwIfDatabaseQueryAborted(options.signal);
  const choices: Record<string, readonly DatabaseRelationChoice[]> =
    Object.create(null);
  const source = rowAccess(rows);
  const targets = new Map<string, readonly DatabaseRelationChoice[]>();
  for (const property of model.properties) {
    throwIfDatabaseQueryAborted(options.signal);
    if (property.type !== 'relation') continue;
    const selected = options.include?.[property.id] ?? [];
    const targetId = property.relation?.databaseId;
    if (!targetId) {
      const propertyChoices: DatabaseRelationChoice[] = [];
      const seen = new Set<ResourceId>();
      for (const row of source.scan()) {
        throwIfDatabaseQueryAborted(options.signal);
        addChoice(propertyChoices, seen, row);
        if (propertyChoices.length === limit) break;
      }
      for (const id of selected) {
        throwIfDatabaseQueryAborted(options.signal);
        const row = source.get(id);
        if (row) addChoice(propertyChoices, seen, row);
      }
      choices[property.id] = propertyChoices;
      continue;
    }
    let targetChoices = targets.get(targetId);
    if (!targetChoices) {
      const target = definitions?.get(targetId as ResourceId);
      if (!target) targetChoices = [];
      else if (target.membership.mode === 'explicit') {
        const explicit: DatabaseRelationChoice[] = [];
        const seen = new Set<ResourceId>();
        for (const id of target.membership.resourceIds) {
          throwIfDatabaseQueryAborted(options.signal);
          const row = source.get(id);
          if (row) addChoice(explicit, seen, row);
          if (explicit.length === limit) break;
        }
        targetChoices = explicit;
      } else {
        targetChoices = (
          await query.execute(
            target,
            { id: 'membership', name: '', type: 'table' },
            rows,
            '',
            {
              signal: options.signal,
              limit,
              evaluation:
                options.evaluation ?? captureDatabaseEvaluationContext(),
            },
          )
        ).map((row) => ({ id: row.resourceId, title: row.title }));
      }
      targets.set(targetId, targetChoices);
    }
    const propertyChoices = [...targetChoices];
    const seen = new Set(propertyChoices.map((choice) => choice.id));
    const target = definitions?.get(targetId as ResourceId);
    if (target?.membership.mode === 'explicit') {
      const members = new Set(target.membership.resourceIds);
      for (const id of selected) {
        throwIfDatabaseQueryAborted(options.signal);
        if (!members.has(id)) continue;
        const row = source.get(id);
        if (row) addChoice(propertyChoices, seen, row);
      }
    } else if (target && selected.length > 0) {
      const requested = new Set(selected);
      const selectedSource: ResourcePropertyRowSource = {
        revision: 0,
        scan: () =>
          (function* () {
            for (const id of requested) {
              throwIfDatabaseQueryAborted(options.signal);
              const row = source.get(id);
              if (row) yield row;
            }
          })(),
        get: (id) => source.get(id),
      };
      const resolved = await query.execute(
        target,
        { id: 'membership-selection', name: '', type: 'table' },
        selectedSource,
        '',
        {
          signal: options.signal,
          evaluation: options.evaluation ?? captureDatabaseEvaluationContext(),
        },
      );
      for (const row of resolved) addChoice(propertyChoices, seen, row);
    }
    choices[property.id] = propertyChoices;
  }
  return choices;
}

export interface DatabaseRelationContext {
  readonly definitions: DatabaseDefinitions;
  readonly relationships: RelationshipService;
}
export class PartialRelationWriteError extends Error {
  constructor(
    readonly committedResources: readonly ResourceId[],
    readonly failedResource: ResourceId,
    cause: unknown,
  ) {
    super(
      `Relation update stopped after saving ${committedResources.length} resources; failed resource: ${failedResource}`,
      { cause },
    );
    this.name = 'PartialRelationWriteError';
  }
}

/** Inverse edits modify canonical forward properties; no mirrored cell is stored. */
export async function writeInverseRelation(
  context: DatabaseRelationContext,
  workspace: WorkspaceService,
  properties: ResourcePropertyService,
  query: DatabaseQueryProvider,
  owner: ResourceId,
  property: DatabaseProperty,
  value: PropertyValue,
): Promise<void> {
  const relation = property.relation;
  if (!relation?.inverse || !relation.inversePropertyId)
    throw new Error('Invalid inverse relation');
  const reason = properties.catalog.writeReason(property);
  if (reason) throw new Error(reason);
  const diagnostic = properties.catalog.diagnostic(property, value);
  if (diagnostic) throw new Error(diagnostic);
  const model = context.definitions.get(relation.databaseId as ResourceId);
  const forward = model?.properties.find(
    (item) => item.id === relation.inversePropertyId,
  );
  if (!model || forward?.type !== 'relation' || forward.relation?.inverse)
    throw new Error('Stored forward relation unavailable');
  if (forward.relation?.inversePropertyId !== property.id)
    throw new Error('Inverse relation does not match its forward property');
  const forwardReason = properties.catalog.writeReason(forward);
  if (forwardReason) throw new Error(forwardReason);
  const desired = new Set((value ?? []) as ResourceId[]);
  const current = new Set(
    context.relationships
      .list()
      .filter(
        (edge) =>
          edge.type === 'database-relation' &&
          edge.target.location.resourceId === owner &&
          edge.metadata.propertyId === forward.id,
      )
      .map((edge) => edge.source.resourceId),
  );
  const changes = [...new Set([...current, ...desired])].filter(
    (id) => current.has(id) !== desired.has(id),
  );
  const refs = new Map(
    workspace.listDocuments().map((ref) => [ref.location.resourceId, ref]),
  );
  const members = new Set(
    (
      await query.execute(
        model,
        { id: 'membership', name: '', type: 'table' },
        properties.rows(),
        '',
        { evaluation: captureDatabaseEvaluationContext() },
      )
    ).map((row) => row.resourceId),
  );
  for (const id of changes) {
    if (!refs.has(id)) throw new Error(`Related resource unavailable: ${id}`);
    // Removing a stale edge remains possible after query membership changes.
    if (desired.has(id) && !members.has(id))
      throw new Error(`Related resource is not a member: ${id}`);
  }
  const committed: ResourceId[] = [];
  for (const id of changes) {
    try {
      const result = await properties.update(
        refs.get(id)!,
        forward,
        (existing) => {
          if (
            existing !== null &&
            (!Array.isArray(existing) ||
              existing.some((item) => typeof item !== 'string'))
          )
            throw new Error(
              'Invalid stored relation; repair it before editing its inverse',
            );
          const next = new Set((existing ?? []) as ResourceId[]);
          if (desired.has(id)) next.add(owner);
          else next.delete(owner);
          return [...next];
        },
      );
      if (!result.committed) throw result.error;
      committed.push(id);
    } catch (error) {
      throw new PartialRelationWriteError(committed, id, error);
    }
  }
}

export async function validateRelationTargets(
  model: DatabaseModel,
  query: DatabaseQueryProvider,
  properties: ResourcePropertyService,
  value: PropertyValue,
): Promise<void> {
  const members = new Set(
    (
      await query.execute(
        model,
        { id: 'membership', name: '', type: 'table' },
        properties.rows(),
        '',
        { evaluation: captureDatabaseEvaluationContext() },
      )
    ).map((row) => row.resourceId),
  );
  if (
    Array.isArray(value) &&
    value.some((id) => typeof id !== 'string' || !members.has(id as ResourceId))
  )
    throw new Error('Related resource is not a member of the target database');
}
