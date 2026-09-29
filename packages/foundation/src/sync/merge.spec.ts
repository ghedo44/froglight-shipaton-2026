/**
 * Three-way merge conformance.
 *
 * Pure manifest-level matrix: no changes, creates, edits, deletes,
 * renames, directories, binaries, multi-path blobs, every conflict shape,
 * and deterministic conflict naming. No I/O, no network.
 */

import { describe, expect, it } from 'vitest';
import {
  assignConflictPath,
  threeWayMerge,
  type SyncConflict,
} from './merge.js';
import { buildManifest } from './manifest.js';
import type { SyncManifest, SyncManifestEntry } from './contract.js';

const A = `sha256:${'a'.repeat(64)}`;
const B = `sha256:${'b'.repeat(64)}`;
const C = `sha256:${'c'.repeat(64)}`;
const NOW = new Date('2026-09-09T13:10:33.000Z');

function file(path: string, blob: string, size = 3): SyncManifestEntry {
  return { path, kind: 'file', blob, size };
}

function dir(path: string): SyncManifestEntry {
  return { path, kind: 'directory' };
}

function manifest(entries: readonly SyncManifestEntry[]): SyncManifest {
  return buildManifest({
    vaultId: 'v',
    revision: 1,
    parentHash: null,
    entries,
  });
}

function mergedPathsOf(
  base: readonly SyncManifestEntry[],
  local: readonly SyncManifestEntry[],
  remote: readonly SyncManifestEntry[],
): {
  merged: readonly SyncManifestEntry[];
  conflicts: readonly SyncConflict[];
} {
  return threeWayMerge(manifest(base), manifest(local), manifest(remote), {
    now: NOW,
  });
}

function blobAt(
  merged: readonly SyncManifestEntry[],
  path: string,
): string | undefined {
  return merged.find((entry) => entry.path === path && entry.kind === 'file')
    ?.blob;
}

describe('three-way merge', () => {
  it('converges when nothing changed', () => {
    const entries = [file('a.md', A)];
    const { merged, conflicts } = mergedPathsOf(entries, entries, entries);
    expect(merged).toEqual(entries);
    expect(conflicts).toEqual([]);
  });

  it('takes a local file create', () => {
    const { merged, conflicts } = mergedPathsOf([], [file('new.md', A)], []);
    expect(blobAt(merged, 'new.md')).toBe(A);
    expect(conflicts).toEqual([]);
  });

  it('takes a remote file create', () => {
    const { merged, conflicts } = mergedPathsOf([], [], [file('new.md', A)]);
    expect(blobAt(merged, 'new.md')).toBe(A);
    expect(conflicts).toEqual([]);
  });

  it('takes a local file edit', () => {
    const { merged } = mergedPathsOf(
      [file('a.md', A)],
      [file('a.md', B)],
      [file('a.md', A)],
    );
    expect(blobAt(merged, 'a.md')).toBe(B);
  });

  it('takes a remote file edit', () => {
    const { merged } = mergedPathsOf(
      [file('a.md', A)],
      [file('a.md', A)],
      [file('a.md', B)],
    );
    expect(blobAt(merged, 'a.md')).toBe(B);
  });

  it('converges when both sides made the same edit', () => {
    const { merged, conflicts } = mergedPathsOf(
      [file('a.md', A)],
      [file('a.md', B)],
      [file('a.md', B)],
    );
    expect(blobAt(merged, 'a.md')).toBe(B);
    expect(conflicts).toEqual([]);
  });

  it('preserves both versions on concurrent edit with a deterministic copy', () => {
    const { merged, conflicts } = mergedPathsOf(
      [file('lecture.md', A)],
      [file('lecture.md', B)],
      [file('lecture.md', C)],
    );
    expect(blobAt(merged, 'lecture.md')).toBe(B);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      path: 'lecture.md',
      kind: 'edit-edit',
      kept: 'local',
    });
    const copy = conflicts[0]!.conflictPath!;
    expect(copy).toBe('lecture.conflict-aaaaaa-bbbbbb-cccccc.md');
    expect(blobAt(merged, copy)).toBe(C);
  });

  it('disambiguates when the conflict path is already occupied', () => {
    // Remote independently created a file at the would-be conflict name.
    const { merged, conflicts } = mergedPathsOf(
      [file('lecture.md', A)],
      [file('lecture.md', B)],
      [
        file('lecture.md', C),
        file('lecture.conflict-aaaaaa-bbbbbb-cccccc.md', A),
      ],
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.conflictPath).toBe(
      'lecture.conflict-aaaaaa-bbbbbb-cccccc-2.md',
    );
    // The pre-existing file survives untouched.
    expect(blobAt(merged, 'lecture.conflict-aaaaaa-bbbbbb-cccccc.md')).toBe(A);
    expect(blobAt(merged, conflicts[0]!.conflictPath!)).toBe(C);
  });

  it('drops a locally deleted file when remote is unchanged', () => {
    const { merged, conflicts } = mergedPathsOf(
      [file('a.md', A)],
      [],
      [file('a.md', A)],
    );
    expect(blobAt(merged, 'a.md')).toBeUndefined();
    expect(conflicts).toEqual([]);
  });

  it('drops a remotely deleted file when local is unchanged', () => {
    const { merged, conflicts } = mergedPathsOf(
      [file('a.md', A)],
      [file('a.md', A)],
      [],
    );
    expect(blobAt(merged, 'a.md')).toBeUndefined();
    expect(conflicts).toEqual([]);
  });

  it('preserves the edited version on local-delete vs remote-edit', () => {
    const { merged, conflicts } = mergedPathsOf(
      [file('a.md', A)],
      [],
      [file('a.md', B)],
    );
    expect(blobAt(merged, 'a.md')).toBe(B);
    expect(conflicts).toEqual([
      { path: 'a.md', kind: 'delete-edit', conflictPath: null, kept: 'remote' },
    ]);
  });

  it('preserves the edited version on local-edit vs remote-delete', () => {
    const { merged, conflicts } = mergedPathsOf(
      [file('a.md', A)],
      [file('a.md', B)],
      [],
    );
    expect(blobAt(merged, 'a.md')).toBe(B);
    expect(conflicts).toEqual([
      { path: 'a.md', kind: 'edit-delete', conflictPath: null, kept: 'local' },
    ]);
  });

  it('represents rename as delete+add without conflict', () => {
    const { merged, conflicts } = mergedPathsOf(
      [file('Old.md', A)],
      [file('New.md', A)],
      [file('Old.md', A)],
    );
    expect(blobAt(merged, 'Old.md')).toBeUndefined();
    expect(blobAt(merged, 'New.md')).toBe(A);
    expect(conflicts).toEqual([]);
  });

  it('keeps both renames when both sides rename the same blob differently', () => {
    const { merged, conflicts } = mergedPathsOf(
      [file('R.md', A)],
      [file('N1.md', A)],
      [file('N2.md', A)],
    );
    expect(blobAt(merged, 'R.md')).toBeUndefined();
    expect(blobAt(merged, 'N1.md')).toBe(A);
    expect(blobAt(merged, 'N2.md')).toBe(A);
    expect(conflicts).toEqual([]);
  });

  it('unions explicitly created directories', () => {
    const { merged } = mergedPathsOf([], [dir('Docs')], [dir('Pics')]);
    expect(merged).toContainEqual(dir('Docs'));
    expect(merged).toContainEqual(dir('Pics'));
  });

  it('drops a directory deleted on one side and unchanged on the other', () => {
    const { merged } = mergedPathsOf([dir('Docs')], [], [dir('Docs')]);
    expect(merged.find((entry) => entry.path === 'Docs')).toBeUndefined();
  });

  it('keeps files added under a directory the other side deleted', () => {
    const { merged } = mergedPathsOf(
      [dir('Docs')],
      [],
      [file('Docs/note.md', A)],
    );
    expect(blobAt(merged, 'Docs/note.md')).toBe(A);
    // No redundant explicit entry for the implied ancestor.
    expect(merged.find((entry) => entry.path === 'Docs')).toBeUndefined();
  });

  it('treats binary assets as opaque blobs', () => {
    const { merged, conflicts } = mergedPathsOf(
      [file('Assets/book.pdf', A, 80_000_000)],
      [file('Assets/book.pdf', B, 80_000_001)],
      [file('Assets/book.pdf', C, 80_000_002)],
    );
    expect(blobAt(merged, 'Assets/book.pdf')).toBe(B);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.conflictPath).toBe(
      'Assets/book.conflict-aaaaaa-bbbbbb-cccccc.pdf',
    );
  });

  it('supports the same blob at multiple paths', () => {
    const { merged, conflicts } = mergedPathsOf(
      [],
      [file('a.md', A), file('b.md', A)],
      [],
    );
    expect(blobAt(merged, 'a.md')).toBe(A);
    expect(blobAt(merged, 'b.md')).toBe(A);
    expect(conflicts).toEqual([]);
  });

  it('names extensionless and dotfile conflicts sanely', () => {
    const first = mergedPathsOf(
      [file('README', A)],
      [file('README', B)],
      [file('README', C)],
    );
    expect(first.conflicts[0]!.conflictPath).toBe(
      'README.conflict-aaaaaa-bbbbbb-cccccc',
    );
    const second = mergedPathsOf(
      [file('.env', A)],
      [file('.env', B)],
      [file('.env', C)],
    );
    expect(second.conflicts[0]!.conflictPath).toBe(
      '.env.conflict-aaaaaa-bbbbbb-cccccc',
    );
  });

  it('assigns conflict paths deterministically', () => {
    const occupied = new Set<string>();
    const first = assignConflictPath(occupied, 'n.md', B, NOW);
    const second = assignConflictPath(occupied, 'n.md', B, NOW);
    expect(first).toBe(second);
    expect(first).toBe('n.conflict-000000-000000-bbbbbb.md');
  });

  it('merges identical distributed inputs to byte-identical manifests', () => {
    // Two devices reconciling the same conflict at different wall-clock
    // times must generate identical conflict paths, or CAS retries would
    // pile up duplicate copies instead of converging.
    const base = [file('lecture.md', A)];
    const local = [file('lecture.md', B)];
    const remote = [file('lecture.md', C)];
    const first = threeWayMerge(
      manifest(base),
      manifest(local),
      manifest(remote),
      {
        now: new Date('2026-09-09T13:10:33.000Z'),
      },
    );
    const second = threeWayMerge(
      manifest(base),
      manifest(local),
      manifest(remote),
      {
        now: new Date('2031-04-17T08:00:00.000Z'),
      },
    );
    expect(second.merged).toEqual(first.merged);
    expect(second.conflicts).toEqual(first.conflicts);
    // The identity is content-derived (base/local/remote), not temporal.
    expect(first.conflicts[0]!.conflictPath).toBe(
      'lecture.conflict-aaaaaa-bbbbbb-cccccc.md',
    );
  });

  it('merges identical file/directory collisions deterministically', () => {
    const first = threeWayMerge(
      manifest([]),
      manifest([file('D', A)]),
      manifest([file('D/f.md', B)]),
      {
        now: new Date('2026-09-09T13:10:33.000Z'),
      },
    );
    const second = threeWayMerge(
      manifest([]),
      manifest([file('D', A)]),
      manifest([file('D/f.md', B)]),
      {
        now: new Date('2031-04-17T08:00:00.000Z'),
      },
    );
    expect(second.merged).toEqual(first.merged);
    expect(second.conflicts).toEqual(first.conflicts);
  });

  it('distinguishes same-name conflicts by content, never overwriting', () => {
    // Same path, different remote content → different conflict paths, so
    // the second conflict can never overwrite the first.
    const first = mergedPathsOf(
      [file('n.md', A)],
      [file('n.md', B)],
      [file('n.md', C)],
    );
    const occupied = new Set(first.merged.map((entry) => entry.path));
    const retry = assignConflictPath(occupied, 'n.md', C, NOW, {
      baseBlob: A,
      localBlob: B,
      remoteBlob: C,
    });
    // Identical inputs reproduce the occupied path, so disambiguation
    // appends a counter instead of reusing it.
    expect(retry).toBe('n.conflict-aaaaaa-bbbbbb-cccccc-2.md');
  });

  it('relocates a remote directory when local created a file at its path', () => {
    const { merged, conflicts } = mergedPathsOf(
      [],
      [file('D', A)],
      [file('D/f.md', B)],
    );
    expect(blobAt(merged, 'D')).toBe(A);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      path: 'D',
      kind: 'file-directory',
      kept: 'local',
    });
    const relocated = conflicts[0]!.conflictPath!;
    expect(blobAt(merged, `${relocated}/f.md`)).toBe(B);
  });

  it('moves a remote file aside when local created a directory at its path', () => {
    const { merged, conflicts } = mergedPathsOf([], [dir('D')], [file('D', A)]);
    expect(merged).toContainEqual(dir('D'));
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      path: 'D',
      kind: 'file-directory',
      kept: 'local',
    });
    expect(blobAt(merged, conflicts[0]!.conflictPath!)).toBe(A);
    // The merged manifest stays internally consistent (no file/dir overlap).
    const paths = merged.map((entry) => `${entry.kind}:${entry.path}`);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('takes a one-sided file-over-directory replacement without conflict', () => {
    const { merged, conflicts } = mergedPathsOf(
      [dir('D')],
      [file('D', A)],
      [dir('D')],
    );
    expect(blobAt(merged, 'D')).toBe(A);
    expect(conflicts).toEqual([]);
  });
});
