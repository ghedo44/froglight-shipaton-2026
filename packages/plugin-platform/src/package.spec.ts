import { describe, it, expect } from 'vitest';
import { loadPluginPackage, computeIntegrity } from './package.js';

describe('PluginPackage — folder vs zip integrity', () => {
  const baseManifest = {
    manifestVersion: 1 as const,
    id: 'froglight.example',
    version: '1.0.0',
    froglightSdk: '^0.1.0',
    permissions: ['vault.read'] as string[],
  };

  it('loads folder package without integrity', async () => {
    const pkg = await loadPluginPackage({ source: 'folder', manifestJson: baseManifest, code: 'export const x=1' });
    expect(pkg.source).toBe('folder');
    expect(pkg.manifest.id).toBe('froglight.example');
  });

  it('loads zip package with valid sha256', async () => {
    const bytes = new TextEncoder().encode('zip content');
    const integrity = await computeIntegrity(bytes);
    const pkg = await loadPluginPackage({ source: 'zip', manifestJson: { ...baseManifest, integrity }, bytes, code: 'code' });
    expect(pkg.manifest.integrity).toBeTruthy();
  });

  it('rejects zip with mismatched integrity', async () => {
    const bytes = new TextEncoder().encode('zip content');
    await expect(
      loadPluginPackage({ source: 'zip', manifestJson: { ...baseManifest, integrity: 'a'.repeat(64) }, bytes }),
    ).rejects.toThrow(/integrity mismatch/);
  });

  it('rejects zip missing integrity', async () => {
    const bytes = new TextEncoder().encode('zip content');
    await expect(loadPluginPackage({ source: 'zip', manifestJson: baseManifest, bytes })).rejects.toThrow(
      /missing integrity/,
    );
  });

  it('rejects zip missing bytes', async () => {
    await expect(
      loadPluginPackage({ source: 'zip', manifestJson: { ...baseManifest, integrity: 'a'.repeat(64) } }),
    ).rejects.toThrow(/missing bytes/);
  });
});
