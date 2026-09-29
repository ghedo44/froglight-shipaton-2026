import { describe, it, expect } from 'vitest';
import { CrashLoopTracker, filterForSafeMode, MINIMAL_SAFE_MODE_PLUGINS } from './crash-loop.js';

describe('Safe Mode — minimal mount after crash loop', () => {
  it('filterForSafeMode mounts only minimal when shouldEnterSafeMode', () => {
    const tracker = new CrashLoopTracker({ windowMs: 60000, maxFailures: 3 });
    const all = ['froglight.workspace', 'froglight.vault', 'froglight.third-party', 'froglight.another'] as const;
    // Not in safe mode initially
    expect(filterForSafeMode(all as any, tracker)).toEqual(all);

    // Trigger crash loop for third-party
    const now = Date.now();
    for (let i = 0; i < 3; i++) tracker.record({ slotId: 'froglight.third-party', atMillis: now + i * 1000, phase: 'activation', message: 'fail' });
    expect(tracker.shouldEnterSafeMode()).toBe(true);
    const filtered = filterForSafeMode(all as any, tracker);
    expect(filtered).toContain('froglight.workspace');
    expect(filtered).toContain('froglight.vault');
    expect(filtered).not.toContain('froglight.third-party');
    expect(filtered).not.toContain('froglight.another');
  });

  it('safe mode minimal set includes diagnostics', () => {
    expect(MINIMAL_SAFE_MODE_PLUGINS).toContain('froglight.diagnostics');
  });
});
