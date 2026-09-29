import { Dialog, type DialogHandle } from '../primitives/Dialog.jsx';
import { SearchField } from '../primitives/Fields.jsx';
import { useAboveKeyboard } from '../useAboveKeyboard.js';
/**
 * Shared surface reference picker dialog.
 *
 * Search + recent + keyboard + touch; no-match empty state; every option is
 * a real `<button>` with a >=44px hit target, no hover-only paths, and a
 * visible `:focus-visible` ring. The dialog owns no workspace access: the
 * host passes `suggestions` (from
 * `packages/application/src/resource-resolver.ts`) plus `recent`, and this
 * component filters via `resource-picker-model.ts`.
 *
 * Keyboard contract: ArrowDown/ArrowUp move the active option, Home/End
 * jump, Enter picks the active option, Escape closes. The whole contract is
 * handled at the dialog level (input and option keydowns bubble there) so it
 * works with focus on the search field or on any option button; Enter with
 * focus on an option commits through that button's native click path.
 * Cancel closes without picking. Pointer and touch commit via direct button
 * activation. The active option is exposed through `aria-activedescendant`
 * and `aria-selected` for screen readers.
 *
 * Empty-query layout: recent entries render as a `Recent` section above the
 * `All` suggestions section inside one listbox, sharing one
 * active-descendant index (arrow keys move across the Recent/All boundary;
 * Enter commits the active row via its own path: recent rows use
 * `onPickRecent`/`onPick`, suggestion rows use `onPick`).
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ResourceSuggestion } from '@froglight/foundation';
import {
  activeSuggestion,
  clampActiveIndex,
  filterSuggestions,
  isNoMatch,
  moveActiveIndex,
  noMatchCopy,
  type RecentResourceEntry,
} from './resource-picker-model.js';
import styles from './picker.module.css';

export interface ResourcePickerProps {
  /** Workspace suggestions for the current query (resolver output). */
  readonly suggestions: readonly ResourceSuggestion[];
  /** MRU of previously picked resources, shown when the query is empty. */
  readonly recent?: readonly RecentResourceEntry[];
  /** Placeholder for the search field. */
  readonly placeholder?: string;
  /** Accessible label for the dialog. */
  readonly label?: string;
  /** Commit a suggestion (insert at the host's expected surface position). */
  readonly onPick: (suggestion: ResourceSuggestion) => void;
  /** Commit a recent entry (same insert path, identity-stable). */
  readonly onPickRecent?: (entry: RecentResourceEntry) => void;
  /** Close without picking (Escape, backdrop, Cancel). */
  readonly onClose: () => void;
}

export function ResourcePicker(props: ResourcePickerProps): React.ReactElement {
  const {
    suggestions,
    recent = [],
    placeholder = 'Search documents\u2026',
    label = 'Insert reference',
    onPick,
    onPickRecent,
    onClose,
  } = props;
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const aboveKeyboard = useAboveKeyboard<HTMLDivElement>();
  const listId = useId();
  const closedRef = useRef(false);
  const dialogCloseRef = useRef<DialogHandle | null>(null);

  const visible = useMemo(
    () => filterSuggestions(query, suggestions),
    [query, suggestions],
  );
  const queryEmpty = query.trim() === '';
  // Recent shows only on an empty query, above the full suggestion list.
  const recentVisible = queryEmpty ? recent : [];
  const combinedCount = queryEmpty
    ? recentVisible.length + visible.length
    : visible.length;
  const noMatch = isNoMatch(query, visible);

  useEffect(() => {
    setActive((current) => clampActiveIndex(current, combinedCount));
  }, [combinedCount]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const settle = (finish: () => void): void => {
    if (closedRef.current) return;
    closedRef.current = true;
    dialogCloseRef.current?.close(finish);
  };
  const closeOnce = (): void => settle(onClose);

  const commitIndex = (index: number): void => {
    const choice = activeSuggestion(visible, index);
    if (choice === null) return;
    settle(() => onPick(choice));
  };

  const commitRecent = (entry: RecentResourceEntry): void => {
    if (onPickRecent !== undefined) {
      settle(() => onPickRecent(entry));
      return;
    }
    settle(() => onPick({
      target: entry.target,
      label: entry.label,
    }));
  };

  const commitActive = (index: number): void => {
    if (queryEmpty) {
      if (index < 0 || index >= combinedCount) return;
      if (index < recentVisible.length) {
        const entry = recentVisible[index];
        if (entry !== undefined) commitRecent(entry);
        return;
      }
      commitIndex(index - recentVisible.length);
      return;
    }
    commitIndex(index);
  };

  // Dialog-level keyboard contract: input keydowns bubble here, and option
  // buttons bubble here too, so arrows/Home/End/Enter/Escape work with focus
  // on the search field or on any option (single handler, never double).
  const onDialogKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((current) => moveActiveIndex(current, 1, combinedCount));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((current) => moveActiveIndex(current, -1, combinedCount));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActive(clampActiveIndex(0, combinedCount));
    } else if (event.key === 'End') {
      event.preventDefault();
      setActive(clampActiveIndex(combinedCount - 1, combinedCount));
    } else if (event.key === 'Enter') {
      // Let option buttons commit through their native click path; only the
      // search field commits via the active-descendant index here.
      if (event.target === inputRef.current) {
        event.preventDefault();
        commitActive(active);
      }
    }
  };

  const activeId = combinedCount > 0 ? `${listId}-option-${active}` : undefined;

  return (
    <Dialog open closeRef={dialogCloseRef} data-fl-component="resource-picker" onClose={() => {
      closedRef.current = true;
      onClose();
    }}>
      <Dialog.Content unstyled
        ref={aboveKeyboard}
        aria-label={label}
        className={styles['picker-dialog']}
        onKeyDown={onDialogKeyDown}
      >
        <div className={styles['picker-input-row']}>
          <SearchField
            ref={inputRef}
            role="combobox"
            aria-expanded={!noMatch}
            aria-controls={listId}
            aria-activedescendant={activeId}
            aria-label={label}
            className={styles['picker-input']}
            placeholder={placeholder}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </div>
        {noMatch ? (
          <div
            id={listId}
            role="status"
            className={styles['picker-empty']}
            data-testid="picker-empty"
          >
            {noMatchCopy(query)}
          </div>
        ) : !queryEmpty ? (
          <div
            id={listId}
            role="listbox"
            aria-label="Matching references"
            className={styles['picker-list']}
          >
            {visible.map((suggestion, index) => (
              <button
                key={`${suggestion.target.documentId} ${suggestion.target.resourceId} ${suggestion.target.address ?? ''} ${index}`}
                id={`${listId}-option-${index}`}
                type="button"
                role="option"
                aria-selected={index === active}
                data-active={index === active}
                className={styles['picker-option']}
                onMouseEnter={() => setActive(index)}
                onFocus={() => setActive(index)}
                onClick={() => commitIndex(index)}
              >
                <span className={styles['picker-option-label']}>
                  {suggestion.label}
                </span>
                {suggestion.detail !== undefined && (
                  <span className={styles['picker-option-detail']}>
                    {suggestion.detail}
                  </span>
                )}
              </button>
            ))}
          </div>
        ) : combinedCount === 0 ? (
          <div
            id={listId}
            role="listbox"
            aria-label="Recent references"
            className={styles['picker-list']}
          >
            <div
              role="status"
              className={styles['picker-empty']}
              data-testid="picker-recent-empty"
            >
              No recent references yet. Search above to insert a reference.
            </div>
          </div>
        ) : (
          <div
            id={listId}
            role="listbox"
            aria-label="References"
            className={styles['picker-list']}
          >
            {recentVisible.length > 0 && (
              <>
                <div className={styles['picker-section-label']}>Recent</div>
                {recentVisible.map((entry, index) => (
                  <button
                    key={`recent ${entry.target.documentId} ${entry.target.resourceId} ${entry.target.address ?? ''} ${index}`}
                    id={`${listId}-option-${index}`}
                    type="button"
                    role="option"
                    aria-selected={index === active}
                    data-active={index === active}
                    className={styles['picker-option']}
                    onMouseEnter={() => setActive(index)}
                    onFocus={() => setActive(index)}
                    onClick={() => commitRecent(entry)}
                  >
                    <span className={styles['picker-option-label']}>
                      {entry.label}
                    </span>
                  </button>
                ))}
              </>
            )}
            {visible.length > 0 && (
              <>
                <div className={styles['picker-section-label']}>All</div>
                {visible.map((suggestion, index) => {
                  const optionIndex = recentVisible.length + index;
                  return (
                    <button
                      key={`all ${suggestion.target.documentId} ${suggestion.target.resourceId} ${suggestion.target.address ?? ''} ${index}`}
                      id={`${listId}-option-${optionIndex}`}
                      type="button"
                      role="option"
                      aria-selected={optionIndex === active}
                      data-active={optionIndex === active}
                      className={styles['picker-option']}
                      onMouseEnter={() => setActive(optionIndex)}
                      onFocus={() => setActive(optionIndex)}
                      onClick={() => commitIndex(index)}
                    >
                      <span className={styles['picker-option-label']}>
                        {suggestion.label}
                      </span>
                      {suggestion.detail !== undefined && (
                        <span className={styles['picker-option-detail']}>
                          {suggestion.detail}
                        </span>
                      )}
                    </button>
                  );
                })}
              </>
            )}
          </div>
        )}
        <div className={styles['picker-footer']}>
          <button
            type="button"
            className={styles['picker-cancel']}
            onClick={closeOnce}
          >
            Cancel
          </button>
        </div>
      </Dialog.Content>
    </Dialog>
  );
}
