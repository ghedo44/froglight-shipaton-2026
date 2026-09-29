/**
 * Froglight account settings.
 *
 * Platform-neutral presentation over `AccountService`: email + password
 * create/sign-in, signed-in identity display, and ordered sign-out through
 * the account ↔ purchase coordinator (which dismantles cloud authority
 * before Firebase sign-out — local vaults are never touched). Reads the
 * host-owned services through shell-provided resolvers so the section
 * renders honestly on unconfigured hosts, where local-only Froglight keeps
 * working.
 *
 * Identity rule: the Firebase UID is the account identity;
 * email is credential-only and never an ownership identity. The UI never
 * displays a UID as a login name — it shows the email when known.
 */

import { useState } from 'react';
import type { AccountService } from '@froglight/foundation/account';
import type { AccountIdentityService } from '@froglight/foundation';
import { Button } from './Button.jsx';
import { useAccountSnapshot } from './useAccount.jsx';
import sectionStyles from './SettingsView.module.css';
import styles from './AccountSettingsView.module.css';

export interface AccountSettingsViewProps {
  /**
   * Shell resolvers for the host-owned services; null without a provider.
   * Must return stable instances across renders (the probes do) — the
   * snapshot hooks subscribe per instance.
   */
  readonly resolveAccount: () => AccountService | null;
  readonly resolveIdentity: () => AccountIdentityService | null;
  readonly presentation?: 'settings' | 'dialog';
}

/**
 * User-facing copy for stable account codes. Names the problem and the
 * recovery; never leaks Firebase/SDK wording.
 */
export function accountErrorCopy(code: string): string {
  switch (code) {
    case 'NOT_CONFIGURED':
      return 'Accounts aren’t set up in this build yet. Froglight works fully offline without one.';
    case 'INVALID_EMAIL':
      return 'Enter a valid email address.';
    case 'INVALID_PASSWORD':
      return 'Use a password of at least 6 characters.';
    case 'EMAIL_IN_USE':
      return 'That email already has an account. Try signing in instead.';
    case 'USER_NOT_FOUND':
      return 'No account uses that email. Check it, or create an account.';
    case 'WRONG_PASSWORD':
      return 'That password doesn’t match. Try again.';
    case 'NETWORK':
      return 'Couldn’t reach the account service. Check your connection and try again.';
    case 'UNAUTHENTICATED':
      return 'Sign in first.';
    case 'UNSUPPORTED':
      return 'Accounts aren’t available on this host yet.';
    default:
      return 'Something went wrong. Try again.';
  }
}

function errorCodeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = (error as Record<string, unknown>).code;
    if (typeof code === 'string') return code;
  }
  return 'UNKNOWN';
}

type Mode = 'signIn' | 'create';

export function AccountSettingsView(
  props: AccountSettingsViewProps,
): React.ReactElement {
  const { resolveAccount, resolveIdentity, presentation = 'settings' } = props;
  const service = resolveAccount();
  const identity = resolveIdentity();
  const { snapshot } = useAccountSnapshot(service);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<Mode>('signIn');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  if (service === null) {
    return (
      <div
        className={sectionStyles['settings-section']}
        data-fl-component="account-settings"
        data-state="unavailable"
      >
        {presentation === 'settings' ? (
          <h2 className={sectionStyles['settings-section-title']}>Account</h2>
        ) : null}
        <p className={styles['account-lede']}>
          Accounts aren’t set up in this build yet. Froglight works fully
          offline without one — your vaults stay on this device.
        </p>
      </div>
    );
  }

  const user = snapshot.user;

  // Unconfigured hosts: the store reports NOT_CONFIGURED via
  // restore() while local Froglight keeps working. Render the honest
  // local-only copy instead of a sign-in form that could never submit.
  if (user === null && snapshot.error?.code === 'NOT_CONFIGURED') {
    return (
      <div
        className={sectionStyles['settings-section']}
        data-fl-component="account-settings"
        data-state="unavailable"
      >
        {presentation === 'settings' ? (
          <h2 className={sectionStyles['settings-section-title']}>Account</h2>
        ) : null}
        <p className={styles['account-lede']}>
          Accounts aren’t set up in this build yet. Froglight works fully
          offline without one — your vaults stay on this device.
        </p>
      </div>
    );
  }

  if (user !== null) {
    return (
      <div
        className={sectionStyles['settings-section']}
        data-fl-component="account-settings"
        data-state="signed-in"
      >
        {presentation === 'settings' ? (
          <h2 className={sectionStyles['settings-section-title']}>Account</h2>
        ) : null}
        <div className={styles['account-identity']}>
          <span>Signed in as</span>
          <strong data-testid="account-email">{user.email ?? 'account'}</strong>
        </div>
        <p className={styles['account-hint']}>
          Your synced vaults and Froglight Pro subscription belong to this
          account.
        </p>
        {notice !== null ? (
          <p
            role="alert"
            className={styles['account-notice']}
            data-kind="error"
          >
            {notice}
          </p>
        ) : null}
        <div className={styles['account-signout']}>
          <h3>Sign out of this device</h3>
          <p className={styles['account-hint']}>
            Sync will stop. Your local vaults stay on this device and remain
            available offline.
          </p>
          <div className={styles['account-actions']}>
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              data-testid="account-sign-out"
              onClick={() => {
                setBusy(true);
                setNotice(null);
                // Ordered sign-out: the coordinator stops sync,
                // clears the purchase identity, then signs out of Firebase.
                // Falls back to a direct sign-out when the coordinator fiber
                // is dormant (e.g. web without a purchase provider).
                const run =
                  identity !== null ? identity.signOut() : service.signOut();
                void run
                  .catch((error: unknown) => {
                    setNotice(accountErrorCopy(errorCodeOf(error)));
                  })
                  .finally(() => {
                    setBusy(false);
                  });
              }}
            >
              {busy ? 'Signing out…' : 'Sign out'}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const canSubmit =
    !busy &&
    email.trim().length > 0 &&
    password.length > 0 &&
    (snapshot.ready || snapshot.error !== null);

  return (
    <div
      className={sectionStyles['settings-section']}
      data-fl-component="account-settings"
      data-state="signed-out"
      aria-busy={snapshot.loading || busy}
    >
      {presentation === 'settings' ? (
        <>
          <h2 className={sectionStyles['settings-section-title']}>Account</h2>
          <p className={styles['account-lede']}>
            Accounts are optional — Froglight works fully offline without one.
            Sign in to buy Froglight Pro and sync selected vaults between your
            devices.
          </p>
        </>
      ) : null}
      <div
        className={styles['account-mode-row']}
        role="group"
        aria-label="Account mode"
      >
        <Button
          type="button"
          variant={mode === 'signIn' ? 'primary' : 'ghost'}
          aria-pressed={mode === 'signIn'}
          data-testid="account-mode-sign-in"
          onClick={() => {
            setMode('signIn');
            setNotice(null);
          }}
        >
          Sign in
        </Button>
        <Button
          type="button"
          variant={mode === 'create' ? 'primary' : 'ghost'}
          aria-pressed={mode === 'create'}
          data-testid="account-mode-create"
          onClick={() => {
            setMode('create');
            setNotice(null);
          }}
        >
          Create account
        </Button>
      </div>
      <label className={styles['account-field']}>
        <span>Email</span>
        <input
          type="email"
          autoComplete="email"
          data-testid="account-email-input"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </label>
      <label className={styles['account-field']}>
        <span>Password</span>
        <input
          type="password"
          autoComplete={mode === 'create' ? 'new-password' : 'current-password'}
          data-testid="account-password-input"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>
      {notice !== null ? (
        <p role="alert" className={styles['account-notice']} data-kind="error">
          {notice}
        </p>
      ) : null}
      <div className={styles['account-actions']}>
        <Button
          type="button"
          variant="primary"
          disabled={!canSubmit}
          data-testid={
            mode === 'create'
              ? 'account-create-submit'
              : 'account-sign-in-submit'
          }
          onClick={() => {
            setBusy(true);
            setNotice(null);
            const run =
              mode === 'create'
                ? service.createAccount(email, password)
                : service.signIn(email, password);
            void run
              .then(() => {
                setPassword('');
              })
              .catch((error: unknown) => {
                setNotice(accountErrorCopy(errorCodeOf(error)));
              })
              .finally(() => {
                setBusy(false);
              });
          }}
        >
          {busy
            ? mode === 'create'
              ? 'Creating…'
              : 'Signing in…'
            : mode === 'create'
              ? 'Create account'
              : 'Sign in'}
        </Button>
      </div>
    </div>
  );
}
