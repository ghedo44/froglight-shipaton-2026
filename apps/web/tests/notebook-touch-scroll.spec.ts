import { expect, test } from '@playwright/test';
import { createFromSidebar } from './support/sidebar-create.js';

// CDP touch input exercises the assembled product, not physical iPad latency.
for (const viewport of [
  { width: 820, height: 1180 },
  { width: 390, height: 844 },
]) {
  test.describe(`${viewport.width}px touch viewport`, () => {
    test.use({ viewport, hasTouch: true });

    test('Notebook paper follows the finger without losing distance to its own scroll', async ({
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
      await page.getByTestId('create-vault-name-input').fill('Touch scroll');
      await page.getByTestId('choose-vault-location-button').click();
      await page.getByTestId('confirm-create-vault-button').click();
      await createFromSidebar(page, 'Notebook');
      await page.getByRole('textbox', { name: 'Note name' }).fill('Scroll');
      await page
        .getByRole('dialog', { name: 'Create a new note' })
        .getByRole('button', { name: 'Create', exact: true })
        .click();
      await page
        .getByRole('button', { name: 'Toggle document sidebar', exact: true })
        .tap();
      await page.getByRole('tab', { name: 'Pages', exact: true }).tap();
      await page.getByRole('button', { name: 'Page 1 actions' }).tap();
      await page
        .getByRole('menuitem', { name: 'Add after', exact: true })
        .tap();
      await page.keyboard.press('Escape');
      const scroll = page.locator('.fl-nb-scroll');
      const canvas = page.locator('.fl-ink-canvas').first();
      await scroll.evaluate((e) => {
        e.scrollTop = 100;
      });
      await expect(canvas).toBeVisible();
      const bounds = await scroll.boundingBox();
      if (!bounds) throw new Error('Missing scroll viewport');
      const x = bounds.x + bounds.width / 2;
      const y = bounds.y + bounds.height * 0.65;
      // Author real ink before navigating, then ensure scrolling cannot edit it.
      await page.mouse.move(x - 30, y - 50);
      await page.mouse.down();
      await page.mouse.move(x + 30, y - 80, { steps: 12 });
      await page.mouse.up();
      await page.keyboard.press('Control+s');
      const savedNotebook = () =>
        page.evaluate(async () => {
          const vault = await (
            await navigator.storage.getDirectory()
          ).getDirectoryHandle('Touch scroll');
          return (
            await (await vault.getFileHandle('Scroll.notebook')).getFile()
          ).text();
        });
      await expect.poll(savedNotebook).toContain('froglight.ink');
      const savedBefore = await savedNotebook();
      const client = await page.context().newCDPSession(page);
      const before = await scroll.evaluate((e) => e.scrollTop);
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x, y, id: 0 }],
      });
      for (let step = 1; step <= 12; step++) {
        await client.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: x + step * 0.5, y: y - step * 20, id: 0 }],
        });
        await page.evaluate(() => new Promise(requestAnimationFrame));
      }
      const distance = (await scroll.evaluate((e) => e.scrollTop)) - before;
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
      });
      expect(distance).toBeGreaterThan(235);
      expect(distance).toBeLessThan(245);
      // A natural swipe drifts sideways; that must not suppress momentum.
      await expect
        .poll(() => scroll.evaluate((e) => e.scrollTop))
        .toBeGreaterThan(before + distance + 20);
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x, y, id: 0 }],
      });
      const stoppedAt = await scroll.evaluate((e) => e.scrollTop);
      await page.evaluate(async () => {
        for (let frame = 0; frame < 8; frame++)
          await new Promise(requestAnimationFrame);
      });
      expect(await scroll.evaluate((e) => e.scrollTop)).toBeCloseTo(
        stoppedAt,
        0,
      );
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
      });
      await page.keyboard.press('Control+s');
      expect(await savedNotebook()).toBe(savedBefore);
      await page.screenshot({
        path: test.info().outputPath('touch-scroll.png'),
      });
      await page.reload();
      await page.getByRole('button', { name: /Touch scroll Browser/ }).click();
      await expect(
        page.getByRole('tab', { name: 'Scroll.notebook', exact: true }),
      ).toBeVisible();
      expect(await savedNotebook()).toBe(savedBefore);
    });
  });
}

for (const viewport of [
  { width: 820, height: 1180 },
  { width: 390, height: 844 },
]) {
  test.describe(`${viewport.width}px Notebook edge pull`, () => {
    test.use({ viewport, hasTouch: true });

    test('needs a deliberate drag before creating a page', async ({ page }) => {
      await page.addInitScript(() =>
        Object.defineProperty(window, 'showDirectoryPicker', {
          value: undefined,
          configurable: true,
        }),
      );
      await page.goto('/');
      await page.getByTestId('create-vault-button').click();
      await page.getByTestId('create-vault-name-input').fill('Pull threshold');
      await page.getByTestId('choose-vault-location-button').click();
      await page.getByTestId('confirm-create-vault-button').click();
      await createFromSidebar(page, 'Notebook');
      await page.getByRole('textbox', { name: 'Note name' }).fill('Pull');
      await page
        .getByRole('dialog', { name: 'Create a new note' })
        .getByRole('button', { name: 'Create', exact: true })
        .click();

      const scroll = page.locator('.fl-nb-scroll');
      const cue = page.locator('.fl-nb-pull-add');
      const bounds = await scroll.boundingBox();
      if (!bounds) throw new Error('Missing notebook scroll viewport');
      const x = bounds.x + bounds.width / 2;
      const y = bounds.y + 180;
      const client = await page.context().newCDPSession(page);
      const pull = async (distance: number, startY = y) => {
        await client.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [{ x, y: startY, id: 0 }],
        });
        await client.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x, y: startY + distance, id: 0 }],
        });
      };
      const release = async () => {
        await client.send('Input.dispatchTouchEvent', {
          type: 'touchEnd',
          touchPoints: [],
        });
      };

      await pull(140);
      await expect(cue).toHaveAttribute('data-armed', 'false');
      const topTools = page.locator('[data-anchor="float.top-center"]');
      const topToolsBox = await topTools.boundingBox();
      const topCueBox = await cue.boundingBox();
      if (!topToolsBox || !topCueBox)
        throw new Error('Missing top pull geometry');
      expect(topCueBox.y).toBeGreaterThanOrEqual(
        topToolsBox.y + topToolsBox.height,
      );
      expect(
        Number(await cue.evaluate((e) => getComputedStyle(e).opacity)),
      ).toBeCloseTo(140 / 192, 2);
      await release();
      await expect(page.locator('.fl-nb-shell')).toHaveCount(1);

      await pull(220);
      await expect(cue).toHaveAttribute('data-armed', 'true');
      await release();
      await expect(page.locator('.fl-nb-shell')).toHaveCount(2);

      await scroll.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await pull(-140, bounds.y + bounds.height - 160);
      await expect(cue).toHaveAttribute('data-edge', 'bottom');
      const navigationBox = await page
        .locator('[data-anchor="float.bottom-left"]')
        .boundingBox();
      const bottomCueBox = await cue.boundingBox();
      if (!navigationBox || !bottomCueBox)
        throw new Error('Missing bottom pull geometry');
      expect(bottomCueBox.y + bottomCueBox.height).toBeLessThanOrEqual(
        navigationBox.y,
      );
      await release();
      await expect(page.locator('.fl-nb-shell')).toHaveCount(2);

      await page.keyboard.press('Control+s');
      await expect
        .poll(() =>
          page.evaluate(async () => {
            const vault = await (
              await navigator.storage.getDirectory()
            ).getDirectoryHandle('Pull threshold');
            return JSON.parse(
              await (await vault.getFileHandle('Pull.notebook'))
                .getFile()
                .then((file) => file.text()),
            ).pageOrder.length;
          }),
        )
        .toBe(2);
      await page.reload();
      await page
        .getByRole('button', { name: /Pull threshold Browser/ })
        .click();
      await page
        .getByRole('button', { name: /^(Toggle sidebar|Open sidebar)$/ })
        .click();
      await page.getByText('Pull.notebook', { exact: true }).first().dblclick();
      await expect(page.locator('.fl-nb-shell')).toHaveCount(2);
    });
  });
}
