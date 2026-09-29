import { describe, expect, it, vi } from 'vitest';
import { documentKindId } from './identity.js';
import {
  InMemoryCompositionRegistry,
  LazyCompositionController,
  MAX_COMPOSITION_DEPTH,
  compositionKey,
  type CompositionHandle,
  type CompositionRequest,
  type CompositionSnapshot,
} from './composition.js';

const request: CompositionRequest = {
  role: 'preview',
  target: {
    documentId: 'doc-a',
    kindId: 'froglight.markdown',
    resourceId: 'res-a',
  },
};

function readyHandle(dispose = vi.fn()): CompositionHandle {
  const snapshot: CompositionSnapshot = {
    state: 'ready',
    title: 'A',
    summary: 'source text',
  };
  return {
    snapshot: () => snapshot,
    onDidChange: () => ({
      dispose() {
        /* deterministic static test handle */
      },
    }),
    dispose,
  };
}

describe('CompositionRegistry', () => {
  it('recovers the same visible reference when its provider is replaced', () => {
    const registry = new InMemoryCompositionRegistry();
    const handle = registry.open(request);
    const changed = vi.fn();
    const subscription = handle.onDidChange(changed);
    expect(handle.snapshot()).toMatchObject({ reason: 'missing-provider' });
    const dispose = vi.fn();
    const first = registry.register({
      kindId: documentKindId('froglight.markdown'),
      roles: ['preview'],
      writeAuthority: 'none',
      open: () => readyHandle(dispose),
    });
    expect(handle.snapshot()).toMatchObject({ state: 'ready' });
    first.dispose();
    expect(handle.snapshot()).toMatchObject({ reason: 'missing-provider' });
    expect(dispose).toHaveBeenCalledTimes(1);
    const second = registry.register({
      kindId: documentKindId('froglight.markdown'),
      roles: ['preview'],
      writeAuthority: 'none',
      open: () => readyHandle(dispose),
    });
    expect(handle.snapshot()).toMatchObject({ state: 'ready' });
    expect(changed).toHaveBeenCalledTimes(3);
    subscription.dispose();
    handle.dispose();
    second.dispose();
    expect(dispose).toHaveBeenCalledTimes(2);
  });
  it('dispatches plain-data roles and deterministically disposes handles with their provider', () => {
    const registry = new InMemoryCompositionRegistry();
    const disposeHandle = vi.fn();
    const registration = registry.register({
      kindId: documentKindId('froglight.markdown'),
      roles: ['preview'],
      writeAuthority: 'none',
      open: () => readyHandle(disposeHandle),
    });
    const handle = registry.open(request);
    expect(handle.snapshot()).toMatchObject({ state: 'ready', title: 'A' });
    registration.dispose();
    expect(disposeHandle).toHaveBeenCalledOnce();
    expect(registry.open(request).snapshot()).toMatchObject({
      state: 'placeholder',
      reason: 'missing-provider',
    });
  });

  it('terminates cycles and depth exhaustion without opening a provider', () => {
    const registry = new InMemoryCompositionRegistry();
    const open = vi.fn(() => readyHandle());
    registry.register({
      kindId: documentKindId('froglight.markdown'),
      roles: ['preview'],
      writeAuthority: 'none',
      open,
    });
    const key = compositionKey(request);
    expect(
      registry.open({ ...request, ancestry: [key] }).snapshot(),
    ).toMatchObject({
      state: 'placeholder',
      reason: 'cycle',
      recoverable: true,
    });
    expect(
      registry
        .open({
          ...request,
          ancestry: Array.from({ length: MAX_COMPOSITION_DEPTH }, (_, i) =>
            String(i),
          ),
        })
        .snapshot(),
    ).toMatchObject({ state: 'placeholder', reason: 'depth' });
    expect(open).not.toHaveBeenCalled();
  });

  it('rejects writable providers for preview/transclusion but permits source-owned linked views', () => {
    const registry = new InMemoryCompositionRegistry();
    registry.register({
      kindId: documentKindId('acme.database'),
      roles: ['preview', 'linked-view'],
      writeAuthority: 'source',
      open: () => readyHandle(),
    });
    const target = {
      documentId: 'd',
      kindId: 'acme.database',
      resourceId: 'r',
    };
    expect(registry.open({ role: 'preview', target }).snapshot()).toMatchObject(
      { state: 'placeholder', reason: 'permission-denied' },
    );
    expect(
      registry.open({ role: 'linked-view', target, viewId: 'v1' }).snapshot(),
    ).toMatchObject({ state: 'ready' });
    expect(
      registry.open({ role: 'linked-view', target }).snapshot(),
    ).toMatchObject({ state: 'placeholder', reason: 'missing-view' });
  });

  it('prevents a read-only provider from exposing or invoking source mutations', () => {
    const registry = new InMemoryCompositionRegistry();
    const invoke = vi.fn();
    registry.register({
      kindId: documentKindId('acme.readonly'),
      roles: ['preview'],
      writeAuthority: 'none',
      open: () => ({
        snapshot: () => ({
          state: 'ready',
          actions: [{ id: 'mutate', label: 'Mutate', authority: 'source' }],
        }),
        onDidChange: () => ({
          dispose() {
            /* deterministic static test handle */
          },
        }),
        invoke,
        dispose() {
          /* deterministic static test handle */
        },
      }),
    });
    const handle = registry.open({
      role: 'preview',
      target: { documentId: 'd', kindId: 'acme.readonly', resourceId: 'r' },
    });
    expect(handle.snapshot()).toEqual({ state: 'ready', actions: [] });
    handle.invoke?.('mutate');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('opens only while visible and releases provider state offscreen', () => {
    const registry = new InMemoryCompositionRegistry();
    const dispose = vi.fn();
    const open = vi.fn(() => readyHandle(dispose));
    registry.register({
      kindId: documentKindId('froglight.markdown'),
      roles: ['preview'],
      writeAuthority: 'none',
      open,
    });
    const snapshots: CompositionSnapshot[] = [];
    const lazy = new LazyCompositionController(registry, request, (snapshot) =>
      snapshots.push(snapshot),
    );
    expect(open).not.toHaveBeenCalled();
    lazy.setVisible(true);
    expect(open).toHaveBeenCalledOnce();
    expect(snapshots.at(-1)).toMatchObject({ state: 'ready' });
    lazy.setVisible(false);
    expect(dispose).toHaveBeenCalledOnce();
  });
});
