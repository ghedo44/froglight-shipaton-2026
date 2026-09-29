import { useEffect, useId, useRef, useState } from 'react';
import {
  throwIfDatabaseQueryAborted,
  type DatabaseRelationChoice,
  type DatabaseDefinitions,
  type DatabaseProperty,
  type DatabaseQueryProvider,
  type EvaluatedDatabaseRow,
  type PropertyValue,
  type ResourceId,
  type ResourcePropertyRow,
  type ResourcePropertyRowSource,
  captureDatabaseEvaluationContext,
} from '@froglight/foundation';
import styles from './RightSidebarPanels.module.css';

const MAX_VISIBLE_RELATION_CHOICES = 50;
export type RelationChoicePage = {
  readonly choices: readonly DatabaseRelationChoice[];
  readonly selected: readonly DatabaseRelationChoice[];
  readonly hasMore: boolean;
};

export function boundedRelationChoices(
  rows: Iterable<EvaluatedDatabaseRow>,
  selected: ReadonlySet<string>,
  signal?: AbortSignal,
): RelationChoicePage {
  const choices: DatabaseRelationChoice[] = [];
  const selectedChoices: DatabaseRelationChoice[] = [];
  const unresolved = new Set(selected);
  let hasMore = false;
  for (const row of rows) {
    throwIfDatabaseQueryAborted(signal);
    const visible = choices.length < MAX_VISIBLE_RELATION_CHOICES;
    const isSelected = unresolved.delete(row.resourceId);
    if (!visible && !isSelected) {
      hasMore = true;
      continue;
    }
    const choice = { id: row.resourceId, title: row.title };
    if (isSelected) selectedChoices.push(choice);
    if (visible) choices.push(choice);
    else hasMore = true;
    if (hasMore && unresolved.size === 0) break;
  }
  return { choices, selected: selectedChoices, hasMore };
}

export async function loadDatabaseRelationChoicePage(
  property: DatabaseProperty,
  definitions: DatabaseDefinitions | undefined,
  query: DatabaseQueryProvider,
  rows: readonly ResourcePropertyRow[] | ResourcePropertyRowSource,
  search: string,
  selected: readonly ResourceId[],
  signal: AbortSignal,
): Promise<RelationChoicePage> {
  throwIfDatabaseQueryAborted(signal);
  if (property.type !== 'relation')
    return { choices: [], selected: [], hasMore: false };
  const targetId = property.relation?.databaseId;
  let matches: Iterable<EvaluatedDatabaseRow>;
  if (targetId) {
    const target = definitions?.get(targetId as ResourceId);
    matches = target
      ? await query.execute(
          target,
          { id: 'relation-picker', name: '', type: 'table' },
          rows,
          search,
          {
            signal,
            limit: MAX_VISIBLE_RELATION_CHOICES + 1,
            include: selected,
            evaluation: captureDatabaseEvaluationContext(),
          },
        )
      : [];
  } else {
    const normalized = search.toLocaleLowerCase();
    const source = Array.isArray(rows)
      ? rows
      : (rows as ResourcePropertyRowSource).scan();
    matches = (function* () {
      for (const row of source)
        if (row.title.toLocaleLowerCase().includes(normalized))
          yield { ...row, diagnostics: {} };
    })();
  }
  throwIfDatabaseQueryAborted(signal);
  return boundedRelationChoices(matches, new Set(selected), signal);
}

export function DatabaseRelationPicker({
  label,
  value,
  busy,
  lookupScope,
  loadChoices,
  onWrite,
}: {
  label: string;
  value: PropertyValue;
  busy: boolean;
  lookupScope: unknown;
  loadChoices(
    search: string,
    selected: readonly ResourceId[],
    signal: AbortSignal,
  ): Promise<RelationChoicePage>;
  onWrite(value: PropertyValue): void;
}) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<RelationChoicePage | null>(null);
  const [resolvedChoices, setResolvedChoices] = useState<
    Readonly<Record<string, DatabaseRelationChoice>>
  >({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const loadChoicesRef = useRef(loadChoices);
  loadChoicesRef.current = loadChoices;
  const searchId = useId();
  const selected = Array.isArray(value)
    ? value.map((item) => String(item) as ResourceId)
    : [];
  const selectedKey = selected.join('\0');
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const show = () => setOpen(true);
  useEffect(() => {
    setPage(null);
    setResolvedChoices({});
    setSearch('');
  }, [lookupScope]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setPage(null);
    setLoading(true);
    setError('');
    void loadChoicesRef
      .current(search.trim(), selectedRef.current, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setPage(next);
        setResolvedChoices((current) => ({
          ...current,
          ...Object.fromEntries(
            [...next.selected, ...next.choices]
              .filter((choice) => selectedRef.current.includes(choice.id))
              .map((choice) => [choice.id, choice]),
          ),
        }));
      })
      .catch((failure) => {
        if (!controller.signal.aborted)
          setError(
            failure instanceof Error ? failure.message : String(failure),
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [lookupScope, open, search, selectedKey]);
  const close = () => {
    setOpen(false);
    setPage(null);
    setSearch('');
    setError('');
    setLoading(false);
  };
  const visible = [
    ...(page?.choices ?? []),
    ...selected
      .map((id) => resolvedChoices[id])
      .filter((choice) => choice !== undefined)
      .filter((choice) => !page?.choices.some((item) => item.id === choice.id)),
  ];
  const resolvedSelected = new Set([
    ...Object.keys(resolvedChoices),
    ...(page?.selected ?? []).map((choice) => choice.id),
  ]);
  const selectedUnavailable = selected.filter(
    (id) => page !== null && !resolvedSelected.has(id),
  );
  return (
    <div className={styles['document-relation-picker']}>
      <button
        type="button"
        aria-expanded={open}
        disabled={busy}
        onClick={() => (open ? close() : show())}
      >
        {selected.length === 0
          ? `Choose ${label.toLocaleLowerCase()}`
          : `${selected.length} selected`}
      </button>
      {open && (
        <div className={styles['document-relation-options']}>
          <label htmlFor={searchId}>Find related document</label>
          <input
            id={searchId}
            autoFocus
            type="search"
            value={search}
            placeholder="Type a document title"
            onChange={(event) => setSearch(event.target.value)}
          />
          {loading && <small role="status">Loading choices…</small>}
          {error && <small role="alert">Could not load choices: {error}</small>}
          {!loading && !error && page && visible.length === 0 && (
            <small role="status">No related documents found.</small>
          )}
          {!loading &&
            visible.map((choice) => (
              <label key={choice.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(choice.id)}
                  disabled={busy}
                  onChange={(event) =>
                    onWrite(
                      event.target.checked
                        ? [...selected, choice.id]
                        : selected.filter((id) => id !== choice.id),
                    )
                  }
                />
                <span>{choice.title}</span>
              </label>
            ))}
          {!loading && page?.hasMore && (
            <small role="status">
              Showing the first {MAX_VISIBLE_RELATION_CHOICES} results. Refine
              your search.
            </small>
          )}
          {!loading &&
            selectedUnavailable.map((id) => (
              <label key={id} title="This related document is unavailable">
                <input
                  type="checkbox"
                  checked
                  disabled={busy}
                  onChange={() =>
                    onWrite(selected.filter((item) => item !== id))
                  }
                />
                <span>Unavailable resource ({id})</span>
              </label>
            ))}
        </div>
      )}
    </div>
  );
}
