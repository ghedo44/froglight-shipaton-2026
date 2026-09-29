/**
 * Relationship extraction for Markdown.
 *
 * Links found by `extractLinks` become `RelationshipInput` edges.
 * Resolution is path-only for v1; hrefs that are not resolvable to a
 * workspace path remain as unresolved edges (metadata.fragment / href).
 * The extractor itself (called from `DocumentKind.decode`) produces edges
 * with synthetic target ids derived from the href path string — the
 * workspace-layer resolver can later map those to real document ids when
 * the workspace snapshot is available.
 */

import type { DocumentId, DocumentKindId, ResourceId } from '../identity.js';
import type { DocumentLocation, DocumentRef } from '../documents.js';
import type { RelationshipInput } from '../relationships.js';
import { extractLinks } from './links.js';
import { parseFrontmatter } from './frontmatter.js';

/** Synthetic target ids when the href cannot be resolved to a real document at decode time. */
function syntheticTargetFor(hrefPath: string, fragment: string | undefined): DocumentRef {
  // Use the href path string itself as documentId/resourceId synthetic.
  // This is deterministic and host-agnostic; real resolution maps it to a real id later.
  const key = hrefPath;
  return {
    documentId: key as unknown as DocumentId,
    kindId: 'froglight.markdown' as DocumentKindId,
    location: {
      resourceId: key as unknown as ResourceId,
      ...(fragment ? { address: fragment } : {}),
    },
  };
}

export interface ExtractMarkdownRelationshipsInput {
  readonly source: DocumentLocation;
  readonly raw: string;
}

/** Extract relationships from raw Markdown. Host- and editor-free. */
export function extractMarkdownRelationships(input: ExtractMarkdownRelationshipsInput): RelationshipInput[] {
  const { body } = parseFrontmatter(input.raw);
  const links = extractLinks(body);
  const edges: RelationshipInput[] = [];
  for (const link of links) {
    // Skip bare external URLs — still extracted but typed separately for consumers that may ignore them.
    const isExternal = /^https?:\/\//i.test(link.destination) || /^mailto:/i.test(link.destination);
    const type =
      link.kind === 'markdown-image' || link.kind === 'wiki-embed'
        ? 'markdown.embed'
        : isExternal
          ? 'markdown.link.external'
          : 'markdown.link';
    const target = syntheticTargetFor(link.destination, link.fragment);
    edges.push({
      type,
      source: input.source,
      target,
      metadata: {
        raw: link.raw,
        href: link.destination,
        ...(link.fragment ? { fragment: link.fragment } : {}),
        ...(link.alias ? { alias: link.alias } : {}),
        kind: link.kind,
      },
    });
  }
  return edges;
}

/**
 * Attempt to resolve an href path to a real `DocumentRef` using the workspace snapshot.
 * Title fallback handled separately; this is path resolution only.
 */
export function resolveMarkdownHrefToRef(
  hrefPath: string,
  fragment: string | undefined,
  sourcePath: string,
  pathToRef: Map<string, DocumentRef>,
  titleToRefs: Map<string, DocumentRef[]>,
): DocumentRef | null {
  // Try WorkspacePath resolution first when href looks like a path.
  const looksLikePath = hrefPath.includes('/') || hrefPath.endsWith('.md');
  if (looksLikePath) {
    // Relative to source directory.
    const slash = sourcePath.lastIndexOf('/');
    const dir = slash === -1 ? '' : sourcePath.slice(0, slash + 1);
    let candidate = hrefPath;
    if (!candidate.startsWith('/') && !candidate.includes(':')) {
      candidate = dir + candidate;
    }
    // Normalize: remove leading slash, collapse //, handle ./ and handle implicit .md
    candidate = candidate.replace(/^\//, '').replace(/\/\/+/g, '/');
    // If no extension, try with .md implicit — title path resolution prefers file, so try both.
    const withMd = candidate.endsWith('.md') ? candidate : `${candidate}.md`;
    const hit = pathToRef.get(candidate) ?? pathToRef.get(withMd);
    if (hit !== undefined) {
      if (fragment !== undefined) {
        return { ...hit, location: { ...hit.location, address: fragment } };
      }
      return hit;
    }
    return null;
  }
  // Title lookup for bare names.
  const key = hrefPath.trim();
  if (key !== '') {
    const hits = titleToRefs.get(key);
    if (hits !== undefined && hits.length === 1) {
      const hit = hits[0];
      if (fragment !== undefined) {
        return { ...hit, location: { ...hit.location, address: fragment } };
      }
      return hit;
    }
  }
  return null;
}
