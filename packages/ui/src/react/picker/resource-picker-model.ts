/**
 * Shared surface reference picker model.
 *
 * Pure, headless filtering + keyboard index + recent-store helpers for the
 * Whiteboard/Notebook surface reference picker. No DOM, no React, no
 * workspace access: the React shell supplies `ResourceSuggestion[]` from
 * `packages/application/src/resource-resolver.ts` (no store fork) and this
 * module decides what is visible, what is active, and what the empty state
 * says.
 *
 * - search: case-insensitive substring over label/detail/addresses/views;
 * - recent: MRU of picked targets shown when the query is empty;
 * - keyboard: ArrowUp/Down/Home/End + Enter/Escape contract (index helpers);
 * - empty state: explicit copy when a non-empty query matches nothing.
 */

import type {
  ResourceSuggestion,
  ResourceTarget,
} from '@froglight/foundation';

/** Copy shown when a non-empty query matches nothing. */
export function noMatchCopy(query: string): string {
  const trimmed = query.trim();
  if (trimmed === '') return '';
  return `No matches for \u201C${trimmed}\u201D. Try a different search or pick from recent.`;
}

/** True when the picker should render the no-match empty state. */
export function isNoMatch(
  query: string,
  visible: readonly ResourceSuggestion[],
): boolean {
  return query.trim() !== '' && visible.length === 0;
}

function haystackOf(suggestion: ResourceSuggestion): string {
  const parts: string[] = [suggestion.label];
  if (suggestion.detail !== undefined) parts.push(suggestion.detail);
  for (const entry of suggestion.addresses ?? []) {
    parts.push(entry.label);
    parts.push(entry.address);
  }
  for (const entry of suggestion.views ?? []) parts.push(entry.label);
  return parts.join('\n').toLocaleLowerCase();
}

/**
 * Filter suggestions by a case-insensitive substring query. An empty query
 * returns every suggestion (the shell decides whether to show recent
 * instead); a non-empty query with no hits yields `[]` so the caller
 * renders the no-match empty state via `noMatchCopy`/`isNoMatch`.
 */
export function filterSuggestions(
  query: string,
  suggestions: readonly ResourceSuggestion[],
): ResourceSuggestion[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === '') return [...suggestions];
  return suggestions.filter((suggestion) =>
    haystackOf(suggestion).includes(needle),
  );
}

/** Clamp a candidate active index into `[0, count)`, or -1 when empty. */
export function clampActiveIndex(index: number, count: number): number {
  if (count <= 0) return -1;
  if (index < 0) return 0;
  if (index >= count) return count - 1;
  return index;
}

/** Move the active index for ArrowUp/ArrowDown (clamped, never wraps). */
export function moveActiveIndex(
  current: number,
  direction: -1 | 1,
  count: number,
): number {
  if (count <= 0) return -1;
  return clampActiveIndex(current + direction, count);
}

/** Resolve the active suggestion, or null when the index is out of range. */
export function activeSuggestion(
  suggestions: readonly ResourceSuggestion[],
  activeIndex: number,
): ResourceSuggestion | null {
  if (activeIndex < 0 || activeIndex >= suggestions.length) return null;
  return suggestions[activeIndex] ?? null;
}

// --- Recent store (MRU of picked targets, query-empty affordance) ---

const RECENT_LIMIT = 8;
const RECENT_SEPARATOR = '';

function recentKeyOf(target: ResourceTarget): string {
  return [
    target.documentId,
    target.kindId,
    target.resourceId,
    target.address ?? '',
  ].join(RECENT_SEPARATOR);
}

export interface RecentResourceEntry {
  readonly target: ResourceTarget;
  readonly label: string;
}

/**
 * In-memory MRU of picked resources. The picker shows these when the query
 * is empty so pointer, touch, and keyboard users can reinsert without
 * typing. Bounded (8), deduped by stable identity (never labels/paths),
 * most-recent-first. Hosts may persist the snapshot; the store itself
 * holds no browser storage so headless tests stay deterministic.
 */
export function createRecentResourceStore(
  initial: readonly RecentResourceEntry[] = [],
): {
  list(): readonly RecentResourceEntry[];
  push(target: ResourceTarget, label: string): void;
  clear(): void;
} {
  const entries: RecentResourceEntry[] = [...initial].slice(0, RECENT_LIMIT);
  return {
    list: () => [...entries],
    push: (target, label) => {
      const key = recentKeyOf(target);
      const at = entries.findIndex((entry) => recentKeyOf(entry.target) === key);
      if (at !== -1) entries.splice(at, 1);
      entries.unshift({ target: { ...target }, label });
      while (entries.length > RECENT_LIMIT) entries.pop();
    },
    clear: () => {
      entries.length = 0;
    },
  };
}

export const RESOURCE_PICKER_RECENT_LIMIT = RECENT_LIMIT;
