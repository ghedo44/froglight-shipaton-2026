/** Shared Froglight application composition. Hosts select capabilities/providers only. */

import {
  Runtime,
  createServiceProbe,
  definePlugin,
  type PluginDefinition,
} from '@froglight/runtime';
import {
  InMemoryDocumentEditorRegistry,
  InMemoryDocumentReaderRegistry,
  commandsToken,
  documentEditorRegistryToken,
  documentReaderRegistryToken,
  vaultToken,
  workspacePlugin,
  workspaceToken,
  documentRegistryToken,
  documentPresentationToken,
  InMemoryDocumentPresentationRegistry,
  navigationToken,
  searchToken,
  markdownEditorProviderToken,
  markdownKind,
  documentAssetStoreToken,
  handwritingRecognizerToken,
  settingsToken,
  stylusToken,
  compositionRegistryToken,
  pdfProviderToken,
  pdfExportProviderToken,
  latexProviderToken,
  latexKindId,
  blockRegistryToken,
  InMemoryCompositionRegistry,
  InMemoryCompositionPresentationRegistry,
  compositionPresentationToken,
  InMemoryBlockRegistry,
  InMemorySettingsService,
  type BlockPageEditorProvider,
  type CommandService,
  type DocumentEditorProvider,
  type DocumentEditorRegistry,
  type DocumentReaderProvider,
  type DocumentReaderRegistry,
  type DocumentKindDescriptor,
  type DocumentKindId,
  type DocumentAssetStore,
  type HandwritingRecognizer,
  type BlockRegistry,
  type CompositionProviderRegistration,
  type CompositionImage,
  type CompositionRegistry,
  type CompositionPresenter,
  type MarkdownEditorProvider,
  type NavigationService,
  type NotebookEditorProvider,
  type NotebookModel,
  type PdfProvider,
  type PdfExportProvider,
  type LaTeXProvider,
  type SearchService,
  type SettingsService,
  withObservableVault,
  type ResourceResolver,
  type VaultService,
  type ResourceTarget,
  type SurfaceModel,
  type WorkspacePluginConfig,
  type WorkspaceService,
  searchMarkdownImageFiles,
} from '@froglight/foundation';
import {
  dockLayoutPlugin,
  dockLayoutToken,
  type DockLayoutStore,
} from './dock-layout.js';
import { workspaceAssetsPlugin } from './asset-store.js';
import { createFirstPartyCompositionProviders } from './composition-providers.js';
import {
  asBlockDocumentEditorProvider,
  asMarkdownDocumentEditorProvider,
  asNotebookDocumentEditorProvider,
  withApplicationEditorCapabilities,
} from './editor-adapters.js';
import { createWorkspaceResourceResolver } from './resource-resolver.js';
import { replaceSlots } from './replace-slot.js';
import { installDocumentFeature, type DocumentFeature } from './document-features.js';
import { InMemoryOutlineRegistry, outlineRegistryToken } from './outline/registry.js';

export {
  defineDocumentFeature,
  firstPartyDocumentFeatures,
  withFirstPartyDocumentProviders,
  installDocumentFeature,
  type DocumentFeature,
} from './document-features.js';

export {
  importPdfAsNotebook,
  insertPdfIntoNotebook,
  mapPdfLinkToNotebook,
  projectPdfSourceText,
  indexStandalonePdfSource,
  indexPdfBackedNotebookSource,
  type ImportedPdfOutlineEntry,
  type PdfNotebookImportResult,
  type PdfImportOptions,
  type MappedPdfLink,
  type PdfSourceTextProjection,
} from './pdf-import.js';

export {
  createLaTeXSourceResolver,
  type CreateLaTeXSourceResolverInput,
} from './latex-resolver.js';

type ProfileDocumentKind = DocumentKindDescriptor<any>;

export interface AppOptions<
  C extends Readonly<Record<string, unknown>> = Readonly<
    Record<string, unknown>
  >,
> {
  readonly vaultPlugin: PluginDefinition<C>;
  readonly vaultConfig?: C;
  readonly searchService?: SearchService;
  readonly workspaceConfig?: WorkspacePluginConfig;
  /** Document kinds included in the profile. Defaults to Markdown only. */
  readonly documentKinds?: readonly ProfileDocumentKind[];
  /** One declaration per kind; each capability still gets its own runtime slot. */
  readonly documentFeatures?: readonly DocumentFeature[];
  /** Generic editors resolved by DocumentKindId. */
  readonly documentEditorProviders?: readonly DocumentEditorProvider[];
  /**
   * Reading-view providers resolved by DocumentKindId. Kinds without a
   * reader use their editor's read-only surface in `reading` mode.
   */
  readonly documentReaderProviders?: readonly DocumentReaderProvider[];
  /** Convenience Markdown adapter; registered into the generic editor registry. */
  readonly markdownEditorProvider?: MarkdownEditorProvider;
  /** Convenience block-page adapter; registered into the generic editor registry. */
  readonly blockPageEditorProvider?: BlockPageEditorProvider;
  /**
   * Convenience notebook adapter; registered into the generic editor
   * registry and the typed `froglight.editor.notebook` seam.
   */
  readonly notebookEditorProvider?: NotebookEditorProvider;
  readonly pdfProvider?: PdfProvider;
  readonly pdfExportProvider?: PdfExportProvider;
  /**
   * Replaceable LaTeX render capability. Absent
   * means LaTeX previews degrade to recoverable placeholders.
   */
  readonly latexProvider?: LaTeXProvider;
  /**
   * Explicit handwriting recognizer. Absent means the
   * recognition action is unavailable; nothing runs implicitly.
   */
  readonly handwritingRecognizer?: HandwritingRecognizer;
  readonly compositionPresenters?: readonly CompositionPresenter[];
  readonly compositionProviders?: readonly CompositionProviderRegistration[];
  /** Optional host-capable raster adapter for derived Ink composition previews. */
  readonly inkPreviewRenderer?: (
    model: SurfaceModel,
  ) => Promise<CompositionImage | undefined> | CompositionImage | undefined;
  readonly notebookPreviewRenderer?: (
    model: NotebookModel,
  ) => Promise<readonly CompositionImage[]> | readonly CompositionImage[];
  readonly pdfPreviewRenderer?: (
    bytes: Uint8Array,
    pageIndex: number,
  ) => Promise<CompositionImage | undefined> | CompositionImage | undefined;
  /** Additional discovery data, including provider-owned linked-view choices. */
  readonly resourceResolver?: ResourceResolver;
  /** App-wide preferences, shared by every vault and available on the launcher. */
  readonly settingsService?: SettingsService;
  /** Additional plugins registered after the built-in composition (tests, profiles). */
  readonly extraPlugins?: readonly PluginDefinition[];
  /** Profile-selected database evaluator/index provider. */
  readonly databaseQueryProviderPlugin?: PluginDefinition;
}

export interface FroglightApp {
  readonly runtime: Runtime;
  getWorkspace(): WorkspaceService | null;
  getResourceProperties(): ResourcePropertyService | null;
  getDatabaseQuery(): DatabaseQueryProvider | null;
  /** The active vault provider service (trusted surfaces read raw resources through it). */
  getVault(): VaultService | null;
  getSearch(): SearchService | null;
  getNavigation(): NavigationService | null;
  getCommands(): CommandService | null;
  getDockLayout(): DockLayoutStore | null;
  getDocumentEditor(kindId: DocumentKindId): DocumentEditorProvider | null;
  onDocumentEditorProviderChange(
    listener: (kindIds: readonly DocumentKindId[]) => void,
  ): { dispose(): void };
  getDocumentKind(kindId: DocumentKindId): DocumentKindDescriptor | null;
  getOutlineRegistry(): InMemoryOutlineRegistry;
  /** Trusted composition signal: remount projections when their capabilities change. */
  onDocumentPresentationCapabilityChange?(
    listener: (kindIds: readonly DocumentKindId[]) => void,
  ): { dispose(): void };
  onDocumentReaderProviderChange(
    listener: (kindIds: readonly DocumentKindId[]) => void,
  ): { dispose(): void };
  getDocumentReader(kindId: DocumentKindId): DocumentReaderProvider | null;
  /** Explicit handwriting recognizer when the profile binds one. */
  getHandwritingRecognizer(): HandwritingRecognizer | null;
  getCompositionRegistry(): CompositionRegistry;
  getDocumentAssetStore(): DocumentAssetStore | null;
  getPdfProvider(): PdfProvider | null;
  getPdfExportProvider(): PdfExportProvider | null;
  getLatexProvider(): LaTeXProvider | null;
  replaceLatexProvider(provider: LaTeXProvider | null): Promise<void>;
  replaceVault<C extends Readonly<Record<string, unknown>>>(
    plugin: PluginDefinition<C>,
    config?: C,
  ): Promise<void>;
  /** Withdraw the active vault and every workspace capability depending on it. */
  closeVault(): Promise<void>;
  replaceMarkdownEditorProvider(
    provider: MarkdownEditorProvider | null,
  ): Promise<void>;
  replaceNotebookEditorProvider(
    provider: NotebookEditorProvider | null,
  ): Promise<void>;
  replacePdfProvider(provider: PdfProvider | null): Promise<void>;
  /** Reconcile open notebook consumers after the provider binding changes. */
  onNotebookEditorProviderChange?(listener: () => void | Promise<void>): {
    dispose(): void;
  };
  dispose(): Promise<void>;
}

function documentKindsPlugin(
  kinds: readonly ProfileDocumentKind[],
): PluginDefinition {
  return definePlugin({
    id: 'froglight.document-kinds.profile',
    requirements: { requires: [documentRegistryToken] },
    activate: (ctx) => {
      const registry = ctx.require(documentRegistryToken);
      for (const kind of kinds) {
        ctx.effect(() => registry.register(kind).dispose);
      }
    },
  });
}

function searchBindingPlugin(service: SearchService): PluginDefinition {
  return definePlugin({
    id: 'froglight.search.binding',
    activate: (ctx) => {
      ctx.provide(searchToken, service);
    },
  });
}

function editorRegistryPlugin(
  registry: DocumentEditorRegistry,
): PluginDefinition {
  return definePlugin({
    id: 'froglight.editor-registry.binding',
    activate: (ctx) => {
      ctx.provide(documentEditorRegistryToken, registry);
    },
  });
}

function documentEditorBindingPlugin(
  provider: DocumentEditorProvider,
): PluginDefinition {
  return definePlugin({
    id: `froglight.document-editor.${provider.id}`,
    requirements: { requires: [documentEditorRegistryToken] },
    activate: (ctx) => {
      const registry = ctx.require(documentEditorRegistryToken);
      ctx.effect(() => registry.register(provider).dispose);
    },
  });
}

function documentReaderBindingPlugin(
  provider: DocumentReaderProvider,
): PluginDefinition {
  return definePlugin({
    id: `froglight.document-reader.${provider.id}`,
    requirements: { requires: [documentReaderRegistryToken] },
    activate: (ctx) => {
      const registry = ctx.require(documentReaderRegistryToken);
      ctx.effect(() => registry.register(provider).dispose);
    },
  });
}

function readerRegistryPlugin(
  registry: DocumentReaderRegistry,
): PluginDefinition {
  return definePlugin({
    id: 'froglight.reader-registry.binding',
    activate: (ctx) => {
      ctx.provide(documentReaderRegistryToken, registry);
    },
  });
}

function markdownProviderBindingPlugin(
  provider: MarkdownEditorProvider,
): PluginDefinition {
  return definePlugin({
    id: 'froglight.editor.markdown.binding',
    activate: (ctx) => {
      ctx.provide(markdownEditorProviderToken, provider);
    },
  });
}

function pdfProviderBindingPlugin(provider: PdfProvider): PluginDefinition {
  return definePlugin({
    id: 'froglight.pdf-provider.binding',
    activate: (ctx) => {
      ctx.provide(pdfProviderToken, provider);
    },
  });
}

function pdfExportProviderBindingPlugin(
  provider: PdfExportProvider,
): PluginDefinition {
  return definePlugin({
    id: 'froglight.pdf-export-provider.binding',
    activate: (ctx) => {
      ctx.provide(pdfExportProviderToken, provider);
    },
  });
}

function latexProviderBindingPlugin(provider: LaTeXProvider): PluginDefinition {
  return definePlugin({
    id: 'froglight.latex-provider.binding',
    activate: (ctx) => {
      ctx.provide(latexProviderToken, provider);
    },
  });
}

function handwritingRecognizerBindingPlugin(
  provider: HandwritingRecognizer,
): PluginDefinition {
  return definePlugin({
    id: 'froglight.handwriting-recognition.binding',
    activate: (ctx) => {
      ctx.provide(handwritingRecognizerToken, provider);
    },
  });
}

export async function createApp<
  C extends Readonly<Record<string, unknown>> = Readonly<
    Record<string, unknown>
  >,
>(options: AppOptions<C>): Promise<FroglightApp> {
  const runtime = new Runtime();
  const appSettings = options.settingsService ?? new InMemorySettingsService();
  await runtime.registerSlot({
    id: 'app-settings',
    plugin: definePlugin({
      id: 'froglight.app-settings',
      activate: (ctx) => {
        ctx.provide(settingsToken, appSettings);
      },
    }),
  });
  const editorRegistry = new InMemoryDocumentEditorRegistry();
  const readerRegistry = new InMemoryDocumentReaderRegistry();
  const outlineRegistry = new InMemoryOutlineRegistry();
  const compositionRegistry = new InMemoryCompositionRegistry();
  const compositionPresentations =
    new InMemoryCompositionPresentationRegistry();
  const blockRegistry = new InMemoryBlockRegistry();

  // Instance-owned probes sharing one capture/clear lifecycle. No mutable
  // provider capture remains at module scope.
  const resourcePropertiesProbe = createServiceProbe({
    pluginId: 'froglight.app.resource-properties-probe',
    token: resourcePropertiesToken,
  });
  const databaseQueryProbe = createServiceProbe({
    pluginId: 'froglight.app.database-query-probe',
    token: databaseQueryToken,
  });
  const workspaceProbe = createServiceProbe({
    pluginId: 'froglight.app.workspace-probe',
    token: workspaceToken,
  });
  const vaultProbe = createServiceProbe({
    pluginId: 'froglight.app.vault-probe',
    token: vaultToken,
  });
  const searchProbe = createServiceProbe({
    pluginId: 'froglight.app.search-probe',
    token: searchToken,
  });
  const assetStoreProbe = createServiceProbe({
    pluginId: 'froglight.app.asset-store-probe',
    token: documentAssetStoreToken,
  });
  const pdfProbe = createServiceProbe({
    pluginId: 'froglight.app.pdf-provider-probe',
    token: pdfProviderToken,
  });
  const pdfExportProbe = createServiceProbe({
    pluginId: 'froglight.app.pdf-export-provider-probe',
    token: pdfExportProviderToken,
  });
  const latexProbe = createServiceProbe({
    pluginId: 'froglight.app.latex-provider-probe',
    token: latexProviderToken,
  });
  const editorRegistryProbe = createServiceProbe({
    pluginId: 'froglight.app.editor-registry-probe',
    token: documentEditorRegistryToken,
  });
  const documentRegistryProbe = createServiceProbe({
    pluginId: 'froglight.app.document-registry-probe',
    token: documentRegistryToken,
  });
  const readerRegistryProbe = createServiceProbe({
    pluginId: 'froglight.app.reader-registry-probe',
    token: documentReaderRegistryToken,
  });
  const navigationProbe = createServiceProbe({
    pluginId: 'froglight.app.navigation-probe',
    token: navigationToken,
  });
  const commandsProbe = createServiceProbe({
    pluginId: 'froglight.app.commands-probe',
    token: commandsToken,
  });
  const dockLayoutProbe = createServiceProbe({
    pluginId: 'froglight.app.dock-layout-probe',
    token: dockLayoutToken,
  });
  const markdownProbe = createServiceProbe({
    pluginId: 'froglight.app.markdown-editor-probe',
    token: markdownEditorProviderToken,
  });
  const handwritingProbe = createServiceProbe({
    pluginId: 'froglight.app.handwriting-recognition-probe',
    token: handwritingRecognizerToken,
  });
  const stylusProbe = createServiceProbe({
    pluginId: 'froglight.app.stylus-probe',
    token: stylusToken,
  });
  const settingsProbe = createServiceProbe({
    pluginId: 'froglight.app.settings-probe',
    token: settingsToken,
  });

  const presentationCapabilityListeners = new Set<(kindIds: readonly DocumentKindId[]) => void>();
  const notifyPresentationCapabilities = (kindIds: readonly DocumentKindId[]): void => {
    for (const listener of [...presentationCapabilityListeners]) listener(kindIds);
  };

  const notebookProviderListeners = new Set<() => void | Promise<void>>();
  const notifyNotebookProviderListeners = async (): Promise<void> => {
    for (const listener of [...notebookProviderListeners]) await listener();
  };

  const capabilityDeps = {
    getAssets: () => assetStoreProbe.get(),
    getPdfProvider: () => pdfProbe.get(),
    getSettings: () => settingsProbe.get(),
    getStylusInput: () => stylusProbe.get(),
  };
  const openResource = (target: ResourceTarget): void => {
    navigationProbe.get()?.push({
      resourceId: target.resourceId,
      ...(target.address !== undefined ? { address: target.address } : {}),
    });
  };
  const workspaceResourceResolver = createWorkspaceResourceResolver({
    getWorkspace: () => workspaceProbe.get(),
    ...(options.resourceResolver !== undefined
      ? { additionalResolver: options.resourceResolver }
      : {}),
  });
  const blockAdapterDeps = {
    compositionRegistry,
    compositionPresenter: compositionPresentations,
    blockRegistry: blockRegistry as BlockRegistry,
    openResource,
    resourceResolver: workspaceResourceResolver,
  };

  const withCapabilities = (
    provider: DocumentEditorProvider,
  ): DocumentEditorProvider =>
    withApplicationEditorCapabilities(provider, capabilityDeps);

  if (options.searchService !== undefined) {
    await runtime.registerSlot({
      id: 'search',
      plugin: searchBindingPlugin(options.searchService),
    });
  }
  await runtime.registerSlot({
    id: 'search-probe',
    plugin: searchProbe.plugin,
  });

  // Every vault in the application composition is observed at the
  // boundary: the `vaultToken` consumers (workspace sessions, asset
  // ingestion, search projection) and the sync scheduler share one
  // observable facade, so committed local writes always reach the
  // mutation feed. Transparent for local-only use (still a
  // `VaultService`); idempotent for already-observable providers.
  await runtime.registerSlot({
    id: 'vault',
    plugin: withObservableVault(options.vaultPlugin),
    config: (options.vaultConfig ?? {}) as C,
  });
  await runtime.registerSlot({ id: 'vault-probe', plugin: vaultProbe.plugin });
  await runtime.registerSlot({
    id: 'composition-presentations',
    plugin: definePlugin({
      id: 'froglight.composition-presentations',
      activate(ctx) {
        ctx.provide(compositionPresentationToken, compositionPresentations);
      },
    }),
  });
  await runtime.registerSlot({
    id: 'document-presentations',
    plugin: definePlugin({
      id: 'froglight.document-presentations',
      activate(ctx) {
        ctx.provide(documentPresentationToken, new InMemoryDocumentPresentationRegistry());
      },
    }),
  });
  await runtime.registerSlot({
    id: 'outline-registry',
    plugin: definePlugin({
      id: 'froglight.outline-registry.binding',
      activate(ctx) {
        ctx.provide(outlineRegistryToken, outlineRegistry);
      },
    }),
  });
  for (const [index, presenter] of (
    options.compositionPresenters ?? []
  ).entries()) {
    await runtime.registerSlot({
      id: `composition-presentation-${index}`,
      plugin: definePlugin({
        id: `froglight.composition-presentation.${index}`,
        requirements: { requires: [compositionPresentationToken] },
        activate(ctx) {
          ctx.effect(
            () =>
              ctx
                .require(compositionPresentationToken)
                .register(String(index), presenter).dispose,
          );
        },
      }),
    });
  }
  await runtime.registerSlot({
    id: 'composition-registry',
    plugin: definePlugin({
      id: 'froglight.composition-registry.binding',
      activate: (ctx) => {
        ctx.provide(compositionRegistryToken, compositionRegistry);
      },
    }),
  });
  await runtime.registerSlot({
    id: 'block-registry',
    plugin: definePlugin({
      id: 'froglight.block-registry.binding',
      activate: (ctx) => {
        ctx.provide(blockRegistryToken, blockRegistry);
      },
    }),
  });
  const compositionProviders = [
    ...createFirstPartyCompositionProviders({
      workspace: () => workspaceProbe.get(),
      openSource: (target) =>
        navigationProbe.get()?.push({
          resourceId: target.resourceId,
          ...(target.address !== undefined ? { address: target.address } : {}),
        }),
      ...(options.inkPreviewRenderer !== undefined
        ? { renderInkPreview: options.inkPreviewRenderer }
        : {}),
      ...(options.notebookPreviewRenderer !== undefined
        ? { renderNotebookPreviews: options.notebookPreviewRenderer }
        : {}),
      ...(options.pdfPreviewRenderer !== undefined
        ? { renderPdfPreview: options.pdfPreviewRenderer }
        : {}),
      pdfProvider: () => pdfProbe.get(),
      latexProvider: () => latexProbe.get(),
    }),
    ...(options.compositionProviders ?? []),
  ];
  for (const [index, provider] of compositionProviders.entries()) {
    await runtime.registerSlot({
      id: `composition-provider-${index}`,
      plugin: definePlugin({
        id: `froglight.composition-provider.${index}`,
        requirements: { requires: [compositionRegistryToken] },
        activate: (ctx) => {
          const registry = ctx.require(compositionRegistryToken);
          ctx.effect(() => registry.register(provider).dispose);
        },
      }),
    });
  }
  await runtime.registerSlot({
    id: 'document-assets',
    plugin: workspaceAssetsPlugin(),
  });
  await runtime.registerSlot({
    id: 'asset-store-probe',
    plugin: assetStoreProbe.plugin,
  });
  if (options.pdfProvider !== undefined) {
    await runtime.registerSlot({
      id: 'pdf-provider',
      plugin: pdfProviderBindingPlugin(options.pdfProvider),
    });
  }
  await runtime.registerSlot({
    id: 'pdf-provider-probe',
    plugin: pdfProbe.plugin,
  });
  if (options.pdfExportProvider !== undefined) {
    await runtime.registerSlot({
      id: 'pdf-export-provider',
      plugin: pdfExportProviderBindingPlugin(options.pdfExportProvider),
    });
  }
  await runtime.registerSlot({
    id: 'pdf-export-provider-probe',
    plugin: pdfExportProbe.plugin,
  });
  if (options.latexProvider !== undefined) {
    await runtime.registerSlot({
      id: 'latex-provider',
      plugin: latexProviderBindingPlugin(options.latexProvider),
    });
  }
  await runtime.registerSlot({
    id: 'latex-provider-probe',
    plugin: latexProbe.plugin,
  });
  await runtime.registerSlot({
    id: 'workspace',
    plugin: workspacePlugin,
    config: options.workspaceConfig ?? {},
  });
  if (options.documentFeatures === undefined) {
    await runtime.registerSlot({
      id: 'document-kinds',
      plugin: documentKindsPlugin(options.documentKinds ?? [markdownKind]),
    });
  }

  for (const [id, plugin] of [
    ['property-catalog', propertyCatalogPlugin],
    ['formula-functions', formulaFunctionsPlugin],
    ['resource-properties', resourcePropertiesPlugin],
    ['database-definitions', databaseDefinitionsPlugin],
    [
      'database-query',
      options.databaseQueryProviderPlugin ?? databaseQueryPlugin,
    ],
    ['resource-properties-probe', resourcePropertiesProbe.plugin],
    ['database-query-probe', databaseQueryProbe.plugin],
  ] as const)
    await runtime.registerSlot({ id, plugin });
  await runtime.registerSlot({
    id: 'database-composition',
    plugin: definePlugin({
      id: 'froglight.database-composition',
      requirements: {
        requires: [
          compositionRegistryToken,
          workspaceToken,
          resourcePropertiesToken,
          databaseQueryToken,
          databaseDefinitionsToken,
          relationshipsToken,
        ],
      },
      activate(ctx) {
        const workspace = ctx.require(workspaceToken);
        const properties = ctx.require(resourcePropertiesToken);
        const query = ctx.require(databaseQueryToken);
        const providerOptions = {
          definitions: ctx.require(databaseDefinitionsToken),
          workspace: () => workspace,
          properties: () => properties,
          query: () => query,
          relations: {
            definitions: ctx.require(databaseDefinitionsToken),
            relationships: ctx.require(relationshipsToken),
          },
          openSource: (target: ResourceTarget) =>
            navigationProbe.get()?.push({ resourceId: target.resourceId }),
        };
        for (const role of ['linked-view', 'preview'] as const) {
          const provider = createDatabaseCompositionProvider({
            ...providerOptions,
            role,
          });
          ctx.effect(
            () =>
              ctx.require(compositionRegistryToken).register(provider).dispose,
          );
        }
      },
    }),
  });

  await runtime.registerSlot({
    id: 'editor-registry',
    plugin: editorRegistryPlugin(editorRegistry),
  });
  await runtime.registerSlot({
    id: 'editor-registry-probe',
    plugin: editorRegistryProbe.plugin,
  });
  await runtime.registerSlot({
    id: 'document-registry-probe',
    plugin: documentRegistryProbe.plugin,
  });
  await runtime.registerSlot({
    id: 'reader-registry',
    plugin: readerRegistryPlugin(readerRegistry),
  });
  await runtime.registerSlot({
    id: 'reader-registry-probe',
    plugin: readerRegistryProbe.plugin,
  });

  for (const feature of options.documentFeatures ?? []) {
    const editor = typeof feature.editor === 'function'
      ? feature.editor({
          adaptMarkdown: (provider) => asMarkdownDocumentEditorProvider(
            provider,
            workspaceResourceResolver,
            (query) => searchMarkdownImageFiles(vaultProbe.get(), query),
          ),
          adaptBlockPage: (provider) => asBlockDocumentEditorProvider(provider, blockAdapterDeps),
        })
      : feature.editor;
    await installDocumentFeature(runtime, {
      ...feature,
      ...(editor ? { editor: withCapabilities(editor) } : {}),
    });
  }

  // One generic registry binding list built from AppOptions: direct generic
  // providers plus adapted typed convenience providers. Every entry passes
  // through the same capability decorator, so product resolution stays
  // registry-by-kind with identical asset/PDF wiring on every path.
  const genericEditorEntries: {
    readonly slotId: string;
    readonly provider: DocumentEditorProvider;
  }[] = [
    ...(options.documentEditorProviders ?? []).map((provider, index) => ({
      slotId: `editor-provider-${index}`,
      provider,
    })),
    ...(options.markdownEditorProvider !== undefined
      ? [
          {
            slotId: 'editor-markdown',
            provider: asMarkdownDocumentEditorProvider(
              options.markdownEditorProvider,
              workspaceResourceResolver,
              (query) => searchMarkdownImageFiles(vaultProbe.get(), query),
            ),
          },
        ]
      : []),
    ...(options.blockPageEditorProvider !== undefined
      ? [
          {
            slotId: 'editor-blockpage',
            provider: asBlockDocumentEditorProvider(
              options.blockPageEditorProvider,
              blockAdapterDeps,
            ),
          },
        ]
      : []),
    ...(options.notebookEditorProvider !== undefined
      ? [
          {
            slotId: 'editor-notebook',
            provider: asNotebookDocumentEditorProvider(
              options.notebookEditorProvider,
            ),
          },
        ]
      : []),
  ];
  for (const entry of genericEditorEntries) {
    await runtime.registerSlot({
      id: entry.slotId,
      plugin: documentEditorBindingPlugin(withCapabilities(entry.provider)),
    });
  }

  for (const [index, provider] of (
    options.documentReaderProviders ?? []
  ).entries()) {
    await runtime.registerSlot({
      id: `reader-provider-${index}`,
      plugin: documentReaderBindingPlugin(provider),
    });
  }

  if (options.markdownEditorProvider !== undefined) {
    await runtime.registerSlot({
      id: 'editor-markdown-capability',
      plugin: markdownProviderBindingPlugin(options.markdownEditorProvider),
    });
  }
  await runtime.registerSlot({
    id: 'markdown-editor-probe',
    plugin: markdownProbe.plugin,
  });

  if (options.handwritingRecognizer !== undefined) {
    await runtime.registerSlot({
      id: 'handwriting-recognition',
      plugin: handwritingRecognizerBindingPlugin(options.handwritingRecognizer),
    });
  }
  await runtime.registerSlot({
    id: 'handwriting-recognition-probe',
    plugin: handwritingProbe.plugin,
  });
  await runtime.registerSlot({
    id: 'settings-probe',
    plugin: settingsProbe.plugin,
  });
  await runtime.registerSlot({
    id: 'stylus-probe',
    plugin: stylusProbe.plugin,
  });

  await runtime.registerSlot({
    id: 'workspace-probe',
    plugin: workspaceProbe.plugin,
  });
  await runtime.registerSlot({
    id: 'navigation-probe',
    plugin: navigationProbe.plugin,
  });
  await runtime.registerSlot({
    id: 'commands-probe',
    plugin: commandsProbe.plugin,
  });
  await runtime.registerSlot({ id: 'dock-layout', plugin: dockLayoutPlugin });
  await runtime.registerSlot({
    id: 'dock-layout-probe',
    plugin: dockLayoutProbe.plugin,
  });
  for (const extra of options.extraPlugins ?? []) {
    await runtime.registerSlot({ id: `extra-${extra.id}`, plugin: extra });
  }

  const replaceVault = async <V extends Readonly<Record<string, unknown>>>(
    plugin: PluginDefinition<V>,
    config?: V,
  ): Promise<void> => {
    await runtime.removeSlot('vault');
    searchProbe.get()?.clear();
    await runtime.registerSlot({
      id: 'vault',
      plugin: withObservableVault(plugin),
      config: (config ?? {}) as V,
    });
  };

  const closeVault = async (): Promise<void> => {
    await runtime.removeSlot('vault');
    searchProbe.get()?.clear();
  };

  const replaceMarkdownEditorProvider = async (
    provider: MarkdownEditorProvider | null,
  ): Promise<void> => {
    await replaceSlots(runtime, {
      providerSlotIds: ['editor-markdown', 'editor-markdown-capability'],
      probeSlotIds: ['markdown-editor-probe'],
      clearCaptures: () => markdownProbe.clear(),
      registerProviders: async () => {
        if (provider === null) return;
        await runtime.registerSlot({
          id: 'editor-markdown-capability',
          plugin: markdownProviderBindingPlugin(provider),
        });
        await runtime.registerSlot({
          id: 'editor-markdown',
          plugin: documentEditorBindingPlugin(
            withCapabilities(asMarkdownDocumentEditorProvider(
              provider,
              workspaceResourceResolver,
              (query) => searchMarkdownImageFiles(vaultProbe.get(), query),
            )),
          ),
        });
      },
      registerProbes: async () => {
        await runtime.registerSlot({
          id: 'markdown-editor-probe',
          plugin: markdownProbe.plugin,
        });
      },
    });
  };

  const replaceNotebookEditorProvider = async (
    provider: NotebookEditorProvider | null,
  ): Promise<void> => {
    await replaceSlots(runtime, {
      providerSlotIds: ['editor-notebook'],
      registerProviders: async () => {
        if (provider === null) return;
        await runtime.registerSlot({
          id: 'editor-notebook',
          plugin: documentEditorBindingPlugin(
            withCapabilities(asNotebookDocumentEditorProvider(provider)),
          ),
        });
      },
      afterReplace: () => notifyNotebookProviderListeners(),
    });
  };

  const replacePdfProvider = async (
    provider: PdfProvider | null,
  ): Promise<void> => {
    await replaceSlots(runtime, {
      providerSlotIds: ['pdf-provider'],
      probeSlotIds: ['pdf-provider-probe'],
      clearCaptures: () => pdfProbe.clear(),
      registerProviders: async () => {
        if (provider === null) return;
        await runtime.registerSlot({
          id: 'pdf-provider',
          plugin: pdfProviderBindingPlugin(provider),
        });
      },
      registerProbes: async () => {
        await runtime.registerSlot({
          id: 'pdf-provider-probe',
          plugin: pdfProbe.plugin,
        });
      },
      afterReplace: () => notifyNotebookProviderListeners(),
    });
  };

  const replaceLatexProvider = async (
    provider: LaTeXProvider | null,
  ): Promise<void> => {
    // Withdraw captures and invalidate live projections before the first await:
    // in-flight opens/renders must not publish while runtime slots reconcile.
    latexProbe.clear();
    notifyPresentationCapabilities([latexKindId]);
    await replaceSlots(runtime, {
      providerSlotIds: ['latex-provider'],
      probeSlotIds: ['latex-provider-probe'],
      clearCaptures: () => latexProbe.clear(),
      registerProviders: async () => {
        if (provider === null) return;
        await runtime.registerSlot({
          id: 'latex-provider',
          plugin: latexProviderBindingPlugin(provider),
        });
      },
      registerProbes: async () => {
        await runtime.registerSlot({
          id: 'latex-provider-probe',
          plugin: latexProbe.plugin,
        });
      },
      afterReplace: () => {
        if (latexProbe.get() !== null) notifyPresentationCapabilities([latexKindId]);
      },
    });
  };

  return {
    runtime,
    getWorkspace: () => workspaceProbe.get(),
    getResourceProperties: () => resourcePropertiesProbe.get(),
    getDatabaseQuery: () => databaseQueryProbe.get(),
    getVault: () => vaultProbe.get(),
    getSearch: () => searchProbe.get(),
    getNavigation: () => navigationProbe.get(),
    getCommands: () => commandsProbe.get(),
    getDockLayout: () => dockLayoutProbe.get(),
    getDocumentEditor: (kindId) =>
      editorRegistryProbe.get()?.get(kindId) ?? null,
    onDocumentEditorProviderChange: (listener) =>
      editorRegistryProbe.get()?.onDidChange(listener) ?? {
        dispose() {
          /* no-op */
        },
      },
    getDocumentKind: (kindId) => documentRegistryProbe.get()?.recognize(kindId) ?? null,
    getOutlineRegistry: () => outlineRegistry,
    onDocumentReaderProviderChange: (listener) => readerRegistry.onDidChange(listener),
    getDocumentReader: (kindId) =>
      readerRegistryProbe.get()?.get(kindId) ?? null,
    getHandwritingRecognizer: () => handwritingProbe.get(),
    getCompositionRegistry: () => compositionRegistry,
    getDocumentAssetStore: () => assetStoreProbe.get(),
    getPdfProvider: () => pdfProbe.get(),
    getPdfExportProvider: () => pdfExportProbe.get(),
    onDocumentPresentationCapabilityChange(listener) {
      presentationCapabilityListeners.add(listener);
      return { dispose: () => { presentationCapabilityListeners.delete(listener); } };
    },
    getLatexProvider: () => latexProbe.get(),
    replaceVault,
    closeVault,
    replaceMarkdownEditorProvider,
    replaceNotebookEditorProvider,
    replacePdfProvider,
    replaceLatexProvider,
    onNotebookEditorProviderChange(listener: () => void | Promise<void>) {
      notebookProviderListeners.add(listener);
      let disposed = false;
      return {
        dispose() {
          if (disposed) return;
          disposed = true;
          notebookProviderListeners.delete(listener);
        },
      };
    },
    dispose: async () => {
      notebookProviderListeners.clear();
      await runtime.dispose();
    },
  };
}

export {
  WorkbenchController,
  createWorkbenchController,
  type WorkbenchApplication,
  type WorkbenchDocument,
  type WorkbenchSearchResult,
  type WorkbenchState,
} from './workbench-controller.js';
export {
  DOCK_RECORD_PATH,
  DockLayoutStoreImpl,
  dockLayoutPlugin,
  dockLayoutToken,
  type DockLayoutStore,
} from './dock-layout.js';
export type {
  DockLayoutRecord,
  DockMoveTarget,
  DockStateView,
  DockTabKind,
  DockTabView,
  PaneMode,
  PaneStateView,
} from './workbench-controller.js';
export type { DockDirection, DockNode, DockSide } from './dock-model.js';
export {
  runNotebookHandwritingRecognition,
  type RunRecognitionResult,
} from './recognition.js';
export {
  ATTACHMENTS_DIR,
  createVaultAssetStore,
  workspaceAssetsPlugin,
} from './asset-store.js';
import {
  createDatabaseCompositionProvider,
  propertyCatalogPlugin,
  resourcePropertiesPlugin,
  resourcePropertiesToken,
  databaseQueryPlugin,
  databaseQueryToken,
  databaseDefinitionsPlugin,
  databaseDefinitionsToken,
  relationshipsToken,
  formulaFunctionsPlugin,
  type ResourcePropertyService,
  type DatabaseQueryProvider,
} from '@froglight/foundation';

export {
  DEMO_VAULT_ID,
  DEMO_VAULT_NAME,
  installDemoVault,
} from './demo-vault/index.js';
