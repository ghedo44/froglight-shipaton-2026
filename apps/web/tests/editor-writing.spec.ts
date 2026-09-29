import { createFromSidebar } from './support/sidebar-create.js';
import { expect, test } from '@playwright/test';

test('Markdown writing suggestions and LaTeX environment pairing work in a disposable vault', async ({
  page,
}) => {
  const clickInsertTool = async (name: string) => {
    const action = page.getByRole('button', { name, exact: true });
    if (!(await action.isVisible()))
      await page
        .getByRole('toolbar', { name: 'Insert tools' })
        .getByRole('button', { name: 'More tools' })
        .click();
    await action.click();
  };
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: undefined,
      configurable: true,
    });
  });
  await page.goto('/');
  await page.getByTestId('create-vault-button').click();
  await page.getByTestId('create-vault-name-input').fill('Writing editors');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();
  await expect(
    page.getByRole('tab', { name: /welcome\.md/ }).first(),
  ).toBeVisible();

  await createFromSidebar(page);
  await page.getByRole('textbox', { name: 'Note name' }).fill('Destination');
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  await expect(
    page.getByRole('tab', { name: 'Destination.md', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  const destinationEditor = page.locator(
    '.froglight-markdown-editor .cm-content',
  );
  await expect(destinationEditor).toContainText('# Destination');
  await destinationEditor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Embedded body one');
  await page.keyboard.press('Control+s');
  await createFromSidebar(page);
  await page.getByRole('textbox', { name: 'Note name' }).fill('Source');
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  const markdown = page.locator('.froglight-markdown-editor .cm-content');
  await expect(
    page.getByRole('tab', { name: 'Source.md', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(markdown).toContainText('# Source');
  await page.getByRole('button', { name: 'Style', exact: true }).click();
  await expect(
    page.getByRole('combobox', { name: 'Line style' }).locator('option'),
  ).toHaveCount(6);
  await page
    .getByRole('toolbar', { name: 'Style tools' })
    .getByRole('button', { name: 'More tools' })
    .click();
  await expect(
    page.getByRole('button', { name: 'Numbered list' }),
  ).toBeVisible();
  await markdown.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('[[Dest');
  await expect(page.locator('.cm-tooltip-autocomplete')).toContainText(
    'Destination',
  );
  await page
    .locator('.cm-tooltip-autocomplete li')
    .filter({ hasText: 'Destination.md' })
    .click();
  await expect(markdown).toContainText('[[Destination.md]]');
  await page.getByRole('button', { name: 'Insert', exact: true }).click();
  await clickInsertTool('Link note');
  await page.keyboard.type('Dest');
  await expect(page.locator('.cm-tooltip-autocomplete')).toContainText(
    'Destination',
  );
  await page
    .locator('.cm-tooltip-autocomplete li')
    .filter({ hasText: 'Destination.md' })
    .click();
  await expect(markdown).toContainText('[[Destination.md]][[Destination.md]]');
  await clickInsertTool('Table');
  const tableMenu = page.getByRole('dialog', { name: 'Insert table' });
  await tableMenu.getByRole('spinbutton', { name: 'Columns' }).fill('4');
  await tableMenu.getByRole('spinbutton', { name: 'Rows' }).fill('2');
  await expect(
    tableMenu.getByRole('checkbox', { name: 'Header labels' }),
  ).toBeChecked();
  await tableMenu.getByRole('checkbox', { name: 'Header labels' }).uncheck();
  await expect(
    tableMenu.getByRole('checkbox', { name: 'Header labels' }),
  ).not.toBeChecked();
  await tableMenu.getByRole('checkbox', { name: 'Header labels' }).check();
  await tableMenu.getByRole('button', { name: 'Insert', exact: true }).click();
  await expect(markdown).toContainText(
    '| Column 1 | Column 2 | Column 3 | Column 4 |',
  );
  await markdown.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('![[Dest');
  await expect(page.locator('.cm-tooltip-autocomplete')).toContainText(
    'Destination',
  );
  await page
    .locator('.cm-tooltip-autocomplete li')
    .filter({ hasText: 'Destination.md' })
    .click();
  await expect(markdown).toContainText('![[Destination.md]]');
  await page.keyboard.press('Control+s');
  await page.getByRole('button', { name: 'View', exact: true }).click();
  await expect(page.locator('.fl-markdown-reader .md-embed')).toContainText(
    'Embedded body one',
  );

  await page.getByRole('tab', { name: 'Destination.md', exact: true }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await destinationEditor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Embedded body two');
  await page.keyboard.press('Control+s');
  await page.getByRole('tab', { name: 'Source.md', exact: true }).click();
  await page.getByRole('button', { name: 'View', exact: true }).click();
  await expect(page.locator('.fl-markdown-reader .md-embed')).toContainText(
    'Embedded body two',
  );

  const imageBytes = Array.from(
    Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9pHhwAAAAASUVORK5CYII=',
      ),
      (character) => character.charCodeAt(0),
    ),
  );
  const transfer = await page.evaluateHandle((bytes) => {
    const data = new DataTransfer();
    data.items.add(
      new File([new Uint8Array(bytes)], 'Pixel.png', { type: 'image/png' }),
    );
    return data;
  }, imageBytes);
  await page
    .getByTestId('file-explorer')
    .locator('[class*="explorer-tree"]')
    .dispatchEvent('drop', { dataTransfer: transfer });
  await expect(
    page.getByTestId('file-explorer').getByText('Pixel.png'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await markdown.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Insert', exact: true }).click();
  await clickInsertTool('Embed file');
  await page.keyboard.type('Pix');
  await expect(page.locator('.cm-tooltip-autocomplete')).toContainText(
    'Pixel.png',
  );
  await page
    .locator('.cm-tooltip-autocomplete li')
    .filter({ hasText: 'Pixel.png' })
    .click();
  await expect(markdown).toContainText('![[Pixel.png]]');
  await page.getByRole('button', { name: 'View', exact: true }).click();
  const embeddedImage = page.locator(
    '.fl-markdown-reader .md-embed img[alt="Pixel.png"]',
  );
  await expect(embeddedImage).toBeVisible();
  await expect
    .poll(() =>
      embeddedImage.evaluate(
        (image) => (image as HTMLImageElement).naturalWidth,
      ),
    )
    .toBe(1);

  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await markdown.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Insert', exact: true }).click();
  const firstImageChooser = page.waitForEvent('filechooser');
  await clickInsertTool('Import image');
  await (
    await firstImageChooser
  ).setFiles({
    name: 'Imported.png',
    mimeType: 'image/png',
    buffer: Buffer.from(imageBytes),
  });
  await expect(markdown).toContainText('![[Imported.png]]');
  const secondImageChooser = page.waitForEvent('filechooser');
  await clickInsertTool('Import image');
  await (
    await secondImageChooser
  ).setFiles({
    name: 'Imported.png',
    mimeType: 'image/png',
    buffer: Buffer.from(imageBytes),
  });
  await expect(markdown).toContainText('![[Imported (1).png]]');
  await page.getByRole('button', { name: 'View', exact: true }).click();
  await expect(
    page.locator('.fl-markdown-reader .md-embed img[alt="Imported.png"]'),
  ).toBeVisible();

  await createFromSidebar(page, 'LaTeX');
  await page.getByRole('textbox', { name: 'Note name' }).fill('Formula');
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  const latex = page.locator('.froglight-latex-source .cm-content');
  await expect(
    page.getByRole('tab', { name: 'Formula.tex', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await page
    .locator('.froglight-latex-source .cm-line')
    .filter({ hasText: '\\section{Formula}' })
    .click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('\\begin{itemize}');
  await page.keyboard.press('Enter');
  await expect(latex).toContainText('\\end{itemize}');
  await page.getByRole('button', { name: 'Insert', exact: true }).click();
  await clickInsertTool('Quotation');
  await expect(latex).toContainText('\\begin{quote}');
  expect(
    await latex.evaluate((node) => getComputedStyle(node).maxWidth),
  ).not.toBe('none');
});
