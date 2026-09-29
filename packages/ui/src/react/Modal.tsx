import { useId, useRef, type ReactNode, type Ref } from 'react';
import { IconButton } from './Button.jsx';
import { Dialog, type DialogHandle } from './primitives/Dialog.jsx';
import styles from './Modal.module.css';

/** Database task modal over the shared portal dialog primitive. */
export function Modal({
  title,
  description,
  onClose,
  children,
  wide = false,
  closeLabel = 'Close panel',
  closeRef: externalCloseRef,
}: {
  title: string;
  description?: string;
  onClose(): void;
  children: ReactNode;
  wide?: boolean;
  closeLabel?: string;
  closeRef?: Ref<DialogHandle>;
}): React.ReactElement {
  const titleId = useId();
  const descriptionId = useId();
  const closeRef = useRef<DialogHandle | null>(null);
  return <Dialog open onClose={onClose} closeRef={(handle) => {
    closeRef.current = handle;
    if (typeof externalCloseRef === 'function') externalCloseRef(handle);
    else if (externalCloseRef) externalCloseRef.current = handle;
  }}>
    <Dialog.Content
      className={`${styles.dialog} ${wide ? styles.wide : ''}`}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
    >
      <Dialog.Header className={styles.header}>
        <div>
          <h2 id={titleId}>{title}</h2>
          {description && <p id={descriptionId}>{description}</p>}
        </div>
        <IconButton icon="close" label={closeLabel} onClick={() => closeRef.current?.close()} />
      </Dialog.Header>
      <Dialog.Body className={styles.content}>{children}</Dialog.Body>
    </Dialog.Content>
  </Dialog>;
}
