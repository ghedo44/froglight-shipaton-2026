import { expect, test } from '@playwright/test';
import { createFromSidebar } from './support/sidebar-create.js';

// Real browser touch input; physical iPad/Pencil behavior needs hardware.
for (const width of [820, 390]) {
  test.describe(`${width}px notebook pinch`, () => {
    test.use({ viewport: { width, height: 1180 }, hasTouch: true });
    test('zooms across pages and paper edges without changing ink', async ({
      page,
    }) => {
      test.setTimeout(60_000);
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
        .fill('Cross-page pinch');
      await page.getByTestId('choose-vault-location-button').click();
      await page.getByTestId('confirm-create-vault-button').click();
      await createFromSidebar(page, 'Notebook');
      await page.getByRole('textbox', { name: 'Note name' }).fill('Pinch');
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
      await page.mouse.click(100, 350);
      await expect(
        page.getByRole('complementary', {
          name: 'Document sidebar',
          exact: true,
        }),
      ).toBeHidden();
      const scroll = page.locator('.fl-nb-scroll');
      const root = page.locator('.fl-nb');
      await page.keyboard.press('Escape');
      await scroll.evaluate((e) => {
        e.scrollTop = 0;
      });
      const canvas = page.locator('.fl-ink-canvas').first();
      await expect(canvas).toBeVisible();
      const paper = await canvas.boundingBox();
      if (!paper) throw new Error('Missing paper');
      await page.mouse.move(
        paper.x + paper.width * 0.4,
        paper.y + Math.min(300, paper.height * 0.6),
      );
      await page.mouse.down();
      await page.mouse.move(
        paper.x + paper.width * 0.6,
        paper.y + Math.min(300, paper.height * 0.6) + 30,
        {
          steps: 12,
        },
      );
      await page.mouse.up();
      await page.keyboard.press('Control+s');
      const savedNotebook = () =>
        page.evaluate(async () => {
          const vault = await (
            await navigator.storage.getDirectory()
          ).getDirectoryHandle('Cross-page pinch');
          return (
            await (await vault.getFileHandle('Pinch.notebook')).getFile()
          ).text();
        });
      await expect.poll(savedNotebook).toContain('froglight.ink');
      const savedBefore = await savedNotebook();
      const client = await page.context().newCDPSession(page);
      const origins = [
        'different pages',
        'page and gutter',
        'gutter and page',
        'same page',
        'gutter',
      ];
      for (const { origin, direction } of origins.flatMap((origin) => [
        { origin, direction: 1 },
        { origin, direction: -1 },
      ])) {
        await page
          .getByRole('button', {
            name: /Notebook zoom .*activate to reset to 100%/,
          })
          .tap();
        await expect(root).toHaveAttribute('data-zoom', '100');
        await expect
          .poll(() =>
            page.locator('.fl-nb-stack').evaluate((e) => e.style.transform),
          )
          .toBe('');
        await scroll.evaluate((element) => {
          const second = element.querySelectorAll('.fl-nb-shell')[1];
          if (!second) throw new Error('Missing second page');
          element.scrollTop +=
            second.getBoundingClientRect().top -
            element.getBoundingClientRect().top -
            element.clientHeight / 2;
        });
        const viewport = await scroll.boundingBox();
        const second = await page.locator('.fl-nb-shell').nth(1).boundingBox();
        if (!viewport || !second) throw new Error('Missing page geometry');
        const centerX = viewport.x + viewport.width / 2;
        const seam = second.y - 14;
        const gutterX = viewport.x + 10;
        const first = {
          x:
            origin === 'gutter and page' || origin === 'gutter'
              ? gutterX
              : centerX,
          y: seam - 70,
          id: 0,
        };
        const other = {
          x:
            origin === 'page and gutter' || origin === 'gutter'
              ? gutterX
              : centerX,
          y: origin === 'same page' ? seam - 150 : seam + 70,
          id: 1,
        };
        const hitPages = await page.evaluate(
          (points) =>
            points.map(
              (point) =>
                document
                  .elementFromPoint(point.x, point.y)
                  ?.closest('.fl-nb-shell')
                  ?.getAttribute('data-page-id') ?? null,
            ),
          [first, other],
        );
        if (origin === 'different pages') {
          expect(hitPages[0]).not.toBeNull();
          expect(hitPages[1]).not.toBeNull();
          expect(hitPages[0]).not.toBe(hitPages[1]);
        } else if (origin === 'same page') {
          expect(hitPages[0]).not.toBeNull();
          expect(hitPages[0]).toBe(hitPages[1]);
        } else {
          expect(hitPages.map((id) => id !== null)).toEqual(
            origin === 'gutter'
              ? [false, false]
              : origin === 'page and gutter'
                ? [true, false]
                : [false, true],
          );
        }
        const centroid = {
          x: (first.x + other.x) / 2,
          y: (first.y + other.y) / 2,
        };
        const zoomBefore = Number(await root.getAttribute('data-zoom'));
        await client.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [first],
        });
        await client.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [first, other],
        });
        for (let step = 1; step <= 8; step++) {
          const factor = 1 + direction * step * 0.025;
          await client.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [first, other].map((point) => ({
              ...point,
              x: centroid.x + (point.x - centroid.x) * factor,
              y: centroid.y + (point.y - centroid.y) * factor,
            })),
          });
          await page.evaluate(() => new Promise(requestAnimationFrame));
        }
        const zoomAfter = Number(await root.getAttribute('data-zoom'));
        if (direction > 0)
          expect(zoomAfter, origin).toBeGreaterThan(zoomBefore * 1.1);
        else expect(zoomAfter, origin).toBeLessThan(zoomBefore * 0.9);
        // ResizeObserver runs after rAF and before paint. A cleared backing
        // store here is a visible blank frame even if the next rAF repairs it.
        await root.evaluate((element) => {
          element.setAttribute('data-blank-resize-frames', '0');
          const observer = new ResizeObserver(() => {
            queueMicrotask(() => {
              for (const canvas of element.querySelectorAll<HTMLCanvasElement>(
                '.fl-ink-canvas',
              )) {
                const box = canvas.getBoundingClientRect();
                if (box.bottom <= 0 || box.top >= innerHeight) continue;
                const alpha = canvas
                  .getContext('2d')
                  ?.getImageData(
                    Math.floor(canvas.width / 2),
                    Math.floor(canvas.height / 2),
                    1,
                    1,
                  ).data[3];
                if (alpha === 0)
                  element.setAttribute(
                    'data-blank-resize-frames',
                    String(
                      Number(element.getAttribute('data-blank-resize-frames')) +
                        1,
                    ),
                  );
              }
            });
          });
          for (const shell of element.querySelectorAll('.fl-nb-shell'))
            observer.observe(shell);
          element.addEventListener(
            'pinch-probe-done',
            () => observer.disconnect(),
            { once: true },
          );
        });
        await client.send('Input.dispatchTouchEvent', {
          type: 'touchEnd',
          touchPoints: [first],
        });
        await client.send('Input.dispatchTouchEvent', {
          type: 'touchEnd',
          touchPoints: [],
        });
        await expect
          .poll(() =>
            page.locator('.fl-nb-stack').evaluate((e) => e.style.transform),
          )
          .toBe('');
        await page.evaluate(() => new Promise(requestAnimationFrame));
        await root.evaluate((element) =>
          element.dispatchEvent(new Event('pinch-probe-done')),
        );
        await expect(root, origin).toHaveAttribute(
          'data-blank-resize-frames',
          '0',
        );
      }
      await page.keyboard.press('Control+s');
      expect(await savedNotebook()).toBe(savedBefore);
      await page.screenshot({
        path: test.info().outputPath('cross-page-pinch.png'),
      });
      await page.reload();
      await page
        .getByRole('button', { name: /Cross-page pinch Browser/ })
        .click();
      await expect(
        page.getByRole('tab', { name: 'Pinch.notebook', exact: true }),
      ).toBeVisible();
      expect(await savedNotebook()).toBe(savedBefore);
    });
  });
}
