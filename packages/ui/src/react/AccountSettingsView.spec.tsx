// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AccountSettingsView,
  accountErrorCopy,
} from './AccountSettingsView.jsx';
import {
  AccountError,
  type AccountSnapshot,
} from '@froglight/foundation/account';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function fakeAccount(user: { id: string; email: string | null } | null) {
  const listeners = new Set<(snapshot: never) => void>();
  const calls: string[] = [];
  return {
    calls,
    service: {
      snapshot: (): AccountSnapshot => ({
        ready: true,
        loading: false,
        user,
        error: null,
      }),
      subscribe: (listener: (snapshot: never) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      restore: async () => undefined,
      createAccount: async (email: string) => {
        calls.push(`createAccount:${email}`);
        return { id: 'uid-1', email };
      },
      signIn: async (email: string) => {
        calls.push(`signIn:${email}`);
        return { id: 'uid-1', email };
      },
      signOut: async () => {
        calls.push('signOut');
      },
      refreshToken: async () => ({
        token: null,
        expiresAt: null,
        entitlements: [],
      }),
    },
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(node: React.ReactElement): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(node);
  });
  return host;
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
    for (let i = 0; i < 8; i += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  });
}

describe('AccountSettingsView', () => {
  it('renders the local-only state without a provider', () => {
    const mounted = mount(
      createElement(AccountSettingsView, {
        resolveAccount: () => null,
        resolveIdentity: () => null,
      }),
    );
    expect(mounted.textContent).toContain('works fully offline');
  });

  it('signs in through the account service', async () => {
    const fake = fakeAccount(null);
    const mounted = mount(
      createElement(AccountSettingsView, {
        resolveAccount: () => fake.service as never,
        resolveIdentity: () => null,
      }),
    );
    await settle();
    const email = mounted.querySelector(
      '[data-testid="account-email-input"]',
    ) as HTMLInputElement;
    const password = mounted.querySelector(
      '[data-testid="account-password-input"]',
    ) as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set;
      if (setter === undefined) throw new Error('no input value setter');
      setter.call(email, 'ada@example.com');
      email.dispatchEvent(new Event('input', { bubbles: true }));
      setter.call(password, 'secret12');
      password.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const submit = mounted.querySelector(
      '[data-testid="account-sign-in-submit"]',
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    await act(async () => {
      submit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      for (let i = 0; i < 8; i += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    });
    expect(fake.calls).toContain('signIn:ada@example.com');
  });

  it('signs out through the ordered coordinator when present', async () => {
    const fake = fakeAccount({ id: 'uid-1', email: 'ada@example.com' });
    const signOut = vi.fn(async () => undefined);
    const mounted = mount(
      createElement(AccountSettingsView, {
        resolveAccount: () => fake.service as never,
        resolveIdentity: () => ({ signOut }) as never,
      }),
    );
    await settle();
    expect(mounted.textContent).toContain('ada@example.com');
    const button = mounted.querySelector(
      '[data-testid="account-sign-out"]',
    ) as HTMLButtonElement;
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      for (let i = 0; i < 8; i += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    });
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(fake.calls).not.toContain('signOut');
  });

  it('names account failures without leaking provider wording', () => {
    expect(accountErrorCopy('EMAIL_IN_USE')).toContain(
      'already has an account',
    );
    expect(accountErrorCopy('NOT_CONFIGURED')).toContain('works fully offline');
    expect(accountErrorCopy('FUTURE_CODE')).toContain('Try again');
  });

  it('renders the local-only state for unconfigured providers', () => {
    const fake = fakeAccount(null);
    fake.service.snapshot = (): AccountSnapshot => ({
      ready: true,
      loading: false,
      user: null,
      error: new AccountError('NOT_CONFIGURED', 'not configured'),
    });
    const mounted = mount(
      createElement(AccountSettingsView, {
        resolveAccount: () => fake.service as never,
        resolveIdentity: () => null,
      }),
    );
    expect(mounted.textContent).toContain('works fully offline');
    expect(
      mounted.querySelector('[data-testid="account-sign-in-submit"]'),
    ).toBeNull();
  });
});
