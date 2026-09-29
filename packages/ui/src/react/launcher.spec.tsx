// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  accountToken,
  MemoryVault,
  workspacePath,
} from '@froglight/foundation';
import type {
  AccountService,
  AccountSnapshot,
} from '@froglight/foundation/account';
import { definePlugin } from '@froglight/runtime';
import { mountFroglightApp, type WorkbenchMount } from '../workbench.js';
import {
  createHarness,
  makeChoice,
  settle,
  until,
  click,
  type Harness,
} from './test-support.js';
import styles from './LauncherView.module.css';
import settingsStyles from './SettingsModal.module.css';
import backupStyles from './VaultBackupSettingsView.module.css';
import workspaceStyles from './WorkspaceView.module.css';

describe('vault launcher behaviors (mount seam)', () => {
  let harness: Harness | null = null;
  let mounted: WorkbenchMount | null = null;

  afterEach(async () => {
    if (mounted !== null) {
      await act(async () => {
        await mounted!.dispose();
      });
      mounted = null;
    }
    await harness?.dispose();
    harness = null;
  });

  async function start(...choices: ReturnType<typeof makeChoice>[]) {
    const h = await createHarness(choices);
    const root = document.createElement('div');
    document.body.appendChild(root);
    h.root = root;
    await act(async () => {
      mounted = await mountFroglightApp(root, h.controller, h.adapter, h.ui);
    });
    return h;
  }

  it('maps every asserted class through the CSS module', () => {
    for (const name of [
      'recent-vault-card',
      'recent-vault-text',
      'recent-vault-row',
      'recent-vault-forget',
      'recent-vault-empty',
      'vault-launcher-actions',
      'vault-launcher-message',
      'vault-modal',
    ]) {
      expect(styles[name], `module class ${name}`).toMatch(/\S/);
    }
  });

  it('orders recent vaults by most recently opened', async () => {
    const older = {
      ...makeChoice({ id: 'old', name: 'Old Vault' }),
      lastOpenedAt: 100,
    };
    const newer = {
      ...makeChoice({ id: 'new', name: 'New Vault' }),
      lastOpenedAt: 900,
    };
    const h = await start(older, newer);
    await until(
      () =>
        h.root.querySelectorAll(`.${styles['recent-vault-card']}`).length === 2,
    );
    const names = [
      ...h.root.querySelectorAll(`.${styles['recent-vault-text']} strong`),
    ].map((element) => element.textContent);
    expect(names).toEqual(['New Vault', 'Old Vault']);
  });

  it('forgetting a vault removes its card through the host adapter', async () => {
    const keep = makeChoice({ id: 'keep', name: 'Keep' });
    const drop = makeChoice({ id: 'drop', name: 'Drop' });
    const h = await start(keep, drop);
    await until(
      () =>
        h.root.querySelectorAll(`.${styles['recent-vault-card']}`).length === 2,
    );
    await click(
      h.root,
      `.${styles['recent-vault-row']}:nth-child(2) .${styles['recent-vault-forget']}`,
    );
    await until(() => h.adapter.forgotten.includes('drop'));
    await until(
      () =>
        h.root.querySelectorAll(`.${styles['recent-vault-card']}`).length === 1,
    );
    expect(
      h.root.querySelector(`.${styles['recent-vault-text']} strong`)
        ?.textContent,
    ).toBe('Keep');
  });

  it('shows an empty hint when no recents remain', async () => {
    const h = await start();
    await until(
      () => h.root.querySelector(`.${styles['recent-vault-empty']}`) !== null,
    );
    expect(
      h.root.querySelector(`.${styles['recent-vault-empty']}`)?.textContent,
    ).toContain('No local vaults');
  });

  it('opens general settings and restores backups only from the launcher', async () => {
    const h = await start(makeChoice({ id: 'v1', name: 'My Vault' }));
    await click(h.root, '[data-testid="launcher-settings-button"]');
    expect(
      document.body.querySelector('[data-fl-component="settings-modal"]'),
    ).not.toBeNull();
    await click(document.body, '[data-section-id="froglight.backups"]');
    expect(document.body.textContent).toContain('Restore a vault');
    expect(document.body.textContent).toContain('Restore backup');
    await until(
      () =>
        document.body.querySelectorAll(`.${backupStyles.vaultRow}`).length ===
        1,
    );
    expect(document.body.textContent).toContain('My Vault');
    expect(document.body.textContent).toContain('Back up selected');

    await click(document.body, '[aria-label="Close settings"]');
    await click(h.root, '[data-testid="open-recent-vault-button-0"]');
    await until(
      () => h.root.querySelector(`.${workspaceStyles['fl-activity']}`) !== null,
    );
    await click(h.root, '[data-activity="settings"]');
    await click(document.body, '[data-section-id="froglight.backups"]');
    const content = document.body.querySelector(
      `.${settingsStyles['settings-content']}`,
    );
    expect(content?.textContent).toContain('Back up selected (1)');
    expect(content?.textContent).not.toContain('Restore backup');
  });

  it('opens a focused email and password dialog from the launcher login button', async () => {
    const h = await createHarness();
    harness = h;
    const account: AccountService = {
      snapshot: () => ({
        ready: true,
        loading: false,
        user: null,
        error: null,
      }),
      subscribe: () => () => undefined,
      restore: async () => undefined,
      createAccount: async (email) => ({ id: 'uid-1', email }),
      signIn: async (email) => ({ id: 'uid-1', email }),
      signOut: async () => undefined,
      refreshToken: async () => ({
        token: null,
        expiresAt: null,
        entitlements: [],
      }),
    };
    await h.runtime.registerSlot({
      id: 'test-login-account',
      plugin: definePlugin({
        id: 'test.login-account',
        activate: (ctx) => {
          ctx.provide(accountToken, account);
        },
      }),
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    h.root = root;
    await act(async () => {
      mounted = await mountFroglightApp(root, h.controller, h.adapter, h.ui);
    });
    await click(h.root, '[data-testid="launcher-account-button"]');
    const dialog = document.body.querySelector(
      '[data-testid="login-dialog-backdrop"] [role="dialog"]',
    );
    expect(dialog).not.toBeNull();
    expect(
      dialog?.querySelector('[data-testid="account-email-input"]'),
    ).not.toBeNull();
    expect(
      dialog?.querySelector('[data-testid="account-password-input"]'),
    ).not.toBeNull();
    expect(
      document.body.querySelector('[data-fl-component="settings-modal"]'),
    ).toBeNull();
  });

  it('selects several vaults for backup without opening them', async () => {
    const first = makeChoice({ id: 'one', name: 'Research' });
    const second = makeChoice({ id: 'two', name: 'Journal' });
    const h = await start(first, second);
    await click(h.root, '[data-testid="launcher-settings-button"]');
    await click(document.body, '[data-section-id="froglight.backups"]');
    await until(
      () =>
        document.body.querySelectorAll(`.${backupStyles.vaultRow}`).length ===
        2,
    );
    const button = document.body.querySelector<HTMLButtonElement>(
      `.${settingsStyles['settings-content']} [data-fl-component="button"][data-variant="primary"]`,
    );
    expect(button?.disabled).toBe(true);
    await click(
      document.body,
      `.${backupStyles.selectionActions} button:first-child`,
    );
    expect(button?.textContent).toContain('(2)');
    expect(button?.disabled).toBe(false);
    expect(first.activations).toBe(0);
    expect(second.activations).toBe(0);
    await click(
      document.body,
      `.${backupStyles.selectionActions} button:last-child`,
    );
    expect(button?.disabled).toBe(true);
  });

  it('downloads one backup for each selected vault', async () => {
    const first = makeChoice({ id: 'one', name: 'Research' });
    const second = makeChoice({ id: 'two', name: 'Journal' });
    const h = await start(first, second);
    const opened: string[] = [];
    h.adapter.openForBackup = async (id) => {
      opened.push(id);
      return new MemoryVault();
    };
    const oldCreate = URL.createObjectURL;
    const oldRevoke = URL.revokeObjectURL;
    URL.createObjectURL = () => 'blob:backup-test';
    URL.revokeObjectURL = () => undefined;
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    try {
      await click(h.root, '[data-testid="launcher-settings-button"]');
      await click(document.body, '[data-section-id="froglight.backups"]');
      await until(
        () =>
          document.body.querySelectorAll(`.${backupStyles.vaultRow}`).length ===
          2,
      );
      await click(
        document.body,
        `.${backupStyles.selectionActions} button:first-child`,
      );
      await click(
        document.body,
        `.${settingsStyles['settings-content']} [data-fl-component="button"][data-variant="primary"]`,
      );
      await until(() => anchorClick.mock.calls.length === 2);
      expect(opened).toEqual(['one', 'two']);
      expect(first.activations).toBe(0);
      expect(second.activations).toBe(0);
    } finally {
      anchorClick.mockRestore();
      URL.createObjectURL = oldCreate;
      URL.revokeObjectURL = oldRevoke;
    }
  });

  it('shows file-reading progress while a selected vault is being backed up', async () => {
    const h = await start(makeChoice({ id: 'one', name: 'Research' }));
    const source = new MemoryVault();
    await source.write(workspacePath('note.md'), new Uint8Array([1, 2, 3]));
    const read = source.read.bind(source);
    const releaseRead: { current: () => void } = { current: () => undefined };
    const gate = new Promise<void>((resolve) => {
      releaseRead.current = () => resolve();
    });
    source.read = async (...args) => {
      await gate;
      return read(...args);
    };
    h.adapter.openForBackup = async () => source;
    const oldCreate = URL.createObjectURL;
    const oldRevoke = URL.revokeObjectURL;
    URL.createObjectURL = () => 'blob:backup-test';
    URL.revokeObjectURL = () => undefined;
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    try {
      await click(h.root, '[data-testid="launcher-settings-button"]');
      await click(document.body, '[data-section-id="froglight.backups"]');
      await until(
        () =>
          document.body.querySelectorAll(`.${backupStyles.vaultRow}`).length ===
          1,
      );
      await click(document.body, `.${backupStyles.vaultRow} input`);
      await click(
        document.body,
        `.${settingsStyles['settings-content']} [data-fl-component="button"][data-variant="primary"]`,
      );
      await until(
        () =>
          document.body
            .querySelector(`.${backupStyles.progress}`)
            ?.textContent?.includes('Reading files') === true,
      );
      expect(
        document.body.querySelector('progress[aria-label="Backup progress"]'),
      ).not.toBeNull();
      releaseRead.current();
      await until(
        () =>
          document.body.querySelector(
            `.${backupStyles.notice}[data-kind="success"]`,
          ) !== null,
      );
      expect(anchorClick).toHaveBeenCalledTimes(1);
    } finally {
      releaseRead.current();
      anchorClick.mockRestore();
      URL.createObjectURL = oldCreate;
      URL.revokeObjectURL = oldRevoke;
    }
  });

  it('shows the signed-in email and signs out from its account menu', async () => {
    const h = await createHarness();
    harness = h;
    let user: AccountSnapshot['user'] = {
      id: 'uid-1',
      email: 'ada@example.com',
    };
    const listeners = new Set<(snapshot: AccountSnapshot) => void>();
    const snapshot = (): AccountSnapshot => ({
      ready: true,
      loading: false,
      user,
      error: null,
    });
    const account: AccountService = {
      snapshot,
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      async restore() {
        return undefined;
      },
      async createAccount() {
        throw new Error('unused');
      },
      async signIn() {
        throw new Error('unused');
      },
      async signOut() {
        user = null;
        for (const listener of listeners) listener(snapshot());
      },
      async refreshToken() {
        return { token: null, expiresAt: null, entitlements: [] };
      },
    };
    await h.runtime.registerSlot({
      id: 'test-launcher-account',
      plugin: definePlugin({
        id: 'test.launcher-account',
        activate: (ctx) => {
          ctx.provide(accountToken, account);
        },
      }),
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    h.root = root;
    await act(async () => {
      mounted = await mountFroglightApp(root, h.controller, h.adapter, h.ui);
    });

    const trigger = h.root.querySelector(
      '[data-testid="launcher-account-button"]',
    );
    expect(trigger?.textContent).toContain('ada@example.com');
    await click(h.root, '[data-testid="launcher-account-button"]');
    await click(
      h.root,
      `.${styles['launcher-account-menu'].split(' ').join('.')} button`,
    );
    await until(() => trigger?.textContent?.includes('Log in') === true);
  });

  it('create-vault modal gates creation on name and location', async () => {
    const h = await start();
    await act(async () => {
      h.root
        .querySelector<HTMLButtonElement>(
          `.${styles['vault-launcher-actions']} [data-fl-component="button"][data-variant="primary"]`,
        )
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
    });
    const modal = document.body.querySelector(
      `.${styles['vault-modal'].split(' ').join('.')}`,
    );
    expect(modal).not.toBeNull();
    // Global overlay contract: the fixed backdrop must be outside
    // #app so iOS visual-viewport pan compensation cannot turn the app root
    // into its fixed containing block. The backdrop then self-translates
    // against the real viewport while its card is registered above keyboard.
    const backdrop = document.body.querySelector(
      '[data-testid="create-vault-modal-backdrop"]',
    ) as HTMLElement | null;
    expect(backdrop).not.toBeNull();
    expect(h.root.contains(backdrop!)).toBe(false);
    expect(backdrop!.hasAttribute('data-fl-viewport-overlay')).toBe(true);
    // No name and no location yet: disabled.
    const createButton = modal!.querySelector<HTMLButtonElement>(
      '[data-fl-component="button"][data-variant="primary"]',
    );
    expect(createButton!.disabled).toBe(true);
  });

  it('contains keyboard focus, closes on Escape, and restores the trigger', async () => {
    const h = await start();
    const trigger = h.root.querySelector<HTMLButtonElement>(
      `.${styles['vault-launcher-actions']} [data-fl-component="button"][data-variant="primary"]`,
    );
    if (trigger === null) throw new Error('create-vault trigger is missing');
    trigger.focus();
    await act(async () => {
      trigger.click();
      await settle();
    });
    const modal = document.body.querySelector<HTMLElement>(
      `.${styles['vault-modal'].split(' ').join('.')}`,
    )!;
    expect(modal.contains(document.activeElement)).toBe(true);

    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
      await settle();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 280));
    });
    expect(
      document.body.querySelector(
        `.${styles['vault-modal'].split(' ').join('.')}`,
      ),
    ).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('releases modality and focus while the create dialog exits', async () => {
    const h = await start();
    const trigger = h.root.querySelector<HTMLButtonElement>(
      `.${styles['vault-launcher-actions']} [data-fl-component="button"][data-variant="primary"]`,
    );
    if (trigger === null) throw new Error('create-vault trigger is missing');
    trigger.focus();
    await act(async () => {
      trigger.click();
      await settle();
    });
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
      await settle();
    });
    const dialog = document.body.querySelector<HTMLElement>(
      `.${styles['vault-modal'].split(' ').join('.')}`,
    );
    expect(
      document.body
        .querySelector('[data-testid="create-vault-modal-backdrop"]')
        ?.hasAttribute('data-closing'),
    ).toBe(true);
    expect(dialog?.hasAttribute('inert')).toBe(true);
    expect(dialog?.hasAttribute('aria-modal')).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it('surfaces activation failures as launcher messages', async () => {
    const failing = makeChoice({ id: 'bad', name: 'Bad Vault' });
    failing.activate = async () => {
      throw new Error('disk unavailable');
    };
    const h = await start(failing);
    await until(
      () =>
        h.root.querySelectorAll(`.${styles['recent-vault-card']}`).length === 1,
    );
    await click(h.root, `.${styles['recent-vault-card']}`);
    await until(() =>
      (
        h.root.querySelector(`.${styles['vault-launcher-message']}`)
          ?.textContent ?? ''
      ).includes('disk unavailable'),
    );
    expect(h.controller.calls.initialize).toBe(0);
  });
});
