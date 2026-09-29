import type {
  ToolbarCategoryContribution,
  ToolbarItemContribution,
  ToolbarKindExtension,
} from './composition-registry.js';

/**
 * First-party composition contributions.
 *
 * Stability contract: every `id` below is a stable
 * customization identifier referenced by persisted user overrides
 * (`toolbar-customization.ts`). Keep item ids stable when regrouping them;
 * category removal for a deliberate pre-release merge must be reflected in
 * the pinned set in `toolbar-customization.spec.ts`.
 *
 * Each Surface category has its own primary entry: Selection, Pen,
 * Highlighter, Eraser, Shapes, Text, and Insert. Page and canvas properties
 * remain provider controls but project into the right sidebar. Writing
 * categories still organize the semantic graph; the UI presents their
 * frequent actions directly without category browsing.
 *
 * Fixed shelf slots: slotted items declare an additive
 * `slotId` whose effective id (`slotIdForItem`) doubles as the
 * customization key (`slotSizes`/`slotColors`/`slotPens`) and the
 * React/scope key. Pen family is exactly the four `toolRole: 'pen'`
 * conduits (ball/fountain/brush/pencil); Highlighter (`toolRole:
 * 'highlighter`) has an independent one-tap category and never competes for
 * one of the four fixed Pen slots. Size
 * family is `surface.write.width` + `surface.erase.size` (third position
 * pads with a `null` placeholder); color family is `surface.write.color`
 * alone (two `null` placeholders). The squeeze-palette settings fallbacks
 * (`surface.write.saved-style`, `surface.write.settings-color`,
 * `surface.write.settings-size`, `surface.erase.settings-size`) stay
 * unslotted verbatim so slot order lists key on the primary
 * conduits only. Unslotted items render in verbatim composition order
 * keyed by item id; `order`/`priority`/`before`/`after` resolve
 * first and user-order/slot-order overlays only re-sort after.
 *
 * Deliberate omissions (additive-only means nothing added here either):
 * - Blockpage creation/insertion uses the shared writing graph; contextual
 *   selection edits stay provider-local.
 * - amendment (blockpage polish mission): one-path
 *   constrains creation; contextual edits for table/media/mathDiagram/
 *   columns may surface secondarily at float.selection via placement
 *   islands; creation stays shelf-only.
 * - Markdown strike omit: no markdown strike item is
 *   emitted — `writing.format.strike` stays dormant (`unresolved`) for
 *   markdown until an editor can compute it honestly.
 * - PDF label-only: no PDF id renames — any vocabulary
 *   unification is display-label mapping only, never id changes.
 */
export const DEFAULT_TOOLBAR_CATEGORIES: readonly ToolbarCategoryContribution[] =
  [
    {
      id: 'surface.select',
      familyId: 'surface',
      groupId: 'surface.select',
      label: 'Selection',
      icon: 'lasso',
      order: 0,
      priority: 110,
    },
    {
      id: 'surface.write',
      familyId: 'surface',
      groupId: 'surface.write',
      label: 'Pen',
      icon: 'pen',
      order: 10,
      priority: 100,
    },
    {
      id: 'surface.erase',
      familyId: 'surface',
      groupId: 'surface.erase',
      label: 'Eraser',
      icon: 'eraser',
      order: 20,
      priority: 90,
    },
    {
      id: 'surface.highlighter',
      familyId: 'surface',
      groupId: 'surface.highlighter',
      label: 'Highlighter',
      icon: 'highlighter',
      order: 15,
      priority: 95,
    },
    {
      id: 'surface.shapes',
      familyId: 'surface',
      groupId: 'surface.shapes',
      label: 'Shapes',
      icon: 'shapes',
      order: 40,
      priority: 70,
    },
    {
      id: 'surface.text',
      familyId: 'surface',
      groupId: 'surface.text',
      label: 'Text',
      icon: 'type',
      order: 45,
      priority: 55,
    },
    {
      id: 'surface.insert',
      familyId: 'surface',
      groupId: 'surface.insert',
      label: 'Insert',
      icon: 'plus',
      order: 50,
      priority: 60,
    },
    {
      id: 'writing.style',
      familyId: 'writing',
      groupId: 'writing.style',
      label: 'Style',
      icon: 'type',
      order: 10,
      priority: 100,
    },
    {
      id: 'writing.insert',
      familyId: 'writing',
      groupId: 'writing.insert',
      label: 'Insert',
      icon: 'plus',
      order: 30,
      priority: 70,
    },
    {
      id: 'writing.structure',
      familyId: 'writing',
      groupId: 'writing.structure',
      label: 'Structure',
      icon: 'list-tree',
      order: 40,
      priority: 60,
    },
    {
      id: 'pdf.pages',
      familyId: 'pdf',
      groupId: 'pdf.pages',
      label: 'Pages',
      icon: 'pages',
      order: 10,
      priority: 100,
    },
    {
      id: 'pdf.select',
      familyId: 'pdf',
      groupId: 'pdf.select',
      label: 'Select',
      icon: 'cursor',
      order: 20,
      priority: 80,
    },
    {
      id: 'pdf.annotate',
      familyId: 'pdf',
      groupId: 'pdf.annotate',
      label: 'Annotate',
      icon: 'ink',
      order: 30,
      priority: 70,
    },
  ];

const item = (
  id: string,
  categoryId: string,
  semanticRole: string,
  order: number,
  projections: ToolbarItemContribution['projections'] = [
    'normal',
    'compact',
    'squeeze',
  ],
  // Optional secondary-shelf slot identity. When absent, no fixed slot is
  // used and the item renders in verbatim composition order, keyed by item id.
  // Conditional spread keeps unslotted contributions byte-identical.
  slotId?: string,
): ToolbarItemContribution => ({
  id,
  categoryId,
  semanticRole,
  order,
  projections,
  ...(slotId !== undefined ? { slotId } : {}),
});

export const DEFAULT_TOOLBAR_ITEMS: readonly ToolbarItemContribution[] = [
  // Pen family: exactly the four `toolRole: 'pen'` conduits (four pen
  // slots). Highlighter owns its own primary category so it stays one tap
  // away even when the Pen shelf is compact.
  item(
    'surface.write.ball',
    'surface.write',
    'surface.pen.ball',
    10,
    undefined,
    'surface.slot.pen.ball',
  ),
  item(
    'surface.write.fountain',
    'surface.write',
    'surface.pen.fountain',
    20,
    undefined,
    'surface.slot.pen.fountain',
  ),
  item(
    'surface.write.brush',
    'surface.write',
    'surface.pen.brush',
    30,
    undefined,
    'surface.slot.pen.brush',
  ),
  item(
    'surface.write.pencil',
    'surface.write',
    'surface.pencil',
    40,
    undefined,
    'surface.slot.pen.pencil',
  ),
  item(
    'surface.write.highlighter',
    'surface.highlighter',
    'surface.highlighter',
    10,
  ),
  // Generic single-mode presenter for Surface providers that expose only
  // `surface.erase`. The shared Ink/Notebook/Whiteboard providers emit the
  // fixed-mode tools below; hosts without mode state still get a Stroke tool.
  item('surface.erase.tool', 'surface.erase', 'surface.erase', 10),
  // Two distinct secondary eraser tools with
  // fixed preset modes over the single eraser engine — Stroke (whole
  // strokes), Precision (swept ribbon). Add-only
  // (never a rename): distinct semantic roles so resolution never reports
  // a duplicate presenter and dormancy stays per-tool (each resolves only
  // when its provider control is emitted). Same normal/compact/squeeze
  // projections as the legacy erase tool.
  item('surface.erase.stroke', 'surface.erase', 'surface.erase.stroke', 11),
  item(
    'surface.erase.precision',
    'surface.erase',
    'surface.erase.precision',
    13,
  ),
  item('surface.select.object', 'surface.select', 'surface.select', 10),
  item('surface.select.lasso', 'surface.select', 'surface.lasso', 20),
  item('surface.shapes.line', 'surface.shapes', 'surface.shape.line', 10, [
    'normal',
    'compact',
    'squeeze',
  ]),
  item(
    'surface.shapes.rectangle',
    'surface.shapes',
    'surface.shape.rectangle',
    20,
  ),
  item('pdf.pages.previous', 'pdf.pages', 'pdf.page.previous', 10, [
    'normal',
    'compact',
  ]),
  item('pdf.pages.next', 'pdf.pages', 'pdf.page.next', 20, [
    'normal',
    'compact',
  ]),
  item('pdf.select.source', 'pdf.select', 'pdf.select.source', 10, [
    'normal',
    'compact',
  ]),
  item('pdf.annotate.notebook', 'pdf.annotate', 'pdf.annotate.notebook', 10, [
    'normal',
    'compact',
  ]),
  item('surface.shapes.ellipse', 'surface.shapes', 'surface.shape.ellipse', 30),
  item(
    'surface.shapes.triangle',
    'surface.shapes',
    'surface.shape.triangle',
    40,
  ),
  item('surface.shapes.diamond', 'surface.shapes', 'surface.shape.diamond', 50),
  // Insert text retired: creation lives only as
  // `surface.text.create` below (single presenter). The retired
  // `surface.insert.text` item id is never renamed or repurposed —
  // persisted overrides naming it stay unknown-ignored via the dual-hide
  // contract (hiding is per item id, never control-wide).
  item('surface.insert.image', 'surface.insert', 'surface.insert.image', 20),
  // Grouped surface text and direct creation use one presenter:
  // the `surface.text`
  // category always presents the Text creation tool (semanticRole
  // `surface.insert.text`, provider group `draw`, toolRole `text`) as its
  // leading item so the mainbar strip holds a DIRECT Text button with an
  // empty canvas for Ink/Notebook/Whiteboard — never one-browse-away via
  // Insert alone. Style/size/format/align/color/wrap resolve through the
  // same category + squeeze secondary tier and ride `float.selection`
  // contextually once emitted. Providers expose selected-text state when
  // available and otherwise the pending creation style, so formatting is
  // usable before placement. Never conflate on label `Text`, toolRole `text`, group `text`,
  // id substring `.text`, or icon `type`: creation identity is the exact
  // semanticRole `surface.insert.text` served from `surface.text` only;
  // style identity is the exact
  // roles `surface.text.*` served from `surface.text` only. Ink/Notebook/
  // Whiteboard share one presentation table behind their
  // `ink.text.*` / `notebook.text.*` / `whiteboard.text.*` dialects;
  // `froglight.card` text stays distinct.
  item('surface.text.create', 'surface.text', 'surface.insert.text', 0),
  item('writing.style.block', 'writing.style', 'writing.style', 10, [
    'normal',
    'compact',
  ]),
  item('writing.format.bold', 'writing.style', 'writing.bold', 20, [
    'normal',
    'compact',
  ]),
  item('writing.format.italic', 'writing.style', 'writing.italic', 30, [
    'normal',
    'compact',
  ]),
  item('writing.format.strike', 'writing.style', 'writing.strike', 40, [
    'normal',
    'compact',
  ]),
  item('writing.format.code', 'writing.style', 'writing.code', 50, [
    'normal',
    'compact',
  ]),
  item('writing.insert.link', 'writing.insert', 'writing.link', 10, [
    'normal',
    'compact',
  ]),
  item(
    'writing.insert.code-block',
    'writing.insert',
    'writing.code-block',
    20,
    ['normal', 'compact'],
  ),
  // Blockpage contracts: add-only
  // `writing.*` ids over the provider-exact semantic roles (`block.insert.*`
  // creation, `media.*` payloads, `math.*`/`diagram.*` sources; resolution
  // keys on semanticRole alone, never on id shapes). amendment
  // (repair): creation (`block.insert.*`) is shelf-only
  // (`normal`/`compact` projection, one-path) so it stays reachable with an
  // empty canvas; contextual edits (media/math/diagram below, table/columns
  // in `writing.structure`) stay `selection` projection only for the island
  // tasks to consume. Island consumers must not surface creation
  // at `float.selection`. Verbatim order: provider catalog order
  // (table/image/video/audio/file/math/diagram/columns), then media, then
  // math/diagram — all after the portable members above, which never move.
  // No `blockpage.*` category, item, or role exists.
  item('writing.insert.table', 'writing.insert', 'block.insert.table', 30, [
    'normal',
    'compact',
  ]),
  item('writing.insert.image', 'writing.insert', 'block.insert.image', 40, [
    'normal',
    'compact',
  ]),
  item('writing.insert.video', 'writing.insert', 'block.insert.video', 50, [
    'normal',
    'compact',
  ]),
  item('writing.insert.audio', 'writing.insert', 'block.insert.audio', 60, [
    'normal',
    'compact',
  ]),
  item('writing.insert.file', 'writing.insert', 'block.insert.file', 70, [
    'normal',
    'compact',
  ]),
  item('writing.insert.math', 'writing.insert', 'block.insert.math', 80, [
    'normal',
    'compact',
  ]),
  item('writing.insert.diagram', 'writing.insert', 'block.insert.diagram', 90, [
    'normal',
    'compact',
  ]),
  item('writing.insert.media.name', 'writing.insert', 'media.name', 110, [
    'selection',
  ]),
  item('writing.insert.media.caption', 'writing.insert', 'media.caption', 120, [
    'selection',
  ]),
  item('writing.insert.media.alt', 'writing.insert', 'media.alt', 130, [
    'selection',
  ]),
  item('writing.insert.media.replace', 'writing.insert', 'media.replace', 135, [
    'selection',
  ]),
  item(
    'writing.insert.media.remote-url',
    'writing.insert',
    'media.remoteUrl',
    140,
    ['selection'],
  ),
  item(
    'writing.insert.media.clear-remote',
    'writing.insert',
    'media.clearRemote',
    150,
    ['selection'],
  ),
  item('writing.insert.media.retry', 'writing.insert', 'media.retry', 160, [
    'selection',
  ]),
  item('writing.insert.math.source', 'writing.insert', 'math.source', 170, [
    'selection',
  ]),
  item('writing.insert.math.retry', 'writing.insert', 'math.retry', 180, [
    'selection',
  ]),
  item(
    'writing.insert.diagram.source',
    'writing.insert',
    'diagram.source',
    190,
    ['selection'],
  ),
  item('writing.insert.diagram.retry', 'writing.insert', 'diagram.retry', 200, [
    'selection',
  ]),
  item(
    'writing.structure.table.add-row',
    'writing.structure',
    'table.addRow',
    30,
    ['selection'],
  ),
  item(
    'writing.structure.table.add-column',
    'writing.structure',
    'table.addColumn',
    40,
    ['selection'],
  ),
  item(
    'writing.structure.table.remove-row',
    'writing.structure',
    'table.removeRow',
    50,
    ['selection'],
  ),
  item(
    'writing.structure.table.remove-column',
    'writing.structure',
    'table.removeColumn',
    60,
    ['selection'],
  ),
  item(
    'writing.structure.table.move-row-up',
    'writing.structure',
    'table.moveRowUp',
    70,
    ['selection'],
  ),
  item(
    'writing.structure.table.move-row-down',
    'writing.structure',
    'table.moveRowDown',
    80,
    ['selection'],
  ),
  item(
    'writing.structure.table.move-column-left',
    'writing.structure',
    'table.moveColumnLeft',
    90,
    ['selection'],
  ),
  item(
    'writing.structure.table.move-column-right',
    'writing.structure',
    'table.moveColumnRight',
    100,
    ['selection'],
  ),
  item(
    'writing.structure.table.toggle-header',
    'writing.structure',
    'table.toggleHeader',
    110,
    ['selection'],
  ),
  // decision: squeeze quick styles are composition-driven, not
  // free-floating quick state. These items project the exact style
  // semanticRoles the squeeze palette understands (quick-preferred plus
  // the settings fallbacks in `stylus-palette-model.ts`) into the squeeze
  // projection only. Squeeze-only is deliberate and reversible: the normal
  // / compact graphs are untouched, so the category strip and tool shelf
  // render exactly as before. may widen these projections when
  // the shelf/popover itself becomes composition-driven; until then the
  // palette additionally gates presentation by focusMode
  // (showColorPalette / showInkAttributes). Never infer membership from
  // item/control id shapes — resolution keys on semanticRole alone.
  // Size/color conduits for the fixed GoodNotes-style slots:
  // `surface.write.color` is the color family (two `null` placeholders pad
  // to three positions); `surface.write.width` + `surface.erase.size` are
  // the size family (one `null` placeholder pads to three). The saved-style
  // and settings fallbacks below stay unslotted verbatim — they are
  // squeeze-palette fallbacks gated by focusMode, not fixed shelf slots,
  // so slot order lists key on the primary conduits only.
  item(
    'surface.write.color',
    'surface.write',
    'surface.style.color',
    90,
    ['squeeze'],
    'surface.slot.color.pen',
  ),
  item(
    'surface.write.width',
    'surface.write',
    'surface.style.width',
    100,
    ['squeeze'],
    'surface.slot.size.width',
  ),
  item(
    'surface.write.saved-style',
    'surface.write',
    'surface.style.saved',
    110,
    ['squeeze'],
  ),
  item(
    'surface.write.settings-color',
    'surface.write',
    'surface.settings.color',
    120,
    ['squeeze'],
  ),
  item(
    'surface.write.settings-size',
    'surface.write',
    'surface.settings.size',
    130,
    ['squeeze'],
  ),
  item(
    'surface.erase.size',
    'surface.erase',
    'surface.erase.size',
    90,
    ['squeeze'],
    'surface.slot.size.eraser',
  ),
  item(
    'surface.erase.settings-size',
    'surface.erase',
    'surface.settings.eraser-size',
    100,
    ['squeeze'],
  ),
];

export const DEFAULT_TOOLBAR_KIND_EXTENSIONS: readonly ToolbarKindExtension[] =
  [
    {
      id: 'surface.ink',
      kindIds: ['froglight.ink'],
      familyIds: ['surface'],
    },
    {
      id: 'surface.notebook',
      kindIds: ['froglight.notebook'],
      familyIds: ['surface'],
      items: [
        // Notebook PDF insertion: source-PDF
        // before/after live in the shared `surface.insert` category so
        // clicking Insert shows them in the secondary shelf next to
        // image. Notebook-scoped ids/roles, gated provider-side by
        // `canInsertPdf` (disabled, never synthesized); families that
        // never emit these roles keep the items dormant. Never in
        // `notebook.pages` and never renamed.
        item(
          'notebook.insert.pdf.before',
          'surface.insert',
          'notebook.insert.pdf.before',
          30,
        ),
        item(
          'notebook.insert.pdf.after',
          'surface.insert',
          'notebook.insert.pdf.after',
          40,
        ),
      ],
    },
    {
      id: 'surface.whiteboard',
      kindIds: ['froglight.whiteboard'],
      familyIds: ['surface'],
      items: [
        item(
          'whiteboard.insert.card',
          'surface.insert',
          'surface.insert.card',
          30,
        ),
      ],
    },
    {
      id: 'writing.markdown',
      kindIds: ['froglight.markdown'],
      familyIds: ['writing'],
      items: [
        item(
          'markdown.style.quote',
          'writing.style',
          'markdown.block.quote',
          60,
        ),
        item(
          'markdown.style.bullet',
          'writing.style',
          'markdown.block.bullet',
          70,
        ),
        item(
          'markdown.style.numbered',
          'writing.style',
          'markdown.block.numbered',
          80,
        ),
        item('markdown.style.task', 'writing.style', 'markdown.block.task', 90),
        item(
          'writing.insert.note-link',
          'writing.insert',
          'markdown.insert.note-link',
          8,
          ['normal', 'compact'],
        ),
        item(
          'writing.insert.embed',
          'writing.insert',
          'markdown.insert.embed',
          9,
          ['normal', 'compact'],
        ),
        item(
          'writing.insert.import-image',
          'writing.insert',
          'markdown.insert.import-image',
          10,
          ['normal', 'compact'],
        ),
        item(
          'writing.insert.markdown-table',
          'writing.insert',
          'markdown.insert.table',
          3,
          ['normal', 'compact'],
        ),
        item(
          'markdown.insert.divider',
          'writing.insert',
          'markdown.insert.divider',
          40,
          ['normal', 'compact'],
        ),
      ],
    },
    {
      id: 'writing.blockpage',
      kindIds: ['froglight.blockpage'],
      familyIds: ['writing'],
    },
    {
      id: 'writing.latex',
      kindIds: ['froglight.latex'],
      familyIds: ['writing'],
      categories: [
        {
          id: 'latex.math',
          familyId: 'writing',
          groupId: 'latex.math',
          label: 'Math',
          icon: 'code',
          order: 50,
          priority: 70,
        },
        {
          id: 'latex.references',
          familyId: 'writing',
          groupId: 'latex.references',
          label: 'References',
          icon: 'link',
          order: 60,
          priority: 60,
        },
      ],
      items: [
        item('latex.math.inline', 'latex.math', 'latex.math.inline', 10, [
          'normal',
          'compact',
        ]),
        item('latex.math.display', 'latex.math', 'latex.math.display', 20, [
          'normal',
          'compact',
        ]),
        item(
          'latex.insert.itemize',
          'writing.insert',
          'latex.environment.itemize',
          30,
          ['normal', 'compact'],
        ),
        item(
          'latex.insert.enumerate',
          'writing.insert',
          'latex.environment.enumerate',
          31,
          ['normal', 'compact'],
        ),
        item(
          'latex.insert.quote',
          'writing.insert',
          'latex.environment.quote',
          32,
          ['normal', 'compact'],
        ),
        item(
          'latex.references.label',
          'latex.references',
          'latex.reference.label',
          10,
          ['normal', 'compact'],
        ),
        item(
          'latex.references.ref',
          'latex.references',
          'latex.reference.ref',
          20,
          ['normal', 'compact'],
        ),
        item(
          'latex.references.cite',
          'latex.references',
          'latex.reference.cite',
          30,
          ['normal', 'compact'],
        ),
      ],
    },
    { id: 'pdf.source', kindIds: ['froglight.pdf'], familyIds: ['pdf'] },
  ];

export function defaultToolbarComposition() {
  return {
    categories: DEFAULT_TOOLBAR_CATEGORIES,
    items: DEFAULT_TOOLBAR_ITEMS,
    extensions: DEFAULT_TOOLBAR_KIND_EXTENSIONS,
  } as const;
}
