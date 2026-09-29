/**
 * Internal-link consistency.
 *
 * One identity + reveal + split-pane convergence point for every link
 * flavor (picker, paste, menu, copy-link):
 *
 * - copy-link captures identity plus an opaque sub-document address
 *   (Markdown heading slug, block id, notebook page id, whiteboard object
 *   id) in the canonical JSON form `{documentId,kindId,resourceId,address?}`
 *   with fixed key order, so clipboard round-trips are byte-stable;
 * - `parseResourceLink` rejects URL schemes and malformed text with `null`
 *   (never throws), so paste targets show a recoverable error;
 * - `isResourceLinkTarget` provides the shared target validation for every
 *   flavor;
 * - `resolveResourceTarget` resolves by stable identity (`documentId`,
 *   falling back to `resourceId`) — never by path/title — so rename/move
 *   preserves links;
 * - addresses stay opaque `DocumentLocation` vocabulary: this module never
 *   interprets them; the target editor's existing `revealAddress` seam does.
 *
 * Cross-codec note: the `format`/`parse` wire form mirrors the
 *  picker codec (`packages/ui/.../picker/resource-link.ts`) byte for
 * byte — fixed key order (documentId, kindId, resourceId, address?),
 * extra unknown members tolerated when identity members validate, empty
 * addresses rejected. The application spec pins those vectors with
 * hardcoded fixtures (no `@froglight/ui` import) so a drift in either
 * codec fails loudly. This module additionally enforces DoS caps the
 * picker codec does not (destination/identity/address length); fixtures
 * stay within caps so cross-codec compatibility holds.
 */
import {
  FroglightError,
  isResourceTarget,
  resolveDocumentLink,
  splitLinkDestination,
  type DocumentRef,
  type ErrorCode,
  type ResolvedLinkTarget,
  type ResourceTarget,
  type WorkspaceService,
} from '@froglight/foundation';

export { resolveDocumentLink, splitLinkDestination };
export type { ResolvedLinkTarget };
export type { ResourceTarget };

/** Matches `scheme:` prefixes so browser URLs are never link-canonical. */
const URL_SCHEME_PREFIX = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * Max clipboard/paste destination accepted pre-parse (16 KiB, within the
 * 8–16 KiB budget). Over-long input is rejected before `JSON.parse` so a
 * hostile paste cannot force a large parse.
 */
export const MAX_LINK_DESTINATION_LENGTH = 16 * 1024;

/**
 * Max stable-identity member length (`documentId`/`kindId`/`resourceId`).
 * UUID-like identities are far shorter; 512 bounds hostile payloads
 * without affecting legitimate links.
 */
export const MAX_LINK_ID_LENGTH = 512;

/**
 * Max opaque address length. Mirrors the block-page codec
 * `maxResourceAddress` (4_096) so link addresses can never smuggle a
 * payload the canonical codec would reject.
 */
export const MAX_LINK_ADDRESS_LENGTH = 4_096;

/**
 * Max sanitized link-path candidate length (workspace path + `.md`).
 * Legitimate note paths are far shorter; over-long candidates are
 * rejected instead of creating absurd documents.
 */
export const MAX_LINK_PATH_LENGTH = 1_024;

/**
 * Stable link-failure codes, carried as `FroglightError.code`
 * (the `DUPLICATE_COMMAND` pattern: `error instanceof FroglightError &&
 * error.code === LINK_ERROR_CODES.X`). Callers must never parse error
 * strings.
 */
export const LINK_ERROR_CODES = {
  /** Malformed copy-link JSON or a divergent (non-identity) target. */
  INVALID_RESOURCE_LINK: 'INVALID_RESOURCE_LINK',
  /** Well-formed identity target that resolves to no known document. */
  UNKNOWN_RESOURCE_TARGET: 'UNKNOWN_RESOURCE_TARGET',
  /** A destination that can never become a document (URL, bad path, oversize). */
  INVALID_LINK_DESTINATION: 'INVALID_LINK_DESTINATION',
} as const;

export type LinkErrorCode =
  (typeof LINK_ERROR_CODES)[keyof typeof LINK_ERROR_CODES];

/** Build a coded link failure (never a bare `Error`). */
export function linkError(code: LinkErrorCode, message: string): FroglightError {
  return new FroglightError(code as unknown as ErrorCode, message);
}

/**
 * Serialize a `ResourceTarget` to its stable clipboard form. Key order is
 * fixed (documentId, kindId, resourceId, address?) so identical targets
 * always produce identical strings. Mirrors the picker codec.
 * Empty addresses are omitted (never serialized as `""`), mirroring
 * `resourceTargetForDocument`.
 */
export function formatResourceLink(target: ResourceTarget): string {
  const ordered: Record<string, string> = {
    documentId: target.documentId,
    kindId: target.kindId,
    resourceId: target.resourceId,
  };
  if (target.address !== undefined && target.address !== '')
    ordered.address = target.address;
  return JSON.stringify(ordered);
}

/**
 * Parse clipboard/paste text back to a `ResourceTarget`. Returns the target
 * when the text is exactly `formatResourceLink` output (extra unknown
 * members are ignored only when the identity members validate); otherwise
 * returns `null`. Never throws and never resolves browser URLs: strings
 * starting with a URL scheme are rejected outright. Non-string input,
 * over-long input, over-long identity members, and over-long addresses
 * are rejected with `null`.
 */
export function parseResourceLink(text: unknown): ResourceTarget | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (trimmed.length > MAX_LINK_DESTINATION_LENGTH) return null;
  if (URL_SCHEME_PREFIX.test(trimmed)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isResourceLinkTarget(parsed)) return null;
  const target = parsed as ResourceTarget;
  return {
    documentId: target.documentId,
    kindId: target.kindId,
    resourceId: target.resourceId,
    ...(target.address !== undefined ? { address: target.address } : {}),
  };
}

/**
 * The single target validation every link flavor converges on
 * (picker/paste/menu/copy-link): `isResourceTarget`-class semantics plus
 * DoS caps (identity members ≤512, address ≤ codec max). Path/title-shaped
 * payloads are not identity targets and fail here.
 */
export function isResourceLinkTarget(
  value: unknown,
): value is ResourceTarget {
  if (!isResourceTarget(value)) return false;
  const target = value as ResourceTarget;
  if (
    target.documentId.length > MAX_LINK_ID_LENGTH ||
    target.kindId.length > MAX_LINK_ID_LENGTH ||
    target.resourceId.length > MAX_LINK_ID_LENGTH
  ) {
    return false;
  }
  if (
    target.address !== undefined &&
    target.address.length > MAX_LINK_ADDRESS_LENGTH
  ) {
    return false;
  }
  return true;
}

/**
 * Build the stable copy-link target for a document plus an optional opaque
 * sub-document address (heading slug / block id / page id / object id).
 */
export function resourceTargetForDocument(
  ref: DocumentRef,
  address?: string,
): ResourceTarget {
  return {
    documentId: String(ref.documentId),
    kindId: String(ref.kindId),
    resourceId: String(ref.location.resourceId),
    ...(address !== undefined && address !== '' ? { address } : {}),
  };
}

export interface ResolvedResourceTarget {
  readonly ref: DocumentRef;
  /** Opaque sub-document address carried verbatim to `revealAddress`. */
  readonly address?: string;
}

/**
 * Resolve a validated `ResourceTarget` by stable identity. `documentId` is
 * primary; `resourceId` is the fallback for links written before a vault
 * re-id. Paths/titles are never consulted, so rename/move preserves links.
 * Returns `null` for divergent payloads and unknown identities.
 */
export function resolveResourceTarget(
  workspace: WorkspaceService,
  target: unknown,
): ResolvedResourceTarget | null {
  if (!isResourceTarget(target)) return null;
  const documents = workspace.listDocuments();
  const byDocument = documents.find(
    (ref) => String(ref.documentId) === target.documentId,
  );
  if (byDocument !== undefined) {
    return target.address === undefined
      ? { ref: byDocument }
      : { ref: byDocument, address: target.address };
  }
  const byResource = documents.find(
    (ref) => String(ref.location.resourceId) === target.resourceId,
  );
  if (byResource === undefined) return null;
  return target.address === undefined
    ? { ref: byResource }
    : { ref: byResource, address: target.address };
}
