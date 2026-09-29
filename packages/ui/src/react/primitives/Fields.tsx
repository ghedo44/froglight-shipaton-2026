import type { ComponentProps, ReactNode } from 'react';
import styles from './Fields.module.css';

type InputProps = ComponentProps<'input'>;

export function TextField({
  className = '',
  ...props
}: InputProps): React.ReactElement {
  return <input {...props} className={`${styles.field} ${className}`} />;
}

export function SearchField(
  props: Omit<InputProps, 'type'>,
): React.ReactElement {
  return <TextField {...props} type="search" />;
}

export function TextArea({
  className = '',
  ...props
}: ComponentProps<'textarea'>): React.ReactElement {
  return <textarea {...props} className={`${styles.field} ${className}`} />;
}

export function Select({
  className = '',
  ...props
}: ComponentProps<'select'>): React.ReactElement {
  return <select {...props} className={`${styles.field} ${className}`} />;
}

export function Checkbox({
  className = '',
  ...props
}: Omit<InputProps, 'type'>): React.ReactElement {
  return (
    <input
      {...props}
      type="checkbox"
      className={`${styles.checkbox} ${className}`}
    />
  );
}

export function FormField({
  label,
  hint,
  error,
  children,
  className = '',
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <label className={`${styles.formField} ${className}`}>
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
      {error && <small className={styles.error}>{error}</small>}
    </label>
  );
}
