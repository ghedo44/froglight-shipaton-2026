/**
 * Shared Emulator Suite harness for Security Rules tests.
 *
 * Tests run under `pnpm test:emulators`, which starts Firestore + Storage
 * emulators for a `demo-*` project and executes vitest inside
 * `firebase emulators:exec`. Emulator hosts are discovered from the
 * standard environment variables (set automatically by `emulators:exec`)
 * with fallbacks to `firebase.json` ports, so the suite also works
 * against manually started emulators. No production project, no secrets.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';

const here = dirname(fileURLToPath(import.meta.url));

export const PROJECT_ID =
  process.env.FIREBASE_PROJECT_ID ?? 'demo-froglight-sync-test';

function hostPort(
  envVar: string,
  fallbackPort: number,
): {
  host: string;
  port: number;
} {
  const raw = process.env[envVar];
  if (raw !== undefined) {
    const separator = raw.lastIndexOf(':');
    if (separator > 0) {
      const port = Number(raw.slice(separator + 1));
      if (Number.isInteger(port)) {
        return { host: raw.slice(0, separator), port };
      }
    }
  }
  return { host: '127.0.0.1', port: fallbackPort };
}

export async function setupTestEnvironment(): Promise<RulesTestEnvironment> {
  return initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: readFileSync(join(here, '..', 'firestore.rules'), 'utf8'),
      ...hostPort('FIRESTORE_EMULATOR_HOST', 8080),
    },
    storage: {
      rules: readFileSync(join(here, '..', 'storage.rules'), 'utf8'),
      ...hostPort('FIREBASE_STORAGE_EMULATOR_HOST', 9199),
    },
  });
}

/** Stable test identities. UIDs stand in for Firebase Auth UIDs. */
export const UID_ALICE = 'uid-alice';
export const UID_BOB = 'uid-bob';

/** Trusted Pro claim, as written server-side by the RevenueCat Extension. */
export const PRO_CLAIMS = { revenueCatEntitlements: ['pro'] } as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Gate storage tests on the emulator actually enforcing the rules under
 * test (both directions: unauthenticated denied AND Pro allowed). The
 * Storage emulator can serve requests before freshly pushed rules take
 * effect on a cold boot; without this gate that warmup race surfaces as
 * flaky allows/denies. Polls briefly, then throws — a persistent failure
 * here means the rules or emulator are broken, never "try again".
 */
export async function waitForStorageRulesReady(
  env: RulesTestEnvironment,
): Promise<void> {
  const { ref, uploadBytes } = await import('firebase/storage');
  const probe = `users/${UID_ALICE}/vaults/__probe__/blobs/${'0'.repeat(64)}`;
  const deadline = Date.now() + 20000;
  let lastError: unknown = new Error('storage emulator gave up immediately');
  while (Date.now() < deadline) {
    try {
      let denied = false;
      try {
        await uploadBytes(
          ref(env.unauthenticatedContext().storage(), probe),
          new Uint8Array([1]),
        );
      } catch {
        denied = true;
      }
      if (!denied) throw new Error('storage rules not enforced yet');
      await uploadBytes(
        ref(env.authenticatedContext(UID_ALICE, PRO_CLAIMS).storage(), probe),
        new Uint8Array([1]),
      );
      return;
    } catch (error) {
      lastError = error;
      await sleep(500);
    }
  }
  throw lastError;
}
