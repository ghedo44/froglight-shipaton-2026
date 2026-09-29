import { createWorkerPersistence } from '@froglight/provider-opfs/persistence';
import { workerDatabaseQueryPlugin } from '@froglight/index-sqlite/browser';
/** Web host: browser providers + the shared Froglight application shell. */

import {
  createApp,
  withFirstPartyDocumentProviders,
  createWorkbenchController,
  type FroglightApp,
  createLaTeXSourceResolver,
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
import { OpfsDerivedCacheStorage } from '@froglight/provider-opfs';
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
  attachVisualViewportSource,
  defaultToolbarPlacements,
  documentSettingKey,
  installDefaultUi,
  mountFroglightApp,
  uiPrompt,
  uiPdfPageSelection,
  windowControlsOverlayChrome,
  workspaceSettingsToken,
  type InstalledUi,
} from '@froglight/ui';
import { createKeyboardInset } from '@froglight/foundation';
import {
  createUnconfiguredSyncRemote,
  resolveFirebaseConfigFromEnv,
  resolveFirebaseEmulatorHosts,
  type FirebaseEnvValues,
} from '@froglight/provider-firebase/config-env';
import { createLocalStorageSyncStorage } from '@froglight/provider-firebase/sync-storage';
import { createWebVaultAdapter } from './vault-recents.js';
import { createWebStylus } from './stylus.js';

/** Read public Firebase config from the Vite environment. */
function readFirebaseEnv(): FirebaseEnvValues {
  const env =
    (import.meta as unknown as { env?: Record<string, string | undefined> })
      .env ?? {};
  return env as FirebaseEnvValues;
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
  // Memory exists only long enough to bootstrap the dependency graph. It is
  // withdrawn before launcher mode so no workspace is active at app startup.
  // Overlay keyboard insets: the web host has no native inset
  // events, so the shared visualViewport fallback feeds the same capability.
  const keyboard = createKeyboardInset({
    storage:
      typeof localStorage === 'undefined'
        ? null
        : {
            getItem: (key) => localStorage.getItem(key),
            setItem: (key, value) => {
              localStorage.setItem(key, value);
            },
          },
  });
  attachVisualViewportSource({ store: keyboard.store });
  // Stylus accessory state: the PWA has no native plugin, so
  // the web host reports PointerEvent-derived capabilities behind the
  // same token the native shell feeds from froglight-stylus events.
  const pointerCtor = (
    window as unknown as Record<
      string,
      undefined | { prototype?: Record<string, unknown> }
    >
  ).PointerEvent;
  const stylus = createWebStylus(
    typeof window === 'undefined'
      ? null
      : {
          pointerEvent: pointerCtor,
          getCoalescedEvents: pointerCtor?.prototype?.getCoalescedEvents,
          maxTouchPoints: (navigator as Navigator | undefined)?.maxTouchPoints,
        },
  );
  // Froglight account (`froglight.account`) uses Firebase as its provider.
  // Until a Firebase project is provisioned, local PWA use keeps working
  // without an account or network. The identity coordinator stays dormant
  // until a web purchase provider binds `froglight.purchases`, then activates
  // on its own. Missing or incomplete public config keeps the local fallback.
  //
  // Bundle split: the Firebase SDK never enters the critical startup
  // bundle. The config seam above is SDK-free; the full provider (Auth,
  // Firestore, Storage) is dynamic-imported only when a complete config
  // exists, so local-only users never download it and the PWA offline
  // shell stays lean.
  const firebaseEnv = readFirebaseEnv();
  const firebaseConfig = resolveFirebaseConfigFromEnv(firebaseEnv);
  // The workspace lookup closes over the app handle assigned below, so
  // vault replacement can never leave a stale workspace behind.
  const getWorkspace = () => appRef?.getWorkspace() ?? null;
  const account =
    firebaseConfig === null
      ? createAccountHost({ transport: unconfiguredAccountTransport })
      : createAccountHost({
          transport: (
            await import('@froglight/provider-firebase')
          ).createFirebaseAccountTransport({ config: firebaseConfig }),
        });
  // Ordered sign-out: stop cloud scheduling before the
  // coordinator clears the purchase identity and Firebase signs out.
  // VaultSyncService plugs in here; local vaults are never touched.
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
          purchases: null,
          getWorkspace,
          emulators: resolveFirebaseEmulatorHosts(firebaseEnv),
        });
  const identity = createAccountIdentityHost({
    onBeforeSignOut: async () => {
      await sync.service.prepareForSignOut();
    },
  });
  // Host-owned derived-cache storage (final scalability pass, item 4):
  // disposable compiled geometry under OPFS. Canonical vault bytes stay
  // authoritative; losing this cache only costs a recompile.
  const derivedCacheStorage = new OpfsDerivedCacheStorage();
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

  // Community plugins are scoped to an open vault via the binding slot:
  // attach on vault activation, zero registrations on close.
  const community = new CommunityPluginManager({ runtime: app.runtime });
  await app.runtime.registerSlot({
    id: 'community-plugins',
    plugin: communityPluginsBinding(community),
  });

  // Persisted Firebase session recovery: best-effort so an
  // unconfigured backend or a transient failure leaves the store signed out
  // without breaking boot. Sync metadata restores afterwards so restarts
  // reconstruct pending work by reconciliation.
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
    capabilities: { iframePdf: true },
  });
  uiRef = ui;
  await app.closeVault();
  const vaultAdapter = createWebVaultAdapter(controller, { includeDemo: true });

  const root = document.getElementById('app');
  if (root === null) throw new Error('missing #app root');
  const mount = await mountFroglightApp(root, controller, vaultAdapter, ui, {
    // Installed PWAs running with the window-controls-overlay display get the
    // reclaimed titlebar strip; `null` falls back to the plain browser header.
    windowChrome: windowControlsOverlayChrome(),
  });
  const disposeMount = mount.dispose.bind(mount);
  mount.dispose = async () => {
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
