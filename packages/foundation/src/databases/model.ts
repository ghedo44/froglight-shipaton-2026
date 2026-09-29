import type { ResourceId } from '../identity.js';

import type {
  PropertyValue,
  ResourcePropertyDefinition,
} from '../resource-properties/catalog.js';
export { propertyDiagnostic } from '../resource-properties/catalog.js';
export type {
  PropertyValue,
  PropertyType,
  PropertyOption,
} from '../resource-properties/catalog.js';
export type Aggregation =
  | 'count'
  | 'sum'
  | 'average'
  | 'min'
  | 'max'
  | 'list'
  | 'unique';
export interface DatabaseProperty extends ResourcePropertyDefinition {
  readonly formula?: string;
  readonly rollup?: {
    readonly relation: string;
    readonly property: string;
    readonly aggregation: Aggregation;
  };
  readonly relation?: {
    readonly databaseId: string;
    readonly inversePropertyId?: string;
    readonly inverse?: boolean;
  };
}
export interface DatabaseFilter {
  readonly property: string;
  readonly operator:
    | 'eq'
    | 'neq'
    | 'contains'
    | 'gt'
    | 'lt'
    | 'empty'
    | 'date-relative';
  readonly value?: PropertyValue;
}
export type DatabaseRelativeDatePeriod =
  | 'today'
  | 'yesterday'
  | 'tomorrow'
  | 'past-7-days'
  | 'next-7-days';
/** Optional bounded groups extend flat AND filters without changing their meaning. */
export type DatabaseFilterExpression =
  | DatabaseFilter
  | {
      readonly operator: 'and' | 'or';
      readonly filters: readonly DatabaseFilterExpression[];
    };
export interface DatabaseView {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly filters?: readonly DatabaseFilter[];
  readonly where?: DatabaseFilterExpression;
  readonly sorts?: readonly {
    readonly property: string;
    readonly descending?: boolean;
  }[];
  readonly groupBy?: string;
  readonly dateProperty?: string;
  readonly endDateProperty?: string;
  readonly visibleProperties?: readonly string[];
  /** Widths in CSS pixels, keyed by stable property ID (`$title` for Name). */
  readonly columnWidths?: Readonly<Record<string, number>>;
  readonly [key: string]: unknown;
}
export interface DatabaseTemplate {
  readonly id: string;
  readonly name: string;
  readonly kindId: string;
  readonly model: unknown;
  readonly defaults: Readonly<Record<string, PropertyValue>>;
  readonly [key: string]: unknown;
}
/** Shared inspector layout; personal pins and collapse state live in settings. */
export interface DatabasePropertyPresentation {
  readonly order?: readonly string[];
  readonly hideWhenEmpty?: readonly string[];
  readonly sections?: readonly {
    readonly name: string;
    readonly propertyIds: readonly string[];
  }[];
}
export interface DatabaseModel {
  readonly format: 'froglight.database';
  readonly version: 1;
  title: string;
  properties: DatabaseProperty[];
  membership:
    | { readonly mode: 'explicit'; readonly resourceIds: readonly ResourceId[] }
    | {
        readonly mode: 'query';
        readonly filters: readonly DatabaseFilter[];
        readonly where?: DatabaseFilterExpression;
      };
  views: DatabaseView[];
  templates: DatabaseTemplate[];
  propertyPresentation?: DatabasePropertyPresentation;
  readonly [key: string]: unknown;
}
export function createDatabase(title = 'Untitled database'): DatabaseModel {
  return {
    format: 'froglight.database',
    version: 1,
    title,
    properties: [],
    membership: { mode: 'explicit', resourceIds: [] },
    views: [{ id: 'table', name: 'Table', type: 'table' }],
    templates: [],
  };
}
