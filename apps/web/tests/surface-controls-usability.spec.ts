import { expect, test, type Page } from '@playwright/test';
import { createFromSidebar } from './support/sidebar-create.js';

async function revealToolOptions(page: Page, label: string): Promise<void> {
  await expect(
    page.locator(
      '[data-toolbar="category-strip"] [data-category="surface.write"]',
    ),
  ).toHaveCount(1);
  const category = page
    .locator('[data-toolbar="category-strip"]')
    .getByRole('button', { name: label, exact: true });
  if (!(await category.isVisible())) {
    await page.getByRole('button', { name: 'More tool categories' }).click();
    await page.getByRole('menuitem', { name: label, exact: true }).click();
  }
  if (await category.isVisible()) {
    if ((await category.getAttribute('aria-pressed')) !== 'true')
      await category.click();
    await expect(category).toHaveAttribute('aria-pressed', 'true');
    if ((await category.getAttribute('aria-expanded')) !== 'true')
      await category.click();
  }
  const shelfId =
    label === 'Pen' ? 'surface.write' : `surface.${label.toLowerCase()}`;
  await expect(page.locator(`[data-tool-shelf="${shelfId}"]`)).toBeVisible();
}

async function createNote(page: Page, name: string, type: RegExp) {
  page.setDefaultTimeout(10000);
  await page.addInitScript(() =>
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: undefined,
      configurable: true,
    }),
  );
  await page.goto('/');
  await page.getByTestId('create-vault-button').click();
  await page.getByTestId('create-vault-name-input').fill(name);
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();
  await expect(
    page.getByRole('tab', { name: 'welcome.md', exact: true }),
  ).toBeVisible();
  await createFromSidebar(page, type);
  await page.getByLabel('Note name').fill(name);
  await page.getByRole('radio', { name: type }).check();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  await revealToolOptions(page, 'Pen');
  await expect(
    page
      .locator('[data-tool-shelf="surface.write"]')
      .getByRole('button', { name: 'Pen', exact: true }),
  ).toBeVisible();
}

test.use({ viewport: { width: 1440, height: 900 } });
test('pen family settings open once and preserve keyboard focus after updating styles', async ({
  page,
}) => {
  await createNote(page, 'Style regression', /Ink page/);
  await expect(
    page
      .locator('[data-tool-shelf="surface.write"]')
      .getByRole('button', { name: 'Pen', exact: true }),
  ).toBeVisible();
  const settingsFor = async (family: string) => {
    await revealToolOptions(
      page,
      family === 'Highlighter' ? 'Highlighter' : 'Pen',
    );
    const shelf = page.locator(
      `[data-tool-shelf="${family === 'Highlighter' ? 'surface.highlighter' : 'surface.write'}"]`,
    );
    const tool = shelf.getByRole('button', { name: family, exact: true });
    if ((await tool.getAttribute('aria-pressed')) !== 'true')
      await tool.click();
    await tool.click();
    const dialog = page.getByRole('dialog', {
      name: family + ' settings',
      exact: true,
    });
    await expect(dialog).toBeVisible();
    return dialog;
  };
  for (const family of ['Pen', 'Fountain Pen', 'Highlighter']) {
    const dialog = await settingsFor(family);
    await dialog
      .getByRole('button', { name: 'Color: #c4554d', exact: true })
      .click();
    await dialog.getByLabel('New style name').fill('My ' + family);
    await dialog
      .getByRole('button', { name: 'Save as new', exact: true })
      .click();
    await expect(dialog.getByLabel('New style name')).toBeFocused();
    await dialog
      .getByRole('button', { name: 'Color: #7c6cf0', exact: true })
      .click();
    await dialog
      .getByRole('button', {
        name: 'Update My ' + family + ' to the working style',
        exact: true,
      })
      .click();
    await expect(
      dialog.getByRole('button', { name: new RegExp('^My ' + family + ' ') }),
    ).toBeFocused();
    await page.screenshot({
      path: test
        .info()
        .outputPath(family.replaceAll(' ', '-') + '-settings.png'),
    });
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  }
  await page.keyboard.press('Control+s');
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: /Style regression Browser/ }).click();
  await page
    .getByRole('button', { name: 'Style regression.ink', exact: true })
    .click();
  await revealToolOptions(page, 'Pen');
  await expect(
    page
      .locator('[data-tool-shelf="surface.write"]')
      .getByRole('button', { name: 'Pen', exact: true }),
  ).toBeVisible();
  for (const family of ['Pen', 'Fountain Pen', 'Highlighter']) {
    const dialog = await settingsFor(family);
    const card = dialog.getByRole('button', {
      name: new RegExp('^My ' + family + ' '),
    });
    await expect(card).toBeVisible();
    await card.click();
    await dialog
      .getByRole('button', { name: 'Delete My ' + family, exact: true })
      .click();
    await expect(card).toHaveCount(0);
    await expect(dialog.getByLabel('New style name')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  }
  await expect
    .poll(() =>
      page.evaluate(async () => {
        try {
          const vault = await (
            await navigator.storage.getDirectory()
          ).getDirectoryHandle('Style regression');
          const meta = await vault.getDirectoryHandle('.froglight');
          const text = await (
            await (await meta.getFileHandle('settings.json')).getFile()
          ).text();
          return ['My Pen', 'My Fountain Pen', 'My Highlighter'].some((name) =>
            text.includes(name),
          );
        } catch (error) {
          if (error instanceof DOMException && error.name === 'NotFoundError')
            return false;
          throw error;
        }
      }),
    )
    .toBe(false);
  await page.reload();
  await page.getByRole('button', { name: /Style regression Browser/ }).click();
  await page
    .getByRole('button', { name: 'Style regression.ink', exact: true })
    .click();
  await revealToolOptions(page, 'Pen');
  await expect(
    page
      .locator('[data-tool-shelf="surface.write"]')
      .getByRole('button', { name: 'Pen', exact: true }),
  ).toBeVisible();
  for (const family of ['Pen', 'Fountain Pen', 'Highlighter']) {
    const dialog = await settingsFor(family);
    await expect(
      dialog.getByRole('button', { name: new RegExp('^My ' + family + ' ') }),
    ).toHaveCount(0);
    await page.keyboard.press('Escape');
  }
});

test('Whiteboard edits the same card and saves one undoable change', async ({
  page,
}) => {
  await createNote(page, 'Card regression', /Whiteboard/);
  const insertCategory = page.getByRole('button', {
    name: 'Insert',
    exact: true,
  });
  if (await insertCategory.isVisible()) {
    await insertCategory.click();
  } else {
    await page
      .getByRole('button', { name: 'More tool categories', exact: true })
      .click();
    await page.getByRole('menuitem', { name: 'Insert', exact: true }).click();
  }
  await revealToolOptions(page, 'Insert');
  await page.getByRole('button', { name: 'Card', exact: true }).click();
  await page.mouse.click(620, 370);
  await page.keyboard.press('v');
  await page.mouse.dblclick(670, 400);
  const editor = page.getByRole('textbox', {
    name: 'Edit text',
    exact: true,
  });
  await expect(editor).toHaveValue('New card');
  await editor.fill('Edited card');
  await editor.press('Control+Enter');
  await page.keyboard.press('Control+z');
  await page.mouse.dblclick(670, 400);
  await expect(editor).toHaveValue('New card');
  await editor.press('Escape');
  await page.keyboard.press('Control+Shift+z');
  await page.mouse.dblclick(670, 400);
  await expect(editor).toHaveValue('Edited card');
  await editor.press('Escape');
  await page.keyboard.press('Control+s');
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible();
  const saved = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const vault = await root.getDirectoryHandle('Card regression');
    const file = await vault.getFileHandle('Card regression.whiteboard');
    return JSON.parse(await (await file.getFile()).text());
  });
  expect(saved.order).toHaveLength(1);
  expect(saved.objects[saved.order[0]]).toMatchObject({
    type: 'froglight.card',
    text: 'Edited card',
  });
  await page.reload();
  await page.getByRole('button', { name: /Card regression Browser/ }).click();
  await page
    .getByRole('button', { name: 'Card regression.whiteboard', exact: true })
    .click();
  await expect(
    page
      .locator('[data-toolbar="category-strip"]')
      .getByRole('button', { name: 'Pen', exact: true }),
  ).toBeVisible();
  await page.keyboard.press('v');
  await page.mouse.dblclick(670, 400);
  await expect(editor).toHaveValue('Edited card');
  await editor.press('Escape');
  await page.screenshot({ path: test.info().outputPath('card-reopened.png') });
});

for (const viewport of [
  { width: 820, height: 1180 },
  { width: 390, height: 844 },
]) {
  test.describe(`touch quick slots ${viewport.width}px`, () => {
    test.use({ viewport, hasTouch: true });
    test('active slot edits are live and pen and highlighter values stay independent', async ({
      page,
    }) => {
      await createNote(page, 'Slot regression', /Ink page/);
      const openSlot = async (kind: 'size' | 'color') => {
        const shelf = page.locator('[data-tool-shelf]:visible').first();
        const slot = shelf
          .locator(`button[data-slot-kind="${kind}"][data-slot-index="0"]`)
          .first();
        if (await slot.isVisible()) {
          if ((await slot.getAttribute('aria-pressed')) !== 'true')
            await slot.tap();
          await slot.tap();
        } else {
          await shelf
            .getByRole('button', { name: 'More tools' })
            .tap({ force: true });
          await page
            .getByRole('button', {
              name:
                kind === 'size' ? 'Edit quick width 1' : 'Edit quick color 1',
              exact: true,
            })
            .tap();
        }
        const dialog = page.getByRole('dialog', {
          name: `Edit ${kind} slot 1`,
        });
        await expect(dialog).toBeVisible();
        return dialog;
      };
      let dialog = await openSlot('size');
      await dialog.getByLabel('Slot width in points').fill('8.5');
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      dialog = await openSlot('size');
      await expect(dialog.getByLabel('Slot width in points')).toHaveValue(
        '8.5',
      );
      await page.keyboard.press('Escape');
      await page.setViewportSize({ width: 1180, height: 820 });
      await revealToolOptions(page, 'Pen');
      dialog = await openSlot('color');
      await dialog.getByLabel('Slot color value').fill('#448361');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Control+s');
      await expect(
        page.getByText('Saved locally', { exact: true }),
      ).toBeVisible();
      await page.reload();
      await page.getByRole('button', { name: /Slot regression Browser/ }).tap();
      await page
        .getByRole('button', { name: 'Slot regression.ink', exact: true })
        .tap();
      await expect(
        page.getByRole('tab', { name: 'Slot regression.ink' }),
      ).toBeVisible();
      await revealToolOptions(page, 'Pen');
      dialog = await openSlot('size');
      await expect(dialog.getByLabel('Slot width in points')).toHaveValue(
        '8.5',
      );
      await page.keyboard.press('Escape');
      dialog = await openSlot('color');
      await expect(dialog.getByLabel('Slot color value')).toHaveValue(
        '#448361',
      );
      await page.keyboard.press('Escape');
      await revealToolOptions(page, 'Highlighter');
      dialog = await openSlot('size');
      await expect(dialog.getByLabel('Slot width in points')).toHaveValue('8');
      await dialog.getByLabel('Slot width in points').fill('11');
      await page.keyboard.press('Escape');
      await revealToolOptions(page, 'Pen');
      dialog = await openSlot('size');
      await expect(dialog.getByLabel('Slot width in points')).toHaveValue(
        '8.5',
      );
      await page.keyboard.press('Escape');
    });
  });
}
