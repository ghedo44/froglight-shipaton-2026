import { describe, it, expect } from 'vitest';
import { validateManifest, verifyIntegrity } from './manifest.js';
import { computeIntegrity } from './package.js';

describe('validateManifest — versioned Plugin Manifest', () => {
  const base = {
    manifestVersion: 1 as const,
    id: 'froglight.example',
    version: '1.0.0',
    froglightSdk: '^0.1.0',
    permissions: ['vault.read', 'workspace.commands.register'] as string[],
  };

  it('accepts minimal valid manifest', () => {
    const m = validateManifest(base);
    expect(m.id).toBe('froglight.example');
    expect(m.manifestVersion).toBe(1);
    expect(m.permissions).toEqual(['vault.read', 'workspace.commands.register']);
  });

  it('rejects unknown manifestVersion before any code loads', () => {
    expect(() => validateManifest({ ...base, manifestVersion: 2 })).toThrow(/unsupported manifestVersion/);
    expect(() => validateManifest({ ...base, manifestVersion: 0 })).toThrow(/unsupported manifestVersion/);
    expect(() => validateManifest({ ...base, manifestVersion: '1' })).toThrow(/unsupported manifestVersion/);
  });

  it('rejects invalid id (not reverse-DNS)', () => {
    expect(() => validateManifest({ ...base, id: 'bad' })).toThrow(/invalid id/);
    expect(() => validateManifest({ ...base, id: '' })).toThrow(/invalid id/);
    expect(() => validateManifest({ ...base, id: 'No-Dots' })).toThrow(/invalid id/);
  });

  it('rejects invalid version semver', () => {
    expect(() => validateManifest({ ...base, version: '1.0' })).toThrow(/invalid version/);
    expect(() => validateManifest({ ...base, version: 'x' })).toThrow(/invalid version/);
  });

  it('rejects incompatible froglightSdk range', () => {
    expect(() => validateManifest({ ...base, froglightSdk: '^2.0.0' })).toThrow(/incompatible froglightSdk/);
    expect(() => validateManifest({ ...base, froglightSdk: '^1.0.0' })).toThrow(/incompatible froglightSdk/);
  });

  it('rejects ranges outside the current pre-release SDK line', () => {
    expect(() => validateManifest({ ...base, froglightSdk: '~2.5.3' })).toThrow(
      /incompatible froglightSdk/,
    );
    expect(() => validateManifest({ ...base, froglightSdk: '^0.2.0' })).toThrow(
      /incompatible froglightSdk/,
    );
    expect(() =>
      validateManifest({ ...base, froglightSdk: '>=2.0.0' }),
    ).toThrow(/incompatible froglightSdk/);
  });

  it('accepts ranges containing the current SDK', () => {
    expect(
      validateManifest({ ...base, froglightSdk: '0.1.0' }).froglightSdk,
    ).toBe('0.1.0');
    expect(validateManifest({ ...base, froglightSdk: '*' }).froglightSdk).toBe(
      '*',
    );
    expect(
      validateManifest({ ...base, froglightSdk: '>=0.1.0' }).froglightSdk,
    ).toBe('>=0.1.0');
  });

  it('applies caret bounds at the first nonzero SDK version part', () => {
    const compatible = (range: string, sdkVersion: string) =>
      () => validateManifest({ ...base, froglightSdk: range }, { sdkVersion });

    expect(compatible('^0.0.3', '0.0.3')).not.toThrow();
    expect(compatible('^0.0.3', '0.0.4')).toThrow(/incompatible froglightSdk/);
    expect(compatible('^0.0.3', '0.1.0')).toThrow(/incompatible froglightSdk/);
    expect(compatible('^0.2.3', '0.2.9')).not.toThrow();
    expect(compatible('^0.2.3', '0.3.0')).toThrow(/incompatible froglightSdk/);
    expect(compatible('^1.2.3', '1.9.0')).not.toThrow();
    expect(compatible('^1.2.3', '2.0.0')).toThrow(/incompatible froglightSdk/);
  });

  it('rejects unknown permission name', () => {
    expect(() => validateManifest({ ...base, permissions: ['vault.read', 'unknown.perm'] })).toThrow(/unknown permission/);
  });

  it('accepts scoped permission syntax as reserved (validated but not enforced)', () => {
    const m = validateManifest({ ...base, permissions: ['vault.read:/notes/**', 'vault.write:/notes/**'] });
    expect(m.permissions).toEqual(['vault.read:/notes/**', 'vault.write:/notes/**']);
  });

  it('rejects scoped permission with unknown base', () => {
    expect(() => validateManifest({ ...base, permissions: ['unknown.read:/x'] })).toThrow(/unknown permission base/);
  });

  it('preserves unknown extension fields per open-format rule', () => {
    const m = validateManifest({ ...base, customField: 'hello', another: 42 } as any);
    expect(m.unknownFields).toEqual({ customField: 'hello', another: 42 });
  });

  it('rejects invalid integrity hex when present', () => {
    expect(() => validateManifest({ ...base, integrity: 'not-hex' })).toThrow(/integrity must be sha256/);
    expect(() => validateManifest({ ...base, integrity: 'sha256-bad' })).toThrow(/integrity must be sha256/);
  });

  it('accepts valid sha256 hex and sha256- prefix', () => {
    const hex = 'a'.repeat(64);
    expect(validateManifest({ ...base, integrity: hex }).integrity).toBe(hex);
    expect(validateManifest({ ...base, integrity: `sha256-${hex}` }).integrity).toBe(`sha256-${hex}`);
  });

  it('validates zip-like manifest with integrity', async () => {
    const bytes = new TextEncoder().encode('hello plugin');
    const integrity = await computeIntegrity(bytes);
    const m = validateManifest({ ...base, integrity });
    expect(m.integrity).toBe(integrity);
    expect(await verifyIntegrity(bytes, integrity)).toBe(true);
    expect(await verifyIntegrity(bytes, '0'.repeat(64))).toBe(false);
  });

  it('validates capabilities provides/requires as string arrays', () => {
    const m = validateManifest({ ...base, capabilities: { provides: ['froglight.test'], requires: ['froglight.vault'] } });
    expect(m.capabilities).toEqual({ provides: ['froglight.test'], requires: ['froglight.vault'] });
    expect(() => validateManifest({ ...base, capabilities: { provides: 'bad' } as any })).toThrow(/capabilities.*string\[\]/);
  });
});
