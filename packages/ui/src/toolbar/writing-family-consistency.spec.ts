/**
 * Writing family composition convergence.
 *
 * Markdown, Block Page, and LaTeX share one Writing grammar for
 * Style/Format/Insert/Structure: identical categories, items, ordering, and
 * semantic roles. Provider execution stays provider-specific — resolution
 * keys on semanticRole alone, so equivalent provider controls resolve to
 * the same graph in every Writing family with no kindId branches in
 * presentation. Differences arrive through family membership and kind
 * extensions only.
 *
 * Intentional asymmetries (never synthesized):
 * - Markdown emits no `writing.strike` (no strikethrough node in the
 *   CodeMirror Markdown parse tree for provider-computed active/mixed).
 * - Block Page emits no `writing.code-block` (fenced code is a turn-into
 *   target of the shared `writing.style` selector).
 * - LaTeX emits no strike/code/link/code-block/indent/outdent (source
 *   transforms it does not perform); its Math/References/Diagnostics
 *   additions are additions-only.
 *
 * Synthetic scope (explicit): the family controls below are faithful
 * doubles, not the providers' real snapshots — `@froglight/ui` must not
 * import provider packages (layer direction: providers implement
 * capabilities, UI consumes contracts). The doubles mirror production
 * literals 1:1, and production wiring is proved provider-side:
 * - Markdown: `markdown-toggle.spec.ts` drives the real CodeMirror handle;
 * - Block Page: `editor.spec.ts` drives the real Tiptap handle;
 * - LaTeX: `latex.dom.spec.ts` deep-equals the real snapshot against the
 *   shared builder output (`writingFormatToggleControl`), including the
 *   documented `Emphasis` label exemption and the exact `latex.structure`
 *   choice below. Any production divergence fails loudly there.
 */
import { describe, expect, it } from 'vitest';
import {
  isExclusiveActiveToolControl,
  writingCodeBlockControl,
  writingFormatToggleControl,
  writingIndentControl,
  writingLinkControl,
  writingOutdentControl,
  type DocumentToolControl,
} from '@froglight/foundation';
import { resolveToolbarComposition } from './composition-registry.js';
import {
  DEFAULT_TOOLBAR_CATEGORIES,
  DEFAULT_TOOLBAR_ITEMS,
  DEFAULT_TOOLBAR_KIND_EXTENSIONS,
  defaultToolbarComposition,
} from './default-composition.js';

/** Portable controls per family, mirroring each provider's snapshot. */
function familyControls(
  family: 'markdown' | 'blockpage' | 'latex',
): DocumentToolControl[] {
  const styleChoice = (
    id: string,
    value: string,
    options: { value: string; label: string }[],
  ): DocumentToolControl => ({
    kind: 'choice',
    id,
    group: 'block',
    label: 'Style',
    semanticRole: 'writing.style',
    value,
    options,
  });
  if (family === 'markdown') {
    return [
      styleChoice('markdown.block', 'paragraph', [
        { value: 'paragraph', label: 'Paragraph' },
        { value: 'heading:1', label: 'Heading 1' },
        { value: 'quote', label: 'Quote' },
      ]),
      writingFormatToggleControl('markdown.bold', 'bold', { active: true }),
      writingFormatToggleControl('markdown.italic', 'italic', {
        mixed: true,
      }),
      writingFormatToggleControl('markdown.code', 'code', { disabled: true }),
      writingLinkControl('markdown.link', {
        value: 'https://froglight.test',
        active: true,
      }),
      writingCodeBlockControl('markdown.code-block', {}),
    ];
  }
  if (family === 'blockpage') {
    return [
      styleChoice('block.type', 'paragraph', [
        { value: 'paragraph', label: 'Paragraph' },
        { value: 'heading:1', label: 'Heading 1' },
        { value: 'quote', label: 'Quote' },
      ]),
      writingFormatToggleControl('block.bold', 'bold', { active: true }),
      writingFormatToggleControl('block.italic', 'italic', { mixed: true }),
      writingFormatToggleControl('block.strike', 'strike', {}),
      writingFormatToggleControl('block.code', 'code', { disabled: true }),
      writingLinkControl('block.link', {
        value: 'https://froglight.test',
        active: true,
      }),
      writingIndentControl('block.indent', {}),
      writingOutdentControl('block.outdent', { disabled: true }),
    ];
  }
  return [
    // Production-exact `latex.structure` literal (group `structure`, label
    // `Structure`, full section options) — pinned provider-side by the
    // shared-builder deep-equal test in `latex.dom.spec.ts`.
    {
      kind: 'choice',
      id: 'latex.structure',
      group: 'structure',
      label: 'Structure',
      semanticRole: 'writing.style',
      value: '',
      options: [
        { value: '', label: 'Structure…' },
        { value: 'section', label: 'Section' },
        { value: 'subsection', label: 'Subsection' },
        { value: 'subsubsection', label: 'Subsubsection' },
      ],
    } as DocumentToolControl,
    writingFormatToggleControl('latex.bold', 'bold', {}),
    // Mirrors the production builder call including the documented
    // `Emphasis` label exemption.
    writingFormatToggleControl(
      'latex.emphasis',
      'italic',
      {},
      { label: 'Emphasis' },
    ),
    {
      kind: 'button',
      id: 'latex.inline-math',
      group: 'math',
      label: 'Inline math',
      shortLabel: '$x$',
      semanticRole: 'latex.math.inline',
    },
    {
      kind: 'button',
      id: 'latex.display-math',
      group: 'math',
      label: 'Display math',
      shortLabel: '\\[x\\]',
      semanticRole: 'latex.math.display',
    },
    {
      kind: 'choice',
      id: 'latex.environment',
      group: 'insert',
      label: 'Environment',
      value: '',
      options: [{ value: '', label: 'Environment…' }],
      semanticRole: 'latex.environment',
    },
    {
      kind: 'input',
      id: 'latex.label',
      group: 'references',
      label: 'Label name',
      placeholder: 'label-key',
      actionLabel: 'Label',
      semanticRole: 'latex.reference.label',
    },
    {
      kind: 'input',
      id: 'latex.ref',
      group: 'references',
      label: 'Reference label',
      placeholder: 'label-key',
      actionLabel: 'Ref',
      semanticRole: 'latex.reference.ref',
    },
    {
      kind: 'input',
      id: 'latex.cite',
      group: 'references',
      label: 'Citation key',
      placeholder: 'citation-key',
      actionLabel: 'Cite',
      semanticRole: 'latex.reference.cite',
    },
  ];
}

const KIND_IDS = {
  markdown: 'froglight.markdown',
  blockpage: 'froglight.blockpage',
  latex: 'froglight.latex',
} as const;

function resolveFor(family: keyof typeof KIND_IDS) {
  return resolveToolbarComposition({
    snapshot: defaultToolbarComposition(),
    kindId: KIND_IDS[family],
    controls: familyControls(family),
  });
}

describe('writing family composition convergence', () => {
  it('resolves identical shared categories for Markdown, Block Page, and LaTeX', () => {
    for (const family of ['markdown', 'blockpage', 'latex'] as const) {
      expect(resolveFor(family).diagnostics).toEqual([]);
    }
    const strip = (family: keyof typeof KIND_IDS, id: string): unknown => {
      const category = resolveFor(family).categories.find(
        (entry) => entry.id === id,
      );
      return (
        category && {
          label: category.label,
          icon: category.icon,
          order: category.order,
        }
      );
    };
    // Style includes formatting in all three families. Insert and Structure resolve only where the
    // provider supports at least one portable item — the resolver omits
    // empty categories so no empty shelf ever renders — but the category
    // definitions themselves stay shared (asserted below).
    for (const id of ['writing.style']) {
      expect(strip('blockpage', id), id).toEqual(strip('markdown', id));
      expect(strip('latex', id), id).toEqual(strip('markdown', id));
      expect(strip('markdown', id), id).not.toBeNull();
    }
    expect(strip('blockpage', 'writing.insert')).toEqual(
      strip('markdown', 'writing.insert'),
    );
    expect(strip('markdown', 'writing.insert')).not.toBeNull();
    expect(strip('blockpage', 'writing.structure')).not.toBeNull();
    // One shared definition per category in the defaults: no per-kind
    // category branches exist for families that currently resolve empty.
    const defined = new Map(
      DEFAULT_TOOLBAR_CATEGORIES.filter((entry) =>
        entry.id.startsWith('writing.'),
      ).map((entry) => [
        entry.id,
        { label: entry.label, icon: entry.icon, order: entry.order },
      ]),
    );
    expect([...defined.keys()]).toEqual([
      'writing.style',
      'writing.insert',
      'writing.structure',
    ]);
    expect(strip('markdown', 'writing.style')).toEqual(
      defined.get('writing.style'),
    );
    expect(strip('markdown', 'writing.insert')).toEqual(
      defined.get('writing.insert'),
    );
    expect(strip('blockpage', 'writing.structure')).toEqual(
      defined.get('writing.structure'),
    );
  });

  it('orders portable Format roles identically wherever supported', () => {
    const roles = (family: keyof typeof KIND_IDS): readonly string[] =>
      resolveFor(family)
        .categories.find((entry) => entry.id === 'writing.style')
        ?.items.map((item) => item.semanticRole)
        .filter((role) => role !== 'writing.style') ?? [];
    // Markdown omits strike (unsupported): the shared order still holds for
    // every role each family actually supports — nothing is reordered.
    expect(roles('markdown')).toEqual([
      'writing.bold',
      'writing.italic',
      'writing.code',
    ]);
    expect(roles('blockpage')).toEqual([
      'writing.bold',
      'writing.italic',
      'writing.strike',
      'writing.code',
    ]);
    expect(roles('latex')).toEqual(['writing.bold', 'writing.italic']);
  });

  it('shares Insert and Structure ordering across families', () => {
    const roles = (
      family: keyof typeof KIND_IDS,
      categoryId: string,
    ): readonly string[] =>
      resolveFor(family)
        .categories.find((entry) => entry.id === categoryId)
        ?.items.map((item) => item.semanticRole) ?? [];
    expect(roles('markdown', 'writing.insert')).toEqual([
      'writing.link',
      'writing.code-block',
    ]);
    // Block Page links through the shared role; fenced code stays a
    // style-selector target, so only the link resolves here.
    expect(roles('blockpage', 'writing.insert')).toEqual(['writing.link']);
    // LaTeX environments are LaTeX-specific additions, not the generic
    // code block — portable Insert stays empty for LaTeX.
    expect(roles('latex', 'writing.insert')).toEqual([]);
    expect(roles('blockpage', 'writing.structure')).toEqual([
      'writing.indent',
      'writing.outdent',
    ]);
    expect(roles('markdown', 'writing.structure')).toEqual([]);
    expect(roles('latex', 'writing.structure')).toEqual([]);
  });

  it('leaves unsupported portable roles unresolved instead of synthesizing them', () => {
    expect(resolveFor('markdown').unresolved).toContain(
      'writing.format.strike',
    );
    expect(resolveFor('markdown').unresolved).toContain(
      'writing.structure.indent',
    );
    expect(resolveFor('markdown').unresolved).toContain(
      'writing.structure.outdent',
    );
    expect(resolveFor('blockpage').unresolved).toContain(
      'writing.insert.code-block',
    );
    expect(resolveFor('latex').unresolved).toContain('writing.format.strike');
    expect(resolveFor('latex').unresolved).toContain(
      'writing.insert.code-block',
    );
    expect(resolveFor('latex').unresolved).toContain(
      'writing.structure.indent',
    );
  });

  it('keeps provider-computed active/mixed/disabled flags intact through resolution', () => {
    const find = (
      family: keyof typeof KIND_IDS,
      categoryId: string,
      semanticRole: string,
    ): DocumentToolControl => {
      const graph = resolveFor(family);
      const item = graph.categories
        .find((entry) => entry.id === categoryId)
        ?.items.find((entry) => entry.semanticRole === semanticRole);
      if (item === undefined) throw new Error(`unresolved ${semanticRole}`);
      return item.control;
    };
    // Active/mixed/disabled grammar is consistent: the same role carries
    // the same flags in every family that supports it.
    const markdownBold = find('markdown', 'writing.style', 'writing.bold');
    const blockBold = find('blockpage', 'writing.style', 'writing.bold');
    expect(markdownBold.kind).toBe('button');
    expect(blockBold.kind).toBe('button');
    if (markdownBold.kind === 'button' && blockBold.kind === 'button') {
      expect(markdownBold.active).toBe(true);
      expect(blockBold.active).toBe(true);
      expect(markdownBold.activationRole).toBe('toggle');
      expect(blockBold.activationRole).toBe('toggle');
    }
    const markdownItalic = find('markdown', 'writing.style', 'writing.italic');
    const blockItalic = find('blockpage', 'writing.style', 'writing.italic');
    if (markdownItalic.kind === 'button' && blockItalic.kind === 'button') {
      expect(markdownItalic.mixed).toBe(true);
      expect(blockItalic.mixed).toBe(true);
      expect(markdownItalic.active).toBeUndefined();
      expect(blockItalic.active).toBeUndefined();
    }
    const markdownCode = find('markdown', 'writing.style', 'writing.code');
    const blockCode = find('blockpage', 'writing.style', 'writing.code');
    if (markdownCode.kind === 'button' && blockCode.kind === 'button') {
      expect(markdownCode.disabled).toBe(true);
      expect(blockCode.disabled).toBe(true);
    } else {
      throw new Error('code controls must stay buttons');
    }
    const blockOutdent = find(
      'blockpage',
      'writing.structure',
      'writing.outdent',
    );
    if (blockOutdent.kind !== 'button')
      throw new Error('outdent control must stay a button');
    expect(blockOutdent.disabled).toBe(true);
    const markdownLink = find('markdown', 'writing.insert', 'writing.link');
    const blockLink = find('blockpage', 'writing.insert', 'writing.link');
    if (markdownLink.kind === 'input' && blockLink.kind === 'input') {
      expect(markdownLink.value).toBe('https://froglight.test');
      expect(blockLink.value).toBe('https://froglight.test');
      expect(markdownLink.active).toBe(true);
      expect(blockLink.active).toBe(true);
    } else {
      throw new Error('link controls must stay compact inputs');
    }
  });

  it('keeps writing format toggles out of exclusive-tool reconciliation', () => {
    for (const family of ['markdown', 'blockpage', 'latex'] as const) {
      for (const control of familyControls(family)) {
        if (
          control.kind === 'button' &&
          control.semanticRole?.startsWith('writing.') === true &&
          (control.semanticRole === 'writing.bold' ||
            control.semanticRole === 'writing.italic' ||
            control.semanticRole === 'writing.strike' ||
            control.semanticRole === 'writing.code')
        ) {
          expect(control.activationRole).toBe('toggle');
          expect(
            isExclusiveActiveToolControl({
              ...control,
              active: true,
            }),
          ).toBe(false);
        }
      }
    }
  });

  it('keeps LaTeX kind extensions additions-only', () => {
    const baseCategoryIds = new Set(
      DEFAULT_TOOLBAR_CATEGORIES.map((entry) => entry.id),
    );
    const baseItemIds = new Set(DEFAULT_TOOLBAR_ITEMS.map((entry) => entry.id));
    const latex = DEFAULT_TOOLBAR_KIND_EXTENSIONS.find(
      (entry) => entry.id === 'writing.latex',
    );
    if (latex === undefined) throw new Error('missing writing.latex extension');
    for (const category of latex.categories ?? []) {
      expect(
        baseCategoryIds.has(category.id),
        `writing.latex redefines category ${category.id}`,
      ).toBe(false);
      expect(category.familyId).toBe('writing');
    }
    for (const item of latex.items ?? []) {
      expect(
        baseItemIds.has(item.id),
        `writing.latex overrides item ${item.id}`,
      ).toBe(false);
      const ownCategories = new Set(
        (latex.categories ?? []).map((entry) => entry.id),
      );
      expect(
        baseCategoryIds.has(item.categoryId) ||
          ownCategories.has(item.categoryId),
        `${item.id} targets ${item.categoryId}`,
      ).toBe(true);
    }
    // The documented LaTeX additions: Math + References only.
    expect(latex.categories?.map((entry) => entry.id)).toEqual([
      'latex.math',
      'latex.references',
    ]);
    expect(latex.items?.map((entry) => entry.semanticRole)).toEqual([
      'latex.math.inline',
      'latex.math.display',
      'latex.environment.itemize',
      'latex.environment.enumerate',
      'latex.environment.quote',
      'latex.reference.label',
      'latex.reference.ref',
      'latex.reference.cite',
    ]);
    // Markdown and Block Page contribute no kind-specific categories or
    // items: every difference between them arrives through provider
    // controls, never through composition branches.
    for (const id of ['writing.blockpage']) {
      const extension = DEFAULT_TOOLBAR_KIND_EXTENSIONS.find(
        (entry) => entry.id === id,
      );
      expect(extension?.categories ?? []).toEqual([]);
      expect(extension?.items ?? []).toEqual([]);
    }
    expect(
      DEFAULT_TOOLBAR_KIND_EXTENSIONS.find(
        (entry) => entry.id === 'writing.markdown',
      )?.items?.map((item) => item.id),
    ).toEqual([
      'markdown.style.quote',
      'markdown.style.bullet',
      'markdown.style.numbered',
      'markdown.style.task',
      'writing.insert.note-link',
      'writing.insert.embed',
      'writing.insert.import-image',
      'writing.insert.markdown-table',
      'markdown.insert.divider',
    ]);
  });

  it('resolves LaTeX Math and References only for LaTeX', () => {
    const latex = resolveFor('latex');
    expect(
      latex.categories
        .find((entry) => entry.id === 'latex.math')
        ?.items.map((item) => item.semanticRole),
    ).toEqual(['latex.math.inline', 'latex.math.display']);
    expect(
      latex.categories
        .find((entry) => entry.id === 'latex.references')
        ?.items.map((item) => item.semanticRole),
    ).toEqual([
      'latex.reference.label',
      'latex.reference.ref',
      'latex.reference.cite',
    ]);
    for (const family of ['markdown', 'blockpage'] as const) {
      const graph = resolveFor(family);
      expect(graph.categories.some((entry) => entry.id === 'latex.math')).toBe(
        false,
      );
      expect(
        graph.categories.some((entry) => entry.id === 'latex.references'),
      ).toBe(false);
    }
  });
});

describe('PDF annotation controls fit the shared writing composition', () => {
  it('keeps standalone PDF in its own family: Pages, Select, Annotate', () => {
    const graph = resolveToolbarComposition({
      snapshot: defaultToolbarComposition(),
      kindId: 'froglight.pdf',
      controls: [
        {
          kind: 'button',
          id: 'pdf.previous',
          group: 'pages',
          label: 'Previous PDF page',
          shortLabel: 'Previous',
          icon: 'arrow-back',
          semanticRole: 'pdf.page.previous',
        },
        {
          kind: 'button',
          id: 'pdf.next',
          group: 'pages',
          label: 'Next PDF page',
          shortLabel: 'Next',
          icon: 'arrow-forward',
          semanticRole: 'pdf.page.next',
        },
        {
          kind: 'button',
          id: 'pdf.source-select',
          group: 'interaction',
          label: 'Select and copy source text',
          shortLabel: 'Source Select',
          icon: 'cursor',
          semanticRole: 'pdf.select.source',
          activationRole: 'toggle',
          active: true,
        },
        {
          kind: 'button',
          id: 'pdf.import-notebook',
          group: 'document',
          label: 'Annotate / Import as Notebook',
          shortLabel: 'Annotate',
          icon: 'notebook',
          semanticRole: 'pdf.annotate.notebook',
        },
      ],
    });
    expect(graph.diagnostics).toEqual([]);
    const roles = (categoryId: string): readonly string[] =>
      graph.categories
        .find((entry) => entry.id === categoryId)
        ?.items.map((item) => item.semanticRole) ?? [];
    expect(roles('pdf.pages')).toEqual(['pdf.page.previous', 'pdf.page.next']);
    expect(roles('pdf.select')).toEqual(['pdf.select.source']);
    expect(roles('pdf.annotate')).toEqual(['pdf.annotate.notebook']);
    // Deferral (explicit): annotation editing converges through Notebook
    // import (`pdf.annotate.notebook`, overlay), not by merging
    // PDF into the Surface family. No Surface role resolves for PDF and no
    // Writing role resolves for PDF.
    expect(graph.categories.some((entry) => entry.familyId === 'surface')).toBe(
      false,
    );
    expect(graph.categories.some((entry) => entry.familyId === 'writing')).toBe(
      false,
    );
    // The source-text mode toggle never drives exclusive-tool
    // reconciliation, even while active.
    const select = graph.categories
      .find((entry) => entry.id === 'pdf.select')
      ?.items.find((item) => item.semanticRole === 'pdf.select.source');
    if (select === undefined) throw new Error('missing pdf.select.source');
    expect(isExclusiveActiveToolControl(select.control)).toBe(false);
  });
});
