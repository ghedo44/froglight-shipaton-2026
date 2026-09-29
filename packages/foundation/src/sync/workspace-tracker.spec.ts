/**
 * Workbench-backed dirty tracker.
 *
 * Pure mapping from vault paths to open-session dirty flags over a
 * structural workspace fake: dirty sessions defer, clean/closed/absent
 * paths proceed. Fail-closed: no workspace (null) → clean/false; a
 * workspace lookup that THROWS → dirty/true (state unknown is not
 * permission to overwrite); workspace exists but a required lookup
 * unexpectedly fails → dirty/true (defer; never throws, never overwrites
 * beneath unknown session state).
 */

import { describe, expect, it } from 'vitest';
import type { DocumentId } from '../identity.js';
import type { WorkspacePath } from '../paths.js';
import type { WorkspaceService } from '../workspace.js';
import { WorkspaceDirtyTracker } from './workspace-tracker.js';

const NOTE = 'note.md' as WorkspacePath;
const OTHER = 'other.md' as WorkspacePath;

function fakeWorkspace(options: {
  readonly dirtyPaths?: readonly WorkspacePath[];
  readonly failLookup?: boolean;
  readonly failFind?: boolean;
  readonly failSession?: boolean;
}): WorkspaceService {
  const dirty = new Set(options.dirtyPaths ?? []);
  return {
    findByResourcePath: (path: WorkspacePath) => {
      if (options.failLookup || options.failFind)
        throw new Error('index unavailable');
      if (path !== NOTE && path !== OTHER) return null;
      return {
        documentId: `${String(path)}-id` as DocumentId,
        kindId: 'froglight.markdown' as never,
        location: { resourceId: `${String(path)}-r` as never },
      } as never;
    },
    getOpenDocument: (documentId: DocumentId) => {
      if (options.failLookup || options.failSession)
        throw new Error('session unavailable');
      const path = String(documentId).replace(/-id$/, '') as WorkspacePath;
      if (path !== NOTE && path !== OTHER) return null;
      return { dirty: dirty.has(path) } as never;
    },
  } as unknown as WorkspaceService;
}

describe('WorkspaceDirtyTracker', () => {
  it('reports dirty only for open sessions with unsaved edits', () => {
    const tracker = new WorkspaceDirtyTracker({
      getWorkspace: () => fakeWorkspace({ dirtyPaths: [NOTE] }),
    });
    expect(tracker.isDirty(NOTE)).toBe(true);
    expect(tracker.isDirty(OTHER)).toBe(false);
    expect(tracker.isDirty('missing.md' as WorkspacePath)).toBe(false);
  });

  it('reports clean when no vault is open', () => {
    const tracker = new WorkspaceDirtyTracker({ getWorkspace: () => null });
    expect(tracker.isDirty(NOTE)).toBe(false);
  });

  it('never throws: null workspace is clean; failed lookups fail closed (dirty)', () => {
    // Workspace exists but lookups fail → dirty (defer, fail closed).
    const failing = new WorkspaceDirtyTracker({
      getWorkspace: () => fakeWorkspace({ failLookup: true }),
    });
    expect(failing.isDirty(NOTE)).toBe(true);
    // The workspace getter itself throws: workspace state is UNKNOWN (not
    // absent), so cleanliness cannot be proven → dirty/defer, never a
    // remote overwrite beneath a potentially dirty session.
    const throwing = new WorkspaceDirtyTracker({
      getWorkspace: () => {
        throw new Error('host torn down');
      },
    });
    expect(throwing.isDirty(NOTE)).toBe(true);
  });

  it('fails closed per lookup stage', () => {
    // findByResourcePath throws while a workspace exists → dirty.
    expect(
      new WorkspaceDirtyTracker({
        getWorkspace: () => fakeWorkspace({ failFind: true }),
      }).isDirty(NOTE),
    ).toBe(true);
    // open-session lookup throws → dirty.
    expect(
      new WorkspaceDirtyTracker({
        getWorkspace: () => fakeWorkspace({ failSession: true }),
      }).isDirty(NOTE),
    ).toBe(true);
    // Normal missing document → clean.
    expect(
      new WorkspaceDirtyTracker({
        getWorkspace: () => fakeWorkspace({}),
      }).isDirty('missing.md' as WorkspacePath),
    ).toBe(false);
    // Normal closed document (null session) → clean.
    expect(
      new WorkspaceDirtyTracker({
        getWorkspace: () =>
          ({
            findByResourcePath: () => null,
            getOpenDocument: () => null,
          }) as unknown as WorkspaceService,
      }).isDirty(NOTE),
    ).toBe(false);
    // Normal clean open session → clean; dirty → dirty.
    expect(
      new WorkspaceDirtyTracker({
        getWorkspace: () => fakeWorkspace({ dirtyPaths: [] }),
      }).isDirty(OTHER),
    ).toBe(false);
    expect(
      new WorkspaceDirtyTracker({
        getWorkspace: () => fakeWorkspace({ dirtyPaths: [NOTE] }),
      }).isDirty(NOTE),
    ).toBe(true);
  });

  it('follows vault replacement through the live lookup', () => {
    let workspace: WorkspaceService | null = fakeWorkspace({ dirtyPaths: [] });
    const tracker = new WorkspaceDirtyTracker({
      getWorkspace: () => workspace,
    });
    expect(tracker.isDirty(NOTE)).toBe(false);
    workspace = fakeWorkspace({ dirtyPaths: [NOTE] });
    expect(tracker.isDirty(NOTE)).toBe(true);
    workspace = null;
    expect(tracker.isDirty(NOTE)).toBe(false);
  });
});
