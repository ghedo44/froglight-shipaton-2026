import { expect, test } from '@playwright/test';
import { createFromSidebar } from './support/sidebar-create.js';

declare global {
  interface Window {
    backgroundSaveGate: { entered: boolean; release(fail: boolean): void };
    unavailableDocumentNoticeSeen: boolean;
  }
}

for (const fail of [false, true]) {
  test(`switches during a delayed save and preserves edits after ${fail ? 'failure' : 'success'}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: fail ? 390 : 1280, height: 900 });
    await page.addInitScript(() => Object.defineProperty(window, 'showDirectoryPicker', {
      value: undefined, configurable: true,
    }));
    await page.goto('/');
    await page.getByTestId('create-vault-button').click();
    await page.getByTestId('create-vault-name-input').fill('Background saves');
    await page.getByTestId('choose-vault-location-button').click();
    await page.getByTestId('confirm-create-vault-button').click();
    await createFromSidebar(page);
    await page.getByRole('textbox', { name: 'Note name' }).fill('Slow');
    await page.getByRole('dialog', { name: 'Create a new note' })
      .getByRole('button', { name: 'Create', exact: true }).click();
    const slowTab = page.getByRole('tab', { name: 'Slow.md', exact: true });
    const welcomeTab = page.getByRole('tab', { name: 'welcome.md', exact: true });
    await expect(slowTab).toHaveAttribute('aria-selected', 'true');
    const editor = page.locator('.cm-content').first();
    await expect(editor).toBeVisible();
    // Gate the real OPFS boundary, before opening a writable handle. The rest
    // of the assembled session/provider/UI path is unchanged.
    await page.evaluate(() => {
      const original = FileSystemFileHandle.prototype.createWritable;
      let armed = true;
      let release: (fail: boolean) => void = () => undefined;
      const gate = new Promise<void>((resolve, reject) => {
        release = (fail) => fail
          ? reject(new DOMException('Injected storage failure', 'QuotaExceededError'))
          : resolve();
      });
      window.backgroundSaveGate = { entered: false, release };
      FileSystemFileHandle.prototype.createWritable = async function (options) {
        if (armed && this.name === 'Slow.md') {
          armed = false;
          window.backgroundSaveGate.entered = true;
          await gate;
        }
        return original.call(this, options);
      };
    });
    await editor.click();
    await page.keyboard.type('First edit');
    await page.keyboard.press('Control+s');
    await expect.poll(() => page.evaluate(() => window.backgroundSaveGate.entered)).toBe(true);
    await page.evaluate(() => {
      window.unavailableDocumentNoticeSeen = false;
      const hasUnavailableNotice = () =>
        [...document.querySelectorAll('[role="status"]')].some((status) =>
          status.textContent?.includes('Document content is unavailable'),
        );
      if (hasUnavailableNotice()) {
        window.unavailableDocumentNoticeSeen = true;
      }
      const observer = new MutationObserver(() => {
        if (hasUnavailableNotice()) window.unavailableDocumentNoticeSeen = true;
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    });
    try {
      await welcomeTab.click();
      await expect(welcomeTab).toHaveAttribute('aria-selected', 'true', { timeout: 2000 });
      await expect
        .poll(() => page.evaluate(() => window.unavailableDocumentNoticeSeen))
        .toBe(false);
      await slowTab.click();
      await expect(slowTab).toHaveAttribute('aria-selected', 'true', { timeout: 2000 });
      await expect(editor).toContainText('First edit');
      await expect
        .poll(() => page.evaluate(() => window.unavailableDocumentNoticeSeen))
        .toBe(false);
      await editor.click();
      await page.keyboard.press('Control+End');
      await page.keyboard.type(' and a newer edit');
      await welcomeTab.click();
      await expect(welcomeTab).toHaveAttribute('aria-selected', 'true');
      await page.evaluate((fail) => window.backgroundSaveGate.release(fail), fail);
      if (fail) {
        await expect(slowTab.locator('[title="Save failed. Open this tab to retry."]')).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('background-save-failure.png') });
      }
      await slowTab.click();
      await expect(editor).toContainText('First edit and a newer edit');
      await page.keyboard.press('Control+s');
      await expect.poll(() => page.evaluate(async () => {
        const vault = await (await navigator.storage.getDirectory()).getDirectoryHandle('Background saves');
        return (await (await vault.getFileHandle('Slow.md')).getFile()).text();
      })).toBe('First edit and a newer edit');
      await page.reload();
      await page.getByTestId('open-recent-vault-button-0').click();
      const workspace = page.locator('[data-fl-component="workspace"]');
      await expect(workspace).toHaveAttribute('data-layout', fail ? 'compact' : 'wide');
      await expect(workspace).not.toHaveClass(/sidebar-switching/);
      const savedDocument = page.getByRole('complementary', { name: 'Sidebar', exact: true })
        .getByRole('button', { name: 'Slow.md', exact: true });
      if (!(await savedDocument.isVisible())) {
        await page.getByRole('button', { name: /^(Toggle|Open) sidebar$/ }).click();
      }
      await savedDocument.click();
      await expect(editor).toContainText('First edit and a newer edit');
    } finally {
      await page.evaluate(() => window.backgroundSaveGate?.release(false)).catch(() => undefined);
    }
  });
}
