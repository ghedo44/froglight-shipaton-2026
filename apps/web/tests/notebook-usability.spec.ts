import { createFromSidebar } from './support/sidebar-create.js';
import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 820, height: 1180 }, hasTouch: true });

test('tablet inspector and phone Notebook page controls remain reachable and save', async ({
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
  await page.getByTestId('create-vault-name-input').fill('Notebook usability');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();
  await createFromSidebar(page, 'Notebook');
  await page.getByRole('textbox', { name: 'Note name' }).fill('Paper');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Create', exact: true })
    .tap();
  await expect(
    page.getByRole('tab', { name: 'Paper.notebook', exact: true }),
  ).toBeVisible();
  const toggle = page.getByRole('button', {
    name: 'Toggle document sidebar',
    exact: true,
  });
  const toggleBox = await toggle.boundingBox();
  const tabBox = await page
    .getByRole('tab', { name: 'Paper.notebook', exact: true })
    .boundingBox();
  expect(toggleBox).not.toBeNull();
  expect(tabBox).not.toBeNull();
  expect(
    Math.abs(
      toggleBox!.y + toggleBox!.height / 2 - tabBox!.y - tabBox!.height / 2,
    ),
  ).toBeLessThan(1);
  await page
    .getByRole('button', { name: 'Toggle document sidebar', exact: true })
    .tap();
  await page.getByRole('tab', { name: 'Pages', exact: true }).tap();
  await page.getByRole('button', { name: 'Page 1 actions' }).tap();
  await expect(
    page.getByRole('menu', { name: 'Page 1 actions' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: 'Document settings', exact: true }).tap();
  await expect(
    page.getByRole('button', { name: 'Export notebook as PDF…', exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath('inspector-tablet.png'),
    animations: 'disabled',
  });
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('complementary', { name: 'Document sidebar', exact: true }),
  ).toBeHidden();
  await expect(
    page.getByRole('button', { name: 'Toggle document sidebar', exact: true }),
  ).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  const navigation = page.locator('[data-anchor="float.bottom-left"]');
  const zoom = page.locator('[data-anchor="float.bottom-right"]');
  await expect(navigation).toBeVisible();
  for (const island of [navigation, zoom]) {
    expect(
      await island.evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
    ).toBe(true);
    const bounds = await island.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  }
  await page
    .getByRole('button', { name: 'Toggle document sidebar', exact: true })
    .tap();
  await page.getByRole('tab', { name: 'Document settings', exact: true }).tap();
  await page
    .getByRole('combobox', { name: 'Page paper', exact: true })
    .selectOption({ label: 'Grid' });
  await page
    .getByRole('spinbutton', { name: 'Rule spacing', exact: true })
    .fill('36');
  await page
    .getByRole('spinbutton', { name: 'Rule spacing', exact: true })
    .press('Tab');
  await page
    .getByRole('spinbutton', { name: 'Page width', exact: true })
    .fill('900');
  await page
    .getByRole('spinbutton', { name: 'Page width', exact: true })
    .press('Tab');
  await page.screenshot({
    path: test.info().outputPath('pages-phone.png'),
    animations: 'disabled',
  });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+s');
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const vault = await (
          await navigator.storage.getDirectory()
        ).getDirectoryHandle('Notebook usability');
        return (
          await (await vault.getFileHandle('Paper.notebook')).getFile()
        ).text();
      }),
    )
    .toContain('36');
  await page.reload();
  await page
    .getByRole('button', { name: /Notebook usability Browser/ })
    .click();
  await expect(
    page.getByRole('tab', { name: 'Paper.notebook', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Toggle document sidebar', exact: true })
    .tap();
  await page.getByRole('tab', { name: 'Document settings', exact: true }).tap();
  await expect(
    page
      .getByRole('combobox', { name: 'Page paper', exact: true })
      .locator('option:checked'),
  ).toHaveText('Grid');
  await expect(
    page.getByRole('spinbutton', { name: 'Rule spacing', exact: true }),
  ).toHaveValue('36');
  await expect(
    page.getByRole('spinbutton', { name: 'Page width', exact: true }),
  ).toHaveValue('900');
  await page.keyboard.press('Escape');
  for (const [width, height] of [
    [400, 844],
    [600, 900],
    [820, 1180],
    [1180, 820],
    [1024, 1366],
    [1366, 1024],
    [1440, 900],
    [1280, 800],
  ]) {
    await page.setViewportSize({ width, height });
    await expect
      .poll(() =>
        page
          .locator(
            '[data-anchor="float.bottom-left"], [data-anchor="float.bottom-right"]',
          )
          .evaluateAll((elements) =>
            elements.every((e) => {
              const box = e.getBoundingClientRect();
              return (
                box.left >= 0 &&
                box.right <= innerWidth &&
                e.scrollWidth <= e.clientWidth + 1
              );
            }),
          ),
      )
      .toBe(true);
    if (width === 600 || width === 1024 || width === 1180) {
      await page.screenshot({
        path: test.info().outputPath(`notebook-${width}x${height}.png`),
        animations: 'disabled',
      });
    }
  }
});

test('touch drag previews and reorders Notebook pages', async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: undefined,
      configurable: true,
    }),
  );
  await page.goto('/');
  await page.getByTestId('create-vault-button').click();
  await page.getByTestId('create-vault-name-input').fill('Touch pages');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();
  await createFromSidebar(page, 'Notebook');
  await page.getByRole('textbox', { name: 'Note name' }).fill('Paper');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Create', exact: true })
    .tap();
  await page
    .getByRole('button', { name: 'Toggle document sidebar', exact: true })
    .tap();
  await page.getByRole('tab', { name: 'Pages', exact: true }).tap();
  await page.getByRole('button', { name: 'Page 1 actions' }).tap();
  await page
    .getByRole('menu', { name: 'Page 1 actions' })
    .getByRole('menuitem', { name: 'Add after' })
    .tap();
  const thumbnails = page.getByLabel('Page thumbnails');
  await expect(thumbnails.locator('[data-page-id]')).toHaveCount(2);
  await expect(page.locator('.fl-nb-shell figcaption')).toHaveCount(0);
  const originalOrder = await thumbnails
    .locator('[data-page-id]')
    .evaluateAll((cards) =>
      cards.map((card) => (card as HTMLElement).dataset.pageId),
    );
  const handle = page.getByRole('button', { name: 'Move page 1' });
  await expect(handle).toBeVisible();
  const start = await handle.boundingBox();
  const destination = await thumbnails
    .locator('[data-page-id]')
    .last()
    .boundingBox();
  expect(start).not.toBeNull();
  expect(destination).not.toBeNull();
  const session = await page.context().newCDPSession(page);
  const startPoint = {
    x: start!.x + start!.width / 2,
    y: start!.y + start!.height / 2,
    id: 0,
  };
  const endPoint = {
    x: destination!.x + destination!.width - 12,
    y: destination!.y + destination!.height / 2,
    id: 0,
  };
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [startPoint],
  });
  for (let step = 1; step <= 8; step += 1) {
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        {
          x: startPoint.x + ((endPoint.x - startPoint.x) * step) / 8,
          y: startPoint.y + ((endPoint.y - startPoint.y) * step) / 8,
          id: 0,
        },
      ],
    });
  }
  await expect(page.locator('[data-page-drag-preview]')).toBeVisible();
  // The insertion marker moves; page geometry stays stable under the finger.
  await expect(thumbnails.locator('[data-drop-target]')).toHaveCount(1);
  expect(
    await thumbnails
      .locator('[data-page-id]')
      .evaluateAll((cards) =>
        cards.map((card) => (card as HTMLElement).dataset.pageId),
      ),
  ).toEqual(originalOrder);

  await session.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
  await expect(page.locator('[data-page-drag-preview]')).toHaveCount(0);
  await expect
    .poll(() =>
      thumbnails
        .locator('[data-page-id]')
        .evaluateAll((cards) =>
          cards.map((card) => (card as HTMLElement).dataset.pageId),
        ),
    )
    .toEqual([originalOrder[1], originalOrder[0]]);
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('complementary', { name: 'Document sidebar', exact: true }),
  ).toBeHidden();
  await page.locator('.fl-nb-scroll').evaluate((scroll) => {
    scroll.scrollTop = scroll.scrollHeight;
  });
  await page.screenshot({
    path: test.info().outputPath('notebook-page-bottom.png'),
    animations: 'disabled',
  });
});

test.describe('desktop control capacity', () => {
  test.use({ viewport: { width: 1440, height: 900 }, hasTouch: false });
  test('Page settings and previews remain available on desktop', async ({
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
    await page.getByTestId('create-vault-name-input').fill('Desktop controls');
    await page.getByTestId('choose-vault-location-button').click();
    await page.getByTestId('confirm-create-vault-button').click();
    await createFromSidebar(page, 'Notebook');
    await page.getByRole('textbox', { name: 'Note name' }).fill('Controls');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Create', exact: true })
      .click();
    await expect(
      page.getByRole('tab', { name: 'Controls.notebook', exact: true }),
    ).toBeVisible();
    const penShelf = page.locator('[data-tool-shelf="surface.write"]');
    if (!(await penShelf.isVisible()))
      await page
        .getByRole('toolbar', { name: 'Document tool categories' })
        .getByRole('button', { name: 'Pen', exact: true })
        .click();
    await penShelf
      .getByRole('button', { name: /^(Ball )?Pen$/ })
      .first()
      .click();
    await expect(
      page.getByRole('dialog', { name: 'Pen settings', exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath('pen-settings-desktop.png'),
      animations: 'disabled',
    });
    await page.keyboard.press('Escape');
    await page
      .getByRole('button', { name: 'Toggle document sidebar', exact: true })
      .click();
    await page
      .getByRole('tab', { name: 'Document settings', exact: true })
      .click();
    const settings = page.getByRole('tabpanel', { name: 'Document settings' });
    await expect(
      settings.getByRole('spinbutton', { name: 'Page width', exact: true }),
    ).toBeVisible();
    await page.getByRole('tab', { name: 'Pages', exact: true }).click();
    const pages = page.getByRole('tabpanel', { name: 'Pages' });
    await expect(pages.getByLabel('Page thumbnails')).toBeVisible();
    await expect(
      pages.getByRole('spinbutton', { name: 'Page width', exact: true }),
    ).toHaveCount(0);
    await page.screenshot({
      path: test.info().outputPath('pages-desktop.png'),
      animations: 'disabled',
    });
  });
});
