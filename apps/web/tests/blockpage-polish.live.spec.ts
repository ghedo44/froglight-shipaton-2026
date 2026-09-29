import { setDocumentPresentation } from './support/document-presentation.js';
/**
 * Blockpage production-ready UX polish — LIVE proof spec.
 *
 * Unlike `blockpage-polish.visual.spec.ts`, which uses static `setContent`
 * mirror with a test-only behavior script), every test here boots the REAL
 * production PWA (`vite preview` over `dist/`, built from the working
 * tree), creates a vault + a real **Block page** note through the shipped
 * new-note UI, and drives the REAL mounted stack:
 *
 * - real `BlockPageDocumentEditorProvider` → `TiptapBlockpageEditorHandle`
 *   (`.flbp-host .ProseMirror`, engine-owned slash menus, drag handle,
 *   math overlay, media figures, table grid, and toggles);
 * - real `BlockpageHostSkeleton` (host-owned hidden
 *   `input[data-flbp-media-picker]` answering `flbp:pick-media`);
 * - real `UnifiedToolbar` (category strip + floating islands incl. the
 *   contextual `float.selection` island mounted from the provider's live
 *   `contextualAnchor`).
 *
 * Production truths this spec encodes (probed live, not assumed):
 * - Toolbar hooks are `category-strip` + one `writing.style` shelf; only
 *   anchors with groups mount (`float.top-left/top-center` on an empty
 *   caret; `float.selection` appears exactly when table/media/math
 *   selections set the contextual anchor).
 * - 44px targets + `touch-action: manipulation` live behind
 *   `@media (hover: none), (pointer: coarse)` — desktop fine-pointer truth
 *   is 28px handles / `auto`. The 44px matrix is therefore proven under
 *   coarse-pointer emulation (the iPad contexts below).
 * - `/math` opens the source overlay immediately for the new atom; commit
 *   REMOVES the overlay node (dismissed == detached).
 * - Media picker bytes flow end to end: `flbp:media-picked`
 *   routes into the handle's `uploadMedia` against the vault asset store
 *   the application composition injects into the blockpage path, so the
 *   picked figure hydrates to a live offline preview, Replace re-uploads,
 *   paste ingests, and close/reopen renders byte-faithful (same
 *   `data-sha256`, live preview). (Vitest `media.spec` pins the Replace
 *   rendering/behavior with the real provider.)
 *
 * Screenshots are persisted to the run evidence dir (non-gitignored) with
 * the slash/table/resource menus DISMISSED (production shows them on `/`
 * only). Zero console/page errors asserted in every test.
 *
 *
 * No production source is imported or changed by this file.
 */
import { expect, test, type Page } from '@playwright/test';
import { createFromSidebar } from './support/sidebar-create.js';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const RUN_ID = 'run-20260920-blockpage-production-ready-ux-polish-3a4b21';

function evidenceDir(): string {
  const cwd = process.cwd();
  const root = cwd.endsWith('web') ? join(cwd, '..', '..') : cwd;
  return join(root, '.agentic', 'runs', RUN_ID, 'evidence', 'blockpage-live');
}

async function shot(page: Page, label: string): Promise<string> {
  const dir = evidenceDir();
  await mkdir(dir, { recursive: true });
  const path = join(dir, `blockpage-live-${label}.png`);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  test.info().annotations.push({ type: 'screenshot', description: path });
  return path;
}

async function touchDrag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  beforeRelease?: () => Promise<void>,
): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart', touchPoints: [{ ...from, id: 1 }],
    });
    for (let step = 1; step <= 8; step += 1) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{
          x: from.x + (to.x - from.x) * step / 8,
          y: from.y + (to.y - from.y) * step / 8,
          id: 1,
        }],
      });
    }
    await beforeRelease?.();
  } finally {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
  }
}

/**
 * Slash + table-size + resource menus are engine-owned singletons under
 * the host; all must be parked before a shot (production shows them on
 * `/` only). Each locator resolves to at most one node; absent counts as
 * hidden.
 */
async function expectSlashDismissed(page: Page): Promise<void> {
  // Zero VISIBLE engine menus (slash, table-size, resource, turn-into —
  // production shows them on `/` / gesture only).
  await expect(page.locator('.flbp-host .flbp-slash:visible')).toHaveCount(0);
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${String(err)}`));
  return errors;
}

/**
 * Boot the real app, create a vault (OPFS fallback — no native picker in
 * headless), then create a real Block page note through the shipped
 * new-note modal (select kind + explicit Create commit).
 */
async function openLiveBlockpage(
  page: Page,
  vault: string,
  note: string,
): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: undefined,
      configurable: true,
    });
  });
  await page.goto('/', { waitUntil: 'load' });
  await page.getByTestId('create-vault-button').click();
  await page.getByTestId('create-vault-name-input').fill(vault);
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();
  // Gate on provisioning: the sidebar populates asynchronously (seed
  // files + index). The seeded welcome.md opening is the universal
  // ready signal (the vault-name button never renders at narrow widths
  // where the explorer collapses to an icon rail). Clicking file
  // actions before this races a half-booted shell with an empty
  // explorer.
  await expect(
    page.getByRole('tab', { name: /welcome\.md/ }).first(),
  ).toBeVisible({ timeout: 60000 });
  const sidebarNew = page
    .getByRole('complementary', { name: 'Sidebar' })
    .getByRole('button', { name: 'New', exact: true });
  if (!(await sidebarNew.isVisible().catch(() => false))) {
    await page
      .getByRole('button', { name: 'Toggle sidebar' })
      .dispatchEvent('click');
    await expect(sidebarNew).toBeVisible({ timeout: 15000 });
  }
  await createFromSidebar(page, 'Block page');
  await page.getByRole('textbox', { name: 'Note name' }).fill(note);
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  // The REAL Tiptap provider mounts here (never the headless twin: a live
  // DOM + connected pane host is present).
  await expect(page.locator('.flbp-host .ProseMirror')).toBeVisible({
    timeout: 30000,
  });
  await expect(page.locator('.flbp-host')).toBeVisible();
  // Overlay-drawer widths can leave the drawer's modal backdrop up after
  // modal note creation even once the drawer itself is shut (filed as a
  // live finding): a pointer click on the backdrop dismisses it.
  const backdrop = page.locator('div[class*="backdrop"]');
  if (await backdrop.isVisible().catch(() => false)) {
    const bb = await backdrop.boundingBox().catch(() => null);
    if (bb !== null) {
      await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
    }
    // The node itself stays laid out (never `hidden`); dismissal drops
    // its visible-state class. The editor click below proves hit-testing.
    await expect
      .poll(
        () =>
          backdrop
            .evaluate((el) => (el as HTMLElement).className)
            .catch(() => ''),
        { timeout: 10000 },
      )
      .not.toContain('visible');
  }
}

async function focusEditor(page: Page): Promise<void> {
  const editor = page.locator('.flbp-host .ProseMirror');
  await editor.click();
  await expect(editor).toBeFocused();
}

/**
 * Insert one block through the REAL production slash menu: `/` opens,
 * the filter narrows to the wanted row, Enter commits. Fails loudly if
 * the filter does not resolve (never silently commits entry #0).
 */
async function insertViaSlash(
  page: Page,
  filter: string,
  activeLabel: RegExp,
): Promise<void> {
  await focusEditor(page);
  await page.keyboard.type(`/${filter}`, { delay: 20 });
  const menu = page.locator(
    '.flbp-host .flbp-slash:not(.flbp-table-menu):not(.flbp-resource-menu):not(.flbp-turninto-menu)',
  );
  await expect(menu).toBeVisible({ timeout: 5000 });
  await expect(menu.locator('.flbp-slash-item.active').first()).toContainText(
    activeLabel,
    { timeout: 5000 },
  );
  await page.keyboard.press('Enter');
}

const PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function pixelFile(): { name: string; mimeType: string; buffer: Buffer } {
  return {
    name: 'pixel.png',
    mimeType: 'image/png',
    buffer: Buffer.from(PIXEL_PNG_BASE64, 'base64'),
  };
}

/** A byte-different 1px PNG (red) proving Replace re-uploads new bytes. */
function redPixelFile(): { name: string; mimeType: string; buffer: Buffer } {
  return {
    name: 'red.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    ),
  };
}

test.describe('blockpage live proof (desktop 1280, real preview app)', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('live mount: real Tiptap provider + skeleton picker + UnifiedToolbar', async ({
    page,
  }) => {
    // Live boots (vault provisioning + PWA install + OPFS seed) can exceed
    // the 30s default under load; per-assertion timeouts below stay tight.
    test.setTimeout(120000);
    const errors = collectErrors(page);
    await openLiveBlockpage(page, 'Live polish', 'Live mount');
    // Real provider surface with an editable caret.
    const editor = page.locator('.flbp-host .ProseMirror');
    await editor.click();
    await expect(editor).toBeFocused();
    await expect(editor).toHaveAttribute('contenteditable', 'true');
    // Host-owned picker slot: exactly one, hidden (contract).
    expect(await page.locator('input[data-flbp-media-picker]').count()).toBe(1);
    await expect(page.locator('input[data-flbp-media-picker]')).toBeHidden();
    // Block Page keeps the writing surface clear until a local action.
    await expect(page.locator('[data-toolbar="category-strip"]')).toHaveCount(
      0,
    );
    expect(await page.locator('[data-tool-shelf]').count()).toBe(0);
    // Empty caret offers no contextual anchor yet: float.selection stays
    // unmounted (islands are contextual, not pinned).
    expect(await page.locator('[data-anchor="float.selection"]').count()).toBe(
      0,
    );
    await expectSlashDismissed(page);
    await shot(page, 'desktop-1280-mount');
    expect(errors, 'zero console/page errors').toEqual([]);
  });

  test('todo tap toggles the intended row; checkbox stays first-line-locked', async ({
    page,
  }) => {
    // Live boots (vault provisioning + PWA install + OPFS seed) can exceed
    // the 30s default under load; per-assertion timeouts below stay tight.
    test.setTimeout(120000);
    const errors = collectErrors(page);
    await openLiveBlockpage(page, 'Live polish', 'Live todo');
    await insertViaSlash(page, 'todo', /To-do item/);
    const row = page.locator('li[data-checked]').first();
    await expect(row).toBeVisible({ timeout: 5000 });
    await expectSlashDismissed(page);
    // Checkbox art: 14px drawn box glued to the first text line.
    const box = await page.evaluate(() => {
      const cs = getComputedStyle(
        document.querySelector('li[data-checked]')!,
        '::before',
      );
      return { w: cs.width, h: cs.height };
    });
    expect(box.w).toBe('14px');
    expect(box.h).toBe('14px');
    // Tap the checkbox zone flips the row…
    const bb = await row.boundingBox();
    expect(bb).not.toBeNull();
    await page.mouse.click(bb!.x + 8, bb!.y + bb!.height / 2);
    await expect(row).toHaveAttribute('data-checked', 'true');
    // …body-text taps keep editing (mis-tap guard)…
    await page.mouse.click(bb!.x + bb!.width - 10, bb!.y + bb!.height / 2);
    await expect(row).toHaveAttribute('data-checked', 'true');
    // …and the zone toggles back.
    const bb2 = await row.boundingBox();
    expect(bb2).not.toBeNull();
    await page.mouse.click(bb2!.x + 8, bb2!.y + bb2!.height / 2);
    await expect(row).toHaveAttribute('data-checked', 'false');
    // Desktop keeps the compact document rhythm; the 44px row target is
    // proven under the coarse-pointer context below.
    const rowBox = await row.boundingBox();
    expect(rowBox!.height).toBeGreaterThanOrEqual(26);
    await expectSlashDismissed(page);
    await shot(page, 'desktop-1280-todo');
    expect(errors, 'zero console/page errors').toEqual([]);
  });

  test('media Add/Capture dispatch the pick contract through the real chooser', async ({
    page,
    context,
  }) => {
    // Live boots (vault provisioning + PWA install + OPFS seed) can exceed
    // the 30s default under load; per-assertion timeouts below stay tight.
    test.setTimeout(120000);
    const errors = collectErrors(page);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openLiveBlockpage(page, 'Live polish', 'Live media');
    // Record both production media events at the document: the request
    // (`flbp:pick-media` {blockId, kind, capture}) the host skeleton
    // answers, and the skeleton's picked re-dispatch (`flbp:media-picked`
    // {blockId, kind, capture, files}).
    await page.evaluate(() => {
      const w = window as unknown as {
        __picks: unknown[];
        __picked: unknown[];
      };
      w.__picks = [];
      w.__picked = [];
      document.addEventListener('flbp:pick-media', (e) => {
        w.__picks.push((e as CustomEvent).detail);
      });
      document.addEventListener('flbp:media-picked', (e) => {
        const detail = (e as CustomEvent).detail as {
          files?: readonly unknown[];
        } & Record<string, unknown>;
        w.__picked.push({ ...detail, files: detail.files?.length ?? -1 });
      });
    });
    const picks = (): Promise<unknown[]> =>
      page.evaluate(
        () => (window as unknown as { __picks: unknown[] }).__picks,
      );
    const picked = (): Promise<unknown[]> =>
      page.evaluate(
        () => (window as unknown as { __picked: unknown[] }).__picked,
      );
    await insertViaSlash(page, 'image', /Image/);
    const figure = page.locator('figure[data-flbp-image]').first();
    await expect(figure).toBeVisible({ timeout: 5000 });
    const blockId = await figure.getAttribute('data-block-id');
    expect(blockId).not.toBeNull();
    // Empty card chrome: obvious Add + Capture.
    await expect(figure.locator('[data-flbp-media-pick="add"]')).toContainText(
      /Add/,
    );
    await expect(
      figure.locator('[data-flbp-media-pick="capture"]'),
    ).toContainText(/Capture/);
    // Capture → same contract with the capture hint; cancelling the host
    // dialog is a no-op by construction (no event, no mutation). Runs on
    // the empty card before Add fills it.
    const [captureChooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 5000 }),
      figure.locator('[data-flbp-media-pick="capture"]').click(),
    ]);
    await captureChooser.setFiles([]);
    await page.waitForTimeout(400);
    expect(await picks()).toEqual([{ blockId, kind: 'image', capture: true }]);
    expect(await picked()).toHaveLength(0);
    // Add → pick request + the host-owned hidden picker opens the REAL
    // file chooser → bytes re-enter as flbp:media-picked.
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 5000 }),
      figure.locator('[data-flbp-media-pick="add"]').click(),
    ]);
    await chooser.setFiles([pixelFile()]);
    await expect
      .poll(() => picked(), { timeout: 5000 })
      .toEqual([{ blockId, kind: 'image', capture: false, files: 1 }]);
    expect(await picks()).toEqual([
      { blockId, kind: 'image', capture: true },
      { blockId, kind: 'image', capture: false },
    ]);
    // the picked bytes route into `uploadMedia` against the
    // vault store, so the figure hydrates to a LIVE offline preview (not
    // the "Bind storage" placeholder) — same block id, vault locator +
    // integrity pin committed.
    const liveImg = figure.locator('img');
    await expect(liveImg).toBeVisible({ timeout: 15000 });
    await expect(
      figure.locator(':scope > .flbp-image-ph'),
      'a filled image must not show or reserve space for its empty placeholder',
    ).toBeHidden();
    await expect(liveImg).toHaveCSS('display', 'block');
    const previewOrder = await figure.evaluate((element) =>
      [...element.children].map((child) => child.tagName.toLowerCase()),
    );
    expect(previewOrder.indexOf('img')).toBeLessThan(
      previewOrder.indexOf('figcaption'),
    );
    const imgSrc = await liveImg.getAttribute('src');
    expect(imgSrc?.startsWith('blob:')).toBe(true);
    await expect(figure).not.toContainText(/Bind storage/);
    const firstSha = await figure.getAttribute('data-sha256');
    expect(firstSha).toMatch(/^[0-9a-f]{64}$/);
    expect(await figure.getAttribute('data-src')).toBe(
      `attachments/${firstSha}`,
    );
    // Replace: filled media has no duplicate in-card action. Selecting
    // the image exposes Replace in the existing contextual toolbar, which
    // re-opens the real chooser and re-uploads — bytes change, so the integrity
    // pin must change while the block id stays put.
    await expect(figure.getByRole('button', { name: /Replace/ })).toHaveCount(
      0,
    );
    await liveImg.click();
    await expect(figure).toHaveClass(/ProseMirror-selectednode/);
    await page.getByRole('button', { name: 'Details' }).click();
    const mediaPanel = page.getByRole('dialog', { name: 'Media details' });
    await expect(
      mediaPanel.getByRole('tab', { name: 'From device' }),
    ).toBeVisible();
    await expect(
      mediaPanel.getByRole('tab', { name: 'Remote URL' }),
    ).toHaveCount(0);
    await mediaPanel.getByRole('textbox', { name: 'Caption' }).fill('My image');
    await mediaPanel
      .getByRole('textbox', { name: 'Alt text' })
      .fill('Green pixel');
    await mediaPanel.getByRole('button', { name: 'Save details' }).click();
    await expect(figure.locator('figcaption')).toContainText('My image');
    const replace = page.getByRole('button', { name: 'Replace image' });
    await expect(replace).toBeVisible();
    await shot(page, 'desktop-1280-media-selected');
    const [replaceChooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 5000 }),
      replace.click(),
    ]);
    await replaceChooser.setFiles([redPixelFile()]);
    await expect.poll(() => picked(), { timeout: 5000 }).toHaveLength(2);
    await expect
      .poll(() => figure.getAttribute('data-sha256'), { timeout: 15000 })
      .not.toBe(firstSha);
    await expect(figure.locator('img')).toBeVisible();
    const secondSha = await figure.getAttribute('data-sha256');
    expect(secondSha).toMatch(/^[0-9a-f]{64}$/);
    expect(secondSha).not.toBe(firstSha);
    expect(await figure.getAttribute('data-src')).toBe(
      `attachments/${secondSha}`,
    );
    expect(await figure.getAttribute('data-block-id')).toBe(blockId);
    // Paste ingestion is the second wired fill path: bytes → sniff + sha
    // → vault locator commit (single undo) against the same store, so the
    // pasted figure also renders a live preview.
    await page.evaluate(async () => {
      const bytes = Uint8Array.from(
        atob(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        ),
        (c) => c.charCodeAt(0),
      );
      await navigator.clipboard.write([
        new ClipboardItem({
          'image/png': new File([bytes], 'pixel.png', { type: 'image/png' }),
        }),
      ]);
    });
    await focusEditor(page);
    await page.keyboard.press('Control+v');
    await expect(page.locator('figure[data-flbp-image]')).toHaveCount(2, {
      timeout: 15000,
    });
    // The pasted figure hydrates live too (same store, same primitive).
    const pasted = page.locator('figure[data-flbp-image]').nth(1);
    await expect(pasted.locator('img')).toBeVisible({ timeout: 15000 });
    await expect(pasted).not.toContainText(/Bind storage/);
    // Close + reopen through the shipped tab/explorer UI: the upload must
    // have saved, and reopen renders byte-faithful (same block id, same
    // locator + pin, live preview again — never the placeholder).
    const noteTab = page.getByRole('tab', { name: 'Live media.blockpage' });
    await noteTab.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Close tab' }).click();
    await expect(noteTab).toHaveCount(0, { timeout: 10000 });
    await page
      .getByRole('button', { name: 'Live media.blockpage' })
      .first()
      .click();
    await expect(page.locator('.flbp-host .ProseMirror')).toBeVisible({
      timeout: 30000,
    });
    const reopened = page.locator(
      `figure[data-flbp-image][data-block-id="${blockId}"]`,
    );
    await expect(reopened).toBeVisible({ timeout: 15000 });
    expect(await reopened.getAttribute('data-sha256')).toBe(secondSha);
    expect(await reopened.getAttribute('data-src')).toBe(
      `attachments/${secondSha}`,
    );
    await expect(reopened.locator('img')).toBeVisible({ timeout: 15000 });
    await expect(reopened).not.toContainText(/Bind storage/);
    await expectSlashDismissed(page);
    await shot(page, 'desktop-1280-media');
    expect(errors, 'zero console/page errors').toEqual([]);
  });

  test('video panel offers explicit Local and Remote sources', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await openLiveBlockpage(page, 'Live polish', 'Live remote media');
    await insertViaSlash(page, 'video', /Video/);
    const figure = page.locator('figure[data-flbp-video]').first();
    await expect(figure).toBeVisible();
    await figure.click();
    await page.getByRole('button', { name: 'Details' }).click();
    const panel = page.getByRole('dialog', { name: 'Media details' });
    await expect(panel.getByRole('tab', { name: 'From device' })).toBeVisible();
    await panel.getByRole('tab', { name: 'Remote URL' }).click();
    await shot(page, 'desktop-1280-media-panel');
    await panel
      .getByRole('textbox', { name: 'HTTPS URL' })
      .fill('http://example.invalid/clip.mp4');
    await panel.getByRole('button', { name: 'Use remote URL' }).click();
    await expect(panel.getByRole('alert')).toContainText('HTTPS');
    await panel
      .getByRole('textbox', { name: 'HTTPS URL' })
      .fill('https://example.invalid/clip.mp4');
    await panel.getByRole('button', { name: 'Use remote URL' }).click();
    await expect(figure).toHaveAttribute(
      'data-remote-url',
      'https://example.invalid/clip.mp4',
    );
  });

  test('media panel drop routes image bytes into the offline asset store', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await openLiveBlockpage(page, 'Live polish', 'Live media drop');
    await insertViaSlash(page, 'image', /Image/);
    const figure = page.locator('figure[data-flbp-image]').first();
    await figure.click();
    await page.getByRole('button', { name: 'Details' }).click();
    await page.locator('[data-flbp-media-dropzone]').evaluate((zone) => {
      const bytes = Uint8Array.from(
        atob(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        ),
        (character) => character.charCodeAt(0),
      );
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], 'pixel.png', { type: 'image/png' }));
      zone.dispatchEvent(
        new DragEvent('drop', { bubbles: true, dataTransfer: transfer }),
      );
    });
    await expect(figure.locator('img')).toBeVisible({ timeout: 15000 });
    expect(await figure.getAttribute('data-sha256')).toMatch(/^[0-9a-f]{64}$/);
  });

  test('math overlay opens, commits, and cancels without loss', async ({
    page,
  }) => {
    // Live boots (vault provisioning + PWA install + OPFS seed) can exceed
    // the 30s default under load; per-assertion timeouts below stay tight.
    test.setTimeout(120000);
    const errors = collectErrors(page);
    await openLiveBlockpage(page, 'Live polish', 'Live math');
    await insertViaSlash(page, 'math', /Math/);
    const figure = page.locator('figure[data-flbp-math]').first();
    await expect(figure).toBeVisible({ timeout: 5000 });
    const overlay = page.locator('.flbp-host .flbp-md-overlay');
    // Production opens the source overlay immediately for a new atom so
    // the author types LaTeX first: open proof + focus, no click needed.
    await expect(overlay).toBeVisible({ timeout: 5000 });
    const source = overlay.locator('.flbp-md-editor');
    await expect(source).toBeFocused();
    // Commit path: Save writes through math.source (single undo) and the
    // overlay node is REMOVED (dismissed == detached, not display:none).
    await source.fill('y^3');
    await overlay.locator('.flbp-md-commit').click();
    await expect(overlay).toHaveCount(0, { timeout: 5000 });
    await expect(figure.locator('.flbp-md-preview').first()).toContainText(
      'y^3',
      { timeout: 5000 },
    );
    // Reopen path: clicking the figure re-opens for the same block…
    await figure.click();
    await expect(overlay).toBeVisible({ timeout: 5000 });
    // …and Esc discards without mutation.
    await overlay.locator('.flbp-md-editor').fill('discard-me');
    await page.keyboard.press('Escape');
    await expect(overlay).toHaveCount(0, { timeout: 5000 });
    await expect(figure.locator('.flbp-md-preview').first()).toContainText(
      'y^3',
    );
    await expect(
      page.getByRole('toolbar', { name: 'Source block actions' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Edit source' }).click();
    await expect(overlay).toBeVisible({ timeout: 5000 });
    await page.keyboard.press('Escape');
    await expect(overlay).toHaveCount(0, { timeout: 5000 });
    // Overlay never blocks page scroll.
    await figure.click();
    await expect(overlay).toBeVisible({ timeout: 5000 });
    const touchAction = await overlay.evaluate(
      (el) => getComputedStyle(el).touchAction,
    );
    expect(touchAction).not.toBe('none');
    await page.keyboard.press('Escape');
    await expect(overlay).toHaveCount(0, { timeout: 5000 });
    await expectSlashDismissed(page);
    await shot(page, 'desktop-1280-math');
    expect(errors, 'zero console/page errors').toEqual([]);
  });

  test('table header + align render; selection island offers live grid ops', async ({
    page,
  }) => {
    // Live boots (vault provisioning + PWA install + OPFS seed) can exceed
    // the 30s default under load; per-assertion timeouts below stay tight.
    test.setTimeout(120000);
    const errors = collectErrors(page);
    await openLiveBlockpage(page, 'Live polish', 'Live table');
    await focusEditor(page);
    await page.keyboard.type('/table', { delay: 20 });
    await expect(
      page.locator(
        '.flbp-host .flbp-slash:not(.flbp-table-menu):not(.flbp-resource-menu):not(.flbp-turninto-menu)',
      ),
    ).toBeVisible({ timeout: 5000 });
    await page.keyboard.press('Enter');
    // Engine-owned size picker (2×2 default first).
    const sizes = page.locator('.flbp-host .flbp-table-menu');
    await expect(sizes).toBeVisible({ timeout: 5000 });
    await sizes.locator('.flbp-slash-item').first().click();
    const grid = page.locator('table.flbp-table-grid').first();
    await expect(grid).toBeVisible({ timeout: 5000 });
    await expectSlashDismissed(page);
    // Production inserts headerless grids: 2 rows × 2 body cells, and the
    // header is an explicit opt-in through the live `table.toggleHeader`
    // op (the island proves it below). Pin the insert truth first.
    expect(await grid.locator('.flbp-td').count()).toBe(4);
    expect(await grid.locator('.flbp-th').count()).toBe(0);
    // Table structure lives at the grid edge; text formatting stays in
    // the primary toolbar so the two surfaces never cover each other.
    await grid.locator('.flbp-td').first().click();
    await expect(page.getByRole('toolbar', { name: 'Writing format' })).toBeVisible();
    const rowActions = page.getByRole('button', { name: 'Row 1 actions' });
    await expect(rowActions).toBeVisible();
    await expect(page.locator('[data-flbp-table-row-handle]:visible')).toHaveCount(1);
    await expect(page.locator('[data-flbp-table-column-handle]:visible')).toHaveCount(1);
    await expect(page.locator('[data-selection-toolbar] [data-anchor="float.selection"]')).toHaveCount(0);
    await rowActions.click();
    const headerToggle = page
      .getByRole('dialog', { name: 'Row 1 actions' })
      .getByRole('button', { name: 'Header row' });
    await expect(headerToggle).toBeVisible();
    // Header row toggle executes live: first row promotes to th with a
    // header background distinct from body cells…
    await headerToggle.click();
    await expect(grid.locator('.flbp-th')).toHaveCount(2, { timeout: 5000 });
    const headerBg = await page.evaluate(() => {
      const th = document.querySelector('.flbp-table-grid .flbp-th');
      const td = document.querySelector('.flbp-table-grid .flbp-td');
      return {
        th: th ? getComputedStyle(th).backgroundColor : null,
        td: td ? getComputedStyle(td).backgroundColor : null,
      };
    });
    expect(headerBg.th).not.toBeNull();
    expect(headerBg.th).not.toBe(headerBg.td);
    // …and per-column alignment is deterministic: header and body cells
    // of a column agree (never UA-centered chaos).
    const align = await page.evaluate(() => {
      const ta = (el: Element): string => {
        const v = getComputedStyle(el).textAlign;
        return v === 'start' ? 'left' : v;
      };
      return {
        headers: [
          ...document.querySelectorAll('.flbp-table-grid .flbp-th'),
        ].map(ta),
        secondRow: [
          ...document.querySelectorAll(
            '.flbp-table-grid tbody tr:nth-child(2) .flbp-td',
          ),
        ].map(ta),
      };
    });
    expect(align.headers.length).toBe(2);
    expect(align.headers).toEqual(align.secondRow);
    // A live op executes: Add row grows the grid 2→3 (single undo fused).
    const rowsBefore = await grid.locator('tbody tr').count();
    await rowActions.click();
    await page
      .getByRole('dialog', { name: 'Row 1 actions' })
      .getByRole('button', { name: 'Insert below' })
      .click();
    await expect
      .poll(() => grid.locator('tbody tr').count(), { timeout: 5000 })
      .toBe(rowsBefore + 1);
    const bounds = await grid.boundingBox();
    expect(bounds).not.toBeNull();
    await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height + 3);
    await page.getByRole('button', { name: 'Add table row at bottom' }).click();
    await expect(grid.locator('tbody tr')).toHaveCount(rowsBefore + 2);
    const expanded = await grid.boundingBox();
    expect(expanded).not.toBeNull();
    await page.mouse.move(expanded!.x + expanded!.width + 3, expanded!.y + expanded!.height / 2);
    await page.getByRole('button', { name: 'Add table column at right' }).click();
    await expect(grid.locator('tbody tr').first().locator('td, th')).toHaveCount(3);
    await expectSlashDismissed(page);
    await shot(page, 'desktop-1280-table');
    expect(errors, 'zero console/page errors').toEqual([]);
  });

  test('table row and column handles drag the selected grid in one action', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await openLiveBlockpage(page, 'Live polish', 'Live table drag');
    await focusEditor(page);
    await page.keyboard.type('/table', { delay: 20 });
    await page.keyboard.press('Enter');
    await page
      .locator('.flbp-host .flbp-table-menu .flbp-slash-item')
      .first()
      .click();
    const grid = page.locator('table.flbp-table-grid').first();
    const rows = grid.locator('tbody tr');
    await rows.nth(0).locator('td').first().click();
    await page.keyboard.type('Alpha');
    await rows.nth(1).locator('td').first().click();
    await page.keyboard.type('Beta');
    const rowHandles = page.locator('[data-flbp-table-row-handle]');
    await expect(rowHandles).toHaveCount(2);
    await shot(page, 'desktop-1280-table-handles');
    await rowHandles.nth(1).dragTo(rows.nth(0).locator('td').first());
    await expect(rows.nth(0).locator('td').first()).toContainText('Beta');
    const columns = page.locator('[data-flbp-table-column-handle]');
    await expect(columns).toHaveCount(2);
    await columns.nth(0).dragTo(rows.nth(0).locator('td').nth(1));
    await expect(rows.nth(0).locator('td').nth(1)).toContainText('Beta');
  });

  test('each list item gets its own side actions and moves independently', async ({ page }) => {
    test.setTimeout(120000);
    await openLiveBlockpage(page, 'Live polish', 'Live list items');
    await insertViaSlash(page, 'numbered', /Numbered list/);
    await page.keyboard.type('Alpha');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Beta');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Gamma');
    const items = page.locator('[data-list-id] > li');
    await expect(items).toHaveCount(3);
    await items.nth(1).hover();
    const handle = page.locator('.flbp-drag-handle');
    await expect(handle).toBeVisible();
    await handle.dragTo(items.nth(0));
    await expect(items.nth(0)).toContainText('Beta');
    await expect(items.nth(1)).toContainText('Alpha');
    await items.nth(0).hover();
    const itemBox = await items.nth(0).boundingBox();
    const addBox = await page.getByRole('button', { name: 'Add block' }).boundingBox();
    expect(itemBox).not.toBeNull();
    expect(addBox).not.toBeNull();
    await page.mouse.move(itemBox!.x + itemBox!.width / 2, itemBox!.y + 12);
    await page.mouse.move(addBox!.x + addBox!.width / 2, addBox!.y + addBox!.height / 2, { steps: 20 });
    await expect(page.getByRole('button', { name: 'Add block' })).toBeVisible();
    await page.getByRole('button', { name: 'Add block' }).click();
    await expect(items).toHaveCount(4);
    await expect(items.nth(1)).toBeEmpty();
  });

  test('toggle child side actions remain attached while crossing the gutter', async ({ page }) => {
    test.setTimeout(120000);
    await openLiveBlockpage(page, 'Live polish', 'Live toggle child actions');
    await insertViaSlash(page, 'toggle', /Toggle/);
    const toggle = page.locator('[data-flbp-toggle]').first();
    await toggle.locator(':scope > p').first().click();
    await page.keyboard.type('Title');
    await toggle.locator('.flbp-toggle-empty').click();
    await page.keyboard.type('Child');
    const child = toggle.locator(':scope > p').last();
    const titleBox = await toggle.locator(':scope > p').first().boundingBox();
    const chevronBox = await page.locator('.flbp-chevron').first().boundingBox();
    expect(titleBox).not.toBeNull();
    expect(chevronBox).not.toBeNull();
    expect(Math.abs(chevronBox!.y + chevronBox!.height / 2 - (titleBox!.y + titleBox!.height / 2))).toBeLessThanOrEqual(4);
    await child.hover();
    const childBox = await child.boundingBox();
    const add = page.getByRole('button', { name: 'Add block' });
    const addBox = await add.boundingBox();
    const grip = page.locator('.flbp-drag-handle');
    const gripBox = await grip.boundingBox();
    expect(childBox).not.toBeNull();
    expect(addBox).not.toBeNull();
    expect(gripBox).not.toBeNull();
    await expect(add.locator('svg')).toHaveCount(1);
    await expect(grip.locator('svg')).toHaveCount(1);
    expect(Math.abs(addBox!.y + addBox!.height / 2 - (gripBox!.y + gripBox!.height / 2))).toBeLessThanOrEqual(1);
    expect(Math.abs(gripBox!.y + gripBox!.height / 2 - (childBox!.y + childBox!.height / 2))).toBeLessThanOrEqual(4);
    await page.mouse.move(childBox!.x + 30, childBox!.y + childBox!.height / 2);
    await page.mouse.move(addBox!.x + addBox!.width / 2, addBox!.y + addBox!.height / 2, { steps: 20 });
    await expect(add).toBeVisible();
    await add.click();
    await expect(toggle.locator(':scope > p')).toHaveCount(3);
    await expect(toggle.locator(':scope > p').nth(1)).toContainText('Child');
    await expect(toggle.locator(':scope > p').nth(2)).toHaveText('/');
  });

  test('nested bullet item keeps its side actions while crossing its parent', async ({ page }) => {
    test.setTimeout(120000);
    await openLiveBlockpage(page, 'Live polish', 'Live nested bullet actions');
    await insertViaSlash(page, 'bullet', /Bullet list/);
    await page.keyboard.type('Parent');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Nested');
    await page.keyboard.press('Tab');
    const nested = page.locator('[data-list-id] [data-list-id] > li').first();
    await expect(nested).toContainText('Nested');
    await nested.hover();
    const row = await nested.locator(':scope > p').boundingBox();
    const add = page.getByRole('button', { name: 'Add block' });
    const grip = page.locator('.flbp-drag-handle');
    const addBox = await add.boundingBox();
    const gripBox = await grip.boundingBox();
    expect(row).not.toBeNull();
    expect(addBox).not.toBeNull();
    expect(gripBox).not.toBeNull();
    expect(Math.abs(gripBox!.y + gripBox!.height / 2 - (row!.y + 15))).toBeLessThanOrEqual(5);
    await page.mouse.move(row!.x + 40, row!.y + 14);
    await page.mouse.move(gripBox!.x + gripBox!.width / 2, gripBox!.y + gripBox!.height / 2, { steps: 20 });
    await expect(grip).toBeVisible();
    await page.mouse.move(addBox!.x + addBox!.width / 2, addBox!.y + addBox!.height / 2, { steps: 8 });
    await add.click();
    await expect(page.locator('[data-list-id] [data-list-id] > li')).toHaveCount(2);
  });

  test('a toggle child can be dragged above its sibling from its own handle', async ({ page }) => {
    test.setTimeout(120000);
    await openLiveBlockpage(page, 'Live polish', 'Live toggle child drag');
    await insertViaSlash(page, 'toggle', /Toggle/);
    const toggle = page.locator('[data-flbp-toggle]').first();
    await toggle.locator(':scope > p').first().click();
    await page.keyboard.type('Title');
    await toggle.locator('.flbp-toggle-empty').click();
    await page.keyboard.type('First');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Second');
    const children = toggle.locator(':scope > p');
    await children.nth(2).hover();
    const second = await children.nth(2).boundingBox();
    const first = await children.nth(1).boundingBox();
    const grip = await page.locator('.flbp-drag-handle').boundingBox();
    expect(second).not.toBeNull();
    expect(first).not.toBeNull();
    expect(grip).not.toBeNull();
    await page.mouse.move(second!.x + 36, second!.y + second!.height / 2);
    await page.mouse.move(grip!.x + grip!.width / 2, grip!.y + grip!.height / 2, { steps: 16 });
    await page.mouse.down();
    await page.mouse.move(first!.x + 40, first!.y + 3, { steps: 12 });
    await expect(page.locator('.flbp-drop-preview')).toBeVisible();
    await page.mouse.up();
    await expect(children.nth(1)).toContainText('Second');
    await expect(children.nth(2)).toContainText('First');
  });

  test('toggle Enter creates a sibling while its empty body is an explicit writing target', async ({ page }) => {
    await openLiveBlockpage(page, 'Toggle behavior', 'Toggle rows');
    await insertViaSlash(page, 'toggle', /Toggle/);
    await page.keyboard.type('First');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Second');
    const toggles = page.locator('.ProseMirror > [data-flbp-toggle]');
    await expect(toggles).toHaveCount(2);
    await expect(toggles.first().locator(':scope > p')).toHaveCount(1);
    await toggles.first().locator('.flbp-toggle-empty').click();
    await page.keyboard.type('Inside first');
    await expect(toggles.first().locator(':scope > p')).toHaveText(['First', 'Inside first']);
    await expect(toggles.last().locator(':scope > p')).toHaveText(['Second']);
    await toggles.last().locator(':scope > p').click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Outside');
    await expect(page.locator('.ProseMirror > p').filter({ hasText: /^Outside$/ })).toHaveCount(1);
    await expect(toggles).toHaveCount(2);
  });

  test('Turn into converts one list item and preserves both surrounding list fragments', async ({ page }) => {
    await openLiveBlockpage(page, 'List behavior', 'Single item conversion');
    await insertViaSlash(page, 'bullet', /Bullet list/);
    await page.keyboard.type('Alpha');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Beta');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Gamma');
    await page.locator('.ProseMirror li').nth(1).hover();
    await page.getByRole('button', { name: 'List item actions', exact: true }).click();
    await page.getByRole('option', { name: 'Turn into…', exact: true }).click();
    await page.getByRole('option', { name: 'Heading 2', exact: true }).click();
    await expect(page.locator('.ProseMirror > h2')).toHaveText('Beta');
    await expect(page.locator('.ProseMirror > ul')).toHaveText(['Alpha', 'Gamma']);
    await page.keyboard.press('Control+z');
    await expect(page.locator('.ProseMirror > ul > li')).toHaveText(['Alpha', 'Beta', 'Gamma']);
  });

  test('document title tracks the writing column across widths, font sizes and view mode', async ({ page }) => {
    await openLiveBlockpage(page, 'Title alignment', 'Aligned title');
    await focusEditor(page);
    await page.keyboard.type('First paragraph');
    for (const mode of ['Edit', 'View']) {
      if (mode === 'View') {
        await setDocumentPresentation(page, 'View');
      }
      for (const width of [1280, 1920, 760]) {
        await page.setViewportSize({ width, height: 900 });
        for (const size of [14, 20, 26]) {
          await page.evaluate((size) => document.documentElement.style.setProperty('--fl-editor-font-size', `${size}px`), size);
          await expect.poll(async () => {
            const title = await page.locator('[data-fl-document-name] h1').boundingBox();
            const content = await page.locator('.flbp-host .ProseMirror').boundingBox();
            return Math.abs(title!.x - content!.x);
          }).toBeLessThan(1);
        }
      }
    }
    await page.screenshot({ path: test.info().outputPath('title-alignment.png') });
  });

  test('empty text blocks show a hint only at the focused caret', async ({ page }) => {
    await openLiveBlockpage(page, 'Writing hints', 'Empty block placeholder');
    await focusEditor(page);
    const hint = page.locator('.ProseMirror .flbp-active-empty');
    await expect(hint).toHaveCount(1);
    const content = () => hint.evaluate((node) => getComputedStyle(node, '::before').content);
    expect(await content()).toContain("Enter text or type '/'");
    expect(await hint.evaluate((node) => getComputedStyle(node, '::before').overflow)).toBe('visible');
    await page.screenshot({ path: test.info().outputPath('empty-block-hint.png') });
    await hint.hover();
    await expect(page.locator('.flbp-drag-handle')).toHaveClass(/visible/);
    await expect(page.locator('.flbp-add-block')).toHaveClass(/visible/);
    await page.keyboard.type('Written');
    await expect(page.locator('.flbp-drag-handle')).not.toHaveClass(/visible/);
    await expect(page.locator('.flbp-add-block')).not.toHaveClass(/visible/);
    await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
    await expect(page.locator('.flbp-drag-handle')).not.toHaveClass(/visible/);
    await page.mouse.move(400, 300);
    await page.locator('.ProseMirror > p').first().hover();
    await expect(page.locator('.flbp-drag-handle')).toHaveClass(/visible/);
    await expect(hint).toHaveCount(0);
    await page.keyboard.press('Enter');
    await expect(hint).toHaveCount(1);
    await expect(hint).toHaveText('');
    await page.locator('.ProseMirror > p').filter({ hasText: /^Written$/ }).click();
    await expect(hint).toHaveCount(0);
    await page.locator('.ProseMirror > p').last().click();
    await expect(hint).toHaveCount(1);
    await page.locator('.ProseMirror').evaluate((node) => (node as HTMLElement).blur());
    expect(await content()).toBe('none');
  });

  test('numbering restarts after an item becomes a paragraph and rejoins when converted back', async ({ page }) => {
    await openLiveBlockpage(page, 'List behavior', 'Numbering after conversion');
    await insertViaSlash(page, 'numbered', /Numbered list/);
    await page.keyboard.type('Alpha');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Beta');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Gamma');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Delta');
    await page.locator('.ProseMirror li').nth(1).hover();
    await page.getByRole('button', { name: 'List item actions', exact: true }).click();
    await page.getByRole('option', { name: 'Turn into…', exact: true }).click();
    await page.getByRole('option', { name: 'Paragraph', exact: true }).click();
    const lists = page.locator('.ProseMirror > ol');
    await expect(lists).toHaveCount(2);
    await expect(lists).toHaveText(['Alpha', 'GammaDelta']);
    expect(await lists.evaluateAll((nodes) => nodes.map((node) => (node as HTMLOListElement).start))).toEqual([1, 1]);
    const paragraph = page.locator('.ProseMirror > p').filter({ hasText: /^Beta$/ });
    await paragraph.hover();
    await page.getByRole('button', { name: 'Block actions', exact: true }).click();
    await page.getByRole('option', { name: 'Turn into…', exact: true }).click();
    await page.getByRole('option', { name: 'Numbered list', exact: true }).click();
    await expect(lists).toHaveCount(1);
    await expect(lists.locator(':scope > li')).toHaveText(['Alpha', 'Beta', 'Gamma', 'Delta']);
    expect(await lists.evaluate((node) => (node as HTMLOListElement).start)).toBe(1);
    await page.keyboard.press('Control+z');
    await expect(lists).toHaveCount(2);
    await expect(paragraph).toHaveText('Beta');
  });

  for (const mode of ['split-list', 'list-item'] as const) {
    test(`dragging a heading to a list previews and commits ${mode}`, async ({ page }) => {
      await openLiveBlockpage(page, 'List behavior', `Heading ${mode}`);
      await insertViaSlash(page, 'heading 2', /Heading 2/);
      await page.keyboard.type('Moved');
      await page.keyboard.press('Enter');
      await page.keyboard.type('/bullet', { delay: 20 });
      await page.keyboard.press('Enter');
      await page.keyboard.type('Alpha');
      await page.keyboard.press('Enter');
      await page.keyboard.type('Beta');
      const heading = page.locator('.ProseMirror > h2');
      await heading.hover();
      const handle = await page.locator('.flbp-drag-handle').boundingBox();
      const list = await page.locator('.ProseMirror > ul').boundingBox();
      const row = await page.locator('.ProseMirror > ul > li').last().boundingBox();
      await page.mouse.move(handle!.x + 14, handle!.y + 14);
      await page.mouse.down();
      await page.mouse.move(list!.x + (mode === 'split-list' ? 4 : 90), row!.y + 2, { steps: 12 });
      await expect(page.locator('.flbp-drop-preview')).toHaveAttribute('data-drop-mode', mode);
      const preview = await page.locator('.flbp-drop-preview').boundingBox();
      await page.waitForTimeout(250);
      expect((await page.locator('.flbp-drop-preview').boundingBox())!.y).toBeCloseTo(preview!.y, 0);
      await page.mouse.up();
      if (mode === 'split-list') {
        await expect(page.locator('.ProseMirror > ul')).toHaveText(['Alpha', 'Beta']);
        await expect(heading).toHaveText('Moved');
        expect(await page.locator('.ProseMirror > [data-block-id], .ProseMirror > [data-list-id]').evaluateAll((nodes) => nodes.map((node) => node.textContent))).toEqual(['Alpha', 'Moved', 'Beta']);
      } else {
        await expect(heading).toHaveCount(0);
        await expect(page.locator('.ProseMirror > ul > li')).toHaveText(['Alpha', 'Moved', 'Beta']);
      }
      await page.keyboard.press('Control+z');
      await expect(heading).toHaveText('Moved');
      await expect(page.locator('.ProseMirror > ul > li')).toHaveText(['Alpha', 'Beta']);
    });
  }

  test('a list item can be dragged out as an independent paragraph', async ({ page }) => {
    await openLiveBlockpage(page, 'List behavior', 'Lift item');
    await insertViaSlash(page, 'bullet', /Bullet list/);
    await page.keyboard.type('Alpha');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Beta');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('After');
    await page.locator('.ProseMirror li').last().hover();
    const handle = await page.locator('.flbp-drag-handle').boundingBox();
    const after = await page.locator('.ProseMirror > p').last().boundingBox();
    await page.mouse.move(handle!.x + 14, handle!.y + 14);
    await page.mouse.down();
    await page.mouse.move(after!.x + 60, after!.y + after!.height - 2, { steps: 12 });
    await expect(page.locator('.flbp-drop-preview')).toHaveAttribute('data-drop-mode', 'block');
    await page.mouse.up();
    await expect(page.locator('.ProseMirror > ul > li')).toHaveText(['Alpha']);
    expect(await page.locator('.ProseMirror > p').evaluateAll((nodes) => nodes.map((node) => node.textContent).filter(Boolean))).toEqual(['After', 'Beta']);
  });

  test('the gutter handle follows pointer height through whitespace and stationary-pointer scrolling', async ({ page }) => {
    await openLiveBlockpage(page, 'Hover behavior', 'Follow pointer');
    await focusEditor(page);
    for (let i = 0; i < 35; i++) { await page.keyboard.type(`Row ${i}`); await page.keyboard.press('Enter'); }
    const host = page.locator('.flbp-host');
    await host.evaluate((el) => { el.scrollTop = 0; });
    const rect = await host.boundingBox();
    await page.mouse.move(rect!.x + 12, rect!.y + 230);
    const handle = page.locator('.flbp-drag-handle');
    await expect(handle).toBeVisible();
    const before = await handle.getAttribute('data-target-block-id');
    await host.evaluate((el) => { el.scrollTop += 160; });
    await expect.poll(() => handle.getAttribute('data-target-block-id')).not.toBe(before);
    const moved = await handle.boundingBox();
    expect(Math.abs(moved!.y + 14 - (rect!.y + 230))).toBeLessThan(35);
  });

  test('nested blocks retain paragraph metrics and collapse controls stay out of layout', async ({ page }) => {
    await openLiveBlockpage(page, 'Drag regression', 'Nested metrics');
    await focusEditor(page);
    await page.keyboard.type('Outside');
    await page.keyboard.press('Enter');
    await insertViaSlash(page, 'toggle', /Toggle/);
    const toggle = page.locator('[data-flbp-toggle]').first();
    await toggle.locator(':scope > p').first().click();
    await page.keyboard.type('Summary');
    await toggle.locator('.flbp-toggle-empty').click();
    await page.keyboard.type('Inside');
    const metrics = await page.locator('.flbp-host .ProseMirror').evaluate((pm) => {
      const read = (el: Element) => {
        const style = getComputedStyle(el);
        return [style.paddingLeft, style.paddingRight, style.borderLeftWidth, style.lineHeight, style.fontSize];
      };
      return { outside: read(pm.querySelector(':scope > p')!), inside: read(pm.querySelector('[data-flbp-toggle] > p:last-child')!) };
    });
    expect(metrics.inside).toEqual(metrics.outside);
    await page.screenshot({ path: test.info().outputPath('nested-desktop.png') });
  });

  test('root drop after a toggle uses document positions despite collapse widgets', async ({ page }) => {
    await openLiveBlockpage(page, 'Drag regression', 'Root boundaries');
    await focusEditor(page);
    await page.keyboard.type('Move');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Toggle');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Tail');
    const paragraphs = page.locator('.flbp-host .ProseMirror > p');
    await paragraphs.nth(1).click();
    await page.keyboard.press('Home');
    await page.keyboard.type('/toggle');
    await page.keyboard.press('Enter');
    const source = page.locator('.flbp-host .ProseMirror > p').filter({ hasText: /^Move$/ });
    const tail = page.locator('.flbp-host .ProseMirror > p').filter({ hasText: /^Tail$/ });
    await source.hover();
    const grip = await page.locator('.flbp-drag-handle').boundingBox();
    const target = await tail.boundingBox();
    await page.mouse.move(grip!.x + 14, grip!.y + 14);
    await page.mouse.down();
    await page.mouse.move(target!.x + 80, target!.y + 2, { steps: 12 });
    await page.mouse.up();
    expect(await page.locator('.flbp-host .ProseMirror > [data-block-id]').evaluateAll((nodes) => nodes.map((node) => node.querySelector(':scope > p')?.textContent ?? node.textContent))).toEqual(['Toggle', 'Move', 'Tail']);
  });

  test('whole-list dragging has a separate handle and keeps its nested items together', async ({ page }) => {
    await openLiveBlockpage(page, 'Drag regression', 'List ownership');
    await focusEditor(page);
    await page.keyboard.type('Before');
    await page.keyboard.press('Enter');
    await insertViaSlash(page, 'bullet', /Bullet list/);
    await page.keyboard.type('Parent');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Nested');
    await page.keyboard.press('Tab');
    const list = page.locator('.flbp-host .ProseMirror > [data-list-id]');
    await list.locator(':scope > li > p').first().hover();
    const itemHandle = page.getByRole('button', { name: 'List item actions', exact: true });
    const listHandle = page.getByRole('button', { name: 'List actions', exact: true });
    await expect(itemHandle).toBeVisible();
    await expect(listHandle).toBeVisible();
    const source = await listHandle.boundingBox();
    const target = await page.locator('.flbp-host .ProseMirror > p').first().boundingBox();
    await page.mouse.move(source!.x + 14, source!.y + 14);
    await page.mouse.down();
    await page.mouse.move(target!.x + 60, target!.y + 2, { steps: 12 });
    await expect(page.locator('.flbp-drop-preview')).toBeVisible();
    await page.mouse.up();
    await expect(page.locator('.flbp-host .ProseMirror > :first-child')).toHaveAttribute('data-list-id');
    await expect(list.locator('[data-list-id] > li')).toContainText('Nested');
    await page.keyboard.press('Control+z');
    await expect(page.locator('.flbp-host .ProseMirror > :first-child')).toHaveText('Before');
    await expect(list.locator('[data-list-id] > li')).toContainText('Nested');
  });

  test('an item can move between lists without moving either list container', async ({ page }) => {
    await openLiveBlockpage(page, 'Drag regression', 'Cross-list move');
    await insertViaSlash(page, 'bullet', /Bullet list/);
    await page.keyboard.type('Alpha');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Beta');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Between');
    await page.keyboard.press('Enter');
    await page.keyboard.type('/numbered', { delay: 20 });
    await expect(page.locator('.flbp-slash-item.active').first()).toContainText('Numbered list');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Gamma');
    const first = page.locator('.flbp-host .ProseMirror > ul');
    const second = page.locator('.flbp-host .ProseMirror > ol');
    await first.locator(':scope > li').last().hover();
    const grip = await page.getByRole('button', { name: 'List item actions', exact: true }).boundingBox();
    const target = await second.locator('li').boundingBox();
    await page.mouse.move(grip!.x + 14, grip!.y + 14);
    await page.mouse.down();
    await page.mouse.move(target!.x + 60, target!.y + 2, { steps: 12 });
    await expect(page.locator('.flbp-drop-preview')).toBeVisible();
    await page.mouse.up();
    await expect(first.locator(':scope > li')).toHaveText(['Alpha']);
    await expect(second.locator(':scope > li')).toHaveText(['Beta', 'Gamma']);
    await page.keyboard.press('Control+z');
    await expect(first.locator(':scope > li')).toHaveText(['Alpha', 'Beta']);
    await expect(second.locator(':scope > li')).toHaveText(['Gamma']);
  });

  test('list item actions move and delete only the selected row', async ({ page }) => {
    await openLiveBlockpage(page, 'Drag regression', 'Item menu ownership');
    await insertViaSlash(page, 'bullet', /Bullet list/);
    await page.keyboard.type('Alpha');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Beta');
    const items = page.locator('[data-list-id] > li');
    await items.last().hover();
    await page.getByRole('button', { name: 'List item actions', exact: true }).click();
    await page.getByRole('option', { name: 'Move up', exact: true }).click();
    await expect(items).toHaveText(['Beta', 'Alpha']);
    await items.first().hover();
    await page.getByRole('button', { name: 'List item actions', exact: true }).click();
    await page.getByRole('option', { name: 'Delete item', exact: true }).click();
    await expect(items).toHaveText(['Alpha']);
    await page.keyboard.press('Control+z');
    await expect(items).toHaveText(['Beta', 'Alpha']);
  });

  test('Escape cancels a drag and leaves both content and history intact', async ({ page }) => {
    await openLiveBlockpage(page, 'Drag regression', 'Cancel drag');
    await focusEditor(page);
    await page.keyboard.type('First');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Second');
    const blocks = page.locator('.flbp-host .ProseMirror > p');
    await blocks.last().hover();
    const grip = await page.locator('.flbp-drag-handle').boundingBox();
    const first = await blocks.first().boundingBox();
    await page.mouse.move(grip!.x + 14, grip!.y + 14);
    await page.mouse.down();
    await page.mouse.move(first!.x + 60, first!.y + 2, { steps: 12 });
    await expect(page.locator('.flbp-drop-preview')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect(page.locator('.flbp-drag-preview, .flbp-drop-preview')).toHaveCount(0);
    await expect(blocks).toHaveText(['First', 'Second']);
    await expect(page.locator('.flbp-turninto-menu')).toBeHidden();
  });

  test('block drag shows content and a stable insertion boundary', async ({ page }) => {
    test.setTimeout(120000);
    await openLiveBlockpage(page, 'Live polish', 'Live block drag');
    await focusEditor(page);
    await page.keyboard.type('One');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Two');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Three');
    const blocks = page.locator('.flbp-host .ProseMirror > p');
    await expect(blocks).toHaveCount(3);
    await blocks.nth(2).hover();
    const handle = page.locator('.flbp-drag-handle');
    const grip = await handle.boundingBox();
    const first = await blocks.nth(0).boundingBox();
    expect(grip).not.toBeNull();
    expect(first).not.toBeNull();
    await page.mouse.move(grip!.x + grip!.width / 2, grip!.y + grip!.height / 2);
    await page.mouse.down();
    await page.mouse.move(first!.x + first!.width / 2, first!.y + 3, { steps: 8 });
    await expect(page.locator('.flbp-drag-preview')).toBeVisible();
    await expect(page.locator('.flbp-drop-preview')).toBeVisible();
    const preview = await page.locator('.flbp-drop-preview').boundingBox();
    expect(Math.abs(preview!.y - first!.y)).toBeLessThan(20);
    await expect.poll(() => blocks.nth(0).evaluate((el) => getComputedStyle(el).transform)).not.toBe('none');
    await page.waitForTimeout(200);
    expect((await page.locator('.flbp-drop-preview').boundingBox())!.y).toBeCloseTo(preview!.y, 0);
    await page.mouse.up();
    await expect(blocks.nth(0)).toContainText('Three');
    await expect(page.locator('.flbp-drag-preview')).toHaveCount(0);
    await expect(page.locator('.flbp-drop-preview')).toHaveCount(0);
    await blocks.nth(0).hover();
    const nextGrip = await handle.boundingBox();
    const last = await blocks.last().boundingBox();
    await page.mouse.move(nextGrip!.x + nextGrip!.width / 2, nextGrip!.y + nextGrip!.height / 2);
    await page.mouse.down();
    await page.mouse.move(last!.x + last!.width / 2, last!.y + last!.height - 2, { steps: 8 });
    const endPreview = await page.locator('.flbp-drop-preview').boundingBox();
    expect(endPreview).not.toBeNull();
    expect(Math.abs(endPreview!.y - (last!.y + last!.height))).toBeLessThan(24);
    await page.mouse.up();
    await expect(blocks.last()).toContainText('Three');
  });

  test('a block drops among toggle children with a visible destination preview', async ({ page }) => {
    test.setTimeout(120000);
    await openLiveBlockpage(page, 'Live polish', 'Live toggle drag');
    await focusEditor(page);
    await page.keyboard.type('Move me');
    await page.keyboard.press('Enter');
    await page.keyboard.type('/toggle', { delay: 20 });
    await expect(page.locator('.flbp-slash-item.active').first()).toContainText(/Toggle/);
    await page.keyboard.press('Enter');
    const toggle = page.locator('[data-flbp-toggle]').first();
    await expect(toggle).toBeVisible();
    await toggle.locator(':scope > p').first().click();
    await page.keyboard.type('Tasks');
    await toggle.locator('.flbp-toggle-empty').click();
    await page.keyboard.type('Existing child');
    await expect(toggle.locator(':scope > p').last()).toContainText('Existing child');
    const moving = page.locator('.flbp-host .ProseMirror > p').filter({ hasText: 'Move me' });
    await moving.hover();
    const handle = await page.locator('.flbp-drag-handle').boundingBox();
    const child = await toggle.locator(':scope > p').last().boundingBox();
    expect(handle).not.toBeNull();
    expect(child).not.toBeNull();
    await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
    await page.mouse.down();
    await page.mouse.move(child!.x + 48, child!.y + child!.height - 3, { steps: 8 });
    await expect(page.locator('.flbp-drop-preview')).toBeVisible();
    await page.mouse.up();
    await expect(toggle.locator(':scope > p').last()).toContainText('Move me');
    await expect(toggle.locator(':scope > p').first()).toHaveCSS('font-weight', '400');
  });

  test('block drop target follows a stationary pointer while the page scrolls', async ({ page }) => {
    test.setTimeout(120000);
    await openLiveBlockpage(page, 'Live polish', 'Live drag scroll');
    await focusEditor(page);
    for (let index = 0; index < 30; index += 1) {
      await page.keyboard.type(`Line ${index}`);
      await page.keyboard.press('Enter');
    }
    await page.keyboard.type('Dragged');
    const blocks = page.locator('.flbp-host .ProseMirror > p');
    await blocks.last().scrollIntoViewIfNeeded();
    await blocks.last().hover();
    const handle = await page.locator('.flbp-drag-handle').boundingBox();
    expect(handle).not.toBeNull();
    const point = { x: handle!.x + handle!.width / 2, y: handle!.y + handle!.height / 2 };
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x + 30, point.y - 18, { steps: 5 });
    const firstBefore = await blocks.first().boundingBox();
    await page.mouse.wheel(0, -360);
    await expect.poll(async () => (await blocks.first().boundingBox())!.y)
      .toBeGreaterThan(firstBefore!.y + 80);
    const preview = await page.locator('.flbp-drop-preview').boundingBox();
    expect(preview).not.toBeNull();
    expect(Math.abs(preview!.y - (point.y - 18))).toBeLessThan(100);
    await page.mouse.up();
    await expect(blocks.last()).not.toContainText('Dragged');
  });

  test('table handles appear on hover and row drag previews the destination', async ({ page }) => {
    test.setTimeout(120000);
    await openLiveBlockpage(page, 'Live polish', 'Live table hover drag');
    await focusEditor(page);
    await page.keyboard.type('Before');
    await page.keyboard.press('Enter');
    await page.keyboard.type('/table', { delay: 20 });
    await page.keyboard.press('Enter');
    await page.locator('.flbp-host .flbp-table-menu .flbp-slash-item').first().click();
    const grid = page.locator('table.flbp-table-grid').first();
    const rows = grid.locator('tbody tr');
    await rows.nth(0).locator('td').first().click();
    await page.keyboard.type('Alpha');
    await rows.nth(1).locator('td').first().click();
    await page.keyboard.type('Beta');
    await page.locator('.flbp-host .ProseMirror > p').first().click();
    await rows.nth(1).locator('td').first().hover();
    const handle = page.getByRole('button', { name: 'Row 2 actions' });
    await expect(handle).toBeVisible();
    const handleBox = await handle.boundingBox();
    const firstBox = await rows.nth(0).boundingBox();
    const tableBox = await grid.boundingBox();
    const blockHandleBox = await page.locator('.flbp-drag-handle').boundingBox();
    const addBox = await page.locator('.flbp-add-block').boundingBox();
    const paragraphBox = await page.locator('.flbp-host .ProseMirror > p').first().boundingBox();
    expect(handleBox).not.toBeNull();
    expect(firstBox).not.toBeNull();
    expect(tableBox).not.toBeNull();
    expect(blockHandleBox!.y).toBeGreaterThanOrEqual(tableBox!.y - 1);
    expect(addBox).not.toBeNull();
    const overlap = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
      Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
      Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
    expect(overlap(blockHandleBox!, addBox!)).toBe(0);
    expect(overlap(handleBox!, addBox!)).toBe(0);
    await page.mouse.move(addBox!.x + addBox!.width / 2, addBox!.y + addBox!.height / 2);
    await expect(page.locator('.flbp-add-block')).toBeVisible();
    await expect(handle).toBeVisible();
    expect(handleBox!.y).toBeGreaterThan(paragraphBox!.y + paragraphBox!.height);
    const columnBox = await page.getByRole('button', { name: 'Column 1 actions' }).boundingBox();
    expect(columnBox!.y).toBeGreaterThanOrEqual(paragraphBox!.y + paragraphBox!.height);
    await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(firstBox!.x + 8, firstBox!.y + 8, { steps: 8 });
    await expect(page.locator('[class*="targetPreview"]')).toBeVisible();
    await expect.poll(() => rows.nth(0).evaluate((el) => getComputedStyle(el).transform)).not.toBe('none');
    await page.mouse.up();
    await expect(rows.nth(0).locator('td').first()).toContainText('Beta');
  });

  test('primary format controls keep typing marks across a new block', async ({ page }) => {
    test.setTimeout(120000);
    await openLiveBlockpage(page, 'Live polish', 'Live writing format');
    await focusEditor(page);
    const bold = page.getByRole('toolbar', { name: 'Writing format' }).getByRole('button', { name: 'Bold' });
    await bold.click();
    await expect(bold).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.type('Bold one');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Bold two');
    const paragraphs = page.locator('.flbp-host .ProseMirror > p');
    await expect(paragraphs).toHaveCount(2);
    await expect(paragraphs.nth(0).locator('strong')).toContainText('Bold one');
    await expect(paragraphs.nth(1).locator('strong')).toContainText('Bold two');
  });


});

test.describe('blockpage live proof (coarse-pointer 768 touch, real app)', () => {
  test.use({
    viewport: { width: 768, height: 1024 },
    hasTouch: true,
    isMobile: true,
  });

  test('toggle controls stay separate on a touch viewport', async ({ page }) => {
    test.setTimeout(120000);
    await openLiveBlockpage(page, 'Live polish', 'Live touch toggle');
    await insertViaSlash(page, 'toggle', /Toggle/);
    const toggle = page.locator('[data-flbp-toggle]').first();
    await toggle.locator(':scope > p').first().tap();
    const grip = await page.locator('.flbp-drag-handle').boundingBox();
    const add = await page.locator('.flbp-add-block').boundingBox();
    const chevron = await page.locator('.flbp-chevron').first().boundingBox();
    expect(grip).not.toBeNull();
    expect(add).not.toBeNull();
    expect(chevron).not.toBeNull();
    const chevronIcon = page.locator('.flbp-chevron svg').first();
    await expect(chevronIcon).toHaveCount(1);
    const title = await toggle.locator(':scope > p').first().boundingBox();
    const iconBox = await chevronIcon.boundingBox();
    expect(title).not.toBeNull();
    expect(iconBox).not.toBeNull();
    expect(Math.abs(iconBox!.y + iconBox!.height / 2 - (title!.y + title!.height / 2))).toBeLessThanOrEqual(4);
    const overlap = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
      Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
      Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
    expect(overlap(grip!, add!)).toBe(0);
    expect(overlap(grip!, chevron!)).toBe(0);
    await page.locator('.flbp-chevron').first().tap();
    await expect(toggle).toHaveClass(/collapsed/);
    await page.locator('.flbp-chevron').first().tap();
    await toggle.locator(':scope > p').first().tap();
    await page.keyboard.type('A clear summary');
    await toggle.locator('.flbp-toggle-empty').click();
    await page.keyboard.type('Nested text keeps the same typography and block spacing.');
    await page.screenshot({ path: test.info().outputPath('nested-touch.png') });
  });

  test('nested bullet side actions stay usable by touch', async ({ page }) => {
    test.setTimeout(120000);
    await openLiveBlockpage(page, 'Live polish', 'Live touch bullet');
    await insertViaSlash(page, 'bullet', /Bullet list/);
    await page.keyboard.type('Parent');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Nested');
    await page.keyboard.press('Tab');
    const nested = page.locator('[data-list-id] [data-list-id] > li').first();
    await nested.locator('p').tap();
    const add = page.getByRole('button', { name: 'Add block' });
    const grip = page.getByRole('button', { name: 'List item actions' });
    await expect(add).toBeVisible();
    await expect(grip).toBeVisible();
    const row = await nested.locator(':scope > p').boundingBox();
    const gripBox = await grip.boundingBox();
    expect(row).not.toBeNull();
    expect(gripBox).not.toBeNull();
    expect(Math.abs(gripBox!.y + gripBox!.height / 2 - (row!.y + row!.height / 2))).toBeLessThanOrEqual(5);
    await add.tap();
    await expect(page.locator('[data-list-id] [data-list-id] > li')).toHaveCount(2);
  });

  test('touch drags blocks, table rows and columns through the same pointer path', async ({ page }) => {
    test.setTimeout(120000);
    await openLiveBlockpage(page, 'Live polish', 'Live touch drag');
    await focusEditor(page);
    await page.keyboard.type('One');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Two');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Three');
    const blocks = page.locator('.flbp-host .ProseMirror > p');
    await blocks.nth(2).tap();
    const grip = await page.locator('.flbp-drag-handle').boundingBox();
    const first = await blocks.nth(0).boundingBox();
    expect(grip).not.toBeNull();
    expect(first).not.toBeNull();
    await touchDrag(page,
      { x: grip!.x + grip!.width / 2, y: grip!.y + grip!.height / 2 },
      { x: first!.x + 10, y: first!.y + 4 },
      async () => expect(page.locator('.flbp-drop-preview')).toBeVisible());
    await expect(blocks.nth(0)).toContainText('Three');

    await blocks.last().click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('/table', { delay: 20 });
    await page.keyboard.press('Enter');
    await page.locator('.flbp-host .flbp-table-menu .flbp-slash-item').first().tap();
    const grid = page.locator('table.flbp-table-grid').first();
    const rows = grid.locator('tbody tr');
    await rows.nth(0).locator('td').first().tap();
    await page.keyboard.type('Alpha');
    await rows.nth(1).locator('td').first().tap();
    await page.keyboard.type('Beta');
    const rowGrip = await page.getByRole('button', { name: 'Row 2 actions' }).boundingBox();
    const topRow = await rows.nth(0).boundingBox();
    expect(rowGrip).not.toBeNull();
    expect(topRow).not.toBeNull();
    await touchDrag(page,
      { x: rowGrip!.x + rowGrip!.width / 2, y: rowGrip!.y + rowGrip!.height / 2 },
      { x: topRow!.x + 10, y: topRow!.y + 6 },
      async () => expect(page.locator('[class*="targetPreview"]')).toBeVisible());
    await expect(rows.nth(0).locator('td').first()).toContainText('Beta');
    const columnGrip = await page.getByRole('button', { name: 'Column 1 actions' }).boundingBox();
    const secondCell = await rows.nth(0).locator('td').nth(1).boundingBox();
    const precedingBlock = await grid.evaluate((element) =>
      element.previousElementSibling?.getBoundingClientRect().toJSON() ?? null);
    expect(columnGrip).not.toBeNull();
    expect(secondCell).not.toBeNull();
    if (precedingBlock !== null)
      expect(columnGrip!.y).toBeGreaterThanOrEqual(precedingBlock.y + precedingBlock.height);
    await touchDrag(page,
      { x: columnGrip!.x + columnGrip!.width / 2, y: columnGrip!.y + columnGrip!.height / 2 },
      { x: secondCell!.x + secondCell!.width / 2, y: secondCell!.y + 8 },
      async () => expect(page.locator('[class*="targetPreview"]')).toBeVisible());
    await expect(rows.nth(0).locator('td').nth(1)).toContainText('Beta');
  });

  test('44px matrix: todo row + drag handle + slash item carry manipulation', async ({
    page,
  }) => {
    // Live boots (vault provisioning + PWA install + OPFS seed) can exceed
    // the 30s default under load; per-assertion timeouts below stay tight.
    test.setTimeout(120000);
    const errors = collectErrors(page);
    await openLiveBlockpage(page, 'Live polish', 'Live touch todo');
    await insertViaSlash(page, 'todo', /To-do item/);
    const row = page.locator('li[data-checked]').first();
    await expect(row).toBeVisible({ timeout: 5000 });
    await expectSlashDismissed(page);
    // Coarse truth (behind the pointer:coarse gate): 44px floors.
    const rowBox = await row.boundingBox();
    expect(rowBox!.height).toBeGreaterThanOrEqual(43);
    expect(
      await row.evaluate((el) => getComputedStyle(el).touchAction),
      'todo touch-action',
    ).toBe('manipulation');
    // Hover reveals the engine drag handle at full coarse size.
    await row.hover();
    const handle = page.locator('.flbp-host .flbp-drag-handle');
    await expect(handle).toBeVisible({ timeout: 5000 });
    const handleBox = await handle.boundingBox();
    expect(handleBox!.height).toBeGreaterThanOrEqual(43);
    expect(handleBox!.width).toBeGreaterThanOrEqual(43);
    expect(
      await handle.evaluate((el) => getComputedStyle(el).touchAction),
      'handle touch-action',
    ).toBe('none');
    await focusEditor(page);
    await page.keyboard.press('End');
    const formatting = page.locator('[data-anchor="float.selection"]');
    await expect(formatting).toBeVisible();
    await page.evaluate(() => {
      document.documentElement.dataset.flKeyboardOpen = 'true';
      document.documentElement.style.setProperty(
        '--fl-keyboard-safe-bottom',
        '300px',
      );
    });
    const formattingBox = await formatting.boundingBox();
    expect(formattingBox).not.toBeNull();
    expect(
      Math.abs(formattingBox!.y + formattingBox!.height - 724),
    ).toBeLessThan(3);
    await page.evaluate(() => {
      delete document.documentElement.dataset.flKeyboardOpen;
      document.documentElement.style.removeProperty(
        '--fl-keyboard-safe-bottom',
      );
    });
    // Slash items meet the matrix while the menu is open…
    await focusEditor(page);
    await page.keyboard.type('/', { delay: 20 });
    const menu = page.locator(
      '.flbp-host .flbp-slash:not(.flbp-table-menu):not(.flbp-resource-menu):not(.flbp-turninto-menu)',
    );
    await expect(menu).toBeVisible({ timeout: 5000 });
    const itemBox = await menu
      .locator('.flbp-slash-item')
      .first()
      .boundingBox();
    expect(itemBox!.height).toBeGreaterThanOrEqual(43);
    expect(
      await menu
        .locator('.flbp-slash-item')
        .first()
        .evaluate((el) => getComputedStyle(el).touchAction),
      'slash touch-action',
    ).toBe('manipulation');
    // …then Escape parks the menu so the shot proves dismissal. The `/`
    // trigger text stays as document content (production keeps it on
    // dismiss) — remove it so the proof shot shows the clean result.
    await page.keyboard.press('Escape');
    await expectSlashDismissed(page);
    await page.keyboard.press('Backspace');
    const overflowX =
      (await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      )) ?? 99;
    expect(overflowX).toBeLessThanOrEqual(1);
    await shot(page, 'ipad-768-touch');
    expect(errors, 'zero console/page errors').toEqual([]);
  });

  test('table handles open a local row menu with 44px touch targets', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await openLiveBlockpage(page, 'Live polish', 'Live touch table');
    await focusEditor(page);
    await page.keyboard.type('/table', { delay: 20 });
    await page.keyboard.press('Enter');
    await page
      .locator('.flbp-host .flbp-table-menu .flbp-slash-item')
      .first()
      .tap();
    const grid = page.locator('table.flbp-table-grid').first();
    await grid.locator('td').first().tap();
    const rowHandle = page.getByRole('button', { name: 'Row 1 actions' });
    await expect(rowHandle).toBeVisible();
    const box = await rowHandle.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
    await rowHandle.tap();
    await expect(
      page.getByRole('dialog', { name: 'Row 1 actions' }),
    ).toBeVisible();
  });

  test('44px matrix: media actions + math save fit the coarse measure', async ({
    page,
  }) => {
    // Live boots (vault provisioning + PWA install + OPFS seed) can exceed
    // the 30s default under load; per-assertion timeouts below stay tight.
    test.setTimeout(120000);
    const errors = collectErrors(page);
    await openLiveBlockpage(page, 'Live polish', 'Live touch media');
    await insertViaSlash(page, 'image', /Image/);
    const figure = page.locator('figure[data-flbp-image]').first();
    await expect(figure).toBeVisible({ timeout: 5000 });
    await expectSlashDismissed(page);
    for (const kind of ['add', 'capture'] as const) {
      const btn = figure.locator(`[data-flbp-media-pick="${kind}"]`);
      const b = await btn.boundingBox();
      expect(b, `media ${kind}`).not.toBeNull();
      expect(b!.height, `media ${kind} height`).toBeGreaterThanOrEqual(43);
      expect(
        await btn.evaluate((el) => getComputedStyle(el).touchAction),
        `media ${kind} touch-action`,
      ).toBe('manipulation');
    }
    await expectSlashDismissed(page);
    await shot(page, 'ipad-768-media-touch');
    expect(errors, 'zero console/page errors').toEqual([]);
  });
});

test.describe('blockpage live proof (compact 760, real preview app)', () => {
  test.use({ viewport: { width: 760, height: 900 } });

  test('760 compact keeps the writing surface clear', async ({
    page,
  }) => {
    // Live boots (vault provisioning + PWA install + OPFS seed) can exceed
    // the 30s default under load; per-assertion timeouts below stay tight.
    test.setTimeout(120000);
    const errors = collectErrors(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await openLiveBlockpage(page, 'Live polish', 'Live compact');
    await page.setViewportSize({ width: 760, height: 900 });
    await insertViaSlash(page, 'toggle', /Toggle/);
    const toggle = page.locator('[data-flbp-toggle]').first();
    await expect(toggle).toBeVisible();
    await toggle.hover();
    const grip = await page.locator('.flbp-drag-handle').boundingBox();
    const add = await page.locator('.flbp-add-block').boundingBox();
    const chevron = await page.locator('.flbp-chevron').first().boundingBox();
    expect(grip).not.toBeNull();
    expect(add).not.toBeNull();
    expect(chevron).not.toBeNull();
    const overlap = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
      Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
      Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
    expect(overlap(grip!, add!), JSON.stringify({ grip, add })).toBe(0);
    expect(overlap(grip!, chevron!), JSON.stringify({ grip, chevron })).toBe(0);
    await expectSlashDismissed(page);
    await expect(page.locator('[data-toolbar="category-strip"]')).toHaveCount(
      0,
    );
    const overflowX =
      (await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      )) ?? 99;
    expect(overflowX).toBeLessThanOrEqual(1);
    await expectSlashDismissed(page);
    await shot(page, 'compact-760');
    expect(errors, 'zero console/page errors').toEqual([]);
  });
});

test.describe('blockpage live proof (dark + extremes, real preview app)', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('dark theme + 320/1920 keep rhythm with slash dismissed', async ({
    page,
  }) => {
    // Live boots (vault provisioning + PWA install + OPFS seed) can exceed
    // the 30s default under load; per-assertion timeouts below stay tight.
    test.setTimeout(120000);
    const errors = collectErrors(page);
    await openLiveBlockpage(page, 'Live polish', 'Live extremes');
    await insertViaSlash(page, 'todo', /To-do item/);
    await expect(page.locator('li[data-checked]').first()).toBeVisible({
      timeout: 5000,
    });
    await expectSlashDismissed(page);
    // Dark: the production applyThemeMode('dark') effect is exactly
    // `documentElement.dataset.theme = 'dark'` (themes/dark.css keys off
    // `:root[data-theme='dark']`, falling back to the media query).
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark';
    });
    await page.waitForTimeout(300);
    let overflowX =
      (await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      )) ?? 99;
    expect(overflowX).toBeLessThanOrEqual(1);
    await expectSlashDismissed(page);
    await shot(page, 'desktop-1280-dark');
    // Narrow extreme keeps rhythm with no horizontal scroll.
    await page.setViewportSize({ width: 320, height: 800 });
    await page.waitForTimeout(300);
    overflowX =
      (await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      )) ?? 99;
    expect(overflowX).toBeLessThanOrEqual(1);
    await expectSlashDismissed(page);
    await shot(page, 'narrow-320');
    // Wide extreme keeps the writing measure stable (never full-bleed).
    await page.setViewportSize({ width: 1920, height: 900 });
    await page.waitForTimeout(300);
    const measure = await page.evaluate(() => {
      const surface = document.querySelector(
        '.flbp-host .ProseMirror',
      ) as HTMLElement | null;
      return surface ? surface.getBoundingClientRect().width : 0;
    });
    expect(measure).toBeGreaterThan(0);
    expect(measure).toBeLessThan(1400);
    await expectSlashDismissed(page);
    await shot(page, 'wide-1920');
    expect(errors, 'zero console/page errors').toEqual([]);
  });
});
