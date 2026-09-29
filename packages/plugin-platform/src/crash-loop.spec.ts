import { describe, it, expect } from 'vitest';
import { CrashLoopTracker } from './crash-loop.js';

describe('CrashLoopTracker + Safe Mode', () => {
  it('marks slot as crash loop after 3 failures within window', () => {
    const tracker = new CrashLoopTracker({ windowMs: 10 * 60 * 1000, maxFailures: 3 });
    const now = Date.now();
    tracker.record({ slotId: 'froglight.example', atMillis: now, phase: 'activation', message: 'fail1' });
    tracker.record({ slotId: 'froglight.example', atMillis: now + 1000, phase: 'activation', message: 'fail2' });
    expect(tracker.isCrashLoop('froglight.example')).toBe(false);
    tracker.record({ slotId: 'froglight.example', atMillis: now + 2000, phase: 'activation', message: 'fail3' });
    expect(tracker.isCrashLoop('froglight.example')).toBe(true);
    expect(tracker.shouldEnterSafeMode()).toBe(true);
  });

  it('2 consecutive boot failures triggers safe mode', () => {
    const tracker = new CrashLoopTracker({ maxBootFailures: 2 });
    tracker.record({ slotId: 'boot', atMillis: Date.now(), phase: 'boot', message: 'boot1' });
    expect(tracker.shouldEnterSafeMode()).toBe(false);
    tracker.record({ slotId: 'boot', atMillis: Date.now() + 100, phase: 'boot', message: 'boot2' });
    expect(tracker.shouldEnterSafeMode()).toBe(true);
  });

  it('boot success resets consecutive counter', () => {
    const tracker = new CrashLoopTracker({ maxBootFailures: 2 });
    tracker.record({ slotId: 'boot', atMillis: Date.now(), phase: 'boot', message: 'fail' });
    tracker.recordBootSuccess();
    tracker.record({ slotId: 'boot', atMillis: Date.now(), phase: 'boot', message: 'fail2' });
    expect(tracker.shouldEnterSafeMode()).toBe(false);
  });

  it('clear removes crash loop state', () => {
    const tracker = new CrashLoopTracker();
    const now = Date.now();
    for (let i = 0; i < 3; i++) tracker.record({ slotId: 'a', atMillis: now + i * 1000, phase: 'activation', message: 'x' });
    expect(tracker.isCrashLoop('a')).toBe(true);
    tracker.clear('a');
    expect(tracker.isCrashLoop('a')).toBe(false);
  });
});
