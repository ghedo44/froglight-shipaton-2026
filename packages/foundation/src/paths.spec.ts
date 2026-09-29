/**
 * Tests for the portable workspace path contract.
 *
 * Paths are branded strings with strict validity rules: `""` is root,
 * `/` is the only separator, no leading/trailing slashes, no `.`/`..`/
 * empty segments, no NUL or backslash. Spelling, case, and Unicode code
 * points are preserved exactly — the portable layer never normalizes.
 */

import { describe, expect, it } from 'vitest';
import {
  ROOT_PATH,
  assertWorkspacePath,
  isRootPath,
  isWorkspacePath,
  isValidSegment,
  isValidWorkspacePath,
  joinPath,
  parsePath,
  workspacePath,
} from './paths.js';
import { isVaultError, VaultError } from './errors.js';

/** Assert that `fn` throws a VaultError with the given code. */
function expectVaultCode(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.unreachable('expected the call to throw');
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

describe('isValidWorkspacePath', () => {
  it('accepts the root and simple paths', () => {
    expect(isValidWorkspacePath('')).toBe(true);
    expect(isValidWorkspacePath('a')).toBe(true);
    expect(isValidWorkspacePath('a/b/c')).toBe(true);
    expect(isValidWorkspacePath('notes/2024/01.md')).toBe(true);
    expect(isValidWorkspacePath('.hidden')).toBe(true);
    expect(isValidWorkspacePath('a.b/c-d_e')).toBe(true);
  });

  it('rejects non-string values', () => {
    expect(isValidWorkspacePath(null)).toBe(false);
    expect(isValidWorkspacePath(undefined)).toBe(false);
    expect(isValidWorkspacePath(42)).toBe(false);
    expect(isValidWorkspacePath({})).toBe(false);
    expect(isValidWorkspacePath(['a'])).toBe(false);
  });

  it('rejects leading and trailing slashes', () => {
    expect(isValidWorkspacePath('/')).toBe(false);
    expect(isValidWorkspacePath('/a')).toBe(false);
    expect(isValidWorkspacePath('a/')).toBe(false);
    expect(isValidWorkspacePath('/a/b')).toBe(false);
    expect(isValidWorkspacePath('a/b/')).toBe(false);
  });

  it('rejects dot segments and empty segments', () => {
    expect(isValidWorkspacePath('.')).toBe(false);
    expect(isValidWorkspacePath('..')).toBe(false);
    expect(isValidWorkspacePath('a/../b')).toBe(false);
    expect(isValidWorkspacePath('a/./b')).toBe(false);
    expect(isValidWorkspacePath('a/..')).toBe(false);
    expect(isValidWorkspacePath('a//b')).toBe(false);
    expect(isValidWorkspacePath('a/b//c')).toBe(false);
  });

  it('rejects NUL and backslash anywhere', () => {
    expect(isValidWorkspacePath('a\0b')).toBe(false);
    expect(isValidWorkspacePath('a\\b')).toBe(false);
    expect(isValidWorkspacePath('\\')).toBe(false);
    expect(isValidWorkspacePath('a/b\\c')).toBe(false);
  });

  it('preserves user spelling, case, and Unicode exactly', () => {
    // Case is preserved: the portable layer never lowercases.
    expect(isValidWorkspacePath('MixedCase/FileName.md')).toBe(true);
    // Unicode code points are preserved; no silent normalization.
    expect(isValidWorkspacePath('你好/文件.md')).toBe(true);
    expect(isValidWorkspacePath('emoji-😀/note.txt')).toBe(true);
    expect(isValidWorkspacePath('café/e\u0301.md')).toBe(true);
  });
});

describe('workspacePath branding', () => {
  it('brands valid input and preserves the exact value', () => {
    expect(workspacePath('')).toBe('');
    expect(workspacePath('a/b')).toBe('a/b');
    expect(workspacePath('MixedCase-你好-😀-e\u0301.txt')).toBe('MixedCase-你好-😀-e\u0301.txt');
  });

  it('throws INVALID_PATH with the input for invalid input', () => {
    for (const bad of ['/', '/a', 'a/', 'a//b', '.', '..', 'a/../b', 'a/./b', 'a\\b', '\\', 'a\0b']) {
      expectVaultCode(() => workspacePath(bad), 'INVALID_PATH');
    }
  });
});

describe('isWorkspacePath / assertWorkspacePath', () => {
  it('isWorkspacePath never throws', () => {
    expect(isWorkspacePath('a/b')).toBe(true);
    expect(isWorkspacePath('/a')).toBe(false);
    expect(isWorkspacePath(5)).toBe(false);
  });

  it('assertWorkspacePath narrows or throws INVALID_PATH', () => {
    const value: unknown = 'a/b';
    assertWorkspacePath(value);
    expect(value).toBe('a/b');

    expectVaultCode(() => assertWorkspacePath('a/..'), 'INVALID_PATH');
    expectVaultCode(() => assertWorkspacePath(undefined), 'INVALID_PATH');
  });
});

describe('parsePath', () => {
  it('returns [] for the root and splits otherwise', () => {
    expect(parsePath(ROOT_PATH)).toEqual([]);
    expect(parsePath(workspacePath('a'))).toEqual(['a']);
    expect(parsePath(workspacePath('a/b/c'))).toEqual(['a', 'b', 'c']);
  });

  it('preserves segment spelling exactly', () => {
    expect(parsePath(workspacePath('Mixed/你好/😀'))).toEqual(['Mixed', '你好', '😀']);
  });
});

describe('isRootPath', () => {
  it('is true only for the root', () => {
    expect(isRootPath(ROOT_PATH)).toBe(true);
    expect(isRootPath(workspacePath('a'))).toBe(false);
  });
});

describe('joinPath', () => {
  it('joins segments onto a prefix', () => {
    expect(joinPath(ROOT_PATH, 'a')).toBe('a');
    expect(joinPath(workspacePath('a/b'), 'c')).toBe('a/b/c');
    expect(joinPath(workspacePath('a'), 'b', 'c')).toBe('a/b/c');
  });

  it('rejects invalid segments with INVALID_PATH', () => {
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a\0b']) {
      expectVaultCode(() => joinPath(ROOT_PATH, bad), 'INVALID_PATH');
    }
  });

  it('rejects an invalid prefix', () => {
    expectVaultCode(() => joinPath('/bad' as never, 'a'), 'INVALID_PATH');
  });
});

describe('isValidSegment', () => {
  it('accepts plain names', () => {
    expect(isValidSegment('a')).toBe(true);
    expect(isValidSegment('.hidden')).toBe(true);
    expect(isValidSegment('file name.md')).toBe(true);
    expect(isValidSegment('你好')).toBe(true);
  });

  it('rejects separators, dots, empty, NUL, backslash', () => {
    expect(isValidSegment('')).toBe(false);
    expect(isValidSegment('.')).toBe(false);
    expect(isValidSegment('..')).toBe(false);
    expect(isValidSegment('a/b')).toBe(false);
    expect(isValidSegment('a\\b')).toBe(false);
    expect(isValidSegment('a\0b')).toBe(false);
    expect(isValidSegment(5)).toBe(false);
  });
});

describe('error shape', () => {
  it('thrown path errors are VaultErrors with a stable code', () => {
    try {
      workspacePath('a/..');
      expect.unreachable();
    } catch (error) {
      expect(isVaultError(error)).toBe(true);
      expect(error).toBeInstanceOf(VaultError);
      expect((error as VaultError).code).toBe('INVALID_PATH');
    }
  });
});