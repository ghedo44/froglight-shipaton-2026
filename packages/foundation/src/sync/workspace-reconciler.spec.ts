/**
 * Workspace/session reconciliation fail-closed policy.
 *
 * Required application reconciliation failures must propagate (the service
 * keeps the per-replica pending retry and the base/checkpoint does not
 * advance). Only rebuildable derived state stays best-effort.
 */

import { describe, expect, it } from 'vitest';
import type { WorkspacePath } from '../paths.js';
import type { WorkspaceService } from '../workspace.js';
import { WORKSPACE_RECORD_PATH } from '../workspace.js';
import { WorkspaceSyncReconciler } from './workspace-tracker.js';

const PATH = 'note.md' as WorkspacePath;

function workspaceWith(
  overrides: Partial<Record<string, unknown>>,
): WorkspaceService {
  const base = {
    reloadFromVault: async () => undefined,
    findByResourcePath: (_path: WorkspacePath) => ({
      documentId: 'doc-1',
      kindId: 'froglight.markdown',
      location: { resourceId: 'res-1' },
    }),
    getOpenDocument: (_id: unknown) => ({
      dirty: false,
      reload: async () => undefined,
    }),
    closeDocument: async (_id: unknown) => undefined,
    rebuildDerivedState: async () => undefined,
  };
  return { ...base, ...overrides } as unknown as WorkspaceService;
}

describe('WorkspaceSyncReconciler fail-closed', () => {
  it('propagates getWorkspace throw (null stays a no-op)', async () => {
    const throwing = new WorkspaceSyncReconciler({
      getWorkspace: () => {
        throw new Error('workspace torn down');
      },
    });
    await expect(
      throwing.handleRemoteApplied({ written: [PATH], removed: [] }),
    ).rejects.toThrow('workspace torn down');
    const missing = new WorkspaceSyncReconciler({
      getWorkspace: () => null,
    });
    await expect(
      missing.handleRemoteApplied({ written: [PATH], removed: [] }),
    ).resolves.toBeUndefined();
  });

  it('propagates reloadFromVault failure for the workspace record', async () => {
    const reconciler = new WorkspaceSyncReconciler({
      getWorkspace: () =>
        workspaceWith({
          reloadFromVault: async () => {
            throw new Error('vault unreadable');
          },
        }),
    });
    await expect(
      reconciler.handleRemoteApplied({
        written: [WORKSPACE_RECORD_PATH as WorkspacePath],
        removed: [],
      }),
    ).rejects.toThrow('vault unreadable');
  });

  it('propagates findByResourcePath failure for an affected path', async () => {
    const reconciler = new WorkspaceSyncReconciler({
      getWorkspace: () =>
        workspaceWith({
          findByResourcePath: () => {
            throw new Error('index unavailable');
          },
        }),
    });
    await expect(
      reconciler.handleRemoteApplied({ written: [PATH], removed: [] }),
    ).rejects.toThrow('index unavailable');
  });

  it('propagates getOpenDocument failure', async () => {
    const reconciler = new WorkspaceSyncReconciler({
      getWorkspace: () =>
        workspaceWith({
          getOpenDocument: () => {
            throw new Error('session registry down');
          },
        }),
    });
    await expect(
      reconciler.handleRemoteApplied({ written: [PATH], removed: [] }),
    ).rejects.toThrow('session registry down');
  });

  it('propagates clean reload failure', async () => {
    const reconciler = new WorkspaceSyncReconciler({
      getWorkspace: () =>
        workspaceWith({
          getOpenDocument: () => ({
            dirty: false,
            reload: async () => {
              throw new Error('editor reload blew up');
            },
          }),
        }),
    });
    await expect(
      reconciler.handleRemoteApplied({ written: [PATH], removed: [] }),
    ).rejects.toThrow('editor reload blew up');
  });

  it('propagates clean close failure for removed paths', async () => {
    const reconciler = new WorkspaceSyncReconciler({
      getWorkspace: () =>
        workspaceWith({
          closeDocument: async () => {
            throw new Error('close blew up');
          },
        }),
    });
    await expect(
      reconciler.handleRemoteApplied({ written: [], removed: [PATH] }),
    ).rejects.toThrow('close blew up');
  });

  it('keeps derived rebuild best-effort while canonical work already ran', async () => {
    let reloaded = false;
    const reconciler = new WorkspaceSyncReconciler({
      getWorkspace: () =>
        workspaceWith({
          getOpenDocument: () => ({
            dirty: false,
            reload: async () => {
              reloaded = true;
            },
          }),
          rebuildDerivedState: async () => {
            throw new Error('index blew up');
          },
        }),
    });
    await expect(
      reconciler.handleRemoteApplied({ written: [PATH], removed: [] }),
    ).resolves.toBeUndefined();
    expect(reloaded).toBe(true);
  });

  it('skips dirty sessions without touching them', async () => {
    let reloaded = false;
    let closed = false;
    const reconciler = new WorkspaceSyncReconciler({
      getWorkspace: () =>
        workspaceWith({
          getOpenDocument: () => ({
            dirty: true,
            reload: async () => {
              reloaded = true;
            },
          }),
          closeDocument: async () => {
            closed = true;
          },
        }),
    });
    await reconciler.handleRemoteApplied({ written: [PATH], removed: [PATH] });
    expect(reloaded).toBe(false);
    expect(closed).toBe(false);
  });
});
