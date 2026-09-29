/**
 * Deterministic paste sanitization for the block-page provider.
 *
 * ProseMirror JSON is plain data and `pm-map` stays the only canonical
 * bridge: these helpers only turn untrusted clipboard bytes into plain
 * text lines. The handle then inserts those lines through the normal
 * ProseMirror pipeline (single undoable transaction), so opaque payloads
 * and unknown marks in untouched blocks survive via the existing sync.
 *
 * Rules (predictable, no drops):
 * - CRLF/CR normalize to LF.
 * - Split on LF; exactly one trailing empty from a final newline is
 *   dropped (pasting "a\n" inserts "a", not "a" + empty).
 * - Empty lines in the middle are preserved as empty paragraphs.
 * - HTML is reduced to text lines: script/style/noscript/template/iframe/
 *   object/embed/link/meta/video/audio/source/track and SVG image carriers
 *   are removed entirely; `<br>` and block boundaries (p/div/li/h1-h6/
 *   blockquote/pre/td/th/tr/section/article/table/tbody/thead/tfoot)
 *   become line breaks, with table cells each keeping their own line and
 *   rows breaking only when cell-less (no phantom empties); all
 *   tags/attributes (including event handlers and javascript: URLs) are
 *   discarded because only text is kept.
 * - Payload/fetch attributes (src/href/xlink:href/poster/background/data/
 *   style, including url() style payloads) are stripped inside tag spans
 *   (`<...>`) of the raw string BEFORE `innerHTML` assignment so untrusted
 *   paste bytes never trigger a network fetch while text nodes stay
 *  byte-identical; an unquoted `<` inside a tag span is first
 *  neutralized to `&lt;` so broken openers such as
 *   `<img src=... <onerror=...>` cannot dodge the scan fail-open; the DOM
 *   remove-loop stays as defense-in-depth.
 */

export function normalizePasteText(raw: string): string {
  return raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Split normalized clipboard text into insertable lines.
 * Empty input yields no lines (no-op paste). A single trailing newline
 * does not create an extra block.
 */
export function splitPasteLines(raw: string): string[] {
  const normalized = normalizePasteText(raw);
  if (normalized === '') return [];
  const lines = normalized.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

const STRIP_SELECTOR =
  'script, style, noscript, template, iframe, object, embed, link, meta, ' +
  'video, audio, source, track, image';

const LEAF_BLOCK_SELECTOR =
  'p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, td, th';

const ROW_SELECTOR = 'tr';

const CONTAINER_SELECTOR =
  'div, section, article, ul, ol, table, tbody, thead, tfoot';

/**
 * Payload/fetch tags removed from the raw string BEFORE `innerHTML`
 * assignment (hardened). Setting `innerHTML` with
 * `<img src>` / `<iframe src>` / `<link href>` would issue network fetches
 * for untrusted paste bytes before the DOM remove-loop below ever runs;
 * `<script>` content must never reach the live host either. The DOM strip
 * loop stays as defense-in-depth for anything the regexes miss.
 *
 * Matching is attribute-driven, not tag-name-driven: tag-name
 * lists alone miss closer-less tags (`<iframe src>` with no `</iframe>`)
 * and fetch attributes on any other tag (`background`, `poster`, `style`
 * with `url()`, SVG `<image href>`). So after paired bodies are removed,
 * every leftover payload-tag opener is swept (paired or closer-less alike)
 * and then fetch-capable attributes are stripped off whatever tags remain —
 * element text survives, the fetch surface does not.
 */
const PRE_STRIP_PAIRED =
  /<(script|style|iframe|object|embed|link|meta|noscript|template|video|audio)[\s\S]*?<\/\1\s*>/gi;
/**
 * Leftover openers: void tags plus closer-less payload tags.
 * The `[\s/>]` guard keeps custom elements sharing a prefix (e.g.
 * `<linkage>`) intact; `image` covers SVG `<image href>` carriers.
 * The tag body is quote-aware: `>` inside single/double-quoted
 * attribute values does not end the tag.
 */
const PRE_STRIP_OPEN =
  /<(script|style|iframe|object|embed|link|meta|noscript|template|video|audio|img|image|source|track|input)(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>/gi;
/**
 * Fetch-capable attributes stripped off every remaining tag:
 * src/href/xlink:href/poster/background/data(-*)/style. Values may be
 * double-quoted, single-quoted, or bare. `style` is removed whole (only
 * text is kept downstream, so no presentation is lost and `url()` payloads
 * cannot survive). The trailing-name guard keeps `srcset`-style prefixes
 * and `database`-style names from partially matching.
 */
const PRE_STRIP_FETCH_ATTR =
  /\s+(?:src|xlink:href|href|poster|background|style|data(?:-[\w:.-]+)?)(?![\w:.-])(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'`>=]+))?/gi;

/**
 * One raw tag opener/closer (`<...>`). Fetch-attribute stripping runs
 * inside these matches only: text nodes stay byte-identical so
 * ordinary words like "style" or "background" are never deleted.
 * Scanning is quote-aware: `>` inside single/double-quoted
 * attribute values (e.g. `<img title="a>b" src=...>`) does not end the
 * match, so no `b" src=...` fragment ever leaks as text. Inputs without
 * quoted `>` match exactly as before.
 */
const TAG_SPAN = /<(?:[^<>"']|"[^"]*"|'[^']*')*>/g;

const TAG_OPENER_START = /[A-Za-z]/;

/**
 * Fail-closed `<` handling inside tag spans (no-fetch
 * barrier). The quote-aware spans above (`TAG_SPAN`, `PRE_STRIP_OPEN`,
 * `FALLBACK_BR`, fallback strip) cannot cross a `<` inside a tag, so
 * `<img src="https://evil.test/x.png" <onerror="alert(1)">` dodged every
 * pass and reached `innerHTML` with `src=` intact — fail-OPEN (the old
 * naive `[^>]*` stripped through inner `<`). Neutralize first: an unquoted
 * `<` between a tag opener and its quote-aware closing `>` becomes `&lt;`,
 * so the hardened spans match the whole opener and the existing
 * opener/fetch-attribute sweeps apply. Runs BEFORE every regex below, so
 * `TAG_SPAN`, `PRE_STRIP_OPEN`, `FALLBACK_BR`, and the fallback strip all
 * inherit the closed scan.
 *
 * Scope is deliberately narrow (verbatim text stays byte-identical):
 * - `<` not starting a tag (`a < b`, `<3`) is left alone.
 * - `<` inside single/double-quoted values is left alone (`TAG_SPAN`
 *  already tolerates it.
 * - `<!--...-->` comments pass through verbatim (comments build no
 *   elements, so no fetch surface) so comment text behaves as before.
 * - `<!...>`/`<?...?>` declarations and `</...>` closers pass through to
 *   their first `>` verbatim (closers create no elements, so no fetch
 *   surface) to preserve existing downstream behavior exactly.
 * - Only `<letter...>` openers — the spans that can create fetch-carrying
 *   elements — get inner-`<` neutralization. Unterminated openers are
 *   emitted verbatim (nothing downstream treats them as tag spans either).
 */
function neutralizeInnerTagOpeners(html: string): string {
  let out = '';
  let i = 0;
  const n = html.length;
  while (i < n) {
    const start = html.indexOf('<', i);
    if (start === -1) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, start);
    const next = start + 1 < n ? html[start + 1] : '';
    if (next === '!' && html.startsWith('<!--', start)) {
      const end = html.indexOf('-->', start + 4);
      if (end === -1) {
        out += html.slice(start);
        break;
      }
      out += html.slice(start, end + 3);
      i = end + 3;
      continue;
    }
    if (next === '!' || next === '?' || next === '/') {
      const end = html.indexOf('>', start + 2);
      if (end === -1) {
        out += html.slice(start);
        break;
      }
      out += html.slice(start, end + 1);
      i = end + 1;
      continue;
    }
    if (!TAG_OPENER_START.test(next)) {
      out += '<';
      i = start + 1;
      continue;
    }
    let quote: '"' | "'" | null = null;
    let j = start + 1;
    let closedAt = -1;
    const inner: number[] = [];
    while (j < n) {
      const c = html[j];
      if (quote !== null) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '<') {
        inner.push(j);
      } else if (c === '>') {
        closedAt = j;
        break;
      }
      j += 1;
    }
    if (closedAt === -1) {
      out += html.slice(start);
      break;
    }
    if (inner.length === 0) {
      out += html.slice(start, closedAt + 1);
    } else {
      let k = start;
      for (const pos of inner) {
        out += html.slice(k, pos) + '&lt;';
        k = pos + 1;
      }
      out += html.slice(k, closedAt + 1);
    }
    i = closedAt + 1;
  }
  return out;
}

export function preStripPayloadTags(html: string): string {
  const closed = neutralizeInnerTagOpeners(html);
  const swept = closed
    .replace(PRE_STRIP_PAIRED, '')
    .replace(PRE_STRIP_OPEN, '');
  return swept.replace(TAG_SPAN, (tag) =>
    tag.replace(PRE_STRIP_FETCH_ATTR, ''),
  );
}

/**
 * Fallback text extraction when no DOM is available. Aligned with the DOM
 * path (break parity): script/style bodies are removed
 * entirely (not kept as text), matching the remove-then-read rule above,
 * and `<br>` plus leaf/table closing tags become line breaks so pasted
 * tables and line breaks survive without a document. Wrapper closes
 * (div/section/article/ul/ol/table/...) emit no break here — the DOM rule
 * for those depends on direct-text/leaf-descendant structure a regex cannot
 * see — so the DOM path stays authoritative for nested wrappers.
 */
const FALLBACK_BREAK_CLOSE = /<\/(?:p|li|h[1-6]|blockquote|pre|td|th|tr)>/gi;
const FALLBACK_BR = /<br(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>/gi;

export function htmlToTextFallback(html: string): string {
  return preStripPayloadTags(html)
    .replace(FALLBACK_BR, '\n')
    .replace(FALLBACK_BREAK_CLOSE, '\n')
    .replace(/<(?:[^<>"']|"[^"]*"|'[^']*')*>/g, '')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

/**
 * Reduce untrusted HTML to plain paste lines. `doc` defaults to the
 * global document (jsdom in tests, browser in production) but is
 * injectable for deterministic unit tests.
 */
export function htmlToPasteLines(html: string, doc?: Document): string[] {
  const owner: Document | undefined =
    doc ?? (typeof document !== 'undefined' ? document : undefined);
  if (owner === undefined) return splitPasteLines(htmlToTextFallback(html));
  const host = owner.createElement('div');
  host.innerHTML = preStripPayloadTags(html);
  for (const el of Array.from(host.querySelectorAll(STRIP_SELECTOR))) {
    el.remove();
  }
  for (const br of Array.from(host.querySelectorAll('br'))) {
    br.replaceWith(owner.createTextNode('\n'));
  }
  // Block boundaries become explicit breaks before text extraction so
  // "<p>a</p><p>b</p>" never merges into "ab". Leaf blocks always break;
  // table cells (td/th) each break so pasted tables preserve every cell as
  // its own line; a row breaks only when it holds no cells (bare "<tr>a</tr>"
  // legacy behavior) so cell rows never emit phantom empties; containers
  // break only when they hold direct text (no leaf descendants), so nested
  // "<div><p>a</p></div>" and "<table><tr><td>a</td></tr></table>" never emit
  // phantom empties.
  for (const el of Array.from(host.querySelectorAll(LEAF_BLOCK_SELECTOR))) {
    el.append(owner.createTextNode('\n'));
  }
  for (const el of Array.from(host.querySelectorAll(ROW_SELECTOR))) {
    if (el.querySelector('td, th') !== null) continue;
    el.append(owner.createTextNode('\n'));
  }
  for (const el of Array.from(host.querySelectorAll(CONTAINER_SELECTOR))) {
    if (el.querySelector(LEAF_BLOCK_SELECTOR) !== null) continue;
    if ((el.textContent ?? '').trim() === '') continue;
    el.append(owner.createTextNode('\n'));
  }
  const text = host.textContent ?? '';
  // Trim boundary breaks from the outer wrappers so "<p>a</p>" yields
  // ["a"] rather than ["", "a"]; middle empties survive via splitPasteLines.
  const trimmed = text.replace(/^\n+/, '').replace(/\n+$/, '');
  if (trimmed === '') return [];
  return splitPasteLines(trimmed);
}
