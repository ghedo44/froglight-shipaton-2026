import { Dialog, type DialogHandle } from './primitives/Dialog.jsx';
import { useLayoutEffect, useRef, useState } from 'react';
import type { NoteKindOption } from '../note-kinds.js';
import { Icon } from './Icon.jsx';
import { Button } from './Button.jsx';
import { TextField } from './primitives/Fields.jsx';
import { useAboveKeyboard } from './useAboveKeyboard.js';
import styles from './NewNoteModal.module.css';

export interface NewNoteChoice {
  /** Trimmed display name; callers still normalize paths. */
  readonly name: string;
  readonly kind: NoteKindOption;
  readonly templateId?: string;
}

export interface NewNoteOptions {
  readonly kinds: readonly NoteKindOption[];
  readonly templates?: readonly { id: string; name: string; kindId: string }[];
  /** Select a document kind when the picker is opened from its New menu. */
  readonly initialKindId?: string;
}

/**
 * The new-note picker: a name plus the kind of page to create. Modeled on
 * the quick switcher's keyboard-first grammar — one input, one list, Enter
 * commits — with kind rows standing in for documents. Registered creator
 * capabilities define the types offered by workspace creation surfaces.
 */
export function NewNoteModal(props: {
  onFinish(choice: NewNoteChoice | null): void;
  options: NewNoteOptions;
}): React.ReactElement {
  const { onFinish, options } = props;
  const choices = [...options.kinds]
    .map((kind) => ({ kind, templateId: undefined as string | undefined }));
  for (const template of options?.templates ?? []) {
    const kind = choices.find(
      (choice) => choice.kind.kindId === template.kindId,
    )?.kind;
    if (kind)
      choices.push({
        kind: {
          ...kind,
          id: `template:${template.id}`,
          label: template.name,
          description: `${kind.label} template`,
        },
        templateId: template.id,
      });
  }
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const valueRef = useRef('');
  const finishedRef = useRef(false);
  const closeRef = useRef<DialogHandle | null>(null);
  const [selected, setSelected] = useState(() =>
    Math.max(
      0,
      choices.findIndex(
        (choice) =>
          choice.kind.kindId === options?.initialKindId ||
          (options?.initialKindId === undefined && choice.kind === choices[0]?.kind),
      ),
    ),
  );
  const selectedRef = useRef(selected);
  const dialogRef = useAboveKeyboard<HTMLDivElement>();
  const onDialogKeyDown = (event: KeyboardEvent): void => {
      const inChoices =
        event.target === inputRef.current ||
        (event.target instanceof Element &&
          event.target.getAttribute('role') === 'radio');
      if (!inChoices || event.isComposing) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        commit(selectedRef.current);
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        const onRow =
          document.activeElement?.getAttribute?.('role') === 'radio';
        moveSelection(event.key === 'ArrowDown' ? 1 : -1, onRow);
      }
  };

  const selectableIndexes = choices.flatMap((choice, index) =>
    choice.kind.available ? [index] : [],
  );

  const setSelectedLive = (index: number): void => {
    selectedRef.current = index;
    setSelected(index);
  };

  const focusRow = (index: number): void => {
    const rows =
      listRef.current?.querySelectorAll<HTMLElement>('[role="radio"]');
    rows?.[index]?.focus({ preventScroll: true });
  };

  const moveSelection = (direction: -1 | 1, moveFocus = false): void => {
    if (selectableIndexes.length === 0) return;
    const at = selectableIndexes.indexOf(selectedRef.current);
    const next =
      selectableIndexes[
        (at + direction + selectableIndexes.length) % selectableIndexes.length
      ];
    if (next === undefined) return;
    setSelectedLive(next);
    if (moveFocus) focusRow(next);
  };

  useLayoutEffect(() => {
    // Coarse pointers keep the sheet keyboard-free until the first tap;
    // raising the IME over the kind list is the wrong default there.
    const coarse =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(pointer: coarse)').matches;
    if (coarse) focusRow(selectedRef.current);
    else inputRef.current?.focus();
  }, []);

  const settle = (choice: NewNoteChoice | null): void => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    closeRef.current?.close(() => onFinish(choice));
  };

  const commit = (index: number): void => {
    const choice = choices[index];
    const kind = choice?.kind;
    if (kind === undefined || !kind.available) return;
    const name =
      valueRef.current.trim() === '' ? 'Untitled' : valueRef.current.trim();
    settle({
      name,
      kind,
      ...(choice.templateId ? { templateId: choice.templateId } : {}),
    });
  };

  return (
    <Dialog open onKeyDown={onDialogKeyDown} closeRef={closeRef}
      className={styles['new-note-backdrop']}
      data-fl-component="new-note"
      onClose={() => {
        finishedRef.current = true;
        onFinish(null);
      }}
    >
      <Dialog.Content unstyled
        ref={dialogRef}
        className={styles['new-note']}
        aria-label="Create a new note"
      >
        <TextField
          ref={inputRef}
          type="text"
          className={styles['new-note-input']}
          placeholder="Untitled"
          aria-label="Note name"
          autoComplete="off"
          spellCheck={false}
          maxLength={120}
          onInput={(event) => {
            valueRef.current = event.currentTarget.value;
          }}
        />
        <div
          className={styles['new-note-kinds']}
          role="radiogroup"
          aria-label="Note type"
          ref={listRef}
        >
          {choices.map(({ kind }, index) => (
            <button
              key={kind.id}
              type="button"
              role="radio"
              aria-checked={index === selected}
              aria-disabled={kind.available ? undefined : 'true'}
              data-available={kind.available ? 'true' : 'false'}
              data-selected={index === selected ? 'true' : 'false'}
              tabIndex={index === selected ? 0 : -1}
              onClick={() =>
                kind.available ? setSelectedLive(index) : undefined
              }
            >
              <span
                className={`${styles['new-note-icon']}${kind.available ? '' : ` ${styles.future}`}`}
              >
                <Icon name={kind.icon} size={20} />
              </span>
              <span className={styles['new-note-kind-main']}>
                <span className={styles['new-note-kind-label']}>
                  {kind.label}
                </span>
                <span className={styles['new-note-kind-description']}>
                  {kind.description}
                </span>
              </span>
              <span className={styles['new-note-kind-side']}>
                <code className={styles['new-note-ext']}>
                  {kind.extension}
                </code>
              </span>
            </button>
          ))}
        </div>
        <div className={styles['new-note-footer']}>
          <div className={styles['new-note-hints']}>
            <span>
              <kbd>↑↓</kbd> choose
            </span>
            <span>
              <kbd>Enter</kbd> create
            </span>
            <span>
              <kbd>Esc</kbd> cancel
            </span>
          </div>
          <div className={styles['new-note-actions']}>
            <Button
              type="button"
              variant="secondary"
              onClick={() => settle(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={() => commit(selected)}
            >
              Create
            </Button>
          </div>
        </div>
      </Dialog.Content>
    </Dialog>
  );
}
