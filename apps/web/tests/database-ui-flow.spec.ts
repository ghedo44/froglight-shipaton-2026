import { createFromSidebar } from './support/sidebar-create.js';
import { clickDatabaseAction } from './support/database-actions.js';
import { expect, test } from '@playwright/test';

test('database dialogs, title, and Block Page preview views work together', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: undefined,
      configurable: true,
    });
  });
  await page.goto('/');
  await page.getByTestId('create-vault-button').click();
  await page.getByTestId('create-vault-name-input').fill('Database UI flow');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();

  await createFromSidebar(page, 'Database');
  await page.getByRole('textbox', { name: 'Note name' }).fill('Tasks');
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  let database = page.getByRole('region', { name: 'Tasks', exact: true });

  await database.getByRole('button', { name: 'Rename Tasks' }).click();
  await database
    .getByRole('textbox', { name: 'Document name' })
    .fill('Project tasks');
  await database.getByRole('textbox', { name: 'Document name' }).press('Enter');
  await expect(
    page
      .getByRole('region', { name: 'Project tasks' })
      .getByRole('heading', { name: 'Project tasks' }),
  ).toBeVisible();
  await expect(
    page.getByRole('tab', { name: 'Project tasks.base' }),
  ).toBeVisible();
  await expect(page.getByText('Tasks.base', { exact: true })).toHaveCount(0);
  database = page.getByRole('region', { name: 'Project tasks', exact: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await database.getByRole('button', { name: 'Add view' }).click();
  const addView = page.getByRole('dialog', { name: 'Add view' });
  await expect(addView).toBeVisible();
  await page.evaluate(() =>
    document.documentElement.style.setProperty(
      '--fl-keyboard-overlay-bottom',
      '300px',
    ),
  );
  await expect
    .poll(async () => {
      const box = await addView.boundingBox();
      return box ? box.y + box.height : Infinity;
    })
    .toBeLessThanOrEqual(528);
  await page.evaluate(() =>
    document.documentElement.style.removeProperty(
      '--fl-keyboard-overlay-bottom',
    ),
  );
  await addView.getByRole('textbox', { name: 'New view name' }).fill('Kanban');
  await addView
    .getByRole('combobox', { name: 'New view layout' })
    .selectOption('board');
  await addView.getByRole('button', { name: 'Create view' }).click();
  await expect(
    database.getByRole('button', { name: 'Kanban' }),
  ).toHaveAttribute('aria-current', 'page');
  await page.screenshot({
    path: '../../.impeccable/review/database-toolbar-mobile-current.png',
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({
    path: '../../.impeccable/review/database-toolbar-desktop-current.png',
    animations: 'disabled',
  });
  await clickDatabaseAction(database, 'View settings');
  await page.screenshot({
    path: '../../.impeccable/review/database-view-settings-modal.png',
    animations: 'disabled',
  });
  const settings = page.getByRole('dialog', { name: 'View settings' });
  await expect(settings.locator('details')).toHaveCount(0);
  await settings
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'Filters' })
    .click();
  await expect(
    settings.getByRole('heading', { name: /^Filters ·/ }),
  ).toBeInViewport();
  await settings.getByRole('button', { name: 'Close view settings' }).click();
  await page.setViewportSize({ width: 800, height: 900 });
  const toolbarRight = await database
    .locator('[class*="toolbarRight"]')
    .boundingBox();
  const databaseBounds = await database.boundingBox();
  expect(
    toolbarRight &&
      databaseBounds &&
      toolbarRight.x + toolbarRight.width <=
        databaseBounds.x + databaseBounds.width,
  ).toBeTruthy();
  await page.setViewportSize({ width: 1280, height: 900 });

  await database.getByRole('button', { name: 'New item', exact: true }).click();
  const newNote = page.getByRole('dialog', { name: 'Create a new note' });
  await expect(newNote.getByRole('radio', { name: /Database/ })).toHaveCount(0);
  await newNote.getByRole('textbox', { name: 'Note name' }).fill('First task');
  await newNote.getByRole('radio', { name: /Block page/ }).click();
  await newNote.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(
    page.getByRole('tab', { name: 'First task.blockpage' }),
  ).toHaveAttribute('aria-selected', 'true');

  await createFromSidebar(page);
  await page.getByRole('textbox', { name: 'Note name' }).fill('Loose note');
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  await expect(
    page.getByRole('tab', { name: 'Loose note.md' }),
  ).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Project tasks.base' }).click();
  await expect(
    page.getByRole('tab', { name: 'Project tasks.base' }),
  ).toHaveAttribute('aria-selected', 'true');
  await clickDatabaseAction(database, 'Add existing');
  const picker = page.getByRole('dialog', { name: 'Add existing document' });
  await expect(picker).toBeVisible();
  await page.screenshot({
    path: '../../.impeccable/review/database-add-existing.png',
    animations: 'disabled',
  });
  await picker.getByRole('textbox').fill('Loose note');
  await picker.getByRole('option', { name: /Loose note/ }).click();
  await expect(
    database.getByRole('button', { name: 'Loose note.md', exact: true }),
  ).toBeVisible();

  await createFromSidebar(page, 'Block page');
  await page.getByRole('textbox', { name: 'Note name' }).fill('Host');
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  const editor = page.locator('.flbp-host .ProseMirror');
  await editor.click();
  await page.keyboard.type('/resource embed');
  await page.getByText('Resource embed', { exact: true }).click();
  await page.getByRole('option', { name: 'Project tasks.base' }).click();
  const preview = page.getByRole('region', { name: /Project tasks:/ });
  await expect(preview.getByRole('button', { name: 'Kanban' })).toBeVisible();
  await expect(preview.getByRole('button', { name: 'Table' })).toBeVisible();
  await preview.getByRole('button', { name: 'Table' }).click();
  await expect(preview.getByRole('button', { name: 'Table' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await page.getByRole('tab', { name: 'Project tasks.base' }).click();
  await page.getByRole('tab', { name: 'Host.blockpage' }).click();
  await expect(preview.getByRole('button', { name: 'Table' })).toHaveAttribute(
    'aria-current',
    'page',
  );
});
