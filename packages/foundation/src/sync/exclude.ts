/**
 * Default sync exclusion policy.
 *
 * The sync engine is byte-oriented over the logical vault presented by
 * `VaultService` — it never walks a host application directory, so SQLite
 * files, search indexes, preview/thumbnail caches, and other derived state
 * that lives outside the vault are out of scope by construction (they are
 * rebuilt locally ).
 *
 * Inside the logical vault, `.froglight/` portable records (settings,
 * dock layout, plugin records, persistent revisions, recoverable trash) are
 * canonical bytes and DO sync. `.froglight/indexes/` is explicitly disposable
 * derived state and never enters a manifest. This predicate otherwise
 * excludes only transient/host junk that must never become cloud state, and
 * it must stay identical across replicas:
 *
 * - macOS/Windows explorer droppings (`.DS_Store`, `Thumbs.db`,
 *   `Desktop.ini`)
 * - editor/lock temporaries (`*.tmp`, `*.lock`, `*~`, `~$*`, `.~*`,
 *   `*.swp`, `*.swo`)
 *
 * Pure string matching on the basename — no I/O, no platform sniffing —
 * so every device computes the same synced set.
 */

export function isDefaultExcludedSyncPath(path: string): boolean {
  if (path === '.froglight/indexes' || path.startsWith('.froglight/indexes/'))
    return true;
  const slash = path.lastIndexOf('/');
  const base = slash < 0 ? path : path.slice(slash + 1);
  if (base === '.DS_Store' || base === 'Thumbs.db' || base === 'Desktop.ini') {
    return true;
  }
  if (
    base.endsWith('.tmp') ||
    base.endsWith('.lock') ||
    base.endsWith('~') ||
    base.endsWith('.swp') ||
    base.endsWith('.swo')
  ) {
    return true;
  }
  if (base.startsWith('~$') || base.startsWith('.~')) {
    return true;
  }
  return false;
}
