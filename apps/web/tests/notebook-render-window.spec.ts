import { expect, test } from '@playwright/test';
import { createFromSidebar } from './support/sidebar-create.js';

for (const width of [1440, 390]) {
  test.describe(`${width}px notebook rendering window`, () => {
    test.use({ viewport: { width, height: 900 }, deviceScaleFactor: 2 });

    test('keeps paper fit, Retina density and ink coordinates through 25–800% zoom', async ({
      page,
    }) => {
      test.setTimeout(60000);
      await page.addInitScript(() =>
        Object.defineProperty(window, 'showDirectoryPicker', {
          value: undefined,
          configurable: true,
        }),
      );
      await page.goto('/');
      await page.getByTestId('create-vault-button').click();
      await page.getByTestId('create-vault-name-input').fill('Render window');
      await page.getByTestId('choose-vault-location-button').click();
      await page.getByTestId('confirm-create-vault-button').click();
      await createFromSidebar(page, 'Notebook');
      await page.getByRole('textbox', { name: 'Note name' }).fill('Zoom');
      await page
        .getByRole('dialog', { name: 'Create a new note' })
        .getByRole('button', { name: 'Create', exact: true })
        .click();
      await page
        .getByRole('button', { name: 'Toggle document sidebar', exact: true })
        .click();
      await page.getByRole('tab', { name: 'Pages', exact: true }).click();
      await page.getByRole('button', { name: 'Page 1 actions' }).click();
      await page
        .getByRole('menuitem', { name: 'Add after', exact: true })
        .click();
      await page.keyboard.press('Escape');
      const sidebarToggle = page.getByRole('button', {
        name: 'Toggle document sidebar',
        exact: true,
      });
      if ((await sidebarToggle.getAttribute('aria-expanded')) === 'true')
        await sidebarToggle.click();

      const root = page.locator('.fl-nb');
      const scroll = page.locator('.fl-nb-scroll');
      const first = page.locator('.fl-nb-shell').first();
      const setZoom = async (zoom: number) => {
        const viewport = await scroll.boundingBox();
        if (!viewport) throw new Error('Missing notebook viewport');
        await page.mouse.move(
          viewport.x + viewport.width / 2,
          viewport.y + 180,
        );
        await page.keyboard.down('Control');
        await page.mouse.wheel(0, zoom === 25 ? 4000 : -4000);
        await page.keyboard.up('Control');
        await expect(root).toHaveAttribute('data-zoom', String(zoom));
        await expect
          .poll(() =>
            page.locator('.fl-nb-stack').evaluate((e) => e.style.transform),
          )
          .toBe('');
        await scroll.evaluate((e) => {
          e.scrollLeft = 0;
          e.scrollTop = 0;
        });
        await expect(first.locator('.fl-ink-canvas')).toBeVisible();
      };
      const saved = () =>
        page.evaluate(async () => {
          const vault = await (
            await navigator.storage.getDirectory()
          ).getDirectoryHandle('Render window');
          return (
            await (await vault.getFileHandle('Zoom.notebook')).getFile()
          ).text();
        });
      const gap = () =>
        page
          .locator('.fl-nb-stack')
          .evaluate((e) => parseFloat(getComputedStyle(e).gap));
      const baseGap = await gap();

      // Keep a decoded image on the other page while surfaces unmount/remount.
      await scroll.evaluate((e) => {
        e.scrollTop = e.scrollHeight;
      });
      await expect(
        page.locator('[data-anchor="float.bottom-left"]'),
      ).toContainText('2 / 2');
      await root.locator('input[type=file][accept="image/*"]').setInputFiles({
        name: 'pixel.png',
        mimeType: 'image/png',
        buffer: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=',
          'base64',
        ),
      });
      await expect.poll(saved).toContain('froglight.image');
      let strokeCount = 0;
      for (const zoom of [25, 800, 25]) {
        await setZoom(zoom);
        expect(await gap()).toBeCloseTo((baseGap * zoom) / 100, 5);
        const canvas = first.locator('.fl-ink-canvas');
        await expect
          .poll(() =>
            canvas.evaluate(
              (e: HTMLCanvasElement) => e.width / parseFloat(e.style.width),
            ),
          )
          .toBeCloseTo(2, 2);
        const raster = await canvas.evaluate((e: HTMLCanvasElement) => ({
          width: e.width,
          height: e.height,
        }));
        expect(Math.max(raster.width, raster.height)).toBeLessThanOrEqual(4096);
        if (zoom === 800) {
          const fullWidth = await first.evaluate((e) => e.clientWidth);
          expect(raster.width).toBeLessThan(fullWidth);
          await scroll.evaluate((e) => {
            e.scrollLeft = 700;
            e.scrollTop = 1100;
          });
          await expect
            .poll(() => canvas.evaluate((e) => parseFloat(e.style.top)))
            .toBeGreaterThan(800);
        }
        // Write after a scroll as well as at low zoom. The first point must
        // use the full page fit, even though the canvas starts far inside it.
        const geometry = await first.locator('.fl-ink-page').evaluate((e) => {
          const r = e.getBoundingClientRect();
          return { left: r.left, top: r.top, width: r.width, height: r.height };
        });
        const viewport = await scroll.boundingBox();
        if (!viewport) throw new Error('Missing notebook viewport');
        const x = Math.max(
          geometry.left + 12,
          Math.min(
            geometry.left + geometry.width * 0.35,
            viewport.x + viewport.width * 0.4,
          ),
        );
        const y = Math.max(
          viewport.y + 15,
          Math.min(geometry.top + geometry.height * 0.4, viewport.y + 180),
        );
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x + 25, y + 10, { steps: 8 });
        await page.mouse.up();
        await page.keyboard.press('Control+s');
        strokeCount += 1;
        await expect
          .poll(async () => {
            const document = JSON.parse(await saved());
            return document.pages[document.pageOrder[0]].surface.order.length;
          })
          .toBe(strokeCount);
        const document = JSON.parse(await saved());
        const surface = document.pages[document.pageOrder[0]].surface;
        const stroke = surface.objects[surface.order.at(-1)];
        const scale = Math.min(
          geometry.width / surface.frame.width,
          geometry.height / surface.frame.height,
        );
        expect(stroke.points[0].x).toBeCloseTo(
          surface.frame.width / 2 +
            (x - geometry.left - geometry.width / 2) / scale,
          0,
        );
        expect(stroke.points[0].y).toBeCloseTo(
          surface.frame.height / 2 +
            (y - geometry.top - geometry.height / 2) / scale,
          0,
        );
        await page.screenshot({
          path: test.info().outputPath(`zoom-${zoom}.png`),
        });
        if (zoom === 800) {
          const choose = async (name: string) => {
            await page
              .getByRole('button', { name, exact: true })
              .first()
              .evaluate((e: HTMLButtonElement) => e.click());
          };
          await choose('Selection');
          await choose('Select');
          await page.mouse.click(x + 12, y + 5);
          await page.mouse.move(x + 12, y + 5);
          await page.mouse.down();
          await page.mouse.move(x + 28, y + 15, { steps: 8 });
          await page.mouse.up();
          await page.keyboard.press('Control+s');
          await expect
            .poll(async () => {
              const document = JSON.parse(await saved());
              return document.pages[document.pageOrder[0]].surface.objects[
                stroke.id
              ].points[0].x;
            })
            .toBeCloseTo(stroke.points[0].x + 16 / scale, 0);
          await page.keyboard.press('Control+z');
          await page.keyboard.press('Control+s');
          await expect
            .poll(async () => {
              const document = JSON.parse(await saved());
              return document.pages[document.pageOrder[0]].surface.objects[
                stroke.id
              ].points[0].x;
            })
            .toBeCloseTo(stroke.points[0].x, 0);
          await choose('Eraser');
          await page.mouse.click(x + 12, y + 5);
          await page.keyboard.press('Control+s');
          await expect
            .poll(async () => {
              const document = JSON.parse(await saved());
              return document.pages[document.pageOrder[0]].surface.order.length;
            })
            .toBe(strokeCount - 1);
          await page.keyboard.press('Control+z');
          await page.keyboard.press('Control+s');
          await expect
            .poll(async () => {
              const document = JSON.parse(await saved());
              return document.pages[document.pageOrder[0]].surface.order.length;
            })
            .toBe(strokeCount);
          await choose('Pen');
        }
      }
      const beforeNavigation = await saved();
      await setZoom(800);
      await scroll.evaluate((e) => {
        e.scrollTop = e.scrollHeight;
      });
      await expect(
        page.locator('.fl-nb-shell').nth(1).locator('.fl-ink-canvas'),
      ).toBeVisible();
      await setZoom(25);
      await page.keyboard.press('Control+s');
      expect(await saved()).toBe(beforeNavigation);
      await page.reload();
      await page.getByRole('button', { name: /Render window Browser/ }).click();
      await expect(
        page.getByRole('tab', { name: 'Zoom.notebook', exact: true }),
      ).toBeVisible();
      expect(await saved()).toBe(beforeNavigation);
    });
  });
}
