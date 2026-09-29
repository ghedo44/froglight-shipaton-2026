import { useState, type ComponentProps } from 'react';
import styles from './Slider.module.css';

type NativeInputProps = Omit<
  ComponentProps<'input'>,
  'type' | 'min' | 'max' | 'step' | 'value' | 'defaultValue' | 'className'
>;

export interface SliderProps extends NativeInputProps {
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  readonly value?: number;
  readonly defaultValue?: number;
  /** Layout class on the outer field; the track and thumb stay shared. */
  readonly className?: string;
  /** Keep a 44px pointer target on Pencil and touch surfaces. */
  readonly touch?: boolean;
}

/** One range track and thumb for settings, document tools, and Pencil UI. */
export function Slider(props: SliderProps): React.ReactElement {
  const {
    min,
    max,
    step,
    value,
    defaultValue,
    className,
    touch = false,
    onInput,
    onChange,
    ...inputProps
  } = props;
  const [draft, setDraft] = useState(defaultValue ?? min);
  const current = value ?? draft;
  const progress =
    max > min
      ? Math.min(100, Math.max(0, ((current - min) / (max - min)) * 100))
      : 0;

  return (
    <span
      className={[
        styles['slider'],
        touch ? styles['touch'] : '',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <span className={styles['track']} data-range-track="" aria-hidden="true">
        <span
          className={styles['fill']}
          data-range-fill=""
          style={{ width: `${progress}%` }}
        />
      </span>
      <input
        {...inputProps}
        className={styles['input']}
        type="range"
        min={min}
        max={max}
        step={step}
        value={current}
        onInput={(event) => {
          setDraft(Number(event.currentTarget.value));
          onInput?.(event);
        }}
        onChange={(event) => {
          setDraft(Number(event.currentTarget.value));
          onChange?.(event);
        }}
      />
    </span>
  );
}
