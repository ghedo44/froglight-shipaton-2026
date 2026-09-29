import { useCallback, useRef, useState } from 'react';
import type {
  CommunityPluginInfo,
  CommunityPluginManager,
} from '@froglight/plugin-platform';
import { uiConfirm } from '../dialogs.js';
import { Button, IconButton } from './Button.jsx';
import { Icon } from './Icon.jsx';
import settingsStyles from './SettingsView.module.css';
import styles from './CommunityPluginsView.module.css';

const PLUGINS_FOLDER_HINT = '.froglight/plugins';

export interface CommunityPluginsViewProps {
  readonly manager: CommunityPluginManager;
  readonly onChanged?: () => void;
}

/**
 * Community plugins — settings section.
 *
 * Declarative React over `CommunityPluginManager` with identical
 * user-visible behavior to the previous imperative
 * `renderCommunityPluginsSection` builder: same DOM structure, classes,
 * datasets, ordering, dialogs, and manager outcomes. The manager stays the
 * framework-free source of truth; this component owns only presentation
 * state (feedback message plus a revision counter that re-reads the
 * manager after every async mutation).
 *
 * Styles: colocated CommunityPluginsView.module.css (community chrome
 * plus the Toggle switch) with shared settings row primitives from
 * SettingsView.module.css.
 */
export function CommunityPluginsView(
  props: CommunityPluginsViewProps,
): React.ReactElement {
  const { manager, onChanged } = props;
  const [, setRevision] = useState(0);
  const [feedback, setFeedback] = useState<{ message: string; ok: boolean }>({
    message: '',
    ok: true,
  });
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const bump = useCallback((): void => {
    setRevision((current) => current + 1);
  }, []);

  const clearFeedbackAndBump = useCallback((): void => {
    setFeedback({ message: '', ok: true });
    bump();
  }, [bump]);

  const onInstallClick = useCallback((): void => {
    fileInputRef.current?.click();
  }, []);

  const onReload = useCallback((): void => {
    void manager.sync().then(() => {
      clearFeedbackAndBump();
      onChanged?.();
    });
  }, [clearFeedbackAndBump, manager, onChanged]);

  const onInstallFilesChange = useCallback((): void => {
    const input = fileInputRef.current;
    if (input === null) return;
    const files = input.files;
    void handleInstallFiles(files, manager).then((result) => {
      input.value = '';
      bump();
      setFeedback({ message: result.message, ok: result.ok });
      onChanged?.();
    });
  }, [bump, manager, onChanged]);

  const onSafeModeChange = useCallback(
    (next: boolean): void => {
      void manager.setSafeMode(next).then(() => {
        clearFeedbackAndBump();
      });
    },
    [clearFeedbackAndBump, manager],
  );

  const onTogglePlugin = useCallback(
    (id: string, next: boolean): void => {
      const action = next ? manager.enable(id) : manager.disable(id);
      void action
        .catch((error: unknown) => {
          // The re-render surfaces the failure via the state badge; the warn
          // keeps a diagnosis trail.
          console.warn(`[community-plugins] ${id}:`, error);
        })
        .then(() => {
          clearFeedbackAndBump();
          onChanged?.();
        });
    },
    [clearFeedbackAndBump, manager, onChanged],
  );

  const onRemovePlugin = useCallback(
    (id: string): void => {
      void uiConfirm(
        'Remove plugin',
        `${id} will be removed and its folder deleted from the vault.`,
      ).then((confirmed) => {
        if (!confirmed) return;
        void manager.remove(id).then(() => {
          clearFeedbackAndBump();
          onChanged?.();
        });
      });
    },
    [clearFeedbackAndBump, manager, onChanged],
  );

  const infos = [...manager.list()].sort((a, b) => a.id.localeCompare(b.id));

  return (
    <div className={settingsStyles['settings-section']}>
      <h2>Community plugins</h2>
      <p className={settingsStyles['settings-row-description']}>
        {'Plugins live inside your vault under ' +
          PLUGINS_FOLDER_HINT +
          '/<plugin-id> as plain manifest.json and main.js files.'}
      </p>
      <div className={`${styles['community-banner']} ${styles.warning}`}>
        <span className={styles['community-banner-icon']}>
          <Icon name="shield" size={16} />
        </span>
        <span>
          {'Community plugins are third-party code that runs inside Froglight with the access they declare. ' +
            'They are trusted, not sandboxed — only enable plugins you trust.'}
        </span>
      </div>
      <div className={settingsStyles['settings-row']}>
        <div className={settingsStyles['settings-row-text']}>
          <label className={settingsStyles['settings-row-label']}>
            Safe mode
          </label>
          <p className={settingsStyles['settings-row-description']}>
            Restrict Froglight to first-party features by disabling every
            community plugin.
          </p>
        </div>
        <Toggle
          label="Safe mode"
          on={manager.safeMode}
          onChange={onSafeModeChange}
        />
      </div>
      <div className={styles['community-toolbar']}>
        <Button type="button" variant="secondary" onClick={onInstallClick}>
          <Icon name="plus" size={14} />
          Install from files
        </Button>
        <Button type="button" variant="secondary" onClick={onReload}>
          <Icon name="refresh" size={14} />
          Reload
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".json,.js,text/javascript,application/json"
          className="visually-hidden"
          onChange={onInstallFilesChange}
        />
      </div>
      <div
        className={`${styles['community-feedback']}${feedback.ok ? '' : ` ${styles.error}`}`}
        data-empty={feedback.message.length === 0 ? 'true' : 'false'}
      >
        {feedback.message}
      </div>
      <div className={styles['community-list']}>
        {infos.length === 0 ? (
          <div className={styles['community-empty']}>
            No community plugins installed. Copy a plugin folder into the vault
            or use “Install from files”.
          </div>
        ) : (
          infos.map((info) => (
            <PluginRow
              key={info.id}
              info={info}
              onToggle={onTogglePlugin}
              onRemove={onRemovePlugin}
            />
          ))
        )}
      </div>
    </div>
  );
}

function PluginRow(props: {
  readonly info: CommunityPluginInfo;
  readonly onToggle: (id: string, next: boolean) => void;
  readonly onRemove: (id: string) => void;
}): React.ReactElement {
  const { info, onToggle, onRemove } = props;
  const enabled = info.state === 'active' || info.state === 'failed';
  return (
    <div className={styles['community-plugin-row']}>
      <div className={styles['community-plugin-main']}>
        <div className={styles['community-plugin-title']}>
          <strong>
            {info.manifest
              ? `${info.manifest.id} ${info.manifest.version}`
              : info.id}
          </strong>
          <StateBadge state={info.state} />
        </div>
        {info.manifest && info.manifest.permissions.length > 0 ? (
          <div className={styles['community-perm-chips']}>
            {info.manifest.permissions.map((permission) => (
              <code key={permission} className={styles['community-perm-chip']}>
                {permission}
              </code>
            ))}
          </div>
        ) : null}
        {info.error ? (
          <p className={styles['community-plugin-error']}>{info.error}</p>
        ) : null}
      </div>
      <div className={styles['community-plugin-controls']}>
        <Toggle
          label={`Enable ${info.id}`}
          on={enabled}
          onChange={(next) => onToggle(info.id, next)}
        />
        <IconButton
          icon="trash"
          size={15}
          label={`Remove ${info.id}`}
          title={`Remove ${info.id}`}
          className="community-remove"
          onClick={() => onRemove(info.id)}
        />
      </div>
    </div>
  );
}

const STATE_BADGE_LABELS: Record<CommunityPluginInfo['state'], string> = {
  active: 'Enabled',
  disabled: 'Disabled',
  failed: 'Failed',
  'blocked-safe-mode': 'Safe mode',
  'blocked-crash-loop': 'Blocked (crash loop)',
};

function StateBadge(props: {
  readonly state: CommunityPluginInfo['state'];
}): React.ReactElement {
  const { state } = props;
  return (
    <span
      className={`${styles['community-state-badge']} ${styles[`state-${state}`]}`}
    >
      {STATE_BADGE_LABELS[state]}
    </span>
  );
}

function Toggle(props: {
  readonly label: string;
  readonly on: boolean;
  readonly onChange: (next: boolean) => void;
}): React.ReactElement {
  const { on, onChange } = props;
  return (
    <button
      type="button"
      className={`${styles.toggle}${on ? ` ${styles.on}` : ''}`}
      role="switch"
      aria-label={props.label}
      aria-checked={on}
      onClick={() => onChange(!on)}
    >
      <span className={styles['toggle-knob']} />
    </button>
  );
}

interface InstallResult {
  readonly ok: boolean;
  readonly message: string;
}

async function handleInstallFiles(
  files: FileList | null,
  manager: CommunityPluginManager,
): Promise<InstallResult> {
  if (!files || files.length === 0) {
    return { ok: false, message: 'No files selected.' };
  }
  let manifestJson: unknown = null;
  let code: string | null = null;
  for (const file of Array.from(files)) {
    const lower = file.name.toLowerCase();
    if (lower.endsWith('.json') && manifestJson === null) {
      try {
        manifestJson = JSON.parse(await file.text());
      } catch (error) {
        return {
          ok: false,
          message: `${file.name} is not valid JSON: ${String(error)}`,
        };
      }
    } else if (lower.endsWith('.js') && code === null) {
      code = await file.text();
    }
  }
  if (manifestJson === null || typeof manifestJson !== 'object') {
    return { ok: false, message: 'Select the plugin’s manifest.json.' };
  }
  if (code === null) {
    return { ok: false, message: 'Select the plugin’s main.js.' };
  }
  try {
    const manifest = await manager.install({ manifestJson, code });
    return {
      ok: true,
      message: `Installed ${manifest.id} ${manifest.version}. Enable it below.`,
    };
  } catch (error) {
    return {
      ok: false,
      message: `Install failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
