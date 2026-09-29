import { expect, test, type CDPSession } from '@playwright/test';
import { createFromSidebar } from './support/sidebar-create.js';

test.use({
  hasTouch: true,
  contextOptions: { reducedMotion: 'reduce' },
  viewport: { width: 1440, height: 900 },
});

async function touch(
  cdp: CDPSession,
  type: 'touchStart' | 'touchMove' | 'touchEnd',
  x = 0,
  y = 0,
) {
  await cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }],
  });
}

test('a second tap opens the active tab menu without stealing long-press split', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: undefined,
      configurable: true,
    });
  });
  await page.goto('/');
  await page.getByTestId('create-vault-button').click();
  await page.getByTestId('create-vault-name-input').fill('Touch tab menu');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();
  await createFromSidebar(page, 'Markdown');
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('textbox', { name: 'Note name' })
    .fill('Second');
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('button', { name: 'Create', exact: true })
    .click();

  const tab = page.getByRole('tab', { name: 'Second.md', exact: true });
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await tab.tap();
  await expect(
    page.getByRole('menuitem', { name: 'Close tab', exact: true }),
  ).toHaveCount(0);
  await tab.tap();
  await expect(
    page.getByRole('menuitem', { name: 'Close tab', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('menuitem', { name: 'Close other tabs', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('menuitem', { name: 'Close all', exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');

  const cdp = await page.context().newCDPSession(page);
  const tabBox = await tab.boundingBox();
  if (tabBox === null) throw new Error('Expected active tab bounds');
  const x = tabBox.x + tabBox.width / 2;
  const y = tabBox.y + tabBox.height / 2;
  await touch(cdp, 'touchStart', x, y);
  await page.waitForTimeout(450);
  await expect(page.locator('[data-zone="right"]')).toBeVisible();
  await expect(
    page.getByRole('menuitem', { name: 'Close tab', exact: true }),
  ).toHaveCount(0);

  const zoneBox = await page.locator('[data-zone="right"]').boundingBox();
  if (zoneBox === null) throw new Error('Expected right split target bounds');
  await touch(
    cdp,
    'touchMove',
    zoneBox.x + zoneBox.width / 2,
    zoneBox.y + zoneBox.height / 2,
  );
  await touch(cdp, 'touchEnd');
  await expect(page.locator('[data-pane]')).toHaveCount(2);
});

test('touch tabs scroll horizontally, then long-press reorder and split', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: undefined,
      configurable: true,
    });
  });
  await page.goto('/');
  await page.getByTestId('create-vault-button').click();
  await page.getByTestId('create-vault-name-input').fill('Touch tabs');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();
  for (let i = 0; i < 8; i++) {
    await createFromSidebar(page);
    await page.getByRole('textbox', { name: 'Note name' }).fill(`Touch ${i}`);
    await page
      .getByRole('dialog', { name: 'Create a new note' })
      .getByRole('button', { name: 'Create', exact: true })
      .click();
    await expect(
      page.getByRole('tab', { name: `Touch ${i}.md`, exact: true }),
    ).toHaveAttribute('aria-selected', 'true');
  }
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.waitForTimeout(400);
  const sidebar = page.getByRole('complementary', {
    name: 'Sidebar',
    exact: true,
  });
  if (await sidebar.isVisible())
    await page
      .getByRole('button', { name: 'Toggle sidebar', exact: true })
      .click();
  const strip = page.locator(
    '[data-pane-strip="main"] [class*="tabstrip-tabs"]',
  );
  await strip.evaluate((el) => {
    el.scrollLeft = 0;
  });
  const bounds = (await strip.boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  const x = bounds.x + 260,
    y = bounds.y + bounds.height / 2;
  await touch(cdp, 'touchStart', x, y);
  for (let n = 1; n <= 6; n++) await touch(cdp, 'touchMove', x - n * 30, y);
  await touch(cdp, 'touchEnd');
  await expect
    .poll(() => strip.evaluate((el) => el.scrollLeft))
    .toBeGreaterThan(50);
  expect(await strip.evaluate((el) => el.scrollTop)).toBe(0);
  await expect(page.locator('[data-zone]')).toHaveCount(0);
  await page.waitForTimeout(400);
  await strip.evaluate((el) => {
    el.scrollLeft = 0;
  });
  const first = page.getByRole('tab', { name: 'welcome.md', exact: true });
  const firstBox = (await first.boundingBox())!;
  const fx = firstBox.x + 25,
    fy = firstBox.y + firstBox.height / 2;
  // Vertical swipes cannot displace the strip or turn into delayed drags.
  await touch(cdp, 'touchStart', fx, fy);
  await touch(cdp, 'touchMove', fx, fy - 25);
  await page.waitForTimeout(450);
  await expect(page.locator('[data-zone]')).toHaveCount(0);
  await touch(cdp, 'touchEnd');
  expect(await strip.evaluate((el) => el.scrollTop)).toBe(0);
  await touch(cdp, 'touchStart', fx, fy);
  await page.waitForTimeout(450);
  await expect(page.locator('[data-zone="right"]')).toBeVisible();
  const secondBox = (await page
    .getByRole('tab', { name: 'Touch 1.md', exact: true })
    .boundingBox())!;
  await touch(cdp, 'touchMove', secondBox.x + secondBox.width - 5, fy);
  await touch(cdp, 'touchEnd');
  expect(await strip.evaluate((el) => el.scrollLeft)).toBe(0);
  await expect
    .poll(() =>
      page.locator('[data-pane-strip="main"] [role="tab"]').allTextContents(),
    )
    .toEqual([
      'Touch 0.md',
      'Touch 1.md',
      'welcome.md',
      'Touch 2.md',
      'Touch 3.md',
      'Touch 4.md',
      'Touch 5.md',
      'Touch 6.md',
      'Touch 7.md',
    ]);
  // Cancellation releases the long press and leaves the tab order intact.
  const cancelBox = (await first.boundingBox())!;
  await touch(cdp, 'touchStart', cancelBox.x + 25, fy);
  await page.waitForTimeout(450);
  await expect(page.locator('[data-zone="right"]')).toBeVisible();
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchCancel',
    touchPoints: [],
  });
  await expect(page.locator('[data-zone]')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Touch 0.md', exact: true }).tap();
  await expect(
    page.getByRole('tab', { name: 'Touch 0.md', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  const movedBox = (await first.boundingBox())!;
  await touch(cdp, 'touchStart', movedBox.x + 25, fy);
  await page.waitForTimeout(450);
  const zone = page.locator('[data-zone="right"]');
  await expect(zone).toBeVisible();
  const zb = (await zone.boundingBox())!;
  await touch(cdp, 'touchMove', zb.x + zb.width / 2, zb.y + zb.height / 2);
  await touch(cdp, 'touchEnd');
  await expect(page.locator('[data-pane]')).toHaveCount(2);
  await expect(
    page
      .locator('[data-pane-strip]')
      .nth(1)
      .getByRole('tab', { name: 'welcome.md' }),
  ).toBeVisible();
  await expect(
    page.locator('[data-pane]').nth(1).locator('.cm-content'),
  ).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('touch-split.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 768, height: 1024 });
  await expect(
    page.getByRole('tab', { name: 'welcome.md', exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath('touch-portrait-dark.png'),
  });
});

test('empty tab-strip space opens pane actions with mouse and touch', async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: undefined,
      configurable: true,
    }),
  );
  await page.goto('/');
  await page.getByTestId('create-vault-button').click();
  await page.getByTestId('create-vault-name-input').fill('Pane actions');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();
  const blank = () =>
    page
      .locator('[data-pane-strip]')
      .last()
      .locator('[class*="tabstrip-tabs"]');
  await expect(blank()).toBeVisible();
  await expect(page.locator('.cm-content')).toHaveCSS('user-select', 'text');
  await expect(page.locator('.cm-line').first()).toHaveCSS('user-select', 'text');
  const point = async () => {
    const box = await blank().boundingBox();
    if (box === null) throw new Error('Missing tab strip');
    return { x: box.x + box.width - 20, y: box.y + box.height / 2 };
  };
  for (const direction of ['left', 'up', 'right', 'down']) {
    const before = await page.locator('[data-pane]').count();
    const p = await point();
    await page.mouse.click(p.x, p.y, { button: 'right' });
    for (const label of [
      'Split left',
      'Split right',
      'Split up',
      'Split down',
      'Close pane',
    ]) {
      await expect(
        page.getByRole('menuitem', { name: label, exact: true }),
      ).toBeVisible();
    }
    await page
      .getByRole('menuitem', { name: `Split ${direction}`, exact: true })
      .click();
    await expect(page.locator('[data-pane]')).toHaveCount(before + 1);
  }
  const cdp = await page.context().newCDPSession(page);
  const p = await point();
  await touch(cdp, 'touchStart', p.x, p.y);
  await touch(cdp, 'touchMove', p.x - 25, p.y);
  await page.waitForTimeout(450);
  await expect(
    page.getByRole('menuitem', { name: 'Close pane', exact: true }),
  ).toHaveCount(0);
  await touch(cdp, 'touchEnd');
  await touch(cdp, 'touchStart', p.x, p.y);
  await page.waitForTimeout(450);
  await expect(
    page.getByRole('menuitem', { name: 'Close pane', exact: true }),
  ).toBeVisible();
  await touch(cdp, 'touchEnd');
  await page.screenshot({ path: test.info().outputPath('pane-actions.png') });
  await page.getByRole('menuitem', { name: 'Close pane', exact: true }).tap();
  await expect(page.locator('[data-pane]')).toHaveCount(4);
  await expect(
    page.getByRole('tab', { name: 'welcome.md', exact: true }),
  ).toBeVisible();
  await cdp.detach();
});
