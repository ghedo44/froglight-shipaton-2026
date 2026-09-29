import { describe, expect, it } from 'vitest';
import { InMemorySettingsService } from '@froglight/foundation';
import { adaptWorkspaceSettings } from './workspace-settings.js';

describe('workspace settings adapter', () => {
  it('adds default reads without keeping an independent value map', () => {
    const shared = new InMemorySettingsService();
    const ui = adaptWorkspaceSettings(shared);
    expect(ui.get('appearance.theme', 'system')).toBe('system');
    shared.set('appearance.theme', 'dark');
    expect(ui.get('appearance.theme', 'system')).toBe('dark');
  });

  it('keeps provider and UI updates live in both directions', () => {
    const shared = new InMemorySettingsService();
    const ui = adaptWorkspaceSettings(shared);
    const seen: Array<[string, unknown]> = [];
    const subscription = ui.onChange((key, value) => seen.push([key, value]));

    shared.set('toolbar.customization', '{"version":1}');
    ui.set('appearance.theme', 'dark');

    expect(ui.get('toolbar.customization', '')).toBe('{"version":1}');
    expect(shared.get('appearance.theme')).toBe('dark');
    expect(seen).toEqual([
      ['toolbar.customization', '{"version":1}'],
      ['appearance.theme', 'dark'],
    ]);
    subscription.dispose();
  });

  it('uses the Foundation key validation contract', () => {
    const ui = adaptWorkspaceSettings(new InMemorySettingsService());
    expect(() => ui.set('noDot', 1)).toThrow();
  });
});
