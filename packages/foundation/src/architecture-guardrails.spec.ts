/**
 * Architectural guardrails (layer boundaries).
 *
 * Executable enforcement so architecture does not rely on discipline:
 * shared packages must not import `@tauri-apps/*`; native implementations
 * stay under the native adapter layer; Vite/build APIs must not leak into
 * domain/runtime contracts; browser storage/host APIs stay behind providers.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = (() => {
  // Works both when vitest runs from the repo root (`vitest run <path>`)
  // and when Nx runs it with cwd = the package directory.
  const candidates = [process.cwd(), __dirname];
  for (const start of candidates) {
    let dir = start;
    for (let i = 0; i < 6; i++) {
      if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return path.resolve(__dirname, '..', '..', '..');
})();

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === 'node_modules' ||
      entry.name === 'dist' ||
      entry.name === 'dev-dist' ||
      entry.name === 'out-tsc' ||
      entry.name === 'test-output' ||
      entry.name === 'coverage'
    )
      continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listSourceFiles(full, out);
    else if (
      /\.(ts|tsx|mts|cts)$/.test(entry.name) &&
      !/\.(spec|test)\.(ts|tsx|mts|cts)$/.test(entry.name)
    )
      out.push(full);
  }
  return out;
}

function read(p: string): string {
  return fs.readFileSync(p, 'utf8');
}

describe('architectural guardrails', () => {
  it('shared packages never import @tauri-apps/*', () => {
    const sharedRoots = [
      'packages/foundation/src',
      'packages/runtime/src',
      'packages/sdk/src',
      'packages/application/src',
      'packages/ui/src',
    ];
    const offenders: string[] = [];
    for (const root of sharedRoots) {
      const dir = path.join(REPO_ROOT, root);
      if (!fs.existsSync(dir)) continue;
      for (const file of listSourceFiles(dir)) {
        if (/@tauri-apps\//.test(read(file)))
          offenders.push(path.relative(REPO_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('native Tauri imports stay under apps/native', () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles(path.join(REPO_ROOT, 'packages'))) {
      if (/@tauri-apps\//.test(read(file)))
        offenders.push(path.relative(REPO_ROOT, file));
    }
    expect(offenders).toEqual([]);
  });

  it('Vite/build APIs do not leak into domain/runtime contracts', () => {
    const bannedImport =
      /from\s+['"](vite|vite-plugin-pwa|@vitejs\/[^'"]+)['"]/;
    const offenders: string[] = [];
    const roots = [
      'packages/foundation/src',
      'packages/runtime/src',
      'packages/sdk/src',
    ];
    for (const root of roots) {
      const dir = path.join(REPO_ROOT, root);
      if (!fs.existsSync(dir)) continue;
      for (const file of listSourceFiles(dir)) {
        const content = read(file);
        if (bannedImport.test(content))
          offenders.push(`${path.relative(REPO_ROOT, file)}: vite import`);
        // import.meta.env is build-time config; import.meta.url/dirname remain allowed.
        if (/import\.meta\.env/.test(content))
          offenders.push(`${path.relative(REPO_ROOT, file)}: import.meta.env`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('runtime, foundation, SDK, and plugin-platform stay framework-free (no React)', () => {
    // The React component contract lives exactly once in the UI
    // package React entrypoint for trusted UI plugins. The runtime kernel,
    // foundation capability contracts, generic core SDK, and generic
    // plugin-platform container stay framework-free.
    const bannedImport =
      /from\s+['"]react(?:-dom(?:\/client)?(?:\/jsx-runtime)?)?['"]/;
    const bannedJsx = /react-jsx|jsx-runtime/;
    const offenders: string[] = [];
    const roots = [
      'packages/foundation/src',
      'packages/runtime/src',
      'packages/sdk/src',
      'packages/plugin-platform/src',
    ];
    for (const root of roots) {
      const dir = path.join(REPO_ROOT, root);
      if (!fs.existsSync(dir)) continue;
      for (const file of listSourceFiles(dir)) {
        const content = read(file);
        if (bannedImport.test(content) || bannedJsx.test(content))
          offenders.push(path.relative(REPO_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('foundation stays provider-neutral (no Firebase/Firestore/Storage imports)', () => {
    // Firebase is an implementation provider behind
    // `froglight.account` / sync capabilities. Shared Foundation must
    // contain zero Firebase imports so local-first operation never
    // depends on cloud SDKs.
    const banned = [
      /from\s+['"]firebase\//,
      /from\s+['"]@firebase\//,
      /firebase-admin/,
    ];
    const dir = path.join(REPO_ROOT, 'packages/foundation/src');
    const offenders: string[] = [];
    for (const file of listSourceFiles(dir)) {
      const content = read(file);
      for (const re of banned) {
        if (re.test(content)) {
          offenders.push(`${path.relative(REPO_ROOT, file)}: ${re.source}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('PWA manifest source does not import build tooling', () => {
    const content = read(path.join(REPO_ROOT, 'apps/web/src/pwa-manifest.ts'));
    expect(content).not.toMatch(/from\s+['"]vite-plugin-pwa['"]/);
    expect(content).not.toMatch(/import\.meta\.env/);
  });

  it('browser storage/host APIs stay behind providers, never in shared packages', () => {
    // localStorage / IndexedDB / OPFS / file pickers / Tauri internals are
    // host capabilities: provider packages (provider-opfs, …) and host apps
    // may use them, but shared domain/runtime/UI code must go through
    // capability contracts so providers stay replaceable.
    const banned = [
      /localStorage/,
      /sessionStorage/,
      /indexedDB/,
      /navigator\.storage/,
      /getDirectory\(/,
      /showDirectoryPicker/,
      /showOpenFilePicker/,
      /showSaveFilePicker/,
      /__TAURI_INTERNALS__/,
    ];
    const roots = [
      'packages/foundation/src',
      'packages/runtime/src',
      'packages/sdk/src',
      'packages/application/src',
      'packages/ui/src',
      'packages/search-fts/src',
    ];
    const offenders: string[] = [];
    for (const root of roots) {
      const dir = path.join(REPO_ROOT, root);
      if (!fs.existsSync(dir)) continue;
      for (const file of listSourceFiles(dir)) {
        const content = read(file);
        for (const re of banned) {
          if (re.test(content)) {
            offenders.push(`${path.relative(REPO_ROOT, file)}: ${re.source}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('shared and slice editor packages never touch the network', () => {
    // Offline startup/edit/save/restart must never depend on connectivity:
    // no fetch/WebSocket/XHR/SSE/beacon/online-checks in shared or slice
    // editor code. Sync providers (provider-firebase, …) stay out of scope.
    // Full-text search ships offline (local index), so search-fts is in
    // scope alongside the editors. The banned patterns scan raw file text
    // (comments/strings included): a match in prose still fails loudly by
    // design (conservative, accepted brittleness — rename or scope the prose
    // instead of weakening the gate).
    const banned = [
      /\bfetch\s*\(/,
      /\bnew\s+WebSocket/,
      /\bXMLHttpRequest/,
      /\bEventSource\s*\(/,
      /\bsendBeacon\s*\(/,
      /\bnavigator\.onLine/,
    ];
    const roots = [
      'packages/foundation/src',
      'packages/runtime/src',
      'packages/sdk/src',
      'packages/application/src',
      'packages/ui/src',
      'packages/search-fts/src',
      'packages/surface-default/src',
      'packages/editor-ink/src',
      'packages/editor-notebook/src',
      'packages/editor-whiteboard/src',
      'packages/editor-blockpage/src',
      'packages/editor-codemirror/src',
    ];
    const offenders: string[] = [];
    for (const root of roots) {
      const dir = path.join(REPO_ROOT, root);
      if (!fs.existsSync(dir)) continue;
      for (const file of listSourceFiles(dir)) {
        const content = read(file);
        for (const re of banned) {
          if (re.test(content)) {
            offenders.push(`${path.relative(REPO_ROOT, file)}: ${re.source}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
