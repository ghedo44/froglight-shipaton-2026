import { expect, test } from '@playwright/test';
import { createFromSidebar } from './support/sidebar-create.js';

// Real assembled providers, Canvas and disposable OPFS; synthetic input is
// deliberately not evidence of physical Pencil/WKWebView delivery.
test.use({
  viewport: { width: 1024, height: 768 },
  hasTouch: true,
  contextOptions: { reducedMotion: 'reduce' },
});
for (const kind of ['Notebook', 'Whiteboard']) {
  for (const sampleCount of [6000, 12000]) {
    test(`${kind} ${sampleCount} samples: long pen release and autosave remain responsive and durable`, async ({
      page,
    }) => {
      test.setTimeout(120_000);
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
        .fill('Pencil performance');
      await page.getByTestId('choose-vault-location-button').click();
      await page.getByTestId('confirm-create-vault-button').click();
      await createFromSidebar(page, new RegExp(`^${kind}`));
      await page
        .getByRole('textbox', { name: 'Note name' })
        .fill('Long stroke');
      await page
        .getByRole('dialog', { name: 'Create a new note' })
        .getByRole('button', { name: 'Create', exact: true })
        .click();
      const canvas = page.locator('.fl-ink-canvas').first();
      await expect(canvas).toBeVisible();
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      const report = await canvas.evaluate(async (element, sampleCount) => {
        element.setPointerCapture = () => undefined;
        const rect = element.getBoundingClientRect();
        const cx =
          (Math.max(0, rect.left) + Math.min(innerWidth, rect.right)) / 2;
        const cy =
          (Math.max(100, rect.top) + Math.min(innerHeight - 100, rect.bottom)) /
          2;
        const frame = () =>
          new Promise<number>((resolve) => requestAnimationFrame(resolve));
        const point = (i: number, type: string) => {
          const angle = i * 0.018;
          const event = new PointerEvent(type, {
            pointerId: 42,
            pointerType: 'pen',
            buttons: type === 'pointerup' ? 0 : 1,
            pressure: type === 'pointerup' ? 0 : 0.6,
            clientX: cx + Math.sin(angle) * 100,
            clientY: cy + Math.cos(angle * 1.13) * 65,
            bubbles: true,
            cancelable: true,
          });
          Object.defineProperty(event, 'timeStamp', { value: 1000 + i * 4 });
          return event;
        };
        element.dispatchEvent(point(0, 'pointerdown'));
        for (let start = 1; start < sampleCount; start += 50) {
          const batch = Array.from(
            { length: Math.min(50, sampleCount - start) },
            (_, j) => point(start + j, 'pointermove'),
          );
          const event = batch.at(-1)!;
          Object.defineProperty(event, 'getCoalescedEvents', {
            value: () => batch,
          });
          element.dispatchEvent(event);
          await frame();
        }
        await frame();
        const start = performance.now();
        element.dispatchEvent(point(sampleCount - 1, 'pointerup'));
        const pointerUpMs = performance.now() - start;
        let last = start;
        let maxGapMs = 0;
        const gaps: { at: number; ms: number }[] = [];
        while (performance.now() - start < 5000) {
          await frame();
          const now = performance.now();
          const ms = now - last;
          maxGapMs = Math.max(maxGapMs, ms);
          if (ms > 50) gaps.push({ at: last - start, ms });
          last = now;
        }
        return { pointerUpMs, maxGapMs, gaps };
      }, sampleCount);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      console.log(
        `${kind} ${sampleCount} samples pen release/autosave: ${JSON.stringify(report)}`,
      );
      const saved = () =>
        page.evaluate(async () => {
          try {
            const vault = await (
              await navigator.storage.getDirectory()
            ).getDirectoryHandle('Pencil performance');
            for await (const [name, entry] of vault.entries()) {
              if (entry.kind !== 'file' || !name.startsWith('Long stroke.'))
                continue;
              const data: unknown = JSON.parse(
                await (await entry.getFile()).text(),
              );
              const counts: number[] = [];
              const visit = (value: unknown): void => {
                if (value === null || typeof value !== 'object') return;
                const record = value as Record<string, unknown>;
                if (record.type === 'froglight.ink.stroke')
                  counts.push((record.points as unknown[]).length);
                else Object.values(record).forEach(visit);
              };
              visit(data);
              return counts;
            }
            return null;
          } catch (error) {
            // A direct OPFS read can overlap a write; retry incomplete JSON.
            // Persistently malformed content still fails the polling assertion.
            if (error instanceof SyntaxError) return null;
            if (error instanceof DOMException && error.name === 'NotFoundError')
              return null;
            throw error;
          }
        });
      await expect
        .poll(saved)
        .toEqual(
          sampleCount > 10000 ? [10000, sampleCount - 10000] : [sampleCount],
        );
      // Generous desktop regression ceiling detects the reported multi-second
      // stalls without claiming a physical-device frame budget.
      expect(report.pointerUpMs).toBeLessThan(250);
      expect(report.maxGapMs).toBeLessThan(250);
      await page.keyboard.press('Control+z');
      await page.keyboard.press('Control+s');
      await expect.poll(saved).toEqual([]);
      await page.keyboard.press('Control+Shift+z');
      await page.keyboard.press('Control+s');
      await expect
        .poll(saved)
        .toEqual(
          sampleCount > 10000 ? [10000, sampleCount - 10000] : [sampleCount],
        );
      await page.reload();
      await page
        .getByRole('button', { name: /Pencil performance Browser/ })
        .click();
      await expect
        .poll(saved)
        .toEqual(
          sampleCount > 10000 ? [10000, sampleCount - 10000] : [sampleCount],
        );
    });
  }
}
