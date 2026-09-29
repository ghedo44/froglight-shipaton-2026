/**
 * Structured runtime errors. The runtime distinguishes programmer errors from
 * expected lifecycle failures so consumers never parse messages to determine
 * error kinds (engineering standards).
 */

/** Base class carrying a structured error `code`. */
export class RuntimeError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RuntimeError';
    this.code = code;
  }
}

/** Normalize an unknown thrown value to an `Error` for structured records. */
export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * A required service has no active binding at activation or resolution time.
 * `missing` lists the unresolved tokens (stable identities).
 */
export class MissingRequirementsError extends RuntimeError {
  readonly missing: readonly string[];

  constructor(missing: readonly string[], options?: { cause?: unknown }) {
    super(
      'MISSING_REQUIREMENTS',
      `required service(s) unavailable: ${missing.join(', ')}`,
      options,
    );
    this.name = 'MissingRequirementsError';
    this.missing = missing;
  }
}

/**
 * A second binding for a single-valued token is rejected. The check
 * covers both staged (activating) and committed (active) bindings.
 */
export class DuplicateBindingError extends RuntimeError {
  readonly tokenId: string;

  constructor(tokenId: string, options?: { cause?: unknown }) {
    super(
      'DUPLICATE_BINDING',
      `a binding for service token "${tokenId}" is already reserved; single-valued tokens accept one binding`,
      options,
    );
    this.name = 'DuplicateBindingError';
    this.tokenId = tokenId;
  }
}

/** An operation was attempted on a fiber that is no longer active. */
export class FiberNotActiveError extends RuntimeError {
  readonly fiberId: string;

  constructor(fiberId: string, options?: { cause?: unknown }) {
    super('FIBER_NOT_ACTIVE', `fiber "${fiberId}" is not active`, options);
    this.name = 'FiberNotActiveError';
    this.fiberId = fiberId;
  }
}

/** A slot with the same id already exists in the same scope. */
export class DuplicateSlotError extends RuntimeError {
  readonly slotId: string;

  constructor(slotId: string, options?: { cause?: unknown }) {
    super(
      'DUPLICATE_SLOT',
      `a plugin slot "${slotId}" already exists`,
      options,
    );
    this.name = 'DuplicateSlotError';
    this.slotId = slotId;
  }
}

/** The runtime is already disposed and cannot accept new slots. */
export class RuntimeDisposedError extends RuntimeError {
  constructor(options?: { cause?: unknown }) {
    super('RUNTIME_DISPOSED', 'the runtime has been disposed', options);
    this.name = 'RuntimeDisposedError';
  }
}

/** An effect was added to a scope that has already been disposed. */
export class EffectScopeDisposedError extends RuntimeError {
  constructor(options?: { cause?: unknown }) {
    super(
      'SCOPE_DISPOSED',
      'cannot add an effect to a disposed effect scope',
      options,
    );
    this.name = 'EffectScopeDisposedError';
  }
}

/** Aggregates multiple cleanup failures reported during disposal. */
export class AggregateRuntimeError extends RuntimeError {
  readonly errors: readonly Error[];

  constructor(
    message: string,
    errors: readonly Error[],
    options?: { cause?: unknown },
  ) {
    super('DISPOSAL_FAILED', message, options);
    this.name = 'AggregateRuntimeError';
    this.errors = errors;
  }
}
