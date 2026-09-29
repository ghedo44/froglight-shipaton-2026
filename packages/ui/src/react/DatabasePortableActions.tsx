import { useMemo, useState } from 'react';
import {
  exportPortableDatabase,
  importPortableDatabase,
  type DatabaseController,
  type DocumentRegistry,
  type PortableImportResult,
  type ResourceId,
  type VaultService,
} from '@froglight/foundation';
import styles from './DatabaseView.module.css';
import { databaseRowsToCsv } from './database-csv.js';

const MAX_BUNDLE_BYTES = 700 * 1024 * 1024;
const MAX_VISIBLE_DEPENDENCIES = 200;

interface BundlePreview {
  readonly filename: string;
  readonly bytes: Uint8Array;
  readonly databasePath: string;
  readonly documentCount: number;
  readonly externalReferenceCount: number;
}

export function DatabasePortableActions({
  controller,
  documents,
  vault,
  disabled,
  openResource,
}: {
  readonly controller: DatabaseController;
  readonly documents: DocumentRegistry;
  readonly vault: VaultService;
  readonly disabled: boolean;
  readonly openResource: (id: ResourceId) => void;
}) {
  const [selected, setSelected] = useState<readonly ResourceId[]>([]);
  const [dependencySearch, setDependencySearch] = useState('');
  const [preview, setPreview] = useState<BundlePreview | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [report, setReport] = useState<PortableImportResult | null>(null);
  const [csvViewId, setCsvViewId] = useState(
    controller.model.views[0]?.id ?? '',
  );
  const [spreadsheetSafe, setSpreadsheetSafe] = useState(false);
  const databaseId = controller.session.document.location.resourceId;
  const explicitMembers = useMemo(
    () =>
      new Set(
        controller.model.membership.mode === 'explicit'
          ? controller.model.membership.resourceIds
          : [],
      ),
    [controller.model.membership],
  );
  const dependencies = useMemo(() => {
    const titles = new Map(
      controller.properties.rows().map((row) => [row.resourceId, row.title]),
    );
    return controller.workspace
      .listDocuments()
      .filter((ref) => ref.location.resourceId !== databaseId)
      .map((ref) => {
        const path = controller.workspace.resolveResourcePath(
          ref.location.resourceId,
        );
        return {
          id: ref.location.resourceId,
          path,
          title:
            titles.get(ref.location.resourceId) ??
            path.split('/').pop() ??
            path,
        };
      })
      .sort((a, b) => a.path.localeCompare(b.path));
  }, [controller, databaseId]);
  const normalizedSearch = dependencySearch.trim().toLocaleLowerCase();
  const matchingDependencies = dependencies.filter((item) =>
    `${item.title} ${item.path}`.toLocaleLowerCase().includes(normalizedSearch),
  );
  const visibleDependencies = matchingDependencies.slice(
    0,
    MAX_VISIBLE_DEPENDENCIES,
  );
  const busy = disabled || working;

  const run = async (operation: () => Promise<void>) => {
    setWorking(true);
    setError('');
    try {
      await operation();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setWorking(false);
    }
  };

  const exportBundle = () =>
    void run(async () => {
      const bytes = await exportPortableDatabase({
        databaseId,
        includeResourceIds: selected,
        workspace: controller.workspace,
        vault,
      });
      downloadBundle(bytes, portableFilename(controller.model.title));
    });

  const chooseBundle = (file: File | undefined) =>
    void run(async () => {
      setPreview(null);
      setReport(null);
      if (!file) return;
      if (file.size > MAX_BUNDLE_BYTES)
        throw new Error(
          'This bundle is larger than the supported 700 MB limit.',
        );
      const bytes = new Uint8Array(await file.arrayBuffer());
      setPreview(readBundlePreview(file.name, bytes));
    });

  const importBundle = () => {
    if (!preview) return;
    void run(async () => {
      setReport(
        await importPortableDatabase({
          bundle: preview.bytes,
          workspace: controller.workspace,
          vault,
          registry: documents,
        }),
      );
    });
  };

  const exportCsv = () =>
    void run(async () => {
      const view = controller.model.views.find((item) => item.id === csvViewId);
      if (!view) throw new Error('Choose an available saved view');
      const rows = await controller.rows(view.id);
      if (rows.length > 10_000)
        throw new Error('CSV export is limited to 10,000 matching rows');
      const csv = databaseRowsToCsv(
        controller.model.properties,
        rows,
        spreadsheetSafe,
      );
      downloadBlob(
        new Blob([csv], { type: 'text/csv;charset=utf-8' }),
        `${portableFilename(controller.model.title).replace(/\.froglight-database\.json$/, '')}.csv`,
      );
    });

  return (
    <section className={styles.portableActions}>
      <p>
        Export the database schema and the document dependencies you select.
        Relations to documents left out stay listed as external references.
      </p>
      <fieldset>
        <legend>Document dependencies ({selected.length} selected)</legend>
        <label>
          Find documents{' '}
          <input
            type="search"
            value={dependencySearch}
            disabled={busy}
            onChange={(event) => setDependencySearch(event.target.value)}
          />
        </label>
        {explicitMembers.size > 0 && (
          <button
            type="button"
            disabled={busy}
            onClick={() => setSelected([...explicitMembers])}
          >
            Select collection documents
          </button>
        )}
        <button
          type="button"
          disabled={busy || selected.length === 0}
          onClick={() => setSelected([])}
        >
          Clear selection
        </button>
        <div className={styles.existingChoices}>
          {visibleDependencies.map((item) => (
            <label key={item.id}>
              <input
                type="checkbox"
                checked={selected.includes(item.id)}
                disabled={busy}
                onChange={(event) =>
                  setSelected(
                    event.target.checked
                      ? [...selected, item.id]
                      : selected.filter((id) => id !== item.id),
                  )
                }
              />
              <span>
                {item.title}
                {explicitMembers.has(item.id) ? ' · collection document' : ''}
                <small>{item.path}</small>
              </span>
            </label>
          ))}
          {visibleDependencies.length === 0 && (
            <p>No documents match this search.</p>
          )}
        </div>
        {matchingDependencies.length > MAX_VISIBLE_DEPENDENCIES && (
          <small>
            Showing the first {MAX_VISIBLE_DEPENDENCIES} matches. Narrow the
            search to choose another document.
          </small>
        )}
        <button type="button" disabled={busy} onClick={exportBundle}>
          {working ? 'Working…' : 'Download portable copy'}
        </button>
      </fieldset>

      <fieldset>
        <legend>CSV exchange</legend>
        <p>
          CSV flattens one saved view. It omits templates, membership rules,
          relation identities, and source documents; use a portable copy to
          preserve those. Structured values are JSON text. CSV import is not
          supported here.
        </p>
        <label>
          Saved view{' '}
          <select
            value={csvViewId}
            disabled={busy}
            onChange={(event) => setCsvViewId(event.target.value)}
          >
            {controller.model.views.map((view) => (
              <option key={view.id} value={view.id}>
                {view.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={spreadsheetSafe}
            disabled={busy}
            onChange={(event) => setSpreadsheetSafe(event.target.checked)}
          />{' '}
          Excel formula guard (prefix formula-like text with a tab)
        </label>
        <small>
          This alters exported text. CSV escaping differs across spreadsheet
          apps and may change after re-saving; use the portable copy for
          reliable round trips.
        </small>
        <button type="button" disabled={busy || !csvViewId} onClick={exportCsv}>
          Download CSV
        </button>
      </fieldset>

      <fieldset>
        <legend>Import a portable copy</legend>
        <label>
          Choose bundle{' '}
          <input
            type="file"
            accept=".froglight-database.json,application/json"
            disabled={busy}
            onChange={(event) => chooseBundle(event.target.files?.[0])}
          />
        </label>
        {preview && (
          <div role="status">
            <strong>{preview.filename}</strong>
            <p>
              {preview.documentCount} documents · database at{' '}
              {preview.databasePath} · {preview.externalReferenceCount} external
              references
            </p>
            <p>
              Import validates every document, path, schema, and reference
              before writing. Existing destination paths stop the import.
            </p>
            <button type="button" disabled={busy} onClick={importBundle}>
              Import into this vault
            </button>
          </div>
        )}
      </fieldset>

      {error && <p role="alert">Portable copy failed: {error}</p>}
      {report?.status === 'complete' && (
        <div role="status">
          <p>
            Imported {report.imported.length} documents.{' '}
            {report.externalReferences.length} references still point outside
            this copy.
          </p>
          <button
            type="button"
            onClick={() => openResource(report.database.resourceId)}
          >
            Open imported database
          </button>
        </div>
      )}
      {report?.status === 'partial' && (
        <div role="alert">
          <p>
            Import stopped during {report.phase}. {report.imported.length}{' '}
            documents were already created and were kept.
          </p>
          {report.failedSourceResourceId && (
            <p>Failed source: {report.failedSourceResourceId}</p>
          )}
          <p>{errorMessage(report.error)}</p>
        </div>
      )}
    </section>
  );
}

function portableFilename(title: string): string {
  const base = title
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .slice(0, 80);
  return `${base || 'Database'}.froglight-database.json`;
}

function downloadBundle(bytes: Uint8Array, filename: string): void {
  downloadBlob(
    new Blob([bytes as BlobPart], { type: 'application/json' }),
    filename,
  );
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function readBundlePreview(filename: string, bytes: Uint8Array): BundlePreview {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error(
      'The selected file is not a valid portable database bundle.',
    );
  }
  if (!value || typeof value !== 'object')
    throw new Error(
      'The selected file is not a valid portable database bundle.',
    );
  const record = value as Record<string, unknown>;
  if (
    record.format !== 'froglight.database-portable' ||
    record.version !== 1 ||
    typeof record.databaseResourceId !== 'string' ||
    !Array.isArray(record.documents) ||
    !Array.isArray(record.externalReferences)
  )
    throw new Error('This portable database format or version is unsupported.');
  const database = record.documents.find(
    (item) =>
      item &&
      typeof item === 'object' &&
      (item as Record<string, unknown>).resourceId ===
        record.databaseResourceId,
  ) as Record<string, unknown> | undefined;
  if (!database || typeof database.path !== 'string')
    throw new Error(
      'The portable bundle does not contain its database document.',
    );
  return {
    filename,
    bytes,
    databasePath: database.path,
    documentCount: record.documents.length,
    externalReferenceCount: record.externalReferences.length,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
