// @vitest-environment jsdom
/**
 * Writing presentation parity.
 *
 * Portable Writing roles share presentation across Markdown, Block Page,
 * and LaTeX: the same semantic role renders the same accessible name,
 * icon, and active/mixed/disabled grammar no matter which provider owns
 * execution. Differences arrive through family membership and
 * contributions — there are no kindId branches in this renderer.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  writingFormatToggleControl,
  writingLinkControl,
  type DocumentToolControl,
} from '@froglight/foundation';
import { renderControl } from './tool-controls.jsx';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let hosts: HTMLElement[] = [];
let roots: Root[] = [];
afterEach(() => {
  for (const root of roots) root.unmount();
  roots = [];
  for (const host of hosts) host.remove();
  hosts = [];
});

async function mount(control: DocumentToolControl): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  hosts.push(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(renderControl(control, () => undefined));
  });
  return host;
}

function latexEmphasis(): DocumentToolControl {
  // Mirrors the production builder call in `latex.ts`: `\emph{}` keeps its
  // label through the documented exemption while role, icon, group, and
  // activationRole converge with shared Italic.
  return writingFormatToggleControl(
    'latex.emphasis',
    'italic',
    {},
    { label: 'Emphasis' },
  );
}

describe('writing presentation parity', () => {
  it('shows semantic command icons while retaining accessible names', async () => {
    for (const [id, label, icon] of [
      ['markdown.divider', 'Divider', 'divider'],
      ['block.insert.table', 'Insert table', 'table'],
      ['block.insert.audio', 'Insert audio', 'file-audio'],
      ['block.insert.math', 'Insert math', 'math'],
      ['ink.text.wrap', 'Wrap text', 'wrap'],
    ] as const) {
      const host = await mount({
        kind: 'button',
        id,
        label,
        group: 'insert',
        ...(id === 'ink.text.wrap'
          ? { semanticRole: 'surface.text.wrap' }
          : {}),
        ...(id === 'markdown.divider'
          ? { semanticRole: 'markdown.insert.divider' }
          : {}),
      });
      const trigger = host.querySelector(`button[aria-label="${label}"]`);
      expect(
        trigger?.querySelector('svg')?.classList.contains(`icon-${icon}`),
        id,
      ).toBe(true);
      expect(trigger?.textContent, id).toBe('');
      expect(trigger?.getAttribute('title'), id).toBe(label);
    }
  });

  it('gives built-in selectors a compact icon and a named select', async () => {
    for (const [id, label, icon, semanticRole] of [
      ['markdown.block', 'Line style', 'heading', 'writing.style'],
      [
        'notebook.orientation',
        'Orientation',
        'rotate',
        'notebook.page.orientation',
      ],
      ['pdf.outline', 'PDF outline', 'list-tree', undefined],
    ] as const) {
      const host = await mount({
        kind: 'choice',
        id,
        label,
        group: 'style',
        value: '',
        options: [{ value: '', label: 'Choose' }],
        ...(semanticRole === undefined ? {} : { semanticRole }),
      });
      expect(
        host.querySelector(`select[aria-label="${label}"]`),
        id,
      ).not.toBeNull();
      expect(host.querySelector(`svg.icon-${icon}`), id).not.toBeNull();
    }
  });

  it('keeps numeric values editable beside an icon instead of a label', async () => {
    const host = await mount({
      kind: 'number',
      id: 'notebook.page-width',
      group: 'page-size',
      label: 'Page width',
      semanticRole: 'notebook.page.width',
      value: 800,
    });
    expect(host.querySelector('svg.icon-width')).not.toBeNull();
    expect(host.querySelector('label')?.textContent).toBe('');
    expect(
      host
        .querySelector('input[aria-label="Page width"]')
        ?.getAttribute('value'),
    ).toBe('800');
  });

  it('renders Bold identically for all three provider dialects', async () => {
    for (const id of ['markdown.bold', 'block.bold', 'latex.bold']) {
      const host = await mount(writingFormatToggleControl(id, 'bold', {}));
      const button = host.querySelector('button[aria-label="Bold"]');
      expect(button, id).not.toBeNull();
      expect(
        button?.querySelector('svg')?.classList.contains('icon-bold'),
        id,
      ).toBe(true);
      // Unclaimed state renders no aria-pressed at all (never "false"):
      // the provider did not prove active or mixed.
      expect(button?.hasAttribute('aria-pressed'), id).toBe(false);
    }
  });

  it('exposes mixed formatting as aria-pressed="mixed" in every dialect', async () => {
    for (const [id, slot] of [
      ['markdown.italic', 'italic'],
      ['block.italic', 'italic'],
    ] as const) {
      const host = await mount(
        writingFormatToggleControl(id, slot, { mixed: true }),
      );
      const button = host.querySelector('button[aria-label="Italic"]');
      expect(button?.getAttribute('aria-pressed'), id).toBe('mixed');
      expect(button?.hasAttribute('disabled'), id).toBe(false);
    }
  });

  it('exposes active and disabled identically in every dialect', async () => {
    const activeHost = await mount(
      writingFormatToggleControl('block.strike', 'strike', { active: true }),
    );
    expect(
      activeHost
        .querySelector('button[aria-label="Strikethrough"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');

    for (const id of ['markdown.code', 'block.code']) {
      const host = await mount(
        writingFormatToggleControl(id, 'code', { disabled: true }),
      );
      const button = host.querySelector('button[aria-label="Inline code"]');
      expect((button as HTMLButtonElement | null)?.disabled, id).toBe(true);
    }
  });

  it('renders Link popover triggers identically for Markdown and Block Page', async () => {
    for (const id of ['markdown.link', 'block.link']) {
      const host = await mount(writingLinkControl(id, {}));
      const trigger = host.querySelector(
        'button[aria-label="Link destination"]',
      );
      expect(trigger, id).not.toBeNull();
      expect(
        trigger?.querySelector('svg')?.classList.contains('icon-link'),
      ).toBe(true);
      expect(trigger?.getAttribute('aria-haspopup')).toBe('dialog');
    }
  });

  it('keeps the LaTeX Emphasis label while sharing Italic role and icon', async () => {
    const host = await mount(latexEmphasis());
    const button = host.querySelector('button[aria-label="Emphasis"]');
    expect(button).not.toBeNull();
    expect(
      button?.querySelector('svg')?.classList.contains('icon-italic'),
    ).toBe(true);
  });
});
