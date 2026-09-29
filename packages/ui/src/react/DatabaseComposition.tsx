import { useEffect, useRef, useState } from 'react';
import {
  validateDatabase,
  type CompositionPresenter,
  type CompositionSnapshot,
  type DatabaseFilter,
  type DatabaseFilterExpression,
  type DatabaseProperty,
  type DatabaseRelationChoice,
  type DatabaseView,
  type EvaluatedDatabaseRow,
  type JsonRecord,
  type PropertyValue,
  type PropertyTypeDescriptor,
  type ResourceId,
} from '@froglight/foundation';
import { DatabaseContent } from './DatabaseContent.js';
import { DatabaseFilterTreeEditor } from './DatabaseFilterTreeEditor.js';
import { mountIsolatedReactRoot } from './isolated-react-root.js';
import styles from './DatabaseView.module.css';

function operatorsFor(
  property?: DatabaseProperty,
): readonly DatabaseFilter['operator'][] {
  switch (property?.type) {
    case 'number':
      return ['eq', 'neq', 'gt', 'lt', 'empty'];
    case 'date':
    case 'created':
    case 'updated':
      return ['eq', 'neq', 'gt', 'lt', 'date-relative', 'empty'];
    case 'relation':
    case 'multi-select':
      return ['contains', 'empty'];
    case 'select':
    case 'boolean':
      return ['eq', 'neq', 'empty'];
    case 'text':
    case 'url':
    case 'email':
    case 'phone':
    case undefined:
      return ['eq', 'neq', 'contains', 'empty'];
    default:
      return ['eq', 'neq', 'contains', 'gt', 'lt', 'empty'];
  }
}

const operatorLabels: Readonly<Record<DatabaseFilter['operator'], string>> = {
  eq: 'is',
  neq: 'is not',
  contains: 'contains',
  gt: 'is greater than',
  lt: 'is less than',
  empty: 'is empty',
  'date-relative': 'is relative to today',
};

function propertyLabel(properties: readonly DatabaseProperty[], id: string) {
  if (id === '$title') return 'Document title';
  return properties.find((property) => property.id === id)?.name ?? id;
}

function filterValueLabel(
  filter: DatabaseFilter,
  property: DatabaseProperty | undefined,
  relationChoices: Readonly<Record<string, readonly DatabaseRelationChoice[]>>,
) {
  if (filter.operator === 'empty') return '';
  if (filter.operator === 'date-relative')
    return (
      {
        today: 'Today',
        yesterday: 'Yesterday',
        tomorrow: 'Tomorrow',
        'past-7-days': 'Past 7 days, including today',
        'next-7-days': 'Next 7 days, including today',
      }[String(filter.value)] ?? String(filter.value ?? '')
    );
  if (property?.type === 'boolean') return filter.value ? 'Yes' : 'No';
  if (property?.type === 'select' || property?.type === 'multi-select')
    return (
      property.options?.find((option) => option.id === filter.value)?.name ??
      String(filter.value ?? '')
    );
  if (property?.type === 'relation')
    return (
      relationChoices[property.id]?.find((choice) => choice.id === filter.value)
        ?.title ?? String(filter.value ?? '')
    );
  return String(filter.value ?? '');
}

function coerceFilterValue(
  property: DatabaseProperty | undefined,
  raw: string,
): PropertyValue {
  if (property?.type === 'number') {
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error('Enter a finite number.');
    return value;
  }
  if (property?.type === 'boolean') return raw === 'true';
  return raw;
}

function LinkedPresentation({
  snapshot,
  readOnly,
  invoke,
  configure,
  canChooseView = false,
}: {
  snapshot: CompositionSnapshot;
  readOnly: boolean;
  invoke(action: string, input?: JsonRecord): Promise<void>;
  configure?: Parameters<CompositionPresenter['mount']>[0]['configure'];
  canChooseView?: boolean;
}) {
  const [error, setError] = useState('');
  const [pending, setPending] = useState(0);
  const [filterProperty, setFilterProperty] = useState('$title');
  const [filterValue, setFilterValue] = useState('');
  const [filterOperator, setFilterOperator] =
    useState<DatabaseFilter['operator']>('eq');
  const [editingFilterIndex, setEditingFilterIndex] = useState<number | null>(
    null,
  );
  const [treeDraft, setTreeDraft] = useState<{
    value?: DatabaseFilterExpression;
  } | null>(null);
  const sourceView =
    'presentation' in snapshot &&
    snapshot.presentation?.type === 'froglight.database'
      ? (snapshot.presentation.data.view as unknown as DatabaseView | undefined)
      : undefined;
  const columnWidths = useRef<Readonly<Record<string, number>>>({});
  useEffect(() => {
    columnWidths.current = sourceView?.columnWidths ?? {};
  }, [sourceView?.columnWidths]);
  if (
    !('presentation' in snapshot) ||
    snapshot.presentation?.type !== 'froglight.database'
  )
    return null;
  const data = snapshot.presentation.data;
  const previewOnly = data.previewOnly === true;
  validateDatabase(data.model);
  const model = data.model;
  const view = data.view as unknown as DatabaseView | undefined;
  const overrides = (data.overrides ?? {}) as JsonRecord;
  const filters = Array.isArray(overrides.filters)
    ? (overrides.filters as unknown as readonly DatabaseFilter[])
    : [];
  const relationChoices = (data.relationChoices ?? {}) as unknown as Readonly<
    Record<string, readonly DatabaseRelationChoice[]>
  >;
  const propertyEditors = (data.propertyEditors ?? {}) as unknown as Readonly<
    Record<
      string,
      {
        readonly editor: PropertyTypeDescriptor['editor'];
        readonly writable: boolean;
      }
    >
  >;
  const selectedProperty = model.properties.find(
    (property) => property.id === filterProperty,
  );
  const savedView = model.views.find((item) => item.id === data.viewId);
  const allowedOperators = operatorsFor(selectedProperty);
  const sorts = view?.sorts ?? [];
  const busy = pending > 0;
  const change = (patch: Parameters<NonNullable<typeof configure>>[0]) => {
    try {
      configure?.(patch);
      setError('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  const changeOverrides = (patch: Partial<DatabaseView>) =>
    change({
      overrides: { ...overrides, ...patch } as unknown as JsonRecord,
    });
  const removeOverride = (key: keyof DatabaseView) => {
    const next = { ...overrides };
    delete next[key];
    change({ overrides: next });
  };
  const resetFilterDraft = () => {
    setEditingFilterIndex(null);
    setFilterProperty('$title');
    setFilterOperator('eq');
    setFilterValue('');
  };
  const editFilter = (filter: DatabaseFilter, index: number) => {
    setEditingFilterIndex(index);
    setFilterProperty(filter.property);
    setFilterOperator(filter.operator);
    setFilterValue(String(filter.value ?? ''));
  };
  const rows = data.rows as unknown as readonly EvaluatedDatabaseRow[];
  const dateProperties = model.properties.filter((property) =>
    ['date', 'formula', 'rollup'].includes(property.type),
  );
  return (
    <section
      className={`${styles.database} ${styles.embeddedDatabase}`}
      aria-label={`${model.title}: ${view?.name ?? 'Unavailable view'}`}
      contentEditable={false}
      aria-busy={busy}
    >
      <header className={styles.embedHeader}>
        <div className={styles.embedIdentity}>
          <strong>{model.title}</strong>
          <span>
            {view?.name ?? 'Unavailable view'}
            {view && view.name.toLowerCase() !== view.type.toLowerCase()
              ? ` · ${view.type}`
              : ''}
          </span>
        </div>
        <button type="button" onClick={() => void invoke('open-source')}>
          Open database
        </button>
      </header>
      {model.views.length > 1 && (
        <nav className={styles.embedTabs} aria-label="Embedded database views">
          {model.views.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-current={item.id === data.viewId ? 'page' : undefined}
              disabled={!canChooseView || busy}
              onClick={() => change({ viewId: item.id })}
            >{item.name}</button>
          ))}
        </nav>
      )}
      {snapshot.state === 'placeholder' && (
        <p role="status">{snapshot.message}</p>
      )}
      {configure && !previewOnly && (
        <details
          className={styles.settingsDisclosure}
          open={snapshot.state === 'placeholder'}
        >
          <summary>Linked view settings</summary>
          <div className={styles.settings}>
            <label>
              Saved view{' '}
              <select
                aria-label="Linked saved view"
                disabled={readOnly || busy}
                value={String(data.viewId ?? '')}
                onChange={(event) => change({ viewId: event.target.value })}
              >
                {!model.views.some((item) => item.id === data.viewId) && (
                  <option value={String(data.viewId ?? '')}>
                    Unavailable view
                  </option>
                )}
                {model.views.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            {view && (
              <>
                <label>
                  Local layout{' '}
                  <select
                    aria-label="Local layout"
                    disabled={readOnly || busy}
                    value={
                      typeof overrides.type === 'string' ? overrides.type : ''
                    }
                    onChange={(event) => {
                      if (event.target.value) {
                        changeOverrides({ type: event.target.value });
                      } else removeOverride('type');
                    }}
                  >
                    <option value="">
                      Use source layout ({savedView?.type ?? view.type})
                    </option>
                    {[
                      'table',
                      'board',
                      'list',
                      'gallery',
                      'calendar',
                      'timeline',
                    ].map((type) => (
                      <option key={type}>{type}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Local grouping{' '}
                  <select
                    aria-label="Local grouping"
                    disabled={readOnly || busy}
                    value={
                      typeof overrides.groupBy === 'string'
                        ? overrides.groupBy
                        : '$source'
                    }
                    onChange={(event) => {
                      if (event.target.value === '$source') {
                        removeOverride('groupBy');
                      } else {
                        changeOverrides({ groupBy: event.target.value });
                      }
                    }}
                  >
                    <option value="$source">Use source grouping</option>
                    <option value="">No grouping</option>
                    {model.properties.map((property) => (
                      <option key={property.id} value={property.id}>
                        {property.name}
                      </option>
                    ))}
                  </select>
                </label>
                {(view.type === 'calendar' || view.type === 'timeline') && (
                  <>
                    <label>
                      Start date{' '}
                      <select
                        aria-label="Local start date"
                        disabled={readOnly || busy}
                        value={
                          typeof overrides.dateProperty === 'string'
                            ? overrides.dateProperty
                            : '$source'
                        }
                        onChange={(event) => {
                          if (event.target.value === '$source') {
                            removeOverride('dateProperty');
                          } else {
                            changeOverrides({
                              dateProperty: event.target.value,
                            });
                          }
                        }}
                      >
                        <option value="$source">Use source start date</option>
                        <option value="">Choose a property</option>
                        {dateProperties.map((property) => (
                          <option key={property.id} value={property.id}>
                            {property.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    {view.type === 'timeline' && (
                      <label>
                        End date{' '}
                        <select
                          aria-label="Local end date"
                          disabled={readOnly || busy}
                          value={
                            typeof overrides.endDateProperty === 'string'
                              ? overrides.endDateProperty
                              : '$source'
                          }
                          onChange={(event) => {
                            if (event.target.value === '$source') {
                              removeOverride('endDateProperty');
                            } else {
                              changeOverrides({
                                endDateProperty: event.target.value,
                              });
                            }
                          }}
                        >
                          <option value="$source">Use source end date</option>
                          <option value="">Use start date</option>
                          {dateProperties.map((property) => (
                            <option key={property.id} value={property.id}>
                              {property.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                  </>
                )}
                <fieldset>
                  <legend>Local sort order</legend>
                  {sorts.map((sort, index) => (
                    <div className={styles.sortRow} key={index}>
                      <label>
                        Sort {index + 1}{' '}
                        <select
                          aria-label={`Local sort ${index + 1} property`}
                          disabled={readOnly || busy}
                          value={sort.property}
                          onChange={(event) =>
                            changeOverrides({
                              sorts: sorts.map((item, itemIndex) =>
                                itemIndex === index
                                  ? { ...item, property: event.target.value }
                                  : item,
                              ),
                            })
                          }
                        >
                          <option value="$title">Document title</option>
                          {model.properties.map((property) => (
                            <option key={property.id} value={property.id}>
                              {property.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          disabled={readOnly || busy}
                          checked={sort.descending ?? false}
                          onChange={(event) =>
                            changeOverrides({
                              sorts: sorts.map((item, itemIndex) =>
                                itemIndex === index
                                  ? {
                                      ...item,
                                      descending: event.target.checked,
                                    }
                                  : item,
                              ),
                            })
                          }
                        />
                        Descending
                      </label>
                      <button
                        type="button"
                        disabled={readOnly || busy}
                        onClick={() =>
                          changeOverrides({
                            sorts: sorts.filter(
                              (_, itemIndex) => itemIndex !== index,
                            ),
                          })
                        }
                      >
                        Remove sort
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    disabled={readOnly || busy}
                    onClick={() =>
                      changeOverrides({
                        sorts: [
                          ...sorts,
                          { property: '$title', descending: false },
                        ],
                      })
                    }
                  >
                    Add sort
                  </button>
                  <button
                    type="button"
                    disabled={
                      readOnly || busy || !Array.isArray(overrides.sorts)
                    }
                    onClick={() => removeOverride('sorts')}
                  >
                    Use source sort order
                  </button>
                </fieldset>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    try {
                      const next: DatabaseFilter = {
                        property: filterProperty,
                        operator: filterOperator,
                        ...(filterOperator === 'empty'
                          ? {}
                          : {
                              value: coerceFilterValue(
                                selectedProperty,
                                filterValue,
                              ),
                            }),
                      };
                      changeOverrides({
                        filters:
                          editingFilterIndex === null
                            ? [...filters, next]
                            : filters.map((filter, index) =>
                                index === editingFilterIndex ? next : filter,
                              ),
                      });
                      resetFilterDraft();
                    } catch (failure) {
                      setError(
                        failure instanceof Error
                          ? failure.message
                          : String(failure),
                      );
                    }
                  }}
                >
                  <label>
                    Local filter property{' '}
                    <select
                      aria-label="Local filter property"
                      disabled={readOnly || busy}
                      value={filterProperty}
                      onChange={(event) => {
                        const property = model.properties.find(
                          (item) => item.id === event.target.value,
                        );
                        setFilterProperty(event.target.value);
                        setFilterOperator(operatorsFor(property)[0] ?? 'eq');
                        setFilterValue(
                          property?.type === 'boolean' ? 'true' : '',
                        );
                      }}
                    >
                      {filterProperty !== '$title' &&
                        !model.properties.some(
                          (property) => property.id === filterProperty,
                        ) && (
                          <option value={filterProperty}>
                            Unavailable property ({filterProperty})
                          </option>
                        )}
                      <option value="$title">Document title</option>
                      {model.properties.map((property) => (
                        <option key={property.id} value={property.id}>
                          {property.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Local operator{' '}
                    <select
                      aria-label="Local filter operator"
                      value={filterOperator}
                      disabled={readOnly || busy}
                      onChange={(event) => {
                        const operator = event.target
                          .value as DatabaseFilter['operator'];
                        setFilterOperator(operator);
                        if (operator === 'date-relative')
                          setFilterValue('today');
                      }}
                    >
                      {(allowedOperators.includes(filterOperator)
                        ? allowedOperators
                        : [filterOperator, ...allowedOperators]
                      ).map((operator) => (
                        <option key={operator} value={operator}>
                          {operatorLabels[operator]}
                        </option>
                      ))}
                    </select>
                  </label>
                  {filterOperator !== 'empty' && (
                    <label>
                      Local filter value{' '}
                      {filterOperator === 'date-relative' ? (
                        <select
                          aria-label="Local filter value"
                          disabled={readOnly || busy}
                          value={filterValue || 'today'}
                          onChange={(event) =>
                            setFilterValue(event.target.value)
                          }
                        >
                          <option value="today">Today</option>
                          <option value="yesterday">Yesterday</option>
                          <option value="tomorrow">Tomorrow</option>
                          <option value="past-7-days">
                            Past 7 days, including today
                          </option>
                          <option value="next-7-days">
                            Next 7 days, including today
                          </option>
                        </select>
                      ) : selectedProperty?.type === 'boolean' ? (
                        <select
                          aria-label="Local filter value"
                          disabled={readOnly || busy}
                          value={filterValue}
                          onChange={(event) =>
                            setFilterValue(event.target.value)
                          }
                        >
                          <option value="true">Yes</option>
                          <option value="false">No</option>
                        </select>
                      ) : ['select', 'multi-select'].includes(
                          selectedProperty?.type ?? '',
                        ) ? (
                        <select
                          aria-label="Local filter value"
                          disabled={readOnly || busy}
                          required
                          value={filterValue}
                          onChange={(event) =>
                            setFilterValue(event.target.value)
                          }
                        >
                          <option value="">Choose option</option>
                          {selectedProperty?.options?.map((option) => (
                            <option key={option.id} value={option.id}>
                              {option.name}
                            </option>
                          ))}
                        </select>
                      ) : selectedProperty?.type === 'relation' ? (
                        <select
                          aria-label="Local filter value"
                          disabled={readOnly || busy}
                          required
                          value={filterValue}
                          onChange={(event) =>
                            setFilterValue(event.target.value)
                          }
                        >
                          <option value="">Choose document</option>
                          {relationChoices[selectedProperty.id]?.map(
                            (choice) => (
                              <option key={choice.id} value={choice.id}>
                                {choice.title}
                              </option>
                            ),
                          )}
                        </select>
                      ) : (
                        <input
                          aria-label="Local filter value"
                          type={
                            selectedProperty?.type === 'number'
                              ? 'number'
                              : ['date', 'created', 'updated'].includes(
                                    selectedProperty?.type ?? '',
                                  )
                                ? 'date'
                                : 'text'
                          }
                          required
                          disabled={readOnly || busy}
                          value={filterValue}
                          onChange={(event) =>
                            setFilterValue(event.target.value)
                          }
                        />
                      )}
                    </label>
                  )}
                  <button disabled={readOnly || busy}>
                    {editingFilterIndex === null
                      ? 'Add local filter'
                      : 'Save local filter'}
                  </button>
                  {editingFilterIndex !== null && (
                    <button
                      type="button"
                      disabled={readOnly || busy}
                      onClick={resetFilterDraft}
                    >
                      Cancel edit
                    </button>
                  )}
                </form>
                {filters.map((filter, index) => {
                  const property = model.properties.find(
                    (item) => item.id === filter.property,
                  );
                  return (
                    <span key={`${filter.property}-${index}`}>
                      {propertyLabel(model.properties, filter.property)}{' '}
                      {operatorLabels[filter.operator]}{' '}
                      {filterValueLabel(filter, property, relationChoices)}{' '}
                      <button
                        type="button"
                        aria-label={`Edit local filter ${index + 1}`}
                        disabled={readOnly || busy}
                        onClick={() => editFilter(filter, index)}
                      >
                        Edit
                      </button>{' '}
                      <button
                        type="button"
                        aria-label={`Remove local filter ${index + 1}`}
                        disabled={readOnly || busy}
                        onClick={() => {
                          changeOverrides({
                            filters: filters.filter(
                              (_, itemIndex) => itemIndex !== index,
                            ),
                          });
                          if (editingFilterIndex === index) resetFilterDraft();
                        }}
                      >
                        Remove
                      </button>
                    </span>
                  );
                })}
                {filters.length > 0 && (
                  <button
                    type="button"
                    disabled={readOnly || busy}
                    onClick={() => {
                      changeOverrides({ filters: [] });
                      resetFilterDraft();
                    }}
                  >
                    Clear local filters
                  </button>
                )}
                <p>{filters.length} local filters narrow the source view.</p>
                <DatabaseFilterTreeEditor
                  value={
                    treeDraft === null
                      ? (overrides.where as unknown as
                          | DatabaseFilterExpression
                          | undefined)
                      : treeDraft.value
                  }
                  properties={model.properties}
                  choices={relationChoices}
                  disabled={readOnly || busy}
                  onChange={(value) => setTreeDraft({ value })}
                />
                {treeDraft && (
                  <div>
                    <button
                      type="button"
                      disabled={readOnly || busy}
                      onClick={() => {
                        if (treeDraft.value) {
                          changeOverrides({ where: treeDraft.value });
                        } else {
                          removeOverride('where');
                        }
                        setTreeDraft(null);
                      }}
                    >
                      Save local condition groups
                    </button>
                    <button
                      type="button"
                      disabled={readOnly || busy}
                      onClick={() => setTreeDraft(null)}
                    >
                      Discard condition changes
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </details>
      )}
      {error && <p role="alert">{error}</p>}
      {view ? (
        <>
          <DatabaseContent
            relationChoices={relationChoices}
            editors={propertyEditors}
            model={model}
            view={view}
            rows={rows}
            readOnly={readOnly}
            emptyReason={
              filters.length > 0
                ? 'No documents match the local filters.'
                : 'No documents match this view.'
            }
            onViewPatch={
              readOnly || !configure
                ? undefined
                : (patch) => changeOverrides(patch)
            }
            onColumnWidth={
              readOnly || !configure
                ? undefined
                : (id, width) => {
                    const next = { ...columnWidths.current, [id]: width };
                    columnWidths.current = next;
                    changeOverrides({ columnWidths: next });
                  }
            }
            openResource={(id) => {
              void invoke('open-member', { resourceId: id });
            }}
            write={(id: ResourceId, propertyId, value) => {
              setPending((count) => count + 1);
              setError('');
              void invoke('write-property', {
                resourceId: id,
                propertyId,
                value,
              })
                .catch((failure) =>
                  setError(
                    failure instanceof Error
                      ? failure.message
                      : String(failure),
                  ),
                )
                .finally(() => setPending((count) => count - 1));
            }}
            writeCell={async (id, propertyId, value, expectedValue) => {
              setPending((count) => count + 1);
              try {
                await invoke('write-property', {
                  resourceId: id,
                  propertyId,
                  value,
                  ...(expectedValue === undefined ? {} : { expectedValue }),
                });
              } finally {
                setPending((count) => count - 1);
              }
            }}
          />
          {rows.length === 0 && filters.length > 0 && (
            <div className={styles.toolbar}>
              <button
                type="button"
                disabled={readOnly || busy || !configure}
                onClick={() => {
                  changeOverrides({ filters: [] });
                  resetFilterDraft();
                }}
              >
                Clear local filters
              </button>
            </div>
          )}
        </>
      ) : (
        <p>
          Choose an available saved view above to recover this linked view. Its
          local settings are preserved until you rebind it.
        </p>
      )}
    </section>
  );
}

/** A trusted presenter delegates all six layouts to the standalone content renderer. */
export function createDatabaseCompositionPresenter(): CompositionPresenter {
  return {
    mount(input) {
      if (
        !('presentation' in input.snapshot) ||
        input.snapshot.presentation?.type !== 'froglight.database'
      )
        return null;
      const parent = input.parent;
      if (!(parent instanceof HTMLElement)) return null;
      parent.classList.add('flbp-composition-database');
      const render = (snapshot: CompositionSnapshot, readOnly: boolean) => (
        <LinkedPresentation
          snapshot={snapshot}
          readOnly={readOnly || (('presentation' in snapshot && snapshot.presentation?.data.previewOnly === true))}
          invoke={input.invoke}
          configure={input.configure}
          canChooseView={!readOnly && !!input.configure}
        />
      );
      const root = mountIsolatedReactRoot(
        parent,
        render(input.snapshot, input.readOnly),
      );
      return {
        update(snapshot, readOnly) {
          root.render(render(snapshot, readOnly));
        },
        dispose() {
          root.dispose();
          parent.classList.remove('flbp-composition-database');
        },
      };
    },
  };
}
