/**
 * Workspace-level link resolution (foundation seam).
 *
 * Link resolution is deliberately document-kind agnostic: any future
 * document kind registered with a workspace path participates in `[[…]]`
 * and Markdown link resolution without changing this module. Resolution
 * order per destination:
 *
 * 1. exact path match;
 * 2. the same path with `.md` appended (Obsidian-style extensionless links);
 * 3. case-insensitive full-path or basename match across all documents.
 */

import { isWorkspacePath } from './paths.js';
import type { WorkspaceService } from './workspace.js';
import type { DocumentRef } from './documents.js';
import type { ResourceId } from './identity.js';

export interface ResolvedLinkTarget {
  readonly ref: DocumentRef;
  readonly path: string;
}

/** Split `path#fragment` so fragment text never participates in resolution. */
export function splitLinkDestination(destination: string): { path: string; fragment?: string } {
  const hash = destination.indexOf('#');
  if (hash === -1) return { path: destination };
  return { path: destination.slice(0, hash), fragment: destination.slice(hash + 1) };
}

function normalizeKey(value: string): string {
  return value.toLowerCase();
}

function stripMd(value: string): string {
  return value.replace(/\.md$/i, '');
}

export function resolveDocumentLink(
  workspace: WorkspaceService,
  rawDestination: string,
  sourceResourceId?: ResourceId,
): ResolvedLinkTarget | null {
  const { path: destination } = splitLinkDestination(rawDestination.trim());
  const cleaned = destination.replace(/^\.?\//, '');
  if (cleaned === '') return null;

  // Resolve path-shaped links relative to their source document first. This
  // is the same behavior users get when activating the link in the editor,
  // and prevents two same-named notes in different folders from rebinding.
  const candidates: string[] = [];
  const addCandidate = (candidate: string): void => {
    candidates.push(candidate);
    if (!/\.[^/]+$/i.test(candidate)) candidates.push(`${candidate}.md`);
  };
  if (sourceResourceId !== undefined && !destination.startsWith('/')) {
    try {
      const sourcePath = String(workspace.resolveResourcePath(sourceResourceId));
      const slash = sourcePath.lastIndexOf('/');
      const directory = slash === -1 ? '' : sourcePath.slice(0, slash + 1);
      const relative = normalizeRelativePath(`${directory}${destination}`);
      if (relative !== null) addCandidate(relative);
    } catch {
      // A stale source resource cannot authorize guessing another target.
    }
  }
  addCandidate(cleaned);
  // Exact path candidates are authoritative. Invalid path spellings simply
  // fail exact lookup and fall through to the unambiguous-name lookup.
  const seenCandidates = new Set<string>();
  for (const candidate of candidates) {
    if (seenCandidates.has(candidate)) continue;
    seenCandidates.add(candidate);
    if (!isWorkspacePath(candidate)) continue;
    const ref = workspace.findByResourcePath(candidate as never);
    if (ref !== null) {
      return { ref, path: candidate };
    }
  }

  // Case-insensitive suffix/basename lookup is allowed only when unique.
  // Missing stable targets must never be rebound to an arbitrary same-name
  // note based on list ordering.
  const key = normalizeKey(stripMd(cleaned));
  const matches: ResolvedLinkTarget[] = [];
  for (const ref of workspace.listDocuments()) {
    const path = String(workspace.resolveResourcePath(ref.location.resourceId));
    const normalized = normalizeKey(stripMd(path));
    if (normalized === key || normalized.endsWith(`/${key}`)) {
      matches.push({ ref, path });
    }
  }
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function normalizeRelativePath(value: string): string | null {
  const parts: string[] = [];
  for (const part of value.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  const normalized = parts.join('/');
  return normalized === '' ? null : normalized;
}
