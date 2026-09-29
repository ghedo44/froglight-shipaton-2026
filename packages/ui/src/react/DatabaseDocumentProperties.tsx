import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import {
  DatabaseController,
  captureDatabaseEvaluationContext,
  nextDatabaseDayBoundary,
  applyDatabasePropertyToDocument,
  databaseKindId,
  throwIfDatabaseQueryAborted,
  writeDatabaseProperty,
  type DatabaseDefinitions,
  type DatabaseModel,
  type DatabaseQueryProvider,
  type DatabaseRelationContext,
  type DatabaseRelationChoice,
  type DatabaseUndoOperation,
  type DatabaseProperty,
  type EvaluatedDatabaseRow,
  type ResourceId,
  type ResourcePropertyService,
  type SettingsService,
  type PropertyValue,
  type PropertyTypeDescriptor,
  type WorkspaceService,
} from '@froglight/foundation';
import type { RightSidebarContext } from '../right-sidebar-registry.js';
import { Cell } from './DatabaseContent.js';
import {
  DatabaseRelationPicker,
  loadDatabaseRelationChoicePage,
  type RelationChoicePage,
} from './DatabaseRelationPicker.js';
import styles from './RightSidebarPanels.module.css';

type Membership = {
  id: ResourceId;
  model: DatabaseModel;
  manual: boolean;
  row: EvaluatedDatabaseRow;
};
type Snapshot = {
  resourceId: ResourceId;
  memberships: readonly Membership[];
  available: readonly { id: ResourceId; title: string }[];
  availableSmart: readonly {
    id: ResourceId;
    model: DatabaseModel;
    values: Readonly<Record<string, PropertyValue>>;
  }[];
  unassigned: readonly {
    id: string;
    value: PropertyValue;
    databaseId?: ResourceId;
    property?: DatabaseProperty;
    conflict: boolean;
  }[];
};

const LARGE_SCHEMA_PROPERTY_COUNT = 6;
/** Keep an uncommitted membership choice through workspace service remounts. */
const membershipDrafts = new Map<string, Map<string, string>>();

function membershipDraftsFor(workspace: WorkspaceService): Map<string, string> {
  let drafts = membershipDrafts.get(workspace.workspaceId);
  if (!drafts) {
    drafts = new Map();
    membershipDrafts.set(workspace.workspaceId, drafts);
  }
  return drafts;
}

function presentationOrder(model: DatabaseModel): DatabaseProperty[] {
  const positions = new Map(
    (model.propertyPresentation?.order ?? []).map((id, index) => [id, index]),
  );
  return [...model.properties].sort((left, right) => {
    const a = positions.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const b = positions.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    return (
      a - b || model.properties.indexOf(left) - model.properties.indexOf(right)
    );
  });
}

function presentedProperties(
  model: DatabaseModel,
  pinned: readonly string[],
): DatabaseProperty[] {
  const ordered = presentationOrder(model);
  const pinnedProperties = ordered.filter((property) =>
    pinned.includes(property.id),
  );
  const remaining = ordered.filter((property) => !pinned.includes(property.id));
  const sectioned = (model.propertyPresentation?.sections ?? []).flatMap(
    (section) =>
      remaining.filter((property) => section.propertyIds.includes(property.id)),
  );
  const sectionedIds = new Set(sectioned.map((property) => property.id));
  return [
    ...pinnedProperties,
    ...sectioned,
    ...remaining.filter((property) => !sectionedIds.has(property.id)),
  ];
}

function presentationSection(model: DatabaseModel, propertyId: string): string {
  return (
    model.propertyPresentation?.sections?.find((section) =>
      section.propertyIds.includes(propertyId),
    )?.name ?? ''
  );
}

function emptyPropertyValue(value: PropertyValue): boolean {
  return (
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

function pinnedPropertyIds(
  settings: SettingsService | undefined,
  id: ResourceId,
): string[] {
  const saved = settings?.get(`database.properties.${id}`);
  if (typeof saved !== 'string') return [];
  try {
    const value: unknown = JSON.parse(saved);
    return Array.isArray(value) &&
      value.every((item) => typeof item === 'string')
      ? value
      : [];
  } catch {
    return [];
  }
}

export function databasePropertyActionHref(
  type: DatabaseProperty['type'],
  value: PropertyValue,
): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  if (type === 'url') {
    try {
      const url = new URL(
        /^[a-z][a-z\d+.-]*:/i.test(text) ? text : `https://${text}`,
      );
      return url.protocol === 'http:' || url.protocol === 'https:'
        ? url.href
        : null;
    } catch {
      return null;
    }
  }
  if (
    type === 'email' &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) &&
    !/[?&#]/.test(text)
  )
    return `mailto:${text}`;
  if (type === 'phone' && /^\+?[\d][\d ()-]{2,}$/.test(text))
    return `tel:${text.replace(/[ ()-]/g, '')}`;
  return null;
}

function PropertyEditor({
  property,
  value,
  choices,
  editor,
  relationLookupScope,
  loadRelationChoices,
  readOnly,
  onWrite,
  onDiscard,
}: {
  property: DatabaseProperty;
  value: PropertyValue;
  choices?: readonly DatabaseRelationChoice[];
  editor?: PropertyTypeDescriptor['editor'];
  relationLookupScope?: unknown;
  loadRelationChoices?(
    search: string,
    selected: readonly ResourceId[],
    signal: AbortSignal,
  ): Promise<RelationChoicePage>;
  readOnly: boolean;
  onWrite(value: PropertyValue): Promise<void>;
  onDiscard?(): void;
}) {
  const [draft, setDraft] = useState<PropertyValue | undefined>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (
      !error &&
      draft !== undefined &&
      JSON.stringify(draft) === JSON.stringify(value)
    )
      setDraft(undefined);
  }, [draft, error, value]);
  const save = async (next: PropertyValue) => {
    if (saving) return;
    setDraft(next);
    setError('');
    setSaving(true);
    try {
      await onWrite(next);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  };
  const shownValue = draft === undefined ? value : draft;
  const actionHref = databasePropertyActionHref(property.type, shownValue);
  return (
    <div>
      {property.type === 'relation' && !readOnly && loadRelationChoices ? (
        <DatabaseRelationPicker
          label={property.name}
          value={shownValue}
          busy={saving}
          lookupScope={relationLookupScope}
          loadChoices={loadRelationChoices}
          onWrite={(next) => void save(next)}
        />
      ) : (
        <Cell
          property={property}
          editor={editor}
          value={shownValue}
          choices={choices}
          readOnly={readOnly}
          busy={saving}
          onWrite={(next) => void save(next)}
        />
      )}
      {actionHref && (
        <a
          className={styles['document-property-action']}
          href={actionHref}
          {...(property.type === 'url'
            ? { target: '_blank', rel: 'noopener noreferrer' }
            : {})}
        >
          {property.type === 'url'
            ? 'Open link'
            : property.type === 'email'
              ? 'Write email'
              : 'Call number'}
        </a>
      )}
      {saving && <small role="status">Saving…</small>}
      {error && (
        <small role="alert">
          Could not save: {error}{' '}
          <button
            type="button"
            onClick={() => {
              if (draft !== undefined) void save(draft);
            }}
          >
            Retry
          </button>
          <button
            type="button"
            onClick={() => {
              setDraft(undefined);
              setError('');
              onDiscard?.();
            }}
          >
            Use latest value
          </button>
        </small>
      )}
    </div>
  );
}

/** Shell-owned property panel: the source document stays in its editor session. */
export function DatabaseDocumentProperties({
  context,
  workspace,
  properties,
  query,
  definitions,
  relations,
  settings,
}: {
  context: RightSidebarContext;
  workspace: WorkspaceService;
  properties: ResourcePropertyService;
  query: DatabaseQueryProvider;
  definitions: DatabaseDefinitions;
  relations: DatabaseRelationContext;
  settings?: SettingsService;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [revision, refresh] = useState(0);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(
    () => membershipDraftsFor(workspace).get(context.documentId) ?? '',
  );
  const [membershipPending, setMembershipPending] = useState(false);
  const [applying, setApplying] = useState('');
  const [search, setSearch] = useState('');
  const [expandedDatabases, setExpandedDatabases] = useState<
    ReadonlySet<ResourceId>
  >(new Set());
  const [undo, setUndo] = useState<DatabaseUndoOperation | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [showHidden, setShowHidden] = useState<ReadonlySet<ResourceId>>(
    new Set(),
  );
  const activeDocumentId = useRef(context.documentId);
  activeDocumentId.current = context.documentId;
  const relationLookupScope = useMemo(
    () => ({}),
    [context.documentId, definitions, properties, query],
  );
  const isCurrentDocument = () =>
    activeDocumentId.current === context.documentId;
  const ref = workspace
    .listDocuments()
    .find((item) => item.documentId === context.documentId);
  const resourceId = ref?.location.resourceId;
  useEffect(() => {
    setAdding(membershipDraftsFor(workspace).get(context.documentId) ?? '');
    setSearch('');
    setExpandedDatabases(new Set());
    setShowHidden(new Set());
    setUndo(null);
  }, [context.documentId, workspace]);
  useEffect(() => {
    if (!settings) return;
    return settings.onChange((key) => {
      if (
        key.startsWith('database.properties.') ||
        key.startsWith('database.properties-expanded.')
      )
        refresh((value) => value + 1);
    }).dispose;
  }, [settings]);
  useEffect(() => {
    const sidecars = properties.onDidChange(() =>
      refresh((value) => value + 1),
    );
    const catalog = properties.catalog.onDidChange(() =>
      refresh((value) => value + 1),
    );
    const commits = workspace.onDidCommit(() => refresh((value) => value + 1));
    const derived = workspace.onDidUpdateDerivedState?.(() =>
      refresh((value) => value + 1),
    );
    return () => {
      sidecars.dispose();
      catalog.dispose();
      commits.dispose();
      derived?.dispose();
    };
  }, [workspace, properties]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      clearTimeout(timer);
      const evaluation = captureDatabaseEvaluationContext();
      timer = setTimeout(
        () => {
          refresh((value) => value + 1);
          schedule();
        },
        Math.max(1, nextDatabaseDayBoundary(evaluation) - evaluation.nowMillis),
      );
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        refresh((value) => value + 1);
        schedule();
      }
    };
    schedule();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  useEffect(() => {
    let active = true;
    if (!resourceId || !ref) {
      setSnapshot(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError('');
    void (async () => {
      const all = workspace
        .listDocuments()
        .filter(
          (item) =>
            item.kindId === databaseKindId &&
            item.location.resourceId !== resourceId,
        )
        .flatMap((item) => {
          const model = definitions.get(item.location.resourceId);
          return model
            ? [
                {
                  id: item.location.resourceId,
                  model,
                  manual: model.membership.mode === 'explicit',
                },
              ]
            : [];
        });
      const rows = properties.rows();
      const storedValues = await properties.read(ref);
      const membership = await Promise.all(
        all.map(async (item) => {
          const evaluated = await query.execute(
            item.model,
            { id: 'document-properties', name: '', type: 'table' },
            rows,
            '',
            { evaluation: captureDatabaseEvaluationContext() },
          );
          const row = evaluated.find(
            (entry) => entry.resourceId === resourceId,
          );
          return {
            item,
            row,
          };
        }),
      );
      if (active) {
        const memberships = membership.flatMap(({ item, row }) =>
          row ? [{ ...item, row }] : [],
        );
        setSnapshot({
          resourceId,
          memberships,
          available: membership
            .filter(({ item, row }) => !row && item.manual)
            .map(({ item }) => ({ id: item.id, title: item.model.title })),
          availableSmart: membership
            .filter(({ item, row }) => !row && !item.manual)
            .map(({ item }) => ({
              id: item.id,
              model: item.model,
              values: storedValues,
            })),
          unassigned: Object.entries(storedValues)
            .filter(
              ([id]) =>
                !memberships.some(({ model }) =>
                  model.properties.some((property) => property.id === id),
                ),
            )
            .map(([id, value]) => {
              const owners = all.flatMap(({ id: databaseId, model }) =>
                model.properties
                  .filter((property) => property.id === id)
                  .map((property) => ({ databaseId, property })),
              );
              const conflict = owners.some(
                ({ property }) =>
                  JSON.stringify(property) !==
                  JSON.stringify(owners[0]?.property),
              );
              return { id, value, ...(!conflict ? owners[0] : {}), conflict };
            }),
        });
        setLoading(false);
      }
    })().catch((failure) => {
      if (active) {
        setLoadError(String(failure));
        setLoading(false);
      }
    });
    return () => {
      active = false;
    };
  }, [
    context.documentId,
    resourceId,
    revision,
    workspace,
    properties,
    query,
    definitions,
  ]);
  const current = snapshot?.resourceId === resourceId ? snapshot : null;
  const loadRelationChoices = async (
    databaseId: ResourceId,
    propertyId: string,
    search: string,
    selected: readonly ResourceId[],
    signal: AbortSignal,
  ): Promise<RelationChoicePage> => {
    throwIfDatabaseQueryAborted(signal);
    const latest = definitions.get(databaseId);
    const property = latest?.properties.find((item) => item.id === propertyId);
    if (!latest || !property) throw new Error('Property unavailable');
    const rows = properties.rowSource?.() ?? properties.rows();
    return loadDatabaseRelationChoicePage(
      property,
      definitions,
      query,
      rows,
      search,
      selected,
      signal,
    );
  };
  async function withDatabaseController<Result>(
    id: ResourceId,
    operation: (controller: DatabaseController) => Promise<Result>,
  ): Promise<Result> {
    const databaseRef = workspace
      .listDocuments()
      .find((item) => item.location.resourceId === id);
    if (!databaseRef) throw new Error('Database unavailable');
    const existing = workspace.getOpenDocument<DatabaseModel>(
      databaseRef.documentId,
    );
    const session =
      existing ??
      (await workspace.openDocument<DatabaseModel>(databaseRef.documentId));
    try {
      return await operation(
        new DatabaseController(
          session,
          workspace,
          properties,
          query,
          relations,
        ),
      );
    } finally {
      if (!existing) await session.close();
    }
  }
  const changePresentation = (
    id: ResourceId,
    patch: Partial<NonNullable<DatabaseModel['propertyPresentation']>>,
  ) => {
    setError('');
    void withDatabaseController(id, (controller) =>
      controller.patchPropertyPresentationWithUndo(patch),
    )
      .then((operation) => {
        if (isCurrentDocument()) setUndo(operation);
      })
      .catch((failure) => {
        if (isCurrentDocument()) setError(String(failure));
      });
  };
  const togglePinned = (id: ResourceId, propertyId: string) => {
    if (!settings) return;
    const pinned = pinnedPropertyIds(settings, id);
    settings.set(
      `database.properties.${id}`,
      JSON.stringify(
        pinned.includes(propertyId)
          ? pinned.filter((item) => item !== propertyId)
          : [...pinned, propertyId],
      ),
    );
  };
  const changeMembership = (id: ResourceId, action: 'add' | 'remove') => {
    if (!resourceId || membershipPending) return;
    setError('');
    setMembershipPending(true);
    void (async () => {
      const operation = await withDatabaseController(id, (controller) =>
        action === 'add'
          ? controller.addMemberWithUndo(resourceId)
          : controller.removeMemberWithUndo(resourceId),
      );
      if (!isCurrentDocument()) return;
      setUndo(operation);
      membershipDraftsFor(workspace).delete(context.documentId);
      setAdding('');
      refresh((value) => value + 1);
    })()
      .catch((failure) => {
        if (!isCurrentDocument()) return;
        setError(String(failure));
      })
      .finally(() => {
        if (isCurrentDocument()) setMembershipPending(false);
      });
  };
  return (
    <div className={styles['right-sidebar-panel']}>
      <h2 className={styles['right-sidebar-heading']}>Properties</h2>
      <p className={styles['document-setting-hint']}>
        {context.title} ·{' '}
        {context.kindId.replace(/^froglight\./, '').replace(/[-_]/g, ' ')}
      </p>
      {!ref && <p role="status">Document unavailable.</p>}
      {ref && loading && !current && <p role="status">Loading properties…</p>}
      {ref && loading && current && <small role="status">Refreshing…</small>}
      {error && <p role="alert">{error}</p>}
      {loadError && <p role="alert">{loadError}</p>}
      {undo && (
        <div className={styles['document-properties-undo']} role="status">
          <span>{undo.label} completed.</span>
          <button
            type="button"
            disabled={undoing}
            onClick={() => {
              const operation = undo;
              setUndo(null);
              setUndoing(true);
              setError('');
              void operation
                .undo()
                .then(() => {
                  if (isCurrentDocument()) refresh((value) => value + 1);
                })
                .catch((failure) => {
                  if (isCurrentDocument())
                    setError(
                      `Could not undo: ${failure instanceof Error ? failure.message : String(failure)}`,
                    );
                })
                .finally(() => {
                  if (isCurrentDocument()) setUndoing(false);
                });
            }}
          >
            {undoing ? 'Undoing…' : 'Undo'}
          </button>
        </div>
      )}
      {current && current.memberships.length === 0 && (
        <p>
          No database properties yet. Add this document to a manual database, or
          apply a known field to make it match a smart collection.
        </p>
      )}
      {current &&
        current.memberships.some(
          ({ model }) => model.properties.length > LARGE_SCHEMA_PROPERTY_COUNT,
        ) && (
          <input
            className={styles['document-properties-search']}
            type="search"
            aria-label="Find property"
            placeholder="Find property"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        )}
      {current &&
        current.memberships.map(({ id, model, manual, row }) => {
          const large = model.properties.length > LARGE_SCHEMA_PROPERTY_COUNT;
          const normalizedSearch = search.trim().toLocaleLowerCase();
          const pinned = pinnedPropertyIds(settings, id);
          const ordered = presentedProperties(model, pinned);
          const expanded =
            !large ||
            (settings
              ? settings.get(`database.properties-expanded.${id}`) === true
              : expandedDatabases.has(id)) ||
            normalizedSearch.length > 0;
          const matchingProperties = model.properties.filter((property) =>
            property.name.toLocaleLowerCase().includes(normalizedSearch),
          );
          const hiddenEmpty = model.propertyPresentation?.hideWhenEmpty ?? [];
          const hiddenCount = ordered.filter(
            (property) =>
              !pinned.includes(property.id) &&
              hiddenEmpty.includes(property.id) &&
              emptyPropertyValue(row.values[property.id] ?? null),
          ).length;
          const displayed = ordered.filter(
            (property) =>
              (expanded || pinned.includes(property.id)) &&
              property.name.toLocaleLowerCase().includes(normalizedSearch) &&
              (pinned.includes(property.id) ||
                normalizedSearch.length > 0 ||
                showHidden.has(id) ||
                !hiddenEmpty.includes(property.id) ||
                !emptyPropertyValue(row.values[property.id] ?? null)),
          );
          return (
            <section key={id} className={styles['document-settings-group']}>
              <div className={styles['document-properties-heading']}>
                <h3>{model.title}</h3>
                {large && !normalizedSearch && (
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => {
                      if (settings)
                        settings.set(
                          `database.properties-expanded.${id}`,
                          !expanded,
                        );
                      else
                        setExpandedDatabases((existing) => {
                          const next = new Set(existing);
                          if (next.has(id)) next.delete(id);
                          else next.add(id);
                          return next;
                        });
                    }}
                  >
                    {expanded
                      ? 'Hide properties'
                      : `Show ${model.properties.length} properties`}
                  </button>
                )}
              </div>
              <button
                type="button"
                className={styles['document-properties-open']}
                onClick={() => {
                  const databaseRef = workspace
                    .listDocuments()
                    .find((item) => item.location.resourceId === id);
                  if (databaseRef) context.openDocument(databaseRef.documentId);
                }}
              >
                Open database
              </button>
              {manual && (
                <button
                  type="button"
                  className={styles['document-properties-open']}
                  onClick={() => changeMembership(id, 'remove')}
                  disabled={membershipPending}
                >
                  Remove membership
                </button>
              )}
              {!manual && (
                <small>Smart collection · membership follows its rules</small>
              )}
              {model.properties.length === 0 && (
                <p className={styles['document-setting-hint']}>
                  Add properties in this database to organize its documents.
                </p>
              )}
              {hiddenCount > 0 && !normalizedSearch && (
                <button
                  type="button"
                  aria-expanded={showHidden.has(id)}
                  onClick={() =>
                    setShowHidden((existing) => {
                      const next = new Set(existing);
                      if (next.has(id)) next.delete(id);
                      else next.add(id);
                      return next;
                    })
                  }
                >
                  {showHidden.has(id)
                    ? 'Hide empty properties'
                    : `Show ${hiddenCount} empty properties`}
                </button>
              )}
              {displayed.map((property, index) => {
                const reason = properties.catalog.writeReason(property);
                const diagnostic = row.diagnostics[property.id];
                const section = pinned.includes(property.id)
                  ? 'Pinned'
                  : presentationSection(model, property.id);
                const previousProperty = displayed[index - 1];
                const previousSection = previousProperty
                  ? pinned.includes(previousProperty.id)
                    ? 'Pinned'
                    : presentationSection(model, previousProperty.id)
                  : '';
                const conflict = current.memberships.some(
                  (membership) =>
                    membership.id !== id &&
                    membership.model.properties.some(
                      (other) =>
                        other.id === property.id &&
                        JSON.stringify(other) !== JSON.stringify(property),
                    ),
                );
                return (
                  <Fragment key={property.id}>
                    {section && section !== previousSection && (
                      <h4>{section}</h4>
                    )}
                    <div className={styles['document-setting-row']}>
                      <span>{property.name}</span>
                      {conflict ? (
                        <span role="status">
                          Conflicting property definitions
                        </span>
                      ) : diagnostic ? (
                        <span role="status" title={diagnostic}>
                          Unavailable: {diagnostic}
                        </span>
                      ) : (
                        <div title={reason ?? undefined}>
                          <PropertyEditor
                            key={`${resourceId}:${id}:${property.id}`}
                            property={property}
                            editor={
                              properties.catalog.get(property.type)?.editor
                            }
                            value={row.values[property.id] ?? null}
                            relationLookupScope={relationLookupScope}
                            loadRelationChoices={(search, selected, signal) =>
                              loadRelationChoices(
                                id,
                                property.id,
                                search,
                                selected,
                                signal,
                              )
                            }
                            readOnly={reason !== null}
                            onWrite={async (value) => {
                              if (!resourceId)
                                throw new Error('Document unavailable');
                              const latest = definitions.get(id);
                              if (!latest)
                                throw new Error('Database unavailable');
                              if (
                                !latest.properties.some(
                                  (item) => item.id === property.id,
                                )
                              )
                                throw new Error('Property unavailable');
                              if (
                                !workspace
                                  .listDocuments()
                                  .some(
                                    (item) =>
                                      item.documentId === context.documentId &&
                                      item.location.resourceId === resourceId,
                                  )
                              )
                                throw new Error('Document changed');
                              const latestRows = await query.execute(
                                latest,
                                {
                                  id: 'document-properties-commit',
                                  name: '',
                                  type: 'table',
                                },
                                properties.rows(),
                                '',
                                {
                                  evaluation:
                                    captureDatabaseEvaluationContext(),
                                },
                              );
                              const latestRow = latestRows.find(
                                (item) => item.resourceId === resourceId,
                              );
                              if (!isCurrentDocument())
                                throw new Error('Document changed');
                              if (!latestRow)
                                throw new Error(
                                  'Document no longer belongs to this database',
                                );
                              if (
                                JSON.stringify(
                                  latestRow.values[property.id] ?? null,
                                ) !==
                                JSON.stringify(row.values[property.id] ?? null)
                              )
                                throw new Error(
                                  'Property changed elsewhere. Refresh and retry.',
                                );
                              if (
                                property.type === 'relation' &&
                                property.relation?.inverse
                              ) {
                                await writeDatabaseProperty(
                                  latest,
                                  workspace,
                                  properties,
                                  query,
                                  resourceId,
                                  property.id,
                                  value,
                                  relations,
                                  row.values[property.id] ?? null,
                                );
                                if (isCurrentDocument()) setUndo(null);
                              } else {
                                const operation = await withDatabaseController(
                                  id,
                                  (controller) =>
                                    controller.writeWithUndo(
                                      resourceId,
                                      property.id,
                                      value,
                                      row.values[property.id] ?? null,
                                    ),
                                );
                                if (isCurrentDocument()) setUndo(operation);
                              }
                            }}
                            onDiscard={() => refresh((value) => value + 1)}
                          />
                          {reason && (
                            <small className={styles['document-setting-hint']}>
                              {reason}
                            </small>
                          )}
                        </div>
                      )}
                    </div>
                  </Fragment>
                );
              })}
              {model.properties.length > 0 && (
                <details className={styles['document-property-arrangement']}>
                  <summary>Arrange properties</summary>
                  <p className={styles['document-setting-hint']}>
                    Order, sections, and empty visibility are shared with this
                    database. Pins are personal to this workspace.
                  </p>
                  {presentationOrder(model).map((property, index, ordered) => (
                    <div
                      key={property.id}
                      className={styles['document-property-arrangement-row']}
                    >
                      <strong>{property.name}</strong>
                      <div
                        className={
                          styles['document-property-arrangement-actions']
                        }
                      >
                        <button
                          type="button"
                          aria-label={`Move ${property.name} up`}
                          disabled={index === 0}
                          onClick={() => {
                            const ids = ordered.map((item) => item.id);
                            [ids[index - 1], ids[index]] = [
                              ids[index]!,
                              ids[index - 1]!,
                            ];
                            changePresentation(id, { order: ids });
                          }}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          aria-label={`Move ${property.name} down`}
                          disabled={index === ordered.length - 1}
                          onClick={() => {
                            const ids = ordered.map((item) => item.id);
                            [ids[index], ids[index + 1]] = [
                              ids[index + 1]!,
                              ids[index]!,
                            ];
                            changePresentation(id, { order: ids });
                          }}
                        >
                          ↓
                        </button>
                        {settings && (
                          <button
                            type="button"
                            aria-pressed={pinned.includes(property.id)}
                            onClick={() => togglePinned(id, property.id)}
                          >
                            {pinned.includes(property.id) ? 'Unpin' : 'Pin'}
                          </button>
                        )}
                      </div>
                      <label>
                        <input
                          type="checkbox"
                          checked={hiddenEmpty.includes(property.id)}
                          onChange={(event) =>
                            changePresentation(id, {
                              hideWhenEmpty: event.target.checked
                                ? [...hiddenEmpty, property.id]
                                : hiddenEmpty.filter(
                                    (item) => item !== property.id,
                                  ),
                            })
                          }
                        />
                        Hide when empty
                      </label>
                      <label>
                        Section
                        <input
                          key={`${property.id}:${presentationSection(model, property.id)}`}
                          type="text"
                          defaultValue={presentationSection(model, property.id)}
                          placeholder="No section"
                          onKeyDown={(event) => {
                            if (event.key === 'Enter')
                              event.currentTarget.blur();
                          }}
                          onBlur={(event) => {
                            const name = event.target.value.trim();
                            if (
                              name === presentationSection(model, property.id)
                            )
                              return;
                            const sections = (
                              model.propertyPresentation?.sections ?? []
                            )
                              .map((section) => ({
                                ...section,
                                propertyIds: section.propertyIds.filter(
                                  (item) => item !== property.id,
                                ),
                              }))
                              .filter(
                                (section) => section.propertyIds.length > 0,
                              );
                            if (name) {
                              const existing = sections.find(
                                (section) => section.name === name,
                              );
                              if (existing)
                                sections[sections.indexOf(existing)] = {
                                  ...existing,
                                  propertyIds: [
                                    ...existing.propertyIds,
                                    property.id,
                                  ],
                                };
                              else
                                sections.push({
                                  name,
                                  propertyIds: [property.id],
                                });
                            }
                            changePresentation(id, { sections });
                          }}
                        />
                      </label>
                    </div>
                  ))}
                </details>
              )}
              {expanded &&
                normalizedSearch &&
                matchingProperties.length === 0 && (
                  <p className={styles['document-setting-hint']}>
                    No properties match “{search.trim()}”.
                  </p>
                )}
            </section>
          );
        })}
      {current && current.unassigned.length > 0 && (
        <section className={styles['document-settings-group']}>
          <h3>Other assigned properties</h3>
          {current.unassigned.map(
            ({ id, value, databaseId, property, conflict }) => {
              const reason =
                property && properties.catalog.writeReason(property);
              const editable =
                property &&
                databaseId &&
                !conflict &&
                reason === null &&
                property.type !== 'relation';
              return (
                <div key={id} className={styles['document-setting-row']}>
                  <span>{property?.name ?? id}</span>
                  {editable ? (
                    <PropertyEditor
                      key={`${resourceId}:${databaseId}:${id}`}
                      property={property}
                      editor={properties.catalog.get(property.type)?.editor}
                      value={value}
                      readOnly={false}
                      onWrite={async (next) => {
                        if (!resourceId)
                          throw new Error('Document unavailable');
                        await applyDatabasePropertyToDocument({
                          databaseId,
                          resourceId,
                          propertyId: id,
                          value: next,
                          expectedValue: value,
                          definitions,
                          workspace,
                          properties,
                          query,
                          relations,
                        });
                      }}
                      onDiscard={() => refresh((value) => value + 1)}
                    />
                  ) : (
                    <span
                      role="status"
                      title={
                        conflict
                          ? 'Conflicting property definitions'
                          : property
                            ? (reason ??
                              'Relation requires database membership')
                            : 'Definition unavailable; stored value preserved'
                      }
                    >
                      {property ? (
                        <Cell
                          property={property}
                          editor={properties.catalog.get(property.type)?.editor}
                          value={value}
                          readOnly
                          onWrite={() => undefined}
                        />
                      ) : (
                        `${JSON.stringify(value).slice(0, 120)}${JSON.stringify(value).length > 120 ? '…' : ''}`
                      )}
                    </span>
                  )}
                </div>
              );
            },
          )}
        </section>
      )}
      {current && current.available.length > 0 && (
        <div className={styles['document-setting-row']}>
          <label>
            <span>Add to database</span>
            <select
              value={adding}
              disabled={membershipPending}
              onChange={(event) => {
                membershipDraftsFor(workspace).set(
                  context.documentId,
                  event.target.value,
                );
                setAdding(event.target.value);
              }}
            >
              <option value="">Choose database</option>
              {current.available.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={
              !current.available.some((item) => item.id === adding) ||
              membershipPending
            }
            onClick={() => changeMembership(adding as ResourceId, 'add')}
          >
            {membershipPending ? 'Adding…' : 'Add'}
          </button>
        </div>
      )}
      {current && current.availableSmart.length > 0 && (
        <section className={styles['document-settings-group']}>
          <label className={styles['document-setting-row']}>
            <span>Apply properties from</span>
            <select
              value={applying}
              onChange={(event) => setApplying(event.target.value)}
            >
              <option value="">Choose smart database</option>
              {current.availableSmart.map(({ id, model }) => (
                <option key={id} value={id}>
                  {model.title}
                </option>
              ))}
            </select>
          </label>
          {current.availableSmart
            .filter(({ id }) => id === applying)
            .map(({ id, model, values }) => {
              const editable = model.properties.filter(
                (property) =>
                  properties.catalog.writeReason(property) === null &&
                  !(property.type === 'relation' && property.relation?.inverse),
              );
              return (
                <div key={id}>
                  <p className={styles['document-setting-hint']}>
                    Setting a field may make this document match {model.title}.
                    Membership follows the database rules.
                  </p>
                  {editable.length === 0 && (
                    <p>No editable fields in this database.</p>
                  )}
                  {editable.map((property) => (
                    <div
                      key={property.id}
                      className={styles['document-setting-row']}
                    >
                      <span>{property.name}</span>
                      <PropertyEditor
                        key={`${resourceId}:${id}:${property.id}`}
                        property={property}
                        editor={properties.catalog.get(property.type)?.editor}
                        value={values[property.id] ?? null}
                        relationLookupScope={relationLookupScope}
                        loadRelationChoices={(search, selected, signal) =>
                          loadRelationChoices(
                            id,
                            property.id,
                            search,
                            selected,
                            signal,
                          )
                        }
                        readOnly={false}
                        onWrite={async (value) => {
                          if (!resourceId)
                            throw new Error('Document unavailable');
                          await applyDatabasePropertyToDocument({
                            databaseId: id,
                            resourceId,
                            propertyId: property.id,
                            value,
                            expectedValue: values[property.id] ?? null,
                            definitions,
                            workspace,
                            properties,
                            query,
                            relations,
                          });
                        }}
                        onDiscard={() => refresh((value) => value + 1)}
                      />
                    </div>
                  ))}
                </div>
              );
            })}
        </section>
      )}
    </div>
  );
}
