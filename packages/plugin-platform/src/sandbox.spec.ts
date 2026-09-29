import { describe, it, expect } from 'vitest';
import { validateManifest } from './manifest.js';
import { PermissionBroker } from './permissions.js';
import { createSandboxedHost } from './sandbox.js';

describe('SandboxedHost — Worker-isolated RPC', () => {
  const manifestJson = {
    manifestVersion: 1 as const,
    id: 'froglight.example',
    version: '1.0.0',
    froglightSdk: '^0.1.0',
    permissions: ['vault.read', 'workspace.commands.register'] as string[],
  };

  it('handles valid RPC via broker and invokes provider', async () => {
    const manifest = validateManifest(manifestJson);
    const broker = new PermissionBroker(manifest, 'sandboxed');
    const host = createSandboxedHost({
      manifest,
      tier: 'sandboxed',
      broker,
      invoke: async (req) => `ok:${req.capability}.${req.method}`,
    });
    const res = await host.handleMessage({ id: '1', capability: 'vault', method: 'read', params: ['a.md'] });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result).toBe('ok:vault.read');
  });

  it('rejects extra fields and does not invoke provider (adversarial)', async () => {
    const manifest = validateManifest(manifestJson);
    const broker = new PermissionBroker(manifest, 'sandboxed');
    let invoked = false;
    const host = createSandboxedHost({
      manifest,
      tier: 'sandboxed',
      broker,
      invoke: async () => {
        invoked = true;
        return 'leak';
      },
    });
    const res = await host.handleMessage({ id: '1', capability: 'vault', method: 'read', params: ['a'], extra: 'field', forgedPluginId: 'evil' } as any);
    expect(res.ok).toBe(false);
    expect(invoked).toBe(false);
    if (!res.ok) expect(res.code).toBe('RPC_VALIDATION_FAILED');
  });

  it('permission denied does not reach provider', async () => {
    const manifest = validateManifest(manifestJson);
    const broker = new PermissionBroker(manifest, 'sandboxed');
    let invoked = false;
    const host = createSandboxedHost({
      manifest,
      tier: 'sandboxed',
      broker,
      invoke: async () => {
        invoked = true;
        return 'should not happen';
      },
    });
    const res = await host.handleMessage({ id: '2', capability: 'vault', method: 'write', params: ['a', new Uint8Array()] });
    expect(res.ok).toBe(false);
    expect(invoked).toBe(false);
    if (!res.ok) expect(res.code).toBe('PERMISSION_DENIED');
  });

  it('termination prevents further handling', async () => {
    const manifest = validateManifest(manifestJson);
    const broker = new PermissionBroker(manifest, 'sandboxed');
    const host = createSandboxedHost({ manifest, tier: 'sandboxed', broker });
    host.terminate();
    expect(host.terminated).toBe(true);
    const res = await host.handleMessage({ id: '1', capability: 'vault', method: 'read', params: [] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('HOST_TERMINATED');
  });
});
