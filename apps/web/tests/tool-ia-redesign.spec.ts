import { expect, test } from '@playwright/test';
import { createFromSidebar } from './support/sidebar-create.js';

async function createVault(
  page: import('@playwright/test').Page,
): Promise<void> {
  await page.addInitScript(() =>
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: undefined,
      configurable: true,
    }),
  );
  await page.goto('/');
  await page.getByTestId('create-vault-button').click();
  await page.getByTestId('create-vault-name-input').fill('Tool IA check');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();
}

test('Notebook page management lives in the right sidebar', async ({
  page,
}) => {
  await createVault(page);
  await createFromSidebar(page, 'Notebook');
  await page.getByRole('textbox', { name: 'Note name' }).fill('Paper');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  await expect(
    page.getByRole('tab', { name: 'Paper.notebook', exact: true }),
  ).toBeVisible();
  await expect(page.locator('[data-tool-shelf="surface.write"]')).toBeVisible();
  await page
    .locator('[data-toolbar="category-strip"]')
    .getByRole('button', { name: 'Pen', exact: true })
    .click();
  await expect(
    page.locator('[data-tool-shelf="surface.write"]').locator('..'),
  ).toHaveAttribute('data-open', 'false');
  await expect(page.getByRole('dialog', { name: /Pen settings/ })).toHaveCount(
    0,
  );
  await page
    .locator('[data-toolbar="category-strip"]')
    .getByRole('button', { name: 'Pen', exact: true })
    .click();
  await expect(
    page.locator('[data-tool-shelf="surface.write"]').locator('..'),
  ).toHaveAttribute('data-open', 'true');
  const grip = page.getByRole('button', { name: /Move active tool menu/ });
  const gripBox = await grip.boundingBox();
  const paneBox = await page.locator('[data-floating-layer]').boundingBox();
  expect(gripBox).not.toBeNull();
  expect(paneBox).not.toBeNull();
  await page.mouse.move(
    gripBox!.x + gripBox!.width / 2,
    gripBox!.y + gripBox!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    paneBox!.x + paneBox!.width / 2,
    paneBox!.y + paneBox!.height / 2,
    { steps: 8 },
  );
  const dragPreview = page.locator('[data-drag-preview]');
  await expect(dragPreview).toBeVisible();
  const movingPreview = await dragPreview.boundingBox();
  expect(movingPreview).not.toBeNull();
  expect(
    Math.abs(
      movingPreview!.y +
        movingPreview!.height / 2 -
        (paneBox!.y + paneBox!.height / 2),
    ),
  ).toBeLessThan(35);
  await page.mouse.move(
    paneBox!.x + paneBox!.width - 12,
    paneBox!.y + paneBox!.height / 2,
    { steps: 8 },
  );
  await expect(dragPreview).toHaveAttribute('data-dock', 'right');
  const rightPreview = await dragPreview.boundingBox();
  expect(rightPreview).not.toBeNull();
  expect(rightPreview!.height).toBeGreaterThan(rightPreview!.width);
  expect(rightPreview!.x).toBeGreaterThan(gripBox!.x);
  await page.screenshot({
    path: test.info().outputPath('drag-preview-right.png'),
    animations: 'disabled',
  });
  await page.mouse.up();
  await expect(dragPreview).toHaveCount(0);
  await expect(
    page.locator('[data-dock="right"] [data-tool-shelf="surface.write"]'),
  ).toBeVisible();
  const rightShelf = await page
    .locator('[data-dock="right"] [data-tool-shelf="surface.write"]')
    .boundingBox();
  expect(rightShelf).not.toBeNull();
  expect(rightShelf!.height).toBeGreaterThan(rightShelf!.width);
  const sideSurface = await page
    .locator('[data-dock="right"]')
    .evaluate((menu) => {
      const style = getComputedStyle(menu);
      return { shadow: style.boxShadow, border: style.borderWidth };
    });
  expect(sideSurface.shadow).not.toBe('none');
  expect(sideSurface.border).not.toBe('0px');
  await page.screenshot({
    path: test.info().outputPath('right-dock.png'),
    animations: 'disabled',
  });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({
    path: test.info().outputPath('right-dock-dark.png'),
    animations: 'disabled',
  });
  await page.emulateMedia({ colorScheme: 'light' });
  const sideGrip = await page
    .getByRole('button', { name: /Move active tool menu/ })
    .boundingBox();
  expect(sideGrip).not.toBeNull();
  await page.mouse.move(
    sideGrip!.x + sideGrip!.width / 2,
    sideGrip!.y + sideGrip!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    paneBox!.x + paneBox!.width - 32,
    paneBox!.y + paneBox!.height / 2,
    { steps: 4 },
  );
  await expect(dragPreview).toHaveAttribute('data-dock', 'right');
  await page.mouse.move(
    paneBox!.x + paneBox!.width / 2,
    paneBox!.y + paneBox!.height - 12,
    { steps: 8 },
  );
  await expect(dragPreview).toHaveAttribute('data-dock', 'bottom');
  const bottomPreview = await dragPreview.boundingBox();
  expect(bottomPreview).not.toBeNull();
  expect(bottomPreview!.width).toBeGreaterThan(bottomPreview!.height);
  await page.mouse.up();
  await expect(dragPreview).toHaveCount(0);
  const bottomShelf = page.locator(
    '[data-dock="bottom"] [data-tool-shelf="surface.write"]',
  );
  await expect(bottomShelf).toBeVisible();
  const pageNav = page.locator('[data-anchor="float.bottom-left"]');
  await expect(
    pageNav.getByRole('button', { name: 'Previous page' }),
  ).toBeVisible();
  const [bottomBox, navBox] = await Promise.all([
    bottomShelf.boundingBox(),
    pageNav.boundingBox(),
  ]);
  expect(bottomBox).not.toBeNull();
  expect(navBox).not.toBeNull();
  expect(
    Math.abs(bottomBox!.y + bottomBox!.height - navBox!.y - navBox!.height),
  ).toBeLessThan(4);
  expect(navBox!.x).toBeLessThan(bottomBox!.x);
  await page.screenshot({
    path: test.info().outputPath('bottom-dock.png'),
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 640, height: 900 });
  await expect(
    page.getByRole('button', { name: 'Move active tool menu, docked top' }),
  ).toBeVisible();
  const narrowGrip = await page
    .getByRole('button', { name: /Move active tool menu/ })
    .boundingBox();
  const narrowPane = await page.locator('[data-floating-layer]').boundingBox();
  expect(narrowGrip).not.toBeNull();
  expect(narrowPane).not.toBeNull();
  await page.mouse.move(
    narrowGrip!.x + narrowGrip!.width / 2,
    narrowGrip!.y + narrowGrip!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    narrowPane!.x + narrowPane!.width / 2,
    narrowPane!.y + narrowPane!.height - 12,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect(bottomShelf).toBeVisible();
  const [narrowNav, narrowShelf, narrowZoom] = await Promise.all([
    pageNav.boundingBox(),
    bottomShelf.boundingBox(),
    page.locator('[data-anchor="float.bottom-right"]').boundingBox(),
  ]);
  expect(narrowNav).not.toBeNull();
  expect(narrowShelf).not.toBeNull();
  expect(narrowZoom).not.toBeNull();
  expect(narrowNav!.x + narrowNav!.width).toBeLessThanOrEqual(
    narrowShelf!.x + 1,
  );
  expect(narrowShelf!.x + narrowShelf!.width).toBeLessThanOrEqual(
    narrowZoom!.x + 1,
  );
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(
    page.getByRole('button', { name: 'Move active tool menu, docked top' }),
  ).toBeVisible();
  const leftGrip = await page
    .getByRole('button', { name: /Move active tool menu/ })
    .boundingBox();
  const leftPane = await page.locator('[data-floating-layer]').boundingBox();
  expect(leftGrip).not.toBeNull();
  expect(leftPane).not.toBeNull();
  await page.mouse.move(
    leftGrip!.x + leftGrip!.width / 2,
    leftGrip!.y + leftGrip!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(leftPane!.x + 12, leftPane!.y + leftPane!.height / 2, {
    steps: 8,
  });
  await page.mouse.up();
  const leftShelf = await page
    .locator('[data-dock="left"] [data-tool-shelf="surface.write"]')
    .boundingBox();
  expect(leftShelf).not.toBeNull();
  expect(leftShelf!.height).toBeGreaterThan(leftShelf!.width);
  await page
    .locator('[data-toolbar="category-strip"]')
    .getByRole('button', { name: 'Selection', exact: true })
    .click();
  await page
    .locator('[data-toolbar="category-strip"]')
    .getByRole('button', { name: 'Selection', exact: true })
    .click();
  await expect(
    page.locator('[data-tool-shelf="surface.select"]').locator('..'),
  ).toHaveAttribute('data-open', 'false');
  await page
    .locator('[data-toolbar="category-strip"]')
    .getByRole('button', { name: 'Selection', exact: true })
    .click();
  await page
    .locator('[data-tool-shelf="surface.select"]')
    .getByRole('button', { name: 'Select', exact: true })
    .click();
  await expect(
    page.getByRole('dialog', { name: /Select settings/ }),
  ).toHaveCount(0);
  await expect(
    page
      .locator('[data-tool-shelf="surface.select"]')
      .getByRole('group', { name: 'Lasso mode' }),
  ).toHaveCount(0);
  const lasso = page
    .locator('[data-tool-shelf="surface.select"]')
    .getByRole('button', { name: 'Lasso', exact: true });
  await lasso.click();
  await expect(
    page
      .locator('[data-tool-shelf="surface.select"]')
      .getByRole('group', { name: 'Lasso mode' }),
  ).toBeVisible();
  await lasso.click();
  await expect(
    page
      .getByRole('dialog', { name: /Lasso settings/ })
      .getByRole('group', { name: 'Lasso mode' }),
  ).toBeVisible();
  await expect(
    page.getByRole('combobox', { name: 'Select content' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(
    page.locator(
      '[data-toolbar="category-strip"] [data-category="notebook.pages"]',
    ),
  ).toHaveCount(0);
  await expect(page.locator('.fl-nb-thumbs:visible')).toHaveCount(0);
  await page.getByRole('button', { name: 'Toggle document sidebar' }).click();
  const tabs = page.getByRole('tablist', { name: 'Document panels' });
  await expect(tabs.getByRole('tab', { name: 'Connections' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'More document panels' }),
  ).toHaveCount(0);
  const tabsContainer = tabs.locator('..');
  await tabsContainer.evaluate((element) => {
    element.style.flex = '0 0 125px';
    window.dispatchEvent(new Event('resize'));
  });
  await expect(
    page.getByRole('button', { name: 'More document panels' }),
  ).toBeVisible();
  await tabsContainer.evaluate((element) => {
    element.style.flex = '';
    window.dispatchEvent(new Event('resize'));
  });
  await expect(
    page.getByRole('button', { name: 'More document panels' }),
  ).toHaveCount(0);
  await page.getByRole('tab', { name: 'Pages', exact: true }).click();
  const panel = page.getByRole('tabpanel', { name: 'Pages' });
  await expect(panel.getByLabel('Page thumbnails')).toBeVisible();
  await expect(panel.getByRole('combobox', { name: 'Page paper' })).toHaveCount(
    0,
  );
  await panel.getByRole('button', { name: 'Page 1 actions' }).click();
  await page
    .getByRole('menu', { name: 'Page 1 actions' })
    .getByRole('menuitem', { name: 'Add after' })
    .click();
  await expect(panel.locator('[data-page-id]')).toHaveCount(2);
  await panel.getByRole('button', { name: 'Page 2 actions' }).click();
  await page
    .getByRole('menu', { name: 'Page 2 actions' })
    .getByRole('menuitem', { name: 'Add after' })
    .click();
  await expect(panel.locator('[data-page-id]')).toHaveCount(3);
  const originalOrder = await panel
    .locator('[data-page-id]')
    .evaluateAll((cards) =>
      cards.map((card) => (card as HTMLElement).dataset.pageId),
    );
  const sourceCard = panel.locator(`[data-page-id="${originalOrder[0]}"]`);
  const targetCard = panel.locator(`[data-page-id="${originalOrder[2]}"]`);
  const sourceBox = await sourceCard.boundingBox();
  const targetBox = await targetCard.boundingBox();
  expect(sourceBox).not.toBeNull();
  expect(targetBox).not.toBeNull();
  await page.mouse.move(
    sourceBox!.x + sourceBox!.width / 2,
    sourceBox!.y + sourceBox!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    targetBox!.x + targetBox!.width - 12,
    targetBox!.y + targetBox!.height / 2,
    { steps: 12 },
  );
  await expect(page.locator('[data-page-drag-preview]')).toBeVisible();
  await expect(sourceCard).toHaveAttribute('data-dragging', 'true');
  await expect
    .poll(() =>
      panel
        .locator('[data-page-id]')
        .evaluateAll((cards) =>
          cards.map((card) => (card as HTMLElement).dataset.pageId),
        ),
    )
    .toEqual([originalOrder[1], originalOrder[2], originalOrder[0]]);
  await expect(targetCard.locator('..')).toHaveAttribute(
    'data-drop-target',
    'after',
  );
  await page.screenshot({
    path: test.info().outputPath('page-drag-preview.png'),
    animations: 'disabled',
  });
  await page.mouse.up();
  await expect(page.locator('[data-page-drag-preview]')).toHaveCount(0);
  await expect
    .poll(() =>
      panel
        .locator('[data-page-id]')
        .evaluateAll((cards) =>
          cards.map((card) => (card as HTMLElement).dataset.pageId),
        ),
    )
    .toEqual([originalOrder[1], originalOrder[2], originalOrder[0]]);
  await page.getByRole('tab', { name: 'Document settings' }).click();
  const settingsPanel = page.getByRole('tabpanel', {
    name: 'Document settings',
  });
  await expect(
    settingsPanel.getByRole('combobox', { name: 'Page paper' }),
  ).toBeVisible();
  await expect(
    settingsPanel.locator('section').first().getByRole('heading'),
  ).toHaveText('Page settings');
  for (const label of ['Add before', 'Add after', 'Duplicate', 'Delete']) {
    await expect(
      settingsPanel.getByRole('button', { name: label }),
    ).toBeVisible();
  }
  await settingsPanel.getByRole('button', { name: 'Add after' }).click();
  await page.getByRole('tab', { name: 'Pages', exact: true }).click();
  await expect(panel.locator('[data-page-id]')).toHaveCount(4);
  await page.getByRole('tab', { name: 'Document settings' }).click();
  await page.screenshot({
    path: test.info().outputPath('page-settings.png'),
    animations: 'disabled',
  });
  await page.getByRole('tab', { name: 'Pages', exact: true }).click();
  await page.screenshot({
    path: test.info().outputPath('pages-sidebar.png'),
    animations: 'disabled',
  });
  await page.getByRole('tab', { name: 'Document settings' }).click();
  await settingsPanel.getByRole('button', { name: 'Add before' }).click();
  await page.getByRole('tab', { name: 'Pages', exact: true }).click();
  await expect(panel.locator('[data-page-id]')).toHaveCount(5);
  await page.getByRole('tab', { name: 'Document settings' }).click();
  await settingsPanel.getByRole('button', { name: 'Duplicate' }).click();
  await page.getByRole('tab', { name: 'Pages', exact: true }).click();
  await expect(panel.locator('[data-page-id]')).toHaveCount(6);
  await page.getByRole('tab', { name: 'Document settings' }).click();
  await settingsPanel.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('tab', { name: 'Pages', exact: true }).click();
  await expect(panel.locator('[data-page-id]')).toHaveCount(5);
});

test('Stroke hides sizes; Precision edits a live size slot beside the docked menu', async ({
  page,
}) => {
  await createVault(page);
  await createFromSidebar(page, 'Notebook');
  await page.getByRole('textbox', { name: 'Note name' }).fill('Eraser');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  await expect(page.locator('[data-tool-shelf="surface.write"]')).toBeVisible();
  const primary = page.locator('[data-fl-component="document-toolbar"]');
  const penButton = page
    .locator('[data-toolbar="category-strip"]')
    .getByRole('button', { name: 'Pen', exact: true });
  const primaryBox = await primary.boundingBox();
  const penBox = await penButton.boundingBox();
  expect(primaryBox).not.toBeNull();
  expect(penBox).not.toBeNull();
  expect(penBox!.y).toBeGreaterThan(primaryBox!.y);
  expect(penBox!.y + penBox!.height).toBeLessThan(
    primaryBox!.y + primaryBox!.height,
  );

  await page
    .locator('[data-toolbar="category-strip"]')
    .getByRole('button', { name: 'Eraser', exact: true })
    .click();
  const eraserMenu = page.locator('[data-tool-shelf="surface.erase"]');
  await expect(eraserMenu).toBeVisible();
  const grip = eraserMenu.getByRole('button', {
    name: /Move active tool menu/,
  });
  const gripBox = await grip.boundingBox();
  const paneBox = await page.locator('[data-floating-layer]').boundingBox();
  expect(gripBox).not.toBeNull();
  expect(paneBox).not.toBeNull();
  await page.mouse.move(
    gripBox!.x + gripBox!.width / 2,
    gripBox!.y + gripBox!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(paneBox!.x + 12, paneBox!.y + paneBox!.height / 2, {
    steps: 8,
  });
  await page.mouse.up();
  const docked = page.locator(
    '[data-dock="left"] [data-tool-shelf="surface.erase"]',
  );
  await expect(docked).toBeVisible();
  expect((await docked.innerText()).trim()).toBe('⋮⋮');
  await docked
    .getByRole('button', { name: 'Stroke Eraser', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: /Stroke Eraser settings/ });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('data-popover-placement', 'right');
  const dockedBox = await docked.boundingBox();
  const dialogBox = await dialog.boundingBox();
  expect(dialogBox!.x).toBeGreaterThan(dockedBox!.x + dockedBox!.width);
  await expect(dialog.getByRole('slider', { name: 'Eraser size' })).toHaveCount(
    0,
  );
  await expect(docked.getByRole('group', { name: 'Eraser size' })).toHaveCount(
    0,
  );
  await page.keyboard.press('Escape');
  await docked
    .getByRole('button', { name: 'Precision Eraser', exact: true })
    .click();
  const sizes = docked.getByRole('group', { name: 'Eraser size' });
  await expect(sizes.getByRole('button')).toHaveCount(3);
  const middle = sizes.getByRole('button', { name: 'Eraser size slot 2: 12' });
  await middle.click();
  await expect(middle).toHaveAttribute('aria-pressed', 'true');
  await middle.click();
  const slotDialog = page.getByRole('dialog', { name: 'Edit size slot 2' });
  await expect(slotDialog).toBeVisible();
  await expect(slotDialog).toHaveAttribute('data-popover-placement', 'right');
  const slider = slotDialog.getByRole('slider', { name: 'Eraser size slider' });
  await expect(slider).toHaveAttribute('min', '2');
  await expect(slider).toHaveAttribute('max', '40');
  const beforeGlyph = await middle.locator('span').boundingBox();
  await slider.focus();
  await page.keyboard.press('Home');
  await expect(slider).toHaveValue('2');
  const rangeTrack = slotDialog.locator('[data-range-track]');
  const rangeFill = slotDialog.locator('[data-range-fill]');
  await expect
    .poll(() =>
      rangeFill.evaluate((element) => element.getBoundingClientRect().width),
    )
    .toBe(0);
  await page.keyboard.press('End');
  await expect(slider).toHaveValue('40');
  await expect
    .poll(async () => {
      const [track, fill] = await Promise.all([
        rangeTrack.boundingBox(),
        rangeFill.boundingBox(),
      ]);
      return Math.abs((track?.width ?? 0) - (fill?.width ?? 0));
    })
    .toBeLessThan(1);
  await expect(
    sizes.getByRole('button', { name: 'Eraser size slot 2: 40' }),
  ).toBeVisible();
  const afterGlyph = await sizes
    .getByRole('button', { name: 'Eraser size slot 2: 40' })
    .locator('span')
    .boundingBox();
  expect(afterGlyph!.width).toBeGreaterThan(beforeGlyph!.width);
  await page.screenshot({
    path: test.info().outputPath('docked-eraser-settings.png'),
    animations: 'disabled',
  });
  await page.keyboard.press('Escape');
  const leftGripBox = await docked
    .getByRole('button', { name: /Move active tool menu/ })
    .boundingBox();
  expect(leftGripBox).not.toBeNull();
  await page.mouse.move(
    leftGripBox!.x + leftGripBox!.width / 2,
    leftGripBox!.y + leftGripBox!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    paneBox!.x + paneBox!.width - 12,
    paneBox!.y + paneBox!.height / 2,
    { steps: 8 },
  );
  await page.mouse.up();
  const rightDocked = page.locator(
    '[data-dock="right"] [data-tool-shelf="surface.erase"]',
  );
  await expect(rightDocked).toBeVisible();
  await rightDocked
    .getByRole('button', { name: 'Precision Eraser', exact: true })
    .click();
  const precisionDialog = page.getByRole('dialog', {
    name: /Precision Eraser settings/,
  });
  await expect(precisionDialog).toHaveAttribute(
    'data-popover-placement',
    'left',
  );
  await page.setViewportSize({ width: 800, height: 700 });
  await expect(precisionDialog).toBeVisible();
  const narrowPane = await page.locator('[data-pane]').last().boundingBox();
  const narrowDialog = await precisionDialog.boundingBox();
  expect(narrowDialog!.x).toBeGreaterThanOrEqual(narrowPane!.x);
  expect(narrowDialog!.x + narrowDialog!.width).toBeLessThanOrEqual(
    narrowPane!.x + narrowPane!.width,
  );
});

test('Markdown presents frequent actions directly', async ({ page }) => {
  await createVault(page);
  await createFromSidebar(page, 'Markdown');
  await page.getByRole('textbox', { name: 'Note name' }).fill('Words');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  const direct = page.getByRole('toolbar', { name: 'Writing tools' });
  await expect(direct).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Document source' }).getByRole('textbox'),
  ).toBeVisible();
  await expect(direct.getByRole('button', { name: 'Bold' })).toBeVisible();
  await expect(page.locator('[data-toolbar="category-strip"]')).toHaveCount(0);
  await direct.getByRole('button', { name: 'Insert and more' }).click();
  const writingMenu = page.locator('[data-tool-shelf="writing.secondary"]');
  await expect(writingMenu).toBeVisible();
  await expect(writingMenu).toHaveAttribute('data-active-tool-menu', '');
  await expect(
    page.getByRole('dialog', { name: 'Insert and more' }),
  ).toHaveCount(0);
  const grip = writingMenu.getByRole('button', {
    name: /Move active tool menu/,
  });

  const paneBox = await page.locator('[data-floating-layer]').boundingBox();
  await expect
    .poll(async () => (await grip.boundingBox())?.y ?? 0)
    .toBeGreaterThan(paneBox!.y);
  const gripBox = await grip.boundingBox();
  expect(gripBox).not.toBeNull();
  expect(paneBox).not.toBeNull();
  await page.mouse.move(
    gripBox!.x + gripBox!.width / 2,
    gripBox!.y + gripBox!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    paneBox!.x + paneBox!.width - 12,
    paneBox!.y + paneBox!.height / 2,
    { steps: 8 },
  );
  await expect(page.locator('[data-drag-preview]')).toHaveAttribute(
    'data-dock',
    'right',
  );
  await page.mouse.up();
  const rightMenu = page.locator(
    '[data-dock="right"] [data-tool-shelf="writing.secondary"]',
  );
  await expect(rightMenu).toBeVisible();
  const rightBox = await rightMenu.boundingBox();
  expect(rightBox).not.toBeNull();
  expect(rightBox!.height).toBeGreaterThan(rightBox!.width);
  await page.screenshot({
    path: test.info().outputPath('markdown-writing-menu.png'),
    animations: 'disabled',
  });
  const rightGripBox = await rightMenu
    .getByRole('button', { name: /Move active tool menu/ })
    .boundingBox();
  expect(rightGripBox).not.toBeNull();
  await page.mouse.move(
    rightGripBox!.x + rightGripBox!.width / 2,
    rightGripBox!.y + rightGripBox!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    paneBox!.x + paneBox!.width / 2,
    paneBox!.y + paneBox!.height - 12,
    { steps: 8 },
  );
  await expect(page.locator('[data-drag-preview]')).toHaveAttribute(
    'data-dock',
    'bottom',
  );
  await page.mouse.up();
  await expect(
    page.locator('[data-dock="bottom"] [data-tool-shelf="writing.secondary"]'),
  ).toBeVisible();

  await createFromSidebar(page, 'Block page');
  await page.getByRole('textbox', { name: 'Note name' }).fill('Blocks');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  await expect(
    page.getByRole('toolbar', { name: 'Writing tools' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('region', { name: 'Document source' }).getByRole('textbox'),
  ).toBeVisible();
  await expect(
    page.locator('[data-tool-shelf="writing.secondary"]'),
  ).toHaveCount(0);
  const blockEditor = page.locator('.flbp-host .ProseMirror');
  await expect(blockEditor).toBeVisible();
  await blockEditor.locator('p').first().hover();
  await expect(page.getByRole('button', { name: 'Add block' })).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath('block-writing-menu.png'),
    animations: 'disabled',
  });
});

test('floating toolbars share glass and pen dialogs show tool-specific settings', async ({
  page,
}) => {
  await createVault(page);
  await createFromSidebar(page, 'Notebook');
  await page.getByRole('textbox', { name: 'Note name' }).fill('Glass controls');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  const island = page.locator('[data-tool-shelf="surface.write"]');
  await expect(island).toBeVisible();
  const floating = await island.evaluate((element) => {
    const css = getComputedStyle(element);
    return {
      radius: parseFloat(css.borderTopLeftRadius),
      blur: css.backdropFilter,
    };
  });
  expect(floating.radius).toBeGreaterThanOrEqual(12);
  expect(floating.blur).toContain('blur(');

  const pen = page
    .locator('[data-tool-shelf="surface.write"]')
    .getByRole('button', { name: 'Pen', exact: true });
  await pen.click();
  const settings = page.getByRole('dialog', { name: 'Pen settings' });
  await expect(settings).toBeVisible();
  await expect(
    settings.getByRole('slider', { name: 'Pressure response' }),
  ).toBeVisible();
  const sliderWidth = await settings
    .getByRole('slider', { name: 'Pressure response' })
    .evaluate((element) => element.getBoundingClientRect().width);
  expect(sliderWidth).toBeGreaterThan(200);
  await expect(settings.getByRole('group', { name: 'Pen family' })).toHaveCount(
    0,
  );
  await expect(settings.getByRole('region', { name: 'Color' })).toHaveCount(0);
  await expect(settings.getByRole('region', { name: 'Size' })).toHaveCount(0);
  const panel = await settings.evaluate((element) => {
    const css = getComputedStyle(element);
    return {
      radius: parseFloat(css.borderTopLeftRadius),
      blur: css.backdropFilter,
    };
  });
  expect(panel.radius).toBeGreaterThanOrEqual(12);
  expect(panel.blur).toContain('blur(');
  await page.screenshot({
    path: test.info().outputPath('pen-settings-glass.png'),
    animations: 'disabled',
  });
});
