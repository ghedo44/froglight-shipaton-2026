// @vitest-environment jsdom
import { act } from 'react';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { notebookKindId } from '@froglight/foundation';
import { TEST_NOTE_KINDS } from '../testing/note-kind-options.js';
import { resolveIconPath } from '../icons.js';
import {
  NewNoteModal,
  type NewNoteChoice,
  type NewNoteOptions,
} from './NewNoteModal.jsx';
import styles from './NewNoteModal.module.css';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

describe('new-note modal', () => {
  let host: HTMLDivElement | null = null;
  let root: Root | null = null;
  let choice: NewNoteChoice | null | undefined;
  let done = false;

  afterEach(async () => {
    if (root !== null) {
      await act(async () => {
        root!.unmount();
      });
    }
    host?.remove();
    host = null;
    root = null;
    choice = undefined;
    done = false;
  });

  async function mount(options?: Partial<NewNoteOptions>): Promise<void> {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        createElement(NewNoteModal, {
          onFinish: (result) => {
            choice = result;
            done = true;
          },
          options: { kinds: TEST_NOTE_KINDS, ...options },
        }),
      );
    });
  }

  async function waitForExit(): Promise<void> {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 210)); });
  }

  const rows = (): NodeListOf<HTMLButtonElement> =>
    document.querySelectorAll(`.${styles['new-note-kinds']} [role="radio"]`);

  function press(key: string): void {
    (document.activeElement ?? document).dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
    );
  }

  async function type(text: string): Promise<void> {
    const input = document.querySelector<HTMLInputElement>(
      `.${styles['new-note-input']}`,
    )!;
    input.value = text;
    await act(async () => {
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it('lists every catalog kind with availability data and focuses the name input', async () => {
    await mount();
    expect(rows().length).toBe(TEST_NOTE_KINDS.length);
    expect(
      document.querySelector<HTMLInputElement>(`.${styles['new-note-input']}`),
    ).toBe(document.activeElement);
    const markdown = rows()[0]!;
    expect(markdown.dataset.available).toBe('true');
    expect(markdown.dataset.selected).toBe('true');
    expect(markdown.tabIndex).toBe(0);
    expect(rows()[1]!.tabIndex).toBe(-1);
    // Markdown, Block page, Ink page, Whiteboard, and Notebook are all creatable.
    for (const row of Array.from(rows())) {
      expect(row.dataset.available).toBe('true');
    }
    expect(rows()[3]!.textContent).toContain('.whiteboard');
    expect(rows()[3]!.textContent).not.toContain('Soon');
  });

  it('shows a distinct matching icon for every document type', async () => {
    await mount();
    const expected = [
      'markdown',
      'blockpage',
      'ink',
      'canvas',
      'notebook',
      'file-latex',
      'database',
    ];
    expect(TEST_NOTE_KINDS.map((kind) => kind.icon)).toEqual(expected);
    for (const [index, name] of expected.entries()) {
      const icon = rows()[index]!.querySelector('svg');
      expect(icon?.classList.contains(`icon-${name}`)).toBe(true);
      expect(icon?.querySelector('path')?.getAttribute('d')).toBe(
        resolveIconPath(name),
      );
    }
    expect(new Set(expected.map(resolveIconPath)).size).toBe(expected.length);
  });

  it('selects a Notebook from the catalog and creates only after confirmation', async () => {
    await mount();
    await act(async () => {
      rows()[4]!.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    });
    expect(done).toBe(false);
    expect(rows()[4]!.dataset.selected).toBe('true');
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          `.${styles['new-note-actions']} button:last-child`,
        )!
        .click();
    });
    await waitForExit();
    expect(choice!.kind.id).toBe('froglight.notebook');
    expect(choice!.kind.extension).toBe('.notebook');
  });

  it('preselects the kind chosen from the New menu', async () => {
    await mount({ initialKindId: String(notebookKindId) });
    expect(rows()[4]!.dataset.selected).toBe('true');
    expect(rows()[0]!.dataset.selected).toBe('false');
  });

  it('Enter creates with the default kind and name', async () => {
    await mount();
    await act(async () => {
      press('Enter');
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitForExit();
    expect(done).toBe(true);
    await waitForExit();
    expect(choice!.kind.id).toBe('froglight.markdown');
    expect(choice!.name).toBe('Untitled');
  });

  it('ArrowDown selects Block page; the typed name travels with the choice', async () => {
    await mount();
    await type('Meeting notes');
    await act(async () => {
      press('ArrowDown');
    });
    expect(rows()[1]!.dataset.selected).toBe('true');
    await act(async () => {
      press('Enter');
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitForExit();
    expect(done).toBe(true);
    await waitForExit();
    expect(choice!.kind.id).toBe('froglight.blockpage');
    expect(choice!.name).toBe('Meeting notes');
  });

  it('clicking Whiteboard selects it for the Create action', async () => {
    await mount();
    await act(async () => {
      rows()[3]!.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    });
    expect(done).toBe(false);
    document
      .querySelector<HTMLButtonElement>(
        `.${styles['new-note-actions']} button:last-child`,
      )!
      .click();
    await act(async () => undefined);
    await waitForExit();
    expect(choice!.kind.id).toBe('froglight.whiteboard');
    expect(choice!.kind.extension).toBe('.whiteboard');
  });

  it('Escape dismisses with null', async () => {
    await mount();
    await act(async () => {
      press('Escape');
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitForExit();
    expect(done).toBe(true);
    expect(choice).toBeNull();
  });

  it('clicking an available kind does not bypass the explicit Create action', async () => {
    await mount();
    await act(async () => {
      rows()[1]!.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    });
    expect(done).toBe(false);
    expect(rows()[1]!.dataset.selected).toBe('true');
  });
});
