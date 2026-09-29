import { expect, test } from '@playwright/test';

test.use({ hasTouch: true });

for (const viewport of [
  { width: 820, height: 1180 },
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
]) {
  test(`graph fills its pane and filters documents at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(
      viewport.width < 600 ? { width: 820, height: 1180 } : viewport,
    );
    await page.goto('/');
    await page.getByTestId('open-recent-vault-button-0').click();
    await expect(page.locator('.flbp-host').first()).toBeVisible();
    await page.getByRole('button', { name: 'Graph view', exact: true }).click();
    const graph = page.locator('[data-fl-component="graph-view"]');
    await expect(graph).toBeVisible();
    await page.setViewportSize(viewport);
    const canvas = graph.locator('canvas');
    const geometry = await graph.evaluate((el) => ({
      graph: el.getBoundingClientRect().height,
      pane: el.parentElement!.parentElement!.getBoundingClientRect().height,
      canvas: el.querySelector('canvas')!.getBoundingClientRect().height,
    }));
    expect(geometry.canvas).toBeGreaterThan(geometry.pane - 2);
    expect(geometry.graph).toBeGreaterThan(geometry.pane - 2);
    const before = await canvas.evaluate((el) => (el as HTMLCanvasElement).toDataURL());
    await page.waitForTimeout(600);
    expect(
      await canvas.evaluate((el, before) => (el as HTMLCanvasElement).toDataURL() === before, before),
    ).toBe(true);
    await graph.getByRole('button', { name: 'Recenter', exact: true }).click();
    expect(
      await canvas.evaluate((el, before) => (el as HTMLCanvasElement).toDataURL() === before, before),
    ).toBe(true);

    const summary = graph.locator('summary');
    await summary.click();
    await expect(
      graph.getByRole('slider', { name: 'Repulsion', exact: true }),
    ).toBeVisible();
    await graph.getByRole('slider', { name: 'Node size' }).fill('150');
    expect(
      await canvas.evaluate((el, before) => (el as HTMLCanvasElement).toDataURL() === before, before),
    ).toBe(false);
    await graph.getByRole('checkbox', { name: 'Ink page', exact: false }).uncheck();
    await expect(
      graph.getByRole('checkbox', { name: 'Markdown', exact: false }),
    ).toBeChecked();
    await expect(
      graph.getByRole('checkbox', { name: 'Block page', exact: false }),
    ).toBeChecked();
    for (const checkbox of await graph.getByRole('checkbox').all())
      await checkbox.uncheck();
    await expect(
      graph.getByText('No documents match these filters.', { exact: false }),
    ).toBeVisible();
    await graph.getByRole('button', { name: 'Reset settings' }).click();
    await expect(
      graph.getByText('No documents match these filters.', { exact: false }),
    ).toBeHidden();
    await expect(graph.getByRole('slider', { name: 'Node size' })).toHaveValue(
      '100',
    );
    const headerVisible = await summary.evaluate((el) => {
      const header = el.getBoundingClientRect();
      const panel = el.parentElement!.getBoundingClientRect();
      return header.top >= panel.top && header.bottom <= panel.bottom;
    });
    expect(headerVisible).toBe(true);
    await page.screenshot({
      path: test.info().outputPath(`graph-${viewport.width}-light.png`),
    });
    await page.evaluate(() =>
      document.documentElement.setAttribute('data-theme', 'dark'),
    );
    await page.waitForTimeout(50);
    await page.screenshot({
      path: test.info().outputPath(`graph-${viewport.width}-dark.png`),
    });
    await summary.click();
    await expect(
      graph.getByRole('slider', { name: 'Repulsion', exact: true }),
    ).toBeHidden();
    await summary.focus();
    await page.keyboard.press('Enter');
    await expect(
      graph.getByRole('slider', { name: 'Repulsion', exact: true }),
    ).toBeVisible();
    expect(await graph.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
      true,
    );
  });
}

test('connected nodes react while a node is held and dragged', async ({
  page,
}) => {
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.goto('/');
  await page.getByTestId('open-recent-vault-button-0').click();
  await expect(page.locator('.flbp-host').first()).toBeVisible();
  // Observe the real canvas draws without substituting graph data or physics.
  await page.evaluate(() => {
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    const arc = CanvasRenderingContext2D.prototype.arc;
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      if (this.canvas.getAttribute('aria-label') === 'Workspace document graph')
        this.canvas.dataset['nodes'] = '[]';
      return clear.apply(this, args);
    };
    CanvasRenderingContext2D.prototype.arc = function (...args) {
      if (
        this.canvas.getAttribute('aria-label') === 'Workspace document graph'
      ) {
        const nodes: number[][] = JSON.parse(
          this.canvas.dataset['nodes'] ?? '[]',
        );
        nodes.push([args[0], args[1], args[2]]);
        this.canvas.dataset['nodes'] = JSON.stringify(nodes);
      }
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
  const box = await canvas.boundingBox();
  if (box === null) throw new Error('Graph canvas missing');
  const initial = await readNodes();
  expect(Math.max(...initial.map((node) => node[2]))).toBeGreaterThan(12);
  const index = initial.findIndex(
    ([x, y]) =>
      x > 100 && x < box.width - 180 && y > 150 && y < box.height - 150,
  );
  expect(index).toBeGreaterThanOrEqual(0);
  const [x, y] = initial[index];
  await page.mouse.move(box.x + x, box.y + y);
  await page.mouse.down();
  // Let pointerdown's first frame complete before moving: this catches loops
  // which stop as soon as a node is pinned.
  await page.waitForTimeout(80);
  const before = await readNodes();
  await page.mouse.move(box.x + x + 100, box.y + y + 60, { steps: 5 });
  await page.waitForTimeout(180);
  const during = await readNodes();
  expect(
    during.some(
      ([nx, ny], i) =>
        i !== index && Math.hypot(nx - before[i][0], ny - before[i][1]) > 1,
    ),
  ).toBe(true);
  expect(during[index][0]).toBeCloseTo(x + 100, 0);
  expect(during[index][1]).toBeCloseTo(y + 60, 0);
  await page.mouse.up();

  const graph = page.locator('[data-fl-component="graph-view"]');
  await graph.locator('summary').click();
  await graph
    .getByRole('slider', { name: 'Attraction', exact: true })
    .fill('30');
  await expect(
    graph.getByRole('slider', { name: 'Attraction', exact: true }),
  ).toHaveValue('30');
  await graph.getByRole('checkbox', { name: 'Ink page', exact: false }).uncheck();
  const filteredCount = (await readNodes()).length;
  expect(filteredCount).toBeLessThan(initial.length);
  await graph
    .getByRole('button', { name: 'Rebuild graph', exact: true })
    .click();
  await expect
    .poll(async () => {
      const count = (await readNodes()).length;
      return count > 0 && count < filteredCount;
    })
    .toBe(true);
  await expect.poll(async () => (await readNodes()).length).toBe(filteredCount);
  // Repeated rebuilds replace the running replay rather than duplicating nodes.
  await graph
    .getByRole('button', { name: 'Rebuild graph', exact: true })
    .click();
  await graph
    .getByRole('button', { name: 'Rebuild graph', exact: true })
    .click();
  await expect.poll(async () => (await readNodes()).length).toBe(filteredCount);
  await expect(
    graph.getByRole('checkbox', { name: 'Ink page', exact: false }),
  ).not.toBeChecked();
});

test('rebuild respects reduced motion and keeps attraction settings', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.goto('/');
  await page.getByTestId('open-recent-vault-button-0').click();
  await expect(page.locator('.flbp-host').first()).toBeVisible();
  await page.getByRole('button', { name: 'Graph view', exact: true }).click();
  const graph = page.locator('[data-fl-component="graph-view"]');
  await graph.locator('summary').click();
  await graph
    .getByRole('slider', { name: 'Attraction', exact: true })
    .fill('20');
  await graph
    .getByRole('button', { name: 'Rebuild graph', exact: true })
    .click();
  const canvas = graph.locator('canvas');
  const frame = await canvas.evaluate((el) => (el as HTMLCanvasElement).toDataURL());
  await page.waitForTimeout(250);
  expect(
    await canvas.evaluate((el, frame) => (el as HTMLCanvasElement).toDataURL() === frame, frame),
  ).toBe(true);
  await expect(
    graph.getByRole('slider', { name: 'Attraction', exact: true }),
  ).toHaveValue('20');
});
