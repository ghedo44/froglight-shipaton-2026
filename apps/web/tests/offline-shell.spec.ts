/**
 * Production PWA offline lifecycle (real Chromium, real service worker).
 *
 * Regression suite for the installed-PWA white screen: the app shell must
 * render after the server goes away, and the exact assets the PDF viewer
 * needs (pdf.js worker) must resolve offline from the precache.
 *
 * Runs against `vite preview` (production `dist/`), never the dev server:
 * a PWA installed from `vite dev` is served entirely from localhost and can
 * never survive offline — that is expected and not what this suite covers.
 */
import { expect, test } from '@playwright/test';

test.describe('installed PWA survives offline', () => {
  test('shell renders after offline reload (no white screen)', async ({
    page,
    context,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    page.on('requestfailed', (request) => {
      const failure = request.failure();
      pageErrors.push(
        `requestfailed: ${request.url()} ${failure?.errorText ?? ''}`,
      );
    });

    await page.goto('/', { waitUntil: 'load' });
    await page.waitForSelector(
      '.froglight-launcher-root, .froglight-app, #app > *',
      {
        timeout: 30000,
      },
    );

    // Wait for the service worker to take control before going offline.
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      const worker =
        registration.active ?? registration.waiting ?? registration.installing;
      if (worker && worker.state !== 'activated') {
        await new Promise<void>((resolve) => {
          worker.addEventListener('statechange', () => {
            if (worker.state === 'activated') resolve();
          });
        });
      }
    });

    await context.setOffline(true);
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector(
      '.froglight-launcher-root, .froglight-app, #app > *',
      {
        timeout: 30000,
      },
    );

    const text = (await page.textContent('body')) ?? '';
    expect(text.trim().length).toBeGreaterThan(0);
    expect(text).toContain('Froglight');
    expect(pageErrors).toEqual([]);
  });

  test('pdf.js worker resolves offline from the precache', async ({
    page,
    context,
  }) => {
    await page.goto('/', { waitUntil: 'load' });
    await page.waitForSelector(
      '.froglight-launcher-root, .froglight-app, #app > *',
      {
        timeout: 30000,
      },
    );
    await page.evaluate(() => navigator.serviceWorker.ready);

    // Discover the hashed worker asset while online (sw.js itself is the
    // service worker script and is not served offline to pages).
    const workerAsset = await page.evaluate(async () => {
      const swText = await (await fetch('sw.js')).text();
      return /assets\/pdf\.worker[^"'`]*/.exec(swText)?.[0] ?? null;
    });
    expect(workerAsset).not.toBeNull();
    if (workerAsset === null)
      throw new Error('pdf worker asset missing from sw.js');

    await context.setOffline(true);
    const status = await page.evaluate(
      async (asset) => (await fetch(asset)).status,
      workerAsset,
    );
    expect(status).toBe(200);
  });
});
