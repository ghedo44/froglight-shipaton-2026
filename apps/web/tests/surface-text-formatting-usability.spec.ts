import { expect, test, type Page } from '@playwright/test';
import { createFromSidebar } from './support/sidebar-create.js';

async function createNote(page: Page, name: string, kind: RegExp) {
  await createFromSidebar(page, kind);
  const dialog = page.getByRole('dialog', { name: 'Create a new note' });
  await dialog.getByRole('textbox', { name: 'Note name' }).fill(name);
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('tab', { selected: true })).toContainText(name);
  await expect(page.locator('.fl-ink-canvas')).toBeVisible();
}

async function expectTextFormattingShelf(page: Page) {
  const categories = page.getByRole('toolbar', {
    name: 'Document tool categories',
  });
  await categories.getByRole('button', { name: 'Text', exact: true }).click();
  const shelf = page.locator('[data-tool-shelf="surface.text"]');
  await expect(shelf).toBeVisible();
  for (const label of [
    'Text style',
    'Font size',
    'Bold',
    'Italic',
    'Text alignment',
    'Text color',
    'Wrap text',
  ]) {
    await expect(shelf.getByLabel(label, { exact: true })).toBeVisible();
  }
}

test.use({ viewport: { width: 1440, height: 900 } });

test('Ink, Whiteboard, and Notebook expose text formatting before placement', async ({
  page,
}) => {
  page.setDefaultTimeout(10_000);
  await page.addInitScript(() =>
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: undefined,
      configurable: true,
    }),
  );
  await page.goto('/');
  await page.getByTestId('create-vault-button').click();
  await page.getByTestId('create-vault-name-input').fill('Surface text tools');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();

  for (const [name, kind] of [
    ['Text tools ink', /Ink page/],
    ['Text tools whiteboard', /Whiteboard/],
    ['Text tools notebook', /Notebook/],
  ] as const) {
    await createNote(page, name, kind);
    await expectTextFormattingShelf(page);
  }
});

test('Ink text uses direct controls, stays on the page, and resizes inline', async ({
  page,
}) => {
  page.setDefaultTimeout(10_000);
  await page.addInitScript(() =>
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: undefined,
      configurable: true,
    }),
  );
  await page.goto('/');
  await page.getByTestId('create-vault-button').click();
  await page.getByTestId('create-vault-name-input').fill('Ink text check');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();
  await createNote(page, 'Writing', /Ink page/);
  await expectTextFormattingShelf(page);
  const shelf = page.locator('[data-tool-shelf="surface.text"]');
  await expect(
    shelf.getByRole('button', { name: 'Text', exact: true }),
  ).toHaveCount(0);
  await expect(shelf.getByRole('button', { name: /settings/i })).toHaveCount(0);
  await expect(
    shelf.getByRole('group', { name: 'Text color' }).getByRole('button'),
  ).toHaveCount(3);
  const color = shelf.getByRole('button', { name: /Text color 2:/ });
  await color.click();
  await expect(color).toHaveAttribute('aria-pressed', 'true');
  await color.click();
  await shelf.getByLabel('Edit text color 2').fill('#336699');
  await expect(
    shelf.getByRole('button', { name: 'Text color 2: #336699' }),
  ).toHaveAttribute('aria-pressed', 'true');
  const canvas = page.locator('.fl-ink-canvas');
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await canvas.click({ position: { x: 12, y: 100 } });
  await expect(page.locator('.fl-ink-text-input')).toHaveCount(0);
  await canvas.click({ position: { x: box!.width / 2, y: box!.height / 2 } });
  const editor = page.locator('.fl-ink-text-input');
  await expect(editor).toBeVisible();
  const handle = page.getByRole('button', { name: 'Resize text box' });
  await expect(handle).toBeVisible();
  const before = await editor.boundingBox();
  const grip = await handle.boundingBox();
  expect(before).not.toBeNull();
  expect(grip).not.toBeNull();
  await page.mouse.move(grip!.x + grip!.width / 2, grip!.y + grip!.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    grip!.x + grip!.width / 2 + 80,
    grip!.y + grip!.height / 2,
    { steps: 5 },
  );
  await page.mouse.up();
  const after = await editor.boundingBox();
  expect(after!.width).toBeGreaterThan(before!.width + 40);
  await editor.fill('A resizable note');
  await editor.press('Control+Enter');
  await expect(editor).toHaveCount(0);
  await canvas.dblclick({
    position: { x: box!.width / 2 + 16, y: box!.height / 2 + 10 },
  });
  const existing = page.locator('[data-fl-text-overlay="edit"]');
  await expect(existing).toBeVisible();
  await expect(existing).toHaveValue('A resizable note');
  await expect(
    page.getByRole('button', { name: 'Resize text box' }),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath('ink-text-edit.png'),
    animations: 'disabled',
  });
  await existing.fill('An edited note');
  await existing.press('Control+Enter');
  await expect(existing).toHaveCount(0);
});

for (const kind of ['Ink page', 'Notebook', 'Whiteboard']) {
  test(`${kind}: live text editing and shared stroke palette`, async ({
    page,
  }) => {
    page.setDefaultTimeout(10_000);
    await page.addInitScript(() =>
      Object.defineProperty(window, 'showDirectoryPicker', {
        value: undefined,
        configurable: true,
      }),
    );
    await page.goto('/');
    await page.getByTestId('create-vault-button').click();
    await page.getByTestId('create-vault-name-input').fill(`Editing ${kind}`);
    await page.getByTestId('choose-vault-location-button').click();
    await page.getByTestId('confirm-create-vault-button').click();
    await createNote(page, 'Editing', new RegExp(kind));
    const categories = page.getByRole('toolbar', {
      name: 'Document tool categories',
    });
    await categories.getByRole('button', { name: 'Text', exact: true }).click();
    const canvas = page.locator('.fl-ink-canvas');
    const bounds = await canvas.boundingBox();
    if (bounds === null) throw new Error('Missing surface');
    await canvas.click({
      position: { x: bounds.width / 2, y: bounds.height / 2 },
    });
    const editor = page.locator('.fl-ink-text-input');
    await editor.fill('Live text');
    await expect(editor).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(editor).toHaveCSS('padding', '0px');
    const size = page
      .getByRole('spinbutton', { name: 'Font size', exact: true })
      .first();
    const initialSize = await editor.evaluate((node) =>
      Number.parseFloat(getComputedStyle(node).fontSize),
    );
    const initialValue = Number(await size.inputValue());
    await size.fill('32');
    await expect(editor).toBeVisible();
    await expect
      .poll(() =>
        editor.evaluate((node) =>
          Number.parseFloat(getComputedStyle(node).fontSize),
        ),
      )
      .toBeCloseTo((initialSize * 32) / initialValue, 2);
    await expect(size).toBeFocused();
    await editor.press('Control+Enter');
    await expect(editor).toHaveCount(0);
    await expect(
      page.getByRole('toolbar', { name: 'Object menu' }),
    ).toHaveCount(0);
    await expect(
      categories.getByRole('button', { name: 'Text', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await canvas.dblclick({
      position: { x: bounds.width / 2 + 20, y: bounds.height / 2 + 10 },
    });
    await expect(editor).toHaveAttribute('data-fl-text-overlay', 'edit');
    await editor.fill('Edited draft');
    const objectMenu = page.getByRole('toolbar', { name: 'Object menu' });
    await objectMenu.getByRole('spinbutton', { name: 'Font size' }).fill('48');
    await expect(editor).toHaveValue('Edited draft');
    await expect
      .poll(() =>
        editor.evaluate((node) =>
          Number.parseFloat(getComputedStyle(node).fontSize),
        ),
      )
      .toBeCloseTo((initialSize * 48) / initialValue, 2);
    await page.screenshot({ path: test.info().outputPath('inline-edit.png') });
    await editor.press('Control+Enter');
    await categories.getByRole('button', { name: 'Pen', exact: true }).click();
    const x = bounds.x + bounds.width * 0.38;
    const y = bounds.y + bounds.height * 0.3;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let step = 1; step <= 12; step++)
      await page.mouse.move(x + step * 6, y + step * 3);
    await page.mouse.up();
    await categories
      .getByRole('button', { name: 'Selection', exact: true })
      .click();
    await page.getByRole('button', { name: 'Select', exact: true }).click();
    await page.mouse.click(x + 36, y + 18);
    await expect(objectMenu).toBeVisible();
    await expect(
      objectMenu.getByRole('spinbutton', { name: 'Font size' }),
    ).toHaveCount(0);
    await expect(
      objectMenu.locator('button[data-slot-kind="size"]'),
    ).toHaveCount(3);
    const colors = objectMenu.locator('button[data-slot-kind="color"]');
    await expect(colors).toHaveCount(3);
    await colors.nth(1).dblclick();
    const dialog = page.getByRole('dialog', {
      name: 'Edit color slot 2',
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await dialog
      .getByRole('textbox', { name: 'Slot color value' })
      .fill('#336699');
    await page.keyboard.press('Escape');
    await expect(colors.nth(1).locator('span')).toHaveCSS(
      'background-color',
      'rgb(51, 102, 153)',
    );
    await page.screenshot({ path: test.info().outputPath('stroke-menu.png') });
    await categories.getByRole('button', { name: 'Pen', exact: true }).click();
    await expect(
      page
        .locator('[data-tool-shelf] button[data-slot-kind="color"]')
        .nth(1)
        .locator('span'),
    ).toHaveCSS('background-color', 'rgb(51, 102, 153)');
    await page.keyboard.press('Control+s');
    const extension = kind === 'Ink page' ? 'ink' : kind.toLowerCase();
    await expect
      .poll(() =>
        page.evaluate(
          async ({ kind, extension }) => {
            try {
              const vault = await (
                await navigator.storage.getDirectory()
              ).getDirectoryHandle(`Editing ${kind}`);
              return (
                await (
                  await vault.getFileHandle(`Editing.${extension}`)
                ).getFile()
              ).text();
            } catch {
              return '';
            }
          },
          { kind, extension },
        ),
      )
      .toContain('Edited draft');
    await page.reload();
    await page
      .getByRole('button', { name: new RegExp(`Editing ${kind} Browser`) })
      .click();
    await page
      .getByRole('button', { name: `Editing.${extension}`, exact: true })
      .click();
    await expect(canvas).toBeVisible();
    await categories
      .getByRole('button', { name: 'Selection', exact: true })
      .click();
    await page.getByRole('button', { name: 'Select', exact: true }).click();
    const reopened = await canvas.boundingBox();
    if (reopened === null) throw new Error('Missing reopened surface');
    await canvas.dblclick({
      position: { x: reopened.width / 2 + 6, y: reopened.height / 2 + 6 },
    });
    await expect(editor).toHaveValue('Edited draft');
    await expect(
      objectMenu.getByRole('spinbutton', { name: 'Font size' }),
    ).toHaveValue('48');
    await editor.press('Control+Enter');
  });
}

for (const kind of ['Ink page', 'Notebook', 'Whiteboard']) {
  test(`${kind}: drag text and connect objects without inserting cards`, async ({
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
      .fill(`Connections ${kind}`);
    await page.getByTestId('choose-vault-location-button').click();
    await page.getByTestId('confirm-create-vault-button').click();
    await createNote(page, 'Connections', new RegExp(kind));
    const categories = page.getByRole('toolbar', {
      name: 'Document tool categories',
    });
    await categories.getByRole('button', { name: 'Text', exact: true }).click();
    const canvas = page.locator('.fl-ink-canvas');
    const bounds = await canvas.boundingBox();
    if (bounds === null) throw new Error('Missing canvas');
    const editor = page.locator('.fl-ink-text-input');
    const boxes = [];
    for (const [text, fraction] of [
      ['Source', 0.25],
      ['Target', 0.48],
    ] as const) {
      await canvas.click({
        position: { x: bounds.width * 0.25, y: bounds.height * fraction },
      });
      await editor.fill(text);
      const box = await editor.boundingBox();
      if (box === null) throw new Error('Missing editor');
      const fontSize = await editor.evaluate((node) =>
        parseFloat(getComputedStyle(node).fontSize),
      );
      boxes.push({
        ...box,
        width: (await editor.evaluate((node) => node.tagName === 'TEXTAREA'))
          ? box.width
          : await editor.evaluate((node, value) => {
              const style = getComputedStyle(node);
              const ctx = document.createElement('canvas').getContext('2d')!;
              ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
              return ctx.measureText(value).width;
            }, text),
        height: fontSize * 1.25,
      });
      await editor.press('Control+Enter');
      await expect(editor).toHaveCount(0);
      await expect(
        page.getByRole('toolbar', { name: 'Object menu' }),
      ).toHaveCount(0);
    }
    const source = boxes[0]!;
    const target = boxes[1]!;
    await page.mouse.click(source.x + 12, source.y + source.height / 2);
    await expect(
      page.getByRole('toolbar', { name: 'Object menu' }),
    ).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath('connection-handles.png'),
    });
    const sourceMenu = (await page
      .getByRole('toolbar', { name: 'Object menu' })
      .boundingBox())!;
    expect(sourceMenu.y + sourceMenu.height).toBeLessThanOrEqual(source.y - 20);
    const sx = source.x + source.width / 2;
    const sy = source.y + source.height + 8;
    const tx = target.x + target.width / 2;
    const ty = target.y + 2;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(tx, ty, { steps: 12 });
    await page.mouse.up();
    const records = async () => {
      await page.keyboard.press('Control+s');
      return page.evaluate(
        async ({ kind }) => {
          try {
            const ext = kind === 'Ink page' ? 'ink' : kind.toLowerCase();
            const vault = await (
              await navigator.storage.getDirectory()
            ).getDirectoryHandle(`Connections ${kind}`);
            const bytes = await (
              await (await vault.getFileHandle(`Connections.${ext}`)).getFile()
            ).text();
            const found: Record<string, unknown>[] = [];
            const visit = (value: unknown): void => {
              if (value === null || typeof value !== 'object') return;
              const obj = value as Record<string, unknown>;
              if (
                typeof obj.type === 'string' &&
                obj.type.startsWith('froglight.') &&
                typeof obj.id === 'string'
              )
                found.push(obj);
              else Object.values(obj).forEach(visit);
            };
            visit(JSON.parse(bytes));
            return found;
          } catch {
            return [];
          }
        },
        { kind },
      );
    };
    await page.screenshot({
      path: test.info().outputPath('after-connection.png'),
    });
    await expect
      .poll(
        async () =>
          (await records()).filter((r) => r.type === 'froglight.line').length,
      )
      .toBe(1);
    const connected = await records();
    const line = connected.find((r) => r.type === 'froglight.line')!;
    const first = connected.find((r) => r.text === 'Source')!;
    const second = connected.find((r) => r.text === 'Target')!;
    expect(line.source).toEqual({ objectId: first.id, anchor: 's' });
    expect(line.target).toEqual({ objectId: second.id, anchor: 'n' });
    expect(connected.filter((r) => r.type === 'froglight.card')).toHaveLength(
      0,
    );
    // With Text still active, the body moves; the arrow follows its target.
    await page.mouse.click(target.x + 16, target.y + target.height / 2);
    const menu = page.getByRole('toolbar', { name: 'Object menu' });
    await expect
      .poll(async () => (await menu.boundingBox())!.y)
      .toBeGreaterThan(target.y - 75);
    await page.mouse.down();
    const beforeDrag = await menu.boundingBox();
    expect(beforeDrag).not.toBeNull();
    await page.mouse.move(target.x + 46, target.y + target.height / 2 + 30, {
      steps: 8,
    });
    await expect
      .poll(async () => (await menu.boundingBox())!.y)
      .toBeCloseTo(beforeDrag!.y + 30, 0);
    await page.screenshot({
      path: test.info().outputPath('during-connected-drag.png'),
    });
    await page.mouse.up();
    await expect(editor).toHaveCount(0);
    await expect
      .poll(async () => (await records()).find((r) => r.id === second.id)?.y)
      .not.toBe(second.y);
    const moved = (await records()).find((r) => r.id === line.id)!;
    expect(moved.y2).not.toBe(line.y2);
    await page.keyboard.press('Control+z');
    await expect
      .poll(async () => (await records()).find((r) => r.id === second.id)?.y)
      .toBe(second.y);
    // Resize the right border while Text is active, without reopening editing.
    await page.mouse.move(
      target.x + target.width,
      target.y + target.height / 2,
    );
    await expect(canvas).toHaveCSS('cursor', 'ew-resize');
    await page.mouse.down();
    await page.mouse.move(
      target.x + target.width + 45,
      target.y + target.height / 2,
      { steps: 5 },
    );
    await page.mouse.up();
    await expect(editor).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (
            (await records()).find((r) => r.id === second.id)?.appearance as
              | { wrapWidth?: number }
              | undefined
          )?.wrapWidth ?? 0,
      )
      .toBeGreaterThan(40);
    await page.keyboard.press('Control+z');
    // Select the line itself and delete it, then restore it in one undo.
    await page.mouse.click((sx + tx) / 2, (sy + ty) / 2);
    await expect(
      page
        .getByRole('toolbar', { name: 'Object menu' })
        .getByRole('spinbutton', { name: 'Font size' }),
    ).toHaveCount(0);
    await menu
      .getByLabel('Connector path', { exact: true })
      .selectOption('curved');
    await expect
      .poll(async () => (await records()).find((r) => r.id === line.id)?.path)
      .toBe('curved');
    await menu.getByLabel('Arrowheads', { exact: true }).selectOption('both');
    await expect
      .poll(async () => (await records()).find((r) => r.id === line.id)?.arrows)
      .toBe('both');
    await menu
      .getByRole('group', { name: 'Quick colors' })
      .getByRole('button')
      .nth(1)
      .click();
    await expect
      .poll(async () => (await records()).find((r) => r.id === line.id)?.color)
      .toBe('#7c6cf0');
    await menu
      .getByRole('button', { name: 'Delete selection', exact: true })
      .click();
    await expect
      .poll(async () => (await records()).some((r) => r.id === line.id))
      .toBe(false);
    await page.keyboard.press('Control+z');
    await expect
      .poll(async () => (await records()).some((r) => r.id === line.id))
      .toBe(true);
  });
}

test('Whiteboard cards contain text and shapes offer fill and extra geometry', async ({
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
    .fill('Card and shape checks');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();
  await createNote(page, 'Objects', /Whiteboard/);
  const categories = page.getByRole('toolbar', {
    name: 'Document tool categories',
  });
  await categories.getByRole('button', { name: 'Insert', exact: true }).click();
  await page.getByRole('button', { name: 'Card', exact: true }).click();
  const canvas = page.locator('.fl-ink-canvas');
  const bounds = (await canvas.boundingBox())!;
  const x = bounds.x + 240,
    y = bounds.y + 220;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 160, y + 100, { steps: 6 });
  await page.mouse.up();
  const editor = page.locator('.fl-ink-text-input');
  await expect(editor).toBeVisible();
  await editor.fill(
    'A card with a long description that must wrap inside its own margins. '.repeat(
      6,
    ),
  );
  const editingBox = (await editor.boundingBox())!;
  expect(editingBox.x).toBeGreaterThan(x);
  expect(editingBox.x + editingBox.width).toBeLessThanOrEqual(x + 161);
  expect(editingBox.y + editingBox.height).toBeLessThanOrEqual(y + 101);
  await page.screenshot({ path: test.info().outputPath('card-editing.png') });
  await editor.press('Control+Enter');
  await expect(editor).toHaveCount(0);
  await categories
    .getByRole('button', { name: 'Selection', exact: true })
    .click();
  await page.mouse.click(x + 20, y + 20);
  const menu = page.getByRole('toolbar', { name: 'Object menu' });
  await expect(menu.getByLabel('Card font size')).toBeVisible();
  await expect(
    menu.getByRole('button', { name: 'Card background', exact: true }).first(),
  ).toBeVisible();
  await menu
    .getByRole('button', { name: 'Card background', exact: true })
    .nth(1)
    .click();
  await menu.getByLabel('Card font size').fill('22');
  await page.mouse.click(bounds.x + 100, bounds.y + 150);
  await categories.getByRole('button', { name: 'Shapes', exact: true }).click();
  const shelf = page.locator('[data-tool-shelf="surface.shapes"]');
  for (const name of ['Triangle', 'Diamond'])
    await expect(
      shelf.getByRole('button', { name, exact: true }),
    ).toBeVisible();
  await shelf.getByRole('button', { name: 'Triangle', exact: true }).click();
  await shelf.getByLabel('Shape fill', { exact: true }).selectOption('outline');
  await page.mouse.move(x + 280, y);
  await page.mouse.down();
  await page.mouse.move(x + 430, y + 130, { steps: 6 });
  await page.mouse.up();
  await categories
    .getByRole('button', { name: 'Selection', exact: true })
    .click();
  await page.mouse.click(x + 355, y + 70);
  await expect(menu.getByLabel('Shape', { exact: true })).toHaveValue(
    'triangle',
  );
  await page.screenshot({
    path: test.info().outputPath('card-and-outline-triangle.png'),
  });
});

test('Text wrapping uses the visible font instead of a character-count estimate', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: undefined,
      configurable: true,
    });
    const paints: string[] = [];
    (window as unknown as { surfaceTextPaints: string[] }).surfaceTextPaints =
      paints;
    const draw = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (
      text,
      x,
      y,
      maxWidth,
    ) {
      if (text.includes('iiii')) paints.push(text);
      if (maxWidth === undefined) draw.call(this, text, x, y);
      else draw.call(this, text, x, y, maxWidth);
    };
  });
  await page.goto('/');
  await page.getByTestId('create-vault-button').click();
  await page.getByTestId('create-vault-name-input').fill('Text width check');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();
  await createNote(page, 'Text width', /Whiteboard/);
  await expectTextFormattingShelf(page);
  const shelf = page.locator('[data-tool-shelf="surface.text"]');
  await shelf.getByLabel('Font size', { exact: true }).fill('41');
  await shelf.getByLabel('Wrap text', { exact: true }).click();
  const canvas = page.locator('.fl-ink-canvas');
  await canvas.click({ position: { x: 300, y: 260 } });
  const editor = page.locator('.fl-ink-text-input');
  const text = 'iiiiiiiiiiiiiiiiiiii';
  await editor.fill(text);
  await editor.press('Control+Enter');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { surfaceTextPaints: string[] })
            .surfaceTextPaints,
      ),
    )
    .toContain(text);
  await canvas.click({ position: { x: 310, y: 270 } });
  // Only the rendered line height exposes the right-edge resize affordance.
  const inputOrigin = { x: 300, y: 260 };
  await page.mouse.move(
    (await canvas.boundingBox())!.x + inputOrigin.x + 240,
    (await canvas.boundingBox())!.y + inputOrigin.y + 45,
  );
  await expect(canvas).toHaveCSS('cursor', 'ew-resize');
  await page.mouse.move(
    (await canvas.boundingBox())!.x + inputOrigin.x + 240,
    (await canvas.boundingBox())!.y + inputOrigin.y + 100,
  );
  await expect(canvas).not.toHaveCSS('cursor', 'ew-resize');
  await page.screenshot({
    path: test.info().outputPath('text-width-and-chrome.png'),
  });
});

for (const kind of ['Ink page', 'Notebook', 'Whiteboard']) {
  test(`${kind}: shapes share editable slots and corner radius with selection`, async ({
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
      .fill(`Shape slots ${kind}`);
    await page.getByTestId('choose-vault-location-button').click();
    await page.getByTestId('confirm-create-vault-button').click();
    await createNote(page, 'Shapes', new RegExp(kind));
    const categories = page.getByRole('toolbar', {
      name: 'Document tool categories',
    });
    await categories
      .getByRole('button', { name: 'Shapes', exact: true })
      .click();
    const shelf = page.locator('[data-tool-shelf="surface.shapes"]');
    await expect(
      shelf.getByRole('button', { name: 'Rounded rectangle', exact: true }),
    ).toHaveCount(0);
    await shelf.getByRole('button', { name: 'Rectangle', exact: true }).click();
    const colors = shelf.locator('button[data-slot-kind="color"]');
    const widths = shelf.locator('button[data-slot-kind="size"]');
    await expect(colors).toHaveCount(3);
    await expect(widths).toHaveCount(3);
    await widths.nth(0).dblclick();
    await page
      .getByRole('dialog', { name: 'Edit size slot 1', exact: true })
      .getByLabel('Slot width in points')
      .fill('6.5');
    await page.keyboard.press('Escape');
    await colors.nth(0).dblclick();
    await page
      .getByRole('dialog', { name: 'Edit color slot 1', exact: true })
      .getByRole('textbox', { name: 'Slot color value' })
      .fill('#336699');
    await page.keyboard.press('Escape');
    await shelf
      .getByLabel('Shape fill', { exact: true })
      .selectOption('outline');
    await shelf.getByLabel('Corner radius', { exact: true }).fill('18');
    const canvas = page.locator('.fl-ink-canvas');
    const box = (await canvas.boundingBox())!;
    const x = box.x + box.width / 2,
      y = box.y + 260;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 180, y + 130, { steps: 6 });
    await page.mouse.up();
    await categories
      .getByRole('button', { name: 'Selection', exact: true })
      .click();
    await page.mouse.click(x + 40, y + 40);
    const menu = page.getByRole('toolbar', { name: 'Object menu' });
    await expect(menu.locator('button[data-slot-kind="color"]')).toHaveCount(3);
    await expect(menu.locator('button[data-slot-kind="size"]')).toHaveCount(3);
    await expect(menu.getByLabel('Corner radius', { exact: true })).toHaveValue(
      '18',
    );
    await menu.getByLabel('Corner radius', { exact: true }).fill('28');
    await menu.locator('button[data-slot-kind="size"]').nth(0).dblclick();
    const sizeDialog = page.getByRole('dialog', {
      name: 'Edit size slot 1',
      exact: true,
    });
    await expect(sizeDialog.getByLabel('Slot width in points')).toHaveValue(
      '6.5',
    );
    await sizeDialog.getByLabel('Slot width in points').fill('9');
    await page.keyboard.press('Escape');
    await menu.locator('button[data-slot-kind="color"]').nth(0).dblclick();
    const colorDialog = page.getByRole('dialog', {
      name: 'Edit color slot 1',
      exact: true,
    });
    await expect(
      colorDialog.getByRole('textbox', { name: 'Slot color value' }),
    ).toHaveValue('#336699');
    await colorDialog
      .getByRole('textbox', { name: 'Slot color value' })
      .fill('#448361');
    await page.keyboard.press('Escape');
    await page.screenshot({
      path: test.info().outputPath('shape-radius-and-slots.png'),
    });
    await categories
      .getByRole('button', { name: 'Shapes', exact: true })
      .click();
    await shelf.getByRole('button', { name: 'Triangle', exact: true }).click();
    await widths.nth(0).dblclick();
    await expect(
      page
        .getByRole('dialog', { name: 'Edit size slot 1', exact: true })
        .getByLabel('Slot width in points'),
    ).toHaveValue('9');
    await page.keyboard.press('Escape');
    await expect(colors.nth(0).locator('span')).toHaveCSS(
      'background-color',
      'rgb(68, 131, 97)',
    );
    await shelf.getByRole('button', { name: 'Ellipse', exact: true }).click();
    await expect(
      shelf.getByLabel('Corner radius', { exact: true }),
    ).toBeDisabled();
  });
}
