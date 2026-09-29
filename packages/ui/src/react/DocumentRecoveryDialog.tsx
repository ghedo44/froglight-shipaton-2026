import { useRef, useState } from 'react';
import type { DocumentRecoveryError } from '@froglight/foundation';
import { Dialog, type DialogHandle } from './primitives/Dialog.jsx';
import { DialogBody, DialogHeader } from './DialogParts.jsx';
import { Button } from './Button.jsx';
import styles from './PublicationConflictDialog.module.css';

export function DocumentRecoveryDialog({
  error,
  onClose,
}: {
  readonly error: DocumentRecoveryError;
  readonly onClose: () => void;
}): React.ReactElement {
  const closeRef = useRef<DialogHandle | null>(null);
  const [exportError, setExportError] = useState('');
  return (
    <Dialog open closeRef={closeRef} onClose={onClose}>
      <Dialog.Content
        className={styles.dialog}
        aria-labelledby="document-recovery-title"
      >
        <DialogHeader>
          <h2 id="document-recovery-title">Recovery needs attention</h2>
        </DialogHeader>
        <DialogBody>
          <p>
            Newer local edits could not be recovered. Your original file and
            recovery data are preserved.
          </p>
          <p>
            You can export the last valid{' '}
            {error.recovery.origin === 'saved-file'
              ? 'saved file'
              : 'local state'}{' '}
            as a separate document. It may omit newer edits.
          </p>
          {exportError && <p role="alert">{exportError}</p>}
          <div className={styles.actions}>
            <Button onClick={() => closeRef.current?.close()}>Close</Button>
            <Button
              variant="primary"
              onClick={() => {
                try {
                  const url = URL.createObjectURL(
                    new Blob([error.recovery.data.slice().buffer], {
                      type: 'application/json',
                    }),
                  );
                  const link = document.createElement('a');
                  link.href = url;
                  link.download = error.recovery.filename;
                  link.click();
                  URL.revokeObjectURL(url);
                } catch (reason) {
                  setExportError(
                    reason instanceof Error
                      ? reason.message
                      : 'Could not export recovery. Try again.',
                  );
                }
              }}
            >
              Export last valid state
            </Button>
          </div>
        </DialogBody>
      </Dialog.Content>
    </Dialog>
  );
}
