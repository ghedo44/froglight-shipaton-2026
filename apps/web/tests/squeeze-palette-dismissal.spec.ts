/**
 * Squeeze palette dismissal in Chromium.
 *
 * Real headless-Chromium interaction against the REAL
 * `StylusPaletteOverlay` (source + real CSS modules, served by a vite dev
 * server over `tests/fixtures/squeeze-palette`): DOM geometry (tip
 * clearance, in-viewport panel, viewport-covering backdrop), outside
 * mouse/touch/Pencil DOWN closes, inside tool executes + stays open +
 * refreshes in place, Escape closes, editor focus never moves, and nothing
 * draws through to the canvas underneath.
 *
 * Run: `pnpm --filter @froglight/web exec playwright test
 * squeeze-palette-dismissal` (shares the repo Playwright install; the app
 * preview webServer from the base config is unused by these tests).
 */
/**
 * Squeeze palette dismissal in Chromium.
 *
 * Real headless-Chromium interaction against the REAL
 * `StylusPaletteOverlay` (source + real CSS modules, prebuilt by the vite
 * CLI and served statically from `tests/fixtures/squeeze-palette`): DOM
 * geometry (tip clearance, in-viewport panel, viewport-covering backdrop),
 * outside mouse/touch/Pencil DOWN closes, inside tool executes + stays
 * open + refreshes in place, Escape closes, editor focus never moves, and
 * nothing draws through to the canvas underneath.
 *
 * The fixture bundle is heavy (the overlay reaches the foundation barrel,
 * like the app build) so it builds lazily on first use and is reused while
 * worktree sources are unchanged (git worktree key in `dist-t2/.srckey`).
 * `dist-t2/` is harness scratch (gitignored), never a committed artifact.
 *
 * Run: `pnpm --filter @froglight/web exec playwright test
 * squeeze-palette-dismissal` (shares the repo Playwright install; the app
 * preview webServer from the base config is unused by these tests).
 */
import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';

declare global {
  interface Window {
    __squeeze: {
      show(anchor?: { x: number; y: number }): void;
      close(): void;
      commitEraser(): void;
      strokes(): string[];
      log(): string[];
    };
  }
}

// The lazy harness build runs under the first test's budget; give the file
// a generous cap so a cold fixture build never trips the default timeout.
test.describe.configure({ timeout: 180000 });

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const testsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testsDir, '..', '..', '..');
const fixtureDir = join(repoRoot, 'apps/web/tests/fixtures/squeeze-palette');
const fixtureOut = join(fixtureDir, 'dist-t2');

let harnessPromise: Promise<string> | null = null;
let server: Server | null = null;

/**
 * Worktree key for the fixture bundle: HEAD plus the status of every source
 * tree the bundle reaches. Any edit/add/delete under them invalidates the
 * cache; a missing key (or no git) rebuilds. Fail-safe, never stale.
 */
function fixtureSourceKey(): string | null {
  try {
    const status = execFileSync(
      'git',
      [
        'status',
        '--porcelain=v1',
        '--',
        'packages/ui/src',
        'packages/foundation/src',
        'apps/web/tests/fixtures/squeeze-palette',
      ],
      { cwd: repoRoot, encoding: 'utf8', timeout: 60000 },
    );
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 60000,
    }).trim();
    return `${head}\n${status}`;
  } catch {
    return null;
  }
}

function buildFixture(): Promise<void> {
  // Prebuild through the Vite CLI; the spec code never imports Vite.
  // the dedicated vite.config.ts next to the fixture owns the build
  // tooling). Build failures reject with the CLI output.
  const viteCli = join(
    testsDir,
    '..',
    'node_modules',
    'vite',
    'bin',
    'vite.js',
  );
  return new Promise<void>((resolve, reject) => {
    execFile(
      process.execPath,
      [viteCli, 'build', '--config', join(fixtureDir, 'vite.config.ts')],
      // The CLI roots itself at its cwd, so run it from the fixture dir:
      // outDir lands in the fixture's dist-t2, never in the app tree.
      { timeout: 170000, cwd: fixtureDir },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(
            new Error(
              `squeeze fixture build failed: ${stderr || stdout || error.message}`,
            ),
          );
        } else {
          resolve();
        }
      },
    );
  });
}

function serveFixture(): Promise<string> {
  server = createServer(async (req, res) => {
    try {
      const path =
        typeof req.url !== 'string' || req.url === '/' ? '/index.html' : req.url;
      const body = await readFile(join(fixtureOut, decodeURIComponent(path)));
      res.writeHead(200, {
        'content-type': CONTENT_TYPES[extname(path)] ?? 'application/octet-stream',
      });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  return new Promise<string>((resolve) => {
    server?.listen(0, '127.0.0.1', () => {
      const address = server?.address();
      const port =
        typeof address === 'object' && address !== null ? address.port : 0;
      resolve(`http://127.0.0.1:${port}/`);
    });
  });
}

/**
 * Lazily built + served harness (cached per process, reused across tests;
 * rebuilt across runs only when worktree sources changed). Called at the
 * start of each test so the cold build runs under a test timeout, never
 * under the 30s hook budget. Serial e2e workers share it safely through
 * the cached promise.
 */
function ensureHarness(): Promise<string> {
  if (harnessPromise === null) {
    harnessPromise = (async () => {
      const keyPath = join(fixtureOut, '.srckey');
      const key = fixtureSourceKey();
      let fresh = false;
      if (key !== null) {
        try {
          fresh = (await readFile(keyPath, 'utf8')) === key;
        } catch {
          fresh = false;
        }
      }
      if (!fresh) {
        await buildFixture();
        if (key !== null) await writeFile(keyPath, key);
      }
      return serveFixture();
    })();
  }
  return harnessPromise;
}

test.afterAll(async () => {
  harnessPromise = null;
  await new Promise<void>((resolve, reject) =>
    server == null
      ? resolve()
      : server.close((error) => (error ? reject(error) : resolve())),
  );
  server = null;
  // dist-t2/ stays on disk as a worktree-keyed cache (gitignored harness
  // scratch); the next run rebuilds only when sources changed.
});

test('outside mouse DOWN closes; geometry clears the tip; no stuck backdrop', async ({
  page,
}) => {
  await page.goto(await ensureHarness());
  await page.click('#show');
  const dialog = page.getByRole('dialog', { name: 'Pencil palette' });
  await expect(dialog).toBeVisible();
  // Geometry: the panel rests beside the Pencil tip, never centered over it.
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  const anchor = { x: 500, y: 400 };
  expect(
    Math.abs((box?.x ?? anchor.x) - anchor.x) > 1 ||
      Math.abs((box?.y ?? anchor.y) - anchor.y) > 1,
  ).toBe(true);
  // The panel stays inside the viewport.
  const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
  expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
    viewport.width,
  );
  // The backdrop covers the viewport so outside DOWN always lands on it.
  const backdropBox = await page
    .locator('div[class*="backdrop"]')
    .boundingBox();
  expect(backdropBox?.width ?? 0).toBeGreaterThanOrEqual(viewport.width - 1);
  expect(backdropBox?.height ?? 0).toBeGreaterThanOrEqual(viewport.height - 1);
  // Outside mouse DOWN closes and removes the backdrop; onClose logged.
  await page.mouse.click(20, 700);
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('div[class*="backdrop"]')).toHaveCount(0);
  await expect
    .poll(async () => page.evaluate(() => window.__squeeze.log()))
    .toContain('close');
  // Click-through works: no stuck backdrop or pointer capture swallows the
  // probe underneath.
  await page.click('#probe');
  await expect(page.locator('#probe')).toContainText('Probe 1');
});

test('inside tool executes, stays open, refreshes in place, draws nothing through', async ({
  page,
}) => {
  await page.goto(await ensureHarness());
  await page.click('#show');
  const dialog = page.getByRole('dialog', { name: 'Pencil palette' });
  await expect(dialog).toBeVisible();
  // Mark the live node: an in-place refresh keeps it, a remount drops it.
  await dialog.evaluate((el) => {
    el.setAttribute('data-t2-probe', 'live');
  });
  await page.getByRole('button', { name: 'Eraser', exact: true }).click();
  await expect
    .poll(async () => page.evaluate(() => window.__squeeze.log()))
    .toContain('tool:ink.tool.eraser');
  // Executes AND stays open (never outside-closed, never toggle-closed).
  await expect(dialog).toBeVisible();
  await expect
    .poll(async () => page.evaluate(() => window.__squeeze.log()))
    .not.toContain('close');
  // In-place model refresh flips pressed state on the same node. The driver
  // button sits under the open backdrop by design, so drive it through the
  // exposed fixture API (programmatic click, not a covered pointer click).
  await page.evaluate(() => window.__squeeze.commitEraser());
  await expect(
    page.getByRole('button', { name: 'Eraser', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-t2-probe="live"]')).toHaveCount(1);
  // The mouse DOWN on the tool never drew through to the canvas underneath.
  expect(await page.evaluate(() => window.__squeeze.strokes())).toEqual([]);
});

test('outside touch DOWN closes', async ({ browser }) => {
  const context = await browser.newContext({
    hasTouch: true,
    viewport: { width: 1280, height: 720 },
  });
  const touch = await context.newPage();
  try {
    await touch.goto(await ensureHarness());
    await touch.tap('#show');
    await expect(
      touch.getByRole('dialog', { name: 'Pencil palette' }),
    ).toBeVisible();
    await touch.touchscreen.tap(20, 700);
    await expect(
      touch.getByRole('dialog', { name: 'Pencil palette' }),
    ).toHaveCount(0);
    await expect
      .poll(async () => touch.evaluate(() => window.__squeeze.log()))
      .toContain('close');
  } finally {
    await context.close();
  }
});

test('Escape closes; the palette never steals editor focus', async ({
  page,
}) => {
  await page.goto(await ensureHarness());
  await page.click('#show');
  const dialog = page.getByRole('dialog', { name: 'Pencil palette' });
  await expect(dialog).toBeVisible();
  await page.focus('#editor');
  expect(
    await page.evaluate(() => document.activeElement?.id ?? ''),
  ).toBe('editor');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  // Focus never moved into the palette and never summoned anything else.
  expect(
    await page.evaluate(() => document.activeElement?.id ?? ''),
  ).toBe('editor');
  await expect
    .poll(async () => page.evaluate(() => window.__squeeze.log()))
    .toContain('close');
});

test('Pencil pointer DOWN outside closes; on-panel pen never draws through', async ({
  page,
}) => {
  await page.goto(await ensureHarness());
  await page.evaluate(() => window.__squeeze.show({ x: 500, y: 400 }));
  const dialog = page.getByRole('dialog', { name: 'Pencil palette' });
  await expect(dialog).toBeVisible();
  // Pen DOWN on the panel is absorbed at the overlay layer: no stroke below.
  await page.evaluate(() => {
    const panel = document.querySelector('[role="dialog"]') as HTMLElement;
    const rect = panel.getBoundingClientRect();
    panel.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        pointerType: 'pen',
        clientX: rect.left + 10,
        clientY: rect.top + 10,
      }),
    );
  });
  expect(await page.evaluate(() => window.__squeeze.strokes())).toEqual([]);
  await expect(dialog).toBeVisible();
  // Pen DOWN outside closes.
  await page.evaluate(() => {
    const backdrop = document.querySelector(
      'div[class*="backdrop"]',
    ) as HTMLElement;
    backdrop.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        pointerType: 'pen',
        clientX: 20,
        clientY: 700,
      }),
    );
  });
  await expect(dialog).toHaveCount(0);
});

test('five tools and settings stay close together; presets use the same arc', async ({ page }) => {
  await page.goto(await ensureHarness());
  await page.click('#show');
  const dialog = page.getByRole('dialog', { name: 'Pencil palette' });
  const rail = page.getByRole('toolbar', { name: 'Drawing tools' });
  await expect(rail.getByRole('button')).toHaveCount(7);
  await expect(rail.locator('[data-squeeze-tier="primary"]')).toHaveText([
    'Pen', 'Fountain Pen', 'Highlighter', 'Lasso', 'Eraser',
  ]);
  const centers = await rail.getByRole('button').evaluateAll((buttons) =>
    buttons.map((button) => {
      const rect = button.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, width: rect.width };
    }),
  );
  for (const center of centers) {
    expect(Math.hypot(center.x - 500, center.y - 400)).toBeCloseTo(184, 1);
  }
  for (let i = 1; i < centers.length; i++) {
    const before = centers[i - 1]!;
    const after = centers[i]!;
    expect(after.width).toBeGreaterThanOrEqual(44);
    const distance = Math.hypot(after.x - before.x, after.y - before.y);
    expect(distance).toBeGreaterThanOrEqual(44);
    expect(distance).toBeLessThan(50);
  }
  const before = await dialog.boundingBox();
  await page.getByRole('button', { name: 'Stroke color', exact: true }).click();
  await expect(page.getByRole('toolbar', { name: 'Color presets' }).getByRole('button', { name: /^Color #/ })).toHaveCount(3);
  await page.getByRole('button', { name: 'Color #ca4036' }).click();
  await expect(page.locator('#log')).toContainText('color:ink.color=#ca4036');
  expect(await dialog.boundingBox()).toEqual(before);
  await page.getByRole('button', { name: 'Stroke width', exact: true }).click();
  await page.getByRole('button', { name: '3.5 px', exact: true }).click();
  await expect(page.locator('#log')).toContainText('width:ink.width=3.5');
  await page.getByRole('button', { name: 'Back to drawing tools' }).click();
  await expect(rail.getByRole('button')).toHaveCount(7);
  expect(await page.evaluate(() => window.__squeeze.strokes())).toEqual([]);
});
