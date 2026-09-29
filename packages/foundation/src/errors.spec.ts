/**
 * Tests for structured portable errors.
 *
 * Consumers never parse error strings: every expected failure is a
 * `FroglightError` subclass carrying a stable machine-readable `code`.
 */

import { describe, expect, it } from 'vitest';
import {
  FroglightError,
  ServiceDisposedError,
  isFroglightError,
  isVaultError,
  isVaultErrorCode,
  toStructuredError,
  VaultError,
} from './errors.js';
import { workspacePath } from './paths.js';

describe('FroglightError', () => {
  it('carries a stable machine-readable code', () => {
    const error = new FroglightError('NOT_FOUND', 'missing');
    expect(error.code).toBe('NOT_FOUND');
    expect(error.name).toBe('FroglightError');
    expect(error.message).toBe('missing');
  });

  it('is instanceof Error', () => {
    expect(new FroglightError('IO', 'x')).toBeInstanceOf(Error);
  });

  it('preserves the cause option', () => {
    const cause = new Error('root');
    const error = new FroglightError('IO', 'x', { cause });
    expect(error.cause).toBe(cause);
  });
});

describe('VaultError', () => {
  it('carries code and optional path', () => {
    const error = new VaultError('NOT_FOUND', 'missing', { path: workspacePath('a/b') });
    expect(error.code).toBe('NOT_FOUND');
    expect(error.path).toBe('a/b');
    expect(isVaultError(error)).toBe(true);
    expect(isVaultErrorCode(error, 'NOT_FOUND')).toBe(true);
    expect(isVaultErrorCode(error, 'IO')).toBe(false);
  });

  it('defaults path to null', () => {
    expect(new VaultError('IO', 'x').path).toBeNull();
  });

  it('is both a VaultError and a FroglightError', () => {
    const error = new VaultError('ABORTED', 'x');
    expect(isVaultError(error)).toBe(true);
    expect(isFroglightError(error)).toBe(true);
  });
});

describe('ServiceDisposedError', () => {
  it('carries SERVICE_DISPOSED code', () => {
    const error = new ServiceDisposedError();
    expect(error.code).toBe('SERVICE_DISPOSED');
    expect(error.name).toBe('ServiceDisposedError');
  });
});

describe('toStructuredError', () => {
  it('passes FroglightErrors through unchanged', () => {
    const original = new VaultError('IO', 'x');
    expect(toStructuredError(original)).toBe(original);
  });

  it('wraps unknown values with UNKNOWN_ERROR and preserves the cause', () => {
    const wrapped = toStructuredError('boom');
    expect(wrapped).toBeInstanceOf(FroglightError);
    expect(wrapped.code).toBe('UNKNOWN_ERROR');
    expect(wrapped.cause).toBe('boom');

    const cause = new Error('native');
    const wrappedError = toStructuredError(cause);
    expect(wrappedError.message).toBe('native');
    expect(wrappedError.cause).toBe(cause);
  });
});
