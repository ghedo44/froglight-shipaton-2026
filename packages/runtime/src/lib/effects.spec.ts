/**
 * EffectScope unit tests: reverse-order cleanup, failure aggregation,
 * rejection of registrations after disposal, and idempotent disposal.
 */

import { describe, expect, it } from 'vitest';

import { EffectScope, EffectScopeDisposedError } from '../index.js';

describe('EffectScope', () => {
  it('runs cleanups in reverse registration order', async () => {
    const scope = new EffectScope();
    const order: string[] = [];
    scope.add({ dispose: () => void order.push('a') });
    scope.add({ dispose: () => void order.push('b') });
    scope.add({ dispose: () => void order.push('c') });

    const failures = await scope.dispose();

    expect(order).toEqual(['c', 'b', 'a']);
    expect(failures).toEqual([]);
    expect(scope.size).toBe(0);
  });

  it('attempts every cleanup and aggregates failures', async () => {
    const scope = new EffectScope();
    const cleanups: string[] = [];
    scope.add({
      dispose: () => {
        cleanups.push('throwing');
        throw new Error('boom');
      },
    });
    scope.add({ dispose: () => void cleanups.push('ok') });

    const failures = await scope.dispose();

    // Reverse order: 'ok' (added last) runs first; the throwing cleanup did
    // not stop the remaining one.
    expect(cleanups).toEqual(['ok', 'throwing']);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).toBe('boom');
  });

  it('rejects add after dispose', async () => {
    const scope = new EffectScope();
    scope.add({ dispose: () => undefined });
    await scope.dispose();

    expect(scope.disposed).toBe(true);
    expect(() => scope.add({ dispose: () => undefined })).toThrow(
      EffectScopeDisposedError,
    );
  });

  it('is idempotent: cleanups run exactly once', async () => {
    const scope = new EffectScope();
    let runs = 0;
    scope.add({
      dispose: () => {
        runs += 1;
      },
    });

    await scope.dispose();
    await scope.dispose();

    expect(runs).toBe(1);
    expect(scope.size).toBe(0);
  });

  it('supports async cleanups', async () => {
    const scope = new EffectScope();
    const order: string[] = [];
    scope.add({
      dispose: async () => {
        await Promise.resolve();
        order.push('async');
      },
    });
    scope.add({ dispose: () => void order.push('sync') });

    await scope.dispose();

    expect(order).toEqual(['sync', 'async']);
  });
});
