import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { installBlockpageFixture } from './support/blockpage-production-fixture.js';
import { createFromSidebar } from './support/sidebar-create.js';

const FILE_NAME = 'Production fixture.blockpage';

async function createFixtureVault(
  page: Page,
  vaultName: string,
): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: undefined,
      configurable: true,
    });
  });
  await page.goto('/', { waitUntil: 'load' });
  await page.getByTestId('create-vault-button').click();
  await page.getByTestId('create-vault-name-input').fill(vaultName);
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();
  await expect(
    page.getByRole('tab', { name: /welcome\.md/ }).first(),
  ).toBeVisible({
    timeout: 60_000,
  });
  await createFromSidebar(page, 'Block page');
  await page
    .getByRole('textbox', { name: 'Note name' })
    .fill('Production fixture');
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  await expect(page.locator('.flbp-host .ProseMirror')).toBeVisible({
    timeout: 30_000,
  });
  const fixtureTab = page.getByRole('tab', { name: FILE_NAME, exact: true });
  await fixtureTab.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Close tab' }).click();
  await expect(fixtureTab).toHaveCount(0);
  await installBlockpageFixture(page, vaultName, FILE_NAME);
  const fixtureFile = page.getByRole('button', {
    name: FILE_NAME,
    exact: true,
  });
  if (!(await fixtureFile.isVisible())) {
    await page.getByRole('button', { name: 'Toggle sidebar' }).click();
  }
  await expect(fixtureFile).toBeVisible({
    timeout: 30_000,
  });
  await fixtureFile.click();
  await expect(page.locator('.flbp-host .ProseMirror')).toBeVisible({
    timeout: 30_000,
  });
}

async function screenshot(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  await page.screenshot({
    path: testInfo.outputPath(`${name}.png`),
    animations: 'disabled',
  });
}

async function expectInsideHost(page: Page, selector: string): Promise<void> {
  await page.locator(selector).evaluate(async (target) => {
    await Promise.allSettled(
      target.getAnimations().map((animation) => animation.finished),
    );
  });
  const result = await page.evaluate((targetSelector) => {
    const host = document.querySelector('.flbp-host');
    const target = document.querySelector(targetSelector);
    if (!(host instanceof HTMLElement) || !(target instanceof HTMLElement))
      return null;
    const h = host.getBoundingClientRect();
    const t = target.getBoundingClientRect();
    return {
      left: t.left - h.left,
      right: h.right - t.right,
      top: t.top - h.top,
      bottom: h.bottom - t.bottom,
    };
  }, selector);
  expect(result).not.toBeNull();
  if (result === null)
    throw new Error(`${selector} was not mounted in the host`);
  for (const [edge, inset] of Object.entries(result)) {
    expect(
      inset,
      `${selector} escaped the host at ${edge}`,
    ).toBeGreaterThanOrEqual(-1);
  }
}

test.describe('Block Page production hardening fixture', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('renders every supported structure and stays pane-contained', async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('pageerror', (error) => errors.push(String(error)));
    await createFixtureVault(page, 'Blockpage production fixture');

    const host = page.locator('.flbp-host');
    const editor = host.locator('.ProseMirror');
    await expect(editor.locator('h1')).toContainText('Document hierarchy');
    await expect(editor.locator('h2')).toContainText('Writing and structure');
    await expect(editor.locator('h3').first()).toContainText(
      'Detailed section',
    );
    await expect(editor.locator('h5')).toContainText('Lower-level heading');
    await expect(editor.locator('li[data-checked]')).toHaveCount(4);
    const todoAlignment = await editor
      .locator('li[data-checked]')
      .last()
      .evaluate((row) => {
        const paragraph = row.querySelector('p');
        const rowRect = row.getBoundingClientRect();
        const paragraphRect = paragraph?.getBoundingClientRect();
        const pseudo = getComputedStyle(row, '::before');
        const boxCenter = rowRect.top + Number.parseFloat(pseudo.top) + 7;
        const firstLineCenter =
          (paragraphRect?.top ?? rowRect.top) +
          Number.parseFloat(getComputedStyle(paragraph ?? row).lineHeight) / 2;
        return Math.abs(boxCenter - firstLineCenter);
      });
    expect(todoAlignment).toBeLessThanOrEqual(2);
    await expect(editor.locator('[data-flbp-callout]')).toHaveCount(1);
    await expect(editor.locator('[data-flbp-toggle]')).toHaveCount(2);
    await expect(editor.locator('pre')).toHaveCount(1);
    await expect(editor.locator('hr')).toHaveCount(1);
    await expect(editor.locator('figure[data-flbp-image]')).toHaveCount(1);
    await expect(editor.locator('figure[data-flbp-video]')).toHaveCount(1);
    await expect(editor.locator('figure[data-flbp-audio]')).toHaveCount(1);
    await expect(editor.locator('figure[data-flbp-file]')).toHaveCount(1);
    await expect(editor.locator('[data-flbp-composition]')).toHaveCount(4);
    await expect(editor.locator('figure[data-flbp-math]')).toHaveCount(1);
    await expect(editor.locator('figure[data-flbp-diagram]')).toHaveCount(1);
    await expect(editor.locator('table.flbp-table-grid')).toHaveCount(2);
    await expect(editor.locator('[data-flbp-opaque]')).toHaveCount(1);

    const overflow = await page.evaluate(() => {
      const root = document.documentElement;
      const hostElement = document.querySelector('.flbp-host') as HTMLElement;
      return {
        page: root.scrollWidth - root.clientWidth,
        host: hostElement.scrollWidth - hostElement.clientWidth,
      };
    });
    expect(overflow.page).toBeLessThanOrEqual(1);
    expect(overflow.host).toBeLessThanOrEqual(1);
    const wideTable = editor.locator('table.flbp-table-grid').nth(1);
    const tableScroller = wideTable;
    expect(
      await tableScroller.evaluate(
        (element) => getComputedStyle(element).overflowX,
      ),
    ).toBe('auto');
    await screenshot(page, testInfo, 'desktop-light-top');

    const math = editor.locator('figure[data-flbp-math]');
    await math.scrollIntoViewIfNeeded();
    await math.click();
    await expect(host.locator('.flbp-md-overlay')).toBeVisible();
    await expectInsideHost(page, '.flbp-md-overlay');
    await screenshot(page, testInfo, 'desktop-light-source-overlay');
    await page.keyboard.press('Escape');

    const tail = editor.locator('[data-block-id="tail-17"]');
    await tail.scrollIntoViewIfNeeded();
    await tail.hover();
    const handle = host.locator('.flbp-drag-handle');
    await expect(handle).toBeVisible();
    await handle.scrollIntoViewIfNeeded();
    const scrollBeforeMenu = await host.evaluate(
      (element) => element.scrollTop,
    );
    await handle.click();
    const actions = host.locator('.flbp-turninto-menu');
    await expect(actions).toBeVisible();
    await expect(actions.locator('.flbp-menu-group-label')).toHaveText([
      'Block',
      'Move',
    ]);
    await expectInsideHost(page, '.flbp-turninto-menu');
    const scrollAfterMenu = await host.evaluate((element) => element.scrollTop);
    // Focusing the first menu action may reveal one line near the viewport edge.
    expect(Math.abs(scrollAfterMenu - scrollBeforeMenu)).toBeLessThanOrEqual(24);
    await screenshot(page, testInfo, 'desktop-light-scrolled-actions');
    await page.keyboard.press('Escape');

    await tail.click();
    await page.keyboard.press('End');
    await page.keyboard.type('/');
    const slash = host.getByRole('listbox', { name: 'Block commands' });
    await expect(slash).toBeVisible();
    await expectInsideHost(page, '.flbp-slash[aria-label="Block commands"]');
    await page.keyboard.press('ArrowDown');
    await expect(slash.locator('[aria-selected="true"]')).toBeInViewport();
    await screenshot(page, testInfo, 'desktop-light-scrolled-slash-menu');
    await page.keyboard.press('Escape');
    await expect(slash).toBeHidden();
    await page.keyboard.press('Backspace');

    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark';
    });
    await screenshot(page, testInfo, 'desktop-dark-scrolled');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(250);
    await wideTable.scrollIntoViewIfNeeded();
    expect(
      await tableScroller.evaluate(
        (element) => element.scrollWidth > element.clientWidth,
      ),
    ).toBe(true);
    await math.scrollIntoViewIfNeeded();
    await math.click();
    await expect(host.locator('.flbp-md-overlay')).toBeVisible();
    await expectInsideHost(page, '.flbp-md-overlay');
    const sourceSize = await host
      .locator('.flbp-md-editor')
      .evaluate((element) => ({
        width: element.getBoundingClientRect().width,
      }));
    expect(sourceSize.width).toBeLessThan(390);
    await screenshot(page, testInfo, 'phone-dark-source-overlay');
    expect(errors).toEqual([]);
  });
});

test.describe('Block Page production hardening coarse pointer', () => {
  test.use({
    viewport: { width: 768, height: 1024 },
    hasTouch: true,
    isMobile: true,
  });

  test('keeps primary editor chrome reachable and iOS-safe', async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    await createFixtureVault(page, 'Blockpage coarse fixture');
    const host = page.locator('.flbp-host');
    const math = host.locator('figure[data-flbp-math]');
    await math.scrollIntoViewIfNeeded();
    await math.tap();
    const source = host.locator('.flbp-md-editor');
    await expect(source).toBeVisible();
    await expectInsideHost(page, '.flbp-md-overlay');
    expect(
      Number.parseFloat(
        await source.evaluate((el) => getComputedStyle(el).fontSize),
      ),
    ).toBeGreaterThanOrEqual(16);
    const save = host.getByRole('button', { name: 'Save' });
    const saveBox = await save.boundingBox();
    expect(saveBox?.height).toBeGreaterThanOrEqual(43);
    await screenshot(page, testInfo, 'tablet-coarse-source-overlay');
  });
});
