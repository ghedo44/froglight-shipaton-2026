import { createFromSidebar } from './support/sidebar-create.js';
import { expect, test } from '@playwright/test';

test('backlinks and related documents name and open their source through the pane router', async ({
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
  await page
    .getByTestId('create-vault-name-input')
    .fill('Knowledge acceptance');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();
  await expect(
    page.getByRole('tab', { name: 'welcome.md', exact: true }),
  ).toBeVisible();
  await createFromSidebar(page);
  await page.getByRole('textbox', { name: 'Note name' }).fill('Target');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  await expect(
    page.getByRole('tab', { name: 'Target.md', exact: true }),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'welcome.md', exact: true }).click();
  const editor = page.locator('.cm-content');
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press('Control+a');
  await page.keyboard.insertText(
    '# Source notes\n\nSee [[Target.md|Readable target]].',
  );
  await page.keyboard.press('Control+s');
  await page.getByRole('tab', { name: 'Target.md', exact: true }).click();
  if (
    !(await page
      .getByRole('tab', { name: 'Connections', exact: true })
      .first()
      .isVisible())
  )
    await page
      .getByRole('button', { name: 'Toggle document sidebar', exact: true })
      .click();
  await page
    .getByRole('tab', { name: 'Connections', exact: true })
    .first()
    .click();
  await expect(
    page.locator('#document-sidebar [role="tabpanel"] > div > section').first(),
  ).toHaveAttribute('aria-label', 'Graph');
  const backlink = page
    .getByRole('navigation', { name: 'Incoming backlinks' })
    .getByRole('button', { name: /^welcome notes\/welcome\.md$/ });
  await expect(backlink).toBeVisible();
  await backlink.click();
  await expect(
    page.getByRole('tab', { name: 'welcome.md', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(editor).toContainText('Source notes');
  const reference = page
    .getByRole('navigation', { name: 'Outgoing references' })
    .getByRole('button', { name: /^Target Target\.md$/ });
  await expect(reference).toBeVisible();

  await expect(
    page.getByRole('tab', { name: 'Backlinks', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('tab', { name: 'References', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('tab', { name: 'Related', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('img', { name: 'Direct document connections' }),
  ).toBeVisible();

  const related = page
    .getByRole('navigation', { name: 'Related documents' })
    .getByRole('button', { name: /Target.md/ });
  await expect(related).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath('related-readable.png'),
    animations: 'disabled',
  });
  await editor.click();
  await page.keyboard.press('Control+a');
  await page.keyboard.insertText('# Source notes\n\nNo links.');
  await page.keyboard.press('Control+s');
  await expect(page.getByText('No references', { exact: true })).toBeVisible();

  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+s');
  await expect(reference).toBeVisible();
  await page.keyboard.press('Control+Shift+z');
  await page.keyboard.press('Control+s');
  await expect(page.getByText('No references', { exact: true })).toBeVisible();

  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+s');
  await reference.click();
  await expect(
    page.getByRole('tab', { name: 'Target.md', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
});

test('a Block Page link reaches the narrow dark knowledge sidebar and local graph', async ({
  browser,
}) => {
  test.setTimeout(60000);
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    colorScheme: 'dark',
  });
  const page = await context.newPage();
  try {
    await page.addInitScript(() =>
      Object.defineProperty(window, 'showDirectoryPicker', {
        value: undefined,
        configurable: true,
      }),
    );
    await page.goto('/');
    await page.getByTestId('create-vault-button').click();
    await page.getByTestId('create-vault-name-input').fill('Block knowledge');
    await page.getByTestId('choose-vault-location-button').click();
    await page.getByTestId('confirm-create-vault-button').click();

    const newNote = page.getByLabel('New note', { exact: true });
    await newNote.click();
    await page.getByRole('textbox', { name: 'Note name' }).fill('Target');
    await page
      .getByRole('dialog', { name: 'Create a new note' })
      .getByRole('button', { name: 'Create', exact: true })
      .click();

    await newNote.click();
    await page.getByRole('textbox', { name: 'Note name' }).fill('Block source');
    await page.getByRole('radio', { name: /Block page/ }).click();
    await page
      .getByRole('dialog', { name: 'Create a new note' })
      .getByRole('button', { name: 'Create', exact: true })
      .click();
    const editor = page.locator('.flbp-host .ProseMirror');
    await editor.click();
    await page.keyboard.insertText('Open Target');
    await page.keyboard.press('Control+a');
    const moreCategories = page.getByRole('button', {
      name: 'More tool categories',
      exact: true,
    });
    if (await moreCategories.isVisible()) {
      await moreCategories.click();
      await page.getByRole('menuitem', { name: 'Insert', exact: true }).click();
    } else {
      await page.getByRole('button', { name: 'Insert', exact: true }).click();
    }
    await page
      .getByRole('button', { name: 'Link destination', exact: true })
      .click();
    const linkDialog = page.getByRole('dialog', { name: 'Link destination' });
    await linkDialog
      .getByRole('textbox', { name: 'Link destination' })
      .fill('Target.md');
    await linkDialog.getByRole('button', { name: 'Link', exact: true }).click();
    await page.keyboard.press('Control+s');

    await page
      .getByRole('button', { name: 'Toggle document sidebar', exact: true })
      .click();
    await page
      .getByRole('tab', { name: 'Connections', exact: true })
      .first()
      .click();
    await expect(
      page
        .getByRole('navigation', { name: 'Outgoing references' })
        .getByRole('button', { name: /^Target Target\.md$/ }),
    ).toBeVisible();
    await expect(
      page.getByRole('img', { name: 'Direct document connections' }),
    ).toBeVisible();
    const sidebarFits = await page.locator('#document-sidebar [role="tabpanel"]').evaluate(
      (panel) => panel.scrollWidth <= panel.clientWidth,
    );
    expect(sidebarFits).toBe(true);
    await page.screenshot({
      path: test.info().outputPath('block-local-graph-dark-narrow.png'),
      animations: 'disabled',
    });
    await page
      .getByRole('button', { name: 'Open full graph', exact: true })
      .click();
    await expect(
      page.getByRole('img', { name: 'Workspace document graph' }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});
