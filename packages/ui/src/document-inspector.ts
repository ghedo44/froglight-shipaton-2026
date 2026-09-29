import type {
  DocumentToolControl,
  DocumentToolSnapshot,
} from '@froglight/foundation';

export interface DocumentInspectorSection {
  readonly id: 'pages' | 'canvas' | 'selection';
  readonly label: string;
  readonly controls: readonly DocumentToolControl[];
}

export interface DocumentInspectorSnapshot {
  readonly sections: readonly DocumentInspectorSection[];
  readonly pages?: DocumentToolSnapshot['pages'];
}

/** Project provider controls into property surfaces without copying their state. */
export function projectDocumentInspector(
  snapshot: DocumentToolSnapshot | null,
): DocumentInspectorSnapshot {
  if (snapshot === null) return { sections: [] };
  const pages: DocumentToolControl[] = [];
  const canvas: DocumentToolControl[] = [];
  const selection: DocumentToolControl[] = [];
  for (const control of snapshot.controls) {
    const role = control.semanticRole ?? '';
    if (
      role.startsWith('notebook.page.') ||
      role.startsWith('notebook.paper.') ||
      control.group === 'pages'
    ) {
      if (
        ![
          'notebook.page.overview',
          'notebook.page.previous',
          'notebook.page.next',
          'notebook.page.go-to',
          'notebook.page.add',
          'notebook.page.duplicate',
          'notebook.page.delete',
        ].includes(role) &&
        ![
          'notebook.previous',
          'notebook.next',
          'notebook.page',
          'notebook.go-to-page',
        ].includes(control.id) &&
        !control.id.startsWith('notebook.insert-')
      )
        pages.push(control);
    } else if (
      role.startsWith('ink.canvas.') ||
      role.startsWith('surface.canvas.')
    ) {
      if (!role.endsWith('.export')) canvas.push(control);
    } else if (
      snapshot.contextualAnchor !== undefined &&
      (role.startsWith('surface.selection.') ||
        role.startsWith('surface.text.') ||
        control.id.includes('.selection.'))
    ) {
      if (control.kind !== 'button') selection.push(control);
    }
  }
  const sections: DocumentInspectorSection[] = [];
  if (pages.length > 0)
    sections.push({ id: 'pages', label: 'Pages', controls: pages });
  if (canvas.length > 0)
    sections.push({ id: 'canvas', label: 'Canvas', controls: canvas });
  if (selection.length > 0)
    sections.push({ id: 'selection', label: 'Selection', controls: selection });
  return {
    sections,
    ...(snapshot.pages !== undefined ? { pages: snapshot.pages } : {}),
  };
}
