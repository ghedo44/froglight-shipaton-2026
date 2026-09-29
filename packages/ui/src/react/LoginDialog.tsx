import { DialogHeader, DialogBody } from './DialogParts.jsx';
import { Dialog } from './primitives/Dialog.jsx';
import type { DialogHandle } from './primitives/Dialog.jsx';
import { useEffect, useLayoutEffect, useRef } from 'react';
import type { AccountIdentityService } from '@froglight/foundation';
import type { AccountService } from '@froglight/foundation/account';
import { AccountSettingsView } from './AccountSettingsView.jsx';
import { FrogMark } from './FrogMark.jsx';
import { Button, IconButton } from './Button.jsx';
import { useAccountSnapshot } from './useAccount.jsx';
import { useAboveKeyboard } from './useAboveKeyboard.js';
import styles from './LoginDialog.module.css';

export function LoginDialog(props: {
  readonly resolveAccount: () => AccountService | null;
  readonly resolveIdentity: () => AccountIdentityService | null;
  readonly onClose: () => void;
}): React.ReactElement {
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<DialogHandle | null>(null);
  const glideRef = useAboveKeyboard<HTMLElement>();
  const account = props.resolveAccount();
  const { snapshot } = useAccountSnapshot(account);
  const unavailable =
    account === null || snapshot.error?.code === 'NOT_CONFIGURED';

  useEffect(() => {
    if (snapshot.user !== null) closeRef.current?.close();
  }, [snapshot.user, props.onClose]);

  useLayoutEffect(() => {
    const coarse =
      typeof window.matchMedia === 'function' &&
      (window.matchMedia('(pointer: coarse)').matches ||
        window.matchMedia('(any-pointer: coarse)').matches);
    const target = coarse
      ? dialogRef.current?.querySelector<HTMLElement>(
          '[aria-label="Close sign in"]',
        )
      : dialogRef.current?.querySelector<HTMLElement>(
          '[data-testid="account-email-input"]',
        );
    target?.focus({ preventScroll: true });
  }, []);

  return (
    <Dialog open closeRef={closeRef}
      className={styles.backdrop}
      data-testid="login-dialog-backdrop"
      onClose={() => props.onClose()}
    >
      <Dialog.Content unstyled
        ref={(node) => {
          dialogRef.current = node;
          glideRef(node);
        }}
        className={styles.dialog}
        aria-labelledby="login-dialog-title"
      >
        <DialogHeader className={styles.header}>
          <IconButton
            icon="close"
            label="Close sign in"
            title="Close sign in"
            className={styles.close}
            onClick={() => closeRef.current?.close()}
          />
          <div className={styles.mark}>
            <FrogMark />
          </div>
          <h2 id="login-dialog-title">Welcome to Froglight</h2>
        </DialogHeader>
        <DialogBody className={styles.content}>
          <p className={styles.intro}>
            Sign in to sync your vaults across devices. Your local vaults are
            always available.
          </p>
          <AccountSettingsView
            presentation="dialog"
            resolveAccount={() => account}
            resolveIdentity={props.resolveIdentity}
          />
          {unavailable ? (
            <div
              className={styles.unavailableForm}
              aria-label="Sign in unavailable"
            >
              <label>
                Email
                <input type="email" autoComplete="email" disabled />
              </label>
              <label>
                Password
                <input
                  type="password"
                  autoComplete="current-password"
                  disabled
                />
              </label>
              <Button type="button" variant="primary" disabled>
                Sign in
              </Button>
            </div>
          ) : null}
        </DialogBody>
      </Dialog.Content>
    </Dialog>
  );
}
