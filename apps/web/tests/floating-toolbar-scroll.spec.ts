import { createFromSidebar } from './support/sidebar-create.js';
import { expect, test, type Page } from '@playwright/test';

async function createNote(
  page: Page,
  input: {
    readonly name: string;
    readonly kind: 'Markdown' | 'Block page' | 'LaTeX' | 'Notebook';
  },
): Promise<void> {
  await createFromSidebar(page, input.kind);
  const dialog = page.getByRole('dialog', { name: 'Create a new note' });
  await dialog.getByRole('textbox', { name: 'Note name' }).fill(input.name);
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
}

async function assertToolbarOverlaysScrollableContent(
  page: Page,
  input: {
    readonly scroller: string;
    readonly firstContent: string;
  },
): Promise<void> {
  const pane = page.locator('[data-pane="main"]');
  const scroller = pane.locator(input.scroller).first();
  const firstContent = pane.locator(input.firstContent).first();

  await expect(scroller).toBeVisible();
  await expect(firstContent).toBeVisible();
  await expect
    .poll(() =>
      scroller.evaluate(
        (element) => element.scrollHeight - element.clientHeight,
      ),
    )
    .toBeGreaterThan(80);
  await scroller.evaluate((element) => {
    element.scrollTop = 0;
  });

  const initial = await pane.evaluate((element, selectors) => {
    const bodyElement = element.querySelector('.fl-pane-editor')?.parentElement;
    const scrollerElement = element.querySelector(selectors.scroller);
    const contentElement = element.querySelector(selectors.firstContent);
    const topIslands = [
      ...element.querySelectorAll<HTMLElement>('[data-anchor^="float.top"]'),
    ].filter((island) => island.getClientRects().length > 0);
    if (
      bodyElement == null ||
      scrollerElement === null ||
      contentElement === null ||
      topIslands.length === 0
    ) {
      throw new Error('missing floating-toolbar acceptance geometry');
    }
    return {
      bodyPaddingTop: Number.parseFloat(
        getComputedStyle(bodyElement).paddingTop,
      ),
      scrollerTop: scrollerElement.getBoundingClientRect().top,
      contentTop: contentElement.getBoundingClientRect().top,
      toolbarBottom: Math.max(
        ...topIslands.map((island) => island.getBoundingClientRect().bottom),
      ),
    };
  }, input);

  // The toolbar is a true overlay over the editor viewport, not a separate
  // blank row. The document's own scrollable headspace protects line/page 1.
  expect(initial.bodyPaddingTop).toBe(0);
  expect(initial.scrollerTop).toBeLessThan(initial.toolbarBottom);
  expect(initial.contentTop).toBeGreaterThanOrEqual(initial.toolbarBottom - 1);
}

async function assertLatexPreviewStartsBelowToolbar(page: Page): Promise<void> {
  const pane = page.locator('[data-pane="main"]');
  const frame = pane.locator('iframe[title="LaTeX preview"]');
  await expect(frame).toBeVisible();
  const renderedPage = frame.contentFrame().locator('body');
  const firstContent = frame.contentFrame().locator('body > *').first();
  await expect(renderedPage).toBeVisible();
  await expect(firstContent).toBeVisible();

  const frameBox = await frame.boundingBox();
  const pageBox = await renderedPage.boundingBox();
  const contentBox = await firstContent.boundingBox();
  const toolbarBottom = await pane
    .locator('[data-anchor^="float.top"]:visible')
    .evaluateAll((islands) =>
      Math.max(
        ...islands.map((island) => island.getBoundingClientRect().bottom),
      ),
    );
  expect(frameBox).not.toBeNull();
  expect(pageBox).not.toBeNull();
  expect(contentBox).not.toBeNull();
  expect(frameBox!.y).toBeLessThan(toolbarBottom);
  expect(pageBox!.y).toBeGreaterThanOrEqual(toolbarBottom - 1);
  expect(contentBox!.y).toBeGreaterThanOrEqual(toolbarBottom - 1);
}

test('writing documents scroll beneath the floating toolbar without hiding their first content', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() =>
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: undefined,
      configurable: true,
    }),
  );
  await page.goto('/');
  await page.getByTestId('create-vault-button').click();
  await page.getByTestId('create-vault-name-input').fill('Floating toolbar');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();

  await createNote(page, { name: 'Markdown clearance', kind: 'Markdown' });
  let content = page.locator('[data-pane="main"] .cm-content');
  await expect(content).toBeVisible();
  await content.click();
  await page.keyboard.insertText(
    Array.from({ length: 80 }, (_, index) => `Markdown line ${index + 1}`).join(
      '\n',
    ),
  );
  await assertToolbarOverlaysScrollableContent(page, {
    scroller: '.cm-scroller',
    firstContent: '.cm-line',
  });

  await createNote(page, { name: 'LaTeX clearance', kind: 'LaTeX' });
  content = page.locator('[data-pane="main"] .cm-content');
  await expect(content).toBeVisible();
  await content.click();
  await page.keyboard.insertText(
    Array.from(
      { length: 40 },
      (_, index) => `\\section{Section ${index + 1}}\nRendered content.`,
    ).join('\n'),
  );
  await assertToolbarOverlaysScrollableContent(page, {
    scroller: '.cm-scroller',
    firstContent: '.cm-line',
  });
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  await assertLatexPreviewStartsBelowToolbar(page);

  await createNote(page, { name: 'Block page clearance', kind: 'Block page' });
  const blockContent = page.locator('[data-pane="main"] .ProseMirror');
  await expect(blockContent).toBeVisible();
  await blockContent.fill('Block page content '.repeat(1_000));
  await assertToolbarOverlaysScrollableContent(page, {
    scroller: '.flbp-host',
    firstContent: '.ProseMirror > *',
  });

  await createNote(page, { name: 'Notebook clearance', kind: 'Notebook' });
  await assertToolbarOverlaysScrollableContent(page, {
    scroller: '.fl-nb-scroll',
    firstContent: '.fl-nb-shell',
  });
});
