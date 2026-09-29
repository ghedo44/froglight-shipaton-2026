// Picker filter/keyboard/empty-state specs (V3).
import { describe, expect, it } from 'vitest';
import type { ResourceSuggestion } from '@froglight/foundation';
import {
  activeSuggestion,
  clampActiveIndex,
  createRecentResourceStore,
  filterSuggestions,
  isNoMatch,
  moveActiveIndex,
  noMatchCopy,
} from './resource-picker-model.js';

function suggestion(
  label: string,
  target: Partial<ResourceSuggestion['target']> = {},
  extra: Partial<ResourceSuggestion> = {},
): ResourceSuggestion {
  return {
    target: {
      documentId: 'doc',
      kindId: 'froglight.markdown',
      resourceId: label.toLowerCase().replace(/\s+/g, '-'),
      ...target,
    } as ResourceSuggestion['target'],
    label,
    ...extra,
  };
}

describe('resource picker model', () => {
  it('matches case-insensitively across label, detail, addresses, and views', () => {
    const items = [
      suggestion('Meeting notes', {}, { detail: 'weekly sync' }),
      suggestion('Roadmap', {}, { addresses: [{ address: 'top', label: 'Vision' }] }),
      suggestion('Board', {}, { views: [{ viewId: 'v1', label: 'Kanban' }] }),
    ];
    expect(filterSuggestions('meeting', items).map((entry) => entry.label)).toEqual([
      'Meeting notes',
    ]);
    expect(filterSuggestions('WEEKLY', items).map((entry) => entry.label)).toEqual([
      'Meeting notes',
    ]);
    expect(filterSuggestions('vision', items).map((entry) => entry.label)).toEqual([
      'Roadmap',
    ]);
    expect(filterSuggestions('kanban', items).map((entry) => entry.label)).toEqual([
      'Board',
    ]);
  });

  it('returns everything on an empty query and nothing on an unmatched query', () => {
    const items = [suggestion('Alpha'), suggestion('Beta')];
    expect(filterSuggestions('', items)).toHaveLength(2);
    expect(filterSuggestions('   ', items)).toHaveLength(2);
    expect(filterSuggestions('zzz-nope', items)).toEqual([]);
  });

  it('reports the no-match empty state only for non-empty queries with zero hits', () => {
    expect(isNoMatch('zzz', [])).toBe(true);
    expect(isNoMatch('zzz', [suggestion('A')])).toBe(false);
    expect(isNoMatch('', [])).toBe(false);
    expect(isNoMatch('   ', [])).toBe(false);
    expect(noMatchCopy('zzz')).toContain('No matches');
    expect(noMatchCopy('zzz')).toContain('zzz');
    expect(noMatchCopy('')).toBe('');
  });

  it('clamps keyboard movement without wrapping', () => {
    expect(moveActiveIndex(0, 1, 3)).toBe(1);
    expect(moveActiveIndex(2, 1, 3)).toBe(2);
    expect(moveActiveIndex(0, -1, 3)).toBe(0);
    expect(moveActiveIndex(0, 1, 0)).toBe(-1);
    expect(clampActiveIndex(99, 2)).toBe(1);
    expect(clampActiveIndex(-5, 2)).toBe(0);
    expect(clampActiveIndex(0, 0)).toBe(-1);
  });

  it('resolves the active suggestion or null out of range', () => {
    const items = [suggestion('A'), suggestion('B')];
    expect(activeSuggestion(items, 1)?.label).toBe('B');
    expect(activeSuggestion(items, 2)).toBeNull();
    expect(activeSuggestion(items, -1)).toBeNull();
    expect(activeSuggestion([], 0)).toBeNull();
  });

  it('keeps an MRU of recent picks bounded and deduped by stable identity', () => {
    const store = createRecentResourceStore();
    const target = (id: string) => ({
      documentId: 'doc',
      kindId: 'froglight.markdown',
      resourceId: id,
    });
    store.push(target('a') as never, 'A');
    store.push(target('b') as never, 'B');
    store.push(target('a') as never, 'A renamed');
    const labels = store.list().map((entry) => entry.label);
    expect(labels).toEqual(['A renamed', 'B']);
    for (let index = 0; index < 12; index += 1) {
      store.push(target(`r${index}`) as never, `R${index}`);
    }
    expect(store.list()).toHaveLength(8);
    expect(store.list()[0]?.label).toBe('R11');
  });

  it('treats address as part of recent identity', () => {
    const store = createRecentResourceStore();
    store.push(
      { documentId: 'd', kindId: 'k', resourceId: 'r', address: 'a1' } as never,
      'A1',
    );
    store.push(
      { documentId: 'd', kindId: 'k', resourceId: 'r', address: 'a2' } as never,
      'A2',
    );
    expect(store.list()).toHaveLength(2);
  });
});
