import { describe, it, expect } from 'vitest';
import {
  SDK_VERSION,
  MANIFEST_VERSION,
  PACKAGE_FORMAT,
  ALL_PERMISSIONS,
  TRUSTED_ONLY_PERMISSIONS,
} from './index.js';

describe('SDK — public surface', () => {
  it('exposes expected versions independently', () => {
    expect(SDK_VERSION).toBe('0.1.0');
    expect(MANIFEST_VERSION).toBe(1);
    expect(PACKAGE_FORMAT).toBe(1);
  });

  it('permission catalog is closed and trusted-only subset is disjoint', () => {
    expect(ALL_PERMISSIONS).toContain('vault.read');
    expect(ALL_PERMISSIONS).toContain('ui.views.register');
    expect(ALL_PERMISSIONS).toContain('workspace.blocks.register');
    expect(ALL_PERMISSIONS).toContain('workspace.surfaces.register');
    expect(ALL_PERMISSIONS).toContain('documents.registerKind');
    expect(ALL_PERMISSIONS).toContain('properties.registerType');
    expect(TRUSTED_ONLY_PERMISSIONS).toEqual([
      'ui.views.register',
      'editor.provider',
      'workspace.blocks.register',
      'workspace.surfaces.register',
      'documents.registerKind',
      'properties.registerType',
    ]);
    for (const p of TRUSTED_ONLY_PERMISSIONS) {
      expect(ALL_PERMISSIONS).toContain(p);
    }
  });
});
