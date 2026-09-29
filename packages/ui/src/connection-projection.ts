import {
  pathName,
  resolveDocumentLink,
  type Relationship,
  type RelationshipService,
  type WorkspaceService,
} from '@froglight/foundation';

export interface ConnectionDocument {
  readonly documentId: string;
  readonly resourceId: string;
  readonly kindId: string;
  readonly title: string;
  readonly path: string;
}

export interface ConnectionOccurrence {
  readonly id: string;
  readonly type: string;
  readonly typeLabel: string;
  readonly sourceDocumentId: string;
  readonly sourceAddress?: string;
  readonly targetDocumentId: string | null;
  readonly unresolvedDocumentId?: string;
  readonly targetAddress?: string;
  readonly unresolvedLabel?: string;
  readonly excerpt?: string;
}

export interface ConnectionEdge {
  readonly source: string;
  readonly target: string;
  readonly occurrences: readonly ConnectionOccurrence[];
  readonly forwardCount: number;
  readonly reverseCount: number;
}

export interface ConnectionProjection {
  readonly documents: readonly ConnectionDocument[];
  readonly occurrences: readonly ConnectionOccurrence[];
  readonly unresolved: readonly ConnectionOccurrence[];
  readonly edges: readonly ConnectionEdge[];
}

const EXTERNAL_DESTINATION = /^[a-z][a-z0-9+.-]*:/i;

/** Friendly presentation for first-party types, with a plugin-safe fallback. */
export function relationshipTypeLabel(type: string): string {
  const known: Readonly<Record<string, string>> = {
    'markdown.link': 'Link',
    'markdown.embed': 'Embed',
    'blockpage.link': 'Link',
    'blockpage.embed': 'Embed',
    'blockpage.transclusion': 'Transclusion',
    'blockpage.linked-view': 'Linked view',
    'notebook.embed': 'Notebook embed',
    'ink.embed': 'Ink embed',
    'whiteboard.embed': 'Canvas embed',
    'latex.include': 'Include',
    'latex.bibliography': 'Bibliography',
  };
  const exact = known[type];
  if (exact !== undefined) return exact;
  const tail =
    type
      .split(/[./:_-]+/)
      .filter(Boolean)
      .at(-1) ?? 'connection';
  return `${tail.slice(0, 1).toUpperCase()}${tail.slice(1)}`;
}

/**
 * Project the derived relationship index into document-level connections.
 * This is the only UI projection used by graph and knowledge panels.
 */
export function projectConnections(services: {
  readonly workspace: WorkspaceService;
  readonly relationships: RelationshipService;
}): ConnectionProjection {
  const documents: ConnectionDocument[] = [];
  const byDocument = new Map<string, ConnectionDocument>();
  const byResource = new Map<string, ConnectionDocument>();
  for (const ref of services.workspace.listDocuments()) {
    const documentId = String(ref.documentId);
    const resourceId = String(ref.location.resourceId);
    let path = '';
    try {
      path = String(
        services.workspace.resolveResourcePath(ref.location.resourceId),
      );
    } catch {
      // Keep stable identity internally without turning it into presentation text.
    }
    const name = pathName(path as never) ?? 'Untitled document';
    const document: ConnectionDocument = Object.freeze({
      documentId,
      resourceId,
      kindId: String(ref.kindId),
      title: stripDocumentExtension(name),
      path: path || 'Unavailable document',
    });
    documents.push(document);
    byDocument.set(documentId, document);
    byResource.set(resourceId, document);
  }

  const occurrences: ConnectionOccurrence[] = [];
  const unresolved: ConnectionOccurrence[] = [];
  for (const relationship of services.relationships.list()) {
    const source = byResource.get(String(relationship.source.resourceId));
    if (source === undefined || isExternalRelationship(relationship)) continue;
    const target = resolveTarget(
      services.workspace,
      relationship,
      source,
      byDocument,
      byResource,
    );
    if (target === null && isUnresolvedMediaLocator(relationship)) continue;
    const unresolvedLabel =
      target === null ? targetLabel(relationship) : undefined;
    const occurrence: ConnectionOccurrence = Object.freeze({
      id: relationship.id,
      type: relationship.type,
      typeLabel: relationshipTypeLabel(relationship.type),
      sourceDocumentId: source.documentId,
      ...(relationship.source.address !== undefined
        ? { sourceAddress: relationship.source.address }
        : {}),
      targetDocumentId: target?.documentId ?? null,
      ...(target === null
        ? { unresolvedDocumentId: String(relationship.target.documentId) }
        : {}),
      ...(relationship.target.location.address !== undefined
        ? { targetAddress: relationship.target.location.address }
        : {}),
      ...(unresolvedLabel !== undefined ? { unresolvedLabel } : {}),
      ...excerptOf(relationship),
    });
    occurrences.push(occurrence);
    if (target === null) unresolved.push(occurrence);
  }

  const edgeSlots = new Map<string, ConnectionOccurrence[]>();
  for (const occurrence of occurrences) {
    const target = occurrence.targetDocumentId;
    if (target === null || target === occurrence.sourceDocumentId) continue;
    const a =
      occurrence.sourceDocumentId < target
        ? occurrence.sourceDocumentId
        : target;
    const b =
      occurrence.sourceDocumentId < target
        ? target
        : occurrence.sourceDocumentId;
    const key = `${a}\u0000${b}`;
    const slot = edgeSlots.get(key) ?? [];
    slot.push(occurrence);
    edgeSlots.set(key, slot);
  }
  const edges = [...edgeSlots.entries()].map(([key, slot]) => {
    const split = key.indexOf('\u0000');
    const source = key.slice(0, split);
    const target = key.slice(split + 1);
    return Object.freeze({
      source,
      target,
      occurrences: Object.freeze(slot),
      forwardCount: slot.filter(
        (item) =>
          item.sourceDocumentId === source && item.targetDocumentId === target,
      ).length,
      reverseCount: slot.filter(
        (item) =>
          item.sourceDocumentId === target && item.targetDocumentId === source,
      ).length,
    });
  });

  return Object.freeze({
    documents: Object.freeze(documents),
    occurrences: Object.freeze(occurrences),
    unresolved: Object.freeze(unresolved),
    edges: Object.freeze(edges),
  });
}

export function localConnectionProjection(
  projection: ConnectionProjection,
  centerDocumentId: string,
): ConnectionProjection {
  const incident = projection.edges.filter(
    (edge) =>
      edge.source === centerDocumentId || edge.target === centerDocumentId,
  );
  const documentIds = new Set<string>([centerDocumentId]);
  for (const edge of incident) {
    documentIds.add(edge.source);
    documentIds.add(edge.target);
  }
  return Object.freeze({
    documents: Object.freeze(
      projection.documents.filter((document) =>
        documentIds.has(document.documentId),
      ),
    ),
    occurrences: Object.freeze(
      projection.occurrences.filter(
        (occurrence) =>
          occurrence.sourceDocumentId === centerDocumentId ||
          occurrence.targetDocumentId === centerDocumentId,
      ),
    ),
    unresolved: Object.freeze(
      projection.unresolved.filter(
        (occurrence) => occurrence.sourceDocumentId === centerDocumentId,
      ),
    ),
    edges: Object.freeze(incident),
  });
}

function resolveTarget(
  workspace: WorkspaceService,
  relationship: Relationship,
  source: ConnectionDocument,
  byDocument: ReadonlyMap<string, ConnectionDocument>,
  byResource: ReadonlyMap<string, ConnectionDocument>,
): ConnectionDocument | null {
  const stable = byDocument.get(String(relationship.target.documentId));
  if (stable !== undefined) return stable;
  const resource = byResource.get(
    String(relationship.target.location.resourceId),
  );
  if (resource !== undefined) return resource;
  const href = relationship.metadata['href'];
  if (typeof href !== 'string') return null;
  const hrefIdentity = href.split('#', 1)[0] ?? '';
  if (
    String(relationship.target.documentId) !== hrefIdentity &&
    String(relationship.target.location.resourceId) !== hrefIdentity
  )
    return null;
  if (hrefIdentity === '' && relationship.target.location.address !== undefined)
    return source;
  try {
    const resolved = resolveDocumentLink(
      workspace,
      href,
      relationship.source.resourceId,
    );
    return resolved === null
      ? null
      : (byDocument.get(String(resolved.ref.documentId)) ?? null);
  } catch {
    return null;
  }
}

function isExternalRelationship(relationship: Relationship): boolean {
  if (relationship.type.endsWith('.external')) return true;
  const href = relationship.metadata['href'];
  return typeof href === 'string' && EXTERNAL_DESTINATION.test(href);
}

function isUnresolvedMediaLocator(relationship: Relationship): boolean {
  return relationship.metadata['kind'] === 'markdown-image';
}

function targetLabel(relationship: Relationship): string {
  const href = relationship.metadata['href'];
  if (typeof href === 'string' && href !== '') return href;
  const target = String(relationship.target.documentId);
  return target.includes('/') || target.includes('.')
    ? target
    : 'Missing document';
}

function excerptOf(relationship: Relationship): { readonly excerpt?: string } {
  const raw = relationship.metadata['raw'];
  if (typeof raw !== 'string') return {};
  const excerpt = raw.replace(/\s+/g, ' ').trim().slice(0, 140);
  return excerpt === '' ? {} : { excerpt };
}

function stripDocumentExtension(name: string): string {
  return name.replace(
    /\.(?:md|markdown|blockpage|base|ink|whiteboard|notebook|tex)$/i,
    '',
  );
}
