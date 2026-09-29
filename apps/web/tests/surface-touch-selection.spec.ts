import { expect, test, type Locator, type Page } from '@playwright/test';
import { createFromSidebar } from './support/sidebar-create.js';

// Real assembled providers and browser pointer capture, using disposable OPFS.
// Chromium touch/Pencil events do not verify physical iPad input behavior.
test.use({ viewport: { width: 1280, height: 1000 }, hasTouch: true });

async function paintedPoint(
  page: Page,
  target?: Locator,
  color: 'dark' | 'red' = 'dark',
) {
  return (target ?? page.locator('.fl-ink-canvas:visible').first()).evaluate(
    (node, color) => {
      const canvas = node as HTMLCanvasElement;
      const context = canvas.getContext('2d');
      if (context === null) throw new Error('Missing canvas context');
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      let minX = canvas.width,
        maxX = -1,
        minY = canvas.height,
        maxY = -1;
      for (let y = 0; y < canvas.height; y += 1) {
        for (let x = 0; x < canvas.width; x += 1) {
          const index = (y * canvas.width + x) * 4;
          if (
            data[index + 3]! > 200 &&
            (color === 'red'
              ? data[index]! > 160 &&
                data[index + 1]! < 130 &&
                data[index + 2]! < 130
              : data[index]! < 100 &&
                data[index + 1]! < 100 &&
                data[index + 2]! < 100)
          ) {
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
          }
        }
      }
      if (maxX < 0) throw new Error('Canvas content has not rendered');
      const rect = canvas.getBoundingClientRect();
      return {
        x: rect.left + (((minX + maxX) / 2) * rect.width) / canvas.width,
        y: rect.top + (((minY + maxY) / 2) * rect.height) / canvas.height,
      };
    },
    color,
  );
}

async function createSurface(
  page: Page,
  kind: string,
  vaultName: string,
  noteName: string,
) {
  await page.addInitScript(() =>
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: undefined,
      configurable: true,
    }),
  );
  await page.goto('/');
  await page.getByTestId('create-vault-button').click();
  await page.getByTestId('create-vault-name-input').fill(vaultName);
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();
  await createFromSidebar(page, kind);
  const dialog = page.getByRole('dialog', { name: 'Create a new note' });
  await dialog.getByRole('textbox', { name: 'Note name' }).fill(noteName);
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
}

for (const kind of ['Ink page', 'Notebook', 'Whiteboard']) {
  test(`${kind}: a finger resizes selected text and an imported image without moving them`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const strokeRect = CanvasRenderingContext2D.prototype.strokeRect;
      CanvasRenderingContext2D.prototype.strokeRect = function (
        x,
        y,
        width,
        height,
      ) {
        // Measure the painted object handle, including clipped Notebook canvases.
        if (
          width === 6 &&
          height === 6 &&
          this.canvas.classList.contains('fl-ink-canvas')
        ) {
          const point = new DOMPoint(x + 3, y + 3).matrixTransform(
            this.getTransform(),
          );
          const rect = this.canvas.getBoundingClientRect();
          (
            window as unknown as { resizeHandle: { x: number; y: number } }
          ).resizeHandle = {
            x: rect.left + (point.x * rect.width) / this.canvas.width,
            y: rect.top + (point.y * rect.height) / this.canvas.height,
          };
        }
        strokeRect.call(this, x, y, width, height);
      };
    });
    await createSurface(page, kind, `Finger resize ${kind}`, 'Resize');
    const canvas = page.locator('.fl-ink-canvas:visible').first();
    await expect(canvas).toBeVisible();
    const categories = page.getByRole('toolbar', {
      name: 'Document tool categories',
    });
    await categories.getByRole('button', { name: 'Text', exact: true }).tap();
    const textTools = page.getByRole('toolbar', {
      name: 'Text tools',
      exact: true,
    });
    await textTools.getByLabel('Wrap text', { exact: true }).click();
    const bounds = (await canvas.boundingBox())!;
    await canvas.tap({
      position: { x: bounds.width * 0.25, y: bounds.height * 0.35 },
    });
    const input = page.locator('.fl-ink-text-input');
    await expect(input).toBeVisible();
    await input.fill('Finger resize');
    await input.press('Control+Enter');
    const point = await paintedPoint(page);
    await page.touchscreen.tap(point.x, point.y);
    const menu = page.getByRole('toolbar', { name: 'Object menu' });
    await expect(menu).toBeVisible();
    const handlePoint = async () => {
      await page.evaluate(() => new Promise(requestAnimationFrame));
      return page.evaluate(
        () =>
          (window as unknown as { resizeHandle: { x: number; y: number } })
            .resizeHandle,
      );
    };
    const record = async (type: string) => {
      await page.keyboard.press('Control+s');
      return page.evaluate(
        async ({ kind, type }) => {
          const extension = kind === 'Ink page' ? 'ink' : kind.toLowerCase();
          const vault = await (
            await navigator.storage.getDirectory()
          ).getDirectoryHandle(`Finger resize ${kind}`);
          const document = JSON.parse(
            await (
              await (await vault.getFileHandle(`Resize.${extension}`)).getFile()
            ).text(),
          );
          const surface =
            kind === 'Notebook'
              ? document.pages[document.pageOrder[0]].surface
              : document;
          return Object.values(surface.objects).find(
            (value) => (value as { type: string }).type === type,
          ) as {
            x: number;
            y: number;
            width?: number;
            height?: number;
            appearance?: { wrapWidth?: number };
          };
        },
        { kind, type },
      );
    };
    const client = await page.context().newCDPSession(page);
    const resize = async (start: { x: number; y: number }) => {
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ ...start, id: 0 }],
      });
      for (let step = 1; step <= 5; step++) {
        await client.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [
            { x: start.x + step * 10, y: start.y + step * 5, id: 0 },
          ],
        });
        await page.evaluate(() => new Promise(requestAnimationFrame));
      }
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
      });
    };
    await expect
      .poll(async () => (await record('froglight.text'))?.appearance?.wrapWidth)
      .toBeGreaterThan(0);
    const textBefore = await record('froglight.text');
    await resize(await handlePoint());
    await expect(input).toHaveCount(0);
    await expect
      .poll(async () => (await record('froglight.text')).appearance?.wrapWidth)
      .toBeGreaterThan(textBefore.appearance!.wrapWidth! + 20);
    expect(await record('froglight.text')).toMatchObject({
      x: textBefore.x,
      y: textBefore.y,
    });
    await page.keyboard.press('Control+z');
    await expect
      .poll(async () => (await record('froglight.text')).appearance?.wrapWidth)
      .toBe(textBefore.appearance!.wrapWidth);
    await categories.getByRole('button', { name: 'Insert', exact: true }).tap();
    const chosen = page.waitForEvent('filechooser');
    await page
      .getByRole('toolbar', { name: 'Insert tools', exact: true })
      .getByRole('button', { name: 'Insert image', exact: true })
      .click();
    const image = await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 200;
      c.height = 120;
      const context = c.getContext('2d')!;
      context.fillStyle = '#c4554d';
      context.fillRect(0, 0, 200, 120);
      return c.toDataURL('image/png').split(',')[1]!;
    });
    await (
      await chosen
    ).setFiles({
      name: 'Resize.png',
      mimeType: 'image/png',
      buffer: Buffer.from(image, 'base64'),
    });
    await expect
      .poll(async () => (await record('froglight.image'))?.width)
      .toBeGreaterThan(50);
    await expect(menu).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath('image-before-resize.png'),
    });
    let imagePoint = { x: 0, y: 0 };
    await expect
      .poll(async () => {
        try {
          imagePoint = await paintedPoint(page, canvas, 'red');
          return true;
        } catch {
          return false;
        }
      })
      .toBe(true);
    await categories.getByRole('button', { name: 'Pen', exact: true }).tap();
    await page.touchscreen.tap(imagePoint.x, imagePoint.y);
    await expect(menu).toBeVisible();
    const imageBefore = await record('froglight.image');
    await resize(await handlePoint());
    await expect
      .poll(async () => (await record('froglight.image')).width)
      .toBeGreaterThan(imageBefore.width! + 20);
    expect(await record('froglight.image')).toMatchObject({
      x: imageBefore.x,
      y: imageBefore.y,
    });
    await page.keyboard.press('Control+z');
    await expect
      .poll(async () => (await record('froglight.image')).width)
      .toBe(imageBefore.width);
    // A second contact hands the resize back to navigation and rolls it back.
    const start = await handlePoint();
    const first = { x: start.x + 30, y: start.y + 25, id: 0 };
    const second = { x: start.x - 120, y: start.y - 80, id: 1 };
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ ...start, id: 0 }],
    });
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [first],
    });
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [first, second],
    });
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [first, { ...second, x: second.x - 30 }],
    });
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    });
    await expect
      .poll(async () => {
        const current = await record('froglight.image');
        return {
          x: current.x,
          y: current.y,
          width: current.width,
          height: current.height,
        };
      })
      .toEqual({
        x: imageBefore.x,
        y: imageBefore.y,
        width: imageBefore.width,
        height: imageBefore.height,
      });
    await expect(
      categories.getByRole('button', { name: 'Pen', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await client.detach();
    await page.screenshot({
      path: test.info().outputPath('finger-resize.png'),
    });
  });

  test(`${kind}: two finger taps edit text and its toolbar follows the selection in a split pane`, async ({
    page,
  }) => {
    await createSurface(page, kind, `Text editing ${kind}`, 'Editing');
    let canvas = page.locator('.fl-ink-canvas:visible').first();
    await expect(canvas).toBeVisible();
    await page
      .getByRole('toolbar', { name: 'Document tool categories' })
      .getByRole('button', { name: 'Text', exact: true })
      .click();
    const bounds = (await canvas.boundingBox())!;
    await canvas.tap({
      position: { x: bounds.width * 0.3, y: bounds.height * 0.45 },
    });
    const input = page.locator('.fl-ink-text-input');
    await expect(input).toBeVisible();
    await input.fill('Edit with a finger');
    await input.press('Control+Enter');
    await page
      .getByRole('tab', { name: /^Editing\./ })
      .click({ button: 'right' });
    await page
      .getByRole('menuitem', { name: 'Split right', exact: true })
      .click();
    await expect(page.locator('[data-pane]')).toHaveCount(2);
    await page
      .getByRole('tab', { name: /^Editing\./ })
      .click({ button: 'right' });
    await page
      .getByRole('menuitem', { name: 'Move to next pane', exact: true })
      .click();
    const pane = page.locator('[data-pane]').last();
    canvas = pane.locator('.fl-ink-canvas:visible').first();
    await expect(canvas).toBeVisible();
    const categories = pane.getByRole('toolbar', {
      name: 'Document tool categories',
    });
    for (const tool of ['Selection', 'Text']) {
      await categories.getByRole('button', { name: tool, exact: true }).click();
      const point = await paintedPoint(page, canvas);
      await page.touchscreen.tap(point.x, point.y);
      await expect(input).toHaveCount(0);
      const menu = pane.getByRole('toolbar', { name: 'Object menu' });
      await expect(menu).toBeVisible();
      await expect
        .poll(async () => {
          const toolbar = (await menu.boundingBox())!;
          const layer = (await pane
            .locator('[data-floating-layer]')
            .boundingBox())!;
          const center = Math.max(
            layer.x + 8 + toolbar.width / 2,
            Math.min(point.x, layer.x + layer.width - 8 - toolbar.width / 2),
          );
          return Math.abs(toolbar.x + toolbar.width / 2 - center);
        })
        .toBeLessThan(20);
      const toolbar = (await menu.boundingBox())!;
      expect(toolbar.y + toolbar.height).toBeLessThan(point.y);
      await page.touchscreen.tap(point.x, point.y);
      await expect(input).toBeFocused();
      await expect(input).toHaveValue('Edit with a finger');
      if (tool === 'Text') {
        const tools = pane.getByRole('toolbar', {
          name: 'Text tools',
          exact: true,
        });
        await tools.getByRole('button', { name: 'Bold', exact: true }).tap();
        await expect(input).toBeFocused();
        await expect(input).toHaveCSS('font-weight', '700');
        await tools.getByRole('button', { name: /^Text color 2:/ }).tap();
        await expect(input).toBeFocused();
        await expect(input).toHaveValue('Edit with a finger');
        await tools.getByRole('button', { name: /^Text color 1:/ }).tap();
        await expect(input).toBeFocused();
      }
      await input.press('Control+Enter');
    }
    if (kind === 'Whiteboard') {
      await categories
        .getByRole('button', { name: 'Selection', exact: true })
        .click();
      const point = await paintedPoint(page, canvas);
      await page.touchscreen.tap(point.x, point.y);
      const layer = (await pane
        .locator('[data-floating-layer]')
        .boundingBox())!;
      const client = await page.context().newCDPSession(page);
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ ...point, id: 0 }],
      });
      for (let step = 1; step <= 8; step++) {
        await client.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [
            {
              x: point.x,
              y: point.y + ((layer.y + 30 - point.y) * step) / 8,
              id: 0,
            },
          ],
        });
        await page.evaluate(() => new Promise(requestAnimationFrame));
      }
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
      });
      await client.detach();
      await expect(input).toHaveCount(0);
      const moved = await paintedPoint(page, canvas);
      const menu = (await pane
        .getByRole('toolbar', { name: 'Object menu' })
        .boundingBox())!;
      expect(menu.y).toBeGreaterThan(moved.y);
      expect(menu.y + menu.height).toBeLessThan(layer.y + layer.height);
    }
    await page.screenshot({
      path: test.info().outputPath('selected-text-split.png'),
    });
  });

  test(`${kind}: finger selects and moves text while Pen stays active, then authoring dismisses`, async ({
    page,
  }) => {
    await createSurface(page, kind, `Touch routing ${kind}`, 'Routing');
    const canvas = page.locator('.fl-ink-canvas:visible').first();
    await expect(canvas).toBeVisible();
    const categories = page.getByRole('toolbar', {
      name: 'Document tool categories',
    });
    await categories.getByRole('button', { name: 'Text', exact: true }).click();
    const bounds = await canvas.boundingBox();
    if (bounds === null) throw new Error('Missing canvas');
    const swipeClient = await page.context().newCDPSession(page);
    const start = {
      x: bounds.x + bounds.width * 0.4,
      y: bounds.y + bounds.height * 0.45,
      id: 0,
    };
    await swipeClient.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [start],
    });
    await swipeClient.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ ...start, y: start.y - 60 }],
    });
    await swipeClient.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    });
    await expect(page.locator('.fl-ink-text-input')).toHaveCount(0);
    await swipeClient.detach();
    await canvas.tap({
      position: { x: bounds.width * 0.4, y: bounds.height * 0.45 },
    });
    const input = page.locator('.fl-ink-text-input');
    await expect(input).toBeVisible();
    await input.fill('Contextual finger text');
    const textTools = page.getByRole('toolbar', {
      name: 'Text tools',
      exact: true,
    });
    await textTools.getByRole('button', { name: 'Bold', exact: true }).tap();
    await expect(input).toBeFocused();
    await expect(input).toHaveCSS('font-weight', '700');
    await textTools.getByRole('button', { name: 'Italic', exact: true }).tap();
    await expect(input).toBeFocused();
    await expect(input).toHaveCSS('font-style', 'italic');
    await textTools.getByRole('button', { name: /^Text color 2:/ }).tap();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('Contextual finger text');
    await textTools.getByRole('button', { name: /^Text color 1:/ }).tap();
    await expect(input).toBeFocused();
    await input.press('Control+Enter');
    await expect(input).toHaveCount(0);
    const pen = categories.getByRole('button', { name: 'Pen', exact: true });
    await pen.click();
    const menu = page.getByRole('toolbar', { name: 'Object menu' });
    await expect(menu).toHaveCount(0);
    await page.evaluate(() => new Promise(requestAnimationFrame));
    let point = await paintedPoint(page);
    const client = await page.context().newCDPSession(page);
    const touch = (
      type: string,
      points: { x: number; y: number; id: number }[],
    ) => client.send('Input.dispatchTouchEvent', { type, touchPoints: points });
    const extension =
      kind === 'Ink page'
        ? 'ink'
        : kind === 'Notebook'
          ? 'notebook'
          : 'whiteboard';
    const saved = () =>
      page.evaluate(
        async ({ kind, extension }) => {
          const vault = await (
            await navigator.storage.getDirectory()
          ).getDirectoryHandle(`Touch routing ${kind}`);
          try {
            return await (
              await (
                await vault.getFileHandle(`Routing.${extension}`)
              ).getFile()
            ).text();
          } catch (error) {
            if (
              error instanceof DOMException &&
              error.name === 'NotReadableError'
            )
              return null;
            throw error;
          }
        },
        { kind, extension },
      );
    await page.keyboard.press('Control+s');
    let beforeSwipe: string | null = null;
    await expect
      .poll(async () => (beforeSwipe = await saved()))
      .toContain('Contextual finger text');
    await touch('touchStart', [{ ...point, id: 0 }]);
    await expect(menu).toHaveCount(0);
    for (let step = 1; step <= 4; step++) {
      await touch('touchMove', [{ x: point.x, y: point.y - step * 15, id: 0 }]);
      await page.evaluate(() => new Promise(requestAnimationFrame));
    }
    const navigated = await paintedPoint(page);
    // Bounded Ink paper resists overscroll; it must still follow the swipe.
    expect(navigated.y).toBeLessThan(point.y - 15);
    await touch('touchEnd', []);
    await expect(menu).toHaveCount(0);
    await page.keyboard.press('Control+s');
    await expect.poll(saved).toBe(beforeSwipe);
    // Stop released navigation before tapping at its current position.
    await touch('touchStart', [
      { x: navigated.x - 250, y: navigated.y, id: 0 },
    ]);
    await touch('touchEnd', []);
    await page.evaluate(() => new Promise(requestAnimationFrame));
    point = await paintedPoint(page);
    await touch('touchStart', [{ ...point, id: 0 }]);
    await touch('touchEnd', []);
    await expect(menu).toBeVisible();
    await expect(pen).toHaveAttribute('aria-pressed', 'true');
    await expect(input).toHaveCount(0);
    // Grab the current selection: real capture owns the move and commits on lift.
    await touch('touchStart', [{ ...point, id: 0 }]);
    for (let step = 1; step <= 4; step++) {
      await touch('touchMove', [
        { x: point.x + step * 10, y: point.y + step * 5, id: 0 },
      ]);
      await page.evaluate(() => new Promise(requestAnimationFrame));
    }
    await touch('touchEnd', []);
    await expect(pen).toHaveAttribute('aria-pressed', 'true');
    const moved = await paintedPoint(page);
    expect(moved.x).toBeGreaterThan(point.x + 25);
    expect(moved.y).toBeGreaterThan(point.y + 10);
    if (kind === 'Notebook') {
      const readSnapshot = () =>
        page.evaluate(async () => {
          const vault = await (
            await navigator.storage.getDirectory()
          ).getDirectoryHandle('Touch routing Notebook');
          const file = await (
            await vault.getFileHandle('Routing.notebook')
          ).getFile();
          return { text: await file.text(), modified: file.lastModified };
        });
      const canonical = async () => {
        const before = (await readSnapshot()).modified;
        await page.keyboard.press('Control+s');
        await expect
          .poll(async () => (await readSnapshot()).modified)
          .toBeGreaterThan(before);
        return (await readSnapshot()).text;
      };
      const beforePinch = await canonical();
      const first = { x: moved.x + 15, y: moved.y + 15, id: 0 };
      const second = { x: moved.x + 160, y: moved.y + 80, id: 1 };
      await touch('touchStart', [{ ...moved, id: 0 }]);
      await touch('touchMove', [first]);
      await page.evaluate(() => new Promise(requestAnimationFrame));
      await touch('touchStart', [first, second]);
      await touch('touchMove', [first, { ...second, x: second.x + 40 }]);
      await expect(page.locator('.fl-nb-stack')).toHaveCSS(
        'transform',
        /matrix\((?!1,)/,
      );
      await touch('touchEnd', []);
      expect(await canonical()).toBe(beforePinch);
    }
    const current = await paintedPoint(page);
    const outside = { x: current.x - 150, y: current.y + 130, id: 0 };
    await touch('touchStart', [outside]);
    await expect(menu).toHaveCount(0);
    await touch('touchEnd', []);
    const target = await paintedPoint(page);
    await touch('touchStart', [{ ...target, id: 0 }]);
    await touch('touchEnd', []);
    await expect(menu).toBeVisible();
    // Same active Pen, same authoring down: dismiss before any move/up.
    const stroke = { x: target.x - 120, y: target.y + 80 };
    const darkPixels = () =>
      canvas.evaluate((node) => {
        const c = node as HTMLCanvasElement;
        const data = c
          .getContext('2d')!
          .getImageData(0, 0, c.width, c.height).data;
        let count = 0;
        for (let i = 0; i < data.length; i += 4)
          if (
            data[i]! < 100 &&
            data[i + 1]! < 100 &&
            data[i + 2]! < 100 &&
            data[i + 3]! > 200
          )
            count += 1;
        return count;
      });
    const beforeStroke = await darkPixels();
    await client.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      pointerType: 'pen',
      button: 'left',
      buttons: 1,
      force: 0.5,
      ...stroke,
    });
    await expect(menu).toHaveCount(0);
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      pointerType: 'pen',
      buttons: 1,
      force: 0.5,
      x: stroke.x + 20,
      y: stroke.y + 20,
    });
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      pointerType: 'pen',
      button: 'left',
      buttons: 0,
      x: stroke.x + 40,
      y: stroke.y + 40,
    });
    await expect.poll(darkPixels).toBeGreaterThan(beforeStroke + 20);
    await expect(pen).toHaveAttribute('aria-pressed', 'true');
    await page.screenshot({
      path: test.info().outputPath('touch-routing.png'),
    });
    await client.detach();
  });
}

for (const kind of ['Ink page', 'Notebook', 'Whiteboard']) {
  test(`${kind}: Select distinguishes a figure tap from scrolling and cancels a drag on pinch`, async ({
    page,
  }) => {
    await createSurface(page, kind, `Figure routing ${kind}`, 'Figures');
    const canvas = page.locator('.fl-ink-canvas:visible').first();
    await expect(canvas).toBeVisible();
    const categories = page.getByRole('toolbar', {
      name: 'Document tool categories',
    });
    await categories.getByRole('button', { name: 'Shapes', exact: true }).tap();
    await page
      .getByRole('toolbar', { name: 'Shapes tools' })
      .getByRole('button', { name: 'Rectangle', exact: true })
      .tap();
    const bounds = await canvas.boundingBox();
    if (bounds === null) throw new Error('Missing canvas');
    await page.mouse.move(
      bounds.x + bounds.width * 0.35,
      bounds.y + bounds.height * 0.4,
    );
    await page.mouse.down();
    await page.mouse.move(
      bounds.x + bounds.width * 0.5,
      bounds.y + bounds.height * 0.5,
      { steps: 4 },
    );
    await page.mouse.up();
    await categories
      .getByRole('button', { name: 'Selection', exact: true })
      .tap();
    await page
      .getByRole('toolbar', { name: 'Selection tools' })
      .getByRole('button', { name: 'Select', exact: true })
      .tap();
    const menu = page.getByRole('toolbar', { name: 'Object menu' });
    const extension =
      kind === 'Ink page'
        ? 'ink'
        : kind === 'Notebook'
          ? 'notebook'
          : 'whiteboard';
    const saved = () =>
      page.evaluate(
        async ({ kind, extension }) => {
          const vault = await (
            await navigator.storage.getDirectory()
          ).getDirectoryHandle(`Figure routing ${kind}`);
          return (
            await (await vault.getFileHandle(`Figures.${extension}`)).getFile()
          ).text();
        },
        { kind, extension },
      );
    await page.keyboard.press('Control+s');
    await expect.poll(saved).toContain('froglight.rectangle');
    const before = await saved();
    const client = await page.context().newCDPSession(page);
    const touch = (
      type: string,
      touchPoints: { x: number; y: number; id: number }[],
    ) => client.send('Input.dispatchTouchEvent', { type, touchPoints });
    let point = await paintedPoint(page);
    await touch('touchStart', [{ ...point, id: 0 }]);
    await touch('touchMove', [{ x: point.x, y: point.y - 60, id: 0 }]);
    await touch('touchEnd', []);
    await expect(menu).toHaveCount(0);
    await page.keyboard.press('Control+s');
    expect(await saved()).toBe(before);
    // Stop released navigation before targeting the moving page bitmap.
    await touch('touchStart', [
      {
        x: bounds.x + bounds.width * 0.7,
        y: bounds.y + bounds.height * 0.65,
        id: 0,
      },
    ]);
    await touch('touchEnd', []);
    await page.evaluate(async () => {
      for (let frame = 0; frame < 2; frame++)
        await new Promise(requestAnimationFrame);
    });
    point = await paintedPoint(page);
    await touch('touchStart', [{ ...point, id: 0 }]);
    await touch('touchEnd', []);
    await expect(menu).toBeVisible();
    point = await paintedPoint(page);
    const first = { x: point.x + 20, y: point.y + 20, id: 0 };
    const second = { x: point.x + 120, y: point.y + 80, id: 1 };
    await touch('touchStart', [{ ...point, id: 0 }]);
    await touch('touchMove', [first]);
    await touch('touchStart', [first, second]);
    await touch('touchMove', [first, { ...second, x: second.x + 40 }]);
    await touch('touchEnd', []);
    await page.keyboard.press('Control+s');
    expect(await saved()).toBe(before);
    await page.screenshot({
      path: test.info().outputPath('figure-routing.png'),
    });
    await client.detach();
  });
}
