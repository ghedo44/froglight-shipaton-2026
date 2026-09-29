/**
 * @froglight/sdk — public plugin capabilities.
 *
 * Exposes only the intentionally small, versioned capability facades.
 * Raw Tauri/Rust/runtime internals are not re-exported.
 * SDK version is independent from manifestVersion and packageFormat.
 */

export const SDK_VERSION = '0.1.0' as const;
export const MANIFEST_VERSION = 1 as const;
export const PACKAGE_FORMAT = 1 as const;

// Re-export allowed capability tokens.
// Internal runtime tokens (FiberHandle, EffectScope, etc.) are not exported.
export {
  vaultToken,
  workspaceToken,
  documentRegistryToken,
  metadataToken,
  relationshipsToken,
  commandsToken,
  settingsToken,
  navigationToken,
  revisionsToken,
  searchToken,
} from '@froglight/foundation';

export type {
  VaultService,
  VaultCapabilities,
  VaultEntry,
  WorkspacePath,
  ResourceId,
  DocumentId,
  DocumentKindId,
  DocumentLocation,
  DocumentRef,
  DocumentRegistry,
  DocumentKindDescriptor,
  PropertyTypeDescriptor,
  PropertyValue,
  ResourcePropertyDefinition,
  NormalizedMetadata,
  Relationship,
  CommandService,
  SettingsService,
  NavigationService,
  RevisionService,
  WorkspaceService,
  SearchService,
} from '@froglight/foundation';

// Permission catalog — a closed coarse list extended by block and surface
// capabilities.
export const ALL_PERMISSIONS = [
  'vault.read',
  'vault.write',
  'vault.watch',
  'workspace.commands.register',
  'workspace.settings.read',
  'workspace.settings.write',
  'documents.registerKind',
  'documents.read',
  'search.query',
  'relationships.read',
  'ui.views.register',
  'editor.provider',
  'workspace.blocks.register',
  'workspace.surfaces.register',
  'properties.registerType',
] as const;

export type Permission = (typeof ALL_PERMISSIONS)[number];

export const TRUSTED_ONLY_PERMISSIONS: readonly Permission[] = [
  'ui.views.register',
  'editor.provider',
  'workspace.blocks.register',
  'workspace.surfaces.register',
  'documents.registerKind',
  'properties.registerType',
] as const;

export type TrustTier = 'trusted' | 'sandboxed';

// SDK-level errors — broker checks surface these, not generic messages.
export class PermissionDeniedError extends Error {
  readonly permission: string;
  readonly tier: TrustTier;
  constructor(permission: string, tier: TrustTier) {
    super(`PermissionDenied: "${permission}" not granted for ${tier} tier`);
    this.name = 'PermissionDeniedError';
    this.permission = permission;
    this.tier = tier;
  }
}

export class ManifestValidationError extends Error {
  readonly issues: readonly string[];
  constructor(message: string, issues: readonly string[]) {
    super(message);
    this.name = 'ManifestValidationError';
    this.issues = issues;
  }
}
