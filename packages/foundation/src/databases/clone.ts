import {
  cloneTemplateValue,
  type DocumentTemplateCloneContext,
} from '../documents.js';
import { parseFormula, type FormulaExpression } from './formula.js';
import type {
  DatabaseFilter,
  DatabaseFilterExpression,
  DatabaseModel,
  PropertyValue,
} from './model.js';

function remapFilter(
  filter: DatabaseFilter,
  properties: ReadonlyMap<string, string>,
): DatabaseFilter {
  return {
    ...filter,
    property: properties.get(filter.property) ?? filter.property,
  };
}

function remapFilterExpression(
  expression: DatabaseFilterExpression,
  properties: ReadonlyMap<string, string>,
): DatabaseFilterExpression {
  if ('property' in expression) return remapFilter(expression, properties);
  return {
    ...expression,
    filters: expression.filters.map((child) =>
      remapFilterExpression(child, properties),
    ),
  };
}

function printFormula(expression: FormulaExpression): string {
  if ('literal' in expression) {
    if (Array.isArray(expression.literal))
      return `[${expression.literal.map((item) => JSON.stringify(item)).join(',')}]`;
    return JSON.stringify(expression.literal);
  }
  if ('variable' in expression) return expression.variable;
  return `${expression.call}(${expression.args.map(printFormula).join(',')})`;
}

function remapFormula(
  source: string,
  properties: ReadonlyMap<string, string>,
): string {
  try {
    const visit = (expression: FormulaExpression): FormulaExpression => {
      if (!('call' in expression)) return expression;
      if (
        expression.call === 'prop' &&
        expression.args.length === 1 &&
        'literal' in expression.args[0]! &&
        typeof expression.args[0].literal === 'string'
      ) {
        const id = expression.args[0].literal;
        return {
          ...expression,
          args: [{ literal: properties.get(id) ?? id }],
        };
      }
      return { ...expression, args: expression.args.map(visit) };
    };
    return printFormula(visit(parseFormula(source).expression));
  } catch {
    // Invalid/plugin-authored formula source remains opaque and byte-equivalent.
    return source;
  }
}

function remapDefaultValue(
  value: PropertyValue,
  options: ReadonlyMap<string, string> | undefined,
): PropertyValue {
  if (!options) return value;
  if (typeof value === 'string') return options.get(value) ?? value;
  if (Array.isArray(value))
    return value.map((item) =>
      typeof item === 'string' ? (options.get(item) ?? item) : item,
    );
  return value;
}

/** Duplicate a database as an independent schema while retaining external resources. */
export function cloneDatabase(
  model: DatabaseModel,
  context: DocumentTemplateCloneContext,
): DatabaseModel {
  const clone = cloneTemplateValue(model);
  const propertyIds = new Map(
    clone.properties.map((property) => [property.id, context.newInternalId()]),
  );
  const optionIds = new Map<string, Map<string, string>>();
  clone.properties = clone.properties.map((property) => {
    const options = ['select', 'multi-select'].includes(property.type)
      ? property.options?.map((option) => {
          const id = context.newInternalId();
          const mapping =
            optionIds.get(property.id) ?? new Map<string, string>();
          mapping.set(option.id, id);
          optionIds.set(property.id, mapping);
          return { ...option, id };
        })
      : property.options;
    return {
      ...property,
      id: propertyIds.get(property.id)!,
      ...(property.storageKey ? {
        storageKey: `${property.storageKey}-${propertyIds.get(property.id)!.replace(/[^A-Za-z0-9]/g, '').slice(0, 12)}`,
      } : {}),
      ...(options ? { options } : {}),
      ...(property.type === 'formula' && property.formula
        ? { formula: remapFormula(property.formula, propertyIds) }
        : {}),
      ...(property.type === 'rollup' && property.rollup
        ? {
            rollup: {
              ...property.rollup,
              relation:
                propertyIds.get(property.rollup.relation) ??
                property.rollup.relation,
            },
          }
        : {}),
    };
  });
  const remapView = (view: DatabaseModel['views'][number]) => ({
    ...view,
    id: context.newInternalId(),
    ...(view.filters
      ? {
          filters: view.filters.map((filter) =>
            remapFilter(filter, propertyIds),
          ),
        }
      : {}),
    ...(view.where
      ? { where: remapFilterExpression(view.where, propertyIds) }
      : {}),
    ...(view.sorts
      ? {
          sorts: view.sorts.map((sort) => ({
            ...sort,
            property: propertyIds.get(sort.property) ?? sort.property,
          })),
        }
      : {}),
    ...(view.groupBy
      ? { groupBy: propertyIds.get(view.groupBy) ?? view.groupBy }
      : {}),
    ...(view.dateProperty
      ? {
          dateProperty: propertyIds.get(view.dateProperty) ?? view.dateProperty,
        }
      : {}),
    ...(view.endDateProperty
      ? {
          endDateProperty:
            propertyIds.get(view.endDateProperty) ?? view.endDateProperty,
        }
      : {}),
    ...(view.visibleProperties
      ? {
          visibleProperties: view.visibleProperties.map(
            (id) => propertyIds.get(id) ?? id,
          ),
        }
      : {}),
    ...(view.columnWidths
      ? {
          columnWidths: Object.fromEntries(
            Object.entries(view.columnWidths).map(([id, width]) => [
              propertyIds.get(id) ?? id,
              width,
            ]),
          ),
        }
      : {}),
  });
  clone.views = clone.views.map(remapView);
  clone.membership =
    clone.membership.mode === 'query'
      ? {
          ...clone.membership,
          filters: clone.membership.filters.map((filter) =>
            remapFilter(filter, propertyIds),
          ),
          ...(clone.membership.where
            ? {
                where: remapFilterExpression(
                  clone.membership.where,
                  propertyIds,
                ),
              }
            : {}),
        }
      : clone.membership;
  clone.templates = clone.templates.map((template) => ({
    ...template,
    id: context.newInternalId(),
    defaults: Object.fromEntries(
      Object.entries(template.defaults).map(([id, value]) => [
        propertyIds.get(id) ?? id,
        remapDefaultValue(value, optionIds.get(id)),
      ]),
    ),
  }));
  if (clone.propertyPresentation) {
    clone.propertyPresentation = {
      ...clone.propertyPresentation,
      ...(clone.propertyPresentation.order
        ? {
            order: clone.propertyPresentation.order.map(
              (id) => propertyIds.get(id) ?? id,
            ),
          }
        : {}),
      ...(clone.propertyPresentation.hideWhenEmpty
        ? {
            hideWhenEmpty: clone.propertyPresentation.hideWhenEmpty.map(
              (id) => propertyIds.get(id) ?? id,
            ),
          }
        : {}),
      ...(clone.propertyPresentation.sections
        ? {
            sections: clone.propertyPresentation.sections.map((section) => ({
              ...section,
              propertyIds: section.propertyIds.map(
                (id) => propertyIds.get(id) ?? id,
              ),
            })),
          }
        : {}),
    };
  }
  return clone;
}
