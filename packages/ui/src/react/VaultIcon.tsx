import {
  DEFAULT_VAULT_APPEARANCE,
  type VaultAppearance,
} from '@froglight/foundation';
import { Icon } from './Icon.jsx';
import styles from './VaultIdentity.module.css';

export function VaultIcon({
  appearance = DEFAULT_VAULT_APPEARANCE,
  size = 34,
}: {
  readonly appearance?: VaultAppearance;
  readonly size?: number;
}): React.ReactElement {
  return (
    <span
      className={styles['vault-icon']}
      data-color={appearance.color}
      style={{ width: size, height: size }}
    >
      <Icon name={appearance.icon} size={size <= 28 ? 16 : 20} />
    </span>
  );
}
