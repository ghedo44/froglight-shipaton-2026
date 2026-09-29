import { expect, type Page } from '@playwright/test';

/** Open the sidebar's document picker and select a kind. */
export async function createFromSidebar(
  page: Page,
  kind: string | RegExp = 'Markdown',
): Promise<void> {
  const sidebar = page.getByRole('complementary', {
    name: 'Sidebar',
    exact: true,
  });
  const newButton = sidebar.getByRole('button', { name: 'New', exact: true });
  const toggle = page.getByRole('button', {
    name: /^(Toggle|Open) sidebar$/,
  });
  const workspace = page.locator('[data-fl-component="workspace"]');
  await expect(workspace).toBeVisible();
  await expect(workspace).toHaveAttribute(
    'data-layout',
    page.viewportSize()!.width < 761
      ? 'compact'
      : page.viewportSize()!.width < 1180
        ? 'medium'
        : 'wide',
  );
  await expect(workspace).not.toHaveClass(/sidebar-switching/);
  if (!(await newButton.isVisible())) {
    await toggle.click();
  }
  await expect(newButton).toBeVisible();
  await newButton.click();
  await page.getByRole('menuitem', { name: 'New document' }).click();
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('radio', { name: kind })
    .click();
}
