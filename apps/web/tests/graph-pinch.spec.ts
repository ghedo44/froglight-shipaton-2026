import { expect, test } from '@playwright/test';

test.use({ hasTouch: true, viewport: { width: 820, height: 1180 } });

test('two fingers zoom the graph around their midpoint without flinging nodes', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByTestId('open-recent-vault-button-0').click();
  await expect(page.locator('.flbp-host').first()).toBeVisible();
  await page.evaluate(() => {
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    const arc = CanvasRenderingContext2D.prototype.arc;
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      this.canvas.dataset['nodes'] = '[]';
      return clear.apply(this, args);
    };
    CanvasRenderingContext2D.prototype.arc = function (...args) {
      const nodes = JSON.parse(this.canvas.dataset['nodes'] ?? '[]');
      nodes.push([args[0], args[1]]);
      this.canvas.dataset['nodes'] = JSON.stringify(nodes);
      return arc.apply(this, args);
    };
  });
  await page.getByRole('button', { name: 'Graph view', exact: true }).click();
  const canvas = page.getByRole('img', { name: 'Workspace document graph' });
  const readNodes = () =>
    canvas.evaluate((el): number[][] =>
      JSON.parse(el.getAttribute('data-nodes') ?? '[]'),
    );
  await expect.poll(async () => (await readNodes()).length).toBeGreaterThan(2);
  await page.waitForTimeout(700);
  const initial = await readNodes();
  const box = (await canvas.boundingBox())!;
  // Start away from nodes so no force simulation needs to settle.
  const x = box.x + 100;
  const y = box.y + 80;
  const session = await page.context().newCDPSession(page);
  const touch = async (
    points: { x: number; y: number; id: number }[],
    type: 'touchStart' | 'touchMove' | 'touchEnd',
  ) => {
    await session.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: points,
    });
  };
  await touch(
    [
      { x, y, id: 1 },
      { x: x + 100, y, id: 2 },
    ],
    'touchStart',
  );
  await touch(
    [
      { x: x - 25, y, id: 1 },
      { x: x + 125, y, id: 2 },
    ],
    'touchMove',
  );
  const zoomed = await readNodes();
  const ratio =
    Math.hypot(zoomed[0][0] - zoomed[1][0], zoomed[0][1] - zoomed[1][1]) /
    Math.hypot(initial[0][0] - initial[1][0], initial[0][1] - initial[1][1]);
  expect(ratio).toBeCloseTo(1.5, 1);
  for (let i = 0; i < initial.length; i++) {
    expect(zoomed[i][0]).toBeCloseTo(150 + (initial[i][0] - 150) * 1.5, 0);
    expect(zoomed[i][1]).toBeCloseTo(80 + (initial[i][1] - 80) * 1.5, 0);
  }
  // Lifting one finger must neither fling the graph nor turn the remainder
  // into a node click/drag using coordinates left over from the pinch.
  await touch([{ x: x - 25, y, id: 1 }], 'touchEnd');
  await touch([{ x: x + 10, y: y + 20, id: 1 }], 'touchMove');
  expect(await readNodes()).toEqual(zoomed);
  await touch([], 'touchEnd');
  await touch([{ x, y, id: 3 }], 'touchStart');
  await touch([{ x: x + 30, y: y + 30, id: 3 }], 'touchMove');
  const panned = await readNodes();
  for (let i = 0; i < zoomed.length; i++) {
    expect(panned[i][0]).toBeCloseTo(zoomed[i][0] + 30, 0);
    expect(panned[i][1]).toBeCloseTo(zoomed[i][1] + 30, 0);
  }
  await touch([], 'touchEnd');
  await expect(canvas).toBeVisible();
});
