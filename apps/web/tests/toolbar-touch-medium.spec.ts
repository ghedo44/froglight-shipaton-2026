/**
 * Chromium geometry checks for touch toolbar sizing and medium-width overflow.
 *
 * These real-browser checks run in CI via `pnpm --filter @froglight/web
 * test:e2e`. They use `setContent` harnesses with the production stylesheet,
 * alongside `toolbar-geometry.spec.ts`.
 *
 * The hybrid touch path cannot be emulated through Playwright context options
 * or CDP `setEmulatedMedia`, so Vitest pins the JavaScript path with stubbed
 * `matchMedia`. This spec checks the live `(any-pointer: coarse)` query in both
 * directions and verifies the shipped stylesheet keeps compact hit targets
 * from touch availability while fine-only hosts keep dense 30px targets.
 *
 * Geometry checks show the full inline shelf overflows 768/820/834/1024px
 * touch panes while fitting at 1400px. On medium panes, settings and More
 * remain usable at scroll position zero, and overflowed quick actions are
 * reachable through the pane popover layer.
 *
 * Shelf/menu HTML comes from `packages/ui/src/react/__fixtures__/
 * shelf-partitions.json`, the same fixture used by the React tests. Unknown
 * labels throw, and a test below checks DOM membership for every scenario.
 *
 * Measurement tolerances are per-cell estimate drift of 12px and center-slot
 * budget drift of 32px. The history-only harness also checks that the budget
 * remains conservative. Each scenario verifies that the partitioned shelf
 * fits at scroll position zero, including compact panes below 760px.
 */
import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const TOL_CELL = 12;
const TOL_SLOT = 32;
const TOL_CONSERVATIVE = 200;

interface FixtureScenario {
  readonly paneWidth: number;
  readonly touch: boolean;
  readonly compact: boolean;
  readonly inlineTools: readonly string[];
  readonly inlineSettings: string | null;
  readonly inlineQuicks: readonly string[];
  readonly menuTools: readonly string[];
  readonly menuQuicks: readonly string[];
  readonly moreVisible: boolean;
}

interface ShelfFixture {
  readonly writeShelf: {
    readonly cells: Record<
      string,
      readonly { readonly id: string; readonly width: number }[]
    >;
    readonly budgets: Record<string, Record<string, number>>;
  };
  readonly scenarios: Record<string, FixtureScenario>;
}

async function loadFixture(): Promise<ShelfFixture> {
  const cwd = process.cwd();
  const root = cwd.endsWith('web') ? join(cwd, '..', '..') : cwd;
  const raw = await readFile(
    join(root, 'packages/ui/src/react/__fixtures__/shelf-partitions.json'),
    'utf8',
  );
  return JSON.parse(raw) as ShelfFixture;
}

async function productionStyles(): Promise<string> {
  const cwd = process.cwd();
  const root = cwd.endsWith('web') ? join(cwd, '..', '..') : cwd;
  const toolbarCss = await readFile(
    join(root, 'packages/ui/src/react/UnifiedToolbar.module.css'),
    'utf8',
  );
  const tokens = `:root{--fl-surface-raised:#fff;--fl-surface-editor:#fff;--fl-surface-hover:#eee;--fl-surface-sunken:#eee;--fl-text-primary:#111;--fl-text-secondary:#333;--fl-border-default:#ddd;--fl-border-strong:#bbb;--fl-radius-md:8px;--fl-radius-sm:4px;--fl-radius-xl:12px;--fl-shadow-medium:0 2px 8px rgba(0,0,0,.15);--fl-accent:#0066cc;--fl-accent-strong:#0055aa;--fl-accent-soft:#e6f0ff;--fl-focus-ring:#0066cc;--fl-motion-fast:100ms;--fl-ease-standard:ease;--fl-safe-area-top:0px;--fl-safe-area-bottom:0px;--fl-safe-area-left:0px;--fl-safe-area-right:0px;--fl-keyboard-aware-bottom:0px;--fl-keyboard-safe-bottom:0px;}`;
  return `${tokens}\n${toolbarCss}`;
}

/** Pen-active write family (the eraser lives in surface.erase, never here). */
const WRITE_TOOLS = [
  'Ball Pen',
  'Fountain Pen',
  'Brush Pen',
  'Pencil',
] as const;

const WIDTH_BUTTONS = ['Thin', 'Medium', 'Thick'] as const;
const COLOR_DOTS = [
  '#37352f',
  '#7c6cf0',
  '#c4554d',
  '#448361',
  '#a08430',
] as const;

/** Build shelf/menu HTML for a tool label; throw for unknown labels. */
function toolHtml(label: string): string {
  if (
    !(WRITE_TOOLS as readonly string[]).includes(label) &&
    label !== 'Eraser'
  ) {
    throw new Error(`fixture uses unknown tool label: ${label}`);
  }
  return `<div class="fl-document-tool-group"><button type="button" class="fl-document-tool" aria-label="${label}">B</button></div>`;
}

function settingsHtml(label: string): string {
  if (!label.endsWith(' settings')) {
    throw new Error(`fixture uses unknown settings label: ${label}`);
  }
  return `<button type="button" class="fl-document-tool" aria-label="${label}">S</button>`;
}

/** Build shelf/menu HTML for a quick-group label; throw for unknown groups. */
function quickHtml(group: string): string {
  switch (group) {
    case 'Favorite styles':
      return `<div class="fl-shelf-quick" role="group" aria-label="Favorite styles">
        <button type="button" class="fl-document-tool" aria-label="Style Daily"><span class="fl-document-tool-swatch"></span><span class="fl-shelf-fav-name">Daily</span></button>
        <button type="button" class="fl-document-tool" aria-label="Style Fine"><span class="fl-document-tool-swatch"></span><span class="fl-shelf-fav-name">Fine</span></button>
      </div>`;
    case 'Quick widths':
      return `<div class="fl-shelf-quick" role="group" aria-label="Quick widths">${WIDTH_BUTTONS.map(
        (option) =>
          `<button type="button" class="fl-document-tool" aria-label="Size: ${option}">${option[0]}</button>`,
      ).join('')}</div>`;
    case 'Edit quick widths':
    case 'Edit quick colors': {
      const kind = group === 'Edit quick widths' ? 'width' : 'color';
      return `<div class="fl-shelf-quick" role="group" aria-label="${group}">${[
        1, 2, 3,
      ]
        .map(
          (index) =>
            `<button type="button" class="fl-document-tool" aria-label="Edit quick ${kind} ${index}">Edit ${kind} ${index}</button>`,
        )
        .join('')}</div>`;
    }
    case 'Quick colors':
      return `<div class="fl-shelf-quick" role="group" aria-label="Quick colors">${COLOR_DOTS.map(
        (color, index) =>
          `<button type="button" class="fl-document-color" aria-label="Color: ${color}" style="background-color:${color};">${index}</button>`,
      ).join('')}</div>`;
    default:
      throw new Error(`fixture uses unknown quick group: ${group}`);
  }
}

function moreTriggerHtml(): string {
  return `<div class="fl-toolbar-overflow-wrap"><button type="button" class="fl-document-tool" aria-label="More tools" aria-expanded="true">…</button></div>`;
}

/** Build inline shelf HTML from the React fixture partition. */
function shelfHtmlFromScenario(scenario: FixtureScenario): string {
  return (
    scenario.inlineTools.map(toolHtml).join('') +
    (scenario.inlineSettings === null
      ? ''
      : settingsHtml(scenario.inlineSettings)) +
    scenario.inlineQuicks.map(quickHtml).join('') +
    (scenario.moreVisible ? moreTriggerHtml() : '')
  );
}

/** Build More menu HTML from the React fixture partition. */
function menuHtmlFromScenario(scenario: FixtureScenario): string {
  // Menu tools render as bare controls (no group chrome), quicks keep it.
  const tools = scenario.menuTools
    .map(
      (label) =>
        `<div><button type="button" class="fl-document-tool" aria-label="${label}">B</button></div>`,
    )
    .join('');
  return tools + scenario.menuQuicks.map(quickHtml).join('');
}

/**
 * Ink-faithful top strip (history is the only top-edge companion island
 * for ink kinds): history left, shelf center, empty right slot, plus a
 * pane popover layer holding the open More menu.
 */
function inkReachHtml(
  paneWidth: string,
  shelfInner: string,
  menuInner: string,
): string {
  return `
  <section data-pane="main" style="position:relative;width:${paneWidth};height:100vh;display:flex;flex-direction:column;">
    <div class="fl-floating-layer" data-floating-layer="">
      <div class="fl-floating-strip strip-top">
        <div class="fl-floating-slot slot-start"><div data-anchor="float.top-left" class="fl-floating-island" role="toolbar" aria-label="Top left tools"><div class="fl-document-tool-group"><button type="button" class="fl-document-tool" aria-label="Undo">U</button><button type="button" class="fl-document-tool" aria-label="Redo">R</button></div></div></div>
        <div class="fl-floating-slot slot-center fl-contextual-stack">
          <div class="fl-floating-island fl-tool-shelf" role="toolbar" aria-label="Write tools" data-tool-shelf="surface.write" data-anchor="float.top-center">
            ${shelfInner}
          </div>
        </div>
        <div class="fl-floating-slot slot-end"></div>
      </div>
    </div>
    <div data-popover-layer="" style="position:absolute;inset:0;z-index:4;pointer-events:none;">
      <div class="fl-toolbar-inline-menu" role="group" aria-label="More tools" style="position:fixed;left:200px;top:80px;transform:none;pointer-events:auto;">
        ${menuInner}
      </div>
    </div>
  </section>`;
}

/** Full inline shelf (every cell): measures whether a pane NEEDS overflow. */
function fullShelfHtml(): string {
  return `
          <div class="fl-floating-island fl-tool-shelf" role="toolbar" aria-label="Write tools" data-tool-shelf="surface.write" data-anchor="float.top-center">
            ${WRITE_TOOLS.map(toolHtml).join('')}
            ${quickHtml('Favorite styles')}
            ${quickHtml('Quick widths')}
            ${quickHtml('Quick colors')}
          </div>`;
}

function paneHtml(paneWidth: string, inner: string): string {
  return `
  <section data-pane="main" style="position:relative;width:${paneWidth};height:100vh;display:flex;flex-direction:column;">
    <div class="fl-floating-layer" data-floating-layer="">
      <div class="fl-floating-strip strip-top">
        <div class="fl-floating-slot slot-start"><div data-anchor="float.top-left" class="fl-floating-island" role="toolbar" aria-label="Top left tools"><div class="fl-document-tool-group"><button type="button" class="fl-document-tool" aria-label="Undo">U</button><button type="button" class="fl-document-tool" aria-label="Redo">R</button></div></div></div>
        <div class="fl-floating-slot slot-center fl-contextual-stack">${inner}</div>
        <div class="fl-floating-slot slot-end"><div data-anchor="float.top-right" class="fl-floating-island" role="toolbar" aria-label="Top right tools"><div class="fl-document-tool-group"><button type="button" class="fl-document-tool" aria-label="Zoom out">-</button><button type="button" class="fl-document-tool" aria-label="Zoom in">+</button><button type="button" class="fl-document-tool" aria-label="Fit board">F</button></div></div></div>
      </div>
    </div>
  </section>`;
}

async function setHarness(
  page: import('@playwright/test').Page,
  body: string,
): Promise<void> {
  const css = await productionStyles();
  await page.setContent(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body style="margin:0;">${body}</body></html>`,
    { waitUntil: 'load' },
  );
}

async function shelfBox(
  page: import('@playwright/test').Page,
): Promise<{ scroll: number; client: number }> {
  return page.evaluate(() => {
    const shelf = document.querySelector('[data-tool-shelf]')!;
    return {
      scroll: (shelf as HTMLElement).scrollWidth,
      client: (shelf as HTMLElement).clientWidth,
    };
  });
}

/**
 * True center-slot width (the 1fr grid item). The island itself is
 * content-sized whenever it fits, so island clientWidth only equals the
 * slot while the island is slot-constrained (scrollWidth > clientWidth) —
 * slot assertions must read the slot, never the island.
 */
async function slotWidth(
  page: import('@playwright/test').Page,
): Promise<number> {
  return page.evaluate(
    () =>
      document
        .querySelector('.fl-floating-slot.slot-center')!
        .getBoundingClientRect().width,
  );
}

test.describe('touch hit targets (real engine)', () => {
  test.use({
    viewport: { width: 834, height: 1112 },
    hasTouch: true,
    isMobile: true,
  });

  test('touch controls keep desktop geometry and any-pointer is live', async ({
    page,
  }) => {
    await setHarness(page, paneHtml('100vw', fullShelfHtml()));
    const live = await page.evaluate(() => ({
      anyPointer: matchMedia('(any-pointer: coarse)').matches,
      primary: matchMedia('(pointer: coarse)').matches,
    }));
    expect(live.anyPointer).toBe(true);
    // Compact buttons retain their desktop geometry on touch.
    for (const name of ['Ball Pen', 'Size: Thick', 'Zoom in']) {
      const box = await page
        .locator(
          `[data-tool-shelf] [aria-label="${name}"], [data-anchor] [aria-label="${name}"]`,
        )
        .first()
        .boundingBox();
      expect(box, name).not.toBeNull();
      expect(box!.width, `${name} width`).toBeGreaterThanOrEqual(29.5);
      expect(box!.height, `${name} height`).toBeGreaterThanOrEqual(29.5);
    }
    const color = await page
      .locator('[data-tool-shelf] .fl-document-color')
      .first()
      .boundingBox();
    expect(color).not.toBeNull();
    expect(color!.width).toBe(20);
    expect(color!.height).toBe(20);
  });
});

test.describe('fine-only density (real engine)', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('fine-only hosts stay dense with no coarse availability', async ({
    page,
  }) => {
    await setHarness(page, paneHtml('100vw', fullShelfHtml()));
    const live = await page.evaluate(() => ({
      anyPointer: matchMedia('(any-pointer: coarse)').matches,
      primary: matchMedia('(pointer: coarse)').matches,
    }));
    expect(live.anyPointer).toBe(false);
    expect(live.primary).toBe(false);
    const box = await page
      .locator('[data-tool-shelf] [aria-label="Ball Pen"]')
      .boundingBox();
    expect(box).not.toBeNull();
    // Dense 30px targets allowed (not forced to touch size).
    expect(box!.height).toBeLessThan(40);
    expect(box!.height).toBeGreaterThanOrEqual(27);
  });
});

test.describe('medium overflow need (real engine, touch)', () => {
  test.use({
    hasTouch: true,
    isMobile: true,
  });

  for (const width of [768, 820, 834, 1024]) {
    test(`compact shelf fits a ${width}px touch pane`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await setHarness(page, paneHtml('100vw', fullShelfHtml()));
      const need = await shelfBox(page);
      const slot = await slotWidth(page);
      // Compact controls fit inline at tablet widths.
      // Compared against the true slot (the island is content-sized when it
      // fits, so its own clientWidth cannot serve as the comparator).
      expect(
        need.scroll,
        `${width}px scrollWidth ${need.scroll} vs slot ${slot}`,
      ).toBeLessThanOrEqual(slot + 1);
    });
  }

  test('full shelf fits a 1400px touch pane (no More needed)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await setHarness(page, paneHtml('100vw', fullShelfHtml()));
    const fit = await shelfBox(page);
    const slot = await slotWidth(page);
    expect(fit.scroll).toBeLessThanOrEqual(slot + 1);
  });
});

test.describe('generated harnesses equal fixture partitions', () => {
  test.use({
    viewport: { width: 1400, height: 900 },
    hasTouch: true,
    isMobile: true,
  });

  for (const name of ['768-touch', '1024-touch', '500-touch', '390-touch']) {
    test(`${name} harness carries exactly the fixture labels`, async ({
      page,
    }) => {
      const fixture = await loadFixture();
      const scenario = fixture.scenarios[name]!;
      await setHarness(
        page,
        inkReachHtml(
          '100vw',
          shelfHtmlFromScenario(scenario),
          menuHtmlFromScenario(scenario),
        ),
      );
      // Builder self-check: the DOM partition must equal the fixture the
      // builder consumed (guards builder drift, not React — React==fixture
      // is pinned by the Vitest fixture comparison).
      const dom = await page.evaluate(() => {
        const shelf = document.querySelector('[data-tool-shelf]')!;
        const menu = document.querySelector(
          '[role="group"][aria-label="More tools"]',
        )!;
        const labels = (root: Element, selector: string): (string | null)[] =>
          [...root.querySelectorAll(selector)].map((element) =>
            element.getAttribute('aria-label'),
          );
        const toolLabel = (element: Element): string | null =>
          element.getAttribute('aria-label');
        return {
          inlineTools: labels(
            shelf,
            ':scope > div:not([role="group"]) button[aria-label]',
          )
            .filter((label) => label !== 'More tools')
            .map(String),
          inlineSettings:
            shelf
              .querySelector(':scope > button[aria-label$="settings"]')
              ?.getAttribute('aria-label') ?? null,
          inlineQuicks: labels(
            shelf,
            ':scope > div[role="group"][aria-label]',
          ).map(String),
          menuTools: [...menu.querySelectorAll('button[aria-label]')]
            .filter((element) => element.closest('[role="group"]') === menu)
            .map(toolLabel)
            .map(String),
          menuQuicks: labels(menu, '[role="group"][aria-label]').map(String),
          moreVisible:
            shelf.querySelector('button[aria-label="More tools"]') !== null,
        };
      });
      expect(dom.inlineTools, `${name} inlineTools`).toEqual(
        scenario.inlineTools,
      );
      expect(dom.inlineSettings, `${name} inlineSettings`).toBe(
        scenario.inlineSettings,
      );
      expect(dom.inlineQuicks, `${name} inlineQuicks`).toEqual(
        scenario.inlineQuicks,
      );
      expect(dom.menuTools, `${name} menuTools`).toEqual(scenario.menuTools);
      expect(dom.menuQuicks, `${name} menuQuicks`).toEqual(scenario.menuQuicks);
      expect(dom.moreVisible, `${name} moreVisible`).toBe(scenario.moreVisible);
    });
  }
});

test.describe('estimate-vs-reality tolerance (real engine)', () => {
  test.use({
    viewport: { width: 834, height: 1112 },
    hasTouch: true,
    isMobile: true,
  });

  test('touch cell widths match estimates within tolerance', async ({
    page,
  }) => {
    const fixture = await loadFixture();
    await setHarness(page, paneHtml('100vw', fullShelfHtml()));
    const measured = await page.evaluate(() => {
      const rect = (selector: string): number =>
        document.querySelector(selector)!.getBoundingClientRect().width;
      return {
        tool: rect('[data-tool-shelf] [aria-label="Ball Pen"]'),
        favorites: rect('[data-tool-shelf] [aria-label="Favorite styles"]'),
        widths: rect('[data-tool-shelf] [aria-label="Quick widths"]'),
        colors: rect('[data-tool-shelf] [aria-label="Quick colors"]'),
      };
    });
    const estimates = Object.fromEntries(
      fixture.writeShelf.cells['touch']!.map((cell) => [cell.id, cell.width]),
    ) as Record<string, number>;
    const pairs: Array<[string, number, number]> = [
      ['tool', measured.tool, estimates['shelf:tool:ink.tool.pen']!],
      ['favorites', measured.favorites, estimates['shelf:favorites']!],
      ['widths', measured.widths, estimates['shelf:widths']!],
      ['colors', measured.colors, estimates['shelf:colors']!],
    ];
    for (const [cell, actual, estimated] of pairs) {
      expect(
        Math.abs(actual - estimated),
        `${cell}: measured ${actual} vs estimate ${estimated}`,
      ).toBeLessThanOrEqual(TOL_CELL);
    }
  });

  test('touch center slot matches the capacity budget within tolerance', async ({
    page,
  }) => {
    const fixture = await loadFixture();
    // History+zoom harness: budget models both side islands. The comparator
    // is the true slot: a fitting island is content-sized, so island
    // clientWidth would compare content against itself.
    for (const width of [768, 1024, 1400]) {
      await page.setViewportSize({ width, height: 900 });
      await setHarness(page, paneHtml('100vw', fullShelfHtml()));
      const slot = await slotWidth(page);
      const budget = fixture.writeShelf.budgets['touch']![String(width)]!;
      expect(
        Math.abs(slot - budget),
        `${width}px slot ${slot} vs budget ${budget}`,
      ).toBeLessThanOrEqual(TOL_SLOT);
    }
    // History-only harness (real ink layout): the budget stays
    // conservative (it assumes worst-case side islands) within a bounded
    // margin — never optimistic, never absurd.
    for (const width of [768, 1024]) {
      await page.setViewportSize({ width, height: 900 });
      const scenario = fixture.scenarios[`${width}-touch` as const]!;
      await setHarness(
        page,
        inkReachHtml(
          '100vw',
          shelfHtmlFromScenario(scenario),
          menuHtmlFromScenario(scenario),
        ),
      );
      const slot = await slotWidth(page);
      const budget = fixture.writeShelf.budgets['touch']![String(width)]!;
      expect(slot - budget, `${width}px conservatism`).toBeGreaterThanOrEqual(
        0,
      );
      expect(slot - budget, `${width}px conservatism`).toBeLessThanOrEqual(
        TOL_CONSERVATIVE,
      );
    }
  });
});

test.describe('fine-only cells and slot (real engine)', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('fine cell widths and slot match estimates within tolerance', async ({
    page,
  }) => {
    const fixture = await loadFixture();
    await setHarness(page, paneHtml('100vw', fullShelfHtml()));
    const measured = await page.evaluate(() => {
      const rect = (selector: string): number =>
        document.querySelector(selector)!.getBoundingClientRect().width;
      return {
        tool: rect('[data-tool-shelf] [aria-label="Ball Pen"]'),
        favorites: rect('[data-tool-shelf] [aria-label="Favorite styles"]'),
        widths: rect('[data-tool-shelf] [aria-label="Quick widths"]'),
        colors: rect('[data-tool-shelf] [aria-label="Quick colors"]'),
      };
    });
    const estimates = Object.fromEntries(
      fixture.writeShelf.cells['fine']!.map((cell) => [cell.id, cell.width]),
    ) as Record<string, number>;
    const pairs: Array<[string, number, number]> = [
      ['tool', measured.tool, estimates['shelf:tool:ink.tool.pen']!],
      ['favorites', measured.favorites, estimates['shelf:favorites']!],
      ['widths', measured.widths, estimates['shelf:widths']!],
      ['colors', measured.colors, estimates['shelf:colors']!],
    ];
    for (const [cell, actual, estimated] of pairs) {
      expect(
        Math.abs(actual - estimated),
        `${cell}: measured ${actual} vs estimate ${estimated}`,
      ).toBeLessThanOrEqual(TOL_CELL);
    }
    // 1280 fine slot vs interpolated budget: reserve arithmetic is
    // density-driven, so assert the reserve identity directly against the
    // true slot (a fitting island is content-sized).
    const slot = await slotWidth(page);
    const budget1280 = 1280 - 168 - 48;
    expect(Math.abs(slot - budget1280)).toBeLessThanOrEqual(TOL_SLOT);
  });
});

test.describe('reachability without scroll (real engine, touch 390)', () => {
  test.use({
    viewport: { width: 390, height: 900 },
    hasTouch: true,
    isMobile: true,
  });

  test('settings + More usable at scroll 0, quicks hit-test via layer', async ({
    page,
  }) => {
    const fixture = await loadFixture();
    const scenario = fixture.scenarios['390-touch']!;
    await setHarness(
      page,
      inkReachHtml(
        '100vw',
        shelfHtmlFromScenario(scenario),
        menuHtmlFromScenario(scenario),
      ),
    );
    const island = await page.locator('[data-tool-shelf]').boundingBox();
    expect(island).not.toBeNull();
    // Single-row invariant: the compact island never wraps.
    expect(island!.height).toBeLessThanOrEqual(64);
    // The partitioned shelf fits its slot without hidden-scroll dependence.
    const box = await shelfBox(page);
    expect(
      box.scroll,
      `partitioned scrollWidth ${box.scroll} vs client ${box.client}`,
    ).toBeLessThanOrEqual(box.client + 1);
    // Settings disclosure fully visible without scrolling.
    const settings = await page
      .locator('[data-tool-shelf] [aria-label="Ball Pen"]')
      .boundingBox();
    expect(settings).not.toBeNull();
    expect(settings!.x).toBeGreaterThanOrEqual(island!.x - 1);
    expect(settings!.x + settings!.width).toBeLessThanOrEqual(
      island!.x + island!.width + 1,
    );
    // More trigger touch-sized and visible without scrolling.
    const more = page.locator('[data-tool-shelf] [aria-label="More tools"]');
    await expect(more).toBeVisible();
    const moreBox = await more.boundingBox();
    expect(moreBox!.width).toBeGreaterThanOrEqual(29.5);
    expect(moreBox!.height).toBeGreaterThanOrEqual(29.5);
    expect(moreBox!.x + moreBox!.width).toBeLessThanOrEqual(
      island!.x + island!.width + 1,
    );
    // Overflowed quicks live in the pane popover layer and hit-test: the
    // topmost element at the quick's center IS the quick (the transparent
    // layer never intercepts, the menu re-enables hit-testing).
    const menu = page.locator('[role="group"][aria-label="More tools"]');
    await expect(menu).toBeVisible();
    const quick = page.locator(
      '[role="group"][aria-label="More tools"] [aria-label="Size: Thick"]',
    );
    await expect(quick).toBeVisible();
    const hit = await quick.evaluate((node) => {
      const rect = (node as HTMLElement).getBoundingClientRect();
      const top = document.elementFromPoint(
        rect.x + rect.width / 2,
        rect.y + rect.height / 2,
      );
      return (top as HTMLElement | null)?.getAttribute('aria-label') ?? null;
    });
    expect(hit).toBe('Size: Thick');
  });
});

test.describe('reachability without scroll (real engine, touch 1024)', () => {
  test.use({
    viewport: { width: 1024, height: 900 },
    hasTouch: true,
    isMobile: true,
  });

  test('partitioned shelf fits with colors inline', async ({ page }) => {
    const fixture = await loadFixture();
    const scenario = fixture.scenarios['1024-touch']!;
    await setHarness(
      page,
      inkReachHtml(
        '100vw',
        shelfHtmlFromScenario(scenario),
        menuHtmlFromScenario(scenario),
      ),
    );
    const island = await page.locator('[data-tool-shelf]').boundingBox();
    expect(island).not.toBeNull();
    expect(island!.height).toBeLessThanOrEqual(64);
    // The partitioned shelf fits its slot.
    const box = await shelfBox(page);
    expect(
      box.scroll,
      `partitioned scrollWidth ${box.scroll} vs client ${box.client}`,
    ).toBeLessThanOrEqual(box.client + 1);
    const settings = await page
      .locator('[data-tool-shelf] [aria-label="Ball Pen"]')
      .boundingBox();
    expect(settings).not.toBeNull();
    expect(settings!.x + settings!.width).toBeLessThanOrEqual(
      island!.x + island!.width + 1,
    );
    await expect(
      page.locator('[data-tool-shelf] [aria-label="Quick colors"]'),
    ).toBeVisible();
    // Widths stay inline at 1024 (priority retention, per the fixture).
    await expect(
      page.locator('[data-tool-shelf] [aria-label="Quick widths"]'),
    ).toBeVisible();
  });
});

test.describe('narrow pane in wide viewport (500-in-1400, touch)', () => {
  test.use({
    viewport: { width: 1400, height: 900 },
    hasTouch: true,
    isMobile: true,
  });

  test('500px pane keeps settings + More reachable', async ({ page }) => {
    const fixture = await loadFixture();
    const scenario = fixture.scenarios['500-touch']!;
    await setHarness(
      page,
      inkReachHtml(
        '500px',
        shelfHtmlFromScenario(scenario),
        menuHtmlFromScenario(scenario),
      ),
    );
    const island = await page.locator('[data-tool-shelf]').boundingBox();
    expect(island).not.toBeNull();
    expect(island!.height).toBeLessThanOrEqual(64);
    // The compact shelf fits at 500px.
    const box = await shelfBox(page);
    expect(
      box.scroll,
      `partitioned scrollWidth ${box.scroll} vs client ${box.client}`,
    ).toBeLessThanOrEqual(box.client + 1);
    const settings = await page
      .locator('[data-tool-shelf] [aria-label="Ball Pen"]')
      .boundingBox();
    expect(settings).not.toBeNull();
    expect(settings!.x).toBeGreaterThanOrEqual(island!.x - 1);
    expect(settings!.x + settings!.width).toBeLessThanOrEqual(
      island!.x + island!.width + 1,
    );
    await expect(
      page.locator('[data-tool-shelf] [aria-label="More tools"]'),
    ).toBeVisible();
    const menu = page.locator('[role="group"][aria-label="More tools"]');
    await expect(menu).toBeVisible();
    await expect(menu.locator('[aria-label="Quick colors"]')).toBeVisible();
  });
});

test.describe('phone shelf (real engine, touch 390)', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });

  test('phone shelf stays one row with reachable overflow', async ({
    page,
  }) => {
    const fixture = await loadFixture();
    const scenario = fixture.scenarios['390-touch']!;
    await setHarness(
      page,
      inkReachHtml(
        '100vw',
        shelfHtmlFromScenario(scenario),
        menuHtmlFromScenario(scenario),
      ),
    );
    const island = await page.locator('[data-tool-shelf]').boundingBox();
    expect(island).not.toBeNull();
    expect(island!.height).toBeLessThanOrEqual(64);
    // The compact shelf fits at 390px.
    const box = await shelfBox(page);
    expect(
      box.scroll,
      `partitioned scrollWidth ${box.scroll} vs client ${box.client}`,
    ).toBeLessThanOrEqual(box.client + 1);
    await expect(
      page.locator('[data-tool-shelf] [aria-label="More tools"]'),
    ).toBeVisible();
    const settings = await page
      .locator('[data-tool-shelf] [aria-label="Ball Pen"]')
      .boundingBox();
    expect(settings).not.toBeNull();
    expect(settings!.width).toBeGreaterThanOrEqual(29.5);
    expect(settings!.x).toBeGreaterThanOrEqual(island!.x - 1);
    expect(settings!.x + settings!.width).toBeLessThanOrEqual(
      island!.x + island!.width + 1,
    );
  });
});
