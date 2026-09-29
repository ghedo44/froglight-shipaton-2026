import { setDocumentPresentation } from './support/document-presentation.js';
import { expect, test, type Page } from '@playwright/test';
import { createFromSidebar } from './support/sidebar-create.js';

async function createVault(page: Page): Promise<void> {
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
    .fill('Surface cursor disposable');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();
}

async function createDrawing(
  page: Page,
  kind: 'Ink' | 'Notebook' | 'Whiteboard',
): Promise<void> {
  await createFromSidebar(page, kind === 'Ink' ? 'Ink page' : kind);
  await page.getByRole('textbox', { name: 'Note name' }).fill(`${kind} cursor`);
  await page.getByRole('radio', { name: new RegExp(kind) }).click();
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  await expect(page.locator('.fl-ink-canvas:visible').first()).toBeVisible();
}

async function stationaryClick(page: Page, name: string): Promise<void> {
  const button = page.getByRole('button', { name, exact: true }).first();
  await expect(button).toBeAttached();
  await button.evaluate((element: HTMLButtonElement) => element.click());
}

async function cursorState(page: Page) {
  return page.evaluate(() => {
    const canvas =
      [...document.querySelectorAll<HTMLCanvasElement>('.fl-ink-canvas')].find(
        (element) => element.offsetParent !== null,
      ) ?? null;
    const indicator =
      canvas?.parentElement?.querySelector<HTMLElement>(
        '.fl-ink-pointer-indicator',
      ) ?? null;
    if (canvas === null || indicator === null)
      throw new Error('cursor host missing');
    const cursor = getComputedStyle(canvas).cursor;
    const style = getComputedStyle(indicator);
    return {
      cursor,
      owner: canvas.dataset.cursorOwner,
      display: style.display,
      width: Number.parseFloat(style.width),
      height: Number.parseFloat(style.height),
      background: style.backgroundColor,
      shadow: style.boxShadow,
      shape: indicator.dataset.cursorShape,
      dashed: indicator.dataset.dashed,
      marker: indicator.dataset.marker,
    };
  });
}

test('shared drawing cursor resolves live tools and owns only the canvas', async ({
  page,
}) => {
  await createVault(page);
  await createDrawing(page, 'Ink');
  const canvas = page.locator('.fl-ink-canvas').first();
  const box = await canvas.boundingBox();
  if (box === null) throw new Error('surface canvas has no layout');
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(point.x, point.y);

  const pen = await cursorState(page);
  expect(pen).toMatchObject({
    cursor: 'none',
    owner: 'custom',
    display: 'block',
    shape: 'circle',
    background: 'rgba(0, 0, 0, 0)',
    shadow: 'none',
  });

  await stationaryClick(page, 'Zoom in');
  const zoomedPen = await cursorState(page);
  expect(zoomedPen.width).toBeGreaterThan(pen.width);
  const widths = page
    .getByRole('group', { name: 'Quick widths' })
    .getByRole('button', { name: 'Size', exact: true });
  await widths.nth(2).evaluate((element: HTMLButtonElement) => element.click());
  expect((await cursorState(page)).width).toBeGreaterThan(zoomedPen.width);

  // Produce real selectable content for semantic selection hover.
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 60, point.y, { steps: 8 });
  await page.mouse.up();

  await stationaryClick(page, 'Highlighter');
  const highlighter = await cursorState(page);
  expect(highlighter.width).toBeGreaterThan(pen.width * 2);

  await stationaryClick(page, 'Eraser');
  expect(await cursorState(page)).toMatchObject({
    cursor: 'none',
    width: 20,
    height: 20,
    dashed: 'true',
    marker: 'stroke-eraser',
  });
  await stationaryClick(page, 'Precision Eraser');
  expect(await cursorState(page)).toMatchObject({
    dashed: 'false',
    marker: 'none',
  });
  await stationaryClick(page, 'Eraser size slot 3: 28');
  expect((await cursorState(page)).width).toBeGreaterThan(20);

  await stationaryClick(page, 'Selection');
  expect(await cursorState(page)).toMatchObject({
    cursor: 'default',
    owner: 'native',
    display: 'none',
  });
  await page.mouse.click(point.x + 30, point.y);
  expect(await cursorState(page)).toMatchObject({
    cursor: 'move',
    display: 'none',
  });
  await stationaryClick(page, 'Lasso');
  expect(await cursorState(page)).toMatchObject({
    cursor: 'none',
    shape: 'lasso',
  });
  await stationaryClick(page, 'Text');
  expect(await cursorState(page)).toMatchObject({
    cursor: 'text',
    display: 'none',
  });
  await stationaryClick(page, 'Shapes');
  expect(await cursorState(page)).toMatchObject({
    cursor: 'crosshair',
    display: 'none',
  });

  // Keyboard panning wins without moving the stationary pointer.
  const root = page.locator('.fl-ink-root').first();
  await root.evaluate((element) =>
    element.dispatchEvent(
      new KeyboardEvent('keydown', { key: ' ', bubbles: true }),
    ),
  );
  expect(await cursorState(page)).toMatchObject({
    cursor: 'grab',
    display: 'none',
  });
  await root.evaluate((element) =>
    element.dispatchEvent(
      new KeyboardEvent('keyup', { key: ' ', bubbles: true }),
    ),
  );

  // Pointer capture may continue the gesture outside, but its cursor may not.
  await stationaryClick(page, 'Eraser');
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width + 30, point.y);
  expect(await cursorState(page)).toMatchObject({
    display: 'none',
    owner: 'native',
  });
  await page.mouse.up();
  await page.mouse.move(point.x, point.y);
  expect(await cursorState(page)).toMatchObject({
    display: 'block',
    owner: 'custom',
  });

  // Read-only transitions replace and restore the stationary affordance.
  await setDocumentPresentation(page, 'View', { stationary: true });
  expect(await cursorState(page)).toMatchObject({
    cursor: 'auto',
    display: 'none',
    owner: 'native',
  });
  await setDocumentPresentation(page, 'Edit', { stationary: true });
  await page.mouse.move(point.x, point.y);
  expect(await cursorState(page)).toMatchObject({
    cursor: 'none',
    display: 'block',
    owner: 'custom',
  });

  await page.mouse.move(20, 20);
  expect(await cursorState(page)).toMatchObject({
    display: 'none',
    owner: 'native',
  });
});

test('Ink, Notebook and Whiteboard share the same cursor presenter', async ({
  page,
}) => {
  await createVault(page);
  for (const kind of ['Ink', 'Notebook', 'Whiteboard'] as const) {
    await createDrawing(page, kind);
    const canvas = page.locator('.fl-ink-canvas:visible').first();
    const box = await canvas.boundingBox();
    if (box === null) throw new Error(`${kind} canvas has no layout`);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
    expect(await cursorState(page)).toMatchObject({
      cursor: 'none',
      owner: 'custom',
      display: 'block',
      shape: 'circle',
    });
  }
});
