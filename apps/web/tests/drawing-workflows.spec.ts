import { expect, test, type Page } from '@playwright/test';
import { createFromSidebar } from './support/sidebar-create.js';

// Production providers, real Canvas2D, toolbar, DocumentSession, and OPFS.
// Synthetic pointer input proves wiring/persistence, not physical stylus feel.
//
// Floating-point note: a selection drag translates samples by (+dx,+dy) and
// its undo translates back by (−dx,−dy). In IEEE-754 `(x+dx)−dx` can differ
// from `x` by 1 ULP, so snapshots taken across a drag/undo cycle are
// compared at microunit resolution (1e-6 surface units — far below any
// meaningful movement, far above float noise). This keeps the suite
// deterministic without masking real content changes.
function roundNumbers(value: unknown): unknown {
  if (typeof value === 'number') return Math.round(value * 1e6) / 1e6;
  if (Array.isArray(value)) return value.map(roundNumbers);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value))
      out[key] = roundNumbers(entry);
    return out;
  }
  return value;
}

async function savedStrokes(
  page: Page,
): Promise<Record<string, unknown>[] | null> {
  const records = await page.evaluate(async () => {
    let vault: FileSystemDirectoryHandle;
    try {
      vault = await (
        await navigator.storage.getDirectory()
      ).getDirectoryHandle('Drawing acceptance');
    } catch {
      // The vault directory does not exist yet (nothing saved, or a fresh
      // profile): report "no complete snapshot" so `expect.poll` keeps
      // waiting instead of failing on a storage NotFoundError.
      return null;
    }
    const records: Record<string, unknown>[] = [];
    const visit = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      const record = value as Record<string, unknown>;
      if (record.type === 'froglight.ink.stroke') records.push(record);
      else for (const child of Object.values(record)) visit(child);
    };
    try {
      for await (const [name, entry] of vault.entries()) {
        if (entry.kind !== 'file' || !name.startsWith('Drawing.')) continue;
        // The app may concurrently move/rewrite files (save, open, offline
        // reload): a file vanishing mid-read is transient — report "no
        // complete snapshot" so `expect.poll` retries instead of failing.
        // Genuinely missing content still times out and fails.
        const text = await (await entry.getFile()).text();
        // OPFS sync writes can be observed between truncation and
        // completion. Poll only complete snapshots; malformed persisted
        // content still times out.
        visit(JSON.parse(text));
      }
    } catch {
      return null;
    }
    return records;
  });
  if (records === null) return null;
  return roundNumbers(records) as Record<string, unknown>[];
}

for (const kind of ['Ink', 'Notebook', 'Whiteboard']) {
  test(`${kind}: draw, undo, redo, highlight, save and reopen offline`, async ({
    page,
    context,
  }, testInfo) => {
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
      .fill('Drawing acceptance');
    await page.getByTestId('choose-vault-location-button').click();
    await page.getByTestId('confirm-create-vault-button').click();
    await createFromSidebar(page, kind === 'Ink' ? 'Ink page' : kind);
    await page.getByRole('textbox', { name: 'Note name' }).fill('Drawing');
    await page
      .getByRole('dialog', { name: 'Create a new note' })
      .getByRole('button', { name: 'Create', exact: true })
      .click();
    const canvas = page.locator('.fl-ink-canvas').first();
    await expect(canvas).toBeVisible();
    await page
      .getByRole('toolbar', { name: 'Document tool categories' })
      .getByRole('button', { name: 'Pen', exact: true })
      .click();
    // Clicking the active pen opens settings; Escape returns to drawing.
    await page.keyboard.press('Escape');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('drawing canvas has no layout');
    const x = box.x + box.width * 0.4;
    const y = box.y + Math.min(box.height * 0.3, 180);
    const draw = async (offset: number) => {
      await page.mouse.move(x, y + offset);
      await page.mouse.down();
      for (let i = 1; i <= 24; i++)
        await page.mouse.move(x + i * 3, y + offset + Math.sin(i / 3) * 8);
      await page.mouse.up();
      await page.keyboard.press('Control+s');
    };
    await draw(0);
    await expect.poll(() => savedStrokes(page)).toHaveLength(1);
    const first = await savedStrokes(page);
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+s');
    expect(errors).toEqual([]);
    await expect.poll(() => savedStrokes(page)).toHaveLength(0);
    await page.keyboard.press('Control+Shift+z');
    await page.keyboard.press('Control+s');
    await expect.poll(() => savedStrokes(page)).toEqual(first);
    await page.getByRole('button', { name: 'Eraser', exact: true }).click();
    await page
      .getByRole('button', { name: 'Stroke Eraser', exact: true })
      .click();
    await page.keyboard.press('Escape');
    await page.mouse.move(x + 36, y - 16);
    await page.mouse.down();
    await page.mouse.move(x + 36, y + 16, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.press('Control+s');
    await expect.poll(() => savedStrokes(page)).toHaveLength(0);
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+s');
    await expect.poll(() => savedStrokes(page)).toEqual(first);
    await page.keyboard.press('Control+Shift+z');
    await page.keyboard.press('Control+s');
    await expect.poll(() => savedStrokes(page)).toHaveLength(0);
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+s');
    await expect.poll(() => savedStrokes(page)).toEqual(first);
    await page
      .getByRole('toolbar', { name: 'Document tool categories' })
      .getByRole('button', { name: 'Pen', exact: true })
      .click();
    await page.getByRole('button', { name: /^(Highlighter|Marker)$/ }).click();
    await draw(35);
    await expect.poll(() => savedStrokes(page)).toHaveLength(2);
    const beforeReload = await savedStrokes(page);
    if (beforeReload === null) throw new Error('save is still in progress');
    expect(
      beforeReload.some(
        (stroke) => (stroke.brush as { kind?: string })?.kind === 'highlighter',
      ),
    ).toBe(true);
    await page.getByRole('button', { name: 'Selection', exact: true }).click();
    await page.mouse.click(x + 36, y + Math.sin(4) * 8);
    const selectionToolbar = page.locator('[data-selection-toolbar]');
    await expect(selectionToolbar).toBeVisible();
    const selectionBox = await selectionToolbar.boundingBox();
    console.log(
      'selection-before',
      await selectionToolbar.getAttribute('style'),
    );
    expect(selectionBox).not.toBeNull();
    expect(selectionBox!.y).toBeLessThan(y);
    await expect(
      selectionToolbar.getByRole('button', {
        name: 'Duplicate selection',
        exact: true,
      }),
    ).toHaveText('');
    // A selection drag receives incremental pointer deltas; the contextual
    // toolbar should track the object one-for-one instead of compounding the
    // distance on every pointermove.
    const dragX = 40;
    const dragY = 24;
    await page.evaluate(() => {
      (window as unknown as { pointerEvents: unknown[] }).pointerEvents = [];
      for (const type of ['pointerdown', 'pointermove', 'pointerup'])
        document
          .querySelector('.fl-ink-canvas')
          ?.addEventListener(type, (event) => {
            const pointer = event as PointerEvent;
            (
              window as unknown as { pointerEvents: unknown[] }
            ).pointerEvents.push({
              type,
              x: pointer.clientX,
              y: pointer.clientY,
              buttons: pointer.buttons,
            });
          });
    });
    expect(
      await page.evaluate(
        ({ px, py }) => document.elementFromPoint(px, py)?.className,
        { px: x + 36, py: y + Math.sin(4) * 8 },
      ),
    ).toContain('fl-ink-canvas');
    await page.mouse.move(x + 36, y + Math.sin(4) * 8);
    await page.mouse.down();
    await page.mouse.move(x + 36 + dragX, y + Math.sin(4) * 8 + dragY, {
      steps: 8,
    });
    await page.mouse.up();
    console.log(
      'selection-after',
      await selectionToolbar.getAttribute('style'),
    );
    console.log(
      'pointer-events',
      await page.evaluate(
        () => (window as unknown as { pointerEvents: unknown[] }).pointerEvents,
      ),
    );
    await page.keyboard.press('Control+s');
    console.log('after-drag-strokes', JSON.stringify(await savedStrokes(page)));
    await expect
      .poll(async () => {
        const moved = await selectionToolbar.boundingBox();
        return moved === null
          ? null
          : {
              x: Math.round(moved.x - selectionBox!.x),
              y: Math.round(moved.y - selectionBox!.y),
            };
      })
      .toEqual({ x: dragX, y: dragY });
    await page.keyboard.press('Control+z');
    await page.keyboard.down('Shift');
    await page.mouse.click(x + 36, y + 35 + Math.sin(4) * 8);
    await page.keyboard.up('Shift');
    await page
      .getByRole('button', { name: 'Duplicate selection', exact: true })
      .click();
    await page.keyboard.press('Control+s');
    await expect.poll(() => savedStrokes(page)).toHaveLength(4);
    await page
      .getByRole('button', { name: 'Delete selection', exact: true })
      .click();
    await page.keyboard.press('Control+s');
    await expect.poll(() => savedStrokes(page)).toEqual(beforeReload);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await context.setOffline(true);
    await page.reload();
    await page
      .getByRole('button', {
        name: /^Drawing acceptance Browser private storage/,
      })
      .click();
    await page
      .getByRole('button', { name: 'Open quick switcher', exact: true })
      .click();
    await page.getByRole('dialog').getByRole('textbox').fill('Drawing');
    await page.getByRole('option', { name: /Drawing/ }).click();
    await expect(canvas).toBeVisible();
    await expect(page.getByRole('dialog')).toBeHidden();
    expect(await savedStrokes(page)).toEqual(beforeReload);
    await page.screenshot({
      path: testInfo.outputPath(`${kind.toLowerCase()}-offline.png`),
    });
    expect(errors).toEqual([]);
  });
}
