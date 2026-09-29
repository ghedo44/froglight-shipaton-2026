/**
 * Typed editor adapters and the single application editor-capability
 * decorator.
 *
 * Typed Markdown/Block/Notebook adapters own only model/session-specific
 * bridging. All asset/PDF injection happens in one subsequent generic
 * capability decorator, so typed Notebook providers and generic Notebook
 * `DocumentEditorProvider`s receive identical asset/PDF/import wiring.
 *
 * The decorator receives getters, not captured service instances.
 * `createEditor` resolves what must be fixed for that editor instance;
 * long-lived operations such as Notebook `importPdf` re-read the current
 * capabilities when invoked and fail cleanly when unavailable.
 */

import {
  blockPageKindId,
  inkPageKindId,
  markdownKindId,
  notebookKindId,
  whiteboardKindId,
  type BlockPageEditorProvider,
  type BlockPageModel,
  type BlockRegistry,
  type CompositionRegistry,
  type CompositionPresenter,
  type DocumentAssetStore,
  type DocumentEditorProvider,
  type DocumentSession,
  type MarkdownEditorProvider,
  type MarkdownModel,
  type NotebookEditorInput,
  type NotebookEditorProvider,
  type NotebookModel,
  type PdfProvider,
  type ResourceResolver,
  type ResourceTarget,
  type SettingsService,
  type StylusInputPolicy,
} from '@froglight/foundation';
import { insertPdfIntoNotebook as insertPdfIntoNotebookOperation } from './pdf-import.js';

/** Adapt a Markdown provider onto the generic registry seam (dirty bridging only). */
export function asMarkdownDocumentEditorProvider(
  provider: MarkdownEditorProvider,
  resourceResolver?: ResourceResolver,
  searchImageFiles?: (query: string) => Promise<readonly string[]>,
): DocumentEditorProvider {
  return {
    id: 'markdown',
    kindIds: [markdownKindId],
    createEditor({ session, parent }) {
      const markdownSession = session as DocumentSession<MarkdownModel>;
      const handle = provider.createEditor({
        session: markdownSession,
        parent,
        initialText: markdownSession.model.raw,
        ...(resourceResolver ? { resourceResolver } : {}),
        ...(searchImageFiles ? { searchImageFiles } : {}),
        onDirtyText: (text) => {
          if (markdownSession.model.raw === text) return;
          (markdownSession.model as { raw: string }).raw = text;
          markdownSession.markDirty();
        },
      });
      const subscription = markdownSession.onDidChangeContent(() => {
        handle.replaceAll?.(markdownSession.model.raw);
      });
      const destroy = handle.destroy.bind(handle);
      handle.destroy = () => {
        subscription.dispose();
        destroy();
      };
      return handle;
    },
  };
}

export interface BlockAdapterDeps {
  readonly compositionRegistry: CompositionRegistry;
  readonly compositionPresenter?: CompositionPresenter;
  readonly blockRegistry: BlockRegistry;
  readonly openResource: (target: ResourceTarget) => void;
  readonly resourceResolver: ResourceResolver;
}

/** Adapt a Block Page provider onto the generic seam (model bridging only).
 *
 * The optional vault asset binding flows through opaquely.
 * `withApplicationEditorCapabilities` injects the active
 * `DocumentAssetStore` into the generic input and this adapter forwards it
 * to the typed provider (whose provider-local extended input carries it —
 * the foundation seam stays unchanged). Absent bindings stay absent and
 * the provider fails safe to offline placeholders downstream.
 */
export function asBlockDocumentEditorProvider(
  provider: BlockPageEditorProvider,
  deps: BlockAdapterDeps,
): DocumentEditorProvider {
  return {
    id: 'blockpage',
    kindIds: [blockPageKindId],
    createEditor(input: {
      readonly session: DocumentSession;
      readonly parent: unknown;
      readonly assets?: DocumentAssetStore | null;
    }) {
      const { session, parent } = input;
      const assets = input.assets ?? null;
      const blockSession = session as DocumentSession<BlockPageModel>;
      const handle = provider.createEditor({
        session: blockSession,
        parent,
        initialModel: blockSession.model,
        onDirtyModel: (model) => {
          // Canonical plain data replaces the model in place; no editor
          // types ever cross this boundary.
          Object.assign(blockSession.model as object, model);
          blockSession.markDirty();
        },
        compositionRegistry: deps.compositionRegistry,
        ...(deps.compositionPresenter ? { compositionPresenter: deps.compositionPresenter } : {}),
        blockRegistry: deps.blockRegistry,
        openResource: deps.openResource,
        resourceResolver: deps.resourceResolver,
        // Spread (never a literal field) so the foundation seam type stays
        // unchanged while the provider-local extended input receives it.
        ...(assets !== null ? { assets } : {}),
      });
      const subscription = blockSession.onDidChangeContent(() => {
        handle.applyDocumentMetadata?.(blockSession.model.meta);
      });
      const destroy = handle.destroy.bind(handle);
      handle.destroy = () => {
        subscription.dispose();
        destroy();
      };
      return handle;
    },
  };
}

/**
 * Adapt a Notebook provider onto the generic seam (typed input adaptation
 * only). Asset/PDF/import wiring is applied later by
 * `withApplicationEditorCapabilities`, never here.
 */
export function asNotebookDocumentEditorProvider(
  provider: NotebookEditorProvider,
): DocumentEditorProvider {
  return {
    id: 'notebook',
    kindIds: [notebookKindId],
    createEditor(input) {
      const { session, parent, ...rest } = input as {
        readonly session: DocumentSession;
        readonly parent: unknown;
      } & Partial<NotebookEditorInput>;
      const notebookSession = session as DocumentSession<NotebookModel>;
      return provider.createEditor({
        session: notebookSession,
        parent,
        ...rest,
      });
    },
  };
}

export interface ApplicationEditorCapabilities {
  /** Lazily resolve the active asset store (never captured at composition). */
  readonly getAssets: () => DocumentAssetStore | null;
  /** Lazily resolve the active PDF provider (never captured at composition). */
  readonly getPdfProvider: () => PdfProvider | null;
  /**
   * Lazily resolve the application settings service backing shared
   * surface tool presets. Ink, Notebook, and
   * Whiteboard editors sharing one service share user defaults —
   * selected Pen subtype, colors, sizes, brush tuning, eraser/lasso —
   * across pages, documents, editor types, and restarts.
   */
  readonly getSettings?: () => SettingsService | null;
  readonly getStylusInput?: () => StylusInputPolicy | null;
}

/**
 * Inject vault-scoped editor capabilities into provider entries.
 *
 * - Ink/Whiteboard: lazy `DocumentAssetStore` + shared tool-preset
 *   settings access;
 * - Notebook: lazy `DocumentAssetStore`, lazy `PdfProvider`, shared
 *   tool-preset settings, and a PDF-import operation that re-reads
 *   capabilities at invocation time;
 * - Block page: lazy `DocumentAssetStore` only — picked
 *   and pasted media bytes persist through `uploadMedia` and vault figures
 *   hydrate offline; no PDF/settings/import surface;
 * - unrelated kinds: the provider is returned unchanged.
 */
export function withApplicationEditorCapabilities(
  provider: DocumentEditorProvider,
  deps: ApplicationEditorCapabilities,
): DocumentEditorProvider {
  const isNotebook = provider.kindIds.includes(notebookKindId);
  const isSurface =
    provider.kindIds.includes(inkPageKindId) ||
    provider.kindIds.includes(whiteboardKindId);
  const isBlockpage = provider.kindIds.includes(blockPageKindId);
  if (!isNotebook && !isSurface && !isBlockpage) return provider;

  return {
    id: provider.id,
    kindIds: provider.kindIds,
    createEditor({ session, parent, ...providerContext }) {
      if (isBlockpage) {
        const assetStore = deps.getAssets();
        const input = {
          session,
          parent,
          ...providerContext,
          ...(assetStore !== null ? { assets: assetStore } : {}),
        };
        return provider.createEditor(input);
      }
      const presetSettings = deps.getSettings?.() ?? null;
      const stylusInput = deps.getStylusInput?.() ?? null;
      if (!isNotebook) {
        const assetStore = deps.getAssets();
        const input = {
          session,
          parent,
          ...providerContext,
          ...(assetStore !== null ? { assets: assetStore } : {}),
          ...(presetSettings !== null ? { presetSettings } : {}),
          ...(stylusInput !== null ? { stylusInput } : {}),
        };
        return provider.createEditor(input);
      }
      const assetStore = deps.getAssets();
      const activePdfProvider = deps.getPdfProvider();
      return provider.createEditor({
        session: session as DocumentSession<NotebookModel>,
        parent,
        ...providerContext,
        ...(assetStore !== null ? { assets: assetStore } : {}),
        ...(presetSettings !== null ? { presetSettings } : {}),
        ...(stylusInput !== null ? { stylusInput } : {}),
        ...(activePdfProvider !== null
          ? { pdfProvider: activePdfProvider }
          : {}),
        importPdf: async (
          notebook: NotebookModel,
          bytes: Uint8Array,
          at: number,
          selectedPageIndexes?: readonly number[],
          password?: string,
        ) => {
          const freshAssets = deps.getAssets();
          const freshPdfProvider = deps.getPdfProvider();
          if (freshAssets === null || freshPdfProvider === null) {
            throw new Error(
              'PDF import requires an asset store and PDF provider',
            );
          }
          await insertPdfIntoNotebookOperation({
            notebook,
            bytes,
            at,
            assets: freshAssets,
            provider: freshPdfProvider,
            ...(selectedPageIndexes !== undefined
              ? { selectedPageIndexes }
              : {}),
            ...(password !== undefined ? { password } : {}),
          });
        },
      } as NotebookEditorInput);
    },
  };
}
