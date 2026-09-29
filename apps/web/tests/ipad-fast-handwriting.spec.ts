import { expect, test } from '@playwright/test';
import { createFromSidebar } from './support/sidebar-create.js';

test.use({
  viewport: { width: 1024, height: 768 },
  deviceScaleFactor: 2,
  hasTouch: true,
});

for (const kind of ['Ink', 'Notebook', 'Whiteboard']) {
  test(`${kind}: rapid consecutive strokes preserve curves without a closing chord`, async ({
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
    await page.getByTestId('create-vault-name-input').fill('Fast handwriting');
    await page.getByTestId('choose-vault-location-button').click();
    await page.getByTestId('confirm-create-vault-button').click();
    await createFromSidebar(page, new RegExp(`^${kind}`));
    await page.getByRole('textbox', { name: 'Note name' }).fill('Curves');
    await page
      .getByRole('dialog', { name: 'Create a new note' })
      .getByRole('button', { name: 'Create', exact: true })
      .click();
    const canvas = page.locator('.fl-ink-canvas').first();
    await expect(canvas).toBeVisible();
    const probe = await canvas.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const x =
        (Math.max(rect.left, 0) + Math.min(rect.right, innerWidth)) / 2 - 100;
      const y =
        (Math.max(rect.top, 100) + Math.min(rect.bottom, innerHeight - 100)) /
        2;
      const bitmap = element as HTMLCanvasElement;
      const ctx = bitmap.getContext('2d')!;
      const px = Math.round(((x + 50 - rect.left) * bitmap.width) / rect.width);
      const py = Math.round(((y - rect.top) * bitmap.height) / rect.height);
      const before = Array.from(ctx.getImageData(px - 2, py - 2, 5, 5).data);
      // Synthetic input cannot establish native pointer capture. Everything
      // beyond that boundary is the real provider, engine, paint and saving.
      element.setPointerCapture = () => undefined;
      let time = 1000;
      const dispatch = (
        type: string,
        point: { x: number; y: number },
        samples?: { x: number; y: number }[],
      ) => {
        const event = new PointerEvent(type, {
          pointerId: 42,
          pointerType: 'pen',
          pressure: 0.5,
          buttons: type === 'pointerup' ? 0 : 1,
          clientX: point.x,
          clientY: point.y,
          bubbles: true,
          cancelable: true,
        });
        Object.defineProperty(event, 'timeStamp', { value: time++ });
        if (samples)
          Object.defineProperty(event, 'getCoalescedEvents', {
            value: () =>
              samples.map((point) => ({
                clientX: point.x,
                clientY: point.y,
                pressure: 0.5,
                tiltX: 0,
                tiltY: 0,
                twist: 0,
                timeStamp: time++,
              })),
          });
        element.dispatchEvent(event);
      };
      dispatch('pointerdown', { x: x - 30, y: y + 20 });
      dispatch('pointermove', { x: x - 10, y });
      dispatch('pointerup', { x: x - 10, y });
      // Start the next stroke immediately, with no render frame in between.
      const curve = Array.from({ length: 61 }, (_, i) => ({
        x: x + i * 3,
        y: y + 40 * Math.sin((i * Math.PI) / 30),
      }));
      dispatch('pointerdown', curve[0]!);
      // A processed parent differs from its final coalesced contact. It
      // must not insert a chord back across the wave before pointerup.
      dispatch('pointermove', curve[0]!, curve.slice(1));
      dispatch('pointerup', curve[60]!);
      return { px, py, before };
    });
    await page.keyboard.press('Control+s');
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const vault = await (
            await navigator.storage.getDirectory()
          ).getDirectoryHandle('Fast handwriting');
          for await (const [name, entry] of vault.entries()) {
            if (entry.kind !== 'file' || !name.startsWith('Curves.')) continue;
            let data: unknown;
            try {
              data = JSON.parse(await (await entry.getFile()).text());
            } catch {
              // Saving may still be replacing the disposable vault file.
              return [];
            }
            const counts: number[] = [];
            const visit = (value: unknown): void => {
              if (value === null || typeof value !== 'object') return;
              const record = value as Record<string, unknown>;
              if (record.type === 'froglight.ink.stroke')
                counts.push(
                  Array.isArray(record.points) ? record.points.length : 0,
                );
              else Object.values(record).forEach(visit);
            };
            visit(data);
            return counts;
          }
          return [];
        }),
      )
      .toEqual([2, 61]);
    // The chord would cross this patch; the actual curve stays 35px away.
    await expect
      .poll(() =>
        canvas.evaluate(
          (element, probe) =>
            Array.from(
              (element as HTMLCanvasElement)
                .getContext('2d')!
                .getImageData(probe.px - 2, probe.py - 2, 5, 5).data,
            ),
          probe,
        ),
      )
      .toEqual(probe.before);
  });
}
