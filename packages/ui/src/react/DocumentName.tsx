import { isValidSegment } from '@froglight/foundation';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import styles from './DocumentName.module.css';

export interface DocumentNameProps {
  /** Display name without its document extension. */
  readonly name: string;
  readonly editable: boolean;
  readonly extension?: string;
  readonly layout: 'markdown' | 'block' | 'reading' | 'database';
  readonly onRename: (name: string) => Promise<void>;
}

export function DocumentName({
  name,
  editable,
  extension,
  layout,
  onRename,
}: DocumentNameProps): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const titleInputRef = useRef<HTMLTextAreaElement | null>(null);
  const saving = useRef(false);
  const cancelled = useRef(false);

  useLayoutEffect(() => {
    if (!editing) return;
    const input = titleInputRef.current;
    if (!input) return;
    input.setSelectionRange(input.value.length, input.value.length);
  }, [editing]);

  useEffect(() => {
    if (!editable) {
      cancelled.current = true;
      setEditing(false);
      setError('');
    }
  }, [editable]);

  async function save(): Promise<void> {
    if (saving.current || cancelled.current || !editable) return;
    const trimmed = draft.trim();
    const nextName =
      extension && trimmed.toLowerCase().endsWith(extension.toLowerCase())
        ? trimmed.slice(0, -extension.length)
        : trimmed;
    if (nextName === name) {
      setEditing(false);
      return;
    }
    if (!nextName || !isValidSegment(nextName)) {
      setError('Enter a valid document name without a path.');
      return;
    }
    saving.current = true;
    setPending(true);
    setError('');
    try {
      await onRename(nextName);
      setEditing(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      saving.current = false;
      setPending(false);
    }
  }

  return (
    <div className={styles.name} data-layout={layout} data-fl-document-name>
      <div className={styles.measure}>
        {editing && editable ? (
          <div className={styles.editField}>
            <span className={styles.editSizer} aria-hidden="true">
              {draft || '\u00a0'}
            </span>
            <textarea
              ref={titleInputRef}
              autoFocus
              aria-label="Document name"
              rows={1}
              value={draft}
              disabled={pending}
              onChange={(event) => {
                setDraft(event.target.value);
                setError('');
              }}
              onBlur={() => {
                void save();
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void save();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  cancelled.current = true;
                  setEditing(false);
                  setError('');
                }
              }}
            />
          </div>
        ) : (
          <h1>
            {editable ? (
              <button
                type="button"
                aria-label={`Rename ${name}`}
                onClick={() => {
                  cancelled.current = false;
                  setDraft(name);
                  setError('');
                  setEditing(true);
                }}
              >
                {name}
              </button>
            ) : (
              name
            )}
          </h1>
        )}
        {error && <p role="alert">{error}</p>}
      </div>
    </div>
  );
}
