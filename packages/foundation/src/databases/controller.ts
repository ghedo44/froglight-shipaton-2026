import type { DocumentRef } from '../documents.js';
import {
  documentKindId,
  generateResourceId,
  type ResourceId,
} from '../identity.js';
import type { WorkspacePath } from '../paths.js';
import type { DocumentSession } from '../session.js';
import type { WorkspaceService } from '../workspace.js';
import type { ResourcePropertyService } from '../resource-properties/contract.js';
import { stableStringify } from '../records.js';
import { parseFormula } from './formula.js';
import type { DatabaseDefinitions } from './definitions.js';
import { databaseKindId, validateDatabase } from './kind.js';
import {
  type DatabaseModel,
  type DatabaseProperty,
  type DatabaseFilterExpression,
  type DatabasePropertyPresentation,
  type DatabaseView,
  type DatabaseTemplate,
  type PropertyValue,
} from './model.js';
import {
  captureDatabaseEvaluationContext,
  resolveDatabaseView,
  type DatabaseQueryProvider,
  type DatabaseQueryOptions,
  type EvaluatedDatabaseRow,
} from './query.js';
import {
  writeInverseRelation,
  validateRelationTargets,
  PartialRelationWriteError,
  type DatabaseRelationContext,
} from './relations.js';
import {
  DatabaseUndoConflictError,
  databaseUndoOperation,
  type DatabaseUndoOperation,
} from './undo.js';

function sameValue(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function referencesFilter(
  expression: DatabaseFilterExpression | undefined,
  propertyId: string,
): boolean {
  if (!expression) return false;
  return 'filters' in expression
    ? expression.filters.some((child) => referencesFilter(child, propertyId))
    : expression.property === propertyId;
}

function propertyRemovalBlocker(
  model: DatabaseModel,
  propertyId: string,
): string | null {
  if (
    model.membership.mode === 'query' &&
    (model.membership.filters.some(
      (filter) => filter.property === propertyId,
    ) ||
      referencesFilter(model.membership.where, propertyId))
  )
    return 'Remove the collection rule using this property first.';
  for (const view of model.views) {
    if (
      view.filters?.some((filter) => filter.property === propertyId) ||
      referencesFilter(view.where, propertyId) ||
      view.sorts?.some((sort) => sort.property === propertyId) ||
      view.groupBy === propertyId ||
      view.dateProperty === propertyId ||
      view.endDateProperty === propertyId
    )
      return `Remove the reference in the ${view.name} view first.`;
  }
  for (const other of model.properties) {
    if (other.id === propertyId) continue;
    if (
      other.rollup?.relation === propertyId ||
      other.rollup?.property === propertyId
    )
      return `Edit the dependent rollup ${other.name} first.`;
    if (other.type === 'formula' && other.formula) {
      try {
        if (parseFormula(other.formula).dependencies.includes(propertyId))
          return `Edit the dependent formula ${other.name} first.`;
      } catch {
        return `Repair the invalid formula ${other.name} before removing properties.`;
      }
    }
  }
  if (
    model.templates.some((template) =>
      Object.hasOwn(template.defaults, propertyId),
    )
  )
    return 'Remove this property from template defaults first.';
  const property = model.properties.find((item) => item.id === propertyId);
  if (property?.relation?.inversePropertyId)
    return 'Remove the two-way relation pairing before removing this property.';
  return null;
}

interface ExpectedPropertyValue {
  readonly value: PropertyValue;
  readonly present?: boolean;
}

export interface DatabaseBulkPropertyTarget {
  readonly resourceId: ResourceId;
  readonly expected: {
    readonly present: boolean;
    readonly value: PropertyValue;
  };
}

export interface DatabaseBulkPropertyCommit {
  readonly resourceId: ResourceId;
}

export interface DatabaseBulkPropertyFailure {
  readonly resourceId: ResourceId;
  readonly error: unknown;
}

export interface DatabaseBulkPropertyUndoResult {
  /** Cumulative resources restored to their value before the bulk edit. */
  readonly reverted: readonly DatabaseBulkPropertyCommit[];
  /** Resources still at risk of conflict or storage failure. */
  readonly failed: readonly DatabaseBulkPropertyFailure[];
  /** Retry only resources that have not yet been reverted. */
  retry(): Promise<DatabaseBulkPropertyUndoResult>;
}

export interface DatabaseBulkPropertyUndoOperation {
  readonly label: string;
  /** Undo every committed item whose value still equals the bulk value. */
  undo(): Promise<DatabaseBulkPropertyUndoResult>;
}

export interface DatabaseBulkPropertyEditResult {
  /** Cumulative resources committed by this operation. */
  readonly committed: readonly DatabaseBulkPropertyCommit[];
  /** Resources that have not committed, with their latest exact failure. */
  readonly failed: readonly DatabaseBulkPropertyFailure[];
  /** Retry only resources that have not committed, using the original expectation. */
  retry(): Promise<DatabaseBulkPropertyEditResult>;
  /** Conflict-aware logical undo for every resource this operation committed. */
  readonly undo: DatabaseBulkPropertyUndoOperation;
}

export async function writeDatabaseProperty(
  model: DatabaseModel,
  workspace: WorkspaceService,
  properties: ResourcePropertyService,
  query: DatabaseQueryProvider,
  resourceId: ResourceId,
  propertyId: string,
  value: PropertyValue,
  relations?: DatabaseRelationContext,
  expectedValue?: PropertyValue,
): Promise<void> {
  const property = model.properties.find((item) => item.id === propertyId);
  if (!property) throw new Error('Property unavailable');
  const ref = workspace
    .listDocuments()
    .find((item) => item.location.resourceId === resourceId);
  if (!ref) throw new Error('Resource unavailable');
  if (
    model.membership.mode === 'explicit' &&
    !model.membership.resourceIds.includes(resourceId)
  )
    throw new Error('Resource is not a member');
  if (model.membership.mode === 'query') {
    const members = await query.execute(
      model,
      { id: 'membership', name: '', type: 'table' },
      await properties.rows(),
      '',
      { evaluation: captureDatabaseEvaluationContext() },
    );
    if (!members.some((item) => item.resourceId === resourceId))
      throw new Error('Resource no longer matches this collection');
  }
  await writeResolvedProperty(
    property,
    ref,
    workspace,
    properties,
    query,
    resourceId,
    value,
    relations,
    expectedValue === undefined ? undefined : { value: expectedValue },
  );
}

/** Set a known stored field before a resource matches a smart collection. */
export async function applyDatabasePropertyToDocument(input: {
  readonly databaseId: ResourceId;
  readonly resourceId: ResourceId;
  readonly propertyId: string;
  readonly value: PropertyValue;
  readonly expectedValue: PropertyValue;
  readonly definitions: DatabaseDefinitions;
  readonly workspace: WorkspaceService;
  readonly properties: ResourcePropertyService;
  readonly query: DatabaseQueryProvider;
  readonly relations?: DatabaseRelationContext;
}): Promise<void> {
  const {
    databaseId,
    resourceId,
    propertyId,
    value,
    expectedValue,
    definitions,
    workspace,
    properties,
    query,
    relations,
  } = input;
  const model = definitions.get(databaseId);
  if (!model) throw new Error('Database unavailable');
  const property = model.properties.find((item) => item.id === propertyId);
  if (!property) throw new Error('Property unavailable');
  const reason = properties.catalog.writeReason(property);
  if (reason) throw new Error(reason);
  if (property.type === 'relation' && property.relation?.inverse)
    throw new Error('Inverse relations require database membership');
  for (const database of workspace.listDocuments()) {
    if (
      database.kindId !== databaseKindId ||
      database.location.resourceId === databaseId
    )
      continue;
    const other = definitions
      .get(database.location.resourceId)
      ?.properties.find((item) => item.id === propertyId);
    if (other && JSON.stringify(other) !== JSON.stringify(property))
      throw new Error('Conflicting property definitions');
  }
  const ref = workspace
    .listDocuments()
    .find((item) => item.location.resourceId === resourceId);
  if (!ref) throw new Error('Resource unavailable');
  await writeResolvedProperty(
    property,
    ref,
    workspace,
    properties,
    query,
    resourceId,
    value,
    relations,
    { value: expectedValue },
  );
}

async function writeResolvedProperty(
  property: DatabaseProperty,
  ref: DocumentRef,
  workspace: WorkspaceService,
  properties: ResourcePropertyService,
  query: DatabaseQueryProvider,
  resourceId: ResourceId,
  value: PropertyValue,
  relations?: DatabaseRelationContext,
  expected?: ExpectedPropertyValue,
): Promise<void> {
  if (property.type === 'relation' && property.relation) {
    if (!relations) throw new Error('Relation services unavailable');
    if (property.relation.inverse)
      return writeInverseRelation(
        relations,
        workspace,
        properties,
        query,
        resourceId,
        property,
        value,
      );
    const target = relations.definitions.get(
      property.relation.databaseId as ResourceId,
    );
    if (!target) throw new Error('Related database unavailable');
    await validateRelationTargets(target, query, properties, value);
  }
  const result =
    expected === undefined
      ? await properties.write(ref, property, value)
      : await properties.update(ref, property, (current, state) => {
          if (
            (expected.present !== undefined &&
              expected.present !== state.present) ||
            !sameValue(current, expected.value)
          )
            throw new Error('Property changed elsewhere. Refresh and retry.');
          return value;
        });
  if (!result.committed) throw result.error;
}

const definitionWrites = new WeakMap<
  DocumentSession<DatabaseModel>,
  Promise<unknown>
>();

/** Shared mutation authority for standalone and linked database renderers. */
export class DatabaseController {
  constructor(
    readonly session: DocumentSession<DatabaseModel>,
    readonly workspace: WorkspaceService,
    readonly properties: ResourcePropertyService,
    readonly query: DatabaseQueryProvider,
    readonly relations?: DatabaseRelationContext,
  ) {}
  get model(): DatabaseModel {
    return this.session.model;
  }
  async rows(
    viewId: string,
    overrides: Partial<DatabaseView> = {},
    search = '',
    options: DatabaseQueryOptions = {},
  ): Promise<readonly EvaluatedDatabaseRow[]> {
    return this.query.execute(
      this.model,
      resolveDatabaseView(this.model, viewId, overrides),
      await this.properties.rows(),
      search,
      options,
    );
  }
  #change<Result>(update: (model: DatabaseModel) => Result): Promise<Result> {
    const previous = definitionWrites.get(this.session) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(async () => {
        const next = JSON.parse(JSON.stringify(this.model)) as DatabaseModel;
        const output = update(next);
        validateDatabase(next);
        Object.assign(this.model, next);
        this.session.markDirty();
        const result = await this.session.save();
        if (!result.committed) throw result.error;
        return output;
      });
    definitionWrites.set(this.session, operation);
    return operation;
  }
  async addMember(resourceId: ResourceId): Promise<void> {
    if (
      !this.workspace
        .listDocuments()
        .some((ref) => ref.location.resourceId === resourceId)
    )
      throw new Error('Resource unavailable');
    await this.#change((model) => {
      if (model.membership.mode !== 'explicit')
        throw new Error(
          'Query membership follows the query; edit the source properties instead',
        );
      model.membership = {
        ...model.membership,
        resourceIds: [
          ...new Set([...model.membership.resourceIds, resourceId]),
        ],
      };
    });
  }
  async removeMember(resourceId: ResourceId): Promise<void> {
    await this.#change((model) => {
      if (model.membership.mode !== 'explicit')
        throw new Error('Query membership follows the query');
      model.membership = {
        ...model.membership,
        resourceIds: model.membership.resourceIds.filter(
          (id) => id !== resourceId,
        ),
      };
    });
  }
  async addMemberWithUndo(
    resourceId: ResourceId,
  ): Promise<DatabaseUndoOperation> {
    if (
      !this.workspace
        .listDocuments()
        .some((ref) => ref.location.resourceId === resourceId)
    )
      throw new Error('Resource unavailable');
    const snapshots = await this.#change((model) => {
      if (model.membership.mode !== 'explicit')
        throw new Error(
          'Query membership follows the query; edit the source properties instead',
        );
      const before = [...model.membership.resourceIds];
      const after = [...new Set([...before, resourceId])];
      model.membership = { ...model.membership, resourceIds: after };
      return { before, after };
    });
    return databaseUndoOperation('Add database member', async () => {
      await this.#change((model) => {
        if (
          model.membership.mode !== 'explicit' ||
          !sameValue(model.membership.resourceIds, snapshots.after)
        )
          throw new DatabaseUndoConflictError();
        model.membership = {
          ...model.membership,
          resourceIds: snapshots.before,
        };
      });
    });
  }
  async removeMemberWithUndo(
    resourceId: ResourceId,
  ): Promise<DatabaseUndoOperation> {
    const snapshots = await this.#change((model) => {
      if (model.membership.mode !== 'explicit')
        throw new Error('Query membership follows the query');
      const before = [...model.membership.resourceIds];
      const after = before.filter((id) => id !== resourceId);
      model.membership = { ...model.membership, resourceIds: after };
      return { before, after };
    });
    return databaseUndoOperation('Remove database member', async () => {
      await this.#change((model) => {
        if (
          model.membership.mode !== 'explicit' ||
          !sameValue(model.membership.resourceIds, snapshots.after)
        )
          throw new DatabaseUndoConflictError();
        model.membership = {
          ...model.membership,
          resourceIds: snapshots.before,
        };
      });
    });
  }
  async createMember(
    templateId: string,
    path: WorkspacePath,
  ): Promise<DocumentRef> {
    if (this.model.membership.mode !== 'explicit')
      throw new Error('New members require an explicit collection');
    const template = this.model.templates.find(
      (item) => item.id === templateId,
    );
    if (!template) throw new Error('Template unavailable');
    for (const [id, value] of Object.entries(template.defaults)) {
      const property = this.model.properties.find((item) => item.id === id);
      if (!property) throw new Error(`Template property is unavailable: ${id}`);
      const reason = this.properties.catalog.writeReason(property);
      if (reason) throw new Error(`Template property ${id}: ${reason}`);
      if (property.type === 'relation' && property.relation?.inverse)
        throw new Error('Inverse relation cannot be a template default');
      const diagnostic = this.properties.catalog.diagnostic(property, value);
      if (diagnostic) throw new Error(diagnostic);
      if (property.type === 'relation' && property.relation) {
        const target = this.relations?.definitions.get(
          property.relation.databaseId as ResourceId,
        );
        if (!target) throw new Error('Related database unavailable');
        await validateRelationTargets(
          target,
          this.query,
          this.properties,
          value,
        );
      }
    }
    const ref = await this.workspace.createDocumentFromTemplate({
      kindId: documentKindId(template.kindId),
      path,
      templateModel: template.model,
    });
    // A failed later write leaves a normal recoverable resource, never deletes content.
    try {
      await this.addMember(ref.location.resourceId);
    } catch (cause) {
      throw new PartialDatabaseCreationError(
        ref.location.resourceId,
        cause,
        templateId,
        false,
      );
    }
    try {
      await this.applyTemplateDefaults(templateId, ref.location.resourceId);
    } catch (cause) {
      throw new PartialDatabaseCreationError(
        ref.location.resourceId,
        cause,
        templateId,
        true,
      );
    }
    return ref;
  }
  async applyTemplateDefaults(
    templateId: string,
    resourceId: ResourceId,
  ): Promise<void> {
    const template = this.model.templates.find(
      (item) => item.id === templateId,
    );
    if (!template) throw new Error('Template unavailable');
    const ref = this.workspace
      .listDocuments()
      .find((item) => item.location.resourceId === resourceId);
    if (!ref) throw new Error('Resource unavailable');
    for (const [id, value] of Object.entries(template.defaults)) {
      const property = this.model.properties.find((item) => item.id === id);
      if (!property) throw new Error(`Template property is unavailable: ${id}`);
      if (property.type === 'relation' && property.relation?.inverse)
        throw new Error('Inverse relation cannot be a template default');
      // A retry only fills untouched fields. Previously committed defaults and
      // later user edits both remain authoritative.
      if ((await this.properties.read(ref))[id] !== undefined) continue;
      await writeDatabaseProperty(
        this.model,
        this.workspace,
        this.properties,
        this.query,
        resourceId,
        id,
        value,
        this.relations,
        null,
      );
    }
  }
  async createResource(
    input: Parameters<WorkspaceService['createDocument']>[0],
  ): Promise<DocumentRef> {
    if (this.model.membership.mode !== 'explicit')
      throw new Error('New members require an explicit collection');
    const ref = await this.workspace.createDocument(input);
    try {
      await this.addMember(ref.location.resourceId);
    } catch (cause) {
      throw new PartialDatabaseCreationError(
        ref.location.resourceId,
        cause,
        undefined,
        false,
      );
    }
    return ref;
  }
  async write(
    resourceId: ResourceId,
    propertyId: string,
    value: PropertyValue,
  ): Promise<void> {
    await writeDatabaseProperty(
      this.model,
      this.workspace,
      this.properties,
      this.query,
      resourceId,
      propertyId,
      value,
      this.relations,
    );
  }
  async bulkWriteWithUndo(
    propertyId: string,
    value: PropertyValue,
    targets: readonly DatabaseBulkPropertyTarget[],
  ): Promise<DatabaseBulkPropertyEditResult> {
    const property = this.model.properties.find(
      (item) => item.id === propertyId,
    );
    if (!property) throw new Error('Property unavailable');
    const reason = this.properties.catalog.writeReason(property);
    if (reason) throw new Error(reason);
    if (property.type === 'relation' && property.relation?.inverse)
      throw new Error('Logical undo is unavailable for inverse relations');
    const diagnostic = this.properties.catalog.diagnostic(property, value);
    if (diagnostic) throw new Error(diagnostic);
    if (property.type === 'relation' && property.relation) {
      if (!this.relations) throw new Error('Relation services unavailable');
      const target = this.relations.definitions.get(
        property.relation.databaseId as ResourceId,
      );
      if (!target) throw new Error('Related database unavailable');
      await validateRelationTargets(target, this.query, this.properties, value);
    }

    const seen = new Set<ResourceId>();
    for (const target of targets) {
      if (seen.has(target.resourceId))
        throw new Error(`Duplicate bulk target: ${target.resourceId}`);
      seen.add(target.resourceId);
    }

    const propertySnapshot = JSON.parse(
      JSON.stringify(property),
    ) as DatabaseProperty;
    const requestedValue = JSON.parse(JSON.stringify(value)) as PropertyValue;
    const states = targets.map((target) => ({
      resourceId: target.resourceId,
      expected: {
        present: target.expected.present,
        value: JSON.parse(
          JSON.stringify(target.expected.value),
        ) as PropertyValue,
      },
      ref: undefined as DocumentRef | undefined,
      committed: false,
      reverted: false,
      editError: undefined as unknown,
      undoError: undefined as unknown,
    }));
    let phase: 'editing' | 'undoing' = 'editing';
    let tail: Promise<void> = Promise.resolve();

    const serialize = <Result>(
      operation: () => Promise<Result>,
    ): Promise<Result> => {
      const running = tail.then(operation, operation);
      tail = running.then(
        () => undefined,
        () => undefined,
      );
      return running;
    };

    const assertDefinition = (): void => {
      const current = this.model.properties.find(
        (item) => item.id === propertyId,
      );
      if (!sameValue(current, propertySnapshot))
        throw new DatabaseUndoConflictError(
          'Property definition changed during this bulk edit.',
        );
    };

    const editResult = (): DatabaseBulkPropertyEditResult => ({
      committed: states
        .filter((state) => state.committed)
        .map(({ resourceId }) => ({ resourceId })),
      failed: states
        .filter((state) => !state.committed)
        .map(({ resourceId, editError }) => ({
          resourceId,
          error: editError,
        })),
      retry: executeEdit,
      undo: undoOperation,
    });

    const undoResult = (): DatabaseBulkPropertyUndoResult => ({
      reverted: states
        .filter((state) => state.committed && state.reverted)
        .map(({ resourceId }) => ({ resourceId })),
      failed: states
        .filter((state) => state.committed && !state.reverted)
        .map(({ resourceId, undoError }) => ({
          resourceId,
          error: undoError,
        })),
      retry: executeUndo,
    });

    async function prepare(
      controller: DatabaseController,
      pending: (typeof states)[number][],
    ): Promise<void> {
      let members: ReadonlySet<ResourceId> | null = null;
      if (controller.model.membership.mode === 'query') {
        try {
          const rows = await controller.query.execute(
            controller.model,
            { id: 'membership', name: '', type: 'table' },
            await controller.properties.rows(),
            '',
            { evaluation: captureDatabaseEvaluationContext() },
          );
          members = new Set(rows.map((row) => row.resourceId));
        } catch (error) {
          for (const state of pending) state.editError = error;
          return;
        }
      }
      for (const state of pending) {
        state.ref = undefined;
        try {
          const ref = controller.workspace
            .listDocuments()
            .find((item) => item.location.resourceId === state.resourceId);
          if (!ref) throw new Error('Resource unavailable');
          if (
            controller.model.membership.mode === 'explicit' &&
            !controller.model.membership.resourceIds.includes(state.resourceId)
          )
            throw new Error('Resource is not a member');
          if (members !== null && !members.has(state.resourceId))
            throw new Error('Resource no longer matches this collection');
          const values = await controller.properties.read(ref);
          const present = Object.prototype.hasOwnProperty.call(
            values,
            propertyId,
          );
          const current = values[propertyId] ?? null;
          if (
            present !== state.expected.present ||
            !sameValue(current, state.expected.value)
          )
            throw new Error('Property changed elsewhere. Refresh and retry.');
          state.ref = ref;
          state.editError = undefined;
        } catch (error) {
          state.editError = error;
        }
      }
    }

    const executeEdit = (): Promise<DatabaseBulkPropertyEditResult> =>
      serialize(async () => {
        if (phase !== 'editing')
          throw new Error('This bulk edit is already being undone');
        const pending = states.filter((state) => !state.committed);
        if (pending.length === 0) return editResult();
        assertDefinition();
        await prepare(this, pending);
        assertDefinition();
        // Every remaining target is checked before the first retry write. A
        // target failure does not prevent independent valid targets committing.
        for (const state of pending) {
          if (!state.ref) continue;
          try {
            await writeResolvedProperty(
              propertySnapshot,
              state.ref,
              this.workspace,
              this.properties,
              this.query,
              state.resourceId,
              requestedValue,
              this.relations,
              state.expected,
            );
            state.committed = true;
            state.editError = undefined;
          } catch (error) {
            state.editError = error;
          }
        }
        return editResult();
      });

    const executeUndo = (): Promise<DatabaseBulkPropertyUndoResult> =>
      serialize(async () => {
        phase = 'undoing';
        for (const state of states) {
          if (!state.committed || state.reverted) continue;
          try {
            assertDefinition();
            if (!state.ref) throw new Error('Resource unavailable');
            const result = state.expected.present
              ? await this.properties.update(
                  state.ref,
                  propertySnapshot,
                  (current, currentState) => {
                    if (
                      !currentState.present ||
                      !sameValue(current, requestedValue)
                    )
                      throw new DatabaseUndoConflictError();
                    return state.expected.value;
                  },
                )
              : await this.properties.unset(
                  state.ref,
                  propertySnapshot,
                  requestedValue,
                );
            if (!result.committed) throw result.error;
            state.reverted = true;
            state.undoError = undefined;
          } catch (error) {
            state.undoError =
              error instanceof Error &&
              error.message === 'Property changed elsewhere. Refresh and retry.'
                ? new DatabaseUndoConflictError()
                : error;
          }
        }
        return undoResult();
      });

    const undoOperation: DatabaseBulkPropertyUndoOperation = {
      label: 'Edit database properties',
      undo: executeUndo,
    };
    return executeEdit();
  }
  async writeWithUndo(
    resourceId: ResourceId,
    propertyId: string,
    value: PropertyValue,
    expectedValue?: PropertyValue,
  ): Promise<DatabaseUndoOperation> {
    const property = this.model.properties.find(
      (item) => item.id === propertyId,
    );
    if (!property) throw new Error('Property unavailable');
    if (property.type === 'relation' && property.relation?.inverse)
      throw new Error('Logical undo is unavailable for inverse relations');
    const ref = this.workspace
      .listDocuments()
      .find((item) => item.location.resourceId === resourceId);
    if (!ref) throw new Error('Resource unavailable');
    if (
      this.model.membership.mode === 'explicit' &&
      !this.model.membership.resourceIds.includes(resourceId)
    )
      throw new Error('Resource is not a member');
    if (this.model.membership.mode === 'query') {
      const members = await this.query.execute(
        this.model,
        { id: 'membership', name: '', type: 'table' },
        await this.properties.rows(),
        '',
        { evaluation: captureDatabaseEvaluationContext() },
      );
      if (!members.some((item) => item.resourceId === resourceId))
        throw new Error('Resource no longer matches this collection');
    }
    const values = await this.properties.read(ref);
    const previousPresent = Object.prototype.hasOwnProperty.call(
      values,
      propertyId,
    );
    const previousValue = values[propertyId] ?? null;
    if (expectedValue !== undefined && !sameValue(previousValue, expectedValue))
      throw new Error('Property changed elsewhere. Refresh and retry.');
    await writeResolvedProperty(
      property,
      ref,
      this.workspace,
      this.properties,
      this.query,
      resourceId,
      value,
      this.relations,
      { value: previousValue, present: previousPresent },
    );
    const propertySnapshot = JSON.parse(
      JSON.stringify(property),
    ) as DatabaseProperty;
    return databaseUndoOperation('Edit database property', async () => {
      const current = this.model.properties.find(
        (item) => item.id === propertyId,
      );
      if (!sameValue(current, propertySnapshot))
        throw new DatabaseUndoConflictError(
          'Property definition changed after this edit.',
        );
      let result;
      try {
        result = previousPresent
          ? await this.properties.update(
              ref,
              propertySnapshot,
              (currentValue, state) => {
                if (!state.present || !sameValue(currentValue, value))
                  throw new DatabaseUndoConflictError();
                return previousValue;
              },
            )
          : await this.properties.unset(ref, propertySnapshot, value);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === 'Property changed elsewhere. Refresh and retry.'
        )
          throw new DatabaseUndoConflictError();
        throw error;
      }
      if (!result.committed) throw result.error;
    });
  }
  async patchPropertyPresentationWithUndo(
    patch: Partial<DatabasePropertyPresentation>,
  ): Promise<DatabaseUndoOperation> {
    const snapshots = await this.#change((model) => {
      const before = JSON.parse(
        JSON.stringify(model.propertyPresentation ?? {}),
      ) as DatabasePropertyPresentation;
      const after = { ...before, ...patch };
      model.propertyPresentation = after;
      return {
        before,
        after: JSON.parse(
          JSON.stringify(after),
        ) as DatabasePropertyPresentation,
      };
    });
    return databaseUndoOperation('Arrange database properties', async () => {
      await this.#change((model) => {
        if (!sameValue(model.propertyPresentation ?? {}, snapshots.after))
          throw new DatabaseUndoConflictError(
            'Property presentation changed after this edit.',
          );
        model.propertyPresentation = snapshots.before;
      });
    });
  }
  async saveProperty(property: DatabaseProperty): Promise<void> {
    await this.#change((model) => {
      const index = model.properties.findIndex(
        (item) => item.id === property.id,
      );
      if (index >= 0 && model.properties[index]!.storageKey !== property.storageKey)
        throw new Error('Document storage binding cannot change through a schema edit');
      if (index < 0) model.properties.push(property);
      else model.properties[index] = property;
    });
  }
  async removePropertyWithUndo(
    propertyId: string,
  ): Promise<DatabaseUndoOperation> {
    const removed = await this.#change((model) => {
      const index = model.properties.findIndex(
        (item) => item.id === propertyId,
      );
      if (index < 0) throw new Error('Property unavailable');
      const blocker = propertyRemovalBlocker(model, propertyId);
      if (blocker) throw new Error(blocker);
      const property = model.properties[index]!;
      model.properties.splice(index, 1);
      return { property, index };
    });
    return databaseUndoOperation('Remove property definition', async () => {
      await this.#change((model) => {
        if (model.properties.some((item) => item.id === propertyId))
          throw new DatabaseUndoConflictError(
            'Property ID was reused after removal.',
          );
        model.properties.splice(removed.index, 0, removed.property);
      });
    });
  }
  async savePropertyWithUndo(
    property: DatabaseProperty,
  ): Promise<DatabaseUndoOperation> {
    const propertySnapshot = JSON.parse(
      JSON.stringify(property),
    ) as DatabaseProperty;
    const previous = await this.#change((model) => {
      const index = model.properties.findIndex(
        (item) => item.id === property.id,
      );
      const before =
        index < 0
          ? undefined
          : (JSON.parse(
              JSON.stringify(model.properties[index]),
            ) as DatabaseProperty);
      if (before && before.storageKey !== propertySnapshot.storageKey)
        throw new Error('Document storage binding cannot change through a schema edit');
      if (index < 0) model.properties.push(propertySnapshot);
      else model.properties[index] = propertySnapshot;
      return before;
    });
    return databaseUndoOperation(
      'Edit database property definition',
      async () => {
        await this.#change((model) => {
          const index = model.properties.findIndex(
            (item) => item.id === property.id,
          );
          if (
            index < 0 ||
            !sameValue(model.properties[index], propertySnapshot)
          )
            throw new DatabaseUndoConflictError(
              'Property definition changed after this edit.',
            );
          if (previous === undefined) model.properties.splice(index, 1);
          else model.properties[index] = previous;
        });
      },
    );
  }
  async saveRelation(
    property: DatabaseProperty,
    inverseName?: string,
  ): Promise<void> {
    if (
      property.type !== 'relation' ||
      !property.relation ||
      property.relation.inverse
    )
      throw new Error('Expected a forward relation');
    if (!inverseName?.trim()) return this.saveProperty(property);
    const targetId = property.relation.databaseId as ResourceId;
    const target = this.workspace
      .listDocuments()
      .find((ref) => ref.location.resourceId === targetId);
    if (!target || !this.relations?.definitions.get(targetId))
      throw new Error('Target database unavailable');
    const inverseId =
      property.relation.inversePropertyId ??
      this.model.properties.find((item) => item.id === property.id)?.relation
        ?.inversePropertyId ??
      generateResourceId();
    const forward = {
      ...property,
      relation: { ...property.relation, inversePropertyId: inverseId },
    };
    const inverse: DatabaseProperty = {
      id: inverseId,
      name: inverseName.trim(),
      type: 'relation',
      relation: {
        databaseId: this.session.document.location.resourceId,
        inversePropertyId: property.id,
        inverse: true,
      },
    };
    if (targetId === this.session.document.location.resourceId) {
      await this.#change((model) => {
        for (const item of [forward, inverse]) {
          const index = model.properties.findIndex(
            (existing) => existing.id === item.id,
          );
          if (index < 0) model.properties.push(item);
          else model.properties[index] = item;
        }
      });
      return;
    }
    await this.saveProperty(forward);
    const existing = this.workspace.getOpenDocument<DatabaseModel>(
      target.documentId,
    );
    let opened: DocumentSession<DatabaseModel> | undefined;
    try {
      opened =
        existing ??
        (await this.workspace.openDocument<DatabaseModel>(target.documentId));
      await new DatabaseController(
        opened,
        this.workspace,
        this.properties,
        this.query,
        this.relations,
      ).saveProperty(inverse);
    } catch (error) {
      throw new PartialRelationWriteError(
        [this.session.document.location.resourceId],
        targetId,
        error,
      );
    } finally {
      if (!existing && opened) await opened.close();
    }
  }
  async saveMembership(membership: DatabaseModel['membership']): Promise<void> {
    await this.#change((model) => {
      model.membership = membership;
    });
  }
  async saveMembershipWithUndo(
    membership: DatabaseModel['membership'],
  ): Promise<DatabaseUndoOperation> {
    const next = JSON.parse(
      JSON.stringify(membership),
    ) as DatabaseModel['membership'];
    const previous = await this.#change((model) => {
      const before = JSON.parse(
        JSON.stringify(model.membership),
      ) as DatabaseModel['membership'];
      model.membership = next;
      return before;
    });
    return databaseUndoOperation('Edit database membership', async () => {
      await this.#change((model) => {
        if (!sameValue(model.membership, next))
          throw new DatabaseUndoConflictError();
        model.membership = previous;
      });
    });
  }
  async saveTemplate(template: DatabaseTemplate): Promise<void> {
    await this.#change((model) => {
      const index = model.templates.findIndex(
        (item) => item.id === template.id,
      );
      if (index < 0) model.templates.push(template);
      else model.templates[index] = template;
    });
  }
  async writeTemplateDefault(
    templateId: string,
    propertyId: string,
    value: PropertyValue,
  ): Promise<void> {
    await this.#change((model) => {
      const template = model.templates.find((item) => item.id === templateId);
      if (!template)
        throw new Error(`Unknown database template: ${templateId}`);
      model.templates = model.templates.map((item) =>
        item.id === templateId
          ? { ...item, defaults: { ...item.defaults, [propertyId]: value } }
          : item,
      );
    });
  }
  async saveView(view: DatabaseView): Promise<void> {
    await this.#change((model) => {
      const index = model.views.findIndex((item) => item.id === view.id);
      if (index < 0) model.views.push(view);
      else model.views[index] = view;
    });
  }
  async saveTitle(title: string): Promise<void> {
    const next = title.trim();
    if (!next) throw new Error('Database title cannot be empty');
    await this.#change((model) => {
      model.title = next;
    });
  }
  /** Apply a UI change to the latest committed view inside the serialized write. */
  async patchView(viewId: string, patch: Partial<DatabaseView>): Promise<void> {
    await this.#change((model) => {
      const index = model.views.findIndex((view) => view.id === viewId);
      if (index < 0) throw new Error('Saved view unavailable');
      model.views[index] = { ...model.views[index]!, ...patch, id: viewId };
    });
  }
  async patchViewWithUndo(
    viewId: string,
    patch: Partial<DatabaseView>,
  ): Promise<DatabaseUndoOperation> {
    const snapshots = await this.#change((model) => {
      const index = model.views.findIndex((view) => view.id === viewId);
      if (index < 0) throw new Error('Saved view unavailable');
      const before = JSON.parse(
        JSON.stringify(model.views[index]),
      ) as DatabaseView;
      const after = { ...model.views[index]!, ...patch, id: viewId };
      model.views[index] = after;
      return {
        before,
        after: JSON.parse(JSON.stringify(after)) as DatabaseView,
      };
    });
    return databaseUndoOperation('Edit database view', async () => {
      await this.#change((model) => {
        const index = model.views.findIndex((view) => view.id === viewId);
        if (index < 0 || !sameValue(model.views[index], snapshots.after))
          throw new DatabaseUndoConflictError(
            'Saved view changed after this edit.',
          );
        model.views[index] = snapshots.before;
      });
    });
  }
  async setColumnWidth(
    viewId: string,
    propertyId: string,
    width: number,
  ): Promise<void> {
    await this.#change((model) => {
      const index = model.views.findIndex((view) => view.id === viewId);
      if (index < 0) throw new Error('Saved view unavailable');
      const current = model.views[index]!;
      model.views[index] = {
        ...current,
        columnWidths: { ...current.columnWidths, [propertyId]: width },
      };
    });
  }
  async setColumnWidthWithUndo(
    viewId: string,
    propertyId: string,
    width: number,
  ): Promise<DatabaseUndoOperation> {
    const previous = await this.#change((model) => {
      const index = model.views.findIndex((view) => view.id === viewId);
      if (index < 0) throw new Error('Saved view unavailable');
      const current = model.views[index]!;
      const present = Object.hasOwn(current.columnWidths ?? {}, propertyId);
      const value = current.columnWidths?.[propertyId];
      model.views[index] = {
        ...current,
        columnWidths: { ...current.columnWidths, [propertyId]: width },
      };
      return { present, value };
    });
    return databaseUndoOperation('Resize database column', async () => {
      await this.#change((model) => {
        const index = model.views.findIndex((view) => view.id === viewId);
        if (index < 0) throw new DatabaseUndoConflictError();
        const current = model.views[index]!;
        if (current.columnWidths?.[propertyId] !== width)
          throw new DatabaseUndoConflictError(
            'Column width changed after this resize.',
          );
        const columnWidths = { ...current.columnWidths };
        if (previous.present) columnWidths[propertyId] = previous.value!;
        else delete columnWidths[propertyId];
        model.views[index] = { ...current, columnWidths };
      });
    });
  }
  async duplicateView(viewId: string): Promise<string> {
    const source = resolveDatabaseView(this.model, viewId);
    const id = generateResourceId();
    await this.saveView({ ...source, id, name: `${source.name} copy` });
    return id;
  }
  async deleteView(viewId: string): Promise<void> {
    await this.#change((model) => {
      if (model.views.length <= 1)
        throw new Error('Keep at least one saved view');
      model.views = model.views.filter((view) => view.id !== viewId);
    });
  }
}

/** The document exists; retry membership with this ID instead of creating again. */
export class PartialDatabaseCreationError extends Error {
  constructor(
    readonly createdResourceId: ResourceId,
    cause: unknown,
    readonly templateId?: string,
    readonly membershipSaved = false,
  ) {
    super(
      membershipSaved
        ? 'Document was created and added, but template defaults could not be saved. Retry the defaults on this document.'
        : 'Document was created, but could not be added to this database. Retry adding the existing document.',
      { cause },
    );
  }
}
