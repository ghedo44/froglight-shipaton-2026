import type { Locator, Page } from '@playwright/test';

export async function openDocumentProperties(page: Page): Promise<void> {
  const propertiesTab = page.getByRole('tab', {
    name: 'Properties',
    exact: true,
  });
  if (!(await propertiesTab.isVisible())) {
    const sidebarToggle = page.getByRole('button', {
      name: 'Toggle document sidebar',
    });
    if ((await sidebarToggle.getAttribute('aria-expanded')) !== 'true') {
      await sidebarToggle.click();
    }
  }
  if (!(await propertiesTab.isVisible())) {
    const morePanels = page.getByRole('button', {
      name: 'More document panels',
    });
    if (await morePanels.isVisible()) {
      await morePanels.click();
      await page
        .getByRole('menu', { name: 'More document panels' })
        .getByRole('menuitem', { name: 'Properties', exact: true })
        .click();
    }
  }
  await propertiesTab.click();
}

export async function clickDatabaseAction(
  database: Locator,
  action: string,
): Promise<void> {
  await database.getByRole('button', { name: 'More database actions' }).click();
  const menuLabel =
    action === 'Add existing' ? 'Add existing document' : action;
  await database.getByRole('button', { name: menuLabel, exact: true }).click();
}
