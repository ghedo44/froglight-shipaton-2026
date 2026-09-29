/**
 * Shared LaTeX presentation helpers.
 *
 * The source-only editor (`latex.ts`, edit mode) and the sandboxed preview
 * reader (`latex-reader.ts`, reading mode) both build on these primitives.
 * Neither owns canonical bytes: preview state is always derived.
 */

import type {
  DocumentSession,
  LaTeXDiagnostic,
  LaTeXProvider,
  LaTeXSourceResolver,
} from '@froglight/foundation';
import { extractLaTeXStructure, slugify } from '@froglight/foundation';

/** Sandbox for the preview iframe: same-origin, deliberately no scripts. */
export const PREVIEW_SANDBOX = 'allow-same-origin';

/**
 * Render-capability dependencies shared by the LaTeX source editor
 * (edit-time diagnostics) and the LaTeX reader (reading-mode preview).
 */
export interface LatexRenderDeps {
  /** Active render capability; null degrades to a notice/placeholder. */
  readonly latexProvider: () => LaTeXProvider | null;
  /** Vault-backed resolver for the given document path, or null. */
  readonly createResolver: (documentPath: string) => LaTeXSourceResolver | null;
  /** Real workspace path of the document, when known. */
  readonly resolveDocumentPath: (session: DocumentSession) => string | null;
  /** Debounce for provider re-renders. */
  readonly renderDebounceMillis?: number;
}

/**
 * Outline address resolved to a source section.
 *
 * Mirrors the extractor (`packages/application/src/outline/latex.ts`)
 * slug assignment verbatim so outline row addresses round-trip: sections
 * only (level 1–3), plain-text titles via the canonical foundation parser,
 * markdown-style `slugify` with first-bare/then-`-1`/`-2` dedup, and the
 * `section-<line>` fallback for titles whose slug is empty. Empty titles
 * are skipped, matching the extractor.
 *
 * `occurrence` is the 0-based ordinal among sections sharing the same
 * plain-text title, so the reading preview can scroll to the nth matching
 * heading deterministically for duplicate titles.
 */
export interface ResolvedLatexAddress {
  readonly title: string;
  readonly level: number;
  readonly line: number;
  readonly occurrence: number;
}

/** Markdown-style dedup: first `base`, then `base-1`, `base-2`, ... skipping globally used slugs. */
function uniqueSlug(base: string, used: ReadonlySet<string>): string {
  if (!used.has(base)) return base;
  let counter = 1;
  while (used.has(`${base}-${counter}`)) counter += 1;
  return `${base}-${counter}`;
}

/**
 * Resolve an outline address to its source section. Unknown addresses
 * return null (silent no-op/miss at the call sites) and never throw.
 * Current outline slug addresses and exact plain-text title addresses resolve;
 * title addresses select the first matching section.
 */
export function resolveLatexAddress(
  raw: string,
  address: string,
): ResolvedLatexAddress | null {
  if (typeof raw !== 'string' || typeof address !== 'string' || address === '')
    return null;
  const { sections } = extractLaTeXStructure(raw);
  const used = new Set<string>();
  const titleOrdinals = new Map<string, number>();
  const slugs: Array<{ slug: string; resolved: ResolvedLatexAddress }> = [];
  for (const section of sections) {
    if (section.level < 1 || section.level > 3) continue;
    if (section.title === '') continue;
    let base = slugify(section.title);
    if (base === '') base = `section-${section.line}`;
    const slug = uniqueSlug(base, used);
    used.add(slug);
    const occurrence = titleOrdinals.get(section.title) ?? 0;
    titleOrdinals.set(section.title, occurrence + 1);
    const resolved: ResolvedLatexAddress = {
      title: section.title,
      level: section.level,
      line: section.line,
      occurrence,
    };
    slugs.push({ slug, resolved });
  }
  const slugHit = slugs.find((entry) => entry.slug === address);
  if (slugHit !== undefined) return slugHit.resolved;
  // Exact-title addresses select the first matching section. Commented-out
  // sections never resolve: the canonical foundation parser masks comments,
  // so Ghost rows stay unknown -> null.
  const titleHit = slugs.find((entry) => entry.resolved.title === address);
  if (titleHit !== undefined) return titleHit.resolved;
  return null;
}

export function diagnosticLabel(diagnostic: LaTeXDiagnostic): string {
  if (diagnostic.code === 'LATEX_PARSE_ERROR') return 'Parse error';
  if (diagnostic.code === 'LATEX_UNSUPPORTED_COMMAND') return 'Unsupported';
  if (diagnostic.code === 'LATEX_UNSUPPORTED_PACKAGE') return 'Package';
  if (diagnostic.code === 'LATEX_CYCLE') return 'Cycle';
  if (diagnostic.code === 'LATEX_RESOURCE_LIMIT') return 'Limit';
  if (diagnostic.code === 'LATEX_RESOLVE_DENIED') return 'Denied';
  if (diagnostic.code === 'LATEX_RESOLVE_MISSING') return 'Missing';
  return 'Note';
}

/** Minimal recoverable placeholder shown inside the reading preview. */
export function latexPlaceholderDocument(title: string, body: string): string {
  const escape = (text: string): string =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Placeholders carry the same script/network-dead CSP as provider output
  // (defense in depth alongside the iframe sandbox).
  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    'img-src blob: data:',
    'font-src data:',
  ].join('; ');
  return (
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    '<style>html{color-scheme:light dark;background:var(--fl-surface-editor,#fff);}' +
    'body{font-family:sans-serif;color:var(--fl-text-secondary,#555);background:var(--fl-surface-editor,#fff);padding:24px;max-width:640px;margin:max(0px,var(--_fl-editor-floating-top,0px)) auto 0;}h1{font-size:16px;color:var(--fl-text-primary,#37352f);}</style>' +
    '</head><body>' +
    `<h1>${escape(title)}</h1><p>${escape(body)}</p>` +
    '</body></html>'
  );
}
