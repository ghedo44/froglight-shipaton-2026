// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { createDatabase, newResourceId } from '@froglight/foundation';
import { Cell, DatabaseContent } from './DatabaseContent.js';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

describe('database extension property controls', () => {
  const buttonNamed = (host: HTMLElement, name: string) =>
    [...host.querySelectorAll('button')].find(
      (button) => button.textContent === name,
    );

  it('uses a registered editor and preserves the value when its provider leaves', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const onWrite = vi.fn();
    const property = { id: 'rating', name: 'Rating', type: 'example.rating' };
    try {
      await act(async () => {
        root.render(
          <Cell
            property={property}
            value={3}
            editor="number"
            readOnly={false}
            onWrite={onWrite}
          />,
        );
      });
      const input = host.querySelector<HTMLInputElement>(
        'input[type="number"]',
      );
      expect(input).not.toBeNull();
      await act(async () => {
        if (!input) return;
        input.focus();
        input.value = '4';
        input.blur();
      });
      expect(onWrite).toHaveBeenCalledWith(4);

      await act(async () => {
        root.render(
          <Cell
            property={property}
            value={4}
            readOnly={false}
            onWrite={onWrite}
          />,
        );
      });
      expect(host.querySelector('input')).toBeNull();
      expect(host.textContent).toContain('4');
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it('keeps the edit base while a fresh row arrives during an active draft', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const model = createDatabase('Research');
    model.properties.push({ id: 'rating', name: 'Rating', type: 'number' });
    const id = newResourceId();
    const writeCell = vi.fn(async () => undefined);
    const render = (rating: number) => (
      <DatabaseContent
        model={model}
        view={model.views[0]}
        rows={[
          {
            resourceId: id,
            title: 'Paper',
            kindId: 'example.kind',
            path: 'Paper.md',
            values: { rating },
            diagnostics: {},
          },
        ]}
        readOnly={false}
        write={() => undefined}
        writeCell={writeCell}
        openResource={() => undefined}
      />
    );
    try {
      await act(async () => root.render(render(3)));
      await act(async () =>
        host
          .querySelector<HTMLButtonElement>('button[aria-label^="Edit Rating"]')
          ?.click(),
      );
      await act(async () => root.render(render(4)));
      const input = host.querySelector<HTMLInputElement>(
        'input[aria-label="Rating"]',
      );
      expect(input?.value).toBe('3');
      await act(async () => {
        if (!input) return;
        input.focus();
        input.value = '5';
        input.blur();
      });
      expect(writeCell).toHaveBeenCalledWith(id, 'rating', 5, 3);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it('searches beyond the initial relation page from an active table cell', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const model = createDatabase('Research');
    model.properties.push({ id: 'related', name: 'Related', type: 'relation' });
    const id = newResourceId();
    const distant = newResourceId();
    const writeCell = vi.fn(async () => undefined);
    const loadRelationChoices = vi.fn(async (search: string) => ({
      choices: search ? [{ id: distant, title: 'Zebra' }] : [],
      selected: [],
      hasMore: !search,
    }));
    try {
      await act(async () =>
        root.render(
          <DatabaseContent
            model={model}
            view={model.views[0]}
            rows={[
              {
                resourceId: id,
                title: 'Paper',
                kindId: 'example.kind',
                path: 'Paper.md',
                values: { related: [] },
                diagnostics: {},
              },
            ]}
            readOnly={false}
            write={() => undefined}
            writeCell={writeCell}
            loadRelationChoices={loadRelationChoices}
            openResource={() => undefined}
          />,
        ),
      );
      await act(async () =>
        host
          .querySelector<HTMLButtonElement>(
            'button[aria-label^="Edit Related"]',
          )
          ?.click(),
      );
      await act(async () => buttonNamed(host, 'Choose related')?.click());
      const search = host.querySelector<HTMLInputElement>(
        'input[type="search"]',
      );
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )?.set?.call(search, 'Zebra');
        search?.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(loadRelationChoices).toHaveBeenCalledWith(
        'related',
        'Zebra',
        [],
        expect.any(AbortSignal),
      );
      await act(async () =>
        [...host.querySelectorAll('label')]
          .find((label) => label.textContent?.includes('Zebra'))
          ?.querySelector('input')
          ?.click(),
      );
      expect(writeCell).toHaveBeenCalledWith(id, 'related', [distant], []);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it('discards retained title sessions when a failed edit is abandoned', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    let mounted = true;
    const model = createDatabase('Research');
    const id = newResourceId();
    const discarded = [
      vi.fn(async () => undefined),
      vi.fn(async () => undefined),
      vi.fn(async () => undefined),
      vi.fn(async () => undefined),
    ];
    let attempt = 0;
    const onEditTitle = vi.fn(async () => {
      const index = attempt++;
      const discard = discarded[index];
      if (!discard) throw new Error('Unexpected title save attempt');
      const result = {
        committed: false,
        error: new Error('disk full'),
        derivedError: null,
        retry: async () => result,
        discard,
      };
      return result;
    });
    const render = () => (
      <DatabaseContent
        model={model}
        view={model.views[0]}
        rows={[
          {
            resourceId: id,
            title: 'Paper',
            kindId: 'example.kind',
            path: 'Paper.md',
            values: {},
            diagnostics: {},
          },
        ]}
        readOnly={false}
        write={() => undefined}
        openResource={() => undefined}
        onEditTitle={onEditTitle}
      />
    );
    const editAndFail = async () => {
      await act(async () =>
        host
          .querySelector<HTMLButtonElement>(
            'button[aria-label="Edit document title for Paper"]',
          )
          ?.click(),
      );
      await act(async () =>
        [...host.querySelectorAll('button')]
          .find((button) => button.textContent === 'Save')
          ?.click(),
      );
    };
    try {
      await act(async () => root.render(render()));

      await editAndFail();
      const changed = host.querySelector<HTMLInputElement>(
        'input[aria-label="Document title for Paper"]',
      );
      await act(async () => {
        if (!changed) return;
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )?.set?.call(changed, 'Another title');
        changed.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(discarded[0]).toHaveBeenCalledOnce();

      await act(async () =>
        [...host.querySelectorAll('button')]
          .find((button) => button.textContent === 'Save')
          ?.click(),
      );
      const escaped = host.querySelector<HTMLInputElement>(
        'input[aria-label="Document title for Paper"]',
      );
      await act(async () =>
        escaped?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        ),
      );
      expect(discarded[1]).toHaveBeenCalledOnce();

      await editAndFail();
      await act(async () =>
        [...host.querySelectorAll('button')]
          .find((button) => button.textContent === 'Cancel')
          ?.click(),
      );
      expect(discarded[2]).toHaveBeenCalledOnce();

      await editAndFail();
      await act(async () => root.unmount());
      mounted = false;
      expect(discarded[3]).toHaveBeenCalledOnce();
    } finally {
      if (mounted) {
        await act(async () => root.unmount());
      }
      host.remove();
    }
  });

  it('copies only an explicit contiguous row block across visible property columns', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const model = createDatabase('Research');
    model.properties.push(
      { id: 'topic', name: 'Topic', type: 'text' },
      { id: 'score', name: 'Score', type: 'number' },
    );
    const ids = [newResourceId(), newResourceId(), newResourceId()];
    const writeText = vi.fn(async () => undefined);
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      'clipboard',
    );
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText, readText: vi.fn() },
    });
    try {
      await act(async () =>
        root.render(
          <DatabaseContent
            model={model}
            view={model.views[0]}
            rows={ids.map((resourceId, index) => ({
              resourceId,
              title: `Paper ${index + 1}`,
              kindId: 'example.kind',
              path: `Paper ${index + 1}.md`,
              values: {
                topic: ['Alpha', 'Beta', 'Gamma'][index],
                score: index + 1,
              },
              diagnostics: {},
            }))}
            readOnly={false}
            write={() => undefined}
            openResource={() => undefined}
            onBulkWrite={vi.fn()}
          />,
        ),
      );
      const rowChecks = host.querySelectorAll<HTMLInputElement>(
        'tbody input[type="checkbox"]',
      );
      await act(async () => {
        rowChecks[0]?.click();
        rowChecks[1]?.click();
      });
      const copy = buttonNamed(host, 'Copy cells');
      copy?.focus();
      await act(async () => copy?.click());
      expect(writeText).toHaveBeenCalledWith('Alpha\t1\nBeta\t2');
      expect(document.activeElement).toBe(copy);

      await act(async () => {
        rowChecks[1]?.click();
        rowChecks[2]?.click();
      });
      expect(buttonNamed(host, 'Copy cells')?.disabled).toBe(true);
      expect(host.textContent).toContain('one contiguous block of rows');
    } finally {
      await act(async () => root.unmount());
      host.remove();
      if (clipboardDescriptor)
        Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
      else
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: undefined,
        });
    }
  });

  it('preflights typed paste cells and reports exact partial write failures', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const model = createDatabase('Research');
    model.properties.push(
      { id: 'topic', name: 'Topic', type: 'text' },
      { id: 'score', name: 'Score', type: 'number' },
      { id: 'total', name: 'Total', type: 'formula', expression: 'score' },
    );
    const ids = [newResourceId(), newResourceId()];
    let clipboardText = 'wrong\tbounds';
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      'clipboard',
    );
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn(),
        readText: vi.fn(async () => clipboardText),
      },
    });
    const onBulkWrite = vi.fn(async (propertyId, _value, targets) => {
      const target = targets[0];
      if (!target) throw new Error('Expected one clipboard target');
      const resourceId = target.resourceId;
      const committed = propertyId === 'score' ? [] : [{ resourceId }];
      const failed =
        propertyId === 'score'
          ? [{ resourceId, error: new Error('disk full') }]
          : [];
      const undoResult = {
        reverted: committed,
        failed: [],
        retry: async () => undoResult,
      };
      const result = {
        committed,
        failed,
        retry: async () => result,
        undo: { label: 'Undo paste cell', undo: async () => undoResult },
      };
      return result;
    });
    try {
      await act(async () =>
        root.render(
          <DatabaseContent
            model={model}
            view={model.views[0]}
            rows={ids.map((resourceId, index) => ({
              resourceId,
              title: `Paper ${index + 1}`,
              kindId: 'example.kind',
              path: `Paper ${index + 1}.md`,
              values: {
                topic: `Old ${index + 1}`,
                score: index + 1,
                total: index + 1,
              },
              diagnostics: {},
            }))}
            readOnly={false}
            write={() => undefined}
            openResource={() => undefined}
            onBulkWrite={onBulkWrite}
          />,
        ),
      );
      await act(async () =>
        host
          .querySelector('summary')
          ?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
      );
      await act(async () =>
        host
          .querySelector<HTMLSelectElement>(
            'select[aria-label="Selection scope"]',
          )
          ?.dispatchEvent(new Event('change', { bubbles: true })),
      );
      await act(async () => buttonNamed(host, 'Select scope')?.click());
      await act(async () => buttonNamed(host, 'Paste cells…')?.click());
      expect(host.textContent).toContain(
        'Clipboard bounds are 1 row × 2 columns',
      );

      clipboardText = 'New 1\tbad\tignored\nNew 2\t4\tignored';
      await act(async () => buttonNamed(host, 'Paste cells…')?.click());
      expect(host.textContent).toContain(
        '3 will change · 0 unchanged · 3 rejected',
      );
      expect(host.textContent).toContain('Paper 1 · Score');
      expect(host.textContent).toContain('Expected a finite number');
      expect(host.textContent).toContain('Paper 1 · Total');
      expect(host.textContent).toContain('derived or read-only');

      const confirmation = [
        ...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
      ].find((input) =>
        input.parentElement?.textContent?.includes('Apply the'),
      );
      await act(async () => confirmation?.click());
      await act(async () => buttonNamed(host, 'Apply 3 cells')?.click());
      expect(onBulkWrite).toHaveBeenCalledTimes(3);
      expect(onBulkWrite.mock.calls.map(([propertyId]) => propertyId)).toEqual([
        'topic',
        'topic',
        'score',
      ]);
      expect(host.textContent).toContain('2 committed · 1 write failures');
      expect(host.textContent).toContain('Paper 2 · Score');
      expect(host.textContent).toContain('disk full');
    } finally {
      await act(async () => root.unmount());
      host.remove();
      if (clipboardDescriptor)
        Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
      else
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: undefined,
        });
    }
  });
});
