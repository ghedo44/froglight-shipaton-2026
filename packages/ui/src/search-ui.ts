import { createServiceToken, definePlugin } from '@froglight/runtime';
import {
  pathName,
  searchToken,
  workspaceToken,
  type SearchService,
  type WorkspaceService,
} from '@froglight/foundation';

export interface SearchUiResult {
  readonly documentId: string;
  readonly title: string;
  readonly excerpt: string;
  /** Portable in-document address, such as a notebook page id. */
  readonly address?: string;
  /** Where the match came from; drives result grouping in the panel. */
  readonly matchedIn?: 'filename' | 'content';
}

export interface SearchUiService {
  search(query: string): Promise<readonly SearchUiResult[]>;
}

export const searchUiToken = createServiceToken<SearchUiService>(
  'froglight.search-ui',
);

/** Search UI over all workspace documents, with filename prefix matching. */
export const searchUiPlugin = definePlugin({
  id: 'froglight.search-ui',
  requirements: { requires: [searchToken, workspaceToken] },
  activate: (ctx) => {
    const search: SearchService = ctx.require(searchToken);
    const workspace: WorkspaceService = ctx.require(workspaceToken);

    const service: SearchUiService = {
      async search(query) {
        const normalizedQuery = normalize(query.trim());
        if (normalizedQuery.length === 0) return [];

        const documents = workspace.listDocuments().map((ref) => {
          const path = workspace.resolveResourcePath(ref.location.resourceId);
          return {
            documentId: String(ref.documentId),
            title: pathName(path) ?? String(path),
            path: String(path),
          };
        });
        const documentById = new Map(
          documents.map((document) => [document.documentId, document]),
        );

        // Search canonical text first. When a query matches both a path and
        // body text, the body excerpt is the useful result to show.
        const semanticMatches = search
          .search({ text: query })
          .flatMap<SearchUiResult>((result) => {
            const documentId = String(result.documentId);
            const document = documentById.get(documentId);
            return [
              {
                documentId,
                title: result.title ?? document?.title ?? documentId,
                excerpt: result.excerpt || document?.path || '',
                ...(result.location.address !== undefined
                  ? { address: result.location.address }
                  : {}),
                matchedIn: 'content' as const,
              },
            ];
          });
        const seen = new Set(
          semanticMatches.map((result) => result.documentId),
        );

        // Filename/path matches are independent of document content. This is
        // what makes every document kind discoverable before it has a custom
        // content-search projector.
        const filenameMatches: SearchUiResult[] = documents
          .filter((document) => {
            if (seen.has(document.documentId)) return false;
            const title = normalize(document.title);
            const path = normalize(document.path);
            return (
              title.includes(normalizedQuery) ||
              path.includes(`/${normalizedQuery}`) ||
              normalizedQuery
                .split(/\s+/)
                .every((token) => path.includes(token))
            );
          })
          .sort(
            (a, b) =>
              normalize(a.title).indexOf(normalizedQuery) -
                normalize(b.title).indexOf(normalizedQuery) ||
              a.title.localeCompare(b.title),
          )
          .map((document) => ({
            documentId: document.documentId,
            title: document.title,
            excerpt: document.path,
            matchedIn: 'filename' as const,
          }));

        return [...semanticMatches, ...filenameMatches].slice(0, 50);
      },
    };
    ctx.provide(searchUiToken, service);
  },
});

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Escape an excerpt and wrap every case-insensitive query-token occurrence
 * in `<mark>`. Marking happens on raw text; both marked and unmarked slices
 * are HTML-escaped, so attributes/entities can never be injected.
 */
export function highlightMatches(text: string, query: string): string {
  const trimmed = query.trim();
  if (trimmed === '') return escapeHtml(text);
  const tokens = trimmed
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .map(escapeRegExp);
  if (tokens.length === 0) return escapeHtml(text);
  const pattern = new RegExp(`(${tokens.join('|')})`, 'gi');
  let out = '';
  let lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    out += escapeHtml(text.slice(lastIndex, index));
    out += `<mark>${escapeHtml(match[0])}</mark>`;
    lastIndex = index + match[0].length;
  }
  out += escapeHtml(text.slice(lastIndex));
  return out;
}

function normalize(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}
