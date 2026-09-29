import { createFromSidebar } from './support/sidebar-create.js';
import {
  clickDatabaseAction,
  openDocumentProperties,
} from './support/database-actions.js';
import { expect, test } from '@playwright/test';

test('a document can acquire a smart collection property before membership', async ({
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
  await page
    .getByTestId('create-vault-name-input')
    .fill('Smart property acceptance');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();
  await createFromSidebar(page, 'Database');
  await page.getByRole('textbox', { name: 'Note name' }).fill('Research');
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  const database = page.getByRole('region', { name: 'Research', exact: true });
  await clickDatabaseAction(database, 'View settings');
  await page.getByRole('button', { name: 'Schema and templates', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Property name', exact: true })
    .fill('Topic');
  await page
    .getByRole('dialog', { name: 'View settings' })
    .getByRole('button', { name: 'Add property', exact: true })
    .click();
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('heading', { name: 'Documents in this database · Manual' }).click();
  await page
    .getByRole('button', { name: /Convert to smart collection/ })
    .click();
  await page.getByRole('heading', { name: /^Filters ·/ }).click();
  await page
    .getByRole('combobox', { name: 'Filter scope' })
    .selectOption('membership');
  await page
    .getByRole('combobox', { name: 'Filter property' })
    .selectOption({ label: 'Topic' });
  await page
    .getByRole('textbox', { name: 'Value', exact: true })
    .fill('Physics');
  await page
    .getByRole('button', { name: 'Add filter', exact: true })
    .click();
  await page.getByRole('button', { name: 'Close view settings' }).click();
  await createFromSidebar(page);
  await page.getByRole('textbox', { name: 'Note name' }).fill('Paper');
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  await expect(page.getByRole('tab', { name: 'Paper.md' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await openDocumentProperties(page);
  const inspector = page.getByRole('tabpanel', { name: 'Properties' });
  await inspector
    .getByRole('combobox', { name: 'Apply properties from' })
    .selectOption({ label: 'Research' });
  await inspector.getByRole('textbox', { name: 'Topic' }).fill('Physics');
  await inspector.getByRole('textbox', { name: 'Topic' }).press('Tab');
  await expect(
    inspector.getByText('Smart collection · membership follows its rules'),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'Research.base' }).click();
  await expect(
    page.getByRole('tab', { name: 'Research.base' }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(
    database.getByRole('button', { name: 'Paper.md', exact: true }),
  ).toBeVisible();
});

test('nested smart collection rules are authored and applied in the app', async ({
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
  await page.getByTestId('create-vault-name-input').fill('Grouped rules');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();
  await createFromSidebar(page, 'Database');
  await page.getByRole('textbox', { name: 'Note name' }).fill('Research');
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  const database = page.getByRole('region', { name: 'Research', exact: true });
  await clickDatabaseAction(database, 'View settings');
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('heading', { name: 'Documents in this database · Manual' }).click();
  await page
    .getByRole('button', { name: /Convert to smart collection/ })
    .click();
  await page.getByRole('heading', { name: /^Filters ·/ }).click();
  await page
    .getByRole('combobox', { name: 'Filter scope' })
    .selectOption('membership');
  await page.getByRole('button', { name: 'Add condition group' }).click();
  const group = page.getByRole('group', { name: 'Condition group' });
  await group.getByRole('combobox', { name: 'Match' }).selectOption('or');
  await group.getByRole('combobox', { name: 'Field' }).selectOption('$path');
  await group
    .getByRole('combobox', { name: 'Operator' })
    .selectOption('contains');
  await group.getByRole('textbox', { name: 'Value' }).fill('Paper.md');
  await page.getByRole('button', { name: 'Save condition groups' }).click();
  await page.getByRole('button', { name: 'Close view settings' }).click();
  await createFromSidebar(page);
  await page.getByRole('textbox', { name: 'Note name' }).fill('Paper');
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  await expect(page.getByRole('tab', { name: 'Paper.md' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('tab', { name: 'Research.base' }).click();
  await expect(
    page.getByRole('tab', { name: 'Research.base' }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(
    database.getByRole('button', { name: 'Paper.md', exact: true }),
  ).toBeVisible();
});

test('document Properties evaluates formulas from its database', async ({
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
  await page.getByTestId('create-vault-name-input').fill('Computed properties');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();
  await createFromSidebar(page, 'Database');
  await page.getByRole('textbox', { name: 'Note name' }).fill('Research');
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  const database = page.getByRole('region', { name: 'Research', exact: true });
  await database.getByRole('button', { name: 'New item', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('textbox', { name: 'Note name' })
    .fill('Paper');
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  await expect(page.getByRole('tab', { name: 'Paper.md' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('tab', { name: 'Research.base' }).click();
  await expect(
    page.getByRole('tab', { name: 'Research.base' }),
  ).toHaveAttribute('aria-selected', 'true');
  await clickDatabaseAction(database, 'View settings');
  await page.getByRole('button', { name: 'Schema and templates', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Property name', exact: true })
    .fill('Review label');
  await page
    .getByRole('combobox', { name: 'Type', exact: true })
    .selectOption('formula');
  await page
    .getByRole('textbox', { name: 'Formula expression', exact: true })
    .fill('concat("Review", " due")');
  await page
    .getByRole('dialog', { name: 'View settings' })
    .getByRole('button', { name: 'Add property', exact: true })
    .click();
  await page.getByRole('button', { name: 'Close view settings' }).click();
  await page.getByRole('tab', { name: 'Paper.md' }).click();
  await openDocumentProperties(page);
  const inspector = page.getByRole('tabpanel', { name: 'Properties' });
  await expect(inspector.getByText('Review due')).toBeVisible();
  await expect(
    inspector.getByText('Review label', { exact: true }).first(),
  ).toBeVisible();
  await inspector.getByRole('button', { name: 'Open database' }).click();
  await expect(
    page.getByRole('tab', { name: 'Research.base' }),
  ).toHaveAttribute('aria-selected', 'true');
  await database.getByRole('button', { name: 'New item', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('textbox', { name: 'Note name' })
    .fill('Target');
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  await expect(page.getByRole('tab', { name: 'Target.md' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('tab', { name: 'Research.base' }).click();
  await expect(
    page.getByRole('tab', { name: 'Research.base' }),
  ).toHaveAttribute('aria-selected', 'true');
  await clickDatabaseAction(database, 'View settings');
  await page.getByRole('button', { name: 'Schema and templates', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Property name', exact: true })
    .fill('Related');
  await page
    .getByRole('combobox', { name: 'Type', exact: true })
    .selectOption('relation');
  await page
    .getByRole('combobox', { name: 'Target database' })
    .selectOption({ label: 'Research' });
  await page
    .getByRole('dialog', { name: 'View settings' })
    .getByRole('button', { name: 'Add property', exact: true })
    .click();
  await page.getByRole('button', { name: 'Close view settings' }).click();
  await page.getByRole('tab', { name: 'Paper.md' }).click();
  await inspector.getByRole('button', { name: 'Choose related' }).click();
  await inspector
    .getByRole('searchbox', { name: 'Find related document' })
    .fill('Target');
  await inspector.getByRole('checkbox', { name: 'Target' }).check();
  await expect(
    inspector.getByRole('button', { name: '1 selected' }),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'Research.base' }).click();
  const paperRow = database.getByRole('row', { name: /Paper/ });
  await paperRow.getByRole('button', { name: /Edit Related:/ }).click();
  await paperRow.getByRole('button', { name: '1 selected' }).click();
  await paperRow
    .getByRole('searchbox', { name: 'Find related document' })
    .fill('Target');
  await expect(
    paperRow.getByRole('checkbox', { name: 'Target' }),
  ).toBeChecked();
});

test('an empty database supports user templates and all six views offline', async ({
  page,
  context,
}) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: undefined,
      configurable: true,
    });
  });
  await page.goto('/');
  await page.getByTestId('create-vault-button').click();
  await page.getByTestId('create-vault-name-input').fill('Database acceptance');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();
  await expect(
    page.getByRole('tab', { name: 'welcome.md', exact: true }),
  ).toBeVisible();
  await createFromSidebar(page, 'Database');
  await page.getByRole('textbox', { name: 'Note name' }).fill('Contacts');
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  const database = page.getByRole('region', { name: 'Contacts', exact: true });
  await expect(
    database.getByRole('heading', { name: 'Rename Contacts' }),
  ).toBeVisible();
  await expect(
    database.getByRole('combobox', { name: 'Status', exact: true }),
  ).toHaveCount(0);
  await expect(
    database.getByRole('columnheader', { name: 'Name' }),
  ).toBeVisible();
  await expect(
    database.getByRole('button', { name: 'Add property' }).first(),
  ).toBeVisible();
  await database.getByRole('button', { name: 'New item', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('textbox', { name: 'Note name' })
    .fill('Ada');
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('radio', { name: 'Block page' })
    .click();
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  await expect(
    page.getByRole('tab', { name: 'Ada.blockpage' }),
  ).toHaveAttribute('aria-selected', 'true');
  const adaEditor = page.locator('.flbp-host .ProseMirror');
  await expect(adaEditor).toBeVisible();
  await adaEditor.click();
  await page.keyboard.type('Ada owns design notes');
  await expect(adaEditor).toContainText('Ada owns design notes');
  await page.getByRole('tab', { name: 'Contacts.base' }).click();
  await expect(
    database.getByRole('button', { name: 'Ada', exact: true }),
  ).toBeVisible();
  await clickDatabaseAction(database, 'View settings');
  await page.getByRole('button', { name: 'Schema and templates', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Property name', exact: true })
    .fill('Region');
  await page
    .getByRole('combobox', { name: 'Type', exact: true })
    .selectOption('select');
  await page
    .getByRole('dialog', { name: 'View settings' })
    .getByRole('button', { name: 'Add property', exact: true })
    .click();
  await page
    .getByRole('textbox', { name: 'New option for Region' })
    .fill('Europe');
  await page
    .getByRole('button', { name: 'Add option', exact: true })
    .click();
  await expect(
    page.getByRole('textbox', { name: 'Region option name' }),
  ).toHaveValue('Europe');
  await page
    .getByRole('combobox', { name: 'Color for Europe' })
    .selectOption('blue');
  await expect(
    page.getByRole('combobox', { name: 'Color for Europe' }),
  ).toHaveValue('blue');
  await page.getByRole('button', { name: 'Close view settings' }).click();
  await database.getByRole('button', { name: /Edit Region:/ }).click();
  await database.getByRole('combobox', { name: 'Region', exact: true }).focus();
  await database
    .getByRole('combobox', { name: 'Region', exact: true })
    .selectOption({ label: 'Europe' });
  await expect(database).toHaveAttribute('aria-busy', 'false');
  await expect(
    database.getByRole('button', { name: 'Edit Region: Europe' }),
  ).toBeVisible();
  await clickDatabaseAction(database, 'View settings');
  await page
    .getByRole('combobox', { name: 'Group by', exact: true })
    .selectOption({ label: 'Region' });
  await page
    .getByRole('textbox', { name: 'View name', exact: true })
    .fill('Regions');
  await page
    .getByRole('textbox', { name: 'View name', exact: true })
    .press('Tab');
  await page
    .getByRole('combobox', { name: 'Layout', exact: true })
    .selectOption('board');
  await page.getByRole('button', { name: 'Close view settings' }).click();
  await expect(
    database.getByRole('heading', { name: /Europe \(1\)/ }),
  ).toBeVisible();
  await database
    .getByRole('combobox', { name: 'Move Ada to Region' })
    .selectOption({ label: 'Unassigned' });
  await expect(
    database.getByRole('heading', { name: /Unassigned \(1\)/ }),
  ).toBeVisible();
  await database
    .getByRole('combobox', { name: 'Move Ada to Region' })
    .selectOption({ label: 'Europe' });
  await expect(
    database.getByRole('heading', { name: /Europe \(1\)/ }),
  ).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: '../../.impeccable/review/database-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 810, height: 1080 });
  await expect(
    database.getByRole('button', { name: 'New item', exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: '../../.impeccable/review/database-tablet-portrait-web.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 1080, height: 810 });
  await page.screenshot({
    path: '../../.impeccable/review/database-tablet-landscape-web.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(database).toHaveAttribute('aria-busy', 'false');
  await page.screenshot({
    path: '../../.impeccable/review/database-mobile-web.png',
    fullPage: true,
    animations: 'disabled',
  });
  await clickDatabaseAction(database, 'View settings');
  await page.getByRole('button', { name: 'Schema and templates', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Template name', exact: true })
    .fill('European contact');
  await page
    .getByRole('combobox', { name: 'Template document kind', exact: true })
    .selectOption({ label: 'Block page' });
  await page
    .getByRole('button', { name: 'Customize template', exact: true })
    .click();
  const defaults = page.getByRole('group', {
    name: 'Property defaults',
  });
  await defaults
    .getByRole('combobox', { name: 'Region', exact: true })
    .selectOption({ label: 'Europe' });
  await page
    .getByRole('button', { name: 'Save template', exact: true })
    .click();
  await page.getByRole('button', { name: 'Close view settings' }).click();
  await database.getByRole('button', { name: 'New item', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('radio', { name: 'European contact' })
    .click();
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('textbox', { name: 'Note name' })
    .fill('Grace');
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  await expect(
    page.getByRole('tab', { name: 'Grace.blockpage' }),
  ).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Contacts.base' }).click();
  await clickDatabaseAction(database, 'View settings');
  // A template's canonical title remains its authored content; its path uses the new resource name.
  await expect(
    page.getByRole('button', { name: 'European contact', exact: true }),
  ).toBeVisible();
  const assignedRegion = await page
    .getByRole('combobox', { name: 'Move Ada to Region' })
    .inputValue();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('tab', { name: 'Ada.blockpage' }).click();
  await page.getByRole('button', { name: 'Note actions' }).click();
  await page.getByRole('menuitem', { name: 'Properties' }).click();
  await expect(page.getByRole('tab', { name: 'Properties' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const documentProperties = page.getByRole('tabpanel').last();
  await expect(
    documentProperties.getByRole('combobox', { name: 'Region' }),
  ).toHaveValue(assignedRegion);
  await page.screenshot({
    path: '../../.impeccable/review/database-document-properties.png',
    fullPage: true,
    animations: 'disabled',
  });
  await documentProperties
    .getByRole('combobox', { name: 'Region' })
    .selectOption('');
  await expect(documentProperties.getByText('Saving…')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Contacts.base' }).click();
  await expect(
    page.getByRole('heading', { name: /Unassigned \(1\)/ }),
  ).toBeVisible();
  await page
    .getByRole('combobox', { name: 'Move Ada to Region' })
    .selectOption({ label: 'Europe' });
  await expect(
    page.getByRole('heading', { name: /Europe \(2\)/ }),
  ).toBeVisible();
  await clickDatabaseAction(database, 'View settings');
  for (const layout of ['table', 'list', 'gallery']) {
    await page
      .getByRole('combobox', { name: 'Layout', exact: true })
      .selectOption(layout);
    await expect(
      page.getByRole('button', { name: 'Ada', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'European contact', exact: true }),
    ).toBeVisible();
  }
  await expect(
    page.locator('[class*="galleryPreview"]').first(),
  ).toBeVisible();
  await expect(
    page.locator('[class*="galleryPreview"]').first(),
  ).toContainText('Ada owns design notes');
  await page.getByRole('button', { name: 'Close view settings' }).click();
  await page.screenshot({
    path: '../../.impeccable/review/database-gallery-web.png',
    fullPage: true,
    animations: 'disabled',
  });
  await clickDatabaseAction(database, 'View settings');
  await page
    .getByRole('combobox', { name: 'Layout', exact: true })
    .selectOption('list');
  await page.getByRole('button', { name: 'Close view settings' }).click();
  await page.screenshot({
    path: '../../.impeccable/review/database-list-web.png',
    fullPage: true,
    animations: 'disabled',
  });
  await clickDatabaseAction(database, 'View settings');
  await page.getByRole('button', { name: 'Schema and templates', exact: true }).click();
  const propertyForm = page.locator('form').filter({
    has: page.getByRole('button', { name: 'Add property', exact: true }),
  });
  await propertyForm
    .getByRole('textbox', { name: 'Property name', exact: true })
    .fill('Meeting');
  await propertyForm
    .getByRole('combobox', { name: 'Type', exact: true })
    .selectOption('date');
  await propertyForm
    .getByRole('button', { name: 'Add property', exact: true })
    .click();
  await page
    .getByRole('combobox', { name: 'Date property', exact: true })
    .selectOption({ label: 'Meeting' });
  await page
    .getByRole('combobox', { name: 'Layout', exact: true })
    .selectOption('table');
  await page.getByRole('button', { name: 'Close view settings' }).click();
  await database
    .getByRole('combobox', { name: 'Region column options' })
    .selectOption('right');
  await expect(database.getByRole('columnheader').nth(2)).toContainText(
    'Meeting',
  );
  await database.getByRole('button', { name: 'Resize Meeting column' }).focus();
  await database
    .getByRole('button', { name: 'Resize Meeting column' })
    .press('ArrowRight');
  await expect(database.locator('colgroup col').nth(2)).toHaveAttribute(
    'style',
    /216px/,
  );
  await expect(database).toHaveAttribute('aria-busy', 'false');
  const resizeBox = await database
    .getByRole('button', { name: 'Resize Meeting column' })
    .boundingBox();
  expect(resizeBox).not.toBeNull();
  const point = {
    x: resizeBox!.x + resizeBox!.width / 2,
    y: resizeBox!.y + resizeBox!.height / 2,
  };
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 32, point.y);
  await page.mouse.up();
  await expect(database.locator('colgroup col').nth(2)).toHaveAttribute(
    'style',
    /248px/,
  );
  const adaRow = database.getByRole('row', { name: /Ada/ });
  await adaRow.getByRole('button', { name: 'Ada', exact: true }).focus();
  await adaRow
    .getByRole('button', { name: 'Ada', exact: true })
    .press('ArrowRight');
  const meetingCell = adaRow.getByRole('button', { name: /Edit Meeting:/ });
  await expect(meetingCell).toBeFocused();
  await meetingCell.press('Enter');
  await adaRow.getByLabel('Meeting', { exact: true }).press('Escape');
  await expect(meetingCell).toBeFocused();
  await page.screenshot({
    path: '../../.impeccable/review/database-columns-web.png',
    fullPage: true,
    animations: 'disabled',
  });
  await clickDatabaseAction(database, 'View settings');
  await page
    .getByRole('combobox', { name: 'Layout', exact: true })
    .selectOption('calendar');
  await page.getByRole('button', { name: 'Close view settings' }).click();
  await database.getByLabel('Schedule Ada', { exact: true }).fill('2026-09-10');
  await database
    .getByLabel('End date for Ada', { exact: true })
    .fill('2026-09-12');
  await page.screenshot({
    path: '../../.impeccable/review/database-calendar-web.png',
    fullPage: true,
    animations: 'disabled',
  });
  await clickDatabaseAction(database, 'View settings');
  await page
    .getByRole('combobox', { name: 'Layout', exact: true })
    .selectOption('timeline');
  await page.getByRole('button', { name: 'Close view settings' }).click();
  await expect(
    database.getByLabel('Ada: 2026-09-10 to 2026-09-12', { exact: true }),
  ).toBeVisible();
  await database.getByLabel('Schedule Ada', { exact: true }).fill('2026-09-15');
  await page.screenshot({
    path: '../../.impeccable/review/database-timeline-web.png',
    fullPage: true,
    animations: 'disabled',
  });
  await expect(
    database.getByLabel('End date for Ada', { exact: true }),
  ).toHaveValue('2026-09-17');
  await expect(database).toHaveAttribute('aria-busy', 'false');
  const indexHeader = () =>
    page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const vault = await root.getDirectoryHandle('Database acceptance');
      const internal = await vault.getDirectoryHandle('.froglight');
      const indexes = await internal.getDirectoryHandle('indexes');
      const file = await (
        await indexes.getFileHandle('database.sqlite')
      ).getFile();
      return new TextDecoder().decode((await file.arrayBuffer()).slice(0, 15));
    });
  await expect.poll(indexHeader).toBe('SQLite format 3');
  // Corrupt only the disposable cache; canonical definitions and sidecars stay intact.
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const vault = await root.getDirectoryHandle('Database acceptance');
    const internal = await vault.getDirectoryHandle('.froglight');
    const indexes = await internal.getDirectoryHandle('indexes');
    const output = await (
      await indexes.getFileHandle('database.sqlite')
    ).createWritable();
    await output.write('broken derived cache');
    await output.close();
  });
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await context.setOffline(true);
  await page.reload({ waitUntil: 'load' });
  await page
    .getByRole('button', {
      name: /^Database acceptance Browser private storage/,
    })
    .click();
  await page
    .getByRole('button', { name: 'Open quick switcher', exact: true })
    .click();
  await page.getByRole('dialog').getByRole('textbox').fill('Contacts');
  await page
    .getByRole('dialog')
    .getByRole('option', { name: /Contacts/ })
    .click();
  await expect(
    database.getByRole('heading', { name: 'Rename Contacts' }),
  ).toBeVisible();
  await expect(
    database.getByLabel('Schedule Ada', { exact: true }),
  ).toHaveValue('2026-09-15');
  await expect(
    database.getByLabel('End date for Ada', { exact: true }),
  ).toHaveValue('2026-09-17');
  await database.getByLabel('Schedule Ada', { exact: true }).fill('2026-09-20');
  await expect(
    database.getByLabel('End date for Ada', { exact: true }),
  ).toHaveValue('2026-09-22');
  await expect(database.getByLabel('Schedule Ada', { exact: true })).toBeEnabled();
  await expect(database.getByText('Could not save:', { exact: false })).toHaveCount(0);
  await expect(database).toHaveAttribute('aria-busy', 'false');
  await page.reload({ waitUntil: 'load' });
  await page
    .getByRole('button', {
      name: /^Database acceptance Browser private storage/,
    })
    .click();
  await page
    .getByRole('button', { name: 'Open quick switcher', exact: true })
    .click();
  await page.getByRole('dialog').getByRole('textbox').fill('Contacts');
  await page
    .getByRole('dialog')
    .getByRole('option', { name: /Contacts/ })
    .click();
  await expect(
    database.getByLabel('Schedule Ada', { exact: true }),
  ).toHaveValue('2026-09-20');
  await expect(
    database.getByLabel('End date for Ada', { exact: true }),
  ).toHaveValue('2026-09-22');
  await expect.poll(indexHeader).toBe('SQLite format 3');
  await clickDatabaseAction(database, 'View settings');
  await page
    .getByRole('combobox', { name: 'Layout', exact: true })
    .selectOption('table');
  await expect(page.getByRole('columnheader').nth(2)).toContainText(
    'Meeting',
  );
  await expect(page.locator('colgroup col').nth(2)).toHaveAttribute(
    'style',
    /248px/,
  );
  await page.getByRole('button', { name: 'Schema and templates', exact: true }).click();
  const creator = page.locator('form').filter({
    has: page.getByRole('button', { name: 'Add property', exact: true }),
  });
  await creator
    .getByRole('textbox', { name: 'Property name', exact: true })
    .fill('Score');
  await creator
    .getByRole('combobox', { name: 'Type', exact: true })
    .selectOption('formula');
  await creator
    .getByRole('textbox', { name: 'Formula expression', exact: true })
    .fill('1 / 0');
  await creator
    .getByRole('button', { name: 'Add property', exact: true })
    .click();
  await expect(
    page.getByText('Division by zero', { exact: true }).first(),
  ).toBeVisible();
  await page.getByText('Edit Score', { exact: true }).click();
  const formulaEditor = page.getByRole('dialog', { name: 'Edit Score' });
  await formulaEditor
    .getByRole('textbox', { name: 'Formula expression', exact: true })
    .fill('2 + 3');
  await formulaEditor
    .getByRole('button', { name: 'Save property', exact: true })
    .click();
  await expect(
    page.getByText('Division by zero', { exact: true }),
  ).toHaveCount(0);
  await clickDatabaseAction(database, 'View settings');
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('heading', { name: 'Documents in this database · Manual' }).click();
  await page
    .getByRole('button', { name: /Convert to smart collection/ })
    .click();
  await page.getByRole('heading', { name: /^Filters ·/ }).click();
  await page
    .getByRole('combobox', { name: 'Filter scope', exact: true })
    .selectOption('membership');
  await page
    .getByRole('combobox', { name: 'Filter property', exact: true })
    .selectOption('$kind');
  await page
    .getByRole('textbox', { name: 'Value', exact: true })
    .fill('froglight.blockpage');
  await page
    .getByRole('button', { name: 'Add filter', exact: true })
    .click();
  await page.getByRole('button', { name: 'Close view settings' }).click();
  await database.getByRole('button', { name: 'Add view' }).click();
  await page
    .getByRole('dialog', { name: 'Add view' })
    .getByRole('button', { name: 'Close add view' })
    .click();
  await expect(
    database.getByRole('button', { name: 'Ada', exact: true }),
  ).toBeVisible();
  await expect(
    database.getByRole('button', { name: 'European contact', exact: true }),
  ).toBeVisible();
  await expect(database.locator('footer')).toContainText('2 resources');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings
    .getByRole('option', { name: 'Appearance', exact: true })
    .click();
  await settings
    .getByRole('combobox', { name: 'Base theme' })
    .selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await settings.getByRole('button', { name: 'Close settings' }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const settingsDialog = database.getByRole('dialog', {
    name: 'View settings',
  });
  if (await settingsDialog.isVisible())
    await page.getByRole('button', { name: 'Close view settings' }).click();
  await page.screenshot({
    path: '../../.impeccable/review/database-dark-web.png',
    fullPage: true,
    animations: 'disabled',
  });
  const adaTab = page.getByRole('tab', { name: 'Ada.blockpage', exact: true });
  await database
    .getByRole('row', { name: /Ada/ })
    .getByRole('button', { name: 'Beside' })
    .click();
  await expect(database).toBeVisible();
  await expect(adaTab).toHaveCount(2);
  await expect(
    page.locator(
      'button[role="tab"][title="Ada.blockpage"][aria-selected="true"]',
    ),
  ).toHaveCount(1);
  await expect(page.locator('.flbp-host .ProseMirror')).toBeVisible();
  expect(errors).toEqual([]);
});
