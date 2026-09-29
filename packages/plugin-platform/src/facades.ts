import type { TrustTier } from '@froglight/sdk';
import type { PermissionBroker } from './permissions.js';
import type {
  VaultService,
  WorkspacePath,
  BlockRegistry,
  BlockTypeDescriptor,
  DocumentRegistry,
  DocumentKindDescriptor,
  PropertyCatalog,
  PropertyTypeDescriptor,
} from '@froglight/foundation';
import { isValidWorkspacePath } from '@froglight/foundation';
import type { CommandService } from '@froglight/foundation';
import type { SettingsService } from '@froglight/foundation';
import type { MarkdownEditorProvider } from '@froglight/foundation';
import { createServiceToken } from '@froglight/runtime';
import type {
  CommunityToolbarHost,
  CommunityToolbarManifest,
} from './toolbar.js';
import { validateCommunityToolbarManifest } from './toolbar.js';

/**
 * Scoped capability facades — identity-carrying proxies that check the
 * PermissionBroker before delegating to the trusted provider. No raw host
 * handles are exposed. Services are injected via the activation context
 * (ctx.require), not via runtime.inspect, so the facade never bypasses
 * the capability boundary or message chains.
 */

/**
 * Ordinary views contribute framework-neutral metadata. Trusted same-realm
 * plugins can additionally mount content in a shell-owned activity window.
 * The container stays opaque here; the UI package owns its DOM type.
 */
export interface UiViewContribution {
  readonly id: string;
  readonly title?: string;
  readonly area?: 'activity';
  readonly icon?: string;
  readonly mount?: (container: unknown) => void | (() => void);
}

export interface UiViewsService {
  register(view: UiViewContribution): { dispose(): void };
}

export const uiViewsToken =
  createServiceToken<UiViewsService>('froglight.ui.views');

/**
 * A settings-section contribution from a plugin: framework-neutral metadata
 * and capability discovery only (same trusted-only gate as views, so the
 * closed permission catalog stays closed). Visible presentation belongs to
 * trusted UI plugins through the UI package React entrypoint.
 */
export interface UiSettingsSectionContribution {
  readonly id: string;
  readonly name: string;
  readonly group?: string;
  readonly icon?: string;
  readonly order?: number;
  readonly keywords?: readonly string[];
}

export interface UiSettingsService {
  register(section: UiSettingsSectionContribution): { dispose(): void };
}

export const uiSettingsToken = createServiceToken<UiSettingsService>(
  'froglight.ui.settings',
);

export interface FacadeServices {
  readonly vault?: VaultService;
  readonly commands?: CommandService;
  readonly settings?: SettingsService;
  readonly uiViews?: UiViewsService;
  readonly uiSettings?: UiSettingsService;
  readonly editorProvider?: MarkdownEditorProvider;
  readonly blocks?: BlockRegistry;
  readonly toolbar?: CommunityToolbarHost;
  readonly documents?: DocumentRegistry;
  readonly propertyCatalog?: PropertyCatalog;
}

export interface FacadeDeps {
  readonly broker: PermissionBroker;
  readonly tier: TrustTier;
  readonly services: FacadeServices;
  /**
   * Called for every registration a plugin makes through these facades while
   * its activation runs. The host forwards these into the fiber's effect
   * scope so teardown is automatic — plugin authors do not have to remember
   * bespoke cleanup for activation-time registrations.
   */
  readonly onRegistration?: (dispose: () => void) => void;
}

export interface VaultFacade {
  read(path: WorkspacePath): Promise<Uint8Array>;
  write(path: WorkspacePath, data: Uint8Array): Promise<void>;
  remove(path: WorkspacePath): Promise<void>;
  stat(path: WorkspacePath): Promise<unknown>;
  list(dir: WorkspacePath): Promise<unknown>;
}

export interface CommandFacade {
  register(cmd: { id: string; title?: string; execute: () => unknown }): {
    dispose(): void;
  };
  execute(id: string, ...args: unknown[]): Promise<unknown>;
  list(): unknown;
}

export interface SettingsFacade {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
}

export interface UiViewsFacade {
  register(view: UiViewContribution): { dispose(): void };
}

export interface UiSettingsFacade {
  register(section: UiSettingsSectionContribution): { dispose(): void };
}

export interface EditorProviderFacade {
  register(provider: unknown): { dispose(): void };
}

export interface BlocksFacade {
  register(descriptor: BlockTypeDescriptor): { dispose(): void };
}

export interface ToolbarFacade {
  register(manifest: CommunityToolbarManifest): { dispose(): void };
}

export interface DocumentsFacade {
  registerKind(descriptor: DocumentKindDescriptor): { dispose(): void };
}

export interface PropertiesFacade {
  registerType(descriptor: PropertyTypeDescriptor): { dispose(): void };
}

export interface SdkFacades {
  readonly vault: VaultFacade;
  readonly commands: CommandFacade;
  readonly settings: SettingsFacade;
  readonly uiViews: UiViewsFacade;
  readonly uiSettings: UiSettingsFacade;
  readonly editorProvider: EditorProviderFacade;
  readonly blocks: BlocksFacade;
  readonly toolbar: ToolbarFacade;
  readonly documents: DocumentsFacade;
  readonly properties: PropertiesFacade;
}

function assertWorkspacePath(path: string): WorkspacePath {
  if (!isValidWorkspacePath(path as WorkspacePath)) {
    throw new Error(`Vault path traversal rejected: ${JSON.stringify(path)}`);
  }
  if (path.includes('\0') || path.includes('\\')) {
    throw new Error(
      `Vault path traversal rejected: illegal characters in ${JSON.stringify(path)}`,
    );
  }
  return path as WorkspacePath;
}

export function createSdkFacades(deps: FacadeDeps): SdkFacades {
  const { broker, services, onRegistration } = deps;
  // Registration-owning facades route their disposer to the owner scope.
  const own = (dispose: () => void): { dispose(): void } => {
    onRegistration?.(dispose);
    return { dispose };
  };

  const vault: VaultFacade = {
    async read(path) {
      broker.require('vault.read');
      const clean = assertWorkspacePath(path as string);
      const svc = services.vault;
      if (!svc) throw new Error('vault service unavailable');
      return svc.read(clean);
    },
    async write(path, data) {
      broker.require('vault.write');
      const clean = assertWorkspacePath(path as string);
      const svc = services.vault;
      if (!svc) throw new Error('vault service unavailable');
      return svc.write(clean, data);
    },
    async remove(path) {
      broker.require('vault.write');
      const clean = assertWorkspacePath(path as string);
      const svc = services.vault;
      if (!svc) throw new Error('vault service unavailable');
      return svc.remove(clean);
    },
    async stat(path) {
      broker.require('vault.read');
      const clean = assertWorkspacePath(path as string);
      const svc = services.vault;
      if (!svc) throw new Error('vault service unavailable');
      return svc.stat(clean);
    },
    async list(dir) {
      broker.require('vault.read');
      const clean = assertWorkspacePath(dir as string);
      const svc = services.vault;
      if (!svc) throw new Error('vault service unavailable');
      return svc.list(clean);
    },
  };

  const commands: CommandFacade = {
    register(cmd) {
      broker.require('workspace.commands.register');
      const svc = services.commands;
      if (!svc) throw new Error('commands service unavailable');
      return own(svc.register(cmd).dispose);
    },
    async execute(id, ...args) {
      // Deliberately fail-closed: the closed permission catalog has no
      // separate execute/list grant in this phase, so only plugins that may
      // register commands may invoke or enumerate them.
      broker.require('workspace.commands.register');
      const svc = services.commands;
      if (!svc) throw new Error('commands service unavailable');
      return (svc as any).execute(id, ...args);
    },
    list() {
      broker.require('workspace.commands.register');
      const svc = services.commands;
      if (!svc) throw new Error('commands service unavailable');
      return (svc as any).list();
    },
  };

  const settings: SettingsFacade = {
    get(key) {
      broker.require('workspace.settings.read');
      const svc = services.settings;
      if (!svc) throw new Error('settings service unavailable');
      return svc.get(key as any) as any;
    },
    set(key, value) {
      broker.require('workspace.settings.write');
      const svc = services.settings;
      if (!svc) throw new Error('settings service unavailable');
      return (svc as any).set(key, value);
    },
  };

  const uiViews: UiViewsFacade = {
    register(view) {
      broker.require('ui.views.register');
      const svc = services.uiViews;
      if (!svc) throw new Error('ui.views service unavailable');
      return own(svc.register(view).dispose);
    },
  };

  const uiSettings: UiSettingsFacade = {
    register(section) {
      // Settings sections are UI registration: same trusted-only gate as
      // views, so the closed permission catalog stays closed.
      broker.require('ui.views.register');
      const svc = services.uiSettings;
      if (!svc) throw new Error('ui.settings service unavailable');
      return own(svc.register(section).dispose);
    },
  };

  const editorProvider: EditorProviderFacade = {
    register(_provider) {
      broker.require('editor.provider');
      if (!services.editorProvider)
        throw new Error('editor.provider service unavailable');
      // Community plugins cannot install editor providers through this
      // facade; the permission check alone does not register a provider.
      throw new Error(
        'editor.provider registration is not supported for community plugins yet',
      );
    },
  };

  const blocks: BlocksFacade = {
    register(descriptor) {
      broker.require('workspace.blocks.register');
      const svc = services.blocks;
      if (!svc) throw new Error('block registry service unavailable');
      const prefix = `${broker.manifest.id}.`;
      if (!descriptor.typeId.startsWith(prefix)) {
        throw new Error(
          `block type "${descriptor.typeId}" must use plugin prefix "${prefix}"`,
        );
      }
      return own(svc.register(descriptor).dispose);
    },
  };

  const toolbar: ToolbarFacade = {
    register(manifest) {
      // Reuse the commands permission: toolbar contributions are
      // declarative command launchers, not new authority. No new SDK
      // permission is introduced, so the frozen permission catalog stays
      // closed. The trusted host re-validates the DTO and owns execution
      // routing through the command broker; community code never receives
      // React, DOM, CSS, handles, or registry objects.
      broker.require('workspace.commands.register');
      const errors = validateCommunityToolbarManifest(manifest);
      if (errors.length > 0) throw new TypeError(errors.join('; '));
      const svc = services.toolbar;
      if (!svc) throw new Error('toolbar service unavailable');
      const handle = svc.registerToolbar(
        broker.manifest.id,
        manifest as CommunityToolbarManifest,
      );
      return own(handle.dispose);
    },
  };

  const documents: DocumentsFacade = {
    registerKind(descriptor) {
      broker.require('documents.registerKind');
      const svc = services.documents;
      if (!svc) throw new Error('document registry service unavailable');
      const prefix = `${broker.manifest.id}.`;
      if (!descriptor.id.startsWith(prefix)) {
        throw new Error(
          `document kind "${descriptor.id}" must use plugin prefix "${prefix}"`,
        );
      }
      if (
        typeof descriptor.decode !== 'function' ||
        typeof descriptor.encode !== 'function'
      ) {
        throw new TypeError(
          'document kind requires decode and encode functions',
        );
      }
      return own(svc.register(descriptor).dispose);
    },
  };

  const properties: PropertiesFacade = {
    registerType(descriptor) {
      broker.require('properties.registerType');
      const svc = services.propertyCatalog;
      if (!svc) throw new Error('property catalog service unavailable');
      const prefix = `${broker.manifest.id}.`;
      if (!descriptor.id.startsWith(prefix)) {
        throw new Error(
          `property type "${descriptor.id}" must use plugin prefix "${prefix}"`,
        );
      }
      if (
        typeof descriptor.label !== 'string' ||
        descriptor.label.length === 0 ||
        !['stored', 'computed'].includes(descriptor.storage) ||
        ![
          'text',
          'number',
          'boolean',
          'date',
          'select',
          'multi-select',
          'relation',
          'none',
        ].includes(descriptor.editor) ||
        typeof descriptor.validate !== 'function'
      ) {
        throw new TypeError('invalid property type descriptor');
      }
      return own(svc.register(descriptor).dispose);
    },
  };

  return {
    vault,
    commands,
    settings,
    uiViews,
    uiSettings,
    editorProvider,
    blocks,
    toolbar,
    documents,
    properties,
  };
}
