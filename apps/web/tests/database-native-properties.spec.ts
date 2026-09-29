import { createFromSidebar } from './support/sidebar-create.js';
import {
  clickDatabaseAction,
  openDocumentProperties,
} from './support/database-actions.js';
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

test('Markdown property edits stay in visible source and database views', async ({
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
    .fill('Native property acceptance');
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
    .fill('Status');
  await page
    .getByRole('combobox', { name: 'Type', exact: true })
    .selectOption('select');
  await page
    .getByRole('dialog', { name: 'View settings' })
    .getByRole('button', { name: 'Add property', exact: true })
    .click();
  for (const option of ['Todo', 'Doing', 'Done']) {
    await page
      .getByRole('textbox', { name: 'New option for Status' })
      .fill(option);
    await page
      .getByRole('button', { name: 'Add option', exact: true })
      .click();
  }
  await page.getByRole('button', { name: 'Close view settings' }).click();
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
  await expect(page.getByTestId('document-properties')).toHaveCount(0);
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('Body draft');
  await expect(page.locator('.cm-content')).toContainText('Body draft');
  await openDocumentProperties(page);
  const inspector = page.getByRole('tabpanel', { name: 'Properties' });
  await inspector
    .getByRole('combobox', { name: 'Status' })
    .selectOption({ label: 'Doing' });
  await expect(page.locator('.cm-content')).toContainText('status: doing');
  const readBytes = async () =>
    page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const files: { path: string; text: string }[] = [];
      async function visit(dir: FileSystemDirectoryHandle, prefix = '') {
        for await (const [name, handle] of dir.entries()) {
          const path = `${prefix}${name}`;
          if (handle.kind === 'directory') await visit(handle, `${path}/`);
          else if (
            name === 'Paper.md' ||
            path.includes('.froglight/properties/')
          ) {
            try {
              files.push({ path, text: await (await handle.getFile()).text() });
            } catch (error) {
              if (
                !(
                  error instanceof DOMException &&
                  error.name === 'NotReadableError'
                )
              )
                throw error;
            }
          }
        }
      }
      await visit(root);
      return files;
    });
  await expect
    .poll(
      async () =>
        (await readBytes()).find((file) => file.path.endsWith('Paper.md'))
          ?.text,
    )
    .toContain('status: doing');
  const bytes = await readBytes();
  expect(bytes.find((file) => file.path.endsWith('Paper.md'))?.text).toContain(
    'status: doing',
  );
  expect(bytes.find((file) => file.path.endsWith('Paper.md'))?.text).toContain(
    'Body draft',
  );
  expect(
    bytes.some((file) => file.path.includes('.froglight/properties/')),
  ).toBe(false);
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+a');
  await page.keyboard.insertText('---\nstatus: done\n---\n# Paper\n');
  await expect(page.locator('.cm-content')).toContainText('status: done');
  await page.keyboard.press('Control+s');
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible();
  await expect(inspector.getByRole('combobox', { name: 'Status' })).toHaveValue(
    'done',
  );
  await page.getByRole('tab', { name: 'Research.base' }).click();
  await expect(database.getByRole('row', { name: /Paper/ })).toContainText(
    'Done',
  );
  await clickDatabaseAction(database, 'View settings');
  await page
    .getByRole('combobox', { name: 'Group by' })
    .selectOption({ label: 'Status' });
  await page
    .getByRole('combobox', { name: 'Layout' })
    .selectOption('board');
  await page.getByRole('button', { name: 'Close view settings' }).click();
  await expect(
    database.getByRole('heading', { name: /done \(1\)/i }),
  ).toBeVisible();
  await database
    .getByRole('combobox', { name: 'Move Paper to Status' })
    .selectOption({ label: 'Doing' });
  await expect(
    database.getByRole('heading', { name: /doing \(1\)/i }),
  ).toBeVisible();
  await expect
    .poll(
      async () =>
        (await readBytes()).find((file) => file.path.endsWith('Paper.md'))
          ?.text,
    )
    .toContain('status: doing');
  await database
    .getByRole('combobox', { name: 'Move Paper to Status' })
    .selectOption({ label: 'Done' });
  await expect(
    database.getByRole('heading', { name: /done \(1\)/i }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Native property acceptance vault options' })
    .click();
  await page.getByText('Close vault', { exact: true }).click();
  await expect(page.getByTestId('create-vault-button')).toBeVisible();
  await page.getByTestId('open-recent-vault-button-0').click();
  await page.getByRole('tab', { name: 'Research.base' }).click();
  await expect(
    page
      .getByRole('region', { name: 'Research', exact: true })
      .getByRole('heading', { name: /done \(1\)/i }),
  ).toBeVisible();
});

test('structured document properties survive editor and vault reopen', async ({
  page,
}) => {
  test.setTimeout(90_000);
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
    .fill('Structured property acceptance');
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
    .fill('Status');
  await page
    .getByRole('dialog', { name: 'View settings' })
    .getByRole('button', { name: 'Add property', exact: true })
    .click();
  await page.getByRole('button', { name: 'Close view settings' }).click();
  const readSource = async (name: string) =>
    page.evaluate(async (filename) => {
      const root = await navigator.storage.getDirectory();
      async function find(
        dir: FileSystemDirectoryHandle,
      ): Promise<string | null> {
        for await (const [entry, handle] of dir.entries()) {
          if (handle.kind === 'directory') {
            const found = await find(handle);
            if (found !== null) return found;
          } else if (entry === filename) {
            try {
              return await (await handle.getFile()).text();
            } catch (error) {
              if (
                error instanceof DOMException &&
                error.name === 'NotReadableError'
              )
                return null;
              throw error;
            }
          }
        }
        return null;
      }
      return find(root);
    }, name);
  for (const [label, extension] of [
    ['Block page', 'blockpage'],
    ['Notebook', 'notebook'],
    ['Ink page', 'ink'],
    ['Whiteboard', 'whiteboard'],
  ] as const) {
    await database
      .getByRole('button', { name: 'New item', exact: true })
      .click();
    await page
      .getByRole('dialog', { name: 'Create a new note' })
      .getByRole('textbox', { name: 'Note name' })
      .fill(label.replace(' ', ''));
    await page
      .getByRole('dialog', { name: 'Create a new note' })
      .getByRole('radio', { name: label })
      .click();
    await page
      .getByRole('dialog', { name: 'Create a new note' })
      .getByRole('button', { name: 'Create', exact: true })
      .click();
    const name = `${label.replace(' ', '')}.${extension}`;
    await expect(page.getByRole('tab', { name })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByTestId('document-properties')).toHaveCount(0);
    await openDocumentProperties(page);
    const inspector = page.getByRole('tabpanel', { name: 'Properties' });
    await inspector.getByRole('textbox', { name: 'Status' }).fill('doing');
    await inspector.getByRole('textbox', { name: 'Status' }).press('Tab');
    await expect.poll(() => readSource(name)).toContain('doing');
    const source = await readSource(name);
    expect(source).toContain('properties');
    expect(source).toContain('doing');
    await page.getByRole('tab', { name: 'Research.base' }).click();
    await expect(
      database.getByRole('row', { name: new RegExp(label.replace(' ', '')) }),
    ).toContainText('doing');
  }
  await database.getByRole('button', { name: 'New item', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('textbox', { name: 'Note name' })
    .fill('Formula');
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('radio', { name: 'LaTeX' })
    .click();
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  await expect(page.getByRole('tab', { name: 'Formula.tex' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const latexBefore = await readSource('Formula.tex');
  await openDocumentProperties(page);
  const inspector = page.getByRole('tabpanel', { name: 'Properties' });
  await inspector.getByRole('textbox', { name: 'Status' }).fill('sidecar');
  await inspector.getByRole('textbox', { name: 'Status' }).press('Tab');
  await page.getByRole('tab', { name: 'Research.base' }).click();
  await expect(database.getByRole('row', { name: /Formula/ })).toContainText(
    'sidecar',
  );
  expect(await readSource('Formula.tex')).toBe(latexBefore);
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        async function find(
          dir: FileSystemDirectoryHandle,
          prefix = '',
        ): Promise<boolean> {
          for await (const [name, handle] of dir.entries()) {
            const path = `${prefix}${name}`;
            if (handle.kind === 'directory') {
              if (await find(handle, `${path}/`)) return true;
            } else if (
              path.includes('.froglight/properties/') &&
              (await (await handle.getFile()).text()).includes('sidecar')
            )
              return true;
          }
          return false;
        }
        return find(root);
      }),
    )
    .toBe(true);
  const pdfBytes = Array.from(
    readFileSync(new URL('./fixtures/three-page-source.pdf', import.meta.url)),
  );
  const transfer = await page.evaluateHandle((bytes) => {
    const data = new DataTransfer();
    data.items.add(
      new File([new Uint8Array(bytes)], 'Source.pdf', {
        type: 'application/pdf',
      }),
    );
    return data;
  }, pdfBytes);
  await page
    .getByTestId('file-explorer')
    .locator('[class*="explorer-tree"]')
    .dispatchEvent('drop', { dataTransfer: transfer });
  await expect(
    page.getByTestId('file-explorer').getByText('Source.pdf'),
  ).toBeVisible();
  const pdfBefore = await readSource('Source.pdf');
  await clickDatabaseAction(database, 'Add existing');
  const picker = page.getByRole('dialog', { name: 'Add existing document' });
  await picker.getByRole('textbox').fill('Source.pdf');
  await picker.getByRole('option', { name: /Source.pdf/ }).click();
  await database
    .getByRole('button', { name: 'Source.pdf', exact: true })
    .click();
  await openDocumentProperties(page);
  await inspector.getByRole('textbox', { name: 'Status' }).fill('pdf-sidecar');
  await inspector.getByRole('textbox', { name: 'Status' }).press('Tab');
  await page.getByRole('tab', { name: 'Research.base' }).click();
  await expect(database.getByRole('row', { name: /Source/ })).toContainText(
    'pdf-sidecar',
  );
  expect(await readSource('Source.pdf')).toBe(pdfBefore);
  await page
    .getByRole('button', {
      name: 'Structured property acceptance vault options',
    })
    .click();
  await page.getByText('Close vault', { exact: true }).click();
  await page.getByTestId('open-recent-vault-button-0').click();
  await page.getByRole('tab', { name: 'Research.base' }).click();
  for (const label of ['Blockpage', 'Notebook', 'Inkpage', 'Whiteboard'])
    await expect(
      page
        .getByRole('region', { name: 'Research', exact: true })
        .getByRole('row', { name: new RegExp(label) }),
    ).toContainText('doing');
  await expect(
    page
      .getByRole('region', { name: 'Research', exact: true })
      .getByRole('row', { name: /Formula/ }),
  ).toContainText('sidecar');
  await expect(
    page
      .getByRole('region', { name: 'Research', exact: true })
      .getByRole('row', { name: /Source/ }),
  ).toContainText('pdf-sidecar');
});
