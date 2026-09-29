import { documentKindId } from '../identity.js';
import type { DocumentKindDescriptor } from '../documents.js';
import { utf8Decode, utf8Encode } from '../encoding.js';
import { stableStringify } from '../records.js';
import { createDatabase, type DatabaseModel } from './model.js';
import { cloneDatabase } from './clone.js';

export const databaseKindId = documentKindId('froglight.database');

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function stringList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 1000 &&
    value.every((item) => typeof item === 'string' && item.length > 0) &&
    new Set(value).size === value.length
  );
}
function namedRecords(value: unknown): value is Record<string, unknown>[] {
  return (
    Array.isArray(value) &&
    value.length <= 1000 &&
    value.every(
      (item) =>
        object(item) &&
        typeof item.id === 'string' &&
        item.id.length > 0 &&
        typeof item.name === 'string',
    ) &&
    new Set(value.map((item) => item.id)).size === value.length
  );
}
function filters(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= 1000 &&
    value.every(
      (item) =>
        object(item) &&
        typeof item.property === 'string' &&
        [
          'eq',
          'neq',
          'contains',
          'gt',
          'lt',
          'empty',
          'date-relative',
        ].includes(String(item.operator)) &&
        (item.operator !== 'date-relative' ||
          [
            'today',
            'yesterday',
            'tomorrow',
            'past-7-days',
            'next-7-days',
          ].includes(String(item.value))),
    )
  );
}
function filterExpression(
  value: unknown,
  budget: { nodes: number },
  depth = 0,
): boolean {
  if (!object(value) || depth > 4 || ++budget.nodes > 64) return false;
  if (value.operator === 'and' || value.operator === 'or')
    return (
      Array.isArray(value.filters) &&
      value.filters.length > 0 &&
      value.filters.length <= 16 &&
      value.filters.every((child) => filterExpression(child, budget, depth + 1))
    );
  return filters([value]);
}
function filterRecords(value: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(filterRecords);
  if (!object(value)) return [];
  return value.operator === 'and' || value.operator === 'or'
    ? filterRecords(value.filters)
    : [value];
}
export function validateDatabase(
  value: unknown,
): asserts value is DatabaseModel {
  if (
    !object(value) ||
    value.format !== 'froglight.database' ||
    value.version !== 1
  )
    throw new Error('Unsupported database format/version');
  if (
    typeof value.title !== 'string' ||
    !namedRecords(value.properties) ||
    !namedRecords(value.views) ||
    !namedRecords(value.templates)
  )
    throw new Error('Invalid database title, schema, views, or templates');
  for (const property of value.properties) {
    if (
      [
        '$title',
        '$kind',
        '$path',
        '__proto__',
        'constructor',
        'prototype',
      ].includes(String(property.id))
    )
      throw new Error('Reserved property ID');
    if (typeof property.type !== 'string' || !property.type)
      throw new Error('Invalid property type');
    if (property.storageKey !== undefined &&
      (typeof property.storageKey !== 'string' ||
        !/^[A-Za-z][A-Za-z0-9_-]*$/.test(property.storageKey) ||
        ['title', 'tags'].includes(property.storageKey)))
      throw new Error('Invalid property storage key');
    if (
      property.readOnly !== undefined &&
      typeof property.readOnly !== 'boolean'
    )
      throw new Error('Invalid property read-only flag');
    if (property.options !== undefined && !namedRecords(property.options))
      throw new Error('Invalid property options');
    if (
      Array.isArray(property.options) &&
      property.options.some(
        (option) =>
          option.color !== undefined && typeof option.color !== 'string',
      )
    )
      throw new Error('Invalid option color');
    if (property.type === 'relation' && property.relation !== undefined) {
      const relation = property.relation;
      if (
        !object(relation) ||
        typeof relation.databaseId !== 'string' ||
        !relation.databaseId ||
        (relation.inverse !== undefined &&
          typeof relation.inverse !== 'boolean') ||
        (relation.inversePropertyId !== undefined &&
          (typeof relation.inversePropertyId !== 'string' ||
            !relation.inversePropertyId)) ||
        (relation.inverse === true && !relation.inversePropertyId)
      )
        throw new Error('Invalid relation definition');
    }
    if (property.type === 'formula' && typeof property.formula !== 'string')
      throw new Error('Formula source is required');
    if (
      property.type === 'rollup' &&
      (!object(property.rollup) ||
        typeof property.rollup.relation !== 'string' ||
        typeof property.rollup.property !== 'string' ||
        !['count', 'sum', 'average', 'min', 'max', 'list', 'unique'].includes(
          String(property.rollup.aggregation),
        ))
    )
      throw new Error('Invalid rollup');
  }
  const nativeKeys = new Map<string, string>();
  for (const property of value.properties) {
    if (typeof property.storageKey !== 'string') continue;
    const owner = nativeKeys.get(property.storageKey);
    if (owner && owner !== property.id)
      throw new Error(`Document storage key is already bound: ${property.storageKey}`);
    nativeKeys.set(property.storageKey, property.id as string);
  }
  const membership = value.membership;
  if (!object(membership)) throw new Error('Invalid membership');
  if (membership.mode === 'explicit') {
    if (
      !Array.isArray(membership.resourceIds) ||
      membership.resourceIds.some((id) => typeof id !== 'string' || !id) ||
      new Set(membership.resourceIds).size !== membership.resourceIds.length
    )
      throw new Error('Invalid member IDs');
  } else if (membership.mode !== 'query' || !filters(membership.filters))
    throw new Error('Invalid query membership');
  if (
    membership.mode === 'query' &&
    membership.where !== undefined &&
    !filterExpression(membership.where, { nodes: 0 })
  )
    throw new Error('Invalid query membership expression');
  if (value.propertyPresentation !== undefined) {
    const presentation = value.propertyPresentation;
    if (
      !object(presentation) ||
      (presentation.order !== undefined && !stringList(presentation.order)) ||
      (presentation.hideWhenEmpty !== undefined &&
        !stringList(presentation.hideWhenEmpty)) ||
      (presentation.sections !== undefined &&
        (!Array.isArray(presentation.sections) ||
          presentation.sections.some(
            (section) =>
              !object(section) ||
              typeof section.name !== 'string' ||
              !section.name.trim() ||
              !stringList(section.propertyIds),
          )))
    )
      throw new Error('Invalid property presentation');
  }
  for (const view of value.views) {
    if (typeof view.type !== 'string' || !view.type)
      throw new Error('Invalid view type');
    if (view.filters !== undefined && !filters(view.filters))
      throw new Error('Invalid view filters');
    if (view.where !== undefined && !filterExpression(view.where, { nodes: 0 }))
      throw new Error('Invalid view filter expression');
    if (
      view.sorts !== undefined &&
      (!Array.isArray(view.sorts) ||
        !view.sorts.every(
          (sort) =>
            object(sort) &&
            typeof sort.property === 'string' &&
            (sort.descending === undefined ||
              typeof sort.descending === 'boolean'),
        ))
    )
      throw new Error('Invalid view sorts');
    if (
      view.visibleProperties !== undefined &&
      (!Array.isArray(view.visibleProperties) ||
        !view.visibleProperties.every((id) => typeof id === 'string'))
    )
      throw new Error('Invalid visible properties');
    if (
      view.columnWidths !== undefined &&
      (!object(view.columnWidths) ||
        Object.values(view.columnWidths).some(
          (width) =>
            typeof width !== 'number' ||
            !Number.isFinite(width) ||
            width < 120 ||
            width > 640,
        ))
    )
      throw new Error('Invalid column widths');
    for (const key of ['groupBy', 'dateProperty', 'endDateProperty'])
      if (view[key] !== undefined && typeof view[key] !== 'string')
        throw new Error(`Invalid ${key}`);
  }
  for (const template of value.templates)
    if (
      typeof template.kindId !== 'string' ||
      !object(template.defaults) ||
      !Object.hasOwn(template, 'model')
    )
      throw new Error('Invalid template');

  const propertyTypes = new Map(
    value.properties.map(
      (property) => [String(property.id), String(property.type)] as const,
    ),
  );
  const persistedFilters = [
    ...(membership.mode === 'query'
      ? [membership.filters, membership.where]
      : []),
    ...value.views.flatMap((view) => [view.filters, view.where]),
  ].flatMap(filterRecords);
  for (const filter of persistedFilters)
    if (
      filter.operator === 'date-relative' &&
      !['date', 'created', 'updated'].includes(
        String(propertyTypes.get(String(filter.property))),
      )
    )
      throw new Error('Relative date filter requires a date property');
}

export const databaseKind: DocumentKindDescriptor<DatabaseModel> = {
  id: databaseKindId,
  creation: {
    label: 'Database',
    extension: '.base',
    createInitialModel: createDatabase,
  },
  cloneTemplate: cloneDatabase,
  documentTitle: {
    read: (model) => model.title,
    write: (model, title) => {
      model.title = title;
    },
  },
  recognize: (id) =>
    id === databaseKindId || (typeof id === 'string' && id.endsWith('.base')),
  decode(data) {
    if (data.byteLength > 8 * 1024 * 1024)
      throw new Error('Database definition exceeds 8 MiB');
    const model: unknown = JSON.parse(utf8Decode(data));
    validateDatabase(model);
    return { model, metadata: { title: model.title }, relationships: [] };
  },
  encode(model) {
    validateDatabase(model);
    const data = utf8Encode(stableStringify(model));
    if (data.byteLength > 8 * 1024 * 1024)
      throw new Error('Database definition exceeds 8 MiB');
    return data;
  },
  searchText: (model) =>
    [
      model.title,
      ...model.properties.map((property) => property.name),
      ...model.views.map((view) => view.name),
    ].join('\n'),
};
