import { expect, test, type Page } from '@playwright/test';
import { createFromSidebar } from './support/sidebar-create.js';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: undefined,
      configurable: true,
    }),
  );
  await page.goto('/');
  await page.getByTestId('create-vault-button').click();
  await page.getByTestId('create-vault-name-input').fill('Pointer selection');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();
  await expect(
    page.getByRole('tab', { name: 'welcome.md', exact: true }),
  ).toBeVisible();
});

async function create(page: Page, kind: string) {
  await createFromSidebar(page, kind === 'Ink' ? /^Ink page/ : kind);
  const dialog = page.getByRole('dialog', { name: 'Create a new note' });
  await dialog.getByRole('textbox', { name: 'Note name' }).fill('Pointer');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  const extension = {
    Markdown: 'md',
    LaTeX: 'tex',
    'Block page': 'blockpage',
    Ink: 'ink',
    Notebook: 'notebook',
  }[kind];
  await expect(
    page.getByRole('tab', { name: `Pointer.${extension}`, exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  if (kind === 'LaTeX')
    await expect(page.locator('.froglight-latex-source')).toBeVisible();
}

for (const kind of ['Markdown', 'LaTeX']) {
  test(`${kind} waits for focus and uses the primary caret and native selection`, async ({
    page,
  }, testInfo) => {
    await create(page, kind);
    const editor = page.locator('.cm-content');
    await expect(editor).toBeVisible();
    if (kind === 'Markdown') await expect(editor).not.toBeFocused();
    await editor.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('\nSelectioncheck');
    const colors = await editor.evaluate((el) => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--fl-accent)';
      probe.style.backgroundColor = 'var(--fl-accent-soft)';
      el.append(probe);
      const accent = getComputedStyle(probe).color;
      const soft = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return {
        accent,
        soft,
        caret: getComputedStyle(el).caretColor,
        selection: getComputedStyle(
          el.querySelector('.cm-line')!,
          '::selection',
        ).backgroundColor,
      };
    });
    expect(colors.caret).toBe(colors.accent);
    expect(colors.selection).toBe(colors.soft);
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');
    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString()))
      .toBe('Selectioncheck');
    await expect(page.locator('.cm-selectionBackground')).toHaveCount(0);
    await expect(
      page.locator('[data-selection-toolbar] [data-anchor="float.selection"]'),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`${kind}-selection.png`),
    });
  });
}

test('opening Markdown does not summon a caret', async ({ page }) => {
  await expect(page.locator('.cm-content')).not.toBeFocused();
  await expect(page.locator('.cm-editor')).not.toHaveClass(/cm-focused/);
  await create(page, 'Markdown');
  await page.getByRole('tab', { name: 'welcome.md', exact: true }).click();
  await expect(page.locator('.cm-content')).not.toBeFocused();
});

test.describe('touch Block Page', () => {
  test.use({ hasTouch: true, viewport: { width: 820, height: 1180 } });
  test('taps place the caret inside words and swipes scroll without changing selection', async ({
    page,
  }) => {
    await create(page, 'Block page');
    const editor = page.locator('.flbp-host .ProseMirror');
    await editor.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.insertText('Selectioncheck');
    const paragraph = editor.locator('p').filter({ hasText: 'Selectioncheck' });
    const point = await paragraph.evaluate((el) => {
      const text = el.firstChild!;
      const range = document.createRange();
      range.setStart(text, 6);
      range.setEnd(text, 7);
      const r = range.getBoundingClientRect();
      return { x: r.left + 1, y: (r.top + r.bottom) / 2 };
    });
    await page.touchscreen.tap(point.x, point.y);
    await page.keyboard.insertText('|');
    await expect(editor.locator('p').last()).toHaveText('Select|ioncheck');
    await page.keyboard.press('Control+End');
    for (let i = 0; i < 60; i++) {
      await page.keyboard.press('Enter');
      await page.keyboard.insertText(`Scroll paragraph ${i}`);
    }
    await page.keyboard.press('Control+Home');
    const host = page.locator('.flbp-host');
    await host.evaluate((el) => {
      el.scrollTop = 600;
    });
    await expect(
      page.locator('[data-selection-toolbar-kind="froglight.blockpage"]'),
    ).toHaveCount(0);
    const bounds = (await host.boundingBox())!;
    const selectionBefore = await page.evaluate(() => {
      const s = window.getSelection()!;
      return { text: s.anchorNode?.textContent, offset: s.anchorOffset };
    });
    const before = await host.evaluate((el) => el.scrollTop);
    const cdp = await page.context().newCDPSession(page);
    const x = bounds.x + bounds.width * 0.65;
    const y = bounds.y + bounds.height * 0.7;
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y, id: 0 }],
    });
    for (let step = 1; step <= 12; step++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: x + step * 0.5, y: y - step * 20, id: 0 }],
      });
      await page.evaluate(() => new Promise(requestAnimationFrame));
    }
    const after = await host.evaluate((el) => el.scrollTop);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    });
    await cdp.detach();
    expect(after - before).toBeGreaterThan(200);
    expect(after - before).toBeLessThan(260);
    expect(
      await page.evaluate(() => {
        const s = window.getSelection()!;
        return { text: s.anchorNode?.textContent, offset: s.anchorOffset };
      }),
    ).toEqual(selectionBefore);
  });
});

test.describe('embedded previews on touch', () => {
  test.use({ hasTouch: true, viewport: { width: 1280, height: 1180 } });
  for (const kind of ['Ink', 'Notebook']) {
    test(`swipes over an embedded ${kind} preview scroll the Block Page`, async ({
      page,
    }) => {
      await create(page, kind);
      const canvas = page.locator('.fl-ink-canvas').first();
      await expect(canvas).toBeVisible();
      const paper = (await canvas.boundingBox())!;
      await page.mouse.move(paper.x + 100, paper.y + 180);
      await page.mouse.down();
      await page.mouse.move(paper.x + 170, paper.y + 210, { steps: 10 });
      await page.mouse.up();
      await page.keyboard.press('Control+s');
      await create(page, 'Block page');
      const editor = page.locator('.flbp-host .ProseMirror');
      await editor.click();
      await page.keyboard.type('/resource embed');
      await page.getByText('Resource embed', { exact: true }).click();
      await page
        .getByRole('option', {
          name: kind === 'Ink' ? 'Pointer.ink' : 'Pointer.notebook',
          exact: true,
        })
        .click();
      const image = page.locator('[data-flbp-composition] img').first();
      await expect(image).toBeVisible();
      await editor.click();
      await page.keyboard.press('Control+End');
      for (let i = 0; i < 35; i++) {
        await page.keyboard.press('Enter');
        await page.keyboard.insertText(`After the preview ${i}`);
      }
      await image.scrollIntoViewIfNeeded();
      const host = page.locator('.flbp-host');
      const viewport = (await host.boundingBox())!;
      const bounds = (await image.boundingBox())!;
      const x = bounds.x + bounds.width / 2;
      const y = Math.min(
        bounds.y + bounds.height - 20,
        viewport.y + viewport.height - 40,
      );
      const before = await host.evaluate((el) => el.scrollTop);
      const cdp = await page.context().newCDPSession(page);
      try {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [{ x, y, id: 0 }],
        });
        for (let step = 1; step <= 12; step++) {
          await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [{ x: x + step * 0.5, y: y - step * 20, id: 0 }],
          });
          await page.evaluate(() => new Promise(requestAnimationFrame));
        }
        const distance = (await host.evaluate((el) => el.scrollTop)) - before;
        expect(distance).toBeGreaterThan(200);
        expect(distance).toBeLessThan(260);
      } finally {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchEnd',
          touchPoints: [],
        });
        await cdp.detach();
      }
    });
  }
});

test('Block Page precise clicks preserve word selection and selection dragging', async ({
  page,
}) => {
  await create(page, 'Block page');
  const editor = page.locator('.flbp-host .ProseMirror');
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('Selectioncheck');
  const paragraph = editor.locator('p').last();
  const points = await paragraph.evaluate((el) => {
    const point = (offset: number) => {
      const range = document.createRange();
      range.setStart(el.firstChild!, offset);
      range.setEnd(el.firstChild!, offset + 1);
      const r = range.getBoundingClientRect();
      return { x: r.left + 1, y: (r.top + r.bottom) / 2 };
    };
    return { start: point(3), middle: point(6), end: point(10) };
  });
  await page.mouse.click(points.middle.x, points.middle.y);
  expect(await page.evaluate(() => window.getSelection()!.anchorOffset)).toBe(
    6,
  );
  await page.mouse.dblclick(points.middle.x, points.middle.y);
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toBe('Selectioncheck');
  // Collapse the selected word so the next drag starts a text selection.
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(600);
  await page.mouse.move(points.start.x, points.start.y);
  await page.mouse.down();
  await page.mouse.move(points.end.x, points.end.y, { steps: 10 });
  await page.mouse.up();
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toBe('ectionc');
});

test.describe('source selection on narrow touch panes', () => {
  test.use({
    hasTouch: true,
    viewport: { width: 390, height: 844 },
    colorScheme: 'dark',
  });
  for (const kind of ['Markdown', 'LaTeX']) {
    test(`${kind} shares Block Page's keyboard-gated formatting`, async ({
      page,
    }, testInfo) => {
      await create(page, kind);
      const editor = page.locator('.cm-content');
      await editor.click();
      await page.keyboard.press('Control+End');
      await page.keyboard.insertText('\nSelectioncheck');
      await page.keyboard.press('Home');
      await page.keyboard.press('Shift+End');
      const toolbar = page.locator(
        '[data-selection-toolbar] [data-anchor="float.selection"]',
      );
      await expect(toolbar).toBeHidden();
      await page.evaluate(() => {
        Object.defineProperty(window.visualViewport!, 'height', {
          configurable: true,
          value: window.innerHeight - 300,
        });
        window.visualViewport!.dispatchEvent(new Event('resize'));
      });
      await expect(toolbar).toBeVisible();
      await toolbar.getByRole('button', { name: 'Bold', exact: true }).tap();
      await expect(editor).toContainText(
        kind === 'Markdown' ? '**Selectioncheck**' : '\\textbf{Selectioncheck}',
      );
      const bounds = (await toolbar.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
      await page.screenshot({
        path: testInfo.outputPath(`${kind}-touch-selection.png`),
      });
    });
  }
});
