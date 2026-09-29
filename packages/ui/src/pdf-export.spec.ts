import { describe, expect, it } from 'vitest';
import { buildPrintableDocument } from './pdf-export.js';

describe('PDF export projection', () => {
  it('renders escaped document identity and selected print geometry', () => {
    const html = buildPrintableDocument({
      title: 'Notes <draft>',
      markdown: '# Heading\n\nHello **paper**.',
      options: { pageSize: 'letter', margins: 'narrow', includeTitle: true },
    });

    expect(html).toContain('@page { size: letter; margin: 12mm; }');
    expect(html).toContain('Notes &lt;draft&gt;');
    expect(html).toContain('<h1 data-document-address="heading">Heading</h1>');
    expect(html).toContain('<strong>paper</strong>');
  });

  it('can omit the generated title without dropping document headings', () => {
    const html = buildPrintableDocument({
      title: 'Title',
      markdown: '# Body heading',
      options: { pageSize: 'a4', margins: 'normal', includeTitle: false },
    });
    expect(html).not.toContain('class="print-title"');
    expect(html).toContain(
      '<h1 data-document-address="body-heading">Body heading</h1>',
    );
  });
});
