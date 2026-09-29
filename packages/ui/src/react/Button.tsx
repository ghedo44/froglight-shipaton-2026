import type { ButtonHTMLAttributes, MouseEventHandler, ReactNode } from 'react';
import { Icon } from './Icon.jsx';
import styles from './Button.module.css';

export type ButtonVariant =
  | 'default'
  | 'primary'
  | 'secondary'
  | 'ghost'
  | 'danger';

interface ButtonBase {
  /** Visual variant. Omitted `variant` renders the base button look. */
  readonly variant?: ButtonVariant;
}

export interface ButtonElementProps
  extends ButtonBase,
    Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'href' | 'download'> {
  readonly href?: undefined;
  readonly ref?: React.Ref<HTMLButtonElement>;
}

export interface ButtonAnchorProps extends ButtonBase {
  readonly href: string;
  readonly download?: string | boolean;
  readonly onClick?: MouseEventHandler<HTMLAnchorElement>;
  readonly title?: string;
  readonly className?: string;
  readonly children?: ReactNode;
}

export type ButtonProps = ButtonElementProps | ButtonAnchorProps;

function mergeClass(...parts: Array<string | undefined>): string {
  return parts.filter((part) => part !== undefined && part !== '').join(' ');
}

/**
 * Froglight button — appearance, semantics, and accessibility defaults as
 * one unit. Variants select through `data-variant`, never global class
 * names; `data-fl-component="button"` is the deliberate external hook.
 */
export function Button(props: ButtonProps): React.ReactElement {
  if (props.href !== undefined) {
    const { variant = 'default', className, children, href, download } = props;
    return (
      <a
        className={mergeClass(styles.btn, className)}
        data-fl-component="button"
        data-variant={variant}
        href={href}
        download={download}
        onClick={props.onClick}
        title={props.title}
      >
        {children}
      </a>
    );
  }
  const {
    variant = 'default',
    className,
    children,
    type,
    disabled,
    ref,
    ...rest
  } = props;
  return (
    <button
      className={mergeClass(styles.btn, className)}
      data-fl-component="button"
      data-variant={variant}
      type={type ?? 'button'}
      disabled={disabled}
      ref={ref}
      {...rest}
    >
      {children}
    </button>
  );
}

export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  readonly icon: string;
  /** Accessible name. Always applied as `aria-label`. */
  readonly label: string;
  readonly size?: number;
  /**
   * Toggled state. Renders the global `active` state hook class so existing
   * contextual rules (pane-header, titlebar toggle) keep matching; the
   * class is state, never structure.
   */
  readonly active?: boolean;
}

/**
 * Froglight icon-only button. The accessible name is required — an
 * icon without a label is a review failure, not a styling choice.
 */
export function IconButton(props: IconButtonProps): React.ReactElement {
  const { icon, label, size = 16, active, className, ...rest } = props;
  return (
    <button
      type="button"
      className={mergeClass(
        styles['icon-button'],
        active === true ? 'active' : undefined,
        className,
      )}
      data-fl-component="icon-button"
      aria-label={label}
      {...rest}
    >
      <Icon name={icon} size={size} />
    </button>
  );
}
