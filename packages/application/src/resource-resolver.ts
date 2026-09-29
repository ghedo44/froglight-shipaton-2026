/**
 * Workspace-backed resource suggestion for Block Page editors.
 *
 * Owns workspace listing, Markdown heading enrichment, Block Page
 * enrichment, ranking/order, and key-based dedup. Extracted verbatim from
 * the former inline Block Page editor adapter so ranking, labels,
 * addresses, dedup keys, and fallback/additional-resolver ordering are
 * preserved exactly in this slice.
 *
 * The resolver reads the active workspace on every `search()` call via
 * `getWorkspace()`, so a vault/workspace replacement cannot leave a stale
 * captured workspace behind.
 */

import {
  blockPageKindId,
  databaseKindId,
  type DatabaseModel,
  extractHeadings,
  markdownKindId,
  runsOf,
  type BlockPageModel,
  type MarkdownModel,
  type ResourceResolver,
  type ResourceSuggestion,
  type WorkspaceService,
} from '@froglight/foundation';

/** Unit-separator joining documentId and resourceId in dedup keys. */
const DEDUP_SEPARATOR = String.fromCharCode(31);

export interface WorkspaceResourceResolverOptions {
  /** Resolve the active workspace on every search (never captured). */
  readonly getWorkspace: () => WorkspaceService | null;
  /** Optional additional/provider-owned resolver merged after workspace hits. */
  readonly additionalResolver?: ResourceResolver;
}

/**
 * Create a `ResourceResolver` that suggests workspace paths with
 * Markdown/Block Page enrichment and key-based dedup.
 */
export function createWorkspaceResourceResolver(
  options: WorkspaceResourceResolverOptions,
): ResourceResolver {
  const { getWorkspace, additionalResolver } = options;
  return {
    async search(query) {
      const active = getWorkspace();
      const additional = (await additionalResolver?.search(query)) ?? [];
      if (active === null) return additional;
      const needle = query.trim().toLocaleLowerCase();
      const candidates = active.listDocuments().flatMap((ref) => {
        let label: string;
        try {
          label = active.resolveResourcePath(ref.location.resourceId);
        } catch {
          return [];
        }
        if (needle !== '' && !label.toLocaleLowerCase().includes(needle))
          return [];
        return [
          {
            target: {
              documentId: ref.documentId,
              kindId: ref.kindId,
              resourceId: ref.location.resourceId,
              ...(ref.location.address !== undefined
                ? { address: ref.location.address }
                : {}),
            },
            label,
          },
        ];
      });
      const enriched = await Promise.all(
        candidates.map(async (suggestion): Promise<ResourceSuggestion> => {
          try {
            if (suggestion.target.kindId === databaseKindId) {
              const read = await active.readDocument<DatabaseModel>(
                suggestion.target.documentId as never,
              );
              return {
                ...suggestion,
                views: read.model.views.map((view) => ({
                  viewId: view.id,
                  label: view.name,
                })),
              };
            }
            if (suggestion.target.kindId === markdownKindId) {
              const read = await active.readDocument<MarkdownModel>(
                suggestion.target.documentId as never,
              );
              return {
                ...suggestion,
                addresses: extractHeadings(read.model.raw).map((heading) => ({
                  address: heading.slug,
                  label: heading.text,
                })),
              };
            }
            if (suggestion.target.kindId === blockPageKindId) {
              const read = await active.readDocument<BlockPageModel>(
                suggestion.target.documentId as never,
              );
              return {
                ...suggestion,
                addresses: Object.values(read.model.blocks).map((block) => ({
                  address: block.id,
                  label:
                    runsOf(block)
                      ?.map((run) => run.text)
                      .join('') ||
                    (typeof block.label === 'string'
                      ? block.label
                      : block.type),
                })),
              };
            }
          } catch {
            // Keep the resource discoverable when canonical detail loading fails.
          }
          return suggestion;
        }),
      );
      const byKey = new Map<string, ResourceSuggestion>();
      for (const suggestion of [...enriched, ...additional]) {
        const key = `${suggestion.target.documentId}${DEDUP_SEPARATOR}${suggestion.target.resourceId}`;
        const previous = byKey.get(key);
        byKey.set(
          key,
          previous === undefined
            ? suggestion
            : {
                ...previous,
                ...suggestion,
                addresses: suggestion.addresses ?? previous.addresses,
                views: suggestion.views ?? previous.views,
              },
        );
      }
      return [...byKey.values()];
    },
  };
}
