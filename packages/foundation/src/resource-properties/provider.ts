import type { DocumentRef, DocumentKindDescriptor, DocumentRegistry } from '../documents.js';
import { documentKindId, resourceId, type ResourceId } from '../identity.js';
import type { MetadataService } from '../metadata.js';
import type { RelationshipService } from '../relationships.js';
import type { RevisionService } from '../revisions.js';
import { DocumentSessionImpl, type SaveResult } from '../session.js';
import type { VaultService } from '../vault/contract.js';
import type { WorkspaceService } from '../workspace.js';
import { workspacePath } from '../paths.js';
import { ensureDirectory } from '../vault/helpers.js';
import { isVaultErrorCode } from '../errors.js';
import { utf8Decode, utf8Encode } from '../encoding.js';
import { stableStringify } from '../records.js';
import { databaseKindId } from '../databases/kind.js';
import type { DatabaseModel } from '../databases/model.js';
import {
  PropertyCatalog,
  type ResourcePropertyDefinition,
  type PropertyValue,
} from './catalog.js';
import type {
  ResourcePropertyService,
  ResourcePropertyRow,
} from './contract.js';

interface PropertyRecord {
  readonly format: 'froglight.properties';
  readonly version: 1;
  readonly owner: ResourceId;
  values: Record<string, PropertyValue>;
  relations: string[];
  readonly [key: string]: unknown;
}
const removePropertyValue = Symbol('remove-property-value');
const propertyKindId = documentKindId('froglight.properties');
function validValue(value: unknown, depth = 0): value is PropertyValue {
  return (
    depth <= 16 &&
    (value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value)) ||
      (Array.isArray(value) &&
        value.length <= 10000 &&
        value.every((item) => validValue(item, depth + 1))) ||
      (typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        Object.keys(value).length <= 1000 &&
        Object.values(value).every((item) => validValue(item, depth + 1))))
  );
}
const propertyKind: DocumentKindDescriptor<PropertyRecord> = {
  id: propertyKindId,
  decode(bytes) {
    if (bytes.byteLength > 1024 * 1024)
      throw new Error('Property record exceeds 1 MiB');
    const record = JSON.parse(utf8Decode(bytes));
    if (
      !record ||
      record.format !== 'froglight.properties' ||
      record.version !== 1 ||
      typeof record.owner !== 'string' ||
      !record.values ||
      typeof record.values !== 'object' ||
      Array.isArray(record.values) ||
      !Object.values(record.values).every((value) => validValue(value)) ||
      !Array.isArray(record.relations) ||
      !record.relations.every((id: unknown) => typeof id === 'string')
    )
      throw new Error('Invalid property record');
    return { model: record, metadata: {}, relationships: [] };
  },
  encode(model, ref) {
    const bytes = utf8Encode(stableStringify(model));
    propertyKind.decode(bytes, ref);
    return bytes;
  },
};
export function propertyResourceId(owner: ResourceId): ResourceId {
  return resourceId(`properties:${owner}`);
}
export function resourcePropertyPath(owner: ResourceId) {
  return workspacePath(
    `.froglight/properties/${encodeURIComponent(owner)}.json`,
  );
}
/** Canonical sidecars use source document revisions and independent sessions. */
export class WorkspaceResourceProperties implements ResourcePropertyService {
  get catalog(): PropertyCatalog {
    return this.deps.catalog;
  }
  readonly #tails = new Map<ResourceId, Promise<unknown>>();
  readonly #listeners = new Set<() => void>();
  readonly #rows = new Map<ResourceId, ResourcePropertyRow>();
  readonly #definitions = new Map<ResourceId, DatabaseModel>();
  #definitionRefresh: Promise<void> | null = null;
  #bindingCache: Map<string, { storageKey: string; relation: boolean; signature: string } | null> | null = null;
  #rowRevision = 0;
  readonly #projection: ReturnType<MetadataService['propertyProjection']>;
  readonly #registrySubscription: { dispose(): void } | undefined;
  #registryRefresh: Promise<void> = Promise.resolve();
  #disposed = false;
  constructor(
    readonly deps: {
      workspace: WorkspaceService;
      vault: VaultService;
      metadata: MetadataService;
      relationships: RelationshipService;
      revisions: RevisionService | null;
      catalog: PropertyCatalog;
      registry?: DocumentRegistry;
    },
  ) {
    this.#projection = deps.metadata.propertyProjection();
    this.#registrySubscription = deps.registry?.onDidChange(() => {
      this.#registryRefresh = this.#registryRefresh.catch(() => undefined).then(async () => {
        if (this.#disposed) return;
        for (const ref of this.deps.workspace.listDocuments())
          await this.#projectOne(ref);
        for (const listener of this.#listeners) listener();
      });
      void this.#registryRefresh.catch(() => undefined);
    });
  }
  #assert(ref: DocumentRef): void {
    if (this.#disposed) throw new Error('Resource properties disposed');
    if (
      !this.deps.workspace
        .listDocuments()
        .some(
          (item) =>
            item.documentId === ref.documentId &&
            item.location.resourceId === ref.location.resourceId &&
            item.kindId === ref.kindId,
        )
    )
      throw new Error('Resource is unavailable');
  }
  async #record(ref: DocumentRef): Promise<PropertyRecord> {
    this.#assert(ref);
    try {
      const record = propertyKind.decode(
        await this.deps.vault.read(
          resourcePropertyPath(ref.location.resourceId),
        ),
        ref,
      ).model;
      if (record.owner !== ref.location.resourceId)
        throw new Error('Property record owner mismatch');
      return record;
    } catch (error) {
      if (!isVaultErrorCode(error, 'NOT_FOUND')) throw error;
      return {
        format: 'froglight.properties',
        version: 1,
        owner: ref.location.resourceId,
        values: {},
        relations: [],
      };
    }
  }
  async read(
    ref: DocumentRef,
  ): Promise<Readonly<Record<string, PropertyValue>>> {
    await this.#ensureDefinitions();
    const values = { ...(await this.#record(ref)).values };
    const descriptor = this.deps.registry?.recognize(ref.kindId);
    if (this.deps.registry && !descriptor)
      throw new Error('Document provider unavailable; embedded properties cannot be read');
    const native = descriptor?.documentProperties;
    if (!native) return values;
    const bindings = this.#bindings();
    if ([...bindings.values()].some((binding) => binding === null))
      throw new Error('Conflicting document property storage bindings');
    const applicable = [...bindings.entries()].filter(([id, binding]) =>
      binding !== null && !binding.relation && id !== '$title');
    if (!applicable.length) return values;
    const model = this.deps.workspace.getOpenDocument(ref.documentId)?.model ??
      (await this.deps.workspace.readDocument(ref.documentId)).model;
    for (const [id, binding] of applicable) {
      const stored = native.read(model, native.key(id, binding!.storageKey));
      if (!stored.present) continue;
      if (Object.prototype.hasOwnProperty.call(values, id))
        throw new Error(`Property ${id} exists in both document and sidecar; convert explicitly`);
      values[id] = stored.value;
    }
    return values;
  }

  #bindings(): Map<string, { storageKey: string; relation: boolean; signature: string } | null> {
    if (this.#bindingCache) return this.#bindingCache;
    const result = new Map<string, { storageKey: string; relation: boolean; signature: string } | null>();
    const keys = new Map<string, string>();
    for (const model of this.#definitions.values()) {
      if (model.version !== 1) continue;
      for (const property of model.properties) {
        if (!property.storageKey || ['formula', 'rollup', 'created', 'updated'].includes(property.type)) continue;
        const prior = result.get(property.id);
        const relation = property.type === 'relation';
        const signature = stableStringify({ type: property.type,
          options: property.options?.map((option) => option.id) ?? null,
          relation: property['relation'] ?? null });
        const owner = keys.get(property.storageKey);
        if ((prior && (prior.storageKey !== property.storageKey || prior.signature !== signature)) ||
          (owner && owner !== property.id)) {
          result.set(property.id, null);
          if (owner) result.set(owner, null);
        } else if (!result.has(property.id)) {
          result.set(property.id, { storageKey: property.storageKey, relation, signature });
          keys.set(property.storageKey, property.id);
        }
      }
    }
    this.#bindingCache = result;
    return result;
  }
  async #ensureDefinitions(): Promise<void> {
    if (this.#definitionRefresh) return this.#definitionRefresh;
    const missing = this.deps.workspace.listDocuments().filter((ref) =>
      ref.kindId === databaseKindId &&
      !this.#definitions.has(ref.location.resourceId),
    );
    if (missing.length === 0) return;
    const refresh = (async () => {
      for (const ref of missing) {
        const { model } = await this.deps.workspace.readDocument<DatabaseModel>(
          ref.documentId,
        );
        this.#definitions.set(ref.location.resourceId, model);
      }
      this.#bindingCache = null;
    })();
    this.#definitionRefresh = refresh;
    try {
      await refresh;
    } finally {
      this.#definitionRefresh = null;
    }
  }
  write(
    ref: DocumentRef,
    property: ResourcePropertyDefinition,
    value: PropertyValue,
  ): Promise<SaveResult> {
    if (!validValue(value))
      return Promise.reject(new Error('Invalid property value'));
    const diagnostic = this.deps.catalog.diagnostic(property, value);
    if (diagnostic) return Promise.reject(new Error(diagnostic));
    return this.update(ref, property, () => value);
  }
  update(
    ref: DocumentRef,
    property: ResourcePropertyDefinition,
    update: (
      current: PropertyValue,
      state: { readonly present: boolean },
    ) => PropertyValue,
  ): Promise<SaveResult> {
    return this.#mutate(ref, property, update);
  }
  unset(
    ref: DocumentRef,
    property: ResourcePropertyDefinition,
    expectedValue: PropertyValue,
  ): Promise<SaveResult> {
    return this.#mutate(ref, property, (current, state) => {
      if (
        !state.present ||
        stableStringify(current) !== stableStringify(expectedValue)
      )
        throw new Error('Property changed elsewhere. Refresh and retry.');
      return removePropertyValue;
    });
  }
  async #mutate(
    ref: DocumentRef,
    property: ResourcePropertyDefinition,
    update: (
      current: PropertyValue,
      state: { readonly present: boolean },
    ) => PropertyValue | typeof removePropertyValue,
  ): Promise<SaveResult> {
    this.#assert(ref);
    await this.#ensureDefinitions();
    const relation = property['relation'];
    if (
      property.type === 'relation' &&
      typeof relation === 'object' &&
      relation !== null &&
      'inverse' in relation &&
      relation.inverse === true
    )
      return Promise.reject(
        new Error(
          'Inverse relations must be edited through database relation authority',
        ),
      );
    const writeReason = this.deps.catalog.writeReason(property);
    if (writeReason) return Promise.reject(new Error(writeReason));
    if (
      !property.id ||
      ['__proto__', 'constructor', 'prototype'].includes(property.id)
    )
      return Promise.reject(new Error('Invalid property ID'));
    const bindings = this.#bindings();
    const binding = bindings.get(property.id);
    if (bindings.has(property.id) && binding === null)
      return Promise.reject(new Error('Conflicting document property storage bindings'));
    const descriptor = this.deps.registry?.recognize(ref.kindId);
    if (this.deps.registry && !descriptor)
      return Promise.reject(new Error('Document provider unavailable'));
    const native = descriptor?.documentProperties;
    if (binding && native && !binding.relation)
      return this.#mutateNative(ref, property, binding.storageKey, native, update);
    const previous =
      this.#tails.get(ref.location.resourceId) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(async () => {
        this.#assert(ref);
        const record = await this.#record(ref);
        const path = resourcePropertyPath(ref.location.resourceId);
        await ensureDirectory(
          this.deps.vault,
          workspacePath('.froglight/properties'),
        );
        try {
          await this.deps.vault.stat(path);
        } catch (error) {
          if (!isVaultErrorCode(error, 'NOT_FOUND')) throw error;
          await this.deps.vault.write(path, propertyKind.encode(record, ref));
        }
        const session = new DocumentSessionImpl<PropertyRecord>({
          ref: {
            documentId: ref.documentId,
            kindId: propertyKindId,
            location: {
              resourceId: propertyResourceId(ref.location.resourceId),
            },
          },
          kind: propertyKind,
          vault: this.deps.vault,
          revisions: this.deps.revisions,
          resolveResourcePath: () => path,
        });
        await session.open();
        try {
          const present = Object.prototype.hasOwnProperty.call(
            session.model.values,
            property.id,
          );
          const value = update(session.model.values[property.id] ?? null, {
            present,
          });
          if (value === removePropertyValue) {
            delete session.model.values[property.id];
            session.model.relations = session.model.relations.filter(
              (id) => id !== property.id,
            );
          } else {
            if (!validValue(value)) throw new Error('Invalid property value');
            const diagnostic = this.deps.catalog.diagnostic(property, value);
            if (diagnostic) throw new Error(diagnostic);
            session.model.values[property.id] = value;
            session.model.relations = [
              ...new Set([
                ...session.model.relations.filter((id) => id !== property.id),
                ...(property.type === 'relation' ? [property.id] : []),
              ]),
            ];
          }
          session.markDirty();
          session.onPostCommit(async () => {
            await this.#project(ref, session.model);
            for (const listener of this.#listeners) listener();
          });
          return await session.save();
        } finally {
          await session.close();
        }
      });
    this.#tails.set(ref.location.resourceId, operation);
    void operation
      .finally(() => {
        if (this.#tails.get(ref.location.resourceId) === operation)
          this.#tails.delete(ref.location.resourceId);
      })
      .catch(() => undefined);
    return operation;
  }
  #mutateNative(
    ref: DocumentRef,
    property: ResourcePropertyDefinition,
    storageKey: string,
    native: NonNullable<DocumentKindDescriptor['documentProperties']>,
    update: (current: PropertyValue, state: { readonly present: boolean }) => PropertyValue | typeof removePropertyValue,
  ): Promise<SaveResult> {
    const previous = this.#tails.get(ref.location.resourceId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      this.#assert(ref);
      const sidecar = await this.#record(ref);
      if (Object.prototype.hasOwnProperty.call(sidecar.values, property.id))
        throw new Error('Property exists in a sidecar; convert it explicitly before native edits');
      const existing = this.deps.workspace.getOpenDocument(ref.documentId);
      const session = existing ?? await this.deps.workspace.openDocument(ref.documentId);
      try {
        const key = native.key(property.id, storageKey);
        const current = native.read(session.model, key);
        const value = update(current.present ? current.value : null, { present: current.present });
        if (value === removePropertyValue) native.unset(session.model, key);
        else {
          if (!validValue(value)) throw new Error('Invalid property value');
          const diagnostic = this.deps.catalog.diagnostic(property, value);
          if (diagnostic) throw new Error(diagnostic);
          native.write(session.model, key, value);
        }
        session.markDirty();
        return await session.save();
      } finally {
        if (!existing) await session.close();
      }
    });
    this.#tails.set(ref.location.resourceId, operation);
    void operation.finally(() => {
      if (this.#tails.get(ref.location.resourceId) === operation)
        this.#tails.delete(ref.location.resourceId);
    }).catch(() => undefined);
    return operation;
  }
  async #project(ref: DocumentRef, record: PropertyRecord): Promise<void> {
    // Native and fallback fields resolve to one ID-keyed projection.
    const properties = JSON.parse(JSON.stringify(await this.read(ref)));
    this.#projection.set(ref.documentId, properties);
    // Workspace identity can load before its first metadata rebuild. Keep the
    // property capability available so that rebuild can populate both layers.
    let normalized;
    try {
      normalized = this.deps.metadata.get(ref.documentId);
    } catch {
      normalized = { documentId: ref.documentId, properties };
    }
    const path = this.deps.workspace.resolveResourcePath(
      ref.location.resourceId,
    );
    const sourceModified = (await this.deps.vault.stat(path)).modifiedMillis;
    let propertiesModified: number | null = null;
    try {
      propertiesModified = (
        await this.deps.vault.stat(
          resourcePropertyPath(ref.location.resourceId),
        )
      ).modifiedMillis;
    } catch (error) {
      if (!isVaultErrorCode(error, 'NOT_FOUND')) throw error;
    }
    const modified = [
      sourceModified,
      propertiesModified,
      normalized.modifiedMillis,
    ].filter((value): value is number => typeof value === 'number');
    const projectedValues = { ...normalized.properties, ...properties };
    const native = this.deps.registry?.recognize(ref.kindId)?.documentProperties;
    if (native) {
      for (const [id, binding] of this.#bindings()) {
        if (!binding || binding.relation) continue;
        const key = native.key(id, binding.storageKey);
        if (key !== id) delete projectedValues[key];
      }
    }
    this.#rows.set(ref.location.resourceId, {
      resourceId: ref.location.resourceId,
      kindId: ref.kindId,
      path,
      title: normalized.title ?? path.split('/').at(-1) ?? path,
      values: projectedValues,
      ...(normalized.createdMillis !== undefined
        ? { createdMillis: normalized.createdMillis }
        : {}),
      ...(modified.length ? { updatedMillis: Math.max(...modified) } : {}),
    });
    this.#rowRevision += 1;
    for (const edge of this.deps.relationships.bySource(
      ref.location.resourceId,
    ))
      if (edge.type === 'database-relation')
        this.deps.relationships.remove(edge.id);
    const targets = new Map(
      this.deps.workspace
        .listDocuments()
        .map((item) => [String(item.location.resourceId), item]),
    );
    for (const id of record.relations) {
      const values = record.values[id];
      if (!Array.isArray(values)) continue;
      for (const value of values) {
        const target =
          typeof value === 'string' ? targets.get(value) : undefined;
        if (target)
          this.deps.relationships.add({
            type: 'database-relation',
            source: ref.location,
            target,
            metadata: { propertyId: id },
          });
      }
    }
  }
  rows(): readonly ResourcePropertyRow[] {
    if (this.#disposed) throw new Error('Resource properties disposed');
    return [...this.#rows.values()];
  }
  rowSource() {
    if (this.#disposed) throw new Error('Resource properties disposed');
    const revision = this.#rowRevision;
    const assertCurrent = () => {
      if (this.#disposed) throw new Error('Resource properties disposed');
      if (this.#rowRevision !== revision)
        throw new Error('Resource property projection changed');
    };
    return {
      revision,
      scan: () => {
        assertCurrent();
        return this.#rows.values();
      },
      get: (id: ResourceId) => {
        assertCurrent();
        return this.#rows.get(id);
      },
    };
  }
  async rebuild(): Promise<void> {
    this.#rows.clear();
    this.#definitions.clear();
    this.#bindingCache = null;
    this.#rowRevision += 1;
    for (const ref of this.deps.workspace.listDocuments()) {
      if (ref.kindId !== databaseKindId) continue;
      try {
        const { model } = await this.deps.workspace.readDocument<DatabaseModel>(ref.documentId);
        this.#definitions.set(ref.location.resourceId, model);
      } catch { /* Unavailable schema is diagnosed by its owning projection. */ }
    }
    for (const ref of this.deps.workspace.listDocuments())
      await this.#projectOne(ref);
  }
  async project(ref: DocumentRef): Promise<void> {
    if (ref.kindId === databaseKindId) {
      this.#bindingCache = null;
      try {
        const session = this.deps.workspace.getOpenDocument<DatabaseModel>(ref.documentId);
        const model = session?.model ?? (await this.deps.workspace.readDocument<DatabaseModel>(ref.documentId)).model;
        this.#definitions.set(ref.location.resourceId, model);
      } catch {
        this.#definitions.delete(ref.location.resourceId);
      }
      for (const member of this.deps.workspace.listDocuments()) {
        if (member.kindId !== databaseKindId) await this.#projectOne(member);
      }
    }
    await this.#projectOne(ref);
    for (const listener of this.#listeners) listener();
  }
  async #projectOne(ref: DocumentRef): Promise<void> {
    let record: PropertyRecord;
    let diagnostic: string | undefined;
    try {
      record = await this.#record(ref);
    } catch (error) {
      diagnostic = error instanceof Error ? error.message : String(error);
      record = {
        format: 'froglight.properties',
        version: 1,
        owner: ref.location.resourceId,
        values: {},
        relations: [],
      };
    }
    try {
      await this.#project(ref, record);
    } catch (error) {
      diagnostic = error instanceof Error ? error.message : String(error);
      this.#projection.set(ref.documentId, {});
      const path = this.deps.workspace.resolveResourcePath(ref.location.resourceId);
      this.#rows.set(ref.location.resourceId, {
        resourceId: ref.location.resourceId, kindId: ref.kindId, path,
        title: this.deps.metadata.get(ref.documentId).title ?? path,
        values: {},
      });
      this.#rowRevision += 1;
    }
    if (diagnostic) {
      const row = this.#rows.get(ref.location.resourceId)!;
      this.#rows.set(ref.location.resourceId, {
        ...row,
        diagnostics: { $properties: diagnostic },
      });
      this.#rowRevision += 1;
    }
  }
  remove(id: ResourceId): void {
    if (this.#definitions.delete(id)) this.#bindingCache = null;
    if (this.#rows.delete(id)) this.#rowRevision += 1;
  }
  onDidChange(listener: () => void): { dispose(): void } {
    if (this.#disposed) throw new Error('Resource properties disposed');
    this.#listeners.add(listener);
    return {
      dispose: () => {
        this.#listeners.delete(listener);
      },
    };
  }
  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#registrySubscription?.dispose();
    this.#listeners.clear();
    await this.#registryRefresh.catch(() => undefined);
    await Promise.allSettled([...this.#tails.values()]);
    this.#rows.clear();
    this.#rowRevision += 1;
    this.#projection.dispose();
  }
}
