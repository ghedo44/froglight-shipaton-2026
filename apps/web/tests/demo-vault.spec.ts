import { setDocumentPresentation } from './support/document-presentation.js';
import { expect, test } from '@playwright/test';

test('demo calculator plugin opens a movable window from the activity rail', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByTestId('open-recent-vault-button-0').click();
  const trigger = page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('button', { name: 'Calculator' });
  await expect(trigger).toBeVisible();
  await trigger.click();
  const calculator = page.getByRole('dialog', { name: 'Calculator' });
  await expect(calculator).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath('calculator-window.png'),
  });
  const press = async (key: string) =>
    calculator.getByRole('button', { name: key, exact: true }).click();
  const display = calculator.locator('output');
  const expression = calculator.locator('.demo-calc-expression');
  await press('8');
  await press('+');
  await expect(display).toHaveText('8 +');
  await press('2');
  await expect(display).toHaveText('8 + 2');
  await press('=');
  await expect(display).toHaveText('10');
  await expect(expression).toHaveText('8 + 2 =');
  await press('C');
  for (const key of ['7', '×', '8', '=']) await press(key);
  await expect(display).toHaveText('56');
  await expect(expression).toHaveText('7 × 8 =');
  await page.screenshot({
    path: test.info().outputPath('calculator-result.png'),
  });
  const before = await calculator.boundingBox();
  const header = calculator.locator('header');
  const box = await header.boundingBox();
  if (!before || !box) throw new Error('Calculator window missing');
  await page.mouse.move(box.x + 50, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 110, box.y + box.height / 2 + 60, { steps: 5 });
  await page.mouse.up();
  const after = await calculator.boundingBox();
  if (!after) throw new Error('Calculator window disappeared during drag');
  expect(after.x).toBeGreaterThan(before.x + 30);
  await calculator.getByRole('button', { name: 'Close Calculator' }).click();
  await expect(calculator).toHaveCount(0);
});

test('demo calculator retains touch input, operator corrections and keyboard expressions', async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext({
    hasTouch: true,
    viewport: { width: 1180, height: 820 },
  });
  const page = await context.newPage();
  try {
    await page.goto('/');
    await page.getByTestId('open-recent-vault-button-0').tap();
    await page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('button', { name: 'Calculator' })
      .tap();
    const calculator = page.getByRole('dialog', { name: 'Calculator' });
    const display = calculator.locator('output');
    const expression = calculator.locator('.demo-calc-expression');
    const press = async (key: string) =>
      calculator.getByRole('button', { name: key, exact: true }).tap();
    for (const key of ['8', '+', '×']) await press(key);
    await expect(display).toHaveText('8 ×');
    await press('⌫');
    await expect(display).toHaveText('8');
    for (const key of ['+', '2', '.', '5']) await press(key);
    await expect(display).toHaveText('8 + 2.5');
    await page.screenshot({
      path: testInfo.outputPath('calculator-expression-touch.png'),
    });
    await press('=');
    await expect(display).toHaveText('10.5');
    await expect(expression).toHaveText('8 + 2.5 =');
    await press('3');
    await expect(display).toHaveText('3');
    await expect(expression).toBeEmpty();
    await calculator.locator('.demo-calc').focus();
    await page.keyboard.press('Escape');
    await page.keyboard.type('8+2+3');
    await expect(display).toHaveText('8 + 2 + 3');
    await page.keyboard.press('Enter');
    await expect(display).toHaveText('13');
    await expect(expression).toHaveText('8 + 2 + 3 =');
    await page.keyboard.press('Escape');
    await page.keyboard.type('8+2*3');
    await expect(display).toHaveText('(8 + 2) × 3');
    await page.keyboard.press('Enter');
    await expect(display).toHaveText('30');
    await expect(expression).toHaveText('(8 + 2) × 3 =');
    await page.keyboard.press('Escape');
    await page.keyboard.type('8/0');
    await page.keyboard.press('Enter');
    await expect(display).toHaveText('Error');
    await expect(expression).toHaveText('8 ÷ 0 =');
    await press('7');
    await expect(display).toHaveText('7');
    await expect(expression).toBeEmpty();
  } finally {
    await context.close();
  }
});

test('bundled aerospace demo opens, renders and survives offline restart', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  await page.goto('/');
  await expect(page.getByTestId('recent-vault-name-0')).toHaveText(
    'Asteria — Aerospace Studio',
  );
  await page.getByTestId('open-recent-vault-button-0').click();
  await expect(
    page.getByRole('tab', {
      name: '00 Mission Control.blockpage',
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText('The question worth answering', { exact: false }).first(),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath('mission-control.png'),
    fullPage: true,
  });
  const sketch = page
    .locator('[data-flbp-composition][data-record*="resource-embed"]')
    .first();
  await sketch.scrollIntoViewIfNeeded();
  await expect(sketch.locator('img')).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath('spacecraft-embed.png'),
  });
  const originalPreview = await sketch.locator('img').getAttribute('src');
  await sketch
    .getByRole('button', { name: 'Open source', exact: true })
    .click();
  await expect(
    page.getByRole('tab', { name: 'Spacecraft architecture.ink', exact: true }),
  ).toBeVisible();
  const drawing = await page.locator('.fl-ink-canvas').first().boundingBox();
  if (!drawing) throw new Error('Missing ink canvas');
  await page.mouse.move(drawing.x + 110, drawing.y + 170);
  await page.mouse.down();
  await page.mouse.move(drawing.x + 180, drawing.y + 200, { steps: 12 });
  await page.mouse.up();
  await page.keyboard.press('Control+s');
  await page
    .getByRole('tab', { name: '00 Mission Control.blockpage', exact: true })
    .click();
  await sketch.scrollIntoViewIfNeeded();
  await expect
    .poll(() => sketch.locator('img').getAttribute('src'))
    .not.toBe(originalPreview);

  const math = page.locator('[data-flbp-math]').first();
  await math.scrollIntoViewIfNeeded();
  await expect(math.locator('.katex')).toBeVisible();
  const diagram = page.locator('[data-flbp-diagram]').first();
  await diagram.scrollIntoViewIfNeeded();
  await expect(diagram.locator('svg')).toBeVisible();
  const files = await page.evaluate(async () => {
    const vault = await (
      await navigator.storage.getDirectory()
    ).getDirectoryHandle('froglight-asteria-demo');
    const file = await (
      await (
        await vault.getDirectoryHandle('.froglight')
      ).getFileHandle('workspace.json')
    ).getFile();
    return JSON.parse(await file.text()).documents;
  });
  expect(files).toHaveLength(30);
  await page
    .getByText('Read the complete LaTeX design study', { exact: true })
    .click();
  await expect(
    page.getByRole('tab', { name: 'Asteria design notes.tex', exact: true }),
  ).toBeVisible();
  // Inspect through the product's reading mode, using its real bundled provider.
  await setDocumentPresentation(page, 'View');
  const preview = page.frameLocator('iframe');
  await expect(
    preview
      .getByText('Asteria: From Orbit to Engineering Judgment', {
        exact: false,
      })
      .first(),
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    preview.getByText('The next useful result may be a better question.', {
      exact: false,
    }),
  ).toBeAttached();
  await page.screenshot({ path: test.info().outputPath('latex-preview.png') });
  await page
    .getByRole('tab', { name: '00 Mission Control.blockpage', exact: true })
    .click();
  await page
    .getByText('Enter the design room: move cards and connect hypotheses', {
      exact: true,
    })
    .click();
  await expect(page.locator('.fl-ink-canvas').first()).toBeVisible();
  await page.getByRole('button', { name: 'Fit board', exact: true }).click();
  await page.screenshot({ path: test.info().outputPath('whiteboard.png') });
  await page
    .getByRole('button', { name: 'Field notebook.notebook', exact: true })
    .dblclick();
  await expect(page.locator('.fl-nb-scroll')).toBeVisible();
  for (const [index, fraction] of [0, 0.5, 1].entries()) {
    await page.locator('.fl-nb-scroll').evaluate((element, value) => {
      element.scrollTop = (element.scrollHeight - element.clientHeight) * value;
    }, fraction);
    await page.screenshot({
      path: test.info().outputPath(`notebook-${index + 1}.png`),
    });
  }
  await page.getByRole('button', { name: 'Graph view', exact: true }).click();
  await page.screenshot({ path: test.info().outputPath('graph.png') });
  await page
    .getByRole('button', { name: 'Design room.whiteboard', exact: true })
    .dblclick();
  const inkCanvas = page.locator('.fl-ink-canvas').first();
  await expect(inkCanvas).toBeVisible();
  const readBoard = () =>
    page.evaluate(async () => {
      const vault = await (
        await navigator.storage.getDirectory()
      ).getDirectoryHandle('froglight-asteria-demo');
      return (
        await (await vault.getFileHandle('Design room.whiteboard')).getFile()
      ).text();
    });
  const before = JSON.parse(await readBoard()).order.length;
  const box = await inkCanvas.boundingBox();
  if (!box) throw new Error('Missing drawing canvas');
  await page.mouse.move(box.x + 90, box.y + 470);
  await page.mouse.down();
  await page.mouse.move(box.x + 160, box.y + 485, { steps: 12 });
  await page.mouse.up();
  await page.keyboard.press('Control+s');
  await expect
    .poll(async () => JSON.parse(await readBoard()).order.length)
    .toBeGreaterThan(before);
  const saved = await readBoard();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page
    .getByRole('button', {
      name: 'Asteria — Aerospace Studio vault options',
      exact: true,
    })
    .click();
  await page
    .getByRole('menuitem', { name: 'Close vault', exact: true })
    .click();
  await expect(page.getByTestId('open-recent-vault-button-0')).toBeVisible();
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId('open-recent-vault-button-0')).toBeVisible();
  await page.getByTestId('open-recent-vault-button-0').click();
  await expect(
    page.getByRole('tab', { name: 'Design room.whiteboard', exact: true }),
  ).toBeVisible();
  expect(await readBoard()).toBe(saved);
});

test('the demo is installed before opening and forgetting it does not recreate it', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('recent-vault-name-0')).toHaveText(
    'Asteria — Aerospace Studio',
  );
  expect(
    await page.evaluate(async () => {
      const root = await (
        await navigator.storage.getDirectory()
      ).getDirectoryHandle('froglight-asteria-demo');
      return (
        await (
          await root.getFileHandle('00 Mission Control.blockpage')
        ).getFile()
      ).size;
    }),
  ).toBeGreaterThan(1000);
  await page.getByTestId('forget-recent-vault-button-0').click();
  await expect(page.getByTestId('recent-vault-empty-state')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('recent-vault-empty-state')).toBeVisible();
  // Forgetting removes the launcher entry, never the user's editable copy.
  expect(
    await page.evaluate(async () => {
      const root = await (
        await navigator.storage.getDirectory()
      ).getDirectoryHandle('froglight-asteria-demo');
      return (
        await (
          await root.getFileHandle('00 Mission Control.blockpage')
        ).getFile()
      ).size;
    }),
  ).toBeGreaterThan(1000);
});

test('demo Markdown equations and tags render offline in the reader', async ({
  page,
  context,
}) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await page.getByTestId('open-recent-vault-button-0').click();
  await expect(
    page.getByRole('tab', {
      name: '00 Mission Control.blockpage',
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Pitch tour.md', exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Zettelkasten', exact: true })
    .dblclick();
  await page
    .getByRole('button', { name: '06 Energy balance.md', exact: true })
    .dblclick();
  await setDocumentPresentation(page, 'View');
  const reader = page.locator('.fl-markdown-reader');
  await expect(
    reader
      .locator('.md-frontmatter-row')
      .filter({ has: page.locator('dt', { hasText: /^tags$/ }) })
      .locator('dd'),
  ).toHaveText('aerospace, asteria, permanent-note');
  await expect(reader.locator('p .katex').first()).toBeVisible();
  await expect(reader.locator('.katex-display')).toBeVisible();
  await expect(reader.locator('.md-math-error')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  expect(
    await reader
      .locator('.katex')
      .first()
      .evaluate((element) => getComputedStyle(element).fontFamily),
  ).toContain('KaTeX');
  await page.screenshot({
    path: test.info().outputPath('markdown-math-light.png'),
  });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await page.setViewportSize({ width: 760, height: 850 });
  await reader.locator('.katex-display').scrollIntoViewIfNeeded();
  expect(
    await reader.evaluate(
      (element) => element.scrollWidth - element.clientWidth,
    ),
  ).toBeLessThanOrEqual(1);
  await page.screenshot({
    path: test.info().outputPath('markdown-math-dark-narrow.png'),
  });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await context.setOffline(true);
  await page.reload();
  await page.getByTestId('open-recent-vault-button-0').click();
  await expect(
    page.locator('.fl-markdown-reader .katex-display'),
  ).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  expect(
    await page.evaluate(() => document.fonts.check('16px KaTeX_Main')),
  ).toBe(true);
});
