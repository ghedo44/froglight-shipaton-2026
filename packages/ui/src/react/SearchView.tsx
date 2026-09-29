import { useEffect, useRef, useState } from 'react';
import { highlightMatches, type SearchUiResult } from '../search-ui.js';
import { Icon } from './Icon.jsx';
import styles from './SearchView.module.css';

const SEARCH_DEBOUNCE_MS = 150;

const HINT_HTML =
  'Tip: match file names or full text. Use <kbd>↑</kbd><kbd>↓</kbd> to navigate and <kbd>Enter</kbd> to open. Middle-click opens a note in a new tab.';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface SearchViewProps {
  readonly onSearch: (query: string) => Promise<readonly SearchUiResult[]>;
  readonly onOpen: (id: string, address?: string) => void;
  readonly onOpenBackground?: (id: string, address?: string) => void;
}

/**
 * Search panel — declarative React over the search-ui service callbacks.
 *
 * Converted from the imperative `renderSearchPanel` builder with identical
 * user-visible behavior: same DOM structure, classes, datasets, placeholder,
 * labels, ordering, debounced search outcomes, grouping, highlight behavior,
 * keyboard navigation, and open/background-open outcomes. Search ranking and
 * `highlightMatches` stay in `search-ui.ts`; this component owns only
 * presentation state (query, results, selection). The view registers as a
 * component; the shell mounts it directly.
 */
export function SearchView(props: SearchViewProps): React.ReactElement {
  const { onSearch, onOpen, onOpenBackground } = props;
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<readonly SearchUiResult[]>([]);
  const [displayQuery, setDisplayQuery] = useState('');
  const [selected, setSelected] = useState(-1);
  const [hasRun, setHasRun] = useState(false);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const outputRef = useRef<HTMLDivElement | null>(null);
  const queryRef = useRef('');
  const generationRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      generationRef.current += 1;
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (selected < 0) return;
    const row =
      outputRef.current?.querySelectorAll<HTMLElement>('.result')[selected];
    if (
      row !== null &&
      row !== undefined &&
      typeof row.scrollIntoView === 'function'
    ) {
      row.scrollIntoView({ block: 'nearest' });
    }
  }, [selected, results, displayQuery]);

  const runSearch = (): void => {
    const current = generationRef.current + 1;
    generationRef.current = current;
    const trimmed = queryRef.current.trim();
    if (trimmed === '') {
      setResults([]);
      setDisplayQuery('');
      setSelected(-1);
      setHasRun(true);
      return;
    }
    void onSearch(trimmed)
      .then((next) => {
        if (current !== generationRef.current || !aliveRef.current) return;
        setResults(next);
        setDisplayQuery(trimmed);
        setSelected(-1);
        setHasRun(true);
      })
      .catch(() => undefined);
  };

  const onQueryChange = (value: string): void => {
    setQuery(value);
    queryRef.current = value;
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (!aliveRef.current) return;
      runSearch();
    }, SEARCH_DEBOUNCE_MS);
  };

  const clearInput = (): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    generationRef.current += 1;
    queryRef.current = '';
    setQuery('');
    setResults([]);
    setDisplayQuery('');
    setSelected(-1);
    setHasRun(true);
    inputRef.current?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      clearInput();
      inputRef.current?.blur();
      return;
    }
    if (results.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelected((current) => Math.min(results.length - 1, current + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelected((current) => Math.max(0, current - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const index = selected >= 0 ? selected : 0;
      const target = results[index];
      if (target !== undefined) onOpen(target.documentId);
    }
  };

  const renderOutput = (): React.ReactNode => {
    if (displayQuery === '') {
      if (!hasRun) {
      return (
        <div
          className={styles['search-hint']}
          dangerouslySetInnerHTML={{ __html: HINT_HTML }}
        />
      );
      }
      return null;
    }
    if (results.length === 0) {
      return (
        <div
          className={styles['search-empty']}
          dangerouslySetInnerHTML={{
            __html: `No results for <strong>${escapeHtml(displayQuery)}</strong>`,
          }}
        />
      );
    }
    const nodes: React.ReactNode[] = [];
    nodes.push(
      <div key="count" className={styles['search-count']}>
        {`${results.length} result${results.length === 1 ? '' : 's'} in this vault`}
      </div>,
    );
    let lastSection: string | null = null;
    results.forEach((result, index) => {
      const section =
        result.matchedIn === 'filename' ? 'File names' : 'Content';
      if (section !== lastSection) {
        lastSection = section;
        nodes.push(
          <div
            key={`section-${section}-${index}`}
            className={styles['search-section']}
          >
            {section}
          </div>,
        );
      }
      const isSelected = index === selected;
      nodes.push(
        <button
          key={`${result.documentId}:${result.address ?? ''}:${index}`}
          type="button"
          className={`${styles.result}${isSelected ? ` ${styles.selected}` : ''}`}
          onClick={() => onOpen(result.documentId, result.address)}
          onAuxClick={(event) => {
            if (event.button === 1) {
              event.preventDefault();
              (onOpenBackground ?? onOpen)(
                result.documentId,
                result.address,
              );
            }
          }}
        >
          <div
            className={styles.title}
            dangerouslySetInnerHTML={{
              __html: highlightMatches(result.title, displayQuery),
            }}
          />
          <div
            className={styles.excerpt}
            dangerouslySetInnerHTML={{
              __html: highlightMatches(result.excerpt, displayQuery),
            }}
          />
        </button>,
      );
    });
    return nodes;
  };

  return (
    <div className={styles['search-panel']} data-fl-component="search-view">
      <div className={styles['explorer-header']}>
        <span className={styles['sidebar-heading']}>Search</span>
      </div>
      <div className={styles['search-field']}>
        <span className={styles['search-field-icon']}>
          <Icon name="search" size={14} />
        </span>
        <input
          ref={(element) => {
            inputRef.current = element;
            // The imperative builder set the IDL property directly; React
            // omits the attribute for `false`, so keep exact parity here.
            if (element !== null) element.spellcheck = false;
          }}
          placeholder="Search files and content…"
          aria-label="Search workspace"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          className={`${styles['search-clear']}${query !== '' ? ` ${styles.visible}` : ''}`}
          aria-label="Clear search"
          onClick={clearInput}
        >
          <Icon name="close" size={13} />
        </button>
      </div>
      <div ref={outputRef} className={styles['search-results']}>
        {renderOutput()}
      </div>
    </div>
  );
}
