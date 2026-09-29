import { expect, test } from '@playwright/test';

interface LifecycleReport {
  ready: boolean;
  error?: string;
  provider: 'active' | 'withdrawn';
  activations: number;
  disposals: number;
  documentRegistryChanges: number;
  propertyCatalogChanges: number;
  propertyWriteCallbacks: number;
  bytesBeforeWithdrawal: readonly number[];
  bytesAfterReactivation: readonly number[];
  databaseBytesBeforeWithdrawal: readonly number[];
  databaseBytesAfterReactivation: readonly number[];
  propertyBytesBeforeWithdrawal: readonly number[];
  propertyBytesAfterReactivation: readonly number[];
  membershipPreserved: boolean;
  propertyConfigurationPreserved: boolean;
  templateConfigurationPreserved: boolean;
  kindRegistrations: number;
  propertyTypeRegistrations: number;
}

test('independent database extensions withdraw and reactivate without data loss or duplicate callbacks', async ({
  page,
}) => {
  await page.goto('/bench/database-plugin-lifecycle.html');
  await expect
    .poll(() =>
      page.evaluate(
        () => window.__froglightPluginDatabaseLifecycle?.ready ?? false,
      ),
    )
    .toBe(true);
  const initial = await page.evaluate(
    () => window.__froglightPluginDatabaseLifecycle as LifecycleReport,
  );
  expect(initial.error).toBeUndefined();
  expect(initial.provider).toBe('active');
  expect(initial.activations).toBe(1);
  expect(initial.kindRegistrations).toBe(1);
  expect(initial.propertyTypeRegistrations).toBe(1);
  await page.getByRole('button', { name: 'Edit Quality: 4' }).click();
  await expect(page.getByRole('spinbutton', { name: 'Quality' })).toHaveValue(
    '4',
  );
  await page.getByRole('spinbutton', { name: 'Quality' }).press('Escape');

  await page.getByRole('button', { name: 'Disable provider' }).click();
  await expect(page.getByTestId('provider-state')).toHaveText('withdrawn');
  await expect(page.getByTestId('document-action-state')).toContainText(
    'provider unavailable',
  );
  await expect(page.getByRole('spinbutton', { name: 'Quality' })).toHaveCount(
    0,
  );
  await expect(
    page.getByText('Property provider unavailable: acme.research.rating'),
  ).toBeVisible();
  const withdrawn = await page.evaluate(
    () => window.__froglightPluginDatabaseLifecycle as LifecycleReport,
  );
  expect(withdrawn.activations).toBe(1);
  expect(withdrawn.disposals).toBe(1);
  expect(withdrawn.kindRegistrations).toBe(0);
  expect(withdrawn.propertyTypeRegistrations).toBe(0);
  expect(withdrawn.propertyWriteCallbacks).toBe(0);

  await page.getByRole('button', { name: 'Re-enable provider' }).click();
  await expect(page.getByTestId('provider-state')).toHaveText('active');
  await page.getByRole('button', { name: 'Edit Quality: 4' }).click();
  await expect(page.getByRole('spinbutton', { name: 'Quality' })).toHaveValue(
    '4',
  );
  const reactivated = await page.evaluate(
    () => window.__froglightPluginDatabaseLifecycle as LifecycleReport,
  );
  expect(reactivated.activations).toBe(2);
  expect(reactivated.disposals).toBe(1);
  expect(reactivated.kindRegistrations).toBe(1);
  expect(reactivated.propertyTypeRegistrations).toBe(1);
  expect(reactivated.documentRegistryChanges).toBe(3);
  expect(reactivated.propertyCatalogChanges).toBe(3);
  expect(reactivated.bytesAfterReactivation).toEqual(
    reactivated.bytesBeforeWithdrawal,
  );
  expect(reactivated.databaseBytesAfterReactivation).toEqual(
    reactivated.databaseBytesBeforeWithdrawal,
  );
  expect(reactivated.propertyBytesAfterReactivation).toEqual(
    reactivated.propertyBytesBeforeWithdrawal,
  );
  expect(reactivated.membershipPreserved).toBe(true);
  expect(reactivated.propertyConfigurationPreserved).toBe(true);
  expect(reactivated.templateConfigurationPreserved).toBe(true);

  const editor = page.getByRole('spinbutton', { name: 'Quality' });
  await editor.fill('5');
  await editor.press('Tab');
  await expect(
    page.getByRole('button', { name: 'Edit Quality: 5' }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__froglightPluginDatabaseLifecycle?.propertyWriteCallbacks ??
          -1,
      ),
    )
    .toBe(1);
});

declare global {
  interface Window {
    __froglightPluginDatabaseLifecycle?: LifecycleReport;
  }
}
