import { setDocumentPresentation } from './support/document-presentation.js';
import { createFromSidebar } from './support/sidebar-create.js';
import { expect, test, type Page } from '@playwright/test';

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
    .fill('First pan disposable');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();
}

async function createDrawing(
  page: Page,
  name: string,
  kind: RegExp,
): Promise<void> {
  await createFromSidebar(page, kind);
  await page.getByRole('textbox', { name: 'Note name' }).fill(name);
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  await expect(page.getByRole('tab', { name: new RegExp(name) }))
    .toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.fl-ink-canvas:visible')).toBeVisible();
}

async function drawingSnapshot(page: Page, name: string) {
  return page.evaluate(async (name) => {
    const vault = await (await navigator.storage.getDirectory()).getDirectoryHandle('First pan disposable');
    for await (const entry of vault.values()) {
      if (entry.kind === 'file' && entry.name.startsWith(`${name}.`)) {
        const file = await (await vault.getFileHandle(entry.name)).getFile();
        return { name, text: await file.text(), modified: file.lastModified };
      }
    }
    throw new Error(`Missing drawing: ${name}`);
  }, name);
}

async function expectUnchangedDrawing(page: Page, before: Awaited<ReturnType<typeof drawingSnapshot>>) {
  await page.keyboard.press('Control+s');
  // Wait for the real save to finish before comparing canonical content.
  await expect.poll(async () => (await drawingSnapshot(page, before.name)).modified)
    .toBeGreaterThan(before.modified);
  expect((await drawingSnapshot(page, before.name)).text).toBe(before.text);
}

async function zoomInTo(page: Page, targetPercent: number): Promise<void> {
  const zoomIn = page.getByRole('button', { name: 'Zoom in', exact: true });
  const zoomLabel = zoomIn.locator('xpath=preceding-sibling::button[1]');
  const readPercent = async (): Promise<number> =>
    Number.parseInt((await zoomLabel.textContent()) ?? '', 10);
  for (let step = 0; step < 30; step += 1) {
    const before = await readPercent();
    if (before >= targetPercent) return;
    await zoomIn.click();
    await expect.poll(readPercent).toBeGreaterThan(before);
    // Toolbar zoom keeps the polished spring preview. Let its canonical
    // camera/stack target settle before deriving the next multiplicative step.
    await page.waitForTimeout(450);
  }
  throw new Error(`Zoom did not reach ${targetPercent}%`);
}

test('view mode pans Ink, Whiteboard, and Notebook with a primary mouse drag', async ({
  page,
}) => {
  await createVault(page);
  for (const [name, kind] of [
    ['View pan ink', /Ink page/],
    ['View pan whiteboard', /Whiteboard/],
    ['View pan notebook', /Notebook/],
  ] as const) {
    await createDrawing(page, name, kind);
    const before = await drawingSnapshot(page, name);
    await expect(
      page.getByRole('tab', { name: new RegExp(name) }),
    ).toHaveAttribute('aria-selected', 'true');
    await setDocumentPresentation(page, 'View');
    const canvas = page.locator('.fl-ink-canvas:visible').first();
    const root = canvas.locator(
      'xpath=ancestor::*[contains(@class,"fl-ink-root")][1]',
    );
    await expect(root).toHaveAttribute('data-read-only', 'true');
    const box = await canvas.boundingBox();
    if (box === null) throw new Error(`${name} canvas has no layout`);
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.mouse.move(center.x, center.y);
    await page.mouse.down();
    await page.mouse.move(center.x + 80, center.y + 40, { steps: 8 });
    await expect(root.locator('.fl-ink-page')).toHaveClass(/panning/);
    await page.mouse.up();
    await expect(root.locator('.fl-ink-page')).not.toHaveClass(/panning/);
    await setDocumentPresentation(page, 'Edit');
    await expectUnchangedDrawing(page, before);
  }
});

test('the first real Space or middle-button drag pans without authoring', async ({
  page,
}) => {
  await createVault(page);
  await createDrawing(page, 'Pan proof', /Ink page/);
  const before = await drawingSnapshot(page, 'Pan proof');
  const canvas = page.locator('.fl-ink-canvas:visible');
  const zoomIn = page.getByRole('button', { name: 'Zoom in', exact: true });

  // Leave keyboard focus on a real toolbar control, matching the reported
  // first-interaction state rather than dispatching a synthetic root event.
  await zoomIn.click();
  await zoomIn.click();
  await zoomIn.click();
  await expect(zoomIn).toBeFocused();

  const box = await canvas.boundingBox();
  if (box === null) throw new Error('Ink canvas has no layout');
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(center.x, center.y);
  const beforeFirst = await canvas.screenshot();

  await page.keyboard.down('Space');
  await expect
    .poll(() => canvas.evaluate((node) => getComputedStyle(node).cursor))
    .toBe('grab');
  await page.mouse.down();
  await page.mouse.move(center.x + 10, center.y + 5);
  await expect
    .poll(() => canvas.evaluate((node) => getComputedStyle(node).cursor))
    .toBe('grabbing');
  await page.mouse.move(center.x + 90, center.y + 45, { steps: 8 });
  const duringFirst = await canvas.screenshot();
  await page.mouse.up();
  await page.keyboard.up('Space');
  expect(duringFirst.equals(beforeFirst)).toBe(false);

  const beforeSecond = await canvas.screenshot();
  await page.keyboard.down('Space');
  await page.mouse.down();
  await page.mouse.move(center.x + 20, center.y + 10, { steps: 8 });
  const duringSecond = await canvas.screenshot();
  await page.mouse.up();
  await page.keyboard.up('Space');
  expect(duringSecond.equals(beforeSecond)).toBe(false);

  // Explicit middle-button navigation also wins over an authoring tool.
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.mouse.move(center.x, center.y);
  const beforeMiddle = await canvas.screenshot();
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(center.x - 70, center.y - 35, { steps: 8 });
  const duringMiddle = await canvas.screenshot();
  await page.mouse.up({ button: 'middle' });
  expect(duringMiddle.equals(beforeMiddle)).toBe(false);
  await expect(page.locator('.fl-ink-text-input')).toHaveCount(0);
  await expectUnchangedDrawing(page, before);
});

test('Ink desktop pan rubber-bands at the edge and returns after release', async ({
  page,
}) => {
  await createVault(page);
  await createDrawing(page, 'Elastic desktop pan', /Ink page/);
  const before = await drawingSnapshot(page, 'Elastic desktop pan');
  const canvas = page.locator('.fl-ink-canvas:visible');
  const box = await canvas.boundingBox();
  if (box === null) throw new Error('Ink canvas has no layout');
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(center.x, center.y);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, 1_000);
  await page.keyboard.up('Control');
  await expect(page.getByRole('button', { name: 'zoom 25%' })).toBeVisible();
  await page.waitForTimeout(500);

  const pixels = () =>
    canvas.evaluate((node) => (node as HTMLCanvasElement).toDataURL());
  const centered = await pixels();
  await page.keyboard.down('Space');
  await page.mouse.down();
  await page.mouse.move(center.x + 250, center.y, { steps: 10 });
  const displaced = await pixels();
  expect(displaced).not.toBe(centered);
  await page.mouse.up();
  await page.keyboard.up('Space');
  await expect.poll(pixels, { timeout: 3_000 }).toBe(centered);
  await expectUnchangedDrawing(page, before);
});

test('saturated Ink and Whiteboard wheel zoom stays anchored and reverses immediately', async ({
  page,
}) => {
  await createVault(page);
  for (const [name, kind] of [
    ['Ink zoom proof', /Ink page/],
    ['Whiteboard zoom proof', /Whiteboard/],
  ] as const) {
    await createDrawing(page, name, kind);
    const canvas = page.locator('.fl-ink-canvas:visible');
    const zoomLabel = page.getByRole('button', { name: /zoom \d+%/i });
    const box = await canvas.boundingBox();
    if (box === null) throw new Error(`${name} canvas has no layout`);
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.35);
    for (let step = 0; step < 3; step += 1) {
      await page.keyboard.down('Control');
      await page.mouse.wheel(0, -1_000);
      await page.keyboard.up('Control');
      await page.waitForTimeout(300);
    }
    await expect(zoomLabel).toHaveText('800%');

    const saturated = await canvas.evaluate((node) =>
      (node as HTMLCanvasElement).toDataURL(),
    );
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -120);
    await page.keyboard.up('Control');
    await page.waitForTimeout(250);
    expect(
      await canvas.evaluate((node) => (node as HTMLCanvasElement).toDataURL()),
    ).toBe(saturated);
    await expect(zoomLabel).toHaveText('800%');

    await page.keyboard.down('Control');
    await page.mouse.wheel(0, 120);
    await page.keyboard.up('Control');
    await expect
      .poll(async () =>
        Number.parseInt((await zoomLabel.textContent()) ?? '', 10),
      )
      .toBeLessThan(800);
  }
});

test('Notebook desktop pan stays pager-owned and zoom re-rasterizes the page', async ({
  page,
}) => {
  await createVault(page);
  await createDrawing(page, 'Notebook navigation proof', /Notebook/);

  const canvas = page.locator('.fl-nb-shell:visible .fl-ink-canvas');
  const scroll = page.locator('.fl-nb-scroll:visible');
  const shell = page.locator('.fl-nb-shell:visible').first();
  const stack = page.locator('.fl-nb-stack:visible');
  const gutterLayout = await Promise.all([
    scroll.boundingBox(),
    shell.boundingBox(),
    shell.evaluate((node) => {
      const bounds = node.getBoundingClientRect();
      return bounds.left + bounds.width / 2;
    }),
  ]);
  if (gutterLayout[0] === null || gutterLayout[1] === null)
    throw new Error('Notebook gutter has no layout');
  await stack.evaluate((node) => {
    const tracked = node as HTMLElement & {
      __motionProbe?: { values: string[]; observer: MutationObserver };
    };
    const values: string[] = [];
    const observer = new MutationObserver(() =>
      values.push(node.style.transform),
    );
    observer.observe(node, { attributes: true, attributeFilter: ['style'] });
    tracked.__motionProbe = { values, observer };
  });
  const gutterPoint = {
    x: (gutterLayout[0].x + gutterLayout[1].x) / 2,
    y:
      (Math.max(gutterLayout[0].y, gutterLayout[1].y) +
        Math.min(
          gutterLayout[0].y + gutterLayout[0].height,
          gutterLayout[1].y + gutterLayout[1].height,
        )) /
      2,
  };
  await page.mouse.move(gutterPoint.x, gutterPoint.y);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -100);
  await page.keyboard.up('Control');
  await expect
    .poll(() =>
      page
        .locator('.fl-nb:visible')
        .evaluate((node) => Number(node.getAttribute('data-zoom'))),
    )
    .toBeGreaterThan(100);
  await expect(stack).toHaveCSS('transform', 'none', { timeout: 5_000 });
  const gutterMotion = await stack.evaluate((node) => {
    const tracked = node as HTMLElement & {
      __motionProbe?: { values: string[]; observer: MutationObserver };
    };
    const values = [...(tracked.__motionProbe?.values ?? [])];
    tracked.__motionProbe?.observer.disconnect();
    delete tracked.__motionProbe;
    return values;
  });
  expect(gutterMotion.some((value) => value.includes('scale('))).toBe(true);
  expect(
    gutterMotion.some(
      (value) => value.includes('scale(1)') && !value.includes('translate(0px'),
    ),
  ).toBe(true);
  const centeredAfterGutter = await shell.evaluate((node) => {
    const bounds = node.getBoundingClientRect();
    return bounds.left + bounds.width / 2;
  });
  const viewportCenter = gutterLayout[0].x + gutterLayout[0].width / 2;
  // Fractional CSS widths and the viewport border can round by half a pixel.
  expect(Math.abs(centeredAfterGutter - viewportCenter)).toBeLessThanOrEqual(1);

  const initialZoom = await Promise.all([
    shell.evaluate((node) => node.getBoundingClientRect().width),
    canvas.evaluate((node) => (node as HTMLCanvasElement).width),
  ]);
  await zoomInTo(page, 250);
  await expect(stack).toHaveCSS('transform', 'none', { timeout: 5_000 });
  await expect
    .poll(() => shell.evaluate((node) => node.getBoundingClientRect().width))
    .toBeGreaterThan(initialZoom[0] * 1.8);
  await expect
    .poll(() => canvas.evaluate((node) => (node as HTMLCanvasElement).width))
    .toBeGreaterThan(initialZoom[1] * 1.8);

  const beforePan = await canvas.evaluate((node) =>
    (node as HTMLCanvasElement).toDataURL(),
  );
  const scrollBeforePan = await scroll.evaluate((node) => node.scrollTop);
  const scrollBox = await scroll.boundingBox();
  const canvasBox = await canvas.boundingBox();
  if (scrollBox === null) throw new Error('Notebook viewport has no layout');
  if (canvasBox === null) throw new Error('Notebook canvas has no layout');

  const panPoint = {
    x:
      (Math.max(scrollBox.x, canvasBox.x) +
        Math.min(
          scrollBox.x + scrollBox.width,
          canvasBox.x + canvasBox.width,
        )) /
      2,
    y:
      (Math.max(scrollBox.y, canvasBox.y) +
        Math.min(
          scrollBox.y + scrollBox.height,
          canvasBox.y + canvasBox.height,
        )) /
      2,
  };
  await page.mouse.move(panPoint.x, panPoint.y);
  await page.keyboard.down('Space');
  await page.mouse.down();
  await page.mouse.move(panPoint.x, panPoint.y + 160, {
    steps: 8,
  });
  await expect
    .poll(() => scroll.evaluate((node) => node.scrollTop))
    .not.toBe(scrollBeforePan);
  await page.mouse.up();
  await page.keyboard.up('Space');
  // Pager movement changes the page's viewport position, not its private
  // content camera. Capturing the canvas itself therefore remains identical.
  expect(
    await canvas.evaluate((node) => (node as HTMLCanvasElement).toDataURL()),
  ).toBe(beforePan);

  const beforeZoom = await Promise.all([
    shell.evaluate((node) => node.getBoundingClientRect().width),
    canvas.evaluate((node) => ({
      backingWidth: (node as HTMLCanvasElement).width,
      cssWidth: node.getBoundingClientRect().width,
    })),
  ]);
  await zoomInTo(page, 400);
  await expect(stack).toHaveCSS('transform', 'none', { timeout: 5_000 });
  await expect
    .poll(() =>
      page
        .locator('.fl-nb:visible')
        .evaluate((node) => Number(node.getAttribute('data-zoom'))),
    )
    .toBeGreaterThanOrEqual(400);

  await expect
    .poll(() => shell.evaluate((node) => node.getBoundingClientRect().width))
    .toBeGreaterThan(beforeZoom[0] * 1.35);
  const afterZoom = await canvas.evaluate((node) => ({
    backingWidth: (node as HTMLCanvasElement).width,
    backingHeight: (node as HTMLCanvasElement).height,
    cssWidth: node.getBoundingClientRect().width,
    cssHeight: node.getBoundingClientRect().height,
  }));
  expect(afterZoom.backingWidth).toBeGreaterThan(
    beforeZoom[1].backingWidth * 1.35,
  );
  // At this zoom the mobile-safe backing-store cap reduces DPR uniformly.
  expect(Math.max(afterZoom.backingWidth, afterZoom.backingHeight)).toBe(4096);
  expect(afterZoom.backingWidth / afterZoom.cssWidth).toBeCloseTo(
    afterZoom.backingHeight / afterZoom.cssHeight,
    2,
  );

  // Reach the real minimum with wheel input, then prove further outward
  // ticks do not temporarily scale/rasterize the paper template.
  const latestCanvasBox = await canvas.boundingBox();
  if (latestCanvasBox === null) throw new Error('Notebook canvas disappeared');
  const latestScrollBox = await scroll.boundingBox();
  if (latestScrollBox === null)
    throw new Error('Notebook viewport disappeared');
  await page.mouse.move(
    (Math.max(latestCanvasBox.x, latestScrollBox.x) +
      Math.min(
        latestCanvasBox.x + latestCanvasBox.width,
        latestScrollBox.x + latestScrollBox.width,
      )) /
      2,
    (Math.max(latestCanvasBox.y, latestScrollBox.y) +
      Math.min(
        latestCanvasBox.y + latestCanvasBox.height,
        latestScrollBox.y + latestScrollBox.height,
      )) /
      2,
  );
  for (let step = 0; step < 4; step += 1) {
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, 1_000);
    await page.keyboard.up('Control');
    await page.waitForTimeout(300);
  }
  await expect(page.locator('.fl-nb:visible')).toHaveAttribute(
    'data-zoom',
    '25',
  );
  await expect(stack).toHaveCSS('transform', 'none', { timeout: 5_000 });
  const minimumPaper = await shell.screenshot();
  await stack.evaluate((node) => {
    const tracked = node as HTMLElement & {
      __saturatedProbe?: { values: string[]; observer: MutationObserver };
    };
    const values: string[] = [];
    const observer = new MutationObserver(() =>
      values.push(node.style.transform),
    );
    observer.observe(node, { attributes: true, attributeFilter: ['style'] });
    tracked.__saturatedProbe = { values, observer };
  });
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, 240);
  await page.keyboard.up('Control');
  await page.waitForTimeout(250);
  await expect(page.locator('.fl-nb:visible')).toHaveAttribute(
    'data-zoom',
    '25',
  );
  await expect(stack).toHaveCSS('transform', 'none');
  expect((await shell.screenshot()).equals(minimumPaper)).toBe(true);
  expect(
    await stack.evaluate((node) => {
      const tracked = node as HTMLElement & {
        __saturatedProbe?: { values: string[]; observer: MutationObserver };
      };
      const values = [...(tracked.__saturatedProbe?.values ?? [])];
      tracked.__saturatedProbe?.observer.disconnect();
      delete tracked.__saturatedProbe;
      return values;
    }),
  ).toEqual([]);

  // At the horizontal edge, release starts the return spring on the next
  // frame instead of spending seconds in an inertial decay first.
  const minimumCanvasBox = await canvas.boundingBox();
  if (minimumCanvasBox === null)
    throw new Error('Minimum-zoom Notebook canvas has no layout');
  const edgePanPoint = {
    x: minimumCanvasBox.x + minimumCanvasBox.width / 2,
    y: minimumCanvasBox.y + minimumCanvasBox.height / 2,
  };
  await page.mouse.move(edgePanPoint.x, edgePanPoint.y);
  await page.keyboard.down('Space');
  await page.mouse.down();
  await page.mouse.move(edgePanPoint.x + 220, edgePanPoint.y, { steps: 6 });
  const displacement = await stack.evaluate((node) => {
    const match = /translate\(([-\d.]+)px,/.exec(
      (node as HTMLElement).style.transform,
    );
    return match === null ? 0 : Number(match[1]);
  });
  expect(Math.abs(displacement)).toBeGreaterThan(0);
  await page.mouse.up();
  await page.keyboard.up('Space');
  await page.waitForTimeout(50);
  const returning = await stack.evaluate((node) => {
    const match = /translate\(([-\d.]+)px,/.exec(
      (node as HTMLElement).style.transform,
    );
    return match === null ? 0 : Number(match[1]);
  });
  expect(Math.abs(returning)).toBeLessThan(Math.abs(displacement));
  await expect(stack).toHaveCSS('transform', 'none', { timeout: 2_000 });
});
