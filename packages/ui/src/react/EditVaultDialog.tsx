import { useLayoutEffect, useRef, useState } from 'react';
import {
  writeVaultProfile,
  type VaultProfile,
  type VaultService,
} from '@froglight/foundation';
import { Dialog } from './primitives/Dialog.jsx';
import type { DialogHandle } from './primitives/Dialog.jsx';
import { DialogBody, DialogHeader } from './DialogParts.jsx';
import { Button } from './Button.jsx';
import { TextField } from './primitives/Fields.jsx';
import { VaultAppearancePicker } from './VaultAppearancePicker.jsx';
import { VaultIcon } from './VaultIcon.jsx';
import { useAboveKeyboard } from './useAboveKeyboard.js';
import styles from './LauncherView.module.css';

export function EditVaultDialog({
  vault,
  profile,
  onSaved,
  onClose,
}: {
  readonly vault: VaultService;
  readonly profile: VaultProfile;
  readonly onSaved: (profile: VaultProfile) => void;
  readonly onClose: () => void;
}): React.ReactElement {
  const [draft, setDraft] = useState(profile);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ref = useRef<HTMLElement | null>(null);
  const closeRef = useRef<DialogHandle | null>(null);
  const aboveKeyboard = useAboveKeyboard<HTMLElement>();
  useLayoutEffect(() => {
    const coarse = window.matchMedia?.('(any-pointer: coarse)').matches;
    ref.current
      ?.querySelector<HTMLElement>(coarse ? 'button' : 'input')
      ?.focus();
  }, []);
  return (
    <Dialog open closeRef={closeRef} dismissible={!busy}
      className={styles['vault-modal-backdrop']}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <Dialog.Content unstyled
        ref={(node) => {
          ref.current = node;
          aboveKeyboard(node);
        }}
        className={styles['vault-modal']}
        aria-labelledby="edit-vault-title"
        aria-busy={busy}
      >
        <DialogHeader>
          <h2 id="edit-vault-title">Edit vault</h2>
          <VaultIcon appearance={draft} size={40} />
        </DialogHeader>
        <DialogBody>
          <p className={styles['vault-modal-description']}>
            Give this vault a name and a look. These details sync with the
            vault; its folder stays in the same place.
          </p>
          <label className={styles['vault-field']}>
            <span>Vault name</span>
            <TextField
              value={draft.name}
              maxLength={120}
              disabled={busy}
              onChange={(event) =>
                setDraft({ ...draft, name: event.target.value })
              }
            />
          </label>
          <VaultAppearancePicker
            value={draft}
            onChange={(appearance) => setDraft({ ...draft, ...appearance })}
            disabled={busy}
          />
          {error && (
            <p className={styles['vault-modal-error']} role="alert">
              {error}
            </p>
          )}
          <div className={styles['vault-modal-actions']}>
            <Button disabled={busy} onClick={() => closeRef.current?.close()}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={busy || !draft.name.trim()}
              onClick={() => {
                const next = { ...draft, name: draft.name.trim() };
                setBusy(true);
                setError('');
                void writeVaultProfile(vault, next)
                  .then(() => closeRef.current?.close(() => onSaved(next)))
                  .catch((reason: unknown) =>
                    setError(
                      reason instanceof Error
                        ? reason.message
                        : 'Could not save vault details. Try again.',
                    ),
                  )
                  .finally(() => setBusy(false));
              }}
            >
              {busy ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </DialogBody>
      </Dialog.Content>
    </Dialog>
  );
}
