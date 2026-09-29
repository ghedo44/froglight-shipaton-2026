import { setDocumentPresentation } from './support/document-presentation.js';
import { createFromSidebar } from './support/sidebar-create.js';
import { expect, test } from '@playwright/test';

test('right-click uses Froglight menus in app space', async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: undefined,
      configurable: true,
    }),
  );
  await page.goto('/');

  const rightClickPrevented = async (selector: string): Promise<boolean> => {
    const target = page.locator(selector).first();
    await page.evaluate(() => {
      const state = window as Window & { lastContextPrevented?: boolean };
      delete state.lastContextPrevented;
      document.addEventListener(
        'contextmenu',
        (event) => {
          state.lastContextPrevented = event.defaultPrevented;
        },
        { once: true },
      );
    });
    await target.click({ button: 'right' });
    return page.evaluate(
      () =>
        (window as Window & { lastContextPrevented?: boolean })
          .lastContextPrevented ?? false,
    );
  };

  expect(await rightClickPrevented('body')).toBe(true);
  await expect(page.getByRole('menu')).toHaveCount(0);

  await page.getByTestId('create-vault-button').click();
  const vaultName = page.getByTestId('create-vault-name-input');
  expect(
    await rightClickPrevented('[data-testid="create-vault-name-input"]'),
  ).toBe(false);
  await vaultName.fill('Context menu');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();

  await expect(
    page.locator('.froglight-markdown-editor .cm-content'),
  ).toBeVisible();
  expect(
    await rightClickPrevented('.froglight-markdown-editor .cm-content'),
  ).toBe(true);
  await expect(page.getByRole('menu')).toHaveCount(0);

  const create = page.getByRole('dialog', { name: 'Create a new note' });
  for (const [kind, name] of [
    ['Ink page', 'Canvas'],
    ['Notebook', 'Pages'],
    ['Whiteboard', 'Board'],
  ]) {
    await createFromSidebar(page, kind);
    await create.getByRole('textbox', { name: 'Note name' }).fill(name);
    await create.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.locator('.fl-ink-canvas').first()).toBeVisible();
    expect(await rightClickPrevented('.fl-ink-canvas')).toBe(true);
    await expect(page.getByRole('menu')).toHaveCount(0);
  }

  expect(await rightClickPrevented('[data-fl-component="titlebar"]')).toBe(
    true,
  );
  await expect(page.getByRole('menu')).toHaveCount(0);

  await createFromSidebar(page, 'LaTeX');
  await create.getByRole('textbox', { name: 'Note name' }).fill('Formula');
  await create.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(
    page.locator('.froglight-latex-source .cm-content'),
  ).toBeVisible();
  expect(await rightClickPrevented('.froglight-latex-source .cm-content')).toBe(
    true,
  );
  await expect(page.getByRole('menu')).toHaveCount(0);

  await setDocumentPresentation(page, 'View');
  const preview = page
    .frameLocator('iframe.froglight-latex-frame')
    .locator('body');
  await expect(preview).toBeVisible();
  await page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>(
      'iframe.froglight-latex-frame',
    )!;
    const result = window as Window & { previewMenuPrevented?: boolean };
    const attach = () => {
      frame.contentDocument?.addEventListener('contextmenu', (event) => {
        result.previewMenuPrevented = event.defaultPrevented;
      });
    };
    frame.addEventListener('load', attach);
    attach();
  });
  await preview.click({ button: 'right' });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as Window & { previewMenuPrevented?: boolean })
            .previewMenuPrevented,
      ),
    )
    .toBe(true);
});
