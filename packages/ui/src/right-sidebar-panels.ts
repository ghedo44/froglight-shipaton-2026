import { createElement, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { definePlugin } from '@froglight/runtime';
import {
  relationshipsToken,
  settingsToken,
  workspaceToken,
  resourcePropertiesToken,
  databaseQueryToken,
  databaseDefinitionsToken,
  type Relationship,
  type RelationshipService,
  type WorkspaceService,
} from '@froglight/foundation';
import {
  DocumentSettingsPanel,
  DocumentInspectorPanel,
  OutlinePanel,
} from './react/index.js';
import { DatabaseDocumentProperties } from './react/DatabaseDocumentProperties.js';
import panelStyles from './react/RightSidebarPanels.module.css';
import {
  rightSidebarRegistryToken,
  type RightSidebarContext,
} from './right-sidebar-registry.js';
import { workspaceSettingsToken } from './workspace-settings.js';
import {
  projectConnections,
  relationshipTypeLabel,
} from './connection-projection.js';
import { fileNameOf, iconForPath } from './file-kinds.js';
import { Icon } from './react/Icon.js';

/** First-party outline contribution; disabling it removes only its tab. */
export const documentOutlinePlugin = definePlugin({
  id: 'froglight.document-outline',
  requirements: { requires: [rightSidebarRegistryToken] },
  activate: (ctx) => {
    const registry = ctx.require(rightSidebarRegistryToken);
    ctx.effect(
      () =>
        registry.register({
          id: 'outline',
          title: 'Outline',
          icon: 'list-tree',
          order: 10,
          when: (context) =>
            context.outlineSupported ?? context.outline !== undefined,
          component: OutlinePanel,
        }).dispose,
    );
  },
});

/** First-party document settings contribution through the same public seam. */
export const documentSettingsPanelPlugin = definePlugin({
  id: 'froglight.document-settings-panel',
  requirements: {
    requires: [rightSidebarRegistryToken, workspaceSettingsToken],
  },
  activate: (ctx) => {
    const registry = ctx.require(rightSidebarRegistryToken);
    const settings = ctx.require(workspaceSettingsToken);
    function DocumentSettingsPanelHost(props: {
      readonly context: RightSidebarContext;
    }): React.ReactElement {
      return createElement(DocumentSettingsPanel, {
        key: props.context.documentId,
        context: props.context,
        settings,
      });
    }
    ctx.effect(
      () =>
        registry.register({
          id: 'document-settings',
          title: 'Document settings',
          icon: 'sliders',
          order: 20,
          component: DocumentSettingsPanelHost,
        }).dispose,
    );
  },
});

/** Pages, Canvas, and Selection share the provider's live semantic controls. */
export const documentInspectorPanelPlugin = definePlugin({
  id: 'froglight.document-inspector-panel',
  requirements: { requires: [rightSidebarRegistryToken] },
  activate: (ctx) => {
    const registry = ctx.require(rightSidebarRegistryToken);
    for (const [id, icon, order] of [
      ['pages', 'pages', 11],
      ['canvas', 'shapes', 12],
      ['selection', 'cursor', 13],
    ] as const) {
      ctx.effect(
        () =>
          registry.register({
            id: `inspector-${id}`,
            title:
              id === 'pages'
                ? 'Pages'
                : id === 'canvas'
                  ? 'Canvas'
                  : 'Inspector',
            icon,
            order,
            when: (context) =>
              context.inspector?.sections.some(
                (section) => section.id === id,
              ) === true,
            component: ({ context }) =>
              createElement(DocumentInspectorPanel, { context, section: id }),
          }).dispose,
      );
    }
  },
});

/** One provider-neutral property surface for every document editor. */
export const databaseDocumentPropertiesPlugin = definePlugin({
  id: 'froglight.document-database-properties',
  requirements: {
    requires: [
      rightSidebarRegistryToken,
      workspaceToken,
      resourcePropertiesToken,
      databaseQueryToken,
      databaseDefinitionsToken,
      relationshipsToken,
      settingsToken,
    ],
  },
  activate(ctx) {
    const registry = ctx.require(rightSidebarRegistryToken);
    const workspace = ctx.require(workspaceToken);
    const properties = ctx.require(resourcePropertiesToken);
    const query = ctx.require(databaseQueryToken);
    const definitions = ctx.require(databaseDefinitionsToken);
    const relationships = ctx.require(relationshipsToken);
    const settings = ctx.require(settingsToken);
    ctx.effect(
      () =>
        registry.register({
          id: 'database-properties',
          title: 'Properties',
          icon: 'blocks',
          order: 21,
          component: ({ context }) =>
            createElement(DatabaseDocumentProperties, {
              context,
              workspace,
              properties,
              query,
              definitions,
              relations: { definitions, relationships },
              settings,
            }),
        }).dispose,
    );
  },
});

/**
 * Knowledge panels.
 *
 * Four always-visible tabs over the derived relationship graph: References
 * (outgoing edges from the focused document), Backlinks (incoming edges to
 * it), Related (per-document one-hop neighborhood), and Document (live
 * knowledge facts). Unlike the outline tab they carry no `when` gate —
 * with no edges they render kind-neutral empty states, and without
 * workspace services they render the unavailable empty state (fail closed).
 *
 * Provider neutrality: only `{ id, type, source, target, metadata }` crosses
 * from the relationship service as plain data — never editor engines, never
 * canonical models. Edge `type` strings are opaque (never interpreted, only
 * grouped for the Document breakdown). Identity is stable-only: peers key on
 * `documentId` with a `resourceId` fallback (the rule); legacy href
 * targets resolve live through the foundation `resolveDocumentLink` seam and
 * are never stored as canonical identity. Paths/titles never key anything.
 * Dangling targets are preserved (outgoing rows stay visible; Related only
 * aggregates resolved documents).
 *
 * Liveness: each Host subscribes to `workspace.onDidCommit` and
 * re-derives on every commit — saves, never keystrokes, so there is no
 * per-keystroke rebuild. Derivation is revision-counted and row-cached:
 * unchanged rows keep referential identity across commits (proving no full
 * rebuild), and the injectable counters expose derivations/commits/reuse for
 * tests. Backlinks refresh on ANY commit because an incoming edge can be
 * added by editing another document.
 *
 * Reveal: activating a row delegates the exact source address verbatim to
 * the existing `context.revealAddress` seam — the panel never validates
 * addresses, so unknown ones degrade gracefully at the delegate. Rows with
 * no in-focused-document address (Markdown links carry none; incoming edges
 * live in other documents) render as static rows. Components live in this
 * module (createElement, no JSX) so the feature stays in its scoped file;
 * they reuse the colocated panel stylesheet classes for a consistent look.
 */

/** Workspace + relationship services closed over by the knowledge Hosts. */
export interface KnowledgePanelServices {
  readonly workspace: WorkspaceService;
  readonly relationships: RelationshipService;
}

/**
 * One knowledge row: a single relationship edge as plain data.
 *
 * `peerDocumentId`/`peerResourceId` name the other side by stable identity
 * (a synthetic href string when the target dangles — never a path/title
 * key). `reveal` is the exact in-focused-document source address, or null
 * when the edge has no address in the focused document.
 */
export interface RightSidebarKnowledgeRow {
  readonly id: string;
  readonly edgeType: string;
  readonly direction: 'outgoing' | 'incoming';
  readonly peerDocumentId: string;
  readonly peerResolved: boolean;
  readonly peerResourceId: string;
  readonly peerAddress?: string;
  readonly label: string;
  readonly excerpt?: string;
  readonly reveal: string | null;
}

/** One related document: per-direction edge counts plus edge-type set. */
export interface RightSidebarRelatedEntry {
  readonly documentId: string;
  readonly label: string;
  readonly outgoing: number;
  readonly incoming: number;
  readonly edgeTypes: readonly string[];
}

/** Derived knowledge data for the focused document (frozen plain data). */
export interface KnowledgePanelsData {
  readonly documentId: string;
  readonly outgoing: readonly RightSidebarKnowledgeRow[];
  readonly incoming: readonly RightSidebarKnowledgeRow[];
  readonly related: readonly RightSidebarRelatedEntry[];
  readonly outgoingCount: number;
  readonly incomingCount: number;
}

/**
 * Counter hooks proving incremental updates.
 *
 * `derivations` counts derivation runs, `commits` counts observed workspace
 * commits, `rowsReused` counts rows/entries that kept referential identity
 * across derivations instead of being rebuilt.
 */
export interface KnowledgePanelCounters {
  derivations: number;
  commits: number;
  rowsReused: number;
}

export function createKnowledgePanelCounters(): KnowledgePanelCounters {
  return { derivations: 0, commits: 0, rowsReused: 0 };
}

/**
 * Per-Host row cache keyed by stable relationship id (`out:`/`in:`) and
 * peer document id (`rel:`). Unchanged rows survive derivations by
 * reference so React (and tests) can observe incrementality.
 */
export interface KnowledgeRowCache {
  readonly rows: Map<string, RightSidebarKnowledgeRow>;
  readonly related: Map<string, RightSidebarRelatedEntry>;
}

export function createKnowledgeRowCache(): KnowledgeRowCache {
  return { rows: new Map(), related: new Map() };
}

/** Target handle for peer resolution (stable ids plus legacy href). */
export interface KnowledgePeerTarget {
  readonly documentId: string;
  readonly resourceId: string;
  readonly href?: string;
}

/** Known workspace document by stable identity (path/title never used). */
export interface KnownKnowledgeDocument {
  readonly documentId: string;
  readonly resourceId: string;
}

const EXTERNAL_KNOWLEDGE_HREF = /^(https?:\/\/|mailto:|#)/i;

/**
 * Resolve an edge target to a known document id (stable identity only).
 *
 * Order: exact `documentId` hit, then `resourceId` fallback (the
 * identity rule — renames/moves preserve links), then the legacy `href`
 * through the injected seam (same seam the graph view uses). Returns null
 * for dangling/external targets instead of inventing identity; resolution
 * failures fail closed to null and never throw.
 */
export function resolveKnowledgePeer(input: {
  readonly target: KnowledgePeerTarget;
  readonly documents: readonly KnownKnowledgeDocument[];
  readonly resolveHref?: (href: string) => string | null;
}): string | null {
  const { target, documents } = input;
  const direct = documents.find((doc) => doc.documentId === target.documentId);
  if (direct !== undefined) return direct.documentId;
  if (target.resourceId !== '') {
    const byResource = documents.find(
      (doc) => doc.resourceId === target.resourceId,
    );
    if (byResource !== undefined) return byResource.documentId;
  }
  const href = target.href;
  if (href === undefined || href === '' || EXTERNAL_KNOWLEDGE_HREF.test(href)) {
    return null;
  }
  try {
    const resolved = input.resolveHref?.(href) ?? null;
    if (
      resolved !== null &&
      documents.some((doc) => doc.documentId === resolved)
    ) {
      return resolved;
    }
  } catch {
    return null;
  }
  return null;
}

function knowledgeEdgeLabel(edge: Relationship, peerId: string): string {
  const metadata = edge.metadata;
  const alias = metadata['alias'];
  if (typeof alias === 'string' && alias !== '') return alias;
  const href = metadata['href'];
  if (typeof href === 'string' && href !== '') return href;
  return peerId;
}

function knowledgeRowsEqual(
  a: RightSidebarKnowledgeRow,
  b: RightSidebarKnowledgeRow,
): boolean {
  return (
    a.id === b.id &&
    a.edgeType === b.edgeType &&
    a.direction === b.direction &&
    a.peerDocumentId === b.peerDocumentId &&
    a.peerResourceId === b.peerResourceId &&
    a.peerResolved === b.peerResolved &&
    (a.peerAddress ?? null) === (b.peerAddress ?? null) &&
    a.label === b.label &&
    (a.excerpt ?? null) === (b.excerpt ?? null) &&
    (a.reveal ?? null) === (b.reveal ?? null)
  );
}

function relatedEntriesEqual(
  a: RightSidebarRelatedEntry,
  b: RightSidebarRelatedEntry,
): boolean {
  return (
    a.documentId === b.documentId &&
    a.label === b.label &&
    a.outgoing === b.outgoing &&
    a.incoming === b.incoming &&
    a.edgeTypes.length === b.edgeTypes.length &&
    a.edgeTypes.every((type, index) => type === b.edgeTypes[index])
  );
}

function cachedKnowledgeRow(
  cache: KnowledgeRowCache | undefined,
  counters: KnowledgePanelCounters | undefined,
  key: string,
  build: () => RightSidebarKnowledgeRow,
): RightSidebarKnowledgeRow {
  const next = Object.freeze(build());
  if (cache === undefined) return next;
  const previous = cache.rows.get(key);
  if (previous !== undefined && knowledgeRowsEqual(previous, next)) {
    if (counters !== undefined) counters.rowsReused += 1;
    return previous;
  }
  cache.rows.set(key, next);
  return next;
}

function cachedRelatedEntry(
  cache: KnowledgeRowCache | undefined,
  counters: KnowledgePanelCounters | undefined,
  key: string,
  build: () => RightSidebarRelatedEntry,
): RightSidebarRelatedEntry {
  const next = Object.freeze(build());
  if (cache === undefined) return next;
  const previous = cache.related.get(key);
  if (previous !== undefined && relatedEntriesEqual(previous, next)) {
    if (counters !== undefined) counters.rowsReused += 1;
    return previous;
  }
  cache.related.set(key, next);
  return next;
}

function peerTargetOf(edge: Relationship): KnowledgePeerTarget {
  const href = edge.metadata['href'];
  return {
    documentId: String(edge.target.documentId),
    resourceId: String(edge.target.location.resourceId),
    ...(typeof href === 'string' && href !== '' ? { href } : {}),
  };
}

/**
 * Pure knowledge derivation over one relationship snapshot.
 *
 * Outgoing = edges sourced at `resourceId`; incoming = edges whose target
 * resolves to `documentId` (plus direct stable-id matches for documents
 * outside the workspace index). A self edge appears in both lists; Related
 * excludes the focused document and only aggregates resolved peers.
 */
export function deriveKnowledgePanels(input: {
  readonly documentId: string;
  readonly resourceId: string | null;
  readonly edges: readonly Relationship[];
  readonly resolveDocument: (target: KnowledgePeerTarget) => string | null;
  readonly labelForDocument?: (documentId: string) => string | undefined;
  readonly counters?: KnowledgePanelCounters;
  readonly cache?: KnowledgeRowCache;
}): KnowledgePanelsData {
  const { documentId, resourceId, edges, resolveDocument } = input;
  const counters = input.counters;
  const cache = input.cache;
  if (counters !== undefined) counters.derivations += 1;
  const outgoing: RightSidebarKnowledgeRow[] = [];
  const incoming: RightSidebarKnowledgeRow[] = [];
  // Seen-key sets for per-derivation pruning: every cached row /
  // entry touched by this derivation is recorded; keys absent after the
  // derivation are evicted so bulk add→delete keeps memory bounded while
  // surviving rows keep referential reuse.
  const seenRowKeys = new Set<string>();
  const seenRelatedKeys = new Set<string>();
  const aggregated = new Map<
    string,
    { outgoing: number; incoming: number; edgeTypes: Set<string> }
  >();
  const aggregate = (
    peer: string,
    direction: 'outgoing' | 'incoming',
    edgeType: string,
  ): void => {
    let slot = aggregated.get(peer);
    if (slot === undefined) {
      slot = { outgoing: 0, incoming: 0, edgeTypes: new Set<string>() };
      aggregated.set(peer, slot);
    }
    slot[direction] += 1;
    slot.edgeTypes.add(edgeType);
  };
  for (const edge of edges) {
    const sourceResource = String(edge.source.resourceId);
    const fromSelf = resourceId !== null && sourceResource === resourceId;
    const targetPeer = resolveDocument(peerTargetOf(edge));
    if (fromSelf) {
      const peerId = targetPeer ?? String(edge.target.documentId);
      const outKey = `out:${edge.id}`;
      seenRowKeys.add(outKey);
      outgoing.push(
        cachedKnowledgeRow(cache, counters, outKey, () => ({
          id: edge.id,
          edgeType: edge.type,
          direction: 'outgoing',
          peerDocumentId: peerId,
          peerResolved: targetPeer !== null,
          peerResourceId: String(edge.target.location.resourceId),
          ...(edge.target.location.address !== undefined
            ? { peerAddress: edge.target.location.address }
            : {}),
          label: knowledgeEdgeLabel(edge, peerId),
          reveal: edge.source.address ?? null,
        })),
      );
      if (targetPeer !== null && targetPeer !== documentId) {
        aggregate(targetPeer, 'outgoing', edge.type);
      }
    }
    if (
      targetPeer === documentId ||
      String(edge.target.documentId) === documentId
    ) {
      const resolvedSource = resolveDocument({
        documentId: '',
        resourceId: sourceResource,
      });
      const sourcePeer = resolvedSource ?? sourceResource;
      const inKey = `in:${edge.id}`;
      seenRowKeys.add(inKey);
      incoming.push(
        cachedKnowledgeRow(cache, counters, inKey, () => ({
          id: edge.id,
          edgeType: edge.type,
          direction: 'incoming',
          peerDocumentId: sourcePeer,
          peerResolved: resolvedSource !== null,
          peerResourceId: sourceResource,
          ...(edge.source.address !== undefined
            ? { peerAddress: edge.source.address }
            : {}),
          label: input.labelForDocument?.(sourcePeer) ?? sourcePeer,
          reveal:
            sourcePeer === documentId ? (edge.source.address ?? null) : null,
        })),
      );
      if (resolvedSource !== null && resolvedSource !== documentId) {
        aggregate(sourcePeer, 'incoming', edge.type);
      }
    }
  }
  const related = [...aggregated.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([peer, slot]) => {
      const relatedKey = `rel:${peer}`;
      seenRelatedKeys.add(relatedKey);
      return cachedRelatedEntry(cache, counters, relatedKey, () => ({
        documentId: peer,
        label: input.labelForDocument?.(peer) ?? peer,
        outgoing: slot.outgoing,
        incoming: slot.incoming,
        edgeTypes: [...slot.edgeTypes].sort(),
      }));
    });
  // Evict keys unseen by this derivation so deleted edges free their cache
  // slots. Surviving keys keep referential identity via the cached helpers.
  if (cache !== undefined) {
    for (const key of [...cache.rows.keys()]) {
      if (!seenRowKeys.has(key)) cache.rows.delete(key);
    }
    for (const key of [...cache.related.keys()]) {
      if (!seenRelatedKeys.has(key)) cache.related.delete(key);
    }
  }
  return Object.freeze({
    documentId,
    outgoing: Object.freeze(outgoing),
    incoming: Object.freeze(incoming),
    related: Object.freeze(related),
    outgoingCount: outgoing.length,
    incomingCount: incoming.length,
  });
}

/**
 * Service-level knowledge read for the focused document.
 *
 * Builds the stable-identity document index from `listDocuments` (one pass,
 * no path/title keys) and wires legacy href resolution through the
 * foundation `resolveDocumentLink` seam with a fail-closed guard, then
 * delegates to {@link deriveKnowledgePanels} over `relationships.list()`.
 * An unknown focused document yields empty outgoing rows but still reads
 * incoming edges by stable id.
 */
export function readKnowledgePanels(
  services: KnowledgePanelServices,
  documentId: string,
  options?: {
    readonly counters?: KnowledgePanelCounters;
    readonly cache?: KnowledgeRowCache;
  },
): KnowledgePanelsData {
  const projection = projectConnections(services);
  const documents = new Map(
    projection.documents.map((document) => [document.documentId, document]),
  );
  const outgoing: RightSidebarKnowledgeRow[] = [];
  const incoming: RightSidebarKnowledgeRow[] = [];
  const cache = options?.cache;
  const counters = options?.counters;
  const related = new Map<
    string,
    { outgoing: number; incoming: number; edgeTypes: Set<string> }
  >();
  const countRelated = (
    peer: string,
    direction: 'outgoing' | 'incoming',
    type: string,
  ): void => {
    const slot = related.get(peer) ?? {
      outgoing: 0,
      incoming: 0,
      edgeTypes: new Set<string>(),
    };
    slot[direction] += 1;
    slot.edgeTypes.add(type);
    related.set(peer, slot);
  };
  if (options?.counters !== undefined) options.counters.derivations += 1;
  for (const occurrence of projection.occurrences) {
    if (occurrence.sourceDocumentId === documentId) {
      const peer = occurrence.targetDocumentId;
      const target = peer === null ? null : documents.get(peer);
      outgoing.push(
        cachedKnowledgeRow(cache, counters, `out:${occurrence.id}`, () => ({
          id: occurrence.id,
          edgeType: occurrence.type,
          direction: 'outgoing',
          peerDocumentId: peer ?? occurrence.unresolvedLabel ?? '',
          peerResolved: target !== null && target !== undefined,
          peerResourceId: target?.resourceId ?? '',
          ...(occurrence.targetAddress !== undefined
            ? { peerAddress: occurrence.targetAddress }
            : {}),
          label:
            target?.path ?? occurrence.unresolvedLabel ?? 'Missing document',
          ...(occurrence.excerpt !== undefined
            ? { excerpt: occurrence.excerpt }
            : {}),
          reveal: occurrence.sourceAddress ?? null,
        })),
      );
      if (peer !== null && peer !== documentId)
        countRelated(peer, 'outgoing', occurrence.type);
    }
    if (
      occurrence.targetDocumentId === documentId ||
      occurrence.unresolvedDocumentId === documentId
    ) {
      const source = documents.get(occurrence.sourceDocumentId);
      if (source === undefined) continue;
      incoming.push(
        cachedKnowledgeRow(cache, counters, `in:${occurrence.id}`, () => ({
          id: occurrence.id,
          edgeType: occurrence.type,
          direction: 'incoming',
          peerDocumentId: source.documentId,
          peerResolved: true,
          peerResourceId: source.resourceId,
          ...(occurrence.sourceAddress !== undefined
            ? { peerAddress: occurrence.sourceAddress }
            : {}),
          label: source.path,
          ...(occurrence.excerpt !== undefined
            ? { excerpt: occurrence.excerpt }
            : {}),
          reveal:
            source.documentId === documentId
              ? (occurrence.sourceAddress ?? null)
              : null,
        })),
      );
      if (source.documentId !== documentId)
        countRelated(source.documentId, 'incoming', occurrence.type);
    }
  }
  return Object.freeze({
    documentId,
    outgoing: Object.freeze(outgoing),
    incoming: Object.freeze(incoming),
    related: Object.freeze(
      [...related.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([peer, counts]) =>
          cachedRelatedEntry(cache, counters, `rel:${peer}`, () => ({
            documentId: peer,
            label: documents.get(peer)?.path ?? 'Missing document',
            outgoing: counts.outgoing,
            incoming: counts.incoming,
            edgeTypes: Object.freeze([...counts.edgeTypes].sort()),
          })),
        ),
    ),
    outgoingCount: outgoing.length,
    incomingCount: incoming.length,
  });
}

/** Props for the knowledge panel components (context plus closed-over services). */
export interface KnowledgePanelProps {
  readonly context: RightSidebarContext;
  readonly services: KnowledgePanelServices | null;
  /**
   * Live service resolver (probe-closure pattern).
   *
   * When present it is evaluated per render and per commit subscription
   * instead of trusting the `services` snapshot, so vault close/reopen and
   * cold-boot launcher never stick on a captured binding. `services` remains
   * as the fallback snapshot for direct unit use without a runtime.
   */
  readonly resolveServices?: () => KnowledgePanelServices | null;
  readonly counters?: KnowledgePanelCounters;
}

function useKnowledgeData(
  context: RightSidebarContext,
  services: KnowledgePanelServices | null,
  counters: KnowledgePanelCounters | undefined,
  resolveServices?: () => KnowledgePanelServices | null,
): KnowledgePanelsData | null {
  const resolvedCounters = useMemo(
    () => counters ?? createKnowledgePanelCounters(),
    [counters],
  );
  // Read services on every render/commit; never trust a captured binding
  // across vault lifecycles. The
  // resolver reads committed bindings live; a withdrawn vault fails closed
  // to null (never a disposed read) and a reopened vault yields fresh
  // services on the next render/commit. The snapshot stays as fallback for
  // direct unit use without a runtime.
  let live: KnowledgePanelServices | null = services;
  if (resolveServices !== undefined) {
    try {
      live = resolveServices();
    } catch {
      live = null;
    }
  }
  const workspace = live?.workspace ?? null;
  const relationships = live?.relationships ?? null;
  const cache = useMemo(
    () => createKnowledgeRowCache(),
    // Key on service identities (not the wrapper object, which the resolver
    // recreates per call) so the cache survives renders but resets on swap.
    [workspace, relationships, context.documentId],
  );
  const [sequence, setSequence] = useState(0);
  useEffect(() => {
    if (workspace === null) return;
    const subscription = (
      workspace.onDidUpdateDerivedState?.bind(workspace) ??
      workspace.onDidCommit.bind(workspace)
    )(() => {
      resolvedCounters.commits += 1;
      setSequence((value) => value + 1);
    });
    return () => subscription.dispose();
  }, [workspace, context.documentId, resolvedCounters]);
  return useMemo(() => {
    // Commit-granular cache buster (mirrors the outline panel): keystrokes
    // never reach this memo, only committed saves do.
    void sequence;
    if (workspace === null || relationships === null) return null;
    const current: KnowledgePanelServices = { workspace, relationships };
    return readKnowledgePanels(current, context.documentId, {
      counters: resolvedCounters,
      cache,
    });
  }, [
    workspace,
    relationships,
    context.documentId,
    sequence,
    resolvedCounters,
    cache,
  ]);
}

function KnowledgeEmpty(props: {
  readonly title: string;
  readonly body: string;
}): ReactElement {
  return createElement(
    'div',
    { className: panelStyles['right-sidebar-empty'] },
    createElement('strong', null, props.title),
    createElement('span', null, props.body),
  );
}

const KNOWLEDGE_UNAVAILABLE = {
  title: 'Knowledge unavailable',
  body: 'Workspace knowledge isn’t available in this profile.',
};

function KnowledgeRowList(props: {
  readonly rows: readonly RightSidebarKnowledgeRow[];
  readonly label: string;
  readonly onReveal: (address: string) => void;
  readonly onOpen: RightSidebarContext['openDocument'];
}): ReactElement {
  const groups = new Map<string, RightSidebarKnowledgeRow[]>();
  for (const row of props.rows) {
    const key = row.peerResolved
      ? row.peerDocumentId
      : `unresolved:${row.label}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return createElement(
    'nav',
    { className: panelStyles['connection-list'], 'aria-label': props.label },
    [...groups.values()].map((rows) => {
      const first = rows[0]!;
      const title = documentTitle(first.label);
      const path = first.peerResolved
        ? first.label
        : `${first.label} · Unresolved internal reference`;
      const activate = (): void => {
        if (!first.peerResolved) return;
        props.onOpen(first.peerDocumentId, first.peerAddress);
      };
      return createElement(
        'section',
        {
          key: first.peerResolved ? first.peerDocumentId : first.id,
          className: panelStyles['connection-group'],
        },
        first.peerResolved
          ? createElement(
              'button',
              {
                type: 'button',
                className: panelStyles['connection-primary'],
                onClick: activate,
                title: `Open ${title}`,
              },
              createElement(Icon, { name: iconForPath(first.label), size: 17 }),
              createElement(
                'span',
                { className: panelStyles['connection-copy'] },
                createElement('strong', null, title),
                createElement('small', null, path),
              ),
              rows.length > 1
                ? createElement(
                    'span',
                    { className: panelStyles['connection-count'] },
                    String(rows.length),
                  )
                : null,
            )
          : createElement(
              'div',
              {
                className: `${panelStyles['connection-primary']} ${panelStyles.unresolved}`,
              },
              createElement(Icon, { name: 'link', size: 17 }),
              createElement(
                'span',
                { className: panelStyles['connection-copy'] },
                createElement('strong', null, title),
                createElement('small', null, path),
              ),
            ),
        createElement(
          'details',
          { className: panelStyles['connection-occurrences'] },
          createElement(
            'summary',
            null,
            `${rows.length} ${rows.length === 1 ? 'occurrence' : 'occurrences'}`,
          ),
          createElement(
            'div',
            { className: panelStyles['connection-occurrence-list'] },
            rows.map((row, index) =>
              createElement(
                'div',
                {
                  key: row.id,
                  className: panelStyles['connection-occurrence'],
                },
                createElement(
                  'div',
                  { className: panelStyles['connection-occurrence-copy'] },
                  createElement(
                    'strong',
                    null,
                    relationshipTypeLabel(row.edgeType),
                  ),
                  createElement(
                    'small',
                    null,
                    row.excerpt ??
                      (row.peerAddress !== undefined
                        ? `At ${row.peerAddress}`
                        : `Occurrence ${index + 1}`),
                  ),
                ),
                row.peerResolved
                  ? createElement(
                      'button',
                      {
                        type: 'button',
                        onClick: () =>
                          props.onOpen(row.peerDocumentId, row.peerAddress),
                      },
                      'Open',
                    )
                  : null,
                row.direction === 'outgoing' && row.reveal !== null
                  ? createElement(
                      'button',
                      {
                        type: 'button',
                        onClick: () => props.onReveal(row.reveal!),
                      },
                      'Show in this note',
                    )
                  : null,
              ),
            ),
          ),
        ),
      );
    }),
  );
}

function documentTitle(path: string): string {
  return fileNameOf(path).replace(
    /\.(?:md|markdown|blockpage|base|ink|whiteboard|notebook|tex)$/i,
    '',
  );
}

/**
 * References panel — outgoing edges from the focused document.
 *
 * The primary row opens the destination at its target address. Each expanded
 * occurrence keeps a separate source-side reveal action when one is known.
 */
export function ReferencesPanel(props: KnowledgePanelProps): ReactElement {
  const { context } = props;
  const data = useKnowledgeData(
    context,
    props.services,
    props.counters,
    props.resolveServices,
  );
  const rootClass = `${panelStyles['right-sidebar-panel']} references-panel`;
  const heading = createElement(
    'h2',
    { className: panelStyles['right-sidebar-heading'] },
    'References',
  );
  if (data === null) {
    return createElement(
      'div',
      { className: rootClass },
      heading,
      createElement(KnowledgeEmpty, KNOWLEDGE_UNAVAILABLE),
    );
  }
  if (data.outgoing.length === 0) {
    return createElement(
      'div',
      { className: rootClass },
      heading,
      createElement(KnowledgeEmpty, {
        title: 'No references',
        body: 'This document doesn’t link to anything yet.',
      }),
    );
  }
  return createElement(
    'div',
    { className: rootClass },
    heading,
    createElement(KnowledgeRowList, {
      rows: data.outgoing,
      label: 'Outgoing references',
      onReveal: (address) => context.revealAddress(address),
      onOpen: (documentId, address) =>
        context.openDocument(documentId, address),
    }),
  );
}

/**
 * Backlinks panel — incoming edges to the focused document.
 *
 * Source identity renders from stable ids (never paths/titles). Only
 * self-document edges carry a revealable address; every other row is
 * static, and any delegated address still flows verbatim to the seam.
 */
export function BacklinksPanel(props: KnowledgePanelProps): ReactElement {
  const { context } = props;
  const data = useKnowledgeData(
    context,
    props.services,
    props.counters,
    props.resolveServices,
  );
  const rootClass = `${panelStyles['right-sidebar-panel']} backlinks-panel`;
  const heading = createElement(
    'h2',
    { className: panelStyles['right-sidebar-heading'] },
    'Backlinks',
  );
  if (data === null) {
    return createElement(
      'div',
      { className: rootClass },
      heading,
      createElement(KnowledgeEmpty, KNOWLEDGE_UNAVAILABLE),
    );
  }
  if (data.incoming.length === 0) {
    return createElement(
      'div',
      { className: rootClass },
      heading,
      createElement(KnowledgeEmpty, {
        title: 'No backlinks',
        body: 'Nothing links to this document yet.',
      }),
    );
  }
  return createElement(
    'div',
    { className: rootClass },
    heading,
    createElement(KnowledgeRowList, {
      rows: data.incoming,
      label: 'Incoming backlinks',
      onReveal: (address) => context.revealAddress(address),
      onOpen: (documentId, address) =>
        context.openDocument(documentId, address),
    }),
  );
}

/**
 * Related panel — one-hop document neighborhood aggregated from both edge
 * directions. Counts render per direction; edge types list the opaque kinds
 * connecting the pair.
 */
export function RelatedPanel(props: KnowledgePanelProps): ReactElement {
  const { context } = props;
  const data = useKnowledgeData(
    context,
    props.services,
    props.counters,
    props.resolveServices,
  );
  const rootClass = `${panelStyles['right-sidebar-panel']} related-panel`;
  const heading = createElement(
    'h2',
    { className: panelStyles['right-sidebar-heading'] },
    'Related',
  );
  if (data === null) {
    return createElement(
      'div',
      { className: rootClass },
      heading,
      createElement(KnowledgeEmpty, KNOWLEDGE_UNAVAILABLE),
    );
  }
  if (data.related.length === 0) {
    return createElement(
      'div',
      { className: rootClass },
      heading,
      createElement(KnowledgeEmpty, {
        title: 'No related documents',
        body: 'Documents linked from here or linking here will appear.',
      }),
    );
  }
  return createElement(
    'div',
    { className: rootClass },
    heading,
    createElement(
      'nav',
      {
        className: panelStyles['outline-tree'],
        'aria-label': 'Related documents',
      },
      data.related.map((entry) =>
        createElement(
          'button',
          {
            key: entry.documentId,
            type: 'button',
            onClick: () => context.openDocument(entry.documentId),
            className: panelStyles['connection-primary'],
            title: `${entry.outgoing} outgoing · ${entry.incoming} incoming · ${entry.edgeTypes.map(relationshipTypeLabel).join(', ')}`,
          },
          createElement(Icon, { name: iconForPath(entry.label), size: 17 }),
          createElement(
            'span',
            { className: panelStyles['connection-copy'] },
            createElement('strong', null, documentTitle(entry.label)),
            createElement(
              'small',
              null,
              `${entry.label} · ${entry.outgoing} outgoing · ${entry.incoming} incoming · ${entry.edgeTypes.map(relationshipTypeLabel).join(', ')}`,
            ),
          ),
        ),
      ),
    ),
  );
}

/**
 * Document panel — live knowledge facts for the focused document.
 *
 * Outgoing/incoming/related counts plus the per-edge-type breakdown refresh
 * on every workspace commit through the shared knowledge subscription, so
 * the facts stay live without reloads. Zero edges render the empty state.
 */
export function DocumentLivePanel(props: KnowledgePanelProps): ReactElement {
  const { context } = props;
  const data = useKnowledgeData(
    context,
    props.services,
    props.counters,
    props.resolveServices,
  );
  const rootClass = `${panelStyles['right-sidebar-panel']} document-live-panel`;
  const heading = createElement(
    'h2',
    { className: panelStyles['right-sidebar-heading'] },
    'Link summary',
  );
  if (data === null) {
    return createElement(
      'div',
      { className: rootClass },
      heading,
      createElement(KnowledgeEmpty, KNOWLEDGE_UNAVAILABLE),
    );
  }
  const breakdown = new Map<string, number>();
  for (const row of [...data.outgoing, ...data.incoming]) {
    breakdown.set(row.edgeType, (breakdown.get(row.edgeType) ?? 0) + 1);
  }
  if (data.outgoingCount + data.incomingCount === 0) {
    return createElement(
      'div',
      { className: rootClass },
      heading,
      createElement(KnowledgeEmpty, {
        title: 'No links yet',
        body: 'Links to and from this document will appear here.',
      }),
    );
  }
  const countRow = (label: string, value: number): ReactElement =>
    createElement(
      'div',
      {
        key: label,
        className: `${panelStyles['document-setting-row']} ${panelStyles.readonly}`,
      },
      createElement('span', null, label),
      createElement(
        'span',
        { className: panelStyles['document-setting-value'] },
        String(value),
      ),
    );
  return createElement(
    'div',
    { className: rootClass },
    heading,
    createElement(
      'section',
      { className: panelStyles['document-settings-group'] },
      createElement('h3', null, 'Links'),
      countRow('Outgoing', data.outgoingCount),
      countRow('Incoming', data.incomingCount),
      countRow('Related', data.related.length),
      ...[...breakdown.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([edgeType, count]) =>
          countRow(relationshipTypeLabel(edgeType), count),
        ),
    ),
  );
}

/**
 * First-party knowledge contribution through the same public seam as the
 * outline/settings panels: four effect-owned registrations, reversible as
 * one unit. Workspace services are optional — without them the tabs still
 * register and render the unavailable empty state.
 *
 * Liveness: services resolve live per Host render and per commit
 * subscription through the `resolveServices` probe closure (the
 * commandsProbe/workspaceSettingsProbe pattern) — never a value captured at
 * activation. Cold-boot launcher (no vault yet) resolves null → unavailable
 * states; vault close withdraws bindings → next resolve is null (fail
 * closed, never a disposed read); reopen yields fresh bindings.
 */
export const knowledgePanelsPlugin = definePlugin({
  id: 'froglight.knowledge-panels',
  requirements: {
    requires: [rightSidebarRegistryToken],
    optionallyRequires: [workspaceToken, relationshipsToken],
  },
  activate: (ctx) => {
    const registry = ctx.require(rightSidebarRegistryToken);
    const resolveServices = (): KnowledgePanelServices | null => {
      try {
        const workspace: WorkspaceService | null =
          ctx.try(workspaceToken) ?? null;
        const relationships: RelationshipService | null =
          ctx.try(relationshipsToken) ?? null;
        return workspace !== null && relationships !== null
          ? { workspace, relationships }
          : null;
      } catch {
        // Disposed fiber or retiring bindings: fail closed, never throw
        // into a Host render.
        return null;
      }
    };
    function ReferencesPanelHost(props: {
      readonly context: RightSidebarContext;
    }): ReactElement {
      return createElement(ReferencesPanel, {
        context: props.context,
        services: resolveServices(),
        resolveServices,
      });
    }
    function BacklinksPanelHost(props: {
      readonly context: RightSidebarContext;
    }): ReactElement {
      return createElement(BacklinksPanel, {
        context: props.context,
        services: resolveServices(),
        resolveServices,
      });
    }
    function RelatedPanelHost(props: {
      readonly context: RightSidebarContext;
    }): ReactElement {
      return createElement(RelatedPanel, {
        context: props.context,
        services: resolveServices(),
        resolveServices,
      });
    }
    function DocumentLivePanelHost(props: {
      readonly context: RightSidebarContext;
    }): ReactElement {
      return createElement(DocumentLivePanel, {
        context: props.context,
        services: resolveServices(),
        resolveServices,
      });
    }
    // Four separate effect-owned registrations keep outline and settings
    // panels independently reversible. A throwing register
    // cannot leak a prior sibling, and disposal needs no manual
    // reverse-order unwind — the runtime scope owns each effect.
    ctx.effect(
      () =>
        registry.register({
          id: 'references',
          title: 'References',
          icon: 'link',
          order: 30,
          group: {
            id: 'connections',
            title: 'Connections',
            icon: 'graph',
            order: 30,
          },
          component: ReferencesPanelHost,
        }).dispose,
    );
    ctx.effect(
      () =>
        registry.register({
          id: 'backlinks',
          title: 'Backlinks',
          icon: 'arrow-back',
          order: 40,
          group: {
            id: 'connections',
            title: 'Connections',
            icon: 'graph',
            order: 30,
          },
          component: BacklinksPanelHost,
        }).dispose,
    );
    ctx.effect(
      () =>
        registry.register({
          id: 'related',
          title: 'Related',
          icon: 'pages',
          order: 50,
          group: {
            id: 'connections',
            title: 'Connections',
            icon: 'graph',
            order: 30,
          },
          component: RelatedPanelHost,
        }).dispose,
    );
    ctx.effect(
      () =>
        registry.register({
          id: 'document-live',
          title: 'Document',
          icon: 'file-text',
          order: 60,
          group: {
            id: 'connections',
            title: 'Connections',
            icon: 'graph',
            order: 30,
          },
          component: DocumentLivePanelHost,
        }).dispose,
    );
  },
});
