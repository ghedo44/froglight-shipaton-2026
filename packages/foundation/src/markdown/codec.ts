/**
 * Markdown codec: canonical `.md` bytes <-> MarkdownModel.
 *
 * The model is raw-string-based so round-tripping is byte-identical.
 * Frontmatter preservation is inherent: the raw string is stored.
 */

import type { DocumentRef } from '../documents.js';
import { utf8Decode, utf8Encode } from '../encoding.js';
import type { DecodedDocument } from '../documents.js';
import type { MarkdownModel } from './model.js';
import { extractMarkdownMetadata } from './metadata.js';
import { extractMarkdownRelationships, resolveMarkdownHrefToRef } from './relationships.js';
import { workspacePath } from '../paths.js';

/** Decode raw vault bytes into a Markdown model + derived projections. */
export function decodeMarkdown(
  data: Uint8Array,
  ref: DocumentRef,
  options?: { fallbackTitleFromPath?: string },
): DecodedDocument<MarkdownModel> & { model: MarkdownModel } {
  const raw = utf8Decode(data);
  const model: MarkdownModel = { raw };
  const metadata = extractMarkdownMetadata({
    documentId: ref.documentId,
    raw,
    fallbackTitle: options?.fallbackTitleFromPath,
  });
  const relationships = extractMarkdownRelationships({ source: ref.location, raw });
  return { model, metadata: metadata as Record<string, unknown>, relationships };
}

/** Encode a Markdown model back to canonical bytes. */
export function encodeMarkdown(model: MarkdownModel, _ref: DocumentRef): Uint8Array {
  return utf8Encode(model.raw);
}

/** Helpers for workspace-layer resolution that maps synthetic href targets to real refs. */
export function resolveMarkdownRelationships(
  relationships: DecodedDocument<MarkdownModel>['relationships'],
  sourcePath: string,
  pathToRef: Map<string, DocumentRef>,
  titleToRefs: Map<string, DocumentRef[]>,
): DecodedDocument<MarkdownModel>['relationships'] {
  return relationships.map((edge) => {
    const href = (edge.metadata?.href as string | undefined) ?? '';
    const fragment = edge.metadata?.fragment as string | undefined;
    const resolved = resolveMarkdownHrefToRef(href, fragment, sourcePath, pathToRef, titleToRefs);
    if (resolved !== null) {
      return { ...edge, target: resolved };
    }
    return edge;
  });
}

/** Derive fallback title from a WorkspacePath (filename without directory/ext). */
export function fallbackTitleFromPath(path: ReturnType<typeof workspacePath>): string {
  const parts = path.split('/');
  const name = parts[parts.length - 1] ?? path;
  return name.endsWith('.md') ? name.slice(0, -3) : name;
}
