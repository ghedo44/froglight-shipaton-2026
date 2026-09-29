import { expect, test, type Page } from '@playwright/test';
import { createFromSidebar } from './support/sidebar-create.js';

test.use({
  viewport: { width: 1024, height: 768 },
  contextOptions: { reducedMotion: 'reduce' },
});

async function setup(
  page: Page,
  kind: 'Ink' | 'Notebook' | 'Whiteboard',
): Promise<void> {
  await page.addInitScript(() => {
    // This fresh browser context owns only the disposable acceptance vault.
    // Keep an unrelated demo installation from racing reload/recovery tests.
    localStorage.setItem('froglight-asteria-demo.hidden', 'true');
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: undefined,
      configurable: true,
    });
  });
  await page.goto('/');
  await page.getByTestId('create-vault-button').click();
  await page.getByTestId('create-vault-name-input').fill('Journal acceptance');
  await page.getByTestId('choose-vault-location-button').click();
  await page.getByTestId('confirm-create-vault-button').click();
  await createFromSidebar(page, new RegExp(`^${kind}`));
  await page.getByRole('textbox', { name: 'Note name' }).fill('Continuous ink');
  await page
    .getByRole('dialog', { name: 'Create a new note' })
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  await expect(page.locator('.fl-ink-canvas').first()).toBeVisible({
    timeout: 20_000,
  });
}
async function reopen(page: Page): Promise<void> {
  await page.getByTestId('open-recent-vault-button-0').click();
  const document = page
    .getByRole('complementary', { name: 'Sidebar', exact: true })
    .getByRole('button', {
      name: /^Continuous ink\.(ink|whiteboard|notebook)$/,
    });
  if (!(await document.isVisible()))
    await page.getByRole('button', { name: /^(Toggle|Open) sidebar$/ }).click();
  await document.click();
  await expect(page.locator('.fl-ink-canvas').first()).toBeVisible({
    timeout: 20_000,
  });
}
async function heads(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('froglight-persistence', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const values = await new Promise<unknown[]>((resolve, reject) => {
      const request = db.transaction('records').objectStore('records').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return values.filter(
      (value) =>
        typeof value === 'object' &&
        value !== null &&
        (value as { format?: string }).format === 'froglight.local-journal',
    ) as Array<{
      durableSeq: number;
      publishedSeq: number;
      checkpointSeq: number;
      journal: number[];
      units: Record<string, string>;
    }>;
  });
}
async function counts(page: Page) {
  return page.evaluate(async () => {
    const root = await (
      await navigator.storage.getDirectory()
    ).getDirectoryHandle('Journal acceptance');
    const file = await root
      .getFileHandle('Continuous ink.whiteboard')
      .catch(() => root.getFileHandle('Continuous ink.notebook'));
    const data = JSON.parse(await (await file.getFile()).text()) as {
      objects?: Record<string, { points?: unknown[] }>;
      pages?: Record<
        string,
        { surface: { objects: Record<string, { points?: unknown[] }> } }
      >;
    };
    const records =
      data.objects === undefined
        ? Object.values(data.pages!).flatMap((page) =>
            Object.values(page.surface.objects),
          )
        : Object.values(data.objects);
    return {
      strokes: records.filter((record) => record.points !== undefined).length,
      points: records.reduce(
        (sum, record) => sum + (record.points?.length ?? 0),
        0,
      ),
    };
  });
}
async function draw(page: Page, count: number, points: number, finish = true) {
  return page
    .locator('.fl-ink-canvas')
    .first()
    .evaluate(
      async (element, input) => {
        element.setPointerCapture = () => undefined;
        const rect = element.getBoundingClientRect();
        const times: number[] = [];
        const cx = Math.max(rect.left + 50, 450),
          cy = Math.max(rect.top + 100, 220);
        const event = (type: string, stroke: number, point: number) => {
          const e = new PointerEvent(type, {
            pointerId: 400 + stroke,
            pointerType: 'pen',
            pressure: 0.6,
            buttons: type === 'pointerup' ? 0 : 1,
            clientX: cx + (point % 80),
            clientY: cy + Math.sin(point / 4) * 10 + (stroke % 12),
            bubbles: true,
            cancelable: true,
          });
          Object.defineProperty(e, 'timeStamp', {
            value: stroke * 10000 + point * 4,
          });
          return e;
        };
        for (let stroke = 0; stroke < input.count; stroke++) {
          const started = performance.now();
          element.dispatchEvent(event('pointerdown', stroke, 0));
          for (let start = 1; start < input.points; start += 32) {
            const batch = Array.from(
              { length: Math.min(32, input.points - start) },
              (_, i) => event('pointermove', stroke, start + i),
            );
            const last = batch.at(-1)!;
            Object.defineProperty(last, 'getCoalescedEvents', {
              value: () => batch,
            });
            element.dispatchEvent(last);
            if (input.points > 256)
              await new Promise<void>((resolve) =>
                requestAnimationFrame(() => resolve()),
              );
          }
          if (input.finish)
            element.dispatchEvent(event('pointerup', stroke, input.points - 1));
          times.push(performance.now() - started);
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
        }
        return times;
      },
      { count, points, finish },
    );
}

for (const kind of ['Notebook', 'Whiteboard'] as const) {
  test(`${kind}: continuous short strokes progress, compact, and recover before vault publication`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') console.log(message.text());
    });
    await setup(page, kind);
    const work = await draw(page, 140, 12);
    await expect(
      page.getByRole('tab', { name: /^Continuous ink\./ }),
    ).toHaveAttribute(
      'aria-description',
      'Saved locally. Vault update pending.',
      { timeout: 20_000 },
    );
    const head = (await heads(page))[0]!;
    expect(head.checkpointSeq).toBeGreaterThan(0);
    expect(head.journal.length).toBeLessThan(128);
    expect(head.durableSeq).toBeGreaterThan(head.publishedSeq);
    const sorted = [...work].sort((a, b) => a - b);
    console.log(
      `${kind} short stroke handler ms: p95=${sorted[Math.floor(sorted.length * 0.95)]} max=${sorted.at(-1)}`,
    );
    await page.reload();
    await reopen(page);
    // A recovered session is dirty and must schedule publication even before
    // another user edit. Continue writing while that publication runs.
    await draw(page, 10, 12);
    await expect
      .poll(() => counts(page).catch(() => null), { timeout: 25_000 })
      .toEqual({ strokes: 150, points: 1800 });
    expect(errors).toEqual([]);
    await page.reload();
    await reopen(page);
    expect(await counts(page)).toEqual({ strokes: 150, points: 1800 });
  });
}

test('a long in-progress stroke recovers confirmed blocks after the page stops', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await setup(page, 'Whiteboard');
  await draw(page, 1, 1024, false);
  await expect
    .poll(async () => (await heads(page))[0]?.durableSeq)
    .toBeGreaterThan(1);
  await page.reload();
  await reopen(page);
  // Publish recovery without inventing a pointerup or adding a sample.
  await page.keyboard.press('Control+s');
  await expect
    .poll(
      async () => (await counts(page).catch(() => ({ points: -1 }))).points,
      { timeout: 20_000 },
    )
    .toBeGreaterThanOrEqual(769);
});

test('external changes preserve local edits and require an explicit replacement', async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  await setup(page, 'Whiteboard');
  await draw(page, 2, 12);
  await expect
    .poll(async () => (await heads(page))[0]?.durableSeq)
    .toBeGreaterThanOrEqual(2);
  await page.evaluate(async () => {
    const root = await (
      await navigator.storage.getDirectory()
    ).getDirectoryHandle('Journal acceptance');
    const file = await root.getFileHandle('Continuous ink.whiteboard');
    const data = JSON.parse(await (await file.getFile()).text());
    data.meta = { title: 'External edit' };
    const writable = await file.createWritable();
    await writable.write(JSON.stringify(data));
    await writable.close();
  });
  await page.keyboard.press('Control+s');
  const conflict = page.getByRole('dialog', { name: 'The vault file changed' });
  await expect(conflict).toBeVisible();
  expect(await counts(page)).toEqual({ strokes: 0, points: 0 });
  await page.screenshot({ path: testInfo.outputPath('conflict-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('conflict-mobile.png') });
  await conflict.getByRole('button', { name: 'Keep editing' }).click();
  await draw(page, 1, 12);
  await page.keyboard.press('Control+s');
  await expect(conflict).toBeVisible();
  await conflict.getByRole('button', { name: 'Replace vault version' }).click();
  await expect(conflict).toBeHidden();
  await expect
    .poll(() => counts(page).catch(() => null))
    .toEqual({ strokes: 3, points: 36 });
});

test('a delayed vault publication does not hold back the journal or lose later strokes', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await setup(page, 'Whiteboard');
  await page.evaluate(() => {
    const original = FileSystemFileHandle.prototype.createWritable;
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const state = { entered: false, release };
    Object.assign(window, { publicationGate: state });
    let armed = true;
    FileSystemFileHandle.prototype.createWritable = async function (options) {
      if (armed && this.name === 'Continuous ink.whiteboard') {
        armed = false;
        state.entered = true;
        await wait;
      }
      return original.call(this, options);
    };
  });
  await draw(page, 2, 12);
  await page.keyboard.press('Control+s');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { publicationGate: { entered: boolean } })
            .publicationGate.entered,
      ),
    )
    .toBe(true);
  const before = (await heads(page))[0]!;
  await draw(page, 40, 12);
  await expect
    .poll(async () => (await heads(page))[0]?.durableSeq)
    .toBeGreaterThan(before.durableSeq);
  expect((await heads(page))[0]!.publishedSeq).toBe(before.publishedSeq);
  expect(await counts(page)).toEqual({ strokes: 0, points: 0 });
  // Admit another explicit save while the first publication is still blocked.
  await page.keyboard.press('Control+s');
  await page.evaluate(() =>
    (
      window as unknown as { publicationGate: { release(): void } }
    ).publicationGate.release(),
  );
  await expect
    .poll(() => counts(page).catch(() => null), { timeout: 3000 })
    .toEqual({ strokes: 42, points: 504 });
  await page.reload();
  await reopen(page);
  expect(await counts(page)).toEqual({ strokes: 42, points: 504 });
});

test('a stopped persistence worker replays its journal and accepts new edits', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => {
    const Original = Worker;
    class TrackedWorker extends Original {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (options?.name === 'froglight-persistence')
          Object.assign(window, { persistenceWorker: this });
      }
    }
    window.Worker = TrackedWorker;
  });
  await setup(page, 'Whiteboard');
  await draw(page, 10, 12);
  await expect(
    page.getByRole('tab', { name: /^Continuous ink\./ }),
  ).toHaveAttribute('aria-description', 'Saved locally. Vault update pending.');
  await page.evaluate(() => {
    const worker = (window as unknown as { persistenceWorker: Worker })
      .persistenceWorker;
    worker.terminate();
    // A process failure arrives through the same host error boundary.
    worker.dispatchEvent(
      new ErrorEvent('error', { message: 'Injected worker process exit' }),
    );
  });
  await draw(page, 10, 12);
  await expect(
    page.getByRole('tab', { name: /^Continuous ink\./ }),
  ).toHaveAttribute('aria-description', 'Saved locally. Vault update pending.');
  await page.keyboard.press('Control+s');
  await expect
    .poll(() => counts(page).catch(() => null))
    .toEqual({ strokes: 20, points: 240 });
});

test('a torn external file is recovered from the pending local publication', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await setup(page, 'Whiteboard');
  await page.evaluate(() => {
    const original = FileSystemFileHandle.prototype.createWritable;
    let armed = true;
    FileSystemFileHandle.prototype.createWritable = async function (options) {
      if (armed && this.name === 'Continuous ink.whiteboard') {
        armed = false;
        // Model a non-atomic provider stopping halfway through a write.
        const writable = await original.call(this, options);
        await writable.write('{"interrupted":');
        await writable.close();
        throw new DOMException(
          'Provider stopped during publication',
          'AbortError',
        );
      }
      return original.call(this, options);
    };
  });
  await draw(page, 3, 12);
  await page.keyboard.press('Control+s');
  await expect(
    page
      .getByRole('tab', { name: /^Continuous ink\./ })
      .locator('[data-save-error="true"]'),
  ).toBeVisible();
  await page.reload();
  await reopen(page);
  await page.keyboard.press('Control+s');
  const conflict = page.getByRole('dialog', { name: 'The vault file changed' });
  await expect(conflict).toBeVisible();
  await conflict.getByRole('button', { name: 'Replace vault version' }).click();
  await expect(conflict).toBeHidden();
  await expect
    .poll(() => counts(page).catch(() => null))
    .toEqual({ strokes: 3, points: 36 });
});

test('the installed production worker saves and reopens offline', async ({
  page,
  context,
}) => {
  test.setTimeout(60_000);
  await setup(page, 'Notebook');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await draw(page, 2, 12);
  await page.keyboard.press('Control+s');
  await expect
    .poll(() => counts(page).catch(() => null))
    .toEqual({ strokes: 2, points: 24 });
  await page.reload();
  await reopen(page);
  await expect
    .poll(() =>
      page.evaluate(() => navigator.serviceWorker.controller !== null),
    )
    .toBe(true);
  await context.setOffline(true);
  await draw(page, 2, 12);
  await page.keyboard.press('Control+s');
  await expect
    .poll(() => counts(page).catch(() => null))
    .toEqual({ strokes: 4, points: 48 });
  await page.reload();
  await reopen(page);
  expect(await counts(page)).toEqual({ strokes: 4, points: 48 });
});

test('journal protocol preserves quota failures, rejects corrupt recovery, and repairs missing acknowledgements', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => {
    const Original = Worker;
    window.Worker = class extends Original {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (options?.name === 'froglight-persistence')
          Object.assign(window, { persistenceWorkerUrl: String(url) });
      }
    };
  });
  await setup(page, 'Whiteboard');
  const result = await page.evaluate(async () => {
    const asset = new URL(
      (
        window as unknown as { persistenceWorkerUrl: string }
      ).persistenceWorkerUrl,
      location.href,
    ).href;
    const bootstrap = `
      const waiting = [];
      self.onmessage = event => waiting.push(event);
      let fail = false;
      const original = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function(names, mode, options) {
        if (fail && mode === 'readwrite') throw new DOMException('Injected quota failure', 'QuotaExceededError');
        return original.call(this, names, mode, options);
      };
      await import(${JSON.stringify(asset)});
      const receive = self.onmessage;
      self.onmessage = event => {
        if (event.data.operation === 'quota') { fail = event.data.fail; self.postMessage({id:event.data.id, result:null}); }
        else receive(event);
      };
      for (const event of waiting) self.onmessage(event);
    `;
    const url = URL.createObjectURL(
      new Blob([bootstrap], { type: 'text/javascript' }),
    );
    const worker = new Worker(url, { type: 'module' });
    const root = await (
      await navigator.storage.getDirectory()
    ).getDirectoryHandle('Journal acceptance');
    const data = new Uint8Array(
      await (
        await (await root.getFileHandle('Continuous ink.whiteboard')).getFile()
      ).arrayBuffer(),
    );
    const key = JSON.stringify(['protocol-acceptance', 'document', 'resource']);
    const ref = {
      documentId: 'document',
      kindId: 'froglight.whiteboard',
      location: { resourceId: 'resource' },
    };
    let id = 0;
    const requests = new Map<
      number,
      (value: { result?: unknown; error?: { code: string } }) => void
    >();
    worker.onmessage = (event) => {
      requests.get(event.data.id)?.(event.data);
      requests.delete(event.data.id);
    };
    const call = (
      operation: string,
      args: Record<string, unknown> = {},
      owner = '1',
    ) =>
      new Promise<{ result?: unknown; error?: { code: string } }>((resolve) => {
        const requestId = ++id;
        requests.set(requestId, resolve);
        worker.postMessage({
          id: requestId,
          owner,
          key,
          ref,
          operation,
          ...args,
        });
      });
    const decoded = JSON.parse(new TextDecoder().decode(data));
    const shell = {
      formatVersion: 1,
      frame: decoded.frame,
      unknownFields: { meta: { title: 'Locally protected' } },
    };
    const delta = { shell, surfaces: [] };
    try {
      const opened = await call('open', { data });
      const leased = await call('open', { data }, 'another-owner');
      await call('quota', { fail: true });
      const failed = await call('commit', { sequence: 1, delta });
      await call('quota', { fail: false });
      const committed = await call('commit', { sequence: 1, delta });
      const duplicate = await call('commit', { sequence: 1, delta });
      const snapshot = (await call('snapshot', { sequence: 1 })).result as {
        data: Uint8Array;
        checksum: string;
      };
      await call('dispose');
      // Bytes committed, but publication acknowledgement never arrived.
      const recovered = (await call('open', { data: snapshot.data }))
        .result as { sequence: number; publishedSequence: number };
      await call('dispose');
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('froglight-persistence', 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('records', 'readwrite');
        tx.objectStore('records').put(
          { format: 'froglight.local-journal', version: 1, durableSeq: 10 },
          `${key}/head`,
        );
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
      db.close();
      const corrupt = await call('open', { data: snapshot.data });
      return {
        opened: opened.error,
        leased: leased.error?.code,
        failed: failed.error?.code,
        committed: committed.error,
        duplicate: duplicate.error,
        recovered,
        corrupt: corrupt.error?.code,
      };
    } finally {
      worker.terminate();
      URL.revokeObjectURL(url);
    }
  });
  expect(result).toEqual({
    opened: undefined,
    leased: 'CONFLICT',
    failed: 'QUOTA_EXCEEDED',
    committed: undefined,
    duplicate: undefined,
    recovered: {
      sequence: 1,
      publishedSequence: 1,
      baseChecksum: expect.any(String),
      conflict: false,
      recoveredData: undefined,
    },
    corrupt: 'RECORD_CORRUPT',
  });
});

test('a dense surface publishes an older sequence while short strokes continue', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await setup(page, 'Whiteboard');
  await draw(page, 1, 12);
  await page.keyboard.press('Control+s');
  await expect
    .poll(() => counts(page).catch(() => null))
    .toEqual({ strokes: 1, points: 12 });
  await expect
    .poll(async () => {
      const head = (await heads(page))[0]!;
      return head.durableSeq === head.publishedSeq;
    })
    .toBe(true);
  await page.evaluate(async () => {
    const root = await (
      await navigator.storage.getDirectory()
    ).getDirectoryHandle('Journal acceptance');
    const file = await root.getFileHandle('Continuous ink.whiteboard');
    const data = JSON.parse(await (await file.getFile()).text());
    const source = Object.values(data.objects)[0] as {
      points: Array<{ x: number; y: number }>;
    };
    for (let i = 0; i < 4000; i++) {
      const id = `dense-${i}`;
      const record = structuredClone(source) as typeof source & {
        id: string;
        logicalId?: string;
        chunkIndex?: number;
      };
      record.id = id;
      if (record.logicalId !== undefined) {
        record.logicalId = id;
        record.chunkIndex = 0;
      }
      record.points = record.points.map((point) => ({
        ...point,
        x: point.x + (i % 64) * 20,
        y: point.y + Math.floor(i / 64) * 20,
      }));
      data.objects[id] = record;
      data.order.push(id);
    }
    const writable = await file.createWritable();
    await writable.write(JSON.stringify(data));
    await writable.close();
  });
  await page.reload();
  await reopen(page);
  const before = (await heads(page))[0]!.publishedSeq;
  let finished = false;
  const writing = draw(page, 300, 12).finally(() => {
    finished = true;
  });
  await expect
    .poll(async () => (await heads(page))[0]?.publishedSeq, { timeout: 20_000 })
    .toBeGreaterThan(before);
  expect(finished).toBe(false);
  await writing;
  await page.keyboard.press('Control+s');
  await expect
    .poll(() => counts(page).catch(() => null), { timeout: 20_000 })
    .toEqual({ strokes: 4301, points: 51612 });
  await page.reload();
  await reopen(page);
  expect(await counts(page)).toEqual({ strokes: 4301, points: 51612 });
});

for (const kind of ['Ink', 'Notebook', 'Whiteboard'] as const) {
  test(`${kind}: repeated precision erasures recover their shared sources from an unpublished local journal`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await setup(page, kind);
    await draw(page, 4, 256);
    await expect
      .poll(async () => (await heads(page))[0]?.durableSeq)
      .toBeGreaterThan(0);
    const initial = (await heads(page))[0]!.durableSeq;
    await page.getByRole('button', { name: 'Eraser', exact: true }).click();
    await page
      .getByRole('button', { name: 'Precision Eraser', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Eraser size slot 1: 4', exact: true })
      .click();
    await page.keyboard.press('Escape');
    const release = await page
      .locator('.fl-ink-canvas')
      .first()
      .evaluate((element) => {
        element.setPointerCapture = () => undefined;
        const rect = element.getBoundingClientRect(),
          cx = Math.max(rect.left + 50, 450),
          cy = Math.max(rect.top + 100, 220);
        const times: number[] = [];
        for (const [i, offset] of [20, 40, 60, 30, 50].entries()) {
          const dispatch = (type: string, y: number) =>
            element.dispatchEvent(
              new PointerEvent(type, {
                pointerId: 900 + i,
                pointerType: 'pen',
                pressure: 0.6,
                buttons: type === 'pointerup' ? 0 : 1,
                clientX: cx + offset,
                clientY: y,
                bubbles: true,
                cancelable: true,
              }),
            );
          dispatch('pointerdown', cy - 25);
          dispatch('pointermove', cy + 25);
          const start = performance.now();
          dispatch('pointerup', cy + 25);
          times.push(performance.now() - start);
        }
        return times;
      });
    await expect
      .poll(async () => (await heads(page))[0]?.durableSeq, { timeout: 20_000 })
      .toBeGreaterThan(initial);
    const head = (await heads(page))[0]!;
    expect(head.durableSeq).toBeGreaterThan(head.publishedSeq);
    console.log(`${kind} precision pointer release ms: ${release.join(', ')}`);
    await page.reload();
    await reopen(page);
    await page.keyboard.press('Control+s');
    const read = () =>
      page.evaluate(async () => {
        const root = await (
          await navigator.storage.getDirectory()
        ).getDirectoryHandle('Journal acceptance');
        let text = '';
        for (const extension of ['ink', 'whiteboard', 'notebook']) {
          try {
            text = await (
              await (
                await root.getFileHandle(`Continuous ink.${extension}`)
              ).getFile()
            ).text();
            break;
          } catch {
            // Try the next document-family extension.
          }
        }
        const data = JSON.parse(text);
        type Record = {
          type: string;
          chunks?: Array<{ points: unknown[] }>;
          points?: unknown[];
          sourceId?: string;
        };
        const payload = data as {
          objects?: { [id: string]: Record };
          pages?: {
            [id: string]: { surface: { objects: { [id: string]: Record } } };
          };
        };
        const records = Object.values(
          payload.objects ?? Object.values(payload.pages!)[0]!.surface.objects,
        );
        const sources = records.filter(
          (r) => r.type === 'froglight.ink.source',
        );
        return {
          sources: sources.length,
          samples: records.reduce(
            (n, r) =>
              n +
              (r.points?.length ?? 0) +
              (r.chunks?.reduce((n, c) => n + c.points.length, 0) ?? 0),
            0,
          ),
          fragments: records.filter((r) => r.sourceId !== undefined).length,
        };
      });
    await expect
      .poll(read, { timeout: 20_000 })
      .toMatchObject({ samples: 1024 });
    const saved = await read();
    expect(saved.sources).toBeGreaterThan(0);
    expect(saved.fragments).toBeGreaterThan(saved.sources);
    await page.reload();
    await reopen(page);
    expect(await read()).toEqual(saved);
    expect(errors).toEqual([]);
  });
}

test('failed journal recovery offers a separate last-valid export without overwriting recovery material', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await setup(page, 'Whiteboard');
  await draw(page, 1, 32);
  await expect
    .poll(async () => (await heads(page))[0]?.durableSeq)
    .toBeGreaterThan(0);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        try {
          const root = await (
            await navigator.storage.getDirectory()
          ).getDirectoryHandle('Journal acceptance');
          const internal = await root.getDirectoryHandle('.froglight');
          const dock = JSON.parse(
            await (
              await (await internal.getFileHandle('dock.json')).getFile()
            ).text(),
          ) as { panes: Array<{ activeTab: string | null }> };
          return dock.panes.some((p) => p.activeTab !== null);
        } catch {
          return false;
        }
      }),
    )
    .toBe(true);
  await page.reload();
  const original = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open('froglight-persistence', 1);
      request.onsuccess = () => resolve(request.result);
    });
    const all = await new Promise<[IDBValidKey[], unknown[]]>((resolve) => {
      const store = db.transaction('records').objectStore('records'),
        keys = store.getAllKeys(),
        values = store.getAll();
      values.onsuccess = () => resolve([keys.result, values.result]);
    });
    const index = all[0].findIndex((key) => String(key).endsWith('/head'));
    const key = String(all[0][index]),
      head = all[1][index] as { durableSeq: number; journal: number[] };
    const sequence = head.durableSeq + 1;
    head.durableSeq = sequence;
    head.journal.push(sequence);
    const delta = {
      shell: { formatVersion: 1, frame: { kind: 'infinite' } },
      surfaces: [
        {
          pageId: null,
          shell: { formatVersion: 1, frame: { kind: 'infinite' } },
          order: [{ index: 0, removed: [], inserted: ['invalid'] }],
          objects: {
            invalid: {
              id: 'invalid',
              type: 'froglight.ink.stroke',
              sourceId: 'missing',
              visible: [
                [
                  [
                    { x: 0, y: 0 },
                    { x: 1, y: 0 },
                    { x: 0, y: 1 },
                  ],
                ],
              ],
            },
          },
        },
      ],
    };
    const journalKey = key.replace(/\/head$/, '') + `/journal/${sequence}`;
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('records', 'readwrite'),
        store = transaction.objectStore('records');
      store.put(head, key);
      store.put(delta, journalKey);
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
    db.close();
    return { head, journalKey, delta };
  });
  await page.getByTestId('open-recent-vault-button-0').click();
  const dialog = page.getByRole('dialog', { name: 'Recovery needs attention' });
  // The persisted active tab reports the recovery error through the mounted host.
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await page.screenshot({
    path: test.info().outputPath('recovery-desktop.png'),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark' });
  const exportButton = dialog.getByRole('button', {
    name: 'Export last valid state',
  });
  const bounds = await exportButton.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await page.keyboard.press('Tab');
  await expect(dialog.locator(':focus')).toHaveCount(1);
  await page.screenshot({
    path: test.info().outputPath('recovery-mobile-dark.png'),
  });
  const downloading = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Export last valid state' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('Recovered.whiteboard');
  const path = await download.path();
  const { readFile } = await import('node:fs/promises');
  const exported = JSON.parse(await readFile(path!, 'utf8')) as {
    objects: Record<string, { points?: unknown[] }>;
  };
  expect(Object.values(exported.objects).filter((r) => r.points)).toHaveLength(
    1,
  );
  expect((await heads(page))[0]).toEqual(original.head);
  const retained = await page.evaluate(async (key) => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open('froglight-persistence', 1);
      request.onsuccess = () => resolve(request.result);
    });
    const result = await new Promise<unknown>((resolve) => {
      const request = db.transaction('records').objectStore('records').get(key);
      request.onsuccess = () => resolve(request.result);
    });
    db.close();
    return result;
  }, original.journalKey);
  expect(retained).toEqual(original.delta);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).not.toBeVisible();
});
