/**
 * Firestore Security Rules conformance.
 *
 * Every case in the plan's emulator matrix:
 *
 * - unauthenticated reads denied
 * - user A cannot read user B's vaults
 * - non-Pro owner cannot write the sync HEAD
 * - Pro owner can write the sync HEAD
 * - non-Pro owner can still read the existing cloud vault (retention)
 * - wrong-UID path writes denied
 * - malformed/oversized metadata denied
 * - client-crafted `isPro` field is irrelevant without the trusted claim
 * - monotonic revisions enforced (stale replay denied)
 * - deletes denied even for Pro
 *
 * Auth contexts carry the `revenueCatEntitlements` custom claim exactly
 * as the RevenueCat Firebase Extension writes it server-side; no
 * extension, webhook, or production project is involved.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import {
  PRO_CLAIMS,
  UID_ALICE,
  UID_BOB,
  setupTestEnvironment,
} from './helpers.js';

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  testEnv = await setupTestEnvironment();
});

afterAll(async () => {
  await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
});

const HASH_A = `sha256:${'a'.repeat(64)}`;

function headPath(uid: string, vaultId: string): string {
  return `users/${uid}/vaults/${vaultId}`;
}

function validHead(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    protocolVersion: 1,
    name: 'University',
    revision: 1,
    manifestHash: HASH_A,
    manifestObject: `users/${UID_ALICE}/vaults/vault-1/manifests/1-${'a'.repeat(64)}.json`,
    fileCount: 3,
    totalBytes: 1234,
    createdAt: '2026-09-09T13:10:33.000Z',
    updatedAt: '2026-09-09T13:10:33.000Z',
    updatedByDeviceId: 'device-1',
    ...overrides,
  };
}

/** Seed a HEAD document bypassing rules (setup only, never the assertion). */
async function seedHead(
  uid: string,
  vaultId: string,
  head: Record<string, unknown>,
): Promise<void> {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), headPath(uid, vaultId)), head);
  });
}

describe('firestore vault HEAD rules', () => {
  it('denies unauthenticated reads', async () => {
    await seedHead(UID_ALICE, 'vault-1', validHead());
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, headPath(UID_ALICE, 'vault-1'))));
    await assertFails(getDocs(collection(db, `users/${UID_ALICE}/vaults`)));
  });

  it('denies unauthenticated writes', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(
      setDoc(doc(db, headPath(UID_ALICE, 'vault-1')), validHead()),
    );
  });

  it('denies cross-user reads', async () => {
    await seedHead(UID_ALICE, 'vault-1', validHead());
    const db = testEnv.authenticatedContext(UID_BOB, PRO_CLAIMS).firestore();
    await assertFails(getDoc(doc(db, headPath(UID_ALICE, 'vault-1'))));
    await assertFails(getDocs(collection(db, `users/${UID_ALICE}/vaults`)));
  });

  it('denies cross-user writes even with a Pro claim', async () => {
    const db = testEnv.authenticatedContext(UID_ALICE, PRO_CLAIMS).firestore();
    await assertFails(
      setDoc(doc(db, headPath(UID_BOB, 'vault-1')), validHead()),
    );
  });

  it('denies non-Pro owner writes', async () => {
    const db = testEnv.authenticatedContext(UID_ALICE).firestore();
    await assertFails(
      setDoc(doc(db, headPath(UID_ALICE, 'vault-1')), validHead()),
    );
  });

  it('denies writes with an empty entitlement claim', async () => {
    const db = testEnv
      .authenticatedContext(UID_ALICE, { revenueCatEntitlements: [] })
      .firestore();
    await assertFails(
      setDoc(doc(db, headPath(UID_ALICE, 'vault-1')), validHead()),
    );
  });

  it('denies writes with a wrong-typed entitlement claim', async () => {
    const db = testEnv
      .authenticatedContext(UID_ALICE, { revenueCatEntitlements: 'pro' })
      .firestore();
    await assertFails(
      setDoc(doc(db, headPath(UID_ALICE, 'vault-1')), validHead()),
    );
  });

  it('allows Pro owner create then read-back', async () => {
    const db = testEnv.authenticatedContext(UID_ALICE, PRO_CLAIMS).firestore();
    await assertSucceeds(
      setDoc(doc(db, headPath(UID_ALICE, 'vault-1')), validHead()),
    );
    const snap = await assertSucceeds(
      getDoc(doc(db, headPath(UID_ALICE, 'vault-1'))),
    );
    expect(snap.data()?.revision).toBe(1);
    const list = await assertSucceeds(
      getDocs(collection(db, `users/${UID_ALICE}/vaults`)),
    );
    expect(list.size).toBe(1);
  });

  it('allows non-Pro owner reads of the existing vault (retention)', async () => {
    await seedHead(UID_ALICE, 'vault-1', validHead());
    const db = testEnv.authenticatedContext(UID_ALICE).firestore();
    const snap = await assertSucceeds(
      getDoc(doc(db, headPath(UID_ALICE, 'vault-1'))),
    );
    expect(snap.data()?.name).toBe('University');
    await assertSucceeds(getDocs(collection(db, `users/${UID_ALICE}/vaults`)));
  });

  it('denies expired (non-Pro) owner updates while keeping reads', async () => {
    await seedHead(UID_ALICE, 'vault-1', validHead());
    const db = testEnv.authenticatedContext(UID_ALICE).firestore();
    await assertFails(
      updateDoc(doc(db, headPath(UID_ALICE, 'vault-1')), { revision: 2 }),
    );
    await assertSucceeds(getDoc(doc(db, headPath(UID_ALICE, 'vault-1'))));
  });

  it('enforces monotonic revisions on Pro updates', async () => {
    await seedHead(UID_ALICE, 'vault-1', validHead());
    const db = testEnv.authenticatedContext(UID_ALICE, PRO_CLAIMS).firestore();
    const ref = doc(db, headPath(UID_ALICE, 'vault-1'));
    await assertSucceeds(updateDoc(ref, { revision: 2 }));
    // Replay of the old revision and jumps are both denied.
    await assertFails(updateDoc(ref, { revision: 2 }));
    await assertFails(updateDoc(ref, { revision: 5 }));
    await assertSucceeds(updateDoc(ref, { revision: 3 }));
  });

  it('denies Pro creates at revision != 1', async () => {
    const db = testEnv.authenticatedContext(UID_ALICE, PRO_CLAIMS).firestore();
    await assertFails(
      setDoc(
        doc(db, headPath(UID_ALICE, 'vault-1')),
        validHead({ revision: 7 }),
      ),
    );
  });

  it('denies malformed metadata for Pro writers', async () => {
    const db = testEnv.authenticatedContext(UID_ALICE, PRO_CLAIMS).firestore();
    const cases: Array<[string, Record<string, unknown>]> = [
      ['bad protocol version', { protocolVersion: 2 }],
      ['zero revision', { revision: 0 }],
      ['non-integer revision', { revision: 1.5 }],
      ['bad manifest hash', { manifestHash: 'nope' }],
      ['empty name', { name: '' }],
      ['negative file count', { fileCount: -1 }],
      ['oversized file count', { fileCount: 100001 }],
      ['negative bytes', { totalBytes: -1 }],
      ['empty device id', { updatedByDeviceId: '' }],
      ['empty manifest object', { manifestObject: '' }],
    ];
    let index = 0;
    for (const [label, override] of cases) {
      const vaultId = `malformed-${index}`;
      index += 1;
      await assertFails(
        setDoc(doc(db, headPath(UID_ALICE, vaultId)), {
          ...validHead(),
          manifestObject: `users/${UID_ALICE}/vaults/${vaultId}/manifests/1-${'a'.repeat(64)}.json`,
          ...override,
        }),
        label,
      );
    }
  });

  it('denies cross-vault manifest pointers even for the Pro owner', async () => {
    // The HEAD pointer must address this vault's own manifests prefix so a
    // compromised writer cannot point one vault at another vault's (or
    // another user's) manifest object.
    const db = testEnv.authenticatedContext(UID_ALICE, PRO_CLAIMS).firestore();
    await assertFails(
      setDoc(doc(db, headPath(UID_ALICE, 'vault-1')), {
        ...validHead(),
        manifestObject: `users/${UID_ALICE}/vaults/vault-2/manifests/1-${'a'.repeat(64)}.json`,
      }),
    );
    await assertFails(
      setDoc(doc(db, headPath(UID_ALICE, 'vault-1')), {
        ...validHead(),
        manifestObject: `users/${UID_BOB}/vaults/vault-1/manifests/1-${'a'.repeat(64)}.json`,
      }),
    );
  });

  it('ignores client-crafted Pro flags without the trusted claim', async () => {
    // A hacked client can write anything into document fields; without the
    // server-issued custom claim the write must still fail.
    const db = testEnv.authenticatedContext(UID_ALICE).firestore();
    await assertFails(
      setDoc(doc(db, headPath(UID_ALICE, 'vault-1')), {
        ...validHead(),
        isPro: true,
        revenueCatEntitlements: ['pro'],
      }),
    );
  });

  it('denies deletes even for the Pro owner', async () => {
    await seedHead(UID_ALICE, 'vault-1', validHead());
    const db = testEnv.authenticatedContext(UID_ALICE, PRO_CLAIMS).firestore();
    await assertFails(deleteDoc(doc(db, headPath(UID_ALICE, 'vault-1'))));
  });

  it('rejects unknown field injection even for the Pro owner', async () => {
    const db = testEnv.authenticatedContext(UID_ALICE, PRO_CLAIMS).firestore();
    await assertFails(
      setDoc(doc(db, headPath(UID_ALICE, 'vault-unknown-field')), {
        ...validHead(),
        manifestObject: `users/${UID_ALICE}/vaults/vault-unknown-field/manifests/1-${'a'.repeat(64)}.json`,
        extraField: 'injected',
      }),
    );
  });

  it('rejects createdAt replacement on update', async () => {
    await seedHead(
      UID_ALICE,
      'vault-created',
      validHead({
        manifestObject: `users/${UID_ALICE}/vaults/vault-created/manifests/1-${'a'.repeat(64)}.json`,
      }),
    );
    const db = testEnv.authenticatedContext(UID_ALICE, PRO_CLAIMS).firestore();
    const ref = doc(db, headPath(UID_ALICE, 'vault-created'));
    await assertFails(
      setDoc(
        ref,
        {
          ...validHead(),
          manifestObject: `users/${UID_ALICE}/vaults/vault-created/manifests/2-${'b'.repeat(64)}.json`,
          revision: 2,
          manifestHash: `sha256:${'b'.repeat(64)}`,
          createdAt: '2030-01-01T00:00:00.000Z',
        },
        { merge: false },
      ),
    );
    // The stored document is untouched.
    const snap = await assertSucceeds(getDoc(ref));
    expect(snap.data()?.createdAt).toBe('2026-09-09T13:10:33.000Z');
  });

  it('rejects malformed timestamps', async () => {
    const db = testEnv.authenticatedContext(UID_ALICE, PRO_CLAIMS).firestore();
    await assertFails(
      setDoc(doc(db, headPath(UID_ALICE, 'vault-bad-ts')), {
        ...validHead(),
        manifestObject: `users/${UID_ALICE}/vaults/vault-bad-ts/manifests/1-${'a'.repeat(64)}.json`,
        createdAt: 12345,
      }),
    );
    await assertFails(
      setDoc(doc(db, headPath(UID_ALICE, 'vault-bad-ts2')), {
        ...validHead(),
        manifestObject: `users/${UID_ALICE}/vaults/vault-bad-ts2/manifests/1-${'a'.repeat(64)}.json`,
        updatedAt: null,
      }),
    );
  });

  it('rejects revision rollback and jumps beyond +1', async () => {
    await seedHead(
      UID_ALICE,
      'vault-rev',
      validHead({
        manifestObject: `users/${UID_ALICE}/vaults/vault-rev/manifests/1-${'a'.repeat(64)}.json`,
      }),
    );
    const db = testEnv.authenticatedContext(UID_ALICE, PRO_CLAIMS).firestore();
    const ref = doc(db, headPath(UID_ALICE, 'vault-rev'));
    // Rollback to revision 1 (same value) is denied as non-monotonic.
    await assertFails(updateDoc(ref, { revision: 1 }));
    // Jump to revision 3 skips history and is denied.
    await assertFails(updateDoc(ref, { revision: 3 }));
    // Exact +1 advances.
    await assertSucceeds(updateDoc(ref, { revision: 2 }));
  });

  it('rejects mismatched manifest metadata', async () => {
    const db = testEnv.authenticatedContext(UID_ALICE, PRO_CLAIMS).firestore();
    // Manifest hash not in sha256:hex form.
    await assertFails(
      setDoc(doc(db, headPath(UID_ALICE, 'vault-bad-hash')), {
        ...validHead(),
        manifestObject: `users/${UID_ALICE}/vaults/vault-bad-hash/manifests/1-${'a'.repeat(64)}.json`,
        manifestHash: 'sha256:xyz',
      }),
    );
    // Manifest object missing the revision-hash shape.
    await assertFails(
      setDoc(doc(db, headPath(UID_ALICE, 'vault-bad-object')), {
        ...validHead(),
        manifestObject:
          'users/uid/vaults/vault-bad-object/manifests/latest.json',
      }),
    );
  });

  it('denies user-level document access', async () => {
    const db = testEnv.authenticatedContext(UID_ALICE, PRO_CLAIMS).firestore();
    await assertFails(getDoc(doc(db, `users/${UID_ALICE}`)));
    await assertFails(setDoc(doc(db, `users/${UID_ALICE}`), { name: 'x' }));
  });

  it('denies everything outside the sync hierarchy', async () => {
    const db = testEnv.authenticatedContext(UID_ALICE, PRO_CLAIMS).firestore();
    await assertFails(getDoc(doc(db, 'other/collection-doc')));
  });
});
