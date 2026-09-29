import { createElement } from 'react';
import { definePlugin } from '@froglight/runtime';
import { commandsToken } from '@froglight/foundation';
import type { AccountService } from '@froglight/foundation/account';
import type { AccountIdentityService } from '@froglight/foundation';
import type { VaultSyncService } from '@froglight/foundation';
import type { VaultService } from '@froglight/foundation';
import type { PurchaseService } from '@froglight/foundation/purchases';
import type { CommunityPluginManager } from '@froglight/plugin-platform';
import {
  CORE_SETTINGS_GROUP,
  settingsRegistryToken,
  type SettingsSectionDef,
} from './settings-registry.js';
import {
  workspaceSettingsToken,
  type WorkspaceSettingsService,
} from './workspace-settings.js';
import { workspaceEvents } from './ui-events.js';
import {
  AboutSettingsView,
  AppearanceSettingsView,
  CommunityPluginsSettingsView,
  EditorSettingsView,
  ProSettingsView,
  VaultBackupSettingsView,
} from './react/index.js';
import { AccountSettingsView } from './react/AccountSettingsView.jsx';
import { VaultSyncSettingsView } from './react/VaultSyncSettingsView.jsx';
import { bindAccentToDocument } from './accents.js';
import { applyMotionPreference, MOTION_KEY } from './motion.js';

export type ThemeMode = 'system' | 'light' | 'dark';
export type DefaultViewMode = 'edit' | 'reading' | 'split';

export const THEME_KEY = 'appearance.theme';
export const FONT_SIZE_KEY = 'editor.fontSize';
export const DEFAULT_VIEW_KEY = 'workspace.defaultView';

/** Apply a theme mode to the document root; returns a reset disposer. */
export function applyThemeMode(mode: ThemeMode): { dispose(): void } {
  if (typeof document === 'undefined') return { dispose: () => undefined };
  const root = document.documentElement;
  if (mode === 'system') {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = mode;
  }
  return {
    dispose: () => {
      if (root.dataset.theme === mode) delete root.dataset.theme;
    },
  };
}

/** Apply the editor font size CSS variable; returns a reset disposer. */
export function applyEditorFontSize(size: number): { dispose(): void } {
  if (typeof document === 'undefined') return { dispose: () => undefined };
  const root = document.documentElement;
  const clamped = Math.min(24, Math.max(11, Math.round(size)));
  // Canonical token first, legacy alias second: migrated components consume
  // `--fl-editor-font-size` while remaining shell styles read the alias.
  // Both are removed on dispose.
  root.style.setProperty('--fl-editor-font-size', `${clamped}px`);
  root.style.setProperty('--editor-font-size', `${clamped}px`);
  return {
    dispose: () => {
      root.style.removeProperty('--fl-editor-font-size');
      root.style.removeProperty('--editor-font-size');
    },
  };
}

/** Keep document-level appearance effects in sync with settings changes. */
export function bindAppearanceToDocument(settings: WorkspaceSettingsService): {
  dispose(): void;
} {
  let themeDisposer = applyThemeMode(settings.get<ThemeMode>(THEME_KEY, 'system'));
  let fontDisposer = applyEditorFontSize(settings.get(FONT_SIZE_KEY, 14));
  let motionDisposer = applyMotionPreference(settings.get(MOTION_KEY, 'system'));
  const subscription = settings.onChange((key, value) => {
    if (key === THEME_KEY) {
      themeDisposer.dispose();
      themeDisposer = applyThemeMode((value as ThemeMode) ?? 'system');
    } else if (key === FONT_SIZE_KEY) {
      fontDisposer.dispose();
      fontDisposer = applyEditorFontSize(typeof value === 'number' ? value : 14);
    } else if (key === MOTION_KEY) {
      motionDisposer.dispose();
      motionDisposer = applyMotionPreference(value);
    }
  });
  // Release every owned effect (theme + font + motion + subscription), mirroring
  // `bindAccentToDocument`. Every underlying disposer is idempotent, so
  // double-dispose is safe.
  return {
    dispose: () => {
      subscription.dispose();
      themeDisposer.dispose();
      fontDisposer.dispose();
      motionDisposer.dispose();
    },
  };
}

export interface SettingsViewOptions {
  /**
   * Resolved at render time so the section always reflects the current
   * vault's catalog; return `null` when community plugins are unavailable.
   */
  readonly community?: () => CommunityPluginManager | null;
  /**
   * Shell resolver for the host-owned purchase service. Read at render
   * time through the purchases probe so provider appearance/withdrawal
   * follows runtime lifecycle; `null` renders the honest unavailable
   * state (web hosts today).
   */
  readonly purchases?: () => PurchaseService | null;
  /**
   * Shell resolver for the host-owned account service. Null renders the
   * local-only account state.
   */
  readonly account?: () => AccountService | null;
  /**
   * Shell resolver for the account ↔ purchase coordinator. Null keeps
   * anonymous purchasing and direct sign-out; the hosts provide it
   * whenever the coordinator fiber is active.
   */
  readonly identity?: () => AccountIdentityService | null;
  /**
   * Shell resolver for the host-owned sync service. Null renders sync as
   * unavailable.
   */
  readonly vaultSync?: () => VaultSyncService | null;
  /**
   * The vault the host currently shows as active, if any. Read at render
   * time; the shell updates it as the launcher selection changes.
   */
  readonly currentVault?: () => { id: string; name: string } | null;
  /** Live resolver for the currently mounted local vault service. */
  readonly vault?: () => VaultService | null;
}

/**
 * First-party settings sections, registered through the same registry a
 * third-party trusted plugin would use. Also owns the appearance side
 * effects and the "Open settings" command.
 */
export function createSettingsViewPlugin(options: SettingsViewOptions = {}) {
  return definePlugin({
    id: 'froglight.settings',
    requirements: {
      requires: [workspaceSettingsToken, settingsRegistryToken],
      optionallyRequires: [commandsToken],
    },
    activate: (ctx) => {
      const settings = ctx.require(workspaceSettingsToken);
      const sections = ctx.require(settingsRegistryToken);
      // Appearance side effects live for as long as this fiber does.
      ctx.effect(() => {
        const appearance = bindAppearanceToDocument(settings);
        return () => appearance.dispose();
      });
      // Pro accent side effects ride the same lifetime: the stored accent
      // applies whenever this fiber is active. Accents are free for every
      // user; no entitlement check here.
      ctx.effect(() => {
        const accents = bindAccentToDocument(settings);
        return () => accents.dispose();
      });
      for (const section of coreSections(settings, options)) {
        ctx.effect(() => sections.register(section).dispose);
      }
      const commands = ctx.try(commandsToken);
      if (commands !== undefined) {
        ctx.effect(() =>
          commands
            .register({
              id: 'froglight.settings.open',
              title: 'Open settings',
              execute: () => {
                document.dispatchEvent(
                  new CustomEvent(workspaceEvents.openSettings),
                );
              },
            })
            .dispose,
        );
      }
    },
  });
}

function coreSections(
  settings: WorkspaceSettingsService,
  options: SettingsViewOptions,
): readonly SettingsSectionDef[] {
  return [
    {
      id: 'froglight.appearance',
      name: 'Appearance',
      group: CORE_SETTINGS_GROUP,
      icon: 'palette',
      order: 0,
      keywords: ['theme', 'light', 'dark', 'font', 'appearance', 'base theme', 'accent', 'app accent', 'animations', 'motion', 'reduced motion'],
      component: function AppearanceSettingsSection() {
        return createElement(AppearanceSettingsView, { settings });
      },
    },
    {
      id: 'froglight.editor',
      name: 'Editor',
      group: CORE_SETTINGS_GROUP,
      icon: 'edit',
      order: 1,
      keywords: ['editor', 'font size', 'default view', 'reading', 'editing', 'split'],
      component: function EditorSettingsSection() {
        return createElement(EditorSettingsView, { settings });
      },
    },
    {
      id: 'froglight.community-plugins',
      name: 'Community plugins',
      group: CORE_SETTINGS_GROUP,
      icon: 'shield',
      order: 2,
      keywords: ['plugins', 'community', 'install', 'enable', 'disable', 'safe mode', 'trust'],
      component: function CommunityPluginsSettingsSection() {
        return createElement(CommunityPluginsSettingsView, {
          resolveCommunity: options.community,
        });
      },
    },
    {
      id: 'froglight.account',
      name: 'Account',
      group: CORE_SETTINGS_GROUP,
      icon: 'lock',
      order: 3,
      keywords: ['account', 'sign in', 'sign out', 'email', 'password', 'login'],
      component: function AccountSettingsSection() {
        return createElement(AccountSettingsView, {
          resolveAccount: options.account ?? (() => null),
          resolveIdentity: options.identity ?? (() => null),
        });
      },
    },
    {
      id: 'froglight.pro',
      name: 'Froglight Pro',
      group: CORE_SETTINGS_GROUP,
      icon: 'spark',
      order: 4,
      keywords: [
        'pro',
        'subscription',
        'purchase',
        'billing',
        'restore',
        'upgrade',
      ],
      component: function ProSettingsSection() {
        return createElement(ProSettingsView, {
          settings,
          resolvePurchases: options.purchases ?? (() => null),
          resolveAccount: options.account ?? (() => null),
          resolveIdentity: options.identity ?? (() => null),
        });
      },
    },
    {
      id: 'froglight.vault-sync',
      name: 'Vault Sync',
      group: CORE_SETTINGS_GROUP,
      icon: 'refresh',
      order: 5,
      keywords: [
        'sync',
        'cloud',
        'backup',
        'devices',
        'pro',
        'offline',
        'conflict',
        'enable sync',
      ],
      component: function VaultSyncSettingsSection() {
        return createElement(VaultSyncSettingsView, {
          resolveAccount: options.account ?? (() => null),
          resolvePurchases: options.purchases ?? (() => null),
          resolveSync: options.vaultSync ?? (() => null),
          resolveIdentity: options.identity ?? (() => null),
          resolveCurrentVault: options.currentVault ?? (() => null),
        });
      },
    },
    {
      id: 'froglight.backups',
      name: 'Backups',
      group: CORE_SETTINGS_GROUP,
      icon: 'file-archive',
      order: 6,
      keywords: ['backup', 'export', 'restore', 'archive', 'download', 'vault'],
      component: function VaultBackupSettingsSection() {
        return createElement(VaultBackupSettingsView, {
          resolveVault: options.vault ?? (() => null),
          resolveCurrentVault: options.currentVault ?? (() => null),
        });
      },
    },
    {
      id: 'froglight.about',
      name: 'About',
      group: CORE_SETTINGS_GROUP,
      icon: 'info',
      order: 9,
      keywords: ['about', 'version', 'froglight', 'license'],
      component: AboutSettingsView,
    },
  ];
}
