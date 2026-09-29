import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { PaneModeView } from '../../../workbench.js';
import { Icon } from '../../Icon.jsx';
import styles from '../../WorkspaceView.module.css';

const modes: Record<PaneModeView, { label: string; icon: string }> = {
  edit: { label: 'Edit', icon: 'edit' },
  split: { label: 'Split', icon: 'columns' },
  reading: { label: 'View', icon: 'book' },
};

export function projectedPresentationModes(
  available: readonly PaneModeView[],
  current: PaneModeView,
  allowVisibleSplit: boolean,
): readonly PaneModeView[] {
  return available.filter(
    (mode) => mode !== 'split' || allowVisibleSplit || current === 'split',
  );
}

export function PresentationControl(props: {
  readonly mode: PaneModeView;
  readonly availableModes: readonly PaneModeView[];
  readonly onSetMode: (mode: PaneModeView) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef<number | null>(null);
  const suppressClick = useRef(false);
  useEffect(() => {
    if (!open) return;
    menuRef.current
      ?.querySelector<HTMLButtonElement>('[aria-checked="true"]')
      ?.focus();
    const dismiss = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !rootRef.current?.contains(event.target)
      )
        setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    const observer =
      typeof ResizeObserver === 'function'
        ? new ResizeObserver(() => {
            if (
              triggerRef.current &&
              getComputedStyle(triggerRef.current).display === 'none'
            )
              setOpen(false);
          })
        : null;
    if (rootRef.current) observer?.observe(rootRef.current);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      observer?.disconnect();
    };
  }, [open]);
  if (props.availableModes.length < 2) return <></>;
  return (
    <div
      className={styles['compact-presentation']}
      ref={rootRef}
      onKeyDown={(event) => {
        if (!open) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          setOpen(false);
          triggerRef.current?.focus();
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          const items = [
            ...(menuRef.current?.querySelectorAll<HTMLButtonElement>(
              '[role="menuitemradio"]',
            ) ?? []),
          ];
          const current = items.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          if (items.length === 0) return;
          event.preventDefault();
          items[
            (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) %
              items.length
          ]?.focus();
        }
      }}
    >
      <div
        className={styles['presentation-segments']}
        role="radiogroup"
        aria-label="Document view"
        style={
          {
            '--_presentation-count': props.availableModes.length,
            '--_presentation-index': Math.max(
              0,
              props.availableModes.indexOf(props.mode),
            ),
          } as CSSProperties
        }
        onKeyDown={(event) => {
          const index = props.availableModes.indexOf(props.mode);
          let next: number;
          switch (event.key) {
            case 'ArrowRight':
            case 'ArrowDown':
              next = (index + 1) % props.availableModes.length;
              break;
            case 'ArrowLeft':
            case 'ArrowUp':
              next =
                (index - 1 + props.availableModes.length) %
                props.availableModes.length;
              break;
            case 'Home':
              next = 0;
              break;
            case 'End':
              next = props.availableModes.length - 1;
              break;
            default:
              return;
          }
          event.preventDefault();
          event.stopPropagation();
          props.onSetMode(props.availableModes[next]!);
          event.currentTarget
            .querySelectorAll<HTMLButtonElement>('button')
            [next]?.focus();
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          dragStart.current = event.clientX;
          suppressClick.current = false;
        }}
        onPointerMove={(event) => {
          if (
            dragStart.current === null ||
            Math.abs(event.clientX - dragStart.current) < 6
          )
            return;
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerUp={(event) => {
          const start = dragStart.current;
          dragStart.current = null;
          if (start === null || Math.abs(event.clientX - start) < 6) return;
          suppressClick.current = true;
          const buttons = [
            ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
              'button',
            ),
          ];
          const target =
            buttons.find((button) => {
              const box = button.getBoundingClientRect();
              return event.clientX >= box.left && event.clientX <= box.right;
            }) ?? buttons[event.clientX < start ? 0 : buttons.length - 1];
          const index = buttons.indexOf(target!);
          if (index >= 0) props.onSetMode(props.availableModes[index]!);
          target?.focus();
        }}
        onPointerCancel={() => {
          dragStart.current = null;
        }}
        onClickCapture={(event) => {
          if (!suppressClick.current) return;
          suppressClick.current = false;
          if (event.detail > 0) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
      >
        <span className={styles['presentation-thumb']} aria-hidden="true" />
        {props.availableModes.map((mode) => (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={props.mode === mode}
            tabIndex={props.mode === mode ? 0 : -1}
            onClick={(event) => {
              props.onSetMode(mode);
              event.currentTarget.focus();
            }}
          >
            {modes[mode].label}
          </button>
        ))}
      </div>
      <button
        ref={triggerRef}
        type="button"
        aria-label={`Document view: ${modes[props.mode].label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {modes[props.mode].label} <Icon name="chevron-down" size={13} />
      </button>
      {open ? (
        <div
          className={styles['compact-presentation-menu']}
          role="menu"
          aria-label="Document view"
          ref={menuRef}
        >
          {props.availableModes.map((mode) => (
            <button
              key={mode}
              type="button"
              role="menuitemradio"
              aria-checked={props.mode === mode}
              onClick={() => {
                try {
                  props.onSetMode(mode);
                } finally {
                  setOpen(false);
                  triggerRef.current?.focus();
                }
              }}
            >
              <Icon name={modes[mode].icon} size={16} />
              {modes[mode].label}
              {props.mode === mode ? <Icon name="check" size={14} /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
