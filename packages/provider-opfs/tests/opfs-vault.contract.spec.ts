/**
 * Real-browser OPFS contract suite (Playwright / Chromium).
 *
 * Runs the portable VaultService contract suite against the real
 * browser Origin Private File System via the actual production
 * `OpfsVault` implementation — not a re-implementation. This is the
 *  web proof that requires.
 *
 * The harness serves the built `dist/` files via `page.route` to
 * `http://localhost` (OPFS requires a secure context) and uses an
 * import map so the browser can resolve the bare `@froglight/foundation`
 * specifier to the served foundation bundle.
 * A failure here means a real browser with the real provider cannot
 * satisfy the contract.
 */

import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

test.describe('OpfsVault contract suite (real Chromium OPFS)', () => {
  test('OPFS satisfies the portable VaultService contract', async ({ page }) => {
    // --- serve built files via route -------------------------------------

    const cwd = process.cwd();
    const isProviderCwd = cwd.endsWith('provider-opfs');
    const providerDist = isProviderCwd ? join(cwd, 'dist') : join(cwd, 'packages/provider-opfs/dist');
    const foundationDist = isProviderCwd
      ? join(cwd, '../foundation/dist')
      : join(cwd, 'packages/foundation/dist');

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
import { OpfsVault } from '/provider-opfs/dist/index.js';
import { createVaultContractSuite } from '/foundation/dist/vault/contract-suite.js';

async function run() {
  const status = document.getElementById('status');
  try {
    const originRoot = await navigator.storage.getDirectory();
    const suiteId = 'froglight-pw-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const suiteRootHandle = await originRoot.getDirectoryHandle(suiteId, { create: true });
    const provider = await OpfsVault.create({ root: suiteRootHandle });

    // Use the same portable suite the in-memory and native providers run.
    const suite = createVaultContractSuite({
      provider,
      reopen: () => OpfsVault.create({ root: suiteRootHandle }),
      prefix: 'suite',
    });

    const results = [];
    for (const c of suite) {
      try {
        await c.run();
        results.push({ name: c.name, ok: true });
      } catch (e) {
        results.push({ name: c.name, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }

    // Cleanup the isolated suite directory (best-effort)
    try { await originRoot.removeEntry(suiteId, { recursive: true }); } catch {
      try {
        for await (const [name] of suiteRootHandle.entries()) {
          try { await suiteRootHandle.removeEntry(name, { recursive: true }); } catch {}
        }
        await originRoot.removeEntry(suiteId);
      } catch {}
    }

    window.__results = results;
    status.textContent = 'done:' + JSON.stringify(results);
  } catch (e) {
    const msg = e instanceof Error ? e.message + '\\n' + e.stack : String(e);
    window.__results = [{ name: 'harness', ok: false, error: msg }];
    status.textContent = 'error:' + msg;
  }
}
run();
</script>
</body>
</html>`;

    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      const pathname = url.pathname;

      // Harness HTML
      if (pathname === '/' || pathname === '/harness.html' || pathname === '/index.html') {
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: harnessHtml,
        });
        return;
      }

      // Serve provider-opfs dist
      if (pathname.startsWith('/provider-opfs/dist/')) {
        const filePath = join(providerDist, pathname.replace('/provider-opfs/dist/', ''));
        try {
          const body = await readFile(filePath);
          const contentType = filePath.endsWith('.js') ? 'application/javascript' : 'text/plain';
          await route.fulfill({ status: 200, contentType, body });
        } catch {
          await route.fulfill({ status: 404, body: 'not found: ' + pathname });
        }
        return;
      }

      // Serve foundation dist (including sub-paths like vault/contract-suite.js)
      if (pathname.startsWith('/foundation/dist/')) {
        const filePath = join(foundationDist, pathname.replace('/foundation/dist/', ''));
        try {
          const body = await readFile(filePath);
          const contentType = filePath.endsWith('.js') ? 'application/javascript' : 'text/plain';
          await route.fulfill({ status: 200, contentType, body });
        } catch {
          await route.fulfill({ status: 404, body: 'not found: ' + pathname });
        }
        return;
      }

      // Serve runtime dist
      if (pathname.startsWith('/runtime/dist/')) {
        const runtimeDist = isProviderCwd ? join(cwd, '../runtime/dist') : join(cwd, 'packages/runtime/dist');
        const filePath = join(runtimeDist, pathname.replace('/runtime/dist/', ''));
        try {
          const body = await readFile(filePath);
          const contentType = filePath.endsWith('.js') ? 'application/javascript' : 'text/plain';
          await route.fulfill({ status: 200, contentType, body });
        } catch {
          await route.fulfill({ status: 404, body: 'not found: ' + pathname });
        }
        return;
      }

      // Fallback: let other requests go through (should not happen)
      await route.fulfill({ status: 404, body: 'not found: ' + pathname });
    });

    await page.goto('http://localhost:3000/harness.html');
    await page.waitForFunction(() => (window as unknown as { __results?: unknown }).__results !== undefined, undefined, {
      timeout: 30_000,
    });

    const results = (await page.evaluate(
      () => (window as unknown as { __results: Array<{ name: string; ok: boolean; error?: string }> }).__results,
    )) as Array<{ name: string; ok: boolean; error?: string }>;

    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0) {
      const details = failed.map((r) => `  ✘ ${r.name}: ${r.error}`).join('\n');
      throw new Error(`OPFS contract failures:\n${details}`);
    }

    expect(results.length).toBeGreaterThan(10);
    for (const r of results) {
      expect(r.ok, `${r.name}: ${r.error ?? ''}`).toBe(true);
    }
  });
});
