/**
 * Real-browser OPFS derived-cache storage contract (final scalability
 * pass, item 4).
 *
 * Proves the host storage used by Ink/Notebook/Whiteboard derived reopen
 * caches actually round-trips compact binary records through
 * Origin Private File System, misses cleanly, and removes harmlessly.
 * Served from built dist/ over real Chromium, same harness style as the
 * vault contract suite.
 */

import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

test('OpfsDerivedCacheStorage round-trips binary records (real Chromium OPFS)', async ({
  page,
}) => {
  const cwd = process.cwd();
  const isProviderCwd = cwd.endsWith('provider-opfs');
  const providerDist = isProviderCwd
    ? join(cwd, 'dist')
    : join(cwd, 'packages/provider-opfs/dist');
  const foundationDist = isProviderCwd
    ? join(cwd, '../foundation/dist')
    : join(cwd, 'packages/foundation/dist');
  const runtimeDist = isProviderCwd
    ? join(cwd, '../runtime/dist')
    : join(cwd, 'packages/runtime/dist');

  const harnessHtml = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<script type="importmap">
{
  "imports": {
    "@froglight/foundation": "/foundation/dist/index.js",
    "@froglight/runtime": "/runtime/dist/index.js"
  }
}
</script>
</head>
<body>
<div id="status">loading</div>
<script type="module">
import { OpfsDerivedCacheStorage } from '/provider-opfs/dist/index.js';

async function run() {
  const results = [];
  const check = async (name, fn) => {
    try {
      await fn();
      results.push({ name, ok: true });
    } catch (e) {
      results.push({ name, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  };
  const storage = new OpfsDerivedCacheStorage();

  await check('binary save/load round trip (non-UTF8 bytes included)', async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 128]);
    await storage.save('vault/doc-1', bytes);
    const back = await storage.load('vault/doc-1');
    if (back === null || back.length !== bytes.length) throw new Error('length mismatch');
    for (let i = 0; i < bytes.length; i++) {
      if (back[i] !== bytes[i]) throw new Error('byte ' + i + ' mismatch');
    }
  });

  await check('missing document is a clean miss', async () => {
    const back = await storage.load('vault/never-written');
    if (back !== null) throw new Error('expected null, got ' + back.length + ' bytes');
  });

  await check('remove is harmless and idempotent', async () => {
    await storage.remove('vault/doc-1');
    await storage.remove('vault/doc-1');
    const back = await storage.load('vault/doc-1');
    if (back !== null) throw new Error('expected removed record');
  });

  await check('large binary payload survives verbatim', async () => {
    const big = new Uint8Array(1 << 20);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xff;
    await storage.save('vault/big', big);
    const back = await storage.load('vault/big');
    if (back === null || back.length !== big.length) throw new Error('length mismatch');
    for (let i = 0; i < big.length; i += 4097) {
      if (back[i] !== big[i]) throw new Error('byte ' + i + ' mismatch');
    }
    await storage.remove('vault/big');
  });

  window.__results = results;
  document.getElementById('status').textContent = 'done';
}
run();
</script>
</body>
</html>`;

  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    if (pathname === '/' || pathname === '/harness.html') {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: harnessHtml,
      });
      return;
    }
    const distFor = (prefix: string): string | null => {
      if (pathname.startsWith('/provider-opfs/dist/')) {
        return join(providerDist, pathname.replace('/provider-opfs/dist/', ''));
      }
      if (pathname.startsWith('/foundation/dist/')) {
        return join(foundationDist, pathname.replace('/foundation/dist/', ''));
      }
      if (pathname.startsWith('/runtime/dist/')) {
        return join(runtimeDist, pathname.replace('/runtime/dist/', ''));
      }
      return null;
    };
    const filePath = distFor(pathname);
    if (filePath !== null) {
      try {
        const body = await readFile(filePath);
        await route.fulfill({
          status: 200,
          contentType: filePath.endsWith('.js')
            ? 'application/javascript'
            : 'text/plain',
          body,
        });
      } catch {
        await route.fulfill({ status: 404, body: 'not found: ' + pathname });
      }
      return;
    }
    await route.fulfill({ status: 404, body: 'not found: ' + pathname });
  });

  await page.goto('http://localhost:3000/harness.html');
  await page.waitForFunction(
    () =>
      (window as unknown as { __results?: unknown }).__results !== undefined,
    undefined,
    { timeout: 30_000 },
  );
  const results = (await page.evaluate(
    () =>
      (
        window as unknown as {
          __results: Array<{ name: string; ok: boolean; error?: string }>;
        }
      ).__results,
  )) as Array<{ name: string; ok: boolean; error?: string }>;
  for (const result of results) {
    expect(result.ok, `${result.name}: ${result.error ?? ''}`).toBe(true);
  }
  expect(results.length).toBe(4);
});
