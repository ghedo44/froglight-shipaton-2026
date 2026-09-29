import { useRef, useState } from 'react';
import type { DocumentSession } from '@froglight/foundation';
import { Dialog, type DialogHandle } from './primitives/Dialog.jsx';
import { DialogBody, DialogHeader } from './DialogParts.jsx';
import styles from './PublicationConflictDialog.module.css';
import { Button } from './Button.jsx';

export function PublicationConflictDialog({
  session,
  onClose,
  onSaved,
}: {
  readonly session: DocumentSession;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}): React.ReactElement {
  const closeRef = useRef<DialogHandle | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Dialog open closeRef={closeRef} onClose={onClose} dismissible={!busy}>
      <Dialog.Content
        className={styles.dialog}
        aria-labelledby="publication-conflict-title"
        aria-busy={busy}
      >
        <DialogHeader>
          <h2 id="publication-conflict-title">The vault file changed</h2>
        </DialogHeader>
        <DialogBody>
          <p>
            Your local changes are preserved. Replacing the vault file will
            overwrite its external changes.
          </p>
          {error && <p role="alert">{error}</p>}
          <div className={styles.actions}>
            <Button disabled={busy} onClick={() => closeRef.current?.close()}>
              Keep editing
            </Button>
            <Button
              variant="danger"
              disabled={
                busy || session.resolvePublicationConflict === undefined
              }
              onClick={() => {
                setBusy(true);
                setError('');
                void session.resolvePublicationConflict!()
                  .then((result) => {
                    if (!result.committed) throw result.error;
                    closeRef.current?.close(onSaved);
                  })
                  .catch((reason: unknown) =>
                    setError(
                      reason instanceof Error
                        ? reason.message
                        : 'Could not update the vault. Try again.',
                    ),
                  )
                  .finally(() => setBusy(false));
              }}
            >
              Replace vault version
            </Button>
          </div>
        </DialogBody>
      </Dialog.Content>
    </Dialog>
  );
}
