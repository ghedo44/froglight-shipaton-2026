/** Pure paste-sanitize fixtures: no drops, predictable splits, sanitized HTML.*/
import { describe, expect, it, vi } from 'vitest';
import {
  htmlToPasteLines,
  normalizePasteText,
  preStripPayloadTags,
  splitPasteLines,
} from './paste-sanitize.js';

describe('paste-sanitize fixtures', () => {
  it('normalizes CRLF/CR to LF', () => {
    expect(normalizePasteText('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('splits lines and drops exactly one trailing newline', () => {
    expect(splitPasteLines('a\nb\nc')).toEqual(['a', 'b', 'c']);
    expect(splitPasteLines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitPasteLines('a\n\nc')).toEqual(['a', '', 'c']);
    expect(splitPasteLines('')).toEqual([]);
    expect(splitPasteLines('\n')).toEqual(['']);
    expect(splitPasteLines('a\n\n')).toEqual(['a', '']);
  });

  it('preserves empty middle lines (no drops)', () => {
    expect(splitPasteLines('one\n\n\nfour')).toEqual(['one', '', '', 'four']);
  });

  it('strips scripts/styles/iframes but keeps their surrounding text', () => {
    const lines = htmlToPasteLines(
      '<p>hello</p><script>alert(1)</script><p>world</p><style>p{}</style>',
    );
    expect(lines).toEqual(['hello', 'world']);
  });

  it('turns block boundaries and <br> into line breaks without merging', () => {
    expect(htmlToPasteLines('<p>a</p><p>b</p>')).toEqual(['a', 'b']);
    expect(htmlToPasteLines('a<br>b')).toEqual(['a', 'b']);
    expect(htmlToPasteLines('<div>a</div><div>b</div>')).toEqual(['a', 'b']);
    expect(htmlToPasteLines('<ul><li>a</li><li>b</li></ul>')).toEqual([
      'a',
      'b',
    ]);
  });

  it('discards tags/attributes and javascript: URLs, keeping text', () => {
    const lines = htmlToPasteLines(
      '<p onclick="evil()">hi <a href="javascript:alert(1)">link</a> <b>bold</b></p>',
    );
    expect(lines.join(' ')).toContain('hi');
    expect(lines.join(' ')).toContain('link');
    expect(lines.join(' ')).toContain('bold');
    expect(lines.join(' ')).not.toContain('javascript:');
    expect(lines.join(' ')).not.toContain('onclick');
  });

  it('handles entities and nested blocks without phantom empties', () => {
    expect(htmlToPasteLines('<p>a &amp; b</p>')).toEqual(['a & b']);
    expect(htmlToPasteLines('<div><p>a</p></div><div><p>b</p></div>')).toEqual([
      'a',
      'b',
    ]);
  });

  it('pre-strips img payload tags before innerHTML (no fetch surface)', () => {
    expect(
      htmlToPasteLines(
        '<p>hi</p><img src="https://evil.test/x.png" onerror="alert(1)">',
      ),
    ).toEqual(['hi']);
    expect(htmlToPasteLines('<img src="https://evil.test/x.png">')).toEqual([]);
  });

  it('preserves table cells as lines without phantom empties', () => {
    expect(
      htmlToPasteLines(
        '<table><tbody><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></tbody></table>',
      ),
    ).toEqual(['a', 'b', 'c', 'd']);
    expect(
      htmlToPasteLines(
        '<table><thead><tr><th>h1</th><th>h2</th></tr></thead><tbody><tr><td>a</td></tr></tbody></table>',
      ),
    ).toEqual(['h1', 'h2', 'a']);
    // Rows without cells keep a break when the DOM is built programmatically
    // (raw "<tr>text</tr>" HTML foster-parents its text out of the table per
    // the HTML parser, so real clipboard bytes always carry td/th).
    const owner = document.implementation.createHTMLDocument('');
    const prog = owner.createElement('table');
    const row = owner.createElement('tr');
    row.textContent = 'solo';
    prog.appendChild(row);
    expect(htmlToPasteLines(prog.outerHTML)).toEqual(['solo']);
  });

  it('no-document fallback strips script/style content like the DOM path', () => {
    vi.stubGlobal('document', undefined);
    try {
      expect(htmlToPasteLines('<p>hi</p><script>alert(1)</script>')).toEqual([
        'hi',
      ]);
      expect(htmlToPasteLines('<style>p{}</style><p>ok</p>')).toEqual(['ok']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('no-document fallback keeps br/leaf/table breaks like the DOM path', () => {
    vi.stubGlobal('document', undefined);
    try {
      expect(htmlToPasteLines('a<br>b')).toEqual(['a', 'b']);
      expect(htmlToPasteLines('a<br clear="all">b')).toEqual(['a', 'b']);
      expect(htmlToPasteLines('<p>a</p><p>b</p>')).toEqual(['a', 'b']);
      expect(htmlToPasteLines('<ul><li>a</li><li>b</li></ul>')).toEqual([
        'a',
        'b',
      ]);
      expect(
        htmlToPasteLines(
          '<table><tbody><tr><td>a</td><td>b</td></tr></tbody></table>',
        ),
      ).toEqual(['a', 'b']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('pre-strip kills fetch attributes on the stripped string, closer or not', () => {
    // Every case must leave zero fetch-capable attributes behind BEFORE
    // innerHTML assignment: closer-less void/unclosed tags, SVG image hrefs,
    // poster/background/data carriers, and url() style payloads.
    const cases = [
      '<p>hi</p><iframe src="https://evil.test/x">',
      '<p>hi</p><embed src="https://evil.test/x">',
      '<p>hi</p><link href="https://evil.test/x">',
      '<p>hi</p><video src="https://evil.test/x" poster="https://evil.test/x.png">',
      '<p>hi</p><video><source src="https://evil.test/x">',
      '<p>hi</p><audio src="https://evil.test/x">',
      '<p>hi</p><object data="https://evil.test/x">',
      '<svg><image href="https://evil.test/x" /></svg>',
      '<svg><image xlink:href="https://evil.test/x" /></svg>',
      '<div style="background-image:url(https://evil.test/x)">text</div>',
      '<table background="https://evil.test/x"><tr><td>a</td></tr></table>',
      '<p>hi</p><img src="https://evil.test/x"><script src="https://evil.test/x"></script>',
    ];
    for (const html of cases) {
      const stripped = preStripPayloadTags(html);
      expect(stripped, `fetch attribute survives in: ${html}`).not.toMatch(
        /\s(?:src|href|xlink:href|poster|background|style|data(?:-[\w:.-]+)?)\s*=/i,
      );
      expect(stripped, `url() payload survives in: ${html}`).not.toMatch(
        /url\s*\(/i,
      );
    }
  });

  it('closer-less fetch tags and svg/style carriers paste as text only', () => {
    expect(
      htmlToPasteLines('<p>hi</p><iframe src="https://evil.test/x">'),
    ).toEqual(['hi']);
    expect(
      htmlToPasteLines('<p>hi</p><embed src="https://evil.test/x">'),
    ).toEqual(['hi']);
    expect(
      htmlToPasteLines('<p>hi</p><video src="https://evil.test/x">'),
    ).toEqual(['hi']);
    expect(
      htmlToPasteLines(
        '<div style="background-image:url(https://evil.test/x)">text</div>',
      ),
    ).toEqual(['text']);
    expect(
      htmlToPasteLines(
        '<table background="https://evil.test/x"><tr><td>a</td></tr></table>',
      ),
    ).toEqual(['a']);
    expect(
      htmlToPasteLines('<svg><image href="https://evil.test/x" /></svg>'),
    ).toEqual([]);
  });

  it('keeps ordinary words matching attribute names verbatim', () => {
    expect(htmlToPasteLines('<p>my style is nice</p>')).toEqual([
      'my style is nice',
    ]);
    expect(htmlToPasteLines('<p>my background is blue</p>')).toEqual([
      'my background is blue',
    ]);
    expect(htmlToPasteLines('<p>use src="foo"</p>')).toEqual([
      'use src="foo"',
    ]);
    expect(htmlToPasteLines('<p>see poster sale</p>')).toEqual([
      'see poster sale',
    ]);
    expect(htmlToPasteLines('<p>my data is here</p>')).toEqual([
      'my data is here',
    ]);
  });

  it('keeps > inside quoted attribute values inside the tag', () => {
    // Quote-aware tag scanning: the pre-strip pass must not split on `>`
    // inside quoted attribute values and leak `b" src=...` fragments as
    // text. Closes prior optional edge.
    const img = '<p>hi</p><img title="a>b" src="https://evil.test/x.png">';
    expect(preStripPayloadTags(img)).not.toContain('b" src');
    expect(htmlToPasteLines(img)).toEqual(['hi']);
    expect(
      htmlToPasteLines(
        '<p>see <a title="a>b" href="https://example.com">link</a> now</p>',
      ),
    ).toEqual(['see link now']);
    expect(htmlToPasteLines('<div data-note="a>b">text</div>')).toEqual([
      'text',
    ]);
    for (const lines of [
      htmlToPasteLines(img),
      htmlToPasteLines(
        '<p>see <a title="a>b" href="https://example.com">link</a> now</p>',
      ),
      htmlToPasteLines('<div data-note="a>b">text</div>'),
    ]) {
      expect(lines.join(' ')).not.toContain('b"');
    }
  });

  it('no-document fallback keeps quoted-> attributes inside the tag', () => {
    vi.stubGlobal('document', undefined);
    try {
      expect(htmlToPasteLines('<div data-note="a>b">text</div>')).toEqual([
        'text',
      ]);
      expect(
        htmlToPasteLines('<p>see <a title="a>b">link</a> now</p>'),
      ).toEqual(['see link now']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('pre-strip kills fetch attributes when < hides inside tag spans', () => {
    // Fail-CLOSED barrier: a `<` inside a tag span must not let
    // the whole opener dodge the quote-aware scan and reach `innerHTML`
    // with `src=`/`href=` intact (old naive `[^>]*` stripped through inner
    // `<`; the hardened scan must not regress to fail-open).
    const cases = [
      '<p>hi</p><img src="https://evil.test/x.png" <onerror="alert(1)">',
      '<img src="https://evil.test/x.png" <onerror="alert(1)">',
      '<p>hi</p><input type=image src="https://evil.test/x.png" <foo="bar">',
      '<input type=image src="https://evil.test/x.png" <foo="bar">',
      `<p>hi</p><img src='https://evil.test/x.png' <onerror='alert(1)'>`,
    ];
    for (const html of cases) {
      const stripped = preStripPayloadTags(html);
      expect(stripped, `fetch attribute survives in: ${html}`).not.toMatch(
        /\s(?:src|href|xlink:href|poster|background|style|data(?:-[\w:.-]+)?)\s*=/i,
      );
      expect(stripped, `url() payload survives in: ${html}`).not.toMatch(
        /url\s*\(/i,
      );
    }
  });

  it('angle-bracket-in-tag img/input paste as text only, DOM path', () => {
    expect(
      htmlToPasteLines(
        '<p>hi</p><img src="https://evil.test/x.png" <onerror="alert(1)">',
      ),
    ).toEqual(['hi']);
    expect(
      htmlToPasteLines('<img src="https://evil.test/x.png" <onerror="alert(1)">'),
    ).toEqual([]);
    expect(
      htmlToPasteLines(
        '<p>hi</p><input type=image src="https://evil.test/x.png" <foo="bar">',
      ),
    ).toEqual(['hi']);
    expect(
      htmlToPasteLines('<input type=image src="https://evil.test/x.png" <foo="bar">'),
    ).toEqual([]);
  });

  it('live-DOM: no img/input with a fetch attribute survives pre-strip', () => {
    // Structural no-fetch barrier: the exact string assigned to
    // `host.innerHTML` on the detached-div path must build zero fetch
    // carriers. Runs against the real jsdom document.
    const cases = [
      '<p>hi</p><img src="https://evil.test/x.png" <onerror="alert(1)">',
      '<p>hi</p><input type=image src="https://evil.test/x.png" <foo="bar">',
      `<p>hi</p><img src='https://evil.test/x.png' <onerror='alert(1)'>`,
    ];
    for (const html of cases) {
      const host = document.createElement('div');
      host.innerHTML = preStripPayloadTags(html);
      expect(
        host.querySelectorAll('img[src], input[src], img[href], input[href]'),
        `fetch carrier survives into live DOM: ${host.innerHTML}`,
      ).toHaveLength(0);
      expect(
        host.innerHTML,
        `fetch attribute survives into live DOM: ${html}`,
      ).not.toMatch(/\s(?:src|href)\s*=/i);
    }
  });

  it('angle-bracket-in-tag img/input paste as text only, no-DOM fallback', () => {
    vi.stubGlobal('document', undefined);
    try {
      expect(
        htmlToPasteLines(
          '<p>hi</p><img src="https://evil.test/x.png" <onerror="alert(1)">',
        ),
      ).toEqual(['hi']);
      expect(
        htmlToPasteLines(
          '<img src="https://evil.test/x.png" <onerror="alert(1)">',
        ),
      ).toEqual([]);
      expect(
        htmlToPasteLines(
          '<p>hi</p><input type=image src="https://evil.test/x.png" <foo="bar">',
        ),
      ).toEqual(['hi']);
      expect(
        htmlToPasteLines(
          '<input type=image src="https://evil.test/x.png" <foo="bar">',
        ),
      ).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps single-quoted > inside attribute values inside the tag", () => {
    // Single-quote twin of the double-quote fixtures, per path:
    // pre-strip string, DOM paste lines, and no-DOM fallback.
    const img = `<p>hi</p><img title='a>b' src="https://evil.test/x.png">`;
    expect(preStripPayloadTags(img)).not.toContain(`b' src`);
    expect(preStripPayloadTags(img)).not.toMatch(/\ssrc\s*=/i);
    expect(htmlToPasteLines(img)).toEqual(['hi']);
    expect(
      htmlToPasteLines(`<p>see <a title='a>b'>link</a> now</p>`),
    ).toEqual(['see link now']);
    vi.stubGlobal('document', undefined);
    try {
      expect(htmlToPasteLines(img)).toEqual(['hi']);
      expect(
        htmlToPasteLines(`<p>see <a title='a>b'>link</a> now</p>`),
      ).toEqual(['see link now']);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
