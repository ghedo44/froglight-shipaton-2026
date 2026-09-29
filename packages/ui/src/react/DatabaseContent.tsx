import type {
  DatabaseProperty,
  DatabaseModel,
  DatabaseView,
  EvaluatedDatabaseRow,
  PropertyValue,
  ResourceId,
  DatabaseRelationChoice,
  CompositionRegistry,
  ResourceTarget,
  PropertyCatalog,
  PropertyTypeDescriptor,
  DatabaseBulkPropertyEditResult,
  DatabaseBulkPropertyFailure,
  DatabaseBulkPropertyTarget,
  DatabaseBulkPropertyUndoResult,
  DocumentTitleUpdateResult,
} from '@froglight/foundation';
import { databaseDateInterval, moveDatabaseDate } from '@froglight/foundation';
import { useEffect, useRef, useState } from 'react';
import { DatabaseDates } from './DatabaseDates.js';
import { DatabaseCardPreview } from './DatabaseCardPreview.js';
import { IconButton } from './Button.jsx';
import {
  DatabaseRelationPicker,
  type RelationChoicePage,
} from './DatabaseRelationPicker.js';
import styles from './DatabaseView.module.css';

const writablePropertyTypes = new Set([
  'text',
  'number',
  'boolean',
  'date',
  'select',
  'multi-select',
  'url',
  'email',
  'phone',
  'relation',
]);

type EditorKind = PropertyTypeDescriptor['editor'];

function propertyEditorKind(
  property: DatabaseProperty,
  editor?: EditorKind,
): EditorKind {
  if (editor) return editor;
  if (
    property.type === 'url' ||
    property.type === 'email' ||
    property.type === 'phone'
  )
    return 'text';
  if (writablePropertyTypes.has(property.type))
    return property.type as EditorKind;
  return 'none';
}

export function Cell({
  property,
  value,
  readOnly,
  onWrite,
  choices,
  editor,
  autoFocus,
  busy = false,
  relationLookupScope,
  loadRelationChoices,
}: {
  choices?: readonly DatabaseRelationChoice[];
  editor?: EditorKind;
  property: DatabaseProperty;
  value: PropertyValue;
  readOnly: boolean;
  onWrite(
    value: PropertyValue,
    expectedValue?: PropertyValue,
  ): void | Promise<void>;
  autoFocus?: boolean;
  busy?: boolean;
  relationLookupScope?: unknown;
  loadRelationChoices?(
    search: string,
    selected: readonly ResourceId[],
    signal: AbortSignal,
  ): Promise<RelationChoicePage>;
}) {
  const editorKind = propertyEditorKind(property, editor);
  const supportedEditor = editorKind !== 'none';
  const disabled =
    readOnly ||
    property.readOnly ||
    ['formula', 'rollup', 'created', 'updated'].includes(property.type) ||
    !supportedEditor;
  const label = property.name;
  if (disabled) {
    return (
      <span
        title={
          supportedEditor
            ? 'This property is read-only'
            : `Property editor unavailable for ${property.type}`
        }
      >
        {displayValue(property, value, choices, editorKind)}
      </span>
    );
  }
  if (editorKind === 'boolean')
    return (
      <input
        autoFocus={autoFocus}
        disabled={busy}
        aria-label={label}
        type="checkbox"
        checked={value === true}
        onChange={(event) => onWrite(event.target.checked)}
      />
    );
  if (editorKind === 'select')
    return (
      <select
        autoFocus={autoFocus}
        disabled={busy}
        aria-label={label}
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => onWrite(event.target.value || null)}
      >
        <option value="">No value</option>
        {property.options?.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </select>
    );
  if (editorKind === 'multi-select')
    return (
      <select
        autoFocus={autoFocus}
        disabled={busy}
        multiple
        aria-label={label}
        value={Array.isArray(value) ? value.map(String) : []}
        onChange={(event) =>
          onWrite(
            Array.from(event.target.selectedOptions, (option) => option.value),
          )
        }
      >
        {property.options?.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </select>
    );
  if (editorKind === 'relation') {
    if (loadRelationChoices)
      return (
        <DatabaseRelationPicker
          label={label}
          value={value}
          busy={busy}
          lookupScope={relationLookupScope}
          loadChoices={loadRelationChoices}
          onWrite={onWrite}
        />
      );
    const selected = Array.isArray(value) ? value.map(String) : [];
    const options = choices ?? [];
    return (
      <select
        autoFocus={autoFocus}
        disabled={busy}
        multiple
        aria-label={label}
        value={selected}
        onChange={(event) =>
          onWrite(
            Array.from(event.target.selectedOptions, (option) => option.value),
          )
        }
      >
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.title}
          </option>
        ))}
        {selected
          .filter((id) => !options.some((option) => option.id === id))
          .map((id) => (
            <option key={id} value={id}>
              Unavailable resource ({id})
            </option>
          ))}
      </select>
    );
  }
  if (editorKind === 'date') {
    const interval = databaseDateInterval(value);
    return (
      <div className={styles.scheduleControls}>
        <input
          autoFocus={autoFocus}
          disabled={busy}
          type="date"
          aria-label={label}
          value={interval?.start.slice(0, 10) ?? ''}
          onChange={(event) => {
            const day = event.target.value;
            if (!day) onWrite(null);
            else onWrite(moveDatabaseDate(interval ? value : null, day));
          }}
        />
        {interval && (
          <input
            disabled={busy}
            type="date"
            aria-label={`${label} end`}
            min={interval.start.slice(0, 10)}
            value={interval.end.slice(0, 10)}
            onChange={(event) => {
              if (!event.target.value) return;
              onWrite({
                ...(typeof value === 'object' &&
                value !== null &&
                !Array.isArray(value)
                  ? value
                  : {}),
                start: interval.start,
                end:
                  interval.end.length > 10
                    ? `${event.target.value}${interval.end.slice(10)}`
                    : event.target.value,
              });
            }}
          />
        )}
      </div>
    );
  }
  return (
    <input
      autoFocus={autoFocus}
      disabled={busy}
      aria-label={label}
      key={JSON.stringify(value)}
      type={
        editorKind === 'number'
          ? 'number'
          : property.type === 'url'
            ? 'url'
            : property.type === 'email'
              ? 'email'
              : property.type === 'phone'
                ? 'tel'
                : 'text'
      }
      defaultValue={
        Array.isArray(value) ? value.join(', ') : String(value ?? '')
      }
      onBlur={(event) => {
        const raw = event.target.value;
        const next =
          raw === '' ? null : editorKind === 'number' ? Number(raw) : raw;
        if (JSON.stringify(value) !== JSON.stringify(next)) onWrite(next);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') {
          event.currentTarget.value = Array.isArray(value)
            ? value.join(', ')
            : String(value ?? '');
          event.currentTarget.blur();
        }
      }}
    />
  );
}

function BulkValueEditor({
  property,
  value,
  choices,
  editor,
  disabled,
  onChange,
  loadRelationChoices,
}: {
  property: DatabaseProperty;
  value: PropertyValue;
  choices?: readonly DatabaseRelationChoice[];
  editor?: EditorKind;
  disabled: boolean;
  onChange(value: PropertyValue): void;
  loadRelationChoices?: Parameters<typeof Cell>[0]['loadRelationChoices'];
}) {
  if (propertyEditorKind(property, editor) === 'boolean')
    return (
      <select
        aria-label={property.name}
        value={value === true ? 'true' : value === false ? 'false' : ''}
        disabled={disabled}
        onChange={(event) =>
          onChange(
            event.target.value === '' ? null : event.target.value === 'true',
          )
        }
      >
        <option value="">No value</option>
        <option value="true">Checked</option>
        <option value="false">Unchecked</option>
      </select>
    );
  return (
    <Cell
      property={property}
      value={value}
      choices={choices}
      editor={editor}
      readOnly={false}
      busy={disabled}
      onWrite={onChange}
      relationLookupScope={property.id}
      loadRelationChoices={loadRelationChoices}
    />
  );
}

function FailureList({
  failures,
  names,
}: {
  failures: readonly DatabaseBulkPropertyFailure[];
  names: ReadonlyMap<ResourceId, string>;
}) {
  return (
    <ul className={styles.bulkFailures} role="alert">
      {failures.map((failure) => (
        <li key={failure.resourceId}>
          <strong>{names.get(failure.resourceId) ?? failure.resourceId}</strong>
          <span>{describeFailure(failure.error)}</span>
        </li>
      ))}
    </ul>
  );
}

function describeFailure(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

function displayValue(
  property: DatabaseProperty,
  value: PropertyValue,
  choices?: readonly DatabaseRelationChoice[],
  editor?: EditorKind,
): string {
  const kind = propertyEditorKind(property, editor);
  if (value === null || value === undefined || value === '') return '—';
  const item = (entry: PropertyValue): string => {
    if (typeof entry === 'string' && kind === 'relation')
      return choices?.find((choice) => choice.id === entry)?.title ?? entry;
    if (typeof entry === 'string' && ['select', 'multi-select'].includes(kind))
      return (
        property.options?.find((option) => option.id === entry)?.name ?? entry
      );
    const interval = kind === 'date' ? databaseDateInterval(entry) : null;
    if (interval)
      return interval.start === interval.end
        ? interval.start
        : `${interval.start} – ${interval.end}`;
    if (typeof entry === 'boolean') return entry ? 'Yes' : 'No';
    if (typeof entry === 'object' && entry !== null)
      return JSON.stringify(entry);
    return String(entry ?? '—');
  };
  return Array.isArray(value) ? value.map(item).join(', ') || '—' : item(value);
}

const MAX_CLIPBOARD_CELLS = 1_000;

interface ClipboardCellPlan {
  readonly rowId: ResourceId;
  readonly rowTitle: string;
  readonly property: DatabaseProperty;
  readonly value: PropertyValue;
  readonly expected: PropertyValue;
  readonly present: boolean;
  readonly changed: boolean;
  readonly error?: string;
}

interface ClipboardPastePlan {
  readonly rows: number;
  readonly columns: number;
  readonly cells: readonly ClipboardCellPlan[];
}

interface ClipboardCommit {
  readonly cell: ClipboardCellPlan;
  readonly operation: DatabaseBulkPropertyEditResult;
}

interface ClipboardFailure {
  readonly cell: ClipboardCellPlan;
  readonly error: unknown;
}

interface ClipboardPasteReport {
  readonly committed: readonly ClipboardCommit[];
  readonly failed: readonly ClipboardFailure[];
}

function samePropertyValue(left: PropertyValue, right: PropertyValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseTsv(text: string): readonly (readonly string[])[] {
  const rows: string[][] = [[]];
  const currentRow = () => {
    const row = rows.at(-1);
    if (!row) throw new Error('Could not parse the clipboard rows.');
    return row;
  };
  let value = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text.charAt(index);
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          value += '"';
          index += 1;
        } else quoted = false;
      } else value += character;
      continue;
    }
    if (character === '"' && value === '') quoted = true;
    else if (character === '\t') {
      currentRow().push(value);
      value = '';
    } else if (character === '\n') {
      currentRow().push(value.endsWith('\r') ? value.slice(0, -1) : value);
      rows.push([]);
      value = '';
    } else value += character;
  }
  if (quoted) throw new Error('The clipboard contains an unclosed quote.');
  currentRow().push(value.endsWith('\r') ? value.slice(0, -1) : value);
  const finalRow = currentRow();
  if (
    rows.length > 1 &&
    finalRow.length === 1 &&
    finalRow[0] === '' &&
    /\r?\n$/.test(text)
  )
    rows.pop();
  return rows;
}

function tsvCell(value: string): string {
  return /[\t\r\n"]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function clipboardValue(
  property: DatabaseProperty,
  value: PropertyValue,
  choices: readonly DatabaseRelationChoice[] | undefined,
  editor: EditorKind | undefined,
): string {
  if (value === null || value === undefined) return '';
  const kind = propertyEditorKind(property, editor);
  if (kind === 'select' && typeof value === 'string')
    return (
      property.options?.find((option) => option.id === value)?.name ?? value
    );
  if (kind === 'multi-select' && Array.isArray(value))
    return JSON.stringify(
      value.map((item) =>
        typeof item === 'string'
          ? (property.options?.find((option) => option.id === item)?.name ??
            item)
          : item,
      ),
    );
  if (kind === 'relation' && Array.isArray(value))
    return JSON.stringify(
      value.map((item) =>
        typeof item === 'string'
          ? (choices?.find((choice) => choice.id === item)?.title ?? item)
          : item,
      ),
    );
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function resolveChoice(
  raw: string,
  choices: readonly { readonly id: string; readonly name: string }[],
): string {
  const byId = choices.find((choice) => choice.id === raw);
  if (byId) return byId.id;
  const byName = choices.filter((choice) => choice.name === raw);
  if (byName.length === 1 && byName[0]) return byName[0].id;
  if (byName.length > 1) throw new Error(`Ambiguous choice: ${raw}`);
  throw new Error(`Unknown choice: ${raw}`);
}

function parseClipboardValue(
  property: DatabaseProperty,
  raw: string,
  choices: readonly DatabaseRelationChoice[] | undefined,
  editor: EditorKind | undefined,
  catalog: PropertyCatalog | undefined,
): PropertyValue {
  if (raw === '') return null;
  const kind = propertyEditorKind(property, editor);
  let value: PropertyValue;
  if (kind === 'number') {
    value = Number(raw);
    if (!Number.isFinite(value)) throw new Error('Expected a finite number');
  } else if (kind === 'boolean') {
    if (raw.toUpperCase() === 'TRUE') value = true;
    else if (raw.toUpperCase() === 'FALSE') value = false;
    else throw new Error('Expected TRUE or FALSE');
  } else if (kind === 'select') {
    value = resolveChoice(raw, property.options ?? []);
  } else if (kind === 'multi-select' || kind === 'relation') {
    let entries: unknown;
    try {
      entries = JSON.parse(raw);
    } catch {
      throw new Error('Expected a JSON array of choices');
    }
    if (
      !Array.isArray(entries) ||
      !entries.every((entry) => typeof entry === 'string')
    )
      throw new Error('Expected a JSON array of choices');
    const available =
      kind === 'relation'
        ? (choices ?? []).map((choice) => ({
            id: choice.id,
            name: choice.title,
          }))
        : (property.options ?? []);
    value = entries.map((entry) => resolveChoice(entry as string, available));
  } else if (kind === 'date') {
    if (raw.startsWith('{')) {
      try {
        value = JSON.parse(raw) as PropertyValue;
      } catch {
        throw new Error('Expected an ISO date or JSON date range');
      }
    } else value = raw;
  } else if (kind === 'text') value = raw;
  else throw new Error('This property is read-only');
  const diagnostic = catalog?.diagnostic(property, value);
  if (diagnostic) throw new Error(diagnostic);
  return value;
}

function EditableCell(props: Parameters<typeof Cell>[0]) {
  const editorKind = propertyEditorKind(props.property, props.editor);
  const editBase = useRef<PropertyValue>(props.value);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<PropertyValue | undefined>();
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState('');
  const version = useRef(0);
  const cancelled = useRef(false);
  const inFlight = useRef(false);
  const failed = useRef(false);
  const pending = useRef<Promise<unknown>>(Promise.resolve());
  const displayRef = useRef<HTMLButtonElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (!editing && restoreFocus.current) {
      restoreFocus.current = false;
      displayRef.current?.focus();
    }
  }, [editing]);
  const save = (value: PropertyValue) => {
    if (cancelled.current) return;
    const currentVersion = ++version.current;
    setDraft(value);
    setFailure('');
    setSaving(true);
    inFlight.current = true;
    failed.current = false;
    const operation = pending.current
      .catch(() => undefined)
      .then(() => props.onWrite(value, editBase.current));
    pending.current = operation;
    void operation
      .then(() => {
        editBase.current = value;
        if (version.current !== currentVersion) return;
        setDraft(undefined);
        setSaving(false);
        inFlight.current = false;
        if (!['multi-select', 'relation'].includes(editorKind)) {
          restoreFocus.current =
            document.activeElement === document.body ||
            !!editorRef.current?.contains(document.activeElement);
          setEditing(false);
        }
      })
      .catch((error) => {
        if (version.current !== currentVersion) return;
        setSaving(false);
        inFlight.current = false;
        failed.current = true;
        setFailure(error instanceof Error ? error.message : String(error));
      });
  };
  const disabled =
    props.readOnly ||
    props.property.readOnly ||
    ['formula', 'rollup', 'created', 'updated'].includes(props.property.type) ||
    editorKind === 'none';
  if (disabled)
    return (
      <span>
        {displayValue(props.property, props.value, props.choices, editorKind)}
      </span>
    );
  if (editorKind === 'boolean') return <Cell {...props} />;
  return editing ? (
    <div
      ref={editorRef}
      onBlur={(event) => {
        if (
          !event.currentTarget.contains(event.relatedTarget) &&
          !inFlight.current &&
          !failed.current
        )
          setEditing(false);
      }}
      onKeyDownCapture={(event) => {
        if (event.key === 'Enter' && event.target instanceof HTMLInputElement)
          restoreFocus.current = true;
        if (event.key !== 'Escape') return;
        if (inFlight.current) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        cancelled.current = true;
        restoreFocus.current = true;
        failed.current = false;
        version.current += 1;
        setDraft(undefined);
        setFailure('');
        setEditing(false);
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <Cell
        {...props}
        value={draft === undefined ? props.value : draft}
        onWrite={save}
        autoFocus
      />
      {saving && <small role="status">Saving…</small>}
      {failure && (
        <small role="alert">
          Could not save: {failure}{' '}
          <button
            type="button"
            onClick={() => {
              if (draft !== undefined) save(draft);
            }}
          >
            Retry
          </button>
        </small>
      )}
    </div>
  ) : (
    <button
      ref={displayRef}
      type="button"
      className={styles.cellDisplay}
      aria-label={`Edit ${props.property.name}: ${displayValue(props.property, props.value, props.choices, editorKind)}`}
      onClick={() => {
        cancelled.current = false;
        editBase.current = props.value;
        setDraft(props.value);
        setEditing(true);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'F2') return;
        event.preventDefault();
        cancelled.current = false;
        editBase.current = props.value;
        setDraft(props.value);
        setEditing(true);
      }}
    >
      {displayValue(props.property, props.value, props.choices, editorKind)}
    </button>
  );
}

function EditableTitle({
  row,
  openResource,
  onEditTitle,
  titleEditUnavailable,
  onRename,
}: {
  row: EvaluatedDatabaseRow;
  openResource(id: ResourceId): void;
  onEditTitle?: (
    id: ResourceId,
    title: string,
  ) => Promise<DocumentTitleUpdateResult>;
  titleEditUnavailable?: string;
  onRename?: (
    id: ResourceId,
    title: string,
    expectedPath: string,
  ) => Promise<void>;
}) {
  const [editing, setEditing] = useState<'title' | 'file' | null>(null);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const basePath = useRef(row.path);
  const retainedTitle = useRef<DocumentTitleUpdateResult | null>(null);
  const discardTail = useRef<Promise<void>>(Promise.resolve());
  const discardRetainedTitle = () => {
    const retained = retainedTitle.current;
    retainedTitle.current = null;
    if (!retained) return discardTail.current;
    const discarding = discardTail.current
      .catch(() => undefined)
      .then(() => retained.discard());
    discardTail.current = discarding.catch(() => undefined);
    return discarding;
  };
  useEffect(
    () => () => {
      void discardRetainedTitle();
    },
    [],
  );
  const beginFile = () => {
    basePath.current = row.path;
    const filename = row.path.split('/').at(-1) ?? row.path;
    const extension = filename.lastIndexOf('.');
    setDraft(extension > 0 ? filename.slice(0, extension) : filename);
    setError('');
    void discardRetainedTitle();
    setEditing('file');
  };
  const beginTitle = () => {
    setDraft(row.title);
    setError('');
    void discardRetainedTitle();
    setEditing('title');
  };
  const save = async () => {
    if (!editing || pending) return;
    setPending(true);
    setError('');
    try {
      if (editing === 'file') {
        if (!onRename) return;
        await onRename(row.resourceId, draft, basePath.current);
      } else {
        if (!onEditTitle) return;
        let result: DocumentTitleUpdateResult;
        if (retainedTitle.current) result = await retainedTitle.current.retry();
        else {
          await discardTail.current;
          result = await onEditTitle(row.resourceId, draft);
        }
        if (!result.committed) {
          retainedTitle.current = result;
          setError(
            `Could not save document title: ${result.error instanceof Error ? result.error.message : String(result.error)}`,
          );
          return;
        }
        retainedTitle.current = null;
        if (result.derivedError)
          setError(
            `Title saved, but its database metadata could not refresh: ${result.derivedError instanceof Error ? result.derivedError.message : String(result.derivedError)}`,
          );
      }
      setEditing(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setPending(false);
    }
  };
  if (editing)
    return (
      <span className={styles.titleEditor}>
        <input
          autoFocus
          aria-label={
            editing === 'title'
              ? `Document title for ${row.title}`
              : `File name for ${row.title}`
          }
          value={draft}
          disabled={pending}
          onChange={(event) => {
            void discardRetainedTitle();
            setDraft(event.target.value);
            setError('');
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void save();
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              void discardRetainedTitle();
              setEditing(null);
            }
          }}
        />
        <button type="button" disabled={pending} onClick={() => void save()}>
          {pending ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            void discardRetainedTitle();
            setEditing(null);
          }}
        >
          Cancel
        </button>
        {error && <small role="alert">{error}</small>}
      </span>
    );
  return (
    <span className={styles.titleEditor}>
      <button
        className={styles.title}
        onClick={() => openResource(row.resourceId)}
        onKeyDown={(event) => {
          if (event.key !== 'F2' || !onEditTitle || titleEditUnavailable)
            return;
          event.preventDefault();
          beginTitle();
        }}
      >
        {row.title}
      </button>
      {onEditTitle && (
        <IconButton
          icon="edit"
          className={styles.titleRename}
          label={
            titleEditUnavailable
              ? `Document title unavailable for ${row.title}`
              : `Edit document title for ${row.title}`
          }
          disabled={Boolean(titleEditUnavailable)}
          title={titleEditUnavailable}
          onClick={beginTitle}
        />
      )}
      {onRename && (
        <IconButton
          icon="file"
          className={styles.titleRename}
          label={`Rename file for ${row.title}`}
          onClick={beginFile}
        />
      )}
      {!editing && error && <small role="status">{error}</small>}
    </span>
  );
}

export function DatabaseContent({
  model,
  view,
  rows,
  readOnly,
  write,
  writeCell,
  openResource,
  openBesideResource,
  previews,
  previewTarget,
  relationChoices = {},
  loadRelationChoices,
  canonicalValues,
  catalog,
  editors,
  onAddProperty,
  onNew,
  onRemove,
  onEditTitle,
  titleEditUnavailable,
  onRename,
  onViewPatch,
  onColumnWidth,
  onBulkWrite,
  runBulkOperation,
  bulkDisabled = false,
  emptyReason,
}: {
  relationChoices?: Readonly<Record<string, readonly DatabaseRelationChoice[]>>;
  loadRelationChoices?(
    propertyId: string,
    search: string,
    selected: readonly ResourceId[],
    signal: AbortSignal,
  ): Promise<RelationChoicePage>;
  canonicalValues?: ReadonlyMap<
    ResourceId,
    Readonly<Record<string, PropertyValue>>
  >;
  catalog?: PropertyCatalog;
  editors?: Readonly<
    Record<string, { readonly editor: EditorKind; readonly writable: boolean }>
  >;
  model: DatabaseModel;
  view: DatabaseView | undefined;
  rows: readonly EvaluatedDatabaseRow[];
  readOnly: boolean;
  write(id: ResourceId, propertyId: string, value: PropertyValue): void;
  writeCell?(
    id: ResourceId,
    propertyId: string,
    value: PropertyValue,
    expectedValue?: PropertyValue,
  ): Promise<void>;
  openResource(id: ResourceId): void;
  openBesideResource?: (id: ResourceId) => void;
  previews?: CompositionRegistry;
  previewTarget?: (id: ResourceId) => ResourceTarget | null;
  onAddProperty?: () => void;
  onNew?: () => void;
  onRemove?: (id: ResourceId) => void;
  onEditTitle?: (
    id: ResourceId,
    title: string,
  ) => Promise<DocumentTitleUpdateResult>;
  titleEditUnavailable?: (id: ResourceId) => string | undefined;
  onRename?: (
    id: ResourceId,
    title: string,
    expectedPath: string,
  ) => Promise<void>;
  onViewPatch?: (patch: Pick<DatabaseView, 'visibleProperties'>) => void;
  onColumnWidth?: (id: string, width: number) => void;
  onBulkWrite?: (
    propertyId: string,
    value: PropertyValue,
    targets: readonly DatabaseBulkPropertyTarget[],
  ) => Promise<DatabaseBulkPropertyEditResult>;
  runBulkOperation?: <Result>(
    operation: () => Promise<Result>,
  ) => Promise<Result>;
  bulkDisabled?: boolean;
  emptyReason?: string;
}) {
  const [previewWidths, setPreviewWidths] = useState<Record<string, number>>(
    {},
  );
  const [rowLimit, setRowLimit] = useState(100);
  const [boardRowLimits, setBoardRowLimits] = useState<
    Readonly<Record<string, number>>
  >({});
  const [boardWrites, setBoardWrites] = useState<
    Readonly<Record<string, { pending: boolean; failure: string }>>
  >({});
  const boardWriteVersions = useRef<Record<string, number>>({});
  const [selectionScope, setSelectionScope] = useState<'visible' | 'all'>(
    'visible',
  );
  const [selectedIds, setSelectedIds] = useState<readonly ResourceId[]>([]);
  const [bulkRows, setBulkRows] = useState<
    readonly Pick<EvaluatedDatabaseRow, 'resourceId' | 'title' | 'values'>[]
  >([]);
  const [bulkPropertyId, setBulkPropertyId] = useState('');
  const [bulkValue, setBulkValue] = useState<PropertyValue>(null);
  const [bulkConfirmed, setBulkConfirmed] = useState(false);
  const [bulkResult, setBulkResult] =
    useState<DatabaseBulkPropertyEditResult | null>(null);
  const [bulkUndoResult, setBulkUndoResult] =
    useState<DatabaseBulkPropertyUndoResult | null>(null);
  const [bulkPending, setBulkPending] = useState(false);
  const [bulkError, setBulkError] = useState('');
  const [clipboardPlan, setClipboardPlan] = useState<ClipboardPastePlan | null>(
    null,
  );
  const [clipboardConfirmed, setClipboardConfirmed] = useState(false);
  const [clipboardPending, setClipboardPending] = useState(false);
  const [clipboardStatus, setClipboardStatus] = useState('');
  const [clipboardError, setClipboardError] = useState('');
  const [clipboardReport, setClipboardReport] =
    useState<ClipboardPasteReport | null>(null);
  const [clipboardUndoFailures, setClipboardUndoFailures] = useState<
    readonly ClipboardFailure[] | null
  >(null);
  useEffect(() => setPreviewWidths({}), [view?.id]);
  useEffect(() => setRowLimit(100), [view?.id]);
  useEffect(() => {
    setSelectedIds([]);
    setBulkRows([]);
    setBulkResult(null);
    setBulkUndoResult(null);
    setClipboardPlan(null);
    setClipboardReport(null);
    setClipboardUndoFailures(null);
    setClipboardStatus('');
    setClipboardError('');
  }, [view?.id]);
  useEffect(() => {
    setBoardRowLimits({});
    setBoardWrites({});
    boardWriteVersions.current = {};
  }, [view?.id]);
  const visibleRows = rows.slice(0, rowLimit);
  const previewIds = new Set(
    visibleRows.slice(0, 24).map((row) => row.resourceId),
  );
  const widthFor = (id: string) =>
    previewWidths[id] ??
    view?.columnWidths?.[id] ??
    (id === '$title' ? 240 : 200);
  const resize = (id: string, width: number) => {
    const next = Math.max(120, Math.min(640, Math.round(width)));
    setPreviewWidths((current) => ({ ...current, [id]: next }));
    return next;
  };
  const persistWidth = (id: string, width: number) =>
    onColumnWidth?.(id, resize(id, width));
  const resizeHandle = (id: string, label: string) =>
    onColumnWidth && (
      <button
        type="button"
        className={styles.resizeHandle}
        aria-label={`Resize ${label} column`}
        title={`Resize ${label} column. Use arrow keys for 16-pixel steps.`}
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          const startX = event.clientX;
          const startWidth = widthFor(id);
          const handle = event.currentTarget;
          const move = (next: PointerEvent) => {
            if (next.pointerId === event.pointerId)
              resize(id, startWidth + next.clientX - startX);
          };
          const finish = (next: PointerEvent) => {
            if (next.pointerId !== event.pointerId) return;
            handle.removeEventListener('pointermove', move);
            handle.removeEventListener('pointerup', finish);
            handle.removeEventListener('pointercancel', cancel);
            persistWidth(id, startWidth + next.clientX - startX);
          };
          const cancel = (next: PointerEvent) => {
            if (next.pointerId !== event.pointerId) return;
            handle.removeEventListener('pointermove', move);
            handle.removeEventListener('pointerup', finish);
            handle.removeEventListener('pointercancel', cancel);
            setPreviewWidths((current) => {
              const copy = { ...current };
              delete copy[id];
              return copy;
            });
          };
          handle.addEventListener('pointermove', move);
          handle.addEventListener('pointerup', finish);
          handle.addEventListener('pointercancel', cancel);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          event.stopPropagation();
          persistWidth(
            id,
            widthFor(id) + (event.key === 'ArrowRight' ? 16 : -16),
          );
        }}
      />
    );
  const fields = (
    view?.visibleProperties ?? model.properties.map((property) => property.id)
  )
    .map((id) => model.properties.find((property) => property.id === id))
    .filter((property): property is DatabaseProperty => !!property);
  const propertyCell = (
    row: EvaluatedDatabaseRow,
    property: DatabaseProperty,
  ) => (
    <div className={styles.cell} key={property.id}>
      <EditableCell
        property={property}
        editor={
          catalog?.get(property.type)?.editor ?? editors?.[property.id]?.editor
        }
        choices={relationChoices[property.id]}
        relationLookupScope={`${model.id}:${row.resourceId}:${property.id}`}
        loadRelationChoices={
          loadRelationChoices
            ? (search, selected, signal) =>
                loadRelationChoices(property.id, search, selected, signal)
            : undefined
        }
        value={row.values[property.id] ?? null}
        readOnly={
          readOnly ||
          (catalog
            ? catalog.writeReason(property) !== null
            : editors?.[property.id]?.writable === false)
        }
        onWrite={(value, expectedValue) =>
          writeCell
            ? writeCell(
                row.resourceId,
                property.id,
                value,
                expectedValue === undefined
                  ? (row.values[property.id] ?? null)
                  : expectedValue,
              )
            : write(row.resourceId, property.id, value)
        }
      />
      {row.diagnostics[property.id] && (
        <small role="status">{row.diagnostics[property.id]}</small>
      )}
    </div>
  );
  const grouping = model.properties.find(
    (property) => property.id === view?.groupBy,
  );
  const groupWritable =
    !!grouping &&
    !readOnly &&
    !grouping.readOnly &&
    ['select', 'text'].includes(grouping.type);
  const moveBoardCard = async (
    row: EvaluatedDatabaseRow,
    value: PropertyValue,
  ) => {
    if (!grouping || !groupWritable) return;
    const version = (boardWriteVersions.current[row.resourceId] ?? 0) + 1;
    boardWriteVersions.current[row.resourceId] = version;
    setBoardWrites((current) => ({
      ...current,
      [row.resourceId]: { pending: true, failure: '' },
    }));
    try {
      if (writeCell)
        await writeCell(
          row.resourceId,
          grouping.id,
          value,
          row.values[grouping.id] ?? null,
        );
      else await write(row.resourceId, grouping.id, value);
      if (boardWriteVersions.current[row.resourceId] !== version) return;
      setBoardWrites((current) => {
        const next = { ...current };
        delete next[row.resourceId];
        return next;
      });
    } catch (error) {
      if (boardWriteVersions.current[row.resourceId] !== version) return;
      setBoardWrites((current) => ({
        ...current,
        [row.resourceId]: {
          pending: false,
          failure: error instanceof Error ? error.message : String(error),
        },
      }));
    }
  };
  const card = (row: EvaluatedDatabaseRow) => (
    <article key={row.resourceId} className={styles.card}>
      {view?.type === 'board' && groupWritable && (
        <span
          className={styles.cardDragHandle}
          draggable={!boardWrites[row.resourceId]?.pending}
          aria-hidden="true"
          title={`Drag ${row.title} to another ${grouping.name} lane`}
          onDragStart={(event) => {
            event.stopPropagation();
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData(
              'application/x-froglight-resource',
              row.resourceId,
            );
          }}
        >
          <span />
          <span />
          <span />
          <span />
          <span />
          <span />
        </span>
      )}
      <button
        className={styles.title}
        onClick={() => openResource(row.resourceId)}
      >
        {row.title}
      </button>
      {view?.type === 'gallery' && (
        <DatabaseCardPreview
          kind={
            row.kindId.split('.').at(-1)?.replaceAll('-', ' ') ?? 'Document'
          }
          registry={previewIds.has(row.resourceId) ? previews : undefined}
          target={previewTarget?.(row.resourceId)}
        />
      )}
      {view?.type === 'gallery' && (
        <small className={styles.cardPath}>{row.path}</small>
      )}
      {view?.type === 'board' && grouping && (
        <div className={styles.cardField}>
          <span>Move to {grouping.name}</span>
          {grouping.type === 'select' && groupWritable ? (
            <select
              aria-label={`Move ${row.title} to ${grouping.name}`}
              disabled={boardWrites[row.resourceId]?.pending}
              value={
                typeof row.values[grouping.id] === 'string'
                  ? (row.values[grouping.id] as string)
                  : ''
              }
              onChange={(event) => {
                void moveBoardCard(row, event.target.value || null);
              }}
            >
              <option value="">Unassigned</option>
              {grouping.options?.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
          ) : (
            <Cell
              property={grouping}
              value={row.values[grouping.id] ?? null}
              readOnly={!groupWritable}
              busy={boardWrites[row.resourceId]?.pending}
              onWrite={(value) => moveBoardCard(row, value)}
            />
          )}
        </div>
      )}
      {boardWrites[row.resourceId]?.pending && (
        <small className={styles.cardWriteStatus} role="status">
          Moving…
        </small>
      )}
      {boardWrites[row.resourceId]?.failure && (
        <small className={styles.cardWriteFailure} role="alert">
          Could not move: {boardWrites[row.resourceId].failure}
        </small>
      )}
      {fields
        .filter(
          (property) =>
            !(view?.type === 'board' && property.id === grouping?.id),
        )
        .slice(0, view?.type === 'gallery' ? 3 : fields.length)
        .map((property) => (
          <div className={styles.cardField} key={property.id}>
            <span>{property.name}</span>
            {propertyCell(row, property)}
          </div>
        ))}
      {(openBesideResource || onRemove) && (
        <div className={styles.cardActions}>
          {openBesideResource && (
            <IconButton
              icon="split-right"
              label={`Open ${row.title} beside`}
              onClick={() => openBesideResource(row.resourceId)}
            />
          )}
          {onRemove && (
            <IconButton
              icon="close"
              label={`Remove ${row.title} from database`}
              onClick={() => onRemove(row.resourceId)}
            />
          )}
        </div>
      )}
    </article>
  );
  const listRow = (row: EvaluatedDatabaseRow) => (
    <article key={row.resourceId} className={styles.listRow}>
      <button
        className={styles.title}
        onClick={() => openResource(row.resourceId)}
      >
        {row.title}
      </button>
      <small title={row.path}>{row.path}</small>
      {fields.slice(0, 2).map((property) => (
        <span key={property.id} title={property.name}>
          {property.name}:{' '}
          {displayValue(
            property,
            row.values[property.id] ?? null,
            relationChoices[property.id],
            catalog?.get(property.type)?.editor ??
              editors?.[property.id]?.editor,
          )}
        </span>
      ))}
      {(openBesideResource || onRemove) && (
        <div className={styles.cardActions}>
          {openBesideResource && (
            <IconButton
              icon="split-right"
              label={`Open ${row.title} beside`}
              onClick={() => openBesideResource(row.resourceId)}
            />
          )}
          {onRemove && (
            <IconButton
              icon="close"
              label={`Remove ${row.title} from database`}
              onClick={() => onRemove(row.resourceId)}
            />
          )}
        </div>
      )}
    </article>
  );
  const knownGroups = grouping?.options ?? [];
  const groups =
    grouping?.type === 'select'
      ? [
          ...knownGroups,
          ...[
            ...new Set(
              rows.map((row) => String(row.values[grouping.id] ?? '')),
            ),
          ]
            .filter(
              (id) => id && !knownGroups.some((option) => option.id === id),
            )
            .map((id) => ({ id, name: `Unknown value (${id})` })),
        ]
      : [
          ...new Set(
            rows.map((row) => String(row.values[view?.groupBy ?? ''] ?? '')),
          ),
        ].map((id) => ({ id, name: id || 'Unassigned' }));
  const supported = [
    'table',
    'board',
    'list',
    'gallery',
    'calendar',
    'timeline',
  ].includes(view?.type ?? '');
  const writableBulkProperties = model.properties.filter((property) => {
    if (property.relation?.inverse) return false;
    if (catalog) return catalog.writeReason(property) === null;
    return (
      !property.readOnly &&
      propertyEditorKind(property, editors?.[property.id]?.editor) !== 'none' &&
      editors?.[property.id]?.writable !== false
    );
  });
  const bulkProperty = writableBulkProperties.find(
    (property) => property.id === bulkPropertyId,
  );
  const selected = new Set(selectedIds);
  const selectedRows = rows.filter((row) => selected.has(row.resourceId));
  const bulkTargets: readonly DatabaseBulkPropertyTarget[] = bulkProperty
    ? bulkRows.map((row) => ({
        resourceId: row.resourceId,
        expected: {
          present: Object.prototype.hasOwnProperty.call(
            row.values,
            bulkProperty.id,
          ),
          value: row.values[bulkProperty.id] ?? null,
        },
      }))
    : [];
  const changingTargets = bulkProperty
    ? bulkTargets.filter((target) => {
        const row = bulkRows.find(
          (item) => item.resourceId === target.resourceId,
        );
        return (
          JSON.stringify(row?.values[bulkProperty.id] ?? null) !==
          JSON.stringify(bulkValue)
        );
      })
    : [];
  const bulkNames = new Map(
    bulkRows.map((row) => [row.resourceId, row.title] as const),
  );
  const clipboardRows = visibleRows.filter((row) =>
    selected.has(row.resourceId),
  );
  const clipboardIndexes = clipboardRows.map((row) =>
    visibleRows.findIndex((visible) => visible.resourceId === row.resourceId),
  );
  const firstClipboardIndex = clipboardIndexes[0] ?? -1;
  const clipboardSelectionReason = (() => {
    if (selectedIds.length === 0)
      return 'Select contiguous visible rows first.';
    if (selectedIds.length !== clipboardRows.length)
      return 'Clipboard operations require every selected row to be visible.';
    if (
      clipboardIndexes.some(
        (index, position) => index !== firstClipboardIndex + position,
      )
    )
      return 'Clipboard operations require one contiguous block of rows.';
    if (fields.length === 0) return 'There are no visible property columns.';
    if (clipboardRows.length * fields.length > MAX_CLIPBOARD_CELLS)
      return `Clipboard operations are limited to ${MAX_CLIPBOARD_CELLS} cells.`;
    return '';
  })();
  const clipboardScope = `${clipboardRows.length} row${clipboardRows.length === 1 ? '' : 's'} × ${fields.length} visible property column${fields.length === 1 ? '' : 's'}`;
  const clipboardValidCells =
    clipboardPlan?.cells.filter((cell) => !cell.error && cell.changed) ?? [];
  const clipboardInvalidCells =
    clipboardPlan?.cells.filter((cell) => cell.error) ?? [];
  const clipboardUnchangedCells =
    clipboardPlan?.cells.filter((cell) => !cell.error && !cell.changed) ?? [];

  const copyClipboard = async () => {
    if (clipboardSelectionReason) return;
    setClipboardError('');
    setClipboardStatus('');
    try {
      if (!navigator.clipboard?.writeText)
        throw new Error('Clipboard write access is unavailable.');
      const text = clipboardRows
        .map((row) =>
          fields
            .map((property) =>
              tsvCell(
                clipboardValue(
                  property,
                  row.values[property.id] ?? null,
                  relationChoices[property.id],
                  catalog?.get(property.type)?.editor ??
                    editors?.[property.id]?.editor,
                ),
              ),
            )
            .join('\t'),
        )
        .join('\n');
      await navigator.clipboard.writeText(text);
      setClipboardStatus(`Copied ${clipboardScope}.`);
    } catch (failure) {
      setClipboardError(describeFailure(failure));
    }
  };

  const preflightClipboard = async () => {
    if (clipboardSelectionReason) return;
    setBulkRows([]);
    setBulkResult(null);
    setBulkUndoResult(null);
    setBulkError('');
    setClipboardError('');
    setClipboardStatus('');
    setClipboardReport(null);
    setClipboardUndoFailures(null);
    try {
      if (!navigator.clipboard?.readText)
        throw new Error('Clipboard read access is unavailable.');
      const matrix = parseTsv(await navigator.clipboard.readText());
      if (
        matrix.length !== clipboardRows.length ||
        matrix.some((row) => row.length !== fields.length)
      )
        throw new Error(
          `Clipboard bounds are ${matrix.length} row${matrix.length === 1 ? '' : 's'} × ${Math.max(0, ...matrix.map((row) => row.length))} column${matrix.every((row) => row.length === 1) ? '' : 's'}; the selected scope is ${clipboardScope}.`,
        );
      const cells: ClipboardCellPlan[] = [];
      for (const [rowIndex, row] of clipboardRows.entries()) {
        const canonical = canonicalValues?.get(row.resourceId) ?? row.values;
        for (const [columnIndex, property] of fields.entries()) {
          const raw = matrix[rowIndex]?.[columnIndex];
          if (raw === undefined)
            throw new Error('The clipboard shape changed during preflight.');
          const expected = canonical[property.id] ?? null;
          const present = Object.prototype.hasOwnProperty.call(
            canonical,
            property.id,
          );
          let value: PropertyValue = expected;
          let error: string | undefined;
          const writeReason = property.relation?.inverse
            ? 'Inverse relations are derived and read-only'
            : catalog
              ? catalog.writeReason(property)
              : property.readOnly ||
                  propertyEditorKind(
                    property,
                    editors?.[property.id]?.editor,
                  ) === 'none' ||
                  editors?.[property.id]?.writable === false
                ? 'This property is derived or read-only'
                : null;
          if (writeReason) error = writeReason;
          else {
            try {
              value = parseClipboardValue(
                property,
                raw,
                relationChoices[property.id],
                catalog?.get(property.type)?.editor ??
                  editors?.[property.id]?.editor,
                catalog,
              );
            } catch (failure) {
              error = describeFailure(failure);
            }
          }
          cells.push({
            rowId: row.resourceId,
            rowTitle: row.title,
            property,
            value,
            expected,
            present,
            changed: !error && !samePropertyValue(value, expected),
            ...(error ? { error } : {}),
          });
        }
      }
      setClipboardPlan({
        rows: clipboardRows.length,
        columns: fields.length,
        cells,
      });
      setClipboardConfirmed(false);
    } catch (failure) {
      setClipboardPlan(null);
      setClipboardError(describeFailure(failure));
    }
  };

  const applyClipboard = async () => {
    if (
      !onBulkWrite ||
      !clipboardPlan ||
      !clipboardConfirmed ||
      clipboardValidCells.length === 0
    )
      return;
    setClipboardPending(true);
    setClipboardError('');
    const committed: ClipboardCommit[] = [];
    const failed: ClipboardFailure[] = [];
    try {
      for (const cell of clipboardValidCells) {
        try {
          const operation = await onBulkWrite(cell.property.id, cell.value, [
            {
              resourceId: cell.rowId,
              expected: { present: cell.present, value: cell.expected },
            },
          ]);
          if (operation.committed.length > 0)
            committed.push({ cell, operation });
          else
            failed.push({
              cell,
              error:
                operation.failed[0]?.error ??
                new Error('The property was not committed.'),
            });
        } catch (failure) {
          failed.push({ cell, error: failure });
        }
      }
      setClipboardReport({ committed, failed });
      setClipboardUndoFailures(null);
      setClipboardConfirmed(false);
    } finally {
      setClipboardPending(false);
    }
  };

  const undoClipboard = async () => {
    if (!clipboardReport || clipboardPending) return;
    setClipboardPending(true);
    setClipboardError('');
    const failures: ClipboardFailure[] = [];
    try {
      for (const commit of [...clipboardReport.committed].reverse()) {
        try {
          const result = await performBulk(() => commit.operation.undo.undo());
          if (result.failed.length > 0)
            failures.push({
              cell: commit.cell,
              error: result.failed[0]?.error ?? new Error('Undo failed.'),
            });
        } catch (failure) {
          failures.push({ cell: commit.cell, error: failure });
        }
      }
      setClipboardUndoFailures(failures);
    } finally {
      setClipboardPending(false);
    }
  };

  const selectScope = () => {
    const scopedRows = selectionScope === 'visible' ? visibleRows : rows;
    setSelectedIds(scopedRows.map((row) => row.resourceId));
  };
  const openBulk = () => {
    const first = writableBulkProperties[0];
    setBulkRows(
      selectedRows.map((row) => ({
        resourceId: row.resourceId,
        title: row.title,
        values: JSON.parse(
          JSON.stringify(canonicalValues?.get(row.resourceId) ?? row.values),
        ) as Readonly<Record<string, PropertyValue>>,
      })),
    );
    setBulkPropertyId(first?.id ?? '');
    setBulkValue(null);
    setBulkConfirmed(false);
    setBulkResult(null);
    setBulkUndoResult(null);
    setBulkError('');
    setClipboardPlan(null);
    setClipboardReport(null);
    setClipboardUndoFailures(null);
  };
  const closeBulk = () => {
    if (bulkPending) return;
    setBulkRows([]);
    setBulkResult(null);
    setBulkUndoResult(null);
    setBulkError('');
  };
  async function performBulk<Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> {
    return runBulkOperation ? runBulkOperation(operation) : operation();
  }
  const applyBulk = async () => {
    if (
      !onBulkWrite ||
      !bulkProperty ||
      !bulkConfirmed ||
      changingTargets.length === 0
    )
      return;
    setBulkPending(true);
    setBulkError('');
    try {
      setBulkResult(
        await onBulkWrite(bulkProperty.id, bulkValue, changingTargets),
      );
    } catch (failure) {
      setBulkError(describeFailure(failure));
    } finally {
      setBulkPending(false);
    }
  };
  const retryBulk = async () => {
    if (!bulkResult || bulkPending) return;
    setBulkPending(true);
    setBulkError('');
    try {
      setBulkResult(await performBulk(() => bulkResult.retry()));
    } catch (failure) {
      setBulkError(describeFailure(failure));
    } finally {
      setBulkPending(false);
    }
  };
  const undoBulk = async () => {
    if (!bulkResult || bulkPending) return;
    setBulkPending(true);
    setBulkError('');
    try {
      setBulkUndoResult(await performBulk(() => bulkResult.undo.undo()));
    } catch (failure) {
      setBulkError(describeFailure(failure));
    } finally {
      setBulkPending(false);
    }
  };
  const retryBulkUndo = async () => {
    if (!bulkUndoResult || bulkPending) return;
    setBulkPending(true);
    setBulkError('');
    try {
      setBulkUndoResult(await performBulk(() => bulkUndoResult.retry()));
    } catch (failure) {
      setBulkError(describeFailure(failure));
    } finally {
      setBulkPending(false);
    }
  };
  const actionColumn = Boolean(
    !readOnly && (onAddProperty || onRemove || openBesideResource),
  );
  return (
    <>
      {rows[0]?.diagnostics.$index && (
        <p role="status">{rows[0].diagnostics.$index}</p>
      )}
      {rows
        .filter((row) => row.diagnostics.$properties)
        .map((row) => (
          <p role="status" key={row.resourceId}>
            {row.title}: properties unavailable ({row.diagnostics.$properties}).
            Repair the property record and rebuild the index.
          </p>
        ))}{' '}
      {!view ? (
        <p role="status">
          This saved view is unavailable. Choose another view or create one in
          View settings.
        </p>
      ) : !supported ? (
        <p role="status">
          The {view.type} view provider is unavailable. Its configuration is
          preserved.
        </p>
      ) : view.type === 'table' ? (
        <>
          {!readOnly && onBulkWrite && rows.length > 0 && (
            <>
              <details className={styles.bulkSelectionDisclosure}>
                <summary>
                  Bulk selection
                  {selectedRows.length > 0 && (
                    <span>{selectedRows.length} selected</span>
                  )}
                </summary>
                <div className={styles.bulkSelectionBar}>
                  <label>
                    Selection scope
                    <select
                      aria-label="Selection scope"
                      value={selectionScope}
                      disabled={bulkDisabled}
                      onChange={(event) =>
                        setSelectionScope(
                          event.target.value as 'visible' | 'all',
                        )
                      }
                    >
                      <option value="visible">
                        Visible rows ({visibleRows.length})
                      </option>
                      <option value="all">
                        All matching rows ({rows.length})
                      </option>
                    </select>
                  </label>
                  <button
                    type="button"
                    disabled={bulkDisabled || rows.length === 0}
                    onClick={selectScope}
                  >
                    Select scope
                  </button>
                  {selectedRows.length > 0 && (
                    <span role="status">
                      {selectedRows.length} selected in current results
                    </span>
                  )}
                  {selectedIds.length > 0 && (
                    <button
                      type="button"
                      disabled={bulkDisabled}
                      onClick={() => setSelectedIds([])}
                    >
                      Clear selection
                    </button>
                  )}
                  {selectedRows.length > 0 && (
                    <button
                      type="button"
                      className={styles.primary}
                      disabled={
                        bulkDisabled || writableBulkProperties.length === 0
                      }
                      onClick={openBulk}
                    >
                      Bulk edit…
                    </button>
                  )}
                </div>
              </details>
              {selectedRows.length > 0 && (
                <div
                  className={styles.clipboardBar}
                  role="group"
                  aria-label="Table clipboard"
                >
                  <span>
                    Clipboard scope: {clipboardScope}. Values only; Name is not
                    included.
                  </span>
                  {clipboardSelectionReason && (
                    <small role="status">{clipboardSelectionReason}</small>
                  )}
                  <button
                    type="button"
                    disabled={bulkDisabled || Boolean(clipboardSelectionReason)}
                    onClick={() => void copyClipboard()}
                  >
                    Copy cells
                  </button>
                  <button
                    type="button"
                    disabled={bulkDisabled || Boolean(clipboardSelectionReason)}
                    onClick={() => void preflightClipboard()}
                  >
                    Paste cells…
                  </button>
                  {clipboardStatus && (
                    <small role="status">{clipboardStatus}</small>
                  )}
                  {clipboardError && (
                    <small role="alert">{clipboardError}</small>
                  )}
                </div>
              )}
            </>
          )}
          {bulkRows.length > 0 && (
            <section
              className={styles.bulkPanel}
              role="dialog"
              aria-labelledby="bulk-edit-title"
            >
              <div className={styles.bulkPanelHeading}>
                <div>
                  <h2 id="bulk-edit-title">
                    Bulk edit {bulkRows.length} resources
                  </h2>
                  <p>
                    This selection is fixed by resource ID. Review the property,
                    value, and compare-and-apply summary before writing.
                  </p>
                </div>
                <button
                  type="button"
                  disabled={bulkPending}
                  onClick={closeBulk}
                >
                  Close
                </button>
              </div>
              {bulkResult === null ? (
                <>
                  <div className={styles.bulkFields}>
                    <label>
                      Property
                      <select
                        aria-label="Bulk property"
                        value={bulkPropertyId}
                        disabled={bulkPending}
                        onChange={(event) => {
                          setBulkPropertyId(event.target.value);
                          setBulkValue(null);
                          setBulkConfirmed(false);
                        }}
                      >
                        {writableBulkProperties.map((property) => (
                          <option key={property.id} value={property.id}>
                            {property.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    {bulkProperty && (
                      <div className={styles.bulkValue}>
                        <span>New value</span>
                        <BulkValueEditor
                          key={bulkProperty.id}
                          property={bulkProperty}
                          value={bulkValue}
                          choices={relationChoices[bulkProperty.id]}
                          editor={
                            catalog?.get(bulkProperty.type)?.editor ??
                            editors?.[bulkProperty.id]?.editor
                          }
                          disabled={bulkPending}
                          loadRelationChoices={
                            loadRelationChoices
                              ? (search, selected, signal) =>
                                  loadRelationChoices(
                                    bulkProperty.id,
                                    search,
                                    selected,
                                    signal,
                                  )
                              : undefined
                          }
                          onChange={(next) => {
                            setBulkValue(next);
                            setBulkConfirmed(false);
                          }}
                        />
                      </div>
                    )}
                  </div>
                  <div className={styles.bulkPreview} aria-live="polite">
                    <strong>Preflight summary</strong>
                    <span>
                      {changingTargets.length} will change ·{' '}
                      {bulkRows.length - changingTargets.length} already have
                      this value
                    </span>
                    <span>
                      Each resource must still match the value shown when this
                      panel opened. Newer edits will fail individually.
                    </span>
                  </div>
                  <label className={styles.bulkConfirmation}>
                    <input
                      type="checkbox"
                      checked={bulkConfirmed}
                      disabled={bulkPending || changingTargets.length === 0}
                      onChange={(event) =>
                        setBulkConfirmed(event.target.checked)
                      }
                    />
                    Apply this value to the {changingTargets.length} resources
                    listed by the preflight. Some resources may commit even if
                    another fails.
                  </label>
                  <div className={styles.bulkActions}>
                    <button
                      type="button"
                      className={styles.primary}
                      disabled={
                        bulkPending ||
                        !bulkConfirmed ||
                        changingTargets.length === 0
                      }
                      onClick={() => void applyBulk()}
                    >
                      {bulkPending ? 'Applying…' : 'Apply bulk edit'}
                    </button>
                  </div>
                </>
              ) : (
                <div className={styles.bulkReport}>
                  <strong role="status">
                    {bulkResult.committed.length} committed ·{' '}
                    {bulkResult.failed.length} failed
                  </strong>
                  {bulkResult.failed.length > 0 && bulkUndoResult === null && (
                    <FailureList
                      failures={bulkResult.failed}
                      names={bulkNames}
                    />
                  )}
                  {bulkUndoResult !== null && (
                    <>
                      <strong role="status">
                        {bulkUndoResult.reverted.length} reverted ·{' '}
                        {bulkUndoResult.failed.length} undo failures
                      </strong>
                      {bulkUndoResult.failed.length > 0 && (
                        <FailureList
                          failures={bulkUndoResult.failed}
                          names={bulkNames}
                        />
                      )}
                    </>
                  )}
                  <div className={styles.bulkActions}>
                    {bulkUndoResult === null &&
                      bulkResult.failed.length > 0 && (
                        <button
                          type="button"
                          disabled={bulkPending}
                          onClick={() => void retryBulk()}
                        >
                          {bulkPending ? 'Retrying…' : 'Retry failed resources'}
                        </button>
                      )}
                    {bulkUndoResult === null &&
                      bulkResult.committed.length > 0 && (
                        <button
                          type="button"
                          disabled={bulkPending}
                          onClick={() => void undoBulk()}
                        >
                          {bulkPending ? 'Undoing…' : 'Undo committed changes'}
                        </button>
                      )}
                    {bulkUndoResult !== null &&
                      bulkUndoResult.failed.length > 0 && (
                        <button
                          type="button"
                          disabled={bulkPending}
                          onClick={() => void retryBulkUndo()}
                        >
                          {bulkPending ? 'Retrying…' : 'Retry undo failures'}
                        </button>
                      )}
                    <button
                      type="button"
                      disabled={bulkPending}
                      onClick={closeBulk}
                    >
                      Done
                    </button>
                  </div>
                </div>
              )}
              {bulkError && (
                <p className={styles.bulkError} role="alert">
                  {bulkError}
                </p>
              )}
            </section>
          )}
          {clipboardPlan && (
            <section
              className={styles.clipboardPanel}
              role="dialog"
              aria-labelledby="clipboard-paste-title"
            >
              <div className={styles.bulkPanelHeading}>
                <div>
                  <h2 id="clipboard-paste-title">Paste preview</h2>
                  <p>
                    Fixed target: {clipboardPlan.rows} rows ×{' '}
                    {clipboardPlan.columns} visible property columns. Each cell
                    is compared with its canonical value again when written.
                  </p>
                </div>
                <button
                  type="button"
                  disabled={clipboardPending}
                  onClick={() => {
                    setClipboardPlan(null);
                    setClipboardReport(null);
                    setClipboardUndoFailures(null);
                  }}
                >
                  Close
                </button>
              </div>
              <div className={styles.bulkPreview} aria-live="polite">
                <strong>Preflight summary</strong>
                <span>
                  {clipboardValidCells.length} will change ·{' '}
                  {clipboardUnchangedCells.length} unchanged ·{' '}
                  {clipboardInvalidCells.length} rejected
                </span>
              </div>
              {clipboardInvalidCells.length > 0 && (
                <ul className={styles.clipboardFailures} role="alert">
                  {clipboardInvalidCells.map((cell) => (
                    <li key={`${cell.rowId}:${cell.property.id}`}>
                      <strong>
                        {cell.rowTitle} · {cell.property.name}
                      </strong>
                      <span>{cell.error}</span>
                    </li>
                  ))}
                </ul>
              )}
              {!clipboardReport ? (
                <>
                  <label className={styles.bulkConfirmation}>
                    <input
                      type="checkbox"
                      checked={clipboardConfirmed}
                      disabled={
                        clipboardPending || clipboardValidCells.length === 0
                      }
                      onChange={(event) =>
                        setClipboardConfirmed(event.target.checked)
                      }
                    />
                    Apply the {clipboardValidCells.length} valid changed cells.
                    Rejected and unchanged cells will not be written. Some cells
                    may commit even if another fails.
                  </label>
                  <div className={styles.bulkActions}>
                    <button
                      type="button"
                      className={styles.primary}
                      disabled={
                        clipboardPending ||
                        !clipboardConfirmed ||
                        clipboardValidCells.length === 0
                      }
                      onClick={() => void applyClipboard()}
                    >
                      {clipboardPending
                        ? 'Applying…'
                        : `Apply ${clipboardValidCells.length} cells`}
                    </button>
                  </div>
                </>
              ) : (
                <div className={styles.bulkReport}>
                  <strong role="status">
                    {clipboardReport.committed.length} committed ·{' '}
                    {clipboardReport.failed.length} write failures
                  </strong>
                  {clipboardReport.failed.length > 0 && (
                    <ul className={styles.clipboardFailures} role="alert">
                      {clipboardReport.failed.map(({ cell, error }) => (
                        <li key={`${cell.rowId}:${cell.property.id}`}>
                          <strong>
                            {cell.rowTitle} · {cell.property.name}
                          </strong>
                          <span>{describeFailure(error)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {clipboardUndoFailures !== null && (
                    <strong role="status">
                      {clipboardReport.committed.length -
                        clipboardUndoFailures.length}{' '}
                      reverted · {clipboardUndoFailures.length} undo failures
                    </strong>
                  )}
                  {clipboardUndoFailures?.length ? (
                    <ul className={styles.clipboardFailures} role="alert">
                      {clipboardUndoFailures.map(({ cell, error }) => (
                        <li key={`${cell.rowId}:${cell.property.id}`}>
                          <strong>
                            {cell.rowTitle} · {cell.property.name}
                          </strong>
                          <span>{describeFailure(error)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {clipboardUndoFailures === null &&
                    clipboardReport.committed.length > 0 && (
                      <div className={styles.bulkActions}>
                        <button
                          type="button"
                          disabled={clipboardPending}
                          onClick={() => void undoClipboard()}
                        >
                          {clipboardPending
                            ? 'Undoing…'
                            : 'Undo committed cells'}
                        </button>
                      </div>
                    )}
                </div>
              )}
            </section>
          )}
          <div className={styles.scroll}>
            <table
              style={{
                width: `${widthFor('$title') + fields.reduce((sum, property) => sum + widthFor(property.id), 0) + (readOnly ? 0 : 160 + (onBulkWrite ? 44 : 0))}px`,
              }}
              onKeyDown={(event) => {
                if (
                  !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(
                    event.key,
                  )
                )
                  return;
                const target = event.target;
                if (
                  !(target instanceof HTMLButtonElement) ||
                  !(
                    target.classList.contains(styles.cellDisplay) ||
                    target.classList.contains(styles.title)
                  )
                )
                  return;
                const cell = target.closest('td,th');
                const row = cell?.parentElement as HTMLTableRowElement | null;
                const table = row?.closest('table');
                if (!cell || !row || !table) return;
                const column = Array.from(row.cells).indexOf(
                  cell as HTMLTableCellElement,
                );
                const nextRow =
                  event.key === 'ArrowUp'
                    ? row.previousElementSibling
                    : event.key === 'ArrowDown'
                      ? row.nextElementSibling
                      : row;
                const nextColumn =
                  column +
                  (event.key === 'ArrowLeft'
                    ? -1
                    : event.key === 'ArrowRight'
                      ? 1
                      : 0);
                const nextCell = (nextRow as HTMLTableRowElement | null)?.cells[
                  nextColumn
                ];
                const next = nextCell?.querySelector<HTMLButtonElement>(
                  `button.${styles.cellDisplay}, button.${styles.title}`,
                );
                if (next) {
                  event.preventDefault();
                  next.focus();
                }
              }}
            >
              <caption className={styles.visuallyHidden}>
                Arrow keys move between resting cells. Enter or F2 edits a
                property; Escape cancels an uncommitted draft. Tab moves through
                controls.
              </caption>
              <colgroup>
                {!readOnly && onBulkWrite && <col style={{ width: 44 }} />}
                <col style={{ width: widthFor('$title') }} />
                {fields.map((property) => (
                  <col
                    key={property.id}
                    style={{ width: widthFor(property.id) }}
                  />
                ))}
                {actionColumn && <col style={{ width: 160 }} />}
              </colgroup>
              <thead>
                <tr>
                  {!readOnly && onBulkWrite && (
                    <th scope="col">
                      <span className={styles.visuallyHidden}>Select</span>
                    </th>
                  )}
                  <th scope="col">
                    <span className={styles.columnHeader}>
                      Name{resizeHandle('$title', 'Name')}
                    </span>
                  </th>
                  {fields.map((property, index) => (
                    <th key={property.id} scope="col">
                      <span className={styles.columnHeader}>
                        <span>{property.name}</span>
                        {onViewPatch && (
                          <select
                            className={styles.columnMenu}
                            aria-label={`${property.name} column options`}
                            value=""
                            onChange={(event) => {
                              const action = event.target.value;
                              if (action === 'hide') {
                                onViewPatch({
                                  visibleProperties: fields
                                    .filter((field) => field.id !== property.id)
                                    .map((field) => field.id),
                                });
                                return;
                              }
                              const other =
                                index + (action === 'left' ? -1 : 1);
                              if (other < 0 || other >= fields.length) return;
                              const order = fields.map((field) => field.id);
                              [order[index], order[other]] = [
                                order[other]!,
                                order[index]!,
                              ];
                              onViewPatch({ visibleProperties: order });
                            }}
                          >
                            <option value="">Options</option>
                            <option value="left" disabled={index === 0}>
                              Move left
                            </option>
                            <option
                              value="right"
                              disabled={index === fields.length - 1}
                            >
                              Move right
                            </option>
                            <option value="hide">Hide</option>
                          </select>
                        )}
                        {resizeHandle(property.id, property.name)}
                      </span>
                    </th>
                  ))}
                  {actionColumn && (
                    <th scope="col">
                      {onAddProperty ? (
                        <IconButton
                          icon="plus"
                          label="Add property"
                          onClick={onAddProperty}
                        />
                      ) : (
                        <span className={styles.visuallyHidden}>Actions</span>
                      )}
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => (
                  <tr key={row.resourceId}>
                    {!readOnly && onBulkWrite && (
                      <td className={styles.selectionCell}>
                        <input
                          type="checkbox"
                          aria-label={`Select ${row.title}`}
                          checked={selected.has(row.resourceId)}
                          disabled={bulkDisabled}
                          onChange={(event) =>
                            setSelectedIds((current) =>
                              event.target.checked
                                ? [...new Set([...current, row.resourceId])]
                                : current.filter((id) => id !== row.resourceId),
                            )
                          }
                        />
                      </td>
                    )}
                    <th scope="row">
                      <EditableTitle
                        row={row}
                        openResource={openResource}
                        onEditTitle={readOnly ? undefined : onEditTitle}
                        titleEditUnavailable={titleEditUnavailable?.(
                          row.resourceId,
                        )}
                        onRename={readOnly ? undefined : onRename}
                      />
                    </th>
                    {fields.map((property) => (
                      <td key={property.id}>{propertyCell(row, property)}</td>
                    ))}
                    {actionColumn && (
                      <td>
                        {onRemove && (
                          <IconButton
                            icon="trash"
                            label="Remove"
                            className={styles.rowAction}
                            onClick={() => onRemove(row.resourceId)}
                          />
                        )}
                        {openBesideResource && (
                          <IconButton
                            icon="columns"
                            label="Beside"
                            className={styles.rowAction}
                            onClick={() => openBesideResource(row.resourceId)}
                          />
                        )}
                      </td>
                    )}
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td
                      colSpan={
                        fields.length +
                        1 +
                        (onBulkWrite && !readOnly ? 1 : 0) +
                        (actionColumn ? 1 : 0)
                      }
                    >
                      <p className={styles.empty}>
                        {emptyReason ?? 'No documents yet.'}
                      </p>
                    </td>
                  </tr>
                )}
                {!readOnly && onNew && (
                  <tr>
                    <td
                      colSpan={
                        fields.length +
                        1 +
                        (onBulkWrite && !readOnly ? 1 : 0) +
                        (actionColumn ? 1 : 0)
                      }
                    >
                      <button
                        type="button"
                        className={styles.inlineNew}
                        onClick={onNew}
                      >
                        + New document
                      </button>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      ) : rows.length === 0 && view.type !== 'board' ? (
        <p className={styles.empty}>{emptyReason ?? 'No documents yet.'}</p>
      ) : view.type === 'board' ? (
        !grouping ? (
          <p>Choose a grouping property in View settings.</p>
        ) : (
          <>
            {rows.length === 0 && (
              <p className={styles.empty} role="status">
                {emptyReason ?? 'No documents yet.'}
              </p>
            )}
            <div className={styles.board}>
              {[
                { id: '', name: 'Unassigned' },
                ...groups.filter((group) => group.id),
              ].map((group) => {
                const groupRows = rows.filter(
                  (row) => String(row.values[grouping.id] ?? '') === group.id,
                );
                const laneLimit = boardRowLimits[group.id] ?? 100;
                return (
                  <section
                    key={group.id}
                    className={styles.lane}
                    onDragOver={(event) => {
                      if (groupWritable) event.preventDefault();
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      if (!groupWritable) return;
                      const id = event.dataTransfer.getData(
                        'application/x-froglight-resource',
                      ) as ResourceId;
                      const row = rows.find((item) => item.resourceId === id);
                      if (row) void moveBoardCard(row, group.id || null);
                    }}
                  >
                    <h2
                      data-option-color={
                        'color' in group ? String(group.color) : 'default'
                      }
                    >
                      {group.name} ({groupRows.length})
                    </h2>
                    {groupRows.slice(0, laneLimit).map(card)}
                    {groupRows.length > laneLimit && (
                      <button
                        type="button"
                        className={styles.laneMore}
                        onClick={() =>
                          setBoardRowLimits((current) => ({
                            ...current,
                            [group.id]: laneLimit + 100,
                          }))
                        }
                      >
                        Show {Math.min(100, groupRows.length - laneLimit)} more
                        in {group.name}
                      </button>
                    )}
                  </section>
                );
              })}
            </div>
          </>
        )
      ) : view.type === 'calendar' || view.type === 'timeline' ? (
        <DatabaseDates
          rows={visibleRows}
          property={model.properties.find(
            (property) => property.id === view.dateProperty,
          )}
          timeline={view.type === 'timeline'}
          disabled={readOnly}
          card={card}
          move={(id, date, expected) =>
            writeCell
              ? writeCell(id, view.dateProperty!, date, expected)
              : write(id, view.dateProperty!, date)
          }
        />
      ) : (
        <div className={view.type === 'gallery' ? styles.gallery : styles.list}>
          {(view.type === 'calendar' || view.type === 'timeline') && (
            <p>Schedule using the date field on each resource.</p>
          )}
          {visibleRows.map(view.type === 'list' ? listRow : card)}
        </div>
      )}
      {view?.type !== 'board' && rows.length > rowLimit && (
        <div className={styles.moreRows}>
          <span>
            Showing {rowLimit} of {rows.length} documents
          </span>
          <button
            type="button"
            onClick={() => setRowLimit((count) => count + 100)}
          >
            Show 100 more
          </button>
        </div>
      )}
    </>
  );
}
