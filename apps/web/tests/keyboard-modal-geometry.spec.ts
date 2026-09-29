import { expect, test, type Page } from '@playwright/test';
import { createFromSidebar } from './support/sidebar-create.js';
import { clickDatabaseAction } from './support/database-actions.js';

// Real application/providers and disposable browser storage. Keyboard measurements
// are injected at the host CSS seam: this verifies layout, not a physical iPad IME.
async function keyboard(page: Page, height: number, pan = 0) {
  await page.evaluate(
    ({ height, pan }) => {
      const root = document.documentElement;
      root.style.setProperty('--fl-keyboard-inset-height', `${height}px`);
      root.style.setProperty('--fl-visual-viewport-pan-y', `${pan}px`);
      root.dataset.flKeyboardOpen = String(height > 0);
    },
    { height, pan },
  );
}

async function bottomRadius(dialog: ReturnType<Page['getByRole']>) {
  return dialog.evaluate((element) =>
    parseFloat(getComputedStyle(element).borderBottomLeftRadius),
  );
}

async function usableBounds(dialog: ReturnType<Page['getByRole']>) {
  return dialog.evaluate((element) => {
    const backdrop = element.parentElement!;
    const box = backdrop.getBoundingClientRect();
    const style = getComputedStyle(backdrop);
    return {
      top: box.top + parseFloat(style.paddingTop),
      bottom: box.bottom - parseFloat(style.paddingBottom),
    };
  });
}

for (const viewport of [
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
]) {
  test.describe(`shared dialogs at ${viewport.width}px`, () => {
    test.use({ viewport });
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.addInitScript(() => {
        Object.defineProperty(window, 'showDirectoryPicker', {
          value: undefined,
          configurable: true,
        });
      });
      await page.goto('/');
    });

    test('centers above the keyboard, then constrains and scrolls at the top gap', async ({
      page,
    }, info) => {
      await page.getByTestId('create-vault-button').click();
      const dialog = page.getByRole('dialog', { name: 'Create a new vault' });
      await expect(dialog).toBeVisible();
      await expect
        .poll(async () => {
          const box = (await dialog.boundingBox())!;
          return Math.abs(box.y + box.height / 2 - viewport.height / 2);
        })
        .toBeLessThan(2);
      const radius = await bottomRadius(dialog);
      await keyboard(page, 20);
      const shortBounds = await usableBounds(dialog);
      await expect
        .poll(async () => {
          const box = (await dialog.boundingBox())!;
          return Math.abs(
            box.y + box.height / 2 - (shortBounds.top + shortBounds.bottom) / 2,
          );
        })
        .toBeLessThan(2);
      expect(await bottomRadius(dialog)).toBe(radius);
      await expect(dialog).not.toHaveAttribute('data-fl-keyboard-contact');
      await keyboard(page, viewport.height - 300, 40);
      const tallBounds = await usableBounds(dialog);
      await expect
        .poll(async () => {
          const box = (await dialog.boundingBox())!;
          return Math.abs(box.y - tallBounds.top);
        })
        .toBeLessThan(2);
      await expect.poll(() => dialog.evaluate((element) => {
        const backdrop = element.parentElement!;
        const box = backdrop.getBoundingClientRect();
        return box.bottom - box.top;
      })).toBe(viewport.height);
      expect(await bottomRadius(dialog)).toBe(radius);
      const tallBox = (await dialog.boundingBox())!;
      expect(tallBox.y + tallBox.height).toBeLessThanOrEqual(
        tallBounds.bottom + radius + 1,
      );
      expect(tallBox.height).toBeCloseTo(tallBounds.bottom - tallBounds.top + radius, 0);
      const heading = dialog.getByRole('heading');
      const before = (await heading.boundingBox())!.y;
      const scroll = await dialog.evaluate((element) => {
        const body = element.querySelector('header')!.nextElementSibling!;
        body.scrollTop = 100;
        return {
          top: body.scrollTop,
          overflow: body.scrollHeight > body.clientHeight,
        };
      });
      expect(scroll.overflow).toBe(true);
      expect(scroll.top).toBeGreaterThan(0);
      const lastAction = dialog.getByTestId('confirm-create-vault-button');
      await lastAction.scrollIntoViewIfNeeded();
      const actionBox = (await lastAction.boundingBox())!;
      expect(actionBox.y + actionBox.height).toBeLessThanOrEqual(tallBounds.bottom);

      expect((await heading.boundingBox())!.y).toBeCloseTo(before, 0);
      await page.screenshot({ path: info.outputPath('keyboard-dialog.png') });
      await keyboard(page, 20);
      await expect(dialog).not.toHaveAttribute('data-fl-keyboard-contact');
      await keyboard(page, 0);
      const restored = (await dialog.boundingBox())!;
      expect(restored.y + restored.height / 2).toBeCloseTo(
        viewport.height / 2,
        0,
      );
      expect(await bottomRadius(dialog)).toBe(radius);
      await expect(dialog).not.toHaveAttribute('data-fl-keyboard-contact');
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(page.getByTestId('create-vault-button')).toBeFocused();
    });

    test('new-note choices scroll while the name and actions stay reachable', async ({
      page,
    }) => {
      await page.getByTestId('create-vault-button').click();
      await page
        .getByTestId('create-vault-name-input')
        .fill('Dialog acceptance');
      await page.getByTestId('choose-vault-location-button').click();
      await page.getByTestId('confirm-create-vault-button').click();
      await createFromSidebar(page);
      const dialog = page.getByRole('dialog', { name: 'Create a new note' });
      await keyboard(page, viewport.height - 360, 40);
      const choices = dialog.getByRole('radiogroup');
      const inputBefore = (await dialog.getByRole('textbox').boundingBox())!;
      expect(
        await choices.evaluate((element) => {
          element.scrollTop = 160;
          return element.scrollTop;
        }),
      ).toBeGreaterThan(0);
      expect((await dialog.getByRole('textbox').boundingBox())!.y).toBeCloseTo(
        inputBefore.y,
        0,
      );
      const box = (await dialog.boundingBox())!;
      const bounds = await usableBounds(dialog);
      expect(box.y).toBeGreaterThanOrEqual(bounds.top - 1);
      expect(box.y + box.height).toBeLessThanOrEqual(bounds.bottom + (await bottomRadius(dialog)) + 1);
      const create = dialog.getByRole('button', { name: 'Create', exact: true });
      await expect(create).toBeInViewport();
      const createBox = (await create.boundingBox())!;
      expect(createBox.y + createBox.height).toBeLessThanOrEqual(bounds.bottom);
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    });

    test('native top-layer dialogs retain their header and stay above the keyboard', async ({
      page,
    }) => {
      await page.getByTestId('create-vault-button').click();
      await page.getByTestId('create-vault-name-input').fill('Database dialog');
      await page.getByTestId('choose-vault-location-button').click();
      await page.getByTestId('confirm-create-vault-button').click();
      await createFromSidebar(page, 'Database');
      await page.getByRole('textbox', { name: 'Note name' }).fill('Research');
      await page
        .getByRole('dialog', { name: 'Create a new note' })
        .getByRole('button', { name: 'Create', exact: true })
        .click();
      await clickDatabaseAction(
        page.getByRole('region', { name: 'Research', exact: true }),
        'View settings',
      );
      const dialog = page.getByRole('dialog', { name: 'View settings' });
      await expect(dialog).toBeVisible();
      await keyboard(page, viewport.height - 280, 30);
      const bounds = await usableBounds(dialog);
      await expect
        .poll(async () => {
          const box = (await dialog.boundingBox())!;
          return box.y + box.height - bounds.bottom - (await bottomRadius(dialog));
        })
        .toBeLessThanOrEqual(1);
      await dialog.evaluate((element) =>
        Promise.all(
          element
            .getAnimations()
            .map((animation) => animation.finished.catch(() => {})),
        ),
      );
      await expect(
        dialog.getByRole('button', { name: 'Close view settings' }),
      ).toBeInViewport();
      const heading = dialog.getByRole('heading', { name: 'View settings' });
      const y = (await heading.boundingBox())!.y;
      const result = await dialog.evaluate((element) => {
        const body = element.querySelector('header')!.nextElementSibling!;
        body.scrollTop = 160;
        return {
          scrolled: body.scrollTop,
          radius: getComputedStyle(element).borderBottomLeftRadius,
        };
      });
      expect(result.scrolled).toBeGreaterThan(0);
      expect(parseFloat(result.radius)).toBeGreaterThan(0);
      expect((await heading.boundingBox())!.y).toBeCloseTo(y, 0);
      await dialog.getByRole('button', { name: 'Close view settings' }).click();
      await expect(dialog).toBeHidden();
    });

    test('settings close remains reachable with keyboard and dark material', async ({
      page,
    }, info) => {
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      const dialog = page.getByRole('dialog', {
        name: 'Settings',
        exact: true,
      });
      await expect(dialog).toBeVisible();
      await page.evaluate(() => {
        document.documentElement.dataset.theme = 'dark';
      });
      await keyboard(page, viewport.height - 350, 30);
      const close = dialog.getByRole('button', { name: 'Close settings' });
      await expect(close).toBeInViewport();
      const bounds = await usableBounds(dialog);
      await expect
        .poll(async () => {
          const box = (await dialog.boundingBox())!;
          return box.y + box.height - bounds.bottom - (await bottomRadius(dialog));
        })
        .toBeLessThanOrEqual(1);
      await page.screenshot({ path: info.outputPath('settings-dark.png') });
      await close.click();
      await expect(dialog).toBeHidden();
    });
  });
}
