/**
 * Phone bottom navigation: search, new note, graph, and settings.
 */

import { Icon } from '../../Icon.jsx';
import { useAboveKeyboard } from '../../useAboveKeyboard.js';
import styles from '../../WorkspaceView.module.css';

const bottomItems = [
  { id: 'search', icon: 'search', title: 'Search' },
  { id: 'new-note', icon: 'plus', title: 'New note' },
  { id: 'graph', icon: 'graph', title: 'Graph' },
  { id: 'settings', icon: 'settings', title: 'Settings' },
] as const;

export type BottomNavId = (typeof bottomItems)[number]['id'];

export function BottomNav(props: {
  readonly searchActive: boolean;
  readonly graphActive: boolean;
  readonly settingsActive: boolean;
  readonly onSelect: (id: BottomNavId) => void;
}): React.ReactElement {
  const { searchActive, graphActive, settingsActive, onSelect } = props;
  // The bottom nav rides above the overlay keyboard.
  const aboveKeyboard = useAboveKeyboard<HTMLElement>();
  return (
    <nav
      className={styles['fl-bottomnav']}
      aria-label="Primary"
      ref={aboveKeyboard}
    >
      {bottomItems.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`${styles['bottomnav-button']}${
            item.id === 'settings'
              ? settingsActive
                ? ` ${styles.active}`
                : ''
              : item.id !== 'new-note' && item.id === 'graph'
                ? graphActive
                  ? ` ${styles.active}`
                  : ''
                : item.id === 'search'
                  ? searchActive
                    ? ` ${styles.active}`
                    : ''
                  : ''
          }`}
          data-activity={item.id}
          aria-label={item.title}
          onClick={() => onSelect(item.id)}
        >
          <Icon name={item.icon} size={20} />
          <span>{item.title}</span>
        </button>
      ))}
    </nav>
  );
}
