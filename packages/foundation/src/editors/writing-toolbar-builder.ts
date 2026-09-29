/**
 * Shared Writing toolbar grammar.
 *
 * Markdown, Block Page, and LaTeX providers expose the same Writing activity
 * (Style selector, Format toggles, Link/Code-block insertion, Indent/Outdent
 * structure) through three separately maintained Document Tools snapshots.
 * This module owns that shareable presentation subset behind the
 * provider-neutral Document Tools seam: one place for control shapes
 * (label, icon, group, semantic role, activation role) and canonical
 * ordering, with provider-owned control ids and provider-computed
 * active/mixed/disabled state passed in at each call site.
 *
 * Provider execution stays provider-specific: this module performs no
 * commands and interprets no editor state. Family-specific controls stay
 * provider-local: LaTeX Math/Environments/References/Citations/Diagnostics,
 * Markdown task-list options, and Block Page toggle/callout options never
 * enter this builder. No DOM or engine types cross it.
 */

import type { DocumentToolControl } from './tools.js';

/** The one Style selector role shared by Markdown, Block Page, and LaTeX. */
export const WRITING_STYLE_SEMANTIC_ROLE = 'writing.style';

/**
 * Canonical Format slot: one entry per shared Format grammar toggle.
 * Providers map their own control ids onto these slots; presentation
 * (label, icon, group, semantic role, activation role) and ordering come
 * from the shared table below, never from per-family literals.
 */
export type SharedWritingFormatSlot = 'bold' | 'italic' | 'strike' | 'code';

interface SharedWritingFormatPresentation {
  readonly label: string;
  readonly shortLabel: string;
  readonly icon: string;
  readonly semanticRole: string;
}

/**
 * Canonical Format presentation + ordering. Order
 * follows the shared composition category (Bold, Italic, Strike,
 * Inline code) so snapshot order, shelf order, and composition order agree
 * across Markdown, Block Page, and LaTeX.
 *
 * Icons use only approved registry names shared with the UI icon set.
 */
const SHARED_WRITING_FORMAT_TABLE: Record<
  SharedWritingFormatSlot,
  SharedWritingFormatPresentation
> = {
  bold: {
    label: 'Bold',
    shortLabel: 'B',
    icon: 'bold',
    semanticRole: 'writing.bold',
  },
  italic: {
    label: 'Italic',
    shortLabel: 'I',
    icon: 'italic',
    semanticRole: 'writing.italic',
  },
  strike: {
    label: 'Strikethrough',
    shortLabel: 'S',
    icon: 'strikethrough',
    semanticRole: 'writing.strike',
  },
  code: {
    label: 'Inline code',
    shortLabel: 'Code',
    icon: 'code',
    semanticRole: 'writing.code',
  },
};

/** Canonical Format slot order: Bold, Italic, Strike, Inline code. */
export const WRITING_FORMAT_ORDER: readonly SharedWritingFormatSlot[] = [
  'bold',
  'italic',
  'strike',
  'code',
];

/** Canonical Insert slot order: Link, Code block. */
export const WRITING_INSERT_ORDER = ['link', 'code-block'] as const;
export type SharedWritingInsertSlot = (typeof WRITING_INSERT_ORDER)[number];

/** Canonical Structure slot order: Indent, Outdent. */
export const WRITING_STRUCTURE_ORDER = ['indent', 'outdent'] as const;
export type SharedWritingStructureSlot =
  (typeof WRITING_STRUCTURE_ORDER)[number];

/**
 * Provider-computed toggle state for one Format control. The provider is
 * the sole interpreter of caret/selection/source syntax; the builder only
 * carries the flags into the control shape. Absent means unclaimed — the
 * builder never defaults active/mixed/disabled itself.
 */
export interface WritingToggleState {
  readonly active?: boolean;
  readonly mixed?: boolean;
  readonly disabled?: boolean;
}

/**
 * Presentation options for one Format control. The only supported override
 * is the documented LaTeX exemption below; every other family uses the
 * canonical table verbatim.
 */
export interface WritingFormatPresentationOptions {
  /**
   * Explicit label override. Exemption: LaTeX `\emph{}` keeps
   * `Emphasis` instead of the canonical `Italic` because the command is
   * semantic emphasis, not an italic typeface switch. Role, icon, order,
   * group, and activationRole still converge; the override is pinned by
   * `latex.dom.spec.ts` so it cannot drift silently.
   */
  readonly label?: string;
}

function toggleFlags(state: WritingToggleState): {
  readonly active?: true;
  readonly mixed?: true;
  readonly disabled?: true;
} {
  return {
    ...(state.active === true ? { active: true as const } : {}),
    ...(state.mixed === true ? { mixed: true as const } : {}),
    ...(state.disabled === true ? { disabled: true as const } : {}),
  };
}

/**
 * Build one shared Format toggle from a provider-owned control id and the
 * provider-computed toggle state. Format toggles are never exclusive
 * editing tools, so every control carries `activationRole: 'toggle'`.
 */
export function writingFormatToggleControl(
  id: string,
  slot: SharedWritingFormatSlot,
  state: WritingToggleState,
  options: WritingFormatPresentationOptions = {},
): DocumentToolControl {
  const presentation = SHARED_WRITING_FORMAT_TABLE[slot];
  return {
    kind: 'button',
    id,
    group: 'format',
    label: options.label ?? presentation.label,
    shortLabel: presentation.shortLabel,
    icon: presentation.icon,
    semanticRole: presentation.semanticRole,
    activationRole: 'toggle',
    ...toggleFlags(state),
  };
}

/** Provider-computed Link state (existing-target prefill, caret-in-link). */
export interface WritingLinkState {
  readonly value?: string;
  readonly active?: boolean;
  readonly disabled?: boolean;
}

/**
 * Build the shared Link popover trigger. Every Writing family submits
 * through the same compact `input` contract; the provider owns whether
 * selected text is wrapped, an existing target is edited, or insertion is
 * rejected.
 */
export function writingLinkControl(
  id: string,
  state: WritingLinkState,
): DocumentToolControl {
  return {
    kind: 'input',
    id,
    group: 'insert',
    label: 'Link destination',
    placeholder: 'https://…',
    actionLabel: 'Link',
    icon: 'link',
    semanticRole: 'writing.link',
    ...(state.value !== undefined ? { value: state.value } : {}),
    ...(state.active === true ? { active: true as const } : {}),
    ...(state.disabled === true ? { disabled: true as const } : {}),
  };
}

/**
 * Build the shared generic code-block insertion control. Only families
 * with a genuine code-block command emit it; others omit the role and the
 * composition item stays unresolved (never synthesized).
 */
export function writingCodeBlockControl(
  id: string,
  state: { readonly disabled?: boolean },
): DocumentToolControl {
  return {
    kind: 'button',
    id,
    group: 'insert',
    label: 'Code block',
    shortLabel: 'Code block',
    icon: 'code',
    semanticRole: 'writing.code-block',
    ...(state.disabled === true ? { disabled: true as const } : {}),
  };
}

/**
 * Build the shared Indent/Outdent structure controls. Only families with a
 * genuine indent model emit them; others omit the roles and the composition
 * items stay unresolved (never synthesized).
 */
export function writingIndentControl(
  id: string,
  state: { readonly disabled?: boolean },
): DocumentToolControl {
  return {
    kind: 'button',
    id,
    group: 'structure',
    label: 'Indent block',
    shortLabel: 'Indent',
    icon: 'indent',
    semanticRole: 'writing.indent',
    ...(state.disabled === true ? { disabled: true as const } : {}),
  };
}

export function writingOutdentControl(
  id: string,
  state: { readonly disabled?: boolean },
): DocumentToolControl {
  return {
    kind: 'button',
    id,
    group: 'structure',
    label: 'Outdent block',
    shortLabel: 'Outdent',
    icon: 'outdent',
    semanticRole: 'writing.outdent',
    ...(state.disabled === true ? { disabled: true as const } : {}),
  };
}
