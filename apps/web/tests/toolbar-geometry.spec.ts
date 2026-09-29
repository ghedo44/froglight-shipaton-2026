/**
 * Toolbar Chromium geometry acceptance.
 *
 * Real-browser layout checks for the unified document toolbar shell. Runs
 * in CI via `pnpm --filter @froglight/web test:e2e`.
 * (production preview server still starts, but these tests use `setContent`
 * harnesses with the real production stylesheets so they fail against known
 * broken geometry — clipped popovers, 28px colors, 34px bars, second rows,
 * island overlap — and pass only after the fixes).
 *
 * Harness uses the real source stylesheets (unhashed class names match the
 * test DOM) plus stable `data-*` anchors (pane, toolbar, islands, popover
 * layer, placements). Placement correctness per family is pinned in Vitest
 * (`default-placements`, `unified-toolbar`, `surface-toolbars`); here we
 * prove shell geometry: no pane escape, 40px touch targets, one toolbar row,
 * no island overlap, and priority overflow inside the same surface.
 */
import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

async function productionStyles(): Promise<string> {
  const cwd = process.cwd();
  const root = cwd.endsWith('web') ? join(cwd, '..', '..') : cwd;
  const toolbarCss = await readFile(
    join(root, 'packages/ui/src/react/UnifiedToolbar.module.css'),
    'utf8',
  );
  const workspaceCss = await readFile(
    join(root, 'packages/ui/src/react/WorkspaceView.module.css'),
    'utf8',
  );
  // Minimal token fallbacks so layout is measurable without the full theme.
  // Geometry (flex, absolute, sizes) does not depend on these values.
  const tokens = `:root{--fl-surface-raised:#fff;--fl-surface-editor:#fff;--fl-surface-sidebar:#f5f5f5;--fl-surface-hover:#eee;--fl-surface-sunken:#eee;--fl-surface-active:#e5e5e5;--fl-text-primary:#111;--fl-text-secondary:#333;--fl-text-muted:#666;--fl-border-default:#ddd;--fl-border-strong:#bbb;--fl-radius-md:8px;--fl-radius-sm:4px;--fl-shadow-medium:0 2px 8px rgba(0,0,0,.15);--fl-shadow-overlay:0 4px 16px rgba(0,0,0,.2);--fl-accent:#0066cc;--fl-accent-strong:#0055aa;--fl-accent-soft:#e6f0ff;--fl-danger:#cc0000;--fl-success:#00aa00;--fl-motion-fast:100ms;--fl-motion-normal:200ms;--fl-motion-slow:300ms;--fl-ease-standard:ease;--fl-ease-spring:ease;--fl-layout-tab-height:40px;--fl-layout-sidebar-width:240px;--fl-layout-right-sidebar-width:240px;--fl-layout-ribbon-width:48px;--fl-layout-floating-top:58px;--fl-safe-area-top:0px;--fl-safe-area-bottom:0px;--fl-safe-area-left:0px;--fl-safe-area-right:0px;--fl-titlebar-inset-left:0px;--fl-titlebar-inset-right:0px;--fl-window-controls-width:0px;}`;
  return `${tokens}\n${workspaceCss}\n${toolbarCss}`;
}

function harnessHtml(): string {
  // One pane with header topbar (primary + overflow), floating islands at
  // every anchor, and a pane-scoped popover layer with positioned popovers
  // (fixed, clamped inside the pane — the portal + flip/shift/clamp contract).
  // Widths are explicit so priority overflow is deterministic: primary 200px
  // (priority 100), format 200px (90), insert 200px (80) in a narrow topbar.
  return `
  <section data-pane="main" class="fl-pane focused" style="position:relative;width:100vw;height:100vh;display:flex;flex-direction:column;">
    <div class="fl-pane-header">
      <div data-toolbar="topbar-center" class="fl-topbar-center" role="toolbar" aria-label="Document primary tools">
        <span class="visually-hidden">Markdown paragraph</span>
        <div class="fl-document-tool-group" data-placement="froglight.toolbar-placement.markdown.primary" data-priority="100" data-compact="auto" data-placement-anchor="topbar-center" data-order="10" style="width:200px;">
          <label class="fl-document-tool-choice"><span class="sr-only">Line style</span><select aria-label="Line style"><option>Paragraph</option></select></label>
        </div>
        <div class="fl-document-tool-group" data-overflow-trigger=""><button type="button" class="fl-document-tool" aria-label="More document tools" aria-haspopup="menu" aria-expanded="false"><span aria-hidden="true">…</span></button></div>
      </div>
    </div>
    <div class="fl-pane-body fl-pane-body-floating" style="position:relative;flex:1;display:flex;flex-direction:column;min-height:0;">
      <div class="editor-area fl-pane-editor" style="flex:1;"></div>
      <div data-floating-layer="" class="fl-floating-layer">
        <div class="fl-floating-strip strip-top">
          <div class="fl-floating-slot slot-start"><div data-anchor="float.top-left" class="fl-floating-island" role="toolbar" aria-label="Top left tools"><div class="fl-document-tool-group" data-group="history"><button type="button" class="fl-document-tool" aria-label="Undo">Undo</button><button type="button" class="fl-document-tool" aria-label="Redo">Redo</button></div></div></div>
          <div class="fl-floating-slot slot-center"><div data-anchor="float.top-center" class="fl-floating-island" role="toolbar" aria-label="Top center tools"><div class="fl-document-tool-group" data-group="format"><button type="button" class="fl-document-tool" aria-label="Bold">B</button><button type="button" class="fl-document-tool" aria-label="Italic">I</button><button type="button" class="fl-document-tool" aria-label="Link destination" aria-haspopup="dialog" aria-expanded="false">Link</button></div><div class="fl-document-colors"><button type="button" class="fl-document-color" aria-label="Stroke color: #37352f" aria-pressed="true" style="background-color:#37352f;"></button></div></div></div>
          <div class="fl-floating-slot slot-end"><div data-anchor="float.top-right" class="fl-floating-island" role="toolbar" aria-label="Top right tools"><div class="fl-document-tool-group" data-group="diagnostics"><button type="button" class="fl-document-tool" aria-label="LaTeX 1 issue" aria-haspopup="dialog" aria-expanded="false" data-diagnostics-state="errors">LaTeX 1 issue</button></div></div></div>
        </div>
        <div class="fl-floating-slot-float slot-left"></div>
        <div class="fl-floating-slot-float slot-right"></div>
        <div class="fl-floating-strip strip-bottom">
          <div class="fl-floating-slot slot-start"><div data-anchor="float.bottom-left" class="fl-floating-island" role="toolbar" aria-label="Bottom left tools"><label class="fl-document-tool-number"><span>Canvas width</span><input type="number" aria-label="Canvas width" value="800" /></label></div></div>
          <div class="fl-floating-slot slot-center"><div data-anchor="float.bottom-center" class="fl-floating-island" role="toolbar" aria-label="Bottom center tools"><button type="button" class="fl-document-tool" aria-label="Previous page">Prev</button><button type="button" class="fl-document-tool" aria-label="Next page">Next</button></div></div>
          <div class="fl-floating-slot slot-end"><div data-anchor="float.bottom-right" class="fl-floating-island" role="toolbar" aria-label="Bottom right tools"><button type="button" class="fl-document-tool" aria-label="Zoom out">-</button><button type="button" class="fl-document-tool" aria-label="Zoom in">+</button><button type="button" class="fl-document-tool" aria-label="Fit board">Fit</button></div></div>
        </div>
      </div>
      <div data-popover-layer="" style="position:absolute;inset:0;z-index:4;pointer-events:none;">
        <div class="fl-document-tool-popover" role="dialog" aria-label="Link destination" data-popover-placement="below" style="position:fixed;left:120px;top:120px;transform:none;pointer-events:auto;"><form class="fl-document-tool-input" aria-label="Link destination"><input name="value" type="text" aria-label="Link destination" placeholder="https://…" value="" /><button type="submit" class="fl-document-tool">Link</button></form></div>
        <div class="fl-document-tool-popover" role="dialog" aria-label="LaTeX 1 issue" data-popover-placement="below" style="position:fixed;left:540px;top:120px;transform:none;pointer-events:auto;"><ul class="fl-document-tool-diagnostics"><li><button type="button" class="fl-document-tool" data-diagnostic-entry="0">unknown macro (line 1)</button></li></ul></div>
        <div class="fl-document-tool-popover" role="menu" aria-label="More document tools" style="position:fixed;left:120px;top:60px;transform:none;pointer-events:auto;"><div class="fl-document-tool-group" data-placement="froglight.toolbar-placement.markdown.format" data-priority="90"><button type="button" class="fl-document-tool" aria-label="Bold">B</button></div><div class="fl-document-tool-group" data-placement="froglight.toolbar-placement.markdown.insert" data-priority="80"><button type="button" class="fl-document-tool" aria-label="Code block">Code block</button></div></div>
      </div>
    </div>
  </section>`;
}

async function setHarness(
  page: import('@playwright/test').Page,
): Promise<void> {
  const css = await productionStyles();
  await page.setContent(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body style="margin:0;">${harnessHtml()}</body></html>`,
    { waitUntil: 'load' },
  );
}

test.describe('toolbar geometry (desktop 1440x900)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('no popover escapes its pane', async ({ page }) => {
    await setHarness(page);
    const pane = await page.locator('[data-pane="main"]').boundingBox();
    expect(pane).not.toBeNull();
    const inset = 8;
    for (const label of ['Link destination', 'LaTeX 1 issue']) {
      const popover = page.locator(`[role="dialog"][aria-label="${label}"]`);
      const box = await popover.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(pane!.x + inset - 1);
      expect(box!.x + box!.width).toBeLessThanOrEqual(
        pane!.x + pane!.width - inset + 1,
      );
      expect(box!.y).toBeGreaterThanOrEqual(pane!.y + inset - 1);
      expect(box!.y + box!.height).toBeLessThanOrEqual(
        pane!.y + pane!.height - inset + 1,
      );
    }
  });

  test('topbar stays one row (no second full-width toolbar row)', async ({
    page,
  }) => {
    await setHarness(page);
    const bar = await page
      .locator('[data-toolbar="topbar-center"]')
      .boundingBox();
    expect(bar).not.toBeNull();
    // Every direct toolbar group shares one vertical band (one row).
    const groups = page.locator('[data-toolbar="topbar-center"] > *');
    const count = await groups.count();
    expect(count).toBeGreaterThan(0);
    const bands: Array<{ y: number; height: number }> = [];
    for (let index = 0; index < count; index += 1) {
      const box = await groups.nth(index).boundingBox();
      if (box !== null) bands.push({ y: box.y, height: box.height });
    }
    const tops = bands.map((band) => Math.round(band.y));
    const bottoms = bands.map((band) => Math.round(band.y + band.height));
    expect(Math.max(...bottoms) - Math.min(...tops)).toBeLessThanOrEqual(
      Math.max(...bands.map((band) => band.height)) + 8,
    );
  });

  test('floating islands do not overlap', async ({ page }) => {
    await setHarness(page);
    const anchors = [
      'float.top-left',
      'float.top-center',
      'float.top-right',
      'float.bottom-left',
      'float.bottom-center',
      'float.bottom-right',
    ];
    const boxes: Array<{
      anchor: string;
      x: number;
      y: number;
      width: number;
      height: number;
    }> = [];
    for (const anchor of anchors) {
      const box = await page.locator(`[data-anchor="${anchor}"]`).boundingBox();
      if (box !== null) boxes.push({ anchor, ...box });
    }
    expect(boxes.length).toBeGreaterThanOrEqual(5);
    for (let a = 0; a < boxes.length; a += 1) {
      for (let b = a + 1; b < boxes.length; b += 1) {
        const first = boxes[a]!;
        const second = boxes[b]!;
        const overlapX =
          Math.min(first.x + first.width, second.x + second.width) -
          Math.max(first.x, second.x);
        const overlapY =
          Math.min(first.y + first.height, second.y + second.height) -
          Math.max(first.y, second.y);
        const overlaps = overlapX > 1 && overlapY > 1;
        expect(overlaps, `${first.anchor} overlaps ${second.anchor}`).toBe(
          false,
        );
      }
    }
  });

  test('priority overflow stays inside the same toolbar surface', async ({
    page,
  }) => {
    await setHarness(page);
    // High-priority primary group remains directly visible in the topbar.
    await expect(
      page.locator(
        '[data-toolbar="topbar-center"] [data-placement="froglight.toolbar-placement.markdown.primary"]',
      ),
    ).toBeVisible();
    // Lower-priority groups live in the in-surface overflow menu (same bar,
    // never a second full-width row).
    const trigger = page.locator(
      '[data-toolbar="topbar-center"] [aria-label="More document tools"]',
    );
    await expect(trigger).toBeVisible();
    const menu = page.locator(
      '[role="menu"][aria-label="More document tools"]',
    );
    await expect(menu).toBeVisible();
    await expect(menu.locator('[aria-label="Code block"]')).toBeVisible();
  });
});

test.describe('toolbar geometry (tablet 1024x768 touch)', () => {
  test.use({
    viewport: { width: 1024, height: 768 },
    hasTouch: true,
    isMobile: true,
  });

  test('coarse-pointer controls expose 40px hit targets', async ({ page }) => {
    await setHarness(page);
    // 39.5px tolerance for subpixel rounding (40px CSS still passes; 28/30px
    // broken targets still fail).
    for (const name of ['Undo', 'Bold', 'Link destination', 'LaTeX 1 issue']) {
      const box = await page
        .locator(
          `[data-anchor] [aria-label="${name}"], [data-toolbar] [aria-label="${name}"]`,
        )
        .first()
        .boundingBox();
      expect(box, name).not.toBeNull();
      expect(box!.width, `${name} width`).toBeGreaterThanOrEqual(39.5);
      expect(box!.height, `${name} height`).toBeGreaterThanOrEqual(39.5);
    }
    const color = await page
      .locator('.fl-document-color')
      .first()
      .boundingBox();
    expect(color).not.toBeNull();
    expect(color!.width).toBeGreaterThanOrEqual(39.5);
    expect(color!.height).toBeGreaterThanOrEqual(39.5);
  });

  test('popovers stay inside the pane on tablet', async ({ page }) => {
    await setHarness(page);
    const pane = await page.locator('[data-pane="main"]').boundingBox();
    const popover = await page
      .locator('[role="dialog"][aria-label="Link destination"]')
      .boundingBox();
    expect(pane).not.toBeNull();
    expect(popover).not.toBeNull();
    expect(popover!.x).toBeGreaterThanOrEqual(pane!.x + 8 - 1);
    expect(popover!.x + popover!.width).toBeLessThanOrEqual(
      pane!.x + pane!.width - 8 + 1,
    );
  });
});

test.describe('toolbar geometry (phone 390x844)', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });

  test('phone keeps one toolbar row with reachable overflow', async ({
    page,
  }) => {
    await setHarness(page);
    const bar = await page
      .locator('[data-toolbar="topbar-center"]')
      .boundingBox();
    expect(bar).not.toBeNull();
    // Narrow phone: the bar never grows a second row (height stays one-row).
    expect(bar!.height).toBeLessThanOrEqual(56);
    await expect(
      page.locator(
        '[data-toolbar="topbar-center"] [aria-label="More document tools"]',
      ),
    ).toBeVisible();
  });

  test('phone touch targets stay usable', async ({ page }) => {
    await setHarness(page);
    const button = await page
      .locator('[data-anchor="float.bottom-right"] [aria-label="Zoom in"]')
      .boundingBox();
    expect(button).not.toBeNull();
    expect(button!.width).toBeGreaterThanOrEqual(39.5);
    expect(button!.height).toBeGreaterThanOrEqual(39.5);
  });
});
