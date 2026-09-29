import { describe, expect, it, vi } from 'vitest';
import { validateManifest } from './manifest.js';
import { PermissionBroker } from './permissions.js';
import { createSdkFacades } from './facades.js';
import {
  validateCommunityToolbarManifest,
  communityToolbarToken,
} from './toolbar.js';

function manifest(permissions: string[] = ['workspace.commands.register']) {
  return validateManifest({
    manifestVersion: 1,
    id: 'example.diagram',
    version: '1.0.0',
    froglightSdk: '^0.1.0',
    permissions,
  });
}

describe('toolbar facade — sandbox-safe DTO, broker routing, effect ownership', () => {
  it('validates manifests without host authority', () => {
    expect(
      validateCommunityToolbarManifest({
        id: 'diamond',
        targetCategoryId: 'surface.shapes',
        label: 'Decision diamond',
        icon: 'shapes',
        commandId: 'insert-diamond',
        showInSqueeze: true,
      }),
    ).toEqual([]);
    expect(
      validateCommunityToolbarManifest({
        id: '../bad',
        targetCategoryId: 'surface.shapes',
        label: '',
        commandId: 'run',
      }),
    ).toHaveLength(2);
    expect(
      validateCommunityToolbarManifest({
        id: 'bad',
        targetCategoryId: 'surface.shapes',
        label: 'Bad',
        commandId: 'run',
        execute: () => true,
      }),
    ).toContain("field 'execute' must be data, not a function");
  });

  it('registers through the trusted host with permission + validation, effect-owned', () => {
    const broker = new PermissionBroker(manifest(), 'trusted');
    const registerToolbar = vi.fn(() => ({ dispose: vi.fn() }));
    const owned: Array<() => void> = [];
    const facades = createSdkFacades({
      broker,
      tier: 'trusted',
      services: { toolbar: { registerToolbar } as never },
      onRegistration: (dispose) => owned.push(dispose),
    });
    const handle = facades.toolbar.register({
      id: 'diamond',
      targetCategoryId: 'surface.shapes',
      label: 'Decision diamond',
      commandId: 'insert-diamond',
      showInSqueeze: true,
    });
    expect(registerToolbar).toHaveBeenCalledWith('example.diagram', {
      id: 'diamond',
      targetCategoryId: 'surface.shapes',
      label: 'Decision diamond',
      commandId: 'insert-diamond',
      showInSqueeze: true,
    });
    // Effect-owned: the host disposer is forwarded to the fiber scope.
    expect(owned).toHaveLength(1);
    expect(typeof handle.dispose).toBe('function');
    // Facade exposes data only: no registry, no handles.
    expect(
      (facades.toolbar as unknown as Record<string, unknown>)['composition'],
    ).toBeUndefined();
    expect(
      (facades.toolbar as unknown as Record<string, unknown>)['registry'],
    ).toBeUndefined();
  });

  it('denies without the commands permission and fails closed without a host', () => {
    const noPerm = new PermissionBroker(manifest([]), 'trusted');
    const facades = createSdkFacades({
      broker: noPerm,
      tier: 'trusted',
      services: { toolbar: { registerToolbar: () => ({ dispose: () => undefined }) } as never },
    });
    expect(() =>
      facades.toolbar.register({
        id: 'diamond',
        targetCategoryId: 'surface.shapes',
        label: 'Diamond',
        commandId: 'insert-diamond',
      }),
    ).toThrow(/PermissionDenied/);

    const broker = new PermissionBroker(manifest(), 'trusted');
    const noHost = createSdkFacades({ broker, tier: 'trusted', services: {} });
    expect(() =>
      noHost.toolbar.register({
        id: 'diamond',
        targetCategoryId: 'surface.shapes',
        label: 'Diamond',
        commandId: 'insert-diamond',
      }),
    ).toThrow(/toolbar service unavailable/);
  });

  it('exposes a stable capability token id', () => {
    expect(communityToolbarToken.id).toBe('froglight.community-toolbar');
  });
});
