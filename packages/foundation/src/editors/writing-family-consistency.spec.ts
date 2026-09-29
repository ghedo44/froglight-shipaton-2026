/**
 * Writing family convergence.
 *
 * Markdown, Block Page, and LaTeX share one Writing grammar for
 * Style/Format/Insert/Structure: identical semantic roles, icons, ordering,
 * and active/mixed/disabled grammar. Provider execution stays
 * provider-specific — this module owns presentation only, never command
 * routing. Providers alias (not copy) these tables so the three families
 * cannot drift into per-document vocabularies.
 *
 * Intentional omissions (never synthesized):
 * - Markdown emits no `writing.strike`: the CodeMirror Markdown parse tree
 *   has no strikethrough node, so provider-computed active/mixed state is
 *   unrepresentable. The composition item stays unresolved for Markdown.
 * - Block Page emits no `writing.code-block`: fenced code is a turn-into
 *   target of the shared `writing.style` selector, not a separate command.
 * - LaTeX emits no indent/outdent: source structure has no indent command.
 * - LaTeX keeps its `Emphasis` label for `writing.italic` (`\emph{}`
 *   semantics); role, icon, order, group, and activationRole still converge.
 */

import { describe, expect, it } from 'vitest';
import {
  WRITING_FORMAT_ORDER,
  WRITING_INSERT_ORDER,
  WRITING_STRUCTURE_ORDER,
  WRITING_STYLE_SEMANTIC_ROLE,
  writingCodeBlockControl,
  writingFormatToggleControl,
  writingIndentControl,
  writingLinkControl,
  writingOutdentControl,
  type SharedWritingFormatSlot,
} from './writing-toolbar-builder.js';

const FORMAT_SLOTS: readonly SharedWritingFormatSlot[] = [
  'bold',
  'italic',
  'strike',
  'code',
];

describe('writing family shared grammar', () => {
  it('keeps the canonical Style role stable', () => {
    expect(WRITING_STYLE_SEMANTIC_ROLE).toBe('writing.style');
  });

  it('orders Format as Bold, Italic, Strike, Inline code', () => {
    expect([...WRITING_FORMAT_ORDER]).toEqual([
      'bold',
      'italic',
      'strike',
      'code',
    ]);
  });

  it('orders Insert as Link, Code block', () => {
    expect([...WRITING_INSERT_ORDER]).toEqual(['link', 'code-block']);
  });

  it('orders Structure as Indent, Outdent', () => {
    expect([...WRITING_STRUCTURE_ORDER]).toEqual(['indent', 'outdent']);
  });

  it('shares one presentation per Format slot across provider dialects', () => {
    const expected = {
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
    } as const;
    for (const slot of FORMAT_SLOTS) {
      // Each provider keeps its own control id dialect
      // (`markdown.bold`, `block.bold`, `latex.bold`); presentation converges.
      const control = writingFormatToggleControl(`test.${slot}`, slot, {});
      if (control.kind !== 'button') throw new Error(`not a button: ${slot}`);
      expect(control.id).toBe(`test.${slot}`);
      expect(control.group).toBe('format');
      expect(control.label).toBe(expected[slot].label);
      expect(control.shortLabel).toBe(expected[slot].shortLabel);
      expect(control.icon).toBe(expected[slot].icon);
      expect(control.semanticRole).toBe(expected[slot].semanticRole);
      // Format toggles are never exclusive editing tools.
      expect(control.activationRole).toBe('toggle');
    }
  });

  it('passes provider-computed active/mixed/disabled through untouched', () => {
    const active = writingFormatToggleControl('test.bold', 'bold', {
      active: true,
    });
    if (active.kind !== 'button') throw new Error('not a button');
    expect(active.active).toBe(true);
    expect(active.mixed).toBeUndefined();
    expect(active.disabled).toBeUndefined();

    const mixed = writingFormatToggleControl('test.bold', 'bold', {
      mixed: true,
    });
    if (mixed.kind !== 'button') throw new Error('not a button');
    expect(mixed.active).toBeUndefined();
    expect(mixed.mixed).toBe(true);

    const disabled = writingFormatToggleControl('test.bold', 'bold', {
      disabled: true,
    });
    if (disabled.kind !== 'button') throw new Error('not a button');
    expect(disabled.disabled).toBe(true);

    // The builder never invents state: absent means absent, never false.
    const plain = writingFormatToggleControl('test.bold', 'bold', {});
    if (plain.kind !== 'button') throw new Error('not a button');
    expect('active' in plain).toBe(false);
    expect('mixed' in plain).toBe(false);
    expect('disabled' in plain).toBe(false);
  });

  it('supports the one documented LaTeX label exemption without forking the table', () => {
    const emphasis = writingFormatToggleControl(
      'latex.emphasis',
      'italic',
      {},
      { label: 'Emphasis' },
    );
    if (emphasis.kind !== 'button') throw new Error('not a button');
    expect(emphasis.label).toBe('Emphasis');
    // Everything else still converges with shared Italic.
    expect(emphasis.shortLabel).toBe('I');
    expect(emphasis.icon).toBe('italic');
    expect(emphasis.semanticRole).toBe('writing.italic');
    expect(emphasis.group).toBe('format');
    expect(emphasis.activationRole).toBe('toggle');
  });

  it('shares one Link presentation (compact popover trigger)', () => {
    const control = writingLinkControl('test.link', {});
    if (control.kind !== 'input') throw new Error('link is not an input');
    expect(control.group).toBe('insert');
    expect(control.label).toBe('Link destination');
    expect(control.placeholder).toBe('https://…');
    expect(control.actionLabel).toBe('Link');
    expect(control.icon).toBe('link');
    expect(control.semanticRole).toBe('writing.link');

    const prefilled = writingLinkControl('test.link', {
      value: 'https://froglight.test',
      active: true,
    });
    if (prefilled.kind !== 'input') throw new Error('link is not an input');
    expect(prefilled.value).toBe('https://froglight.test');
    expect(prefilled.active).toBe(true);
  });

  it('shares one Code block presentation', () => {
    const control = writingCodeBlockControl('test.code-block', {});
    if (control.kind !== 'button') throw new Error('not a button');
    expect(control.group).toBe('insert');
    expect(control.label).toBe('Code block');
    expect(control.shortLabel).toBe('Code block');
    expect(control.icon).toBe('code');
    expect(control.semanticRole).toBe('writing.code-block');
  });

  it('shares one Indent/Outdent presentation', () => {
    const indent = writingIndentControl('test.indent', {});
    if (indent.kind !== 'button') throw new Error('not a button');
    expect(indent.group).toBe('structure');
    expect(indent.label).toBe('Indent block');
    expect(indent.shortLabel).toBe('Indent');
    expect(indent.icon).toBe('indent');
    expect(indent.semanticRole).toBe('writing.indent');

    const outdent = writingOutdentControl('test.outdent', {
      disabled: true,
    });
    if (outdent.kind !== 'button') throw new Error('not a button');
    expect(outdent.group).toBe('structure');
    expect(outdent.label).toBe('Outdent block');
    expect(outdent.shortLabel).toBe('Outdent');
    expect(outdent.icon).toBe('outdent');
    expect(outdent.semanticRole).toBe('writing.outdent');
    expect(outdent.disabled).toBe(true);
  });
});
