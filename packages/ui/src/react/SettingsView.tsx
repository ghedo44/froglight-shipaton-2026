import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { SDK_VERSION } from '@froglight/sdk';
import type { CommunityPluginManager } from '@froglight/plugin-platform';
import type { WorkspaceSettingsService } from '../workspace-settings.js';
import {
  DEFAULT_VIEW_KEY,
  FONT_SIZE_KEY,
  THEME_KEY,
  type DefaultViewMode,
  type ThemeMode,
} from '../settings-view.js';
import { DEFAULT_ACCENT_ID, ACCENT_KEY } from '../accents.js';
import { MOTION_KEY, type MotionPreference } from '../motion.js';
import { Icon } from './Icon.jsx';
import { Slider } from './Slider.jsx';
import styles from './SettingsView.module.css';
import { CommunityPluginsView } from './CommunityPluginsView.jsx';
import { Accents } from './Accents.jsx';

interface SelectOption {
  readonly value: string;
  readonly label: string;
}

/**
 * First-party settings sections — declarative React over
 * `WorkspaceSettingsService`.
 *
 * Converted from the imperative builders in `../settings-view.ts` with
 * identical user-visible behavior: same DOM structure, classes, datasets,
 * labels, ordering, handlers, and outcomes. The service stays the
 * framework-free source of truth; these components own no persistence
 * logic. Sections register as components; the shell mounts them directly.
 */
function SettingsSectionTitle(props: {
  readonly title: string;
}): React.ReactElement {
  return <h2 className={styles['settings-section-title']}>{props.title}</h2>;
}

function SettingsRow(props: {
  readonly label: string;
  readonly description?: string;
  readonly control: ReactNode;
}): React.ReactElement {
  return (
    <div className={styles['settings-row']}>
      <div className={styles['settings-row-text']}>
        <label className={styles['settings-row-label']}>{props.label}</label>
        {props.description !== undefined ? (
          <p className={styles['settings-row-description']}>
            {props.description}
          </p>
        ) : null}
      </div>
      {props.control}
    </div>
  );
}

/** A themed select: native popup, token-drawn chevron. */
function SettingsSelect(props: {
  readonly label: string;
  readonly options: readonly SelectOption[];
  readonly current: string;
  readonly value?: string;
  readonly settingKey: string;
  readonly onPick: (value: string) => void;
}): React.ReactElement {
  return (
    <div className={styles['settings-select']}>
      <select
        aria-label={props.label}
        className={styles['settings-control']}
        data-setting-key={props.settingKey}
        defaultValue={props.value === undefined ? props.current : undefined}
        value={props.value}
        onChange={(event) => props.onPick(event.currentTarget.value)}
      >
        {props.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <span className={styles['settings-select-chevron']} aria-hidden="true">
        <Icon name="chevron-down" size={12} />
      </span>
    </div>
  );
}

export interface AppearanceSettingsViewProps {
  readonly settings: WorkspaceSettingsService;
}

export function AppearanceSettingsView(
  props: AppearanceSettingsViewProps,
): React.ReactElement {
  const { settings } = props;
  // Mirror ProSettingsView: subscribe so external `settings.set` calls
  // re-render the picker without a remount.
  const [currentAccent, setCurrentAccent] = useState<string>(() =>
    settings.get(ACCENT_KEY, DEFAULT_ACCENT_ID),
  );
  const [currentMotion, setCurrentMotion] = useState<MotionPreference>(() =>
    settings.get(MOTION_KEY, 'system'),
  );
  useEffect(
    () =>
      settings.onChange((key) => {
        if (key === ACCENT_KEY) {
          setCurrentAccent(settings.get(ACCENT_KEY, DEFAULT_ACCENT_ID));
        }
        if (key === MOTION_KEY) {
          setCurrentMotion(settings.get(MOTION_KEY, 'system'));
        }
      }).dispose,
    [settings],
  );
  return (
    <>
      <SettingsSectionTitle title="Appearance" />
      <SettingsRow
        label="Base theme"
        description="Match your system, or force light/dark."
        control={
          <SettingsSelect
            label="Base theme"
            options={[
              { value: 'system', label: 'System' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
            current={settings.get<ThemeMode>(THEME_KEY, 'system')}
            settingKey="appearance.theme"
            onPick={(value) => settings.set(THEME_KEY, value)}
          />
        }
      />
      <SettingsRow
        label="Animations"
        description="Follow your system, or turn app animations on or off."
        control={
          <SettingsSelect
            label="Animations"
            options={[
              { value: 'system', label: 'System' },
              { value: 'on', label: 'On' },
              { value: 'off', label: 'Off' },
            ]}
            current={currentMotion}
            value={currentMotion}
            settingKey={MOTION_KEY}
            onPick={(value) => settings.set(MOTION_KEY, value)}
          />
        }
      />
      <SettingsRow
        label="Editor font size"
        control={
          <Slider
            min={11}
            max={24}
            step={1}
            defaultValue={settings.get(FONT_SIZE_KEY, 14)}
            className={styles['settings-slider']}
            data-setting-key="editor.fontSize"
            aria-label="Editor font size"
            onInput={(event) => {
              settings.set(FONT_SIZE_KEY, Number(event.currentTarget.value));
            }}
          />
        }
      />
      <SettingsRow
        label="App accent"
        description="Pick the accent color used across the app."
        control={<Accents settings={settings} currentId={currentAccent} />}
      />
    </>
  );
}

export interface EditorSettingsViewProps {
  readonly settings: WorkspaceSettingsService;
}

export function EditorSettingsView(
  props: EditorSettingsViewProps,
): React.ReactElement {
  const { settings } = props;
  return (
    <>
      <SettingsSectionTitle title="Editor" />
      <SettingsRow
        label="Default view mode"
        description="How notes open: editing, reading, or split where supported."
        control={
          <SettingsSelect
            label="Default view mode"
            options={[
              { value: 'edit', label: 'Editing' },
              { value: 'reading', label: 'Reading' },
              { value: 'split', label: 'Split' },
            ]}
            current={settings.get<DefaultViewMode>(DEFAULT_VIEW_KEY, 'edit')}
            settingKey="workspace.defaultView"
            onPick={(value) => settings.set(DEFAULT_VIEW_KEY, value)}
          />
        }
      />
    </>
  );
}

export interface CommunityPluginsSettingsViewProps {
  /**
   * Resolved at render time so the section always reflects the current
   * vault's catalog; return `null` when community plugins are unavailable.
   */
  readonly resolveCommunity?: () => CommunityPluginManager | null;
}

export function CommunityPluginsSettingsView(
  props: CommunityPluginsSettingsViewProps,
): React.ReactElement {
  const manager = props.resolveCommunity?.() ?? undefined;
  if (manager === undefined) {
    return (
      <>
        <SettingsSectionTitle title="Community plugins" />
        <p className={styles['settings-about']}>
          Open a vault to manage community plugins.
        </p>
      </>
    );
  }
  return <CommunityPluginsHost manager={manager} />;
}

/**
 * Host the community plugins manager UI directly — no nested bridge root.
 * The `settings-section` class stays on this host so class-scoped styling
 * still applies.
 */
function CommunityPluginsHost(props: {
  readonly manager: CommunityPluginManager;
}): React.ReactElement {
  return (
    <div className={styles['settings-section']}>
      <CommunityPluginsView manager={props.manager} />
    </div>
  );
}

export function AboutSettingsView(): React.ReactElement {
  return (
    <>
      <SettingsSectionTitle title="About" />
      <p
        className={styles['settings-about']}
      >{`Froglight · SDK ${SDK_VERSION}`}</p>
      <p className={styles['settings-about']}>
        Froglight keeps your notes as plain Markdown files inside your vault.
        Search indexes, link graphs, and settings are derived data and can be
        rebuilt from those files at any time.
      </p>
    </>
  );
}
