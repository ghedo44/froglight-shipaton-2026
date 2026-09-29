import type { ComponentProps } from 'react';
import styles from './DialogSurface.module.css';

/** Viewport geometry shared by task dialogs; the host owns keyboard measurement. */
export function DialogBackdrop({
  className = '',
  onDismiss,
  ...props
}: Omit<ComponentProps<'div'>, 'onMouseDown'> & { onDismiss(): void }) {
  return (
    <div
      {...props}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onDismiss();
      }}
      data-fl-viewport-overlay=""
      className={`${styles.backdrop} ${className}`}
    />
  );
}
