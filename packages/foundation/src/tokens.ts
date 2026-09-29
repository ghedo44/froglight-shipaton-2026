/**
 * Stable service tokens for workspace/capability services.
 *
 * A token names a capability; providers bind implementations and consumers
 * depend on the token rather than concrete host/provider packages.
 */

import { createServiceToken } from '@froglight/runtime';
import type { VaultService } from './vault/contract.js';
import type { DocumentRegistry } from './documents.js';
import type { DocumentPresentationRegistry } from './document-presentation.js';
import type { MetadataService } from './metadata.js';
import type { RelationshipService } from './relationships.js';
import type { CommandService } from './commands.js';
import type { SettingsService } from './settings.js';
import type { NavigationService } from './navigation.js';
import type { RevisionService } from './revisions.js';
import type { WorkspaceService } from './workspace.js';
import type { SearchService } from './search/service.js';
import type { DocumentEditorRegistry } from './editors/registry.js';
import type { DocumentReaderRegistry } from './reading/registry.js';
import type { MarkdownEditorProvider } from './editors/provider.js';
import type { DocumentAssetStore } from './assets.js';
import type { HandwritingRecognizer } from './notebooks/recognition.js';
import type { BlockRegistry } from './blocks/registry.js';
import type { SurfaceObjectTypeRegistry } from './surfaces/registry.js';
import type { SurfaceToolRegistry } from './surfaces/tools.js';
import type {
  CompositionRegistry,
  CompositionPresentationRegistry,
} from './composition.js';
import type { PdfExportProvider, PdfProvider } from './pdf/contracts.js';
import type { LaTeXProvider } from './latex/contracts.js';
import type { KeyboardInsetService } from './keyboard-inset/contract.js';
import type { StylusService } from './stylus/contract.js';
import type { PurchaseService } from './purchases/contract.js';
import type { AccountService } from './account/contract.js';
import type { AccountIdentityService } from './account-identity/contract.js';
import type { VaultSyncService } from './sync/contract.js';
import type { ExternalFileDropService } from './file-drop/contract.js';

export const vaultToken = createServiceToken<VaultService>('froglight.vault');
export const compositionPresentationToken =
  createServiceToken<CompositionPresentationRegistry>(
    'froglight.composition-presentation',
  );
export const documentRegistryToken = createServiceToken<DocumentRegistry>(
  'froglight.document-registry',
);
export const documentPresentationToken = createServiceToken<DocumentPresentationRegistry>(
  'froglight.document-presentation',
);
export const metadataToken =
  createServiceToken<MetadataService>('froglight.metadata');
export const relationshipsToken = createServiceToken<RelationshipService>(
  'froglight.relationships',
);
export const commandsToken =
  createServiceToken<CommandService>('froglight.commands');
export const settingsToken =
  createServiceToken<SettingsService>('froglight.settings');
export const navigationToken = createServiceToken<NavigationService>(
  'froglight.navigation',
);
export const revisionsToken = createServiceToken<RevisionService>(
  'froglight.revisions',
);
export const workspaceToken = createServiceToken<WorkspaceService>(
  'froglight.workspace',
);
export const searchToken =
  createServiceToken<SearchService>('froglight.search');

/** Generic editor registry resolved by DocumentKindId. */
export const documentEditorRegistryToken =
  createServiceToken<DocumentEditorRegistry>('froglight.editor-registry');

/** Generic reading-view registry resolved by DocumentKindId. */
export const documentReaderRegistryToken =
  createServiceToken<DocumentReaderRegistry>('froglight.reader-registry');

/**
 * Markdown provider capability used by trusted plugin integrations.
 * The workbench resolves editors through documentEditorRegistryToken.
 */
export const markdownEditorProviderToken =
  createServiceToken<MarkdownEditorProvider>('froglight.editor.markdown');

/** Trusted-tier Block Type registration. */
export const blockRegistryToken = createServiceToken<BlockRegistry>(
  'froglight.block-registry',
);

/** Trusted-tier Surface Object Type registration. */
export const surfaceObjectRegistryToken =
  createServiceToken<SurfaceObjectTypeRegistry>(
    'froglight.surface-object-registry',
  );

/** Trusted-tier surface tool registration. */
export const surfaceToolRegistryToken = createServiceToken<SurfaceToolRegistry>(
  'froglight.surface-tool-registry',
);

/** Document asset ingestion (vault-backed, hash-deduplicated). */
export const documentAssetStoreToken = createServiceToken<DocumentAssetStore>(
  'froglight.document-assets',
);

/** Explicit handwriting recognition (trusted side). */
export const handwritingRecognizerToken =
  createServiceToken<HandwritingRecognizer>(
    'froglight.handwriting-recognition',
  );

/** Provider-neutral cross-document composition registry. */
export const compositionRegistryToken = createServiceToken<CompositionRegistry>(
  'froglight.composition-registry',
);

export const pdfProviderToken = createServiceToken<PdfProvider>(
  'froglight.pdf-provider',
);
export const pdfExportProviderToken = createServiceToken<PdfExportProvider>(
  'froglight.pdf-export-provider',
);

/** Replaceable LaTeX render capability.*/
export const latexProviderToken = createServiceToken<LaTeXProvider>(
  'froglight.latex-provider',
);

/**
 * Overlay keyboard-inset capability. The soft keyboard overlays
 * the full-size WebView; hosts report inset transitions behind this token.
 */
export const keyboardInsetToken = createServiceToken<KeyboardInsetService>(
  'froglight.keyboard-inset',
);

/**
 * Stylus accessory capability. Semantic accessory events only
 * (double-tap, squeeze, eraser, barrel buttons, proximity, capabilities);
 * stroke samples stay in DOM Pointer Events and never cross this token.
 */
export const stylusToken =
  createServiceToken<StylusService>('froglight.stylus');

/**
 * Purchase/entitlement capability. Platform-neutral customer
 * state, offerings, and purchase operations behind `PurchaseService`;
 * RevenueCat is the initial provider and never leaks into shared contracts.
 */
export const purchasesToken = createServiceToken<PurchaseService>(
  'froglight.purchases',
);

/**
 * Account identity capability. Platform-neutral authenticated
 * identity behind `AccountService`; the Firebase UID is the stable opaque
 * account identity and doubles as the RevenueCat App User ID. Firebase
 * stays an implementation provider and never leaks into shared contracts.
 */
export const accountToken =
  createServiceToken<AccountService>('froglight.account');

/**
 * Account ↔ purchase identity binding. Owns the Firebase
 * UID → RevenueCat App User ID binding and the ordered sign-out; resolved
 * by account-bound purchase/sync flows before starting paid work.
 */
export const accountIdentityToken = createServiceToken<AccountIdentityService>(
  'froglight.account-identity',
);

/**
 * Vault sync capability. Froglight-owned
 * reconcile orchestration over the attached local vault plus the
 * provider-neutral remote contract, with UID-scoped remembered bindings
 * for every synced local vault. Firebase implements the
 * remote in the Firebase provider; the local vault stays canonical and
 * authoritative.
 */
export const vaultSyncToken = createServiceToken<VaultSyncService>(
  'froglight.vault-sync',
);

/**
 * Identity of the currently mounted local vault provider. A syncable replica
 * is `(localVaultId, ObservableVaultService)`.
 * — never the physical vault alone: without the host-owned local identity
 * the sync service could only guess which binding belongs to the attached
 * vault. Every vault provider binds this token alongside `vaultToken` so
 * the workspace-lifetime sync attachment can pass both into
 * `VaultSyncService.attach({ localVaultId, vault })` atomically.
 *
 * Transient/bootstrap providers (launcher, tests) bind an ephemeral
 * `ephemeral:<uuid>` identity that can never collide with a persisted
 * vault id; it has no binding, so sync stays parked.
 */
export interface LocalVaultIdentity {
  /** Opaque host vault id; never a path, name, or email. */
  readonly id: string;
}

export const localVaultIdentityToken = createServiceToken<LocalVaultIdentity>(
  'froglight.local-vault-identity',
);

/**
 * Reserved ephemeral identity for transient/bootstrap vaults. Prefixed so
 * it can never be mistaken for (or collide with) a persisted host id.
 */
export function ephemeralLocalVaultId(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } })
    .crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return `ephemeral:${cryptoObj.randomUUID()}`;
  }
  return `ephemeral:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Build the provider identity for a vault plugin. A missing/empty
 * configured id means a transient provider: use the reserved ephemeral
 * namespace instead of inventing a durable identity.
 */
export function localVaultIdentity(
  configuredId?: string | null,
): LocalVaultIdentity {
  return {
    id:
      typeof configuredId === 'string' && configuredId.length > 0
        ? configuredId
        : ephemeralLocalVaultId(),
  };
}

/**
 * External file ingress capability (`froglight.file-drop`). Trusted-tier
 * host infrastructure: native hosts feed opaque file handles through this
 * token where the WebView cannot produce `File` objects (Android). The
 * browser HTML5 path stays primary elsewhere and leaves the token
 * unbound. Community plugins never receive this token.
 */
export const externalFileDropToken =
  createServiceToken<ExternalFileDropService>('froglight.file-drop');
