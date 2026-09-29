import {
  extractHeadings,
  inkPageKindId,
  markdownKindId,
  parseFrontmatter,
  searchMarkdownImageFiles,
  workspacePath,
  type CompositionImage,
  type DocumentSession,
  type MarkdownModel,
  type SurfaceModel,
  type VaultService,
  type WorkspaceService,
} from '@froglight/foundation';

const IMAGE_MIME: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
};

export type MarkdownEmbed =
  | { readonly kind: 'markdown'; readonly raw: string; readonly key: string }
  | {
      readonly kind: 'image';
      readonly src: string;
      readonly alt: string;
      readonly key: string;
    }
  | { readonly kind: 'unavailable'; readonly message: string };

export interface MarkdownEmbedSources {
  readonly workspace: () => WorkspaceService | null;
  readonly vault: () => VaultService | null;
  readonly renderInk?: (
    model: SurfaceModel,
  ) => Promise<CompositionImage | undefined> | CompositionImage | undefined;
}

function sourcePath(
  workspace: WorkspaceService,
  session: DocumentSession,
): string | null {
  try {
    return workspace.resolveResourcePath(session.document.location.resourceId);
  } catch {
    return null;
  }
}

function markdownSection(
  raw: string,
  fragment: string | undefined,
): string | null {
  if (fragment === undefined) return raw;
  const { body } = parseFrontmatter(raw);
  const lines = body.split('\n');
  if (fragment.startsWith('^')) {
    const line = lines.find((entry) =>
      entry.trimEnd().endsWith(` ${fragment}`),
    );
    return line ?? null;
  }
  const headings = extractHeadings(body);
  const index = headings.findIndex((heading) => heading.slug === fragment);
  if (index < 0) return null;
  const heading = headings[index]!;
  const next = headings
    .slice(index + 1)
    .find((entry) => entry.level <= heading.level);
  return lines.slice(heading.line, next?.line ?? lines.length).join('\n');
}

/** Read current source on each resolution; no embed bytes become canonical Markdown. */
export async function resolveMarkdownEmbed(
  sources: MarkdownEmbedSources,
  session: DocumentSession,
  destination: string,
): Promise<MarkdownEmbed> {
  const workspace = sources.workspace();
  if (workspace === null)
    return { kind: 'unavailable', message: 'Workspace unavailable' };
  const path = sourcePath(workspace, session);
  if (path === null)
    return { kind: 'unavailable', message: 'Source path unavailable' };
  const hash = destination.indexOf('#');
  const name = (hash < 0 ? destination : destination.slice(0, hash)).trim();
  const fragment = hash < 0 ? undefined : destination.slice(hash + 1).trim();
  if (
    name === '' ||
    name.includes('\\') ||
    name.startsWith('/') ||
    name.includes('..')
  )
    return { kind: 'unavailable', message: 'Invalid embed path' };
  const directory = path.includes('/')
    ? path.slice(0, path.lastIndexOf('/') + 1)
    : '';
  const candidates = [`${directory}${name}`, name];
  const documents = workspace.listDocuments();
  const paths = documents.map((ref) => ({
    ref,
    path: workspace.resolveResourcePath(ref.location.resourceId),
  }));
  const exact =
    paths.find((entry) => entry.path === candidates[0]) ??
    paths.find((entry) => entry.path === candidates[1]);
  const matched = exact
    ? [exact.ref]
    : paths
        .filter((entry) => {
          const basename = entry.path.split('/').at(-1) ?? '';
          return basename === name || basename.replace(/\.[^.]+$/, '') === name;
        })
        .map((entry) => entry.ref);
  if (matched.length === 1) {
    const ref = matched[0]!;
    if (ref.kindId === markdownKindId) {
      const open = workspace.getOpenDocument<MarkdownModel>(ref.documentId);
      const model =
        open?.model ??
        (await workspace.readDocument<MarkdownModel>(ref.documentId)).model;
      const raw = markdownSection(model.raw, fragment);
      return raw === null
        ? { kind: 'unavailable', message: `Section ${fragment} was not found` }
        : { kind: 'markdown', raw, key: String(ref.documentId) };
    }
    if (
      ref.kindId === inkPageKindId &&
      fragment === undefined &&
      sources.renderInk
    ) {
      const model = (await workspace.readDocument<SurfaceModel>(ref.documentId))
        .model;
      const image = await sources.renderInk(model);
      if (image)
        return {
          kind: 'image',
          src: image.dataUrl,
          alt: name,
          key: String(ref.documentId),
        };
    }
    return {
      kind: 'unavailable',
      message: 'This file cannot be embedded here',
    };
  }
  if (matched.length > 1)
    return {
      kind: 'unavailable',
      message: 'More than one file matches this name',
    };
  const vault = sources.vault();
  if (vault === null || fragment !== undefined)
    return { kind: 'unavailable', message: 'Embedded file unavailable' };
  let exactImage: string | undefined;
  for (const candidate of candidates) {
    try {
      if ((await vault.stat(workspacePath(candidate))).kind === 'file') {
        exactImage = candidate;
        break;
      }
    } catch {
      /* Try the next portable path. */
    }
  }
  const imagePaths = exactImage
    ? []
    : await searchMarkdownImageFiles(vault, name);
  const matchingImages = exactImage
    ? [exactImage]
    : imagePaths.filter((imagePath) => imagePath.split('/').at(-1) === name);
  if (matchingImages.length !== 1)
    return {
      kind: 'unavailable',
      message: matchingImages.length
        ? 'More than one image matches this name'
        : 'Embedded image not found',
    };
  const imagePath = matchingImages[0]!;
  const mime = IMAGE_MIME[imagePath.split('.').at(-1)?.toLowerCase() ?? ''];
  if (!mime)
    return { kind: 'unavailable', message: 'Unsupported image format' };
  const stat = await vault.stat(workspacePath(imagePath));
  if (stat.size > 8_000_000)
    return { kind: 'unavailable', message: 'Image is too large to embed' };
  const bytes = await vault.read(workspacePath(imagePath));
  if (bytes.length > 8_000_000)
    return { kind: 'unavailable', message: 'Image is too large to embed' };
  let binary = '';
  for (let index = 0; index < bytes.length; index += 8192)
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return {
    kind: 'image',
    src: `data:${mime};base64,${btoa(binary)}`,
    alt: name,
    key: imagePath,
  };
}
