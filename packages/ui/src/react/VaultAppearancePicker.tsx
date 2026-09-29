import {
  VAULT_ICONS,
  VAULT_COLORS,
  type VaultAppearance,
} from '@froglight/foundation';
import { Icon } from './Icon.jsx';
import { VaultIcon } from './VaultIcon.jsx';
import styles from './VaultIdentity.module.css';

const iconLabels = [
  'Folder',
  'Apple',
  'Satellite',
  'Book',
  'Star',
  'Heart',
  'Globe',
  'Leaf',
  'Coffee',
  'Music',
  'Camera',
  'Briefcase',
  'Rocket',
  'Flask',
  'Palette',
  'Code',
  'Mountain',
  'Compass',
  'Light bulb',
  'Graduation cap',
];
export function VaultAppearancePicker({
  value,
  onChange,
  disabled = false,
}: {
  readonly value: VaultAppearance;
  readonly onChange: (value: VaultAppearance) => void;
  readonly disabled?: boolean;
}): React.ReactElement {
  return (
    <div className={styles['picker']}>
      <fieldset disabled={disabled}>
        <legend>Icon</legend>
        <div className={styles['icon-options']}>
          {VAULT_ICONS.map((icon, index) => (
            <button
              key={icon}
              type="button"
              title={iconLabels[index]}
              aria-label={iconLabels[index]}
              aria-pressed={value.icon === icon}
              onClick={() => onChange({ ...value, icon })}
            >
              <Icon name={icon} size={21} />
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset disabled={disabled}>
        <legend>Background color</legend>
        <div className={styles['color-options']}>
          {VAULT_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              aria-label={
                color === 'neutral'
                  ? 'Neutral'
                  : color[0]?.toUpperCase() + color.slice(1)
              }
              title={color}
              aria-pressed={value.color === color}
              onClick={() => onChange({ ...value, color })}
            >
              <VaultIcon appearance={{ icon: value.icon, color }} size={30} />
            </button>
          ))}
        </div>
      </fieldset>
    </div>
  );
}
