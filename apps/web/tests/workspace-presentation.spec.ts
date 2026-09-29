import { setDocumentPresentation } from './support/document-presentation.js';
import { expect, test } from '@playwright/test';
import { createFromSidebar } from './support/sidebar-create.js';

async function savedMarkdown(
  page: import('@playwright/test').Page,
): Promise<string> {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const vault = await root.getDirectoryHandle('Split Markdown');
    return (await (await vault.getFileHandle('Flight.md')).getFile()).text();
  });
}

test('a live document splits into a usable second pane', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: undefined,
      configurable: true,
    });
  });
  await page.goto('/');
  await page.getByTestId('create-vault-button').click();
  await page.getByTestId('create-vault-name-input').fill('Split workspace');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();

  await page
    .getByRole('tab', { name: 'welcome.md' })
    .click({ button: 'right' });
  await page
    .getByRole('menuitem', { name: 'Split right', exact: true })
    .click();

  await expect(page.locator('[data-pane]')).toHaveCount(2);
  await expect(page.locator('[data-pane="main"] .cm-content')).toBeVisible();
  await expect(page.locator('[data-pane]').nth(1)).toContainText(
    'No document open',
  );
});

test('Markdown Split presents source and reader as one document', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: undefined,
      configurable: true,
    });
  });
  await page.goto('/');
  await page.getByTestId('create-vault-button').click();
  await page.getByTestId('create-vault-name-input').fill('Split Markdown');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();
  await createFromSidebar(page, 'Markdown');
  await page.getByRole('textbox', { name: 'Note name' }).fill('Flight');
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  await expect(page.getByRole('tab', { name: 'Flight.md' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(
    page.getByRole('button', { name: 'Rename Flight' }),
  ).toBeVisible();
  const source = page.getByRole('region', { name: 'Document source' });
  await source.locator('.cm-content').click();
  await source.locator('.cm-content').press('Control+End');
  await page.keyboard.insertText('# Wing theory\n\nLift grows with airspeed.');
  await expect(source.locator('.cm-content')).toContainText('Wing theory');
  await page.keyboard.press('Control+s');
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible();
  await expect.poll(() => savedMarkdown(page)).toContain('Wing theory');

  await setDocumentPresentation(page, 'Split');
  await expect(source).toBeVisible();
  const preview = page.getByRole('region', { name: 'Document preview' });
  await expect(preview).toBeVisible();
  await expect(
    preview.getByRole('heading', { name: 'Wing theory' }),
  ).toBeVisible();
  await page.waitForTimeout(350);
  await page.screenshot({ path: test.info().outputPath('markdown-split.png') });
  await page.setViewportSize({ width: 1024, height: 1366 });
  await expect(source).toBeVisible();
  await expect(preview).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath('markdown-split-portrait.png'),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(source).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Document view: Split' }),
  ).toBeVisible();
  await expect(preview).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.waitForTimeout(350);
  await page.screenshot({
    path: test.info().outputPath('markdown-split-compact.png'),
  });
});

test('document controls and notebook page use the compact workspace chrome', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() =>
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: undefined,
      configurable: true,
    }),
  );
  await page.goto('/');
  await page.getByTestId('create-vault-button').click();
  await page.getByTestId('create-vault-name-input').fill('Toolbar chrome');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();
  await createFromSidebar(page, 'Notebook');
  await page.getByRole('textbox', { name: 'Note name' }).fill('Paper');
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('button', { name: 'Create', exact: true })
    .click();

  const rail = page.getByRole('navigation', { name: 'Primary' });
  const sidebar = page.getByRole('complementary', { name: 'Sidebar' });
  const toolbar = page.locator('[data-fl-component="document-toolbar"]');
  await expect(
    toolbar.getByRole('radio', { name: 'Edit', exact: true }),
  ).toBeVisible();
  await expect(
    toolbar.getByRole('button', { name: 'Note actions' }),
  ).toBeVisible();
  await expect(
    rail.getByRole('button', { name: /^(Edit|View|Split)$/ }),
  ).toHaveCount(0);
  await expect(
    sidebar.getByRole('button', { name: 'Search workspace' }),
  ).toHaveCount(0);
  await expect(
    page.locator('[data-fl-component="titlebar"] [aria-label="Note actions"]'),
  ).toHaveCount(0);
  await expect(page.locator('.fl-nb-shell[data-current="true"]')).toBeVisible();

  const colors = await page.evaluate(() => {
    const background = (selector: string) =>
      getComputedStyle(document.querySelector<HTMLElement>(selector)!)
        .backgroundColor;
    const shell = document.querySelector<HTMLElement>(
      '.fl-nb-shell[data-current="true"]',
    )!;
    return {
      sidebar: background('[data-fl-component="sidebar"]'),
      main: background('[data-fl-component="main"]'),
      toolbar: background('[data-fl-component="document-toolbar"]'),
      pageShadow: getComputedStyle(shell).boxShadow,
    };
  });
  expect(colors.main).not.toBe(colors.sidebar);
  expect(colors.toolbar).toBe(colors.sidebar);
  expect(colors.pageShadow).not.toContain('124, 108, 240');
  await page.screenshot({
    path: test.info().outputPath('notebook-chrome-desktop.png'),
  });

  await toolbar.getByRole('button', { name: 'Note actions' }).click();
  await expect(
    page.getByRole('menuitem', { name: 'Split right', exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(
    toolbar.getByRole('button', { name: 'Note actions' }),
  ).toBeFocused();
  await toolbar.getByRole('button', { name: 'Note actions' }).click();
  await expect(
    page.getByRole('menuitem', { name: 'Delete note' }),
  ).toHaveAttribute('data-danger', 'true');
  await page.getByRole('menuitem', { name: 'Delete note' }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Cancel' })
    .click();
  await expect(page.getByRole('tab', { name: 'Paper.notebook' })).toBeVisible();
  await setDocumentPresentation(page, 'View');
  await expect(
    toolbar.getByRole('radio', { name: 'View', exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    toolbar.getByRole('button', { name: 'Note actions' }),
  ).toBeVisible();
  await expect(
    toolbar.getByRole('button', { name: 'Document view: View' }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: test.info().outputPath('notebook-chrome-compact.png'),
  });
});
