/**
 * Adversarial lifecycle tests: provider replacement over the real runtime.
 *
 * The runtime owns every registration as a reversible effect:
 * replacing the vault provider must dispose the workspace fiber and every
 * dependent (probe, test documents), then activate fresh fibers with fresh
 * service instances — no dangling services, listeners, or sessions.
 */

import { describe, expect, it } from 'vitest';
import { AggregateRuntimeError, Runtime, definePlugin } from '@froglight/runtime';
import { memoryVaultPlugin } from './plugins/memory-vault.js';
import { workspacePlugin } from './plugins/workspace.js';
import {
  composeWorkspace,
  replaceVaultProvider,
  testDocumentsPluginFactory,
  type ComposedWorkspace,
} from './testing/compose.js';
import { createMemoryVaultState } from './vault/memory.js';
import {
  commandsToken,
  documentRegistryToken,
  metadataToken,
  navigationToken,
  relationshipsToken,
  revisionsToken,
  settingsToken,
  vaultToken,
  workspaceToken,
} from './tokens.js';
import type { CommandService } from './commands.js';
import type { DocumentRegistry } from './documents.js';
import type { DocumentSession } from './session.js';
import type { WorkspaceService } from './workspace.js';
import { workspacePath } from './paths.js';
import { requireValue } from './testing/require-value.js';
import type { TestDocModel } from './testing/test-note.js';

type Mutable<T> = { -readonly [P in keyof T]: T[P] };

/** All capability tokens the workspace plugin provides (plus the vault). */
const ALL_TOKENS = [
  vaultToken,
  documentRegistryToken,
  metadataToken,
  relationshipsToken,
  commandsToken,
  settingsToken,
  navigationToken,
  revisionsToken,
  workspaceToken,
];

function bindingCount(runtime: Runtime, tokenId: string): number {
  return runtime.inspect().bindings.filter((b) => b.token.id === tokenId).length;
}

function errorTreeMessages(error: unknown): readonly string[] {
  if (!(error instanceof Error)) return [];
  if (!(error instanceof AggregateRuntimeError)) return [error.message];
  return [error.message, ...error.errors.flatMap(errorTreeMessages)];
}

interface Captured {
  workspace: WorkspaceService | null;
  registry: DocumentRegistry | null;
  commands: CommandService | null;
  session: DocumentSession | null;
}

/** Compose like `composeWorkspace` but capture live services + session. */
async function composeCapturing(): Promise<ComposedWorkspace & { captured: Captured }> {
  const captured: Captured = { workspace: null, registry: null, commands: null, session: null };
  const runtime = new Runtime();
  const probe = definePlugin({
    id: 'froglight.probe',
    requirements: { requires: [workspaceToken] },
    activate: (ctx) => {
      captured.workspace = ctx.require(workspaceToken);
      captured.registry = ctx.require(documentRegistryToken);
      captured.commands = ctx.require(commandsToken);
    },
  });
  const vaultSlot = await runtime.registerSlot({
    id: 'vault',
    plugin: memoryVaultPlugin,
    config: {},
  });
  const workspaceSlot = await runtime.registerSlot({
    id: 'workspace',
    plugin: workspacePlugin,
    config: { workspaceId: 'ws-adversarial' },
  });
  await runtime.registerSlot({ id: 'probe', plugin: probe });
  const testDocumentsSlot = await runtime.registerSlot({
    id: 'test-documents',
    plugin: testDocumentsPluginFactory({
      onSession: (session) => {
        captured.session = session;
      },
    }),
  });
  return {
    runtime,
    vaultSlot,
    workspaceSlot,
    testDocumentsSlot,
    captured,
    getWorkspace: () => captured.workspace,
    dispose: async () => {
      await runtime.dispose();
    },
    // The slot generics differ from `ComposedWorkspace`'s bare `PluginSlot`;
    // the shape is verified by the tests below.
  } as unknown as ComposedWorkspace & { captured: Captured };
}

describe('composition activates a complete workspace', () => {
  it('activates exactly one binding per capability token', async () => {
    const composed = await composeWorkspace({ vaultPlugin: memoryVaultPlugin });
    try {
      for (const token of ALL_TOKENS) {
        expect(bindingCount(composed.runtime, token.id)).toBe(1);
      }
      expect(composed.getWorkspace()).not.toBeNull();
      expect(composed.runtime.inspect().counts.activeFibers).toBeGreaterThanOrEqual(3);
    } finally {
      await composed.dispose();
    }
  });

  it('dispose tears everything down to zero bindings and fibers', async () => {
    const composed = await composeWorkspace({ vaultPlugin: memoryVaultPlugin });
    await composed.dispose();
    expect(composed.runtime.inspect().counts.activeFibers).toBe(0);
    expect(composed.runtime.inspect().counts.bindings).toBe(0);
  });

  it('disposes the workspace when the final settings flush fails', async () => {
    const runtime = new Runtime();
    const captured = {
      workspace: null as WorkspaceService | null,
      settings: null as import('./settings.js').SettingsService | null,
    };
    await runtime.registerSlot({
      id: 'vault',
      plugin: memoryVaultPlugin,
      config: {
        fail: (operation, path) =>
          operation === 'write' && path === '.froglight/settings.json'
            ? new Error('settings flush failed')
            : null,
      },
    });
    await runtime.registerSlot({ id: 'workspace', plugin: workspacePlugin, config: {} });
    await runtime.registerSlot({
      id: 'cleanup-probe',
      plugin: definePlugin({
        id: 'froglight.cleanup-probe',
        requirements: { requires: [settingsToken, workspaceToken] },
        activate: (ctx) => {
          captured.settings = ctx.require(settingsToken);
          captured.workspace = ctx.require(workspaceToken);
        },
      }),
    });

    requireValue(captured.settings, 'settings').set('appearance.theme', 'dark');
    let disposalError: unknown;
    try {
      await runtime.dispose();
    } catch (error) {
      disposalError = error;
    }
    expect(disposalError).toMatchObject({ code: 'DISPOSAL_FAILED' });
    expect(errorTreeMessages(disposalError)).toContain('settings flush failed');
    expect(() => requireValue(captured.workspace, 'workspace').listDocuments()).toThrow(
      expect.objectContaining({ code: 'SERVICE_DISPOSED' }),
    );
  });
});

describe('provider replacement semantics', () => {
  it('lifecycle invariant: activate → 1 binding, dispose → 0, reactivate → 1', async () => {
    const composed = await composeWorkspace({
      vaultPlugin: memoryVaultPlugin,
      registerTestDocuments: false,
    });
    expect(bindingCount(composed.runtime, vaultToken.id)).toBe(1);
    await composed.runtime.removeSlot(composed.vaultSlot.id);
    expect(bindingCount(composed.runtime, vaultToken.id)).toBe(0);
    expect(composed.getWorkspace()).toBeNull();
    await composed.runtime.registerSlot({
      id: 'vault',
      plugin: memoryVaultPlugin,
      config: {},
    });
    expect(bindingCount(composed.runtime, vaultToken.id)).toBe(1);
    expect(composed.getWorkspace()).not.toBeNull();
    await composed.dispose();
  });

  it('swap disposes the old fiber and activates fresh fibers with fresh services', async () => {
    const composed = await composeCapturing();
    const { runtime, captured } = composed;
    const oldWorkspace = requireValue(captured.workspace, 'workspace');
    const oldFiberIds = new Set(runtime.inspect().fibers.map((f) => f.id));

    await replaceVaultProvider(composed, memoryVaultPlugin, {});

    // Fresh fiber identities everywhere.
    const newFiberIds = new Set(runtime.inspect().fibers.map((f) => f.id));
    for (const id of newFiberIds) {
      expect(oldFiberIds.has(id)).toBe(false);
    }
    expect(captured.workspace).not.toBe(oldWorkspace);
    expect(captured.workspace).not.toBeNull();
    // Still exactly one binding per capability.
    for (const token of ALL_TOKENS) {
      expect(bindingCount(runtime, token.id)).toBe(1);
    }
    // The old workspace is disposed: operations throw SERVICE_DISPOSED.
    try {
      oldWorkspace.listDocuments();
      expect.unreachable('old workspace must be disposed');
    } catch (error) {
      expect(error).toMatchObject({ code: 'SERVICE_DISPOSED' });
    }
    await runtime.dispose();
  });

  it('swap preserves canonical content, identity, and session hygiene', async () => {
    const state = createMemoryVaultState();
    const composed = await composeWorkspace({
      vaultPlugin: memoryVaultPlugin,
      vaultConfig: { state },
      workspaceConfig: { workspaceId: 'ws-swap' },
    });
    const initialWorkspace = requireValue(composed.getWorkspace(), 'workspace');
    const firstRef = requireValue(initialWorkspace.listDocuments()[0], 'document ref');
    const firstSession = await initialWorkspace.openDocument(firstRef.documentId);

    await replaceVaultProvider(composed, memoryVaultPlugin, { state });

    const workspace = requireValue(composed.getWorkspace(), 'workspace');
    // The workspace identity record survived in the shared backing state.
    expect(workspace.workspaceId).toBe('ws-swap');
    // The canonical document is readable after the swap (content survived).
    const ref = workspace.findByResourcePath(workspacePath('test-notes/note-1.md'));
    const openRef = requireValue(ref, 'document ref');
    const session = await workspace.openDocument(openRef.documentId);
    expect((session.model as TestDocModel).title).toBe('Note 1');
    // Old sessions were closed by the swap.
    expect(firstSession.state).toBe('closed');
    await composed.dispose();
  });

  it('swap leaves exactly one document kind and one command', async () => {
    const composed = await composeCapturing();
    const { runtime, captured } = composed;
    await replaceVaultProvider(composed, memoryVaultPlugin, {});
    // One kind: the test-note kind, registered by the test-documents plugin.
    const registry = requireValue(captured.registry, 'registry');
    const commands = requireValue(captured.commands, 'commands');
    expect(registry.list()).toHaveLength(1);
    // Workspace-level commands are product concerns (the workbench owns
    // navigation); only the composition test ping remains here.
    expect([...commands.list()].sort()).toEqual(['froglight.test.ping']);
    // The ping command still executes after the swap.
    expect((await commands.execute('froglight.test.ping')).ok).toBe(true);
    await runtime.dispose();
  });

  it('sequential swaps keep the system consistent', async () => {
    const composed = await composeWorkspace({ vaultPlugin: memoryVaultPlugin });
    for (let i = 0; i < 3; i++) {
      await replaceVaultProvider(composed, memoryVaultPlugin, {});
      expect(composed.getWorkspace()).not.toBeNull();
      for (const token of ALL_TOKENS) {
        expect(bindingCount(composed.runtime, token.id)).toBe(1);
      }
      expect(composed.runtime.inspect().counts.activeFibers).toBeGreaterThanOrEqual(3);
    }
    await composed.dispose();
    expect(composed.runtime.inspect().counts.bindings).toBe(0);
  });

  it('swap yields fresh derived-service instances with no dangling listeners', async () => {
    const state = createMemoryVaultState();
    // Capture derived services via a probe that re-activates on each swap.
    const captured = {
      metadata: null as import('./metadata.js').MetadataService | null,
      relationships: null as import('./relationships.js').RelationshipService | null,
      navigation: null as import('./navigation.js').NavigationService | null,
      workspace: null as WorkspaceService | null,
    };
    const probe = definePlugin({
      id: 'froglight.captured-derived',
      requirements: { requires: [workspaceToken, metadataToken, relationshipsToken, navigationToken] },
      activate: (ctx) => {
        captured.workspace = ctx.require(workspaceToken);
        captured.metadata = ctx.require(metadataToken);
        captured.relationships = ctx.require(relationshipsToken);
        captured.navigation = ctx.require(navigationToken);
      },
    });
    const runtime = new Runtime();
    const vaultSlot = await runtime.registerSlot({ id: 'vault', plugin: memoryVaultPlugin, config: { state } });
    const workspaceSlot = await runtime.registerSlot({
      id: 'workspace',
      plugin: workspacePlugin,
      config: { workspaceId: 'ws-fresh' } as never,
    });
    await runtime.registerSlot({ id: 'probe-derived', plugin: probe });
    const testDocumentsSlot = await runtime.registerSlot({
      id: 'test-documents',
      plugin: testDocumentsPluginFactory(),
    });
    const composed = {
      runtime,
      vaultSlot,
      workspaceSlot,
      testDocumentsSlot,
      getWorkspace: () => captured.workspace,
      dispose: async () => {
        await runtime.dispose();
      },
    } as unknown as ComposedWorkspace;

    const beforeWorkspace = requireValue(captured.workspace, 'workspace');
    const beforeMetadata = requireValue(captured.metadata, 'metadata');
    const beforeRelationships = requireValue(captured.relationships, 'relationships');
    const beforeNavigation = requireValue(captured.navigation, 'navigation');
    // Seed derived state via the initial session's post-commit projection.
    const ref = requireValue(beforeWorkspace.listDocuments()[0], 'ref');
    const s1 = await beforeWorkspace.openDocument(ref.documentId);
    (s1.model as unknown as Mutable<TestDocModel>).title = 'Before';
    s1.markDirty();
    await s1.save();
    expect(beforeMetadata.get(ref.documentId).title).toBe('Before');
    beforeNavigation.push({ resourceId: ref.location.resourceId });
    expect(beforeNavigation.current).not.toBeNull();
    const oldMetadata = beforeMetadata;
    const oldRelationships = beforeRelationships;
    const oldNavigation = beforeNavigation;

    await replaceVaultProvider(composed, memoryVaultPlugin, { state });

    const afterWorkspace = requireValue(captured.workspace, 'workspace');
    const afterMetadata = requireValue(captured.metadata, 'metadata');
    const afterRelationships = requireValue(captured.relationships, 'relationships');
    const afterNavigation = requireValue(captured.navigation, 'navigation');
    // Fresh instances, not the old ones.
    expect(afterMetadata).not.toBe(oldMetadata);
    expect(afterRelationships).not.toBe(oldRelationships);
    expect(afterNavigation).not.toBe(oldNavigation);
    // Old mutated navigation is gone; new history is empty (fresh service).
    expect(afterNavigation.current).toBeNull();
    // New derived state is empty until rebuilt — no dangling metadata from previous fiber.
    expect(afterMetadata.list()).toEqual([]);
    expect(afterRelationships.list()).toEqual([]);
    // But rebuilding from canonical bytes repopulates it (from the saved "Before" title).
    await afterWorkspace.rebuildDerivedState();
    expect(afterMetadata.list().length).toBe(1);
    expect(requireValue(afterMetadata.list()[0], 'metadata entry').title).toBe('Before');
    await composed.dispose();
    // Old services are still the old objects (not magically cleared), but they
    // are no longer the active bindings.
    expect(oldMetadata.list().length).toBe(1);
    expect(oldMetadata.get(ref.documentId).title).toBe('Before');
  });
});
