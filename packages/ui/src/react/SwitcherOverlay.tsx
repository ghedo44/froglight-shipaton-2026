import { Dialog, type DialogHandle } from './primitives/Dialog.jsx';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { rankDocuments, type SwitcherDocument } from '../switcher.js';
import { highlightMatches, type SearchUiResult } from '../search-ui.js';
import { Icon } from './Icon.jsx';
import { reveal } from './overlays.jsx';
import styles from './SwitcherOverlay.module.css';

/**
 * Quick switcher — a keyboard-first palette for jumping between documents
 * (Ctrl/Cmd P). Ranking lives in the pure module; this component owns the
 * overlay interaction.
 */
export function SwitcherOverlay(props: {
  listDocuments: () => readonly SwitcherDocument[];
  search?: (query: string) => Promise<readonly SearchUiResult[]>;
  onPick: (documentId: string, address?: string) => void;
  onClose: () => void;
  label?: string;
  placeholder?: string;
  actionVerb?: string;
  emptyMessage?: string;
}): React.ReactElement {
  const {
    listDocuments,
    search,
    onPick,
    onClose,
    label,
    placeholder,
    actionVerb = 'open',
    emptyMessage,
  } = props;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const settledRef = useRef(false);
  const dialogCloseRef = useRef<DialogHandle | null>(null);
  const listId = useId();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [searchState, setSearchState] = useState<{
    query: string;
    results: readonly SearchUiResult[];
  }>({ query: '', results: [] });

  const quickMatches = rankDocuments(listDocuments(), query);
  const normalizedQuery = query.trim();
  const searchMatches =
    searchState.query === normalizedQuery ? searchState.results : [];
  const useSearchMatches = normalizedQuery !== '' && searchMatches.length > 0;
  const matches = !useSearchMatches
    ? quickMatches.map((entry) => ({
        kind: 'quick' as const,
        documentId: entry.document.documentId,
        title: entry.document.title,
        detail: entry.document.path,
        positions: entry.positions,
      }))
    : searchMatches.map((entry) => ({
        kind: 'search' as const,
        documentId: entry.documentId,
        title: entry.title,
        detail: entry.excerpt,
        ...(entry.address === undefined ? {} : { address: entry.address }),
      }));
  const safeSelected = Math.max(0, Math.min(selected, matches.length - 1));

  useEffect(() => {
    if (search === undefined || normalizedQuery === '') {
      setSearchState({ query: normalizedQuery, results: [] });
      return;
    }
    let current = true;
    void search(normalizedQuery)
      .then((results) => {
        if (current) setSearchState({ query: normalizedQuery, results });
      })
      .catch(() => {
        if (current) setSearchState({ query: normalizedQuery, results: [] });
      });
    return () => {
      current = false;
    };
  }, [normalizedQuery, search]);

  const close = useCallback((after?: () => void): void => {
    if (settledRef.current) return;
    settledRef.current = true;
    dialogCloseRef.current?.close(after ?? onClose);
  }, [onClose]);

  useLayoutEffect(() => {
    inputRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    reveal(
      listRef.current?.querySelectorAll<HTMLElement>(
        `.${styles['switcher-row']}`,
      )[safeSelected],
    );
  }, [safeSelected, query]);

  const pick = (index: number): void => {
    const entry = matches[index];
    if (entry === undefined || settledRef.current) return;
    close(() => {
      onClose();
      onPick(
        entry.documentId,
        entry.kind === 'search' ? entry.address : undefined,
      );
    });
  };

  const highlightHtml = (
    text: string,
    positions: readonly number[],
  ): string => {
    const set = new Set(positions);
    let out = '';
    for (const [index, character] of [...text].entries()) {
      out += set.has(index)
        ? `<mark>${escapeHtml(character)}</mark>`
        : escapeHtml(character);
    }
    return out;
  };

  return (
    <Dialog open closeRef={dialogCloseRef}
      className={styles['switcher-backdrop']}
      data-fl-component="switcher"
      onClose={() => { settledRef.current = true; onClose(); }}
    >
      <Dialog.Content unstyled
        className={styles.switcher}
        aria-label={
          label ??
          (search === undefined ? 'Quick switcher' : 'Search workspace')
        }
      >
        <input
          ref={inputRef}
          type="text"
          placeholder={
            placeholder ??
            (search === undefined
              ? 'Find or create a note…'
              : 'Search files and content…')
          }
          autoComplete="off"
          spellCheck={false}
          value={query}
          aria-controls={listId}
          aria-activedescendant={
            matches.length > 0 ? `${listId}-option-${safeSelected}` : undefined
          }
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setSelected(Math.min(matches.length - 1, safeSelected + 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setSelected(Math.max(0, safeSelected - 1));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              pick(safeSelected);
            }
          }}
        />
        <div
          id={listId}
          className={styles['switcher-list']}
          role="listbox"
          ref={listRef}
        >
          {matches.length === 0 ? (
            <div className={styles['switcher-empty']}>
              {query.trim() === ''
                ? (emptyMessage ?? 'Type to search your notes')
                : `No documents match “${query.trim()}”`}
            </div>
          ) : (
            matches.map((entry, index) => {
              return (
                <button
                  key={entry.documentId}
                  id={`${listId}-option-${index}`}
                  type="button"
                  className={`${styles['switcher-row']}${index === safeSelected ? ` ${styles.selected}` : ''}`}
                  role="option"
                  aria-selected={index === safeSelected}
                  tabIndex={-1}
                  data-selected={index === safeSelected ? 'true' : 'false'}
                  onClick={() => pick(index)}
                >
                  <span className={styles['switcher-icon']}>
                    <Icon name="file" size={15} />
                  </span>
                  <span className={styles['switcher-main']}>
                    <span
                      className={styles['switcher-title']}
                      // Pre-escaped, position-marked projection of the title.
                      dangerouslySetInnerHTML={{
                        __html:
                          entry.kind === 'quick'
                            ? highlightHtml(entry.title, entry.positions)
                            : highlightMatches(entry.title, query),
                      }}
                    />
                    <span
                      className={styles['switcher-path']}
                      {...(entry.kind === 'quick'
                        ? {}
                        : {
                            dangerouslySetInnerHTML: {
                              __html: highlightMatches(entry.detail, query),
                            },
                          })}
                    >
                      {entry.kind === 'quick' ? entry.detail : null}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>
        <div className={styles['switcher-footer']}>
          {(
            [
              ['↑↓', 'navigate'],
              ['Enter', actionVerb],
              ['Esc', 'dismiss'],
            ] as const
          ).map(([key, label]) => (
            <span key={key}>
              <kbd>{key}</kbd> {label}
            </span>
          ))}
        </div>
      </Dialog.Content>
    </Dialog>
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
