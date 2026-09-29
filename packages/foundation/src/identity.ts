/**
 * Opaque workspace identities.
 *
 * `ResourceId`, `DocumentId`, and `DocumentKindId` are branded opaque
 * identifiers. They are never aliases for paths: a document keeps its
 * identity when its resource is moved or renamed, and a path never
 * functions as an identity. Identities are stable, portable values that can
 * be persisted in workspace metadata records.
 */

import { ErrorCodes, FroglightError } from './errors.js';

/** Identity of one canonical resource inside a workspace vault. */
export type ResourceId = string & { readonly __resourceId: unique symbol };

/** Stable identity of a document (which may map to one or more resources). */
export type DocumentId = string & { readonly __documentId: unique symbol };

/** Stable identity of a dynamically registered document kind. */
export type DocumentKindId = string & { readonly __documentKindId: unique symbol };

const MAX_ID_LENGTH = 512;

function validateId(id: string, kind: 'resource' | 'document' | 'document kind'): void {
  if (typeof id !== 'string' || id.length === 0) {
    throw new FroglightError(ErrorCodes.INVALID_ID, `a ${kind} id must be a non-empty string`);
  }
  if (id.length > MAX_ID_LENGTH) {
    throw new FroglightError(
      ErrorCodes.INVALID_ID,
      `a ${kind} id must be at most ${MAX_ID_LENGTH} characters`,
    );
  }
  if (id.includes('\0') || id.includes('\\')) {
    throw new FroglightError(
      ErrorCodes.INVALID_ID,
      `a ${kind} id must not contain NUL or backslash`,
    );
  }
}

/** Brand a validated string as a `ResourceId`. */
export function resourceId(id: string): ResourceId {
  validateId(id, 'resource');
  return id as ResourceId;
}

/** Brand a validated string as a `DocumentId`. */
export function documentId(id: string): DocumentId {
  validateId(id, 'document');
  return id as DocumentId;
}

/** Brand a validated string as a `DocumentKindId`. */
export function documentKindId(id: string): DocumentKindId {
  validateId(id, 'document kind');
  return id as DocumentKindId;
}

/** Generate a fresh random `ResourceId`. */
export function generateResourceId(): ResourceId {
  return resourceId(randomId());
}

/** Generate a fresh random `DocumentId`. */
export function generateDocumentId(): DocumentId {
  return documentId(randomId());
}

function randomId(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }
  // Deterministic fallback for hosts without crypto.randomUUID (never used
  // by the standard test flows, which pass explicit ids).
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
