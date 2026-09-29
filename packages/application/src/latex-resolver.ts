/**
 * Vault-backed `LaTeXSourceResolver` factory.
 *
 * The flattener hands the resolver references relative to the entry
 * document's directory (possibly `..`-prefixed); this factory joins them
 * against the document's real workspace path, validates the result as a
 * `WorkspacePath`, and enforces per-file limits inside one auditable
 * boundary. Nothing here ever touches host filesystem paths.
 */

import {
  latexDirOf,
  latexError,
  LATEX_LIMITS,
  utf8Decode,
  workspacePath,
  type LaTeXSourceResolver,
  type VaultService,
} from '@froglight/foundation';

/** Join a flattener-relative reference against the real document directory. */
function resolveAgainstDocumentDir(documentPath: string, relative: string): string {
  const dir = latexDirOf(documentPath);
  const combined = dir === '' ? relative : `${dir}/${relative}`;
  const segments: string[] = [];
  for (const part of combined.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (segments.length === 0) {
        throw latexError('LATEX_RESOLVE_DENIED', `reference escapes the workspace root: ${relative}`);
      }
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  if (segments.length === 0) {
    throw latexError('LATEX_RESOLVE_DENIED', `reference resolves to the workspace root: ${relative}`);
  }
  return segments.join('/');
}

const ASSET_MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
};

export interface CreateLaTeXSourceResolverInput {
  /** The active vault (provider service behind the `froglight.vault` token). */
  readonly vault: VaultService;
  /** Real workspace path of the entry document. */
  readonly documentPath: string;
  /**
   * Host-owned URL factory for asset bytes (e.g. blob: URL creation in
   * browser-like hosts). Absent or null means the host cannot serve assets
   * and `assetUrl` fails with `LATEX_RESOLVE_MISSING`.
   */
  readonly createAssetUrl?: (bytes: Uint8Array, mimeType: string) => string | null | undefined;
}

export function createLaTeXSourceResolver(
  input: CreateLaTeXSourceResolverInput,
): LaTeXSourceResolver {
  const { vault, documentPath, createAssetUrl } = input;

  /** Read raw bytes, normalizing vault failures to stable LaTeX errors. */
  async function readVaultBytes(resolvedPath: string): Promise<Uint8Array> {
    try {
      return await vault.read(workspacePath(resolvedPath));
    } catch (error) {
      if ((error as { code?: string }).code === 'NOT_FOUND') {
        throw latexError('LATEX_RESOLVE_MISSING', `referenced file does not exist: ${resolvedPath}`);
      }
      throw error;
    }
  }

  return {
    async readFile(path: string): Promise<string> {
      const resolvedPath = resolveAgainstDocumentDir(documentPath, path);
      const bytes = await readVaultBytes(resolvedPath);
      if (bytes.byteLength > LATEX_LIMITS.maxFileBytes) {
        throw latexError(
          'LATEX_RESOURCE_LIMIT',
          `file exceeds the ${LATEX_LIMITS.maxFileBytes}-byte include limit: ${resolvedPath}`,
        );
      }
      return utf8Decode(bytes);
    },

    async assetUrl(path: string): Promise<string> {
      const resolvedPath = resolveAgainstDocumentDir(documentPath, path);
      const extension = resolvedPath.slice(resolvedPath.lastIndexOf('.') + 1).toLowerCase();
      const mimeType = ASSET_MIME_TYPES[extension];
      if (mimeType === undefined) {
        throw latexError(
          'LATEX_UNSUPPORTED_COMMAND',
          `asset type "${extension}" cannot be previewed: ${resolvedPath}`,
        );
      }
      if (createAssetUrl === undefined || createAssetUrl === null) {
        throw latexError('LATEX_RESOLVE_MISSING', `asset previews are unavailable in this host: ${resolvedPath}`);
      }
      const bytes = await readVaultBytes(resolvedPath);
      if (bytes.byteLength > LATEX_LIMITS.maxAssetBytes) {
        throw latexError(
          'LATEX_RESOURCE_LIMIT',
          `asset exceeds the ${LATEX_LIMITS.maxAssetBytes}-byte limit: ${resolvedPath}`,
        );
      }
      const url = createAssetUrl(bytes, mimeType);
      if (url === null || url === undefined || url === '') {
        throw latexError('LATEX_RESOLVE_MISSING', `asset could not be served: ${resolvedPath}`);
      }
      return url;
    },
  };
}
