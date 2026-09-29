/**
 * Tolerant resource-embed presentation read for rendering.
 *
 * The canonical `ResourceEmbedGeometry.presentation` member is owned by
 * parallel and may be ABSENT in this main-based worktree. This
 * helper never crashes on absent/unknown values:
 * - absent → `{ mode: 'preview' }` (the default frame);
 * - `'preview'` / `{ mode: 'preview' }` → preview;
 * - `'link'` / `{ mode: 'link' }` → link (compact chip, no composition);
 * - anything else present → preview with `unknown: true` and the raw value
 *   preserved verbatim (codec keeps it byte-stable; extraction still emits
 *   the edge). Unknown shapes never throw and never drop bytes.
 *
 * Shared by the picker activation card and the whiteboard/notebook owner
 * helpers so every surface renders the same mode from the same record.
 *
 * WHY THREE COPIES: the shared `resourceEmbedPresentationOf`
 * export does NOT exist in `@froglight/foundation` (verified by grep), and
 * editing foundation is forbidden to this task. The provider owner modules
 * (`editor-whiteboard`, `editor-notebook`, both `layer:provider`) cannot
 * import this `layer:plugin` copy either (`layer:provider` may only depend
 * on runtime/capability/provider). So this file is the canonical shared
 * copy for the card, and the two owner-local mirrors
 * (`resolveWhiteboardEmbedPresentation`,
 * `resolveNotebookEmbedPresentation`) must stay behavior-identical with it.
 * The PARITY MATRIX below is duplicated verbatim in all three spec files
 * (`ResourceEmbedCard.spec.tsx`, whiteboard `resource-embed.spec.ts`,
 * notebook `resource-embed.spec.ts`); keep the three copies in sync. If
 * foundation later gains the export, delete all three and import it.
 *
 * PARITY MATRIX (keep identical across all three spec files):
 * | input                  | mode      | unknown |
 * |------------------------|-----------|---------|
 * | absent                 | 'preview' | false   |
 * | 'preview'              | 'preview' | false   |
 * | 'link'                 | 'link'    | false   |
 * | { mode: 'preview' }    | 'preview' | false   |
 * | { mode: 'link' }       | 'link'    | false   |
 * | 'hologram'             | 'preview' | true    |
 * | { mode: 'hologram' }   | 'preview' | true    |
 * | 42 / null / ['preview']| 'preview' | true    |
 */

export type SurfaceEmbedPresentationMode = 'preview' | 'link';

export interface ResolvedSurfaceEmbedPresentation {
  readonly mode: SurfaceEmbedPresentationMode;
  readonly raw: unknown;
  readonly unknown: boolean;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function resolveSurfaceEmbedPresentation(
  record: { readonly [key: string]: unknown },
): ResolvedSurfaceEmbedPresentation {
  const raw = (record as Record<string, unknown>).presentation;
  if (raw === undefined)
    return { mode: 'preview', raw: undefined, unknown: false };
  if (raw === 'preview') return { mode: 'preview', raw, unknown: false };
  if (raw === 'link') return { mode: 'link', raw, unknown: false };
  if (isPlainRecord(raw)) {
    if (raw.mode === 'preview') return { mode: 'preview', raw, unknown: false };
    if (raw.mode === 'link') return { mode: 'link', raw, unknown: false };
  }
  return { mode: 'preview', raw, unknown: true };
}

export function surfaceEmbedPresentationModeOf(record: {
  readonly [key: string]: unknown;
}): SurfaceEmbedPresentationMode {
  return resolveSurfaceEmbedPresentation(record).mode;
}
