/**
 * Quick switcher ranking — a keyboard-first palette for jumping between
 * documents (Ctrl/Cmd P). Fuzzy subsequence matching over title and path.
 * The overlay interaction is owned by the React shell.
 */

export interface SwitcherDocument {
  readonly documentId: string;
  readonly title: string;
  readonly path: string;
}

export interface SwitcherHandle {
  close(): void;
}

/** Score a query against a target string; lower is better, Infinity = no match. */
export function fuzzyScore(query: string, target: string): number {
  if (query.length === 0) return 0;
  const haystack = target.toLowerCase();
  const needle = query.toLowerCase();
  let score = 0;
  let searchFrom = 0;
  let consecutive = 0;
  for (const character of needle) {
    const index = haystack.indexOf(character, searchFrom);
    if (index < 0) return Number.POSITIVE_INFINITY;
    // Reward consecutive hits and word starts; penalize distance.
    score += index === searchFrom ? 0 : 1 + Math.min(4, index - searchFrom);
    if (index > 0 && /[\s/_-]/.test(haystack[index - 1] ?? '')) score -= 2;
    consecutive = index === searchFrom ? consecutive + 1 : 0;
    score -= Math.min(consecutive, 3) * 0.5;
    searchFrom = index + 1;
  }
  return score - (haystack.startsWith(needle) ? 3 : 0);
}

/**
 * Rank documents for a query. Returns at most `limit` matches, best first.
 */
export function rankDocuments(
  documents: readonly SwitcherDocument[],
  query: string,
  limit = 12,
): readonly { document: SwitcherDocument; positions: number[] }[] {
  const trimmed = query.trim();
  const scored: { document: SwitcherDocument; score: number }[] = [];
  for (const document of documents) {
    const haystack = `${document.title} ${document.path}`;
    const score = fuzzyScore(trimmed, haystack);
    if (score !== Number.POSITIVE_INFINITY) scored.push({ document, score });
  }
  scored.sort((a, b) => a.score - b.score || a.document.path.localeCompare(b.document.path));
  return scored.slice(0, limit).map(({ document }) => ({
    document,
    positions: subsequencePositions(trimmed, `${document.title}`),
  }));
}

function subsequencePositions(query: string, target: string): number[] {
  const positions: number[] = [];
  if (query.length === 0) return positions;
  const haystack = target.toLowerCase();
  const needle = query.toLowerCase();
  let searchFrom = 0;
  for (const character of needle) {
    const index = haystack.indexOf(character, searchFrom);
    if (index < 0) break;
    positions.push(index);
    searchFrom = index + 1;
  }
  return positions;
}
