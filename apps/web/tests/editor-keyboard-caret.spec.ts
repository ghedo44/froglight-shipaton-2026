import { expect, test } from '@playwright/test';
import { createFromSidebar } from './support/sidebar-create.js';

test.use({ hasTouch: true, viewport: { width: 820, height: 1180 } });

for (const kind of ['Block Page', 'Markdown', 'LaTeX']) {
  test(`opening the keyboard keeps the tapped ${kind} paragraph visible`, async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByTestId('open-recent-vault-button-0').click();
    await expect(page.locator('.flbp-host').first()).toBeVisible();
    if (kind !== 'Block Page') {
      await createFromSidebar(page, kind);
      await page
        .getByRole('textbox', { name: 'Note name' })
        .fill('Keyboard test');
      await page
        .getByRole('dialog', { name: 'Create a new note' })
        .getByRole('button', { name: 'Create', exact: true })
        .click();
    }
    const blockPage = kind === 'Block Page';
    const scroller = blockPage ? '.flbp-host' : '.cm-scroller';
    const editor = page
      .locator(blockPage ? '.flbp-host .ProseMirror' : '.cm-content')
      .first();
    await expect(editor).toBeVisible();
    await editor.click();
    await page.keyboard.press('Control+End');
    // A long real document makes scrolling the editor's bounding box observably
    // different from revealing the actual insertion point.
    await page.keyboard.insertText(
      '\n' +
        Array.from({ length: 60 }, (_, i) => `Keyboard paragraph ${i}`).join(
          '\n',
        ),
    );
    await page.keyboard.press('Control+Home');
    await expect
      .poll(() =>
        editor.evaluate(
          (el, selector) => el.closest(selector)!.scrollTop,
          scroller,
        ),
      )
      .toBeLessThan(250);
    await editor
      .locator(blockPage ? 'p, h1, h2' : '.cm-line')
      .first()
      .tap();
    const before = await editor.evaluate(
      (el, selector) => el.closest(selector)!.scrollTop,
      scroller,
    );
    await page.evaluate(() => {
      Object.defineProperty(window.visualViewport!, 'height', {
        configurable: true,
        value: window.innerHeight - 350,
      });
      window.visualViewport!.dispatchEvent(new Event('resize'));
    });
    await expect
      .poll(() =>
        page.evaluate(() =>
          getComputedStyle(document.documentElement)
            .getPropertyValue('--fl-keyboard-inset-height')
            .trim(),
        ),
      )
      .toBe('350px');
    await page.waitForTimeout(400);
    expect(
      await editor.evaluate(
        (el, selector) => el.closest(selector)!.scrollTop,
        scroller,
      ),
    ).toBeCloseTo(before, 0);
    const caret = await page.evaluate(() => {
      const selection = window.getSelection()!;
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom };
    });
    expect(caret.top).toBeGreaterThan(0);
    expect(caret.bottom).toBeLessThan(830);
  });
}
