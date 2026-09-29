import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown-render.js';

describe('renderMarkdown', () => {
  it('renders headings and paragraphs', () => {
    const html = renderMarkdown('# Title\n\nSome *text* here.\n');
    expect(html).toContain('<h1 data-document-address="title">Title</h1>');
    expect(html).toContain('<p>Some <em>text</em> here.</p>');
  });

  it('renders heading levels', () => {
    const html = renderMarkdown('## H2\n###### H6');
    expect(html).toContain('<h2 data-document-address="h2">H2</h2>');
    expect(html).toContain('<h6 data-document-address="h6">H6</h6>');
  });

  it('escapes HTML in text (XSS-safe)', () => {
    const html = renderMarkdown('hello <script>alert(1)</script> & "quotes"');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp; &quot;quotes&quot;');
  });

  it('escapes HTML inside fenced code blocks', () => {
    const html = renderMarkdown('```\n<img src=x onerror=alert(1)>\n```');
    expect(html).toContain(
      '<pre><code>&lt;img src=x onerror=alert(1)&gt;</code></pre>',
    );
  });

  it('annotates fenced code blocks with the language', () => {
    const html = renderMarkdown('```ts\nconst x = 1;\n```');
    expect(html).toContain(
      '<pre><code class="language-ts">const x = 1;</code></pre>',
    );
  });

  it('renders inline code without applying other inline rules', () => {
    const html = renderMarkdown('a `**b**` c');
    expect(html).toContain('<code>**b**</code>');
    expect(html).not.toContain('<code><a');
    expect(html).not.toContain('<code><strong>');
  });

  it('still renders wiki-links outside of code spans', () => {
    const html = renderMarkdown('a `[[X]]` b [[X]]');
    expect(html).toContain('<code>[[X]]</code>');
    expect(html.match(/wiki-link/g)?.length ?? 0).toBe(1);
  });

  it('renders bold, italic, and strikethrough', () => {
    const html = renderMarkdown('**bold** __also bold__ *it* _it2_ ~~gone~~');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<strong>also bold</strong>');
    expect(html).toContain('<em>it</em>');
    expect(html).toContain('<em>it2</em>');
    expect(html).toContain('<del>gone</del>');
  });

  it('renders external links with rel/target', () => {
    const html = renderMarkdown('[site](https://example.com)');
    expect(html).toContain(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">site</a>',
    );
  });

  it('renders internal markdown links as workspace links', () => {
    const html = renderMarkdown('[Note](notes/My%20Note.md)');
    expect(html).toContain(
      '<a class="wiki-link" data-destination="notes/My Note.md" href="#">Note</a>',
    );
  });

  it('blocks javascript: link destinations', () => {
    const html = renderMarkdown('[x](javascript:alert(1))');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('href="#"');
  });

  it('renders wiki-links with destination, fragment, and alias', () => {
    const html = renderMarkdown('[[Plain]] [[Dest#Sec|aliased]]');
    expect(html).toContain(
      '<a class="wiki-link" data-destination="Plain" href="#">Plain</a>',
    );
    expect(html).toContain(
      '<a class="wiki-link" data-destination="Dest" data-fragment="Sec" href="#">aliased</a>',
    );
  });

  it('emits escaped, sized wiki embed placeholders without making them links', () => {
    const html = renderMarkdown('![[Pixel.png|100x145]] ![[A"B.md]]');
    expect(html).toContain(
      'data-embed-destination="Pixel.png" data-embed-size="100x145"',
    );
    expect(html).toContain('data-embed-destination="A&quot;B.md"');
    expect(html).not.toContain('class="wiki-link"');
  });

  it('escapes wiki-link destinations for attribute context', () => {
    const html = renderMarkdown('[[A"B]]');
    expect(html).toContain('data-destination="A&quot;B"');
  });

  it('renders images with alt text', () => {
    const html = renderMarkdown('![alt text](https://example.com/i.png)');
    expect(html).toContain(
      '<img src="https://example.com/i.png" alt="alt text">',
    );
  });

  it('sizes externally hosted images from a numeric alt value', () => {
    expect(renderMarkdown('![250](https://example.com/i.png)')).toContain(
      '<img src="https://example.com/i.png" alt="250" width="250">',
    );
  });

  it('does not treat images as links', () => {
    const html = renderMarkdown('![x](https://example.com/i.png)');
    expect(html).not.toContain('<a ');
  });

  it('renders unordered lists including nesting', () => {
    const html = renderMarkdown('- a\n- b\n  - b1\n  - b2\n- c');
    expect(html).toContain('<ul>');
    expect((html.match(/<ul>/g) ?? []).length).toBe(2);
    expect(html).toContain('<li>a</li>');
    expect(html).toContain('<li>b1</li>');
    expect(html).toContain('<li>c</li>');
  });

  it('renders ordered lists', () => {
    const html = renderMarkdown('1. one\n2. two');
    expect(html).toContain('<ol>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<li>two</li>');
  });

  it('renders task list checkboxes', () => {
    const html = renderMarkdown('- [ ] todo\n- [x] done');
    expect(html).toContain('<li class="md-task">');
    expect(html).toContain('<span class="md-task-line">');
    expect(html).toContain('<input type="checkbox" disabled>');
    expect(html).toContain('<input type="checkbox" checked disabled>');
  });

  it('renders blockquotes', () => {
    const html = renderMarkdown('> quoted **line**\n> second');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<strong>line</strong>');
  });

  it('renders thematic breaks', () => {
    expect(renderMarkdown('---')).toContain('<hr>');
    expect(renderMarkdown('***')).toContain('<hr>');
  });

  it('renders tables with header alignment row', () => {
    const html = renderMarkdown('| A | B |\n| --- | --- |\n| 1 | 2 |');
    expect(html).toContain('<table>');
    expect(html).toContain('<th>A</th>');
    expect(html).toContain('<td>2</td>');
  });

  it('strips frontmatter and renders it as properties', () => {
    const html = renderMarkdown(
      '---\ntitle: My Note\ntags: a, b\n---\n\nBody text',
    );
    expect(html).toContain('class="md-frontmatter"');
    expect(html).toContain('title');
    expect(html).toContain('My Note');
    expect(html).toContain('<p>Body text</p>');
  });

  it('keeps content without frontmatter untouched', () => {
    const html = renderMarkdown('# Just a doc\n---\nhr below');
    expect(html).toContain(
      '<h1 data-document-address="just-a-doc">Just a doc</h1>',
    );
    expect(html).toContain('<hr>');
  });

  it('handles hard line breaks within paragraphs', () => {
    const html = renderMarkdown('line one\nline two');
    expect(html).toContain('line one<br>line two');
  });
});

describe('Markdown math and metadata', () => {
  it('renders tag arrays without double-escaping properties', () => {
    const html = renderMarkdown(
      '---\ntags: [aerospace, asteria]\ntitle: \'A & "B" <script>\'\n---\nBody',
    );
    expect(html).toContain('<dd>aerospace, asteria</dd>');
    expect(html).toContain('A &amp; &quot;B&quot; &lt;script&gt;');
    expect(html).not.toContain('&amp;quot;');
    expect(html).not.toContain('<script>');
  });

  it('renders inline and display math with accessible MathML', () => {
    const html = renderMarkdown(String.raw`Speed $v=\sqrt{\mu/r}$.
$$
E_{\mathrm{load}} = P t
$$
$$x^2+y^2=z^2$$`);
    expect(html.match(/class="katex"/g)).toHaveLength(3);
    expect(html.match(/class="katex-display"/g)).toHaveLength(2);
    expect(html).toContain('<math');
    expect(html).not.toContain('<em>');
  });

  it('leaves code, escaped dollars, currency and link destinations alone', () => {
    const html = renderMarkdown(
      String.raw`Cost $5 or $10; \$x\$; ` +
        '`$x$`\n\n```tex\n$$x$$\n```\n\n' +
        '[price](https://example.com/$x$)',
    );
    expect(html).not.toContain('class="katex');
    expect(html).toContain('<code>$x$</code>');
    expect(html).toContain('Cost $5 or $10; $x$;');
    expect(html).toContain('href="https://example.com/$x$"');
  });

  it('preserves malformed math and refuses trusted HTML commands', () => {
    const html = renderMarkdown(String.raw`$\unknown{<script>}$

$$
unclosed

$\href{javascript:alert(1)}{click}$
$\includegraphics{https://example.com/track.png}$`);
    expect(html).toContain('md-math-error');
    expect(html).toContain('$$');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('href="javascript:');
  });
});
