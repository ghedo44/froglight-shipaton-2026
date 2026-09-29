/**
 * Prove Markdown core contains no host-specific branches (filesystem vs OPFS).
 *
 * The Markdown codec, metadata/relationship extractors, search projection, and
 * addressing must not import `VaultCapabilities`, `createNativeVault`, or
 * `OpfsVault`. Host branches belong in provider packages, not document core.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('Markdown host-agnostic core', () => {
  it('contains no host-branch imports or filesystem/OPFS checks', async () => {
    const mdDir = path.resolve(__dirname, '.');
    const files = fs.readdirSync(mdDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'));
    const banned = [/VaultCapabilities/, /createNativeVault/, /OpfsVault/, /FileSystemHandle/, /better-sqlite3/, /node:sqlite/, /sqlite-wasm/];
    for (const file of files) {
      const content = fs.readFileSync(path.join(mdDir, file), 'utf8');
      for (const re of banned) {
        expect(content, `${file} should not contain ${re.source} (host branch)`).not.toMatch(re);
      }
      // Ensure no CodeMirror/ProseMirror leakage into markdown core (imports, not just comments).
      expect(content, `${file} should not leak CodeMirror imports`).not.toMatch(/@codemirror/);
      // For ProseMirror, check for actual import or type usage, not doc comments.
      // Filter out lines that are pure comments containing the word for documentation.
      const nonCommentLines = content
        .split('\n')
        .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
        .join('\n');
      expect(nonCommentLines, `${file} should not leak ProseMirror imports`).not.toMatch(/prosemirror/i);
      expect(nonCommentLines, `${file} should not leak EditorState`).not.toMatch(/EditorState/);
    }
  });

  it('uses only portable VaultService contract (bytes + WorkspacePath)', () => {
    // The codec's only vault interaction is via WorkspaceService which owns VaultService.
    // Direct file assertions: markdown files import only portable helpers.
    const codec = fs.readFileSync(path.resolve(__dirname, 'codec.ts'), 'utf8');
    expect(codec).toContain("from '../encoding.js'");
    expect(codec).not.toContain("from 'node:fs'");
  });
});
