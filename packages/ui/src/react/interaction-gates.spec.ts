// @vitest-environment jsdom
/**
 *  interaction closure gates (touch targets, visible focus)
 * + settings-density retrofit (user ruling 2026-09-17).
 *
 * Raw-stylesheet assertions (readFileSync over the authored `.module.css`,
 * the blockpage-tokens convention): jsdom never applies stylesheets, so the
 * contract pins the authored values for every NEW picker/card/panel
 * control: >=44px touch targets and a `:focus-visible` ring. Panel rows
 * (outline + knowledge) share `.outline-entry`, whose 44px floor lives in
 * RightSidebarPanels.module.css.
 *
 * All document-setting controls use the 44px touch-target floor. The former
 * smaller row, select, checkbox, and export-button exceptions are retired.
 * Rows, selects, and the
 * export button carry a 44px authored floor directly, while the checkbox
 * keeps a 20px visual box inside its 44px toggle label row (the row is the
 * native touch target via label activation; see RightSidebarPanels.tsx).
 * The gates below pin the full >=44px surface with no exceptions.
 *
 * Vitest runs with the ui package as cwd (same assumption as
 * toolbar-touch-medium.spec.tsx).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const pickerCss = readFileSync(
  join(process.cwd(), 'src/react/picker/picker.module.css'),
  'utf8',
);
const panelsCss = readFileSync(
  join(process.cwd(), 'src/react/RightSidebarPanels.module.css'),
  'utf8',
);

/** Escape a CSS selector for literal RegExp matching (attribute selectors
 * carry `[`, `]`, quotes — without escaping they parse as character
 * classes and silently match nothing). */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** All authored blocks for one class selector (base + media variants). */
function blocksFor(css: string, selector: string): string[] {
  const pattern = new RegExp(`\\.${escapeRegExp(selector)}\\s*\\{([^{}]*)\\}`, 'g');
  const blocks: string[] = [];
  for (const match of css.matchAll(pattern)) {
    const body = match[1];
    if (body !== undefined) blocks.push(body);
  }
  expect(blocks, `${selector} must have an authored rule`).not.toHaveLength(0);
  return blocks;
}

function expectMinHeight(css: string, selector: string, px: number): void {
  const ok = blocksFor(css, selector).some((body) =>
    new RegExp(`min-height:\\s*${px}px`).test(body),
  );
  expect(ok, `.${selector} keeps a >=${px}px touch target`).toBe(true);
}

function expectMinWidth(css: string, selector: string, px: number): void {
  const ok = blocksFor(css, selector).some((body) =>
    new RegExp(`min-width:\\s*${px}px`).test(body),
  );
  expect(ok, `.${selector} keeps a >=${px}px touch target`).toBe(true);
}

function expectFocusVisible(css: string, selector: string): void {
  expect(
    css.includes(`.${selector}:focus-visible`),
    `.${selector} exposes a visible :focus-visible ring`,
  ).toBe(true);
}

function expectRuleMatches(
  css: string,
  selector: string,
  pattern: RegExp,
  message: string,
): void {
  const ok = blocksFor(css, selector).some((body) => pattern.test(body));
  expect(ok, message).toBe(true);
}

describe('interaction gates — touch targets (density retrofit)', () => {
  it('document settings controls keep >=44px targets (reversed 2026-09-17)', () => {
    // Full-row floors: base rows plus the readonly details/count rows.
    expectMinHeight(panelsCss, 'document-setting-row', 44);
    expectMinHeight(panelsCss, 'document-setting-row.readonly', 44);
    // Select controls: 44px floor (was a fixed 28px height).
    expectMinHeight(panelsCss, 'document-setting-row select', 44);
    // Export action: 44px floor over the shared .btn base (30px height;
    // min-height wins over height, so the base Button stays untouched).
    expectMinHeight(panelsCss, 'document-export-button', 44);
    // Checkbox: 20px visual box (was 16px); the >=44px touch target is the
    // wrapping toggle label row pinned above — native label activation
    // makes the whole 44px row toggle this input (see
    // RightSidebarPanels.tsx). Pin the visual box so a silent shrink or a
    // silent 44px-box blowup both fail loudly.
    expectRuleMatches(
      panelsCss,
      "document-setting-row input[type='checkbox']",
      /(?:^|[\s;])width:\s*20px/,
      `.document-setting-row input[type='checkbox'] keeps its 20px visual box`,
    );
    expectRuleMatches(
      panelsCss,
      "document-setting-row input[type='checkbox']",
      /(?:^|[\s;])height:\s*20px/,
      `.document-setting-row input[type='checkbox'] keeps its 20px visual box`,
    );
  });

  it('picker search, options, and Cancel keep >=44px targets', () => {
    expectMinHeight(pickerCss, 'picker-input', 44);
    expectMinHeight(pickerCss, 'picker-option', 44);
    expectMinHeight(pickerCss, 'picker-cancel', 44);
    expectMinWidth(pickerCss, 'picker-cancel', 44);
  });

  it('resource-embed card actions and chips keep >=44px targets', () => {
    expectMinHeight(pickerCss, 'embed-action', 44);
    expectMinWidth(pickerCss, 'embed-action', 44);
    expectMinHeight(pickerCss, 'embed-chip', 44);
    expectMinHeight(pickerCss, 'embed-preview', 44);
  });

  it('outline + knowledge panel rows keep >=44px targets', () => {
    expectMinHeight(panelsCss, 'outline-entry', 44);
  });
});

describe('interaction gates — visible focus', () => {
  it('picker controls expose:focus-visible rings', () => {
    expectFocusVisible(pickerCss, 'picker-input');
    expectFocusVisible(pickerCss, 'picker-option');
    expectFocusVisible(pickerCss, 'picker-cancel');
  });

  it('card actions/chips and panel rows expose:focus-visible rings', () => {
    expectFocusVisible(pickerCss, 'embed-action');
    expectFocusVisible(pickerCss, 'embed-chip');
    expectFocusVisible(panelsCss, 'outline-entry');
  });
});
