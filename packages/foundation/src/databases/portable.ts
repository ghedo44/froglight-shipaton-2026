import type { DocumentId, ResourceId } from '../identity.js';
import { documentId, documentKindId, resourceId } from '../identity.js';
import type { DocumentRef, DocumentRegistry } from '../documents.js';
import { utf8Decode, utf8Encode } from '../encoding.js';
import { isVaultErrorCode } from '../errors.js';
import type { WorkspacePath } from '../paths.js';
import { joinPath, parsePath, ROOT_PATH, workspacePath } from '../paths.js';
import { stableStringify } from '../records.js';
import { resourcePropertyPath } from '../resource-properties/provider.js';
import type { PropertyValue } from '../resource-properties/catalog.js';
import type { VaultService } from '../vault/contract.js';
import { ensureDirectory } from '../vault/helpers.js';
import type { WorkspaceService } from '../workspace.js';
import { databaseKindId, validateDatabase } from './kind.js';
import type {
  DatabaseFilterExpression,
  DatabaseModel,
  DatabaseProperty,
} from './model.js';
import { filterLeaves } from './query.js';

const FORMAT = 'froglight.database-portable';
const VERSION = 1;
const MAX_DOCUMENTS = 10_000;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_SIDECAR_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 700 * 1024 * 1024;
const CORE_PROPERTY_TYPES = new Set([
  'text',
  'number',
  'boolean',
  'date',
  'select',
  'multi-select',
  'url',
  'email',
  'phone',
  'relation',
  'rollup',
  'formula',
  'created',
  'updated',
]);
const CORE_VIEW_TYPES = new Set([
  'table',
  'board',
  'list',
  'gallery',
  'calendar',
  'timeline',
]);

export type PortableExternalReferenceKind =
  | 'membership'
  | 'relation-database'
  | 'relation-value';

export interface PortableExternalReference {
  readonly kind: PortableExternalReferenceKind;
  readonly ownerResourceId: ResourceId;
  readonly targetResourceId: ResourceId;
  readonly propertyId?: string;
}

interface PortableDocumentRecord {
  readonly documentId: string;
  readonly resourceId: string;
  readonly kindId: string;
  readonly path: string;
  readonly content: string;
  readonly properties?: string;
}

interface PortableBundleRecord {
  readonly format: typeof FORMAT;
  readonly version: typeof VERSION;
  readonly sourceWorkspaceId: string;
  readonly databaseResourceId: string;
  readonly documents: readonly PortableDocumentRecord[];
  readonly externalReferences: readonly PortableExternalReference[];
}

export interface ExportPortableDatabaseInput {
  readonly databaseId: ResourceId;
  /** Document resources selected for inclusion alongside the database. */
  readonly includeResourceIds?: readonly ResourceId[];
  readonly workspace: WorkspaceService;
  readonly vault: VaultService;
  readonly signal?: AbortSignal;
}

export interface ImportPortableDatabaseInput {
  readonly bundle: Uint8Array;
  readonly workspace: WorkspaceService;
  readonly vault: VaultService;
  readonly registry: DocumentRegistry;
  /** Existing directory under which the exported paths are recreated. */
  readonly destinationRoot?: WorkspacePath;
  readonly signal?: AbortSignal;
}

export interface PortableIdentityMapping {
  readonly sourceDocumentId: DocumentId;
  readonly sourceResourceId: ResourceId;
  readonly documentId: DocumentId;
  readonly resourceId: ResourceId;
  readonly path: WorkspacePath;
}

export type PortableImportPhase =
  | 'create-document'
  | 'finalize-schema'
  | 'write-properties'
  | 'rebuild-derived-state';

export interface PortableImportSuccess {
  readonly status: 'complete';
  readonly database: PortableIdentityMapping;
  readonly imported: readonly PortableIdentityMapping[];
  readonly externalReferences: readonly PortableExternalReference[];
}

export interface PortableImportPartial {
  readonly status: 'partial';
  readonly phase: PortableImportPhase;
  readonly imported: readonly PortableIdentityMapping[];
  readonly failedSourceResourceId: ResourceId | null;
  readonly error: unknown;
  readonly externalReferences: readonly PortableExternalReference[];
}

export type PortableImportResult =
  | PortableImportSuccess
  | PortableImportPartial;

interface DecodedDocument {
  readonly record: PortableDocumentRecord;
  readonly sourceRef: DocumentRef;
  readonly path: WorkspacePath;
  readonly model: unknown;
  readonly properties: PropertyRecord | null;
}

interface PropertyRecord {
  readonly format: 'froglight.properties';
  readonly version: 1;
  readonly owner: string;
  readonly values: Record<string, PropertyValue>;
  readonly relations: readonly string[];
  readonly [key: string]: unknown;
}

/** Export one database and explicitly selected document dependencies. */
export async function exportPortableDatabase(
  input: ExportPortableDatabaseInput,
): Promise<Uint8Array> {
  throwIfAborted(input.signal);
  const refs = new Map(
    input.workspace
      .listDocuments()
      .map((ref) => [ref.location.resourceId, ref]),
  );
  const databaseRef = refs.get(input.databaseId);
  if (!databaseRef || databaseRef.kindId !== databaseKindId) {
    throw new Error('Portable export database is unavailable');
  }
  const selected = [
    ...new Set([input.databaseId, ...(input.includeResourceIds ?? [])]),
  ];
  if (selected.length > MAX_DOCUMENTS) {
    throw new Error(`Portable export exceeds ${MAX_DOCUMENTS} documents`);
  }
  const documents: PortableDocumentRecord[] = [];
  let totalBytes = 0;
  for (const id of selected) {
    throwIfAborted(input.signal);
    const ref = refs.get(id);
    if (!ref) throw new Error(`Selected export resource is unavailable: ${id}`);
    if (ref.kindId === databaseKindId && id !== input.databaseId) {
      throw new Error(
        'A portable database bundle supports one database schema',
      );
    }
    const path = input.workspace.resolveResourcePath(id);
    assertUserDocumentPath(path);
    const content = await input.vault.read(path, { signal: input.signal });
    const decoded = await input.workspace.readDocument(ref.documentId);
    if (id === input.databaseId) assertSupportedDatabase(decoded.model);
    let properties: Uint8Array | undefined;
    try {
      properties = await input.vault.read(resourcePropertyPath(id), {
        signal: input.signal,
      });
      parsePropertyRecord(properties, id);
    } catch (error) {
      if (!isVaultErrorCode(error, 'NOT_FOUND')) throw error;
    }
    totalBytes += content.byteLength + (properties?.byteLength ?? 0);
    assertEntrySizes(content, properties, totalBytes);
    documents.push({
      documentId: ref.documentId,
      resourceId: id,
      kindId: ref.kindId,
      path,
      content: encodeBase64(content),
      ...(properties ? { properties: encodeBase64(properties) } : {}),
    });
  }
  const included = new Set(selected);
  const externalReferences = collectExternalReferences(documents, included);
  const bundle = utf8Encode(
    stableStringify({
      format: FORMAT,
      version: VERSION,
      sourceWorkspaceId: input.workspace.workspaceId,
      databaseResourceId: input.databaseId,
      documents,
      externalReferences,
    } satisfies PortableBundleRecord),
  );
  if (bundle.byteLength > MAX_BUNDLE_BYTES) {
    throw new Error('Portable database bundle exceeds encoded size limit');
  }
  return bundle;
}

/**
 * Import a validated portable bundle. Validation and collision checks finish
 * before the first write. Once creation begins, failures are reported with
 * the resources already committed; user documents are never deleted to mimic
 * a filesystem transaction.
 */
export async function importPortableDatabase(
  input: ImportPortableDatabaseInput,
): Promise<PortableImportResult> {
  const decoded = await preflightImport(input);
  const imported: PortableIdentityMapping[] = [];
  const bySource = new Map<ResourceId, PortableIdentityMapping>();
  const ordered = [
    ...decoded.documents.filter(
      (item) => item.sourceRef.location.resourceId !== decoded.databaseId,
    ),
    ...decoded.documents.filter(
      (item) => item.sourceRef.location.resourceId === decoded.databaseId,
    ),
  ];
  for (const item of ordered) {
    try {
      throwIfAborted(input.signal);
      const ref = await input.workspace.createDocument({
        kindId: item.sourceRef.kindId,
        path: item.path,
        initialModel: item.model,
      });
      const mapping: PortableIdentityMapping = {
        sourceDocumentId: item.sourceRef.documentId,
        sourceResourceId: item.sourceRef.location.resourceId,
        documentId: ref.documentId,
        resourceId: ref.location.resourceId,
        path: item.path,
      };
      imported.push(mapping);
      bySource.set(mapping.sourceResourceId, mapping);
    } catch (error) {
      return partial(
        'create-document',
        imported,
        item.sourceRef.location.resourceId,
        error,
        decoded.externalReferences,
      );
    }
  }

  const database = bySource.get(decoded.databaseId);
  if (!database) {
    return partial(
      'finalize-schema',
      imported,
      decoded.databaseId,
      new Error('Portable import lost its database mapping'),
      decoded.externalReferences,
    );
  }
  const databaseDocument = decoded.documents.find(
    (item) => item.sourceRef.location.resourceId === decoded.databaseId,
  );
  if (!databaseDocument) {
    return partial(
      'finalize-schema',
      imported,
      decoded.databaseId,
      new Error('Portable import lost its database document'),
      decoded.externalReferences,
    );
  }
  try {
    const session = await input.workspace.openDocument<DatabaseModel>(
      database.documentId,
    );
    try {
      Object.assign(
        session.model,
        remapDatabase(databaseDocument.model as DatabaseModel, bySource),
      );
      session.markDirty();
      throwIfAborted(input.signal);
      const result = await session.save();
      if (!result.committed)
        throw new Error('Imported database schema was not committed');
    } finally {
      await session.close();
    }
  } catch (error) {
    return partial(
      'finalize-schema',
      imported,
      decoded.databaseId,
      error,
      decoded.externalReferences,
    );
  }

  try {
    await ensureDirectory(input.vault, workspacePath('.froglight/properties'));
  } catch (error) {
    return partial(
      'write-properties',
      imported,
      null,
      error,
      decoded.externalReferences,
    );
  }
  for (const item of decoded.documents) {
    if (!item.properties) continue;
    const mapping = bySource.get(item.sourceRef.location.resourceId);
    if (!mapping) {
      return partial(
        'write-properties',
        imported,
        item.sourceRef.location.resourceId,
        new Error('Portable import lost a document mapping'),
        decoded.externalReferences,
      );
    }
    try {
      throwIfAborted(input.signal);
      const record = remapPropertyRecord(
        item.properties,
        mapping.resourceId,
        bySource,
      );
      await input.vault.write(
        resourcePropertyPath(mapping.resourceId),
        utf8Encode(JSON.stringify(record)),
        { signal: input.signal },
      );
    } catch (error) {
      return partial(
        'write-properties',
        imported,
        item.sourceRef.location.resourceId,
        error,
        decoded.externalReferences,
      );
    }
  }
  try {
    await input.workspace.rebuildDerivedState();
  } catch (error) {
    return partial(
      'rebuild-derived-state',
      imported,
      null,
      error,
      decoded.externalReferences,
    );
  }
  return {
    status: 'complete',
    database,
    imported,
    externalReferences: decoded.externalReferences,
  };
}

async function preflightImport(input: ImportPortableDatabaseInput): Promise<{
  readonly databaseId: ResourceId;
  readonly documents: readonly DecodedDocument[];
  readonly externalReferences: readonly PortableExternalReference[];
}> {
  throwIfAborted(input.signal);
  if (input.bundle.byteLength > MAX_BUNDLE_BYTES) {
    throw new Error('Portable database bundle exceeds encoded size limit');
  }
  const record = parseBundle(input.bundle);
  const root = input.destinationRoot ?? ROOT_PATH;
  const documents: DecodedDocument[] = [];
  const destinationKeys = new Set<string>();
  let totalBytes = 0;
  for (const item of record.documents) {
    const sourceRef: DocumentRef = {
      documentId: documentId(item.documentId),
      kindId: documentKindId(item.kindId),
      location: { resourceId: resourceId(item.resourceId) },
    };
    const content = decodeBase64(item.content);
    const propertiesBytes =
      item.properties === undefined ? undefined : decodeBase64(item.properties);
    totalBytes += content.byteLength + (propertiesBytes?.byteLength ?? 0);
    assertEntrySizes(content, propertiesBytes, totalBytes);
    const kind = input.registry.get(sourceRef.kindId);
    const model = kind.decode(content, sourceRef).model;
    if (sourceRef.location.resourceId === record.databaseResourceId) {
      if (sourceRef.kindId !== databaseKindId) {
        throw new Error('Portable bundle database has the wrong document kind');
      }
      assertSupportedDatabase(model);
    } else if (sourceRef.kindId === databaseKindId) {
      throw new Error(
        'A portable database bundle supports one database schema',
      );
    }
    const sourcePath = workspacePath(item.path);
    assertUserDocumentPath(sourcePath);
    const path = joinPath(root, ...parsePath(sourcePath));
    assertUserDocumentPath(path);
    const destinationKey = portablePathKey(path, input.vault);
    if (destinationKeys.has(destinationKey)) {
      throw new Error(`Portable bundle has colliding import paths: ${path}`);
    }
    destinationKeys.add(destinationKey);
    try {
      await input.vault.stat(path, { signal: input.signal });
      throw new Error(`Import path already exists: ${path}`);
    } catch (error) {
      if (!isVaultErrorCode(error, 'NOT_FOUND')) throw error;
    }
    documents.push({
      record: item,
      sourceRef,
      path,
      model,
      properties: propertiesBytes
        ? parsePropertyRecord(propertiesBytes, sourceRef.location.resourceId)
        : null,
    });
  }
  const computed = collectExternalReferences(
    record.documents,
    new Set(record.documents.map((item) => item.resourceId)),
  );
  if (
    stableStringify(computed) !== stableStringify(record.externalReferences)
  ) {
    throw new Error(
      'Portable bundle external reference manifest is inconsistent',
    );
  }
  return {
    databaseId: resourceId(record.databaseResourceId),
    documents,
    externalReferences: computed,
  };
}

function parseBundle(bytes: Uint8Array): PortableBundleRecord {
  let value: unknown;
  try {
    value = JSON.parse(utf8Decode(bytes));
  } catch {
    throw new Error('Portable database bundle is not valid JSON');
  }
  if (!object(value) || value.format !== FORMAT || value.version !== VERSION) {
    throw new Error('Unsupported portable database bundle format/version');
  }
  if (
    typeof value.sourceWorkspaceId !== 'string' ||
    typeof value.databaseResourceId !== 'string' ||
    !Array.isArray(value.documents) ||
    value.documents.length === 0 ||
    value.documents.length > MAX_DOCUMENTS ||
    !Array.isArray(value.externalReferences)
  ) {
    throw new Error('Invalid portable database bundle');
  }
  const documents = value.documents as unknown[];
  if (
    !documents.every(validDocumentRecord) ||
    new Set(
      documents.map((item) => (item as PortableDocumentRecord).documentId),
    ).size !== documents.length ||
    new Set(
      documents.map((item) => (item as PortableDocumentRecord).resourceId),
    ).size !== documents.length ||
    new Set(documents.map((item) => (item as PortableDocumentRecord).path))
      .size !== documents.length ||
    !documents.some(
      (item) =>
        (item as PortableDocumentRecord).resourceId ===
        value.databaseResourceId,
    ) ||
    !value.externalReferences.every(validExternalReference)
  ) {
    throw new Error('Invalid portable database bundle documents or references');
  }
  return value as unknown as PortableBundleRecord;
}

function validDocumentRecord(value: unknown): value is PortableDocumentRecord {
  return (
    object(value) &&
    typeof value.documentId === 'string' &&
    typeof value.resourceId === 'string' &&
    typeof value.kindId === 'string' &&
    typeof value.path === 'string' &&
    typeof value.content === 'string' &&
    (value.properties === undefined || typeof value.properties === 'string')
  );
}

function validExternalReference(
  value: unknown,
): value is PortableExternalReference {
  return (
    object(value) &&
    ['membership', 'relation-database', 'relation-value'].includes(
      String(value.kind),
    ) &&
    typeof value.ownerResourceId === 'string' &&
    typeof value.targetResourceId === 'string' &&
    (value.propertyId === undefined || typeof value.propertyId === 'string')
  );
}

function parsePropertyRecord(
  bytes: Uint8Array,
  owner: ResourceId,
): PropertyRecord {
  let value: unknown;
  try {
    value = JSON.parse(utf8Decode(bytes));
  } catch {
    throw new Error(`Invalid property record for ${owner}`);
  }
  if (
    !object(value) ||
    value.format !== 'froglight.properties' ||
    value.version !== 1 ||
    value.owner !== owner ||
    !object(value.values) ||
    !Object.values(value.values).every((item) => validPropertyValue(item)) ||
    !Array.isArray(value.relations) ||
    !value.relations.every((item) => typeof item === 'string') ||
    new Set(value.relations).size !== value.relations.length
  ) {
    throw new Error(`Invalid property record for ${owner}`);
  }
  return value as PropertyRecord;
}

function assertSupportedDatabase(
  value: unknown,
): asserts value is DatabaseModel {
  validateDatabase(value);
  for (const property of value.properties) {
    if (!CORE_PROPERTY_TYPES.has(property.type)) {
      throw new Error(
        `Unsupported plugin property in portable export: ${property.type}`,
      );
    }
  }
  for (const view of value.views) {
    if (!CORE_VIEW_TYPES.has(view.type)) {
      throw new Error(
        `Unsupported plugin view in portable export: ${view.type}`,
      );
    }
  }
}

function collectExternalReferences(
  documents: readonly PortableDocumentRecord[],
  included: ReadonlySet<string>,
): PortableExternalReference[] {
  const external: PortableExternalReference[] = [];
  for (const document of documents) {
    if (document.kindId === databaseKindId) {
      const model = JSON.parse(
        utf8Decode(decodeBase64(document.content)),
      ) as DatabaseModel;
      validateDatabase(model);
      if (model.membership.mode === 'explicit') {
        for (const target of model.membership.resourceIds) {
          if (!included.has(target))
            external.push({
              kind: 'membership',
              ownerResourceId: resourceId(document.resourceId),
              targetResourceId: target,
            });
        }
      }
      for (const property of model.properties) {
        const target = property.relation?.databaseId;
        if (target && !included.has(target))
          external.push({
            kind: 'relation-database',
            ownerResourceId: resourceId(document.resourceId),
            targetResourceId: resourceId(target),
            propertyId: property.id,
          });
      }
      const relationIds = new Set(
        model.properties
          .filter((property) => property.type === 'relation')
          .map((property) => property.id),
      );
      if (model.membership.mode === 'query') {
        for (const filter of [
          ...model.membership.filters,
          ...(model.membership.where
            ? filterLeaves(model.membership.where)
            : []),
        ]) {
          if (relationIds.has(filter.property)) {
            collectRelationValueExternal(
              external,
              document.resourceId,
              filter.property,
              filter.value,
              included,
            );
          }
        }
      }
      for (const view of model.views) {
        for (const filter of [
          ...(view.filters ?? []),
          ...(view.where ? filterLeaves(view.where) : []),
        ]) {
          if (relationIds.has(filter.property)) {
            collectRelationValueExternal(
              external,
              document.resourceId,
              filter.property,
              filter.value,
              included,
            );
          }
        }
      }
      for (const template of model.templates) {
        for (const propertyId of relationIds) {
          collectRelationValueExternal(
            external,
            document.resourceId,
            propertyId,
            template.defaults[propertyId],
            included,
          );
        }
      }
    }
    if (document.properties) {
      const record = parsePropertyRecord(
        decodeBase64(document.properties),
        resourceId(document.resourceId),
      );
      for (const propertyId of record.relations) {
        const value = record.values[propertyId];
        if (!Array.isArray(value)) continue;
        for (const target of value) {
          if (typeof target === 'string' && !included.has(target))
            external.push({
              kind: 'relation-value',
              ownerResourceId: resourceId(document.resourceId),
              targetResourceId: resourceId(target),
              propertyId,
            });
        }
      }
    }
  }
  return [
    ...new Map(external.map((item) => [stableStringify(item), item])).values(),
  ].sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)));
}

function collectRelationValueExternal(
  external: PortableExternalReference[],
  ownerResourceId: string,
  propertyId: string,
  value: PropertyValue | undefined,
  included: ReadonlySet<string>,
): void {
  const values = Array.isArray(value) ? value : [value];
  for (const target of values) {
    if (typeof target === 'string' && !included.has(target)) {
      external.push({
        kind: 'relation-value',
        ownerResourceId: resourceId(ownerResourceId),
        targetResourceId: resourceId(target),
        propertyId,
      });
    }
  }
}

function remapDatabase(
  model: DatabaseModel,
  mappings: ReadonlyMap<ResourceId, PortableIdentityMapping>,
): DatabaseModel {
  const map = (id: string): ResourceId =>
    mappings.get(resourceId(id))?.resourceId ?? resourceId(id);
  const properties = model.properties.map((property) =>
    remapPropertyDefinition(property, map),
  );
  const relationIds = new Set(
    properties
      .filter((property) => property.type === 'relation')
      .map((property) => property.id),
  );
  return {
    ...model,
    properties,
    membership:
      model.membership.mode === 'explicit'
        ? {
            ...model.membership,
            resourceIds: model.membership.resourceIds.map(map),
          }
        : {
            ...model.membership,
            filters: model.membership.filters.map((filter) =>
              relationIds.has(filter.property)
                ? { ...filter, value: remapRelationValue(filter.value, map) }
                : filter,
            ),
            ...(model.membership.where
              ? {
                  where: remapWhere(model.membership.where, relationIds, map),
                }
              : {}),
          },
    templates: model.templates.map((template) => ({
      ...template,
      defaults: Object.fromEntries(
        Object.entries(template.defaults).map(([id, value]) => [
          id,
          relationIds.has(id) ? remapRelationValue(value, map) : value,
        ]),
      ),
    })),
    views: model.views.map((view) => ({
      ...view,
      ...(view.where
        ? { where: remapWhere(view.where, relationIds, map) }
        : {}),
      ...(view.filters
        ? {
            filters: view.filters.map((filter) =>
              relationIds.has(filter.property)
                ? { ...filter, value: remapRelationValue(filter.value, map) }
                : filter,
            ),
          }
        : {}),
    })),
  };
}

function remapWhere(
  expression: DatabaseFilterExpression,
  relationIds: ReadonlySet<string>,
  map: (id: string) => ResourceId,
): DatabaseFilterExpression {
  if ('filters' in expression)
    return {
      ...expression,
      filters: expression.filters.map((child) =>
        remapWhere(child, relationIds, map),
      ),
    };
  return relationIds.has(expression.property)
    ? { ...expression, value: remapRelationValue(expression.value, map) }
    : expression;
}

function remapRelationValue(
  value: PropertyValue,
  map: (id: string) => ResourceId,
): PropertyValue;
function remapRelationValue(
  value: PropertyValue | undefined,
  map: (id: string) => ResourceId,
): PropertyValue | undefined;
function remapRelationValue(
  value: PropertyValue | undefined,
  map: (id: string) => ResourceId,
): PropertyValue | undefined {
  if (typeof value === 'string') return map(value);
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === 'string' ? map(item) : item));
  }
  return value;
}

function remapPropertyDefinition(
  property: DatabaseProperty,
  map: (id: string) => ResourceId,
): DatabaseProperty {
  return property.relation
    ? {
        ...property,
        relation: {
          ...property.relation,
          databaseId: map(property.relation.databaseId),
        },
      }
    : property;
}

function remapPropertyRecord(
  record: PropertyRecord,
  owner: ResourceId,
  mappings: ReadonlyMap<ResourceId, PortableIdentityMapping>,
): PropertyRecord {
  const relationIds = new Set(record.relations);
  return {
    ...record,
    owner,
    values: Object.fromEntries(
      Object.entries(record.values).map(([id, value]) => [
        id,
        relationIds.has(id) && Array.isArray(value)
          ? value.map((item) =>
              typeof item === 'string'
                ? (mappings.get(resourceId(item))?.resourceId ?? item)
                : item,
            )
          : value,
      ]),
    ),
  };
}

function assertUserDocumentPath(path: WorkspacePath): void {
  const segments = parsePath(path);
  if (
    path === ROOT_PATH ||
    path === '.froglight' ||
    path.startsWith('.froglight/') ||
    path.length > 4096 ||
    segments.some((segment) => segment.length > 255)
  ) {
    throw new Error(`Portable database document path is invalid: ${path}`);
  }
}

function portablePathKey(path: WorkspacePath, vault: VaultService): string {
  let key: string = path;
  if (vault.capabilities.nameNormalization === 'nfc')
    key = key.normalize('NFC');
  if (vault.capabilities.caseSensitivity === 'insensitive')
    key = key.toLowerCase();
  return key;
}

function assertEntrySizes(
  content: Uint8Array,
  properties: Uint8Array | undefined,
  totalBytes: number,
): void {
  if (
    content.byteLength > MAX_ENTRY_BYTES ||
    (properties?.byteLength ?? 0) > MAX_SIDECAR_BYTES
  ) {
    throw new Error('Portable database entry exceeds size limit');
  }
  if (totalBytes > MAX_TOTAL_BYTES)
    throw new Error('Portable database payload exceeds total size limit');
}

function validPropertyValue(value: unknown, depth = 0): value is PropertyValue {
  return (
    depth <= 16 &&
    (value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value)) ||
      (Array.isArray(value) &&
        value.length <= 10_000 &&
        value.every((item) => validPropertyValue(item, depth + 1))) ||
      (object(value) &&
        Object.keys(value).length <= 1_000 &&
        Object.values(value).every((item) =>
          validPropertyValue(item, depth + 1),
        )))
  );
}

function partial(
  phase: PortableImportPhase,
  imported: readonly PortableIdentityMapping[],
  failedSourceResourceId: ResourceId | null,
  error: unknown,
  externalReferences: readonly PortableExternalReference[],
): PortableImportPartial {
  return {
    status: 'partial',
    phase,
    imported: [...imported],
    failedSourceResourceId,
    error,
    externalReferences,
  };
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('Portable database operation aborted');
}

const BASE64 =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function encodeBase64(bytes: Uint8Array): string {
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0;
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    output += BASE64.charAt(a >> 2);
    output += BASE64.charAt(((a & 3) << 4) | ((b ?? 0) >> 4));
    output +=
      b === undefined ? '=' : BASE64.charAt(((b & 15) << 2) | ((c ?? 0) >> 6));
    output += c === undefined ? '=' : BASE64.charAt(c & 63);
  }
  return output;
}

function decodeBase64(value: string): Uint8Array {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    throw new Error('Invalid base64 in portable database bundle');
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const output = new Uint8Array((value.length / 4) * 3 - padding);
  let offset = 0;
  for (let index = 0; index < value.length; index += 4) {
    const a = BASE64.indexOf(value.charAt(index));
    const b = BASE64.indexOf(value.charAt(index + 1));
    const c =
      value[index + 2] === '=' ? 0 : BASE64.indexOf(value.charAt(index + 2));
    const d =
      value[index + 3] === '=' ? 0 : BASE64.indexOf(value.charAt(index + 3));
    output[offset++] = (a << 2) | (b >> 4);
    if (offset < output.length) output[offset++] = ((b & 15) << 4) | (c >> 2);
    if (offset < output.length) output[offset++] = ((c & 3) << 6) | d;
  }
  return output;
}
