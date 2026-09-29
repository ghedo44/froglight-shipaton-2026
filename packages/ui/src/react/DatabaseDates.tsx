import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  databaseDateInterval,
  moveDatabaseDate,
  type DatabaseProperty,
  type EvaluatedDatabaseRow,
  type PropertyValue,
  type ResourceId,
} from '@froglight/foundation';
import styles from './DatabaseView.module.css';

const SECTION_LIMIT = 50;

type ScheduleDraft = {
  readonly value: PropertyValue;
  readonly expected: PropertyValue;
  readonly pending: boolean;
  readonly failure?: string;
};

function scheduleInterval(value: PropertyValue) {
  const interval = databaseDateInterval(value);
  return interval && interval.start.length === interval.end.length
    ? interval
    : null;
}

function timingLabel(value: PropertyValue): string {
  const interval = scheduleInterval(value);
  if (!interval || interval.start.length === 10) return 'All-day date';
  const start = interval.start.slice(11, 16);
  const end = interval.end.slice(11, 16);
  return start === end
    ? `UTC time preserved: ${start}`
    : `UTC times preserved: ${start}–${end}`;
}

function sameValue(left: PropertyValue, right: PropertyValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function DatabaseDates({
  rows,
  property,
  timeline,
  disabled,
  card,
  move,
}: {
  rows: readonly EvaluatedDatabaseRow[];
  property: DatabaseProperty | undefined;
  timeline: boolean;
  disabled: boolean;
  card(row: EvaluatedDatabaseRow): ReactNode;
  move(
    id: ResourceId,
    value: PropertyValue,
    expected: PropertyValue,
  ): void | Promise<void>;
}) {
  const [month, setMonth] = useState(() => {
    const first =
      property &&
      rows
        .map((row) => scheduleInterval(row.values[property.id] ?? null))
        .find(Boolean);
    return first
      ? first.start.slice(0, 7)
      : new Date().toISOString().slice(0, 7);
  });
  const [error, setError] = useState('');
  const [drafts, setDrafts] = useState<Readonly<Record<string, ScheduleDraft>>>(
    {},
  );
  const [limits, setLimits] = useState<Readonly<Record<string, number>>>({});
  const versions = useRef<Record<string, number>>({});
  useEffect(() => {
    if (!property) return;
    setDrafts((current) => {
      let changed = false;
      const next = { ...current };
      for (const row of rows) {
        const draft = current[row.resourceId];
        if (
          draft &&
          !draft.failure &&
          sameValue(draft.value, row.values[property.id] ?? null)
        ) {
          delete next[row.resourceId];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [property, rows]);
  if (!property)
    return (
      <p>Choose a date property in View settings to schedule resources.</p>
    );
  const writable = !disabled && !property.readOnly && property.type === 'date';
  const first = new Date(`${month}-01T00:00:00Z`);
  const dayCount = new Date(
    Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
  ).getUTCDate();
  const shift = (delta: number) =>
    setMonth(
      new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + delta, 1))
        .toISOString()
        .slice(0, 7),
    );
  const days = Array.from(
    { length: dayCount },
    (_, index) => `${month}-${String(index + 1).padStart(2, '0')}`,
  );
  const monthStart = days[0] ?? `${month}-01`;
  const monthEnd = days.at(-1) ?? monthStart;
  const valueFor = (row: EvaluatedDatabaseRow): PropertyValue =>
    drafts[row.resourceId]?.value ?? row.values[property.id] ?? null;
  const intervals = new Map(
    rows.map((row) => [row.resourceId, scheduleInterval(valueFor(row))]),
  );
  const commit = async (row: EvaluatedDatabaseRow, value: PropertyValue) => {
    if (!writable) {
      setError('This date property is read-only.');
      return;
    }
    const existing = drafts[row.resourceId];
    const expected =
      existing?.expected ?? row.values[property.id] ?? (null as PropertyValue);
    const version = (versions.current[row.resourceId] ?? 0) + 1;
    versions.current[row.resourceId] = version;
    setDrafts((current) => ({
      ...current,
      [row.resourceId]: { value, expected, pending: true },
    }));
    setError('');
    try {
      await move(row.resourceId, value, expected);
      if (versions.current[row.resourceId] !== version) return;
      setDrafts((current) => ({
        ...current,
        [row.resourceId]: { value, expected: value, pending: false },
      }));
    } catch (failure) {
      if (versions.current[row.resourceId] !== version) return;
      setDrafts((current) => ({
        ...current,
        [row.resourceId]: {
          value,
          expected,
          pending: false,
          failure: failure instanceof Error ? failure.message : String(failure),
        },
      }));
    }
  };
  const discard = (id: ResourceId) => {
    versions.current[id] = (versions.current[id] ?? 0) + 1;
    setDrafts((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  };
  const reschedule = (id: ResourceId, day: string) => {
    const row = rows.find((item) => item.resourceId === id);
    if (!row) return;
    try {
      void commit(row, moveDatabaseDate(valueFor(row), day));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  const controls = (row: EvaluatedDatabaseRow) => {
    const value = valueFor(row);
    const interval = intervals.get(row.resourceId);
    const draft = drafts[row.resourceId];
    if (value !== null && !interval)
      return (
        <div className={styles.scheduleError} role="status">
          <strong>Invalid date retained</strong>
          <span>{JSON.stringify(value)}</span>
          <small>
            Repair this value in the table or Properties inspector before
            scheduling it.
          </small>
        </div>
      );
    return (
      <div className={styles.scheduleControls}>
        {interval && <small>{timingLabel(value)}</small>}
        <label>
          {interval?.start.length === 10 ? 'Start' : 'Start day (UTC)'}{' '}
          <input
            type="date"
            aria-label={`Schedule ${row.title}`}
            disabled={!writable || draft?.pending}
            value={interval?.start.slice(0, 10) ?? ''}
            onChange={(event) => {
              if (event.target.value)
                reschedule(row.resourceId, event.target.value);
            }}
          />
        </label>
        {interval && (
          <label>
            {interval.end.length === 10 ? 'End' : 'End day (UTC)'}{' '}
            <input
              type="date"
              aria-label={`End date for ${row.title}`}
              disabled={!writable || draft?.pending}
              min={interval.start.slice(0, 10)}
              value={interval.end.slice(0, 10)}
              onChange={(event) => {
                const end = event.target.value;
                if (!end) return;
                const next = {
                  ...(typeof value === 'object' &&
                  value !== null &&
                  !Array.isArray(value)
                    ? value
                    : {}),
                  start: interval.start,
                  end:
                    interval.end.length > 10
                      ? `${end}${interval.end.slice(10)}`
                      : end,
                };
                if (scheduleInterval(next)) void commit(row, next);
                else
                  setError('The end date must be on or after the start date.');
              }}
            />
          </label>
        )}
        {interval && (
          <button
            type="button"
            disabled={!writable || draft?.pending}
            onClick={() => void commit(row, null)}
          >
            Remove date
          </button>
        )}
        {draft?.pending && <small role="status">Saving schedule…</small>}
        {draft?.failure && (
          <div className={styles.scheduleError} role="alert">
            <span>Could not save: {draft.failure}</span>
            <button
              type="button"
              disabled={!writable}
              onClick={() => void commit(row, draft.value)}
            >
              Retry
            </button>
            <button type="button" onClick={() => discard(row.resourceId)}>
              Discard change
            </button>
          </div>
        )}
      </div>
    );
  };
  const scheduled = rows.filter((row) => intervals.get(row.resourceId));
  const inMonth = scheduled.filter((row) => {
    const interval = intervals.get(row.resourceId);
    if (!interval) return false;
    return (
      interval.start.slice(0, 10) <= monthEnd &&
      interval.end.slice(0, 10) >= monthStart
    );
  });
  const earlier = scheduled.filter((row) => {
    const interval = intervals.get(row.resourceId);
    return interval ? interval.end.slice(0, 10) < monthStart : false;
  });
  const later = scheduled.filter((row) => {
    const interval = intervals.get(row.resourceId);
    return interval ? interval.start.slice(0, 10) > monthEnd : false;
  });
  const unscheduled = rows.filter((row) => valueFor(row) === null);
  const invalid = rows.filter(
    (row) => valueFor(row) !== null && !intervals.get(row.resourceId),
  );
  const limitFor = (key: string) => limits[key] ?? SECTION_LIMIT;
  const reveal = (key: string) =>
    setLimits((current) => ({
      ...current,
      [key]: limitFor(key) + SECTION_LIMIT,
    }));
  const dragHandle = (row: EvaluatedDatabaseRow) =>
    writable && (
      <span
        className={styles.scheduleDragHandle}
        draggable
        aria-hidden="true"
        title={`Drag ${row.title} to another day`}
        onDragStart={(event) => {
          event.stopPropagation();
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData(
            'application/x-froglight-resource',
            row.resourceId,
          );
        }}
      >
        Drag
      </span>
    );
  const rowPanel = (row: EvaluatedDatabaseRow, draggable = false) => (
    <div key={row.resourceId} className={styles.scheduleItem}>
      {draggable && dragHandle(row)}
      {card(row)}
      {controls(row)}
    </div>
  );
  const collection = (
    key: string,
    title: string,
    items: readonly EvaluatedDatabaseRow[],
    description: string,
  ) => {
    if (items.length === 0) return null;
    const limit = limitFor(key);
    return (
      <section className={styles.dateBucket} aria-label={title}>
        <h2>
          {title} ({items.length})
        </h2>
        <p>{description}</p>
        {items.slice(0, limit).map((row) => rowPanel(row, key === 'undated'))}
        {items.length > limit && (
          <button type="button" onClick={() => reveal(key)}>
            Show {Math.min(SECTION_LIMIT, items.length - limit)} more
          </button>
        )}
      </section>
    );
  };
  const visibleInMonth = inMonth.slice(0, limitFor('month'));
  return (
    <div>
      <div className={styles.toolbar}>
        <button
          type="button"
          onClick={() => shift(-1)}
          aria-label="Previous month"
        >
          Previous
        </button>
        <label>
          Month{' '}
          <input
            type="month"
            aria-label="Displayed month"
            value={month}
            onChange={(event) => {
              if (/^\d{4}-(0[1-9]|1[0-2])$/.test(event.target.value))
                setMonth(event.target.value);
            }}
          />
        </label>
        <button type="button" onClick={() => shift(1)} aria-label="Next month">
          Next
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {!writable && (
        <p role="status">
          This date property is read-only. Rescheduling is unavailable.
        </p>
      )}
      {timeline ? (
        <div className={styles.scroll}>
          <div
            className={styles.timeline}
            style={{
              gridTemplateColumns: `minmax(240px, 320px) repeat(${dayCount}, 40px)`,
            }}
          >
            <strong>Resource</strong>
            {days.map((day) => (
              <time key={day} dateTime={day}>
                {Number(day.slice(-2))}
              </time>
            ))}
            {visibleInMonth.map((row, index) => {
              const interval = intervals.get(row.resourceId);
              if (!interval) return null;
              const start = Math.max(
                0,
                Math.floor(
                  (Date.parse(interval.start.slice(0, 10)) - first.getTime()) /
                    86400000,
                ),
              );
              const end = Math.min(
                dayCount - 1,
                Math.floor(
                  (Date.parse(interval.end.slice(0, 10)) - first.getTime()) /
                    86400000,
                ),
              );
              return (
                <div key={row.resourceId} className={styles.timelineRow}>
                  <div style={{ gridColumn: 1, gridRow: index + 2 }}>
                    {rowPanel(row)}
                  </div>
                  <div
                    className={styles.interval}
                    style={{
                      gridColumn: `${start + 2} / ${end + 3}`,
                      gridRow: index + 2,
                    }}
                    aria-label={`${row.title}: ${interval.start} to ${interval.end}`}
                  >
                    <span>{row.title}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className={styles.calendar}>
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
            <strong key={day}>{day}</strong>
          ))}
          {Array.from({ length: first.getUTCDay() }, (_, index) => (
            <div key={`empty-${index}`} aria-hidden="true" />
          ))}
          {days.map((date) => (
            <section
              key={date}
              className={styles.day}
              aria-label={date}
              onDragOver={(event) => {
                if (writable) event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                const id = event.dataTransfer.getData(
                  'application/x-froglight-resource',
                );
                if (id) reschedule(id as ResourceId, date);
              }}
            >
              <h2>
                <time dateTime={date}>{Number(date.slice(-2))}</time>
              </h2>
              {visibleInMonth
                .filter((row) => {
                  const interval = intervals.get(row.resourceId);
                  if (!interval) return false;
                  const start = interval.start.slice(0, 10);
                  return (start < monthStart ? monthStart : start) === date;
                })
                .map((row) => {
                  const interval = intervals.get(row.resourceId);
                  if (!interval) return null;
                  return (
                    <div key={row.resourceId}>
                      {interval.start.slice(0, 10) < monthStart && (
                        <small>
                          Continues from {interval.start.slice(0, 10)}
                        </small>
                      )}
                      {rowPanel(row, true)}
                    </div>
                  );
                })}
            </section>
          ))}
        </div>
      )}
      {inMonth.length > visibleInMonth.length && (
        <div className={styles.moreRows}>
          <span>
            Showing {visibleInMonth.length} of {inMonth.length} items in this
            month
          </span>
          <button type="button" onClick={() => reveal('month')}>
            Show{' '}
            {Math.min(SECTION_LIMIT, inMonth.length - visibleInMonth.length)}{' '}
            more
          </button>
        </div>
      )}
      {collection(
        'earlier',
        'Before this month',
        earlier,
        'These items remain scheduled and can be moved with their date controls.',
      )}
      {collection(
        'later',
        'After this month',
        later,
        'These items remain scheduled and can be moved with their date controls.',
      )}
      {collection(
        'undated',
        'Unscheduled',
        unscheduled,
        'Choose a start day or drag the handle into the calendar.',
      )}
      {collection(
        'invalid',
        'Invalid dates',
        invalid,
        'These stored values are preserved until you repair them.',
      )}
    </div>
  );
}
