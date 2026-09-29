/**
 * Mutation feed conformance.
 *
 * - write/remove/move/mkdir each emit exactly one typed event
 * - reads never emit; failed mutations never emit
 * - `suppress()` blocks emission (nested, unwinds on throw)
 * - scheduler coalescing: bursts → one run, mid-run requests → one rerun
 * - feed + scheduler integration: local edits schedule, remote apply
 *   through `suppress()` never echoes
 */

import { describe, expect, it, vi } from 'vitest';
import { definePlugin } from '@froglight/runtime';
import { localVaultIdentityToken, vaultToken } from '../tokens.js';
import { memoryVaultPlugin } from '../plugins/memory-vault.js';
import { registerVaultContractSuite } from '../testing/contract-suite-vitest.js';
import { workspacePath } from '../paths.js';
import type {
  VaultCapabilities,
  VaultEntry,
  VaultFile,
  VaultOperationOptions,
  VaultService,
  VaultStat,
} from '../vault/contract.js';
import {
  MemoryVault,
  createMemoryVault,
  createMemoryVaultState,
} from '../vault/memory.js';
import {
  ObservableVaultService,
  SyncScheduler,
  asObservableVault,
  withObservableVault,
  type VaultMutation,
} from './mutations.js';

const PATH_A = workspacePath('notes/a.md');
const PATH_B = workspacePath('notes/b.md');
const DIR = workspacePath('notes');

function collect(observable: ObservableVaultService): {
  events: VaultMutation[];
  stop: () => void;
} {
  const events: VaultMutation[] = [];
  const stop = observable.onMutation((mutation) => {
    events.push(mutation);
  });
  return { events, stop };
}

function flush(times = 5): Promise<void> {
  let chain = Promise.resolve();
  for (let i = 0; i < times; i += 1) {
    chain = chain.then(() => undefined);
  }
  return chain;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('observable vault service', () => {
  it('emits one typed event per successful mutation', async () => {
    const { vault } = createMemoryVault();
    const observable = new ObservableVaultService(vault);
    const { events } = collect(observable);

    await observable.createDirectory(DIR);
    await observable.write(PATH_A, new TextEncoder().encode('hello'));
    await observable.move(PATH_A, PATH_B);
    await observable.remove(PATH_B);

    expect(events).toEqual([
      { type: 'mkdir', path: DIR },
      { type: 'write', path: PATH_A },
      { type: 'move', from: PATH_A, to: PATH_B },
      { type: 'remove', path: PATH_B },
    ]);
  });

  it('reads never emit', async () => {
    const { vault } = createMemoryVault();
    const observable = new ObservableVaultService(vault);
    await observable.createDirectory(DIR);
    await observable.write(PATH_A, new TextEncoder().encode('hello'));
    const { events } = collect(observable);

    await observable.stat(PATH_A);
    await observable.list(DIR);
    await observable.read(PATH_A);

    expect(events).toEqual([]);
  });

  it('failed mutations emit nothing', async () => {
    const { vault } = createMemoryVault();
    const observable = new ObservableVaultService(vault);
    const { events } = collect(observable);

    // No parent directory: write rejects with NOT_FOUND.
    await expect(
      observable.write(PATH_A, new TextEncoder().encode('x')),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(observable.remove(PATH_A)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(observable.move(PATH_A, PATH_B)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      observable.createDirectory(workspacePath('missing/child')),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(events).toEqual([]);
  });

  it('writes through to the wrapped provider byte-identically', async () => {
    const { vault } = createMemoryVault();
    const observable = new ObservableVaultService(vault);
    await observable.createDirectory(DIR);
    const bytes = new TextEncoder().encode('through');
    await observable.write(PATH_A, bytes);
    // Read back through the wrapper and directly from the provider.
    expect(await observable.read(PATH_A)).toEqual(bytes);
    expect(await vault.read(PATH_A)).toEqual(bytes);
    expect(observable.capabilities).toBe(vault.capabilities);
    expect(observable.inner).toBe(vault);
  });

  it('supports unsubscribe and multiple listeners', async () => {
    const { vault } = createMemoryVault();
    const observable = new ObservableVaultService(vault);
    const first: VaultMutation[] = [];
    const second: VaultMutation[] = [];
    const stopFirst = observable.onMutation((m) => {
      first.push(m);
    });
    observable.onMutation((m) => {
      second.push(m);
    });

    await observable.createDirectory(DIR);
    stopFirst();
    await observable.write(PATH_A, new TextEncoder().encode('x'));

    expect(first).toEqual([{ type: 'mkdir', path: DIR }]);
    expect(second).toHaveLength(2);
  });

  it('a throwing listener breaks neither the operation nor later listeners', async () => {
    const { vault } = createMemoryVault();
    const observable = new ObservableVaultService(vault);
    const seen: VaultMutation[] = [];
    observable.onMutation(() => {
      throw new Error('listener blew up');
    });
    observable.onMutation((m) => {
      seen.push(m);
    });

    await observable.createDirectory(DIR);
    await observable.write(PATH_A, new TextEncoder().encode('x'));

    expect(await vault.read(PATH_A)).toEqual(new TextEncoder().encode('x'));
    expect(seen).toEqual([
      { type: 'mkdir', path: DIR },
      { type: 'write', path: PATH_A },
    ]);
  });

  it('suppress blocks all mutation events and returns the result', async () => {
    const { vault } = createMemoryVault();
    const observable = new ObservableVaultService(vault);
    const { events } = collect(observable);

    expect(observable.suppressing).toBe(false);
    const result = await observable.suppress(async () => {
      expect(observable.suppressing).toBe(true);
      await observable.createDirectory(DIR);
      await observable.write(PATH_A, new TextEncoder().encode('remote'));
      await observable.move(PATH_A, PATH_B);
      await observable.remove(PATH_B);
      return 42;
    });

    expect(result).toBe(42);
    expect(observable.suppressing).toBe(false);
    expect(events).toEqual([]);
    // The work itself still happened — only the events were withheld.
    expect(await vault.list(DIR)).toEqual([]);
  });

  it('suppress nests and unwinds when the work throws', async () => {
    const { vault } = createMemoryVault();
    const observable = new ObservableVaultService(vault);
    const { events } = collect(observable);

    await expect(
      observable.suppress(async () => {
        await observable.suppress(async () => {
          await observable.createDirectory(DIR);
          throw new Error('apply failed');
        });
      }),
    ).rejects.toThrow('apply failed');

    expect(observable.suppressing).toBe(false);
    expect(events).toEqual([]);
    // Events resume after suppression unwinds.
    await observable.write(PATH_A, new TextEncoder().encode('x'));
    expect(events).toEqual([{ type: 'write', path: PATH_A }]);
  });

  it('hides readFile exactly when the wrapped provider lacks it', async () => {
    const { vault } = createMemoryVault();
    const inner: VaultService = vault;
    expect(inner.readFile).toBeUndefined();
    const observable = new ObservableVaultService(vault);
    expect(observable.readFile).toBeUndefined();
  });

  it('passes readFile through when the wrapped provider offers it', async () => {
    const { vault } = createMemoryVault();
    const file: VaultFile = {
      name: 'a.md',
      size: 5,
      type: 'text/markdown',
      arrayBuffer: async () =>
        new TextEncoder().encode('hello').buffer as ArrayBuffer,
      text: async () => 'hello',
    };
    const inner: VaultService = {
      ...vault,
      capabilities: vault.capabilities,
      stat: (p, o) => vault.stat(p, o),
      list: (p, o) => vault.list(p, o),
      createDirectory: (p, o) => vault.createDirectory(p, o),
      read: (p, o) => vault.read(p, o),
      readFile: async () => file,
      write: (p, d, o) => vault.write(p, d, o),
      remove: (p, o) => vault.remove(p, o),
      move: (f, t, o) => vault.move(f, t, o),
    };
    const observable = new ObservableVaultService(inner);
    expect(await observable.readFile?.(PATH_A)).toBe(file);
  });

  it('forwards capabilities, stat, and list untouched', async () => {
    const { vault } = createMemoryVault();
    const observable = new ObservableVaultService(vault);
    await observable.createDirectory(DIR);
    await observable.suppress(async () => {
      await observable.write(PATH_A, new TextEncoder().encode('x'));
    });
    const entries: VaultEntry[] = [...(await observable.list(DIR))];
    expect(entries.map((e) => e.name)).toEqual(['a.md']);
    const stat: VaultStat = await observable.stat(PATH_A);
    expect(stat).toMatchObject({ kind: 'file', size: 1 });
    const caps: VaultCapabilities = observable.capabilities;
    expect(caps.supportsMove).toBe(vault.capabilities.supportsMove);
  });

  it('accepts per-operation options without changing events', async () => {
    const { vault } = createMemoryVault();
    const observable = new ObservableVaultService(vault);
    const { events } = collect(observable);
    const options: VaultOperationOptions = {};
    await observable.createDirectory(DIR, options);
    await observable.write(PATH_A, new TextEncoder().encode('x'), options);
    await observable.stat(PATH_A, options);
    await observable.list(DIR, options);
    await observable.read(PATH_A, options);
    expect(events).toEqual([
      { type: 'mkdir', path: DIR },
      { type: 'write', path: PATH_A },
    ]);
  });
});

describe('silent view', () => {
  it('never emits while delegating every operation', async () => {
    const { vault } = createMemoryVault();
    const observable = new ObservableVaultService(vault);
    const { events } = collect(observable);
    const silent = observable.silent;

    expect(silent).not.toBe(observable);
    expect(silent.capabilities).toBe(vault.capabilities);
    await silent.createDirectory(DIR);
    await silent.write(PATH_A, new TextEncoder().encode('quiet'));
    expect(await silent.read(PATH_A)).toEqual(
      new TextEncoder().encode('quiet'),
    );
    expect(await silent.list(DIR)).toEqual([{ name: 'a.md', kind: 'file' }]);
    expect(await silent.stat(PATH_A)).toMatchObject({ kind: 'file' });
    await silent.move(PATH_A, PATH_B);
    await silent.remove(PATH_B);
    expect(events).toEqual([]);
    // The bytes still landed: silence is about events, not writes.
    expect(await vault.list(DIR)).toEqual([]);
  });

  it('is stable across accesses and mirrors readFile support', async () => {
    const { vault } = createMemoryVault();
    const observable = new ObservableVaultService(vault);
    expect(observable.silent).toBe(observable.silent);
    expect(observable.silent.readFile).toBeUndefined();
  });
});

function fakeActivateContext(
  onProvide: (token: unknown, value: unknown) => void,
): never {
  return {
    config: {},
    provide: onProvide,
  } as never;
}

describe('observable vault provisioning', () => {
  it('wraps the provided vault and preserves everything else', () => {
    const wrapped = withObservableVault(memoryVaultPlugin);
    expect(wrapped.id).toBe(memoryVaultPlugin.id);
    expect(wrapped.requirements).toBe(memoryVaultPlugin.requirements);

    const provided = new Map<unknown, unknown>();
    const calls: string[] = [];
    wrapped.activate(
      fakeActivateContext((token: unknown, value: unknown) => {
        calls.push('provide');
        provided.set(token, value);
      }),
    );
    // The provider binds the vault and its local identity; only the vault value is wrapped.
    expect(calls).toEqual(['provide', 'provide']);
    const bound = provided.get(vaultToken);
    expect(bound instanceof ObservableVaultService).toBe(true);
    expect(asObservableVault(bound as never)).toBe(bound);
    const identity = provided.get(localVaultIdentityToken) as
      | { id?: unknown }
      | undefined;
    expect(typeof identity?.id).toBe('string');
    expect(String(identity?.id)).toMatch(/^ephemeral:/);
  });

  it('is idempotent for already-observable providers', () => {
    const { vault } = createMemoryVault();
    const observable = new ObservableVaultService(vault);
    const inner = definePlugin({
      id: 'test.already-observable',
      activate: (ctx) => {
        ctx.provide(vaultToken, observable);
      },
    });
    const provided = new Map<unknown, unknown>();
    withObservableVault(inner).activate(
      fakeActivateContext((t: unknown, v: unknown) => {
        provided.set(t, v);
      }),
    );
    expect(provided.get(vaultToken)).toBe(observable);
  });

  it('forwards non-vault tokens untouched', () => {
    const marker = { id: 'other' };
    const otherToken = { id: 'test.other' } as never;
    const inner = definePlugin({
      id: 'test.passthrough',
      activate: (ctx) => {
        ctx.provide(otherToken, marker);
      },
    });
    const provided = new Map<unknown, unknown>();
    withObservableVault(inner).activate(
      fakeActivateContext((t: unknown, v: unknown) => {
        provided.set(t, v);
      }),
    );
    expect(provided.get(otherToken)).toBe(marker);
  });

  it('returns null from asObservableVault for raw providers', () => {
    const { vault } = createMemoryVault();
    expect(asObservableVault(vault)).toBeNull();
  });
});

// Full provider conformance through the wrapper: transparency proven by
// the identical assertions every vault provider passes. Registered at
// collection time (the adapter defines its own describe block).
const conformanceState = createMemoryVaultState();
registerVaultContractSuite('ObservableVaultService', {
  provider: new ObservableVaultService(new MemoryVault(conformanceState)),
  reopen: () => new ObservableVaultService(new MemoryVault(conformanceState)),
});

describe('sync scheduler', () => {
  it('coalesces a synchronous burst into one run', async () => {
    const run = vi.fn(async () => undefined);
    const scheduler = new SyncScheduler(run);
    scheduler.request();
    scheduler.request();
    scheduler.request();
    expect(scheduler.pending).toBe(true);
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
    expect(scheduler.pending).toBe(false);
  });

  it('runs once more when requested mid-run, never overlapping', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let concurrent = 0;
    let maxConcurrent = 0;
    const run = vi.fn(async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await gate;
      concurrent -= 1;
    });
    const scheduler = new SyncScheduler(run);
    scheduler.request();
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
    // Three requests while the first run is gated collapse into one rerun.
    scheduler.request();
    scheduler.request();
    scheduler.request();
    expect(scheduler.pending).toBe(true);
    release();
    await flush(10);
    expect(run).toHaveBeenCalledTimes(2);
    expect(maxConcurrent).toBe(1);
    expect(scheduler.pending).toBe(false);
  });

  it('debounces rapid requests inside the window', async () => {
    const run = vi.fn(async () => undefined);
    const scheduler = new SyncScheduler(run, { debounceMs: 20 });
    scheduler.request();
    await sleep(5);
    scheduler.request();
    await sleep(5);
    scheduler.request();
    expect(run).not.toHaveBeenCalled();
    await sleep(40);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('runs again for requests in separate debounce windows', async () => {
    const run = vi.fn(async () => undefined);
    const scheduler = new SyncScheduler(run, { debounceMs: 10 });
    scheduler.request();
    await sleep(30);
    expect(run).toHaveBeenCalledTimes(1);
    scheduler.request();
    await sleep(30);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('dispose cancels a debounced run and ignores later requests', async () => {
    const run = vi.fn(async () => undefined);
    const scheduler = new SyncScheduler(run, { debounceMs: 10 });
    scheduler.request();
    expect(scheduler.pending).toBe(true);
    scheduler.dispose();
    expect(scheduler.disposed).toBe(true);
    expect(scheduler.pending).toBe(false);
    await sleep(30);
    expect(run).not.toHaveBeenCalled();
    scheduler.request();
    await flush();
    expect(run).not.toHaveBeenCalled();
  });

  it('dispose during a run finishes it without rescheduling', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = vi.fn(() => gate);
    const scheduler = new SyncScheduler(run);
    scheduler.request();
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
    scheduler.request();
    scheduler.dispose();
    release();
    await flush(10);
    expect(run).toHaveBeenCalledTimes(1);
    expect(scheduler.pending).toBe(false);
  });

  it('reports run failures to onError and stays usable', async () => {
    const errors: unknown[] = [];
    let attempts = 0;
    const scheduler = new SyncScheduler(
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('network down');
      },
      {
        onError: (error) => {
          errors.push(error);
        },
      },
    );
    scheduler.request();
    await flush(10);
    expect(errors).toHaveLength(1);
    expect(scheduler.pending).toBe(false);
    scheduler.request();
    await flush(10);
    expect(attempts).toBe(2);
    expect(errors).toHaveLength(1);
  });

  it('a throwing onError never breaks the scheduler', async () => {
    const scheduler = new SyncScheduler(
      async () => {
        throw new Error('boom');
      },
      {
        onError: () => {
          throw new Error('reporter blew up');
        },
      },
    );
    scheduler.request();
    await flush(10);
    expect(scheduler.pending).toBe(false);
    scheduler.request();
    await flush(10);
    expect(scheduler.pending).toBe(false);
  });

  it('treats invalid debounce windows as zero', async () => {
    const run = vi.fn(async () => undefined);
    const scheduler = new SyncScheduler(run, { debounceMs: -5 });
    scheduler.request();
    scheduler.request();
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('feed + scheduler integration', () => {
  it('local edits schedule one reconcile; suppressed remote apply never echoes', async () => {
    const { vault } = createMemoryVault();
    const observable = new ObservableVaultService(vault);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let runs = 0;
    const scheduler = new SyncScheduler(async () => {
      runs += 1;
      await gate;
    });
    const stop = observable.onMutation(() => scheduler.request());

    // First mutation starts the run and holds it open.
    await observable.createDirectory(DIR);
    await flush(10);
    expect(runs).toBe(1);

    // Two more local mutations mid-run collapse into exactly one rerun.
    await observable.write(PATH_A, new TextEncoder().encode('local'));
    await observable.write(
      workspacePath('notes/c.md'),
      new TextEncoder().encode('local'),
    );
    release();
    await flush(10);
    expect(runs).toBe(2);
    expect(scheduler.pending).toBe(false);

    // Remote change materialized through suppress(): no events emitted,
    // so no follow-up work is scheduled — the upload echo is impossible.
    await observable.suppress(async () => {
      await observable.write(
        workspacePath('notes/remote.md'),
        new TextEncoder().encode('remote'),
      );
    });
    await flush(10);
    expect(runs).toBe(2);
    expect(scheduler.pending).toBe(false);
    expect(await vault.read(workspacePath('notes/remote.md'))).toEqual(
      new TextEncoder().encode('remote'),
    );

    // After unsubscribe, local edits schedule nothing.
    stop();
    await observable.write(PATH_A, new TextEncoder().encode('local 2'));
    await flush(10);
    expect(runs).toBe(2);
  });
});
