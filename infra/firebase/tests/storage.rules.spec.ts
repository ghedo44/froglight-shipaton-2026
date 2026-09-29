/**
 * Storage Security Rules conformance.
 *
 * - unauthenticated uploads denied
 * - wrong-UID path uploads denied
 * - non-Pro owner uploads denied (blobs and manifests)
 * - Pro owner can upload valid blobs and manifests
 * - non-Pro owner can still download the existing replica (retention)
 * - malformed object names / content types / oversized manifests denied
 * - deletes denied even for Pro
 *
 * Same claim model as Firestore: the `revenueCatEntitlements` custom
 * claim stands in for the RevenueCat Extension's server-issued state.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  deleteObject,
  getBytes,
  listAll,
  ref,
  uploadBytes,
  type FirebaseStorage,
} from 'firebase/storage';
import {
  PRO_CLAIMS,
  UID_ALICE,
  UID_BOB,
  setupTestEnvironment,
  waitForStorageRulesReady,
} from './helpers.js';

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  testEnv = await setupTestEnvironment();
  await waitForStorageRulesReady(testEnv);
});

afterAll(async () => {
  await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearStorage();
});

const HEX_A = 'a'.repeat(64);
const VAULT = 'vault-1';

function blobPath(uid: string, vaultId: string, hash: string): string {
  return `users/${uid}/vaults/${vaultId}/blobs/${hash}`;
}

function manifestPath(uid: string, vaultId: string, file: string): string {
  return `users/${uid}/vaults/${vaultId}/manifests/${file}`;
}

function manifestFile(revision: number, hash: string): string {
  return `${revision}-${hash}.json`;
}

function manifestBytes(): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ format: 'froglight.sync-manifest', version: 1 }),
  );
}

/**
 * Seed an object bypassing rules (setup only, never the assertion).
 *
 * Seeding tests MUST use a dedicated vault id (never the shared `VAULT`):
 * `clearStorage()` does not remove objects written with rules disabled in
 * this harness, so a seed under the shared path would pollute every later
 * test that requires a fresh object (notably the first-upload and
 * immutability cases below).
 */
async function seedObject(
  path: string,
  bytes: Uint8Array,
  contentType?: string,
): Promise<void> {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const storage: FirebaseStorage = context.storage();
    await uploadBytes(
      ref(storage, path),
      bytes,
      contentType ? { contentType } : undefined,
    );
  });
}

describe('storage sync object rules', () => {
  it('denies unauthenticated uploads', async () => {
    const storage = testEnv.unauthenticatedContext().storage();
    await assertFails(
      uploadBytes(
        ref(storage, blobPath(UID_ALICE, VAULT, HEX_A)),
        new Uint8Array([1]),
      ),
    );
    await assertFails(
      uploadBytes(
        ref(storage, manifestPath(UID_ALICE, VAULT, manifestFile(1, HEX_A))),
        manifestBytes(),
        {
          contentType: 'application/json',
        },
      ),
    );
  });

  it('denies unauthenticated downloads', async () => {
    const vault = 'vault-seed-unauth';
    await seedObject(blobPath(UID_ALICE, vault, HEX_A), new Uint8Array([1]));
    const storage = testEnv.unauthenticatedContext().storage();
    await assertFails(
      getBytes(ref(storage, blobPath(UID_ALICE, vault, HEX_A))),
    );
  });

  it('denies cross-user uploads even with a Pro claim', async () => {
    const storage = testEnv
      .authenticatedContext(UID_ALICE, PRO_CLAIMS)
      .storage();
    await assertFails(
      uploadBytes(
        ref(storage, blobPath(UID_BOB, VAULT, HEX_A)),
        new Uint8Array([1]),
      ),
    );
    await assertFails(
      uploadBytes(
        ref(storage, manifestPath(UID_BOB, VAULT, manifestFile(1, HEX_A))),
        manifestBytes(),
        {
          contentType: 'application/json',
        },
      ),
    );
  });

  it('denies cross-user downloads', async () => {
    const vault = 'vault-seed-cross';
    await seedObject(blobPath(UID_ALICE, vault, HEX_A), new Uint8Array([1]));
    const storage = testEnv.authenticatedContext(UID_BOB, PRO_CLAIMS).storage();
    await assertFails(
      getBytes(ref(storage, blobPath(UID_ALICE, vault, HEX_A))),
    );
  });

  it('denies non-Pro owner uploads', async () => {
    const storage = testEnv.authenticatedContext(UID_ALICE).storage();
    await assertFails(
      uploadBytes(
        ref(storage, blobPath(UID_ALICE, VAULT, HEX_A)),
        new Uint8Array([1]),
      ),
    );
    await assertFails(
      uploadBytes(
        ref(storage, manifestPath(UID_ALICE, VAULT, manifestFile(1, HEX_A))),
        manifestBytes(),
        {
          contentType: 'application/json',
        },
      ),
    );
  });

  it('allows Pro owner blob upload then owner download (retention without Pro)', async () => {
    const pro = testEnv.authenticatedContext(UID_ALICE, PRO_CLAIMS).storage();
    const bytes = new TextEncoder().encode('vault bytes');
    await assertSucceeds(
      uploadBytes(ref(pro, blobPath(UID_ALICE, VAULT, HEX_A)), bytes),
    );

    // After expiry the owner can still recover the replica.
    const free = testEnv.authenticatedContext(UID_ALICE).storage();
    const downloaded = await assertSucceeds(
      getBytes(ref(free, blobPath(UID_ALICE, VAULT, HEX_A))),
    );
    // getBytes resolves an ArrayBuffer; compare byte-for-byte.
    expect(new Uint8Array(downloaded)).toEqual(bytes);
  });

  it('allows Pro owner manifest upload with JSON type then free-owner read', async () => {
    const pro = testEnv.authenticatedContext(UID_ALICE, PRO_CLAIMS).storage();
    const file = manifestFile(1, HEX_A);
    await assertSucceeds(
      uploadBytes(
        ref(pro, manifestPath(UID_ALICE, VAULT, file)),
        manifestBytes(),
        {
          contentType: 'application/json',
        },
      ),
    );
    const free = testEnv.authenticatedContext(UID_ALICE).storage();
    const downloaded = await assertSucceeds(
      getBytes(ref(free, manifestPath(UID_ALICE, VAULT, file))),
    );
    expect(new Uint8Array(downloaded)).toEqual(manifestBytes());
  });

  it('denies malformed blob names for Pro writers', async () => {
    const storage = testEnv
      .authenticatedContext(UID_ALICE, PRO_CLAIMS)
      .storage();
    await assertFails(
      uploadBytes(
        ref(storage, blobPath(UID_ALICE, VAULT, 'not-a-hash')),
        new Uint8Array([1]),
      ),
    );
    await assertFails(
      uploadBytes(
        ref(storage, blobPath(UID_ALICE, VAULT, 'sha256:abc')),
        new Uint8Array([1]),
      ),
    );
  });

  it('denies malformed manifest names and content types for Pro writers', async () => {
    const storage = testEnv
      .authenticatedContext(UID_ALICE, PRO_CLAIMS)
      .storage();
    await assertFails(
      uploadBytes(
        ref(storage, manifestPath(UID_ALICE, VAULT, 'notes.txt')),
        manifestBytes(),
        {
          contentType: 'application/json',
        },
      ),
    );
    await assertFails(
      uploadBytes(
        ref(storage, manifestPath(UID_ALICE, VAULT, manifestFile(1, HEX_A))),
        manifestBytes(),
        {
          contentType: 'text/plain',
        },
      ),
    );
  });

  it('denies oversized manifests for Pro writers', async () => {
    const storage = testEnv
      .authenticatedContext(UID_ALICE, PRO_CLAIMS)
      .storage();
    const oversized = new Uint8Array(8 * 1024 * 1024 + 1);
    await assertFails(
      uploadBytes(
        ref(storage, manifestPath(UID_ALICE, VAULT, manifestFile(1, HEX_A))),
        oversized,
        {
          contentType: 'application/json',
        },
      ),
    );
  });

  it('denies deletes even for the Pro owner', async () => {
    const vault = 'vault-seed-delete';
    await seedObject(blobPath(UID_ALICE, vault, HEX_A), new Uint8Array([1]));
    const storage = testEnv
      .authenticatedContext(UID_ALICE, PRO_CLAIMS)
      .storage();
    await assertFails(
      deleteObject(ref(storage, blobPath(UID_ALICE, vault, HEX_A))),
    );
  });

  it('denies overwriting an existing blob (immutability)', async () => {
    const storage = testEnv
      .authenticatedContext(UID_ALICE, PRO_CLAIMS)
      .storage();
    const path = blobPath(UID_ALICE, 'vault-immutable-blob', HEX_A);
    await assertSucceeds(uploadBytes(ref(storage, path), new Uint8Array([1])));
    await assertFails(uploadBytes(ref(storage, path), new Uint8Array([2])));
  });

  it('denies overwriting an existing manifest (immutability)', async () => {
    const storage = testEnv
      .authenticatedContext(UID_ALICE, PRO_CLAIMS)
      .storage();
    const path = manifestPath(
      UID_ALICE,
      'vault-immutable-manifest',
      manifestFile(1, HEX_A),
    );
    await assertSucceeds(
      uploadBytes(ref(storage, path), manifestBytes(), {
        contentType: 'application/json',
      }),
    );
    await assertFails(
      uploadBytes(ref(storage, path), manifestBytes(), {
        contentType: 'application/json',
      }),
    );
  });

  it('denies manifest deletes even for the Pro owner', async () => {
    const vault = 'vault-seed-manifest-delete';
    await seedObject(
      manifestPath(UID_ALICE, vault, manifestFile(1, HEX_A)),
      manifestBytes(),
      'application/json',
    );
    const storage = testEnv
      .authenticatedContext(UID_ALICE, PRO_CLAIMS)
      .storage();
    await assertFails(
      deleteObject(
        ref(storage, manifestPath(UID_ALICE, vault, manifestFile(1, HEX_A))),
      ),
    );
  });

  it('allows the owner to list their own sync prefix', async () => {
    const vault = 'vault-seed-list';
    await seedObject(blobPath(UID_ALICE, vault, HEX_A), new Uint8Array([1]));
    const storage = testEnv.authenticatedContext(UID_ALICE).storage();
    const listing = await assertSucceeds(
      listAll(ref(storage, `users/${UID_ALICE}/vaults/${vault}/blobs`)),
    );
    expect(listing.items.map((item) => item.name)).toEqual([HEX_A]);
  });
});
