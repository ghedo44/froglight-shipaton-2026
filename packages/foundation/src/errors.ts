/**
 * Structured errors for the portable workspace contracts.
 *
 * Consumers must never parse error strings: every expected failure is a
 * `FroglightError` subclass carrying a stable machine-readable `code`.
 * Host error objects are translated inside provider boundaries and never
 * exposed as the public contract.
 */

import type { WorkspacePath } from './paths.js';

/** Stable vault error codes. */
export type VaultErrorCode =
  | 'INVALID_PATH'
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'NOT_DIRECTORY'
  | 'IS_DIRECTORY'
  | 'PERMISSION_DENIED'
  | 'CONFLICT'
  | 'QUOTA_EXCEEDED'
  | 'UNSUPPORTED'
  | 'ABORTED'
  | 'IO';

/** Stable codes for non-vault workspace errors. */
export const ErrorCodes = {
  SERVICE_DISPOSED: 'SERVICE_DISPOSED',
  SESSION_CLOSED: 'SESSION_CLOSED',
  SESSION_BUSY: 'SESSION_BUSY',
  COMMAND_FAILED: 'COMMAND_FAILED',
  COMMAND_NOT_FOUND: 'COMMAND_NOT_FOUND',
  DUPLICATE_COMMAND: 'DUPLICATE_COMMAND',
  INVALID_SETTINGS_KEY: 'INVALID_SETTINGS_KEY',
  DUPLICATE_DOCUMENT_KIND: 'DUPLICATE_DOCUMENT_KIND',
  UNKNOWN_DOCUMENT_KIND: 'UNKNOWN_DOCUMENT_KIND',
  DUPLICATE_OUTLINE_EXTRACTOR: 'DUPLICATE_OUTLINE_EXTRACTOR',
  UNKNOWN_OUTLINE_KIND: 'UNKNOWN_OUTLINE_KIND',
  UNKNOWN_DOCUMENT: 'UNKNOWN_DOCUMENT',
  UNKNOWN_RESOURCE: 'UNKNOWN_RESOURCE',
  DUPLICATE_DOCUMENT: 'DUPLICATE_DOCUMENT',
  WORKSPACE_ROLLBACK_FAILED: 'WORKSPACE_ROLLBACK_FAILED',
  INVALID_ID: 'INVALID_ID',
  RECORD_FORMAT_MISMATCH: 'RECORD_FORMAT_MISMATCH',
  RECORD_VERSION_UNSUPPORTED: 'RECORD_VERSION_UNSUPPORTED',
  RECORD_CORRUPT: 'RECORD_CORRUPT',
  FORMAT_LIMIT_EXCEEDED: 'FORMAT_LIMIT_EXCEEDED',
  UNKNOWN_FORMAT_VERSION: 'UNKNOWN_FORMAT_VERSION',
  DUPLICATE_BLOCK_TYPE: 'DUPLICATE_BLOCK_TYPE',
  UNKNOWN_BLOCK_TYPE: 'UNKNOWN_BLOCK_TYPE',
  INVALID_BLOCK_TYPE_ID: 'INVALID_BLOCK_TYPE_ID',
  DUPLICATE_SURFACE_OBJECT_TYPE: 'DUPLICATE_SURFACE_OBJECT_TYPE',
  INVALID_SURFACE_OBJECT_TYPE_ID: 'INVALID_SURFACE_OBJECT_TYPE_ID',
  DUPLICATE_SURFACE_TOOL: 'DUPLICATE_SURFACE_TOOL',
  INVALID_SURFACE_TOOL_ID: 'INVALID_SURFACE_TOOL_ID',
  UNKNOWN_SURFACE_TOOL: 'UNKNOWN_SURFACE_TOOL',
  INVALID_COMPOSITION_PROVIDER: 'INVALID_COMPOSITION_PROVIDER',
  DUPLICATE_COMPOSITION_PROVIDER: 'DUPLICATE_COMPOSITION_PROVIDER',
  PDF_PASSWORD_REQUIRED: 'PDF_PASSWORD_REQUIRED',
  PDF_PASSWORD_INCORRECT: 'PDF_PASSWORD_INCORRECT',
  PDF_ENCRYPTION_UNSUPPORTED: 'PDF_ENCRYPTION_UNSUPPORTED',
  PDF_CORRUPT: 'PDF_CORRUPT',
  PDF_RESOURCE_LIMIT: 'PDF_RESOURCE_LIMIT',
  PDF_PAGE_OUT_OF_RANGE: 'PDF_PAGE_OUT_OF_RANGE',
  PDF_ASSET_INTEGRITY: 'PDF_ASSET_INTEGRITY',
  PDF_RENDER_CANCELLED: 'PDF_RENDER_CANCELLED',
  PDF_FEATURE_UNSUPPORTED: 'PDF_FEATURE_UNSUPPORTED',
  PDF_PROVIDER_UNAVAILABLE: 'PDF_PROVIDER_UNAVAILABLE',
  // LaTeX provider seam.
  LATEX_PARSE_ERROR: 'LATEX_PARSE_ERROR',
  LATEX_UNSUPPORTED_COMMAND: 'LATEX_UNSUPPORTED_COMMAND',
  LATEX_UNSUPPORTED_PACKAGE: 'LATEX_UNSUPPORTED_PACKAGE',
  LATEX_RESOLVE_DENIED: 'LATEX_RESOLVE_DENIED',
  LATEX_RESOLVE_MISSING: 'LATEX_RESOLVE_MISSING',
  LATEX_CYCLE: 'LATEX_CYCLE',
  LATEX_RESOURCE_LIMIT: 'LATEX_RESOURCE_LIMIT',
  LATEX_RENDER_CANCELLED: 'LATEX_RENDER_CANCELLED',
  LATEX_PROVIDER_UNAVAILABLE: 'LATEX_PROVIDER_UNAVAILABLE',
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
} as const;

export type ErrorCode = VaultErrorCode | (typeof ErrorCodes)[keyof typeof ErrorCodes];

/** Base class for all portable structured errors. */
export class FroglightError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'FroglightError';
    this.code = code;
  }
}

/** A vault operation failure with a stable code and the affected path. */
export class VaultError extends FroglightError {
  override readonly code: VaultErrorCode;
  readonly path: WorkspacePath | null;
  constructor(
    code: VaultErrorCode,
    message: string,
    options?: { readonly path?: WorkspacePath | null; readonly cause?: unknown },
  ) {
    super(code, message, options);
    this.name = 'VaultError';
    this.code = code;
    this.path = options?.path ?? null;
  }
}

/** Raised when an operation is attempted on a disposed workspace service. */
export class ServiceDisposedError extends FroglightError {
  constructor(message = 'the workspace service has been disposed') {
    super(ErrorCodes.SERVICE_DISPOSED, message);
    this.name = 'ServiceDisposedError';
  }
}

/** True if `error` is a structured `FroglightError`. */
export function isFroglightError(error: unknown): error is FroglightError {
  return error instanceof FroglightError;
}

/** True if `error` is a `VaultError` (with or without a path). */
export function isVaultError(error: unknown): error is VaultError {
  return error instanceof VaultError;
}

/** True if `error` is a `VaultError` with the given code. */
export function isVaultErrorCode(error: unknown, code: VaultErrorCode): error is VaultError {
  return error instanceof VaultError && error.code === code;
}

/**
 * Normalize an unknown thrown value into a structured error. Existing
 * `FroglightError`s pass through unchanged; anything else is wrapped with
 * `UNKNOWN_ERROR` and the original value preserved as the cause.
 */
export function toStructuredError(error: unknown): FroglightError {
  if (error instanceof FroglightError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new FroglightError(ErrorCodes.UNKNOWN_ERROR, message, { cause: error });
}
