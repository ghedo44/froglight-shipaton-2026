/**
 * Toast live region. Stays mounted so screen readers announce toasts that
 * appear after the first paint.
 */

import styles from '../../WorkspaceView.module.css';
import type { Toast } from '../hooks/useToast.js';

export function ToastRegion(props: {
  readonly toast: Toast | null;
}): React.ReactElement {
  const { toast } = props;
  return (
    <div className={styles['fl-toast-region']} role="status" aria-live="polite">
      {toast !== null ? (
        <div
          key={toast.at}
          className={`${styles['fl-toast']}${toast.kind === 'error' ? ` ${styles.error}` : ''}${toast.leaving ? ` ${styles.leaving}` : ''}`}
        >
          <span className={styles['fl-toast-dot']} />
          <span>{toast.text}</span>
        </div>
      ) : null}
    </div>
  );
}
