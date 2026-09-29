import type { DatabaseDefinitions } from './definitions.js';
import {
  databaseRelationChoiceIncludes,
  databaseRelationChoices,
  type DatabaseRelationContext,
} from './relations.js';
import type {
  CompositionProviderRegistration,
  CompositionSnapshot,
} from '../composition.js';
import { resourceId } from '../identity.js';
import type { JsonRecord } from '../blocks/model.js';
import type { ResourceTarget } from '../blocks/model.js';
import type { WorkspaceService } from '../workspace.js';
import { databaseKindId } from './kind.js';
import type { DatabaseView, PropertyValue } from './model.js';
import {
  captureDatabaseEvaluationContext,
  nextDatabaseDayBoundary,
  resolveDatabaseView,
  type DatabaseQueryProvider,
} from './query.js';
import type { ResourcePropertyService } from '../resource-properties/contract.js';
import { writeDatabaseProperty } from './controller.js';

const browser = globalThis as unknown as {
  document?: {
    visibilityState: string;
    addEventListener(type: string, listener: () => void): void;
    removeEventListener(type: string, listener: () => void): void;
  };
  setTimeout(callback: () => void, delay: number): number;
  clearTimeout(id: number): void;
};

export function createDatabaseCompositionProvider(options: {
  role?: 'linked-view' | 'preview';
  definitions: DatabaseDefinitions;
  workspace(): WorkspaceService | null;
  properties(): ResourcePropertyService | null;
  query(): DatabaseQueryProvider | null;
  relations?: DatabaseRelationContext;
  openSource(target: ResourceTarget): void;
}): CompositionProviderRegistration {
  const role = options.role ?? 'linked-view';
  return {
    kindId: databaseKindId,
    roles: [role],
    writeAuthority: role === 'preview' ? 'none' : 'source',
    open(input) {
      let snapshot: CompositionSnapshot = { state: 'loading' };
      let disposed = false;
      let generation = 0;
      let pending: AbortController | undefined;
      let dayTimer: number | undefined;
      const listeners = new Set<() => void>();
      const workspace = options.workspace();
      const properties = options.properties();
      const query = options.query();
      const update = async () => {
        pending?.abort();
        const abort = new AbortController();
        pending = abort;
        const current = ++generation;
        if (dayTimer !== undefined) browser.clearTimeout(dayTimer);
        dayTimer = undefined;
        const evaluation = captureDatabaseEvaluationContext();
        if (browser.document)
          dayTimer = browser.setTimeout(
            () => {
              if (!disposed) void update();
            },
            Math.max(
              1,
              nextDatabaseDayBoundary(evaluation) - evaluation.nowMillis,
            ),
          );
        let next: CompositionSnapshot;
        try {
          if (!workspace || !properties || !query)
            throw new Error('Database capabilities unavailable');
          const model = options.definitions.get(
            resourceId(input.target.resourceId),
          );
          const ref = workspace
            .listDocuments()
            .find((ref) => ref.documentId === input.target.documentId);
          if (!model || !ref) throw new Error('Database source unavailable');
          const read = { model, ref };
          const propertyEditors = Object.fromEntries(
            read.model.properties.flatMap((property) => {
              const type = properties.catalog.get(property.type);
              return type
                ? [
                    [
                      property.id,
                      {
                        editor: type.editor,
                        writable:
                          properties.catalog.writeReason(property) === null,
                      },
                    ],
                  ]
                : [];
            }),
          );
          if (
            read.ref.kindId !== databaseKindId ||
            read.ref.location.resourceId !== input.target.resourceId
          )
            throw new Error('Database target mismatch');
          const source = read.model.views.find(
            (view) => view.id === input.viewId,
          ) ?? (role === 'preview' && !input.viewId ? read.model.views[0] : undefined);
          if (!source) {
            next = {
              state: 'placeholder',
              reason: 'missing-view',
              recoverable: true,
              message:
                'This saved view is unavailable. Choose a saved view to rebind this block.',
              presentation: {
                type: 'froglight.database',
                data: {
                  model: read.model,
                  viewId: input.viewId ?? '',
                  overrides: input.overrides ?? {},
                  rows: [],
                  propertyEditors,
                  previewOnly: role === 'preview',
                } as unknown as JsonRecord,
              },
              actions: [
                {
                  id: 'open-source',
                  label: 'Open database',
                  authority: 'none',
                },
              ],
            };
          } else {
            const view = resolveDatabaseView(
              read.model,
              source.id,
              input.overrides as Partial<DatabaseView>,
            );
            const rows = await query.execute(
              read.model,
              view,
              properties.rowSource?.() ?? properties.rows(),
              '',
              { evaluation, signal: abort.signal },
            );
            const relationChoices = await databaseRelationChoices(
              read.model,
              query,
              properties.rowSource?.() ?? properties.rows(),
              options.relations?.definitions,
              {
                signal: abort.signal,
                include: databaseRelationChoiceIncludes(read.model, rows),
                evaluation,
              },
            );
            next = {
              state: 'ready',
              title: read.model.title,
              presentation: {
                type: 'froglight.database',
                data: {
                  model: read.model,
                  view,
                  viewId: source.id,
                  overrides: input.overrides ?? {},
                  rows,
                  relationChoices,
                  propertyEditors,
                  previewOnly: role === 'preview',
                } as unknown as JsonRecord,
              },
              actions: [
                {
                  id: 'open-source',
                  label: 'Open database',
                  authority: 'none',
                },
                {
                  id: 'open-member',
                  label: 'Open resource',
                  authority: 'none',
                },
                ...(role === 'linked-view' ? [{
                  id: 'write-property',
                  label: 'Edit source property',
                  authority: 'source' as const,
                }] : []),
              ],
            };
          }
        } catch (error) {
          if (abort.signal.aborted) return;
          next = {
            state: 'placeholder',
            reason: 'missing-target',
            recoverable: true,
            message: error instanceof Error ? error.message : String(error),
          };
        }
        if (disposed || current !== generation) return;
        if (pending === abort) pending = undefined;
        snapshot = next;
        for (const listener of listeners) listener();
      };
      const commits = workspace?.onDidCommit(() => {
        void update();
      });
      const propertyChanges = properties?.onDidChange(() => {
        void update();
      });
      const catalogChanges = properties?.catalog.onDidChange(() => {
        void update();
      });
      const onVisible = () => {
        if (browser.document?.visibilityState === 'visible') void update();
      };
      browser.document?.addEventListener('visibilitychange', onVisible);
      void update();
      return {
        snapshot: () => snapshot,
        onDidChange(listener) {
          listeners.add(listener);
          return {
            dispose: () => {
              listeners.delete(listener);
            },
          };
        },
        async invoke(action, value) {
          if (disposed) throw new Error('Linked view disposed');
          if (action === 'open-source') {
            options.openSource(input.target);
            return;
          }
          if (
            action === 'open-member' &&
            workspace &&
            typeof value?.resourceId === 'string'
          ) {
            const ref = workspace
              .listDocuments()
              .find((ref) => ref.location.resourceId === value.resourceId);
            if (!ref) throw new Error('Resource unavailable');
            options.openSource({
              documentId: ref.documentId,
              kindId: ref.kindId,
              resourceId: ref.location.resourceId,
            });
            return;
          }
          if (
            role !== 'linked-view' ||
            action !== 'write-property' ||
            !workspace ||
            !properties ||
            !query ||
            typeof value?.resourceId !== 'string' ||
            typeof value.propertyId !== 'string'
          )
            throw new Error('Invalid database action');
          // Recheck the saved ViewId before every write. Deleted views cannot
          // retain stale write authority through an already rendered handle.
          const model = options.definitions.get(
            resourceId(input.target.resourceId),
          );
          const ref = workspace
            .listDocuments()
            .find((ref) => ref.documentId === input.target.documentId);
          if (!model || !ref) throw new Error('Database source unavailable');
          const read = { model, ref };
          resolveDatabaseView(read.model, input.viewId ?? '');
          await writeDatabaseProperty(
            read.model,
            workspace,
            properties,
            query,
            resourceId(value.resourceId),
            value.propertyId,
            (value.value ?? null) as PropertyValue,
            options.relations,
            value.expectedValue as PropertyValue | undefined,
          );
          await update();
        },
        dispose() {
          disposed = true;
          pending?.abort();
          if (dayTimer !== undefined) browser.clearTimeout(dayTimer);
          browser.document?.removeEventListener('visibilitychange', onVisible);
          generation++;
          commits?.dispose();
          propertyChanges?.dispose();
          catalogChanges?.dispose();
          listeners.clear();
        },
      };
    },
  };
}
