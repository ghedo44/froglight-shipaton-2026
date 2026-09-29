import { expect, test } from '@playwright/test';
import { createFromSidebar } from './support/sidebar-create.js';

// Assembled providers and real canvas/OPFS. Synthetic cancellation checks
// confirmed-input recovery; it cannot certify physical Pencil or palm behavior.
test.use({
  viewport: { width: 1024, height: 768 },
  deviceScaleFactor: 2,
  hasTouch: true,
  contextOptions: { reducedMotion: 'reduce' },
});
for (const kind of ['Ink', 'Notebook', 'Whiteboard']) {
  test(`${kind}: interrupted pen input survives save and high zoom`, async ({
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
    await page.getByTestId('create-vault-name-input').fill('Pencil recovery');
    await page.getByTestId('choose-vault-location-button').click();
    await page.getByTestId('confirm-create-vault-button').click();
    await createFromSidebar(page, new RegExp(`^${kind}`));
    await page.getByRole('textbox', { name: 'Note name' }).fill('Recovery');
    await page
      .getByRole('dialog', { name: 'Create a new note' })
      .getByRole('button', { name: 'Create', exact: true })
      .click();
    const canvas = page.locator('.fl-ink-canvas').first();
    await expect(canvas).toBeVisible();
    const draw = () =>
      canvas.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const x =
          (Math.max(rect.left, 0) + Math.min(rect.right, innerWidth)) / 2;
        const y =
          (Math.max(rect.top, 100) + Math.min(rect.bottom, innerHeight - 100)) /
          2;
        // Native capture cannot be established with synthetic pointerdown.
        // Stub only that DOM boundary; all input, model, history and paint are real.
        element.setPointerCapture = () => undefined;
        for (let i = 0; i < 20; i++) {
          element.dispatchEvent(
            new PointerEvent(i === 0 ? 'pointerdown' : 'pointermove', {
              pointerId: 42,
              pointerType: 'pen',
              pressure: 0.7,
              buttons: 1,
              clientX: x + i * 2,
              clientY: y + Math.sin(i / 3) * 10,
              bubbles: true,
              cancelable: true,
            }),
          );
        }
        element.dispatchEvent(
          new PointerEvent('pointercancel', {
            pointerId: 42,
            pointerType: 'pen',
            bubbles: true,
          }),
        );
      });
    await draw();
    await page.keyboard.press('Control+s');
    const saved = () =>
      page.evaluate(async () => {
        const vault = await (
          await navigator.storage.getDirectory()
        ).getDirectoryHandle('Pencil recovery');
        for await (const [name, entry] of vault.entries()) {
          if (entry.kind === 'file' && name.startsWith('Recovery.')) {
            try {
              const data: unknown = JSON.parse(
                await (await entry.getFile()).text(),
              );
              const strokes: { points?: unknown[] }[] = [];
              const visit = (value: unknown): void => {
                if (value === null || typeof value !== 'object') return;
                const record = value as Record<string, unknown>;
                if (record.type === 'froglight.ink.stroke')
                  strokes.push(record);
                else Object.values(record).forEach(visit);
              };
              visit(data);
              return strokes.map((stroke) => stroke.points?.length ?? 0);
            } catch {
              return [];
            }
          }
        }
        return [];
      });
    await expect.poll(saved).toEqual([20]);
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+s');
    await expect.poll(saved).toEqual([]);
    await page.keyboard.press('Control+Shift+z');
    await page.keyboard.press('Control+s');
    await expect.poll(saved).toEqual([20]);
    const zoomIn = page.getByRole('button', { name: 'Zoom in', exact: true });
    const zoomState = page.getByRole('button', { name: /zoom [0-9]+%.*reset/i });
    for (let i = 0; i < 18; i++) {
      const previous = await zoomState.getAttribute('aria-label');
      if (previous?.includes('800%')) break;
      await zoomIn.click();
      // Wait for the toolbar command and pager snapshot to settle before
      // issuing the next step (the host serializes tool execution).
      await expect(zoomState).not.toHaveAttribute('aria-label', previous ?? '');
    }
    await expect(
      page.getByRole('button', { name: /zoom 800%/i }),
    ).toBeVisible();
    await expect
      .poll(() =>
        canvas.evaluate((element: HTMLCanvasElement) =>
          Math.max(element.width, element.height),
        ),
      )
      .toBeLessThanOrEqual(4096);
    await expect.poll(saved).toEqual([20]);
    await draw();
    await page.keyboard.press('Control+s');
    await expect.poll(saved).toEqual([20, 20]);
    await expect
      .poll(() =>
        canvas.evaluate((element: HTMLCanvasElement) => {
          const rect = element.getBoundingClientRect();
          const x =
            (Math.max(rect.left, 0) + Math.min(rect.right, innerWidth)) / 2;
          const y =
            (Math.max(rect.top, 100) +
              Math.min(rect.bottom, innerHeight - 100)) /
            2;
          const sx = element.width / rect.width,
            sy = element.height / rect.height;
          const pixels = element
            .getContext('2d')!
            .getImageData(
              Math.floor((x - rect.left) * sx),
              Math.floor((y - rect.top - 12) * sy),
              Math.max(1, Math.ceil(42 * sx)),
              Math.max(1, Math.ceil(24 * sy)),
            ).data;
          let ink = 0;
          for (let i = 0; i < pixels.length; i += 4) {
            if (
              pixels[i]! < 100 &&
              pixels[i + 1]! < 100 &&
              pixels[i + 2]! < 100 &&
              pixels[i + 3]! > 100
            )
              ink++;
          }
          return ink;
        }),
      )
      .toBeGreaterThan(0);
    await page.screenshot({ path: test.info().outputPath(`${kind}-zoom.png`) });
    await page.reload();
    await page.getByRole('button', { name: /Pencil recovery Browser/ }).click();
    await expect.poll(saved).toEqual([20, 20]);
  });
}
