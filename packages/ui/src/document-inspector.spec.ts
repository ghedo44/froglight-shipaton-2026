import { describe, expect, it } from 'vitest';
import type { DocumentToolSnapshot } from '@froglight/foundation';
import { projectDocumentInspector } from './document-inspector.js';

describe('document inspector projection', () => {
  it('keeps page properties and thumbnails together while navigation remains floating', () => {
    const snapshot: DocumentToolSnapshot = {
      context: 'Notebook page',
      pages: [{ id: 'one', label: 'Page 1', current: true }],
      controls: [
        {
          kind: 'button',
          id: 'notebook.previous',
          group: 'pages',
          label: 'Previous page',
          semanticRole: 'notebook.page.previous',
        },
        {
          kind: 'choice',
          id: 'notebook.template',
          group: 'pages',
          label: 'Page paper',
          value: 'blank',
          options: [{ value: 'blank', label: 'Blank' }],
          semanticRole: 'notebook.page.template',
        },
        {
          kind: 'button',
          id: 'notebook.add',
          group: 'pages',
          label: 'Add page',
          semanticRole: 'notebook.page.add',
        },
      ],
    };
    const inspector = projectDocumentInspector(snapshot);
    expect(inspector.pages).toEqual(snapshot.pages);
    expect(
      inspector.sections
        .find((section) => section.id === 'pages')
        ?.controls.map((control) => control.id),
    ).toEqual(['notebook.template']);
  });
});
