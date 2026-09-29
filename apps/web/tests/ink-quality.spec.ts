import { expect, test, type Page } from '@playwright/test';
import { createFromSidebar } from './support/sidebar-create.js';

// Real application + production providers. CDP establishes real pointer capture;
// deterministic DOM raw/move batches then exercise the normal input boundary.
// This is browser evidence, not physical stylus latency or palm-rejection proof.
test.use({ viewport: { width: 1360, height: 1000 }, serviceWorkers: 'block' });

type Sample = { x: number; y: number; dt: number; pressure?: number };
type Stroke = { points: Sample[]; brush: unknown; erasure?: unknown };
type Surface = {
  formatVersion: number;
  order: string[];
  objects: Record<string, Stroke>;
};
const fixtures = [
  {
    name: 'figure eight',
    brush: 'Pen',
    count: 241,
    path: (u: number) => [
      570 + 50 * Math.sin(u * 2 * Math.PI),
      440 + 25 * Math.sin(u * 4 * Math.PI),
    ],
  },
  {
    name: 'spiral',
    brush: 'Fountain Pen',
    count: 301,
    path: (u: number) => [
      740 + 38 * u * Math.cos(u * 6 * Math.PI),
      445 + 38 * u * Math.sin(u * 6 * Math.PI),
    ],
  },
  {
    name: 'acute reversals',
    brush: 'Brush Pen',
    count: 241,
    path: (u: number) => {
      const points = [
        [500, 550],
        [540, 500],
        [545, 551],
        [590, 510],
        [545, 553],
        [615, 552],
      ];
      const q = Math.min(4.999, u * 5),
        i = Math.floor(q),
        v = q - i;
      return [
        points[i]![0]! * (1 - v) + points[i + 1]![0]! * v,
        points[i]![1]! * (1 - v) + points[i + 1]![1]! * v,
      ];
    },
  },
  {
    name: 'missing pressure',
    brush: 'Brush Pen',
    count: 401,
    missing: true,
    path: (u: number) => [
      660 + 170 * u * u,
      550 + 20 * Math.sin(u * 6 * Math.PI),
    ],
  },
  {
    name: 'stationary pressure',
    brush: 'Pencil',
    count: 181,
    path: (u: number) => (u < 0.5 ? [550, 620] : [550 + (u - 0.5) * 120, 620]),
  },
  {
    name: 'wide loops',
    brush: 'Highlighter',
    count: 241,
    path: (u: number) => [
      680 + 100 * u + 10 * Math.sin(u * 6 * Math.PI),
      620 + 14 * Math.sin(u * 8 * Math.PI),
    ],
  },
  { name: 'dot', brush: 'Pen', count: 1, path: () => [520, 680] },
  {
    name: 'flick',
    brush: 'Fountain Pen',
    count: 5,
    path: (u: number) => [560 + 8 * u, 680 - 6 * u],
  },
];

async function settle(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

test('ink batches, prediction, erasure and reopen preserve source and appearance', async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
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
    .fill('ink-quality-disposable');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();
  await page
    .getByRole('tab', { name: /welcome\.md/ })
    .first()
    .waitFor({ timeout: 60_000 });
  const cdp = await context.newCDPSession(page);
  const pointer = async (
    type: 'mouseMoved' | 'mousePressed' | 'mouseReleased',
    sample: { x: number; y: number; pressure?: number },
    down = true,
  ) => {
    await cdp.send('Input.dispatchMouseEvent', {
      type,
      x: sample.x,
      y: sample.y,
      button: 'left',
      buttons: down ? 1 : 0,
      pointerType: 'pen',
      force: down ? (sample.pressure ?? 0.5) : 0,
    });
  };
  const read = async (name: string): Promise<Surface> => {
    await settle(page);
    await page.keyboard.press('Control+s');
    await expect(
      page
        .getByRole('tab', { name: new RegExp(name) })
        .getByTitle('Unsaved changes'),
    ).toHaveCount(0);
    const saved: { text: string | null } = { text: null };
    await expect
      .poll(
        async () => {
          saved.text = await page.evaluate(async (name) => {
            try {
              const root = await navigator.storage.getDirectory();
              const vault = await root.getDirectoryHandle(
                'ink-quality-disposable',
              );
              const file = await (
                await vault.getFileHandle(`${name}.ink`)
              ).getFile();
              return (await file.text()) || null;
            } catch (error) {
              if (
                error instanceof DOMException &&
                ['NotFoundError', 'NotReadableError'].includes(error.name)
              ) {
                return null;
              }
              throw error;
            }
          }, name);
          return saved.text !== null;
        },
        { timeout: 10_000 },
      )
      .toBe(true);
    const text = saved.text;
    if (text === null) throw new Error('No saved Surface bytes');
    return JSON.parse(text) as Surface;
  };
  const capture = async () => {
    await pointer('mouseMoved', { x: 20, y: 20 }, false);
    await settle(page);
    return page.screenshot({
      clip: { x: 480, y: 390, width: 370, height: 320 },
    });
  };
  let reference: Array<{ points: Sample[]; brush: unknown }> | undefined;
  let referenceImage: Buffer | undefined;
  for (const mode of ['single', 'irregular', 'dense'] as const) {
    const name = `Replay ${mode}`;
    await createFromSidebar(page, 'Ink page');
    await page.getByRole('textbox', { name: 'Note name' }).fill(name);
    await page.getByRole('radio', { name: /^Ink/ }).click();
    await page
      .getByRole('dialog', { name: 'Create a new note' })
      .getByRole('button', { name: 'Create', exact: true })
      .click();
    await page.getByRole('tab', { name: new RegExp(name) }).waitFor();
    const canvas = page.locator('.fl-ink-canvas').first();
    await canvas.waitFor();
    await page.getByRole('button', { name: 'Brush Pen', exact: true }).click();
    await settle(page);
    for (const fixture of fixtures) {
      if (fixture.brush === 'Highlighter') {
        await page
          .locator('[data-toolbar="category-strip"]')
          .getByRole('button', { name: 'Highlighter', exact: true })
          .click();
      } else if (
        !(await page.locator('[data-tool-shelf="surface.write"]').isVisible())
      ) {
        await page
          .locator('[data-toolbar="category-strip"]')
          .getByRole('button', { name: 'Pen', exact: true })
          .click();
      }
      await page
        .locator(
          fixture.brush === 'Highlighter'
            ? '[data-tool-shelf="surface.highlighter"]'
            : '[data-tool-shelf="surface.write"]',
        )
        .getByRole('button', { name: fixture.brush, exact: true })
        .click();
      await settle(page);
      const samples: Sample[] = Array.from(
        { length: fixture.count },
        (_, i) => {
          const u = fixture.count === 1 ? 0 : i / (fixture.count - 1);
          const [x, y] = fixture.path(u);
          return {
            x: x!,
            y: y!,
            dt: i * 8,
            ...('missing' in fixture
              ? {}
              : {
                  pressure:
                    fixture.name === 'figure eight'
                      ? 0.65
                      : i % 37 < 3
                        ? 0
                        : 0.15 + 0.8 * u,
                }),
          };
        },
      );
      await canvas.evaluate((c) =>
        c.addEventListener(
          'pointerdown',
          (event) => {
            const e = event as PointerEvent;
            (c as HTMLElement).dataset.qualityPointerId = String(e.pointerId);
            (c as HTMLElement).dataset.qualityPointerTime = String(e.timeStamp);
          },
          { once: true },
        ),
      );
      await pointer('mouseMoved', samples[0]!, false);
      await pointer('mousePressed', samples[0]!);
      const input = await canvas.evaluate((c) => ({
        id: Number((c as HTMLElement).dataset.qualityPointerId),
        time: Number((c as HTMLElement).dataset.qualityPointerTime),
      }));
      expect(Number.isFinite(input.id)).toBe(true);
      let index = 1;
      while (index < samples.length) {
        const count =
          mode === 'single'
            ? 1
            : mode === 'dense'
              ? 32
              : [1, 7, 3, 19][index % 4]!;
        const batch = samples.slice(index, index + count);
        const predicted =
          mode === 'irregular'
            ? samples.slice(index + count, index + count + 3)
            : [];
        await canvas.evaluate(
          (c, { batch, predicted, input }) => {
            const makeEvent = (p: Sample, type: string) => {
              const event = new PointerEvent(type, {
                bubbles: true,
                pointerId: input.id,
                pointerType: 'pen',
                isPrimary: true,
                buttons: 1,
                button: -1,
                clientX: p.x,
                clientY: p.y,
                pressure: p.pressure ?? 0,
              });
              Object.defineProperty(event, 'timeStamp', {
                value: input.time + p.dt,
              });
              if (p.pressure === undefined)
                Object.defineProperty(event, 'pressure', { value: undefined });
              return event;
            };
            for (const type of ['pointerrawupdate', 'pointermove']) {
              const event = makeEvent(batch[batch.length - 1]!, type);
              Object.defineProperty(event, 'getCoalescedEvents', {
                value: () => batch.map((p) => makeEvent(p, type)),
              });
              Object.defineProperty(event, 'getPredictedEvents', {
                value: () => predicted.map((p) => makeEvent(p, type)),
              });
              c.dispatchEvent(event);
            }
          },
          { batch, predicted, input },
        );
        index += batch.length;
        if (mode !== 'dense' || index % 64 === 1) await settle(page);
      }
      const last = samples[samples.length - 1]!;
      await canvas.evaluate(
        (c, { input, last }) => {
          const event = new PointerEvent('pointerup', {
            bubbles: true,
            pointerId: input.id,
            pointerType: 'pen',
            isPrimary: true,
            buttons: 0,
            button: 0,
            pressure: 0,
            clientX: last.x,
            clientY: last.y,
          });
          Object.defineProperty(event, 'timeStamp', {
            value: input.time + last.dt,
          });
          c.dispatchEvent(event);
        },
        { input, last },
      );
      await pointer('mouseReleased', last, false);
      await settle(page);
    }
    await expect
      .poll(async () => (await read(name)).order.length)
      .toBe(fixtures.length);
    const model = await read(name);
    const source = model.order.map((id) => ({
      points: model.objects[id]!.points,
      brush: model.objects[id]!.brush,
    }));
    const image = await capture();
    await testInfo.attach(`${mode}-writing`, {
      body: image,
      contentType: 'image/png',
    });
    if (reference === undefined) {
      reference = source;
      referenceImage = image;
    } else {
      expect(source).toEqual(reference);
      expect(image).toEqual(referenceImage);
    }
    if (mode === 'single') {
      await canvas.evaluate((c) =>
        c.addEventListener(
          'pointerdown',
          (event) => {
            c.dataset['cancelPointer'] = String(
              (event as PointerEvent).pointerId,
            );
          },
          { once: true },
        ),
      );
      await pointer('mousePressed', { x: 500, y: 690 });
      await pointer('mouseMoved', { x: 540, y: 695 });
      await canvas.evaluate((c) => {
        const pointerId = Number(c.dataset['cancelPointer']);
        c.dispatchEvent(
          new PointerEvent('pointercancel', {
            bubbles: true,
            pointerId,
            pointerType: 'pen',
            isPrimary: true,
          }),
        );
      });
      await pointer('mouseReleased', { x: 540, y: 695 }, false);
      expect((await read(name)).order).toEqual(model.order);
      await page
        .getByRole('tab', { name: /welcome\.md/ })
        .first()
        .click();
      await page.getByRole('tab', { name: new RegExp(name) }).click();
      await canvas.waitFor();
      expect(await capture()).toEqual(image);
    }
    if (mode !== 'dense') continue;
    await page.getByRole('button', { name: 'Eraser', exact: true }).click();
    await page
      .getByRole('button', { name: 'Precision Eraser', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Eraser size slot 1: 4', exact: true })
      .click();
    await settle(page);
    await pointer('mousePressed', { x: 740, y: 390 });
    await pointer('mouseMoved', { x: 740, y: 700 });
    await pointer('mouseReleased', { x: 740, y: 700 }, false);
    await expect.poll(async () => (await read(name)).formatVersion).toBe(1);
    const erased = await read(name);
    expect(erased.order).toEqual(model.order);
    expect(
      erased.order.map((id) => ({
        points: erased.objects[id]!.points,
        brush: erased.objects[id]!.brush,
      })),
    ).toEqual(source);
    expect(
      erased.order.some((id) => erased.objects[id]!.erasure !== undefined),
    ).toBe(true);
    const erasedImage = await capture();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    expect(await capture()).toEqual(image);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    expect(await capture()).toEqual(erasedImage);
    await expect.poll(async () => await read(name)).toEqual(erased);
    await page.reload();
    await page
      .getByRole('button', {
        name: /ink-quality-disposable\s*Browser private storage/,
      })
      .click();
    await page.getByText(`${name}.ink`, { exact: true }).first().dblclick();
    await canvas.waitFor();
    await expect
      .poll(async () => (await capture()).equals(erasedImage))
      .toBe(true);
    await page.getByRole('button', { name: 'Eraser', exact: true }).click();
    for (const mode of ['Precision Eraser', 'Stroke Eraser']) {
      await page.getByRole('button', { name: mode, exact: true }).click();
      // Empty-space gestures must not create history or change canonical ink.
      await pointer('mousePressed', { x: 490, y: 710 });
      await pointer('mouseMoved', { x: 820, y: 710 });
      await pointer('mouseReleased', { x: 820, y: 710 }, false);
      expect(await read(name)).toEqual(erased);
      expect(await capture()).toEqual(erasedImage);
      await expect(
        page.getByRole('button', { name: 'Undo', exact: true }),
      ).toHaveCount(0);
      if (mode === 'Precision Eraser') {
        // Repeating the same footprint is also a no-op after cache rebuild.
        await pointer('mousePressed', { x: 740, y: 390 });
        await pointer('mouseMoved', { x: 740, y: 700 });
        await pointer('mouseReleased', { x: 740, y: 700 }, false);
        expect(await read(name)).toEqual(erased);
        expect(await capture()).toEqual(erasedImage);
        await expect(
          page.getByRole('button', { name: 'Undo', exact: true }),
        ).toHaveCount(0);
      } else {
        await pointer('mousePressed', { x: 570, y: 400 });
        await pointer('mouseMoved', { x: 570, y: 480 });
        await pointer('mouseReleased', { x: 570, y: 480 }, false);
        await expect.poll(async () => await read(name)).not.toEqual(erased);
        const cut = await read(name);
        if (mode === 'Stroke Eraser') {
          expect(cut.order.length).toBe(erased.order.length - 1);
        } else {
          expect(cut.order).toEqual(erased.order);
          expect(
            cut.order.map((id) => ({
              points: cut.objects[id]!.points,
              brush: cut.objects[id]!.brush,
            })),
          ).toEqual(source);
        }
        await page.getByRole('button', { name: 'Undo', exact: true }).click();
        expect(await capture()).toEqual(erasedImage);
        await expect.poll(async () => await read(name)).toEqual(erased);
      }
    }
  }
  expect(errors).toEqual([]);
});
