/**
 * Engine-owned math/diagram hydration.
 *
 * `renderHTML` in `extensions.ts` emits a static skeleton only
 * (`figure[data-flbp-math|data-flbp-diagram]` + `data-source` + empty
 * preview/source slots). This module hydrates live previews imperatively
 * after each transaction — the same pattern as `#syncCompositionMounts`
 * and `media-view.ts` (engine-owned derived content, never a provider
 * toolbar):
 *
 * - Source text is passed to the renderer as text and shown with
 *   `textContent`; raw block content is never inserted as HTML.
 * - KaTeX renders with `trust: false` (NEVER true) + `strict: 'error'` so
 *   `\href`/`\includegraphics` cannot smuggle `javascript:`/`data:` URLs;
 *   the HTML output is DOM-walked afterwards and dangerous `href`/`src`
 *   values are stripped (defense in depth — never a regex sanitizer).
 * - Mermaid renders with `securityLevel: 'strict'` (NEVER loose); the SVG
 *   output is DOMPurify-sanitized (strips script/event handlers/
 *   `foreignObject`/`javascript:` hrefs) and re-verified with a DOM walk
 *   before insertion. The repo's single DOMPurify copy (shared with
 *   Mermaid's own dependency) is reused — no second sanitizer, and no
 *   hand-rolled regex sanitizer for SVG, ever.
 * - the preview mounts inside an `flbp-md-sandbox` container holding ONLY
 *   sanitized content; scripts inserted via `innerHTML` never execute, and
 *   a post-insert sweep removes anything the sanitizer missed.
 * - KaTeX fonts/CSS ship BUNDLED (`katex.min.css` + fonts via the
 *   bundler): the preview path performs NO fetch — fully offline-local,
 *   no remote font fetch, no network in tests or production.
 * - failure is failure-as-value: invalid source renders the source plus a
 *   TYPED error message. Renderer exception text/stacks NEVER surface in
 *   the document or UI; canonical bytes are never rewritten.
 * - caps: source bytes are capped (`MAX_MATH_DIAGRAM_SOURCE_BYTES`) and
 *   renders race an abortable timeout (`MATH_DIAGRAM_RENDER_TIMEOUT_MS`).
 *   Over-cap sources never reach a renderer.
 * - lazy + settled: each figure re-renders on a debounce after its source
 *   signature changes (never on every keystroke — source edits commit
 *   through semantic controls, not PM text), and only once visible when an
 *   IntersectionObserver is supplied; without one (tests/headless-shaped
 *   DOM) figures render on sync.
 * - missing renderer (lazy `import()` failure) degrades to the source-text
 *   fallback with the `unavailable` typed message; canonical stays intact.
 */

import 'katex/dist/katex.min.css';
import { positionBlockpageOverlay } from './overlay-geometry.js';

export type MathDiagramKind = 'math' | 'diagram';

/** Stable machine-readable preview failure (UI renders a typed message, never raw error text). */
export type MathDiagramError =
  | 'invalid-source'
  | 'too-large'
  | 'unavailable'
  | 'timeout'
  | 'empty-source';

export type MathDiagramOutcome =
  | { readonly ok: true; readonly html: string }
  | { readonly ok: false; readonly error: MathDiagramError };

/**
 * Source-text renderer: resolved per kind on every render so lazy imports
 * stay lazy (dynamic `import()` on first render need only; startup
 * untouched). A `null` renderer means "missing dependency" and degrades to
 * the source-text fallback. Specs inject stubs here (never real network —
 * neither renderer fetches); production uses the lazy defaults below.
 */
export type SourceRenderer = (
  source: string,
  opts: { readonly signal: AbortSignal },
) => Promise<MathDiagramOutcome>;

export interface MathDiagramViewDeps {
  /** Visibility gate for lazy preview (optional; absent renders on sync). */
  readonly observer?: IntersectionObserver | null;
  /** Settle debounce in ms (default `MATH_DIAGRAM_SETTLE_MS`). */
  readonly debounceMs?: number;
}

/** Source-byte cap: over-cap sources never reach a renderer. */
export const MAX_MATH_DIAGRAM_SOURCE_BYTES = 64 * 1024;

/** Abortable render timeout, in milliseconds. */
export const MATH_DIAGRAM_RENDER_TIMEOUT_MS = 5_000;

/** Settle debounce, ms: renders run on settled sources, not keystrokes. */
export const MATH_DIAGRAM_SETTLE_MS = 150;

interface TestHooks {
  readonly math?: SourceRenderer | null;
  readonly diagram?: SourceRenderer | null;
  readonly debounceMs?: number;
}

let testHooks: TestHooks | null = null;

/**
 * Test-only renderer seam (no network in tests): stub renderers per kind
 * (a function), force the missing-dependency fallback (`null`), or tune
 * the debounce. `undefined` fields (or a `null` hooks object) restore the
 * lazy production defaults. Production code never calls this.
 */
export function __setMathDiagramTestHooks(hooks: TestHooks | null): void {
  testHooks = hooks;
}

interface MdFigure {
  readonly element: HTMLElement;
  readonly kind: MathDiagramKind;
  readonly source: string;
}

const VISIBLE = new WeakSet<Element>();
const PENDING = new Map<Element, ReturnType<typeof setTimeout>>();
let mermaidCounter = 0;

/** Exported for specs/teardown: cancel every scheduled (debounced) render under `host`. */
export function cancelMathDiagramRenders(host: ParentNode): void {
  for (const [element, timer] of [...PENDING]) {
    if (host.contains(element) || host === element) {
      clearTimeout(timer);
      PENDING.delete(element);
    }
  }
}

/** Mark a figure visible (handle observer callback); the next sync renders it. */
export function markMathDiagramVisible(element: Element): void {
  VISIBLE.add(element);
}

function readFigures(host: ParentNode): MdFigure[] {
  const out: MdFigure[] = [];
  const kinds: Array<[string, MathDiagramKind]> = [
    ['figure[data-flbp-math]', 'math'],
    ['figure[data-flbp-diagram]', 'diagram'],
  ];
  for (const [selector, kind] of kinds) {
    for (const el of host.querySelectorAll(selector)) {
      const host2 = el as HTMLElement;
      out.push({
        element: host2,
        kind,
        source: host2.getAttribute('data-source') ?? '',
      });
    }
  }
  return out;
}

function sourceBytes(source: string): number {
  try {
    return new TextEncoder().encode(source).byteLength;
  } catch {
    return source.length * 4;
  }
}

function docOf(host: ParentNode): Document | null {
  return (
    (host as unknown as { ownerDocument?: Document }).ownerDocument ??
    (typeof document !== 'undefined' ? document : null)
  );
}

function typedMessage(kind: MathDiagramKind, error: MathDiagramError): string {
  const noun = kind === 'math' ? 'LaTeX math' : 'Mermaid diagram';
  switch (error) {
    case 'invalid-source':
      return `${noun} could not be rendered. The source is preserved below.`;
    case 'too-large':
      return `${noun} source exceeds the 64 KB preview cap and was not rendered. It is preserved.`;
    case 'unavailable':
      return `${noun} preview is unavailable. The source is preserved below.`;
    case 'timeout':
      return `${noun} preview timed out. The source is preserved below.`;
    case 'empty-source':
      return `Empty ${kind === 'math' ? 'math' : 'diagram'} block. Set the source to preview it.`;
  }
}

function ensureSlots(
  doc: Document,
  element: HTMLElement,
): {
  preview: HTMLElement;
  src: HTMLElement;
  status: HTMLElement;
} {
  let preview = element.querySelector<HTMLElement>(':scope > .flbp-md-preview');
  if (preview === null) {
    preview = doc.createElement('div');
    preview.className = 'flbp-md-preview flbp-md-sandbox';
    element.appendChild(preview);
  } else {
    // The sandbox marker is load-bearing for the review (the
    // preview host must be recognizable as the sandboxed container even
    // for figures parsed from older HTML without the class).
    preview.classList.add('flbp-md-sandbox');
  }
  let src = element.querySelector<HTMLElement>(':scope > .flbp-md-src');
  if (src === null) {
    src = doc.createElement('div');
    src.className = 'flbp-md-src';
    element.appendChild(src);
  }
  let status = element.querySelector<HTMLElement>(':scope > .flbp-md-status');
  if (status === null) {
    status = doc.createElement('div');
    status.className = 'flbp-md-status';
    element.appendChild(status);
  }
  return { preview, src, status };
}

/** Source-text state: source visible as TEXT, typed error, no preview. */
function renderSourceState(
  doc: Document,
  figure: MdFigure,
  error: MathDiagramError,
): void {
  const { element, source } = figure;
  const { preview, src, status } = ensureSlots(doc, element);
  preview.innerHTML = '';
  preview.hidden = true;
  src.hidden = false;
  // Text-only: the source can carry `<script>`/event-handler
  // LOOKING text — it must never parse as markup.
  src.textContent = source;
  status.textContent = '';
  const message = doc.createElement('span');
  message.className = 'flbp-md-message';
  message.textContent = typedMessage(figure.kind, error);
  status.appendChild(message);
  element.dataset.flbpMdHydrated =
    error === 'empty-source' ? 'empty' : 'source';
  element.dataset.flbpMdReason = error;
}

/** Live state: sanitized output in the sandbox host, source hidden but intact in `data-source`. */
function renderLiveState(doc: Document, figure: MdFigure, html: string): void {
  const { element } = figure;
  const { preview, src, status } = ensureSlots(doc, element);
  src.hidden = true;
  status.textContent = '';
  preview.hidden = false;
  // Sanitized content only (KaTeX post-scan / DOMPurify-verified SVG);
  // `innerHTML`-inserted scripts never execute, and the sweep below removes
  // anything the sanitizer missed before the frame paints.
  preview.innerHTML = html;
  sweepInserted(preview);
  element.dataset.flbpMdHydrated = 'live';
  delete element.dataset.flbpMdReason;
}

/**
 * Post-insert sweep (defense in depth): remove script-capable elements,
 * event-handler attributes, and dangerous URL attributes from freshly
 * inserted preview content. Sanitizers run first; this guarantees the
 * sandbox host holds no executable content even if one regresses. The
 * URL-attribute set matches the re-verify layer exactly (shared
 * `stripDangerousUrlAttributes` pass).
 */
function sweepInserted(root: ParentNode): void {
  const elements =
    root instanceof Element
      ? [root, ...root.querySelectorAll('*')]
      : [...(root as DocumentFragment).querySelectorAll('*')];
  for (const el of elements) {
    const tag = el.tagName.toLowerCase();
    if (
      tag === 'script' ||
      tag === 'iframe' ||
      tag === 'object' ||
      tag === 'embed' ||
      tag === 'link' ||
      tag === 'meta' ||
      tag === 'base' ||
      tag === 'form' ||
      tag === 'foreignobject'
    ) {
      el.remove();
      continue;
    }
    stripDangerousUrlAttributes(el);
  }
}

function isDangerousUrl(value: string): boolean {
  // Control-character smuggling: scheme checks must ignore
  // ASCII control/whitespace bytes THROUGHOUT the value, not just leading
  // whitespace — `java\tscript:` / embedded NULs must not bypass the
  // prefix compare. Strip the full [\u0000-\u0020] range before comparing
  // (media-security precedent rejects such bytes outright at fetch time;
  // here renderer output is already in-DOM text, so strip-then-compare is
  // the fail-closed shape).
  // Strip loop (no regex escape range): drop every char at or below U+0020
  // (C0 controls + space) wherever it sits in the value, then compare.
  let stripped = '';
  for (const ch of value) {
    if ((ch.codePointAt(0) ?? 0) > 0x20) stripped += ch;
  }
  const normalized = stripped.toLowerCase();
  return (
    normalized.startsWith('javascript:') ||
    normalized.startsWith('data:') ||
    normalized.startsWith('vbscript:')
  );
}

/**
 * `srcset` candidates carry URLs (`url [density]` per comma-split entry):
 * dangerous when ANY candidate URL is dangerous.
 */
function isDangerousSrcset(value: string): boolean {
  return value.split(',').some((entry) => {
    const url = entry.trim().split(/\s+/, 1)[0] ?? '';
    return url !== '' && isDangerousUrl(url);
  });
}

/**
 * Inline-style URL check: `style="background: url(javascript:…)"`
 * must not survive the sweep. Only `url(...)` payloads are inspected —
 * plain declarations (`fill:`, `color:`) never match.
 */
function styleHasDangerousUrl(value: string): boolean {
  for (const match of value.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
    if (isDangerousUrl(match[2] ?? '')) return true;
  }
  return false;
}

/**
 * Shared per-element URL-attribute pass (sweep/re-verify
 * alignment): every URL-bearing attribute the preview renderers can emit
 * or pass through is covered — `href`/`src`/namespaced `:href`,
 * `srcset` candidates, `poster`/`formaction`/`data`/`codebase`, and
 * `url(...)` payloads inside `style`. Returns true when the caller must
 * fail closed (re-verify); the sweep variant strips instead — same
 * attribute set, same `isDangerousUrl` predicate, so the composed DOM
 * after `renderLiveState` (sanitize → insert → sweep) can never hold a
 * URL either layer accepts. `data-*` custom attributes are untouched
 * (exact `data` match only — the `<object data>` URL).
 */
function stripDangerousUrlAttributes(el: Element): void {
  for (const attr of [...el.attributes]) {
    const name = attr.name.toLowerCase();
    if (name.startsWith('on')) {
      el.removeAttribute(attr.name);
      continue;
    }
    if (name === 'href' || name === 'src' || name.endsWith(':href')) {
      if (isDangerousUrl(attr.value)) el.removeAttribute(attr.name);
      continue;
    }
    if (name === 'srcset') {
      if (isDangerousSrcset(attr.value)) el.removeAttribute(attr.name);
      continue;
    }
    if (
      name === 'poster' ||
      name === 'formaction' ||
      name === 'data' ||
      name === 'codebase'
    ) {
      if (isDangerousUrl(attr.value)) el.removeAttribute(attr.name);
      continue;
    }
    if (name === 'style') {
      if (styleHasDangerousUrl(attr.value)) el.removeAttribute(attr.name);
    }
  }
  // Preserved https links stay navigable but never tab-nabbing:
  // the sweep is the single insertion funnel (every sanitizer output passes
  // through `renderLiveState`), so forcing `noopener` here covers KaTeX and
  // Mermaid output alike.
  if (el.tagName.toLowerCase() === 'a' && el.hasAttribute('href')) {
    const tokens = (el.getAttribute('rel') ?? '').split(/\s+/).filter(Boolean);
    if (!tokens.includes('noopener')) {
      tokens.push('noopener');
      el.setAttribute('rel', tokens.join(' '));
    }
  }
}

/**
 * KaTeX-output post-scan: `trust: false` already disables
 * `\href`/`\includegraphics`, but the output is DOM-walked anyway and any
 * dangerous URL attribute is stripped. Returns null (fail closed → typed
 * error) only when script-capable ELEMENTS appear, which KaTeX never
 * emits — their presence means the renderer was subverted.
 *
 * Exported for spec pinning (media-security precedent); provider-internal.
 */
export function sanitizeKatexHtml(doc: Document, html: string): string | null {
  const tpl = doc.createElement('template');
  // Template content is inert: markup parses without executing scripts.
  tpl.innerHTML = html;
  for (const el of tpl.content.querySelectorAll('*')) {
    const tag = el.tagName.toLowerCase();
    if (
      tag === 'script' ||
      tag === 'iframe' ||
      tag === 'object' ||
      tag === 'embed' ||
      tag === 'link' ||
      tag === 'meta' ||
      tag === 'base' ||
      tag === 'form' ||
      tag === 'foreignobject'
    ) {
      return null;
    }
    // Same URL-attribute set as the post-insert sweep.
    stripDangerousUrlAttributes(el);
  }
  return tpl.innerHTML;
}

/**
 * Mermaid SVG sanitizer: DOMPurify with the SVG profile, then a
 * DOM re-verification that fails closed (null → typed error) when script
 * elements, `foreignObject`, event handlers, or dangerous URL attributes
 * survive. `data:` hrefs are rejected here to match the sweep:
 * the sweep strips `data:` URLs on insertion, so the re-verify fails
 * closed on them instead of passing an SVG the composed DOM would have to
 * repair — same `isDangerousUrl` predicate, same attribute set on both
 * layers. Never a hand-rolled regex sanitizer for SVG.
 *
 * Exported for spec pinning (media-security precedent); provider-internal.
 */
export async function sanitizeMermaidSvg(
  doc: Document,
  svg: string,
): Promise<string | null> {
  let purify: {
    sanitize(dirty: string, opts: unknown): string;
  } | null = null;
  try {
    const mod = (await import('dompurify')) as unknown as {
      default?: unknown;
    };
    const exported = mod.default ?? mod;
    if (
      typeof exported === 'object' &&
      exported !== null &&
      typeof (exported as { sanitize?: unknown }).sanitize === 'function'
    ) {
      purify = exported as {
        sanitize(dirty: string, opts: unknown): string;
      };
    } else if (
      typeof exported === 'function' &&
      typeof window !== 'undefined'
    ) {
      const factory = exported as (w: Window) => {
        sanitize(dirty: string, opts: unknown): string;
      };
      purify = factory(window);
    }
  } catch {
    purify = null;
  }
  if (purify === null) return null;
  let clean: string;
  try {
    // Mermaid's default node style uses this safe filter primitive. Keeping
    // an empty filter would make its node shapes disappear. HTML labels and
    // every other non-SVG element remain outside the allowed profile.
    clean = purify.sanitize(svg, {
      USE_PROFILES: { svg: true },
      ADD_TAGS: ['feDropShadow'],
    });
  } catch {
    return null;
  }
  // Re-verify with a DOM walk (fail closed): no script, no foreignObject,
  // no event handlers, and no dangerous URL on any URL-bearing attribute
  // (same predicate + attribute set as the sweep).
  const tpl = doc.createElement('template');
  tpl.innerHTML = clean;
  for (const el of tpl.content.querySelectorAll('*')) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'script' || tag === 'foreignobject') return null;
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) return null;
      if (name === 'href' || name === 'src' || name.endsWith(':href')) {
        if (isDangerousUrl(attr.value)) return null;
        continue;
      }
      if (name === 'srcset') {
        if (isDangerousSrcset(attr.value)) return null;
        continue;
      }
      if (
        name === 'poster' ||
        name === 'formaction' ||
        name === 'data' ||
        name === 'codebase'
      ) {
        if (isDangerousUrl(attr.value)) return null;
        continue;
      }
      if (name === 'style') {
        if (styleHasDangerousUrl(attr.value)) return null;
      }
    }
  }
  return tpl.innerHTML;
}

interface KatexModule {
  renderToString(source: string, opts: Record<string, unknown>): string;
}

/** Lazy KaTeX renderer: dynamic import on first render need; `trust: false` NEVER true.*/
async function defaultMathRenderer(
  source: string,
  opts: { readonly signal: AbortSignal },
  doc: Document,
): Promise<MathDiagramOutcome> {
  let katex: KatexModule;
  try {
    katex = ((await import('katex')) as unknown as { default: KatexModule })
      .default;
  } catch {
    // Missing dependency degrades to the source-text fallback.
    return { ok: false, error: 'unavailable' };
  }
  if (opts.signal.aborted) return { ok: false, error: 'timeout' };
  let html: string;
  try {
    // `throwOnError: true` routes failures to the typed-error path below;
    // exception text is DISCARDED (never surfaced). `trust:
    // false` disables \href/\includegraphics URL smuggling; `strict:
    // 'error'` fails closed on HTML-affecting constructs.
    html = katex.renderToString(source, {
      throwOnError: true,
      trust: false,
      strict: 'error',
      displayMode: true,
    });
  } catch {
    return { ok: false, error: 'invalid-source' };
  }
  const clean = sanitizeKatexHtml(doc, html);
  if (clean === null) return { ok: false, error: 'invalid-source' };
  return { ok: true, html: clean };
}

interface MermaidModule {
  initialize(opts: Record<string, unknown>): void;
  render(id: string, text: string): Promise<{ svg: string }>;
}

/** Lazy Mermaid renderer: dynamic import on first render need; `securityLevel: 'strict'` NEVER loose.*/
async function defaultDiagramRenderer(
  source: string,
  opts: { readonly signal: AbortSignal },
  doc: Document,
): Promise<MathDiagramOutcome> {
  let mermaid: MermaidModule;
  try {
    mermaid = (
      (await import('mermaid')) as unknown as { default: MermaidModule }
    ).default;
  } catch {
    return { ok: false, error: 'unavailable' };
  }
  if (opts.signal.aborted) return { ok: false, error: 'timeout' };
  let svg: string;
  try {
    // Strict sandbox config is hardcoded at the call site — no option, no
    // flag, no override path can select 'loose'.
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      // The SVG-only sanitizer intentionally rejects foreignObject labels.
      htmlLabels: false,
    });
    mermaidCounter += 1;
    const safeId = `flbp-mmd-${mermaidCounter}`;
    const result = await mermaid.render(safeId, source);
    svg = result.svg;
  } catch {
    // Parse failures are failure-as-value; exception text is DISCARDED.
    return {
      ok: false,
      error: opts.signal.aborted ? 'timeout' : 'invalid-source',
    };
  }
  if (opts.signal.aborted) return { ok: false, error: 'timeout' };
  const clean = await sanitizeMermaidSvg(doc, svg);
  if (clean === null || clean === '')
    return { ok: false, error: 'invalid-source' };
  return { ok: true, html: clean };
}

function resolveRenderer(kind: MathDiagramKind): SourceRenderer | null {
  const override = kind === 'math' ? testHooks?.math : testHooks?.diagram;
  // A test stub (function) or an explicit missing-dependency marker (null)
  // wins; `undefined` (or no hooks) falls through to the lazy default.
  if (override !== undefined) return override;
  if (kind === 'math') {
    return (source, opts) => {
      const doc = typeof document !== 'undefined' ? document : null;
      if (doc === null)
        return Promise.resolve({ ok: false, error: 'unavailable' } as const);
      return defaultMathRenderer(source, opts, doc);
    };
  }
  return (source, opts) => {
    const doc = typeof document !== 'undefined' ? document : null;
    if (doc === null)
      return Promise.resolve({ ok: false, error: 'unavailable' } as const);
    return defaultDiagramRenderer(source, opts, doc);
  };
}

function renderNow(
  doc: Document,
  figure: MdFigure,
  renderer: SourceRenderer,
  expectedSig: string,
): void {
  PENDING.delete(figure.element);
  // Generation guard (media-view precedent): the source may change while a
  // render is in flight — stale bytes must never paint over newer state.
  if (figure.element.dataset.flbpMdSig !== expectedSig) return;
  if (!figure.element.isConnected) return;
  const controller =
    typeof AbortController === 'function' ? new AbortController() : null;
  const timeoutMs = MATH_DIAGRAM_RENDER_TIMEOUT_MS;
  const timer =
    controller !== null
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;
  const clearTimer = (): void => {
    if (timer !== null) clearTimeout(timer);
  };
  // Race-timeout handle: the standalone timeout below must be
  // cleared when the renderer settles first — otherwise every fast render
  // leaks a 5 s timer that fires into a no-op. Cleared on settle; the
  // debounce timers are already owned by PENDING + cancelMathDiagramRenders.
  let raceTimer: ReturnType<typeof setTimeout> | null = null;
  let settled = false;
  const finish = (outcome: MathDiagramOutcome): void => {
    if (settled) return;
    settled = true;
    if (raceTimer !== null) {
      clearTimeout(raceTimer);
      raceTimer = null;
    }
    clearTimer();
    if (figure.element.dataset.flbpMdSig !== expectedSig) return;
    if (!figure.element.isConnected) return;
    if (outcome.ok) renderLiveState(doc, figure, outcome.html);
    else renderSourceState(doc, figure, outcome.error);
  };
  raceTimer = setTimeout(
    () => finish({ ok: false, error: 'timeout' }),
    timeoutMs,
  );
  void renderer(figure.source, {
    signal: controller?.signal ?? ({ aborted: false } as AbortSignal),
  }).then(finish, () => finish({ ok: false, error: 'invalid-source' }));
}

/**
 * Hydrate every math/diagram figure under `host`. Changed sources schedule
 * a debounced render (settled source only); over-cap sources render the
 * typed error immediately without touching a renderer; with an observer
 * supplied, off-screen figures keep the inspectable source until marked
 * visible via `markMathDiagramVisible`.
 */
export async function syncMathDiagramViews(
  host: ParentNode,
  deps: MathDiagramViewDeps,
): Promise<void> {
  const doc = docOf(host);
  if (doc === null) return;
  const debounceMs =
    testHooks?.debounceMs ?? deps.debounceMs ?? MATH_DIAGRAM_SETTLE_MS;
  for (const figure of readFigures(host)) {
    // Re-hydration guard: unchanged signatures skip (steady typing never
    // re-renders); the signature covers kind + source only — rendered
    // output is derived and never part of it. Deferred→visible transition
    // an observer re-sync after `markMathDiagramVisible`
    // recomputes an IDENTICAL sig for an off-screen figure still showing
    // the deferred source state (kind+source only, no visibility), so the
    // plain identical-sig skip would pin it on `unavailable-source`
    // forever. A deferred figure that is visible now falls through to the
    // debounced render below; genuinely settled identical sigs still skip.
    const sig = `${figure.kind}|${figure.source}`;
    if (figure.element.dataset.flbpMdSig === sig) {
      const deferred =
        figure.element.dataset.flbpMdReason === 'deferred' ||
        figure.element.dataset.flbpMdHydrated === 'deferred';
      if (!(deferred && VISIBLE.has(figure.element))) continue;
      // Fall through: re-stamp the same sig (no-op) and schedule the render.
    }
    figure.element.dataset.flbpMdSig = sig;
    const pending = PENDING.get(figure.element);
    if (pending !== undefined) {
      clearTimeout(pending);
      PENDING.delete(figure.element);
    }
    if (figure.source === '') {
      renderSourceState(doc, figure, 'empty-source');
      continue;
    }
    if (sourceBytes(figure.source) > MAX_MATH_DIAGRAM_SOURCE_BYTES) {
      renderSourceState(doc, figure, 'too-large');
      continue;
    }
    const renderer = resolveRenderer(figure.kind);
    if (renderer === null) {
      // Missing dependency degrades to the source-text fallback.
      renderSourceState(doc, figure, 'unavailable');
      continue;
    }
    if (
      deps.observer !== undefined &&
      deps.observer !== null &&
      !VISIBLE.has(figure.element)
    ) {
      // Lazy preview: stay on the inspectable source until the handle's
      // observer marks the figure visible (explicit visibility, never a
      // background render of off-screen content). The observer callback
      // marks + re-syncs; the re-sync falls through to the debounced
      // render below because the figure is now in the visible set.
      renderSourceState(doc, figure, 'unavailable');
      figure.element.dataset.flbpMdReason = 'deferred';
      figure.element.dataset.flbpMdHydrated = 'deferred';
      try {
        deps.observer.observe(figure.element);
      } catch {
        // Best-effort; the figure still renders on the next visible sync.
      }
      continue;
    }
    if (debounceMs <= 0) {
      renderNow(doc, figure, renderer, sig);
      continue;
    }
    const timer = setTimeout(
      () => renderNow(doc, figure, renderer, sig),
      debounceMs,
    );
    PENDING.set(figure.element, timer);
  }
}

// --- engine-owned source overlay ---
//
// In-place source editing via an engine-owned textarea overlay reusing the
// slash-chrome pattern: absolutely positioned under
// the `flbp-host`, anchored to the live figure/caret rect, committed through
// the semantic `math.source` / `diagram.source` path (single closeHistory
// undo owned by the caller) with the same byte-cap gate. The handle wiring
// lands in (owns `tiptap-handle.ts`); this module owns the overlay
// controller + lazy sandboxed preview so stays inside its allowed
// scope (`math-diagram-view.ts` + math/diagram CSS + spec).
//
// - `mousedown` preventDefault preserves the PM selection (slash precedent)
//   EXCEPT inside the textarea/buttons where focus/typing must work.
// - `Enter` (no Shift) / `Ctrl/Cmd+Enter` commits, `Esc` dismisses, outside
//   pointerdown dismisses — all without mutation except the single commit.
// - touch scroll is never blocked: the container never sets
//   `touch-action: none` and never preventDefaults touchmove/scroll; only
// buttons carry `touch-action: manipulation` (coarse contract).
// - preview reuses the renderer seam (`trust: false` / `strict` /
//   DOMPurify-verified, swept before insert) with settled debounce (lazy);
//   over-cap sources never reach a renderer (typed error, commit refused).
// - headless (no document/host) returns null — callers fall back to the
//   semantic control; readOnly refuses the same way.

export interface MathDiagramOverlayRequest {
  readonly kind: MathDiagramKind;
  readonly blockId: string;
  readonly initialSource: string;
  readonly readOnly?: boolean;
}

export interface MathDiagramOverlayCallbacks {
  /** Single-undo commit (wired to `math.source`/`diagram.source`); called at most once. */
  readonly onCommit: (source: string) => boolean;
  readonly onDismiss?: () => void;
  /** Focus return on close; defaults to the anchor/host when omitted. */
  readonly returnFocus?: () => void;
}

export interface MathDiagramOverlayHandle {
  readonly element: HTMLElement;
  readonly textarea: HTMLTextAreaElement;
  readonly saveButton: HTMLButtonElement;
  readonly cancelButton: HTMLButtonElement;
  readonly preview: HTMLElement;
  readonly status: HTMLElement;
  readonly close: (reason: 'commit' | 'dismiss') => void;
  readonly isOpen: () => boolean;
}

function overlayDocOf(host: ParentNode): Document | null {
  return docOf(host);
}

function isOverlayInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return (
    tag === 'textarea' ||
    tag === 'input' ||
    tag === 'button' ||
    target.isContentEditable
  );
}

/** True when `host` holds an open math/diagram overlay. */
export function isMathDiagramOverlayOpen(host: ParentNode): boolean {
  try {
    return host.querySelector(':scope > .flbp-md-overlay') !== null;
  } catch {
    // `:scope` unsupported (older engines): fall back to a flat query.
    return host.querySelector('.flbp-md-overlay') !== null;
  }
}

/** Close (dismiss) any open math/diagram overlay under `host`. */
export function closeMathDiagramOverlay(host: ParentNode): void {
  let overlay: Element | null = null;
  try {
    overlay = host.querySelector(':scope > .flbp-md-overlay');
  } catch {
    overlay = host.querySelector('.flbp-md-overlay');
  }
  if (overlay instanceof HTMLElement) {
    // Dispatch dismissal through the handle when present so focus return +
    // onDismiss run; otherwise remove directly (teardown path).
    const closer = (
      overlay as unknown as {
        __flbpMdClose?: (reason: 'commit' | 'dismiss') => void;
      }
    ).__flbpMdClose;
    if (typeof closer === 'function') closer('dismiss');
    else overlay.remove();
  }
}

function positionOverlay(
  host: HTMLElement,
  overlay: HTMLElement,
  anchor: HTMLElement | null,
): void {
  try {
    const box =
      anchor !== null && anchor.isConnected
        ? anchor.getBoundingClientRect()
        : host.getBoundingClientRect();
    positionBlockpageOverlay(host, overlay, {
      left: box.left,
      top: box.top,
      right: box.right,
      bottom: box.bottom,
      width: box.width,
      height: box.height,
    });
  } catch {
    overlay.style.left = `${host.scrollLeft + 8}px`;
    overlay.style.top = `${host.scrollTop + 8}px`;
  }
}

/**
 * Open the engine-owned source overlay. Returns null headlessly (no
 * document), without a host element, when readOnly, or when the host is
 * detached — callers fall back to the semantic `math.source` /
 * `diagram.source` control. At most one overlay per host (re-open closes).
 */
export function openMathDiagramOverlay(
  host: HTMLElement,
  anchor: HTMLElement | null,
  request: MathDiagramOverlayRequest,
  callbacks: MathDiagramOverlayCallbacks,
): MathDiagramOverlayHandle | null {
  if (typeof document === 'undefined') return null;
  if (!(host instanceof HTMLElement)) return null;
  if (!host.isConnected) return null;
  if (request.readOnly === true) return null;
  if (typeof callbacks.onCommit !== 'function') return null;
  const doc =
    overlayDocOf(host) ?? (typeof document !== 'undefined' ? document : null);
  if (doc === null) return null;

  // Single overlay per host (slash-menu precedent): re-open closes first.
  closeMathDiagramOverlay(host);

  const previouslyFocused =
    typeof document !== 'undefined' &&
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

  const overlay = doc.createElement('div');
  overlay.className = 'flbp-md-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute(
    'aria-label',
    request.kind === 'math' ? 'Edit math source' : 'Edit diagram source',
  );
  overlay.dataset.flbpMdKind = request.kind;
  overlay.dataset.flbpMdBlock = request.blockId;

  // Slash-chrome mousedown pattern: preserve the PM selection by
  // preventDefaulting chrome clicks, but NEVER inside the editable textarea
  // or buttons (they must focus/activate).
  overlay.addEventListener('mousedown', (event) => {
    if (isOverlayInputTarget(event.target)) return;
    event.preventDefault();
  });

  const label = doc.createElement('div');
  label.className = 'flbp-md-overlay-label';
  label.textContent =
    request.kind === 'math'
      ? 'Math source (LaTeX)'
      : 'Diagram source (Mermaid)';
  overlay.appendChild(label);

  const editor = doc.createElement('textarea');
  editor.className = 'flbp-md-editor';
  editor.setAttribute(
    'aria-label',
    request.kind === 'math'
      ? 'Math source (LaTeX)'
      : 'Diagram source (Mermaid)',
  );
  editor.setAttribute('spellcheck', 'false');
  editor.rows = 4;
  editor.value = request.initialSource;
  overlay.appendChild(editor);

  const preview = doc.createElement('div');
  preview.className = 'flbp-md-preview flbp-md-sandbox';
  preview.setAttribute('aria-live', 'polite');
  overlay.appendChild(preview);

  const status = doc.createElement('div');
  status.className = 'flbp-md-status';
  status.setAttribute('role', 'status');
  overlay.appendChild(status);

  const actions = doc.createElement('div');
  actions.className = 'flbp-md-actions';
  const save = doc.createElement('button');
  save.type = 'button';
  save.className = 'flbp-md-action flbp-md-commit';
  save.textContent = 'Save';
  const cancel = doc.createElement('button');
  cancel.type = 'button';
  cancel.className = 'flbp-md-action flbp-md-cancel';
  cancel.textContent = 'Cancel';
  actions.appendChild(save);
  actions.appendChild(cancel);
  overlay.appendChild(actions);

  let open = true;
  let committed = false;
  let previewTimer: ReturnType<typeof setTimeout> | null = null;
  let previewGen = 0;

  const showStatus = (message: string): void => {
    status.textContent = '';
    if (message === '') return;
    const span = doc.createElement('span');
    span.className = 'flbp-md-message';
    span.textContent = message;
    status.appendChild(span);
  };

  const setSaveEnabled = (enabled: boolean): void => {
    save.disabled = !enabled;
    save.setAttribute('aria-disabled', String(!enabled));
  };

  const validateCap = (source: string): boolean => {
    if (sourceBytes(source) > MAX_MATH_DIAGRAM_SOURCE_BYTES) {
      showStatus(typedMessage(request.kind, 'too-large'));
      setSaveEnabled(false);
      return false;
    }
    setSaveEnabled(true);
    return true;
  };

  const clearPreviewTimer = (): void => {
    if (previewTimer !== null) {
      clearTimeout(previewTimer);
      previewTimer = null;
    }
  };

  const paintPreview = (html: string): void => {
    preview.hidden = false;
    preview.innerHTML = html;
    sweepInserted(preview);
  };

  const paintPreviewEmpty = (): void => {
    preview.innerHTML = '';
    preview.hidden = true;
  };

  const runPreviewNow = (source: string, gen: number): void => {
    if (!open || gen !== previewGen) return;
    if (source === '') {
      paintPreviewEmpty();
      showStatus(typedMessage(request.kind, 'empty-source'));
      return;
    }
    if (sourceBytes(source) > MAX_MATH_DIAGRAM_SOURCE_BYTES) {
      paintPreviewEmpty();
      showStatus(typedMessage(request.kind, 'too-large'));
      return;
    }
    const renderer = resolveRenderer(request.kind);
    if (renderer === null) {
      paintPreviewEmpty();
      showStatus(typedMessage(request.kind, 'unavailable'));
      return;
    }
    const controller =
      typeof AbortController === 'function' ? new AbortController() : null;
    const timeoutMs = MATH_DIAGRAM_RENDER_TIMEOUT_MS;
    const timer =
      controller !== null
        ? setTimeout(() => controller.abort(), timeoutMs)
        : null;
    let raceTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      if (!open || gen !== previewGen) return;
      paintPreviewEmpty();
      showStatus(typedMessage(request.kind, 'timeout'));
    }, timeoutMs);
    const settle = (outcome: MathDiagramOutcome): void => {
      if (!open || gen !== previewGen) return;
      if (raceTimer !== null) {
        clearTimeout(raceTimer);
        raceTimer = null;
      }
      if (timer !== null) clearTimeout(timer);
      if (outcome.ok) {
        showStatus('');
        paintPreview(outcome.html);
      } else {
        paintPreviewEmpty();
        showStatus(typedMessage(request.kind, outcome.error));
      }
    };
    void renderer(source, {
      signal: controller?.signal ?? ({ aborted: false } as AbortSignal),
    }).then(settle, () => settle({ ok: false, error: 'invalid-source' }));
  };

  const schedulePreview = (): void => {
    clearPreviewTimer();
    const source = editor.value;
    // Cap + empty short-circuit synchronously (no renderer touch); the
    // settled render stays debounced (lazy) like the figure hydration.
    if (source === '' || sourceBytes(source) > MAX_MATH_DIAGRAM_SOURCE_BYTES) {
      previewGen += 1;
      const gen = previewGen;
      const debounceMs = testHooks?.debounceMs ?? MATH_DIAGRAM_SETTLE_MS;
      if (debounceMs <= 0) {
        runPreviewNow(source, gen);
        validateCap(source);
        return;
      }
      previewTimer = setTimeout(() => {
        previewTimer = null;
        runPreviewNow(source, gen);
      }, debounceMs);
      validateCap(source);
      return;
    }
    validateCap(source);
    showStatus('');
    previewGen += 1;
    const gen = previewGen;
    const debounceMs = testHooks?.debounceMs ?? MATH_DIAGRAM_SETTLE_MS;
    if (debounceMs <= 0) {
      runPreviewNow(source, gen);
      return;
    }
    previewTimer = setTimeout(() => {
      previewTimer = null;
      runPreviewNow(source, gen);
    }, debounceMs);
  };

  const returnFocusTo = (): void => {
    try {
      if (typeof callbacks.returnFocus === 'function') {
        callbacks.returnFocus();
        return;
      }
      if (previouslyFocused !== null && previouslyFocused.isConnected) {
        previouslyFocused.focus();
        return;
      }
      if (anchor !== null && anchor.isConnected) {
        anchor.focus();
        return;
      }
      if (typeof host.focus === 'function' && !host.isContentEditable) {
        // Host focus is best-effort (the PM surface owns real focus);
        // never throw when the host is not focusable.
        try {
          (host as HTMLElement).focus({ preventScroll: true } as FocusOptions);
        } catch {
          // Best-effort only.
        }
      }
    } catch {
      // Focus return never throws (Esc path included).
    }
  };

  const detach = (): void => {
    clearPreviewTimer();
    try {
      document.removeEventListener('pointerdown', onOutside, true);
    } catch {
      // Best-effort.
    }
    try {
      host.removeEventListener('scroll', onScroll, true);
    } catch {
      // Best-effort.
    }
    try {
      window.removeEventListener('resize', onResize);
    } catch {
      // Best-effort.
    }
    overlay.remove();
  };

  const doClose = (reason: 'commit' | 'dismiss'): void => {
    if (!open) return;
    open = false;
    detach();
    if (reason === 'dismiss') {
      try {
        callbacks.onDismiss?.();
      } catch {
        // Dismiss hooks never block focus return.
      }
    }
    returnFocusTo();
  };

  const tryCommit = (): boolean => {
    if (!open || committed) return false;
    const source = editor.value;
    if (!validateCap(source)) return false;
    let accepted = false;
    try {
      accepted = callbacks.onCommit(source);
    } catch {
      accepted = false;
    }
    if (!accepted) return false;
    committed = true;
    doClose('commit');
    return true;
  };

  const onOutside = (event: Event): void => {
    if (!open) return;
    const target = event.target as Node | null;
    if (target === null) return;
    if (overlay.contains(target)) return;
    if (anchor !== null && anchor.contains(target)) return;
    doClose('dismiss');
  };

  const onScroll = (): void => {
    if (!open) return;
    // Passive reposition only — never preventDefault, so touch scroll keeps
    // working while the overlay tracks its anchor.
    positionOverlay(host, overlay, anchor);
  };

  const onResize = (): void => {
    if (!open) return;
    positionOverlay(host, overlay, anchor);
  };

  editor.addEventListener('input', () => {
    schedulePreview();
  });

  editor.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      doClose('dismiss');
      return;
    }
    const mod = event.ctrlKey || event.metaKey;
    if (
      (event.key === 'Enter' && !event.shiftKey) ||
      (event.key === 'Enter' && mod)
    ) {
      event.preventDefault();
      event.stopPropagation();
      tryCommit();
    }
  });

  const commitFromButton = (event: Event): void => {
    event.preventDefault();
    tryCommit();
  };
  const dismissFromButton = (event: Event): void => {
    event.preventDefault();
    doClose('dismiss');
  };
  // Mouse path.
  save.addEventListener('click', commitFromButton);
  cancel.addEventListener('click', dismissFromButton);
  // Touch tap parity (slash-menu precedent): coarse pointers commit on
  // pointerup even when the synthetic click is delayed; guard double-commit
  // via the open flag (second event is a no-op after close).
  save.addEventListener('pointerup', (event) => {
    if (event.pointerType === 'mouse') return;
    commitFromButton(event);
  });
  cancel.addEventListener('pointerup', (event) => {
    if (event.pointerType === 'mouse') return;
    dismissFromButton(event);
  });

  try {
    document.addEventListener('pointerdown', onOutside, true);
  } catch {
    // Best-effort.
  }
  try {
    // Passive by default (never preventDefault) — touch scroll unaffected.
    host.addEventListener('scroll', onScroll, true);
  } catch {
    // Best-effort.
  }
  try {
    window.addEventListener('resize', onResize);
  } catch {
    // Best-effort.
  }

  host.appendChild(overlay);
  positionOverlay(host, overlay, anchor);
  validateCap(editor.value);
  schedulePreview();
  try {
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
  } catch {
    // Focus is best-effort (headless-shaped DOM).
  }

  const handle: MathDiagramOverlayHandle = {
    element: overlay,
    textarea: editor,
    saveButton: save,
    cancelButton: cancel,
    preview,
    status,
    close: doClose,
    isOpen: () => open,
  };
  // Teardown bridge for `closeMathDiagramOverlay(host)` (dismiss path with
  // focus return + onDismiss, not a bare remove).
  (
    overlay as unknown as {
      __flbpMdClose?: (reason: 'commit' | 'dismiss') => void;
    }
  ).__flbpMdClose = doClose;
  return handle;
}
