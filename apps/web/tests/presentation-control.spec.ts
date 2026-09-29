import { expect, test } from '@playwright/test';
import { createFromSidebar } from './support/sidebar-create.js';

for (const touch of [false, true]) {
  test.describe(touch ? 'touch presentation' : 'mouse presentation', () => {
    test.use({ viewport: { width: 1024, height: 900 }, hasTouch: touch });
    test('slides between document modes and uses a menu in narrow panes', async ({
      page,
    }) => {
      await page.addInitScript(() =>
        Object.defineProperty(window, 'showDirectoryPicker', {
          value: undefined,
          configurable: true,
        }),
      );
      await page.goto('/');
      await page.getByTestId('create-vault-button').click();
      await page
        .getByTestId('create-vault-name-input')
        .fill('Presentation controls');
      await page.getByTestId('choose-vault-location-button').click();
      await page.getByTestId('confirm-create-vault-button').click();
      await createFromSidebar(page, 'Markdown');
      await page.getByRole('textbox', { name: 'Note name' }).fill('Modes');
      await page
        .getByRole('dialog', { name: 'Create a new note' })
        .getByRole('button', { name: 'Create', exact: true })
        .click();
      const editor = page.locator('.froglight-markdown-editor .cm-content');
      await editor.click();
      await editor.press('Control+a');
      await page.keyboard.insertText(
        '# A portable document\n\nPreserve this text.',
      );
      const selector = page.getByRole('radiogroup', { name: 'Document view' });
      await expect(selector).toBeVisible();
      const toggleHeight = (await selector.boundingBox())!.height;
      const primaryIconHeight = (await page
        .getByRole('button', { name: 'Back', exact: true })
        .boundingBox())!.height;
      expect(toggleHeight).toBeLessThanOrEqual(primaryIconHeight);
      const header = page.locator('[data-fl-component="document-toolbar"]');
      await expect
        .poll(async () => (await header.boundingBox())?.height)
        .toBe(40);

      await expect(
        page.getByRole('button', { name: 'Document view: Edit' }),
      ).toBeHidden();
      await expect(selector.getByRole('radio')).toHaveCount(3);
      await expect(
        selector.getByRole('radio', { name: 'Edit', exact: true }),
      ).toBeChecked();
      await selector.getByRole('radio', { name: 'Split', exact: true }).click();
      await expect(
        selector.getByRole('radio', { name: 'Split', exact: true }),
      ).toBeChecked();
      await expect(editor).toBeVisible();
      await selector
        .getByRole('radio', { name: 'Split', exact: true })
        .press('ArrowRight');
      const view = selector.getByRole('radio', { name: 'View', exact: true });
      await expect(view).toBeChecked();
      await expect(view).toBeFocused();
      await expect(editor).toBeHidden();
      await expect(
        page.getByRole('heading', { name: 'A portable document' }),
      ).toBeVisible();
      // Drag the selected end of the control back to Edit.
      const from = await view.boundingBox();
      const edit = selector.getByRole('radio', { name: 'Edit', exact: true });
      const to = await edit.boundingBox();
      if (!from || !to)
        throw new Error('Missing presentation control geometry');
      if (touch) {
        const client = await page.context().newCDPSession(page);
        const startX = from.x + from.width / 2;
        const endX = to.x + to.width / 2;
        const y = from.y + from.height / 2;
        await client.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [{ x: startX, y, id: 0 }],
        });
        for (let step = 1; step <= 8; step++)
          await client.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [
              { x: startX + ((endX - startX) * step) / 8, y, id: 0 },
            ],
          });
        await client.send('Input.dispatchTouchEvent', {
          type: 'touchEnd',
          touchPoints: [],
        });
        await client.detach();
      } else {
        await page.mouse.move(
          from.x + from.width / 2,
          from.y + from.height / 2,
        );
        await page.mouse.down();
        await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
          steps: 8,
        });
        await page.mouse.up();
      }
      await expect(edit).toBeChecked();
      await expect(editor).toContainText('Preserve this text.');
      await page.screenshot({ path: test.info().outputPath('modes-wide.png') });
      await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
      await selector.getByRole('radio', { name: 'View', exact: true }).click();
      await expect(
        selector.getByRole('radio', { name: 'View', exact: true }),
      ).toBeChecked();
      await page.screenshot({ path: test.info().outputPath('modes-dark.png') });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(selector).toBeHidden();
      const menuTrigger = page.getByRole('button', {
        name: 'Document view: View',
      });
      await expect(menuTrigger).toBeVisible();
      await expect
        .poll(async () => {
          const trigger = await menuTrigger.boundingBox();
          const icon = await page
            .getByRole('button', { name: 'Back', exact: true })
            .boundingBox();
          return trigger && icon ? trigger.height - icon.height : Infinity;
        })
        .toBeLessThanOrEqual(0);
      await expect
        .poll(async () => (await header.boundingBox())?.height)
        .toBe(40);
      await menuTrigger.click();
      await page
        .getByRole('menuitemradio', { name: 'Edit', exact: true })
        .click();
      await expect(editor).toContainText('Preserve this text.');
      await page.screenshot({
        path: test.info().outputPath('modes-narrow.png'),
      });
      // Notebook exposes the same two-position control through its provider.
      await page.setViewportSize({ width: 1024, height: 900 });
      await createFromSidebar(page, 'Notebook');
      await page
        .getByRole('textbox', { name: 'Note name' })
        .fill('Paper modes');
      await page
        .getByRole('dialog', { name: 'Create a new note' })
        .getByRole('button', { name: 'Create', exact: true })
        .click();
      await expect(selector).toBeVisible();
      await expect(selector.getByRole('radio')).toHaveCount(2);
      await expect
        .poll(async () => (await header.boundingBox())?.height)
        .toBe(40);
      const notebookView = selector.getByRole('radio', {
        name: 'View',
        exact: true,
      });
      if (touch) await notebookView.tap();
      else await notebookView.click();
      await expect(notebookView).toBeChecked();
      await expect(page.locator('.fl-nb')).toBeVisible();
    });
  });
}
