/**
 * UI-shaped view of the Foundation workspace settings service.
 *
 * Foundation owns the single app-wide settings service. This adapter adds
 * default-value reads for UI consumers without creating another cache or
 * persistence path.
 */

import {
  settingsToken,
  type SettingsService,
  type SettingsValue,
} from '@froglight/foundation';
import { createServiceToken, definePlugin } from '@froglight/runtime';

export type WorkspaceSettingsValue = SettingsValue;

export interface WorkspaceSettingsService {
  /** Get a value; returns `defaultValue` when unset. */
  get<T extends WorkspaceSettingsValue>(key: string, defaultValue: T): T;
  /** Set a value in the shared workspace settings service. */
  set(key: string, value: WorkspaceSettingsValue): void;
  /** Subscribe to shared changes from UI or editor/provider consumers. */
  onChange(
    listener: (key: string, value: WorkspaceSettingsValue | undefined) => void,
  ): { dispose(): void };
}

export function adaptWorkspaceSettings(
  settings: SettingsService,
): WorkspaceSettingsService {
  return {
    get<T extends WorkspaceSettingsValue>(key: string, defaultValue: T): T {
      const value = settings.get(key);
      return value === undefined ? defaultValue : (value as T);
    },
    set(key: string, value: WorkspaceSettingsValue): void {
      settings.set(key, value);
    },
    onChange(listener) {
      return settings.onChange(listener);
    },
  };
}

/** Runtime binding follows the app-owned settings capability lifetime. */
export const workspaceSettingsPlugin = definePlugin({
  id: 'froglight.workspace-settings',
  requirements: { requires: [settingsToken] },
  activate: (ctx) => {
    ctx.provide(
      workspaceSettingsToken,
      adaptWorkspaceSettings(ctx.require(settingsToken)),
    );
  },
});

export const workspaceSettingsToken =
  createServiceToken<WorkspaceSettingsService>('froglight.workspace-settings');
