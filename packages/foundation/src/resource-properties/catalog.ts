import type { JsonValue } from '../blocks/model.js';

export type PropertyValue = JsonValue;
export type PropertyType =
  | 'text'
  | 'number'
  | 'boolean'
  | 'date'
  | 'select'
  | 'multi-select'
  | 'url'
  | 'email'
  | 'phone'
  | 'relation'
  | 'rollup'
  | 'formula'
  | 'created'
  | 'updated';
export interface PropertyOption {
  readonly id: string;
  readonly name: string;
  /** Semantic color name; renderers map it to theme tokens. Array order is canonical. */
  readonly color?: string;
  readonly [key: string]: unknown;
}
export interface ResourcePropertyDefinition {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  /** Stable Markdown frontmatter binding in database format v3. */
  readonly storageKey?: string;
  readonly options?: readonly PropertyOption[];
  readonly readOnly?: boolean;
  readonly [key: string]: unknown;
}
export interface PropertyTypeDescriptor {
  readonly id: string;
  readonly label: string;
  readonly storage: 'stored' | 'computed';
  readonly editor:
    | 'text'
    | 'number'
    | 'boolean'
    | 'date'
    | 'select'
    | 'multi-select'
    | 'relation'
    | 'none';
  validate(
    value: PropertyValue,
    definition: ResourcePropertyDefinition,
  ): string | null;
}
export interface DateRange {
  readonly start: string;
  readonly end: string;
}
export function isDateRange(
  value: PropertyValue,
): value is DateRange & { [key: string]: JsonValue } {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).start === 'string' &&
    typeof (value as Record<string, unknown>).end === 'string'
  );
}
export function isIsoDate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{3})?Z)?$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value.slice(0, 10)
  );
}
const text = (value: PropertyValue) =>
  typeof value === 'string' ? null : 'Expected text';
const selection = (
  value: PropertyValue,
  property: ResourcePropertyDefinition,
) =>
  typeof value === 'string' &&
  property.options?.some((option) => option.id === value)
    ? null
    : 'Unknown option';
const coreTypes: readonly PropertyTypeDescriptor[] = [
  {
    id: 'text',
    label: 'Text',
    storage: 'stored',
    editor: 'text',
    validate: text,
  },
  {
    id: 'number',
    label: 'Number',
    storage: 'stored',
    editor: 'number',
    validate: (value) =>
      typeof value === 'number' && Number.isFinite(value)
        ? null
        : 'Expected a finite number',
  },
  {
    id: 'boolean',
    label: 'Checkbox',
    storage: 'stored',
    editor: 'boolean',
    validate: (value) =>
      typeof value === 'boolean' ? null : 'Expected a checkbox value',
  },
  {
    id: 'date',
    label: 'Date or range',
    storage: 'stored',
    editor: 'date',
    validate: (value) =>
      isIsoDate(value) ||
      (isDateRange(value) &&
        isIsoDate(value.start) &&
        isIsoDate(value.end) &&
        value.start.length === value.end.length &&
        Date.parse(value.start) <= Date.parse(value.end))
        ? null
        : 'Expected an ISO date or an ordered date range',
  },
  {
    id: 'select',
    label: 'Select',
    storage: 'stored',
    editor: 'select',
    validate: selection,
  },
  {
    id: 'multi-select',
    label: 'Multi-select',
    storage: 'stored',
    editor: 'multi-select',
    validate: (value, property) =>
      Array.isArray(value) &&
      new Set(value).size === value.length &&
      value.every((item) => selection(item, property) === null)
        ? null
        : 'Expected unique option IDs',
  },
  {
    id: 'url',
    label: 'URL',
    storage: 'stored',
    editor: 'text',
    validate: (value) =>
      typeof value === 'string' &&
      /^https?:\/\/[^\s/?#]+(?:[/?#][^\s]*)?$/i.test(value)
        ? null
        : 'Expected an HTTP or HTTPS URL',
  },
  {
    id: 'email',
    label: 'Email',
    storage: 'stored',
    editor: 'text',
    validate: (value) =>
      typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
        ? null
        : 'Expected an email address',
  },
  {
    id: 'phone',
    label: 'Phone',
    storage: 'stored',
    editor: 'text',
    validate: (value) =>
      typeof value === 'string' &&
      /^\+?[\d ().-]+(?:\s*(?:x|ext\.?)\s*\d+)?$/i.test(value) &&
      /\d/.test(value)
        ? null
        : 'Expected a phone number',
  },
  {
    id: 'relation',
    label: 'Relation',
    storage: 'stored',
    editor: 'relation',
    validate: (value) =>
      Array.isArray(value) &&
      new Set(value).size === value.length &&
      value.every((item) => typeof item === 'string' && item.length > 0)
        ? null
        : 'Expected unique resource IDs',
  },
  ...(['rollup', 'formula', 'created', 'updated'] as const).map((id) => ({
    id,
    label: {
      rollup: 'Rollup',
      formula: 'Formula',
      created: 'Created time',
      updated: 'Updated time',
    }[id],
    storage: 'computed' as const,
    editor: 'none' as const,
    validate: () => null,
  })),
];

/** One validation/write-eligibility catalog for all document kinds and views. */
export class PropertyCatalog {
  readonly #types = new Map(coreTypes.map((type) => [type.id, type]));
  readonly #listeners = new Set<() => void>();
  onDidChange(listener: () => void): { dispose(): void } {
    this.#listeners.add(listener);
    return { dispose: () => this.#listeners.delete(listener) };
  }
  list(): readonly PropertyTypeDescriptor[] {
    return [...this.#types.values()];
  }
  get(id: string): PropertyTypeDescriptor | undefined {
    return this.#types.get(id);
  }
  register(type: PropertyTypeDescriptor): { dispose(): void } {
    if (this.#types.has(type.id))
      throw new Error(`Duplicate property type: ${type.id}`);
    this.#types.set(type.id, type);
    this.#listeners.forEach((listener) => listener());
    return {
      dispose: () => {
        if (this.#types.get(type.id) === type) {
          this.#types.delete(type.id);
          this.#listeners.forEach((listener) => listener());
        }
      },
    };
  }
  diagnostic(
    property: ResourcePropertyDefinition,
    value: PropertyValue,
  ): string | null {
    const type = this.get(property.type);
    if (!type) return `Property provider unavailable: ${property.type}`;
    return value === null ? null : type.validate(value, property);
  }
  writeReason(property: ResourcePropertyDefinition): string | null {
    const type = this.get(property.type);
    if (!type) return `Property provider unavailable: ${property.type}`;
    return property.readOnly || type.storage === 'computed'
      ? 'This property is derived or read-only'
      : null;
  }
}

const coreCatalog = new PropertyCatalog();
export function propertyDiagnostic(
  property: ResourcePropertyDefinition,
  value: PropertyValue,
): string | null {
  return coreCatalog.diagnostic(property, value);
}
