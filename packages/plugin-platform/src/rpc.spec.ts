import { describe, it, expect } from 'vitest';
import { validateRpcRequest, authorizeRpc, createForgedRpc } from './rpc.js';
import { validateManifest } from './manifest.js';
import { PermissionBroker } from './permissions.js';

describe('RPC schema validation — broker entry', () => {
  const baseManifest = {
    manifestVersion: 1 as const,
    id: 'froglight.example',
    version: '1.0.0',
    froglightSdk: '^0.1.0',
    permissions: ['vault.read', 'workspace.commands.register'] as string[],
  };

  it('accepts valid RPC', () => {
    const req = validateRpcRequest({ id: '1', capability: 'vault', method: 'read', params: ['notes/a.md'] });
    expect(req.capability).toBe('vault');
  });

  it('rejects extra fields (schema bypass attempt)', () => {
    expect(() => validateRpcRequest({ id: '1', capability: 'vault', method: 'read', params: [], extra: 'leak' } as any)).toThrow(
      /extra field/,
    );
  });

  it('rejects forged identity field', () => {
    const forged = createForgedRpc({ capability: 'vault', method: 'read', params: ['x'] });
    expect(() => validateRpcRequest(forged)).toThrow(/extra field/);
  });

  it('rejects unknown capability or method', () => {
    expect(() => validateRpcRequest({ id: '1', capability: 'evil', method: 'read', params: [] })).toThrow(/not allowed/);
    expect(() => validateRpcRequest({ id: '1', capability: 'vault', method: 'evil', params: [] })).toThrow(/not allowed/);
  });

  it('broker denies ungranted permission via RPC', () => {
    const m = validateManifest(baseManifest);
    const broker = new PermissionBroker(m, 'sandboxed');
    // vault.read is granted, vault.write is not
    expect(() => authorizeRpc({ id: '1', capability: 'vault', method: 'read', params: ['a'] }, broker)).not.toThrow();
    expect(() => authorizeRpc({ id: '2', capability: 'vault', method: 'write', params: ['a', new Uint8Array()] }, broker)).toThrow(
      /PermissionDenied/,
    );
  });

  it('broker denies trusted-only via RPC for sandboxed', () => {
    const m = validateManifest({ ...baseManifest, permissions: ['vault.read', 'ui.views.register'] });
    const broker = new PermissionBroker(m, 'sandboxed');
    // Even though manifest declared ui.views.register, broker must deny for sandboxed tier.
    expect(() => authorizeRpc({ id: '1', capability: 'vault', method: 'read', params: [] }, broker)).not.toThrow();
    // commands.register would map to workspace.commands.register which is trusted-allowed, but we test ui path:
    // Our RPC capability list does not include ui.views, so vault read is the testable path — we simulate trusted-only directly:
    expect(() => broker.require('ui.views.register')).toThrow(/PermissionDenied/);
  });
});
