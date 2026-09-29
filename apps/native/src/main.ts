import { createWorkerPersistence } from '@froglight/provider-opfs/persistence';
import { workerDatabaseQueryPlugin } from '@froglight/index-sqlite/browser';
/** Native host: Tauri shell over the shared Froglight application. */

import {
  createApp,
  withFirstPartyDocumentProviders,
  createLaTeXSourceResolver,
  createWorkbenchController,
  type FroglightApp,
} from '@froglight/application';
import {
  InMemorySearchService,
  PersistentSettingsService,
  VaultSyncStore,
  WorkspaceDirtyTracker,
  WorkspaceSyncReconciler,
  createAccountHost,
  createAccountIdentityHost,
  createVaultSyncHost,
  unconfiguredAccountTransport,
  memoryVaultPlugin,
  type DocumentSession,
  type SurfaceModel,
} from '@froglight/foundation';
import { WhiteboardDocumentEditorProvider } from '@froglight/editor-whiteboard';
import {
  CommunityPluginManager,
  communityPluginsBinding,
} from '@froglight/plugin-platform';
import {
  MarkdownDocumentEditorProvider,
  LatexDocumentEditorProvider,
  LatexDocumentReaderProvider,
} from '@froglight/editor-codemirror';
import { BlockPageDocumentEditorProvider } from '@froglight/editor-blockpage';
import {
  InkDocumentEditorProvider,
  renderInkPreviewImage,
} from '@froglight/editor-ink';
import {
  NotebookDocumentEditorProvider,
  renderNotebookPreviewImages,
} from '@froglight/editor-notebook';
import { TauriDerivedCacheStorage } from './derived-cache-storage.js';
import {
  PdfDocumentEditorProvider,
  PdfJsProvider,
  renderPdfPreviewImage,
} from '@froglight/provider-pdfjs';
import { PdfLibExportProvider } from '@froglight/provider-pdf-lib';
import { LatexJsProvider } from '@froglight/provider-latexjs';
import {
  MarkdownReaderProvider,
  resolveMarkdownEmbed,
  fileExplorerToken,
  defaultToolbarPlacements,
  documentSettingKey,
  installDefaultUi,
  mountFroglightApp,
  uiPdfPageSelection,
  uiPrompt,
  workspaceSettingsToken,
  type InstalledUi,
} from '@froglight/ui';
import { createNativeVaultAdapter } from './tauri-vault.js';
import {
  createNativeKeyboardInset,
  installNativeKeyboardEventForwarder,
} from './keyboard-inset.js';
import { attachNativeKeyboardGuards } from './keyboard-guards.js';
import {
  createNativeStylus,
  installNativeStylusEventForwarder,
  seedStylusCapabilitiesFromNative,
} from './stylus.js';
import {
  createNativeFileDrop,
  installNativeFileDropEventForwarder,
} from './file-drop.js';
import { createNativePurchases, seedPurchasesFromNative } from './purchases.js';
import {
  createUnconfiguredSyncRemote,
  resolveFirebaseConfigFromEnv,
  resolveFirebaseEmulatorHosts,
  type FirebaseEnvValues,
} from '@froglight/provider-firebase/config-env';
import { createLocalStorageSyncStorage } from '@froglight/provider-firebase/sync-storage';
import { nativeWindowChrome } from './window-chrome.js';
import { invoke } from '@tauri-apps/api/core';

/** Read public Firebase config from the Vite/Tauri environment. */
function readFirebaseEnv(): FirebaseEnvValues {
  const env =
    (import.meta as unknown as { env?: Record<string, string | undefined> })
      .env ?? {};
  return env as FirebaseEnvValues;
}

/**
 * Read the public RevenueCat SDK key from the Vite environment.
 *
 * Canonical source: `VITE_FROGLIGHT_REVENUECAT_PUBLIC_KEY` in
 * `apps/native/.env` (`test_...` for the Test Store, `appl_...` in
 * production). Public by RevenueCat's model — never a secret key. Vite is
 * the authority here: Rust never reads `.env` directly. Absent or blank
 * values stay `undefined` so the purchases backend keeps its unconfigured
 * best-effort behavior.
 */
function readRevenueCatPublicKey(): string | undefined {
  const env =
    (import.meta as unknown as { env?: Record<string, string | undefined> })
      .env ?? {};
  const raw = env['VITE_FROGLIGHT_REVENUECAT_PUBLIC_KEY'];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

async function bootstrap(): Promise<void> {
  const pdfProvider = new PdfJsProvider();
  const latexProvider = new LatexJsProvider();
  let uiRef: InstalledUi | null = null;
  const latexDeps = {
    latexProvider: () =>
      appRef === null ? latexProvider : appRef.getLatexProvider(),
    createResolver: (documentPath: string) => {
      const vault = appRef?.getVault();
      if (vault === null || vault === undefined) return null;
      return createLaTeXSourceResolver({
        vault,
        documentPath,
        createAssetUrl: (bytes: Uint8Array, mimeType: string) => {
          try {
            return URL.createObjectURL(
              new Blob([bytes as BlobPart], { type: mimeType }),
            );
          } catch {
            return null;
          }
        },
      });
    },
    resolveDocumentPath: (session: DocumentSession) => {
      const workspace = appRef?.getWorkspace();
      if (workspace === null || workspace === undefined) return null;
      try {
        return workspace.resolveResourcePath(
          session.document.location.resourceId,
        );
      } catch {
        return null;
      }
    },
  };
  const latexEditor = new LatexDocumentEditorProvider(latexDeps);
  const latexReader = new LatexDocumentReaderProvider(latexDeps);
  const markdownReader = new MarkdownReaderProvider({
    resolveEmbed: (session, destination) => resolveMarkdownEmbed({
      workspace: () => appRef?.getWorkspace() ?? null,
      vault: () => appRef?.getVault() ?? null,
      renderInk: (model) => renderInkPreviewImage(model, { assets: appRef?.getDocumentAssetStore() ?? null }),
    }, session, destination),
    onEmbedChange: (listener) => appRef?.getWorkspace()?.onDidCommit(() => listener()) ?? { dispose: () => undefined },
    loadScroll: (documentId: string) =>
      uiRef?.services
        .try(workspaceSettingsToken)
        ?.get<number>(documentSettingKey(documentId, 'scroll'), -1) ?? -1,
    saveScroll: (documentId: string, top: number) => {
      uiRef?.services
        .try(workspaceSettingsToken)
        ?.set(documentSettingKey(documentId, 'scroll'), top);
    },
  });
  let appRef: FroglightApp | null = null;
  let controllerRef: ReturnType<typeof createWorkbenchController> | null = null;
  const openExternalLink = (url: string): void => {
    window.open(url, '_blank', 'noopener,noreferrer');
  };
  const promptForPdfPassword = (reason: 'required' | 'incorrect') =>
    uiPrompt(
      reason === 'incorrect'
        ? 'That password did not unlock the PDF'
        : 'Unlock PDF',
      {
        description:
          'The password is kept in memory for this session and is not saved.',
        placeholder: 'PDF password',
        confirmLabel: 'Unlock',
        inputType: 'password',
      },
    );
  const pdfReader = new PdfDocumentEditorProvider({
    pdfProvider: () => appRef?.getPdfProvider() ?? pdfProvider,
    promptForPassword: promptForPdfPassword,
    openExternalLink,
    importAsNotebook: async (bytes: Uint8Array) => {
      const controller = controllerRef;
      if (controller === null) return;
      await controller.importPdfAsNotebook({ name: 'Imported PDF.pdf', bytes });
    },
  });
  // Bootstrap only. A persistent native vault must eventually be selected via
  // the Rust-mediated provider; the WebView never receives Node filesystem authority.
  // Overlay keyboard insets: host-owned store + direct-eval
  // forwarder, bound as a capability so the shell lays out against it.
  const keyboard = createNativeKeyboardInset();
  installNativeKeyboardEventForwarder(keyboard.store);
  // Stylus accessory events: host-owned service + direct-eval
  // forwarder, bound as a capability. Stroke samples stay in PointerEvent.
  // Bootstrap ordering: create service → install forwarder → activate
  // plugin → query get_capabilities() → seed service → receive actions.
  const stylus = createNativeStylus((command, payload) => invoke(command, payload));
  installNativeStylusEventForwarder(stylus.service);
  // External file ingress (froglight.file-drop): host-owned service +
  // direct-eval forwarder, bound as a capability. The browser HTML5 path
  // stays primary on desktop; the native backend feeds the same UI on
  // Android where WebView drops are unreliable. Tokens stay host-owned.
  const fileDrop = createNativeFileDrop();
  installNativeFileDropEventForwarder(fileDrop.service);
  // Purchases/entitlements (froglight.purchases): host-owned
  // service over the Tauri plugin transport (RevenueCat on iOS,
  // unsupported elsewhere). Bootstrap ordering: create service →
  // subscribe to customer-info events → configure RevenueCat (public SDK
  // key from `VITE_FROGLIGHT_REVENUECAT_PUBLIC_KEY`) → refresh()
  // (get_customer_info) → receive delegate updates.
  const purchases = createNativePurchases();
  // Froglight account (`froglight.account`) uses Firebase as the initial
  // provider behind the platform-neutral transport. Without a project, the
  // store reports NOT_CONFIGURED while local Froglight keeps working.
  // Missing or incomplete public config keeps the local-only fallback.
  // Account ↔ purchase identity (`froglight.account-identity`) binds the
  // Firebase UID as RevenueCat App User ID and owns ordered sign-out:
  // suspend sync, clear identity, then sign out of Firebase.
  // Slot order: account → purchases → identity → sync.
  //
  // Bundle split (shared with the PWA host): the Firebase SDK is
  // dynamic-imported only when a complete config exists, so local-only
  // users never load it.
  const firebaseEnv = readFirebaseEnv();
  const firebaseConfig = resolveFirebaseConfigFromEnv(firebaseEnv);
  const getWorkspace = () => appRef?.getWorkspace() ?? null;
  const account =
    firebaseConfig === null
      ? createAccountHost({ transport: unconfiguredAccountTransport })
      : createAccountHost({
          transport: (
            await import('@froglight/provider-firebase')
          ).createFirebaseAccountTransport({ config: firebaseConfig }),
        });
  // Vault sync (froglight.vault-sync): the Firebase
  // SyncRemote behind the Froglight-owned reconcile engine, with the
  // session-backed dirty tracker and the client purchase state for UI
  // gating only (never backend authorization). Always
  // registered — unconfigured projects park as local-only with honest UI.
  const sync =
    firebaseConfig === null
      ? (() => {
          const remote = createUnconfiguredSyncRemote();
          const service = new VaultSyncStore({
            remote,
            account: account.service,
            storage: createLocalStorageSyncStorage(),
            tracker: new WorkspaceDirtyTracker({ getWorkspace }),
            reconciler: new WorkspaceSyncReconciler({ getWorkspace }),
            purchases: purchases.service,
          });
          return {
            remote,
            service,
            host: createVaultSyncHost({ service }),
            config: null,
          };
        })()
      : (await import('@froglight/provider-firebase')).createFirebaseSyncHost({
          config: firebaseConfig,
          account: account.service,
          purchases: purchases.service,
          getWorkspace,
          emulators: resolveFirebaseEmulatorHosts(firebaseEnv),
        });
  const identity = createAccountIdentityHost({
    onBeforeSignOut: async () => {
      await sync.service.prepareForSignOut();
    },
  });
  // Host-owned derived-cache storage (final scalability pass, item 4):
  // disposable compiled geometry under the application cache directory.
  // Canonical vault bytes stay authoritative; losing this cache only
  // costs a recompile.
  const derivedCacheStorage = new TauriDerivedCacheStorage();
  const persistence = createWorkerPersistence();
  const disposePersistenceOnExit = (event: PageTransitionEvent) => { if (!event.persisted) persistence.dispose(); };
  window.addEventListener('pagehide', disposePersistenceOnExit);
  const app = await createApp({
    workspaceConfig: { persistenceFactory: persistence.factory },
    vaultPlugin: memoryVaultPlugin,
    vaultConfig: {},
    searchService: new InMemorySearchService(),
    settingsService: new PersistentSettingsService({
      storage: typeof localStorage === 'undefined' ? null : localStorage,
    }),
    databaseQueryProviderPlugin: workerDatabaseQueryPlugin,
    extraPlugins: [
      keyboard.definition,
      stylus.definition,
      fileDrop.definition,
      purchases.definition,
      account.definition,
      identity.definition,
      // Sync lifetime split: host-lifetime service (survives launcher)
      // plus workspace-lifetime attachment (follows the active vault).
      sync.host.definition,
      sync.host.attachment,
      createDatabaseEditorPlugin((id, disposition) => {
        const ref = appRef
          ?.getWorkspace()
          ?.listDocuments()
          .find((item) => item.location.resourceId === id);
        if (!ref || !controllerRef) return;
        if (disposition === 'beside' && window.innerWidth >= 960) {
          const target = controllerRef.resourceTargetFor(
            String(ref.documentId),
          );
          if (target)
            void controllerRef.openResourceTarget(target, {
              openBeside: true,
              preserveFocus: true,
            });
          return;
        }
        void controllerRef.openDocument(ref.documentId);
      }, async (documentId, toPath) => {
        if (!controllerRef) throw new Error('Workbench unavailable');
        await controllerRef.moveDocumentTo(documentId, toPath);
      }),
    ],
    compositionPresenters: [
      createDatabaseCompositionPresenter(),
      createMarkdownCompositionPresenter(),
    ],
    documentFeatures: withFirstPartyDocumentProviders({
      markdown: new MarkdownDocumentEditorProvider({
        importImage: async (name, bytes) => {
          const importFile = uiRef?.services.try(fileExplorerToken)?.importFileWithPath;
          if (!importFile) throw new Error('File import is unavailable');
          return importFile('', name, bytes);
        },
      }),
      blockPage: new BlockPageDocumentEditorProvider(),
      ink: new InkDocumentEditorProvider({ derivedCacheStorage }),
      notebook: new NotebookDocumentEditorProvider({
        openExternalLink,
        selectPdfPages: uiPdfPageSelection,
        promptForPdfPassword,
        derivedCacheStorage,
      }),
      pdf: pdfReader,
      whiteboard: new WhiteboardDocumentEditorProvider({ derivedCacheStorage }),
      latex: latexEditor,
      markdownReader,
      latexReader,
    }),
    pdfProvider,
    latexProvider,
    pdfExportProvider: new PdfLibExportProvider(),
    inkPreviewRenderer: (model: SurfaceModel) =>
      renderInkPreviewImage(model, {
        assets: appRef?.getDocumentAssetStore() ?? null,
      }),
    notebookPreviewRenderer: (model) =>
      renderNotebookPreviewImages(model, {
        assets: appRef?.getDocumentAssetStore() ?? null,
        pdfProvider,
      }),
    pdfPreviewRenderer: (bytes: Uint8Array, pageIndex: number) =>
      renderPdfPreviewImage(pdfProvider, bytes, pageIndex),
  });
  appRef = app;

  const community = new CommunityPluginManager({ runtime: app.runtime });
  await app.runtime.registerSlot({
    id: 'community-plugins',
    plugin: communityPluginsBinding(community),
  });

  // The native plugin may have emitted capabilities during load, before the
  // JS forwarder existed. Query state after activation so the report cannot
  // be lost; direct-eval continues to deliver accessory actions after this.
  try {
    await seedStylusCapabilitiesFromNative(stylus.service, (command) =>
      invoke(command),
    );
  } catch {
    // Seeding is best-effort: drawing works from PointerEvents alone.
  }

  // Purchase state may have refreshed during load, before the event
  // listener existed. Subscribe first, then configure RevenueCat from the
  // Vite env and seed through get_customer_info so the report cannot be
  // lost; delegate updates continue after this.
  // Best-effort: an unconfigured backend (no
  // `VITE_FROGLIGHT_REVENUECAT_PUBLIC_KEY` in `apps/native/.env`) leaves
  // the store unready without breaking boot.
  try {
    await seedPurchasesFromNative(purchases.service, {
      apiKey: readRevenueCatPublicKey(),
    });
  } catch {
    // Unreachable: seedPurchasesFromNative already swallows seed failures.
  }

  // Persisted Firebase session recovery: best-effort so an
  // unconfigured backend or a transient failure leaves the store signed out
  // without breaking boot. The identity coordinator binds a recovered
  // session to RevenueCat once both fibers are active. Sync metadata
  // restores afterwards so restarts reconstruct pending work.
  try {
    await account.service.restore();
  } catch {
    // Seeding is best-effort: local vaults work signed-out.
  }
  try {
    await sync.service.restore();
  } catch {
    // Sync metadata is rebuildable: a missed restore degrades to a fresh
    // disabled service and the next enable rebuilds from a full scan.
  }

  const controller = createWorkbenchController(app);
  controllerRef = controller;
  const ui = await installDefaultUi(app.runtime, {
    community: () => (community.attached ? community : null),
    toolbarPlacements: defaultToolbarPlacements(),
    capabilities: { iframePdf: false },
  });
  uiRef = ui;
  await app.closeVault();
  const vaultAdapter = createNativeVaultAdapter(controller, undefined, {
    includeDemo: true,
  });

  const root = document.getElementById('app');
  if (root === null) throw new Error('missing #app root');
  // Native keyboard guards: cached native state recovery plus the
  // narrow iOS WebKit visual-pan compensation. Keyboard height itself stays
  // single-source in the native plugin; disposed with the app mount.
  const detachKeyboardGuards = attachNativeKeyboardGuards({
    store: keyboard.store,
  });
  const mount = await mountFroglightApp(root, controller, vaultAdapter, ui, {
    windowChrome: nativeWindowChrome(),
  });
  const disposeMount = mount.dispose.bind(mount);
  mount.dispose = async () => {
    detachKeyboardGuards();
    await disposeMount();
    window.removeEventListener('pagehide', disposePersistenceOnExit);
    persistence.dispose();
  };
}

void bootstrap().catch((error: unknown) => {
  const root = document.getElementById('app');
  if (root !== null) root.textContent = String(error);
  console.error(error);
});
import {
  createDatabaseEditorPlugin,
  createDatabaseCompositionPresenter,
  createMarkdownCompositionPresenter,
} from '@froglight/ui/react';
