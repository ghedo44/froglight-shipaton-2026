import { expect, test } from '@playwright/test';
import { createFromSidebar } from './support/sidebar-create.js';

test.use({ hasTouch: true });

test('mounted writing toolbars show icons with accessible command names', async ({
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
  await page.getByTestId('create-vault-name-input').fill('Toolbar icons');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();

  for (const kind of ['Markdown', 'Block page'] as const) {
    await createFromSidebar(page, kind);
    const dialog = page.getByRole('dialog', { name: 'Create a new note' });
    await dialog
      .getByRole('textbox', { name: 'Note name' })
      .fill(`${kind} tools`);
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    const pane = page.locator('[data-pane="main"]');
    const strip = pane.getByRole('toolbar', {
      name: 'Document tool categories',
    });
    const insert = strip.getByRole('button', { name: 'Insert', exact: true });
    await expect(insert.locator('svg')).toBeVisible();
    expect(await insert.textContent()).toBe('');
    await insert.click();
    const commands =
      kind === 'Markdown'
        ? [
            ['Table', 'table'],
            ['Divider', 'divider'],
          ]
        : [
            ['Insert table', 'table'],
            ['Insert image', 'image'],
            ['Insert video', 'file-video'],
            ['Insert audio', 'file-audio'],
            ['Insert file', 'file-plus'],
            ['Insert math', 'math'],
            ['Insert diagram', 'diagram'],
            ['Insert columns', 'columns'],
          ];
    for (const [label, icon] of commands) {
      const command = pane.getByRole('button', { name: label, exact: true });
      await expect(command).toBeVisible();
      await expect(command.locator(`svg.icon-${icon}`)).toBeVisible();
      expect(await command.textContent()).toBe('');
    }
  }

  await page.setViewportSize({ width: 390, height: 844 });
  const strip = page.locator(
    '[data-pane="main"] [data-toolbar="category-strip"]',
  );
  await expect(strip).toHaveAttribute('data-compact', 'true');
  const visible = await strip.evaluate((element) =>
    [...element.querySelectorAll('button')]
      .filter((button) => button.getBoundingClientRect().width > 0)
      .map((button) => ({
        name: button.getAttribute('aria-label'),
        width: button.getBoundingClientRect().width,
        height: button.getBoundingClientRect().height,
        icon: button.querySelector('svg') !== null,
      })),
  );
  expect(
    visible.some(
      (button) =>
        button.name === 'Insert' || button.name === 'More tool categories',
    ),
  ).toBe(true);
  expect(
    visible.every(
      (button) => button.icon && button.width >= 44 && button.height >= 44,
    ),
  ).toBe(true);
});
