import { describe, expect, it } from 'vitest';
import { buildNotePath, sanitizeNoteName } from './noteCreation.js';

describe('sanitizeNoteName', () => {
  it('trims whitespace and replaces backslashes', () => {
    expect(sanitizeNoteName('  my\\note  ')).toBe('my-note');
  });

  it('strips control characters', () => {
    expect(sanitizeNoteName('ab')).toBe('ab');
  });

  it('falls back to Untitled for empty or dot-only names', () => {
    expect(sanitizeNoteName('   ')).toBe('Untitled');
    expect(sanitizeNoteName('.')).toBe('Untitled');
    expect(sanitizeNoteName('..')).toBe('Untitled');
  });

  it('keeps ordinary names untouched', () => {
    expect(sanitizeNoteName('Meeting notes 2026')).toBe('Meeting notes 2026');
  });
});

describe('buildNotePath', () => {
  it('joins the sanitized name with a normalized extension', () => {
    expect(buildNotePath('hello', 'md')).toBe('hello.md');
    expect(buildNotePath('hello', '.md')).toBe('hello.md');
  });

  it('sanitizes hostile names before joining', () => {
    expect(buildNotePath('  a\\b  ', '.md')).toBe('a-b.md');
    expect(buildNotePath('', 'md')).toBe('Untitled.md');
  });
});
