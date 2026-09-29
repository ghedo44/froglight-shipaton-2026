import { describe, expect, it } from 'vitest';
import {
  createDocumentToolbarRegistry,
  type DocumentToolbarContext,
} from './document-toolbar-registry.js';

const context = (kindId: string): DocumentToolbarContext => ({
  pane: 'main',
  documentId: 'doc-1',
  kindId,
  editor: { context: 'Paragraph', controls: [] },
});

describe('document toolbar registry', () => {
  it('owns reversible contextual contributions', async () => {
    const created = createDocumentToolbarRegistry();
    const calls: string[] = [];
    const registration = created.registry.register({
      id: 'acme.markdown-tools',
      when: ({ kindId }) => kindId === 'froglight.markdown',
      controls: () => [
        {
          kind: 'button',
          id: 'acme.cite',
          group: 'references',
          label: 'Insert citation',
        },
      ],
      execute: (_context, id) => {
        calls.push(id);
        return true;
      },
    });

    expect(created.registry.controls(context('froglight.ink'))).toEqual([]);
    expect(
      created.registry
        .controls(context('froglight.markdown'))
        .map(({ id }) => id),
    ).toEqual(['acme.cite']);
    expect(
      await created.registry.execute(
        context('froglight.markdown'),
        'acme.cite',
      ),
    ).toBe(true);
    expect(calls).toEqual(['acme.cite']);

    registration.dispose();
    expect(created.registry.controls(context('froglight.markdown'))).toEqual(
      [],
    );
    created.dispose();
  });

  it('restores a shadowed contribution when its replacement disposes', () => {
    const created = createDocumentToolbarRegistry();
    const first = created.registry.register({
      id: 'acme.tools',
      controls: () => [
        { kind: 'status', id: 'first', group: 'meta', label: 'First' },
      ],
      execute: () => false,
    });
    const replacement = created.registry.register({
      id: 'acme.tools',
      controls: () => [
        { kind: 'status', id: 'second', group: 'meta', label: 'Second' },
      ],
      execute: () => false,
    });

    expect(created.registry.controls(context('any'))[0]?.id).toBe('second');
    replacement.dispose();
    expect(created.registry.controls(context('any'))[0]?.id).toBe('first');
    first.dispose();
  });
});
