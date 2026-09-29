import {
  definePlugin,
  type PluginDefinition,
  type Runtime,
} from '@froglight/runtime';
import {
  blockPageKind,
  databaseKind,
  documentEditorRegistryToken,
  documentPresentationToken,
  documentReaderRegistryToken,
  documentRegistryToken,
  inkPageKind,
  latexKind,
  markdownKind,
  notebookKind,
  pdfKind,
  whiteboardKind,
  type DocumentEditorProvider,
  type DocumentKindDescriptor,
  type DocumentKindId,
  type DocumentPresentation,
  type DocumentReaderProvider,
  type MarkdownEditorProvider,
  type BlockPageEditorProvider,
} from '@froglight/foundation';
import { blockPageOutlineExtractor } from './outline/blockpage.js';
import { latexOutlineExtractor } from './outline/latex.js';
import { markdownOutlineExtractor } from './outline/markdown.js';
import { notebookOutlineExtractor } from './outline/notebook.js';
import { pdfOutlineExtractor } from './outline/pdf.js';
import type { OutlineExtractor } from './outline/types.js';
import { outlineRegistryToken } from './outline/token.js';

export interface DocumentFeature {
  readonly kind: DocumentKindDescriptor<any>;
  readonly presentation?: Omit<DocumentPresentation, 'kindId'>;
  readonly editor?:
    | DocumentEditorProvider
    | ((
        dependencies: DocumentFeatureEditorDependencies,
      ) => DocumentEditorProvider);
  readonly reader?: DocumentReaderProvider;
  readonly outline?: OutlineExtractor;
}

export interface DocumentFeatureEditorDependencies {
  readonly adaptMarkdown: (
    provider: MarkdownEditorProvider,
  ) => DocumentEditorProvider;
  readonly adaptBlockPage: (
    provider: BlockPageEditorProvider,
  ) => DocumentEditorProvider;
}

export function defineDocumentFeature(
  feature: DocumentFeature,
): DocumentFeature {
  return feature;
}

/** Each capability occupies its own slot, so withdrawal is independent. */
export async function installDocumentFeature(
  runtime: Runtime,
  feature: DocumentFeature,
): Promise<void> {
  const id = feature.kind.id;
  const register = async (suffix: string, plugin: PluginDefinition) => {
    await runtime.registerSlot({
      id: `document-feature:${id}:${suffix}`,
      plugin,
    });
  };
  await register(
    'kind',
    definePlugin({
      id: `froglight.document-feature.${id}.kind`,
      requirements: { requires: [documentRegistryToken] },
      activate(ctx) {
        ctx.effect(
          () =>
            ctx.require(documentRegistryToken).register(feature.kind).dispose,
        );
      },
    }),
  );
  if (feature.presentation)
    await register(
      'presentation',
      definePlugin({
        id: `froglight.document-feature.${id}.presentation`,
        requirements: { requires: [documentPresentationToken] },
        activate(ctx) {
          ctx.effect(
            () =>
              ctx.require(documentPresentationToken).register({
                ...feature.presentation,
                kindId: id,
              }).dispose,
          );
        },
      }),
    );
  if (feature.editor) {
    if (typeof feature.editor === 'function')
      throw new Error(
        `Document editor factory for ${id} must be resolved before installation`,
      );
    const editor = feature.editor;
    await register(
      'editor',
      definePlugin({
        id: `froglight.document-feature.${id}.editor`,
        requirements: { requires: [documentEditorRegistryToken] },
        activate(ctx) {
          ctx.effect(
            () =>
              ctx.require(documentEditorRegistryToken).register(editor).dispose,
          );
        },
      }),
    );
  }
  if (feature.reader) {
    const reader = feature.reader;
    await register(
      'reader',
      definePlugin({
        id: `froglight.document-feature.${id}.reader`,
        requirements: { requires: [documentReaderRegistryToken] },
        activate(ctx) {
          ctx.effect(
            () =>
              ctx.require(documentReaderRegistryToken).register(reader).dispose,
          );
        },
      }),
    );
  }
  if (feature.outline) {
    const outline = feature.outline;
    await register(
      'outline',
      definePlugin({
        id: `froglight.document-feature.${id}.outline`,
        requirements: { requires: [outlineRegistryToken] },
        activate(ctx) {
          ctx.effect(
            () => ctx.require(outlineRegistryToken).register(outline).dispose,
          );
        },
      }),
    );
  }
}

/** First-party declaration; host profiles supply replaceable providers. */
export const firstPartyDocumentFeatures: readonly DocumentFeature[] = [
  defineDocumentFeature({
    kind: markdownKind,
    presentation: {
      description: 'Plain text with wiki links — durable everywhere',
      icon: 'markdown',
      shell: { title: 'provider' },
    },
    outline: markdownOutlineExtractor,
  }),
  defineDocumentFeature({
    kind: blockPageKind,
    presentation: {
      description: 'Structured blocks you can rearrange freely',
      icon: 'blockpage',
      shell: { title: 'overlay' },
    },
    outline: blockPageOutlineExtractor,
  }),
  defineDocumentFeature({
    kind: inkPageKind,
    presentation: {
      description: 'Handwritten strokes and sketches',
      icon: 'ink',
      shell: { defaultContextMenu: false },
    },
  }),
  defineDocumentFeature({
    kind: whiteboardKind,
    presentation: {
      description: 'Infinite canvas for visual organization',
      icon: 'canvas',
      shell: { defaultContextMenu: false },
    },
  }),
  defineDocumentFeature({
    kind: notebookKind,
    presentation: {
      description: 'Paged notes and worksheets',
      icon: 'notebook',
      shell: { defaultContextMenu: false },
    },
    outline: notebookOutlineExtractor,
  }),
  defineDocumentFeature({
    kind: latexKind,
    presentation: {
      description: 'Portable TeX notes with live preview',
      icon: 'file-latex',
    },
    outline: latexOutlineExtractor,
  }),
  defineDocumentFeature({
    kind: databaseKind,
    presentation: {
      description: 'Shared document collections with tables and boards',
      icon: 'database',
      shell: { toolbar: 'none' },
    },
  }),
  defineDocumentFeature({
    kind: pdfKind,
    presentation: { label: 'PDF', icon: 'file-pdf' },
    outline: pdfOutlineExtractor,
  }),
];

export function withFirstPartyDocumentProviders(providers: {
  readonly markdown: MarkdownEditorProvider;
  readonly blockPage: BlockPageEditorProvider;
  readonly ink: DocumentEditorProvider;
  readonly notebook: DocumentEditorProvider;
  readonly pdf: DocumentEditorProvider;
  readonly whiteboard: DocumentEditorProvider;
  readonly latex: DocumentEditorProvider;
  readonly markdownReader: DocumentReaderProvider;
  readonly latexReader: DocumentReaderProvider;
}): readonly DocumentFeature[] {
  const editors = new Map<DocumentKindId, DocumentFeature['editor']>([
    [
      markdownKind.id,
      (deps: DocumentFeatureEditorDependencies) =>
        deps.adaptMarkdown(providers.markdown),
    ],
    [
      blockPageKind.id,
      (deps: DocumentFeatureEditorDependencies) =>
        deps.adaptBlockPage(providers.blockPage),
    ],
    [inkPageKind.id, providers.ink],
    [notebookKind.id, providers.notebook],
    [pdfKind.id, providers.pdf],
    [whiteboardKind.id, providers.whiteboard],
    [latexKind.id, providers.latex],
  ]);
  const readers = new Map([
    [markdownKind.id, providers.markdownReader],
    [latexKind.id, providers.latexReader],
  ]);
  return firstPartyDocumentFeatures.map((feature) => ({
    ...feature,
    ...(editors.has(feature.kind.id)
      ? { editor: editors.get(feature.kind.id) }
      : {}),
    ...(readers.has(feature.kind.id)
      ? { reader: readers.get(feature.kind.id) }
      : {}),
  }));
}
