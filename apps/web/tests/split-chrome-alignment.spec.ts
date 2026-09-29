import { expect, test } from '@playwright/test';
import { createFromSidebar } from './support/sidebar-create.js';

test('split tab and toolbar boundaries align with the pane divider', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: undefined,
      configurable: true,
    });
  });
  await page.goto('/');
  await page.getByTestId('create-vault-button').click();
  await page.getByTestId('create-vault-name-input').fill('Split chrome');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();
  await page
    .getByRole('tab', { name: 'welcome.md' })
    .click({ button: 'right' });
  await page
    .getByRole('menuitem', { name: 'Split right', exact: true })
    .click();
  await expect(page.locator('[data-pane]')).toHaveCount(2);
  await createFromSidebar(page, 'Markdown');
  await page.getByRole('textbox', { name: 'Note name' }).fill('Second');
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  await expect(
    page.locator('[data-pane="pane-2"] [data-fl-component="document-toolbar"]'),
  ).toBeVisible();

  const measure = () =>
    page.evaluate(() => {
      const element = (selector: string) => {
        const found = document.querySelector<HTMLElement>(selector);
        if (!found) throw new Error(`Missing ${selector}`);
        return found;
      };
      const rect = (selector: string) =>
        element(selector).getBoundingClientRect();
      const strip = rect('[data-strip-pane="main"]');
      const stripDivider = rect('[class*="fl-strip-divider"]');
      const paneDivider = rect(
        '[role="separator"][aria-label="Resize pane divider"]',
      );
      const leftToolbar = rect(
        '[data-pane="main"] [data-fl-component="document-toolbar"]',
      );
      const rightToolbar = rect(
        '[data-pane="pane-2"] [data-fl-component="document-toolbar"]',
      );
      return {
        stripRight: strip.right,
        stripDividerLeft: stripDivider.left,
        paneDividerLeft: paneDivider.left,
        leftToolbarRight: leftToolbar.right,
        rightToolbarLeft: rightToolbar.left,
        stripDividerBackground: getComputedStyle(
          element('[class*="fl-strip-divider"]'),
        ).backgroundColor,
        toolbarBackground: getComputedStyle(
          element('[data-pane="main"] [data-fl-component="document-toolbar"]'),
        ).backgroundColor,
        paneDividerBackground: getComputedStyle(
          element('[role="separator"][aria-label="Resize pane divider"]'),
        ).backgroundImage,
      };
    });
  const assertAligned = async () => {
    const geometry = await measure();
    expect(geometry.stripRight).toBeCloseTo(geometry.paneDividerLeft, 0);
    expect(geometry.stripDividerLeft).toBeCloseTo(geometry.paneDividerLeft, 0);
    expect(geometry.leftToolbarRight).toBeCloseTo(geometry.paneDividerLeft, 0);
    expect(geometry.rightToolbarLeft).toBeCloseTo(
      geometry.paneDividerLeft + 9,
      0,
    );
    expect(geometry.stripDividerBackground).toBe(geometry.toolbarBackground);
    expect(geometry.paneDividerBackground).toContain(
      geometry.toolbarBackground,
    );
  };
  await assertAligned();
  await page.setViewportSize({ width: 1024, height: 800 });
  await assertAligned();
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.getByRole('button', { name: 'Toggle document sidebar' }).click();
  await expect
    .poll(async () => {
      const geometry = await measure();
      return Math.abs(geometry.stripRight - geometry.paneDividerLeft);
    })
    .toBeLessThan(0.5);
  await assertAligned();
  await page.screenshot({ path: test.info().outputPath('split-chrome.png') });
});
