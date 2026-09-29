import { createContext, useContext, useEffect, useRef, useState } from 'react';
import {
  exportVaultBackup,
  type VaultBackupExportProgress,
  type VaultService,
} from '@froglight/foundation';
import type { VaultChoice, VaultHostAdapter } from '../launcher.js';
import { Button } from './Button.jsx';
import { VaultRestoreAction } from './VaultRestoreAction.jsx';
import sectionStyles from './SettingsView.module.css';
import styles from './VaultBackupSettingsView.module.css';

export const BackupVaultContext = createContext<{
  readonly vaults: VaultHostAdapter;
  readonly onOpen?: (choice: VaultChoice) => void;
} | null>(null);

interface BackupTarget {
  readonly id: string;
  readonly name: string;
  load(): Promise<VaultService>;
}

interface BackupRun {
  readonly busy: boolean;
  readonly completed: number;
  readonly total: number;
  readonly currentName: string | null;
  readonly progress: VaultBackupExportProgress | null;
  readonly failures: readonly string[];
  readonly finished: boolean;
}

const IDLE: BackupRun = {
  busy: false,
  completed: 0,
  total: 0,
  currentName: null,
  progress: null,
  failures: [],
  finished: false,
};

export function VaultBackupSettingsView(props: {
  readonly resolveVault: () => VaultService | null;
  readonly resolveCurrentVault: () => { id: string; name: string } | null;
}): React.ReactElement {
  const currentVault = props.resolveVault();
  const current = props.resolveCurrentVault();
  const host = useContext(BackupVaultContext);
  const [available, setAvailable] = useState<readonly VaultChoice[] | null>(
    null,
  );
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [run, setRun] = useState<BackupRun>(IDLE);
  const operation = useRef<AbortController | null>(null);

  useEffect(() => {
    if (host === null) return;
    let alive = true;
    setAvailable(null);
    setListError(null);
    void host.vaults
      .listRecent()
      .then((choices) => {
        if (!alive) return;
        setAvailable(choices);
        setSelected(
          current !== null && choices.some((choice) => choice.id === current.id)
            ? new Set([current.id])
            : new Set(),
        );
      })
      .catch((error: unknown) => {
        if (alive) setListError(`Could not load vaults: ${describe(error)}`);
      });
    return () => {
      alive = false;
    };
  }, [host?.vaults, current?.id]);

  useEffect(() => () => operation.current?.abort(), []);

  const start = (targets: readonly BackupTarget[]): void => {
    if (run.busy || targets.length === 0) return;
    const abort = new AbortController();
    operation.current = abort;
    setRun({ ...IDLE, busy: true, total: targets.length });
    void (async () => {
      const failures: string[] = [];
      for (const [index, target] of targets.entries()) {
        if (abort.signal.aborted) break;
        let lastReported = 0;
        let lastPhase: VaultBackupExportProgress['phase'] | null = null;
        setRun({
          busy: true,
          completed: index,
          total: targets.length,
          currentName: target.name,
          progress: null,
          failures: [...failures],
          finished: false,
        });
        try {
          const vault = await target.load();
          if (abort.signal.aborted) break;
          const result = await exportVaultBackup({
            vault,
            signal: abort.signal,
            onProgress: (progress) => {
              if (abort.signal.aborted) return;
              const now = performance.now();
              if (
                progress.phase === lastPhase &&
                progress.completedFiles !== progress.totalFiles &&
                now - lastReported < 80
              )
                return;
              lastReported = now;
              lastPhase = progress.phase;
              setRun((state) => ({ ...state, progress }));
            },
          });
          if (abort.signal.aborted) break;
          downloadBytes(
            result.bundle,
            `${safeFilename(target.name)}-${safeFilename(target.id)}.froglight-vault.json`,
          );
        } catch (error) {
          if (abort.signal.aborted) break;
          failures.push(`${target.name}: ${describe(error)}`);
        }
      }
      if (!abort.signal.aborted) {
        setRun({
          busy: false,
          completed: targets.length,
          total: targets.length,
          currentName: null,
          progress: null,
          failures,
          finished: true,
        });
      }
      if (operation.current === abort) operation.current = null;
    })();
  };

  const startSelected = (): void => {
    if (host === null || available === null) return;
    start(
      available
        .filter((choice) => selected.has(choice.id))
        .map((choice) => ({
          id: choice.id,
          name: choice.name,
          load: () =>
            choice.id === current?.id && currentVault !== null
              ? Promise.resolve(currentVault)
              : host.vaults.openForBackup(choice.id),
        })),
    );
  };

  const fraction =
    run.progress?.phase === 'encoding'
      ? 1
      : run.progress?.phase === 'reading' && run.progress.totalFiles !== null
        ? run.progress.totalFiles === 0
          ? 0
          : run.progress.completedFiles / run.progress.totalFiles
        : 0;

  return (
    <>
      <h2 className={sectionStyles['settings-section-title']}>Backups</h2>
      {host !== null ? (
        <>
          <p className={styles.lede}>
            Choose the vaults to back up. Each vault downloads as a separate,
            restorable file containing its saved files and metadata.
          </p>
          <div className={styles.listHeader}>
            <strong>Your vaults</strong>
            {available !== null && available.length > 0 ? (
              <div className={styles.selectionActions}>
                <button
                  type="button"
                  disabled={run.busy}
                  onClick={() =>
                    setSelected(new Set(available.map((choice) => choice.id)))
                  }
                >
                  Select all
                </button>
                <button
                  type="button"
                  disabled={run.busy || selected.size === 0}
                  onClick={() => setSelected(new Set())}
                >
                  Clear
                </button>
              </div>
            ) : null}
          </div>
          {available === null ? (
            <p className={styles.notice} role="status">
              Loading vaults…
            </p>
          ) : available.length === 0 ? (
            <p className={styles.notice}>
              No vaults here yet. Open a vault to add it to this device.
            </p>
          ) : (
            <div
              className={styles.vaultList}
              role="group"
              aria-label="Vaults to back up"
            >
              {available.map((choice) => (
                <label key={choice.id} className={styles.vaultRow}>
                  <input
                    type="checkbox"
                    checked={selected.has(choice.id)}
                    disabled={run.busy}
                    onChange={(event) => {
                      const next = new Set(selected);
                      if (event.target.checked) next.add(choice.id);
                      else next.delete(choice.id);
                      setSelected(next);
                    }}
                  />
                  <span className={styles.vaultDetails}>
                    <strong>{choice.name}</strong>
                    <small>{choice.location}</small>
                  </span>
                </label>
              ))}
            </div>
          )}
          {listError !== null ? (
            <p className={styles.notice} data-kind="error" role="alert">
              {listError}
            </p>
          ) : null}
          <div className={styles.actionRow}>
            <div>
              <strong>Full vault backup</strong>
              <p>
                Select one or several vaults. Only saved files are included.
              </p>
            </div>
            <Button
              type="button"
              variant="primary"
              disabled={run.busy || selected.size === 0 || available === null}
              onClick={startSelected}
            >
              {run.busy ? 'Backing up…' : `Back up selected (${selected.size})`}
            </Button>
          </div>
          {host.onOpen !== undefined ? (
            <div className={styles.actionRow}>
              <div>
                <strong>Restore a vault</strong>
                <p>
                  Restore a backup into a new empty vault. Existing vaults are
                  never overwritten.
                </p>
              </div>
              <VaultRestoreAction vaults={host.vaults} onOpen={host.onOpen} />
            </div>
          ) : null}
        </>
      ) : current !== null && currentVault !== null ? (
        <>
          <p className={styles.lede}>
            Download a lossless copy of every saved file in this vault,
            including hidden Froglight metadata and plugin data.
          </p>
          <div className={styles.actionRow}>
            <div>
              <strong>Full vault backup</strong>
              <p>Keep a portable copy of this vault on your device.</p>
            </div>
            <Button
              type="button"
              variant="primary"
              disabled={run.busy}
              onClick={() =>
                start([
                  {
                    id: current.id,
                    name: current.name,
                    load: () => Promise.resolve(currentVault),
                  },
                ])
              }
            >
              {run.busy ? 'Backing up…' : 'Download backup'}
            </Button>
          </div>
        </>
      ) : (
        <p className={styles.notice} data-kind="error" role="alert">
          Open a vault before creating a backup.
        </p>
      )}
      {run.busy ? (
        <div className={styles.progress} role="status" aria-live="polite">
          <strong>
            Backing up {run.currentName} · {run.completed + 1} of {run.total}
          </strong>
          <progress
            max={run.total}
            value={run.completed + fraction}
            aria-label="Backup progress"
          />
          <span>
            {run.progress?.phase === 'scanning'
              ? 'Scanning files…'
              : run.progress?.phase === 'reading'
                ? `Reading files · ${run.progress.completedFiles} of ${run.progress.totalFiles}`
                : run.progress?.phase === 'encoding'
                  ? 'Preparing download…'
                  : 'Opening vault…'}
          </span>
        </div>
      ) : null}
      {run.finished ? (
        <div
          className={styles.notice}
          role={run.failures.length > 0 ? 'alert' : 'status'}
          data-kind={run.failures.length > 0 ? 'error' : 'success'}
        >
          {run.total - run.failures.length} of {run.total} backup downloads
          started.
          {run.failures.map((failure, index) => (
            <p key={index}>{failure}</p>
          ))}
        </div>
      ) : null}
    </>
  );
}

function safeFilename(value: string): string {
  return (
    value
      .trim()
      .replace(/[\\/:*?"<>|]+/g, '-')
      .slice(0, 80) || 'Froglight vault'
  );
}

function downloadBytes(bytes: Uint8Array, filename: string): void {
  const url = URL.createObjectURL(
    new Blob([bytes as BlobPart], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL?.(url), 1000);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
