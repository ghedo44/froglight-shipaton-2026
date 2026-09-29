import type { ComponentProps } from 'react';
import styles from './DialogSurface.module.css';

/** Stays outside the scrolling body, including an optional close action. */
export function DialogHeader({
  className = '',
  ...props
}: ComponentProps<'header'>) {
  return <header {...props} className={`${styles.header} ${className}`} />;
}

export function DialogBody({
  className = '',
  ...props
}: ComponentProps<'div'>) {
  return <div {...props} className={`${styles.body} ${className}`} />;
}
