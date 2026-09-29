import { DialogHeader, DialogBody } from './DialogParts.jsx';
import { Dialog } from './primitives/Dialog.jsx';
import type { DialogHandle } from './primitives/Dialog.jsx';
import { useEffect, useRef, useState } from 'react';
import {
  restoreVaultBackup,
  type VaultBackupRestoreComplete,
} from '@froglight/foundation';
import type {
  EmptyVaultStore,
  VaultChoice,
  VaultHostAdapter,
} from '../launcher.js';
import { Button } from './Button.jsx';
import { TextField } from './primitives/Fields.jsx';
import { useAboveKeyboard } from './useAboveKeyboard.js';
import styles from './LauncherView.module.css';

const MAX_BUNDLE_BYTES = 700 * 1024 * 1024;

export function VaultRestoreAction(props: {
  readonly vaults: VaultHostAdapter;
  readonly onOpen: (choice: VaultChoice) => void;
}): React.ReactElement {
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);

  return (
    <>
      <Button type="button" onClick={() => fileInput.current?.click()}>
        Restore backup
      </Button>
      <input
        ref={fileInput}
        hidden
        type="file"
        accept=".froglight-vault.json,application/json"
        data-testid="restore-vault-file-input"
        onChange={(event) => {
          const selected = event.target.files?.[0] ?? null;
          event.target.value = '';
          if (selected !== null) setFile(selected);
        }}
      />
      {file !== null ? (
        <RestoreVaultModal
          file={file}
          vaults={props.vaults}
          onOpen={props.onOpen}
          onClose={() => setFile(null)}
        />
      ) : null}
    </>
  );
}

function RestoreVaultModal(props: {
  readonly file: File;
  readonly vaults: VaultHostAdapter;
  readonly onOpen: (choice: VaultChoice) => void;
  readonly onClose: () => void;
}): React.ReactElement {
  const [name, setName] = useState(() => backupName(props.file.name));
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [prepared, setPrepared] = useState<{
    readonly store: EmptyVaultStore;
    readonly result: VaultBackupRestoreComplete;
  } | null>(null);
  const nameInput = useRef<HTMLInputElement | null>(null);
  const dialog = useRef<HTMLElement | null>(null);
  const closeRef = useRef<DialogHandle | null>(null);
  const store = useRef<EmptyVaultStore | null>(null);
  const glideRef = useAboveKeyboard<HTMLElement>();

  useEffect(() => {
    nameInput.current?.focus({ preventScroll: true });
    return () => {
      const pending = store.current;
      store.current = null;
      if (pending !== null) void pending.discard();
    };
  }, []);

  const close = (): void => {
    if (busy) return;
    closeRef.current?.close();
  };

  const openPrepared = async (
    ready: NonNullable<typeof prepared>,
  ): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      const choice = await ready.store.activate();
      if (choice === null) {
        setError('The restored vault is ready, but opening it was canceled.');
        return;
      }
      store.current = null;
      props.onOpen(choice);
    } catch (failure) {
      setError(
        `The backup was restored, but the new vault could not be opened. Retry opening it. ${describe(failure)}`,
      );
    } finally {
      setBusy(false);
    }
  };

  const restore = async (): Promise<void> => {
    if (!confirmed || !name.trim() || busy) return;
    if (props.vaults.createEmptyVaultStore === undefined) {
      setError(
        'This host cannot create a guarded empty restore destination. No vault was changed.',
      );
      return;
    }
    if (props.file.size > MAX_BUNDLE_BYTES) {
      setError('This backup is larger than the supported 700 MiB limit.');
      return;
    }
    setBusy(true);
    setError('');
    let staging: EmptyVaultStore | null = null;
    try {
      const bytes = new Uint8Array(await props.file.arrayBuffer());
      staging = await props.vaults.createEmptyVaultStore(name.trim());
      if (staging === null) return;
      store.current = staging;
      const result = await restoreVaultBackup({
        bundle: bytes,
        destination: staging.vault,
        requireEmptyDestination: true,
      });
      if (result.status === 'partial') {
        await staging.discard();
        store.current = null;
        setError(
          `Restore stopped while ${phaseLabel(result.phase)} “${result.failedPath}” after ${result.writtenFiles.length} files and ${result.createdDirectories.length} folders. The incomplete staging vault was not opened. ${describe(result.error)}`,
        );
        return;
      }
      const ready = { store: staging, result };
      setPrepared(ready);
      await openPrepared(ready);
    } catch (failure) {
      if (staging !== null) {
        await staging.discard();
        store.current = null;
      }
      setError(
        `Restore failed before the new vault opened: ${describe(failure)}`,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open closeRef={closeRef} dismissible={!busy}
      className={styles['vault-modal-backdrop']}
      onClose={props.onClose}
    >
      <Dialog.Content unstyled
        ref={(node) => {
          dialog.current = node;
          glideRef(node);
        }}
        className={styles['vault-modal']}
        aria-labelledby="restore-vault-title"
      >
        <DialogHeader>
          <h2 id="restore-vault-title">Restore backup</h2>
        </DialogHeader>
        <DialogBody>
          <p className={styles['vault-modal-description']}>
            {props.file.name} · {formatBytes(props.file.size)}. Froglight will
            validate the complete backup before writing it.
          </p>
          <label className={styles['vault-field']}>
            <span>New vault name</span>
            <TextField
              ref={nameInput}
              value={name}
              disabled={busy || prepared !== null}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className={styles['vault-restore-confirmation']}>
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy || prepared !== null}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <span>
              Create a new empty vault for this restore. Existing vaults will
              not be changed or overwritten.
            </span>
          </label>
          <div
            className={styles['vault-modal-error']}
            role={error ? 'alert' : undefined}
          >
            {error}
          </div>
          <div className={styles['vault-modal-actions']}>
            <Button type="button" disabled={busy} onClick={close}>
              {prepared === null ? 'Cancel' : 'Discard restored copy'}
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={
                busy || (!confirmed && prepared === null) || !name.trim()
              }
              onClick={() => {
                if (prepared !== null) void openPrepared(prepared);
                else void restore();
              }}
            >
              {busy
                ? prepared === null
                  ? 'Restoring…'
                  : 'Opening…'
                : prepared === null
                  ? 'Restore into new vault'
                  : 'Retry opening'}
            </Button>
          </div>
        </DialogBody>
      </Dialog.Content>
    </Dialog>
  );
}

function backupName(filename: string): string {
  return (
    filename
      .replace(/\.froglight-vault\.json$/i, '')
      .replace(/\.json$/i, '')
      .trim() || 'Restored vault'
  );
}

function phaseLabel(phase: 'create-directory' | 'write-file'): string {
  return phase === 'create-directory' ? 'creating folder' : 'writing file';
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
