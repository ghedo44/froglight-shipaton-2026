import { Select, Checkbox } from './primitives/Fields.jsx';
import { DatabasePropertyCreator } from './DatabasePropertyCreator.js';
import { DatabaseFilterTreeEditor } from './DatabaseFilterTreeEditor.js';
import { DatabaseTemplateCreator } from './DatabaseTemplateCreator.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { definePlugin } from '@froglight/runtime';
import {
  databaseRelationChoiceIncludes,
  databaseRelationChoices,
  captureDatabaseEvaluationContext,
  nextDatabaseDayBoundary,
  type DatabaseRelationChoice,
  DatabaseController,
  DatabaseUndoConflictError,
  PartialDatabaseCreationError,
  databaseKindId,
  InMemoryDocumentEditorRegistry,
  generateResourceId,
  resolveDatabaseView,
  workspacePath,
  isValidSegment,
  joinPath,
  parentPath,
  pathName,
  aggregate,
  type DatabaseModel,
  type DatabaseProperty,
  type DatabaseView as SavedView,
  type DatabaseFilter,
  type DatabaseFilterExpression,
  type DocumentEditorProvider,
  type DocumentEditorRegistry,
  type DocumentRegistry,
  type DocumentSession,
  type EvaluatedDatabaseRow,
  type PropertyValue,
  type ResourceId,
  type DocumentId,
  type WorkspaceService,
  type ResourcePropertyService,
  type DatabaseQueryProvider,
  workspaceToken,
  resourcePropertiesToken,
  databaseQueryToken,
  documentEditorRegistryToken,
  documentRegistryToken,
  type DocumentEditorHandle,
  type DatabaseRelationContext,
  type DatabaseUndoOperation,
  databaseDefinitionsToken,
  relationshipsToken,
  compositionRegistryToken,
  type CompositionRegistry,
  type ResourceTarget,
  type VaultService,
  vaultToken,
  updateDocumentTitle,
} from '@froglight/foundation';
import { mountIsolatedReactRoot } from './isolated-react-root.js';
import styles from './DatabaseView.module.css';
import { DatabaseContent } from './DatabaseContent.js';
import { DocumentName } from './DocumentName.js';
import { loadDatabaseRelationChoicePage } from './DatabaseRelationPicker.js';
import { DatabaseOptions } from './DatabaseOptions.js';
import { DatabasePortableActions } from './DatabasePortableActions.js';
import { uiNewNote } from '../dialogs.js';
import { noteKindOption } from '../note-kinds.js';
import { Modal } from './Modal.jsx';
import type { DialogHandle } from './primitives/Dialog.jsx';
import { Icon } from './Icon.jsx';
import { SwitcherOverlay } from './SwitcherOverlay.jsx';
import {
  fileExplorerToken,
  type FileExplorerService,
} from '../file-explorer.js';

const selectedViews = new WeakMap<DocumentSession<DatabaseModel>, string>();
const unavailableTemplateEditors = new InMemoryDocumentEditorRegistry();

function operatorsFor(
  property?: DatabaseProperty,
): readonly DatabaseFilter['operator'][] {
  switch (property?.type) {
    case 'number':
      return ['eq', 'neq', 'gt', 'lt', 'empty'];
    case 'date':
    case 'created':
    case 'updated':
      return ['eq', 'neq', 'gt', 'lt', 'empty', 'date-relative'];
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

export function DatabaseView({
  controller,
  openResource,
  readOnly = false,
  documents,
  editors = unavailableTemplateEditors,
  previews,
  vault,
  fileExplorer,
  moveDocument,
}: {
  controller: DatabaseController;
  openResource(id: ResourceId, disposition?: 'beside'): void;
  readOnly?: boolean;
  documents: DocumentRegistry;
  editors?: DocumentEditorRegistry;
  previews?: CompositionRegistry;
  vault?: VaultService;
  fileExplorer?: FileExplorerService | null;
  moveDocument?(documentId: string, toPath: string): Promise<void>;
}) {
  const [viewId, setViewId] = useState(
    selectedViews.get(controller.session) ??
      controller.model.views[0]?.id ??
      '',
  );
  const activeRef = useRef(false);
  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);
  const [rows, setRows] = useState<readonly EvaluatedDatabaseRow[]>([]);
  const [rowsViewId, setRowsViewId] = useState('');
  const [relationChoices, setRelationChoices] = useState<
    Readonly<Record<string, readonly DatabaseRelationChoice[]>>
  >({});
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [undoOperation, setUndoOperation] =
    useState<DatabaseUndoOperation | null>(null);
  const [undoPending, setUndoPending] = useState(false);
  const [revision, refresh] = useState(0);
  const [pending, setPending] = useState(0);
  const busy = pending > 0;
  const [configure, setConfigure] = useState(false);
  const [settingsTarget, setSettingsTarget] = useState<'view' | 'filters'>(
    'view',
  );
  const viewSettingsRef = useRef<HTMLDivElement>(null);
  const viewCreatorCloseRef = useRef<DialogHandle | null>(null);
  const propertyCreatorCloseRef = useRef<DialogHandle | null>(null);
  const propertyEditorCloseRef = useRef<DialogHandle | null>(null);
  const configureCloseRef = useRef<DialogHandle | null>(null);
  const sourceSettingsRef = useRef<HTMLElement>(null);
  const filterSettingsRef = useRef<HTMLElement>(null);
  const schemaSettingsRef = useRef<HTMLElement>(null);
  const [portableOpen, setPortableOpen] = useState(false);
  const [editingPropertyId, setEditingPropertyId] = useState<string | null>(
    null,
  );
  const [moreOpen, setMoreOpen] = useState(false);
  const [viewCreatorOpen, setViewCreatorOpen] = useState(false);
  const [viewName, setViewName] = useState('New view');
  const [viewType, setViewType] = useState('table');
  const [propertyOpen, setPropertyOpen] = useState(false);
  const [pendingCreated, setPendingCreated] = useState<ResourceId | null>(null);
  const [pendingTemplate, setPendingTemplate] = useState<string | undefined>();
  const [pendingMembershipSaved, setPendingMembershipSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [queryError, setQueryError] = useState('');
  const [addExisting, setAddExisting] = useState(false);
  const [allResources, setAllResources] = useState<
    readonly {
      documentId: DocumentId;
      resourceId: ResourceId;
      title: string;
      path: string;
    }[]
  >([]);
  const [filterProperty, setFilterProperty] = useState('$title');
  const [filterValue, setFilterValue] = useState('');
  const [filterOperator, setFilterOperator] =
    useState<DatabaseFilter['operator']>('eq');
  const [filterTarget, setFilterTarget] = useState('view');
  const [editingFilterIndex, setEditingFilterIndex] = useState<number | null>(
    null,
  );
  const [treeDraft, setTreeDraft] = useState<{
    key: string;
    value?: DatabaseFilterExpression;
  } | null>(null);
  const model = controller.model;
  const editingProperty = model.properties.find(
    (property) => property.id === editingPropertyId,
  );
  const jumpToSettings = (section: HTMLElement | null) => {
    section?.scrollIntoView({ block: 'start' });
    section?.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (!configure || settingsTarget !== 'filters') return;
    const frame = requestAnimationFrame(() =>
      jumpToSettings(filterSettingsRef.current),
    );
    return () => cancelAnimationFrame(frame);
  }, [configure, settingsTarget]);
  const renameDatabase = async (stem: string): Promise<void> => {
    const current = controller.workspace.resolveResourcePath(
      controller.session.document.location.resourceId,
    );
    const next = joinPath(parentPath(current), `${stem}.base`);
    if (
      next !== current &&
      controller.workspace
        .listDocuments()
        .some(
          (ref) =>
            controller.workspace.resolveResourcePath(
              ref.location.resourceId,
            ) === next,
        )
    )
      throw new Error('A document with this name already exists.');
    const previousTitle = controller.model.title;
    await controller.saveTitle(stem);
    try {
      if (next !== current) {
        if (moveDocument) {
          await moveDocument(
            String(controller.session.document.documentId),
            next,
          );
          fileExplorer?.refresh();
        } else if (fileExplorer) {
          await fileExplorer.moveDocument(
            String(controller.session.document.documentId),
            next,
          );
        } else {
          await controller.workspace.moveDocument(
            controller.session.document.documentId,
            workspacePath(next),
          );
          await controller.workspace.rebuildDerivedState();
        }
      }
      refresh((value) => value + 1);
    } catch (failure) {
      await controller.saveTitle(previousTitle);
      throw failure;
    }
  };
  const documentRefs = useMemo(
    () =>
      new Map(
        controller.workspace
          .listDocuments()
          .map((ref) => [ref.location.resourceId, ref] as const),
      ),
    [controller, revision],
  );
  const previewTarget = (id: ResourceId): ResourceTarget | null => {
    const ref = documentRefs.get(id);
    return ref
      ? {
          documentId: ref.documentId,
          kindId: ref.kindId,
          resourceId: ref.location.resourceId,
        }
      : null;
  };
  const view = model.views.find((item) => item.id === viewId);
  useEffect(() => {
    selectedViews.set(controller.session, viewId);
  }, [controller.session, viewId]);
  useEffect(() => setUndoOperation(null), [controller]);
  const mutate = async (operation: () => Promise<unknown>) => {
    setPending((count) => count + 1);
    setError('');
    try {
      await operation();
      refresh((value) => value + 1);
    } catch (failure) {
      if (failure instanceof PartialDatabaseCreationError) {
        setPendingCreated(failure.createdResourceId);
        setPendingTemplate(failure.templateId);
        setPendingMembershipSaved(failure.membershipSaved);
      }
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setPending((count) => count - 1);
    }
  };
  const mutateUndoable = (operation: () => Promise<DatabaseUndoOperation>) =>
    mutate(async () => {
      setUndoOperation(await operation());
    });
  const undoLatest = async () => {
    const operation = undoOperation;
    if (!operation) return;
    setPending((count) => count + 1);
    setUndoPending(true);
    setError('');
    try {
      await operation.undo();
      setUndoOperation(null);
      refresh((value) => value + 1);
    } catch (failure) {
      const message =
        failure instanceof Error ? failure.message : String(failure);
      setError(
        failure instanceof DatabaseUndoConflictError
          ? `Undo conflict: ${message}`
          : `Could not undo: ${message}`,
      );
      if (failure instanceof DatabaseUndoConflictError) setUndoOperation(null);
    } finally {
      setUndoPending(false);
      setPending((count) => count - 1);
    }
  };
  const mutateSchema = (operation: () => Promise<unknown>) =>
    mutate(async () => {
      const before = new Set(
        controller.model.properties.map((item) => item.id),
      );
      await operation();
      const added = controller.model.properties
        .filter((item) => !before.has(item.id))
        .map((item) => item.id);
      const currentView = controller.model.views.find(
        (item) => item.id === viewId,
      );
      if (added.length && currentView?.visibleProperties)
        await controller.patchView(currentView.id, {
          visibleProperties: [...currentView.visibleProperties, ...added],
        });
    });
  useEffect(() => {
    const creators = documents.onDidChange(() => refresh((value) => value + 1));
    const subscription = controller.properties.onDidChange(() =>
      refresh((value) => value + 1),
    );
    const catalog = controller.properties.catalog.onDidChange(() =>
      refresh((value) => value + 1),
    );
    const commits = controller.workspace.onDidCommit(() =>
      refresh((value) => value + 1),
    );
    return () => {
      subscription.dispose();
      catalog.dispose();
      commits.dispose();
      creators.dispose();
    };
  }, [controller, documents]);
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
    if (!view && model.views.length) setViewId(model.views[0]!.id);
  }, [view, model.views]);
  useEffect(() => {
    let active = true;
    const abort = new AbortController();
    if (view) {
      const evaluation = captureDatabaseEvaluationContext();
      setLoading(true);
      setQueryError('');
      void controller
        .rows(viewId, {}, search, { evaluation, signal: abort.signal })
        .then(async (result) => {
          const source =
            controller.properties.rowSource?.() ?? controller.properties.rows();
          const choices = await databaseRelationChoices(
            controller.model,
            controller.query,
            source,
            controller.relations?.definitions,
            {
              signal: abort.signal,
              include: databaseRelationChoiceIncludes(controller.model, result),
              evaluation,
            },
          );
          if (active) {
            setRows(result);
            setRowsViewId(viewId);
            setRelationChoices(choices);
            setLoading(false);
          }
        })
        .catch((failure) => {
          if (active) {
            setQueryError(String(failure));
            setLoading(false);
          }
        });
    }
    return () => {
      active = false;
      abort.abort();
    };
  }, [controller, viewId, search, revision, view]);
  const write = (id: ResourceId, property: string, value: PropertyValue) =>
    void mutateUndoable(() => controller.writeWithUndo(id, property, value));
  const saveView = (patch: Partial<SavedView>) => {
    if (view)
      void mutateUndoable(() => controller.patchViewWithUndo(view.id, patch));
  };
  const creators = documents.list().filter((kind) => kind.creation);
  const createDocument = (
    requestedName: string,
    kindId: string,
    selectedTemplateId?: string,
  ) =>
    void mutate(async () => {
      const template = model.templates.find(
        (item) => item.id === selectedTemplateId,
      );
      const creator = documents.list().find((kind) => kind.id === kindId);
      const creation = template
        ? documents.list().find((kind) => kind.id === template.kindId)?.creation
        : creator?.creation;
      if (!creation)
        throw new Error(
          'A blank-document creator is unavailable for this kind',
        );
      const name = requestedName?.trim() || 'Untitled';
      if (/[\\/]/.test(name) || ['.', '..'].includes(name))
        throw new Error('Use a document name without folders');
      const databasePath = controller.workspace.resolveResourcePath(
        controller.session.document.location.resourceId,
      );
      const folder = databasePath.includes('/')
        ? databasePath.slice(0, databasePath.lastIndexOf('/') + 1)
        : '';
      const existingPaths = new Set(
        controller.workspace
          .listDocuments()
          .map((ref) =>
            controller.workspace.resolveResourcePath(ref.location.resourceId),
          ),
      );
      let candidate = `${folder}${name}${creation.extension}`;
      let suffix = 2;
      while (existingPaths.has(candidate as ReturnType<typeof workspacePath>))
        candidate = `${folder}${name} ${suffix++}${creation.extension}`;
      const path = workspacePath(candidate);
      const ref = template
        ? await controller.createMember(template.id, path)
        : await controller.createResource({
            kindId: creator!.id,
            path,
            initialModel: creation.createInitialModel(name),
          });
      if (!activeRef.current) return;
      openResource(ref.location.resourceId);
    });
  const chooseDocument = async () => {
    const available = creators.filter((kind) => kind.id !== databaseKindId);
    const allowedKindIds: string[] = available.map((kind) => kind.id);
    const choice = await uiNewNote({
      kinds: fileExplorer?.creatableKinds().filter((kind) => allowedKindIds.includes(kind.kindId))
        ?? available.flatMap((kind) => {
          const option = noteKindOption(kind);
          return option === null ? [] : [option];
        }),
      templates: model.templates.filter((template) =>
        allowedKindIds.includes(template.kindId),
      ),
    });
    if (choice?.kind.kindId)
      createDocument(choice.name, choice.kind.kindId, choice.templateId);
  };
  const fields = (
    view?.visibleProperties ?? model.properties.map((property) => property.id)
  )
    .map((id) => model.properties.find((property) => property.id === id))
    .filter((property): property is DatabaseProperty => property !== undefined);
  const activeFilters =
    filterTarget === 'membership' && model.membership.mode === 'query'
      ? model.membership.filters
      : (view?.filters ?? []);
  const filterKind = model.properties.find(
    (item) => item.id === filterProperty,
  );
  const treeKey = `${filterTarget}:${viewId}`;
  const savedTree =
    filterTarget === 'membership' && model.membership.mode === 'query'
      ? model.membership.where
      : view?.where;
  const activeTree = treeDraft?.key === treeKey ? treeDraft.value : savedTree;
  const loadRelationChoices = (
    propertyId: string,
    search: string,
    selected: readonly ResourceId[],
    signal: AbortSignal,
  ) => {
    const property = controller.model.properties.find(
      (item) => item.id === propertyId,
    );
    if (!property) throw new Error('Property unavailable');
    return loadDatabaseRelationChoicePage(
      property,
      controller.relations?.definitions,
      controller.query,
      controller.properties.rowSource?.() ?? controller.properties.rows(),
      search,
      selected,
      signal,
    );
  };
  return (
    <section
      className={styles.database}
      aria-label={model.title}
      aria-busy={busy}
    >
      <header>
        <DocumentName
          name={model.title}
          editable={!readOnly && !busy}
          extension=".base"
          layout="database"
          onRename={renameDatabase}
        />
        <div className={styles.toolbar}>
          <nav className={styles.viewTabs} aria-label="Database views">
            {model.views.map((item) => (
              <button
                key={item.id}
                type="button"
                className={item.id === viewId ? styles.currentView : undefined}
                aria-current={item.id === viewId ? 'page' : undefined}
                title={`${item.name} · ${item.type} view`}
                onClick={() => setViewId(item.id)}
              >
                {item.name}
              </button>
            ))}
          </nav>
          {!readOnly && (
            <button
              type="button"
              className={styles.addView}
              aria-label="Add view"
              title="Add view"
              disabled={busy}
              onClick={() => {
                setViewName('New view');
                setViewType('table');
                setViewCreatorOpen(true);
              }}
            >
              <Icon name="plus" size={17} />
            </button>
          )}
          <div className={styles.toolbarRight}>
            {view && (
              <div className={styles.toolbarActions}>
                <button
                  type="button"
                  className={
                    activeFilters.length ? styles.activeAction : undefined
                  }
                  aria-label={`Filter${activeFilters.length ? `, ${activeFilters.length} active` : ''}`}
                  onClick={() => {
                    configureCloseRef.current?.cancelClose();
                    setConfigure(true);
                    setSettingsTarget('filters');
                    setPropertyOpen(false);
                    setAddExisting(false);
                  }}
                >
                  Filter
                  {activeFilters.length ? ` · ${activeFilters.length}` : ''}
                </button>
                <button
                  type="button"
                  className={
                    view.sorts?.length ? styles.activeAction : undefined
                  }
                  aria-label={`Sort${view.sorts?.length ? `, ${view.sorts.length} active` : ''}`}
                  onClick={() => {
                    configureCloseRef.current?.cancelClose();
                    setConfigure(true);
                    setSettingsTarget('view');
                    setPropertyOpen(false);
                    setAddExisting(false);
                  }}
                >
                  Sort{view.sorts?.length ? ` · ${view.sorts.length}` : ''}
                </button>
              </div>
            )}
            <div className={styles.toolbarSearch}>
              <Icon name="search" size={16} />
              <input
                type="search"
                aria-label="Search database"
                placeholder="Search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            {!readOnly && model.membership.mode === 'explicit' && (
              <button
                type="button"
                className={styles.primary}
                disabled={busy || creators.length === 0}
                onClick={() => void chooseDocument()}
              >
                New item
              </button>
            )}
            <details
              className={styles.moreMenu}
              open={moreOpen}
              onToggle={(event) => setMoreOpen(event.currentTarget.open)}
            >
              <summary
                role="button"
                aria-label="More database actions"
                aria-expanded={moreOpen}
                title="More database actions"
              >
                <Icon name="more" size={18} />
              </summary>
              <div className={styles.moreMenuItems}>
                <button
                  type="button"
                  aria-expanded={configure}
                  onClick={() => {
                    setMoreOpen(false);
                    setSettingsTarget('view');
                    if (configureCloseRef.current?.isClosing()) {
                      configureCloseRef.current.cancelClose();
                      setConfigure(true);
                    } else {
                      setConfigure(!configure);
                    }
                    setPropertyOpen(false);
                    setAddExisting(false);
                  }}
                >
                  View settings
                </button>
                {!readOnly && vault && (
                  <button
                    type="button"
                    onClick={() => {
                      setMoreOpen(false);
                      setPortableOpen(true);
                    }}
                  >
                    Portable copy
                  </button>
                )}
                {!readOnly && (
                  <button
                    type="button"
                    aria-expanded={propertyOpen}
                    onClick={() => {
                      setMoreOpen(false);
                      setPropertyOpen(!propertyOpen);
                      setConfigure(false);
                      setAddExisting(false);
                    }}
                  >
                    Add property
                  </button>
                )}
                {!readOnly && model.membership.mode === 'explicit' && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setMoreOpen(false);
                      setAddExisting(!addExisting);
                      setConfigure(false);
                      setPropertyOpen(false);
                      const titles = new Map(
                        controller.properties
                          .rows()
                          .map((row) => [row.resourceId, row.title]),
                      );
                      setAllResources(
                        controller.workspace
                          .listDocuments()
                          .filter(
                            (ref) =>
                              ref.location.resourceId !==
                                controller.session.document.location
                                  .resourceId &&
                              ref.kindId !== databaseKindId &&
                              !!documents.recognize(ref.kindId) &&
                              !(
                                controller.model.membership.mode ===
                                  'explicit' &&
                                controller.model.membership.resourceIds.includes(
                                  ref.location.resourceId,
                                )
                              ),
                          )
                          .map((ref) => {
                            const path =
                              controller.workspace.resolveResourcePath(
                                ref.location.resourceId,
                              );
                            return {
                              documentId: ref.documentId,
                              resourceId: ref.location.resourceId,
                              title:
                                titles.get(ref.location.resourceId) ??
                                path.split('/').pop() ??
                                path,
                              path,
                            };
                          }),
                      );
                    }}
                  >
                    Add existing document
                  </button>
                )}
              </div>
            </details>
          </div>
        </div>
      </header>
      {error && <p role="alert">{error}</p>}
      {undoOperation && (
        <div className={styles.undoNotice} role="status" aria-live="polite">
          <span>{undoOperation.label} complete.</span>
          <button
            type="button"
            disabled={busy || undoPending}
            onClick={() => void undoLatest()}
          >
            {undoPending ? 'Undoing…' : 'Undo'}
          </button>
        </div>
      )}
      {pendingCreated && (
        <p role="alert">
          {pendingMembershipSaved
            ? 'The document exists in this database, but its template defaults need to be saved.'
            : 'The new document exists, but is not in this database.'}{' '}
          <button
            type="button"
            onClick={() =>
              void mutate(async () => {
                if (!pendingMembershipSaved)
                  setUndoOperation(
                    await controller.addMemberWithUndo(pendingCreated),
                  );
                if (pendingTemplate)
                  await controller.applyTemplateDefaults(
                    pendingTemplate,
                    pendingCreated,
                  );
                setPendingCreated(null);
                setPendingTemplate(undefined);
                setPendingMembershipSaved(false);
              })
            }
          >
            {pendingMembershipSaved ? 'Retry defaults' : 'Retry adding it'}
          </button>{' '}
          <button type="button" onClick={() => openResource(pendingCreated)}>
            Open document
          </button>
        </p>
      )}
      {queryError && <p role="alert">Database query failed: {queryError}</p>}
      {loading && <p role="status">Loading documents…</p>}
      {viewCreatorOpen && (
        <Modal
          title="Add view"
          closeRef={viewCreatorCloseRef}
          description="Give this view a name and choose how to display its documents."
          closeLabel="Close add view"
          onClose={() => setViewCreatorOpen(false)}
        >
          <form
            className={styles.viewCreator}
            onSubmit={(event) => {
              event.preventDefault();
              if (!viewName.trim()) return;
              void mutate(async () => {
                const id = generateResourceId();
                await controller.saveView({
                  id,
                  name: viewName.trim(),
                  type: viewType,
                });
                setViewId(id);
                viewCreatorCloseRef.current?.close();
              });
            }}
          >
            <label>
              View name
              <input
                aria-label="New view name"
                value={viewName}
                onChange={(event) => setViewName(event.target.value)}
                required
                autoFocus
              />
            </label>
            <label>
              Layout
              <Select
                aria-label="New view layout"
                value={viewType}
                onChange={(event) => setViewType(event.target.value)}
              >
                {[
                  'table',
                  'board',
                  'list',
                  'gallery',
                  'calendar',
                  'timeline',
                ].map((type) => (
                  <option key={type} value={type}>
                    {type[0]!.toUpperCase() + type.slice(1)}
                  </option>
                ))}
              </Select>
            </label>
            <button
              type="submit"
              className={styles.primary}
              disabled={busy || !viewName.trim()}
            >
              Create view
            </button>
          </form>
        </Modal>
      )}
      {addExisting &&
        createPortal(
          <SwitcherOverlay
            label="Add existing document"
            placeholder="Search available documents…"
            actionVerb="add"
            emptyMessage="No available documents to add."
            listDocuments={() =>
              allResources.map(({ documentId, title, path }) => ({
                documentId,
                title,
                path,
              }))
            }
            onClose={() => setAddExisting(false)}
            onPick={(documentId) => {
              const selected = allResources.find(
                (resource) => resource.documentId === documentId,
              );
              if (selected)
                void mutateUndoable(() =>
                  controller.addMemberWithUndo(selected.resourceId),
                );
            }}
          />,
          document.body,
        )}
      {propertyOpen && !readOnly && (
        <Modal
          title="Add property"
          closeRef={propertyCreatorCloseRef}
          description="Properties become columns in this database."
          onClose={() => setPropertyOpen(false)}
        >
          <DatabasePropertyCreator
            controller={controller}
            disabled={busy}
            mutate={(operation) =>
              mutateSchema(async () => {
                await operation();
                propertyCreatorCloseRef.current?.close();
              })
            }
          />
        </Modal>
      )}
      {configure && (
        <Modal
          title="View settings"
          closeRef={configureCloseRef}
          closeLabel="Close view settings"
          onClose={() => setConfigure(false)}
          wide
        >
          <div className={styles.settings}>
            <nav className={styles.settingsNav} aria-label="Settings sections">
              <button
                type="button"
                onClick={() =>
                  viewSettingsRef.current
                    ?.closest('[role="dialog"]')
                    ?.scrollTo({ top: 0 })
                }
              >
                This view
              </button>
              <button
                type="button"
                onClick={() => jumpToSettings(sourceSettingsRef.current)}
              >
                Documents
              </button>
              <button
                type="button"
                onClick={() => jumpToSettings(filterSettingsRef.current)}
              >
                Filters
              </button>
              <button
                type="button"
                onClick={() => jumpToSettings(schemaSettingsRef.current)}
              >
                Schema and templates
              </button>
            </nav>
            <h3 className={styles.settingsGroupHeading}>Database rules</h3>
            <section ref={sourceSettingsRef} tabIndex={-1}>
              <h4>
                Documents in this database ·{' '}
                {model.membership.mode === 'explicit' ? 'Manual' : 'Smart'}
              </h4>
              <p>
                {model.membership.mode === 'explicit'
                  ? 'Documents are added and removed manually.'
                  : 'Documents follow the collection rules. Removing a matching document requires changing the rule.'}
              </p>
              {!readOnly && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void mutate(async () => {
                      if (model.membership.mode === 'explicit') {
                        if (
                          !window.confirm(
                            'Switch to a smart collection? An empty source rule includes every document in this workspace. Your existing documents remain intact.',
                          )
                        )
                          return;
                        await controller.saveMembership({
                          mode: 'query',
                          filters: [],
                        });
                      } else {
                        const allMatching = await controller.query.execute(
                          controller.model,
                          {
                            id: 'conversion-preview',
                            name: 'All matching documents',
                            type: 'table',
                          },
                          await controller.properties.rows(),
                          '',
                          { evaluation: captureDatabaseEvaluationContext() },
                        );
                        if (
                          !window.confirm(
                            `Switch to a manual collection with ${allMatching.length} matching documents? Search and saved-view filters are excluded. No documents will be deleted.`,
                          )
                        )
                          return;
                        await controller.saveMembership({
                          mode: 'explicit',
                          resourceIds: allMatching.map((row) => row.resourceId),
                        });
                      }
                    })
                  }
                >
                  Convert to{' '}
                  {model.membership.mode === 'explicit' ? 'smart' : 'manual'}{' '}
                  collection…
                </button>
              )}
            </section>
            <section
              ref={filterSettingsRef}
              tabIndex={-1}
              className={styles.settingsDisclosure}
            >
              <h4>
                Filters ·{' '}
                {(view?.filters?.length ?? 0) +
                  (model.membership.mode === 'query'
                    ? model.membership.filters.length
                    : 0)}
              </h4>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const property = model.properties.find(
                    (item) => item.id === filterProperty,
                  );
                  if (!operatorsFor(property).includes(filterOperator)) {
                    setError('Choose an operator supported by this property');
                    return;
                  }
                  if (filterOperator !== 'empty' && filterValue === '') {
                    setError('Choose a filter value');
                    return;
                  }
                  const value =
                    property?.type === 'number'
                      ? Number(filterValue)
                      : property?.type === 'boolean'
                        ? filterValue !== 'false'
                        : filterValue;
                  const filter: DatabaseFilter = {
                    property: filterProperty,
                    operator: filterOperator,
                    ...(filterOperator === 'empty' ? {} : { value }),
                  };
                  const next =
                    editingFilterIndex === null
                      ? [...activeFilters, filter]
                      : activeFilters.map((existing, index) =>
                          index === editingFilterIndex ? filter : existing,
                        );
                  if (
                    filterTarget === 'membership' &&
                    model.membership.mode === 'query'
                  )
                    void mutate(() =>
                      controller.saveMembership({
                        mode: 'query',
                        filters: next,
                        where:
                          model.membership.mode === 'query'
                            ? model.membership.where
                            : undefined,
                      }),
                    );
                  else if (view) saveView({ filters: next });
                  setEditingFilterIndex(null);
                }}
              >
                <label>
                  Filter scope{' '}
                  <Select
                    value={filterTarget}
                    disabled={readOnly || busy}
                    onChange={(event) => {
                      setFilterTarget(event.target.value);
                      setEditingFilterIndex(null);
                    }}
                  >
                    <option value="view">This view</option>
                    {model.membership.mode === 'query' && (
                      <option value="membership">Collection membership</option>
                    )}
                  </Select>
                </label>
                <label>
                  Filter property{' '}
                  <Select
                    value={filterProperty}
                    onChange={(event) => {
                      const selected = model.properties.find(
                        (item) => item.id === event.target.value,
                      );
                      setFilterProperty(event.target.value);
                      setFilterOperator(operatorsFor(selected)[0]!);
                      setFilterValue('');
                    }}
                  >
                    <option value="$title">Document title</option>
                    <option value="$kind">Document kind</option>
                    <option value="$path">Document path</option>
                    {model.properties.map((property) => (
                      <option key={property.id} value={property.id}>
                        {property.name}
                      </option>
                    ))}
                  </Select>
                </label>
                <label>
                  Operator{' '}
                  <Select
                    value={filterOperator}
                    onChange={(event) =>
                      setFilterOperator(
                        event.target.value as DatabaseFilter['operator'],
                      )
                    }
                  >
                    {!operatorsFor(filterKind).includes(filterOperator) && (
                      <option value={filterOperator} disabled>
                        Unsupported operator
                      </option>
                    )}
                    {operatorsFor(filterKind).map((operator) => (
                      <option key={operator} value={operator}>
                        {
                          (
                            {
                              eq: 'Is',
                              neq: 'Is not',
                              contains: 'Contains',
                              gt: 'Greater than',
                              lt: 'Less than',
                              empty: 'Is empty',
                              'date-relative': 'Relative date',
                            } as const
                          )[operator]
                        }
                      </option>
                    ))}
                  </Select>
                </label>
                {filterOperator !== 'empty' && (
                  <label>
                    Value{' '}
                    {filterOperator === 'date-relative' ? (
                      <Select
                        value={filterValue}
                        onChange={(event) => setFilterValue(event.target.value)}
                      >
                        <option value="">Choose period</option>
                        <option value="today">Today</option>
                        <option value="yesterday">Yesterday</option>
                        <option value="tomorrow">Tomorrow</option>
                        <option value="past-7-days">Past 7 days</option>
                        <option value="next-7-days">Next 7 days</option>
                      </Select>
                    ) : filterKind?.type === 'boolean' ? (
                      <Select
                        value={filterValue}
                        onChange={(event) => setFilterValue(event.target.value)}
                      >
                        <option value="true">Yes</option>
                        <option value="false">No</option>
                      </Select>
                    ) : ['select', 'multi-select'].includes(
                        filterKind?.type ?? '',
                      ) ? (
                      <Select
                        value={filterValue}
                        onChange={(event) => setFilterValue(event.target.value)}
                      >
                        <option value="">Choose option</option>
                        {filterKind?.options?.map((option) => (
                          <option key={option.id} value={option.id}>
                            {option.name}
                          </option>
                        ))}
                      </Select>
                    ) : filterKind?.type === 'relation' ? (
                      <Select
                        value={filterValue}
                        onChange={(event) => setFilterValue(event.target.value)}
                      >
                        <option value="">Choose document</option>
                        {relationChoices[filterKind.id]?.map((choice) => (
                          <option key={choice.id} value={choice.id}>
                            {choice.title}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <input
                        type={
                          filterKind?.type === 'number'
                            ? 'number'
                            : filterKind?.type === 'date'
                              ? 'date'
                              : 'text'
                        }
                        value={filterValue}
                        onChange={(event) => setFilterValue(event.target.value)}
                      />
                    )}
                  </label>
                )}
                <button disabled={readOnly || busy}>
                  {editingFilterIndex === null ? 'Add filter' : 'Save filter'}
                </button>
                {activeFilters.map((filter, index) => (
                  <span key={`${filter.property}-${index}`}>
                    {model.properties.find(
                      (item) => item.id === filter.property,
                    )?.name ?? filter.property}{' '}
                    {filter.operator} {String(filter.value ?? '')}{' '}
                    <button
                      type="button"
                      aria-label={`Edit filter ${index + 1}`}
                      disabled={readOnly || busy}
                      onClick={() => {
                        setEditingFilterIndex(index);
                        setFilterProperty(filter.property);
                        setFilterOperator(filter.operator);
                        setFilterValue(String(filter.value ?? ''));
                      }}
                    >
                      Edit
                    </button>{' '}
                    <button
                      type="button"
                      aria-label={`Remove filter ${index + 1}`}
                      disabled={readOnly || busy}
                      onClick={() => {
                        const next = activeFilters.filter(
                          (_, itemIndex) => itemIndex !== index,
                        );
                        if (
                          filterTarget === 'membership' &&
                          model.membership.mode === 'query'
                        )
                          void mutate(() =>
                            controller.saveMembership({
                              mode: 'query',
                              filters: next,
                              where:
                                model.membership.mode === 'query'
                                  ? model.membership.where
                                  : undefined,
                            }),
                          );
                        else saveView({ filters: next });
                        setEditingFilterIndex(null);
                      }}
                    >
                      Remove
                    </button>
                  </span>
                ))}
                <button
                  type="button"
                  disabled={readOnly || busy}
                  onClick={() => {
                    setEditingFilterIndex(null);
                    if (
                      filterTarget === 'membership' &&
                      model.membership.mode === 'query'
                    )
                      void mutate(() =>
                        controller.saveMembership({
                          mode: 'query',
                          filters: [],
                          where:
                            model.membership.mode === 'query'
                              ? model.membership.where
                              : undefined,
                        }),
                      );
                    else saveView({ filters: [] });
                  }}
                >
                  Clear filters
                </button>
              </form>
              <DatabaseFilterTreeEditor
                value={activeTree}
                properties={model.properties}
                choices={relationChoices}
                disabled={readOnly || busy}
                onChange={(value) => setTreeDraft({ key: treeKey, value })}
              />
              {treeDraft?.key === treeKey && (
                <div>
                  <button
                    type="button"
                    disabled={readOnly || busy}
                    onClick={() => {
                      void mutate(async () => {
                        if (
                          filterTarget === 'membership' &&
                          model.membership.mode === 'query'
                        )
                          await controller.saveMembership({
                            mode: 'query',
                            filters: model.membership.filters,
                            where: treeDraft.value,
                          });
                        else if (view)
                          await controller.patchView(view.id, {
                            where: treeDraft.value,
                          });
                        setTreeDraft(null);
                      });
                    }}
                  >
                    Save condition groups
                  </button>
                  <button type="button" onClick={() => setTreeDraft(null)}>
                    Discard changes
                  </button>
                </div>
              )}
            </section>
            <div
              ref={viewSettingsRef}
              tabIndex={-1}
              className={styles.viewSettings}
            >
              <div className={styles.viewSettingsHeading}>
                <h3>This view</h3>
                <p>
                  Name, layout and display options for “
                  {view?.name ?? 'this view'}”.
                </p>
              </div>
              {view && (
                <>
                  <label>
                    View name{' '}
                    <input
                      key={view.id}
                      defaultValue={view.name}
                      disabled={readOnly || busy}
                      onBlur={(event) => {
                        if (event.target.value !== view.name)
                          saveView({ name: event.target.value });
                      }}
                    />
                  </label>
                  <label>
                    Layout{' '}
                    <Select
                      value={view.type}
                      disabled={readOnly || busy}
                      onChange={(event) =>
                        saveView({ type: event.target.value })
                      }
                    >
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
                    </Select>
                  </label>
                  <label>
                    Group by{' '}
                    <Select
                      value={view.groupBy ?? ''}
                      disabled={readOnly || busy}
                      onChange={(event) =>
                        saveView({ groupBy: event.target.value })
                      }
                    >
                      <option value="">No grouping</option>
                      {model.properties.map((property) => (
                        <option key={property.id} value={property.id}>
                          {property.name}
                        </option>
                      ))}
                    </Select>
                  </label>
                  <section className={styles.viewOptions}>
                    <h4>
                      Sort order
                      {view.sorts?.length ? ` · ${view.sorts.length}` : ''}
                    </h4>
                    <fieldset>
                      <legend className={styles.srOnly}>Sort order</legend>
                      <p className={styles.settingsHint}>
                        Choose which documents appear first.
                      </p>
                      {(view.sorts ?? []).map((sort, index) => (
                        <div key={index} className={styles.sortRow}>
                          <label>
                            Sort {index + 1}{' '}
                            <Select
                              value={sort.property}
                              disabled={readOnly || busy}
                              onChange={(event) =>
                                saveView({
                                  sorts: view.sorts?.map((item, itemIndex) =>
                                    itemIndex === index
                                      ? {
                                          ...item,
                                          property: event.target.value,
                                        }
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
                            </Select>
                          </label>
                          <label>
                            <Checkbox
                              checked={sort.descending ?? false}
                              disabled={readOnly || busy}
                              onChange={(event) =>
                                saveView({
                                  sorts: view.sorts?.map((item, itemIndex) =>
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
                              saveView({
                                sorts: view.sorts?.filter(
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
                          saveView({
                            sorts: [
                              ...(view.sorts ?? []),
                              { property: '$title', descending: false },
                            ],
                          })
                        }
                      >
                        Add sort
                      </button>
                    </fieldset>
                  </section>
                  {(view.type === 'calendar' ||
                    view.type === 'timeline' ||
                    model.properties.some((property) =>
                      ['date', 'formula', 'rollup'].includes(property.type),
                    )) && (
                    <label>
                      Date property{' '}
                      <Select
                        value={view.dateProperty ?? ''}
                        disabled={readOnly || busy}
                        onChange={(event) =>
                          saveView({ dateProperty: event.target.value })
                        }
                      >
                        <option value="">Choose a property</option>
                        {model.properties
                          .filter((property) =>
                            ['date', 'formula', 'rollup'].includes(
                              property.type,
                            ),
                          )
                          .map((property) => (
                            <option key={property.id} value={property.id}>
                              {property.name}
                            </option>
                          ))}
                      </Select>
                    </label>
                  )}
                  {model.properties.length > 0 && (
                    <section className={styles.viewOptions}>
                      <h4>Visible properties</h4>
                      <fieldset>
                        <legend className={styles.srOnly}>
                          Visible properties
                        </legend>
                        {model.properties.length === 0 && (
                          <p className={styles.settingsHint}>
                            No properties yet. Add one under Schema and
                            templates.
                          </p>
                        )}
                        {model.properties.map((property) => (
                          <label key={property.id}>
                            <Checkbox
                              disabled={readOnly || busy}
                              checked={fields.some(
                                (field) => field.id === property.id,
                              )}
                              onChange={(event) =>
                                saveView({
                                  visibleProperties: event.target.checked
                                    ? [
                                        ...fields.map((field) => field.id),
                                        property.id,
                                      ]
                                    : fields
                                        .filter(
                                          (field) => field.id !== property.id,
                                        )
                                        .map((field) => field.id),
                                })
                              }
                            />
                            {property.name}
                          </label>
                        ))}
                      </fieldset>
                    </section>
                  )}
                  <div className={styles.viewActions}>
                    <button
                      disabled={readOnly || busy}
                      onClick={() =>
                        void mutate(async () =>
                          setViewId(await controller.duplicateView(view.id)),
                        )
                      }
                    >
                      Duplicate view
                    </button>
                    <button
                      disabled={readOnly || busy}
                      onClick={() =>
                        void mutate(() => controller.deleteView(view.id))
                      }
                    >
                      Delete view
                    </button>
                  </div>
                </>
              )}
            </div>
            <section
              ref={schemaSettingsRef}
              tabIndex={-1}
              className={styles.settingsDisclosure}
            >
              <h4>Schema and templates</h4>
              {model.properties.map((property) => (
                <div key={property.id}>
                  <label>
                    Property name{' '}
                    <input
                      defaultValue={property.name}
                      disabled={readOnly || busy}
                      onBlur={(event) => {
                        if (event.target.value !== property.name)
                          void mutateUndoable(() =>
                            controller.savePropertyWithUndo({
                              ...property,
                              name: event.target.value,
                            }),
                          );
                      }}
                    />
                    {property.type}
                  </label>
                  <button
                    type="button"
                    disabled={readOnly || busy}
                    aria-label={`Remove ${property.name} property`}
                    onClick={() => {
                      if (
                        !window.confirm(
                          `Remove “${property.name}” from this database? Stored document values remain recoverable. References in rules, views, formulas, rollups, and templates must be removed first.`,
                        )
                      )
                        return;
                      void mutateUndoable(() =>
                        controller.removePropertyWithUndo(property.id),
                      );
                    }}
                  >
                    Remove property
                  </button>
                </div>
              ))}
              {model.properties
                .filter((property) =>
                  ['select', 'multi-select'].includes(property.type),
                )
                .map((property) => (
                  <DatabaseOptions
                    key={property.id}
                    property={property}
                    disabled={readOnly || busy}
                    save={(next) =>
                      void mutateUndoable(() =>
                        controller.savePropertyWithUndo(next),
                      )
                    }
                  />
                ))}
              {!readOnly && (
                <>
                  {model.properties.map((property) => (
                    <button
                      key={property.id}
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setConfigure(false);
                        setEditingPropertyId(property.id);
                      }}
                    >
                      Edit {property.name}
                    </button>
                  ))}
                  <DatabasePropertyCreator
                    controller={controller}
                    disabled={busy}
                    mutate={mutateSchema}
                  />
                </>
              )}
              {!readOnly && (
                <DatabaseTemplateCreator
                  controller={controller}
                  documents={documents}
                  editors={editors}
                  relationChoices={relationChoices}
                  loadRelationChoices={loadRelationChoices}
                  disabled={busy}
                  mutate={mutate}
                />
              )}
            </section>
          </div>
        </Modal>
      )}
      {portableOpen && vault && (
        <Modal
          title="Portable copy"
          description="Export or import this database and its document dependencies."
          onClose={() => setPortableOpen(false)}
          wide
        >
          <DatabasePortableActions
            controller={controller}
            documents={documents}
            vault={vault}
            disabled={busy}
            openResource={openResource}
          />
        </Modal>
      )}
      {editingProperty && (
        <Modal
          title={`Edit ${editingProperty.name}`}
          closeRef={propertyEditorCloseRef}
          onClose={() => setEditingPropertyId(null)}
        >
          <DatabasePropertyCreator
            controller={controller}
            existing={editingProperty}
            disabled={busy}
            mutate={(operation) =>
              mutateSchema(async () => {
                await operation();
                propertyEditorCloseRef.current?.close();
              })
            }
          />
        </Modal>
      )}
      <DatabaseContent
        catalog={controller.properties.catalog}
        relationChoices={relationChoices}
        loadRelationChoices={loadRelationChoices}
        canonicalValues={
          new Map(
            controller.properties
              .rows()
              .map((row) => [row.resourceId, row.values] as const),
          )
        }
        model={model}
        view={view}
        rows={queryError || rowsViewId !== viewId ? [] : rows}
        readOnly={readOnly}
        write={write}
        writeCell={async (id, propertyId, value, expectedValue) => {
          setPending((count) => count + 1);
          setError('');
          try {
            const operation = await controller.writeWithUndo(
              id,
              propertyId,
              value,
              expectedValue,
            );
            setUndoOperation(operation);
            refresh((current) => current + 1);
          } catch (failure) {
            setError(
              failure instanceof Error ? failure.message : String(failure),
            );
            throw failure;
          } finally {
            setPending((count) => count - 1);
          }
        }}
        openResource={openResource}
        openBesideResource={(id) => openResource(id, 'beside')}
        previews={previews}
        previewTarget={previewTarget}
        onAddProperty={() => setPropertyOpen(true)}
        bulkDisabled={busy}
        onBulkWrite={
          readOnly
            ? undefined
            : async (propertyId, value, targets) => {
                setPending((count) => count + 1);
                setError('');
                setUndoOperation(null);
                try {
                  const result = await controller.bulkWriteWithUndo(
                    propertyId,
                    value,
                    targets,
                  );
                  refresh((current) => current + 1);
                  return result;
                } catch (failure) {
                  setError(
                    failure instanceof Error
                      ? failure.message
                      : String(failure),
                  );
                  throw failure;
                } finally {
                  setPending((count) => count - 1);
                }
              }
        }
        runBulkOperation={async (operation) => {
          setPending((count) => count + 1);
          setError('');
          try {
            const result = await operation();
            refresh((current) => current + 1);
            return result;
          } catch (failure) {
            setError(
              failure instanceof Error ? failure.message : String(failure),
            );
            throw failure;
          } finally {
            setPending((count) => count - 1);
          }
        }}
        onViewPatch={readOnly ? undefined : saveView}
        onColumnWidth={
          readOnly || !view
            ? undefined
            : (id, width) =>
                void mutateUndoable(() =>
                  controller.setColumnWidthWithUndo(view.id, id, width),
                )
        }
        onNew={
          model.membership.mode === 'explicit'
            ? () => void chooseDocument()
            : undefined
        }
        onRemove={
          !readOnly && model.membership.mode === 'explicit'
            ? (id) =>
                void mutateUndoable(() => controller.removeMemberWithUndo(id))
            : undefined
        }
        onEditTitle={
          readOnly
            ? undefined
            : async (id, title) => {
                const ref = documentRefs.get(id);
                if (!ref) throw new Error('Document unavailable');
                const result = await updateDocumentTitle({
                  workspace: controller.workspace,
                  documents,
                  documentId: ref.documentId,
                  title,
                });
                if (result.committed) refresh((value) => value + 1);
                return result;
              }
        }
        titleEditUnavailable={(id) => {
          const ref = documentRefs.get(id);
          if (!ref) return 'Document unavailable.';
          const kind = documents.get(ref.kindId);
          if (!kind.documentTitle)
            return 'This document type does not support title editing.';
          const open = controller.workspace.getOpenDocument(ref.documentId);
          if (!open) return undefined;
          return open.dirty
            ? 'Save and close this document before changing its title.'
            : 'Close this document before changing its title.';
        }}
        onRename={
          readOnly || (!fileExplorer && !moveDocument)
            ? undefined
            : async (id, title, expectedPath) => {
                setPending((count) => count + 1);
                setError('');
                try {
                  const ref = controller.workspace
                    .listDocuments()
                    .find((item) => item.location.resourceId === id);
                  if (!ref) throw new Error('Document unavailable');
                  const current = controller.workspace.resolveResourcePath(id);
                  if (current !== expectedPath)
                    throw new Error(
                      'Document was renamed elsewhere. Refresh and retry.',
                    );
                  const filename = pathName(current);
                  if (!filename) throw new Error('Document path unavailable');
                  const dot = filename.lastIndexOf('.');
                  const extension = dot > 0 ? filename.slice(dot) : '';
                  const trimmed = title.trim();
                  const stem =
                    extension && trimmed.endsWith(extension)
                      ? trimmed.slice(0, -extension.length)
                      : trimmed;
                  if (!isValidSegment(stem))
                    throw new Error(
                      'Enter a valid document name without a path.',
                    );
                  const next = joinPath(
                    parentPath(current),
                    `${stem}${extension}`,
                  );
                  if (next !== current) {
                    if (
                      controller.workspace
                        .listDocuments()
                        .some(
                          (item) =>
                            controller.workspace.resolveResourcePath(
                              item.location.resourceId,
                            ) === next,
                        )
                    )
                      throw new Error(
                        'A document with this name already exists.',
                      );
                    if (moveDocument) {
                      await moveDocument(String(ref.documentId), next);
                      fileExplorer?.refresh();
                    } else
                      await fileExplorer!.moveDocument(
                        String(ref.documentId),
                        next,
                      );
                  }
                  refresh((value) => value + 1);
                } catch (failure) {
                  setError(
                    failure instanceof Error
                      ? failure.message
                      : String(failure),
                  );
                  throw failure;
                } finally {
                  setPending((count) => count - 1);
                }
              }
        }
        emptyReason={
          loading
            ? 'Loading documents…'
            : queryError
              ? 'The database query failed. Retry after checking the source.'
              : search
                ? 'No documents match this search.'
                : view?.filters?.length || model.membership.mode === 'query'
                  ? 'No documents match these rules.'
                  : 'No documents yet. Create one to start this collection.'
        }
      />
      {!loading &&
        !queryError &&
        rows.length === 0 &&
        (search || (view?.filters?.length ?? 0) > 0) && (
          <div className={styles.toolbar}>
            {search && (
              <button type="button" onClick={() => setSearch('')}>
                Clear search
              </button>
            )}
            {(view?.filters?.length ?? 0) > 0 && !readOnly && (
              <button type="button" onClick={() => saveView({ filters: [] })}>
                Clear view filters
              </button>
            )}
          </div>
        )}
      <footer>
        {rows.length} resources
        {model.properties
          .filter((property) => property.type === 'number')
          .map((property) => {
            let sum: PropertyValue = null;
            try {
              sum = aggregate(
                rows.map((row) => row.values[property.id] ?? null),
                'sum',
              );
            } catch {
              /* Diagnostics are shown on individual cells. */
            }
            return (
              <span key={property.id}>
                {' '}
                · {property.name}: {String(sum ?? '—')} total
              </span>
            );
          })}
      </footer>
    </section>
  );
}

export function createDatabaseEditorProvider(options: {
  workspace(): WorkspaceService | null;
  properties(): ResourcePropertyService | null;
  query(): DatabaseQueryProvider | null;
  documents(): DocumentRegistry | null;
  editors?(): DocumentEditorRegistry | null;
  vault?(): VaultService | null;
  previews?(): CompositionRegistry | null;
  fileExplorer?(): FileExplorerService | null;
  moveDocument?(documentId: string, toPath: string): Promise<void>;
  relations?: DatabaseRelationContext;
  openResource(id: ResourceId, disposition?: 'beside'): void;
}): DocumentEditorProvider {
  return {
    id: 'froglight.database.react',
    kindIds: [databaseKindId],
    createEditor({ session, parent }) {
      const workspace = options.workspace();
      const properties = options.properties();
      const query = options.query();
      const documents = options.documents();
      const editors = options.editors?.() ?? unavailableTemplateEditors;
      if (
        !(parent instanceof HTMLElement) ||
        !workspace ||
        !properties ||
        !query ||
        !documents
      )
        throw new Error('Database workspace or host unavailable');
      const controller = new DatabaseController(
        session as DocumentSession<DatabaseModel>,
        workspace,
        properties,
        query,
        options.relations,
      );
      // Validate the provider's model boundary before creating its visible root.
      if (controller.model.views.length)
        resolveDatabaseView(controller.model, controller.model.views[0]!.id);
      const root = mountIsolatedReactRoot(
        parent,
        <DatabaseView
          controller={controller}
          documents={documents}
          editors={editors}
          previews={options.previews?.() ?? undefined}
          vault={options.vault?.() ?? undefined}
          fileExplorer={options.fileExplorer?.() ?? null}
          moveDocument={options.moveDocument}
          openResource={options.openResource}
        />,
      );
      return {
        focus: () => parent.querySelector<HTMLElement>('select')?.focus(),
        hasFocus: () => parent.contains(document.activeElement),
        execCommand: () => false,
        setReadOnly: (readOnly) =>
          root.render(
            <DatabaseView
              controller={controller}
              documents={documents}
              editors={editors}
              previews={options.previews?.() ?? undefined}
              vault={options.vault?.() ?? undefined}
              fileExplorer={options.fileExplorer?.() ?? null}
              moveDocument={options.moveDocument}
              openResource={options.openResource}
              readOnly={readOnly}
            />,
          ),
        destroy: () => root.dispose(),
      };
    },
  };
}

/** The activation owns both registration and mounted consumers of its services. */
export function createDatabaseEditorPlugin(
  openResource: (id: ResourceId, disposition?: 'beside') => void,
  moveDocument?: (documentId: string, toPath: string) => Promise<void>,
) {
  return definePlugin({
    id: 'froglight.database.react',
    requirements: {
      requires: [
        workspaceToken,
        resourcePropertiesToken,
        databaseQueryToken,
        documentEditorRegistryToken,
        documentRegistryToken,
        databaseDefinitionsToken,
        relationshipsToken,
      ],
      optionallyRequires: [
        compositionRegistryToken,
        vaultToken,
        fileExplorerToken,
      ],
    },
    activate(ctx) {
      const workspace = ctx.require(workspaceToken);
      const properties = ctx.require(resourcePropertiesToken);
      const query = ctx.require(databaseQueryToken);
      const provider = createDatabaseEditorProvider({
        workspace: () => workspace,
        properties: () => properties,
        query: () => query,
        documents: () => ctx.require(documentRegistryToken),
        editors: () => ctx.require(documentEditorRegistryToken),
        vault: () => ctx.try(vaultToken) ?? null,
        previews: () => ctx.try(compositionRegistryToken) ?? null,
        fileExplorer: () => ctx.try(fileExplorerToken) ?? null,
        relations: {
          definitions: ctx.require(databaseDefinitionsToken),
          relationships: ctx.require(relationshipsToken),
        },
        openResource,
        moveDocument,
      });
      const handles = new Set<DocumentEditorHandle>();
      ctx.effect(() => {
        const registration = ctx.require(documentEditorRegistryToken).register({
          ...provider,
          createEditor(input) {
            const inner = provider.createEditor(input);
            const handle: DocumentEditorHandle = {
              ...inner,
              destroy() {
                if (!handles.delete(handle)) return;
                inner.destroy();
              },
            };
            handles.add(handle);
            return handle;
          },
        });
        return () => {
          registration.dispose();
          for (const handle of handles) handle.destroy();
        };
      });
    },
  });
}
