import type {
  DatabaseFilter,
  DatabaseFilterExpression,
  DatabaseProperty,
  DatabaseRelationChoice,
  PropertyValue,
} from '@froglight/foundation';

type Group = Extract<
  DatabaseFilterExpression,
  { readonly filters: readonly DatabaseFilterExpression[] }
>;

const operators: Readonly<Record<DatabaseFilter['operator'], string>> = {
  eq: 'Is',
  neq: 'Is not',
  contains: 'Contains',
  gt: 'Greater than',
  lt: 'Less than',
  empty: 'Is empty',
  'date-relative': 'Is relative to today',
};

function allowed(
  property?: DatabaseProperty,
): readonly DatabaseFilter['operator'][] {
  switch (property?.type) {
    case 'relation':
    case 'multi-select':
      return ['contains', 'empty'];
    case 'select':
    case 'boolean':
      return ['eq', 'neq', 'empty'];
    case 'number':
    case 'date':
    case 'created':
    case 'updated':
      return ['eq', 'neq', 'gt', 'lt', 'date-relative', 'empty'];
    default:
      return ['eq', 'neq', 'contains', 'empty'];
  }
}

function newCondition(): DatabaseFilter {
  return { property: '$title', operator: 'eq', value: '' };
}

function valueFor(
  property: DatabaseProperty | undefined,
  input: string,
): PropertyValue {
  if (input === '') return null;
  if (property?.type === 'boolean') return input === 'true';
  if (property?.type === 'number') {
    const value = Number(input);
    return Number.isFinite(value) ? value : null;
  }
  return input;
}

function Condition({
  filter,
  properties,
  choices,
  disabled,
  onChange,
  onRemove,
}: {
  filter: DatabaseFilter;
  properties: readonly DatabaseProperty[];
  choices: Readonly<Record<string, readonly DatabaseRelationChoice[]>>;
  disabled: boolean;
  onChange(filter: DatabaseFilter): void;
  onRemove(): void;
}) {
  const property = properties.find((item) => item.id === filter.property);
  const available = allowed(property);
  const value = filter.value;
  const stringValue =
    value === null || value === undefined ? '' : String(value);
  return (
    <div>
      <label>
        Field{' '}
        <select
          disabled={disabled}
          value={filter.property}
          onChange={(event) => {
            const next = properties.find(
              (item) => item.id === event.target.value,
            );
            const operator = allowed(next)[0]!;
            onChange({ property: event.target.value, operator, value: null });
          }}
        >
          {!['$title', '$kind', '$path'].includes(filter.property) &&
            !property && (
              <option value={filter.property}>
                Unavailable field ({filter.property})
              </option>
            )}
          <option value="$title">Document title</option>
          <option value="$kind">Document kind</option>
          <option value="$path">Document path</option>
          {properties.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Operator{' '}
        <select
          disabled={disabled || (!property && !filter.property.startsWith('$'))}
          value={filter.operator}
          onChange={(event) => {
            const operator = event.target.value as DatabaseFilter['operator'];
            onChange({
              property: filter.property,
              operator,
              ...(operator === 'empty'
                ? {}
                : {
                    value:
                      operator === 'date-relative' ? 'today' : (value ?? null),
                  }),
            });
          }}
        >
          {!available.includes(filter.operator) && (
            <option value={filter.operator} disabled>
              Unsupported ({filter.operator})
            </option>
          )}
          {available.map((operator) => (
            <option key={operator} value={operator}>
              {operators[operator]}
            </option>
          ))}
        </select>
      </label>
      {filter.operator !== 'empty' && (
        <label>
          Value{' '}
          {filter.operator === 'date-relative' ? (
            <select
              disabled={disabled}
              value={stringValue || 'today'}
              onChange={(event) =>
                onChange({ ...filter, value: event.target.value })
              }
            >
              <option value="today">Today</option>
              <option value="yesterday">Yesterday</option>
              <option value="tomorrow">Tomorrow</option>
              <option value="past-7-days">Past 7 days, including today</option>
              <option value="next-7-days">Next 7 days, including today</option>
            </select>
          ) : property?.type === 'boolean' ? (
            <select
              disabled={disabled}
              value={stringValue}
              onChange={(event) =>
                onChange({
                  ...filter,
                  value: valueFor(property, event.target.value),
                })
              }
            >
              <option value="">No value</option>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          ) : property?.type === 'select' ||
            property?.type === 'multi-select' ? (
            <select
              disabled={disabled}
              value={stringValue}
              onChange={(event) =>
                onChange({
                  ...filter,
                  value: valueFor(property, event.target.value),
                })
              }
            >
              <option value="">No value</option>
              {property.options?.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
          ) : property?.type === 'relation' ? (
            <select
              disabled={disabled}
              value={stringValue}
              onChange={(event) =>
                onChange({
                  ...filter,
                  value: valueFor(property, event.target.value),
                })
              }
            >
              <option value="">Choose document</option>
              {choices[property.id]?.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
          ) : (
            <input
              disabled={disabled}
              type={
                property?.type === 'number'
                  ? 'number'
                  : ['date', 'created', 'updated'].includes(
                        property?.type ?? '',
                      )
                    ? 'date'
                    : 'text'
              }
              value={stringValue}
              onChange={(event) =>
                onChange({
                  ...filter,
                  value: valueFor(property, event.target.value),
                })
              }
            />
          )}
        </label>
      )}
      <button type="button" disabled={disabled} onClick={onRemove}>
        Remove condition
      </button>
    </div>
  );
}

function GroupEditor({
  group,
  properties,
  choices,
  disabled,
  depth,
  onChange,
  onRemove,
}: {
  group: Group;
  properties: readonly DatabaseProperty[];
  choices: Readonly<Record<string, readonly DatabaseRelationChoice[]>>;
  disabled: boolean;
  depth: number;
  onChange(group: Group): void;
  onRemove(): void;
}) {
  const replace = (index: number, child: DatabaseFilterExpression) =>
    onChange({
      ...group,
      filters: group.filters.map((item, at) => (at === index ? child : item)),
    });
  const remove = (index: number) => {
    if (group.filters.length === 1) onRemove();
    else
      onChange({
        ...group,
        filters: group.filters.filter((_, at) => at !== index),
      });
  };
  return (
    <fieldset>
      <legend>Condition group</legend>
      <label>
        Match{' '}
        <select
          disabled={disabled}
          value={group.operator}
          onChange={(event) =>
            onChange({
              ...group,
              operator: event.target.value as Group['operator'],
            })
          }
        >
          <option value="and">All conditions</option>
          <option value="or">Any condition</option>
        </select>
      </label>
      {group.filters.map((child, index) =>
        'filters' in child ? (
          <GroupEditor
            key={index}
            group={child}
            properties={properties}
            choices={choices}
            disabled={disabled}
            depth={depth + 1}
            onChange={(next) => replace(index, next)}
            onRemove={() => remove(index)}
          />
        ) : (
          <Condition
            key={index}
            filter={child}
            properties={properties}
            choices={choices}
            disabled={disabled}
            onChange={(next) => replace(index, next)}
            onRemove={() => remove(index)}
          />
        ),
      )}
      <button
        type="button"
        disabled={disabled || group.filters.length >= 16}
        onClick={() =>
          onChange({ ...group, filters: [...group.filters, newCondition()] })
        }
      >
        Add condition
      </button>
      {depth < 3 && (
        <button
          type="button"
          disabled={disabled || group.filters.length >= 16}
          onClick={() =>
            onChange({
              ...group,
              filters: [
                ...group.filters,
                { operator: 'and', filters: [newCondition()] },
              ],
            })
          }
        >
          Add nested group
        </button>
      )}
      <button type="button" disabled={disabled} onClick={onRemove}>
        Remove group
      </button>
    </fieldset>
  );
}

export function DatabaseFilterTreeEditor({
  value,
  properties,
  choices = {},
  disabled,
  onChange,
}: {
  value?: DatabaseFilterExpression;
  properties: readonly DatabaseProperty[];
  choices?: Readonly<Record<string, readonly DatabaseRelationChoice[]>>;
  disabled: boolean;
  onChange(value?: DatabaseFilterExpression): void;
}) {
  return (
    <div>
      <strong>Condition groups</strong>
      {!value ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() =>
            onChange({ operator: 'and', filters: [newCondition()] })
          }
        >
          Add condition group
        </button>
      ) : 'filters' in value ? (
        <GroupEditor
          group={value}
          properties={properties}
          choices={choices}
          disabled={disabled}
          depth={0}
          onChange={onChange}
          onRemove={() => onChange(undefined)}
        />
      ) : (
        <Condition
          filter={value}
          properties={properties}
          choices={choices}
          disabled={disabled}
          onChange={onChange}
          onRemove={() => onChange(undefined)}
        />
      )}
    </div>
  );
}
