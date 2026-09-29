import {
  extractHeadings,
  extractLaTeXStructure,
  navigablePageIds,
  projectBlockPageForSearch,
  runsOf,
  SURFACE_OBJECT_TYPES,
  type BlockPageModel,
  type CompositionHandle,
  type CompositionImage,
  type CompositionProviderInput,
  type CompositionProviderRegistration,
  type CompositionSnapshot,
  type LaTeXModel,
  type LaTeXProvider,
  type MarkdownModel,
  type NotebookModel,
  type PdfProvider,
  type PdfSourceModel,
  type ResourceTarget,
  type SurfaceModel,
  type WorkspaceService,
} from '@froglight/foundation';

interface CompositionProviderDeps {
  readonly workspace: () => WorkspaceService | null;
  readonly openSource: (target: ResourceTarget) => void;
  /**
   * Optional counter hooks for incremental refresh.
   *
   * When present, every completed load increments `loads`; a load whose
   * snapshot is structurally identical to the current one increments
   * `skipped` and notifies nobody (the previous reference survives so
   * downstream memoization holds); a changed load increments `notified`.
   * Absent by default — `createApp` does not thread it, so existing hosts
   * observe only the (compatible) notification-skipping behavior.
   */
  readonly refreshCounters?: CompositionRefreshCounters;
  readonly renderInkPreview?: (
    model: SurfaceModel,
  ) => Promise<CompositionImage | undefined> | CompositionImage | undefined;
  readonly renderNotebookPreviews?: (
    model: NotebookModel,
  ) => Promise<readonly CompositionImage[]> | readonly CompositionImage[];
  readonly pdfProvider?: () => PdfProvider | null;
  readonly renderPdfPreview?: (
    bytes: Uint8Array,
    pageIndex: number,
  ) => Promise<CompositionImage | undefined> | CompositionImage | undefined;
  readonly latexProvider?: () => LaTeXProvider | null;
}

/**
 * Counter hooks for incremental composition refresh.
 *
 * `loads` counts completed loads, `skipped` counts loads whose snapshot was
 * structurally identical to the current one (no notification, reference
 * preserved), and `notified` counts loads that replaced the snapshot and
 * notified listeners.
 */
export interface CompositionRefreshCounters {
  loads: number;
  skipped: number;
  notified: number;
}

export function createCompositionRefreshCounters(): CompositionRefreshCounters {
  return { loads: 0, skipped: 0, notified: 0 };
}

function snapshotsEqualValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a === 'function' || typeof b === 'function') return false;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((entry, index) => snapshotsEqualValue(entry, b[index]));
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (key) =>
      Object.hasOwn(b, key) &&
      snapshotsEqualValue(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
      ),
  );
}

/**
 * Structural equality over composition snapshots (plain data only).
 *
 * Conservative by design: functions (which snapshots never carry) compare
 * unequal so an unexpected callable always triggers a refresh rather than
 * risking a stale view.
 */
export function compositionSnapshotsEqual(
  a: CompositionSnapshot,
  b: CompositionSnapshot,
): boolean {
  return snapshotsEqualValue(a, b);
}

function asyncHandle(
  input: CompositionProviderInput,
  deps: CompositionProviderDeps,
  load: (workspace: WorkspaceService) => Promise<CompositionSnapshot>,
): CompositionHandle {
  let snapshot: CompositionSnapshot = { state: 'loading' };
  let disposed = false;
  let generation = 0;
  const listeners = new Set<() => void>();
  /**
   * Revision-keyed publish: identical reloads keep the
   * previous snapshot reference and skip listener notification, so an
   * unchanged save never triggers a downstream rebuild. Listeners only
   * fire when derived content actually changes.
   */
  const publish = (value: CompositionSnapshot): void => {
    if (deps.refreshCounters !== undefined) {
      deps.refreshCounters.loads += 1;
    }
    if (compositionSnapshotsEqual(snapshot, value)) {
      if (deps.refreshCounters !== undefined) {
        deps.refreshCounters.skipped += 1;
      }
      return;
    }
    snapshot = value;
    if (deps.refreshCounters !== undefined) {
      deps.refreshCounters.notified += 1;
    }
    for (const listener of listeners) listener();
  };
  const workspace = deps.workspace();
  if (workspace === null) {
    snapshot = {
      state: 'placeholder',
      reason: 'missing-target',
      message: 'Workspace is unavailable',
      recoverable: true,
    };
  } else {
    const refresh = (): void => {
      const request = ++generation;
      void load(workspace)
        .then((value) => {
          if (disposed || request !== generation) return;
          publish(value);
        })
        .catch(() => {
          if (disposed || request !== generation) return;
          publish({
            state: 'placeholder',
            reason: 'missing-target',
            message: 'Referenced source is unavailable',
            recoverable: true,
            actions: [
              { id: 'open-source', label: 'Locate source', authority: 'none' },
            ],
          });
        });
    };
    const subscription = workspace.onDidCommit((documentId) => {
      if (documentId === input.target.documentId) refresh();
    });
    refresh();
    return {
      snapshot: () => snapshot,
      onDidChange(listener) {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
      invoke(actionId) {
        if (actionId === 'open-source') deps.openSource(input.target);
      },
      dispose() {
        disposed = true;
        generation += 1;
        subscription.dispose();
        listeners.clear();
      },
    };
  }
  return {
    snapshot: () => snapshot,
    onDidChange(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    invoke(actionId) {
      if (actionId === 'open-source') deps.openSource(input.target);
    },
    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}

function sourceMatches(
  input: CompositionProviderInput,
  ref: { documentId: string; kindId: string; location: { resourceId: string } },
): boolean {
  return (
    ref.documentId === input.target.documentId &&
    ref.kindId === input.target.kindId &&
    ref.location.resourceId === input.target.resourceId
  );
}

function linesAround(raw: string, line: number): string {
  return raw
    .split('\n')
    .slice(line, line + 8)
    .join('\n')
    .trim();
}

function markdownSection(
  raw: string,
  headings: ReturnType<typeof extractHeadings>,
  heading: ReturnType<typeof extractHeadings>[number],
): string {
  const index = headings.indexOf(heading);
  const next = headings
    .slice(index + 1)
    .find((entry) => entry.level <= heading.level);
  return raw.split('\n').slice(heading.line, next?.line ?? undefined).join('\n');
}

export function createFirstPartyCompositionProviders(
  deps: CompositionProviderDeps,
): readonly CompositionProviderRegistration[] {
  return [
    {
      kindId: 'froglight.markdown' as never,
      roles: ['preview', 'transclusion'],
      writeAuthority: 'none',
      open(input) {
        return asyncHandle(input, deps, async (workspace) => {
          const read = await workspace.readDocument<MarkdownModel>(
            input.target.documentId as never,
          );
          if (!sourceMatches(input, read.ref))
            throw new Error('identity mismatch');
          const headings = extractHeadings(read.model.raw);
          let markdown = read.model.raw;
          if (input.role === 'transclusion') {
            const heading = headings.find(
              (entry) => entry.slug === input.target.address,
            );
            if (heading === undefined)
              return {
                state: 'placeholder',
                reason: 'unsupported-address',
                message: 'Markdown address is unavailable',
                recoverable: true,
                actions: [
                  {
                    id: 'open-source',
                    label: 'Open source',
                    authority: 'none',
                  },
                ],
              };
            markdown = markdownSection(read.model.raw, headings, heading);
            return {
              state: 'ready',
              title: heading.text,
              summary: linesAround(read.model.raw, heading.line),
              presentation: {
                type: 'froglight.markdown',
                data: { raw: markdown },
              },
              actions: [
                { id: 'open-source', label: 'Open source', authority: 'none' },
              ],
            };
          }
          return {
            state: 'ready',
            title: headings[0]?.text ?? 'Markdown',
            summary: read.model.raw.slice(0, 800),
            presentation: {
              type: 'froglight.markdown',
              data: { raw: markdown },
            },
            actions: [
              { id: 'open-source', label: 'Open source', authority: 'none' },
            ],
          };
        });
      },
    },
    {
      kindId: 'froglight.blockpage' as never,
      roles: ['preview', 'transclusion'],
      writeAuthority: 'none',
      open(input) {
        return asyncHandle(input, deps, async (workspace) => {
          const read = await workspace.readDocument<BlockPageModel>(
            input.target.documentId as never,
          );
          if (!sourceMatches(input, read.ref))
            throw new Error('identity mismatch');
          if (input.role === 'transclusion') {
            const block =
              input.target.address === undefined
                ? undefined
                : read.model.blocks[input.target.address];
            if (block === undefined)
              return {
                state: 'placeholder',
                reason: 'unsupported-address',
                message: 'Block address is unavailable',
                recoverable: true,
                actions: [
                  {
                    id: 'open-source',
                    label: 'Open source',
                    authority: 'none',
                  },
                ],
              };
            const text =
              runsOf(block)
                ?.map((run) => run.text)
                .join('') ??
              (typeof block.text === 'string' ? block.text : null) ??
              (typeof block.label === 'string' ? block.label : block.type);
            return {
              state: 'ready',
              title:
                typeof read.model.meta.title === 'string'
                  ? read.model.meta.title
                  : 'Block Page',
              summary: text,
              actions: [
                { id: 'open-source', label: 'Open source', authority: 'none' },
              ],
            };
          }
          const projection = projectBlockPageForSearch(
            read.model,
            input.target.documentId,
          );
          return {
            state: 'ready',
            title: projection.title || 'Block Page',
            summary: projection.body.slice(0, 800),
            actions: [
              { id: 'open-source', label: 'Open source', authority: 'none' },
            ],
          };
        });
      },
    },
    {
      kindId: 'froglight.ink' as never,
      roles: ['preview'],
      writeAuthority: 'none',
      open(input) {
        return asyncHandle(input, deps, async (workspace) => {
          const read = await workspace.readDocument<SurfaceModel>(
            input.target.documentId as never,
          );
          if (!sourceMatches(input, read.ref))
            throw new Error('identity mismatch');
          const text = read.model.order
            .flatMap((id) => {
              const object = read.model.objects[id];
              return object?.type === SURFACE_OBJECT_TYPES.text &&
                typeof object.text === 'string'
                ? [object.text]
                : [];
            })
            .join('\n');
          const strokes = read.model.order.filter(
            (id) =>
              read.model.objects[id]?.type === SURFACE_OBJECT_TYPES.stroke,
          ).length;
          const summary =
            text !== ''
              ? text.slice(0, 800)
              : `${read.model.order.length} objects${strokes > 0 ? `, ${strokes} strokes` : ''}`;
          const image = await deps.renderInkPreview?.(read.model);
          return {
            state: 'ready',
            title: 'Ink page',
            ...(text !== '' || image === undefined ? { summary } : {}),
            ...(image !== undefined ? { image } : {}),
            imageOnly: true,
            actions: [
              { id: 'open-source', label: 'Open source', authority: 'none' },
            ],
          };
        });
      },
    },
    {
      kindId: 'froglight.notebook' as never,
      roles: ['preview'],
      writeAuthority: 'none',
      open(input) {
        return asyncHandle(input, deps, async (workspace) => {
          const read = await workspace.readDocument<NotebookModel>(
            input.target.documentId as never,
          );
          if (!sourceMatches(input, read.ref))
            throw new Error('identity mismatch');
          const pageCount = navigablePageIds(read.model).length;
          const images =
            (await deps.renderNotebookPreviews?.(read.model)) ?? [];
          const title =
            typeof read.model.meta.title === 'string' &&
            read.model.meta.title.trim() !== ''
              ? read.model.meta.title
              : 'Notebook';
          return {
            state: 'ready',
            title,
            summary:
              images.length > 0 && images.length < pageCount
                ? `Showing ${images.length} of ${pageCount} pages`
                : `${pageCount} ${pageCount === 1 ? 'page' : 'pages'}`,
            ...(images.length > 0 ? { images } : {}),
            actions: [
              { id: 'open-source', label: 'Open source', authority: 'none' },
            ],
          };
        });
      },
    },
    {
      kindId: 'froglight.pdf' as never,
      roles: ['preview', 'transclusion'],
      writeAuthority: 'none',
      open(input) {
        return asyncHandle(input, deps, async (workspace) => {
          const read = await workspace.readDocument<PdfSourceModel>(
            input.target.documentId as never,
          );
          if (!sourceMatches(input, read.ref))
            throw new Error('identity mismatch');
          const provider = deps.pdfProvider?.();
          if (provider === null || provider === undefined) {
            return {
              state: 'placeholder',
              reason: 'missing-provider',
              message: 'PDF provider is unavailable',
              recoverable: true,
              actions: [
                { id: 'open-source', label: 'Open source', authority: 'none' },
              ],
            };
          }
          const handle = await provider.open({ bytes: read.model.bytes });
          try {
            const pageIndex =
              input.role === 'transclusion' ? Number(input.target.address) : 0;
            if (
              !Number.isInteger(pageIndex) ||
              pageIndex < 0 ||
              pageIndex >= handle.pageCount
            ) {
              return {
                state: 'placeholder',
                reason: 'unsupported-address',
                message: 'PDF page address is unavailable',
                recoverable: true,
                actions: [
                  {
                    id: 'open-source',
                    label: 'Open source',
                    authority: 'none',
                  },
                ],
              };
            }
            const page = await handle.getPageText(pageIndex);
            const summary = page.items
              .map((item) => item.text)
              .join('')
              .slice(0, 800);
            const image = await deps.renderPdfPreview?.(
              read.model.bytes,
              pageIndex,
            );
            return {
              state: 'ready',
              title:
                input.role === 'transclusion'
                  ? `PDF page ${pageIndex + 1}`
                  : 'PDF document',
              ...(summary !== '' || image === undefined
                ? {
                    summary:
                      summary ||
                      `${handle.pageCount} ${handle.pageCount === 1 ? 'page' : 'pages'}`,
                  }
                : {}),
              ...(image !== undefined ? { image } : {}),
              actions: [
                { id: 'open-source', label: 'Open source', authority: 'none' },
              ],
            };
          } finally {
            await handle.close();
          }
        });
      },
    },
    {
      // LaTeX whole-resource preview. The
      // ready state is a structure summary: CompositionSnapshot carries
      // plain data, not live HTML. Label-addressed transclusions are
      // placeholder-only this phase — portable addresses, never
      // provider-specific ones.
      kindId: 'froglight.latex' as never,
      roles: ['preview', 'transclusion'],
      writeAuthority: 'none',
      open(input) {
        return asyncHandle(input, deps, async (workspace) => {
          const read = await workspace.readDocument<LaTeXModel>(
            input.target.documentId as never,
          );
          if (!sourceMatches(input, read.ref))
            throw new Error('identity mismatch');
          const structure = extractLaTeXStructure(read.model.raw);
          if (input.role === 'transclusion') {
            const label = input.target.address ?? '';
            const known = structure.labels.some((entry) => entry.name === label);
            return {
              state: 'placeholder' as const,
              reason: 'unsupported-address' as const,
              message: known
                ? `LaTeX fragment "${label || '?'}" cannot be embedded yet`
                : `LaTeX label "${label || '?'}" is not defined in this document`,
              recoverable: true,
              actions: [
                { id: 'open-source', label: 'Open source', authority: 'none' },
              ],
            };
          }
          const provider = deps.latexProvider?.();
          if (provider === null || provider === undefined) {
            return {
              state: 'placeholder' as const,
              reason: 'missing-provider' as const,
              message: 'LaTeX preview provider is unavailable',
              recoverable: true,
              actions: [
                { id: 'open-source', label: 'Open source', authority: 'none' },
              ],
            };
          }
          const citationCount = structure.citations.reduce(
            (total, citation) => total + citation.keys.length,
            0,
          );
          const items = structure.sections.slice(0, 12).map((section, index) => ({
            id: `section-${index}`,
            text: section.title,
          }));
          const summaryParts = [
            `${structure.sections.length} ${structure.sections.length === 1 ? 'section' : 'sections'}`,
            `${citationCount} ${citationCount === 1 ? 'citation' : 'citations'}`,
          ];
          return {
            state: 'ready' as const,
            title: structure.title ?? 'LaTeX document',
            summary: summaryParts.join(' · '),
            ...(items.length > 0 ? { items } : {}),
            actions: [
              { id: 'open-source', label: 'Open source', authority: 'none' },
            ],
          };
        });
      },
    },
  ];
}
