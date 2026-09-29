import { createElement } from 'react';
import { createServiceToken, definePlugin } from '@froglight/runtime';
import {
  documentRegistryToken,
  documentPresentationToken,
  relationshipsToken,
  workspaceToken,
  type WorkspaceService,
} from '@froglight/foundation';
import { viewRegistryToken } from './view-registry.js';
import { type ForceGraphNode } from './graph-force.js';
import {
  localConnectionProjection,
  projectConnections,
  type ConnectionOccurrence,
  type ConnectionProjection,
} from './connection-projection.js';
import {
  rightSidebarRegistryToken,
  type RightSidebarContext,
} from './right-sidebar-registry.js';
import { GraphView } from './react/index.js';

export interface GraphDataEdge {
  readonly source: string;
  readonly target: string;
  readonly occurrences?: readonly ConnectionOccurrence[];
  readonly forwardCount?: number;
  readonly reverseCount?: number;
}

export interface GraphData {
  readonly nodes: readonly ForceGraphNode[];
  readonly edges: readonly GraphDataEdge[];
}

export interface GraphNodeInfo {
  readonly label: string;
  readonly path: string;
  readonly kindId?: string;
  readonly kindLabel?: string;
  readonly kindIcon?: string;
}

export interface GraphService {
  /** Build the global graph, or an exact one-hop graph around one document. */
  build(centerDocumentId?: string): Promise<GraphData>;
  labels(): ReadonlyMap<string, GraphNodeInfo>;
  onDidChange(listener: () => void): { dispose(): void };
}

export const graphToken = createServiceToken<GraphService>('froglight.graph');

/** Global and document-local graph views over the shared connection projection. */
export const graphViewPlugin = definePlugin({
  id: 'froglight.graph-view',
  requirements: {
    requires: [workspaceToken, relationshipsToken, viewRegistryToken, documentRegistryToken],
    optionallyRequires: [rightSidebarRegistryToken, documentPresentationToken],
  },
  activate: (ctx) => {
    const workspace: WorkspaceService = ctx.require(workspaceToken);
    const kinds = ctx.require(documentRegistryToken);
    const presentations = ctx.try(documentPresentationToken);
    const relationships = ctx.require(relationshipsToken);
    const views = ctx.require(viewRegistryToken);
    const sidebar = ctx.try(rightSidebarRegistryToken);
    const listeners = new Set<() => void>();
    let cachedProjection: ConnectionProjection | null = null;
    let cachedLabels = new Map<string, GraphNodeInfo>();

    const rebuildProjection = (): ConnectionProjection => {
      const projection = projectConnections({ workspace, relationships });
      const presentationsByKind = new Map(presentations?.list().map((item) => [String(item.kindId), item] as const));
      const kindLabels = new Map<string, string>(kinds.list().map((kind) => [
        String(kind.id),
        presentationsByKind.get(kind.id)?.label ?? kind.creation?.label ?? String(kind.id),
      ]));
      cachedProjection = projection;
      cachedLabels = new Map(
        projection.documents.map((document) => [
          document.documentId,
          {
            label: document.title,
            path: document.path,
            kindId: document.kindId,
            kindLabel: kindLabels.get(document.kindId) ?? document.kindId,
            kindIcon: presentationsByKind.get(document.kindId)?.icon,
          },
        ]),
      );
      return projection;
    };

    const service: GraphService = {
      async build(centerDocumentId) {
        const complete = cachedProjection ?? rebuildProjection();
        const projection =
          centerDocumentId === undefined
            ? complete
            : localConnectionProjection(complete, centerDocumentId);
        return {
          nodes: projection.documents.map((document) => ({
            id: document.documentId,
            x: 0,
            y: 0,
            vx: 0,
            vy: 0,
            fixed: document.documentId === centerDocumentId,
          })),
          edges: projection.edges,
        };
      },
      labels() {
        if (cachedProjection === null) rebuildProjection();
        return cachedLabels;
      },
      onDidChange(listener) {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
    };

    const notify = (): void => {
      cachedProjection = null;
      for (const listener of [...listeners]) listener();
    };
    const derivedSubscription =
      workspace.onDidUpdateDerivedState?.(notify) ??
      workspace.onDidCommit(notify);
    const kindSubscription = kinds.onDidChange(notify);
    const presentationSubscription = presentations?.onDidChange(notify);
    ctx.effect(() => () => {
      derivedSubscription.dispose();
      kindSubscription.dispose();
      presentationSubscription?.dispose();
      listeners.clear();
    });

    ctx.provide(graphToken, service);
    ctx.effect(
      () =>
        views.register({
          id: 'graph',
          area: 'pane',
          title: 'Graph',
          component: function GraphViewHost() {
            return createElement(GraphView, { service });
          },
        }).dispose,
    );
    if (sidebar !== undefined) {
      function LocalGraphHost(props: {
        readonly context: RightSidebarContext;
      }): React.ReactElement {
        return createElement(GraphView, {
          service,
          centerDocumentId: props.context.documentId,
          compact: true,
          showNeighbors: false,
        });
      }
      ctx.effect(
        () =>
          sidebar.register({
            id: 'graph-local',
            title: 'Graph',
            icon: 'graph',
            order: 25,
            group: {
              id: 'connections',
              title: 'Connections',
              icon: 'graph',
              order: 30,
            },
            component: LocalGraphHost,
          }).dispose,
      );
    }
  },
});
