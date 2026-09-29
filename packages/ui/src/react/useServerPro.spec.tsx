// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { AccountSnapshot } from '@froglight/foundation/account';
import { useServerPro } from './useServerPro.jsx';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function fakeAccount(options: {
  user: { id: string; email: string | null } | null;
  cached: readonly string[];
  fresh: readonly string[];
  failCached?: boolean;
  failFresh?: boolean;
}) {
  const calls: string[] = [];
  const listeners = new Set<(snapshot: never) => void>();
  return {
    calls,
    service: {
      snapshot: (): AccountSnapshot => ({
        ready: true,
        loading: false,
        user: options.user,
        error: null,
      }),
      subscribe: (listener: (snapshot: never) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      restore: async () => undefined,
      createAccount: async () => ({ id: 'uid-1', email: null }),
      signIn: async () => ({ id: 'uid-1', email: null }),
      signOut: async () => undefined,
      refreshToken: async (force = false) => {
        calls.push(force ? 'force' : 'cached');
        if (!force && options.failCached) throw { code: 'NETWORK' };
        if (force && options.failFresh) throw { code: 'NETWORK' };
        return {
          token: 'token',
          expiresAt: null,
          entitlements: [...(force ? options.fresh : options.cached)],
        };
      },
    },
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(account: { snapshot(): AccountSnapshot } | null): {
  element: HTMLElement;
  states: { isPro: boolean; loading: boolean }[];
} {
  const states: { isPro: boolean; loading: boolean }[] = [];
  function Probe(props: {
    account: { snapshot(): AccountSnapshot } | null;
  }): React.ReactElement {
    const state = useServerPro(props.account as never);
    states.push({ isPro: state.isPro, loading: state.loading });
    return createElement('div', null, state.isPro ? 'pro' : 'free');
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  const nextRoot = createRoot(host);
  root = nextRoot;
  act(() => {
    nextRoot.render(createElement(Probe, { account }));
  });
  return { element: host, states };
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
});

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 12; i += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  });
}

describe('useServerPro', () => {
  it('reports Free without a provider and never reads a token', async () => {
    const { element } = mount(null);
    await settle();
    expect(element.textContent).toBe('free');
  });

  it('reports Free while signed out', async () => {
    const account = fakeAccount({ user: null, cached: [], fresh: [] });
    const { element } = mount(account.service as never);
    await settle();
    expect(element.textContent).toBe('free');
    expect(account.calls).toEqual([]);
  });

  it('reads the cached claim when it already carries Pro', async () => {
    const account = fakeAccount({
      user: { id: 'uid-1', email: 'a@b.c' },
      cached: ['pro'],
      fresh: ['pro'],
    });
    const { element } = mount(account.service as never);
    await settle();
    expect(element.textContent).toBe('pro');
    expect(account.calls).toEqual(['cached']);
  });

  it('force-refreshes once when the cached claim is stale (iPhone purchase → web)', async () => {
    const account = fakeAccount({
      user: { id: 'uid-1', email: 'a@b.c' },
      cached: [],
      fresh: ['pro'],
    });
    const { element } = mount(account.service as never);
    await settle();
    expect(element.textContent).toBe('pro');
    expect(account.calls).toEqual(['cached', 'force']);
  });

  it('stays Free when neither cached nor fresh claims carry Pro', async () => {
    const account = fakeAccount({
      user: { id: 'uid-1', email: 'a@b.c' },
      cached: [],
      fresh: [],
    });
    const { element } = mount(account.service as never);
    await settle();
    expect(element.textContent).toBe('free');
  });

  it('degrades to Free on token failures instead of throwing', async () => {
    const account = fakeAccount({
      user: { id: 'uid-1', email: 'a@b.c' },
      cached: [],
      fresh: [],
      failCached: true,
      failFresh: true,
    });
    const { element } = mount(account.service as never);
    await settle();
    expect(element.textContent).toBe('free');
  });
});
