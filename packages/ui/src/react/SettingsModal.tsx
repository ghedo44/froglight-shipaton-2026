import { Dialog, type DialogHandle } from './primitives/Dialog.jsx';
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type Ref } from 'react';
import type {
  SettingsSectionDef,
  SettingsSectionRegistry,
} from '../settings-registry.js';
import { resolveIconPath } from '../icons.js';
import { Icon } from './Icon.jsx';
import { IconButton } from './Button.jsx';
import { TextField } from './primitives/Fields.jsx';
import { useAboveKeyboard } from './useAboveKeyboard.js';
import styles from './SettingsModal.module.css';
import { reveal } from './overlays.jsx';

/**
 * The settings modal: an almost-full-screen dialog with a searchable section
 * nav (Obsidian pattern) and a content pane that mounts the active section's
 * imperative render. Sections come from the settings-section registry, so
 * first-party and plugin contributions are indistinguishable here.
 *
 * Presentation is in-app on every host: a second browsing context would fork
 * the runtime and contend for workspace storage, so the modal is the contract.
 */
export function SettingsModal(props: {
  registry: SettingsSectionRegistry;
  onClose: () => void;
  closeRef?: Ref<DialogHandle>;
  initialSectionId?: string;
}): React.ReactElement {
  const { registry, onClose, closeRef: externalCloseRef, initialSectionId } = props;
  const [sections, setSections] = useState<readonly SettingsSectionDef[]>(() =>
    registry.list(),
  );
  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState<string | null>(
    () =>
      registry.get(initialSectionId ?? '')?.id ??
      registry.list()[0]?.id ??
      null,
  );
  const searchRef = useRef<HTMLInputElement | null>(null);
  const navListRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<DialogHandle | null>(null);
  const glideRef = useAboveKeyboard<HTMLDivElement>();

  const focusInitial = useCallback((): void => {
    // Coarse-pointer devices (phones/tablets) should not auto-focus the
    // search field: the virtual keyboard would cover the modal. Desktop
    // keyboards still get the search focus for fast filtering.
    const coarsePointer =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(pointer: coarse)').matches;
    const target = coarsePointer
      ? dialogRef.current?.querySelector<HTMLElement>(
          '[aria-label="Close settings"]',
        )
      : searchRef.current;
    target?.focus({ preventScroll: true });
  }, []);

  // Keep the section list in sync with the registry; the selection fallback
  // below guarantees a plugin unloading mid-session never leaves a dangling
  // pane.
  useLayoutEffect(() => {
    const sync = (): void => setSections(registry.list());
    sync();
    return registry.onDidChange(sync).dispose;
  }, [registry]);

  const matches = useMemo(
    () => filterSections(sections, query),
    [sections, query],
  );

  useLayoutEffect(() => {
    setActiveId((id) => {
      if (id !== null && matches.some((section) => section.id === id))
        return id;
      return matches[0]?.id ?? null;
    });
  }, [matches]);

  useLayoutEffect(() => {
    focusInitial();
    const onFocus = (event: FocusEvent): void => {
      if (dialogRef.current?.closest('[data-closing]')) return;
      const target = event.target;
      if (!(target instanceof Element) || dialogRef.current?.contains(target))
        return;
      // Portal-based prompts and menus are child layers with their own focus.
      if (
        target.closest('[role="dialog"], [role="alertdialog"], [role="menu"]')
      )
        return;
      // An editor finishing its async mount must not take focus from a modal.
      focusInitial();
    };
    document.addEventListener('focusin', onFocus);
    return () => {
      document.removeEventListener('focusin', onFocus);
    };
  }, [focusInitial]);

  // Arrow-key navigation across the filtered sections from search or nav.
  const moveSelection = (delta: number, focus: boolean): void => {
    if (matches.length === 0) return;
    const index = matches.findIndex((section) => section.id === activeId);
    const next = Math.max(
      0,
      Math.min(matches.length - 1, (index < 0 ? 0 : index) + delta),
    );
    const id = matches[next]!.id;
    setActiveId(id);
    if (focus)
      navListRef.current
        ?.querySelector<HTMLElement>(`[data-section-id="${CSS.escape(id)}"]`)
        ?.focus();
  };

  const onNavKeyDown = (event: React.KeyboardEvent): void => {
    // Arrow navigation belongs to the section list: from the search field or
    // the nav itself. Focused content controls (slider, select) keep their
    // own arrow semantics.
    const target = event.target as HTMLElement;
    const inSearch = target.classList.contains(styles['settings-search']);
    const inNavList =
      target.closest(`.${styles['settings-nav-list']}`) !== null;
    if (!inSearch && !inNavList) return;
    if (
      event.key === 'ArrowDown' ||
      (inNavList && event.key === 'ArrowRight')
    ) {
      event.preventDefault();
      moveSelection(1, inNavList);
    } else if (
      event.key === 'ArrowUp' ||
      (inNavList && event.key === 'ArrowLeft')
    ) {
      event.preventDefault();
      moveSelection(-1, inNavList);
    } else if (event.key === 'Enter' && inSearch) {
      event.preventDefault();
      navListRef.current
        ?.querySelector<HTMLElement>('[aria-selected="true"]')
        ?.focus();
    }
  };

  useLayoutEffect(() => {
    reveal(
      navListRef.current?.querySelector<HTMLElement>(
        `.${styles['settings-nav-item']}[data-section-id="${CSS.escape(activeId ?? '')}"]`,
      ),
    );
  }, [activeId, matches]);

  const groups = groupSections(matches);

  return (
    <Dialog open closeRef={(handle) => {
      closeRef.current = handle;
      if (typeof externalCloseRef === 'function') externalCloseRef(handle);
      else if (externalCloseRef) externalCloseRef.current = handle;
    }}
      className={styles['settings-backdrop']}
      data-fl-component="settings-modal"
      onClose={onClose}
    >
      <Dialog.Content unstyled
        ref={(node) => {
          dialogRef.current = node;
          glideRef(node);
        }}
        className={styles['settings-modal']}
        aria-label="Settings"
        onKeyDown={onNavKeyDown}
      >
        <nav className={styles['settings-nav']} aria-label="Settings sections">
          <h1 className={styles['settings-title']}>Settings</h1>
          <div className={styles['settings-search-wrap']}>
            <Icon name="search" size={14} />
            <TextField
              ref={searchRef}
              type="text"
              className={styles['settings-search']}
              placeholder="Search settings…"
              aria-label="Search settings"
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div
            className={styles['settings-nav-list']}
            ref={navListRef}
            role="listbox"
            aria-label="Sections"
          >
            {matches.length === 0 ? (
              <div className={styles['settings-empty']}>
                {query.trim() === ''
                  ? 'No settings available'
                  : `No settings match “${query.trim()}”`}
              </div>
            ) : (
              groups.map((group) => (
                <div key={group.name} className={styles['settings-nav-group']}>
                  <div
                    className={styles['settings-nav-group-label']}
                    data-group-name={group.name}
                  >
                    {group.name}
                  </div>
                  {group.sections.map((section) => {
                    const active = section.id === activeId;
                    return (
                      <button
                        key={section.id}
                        type="button"
                        className={`${styles['settings-nav-item']}${active ? ` ${styles.active}` : ''}`}
                        role="option"
                        aria-selected={active}
                        tabIndex={active ? 0 : -1}
                        data-section-id={section.id}
                        data-name={section.name}
                        onClick={() => setActiveId(section.id)}
                      >
                        <span className={styles['settings-nav-icon']}>
                          {section.icon !== undefined &&
                          resolveIconPath(section.icon) !== undefined ? (
                            <Icon name={section.icon} size={15} />
                          ) : null}
                        </span>
                        <span className={styles['settings-nav-name']}>
                          {section.name}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </nav>
        <IconButton
          icon="close"
          size={15}
          label="Close settings"
          title="Close settings"
          className={styles['settings-close']}
          onClick={() => closeRef.current?.close()}
        />
        <div className={styles['settings-main']}>
          {/* Keyed per section: each render gets a fresh container it owns,
              and its disposer runs when the section changes or unmounts. */}
          <SectionHost
            key={activeId ?? 'none'}
            section={
              matches.find((candidate) => candidate.id === activeId) ??
              sections.find((candidate) => candidate.id === activeId)
            }
          />
        </div>
      </Dialog.Content>
    </Dialog>
  );
}

/**
 * Host one settings section's component — the only presentation shape.
 * The section registry requires `component`, so the fallback only guards
 * untyped JavaScript callers.
 */
function SectionHost(props: {
  section: SettingsSectionDef | undefined;
}): React.ReactElement {
  const { section } = props;
  const Component = section?.component;
  return (
    <div className={styles['settings-content']}>
      {Component !== undefined ? <Component /> : null}
    </div>
  );
}

interface SectionGroup {
  readonly name: string;
  readonly sections: readonly SettingsSectionDef[];
}

/** The registry list is pre-sorted, so groups are contiguous runs. */
function groupSections(
  sections: readonly SettingsSectionDef[],
): readonly SectionGroup[] {
  const groups: SectionGroup[] = [];
  for (const section of sections) {
    const name = section.group ?? 'Plugins';
    const last = groups[groups.length - 1];
    if (last !== undefined && last.name === name) {
      groups[groups.length - 1] = {
        name,
        sections: [...last.sections, section],
      };
    } else {
      groups.push({ name, sections: [section] });
    }
  }
  return groups;
}

/** AND-of-substrings match over name, keywords, and group, ASCII-folded. */
function filterSections(
  sections: readonly SettingsSectionDef[],
  query: string,
): readonly SettingsSectionDef[] {
  const terms = fold(query)
    .split(/\s+/)
    .filter((term) => term.length > 0);
  if (terms.length === 0) return sections;
  return sections.filter((section) => {
    const haystack = fold(
      [section.name, section.group ?? '', ...(section.keywords ?? [])].join(
        '\n',
      ),
    );
    return terms.every((term) => haystack.includes(term));
  });
}

function fold(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{Combining_Mark}/gu, '')
    .toLowerCase();
}
