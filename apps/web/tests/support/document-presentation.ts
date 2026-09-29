import { expect, type Page } from '@playwright/test';

/** Operate the presentation control at either pane width. */
export async function setDocumentPresentation(
  page: Page,
  label: 'Edit' | 'Split' | 'View',
  options: { readonly stationary?: boolean } = {},
): Promise<void> {
  const radio = page
    .getByRole('radiogroup', { name: 'Document view' })
    .getByRole('radio', { name: label, exact: true });
  if (await radio.isVisible()) {
    if (options.stationary)
      await radio.evaluate((element: HTMLButtonElement) => element.click());
    else await radio.click();
    await expect(radio).toBeChecked();
    return;
  }
  const trigger = page.getByRole('button', { name: /^Document view:/ });
  if (options.stationary)
    await trigger.evaluate((element: HTMLButtonElement) => element.click());
  else await trigger.click();
  const item = page.getByRole('menuitemradio', { name: label, exact: true });
  if (options.stationary)
    await item.evaluate((element: HTMLButtonElement) => element.click());
  else await item.click();
  await expect(trigger).toHaveAttribute(
    'aria-label',
    `Document view: ${label}`,
  );
}
