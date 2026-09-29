import { describe, it, expect } from 'vitest';
import { validateManifest } from './manifest.js';
import { PermissionBroker, validateTierPermissions } from './permissions.js';

const baseManifest = {
  manifestVersion: 1 as const,
  id: 'froglight.example',
  version: '1.0.0',
  froglightSdk: '^0.1.0',
  permissions: ['vault.read', 'workspace.commands.register', 'workspace.settings.read'] as string[],
};

describe('PermissionBroker — coarse deny-by-default', () => {
  it('grants declared permissions for trusted tier', () => {
    const m = validateManifest(baseManifest);
    const broker = new PermissionBroker(m, 'trusted');
    expect(broker.has('vault.read')).toBe(true);
    expect(broker.has('workspace.commands.register')).toBe(true);
  });

  it('denies undeclared permission even when service exists (availability!= authority)', () => {
    const m = validateManifest(baseManifest);
    const broker = new PermissionBroker(m, 'trusted');
    expect(broker.has('vault.write')).toBe(false);
    expect(() => broker.require('vault.write')).toThrow(/PermissionDenied/);
  });

  it('sandboxed tier cannot use trusted-only permissions even if declared (defense in depth)', () => {
    // Create a manifest that declares trusted-only — validation would normally reject for sandboxed at load time,
    // but broker also enforces at call time.
    const m = validateManifest({ ...baseManifest, permissions: ['ui.views.register', 'vault.read'] });
    const broker = new PermissionBroker(m, 'sandboxed');
    expect(() => broker.require('ui.views.register')).toThrow(/PermissionDenied/);
    expect(() => broker.require('editor.provider')).toThrow(/PermissionDenied/);
  });

  it('scoped permission syntax is validated but not enforced — exact match only', () => {
    const m = validateManifest({ ...baseManifest, permissions: ['vault.read:/notes/**'] });
    const broker = new PermissionBroker(m, 'trusted');
    expect(broker.has('vault.read:/notes/**')).toBe(true);
    // Exact match only: scoped grant does not imply base in
    expect(broker.has('vault.read')).toBe(false);
    // Base grant does not imply scoped either
    const m2 = validateManifest({ ...baseManifest, permissions: ['vault.read'] });
    const broker2 = new PermissionBroker(m2, 'trusted');
    expect(broker2.has('vault.read:/notes/**')).toBe(false);
  });

  it('validateTierPermissions rejects sandboxed declaring trusted-only', () => {
    const m = validateManifest({ ...baseManifest, permissions: ['ui.views.register'] });
    const issues = validateTierPermissions(m, 'sandboxed');
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]).toMatch(/trusted-only/);
    expect(validateTierPermissions(m, 'trusted')).toEqual([]);
  });
});
