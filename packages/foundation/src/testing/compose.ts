/**
 * Test composition helpers: build a full workspace over a vault
 * provider plugin, with a probe that captures the live workspace service.
 *
 * Used by the acceptance and adversarial suites in this package and by the
 * native provider package (provider swap over a real directory).
 */

import { Runtime, definePlugin, type PluginDefinition, type PluginSlot } from '@froglight/runtime';
import { workspacePlugin, type WorkspacePluginConfig } from '../plugins/workspace.js';
import { workspaceToken } from '../tokens.js';
import type { WorkspaceService } from '../workspace.js';
import type { DocumentSession } from '../session.js';
import { testNoteKind, testNoteKindId, testNoteModel } from './test-note.js';
import { documentRegistryToken, commandsToken } from '../tokens.js';
import type { DocumentRegistry } from '../documents.js';
import type { CommandService } from '../commands.js';
import { workspacePath } from '../paths.js';

export interface TestDocumentsPluginHooks {
  /** Called with the live workspace service on every activation. */
  readonly onWorkspace?: (workspace: WorkspaceService) => void;
  /** Called with the opened session on every activation. */
  readonly onSession?: (session: DocumentSession) => void;
}

export interface TestDocumentsPluginConfig extends TestDocumentsPluginHooks {
  /** Path of the create-or-open document; defaults to `test-notes/note-1.md`. */
  readonly documentPath?: string;
}

/**
 * A plugin that registers the test-note kind, a ping command, and a
 * create-or-open document with an open session. Everything is
 * lifecycle-owned, so provider swaps dispose and recreate it cleanly.
 */
export function testDocumentsPluginFactory(
  hooks: TestDocumentsPluginHooks = {},
): PluginDefinition<TestDocumentsPluginConfig> {
  return definePlugin<TestDocumentsPluginConfig>({
    id: 'froglight.test-documents',
    requirements: { requires: [workspaceToken] },
    activate: async (ctx) => {
      const workspace = ctx.require(workspaceToken);
      const registry = ctx.require(documentRegistryToken);
      const commands = ctx.require(commandsToken);
      const path = workspacePath(ctx.config.documentPath ?? 'test-notes/note-1.md');

      ctx.effect(() => registry.register(testNoteKind).dispose);
      ctx.effect(() =>
        commands.register({
          id: 'froglight.test.ping',
          title: 'Ping',
          execute: () => 'pong',
        }).dispose,
      );

      const existing = workspace.findByResourcePath(path);
      const ref =
        existing ??
        (await workspace.createDocument({
          kindId: testNoteKindId,
          path,
          initialModel: testNoteModel('Note 1', 'hello from the test plugin'),
        }));
      const session = await workspace.openDocument(ref.documentId);
      // Bind the method: the runtime invokes the disposer as a plain
      // function, so an unbound `session.close` would lose `this`.
      ctx.effect(() => () => session.close());

      hooks.onWorkspace?.(workspace);
      hooks.onSession?.(session);
    },
  });
}

export interface ComposeWorkspaceOptions {
  /** A plugin that provides `vaultToken` (e.g. `memoryVaultPlugin`). */
  readonly vaultPlugin: PluginDefinition;
  /** Config for the vault slot (e.g. shared state for reopen semantics). */
  readonly vaultConfig?: Readonly<Record<string, unknown>>;
  readonly workspaceConfig?: WorkspacePluginConfig;
  /** Register the test-documents plugin; defaults to true. */
  readonly registerTestDocuments?: boolean;
}

export interface ComposedWorkspace {
  readonly runtime: Runtime;
  readonly vaultSlot: PluginSlot;
  readonly workspaceSlot: PluginSlot;
  readonly testDocumentsSlot: PluginSlot | null;
  /** The currently active workspace service (re-captured after swaps). */
  getWorkspace(): WorkspaceService | null;
  dispose(): Promise<void>;
}

/**
 * Compose a runtime with a vault provider, the workspace plugin, and (by
 * default) the test-documents plugin. A probe slot captures the live
 * workspace service on every activation.
 */
export async function composeWorkspace(
  options: ComposeWorkspaceOptions,
): Promise<ComposedWorkspace> {
  const runtime = new Runtime();
  let current: WorkspaceService | null = null;
  const probe = definePlugin({
    id: 'froglight.probe',
    requirements: { requires: [workspaceToken] },
    activate: (ctx) => {
      const workspace = ctx.require(workspaceToken);
      current = workspace;
      // Lifecycle-owned capture: when the workspace fiber is disposed, the
      // probe is disposed too and must release its reference.
      ctx.effect(() => () => {
        if (current === workspace) {
          current = null;
        }
      });
    },
  });

  const vaultSlot = await runtime.registerSlot({
    id: 'vault',
    plugin: options.vaultPlugin,
    config: options.vaultConfig ?? {},
  });
  const workspaceSlot = await runtime.registerSlot({
    id: 'workspace',
    plugin: workspacePlugin,
    config: options.workspaceConfig ?? {},
  });
  await runtime.registerSlot({ id: 'probe', plugin: probe });
  const testDocumentsSlot =
    options.registerTestDocuments === false
      ? null
      : await runtime.registerSlot({
          id: 'test-documents',
          plugin: testDocumentsPluginFactory(),
        });

  return {
    runtime,
    vaultSlot,
    workspaceSlot,
    testDocumentsSlot,
    getWorkspace: () => current,
    dispose: async () => {
      await runtime.dispose();
    },
  };
}

/**
 * Replace the vault provider: remove the old vault slot (disposing the
 * workspace fiber and every dependent) and register a new one. Returns the
 * new vault slot.
 */
export async function replaceVaultProvider(
  composed: ComposedWorkspace,
  newVaultPlugin: PluginDefinition,
  newVaultConfig?: Readonly<Record<string, unknown>>,
): Promise<PluginSlot> {
  await composed.runtime.removeSlot(composed.vaultSlot.id);
  const slot = await composed.runtime.registerSlot({
    id: 'vault',
    plugin: newVaultPlugin,
    config: newVaultConfig ?? {},
  });
  return slot;
}

/** Re-exported for suites that need the registry/command types. */
export type { DocumentRegistry, CommandService };