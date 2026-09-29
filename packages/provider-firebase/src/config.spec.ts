/**
 * Firebase provider config seam.
 *
 * Hosts supply public web config; null/absent/incomplete input selects
 * the unconfigured fallback so local development never requires a
 * Firebase project.
 */

import { describe, expect, it } from 'vitest';
import { resolveFirebaseProviderConfig } from './config.js';

const COMPLETE = {
  apiKey: 'public-key',
  authDomain: 'froglight-dev.firebaseapp.com',
  projectId: 'froglight-dev',
  storageBucket: 'froglight-dev.appspot.com',
  appId: '1:123:web:abc',
};

describe('resolveFirebaseProviderConfig', () => {
  it('accepts a complete config', () => {
    expect(resolveFirebaseProviderConfig(COMPLETE)).toEqual(COMPLETE);
  });

  it('preserves the emulator URL when present', () => {
    expect(
      resolveFirebaseProviderConfig({
        ...COMPLETE,
        authEmulatorUrl: 'http://127.0.0.1:9099',
      }),
    ).toMatchObject({ authEmulatorUrl: 'http://127.0.0.1:9099' });
  });

  it('selects unconfigured for nullish input', () => {
    expect(resolveFirebaseProviderConfig(null)).toBeNull();
    expect(resolveFirebaseProviderConfig(undefined)).toBeNull();
  });

  it('selects unconfigured for incomplete config', () => {
    expect(resolveFirebaseProviderConfig({})).toBeNull();
    expect(
      resolveFirebaseProviderConfig({ ...COMPLETE, apiKey: '   ' }),
    ).toBeNull();
    const { appId: _dropped, ...withoutAppId } = COMPLETE;
    expect(resolveFirebaseProviderConfig(withoutAppId)).toBeNull();
  });

  it('selects unconfigured for non-object input', () => {
    expect(resolveFirebaseProviderConfig('froglight-dev')).toBeNull();
    expect(resolveFirebaseProviderConfig(42)).toBeNull();
    expect(resolveFirebaseProviderConfig([])).toBeNull();
  });
});
