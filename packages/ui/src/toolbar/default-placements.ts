/**
 * First-party default toolbar placements (Surface family spec).
 *
 * The semantic composition graph
 * (`defaultToolbarComposition()`) is the sole source of truth for normal
 * primary document tools (Surface Write / Erase / Select / Shapes / Insert,
 * Writing Style / Format / Insert / Structure, PDF source actions, LaTeX
 * structure/math/references). `TopbarCenterTools` renders the category strip
 * whenever the composition graph resolves; no `topbar-center` primary
 * placement remains for composition-covered tools, so the same logical tool
 * never renders twice and no duplicate guard is needed.
 *
 * Classification (finished migration, not transitional):
 * - COMPOSITION owns (no placement here): every `topbar-center` primary
 *   (`markdown.primary`, `blockpage.primary`, `ink.primary`,
 *   `notebook.primary`, `whiteboard.primary`, `pdf.primary`,
 *   `latex.primary`) and writing contextual groups (`markdown.format`,
 *   `markdown.insert`, `blockpage.format`, `blockpage.context`,
 *   `latex.insert`).
 * - COMPOSITION SHELF owns (no placement here): every
 *   active-tool quick property (`ink.color` / `ink.width` /
 *   `ink.eraser-radius` and the `notebook.*` / `whiteboard.*` equivalents
 *   with `surface.style.*` / `surface.erase.size` roles). Deleted in
 *  now that `CompositionShelf` owns quick favorites/widths/
 *   colors/modes plus the settings popover; do not re-add property
 *   islands here. Different control ids presenting the same user-facing
 *   property (legacy `ink.color` vs `ink.settings.pen.color`) still count
 *   as a duplicate.
 * - KEEP as geometric placements: history (`float.top-left`), zoom
 *   (`float.bottom-right`), selection (`float.selection`), page/navigation
 *   (`float.bottom-left`), canvas utilities (`float.bottom-left`),
 *   and diagnostics (`float.top-right`).
 *   No `float.top-center` first-party placement remains.
 *
 * Blockpage contextual edits: table grid ops,
 * column region ops, media payload edits, and math/diagram source+retry
 * ride dedicated `float.selection` islands (kind-blind, `control.id`
 * only, visible while an island control is enabled). Creation
 * (`block.insert.*`) stays shelf-only via composition and is NEVER
 * islanded here.
 *
 * Unified grammar: provider-local history in the built-in top-left island,
 * the Active Tool Menu at top-center (tool variants + quick properties),
 * and compact camera/zoom in a stable bottom-right island. Notebook page
 * navigation floats bottom-left; page management and paper properties
 * live in the right sidebar. Ink canvas dimensions live in Canvas there.
 *
 * Notebook PDF export is presented in the document sidebar. Ink PNG export
 * is available from document settings. Derived exports never replace canonical vectors.
 *
 * Zoom is compact by design (surface-toolbars-spec): zoom-out,
 * current/reset, zoom-in, plus fit where the document model distinguishes
 * it. The provider-exposed exact number/slider (`*.zoom`, `*.zoom-slider`)
 * stay unplaced so a future popover can reunite them without a placement
 * change; they are never rendered permanently alongside the compact group.
 * No persistent visible context/category labels (`PEN`, `ERASER`,
 * `Notebook Page`) are rendered — snapshot context survives only as
 * accessible metadata and selected control state.
 *
 * LaTeX composition owns structure/emphasis/math and
 * environments/references/citations (latex-toolbar-spec); only the compact
 * diagnostic indicator keeps a geometric placement floating top-right.
 * No compile-to-PDF action is placed.
 *
 * Active-tool quick properties are composition-owned (shelf + popover):
 * no `when` predicate over the snapshot's active tool remains here.
 * Selection-over-preset and mixed-selection safety are
 * provider-computed where supported; the UI never inspects Surface objects.
 *
 * UI-owned plain data over foundation kind ids and provider control ids.
 * Editor packages must not import this module (dependency direction is
 * UI → foundation); hosts pass these placements to `installDefaultUi`.
 */

import type { DocumentToolbarContext } from '../document-toolbar-registry.js';
import type { ToolbarPlacementContribution } from './placement-registry.js';

const INK = 'froglight.ink';
const NOTEBOOK = 'froglight.notebook';
const WHITEBOARD = 'froglight.whiteboard';
const PDF = 'froglight.pdf';
const LATEX = 'froglight.latex';

function placement(
  id: string,
  kindIds: readonly string[],
  anchor: ToolbarPlacementContribution['anchor'],
  order: number,
  controlIds: readonly string[],
  priority: number,
  when?: (context: DocumentToolbarContext) => boolean,
): ToolbarPlacementContribution {
  return {
    id,
    kindIds,
    anchor,
    order,
    controlIds,
    priority,
    compact: 'auto',
    ...(when !== undefined ? { when } : {}),
  };
}

/**
 * True when at least one of `ids` is present and enabled in the snapshot.
 * Provider-neutral contextual visibility: the snapshot's `disabled` flags
 * are provider-computed selection/caret state, so placements can appear or
 * minimize without React inspecting editor internals.
 */
function anyControlEnabled(
  context: DocumentToolbarContext,
  ids: ReadonlySet<string>,
): boolean {
  const controls = context.editor?.controls ?? [];
  return controls.some((control) => {
    if (
      !ids.has(control.id) ||
      control.kind === 'status' ||
      control.kind === 'diagnostics'
    )
      return false;
    return control.disabled !== true;
  });
}

export function defaultToolbarPlacements(): readonly ToolbarPlacementContribution[] {
  return [
    // --- Shell history: provider-local undo/redo as shell-owned semantic
    // controls in the built-in top-left island. Real geometric anchor, not
    // an implicit hard-coded zone; plugins may move/replace placement policy
    // without gaining provider internals. Priority 100 survives compaction.
    {
      id: 'froglight.toolbar-placement.history',
      anchor: 'float.top-left',
      order: 0,
      controlIds: ['shell.history.undo', 'shell.history.redo'],
      priority: 100,
      compact: 'never',
    },
    placement(
      'froglight.toolbar-placement.blockpage.contextual-format',
      ['froglight.blockpage'],
      'float.selection',
      20,
      [
        'block.type',
        'block.bold',
        'block.italic',
        'block.strike',
        'block.code',
        'block.link',
      ],
      90,
      (context) =>
        anyControlEnabled(
          context,
          new Set(['block.bold', 'block.italic', 'block.strike', 'block.code']),
        ),
    ),
    placement(
      'froglight.toolbar-placement.markdown.contextual-format',
      ['froglight.markdown'],
      'float.selection',
      20,
      [
        'markdown.block',
        'markdown.bold',
        'markdown.italic',
        'markdown.code',
        'markdown.link',
      ],
      90,
      (context) => context.editor?.contextualAnchor !== undefined,
    ),
    placement(
      'froglight.toolbar-placement.latex.contextual-format',
      [LATEX],
      'float.selection',
      20,
      ['latex.bold', 'latex.emphasis', 'latex.inline-math'],
      90,
      (context) => context.editor?.contextualAnchor !== undefined,
    ),
    // --- Writing primaries (Markdown / Block Page) are composition-owned:
    // Style / Format / Insert / Structure resolve through the semantic
    // composition graph (`writing.*` roles). Selected text uses the contextual
    // formatting placements above.

    // Ink tools and canvas dimensions are composition-owned. Selection
    // geometry and zoom retain their contextual geometric placements.
    placement(
      'froglight.toolbar-placement.ink.arrange',
      [INK],
      'float.selection',
      31,
      [
        'ink.selection.color',
        'ink.selection.fill',
        'ink.selection.text-size',
        'ink.selection.shape',
        'ink.selection.radius',
        'ink.selection.line-path',
        'ink.selection.line-arrows',
        'ink.selection.shape-appearance',
        'ink.selection.width',
        'ink.selection.opacity',
        'ink.selection.align',
        'ink.selection.distribute',
        'ink.selection.order',
        'ink.selection.lock',
        'ink.selection.unlock',
        'ink.selection.group',
        'ink.selection.ungroup',
        'ink.selection.duplicate',
        'ink.selection.delete',
        'ink.selection.connect',
      ],
      50,
      (context) =>
        anyControlEnabled(
          context,
          new Set(['ink.selection.duplicate', 'ink.selection.delete']),
        ),
    ),
    // Compact zoom: out, current/reset (%), in, plus fit-to-sheet. The exact
    // number/slider stay provider-exposed but unplaced for a future popover.
    placement(
      'froglight.toolbar-placement.ink.zoom',
      [INK],
      'float.bottom-right',
      40,
      ['ink.zoom-out', 'ink.zoom-reset', 'ink.zoom-in', 'ink.fit'],
      70,
    ),
    // Grouped surface-text controls; size/color are wired,
    // Ink shares Notebook's `surface.text` presentation table
    // behind its `ink.text.*` dialect. Contextual at `float.selection`
    // with the arrange group — visible only while a text control is
    // enabled (text selected), so no text selection means no text island.
    // Never topbar-center, never a second row.
    placement(
      'froglight.toolbar-placement.ink.text',
      [INK],
      'float.selection',
      32,
      [
        'ink.text.style',
        'ink.text.size',
        'ink.text.bold',
        'ink.text.italic',
        'ink.text.align',
        'ink.text.color',
        'ink.text.wrap',
      ],
      45,
      (context) =>
        anyControlEnabled(
          context,
          new Set([
            'ink.text.style',
            'ink.text.size',
            'ink.text.bold',
            'ink.text.italic',
            'ink.text.align',
            'ink.text.color',
            'ink.text.wrap',
          ]),
        ),
    ),

    // --- Notebook: composition owns drawing tools and quick properties;
    // page navigation and stack zoom float independently while page
    // management lives in the right sidebar.
    // Grouped surface-text controls ride `float.selection` contextually
    // while creation resolves through the `surface.text` composition category.
    // Source-PDF insertion lives in the shared Insert shelf via
    // composition (`notebook.insert.pdf.*`), not in navigation.
    // Paper and dimensions live in the Pages sidebar.
    placement(
      'froglight.toolbar-placement.notebook.arrange',
      [NOTEBOOK],
      'float.selection',
      31,
      [
        'notebook.selection.color',
        'notebook.selection.fill',
        'notebook.selection.text-size',
        'notebook.selection.shape',
        'notebook.selection.radius',
        'notebook.selection.line-path',
        'notebook.selection.line-arrows',
        'notebook.selection.shape-appearance',
        'notebook.selection.width',
        'notebook.selection.opacity',
        'notebook.selection.align',
        'notebook.selection.distribute',
        'notebook.selection.order',
        'notebook.selection.lock',
        'notebook.selection.unlock',
        'notebook.selection.group',
        'notebook.selection.ungroup',
        'notebook.selection.duplicate',
        'notebook.selection.delete',
        'notebook.selection.connect',
      ],
      50,
      (context) =>
        anyControlEnabled(
          context,
          new Set([
            'notebook.selection.duplicate',
            'notebook.selection.delete',
          ]),
        ),
    ),
    // Grouped surface-text controls; size/color are wired
    // style, size, bold/italic, align, color, and wrap for
    // the text selection. Contextual at `float.selection` with the arrange
    // group — visible only while a text control is enabled (text
    // selected), so no text selection means no text island. Never
    // topbar-center, never a second toolbar row.
    placement(
      'froglight.toolbar-placement.notebook.text',
      [NOTEBOOK],
      'float.selection',
      32,
      [
        'notebook.text.style',
        'notebook.text.size',
        'notebook.text.bold',
        'notebook.text.italic',
        'notebook.text.align',
        'notebook.text.color',
        'notebook.text.wrap',
      ],
      45,
      (context) =>
        anyControlEnabled(
          context,
          new Set([
            'notebook.text.style',
            'notebook.text.size',
            'notebook.text.bold',
            'notebook.text.italic',
            'notebook.text.align',
            'notebook.text.color',
            'notebook.text.wrap',
          ]),
        ),
    ),
    // Stable compact page navigation, independent of drawing context.
    // The PDF outline jump stays with navigation (it targets pages);
    // management (add/duplicate/delete/template) lives in the
    // Pages sidebar (single source) and
    // PDF insertion lives in the Insert shelf — neither floats here.
    placement(
      'froglight.toolbar-placement.notebook.pages-nav',
      [NOTEBOOK],
      'float.bottom-left',
      40,
      [
        'notebook.previous',
        'notebook.page',
        'notebook.next',
        'notebook.source-outline',
      ],
      80,
    ),
    // One continuous-stack zoom: out, current/reset (%), in, plus fit.
    // The exact number/slider stay unplaced for a future popover.
    placement(
      'froglight.toolbar-placement.notebook.zoom',
      [NOTEBOOK],
      'float.bottom-right',
      50,
      [
        'notebook.zoom-out',
        'notebook.zoom-reset',
        'notebook.zoom-in',
        'notebook.fit',
      ],
      70,
    ),

    // --- Whiteboard: composition owns the infinite-canvas creation
    // vocabulary and quick properties; no page navigation or page-size
    // controls. One arrowed connector tool (Line) shares the shelf.
    placement(
      'froglight.toolbar-placement.whiteboard.arrange',
      [WHITEBOARD],
      'float.selection',
      31,
      [
        'whiteboard.selection.color',
        'whiteboard.selection.fill',
        'whiteboard.selection.text-size',
        'whiteboard.selection.shape',
        'whiteboard.selection.radius',
        'whiteboard.selection.line-path',
        'whiteboard.selection.line-arrows',
        'whiteboard.selection.shape-appearance',
        'whiteboard.selection.width',
        'whiteboard.selection.opacity',
        'whiteboard.selection.align',
        'whiteboard.selection.distribute',
        'whiteboard.selection.order',
        'whiteboard.selection.lock',
        'whiteboard.selection.unlock',
        'whiteboard.selection.group',
        'whiteboard.selection.ungroup',
        'whiteboard.selection.duplicate',
        'whiteboard.selection.delete',
        'whiteboard.selection.connect',
      ],
      50,
      (context) =>
        anyControlEnabled(
          context,
          new Set([
            'whiteboard.selection.duplicate',
            'whiteboard.selection.delete',
          ]),
        ),
    ),
    // Compact infinite-canvas navigation: out, current/reset (%), in, fit.
    placement(
      'froglight.toolbar-placement.whiteboard.zoom',
      [WHITEBOARD],
      'float.bottom-right',
      30,
      [
        'whiteboard.zoom-out',
        'whiteboard.zoom-reset',
        'whiteboard.zoom-in',
        'whiteboard.fit',
      ],
      70,
    ),
    // Grouped surface-text controls; size/color are wired,
    // Whiteboard shares Notebook's `surface.text` presentation
    // table behind its `whiteboard.text.*` dialect (`froglight.card` text
    // stays distinct). Contextual at `float.selection` — visible only
    // while a text control is enabled. Never topbar-center, never a
    // second row.
    placement(
      'froglight.toolbar-placement.whiteboard.text',
      [WHITEBOARD],
      'float.selection',
      32,
      [
        'whiteboard.text.style',
        'whiteboard.text.size',
        'whiteboard.text.bold',
        'whiteboard.text.italic',
        'whiteboard.text.align',
        'whiteboard.text.color',
        'whiteboard.text.wrap',
      ],
      45,
      (context) =>
        anyControlEnabled(
          context,
          new Set([
            'whiteboard.text.style',
            'whiteboard.text.size',
            'whiteboard.text.bold',
            'whiteboard.text.italic',
            'whiteboard.text.align',
            'whiteboard.text.color',
            'whiteboard.text.wrap',
          ]),
        ),
    ),

    // --- PDF: composition owns source actions; page navigation floats bottom-left.
    placement(
      'froglight.toolbar-placement.pdf.pages',
      [PDF],
      'float.bottom-left',
      20,
      ['pdf.previous', 'pdf.page', 'pdf.next', 'pdf.outline'],
      80,
    ),

    // --- Blockpage contextual edits: table grid
    // ops, column region ops, media payload edits, and math/diagram
    // source+retry ride dedicated `float.selection` islands after the
    // Surface text groups (orders 33-36, priority below arrange like the
    // text precedent). Kind-blind on purpose: no `kindIds`, so any provider
    // emitting these provider-exact control ids gets the island, claimed by
    // `control.id` only — never semanticRole, labels, or id substrings.
    // Visible only while an island control is enabled (contextual
    // selection); dormant otherwise. Creation (`block.insert.*`) stays
    // shelf-only via composition and is NEVER islanded here. Never
    // topbar-center, never a second row.
    {
      id: 'froglight.toolbar-placement.selection.table',
      anchor: 'float.selection',
      order: 33,
      controlIds: [
        'table.addRowBefore',
        'table.addRow',
        'table.addColumnBefore',
        'table.addColumn',
        'table.removeRow',
        'table.removeColumn',
        'table.moveRowUp',
        'table.moveRowDown',
        'table.moveColumnLeft',
        'table.moveColumnRight',
        'table.toggleHeader',
      ],
      priority: 45,
      compact: 'auto',
      when: (context) =>
        anyControlEnabled(
          context,
          new Set([
            'table.addRowBefore',
            'table.addRow',
            'table.addColumnBefore',
            'table.addColumn',
            'table.removeRow',
            'table.removeColumn',
            'table.moveRowUp',
            'table.moveRowDown',
            'table.moveColumnLeft',
            'table.moveColumnRight',
            'table.toggleHeader',
          ]),
        ),
    },
    {
      id: 'froglight.toolbar-placement.selection.media',
      anchor: 'float.selection',
      order: 35,
      controlIds: [
        'media.name',
        'media.caption',
        'media.alt',
        'media.details',
        'media.replace',
        'media.remoteUrl',
        'media.clearRemote',
        'media.retry',
      ],
      priority: 45,
      compact: 'auto',
      when: (context) =>
        anyControlEnabled(
          context,
          new Set([
            'media.name',
            'media.caption',
            'media.alt',
            'media.details',
            'media.replace',
            'media.remoteUrl',
            'media.clearRemote',
            'media.retry',
          ]),
        ),
    },
    {
      id: 'froglight.toolbar-placement.selection.math-diagram',
      anchor: 'float.selection',
      order: 36,
      controlIds: [
        'math.edit',
        'math.source',
        'math.retry',
        'diagram.edit',
        'diagram.source',
        'diagram.retry',
      ],
      priority: 45,
      compact: 'auto',
      when: (context) =>
        anyControlEnabled(
          context,
          new Set([
            'math.edit',
            'math.source',
            'math.retry',
            'diagram.edit',
            'diagram.source',
            'diagram.retry',
          ]),
        ),
    },

    // --- LaTeX: composition owns structure/emphasis/math and
    // environment/reference/citation helpers; only the compact diagnostic
    // indicator keeps a geometric placement floating top-right so it stays
    // reachable without a second row. No compile-to-PDF action is placed:
    // the capability does not exist yet.
    placement(
      'froglight.toolbar-placement.latex.diagnostics',
      [LATEX],
      'float.top-right',
      30,
      ['latex.diagnostics'],
      90,
    ),
  ];
}
