/**
 * Accent picker.
 *
 * The picker only writes the settings key — application (`bindAccentToDocument`
 * in the settings plugin) owns applying it, mirroring the base theme.
 */

import { ACCENTS, ACCENT_KEY } from '../accents.js';
import styles from './Accents.module.css';

export interface AccentSettingsLike {
  get(key: string, defaultValue: string): string;
  set(key: string, value: string): void;
}

export interface AccentsProps {
  readonly settings: AccentSettingsLike;
  readonly currentId: string;
}

export function Accents(props: AccentsProps): React.ReactElement {
  const { settings, currentId } = props;
  return (
    <div data-fl-component="accent-picker">
      <div
        className={styles['accent-grid']}
        role="radiogroup"
        aria-label="App accent"
      >
        {ACCENTS.map((accent) => {
          const selected = accent.id === currentId;
          return (
            <button
              key={accent.id}
              type="button"
              role="radio"
              aria-checked={selected}
              title={accent.name}
              data-fl-component="accent-option"
              data-accent-id={accent.id}
              data-selected={String(selected)}
              className={styles['accent-option']}
              onClick={() => {
                settings.set(ACCENT_KEY, accent.id);
              }}
            >
              <span
                className={styles['accent-swatch']}
                style={{ backgroundColor: accent.swatch }}
                aria-hidden="true"
              />
              <span className={styles['accent-name']}>{accent.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
