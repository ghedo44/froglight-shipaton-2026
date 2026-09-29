/**
 * Tests for `DocumentSession` — the editor-neutral session contract.
 *
 * A session binds one open document to its storage: model, dirty/error
 * state, save/reload/close, persistent revisions, and post-commit hooks.
 * Storage failures never reject `save()`; they surface in the result and
 * transition the session to `error`.
 */

import { describe, expect, it } from 'vitest';
import { DocumentSessionImpl, type SaveResult } from './session.js';
import { createMemoryVault, type VaultFailureInjector } from './vault/memory.js';
import { ensureDirectory } from './vault/helpers.js';
import { documentId, documentKindId, resourceId } from './identity.js';
import { parentPath, workspacePath, type WorkspacePath } from './paths.js';
import { utf8Encode } from './encoding.js';
import { VaultRevisionService } from './revisions.js';
import { checksumOf } from './revisions.js';
import { FroglightError, isFroglightError } from './errors.js';
import { requireValue } from './testing/require-value.js';
import type { DocumentRef } from './documents.js';

const RES = resourceId('res-1');
const PATH = workspacePath('notes/a.md');

interface TestModel {
  text: string;
  nested?: { label: string };
}

function makeKind() {
  return {
    id: documentKindId('froglight.test'),
    decode: (data: Uint8Array) => ({ model: { text: new TextDecoder().decode(data) }, metadata: {}, relationships: [] }),
    encode: (model: TestModel) => utf8Encode(model.text),
  };
}

function makeSession(options: {
  vault?: ReturnType<typeof createMemoryVault>['vault'];
  kind?: ReturnType<typeof makeKind> & {
    decodeAsync?: (
      data: Uint8Array,
      ref: DocumentRef,
      isCurrent: () => boolean,
    ) => Promise<{ model: TestModel; metadata: Record<string, unknown>; relationships: unknown[] } | null>;
    encodeAsync?: (
      model: TestModel,
      ref: DocumentRef,
      isCurrent: () => boolean,
    ) => Promise<Uint8Array | null>;
    projectCommitted?: (model: TestModel, ref: DocumentRef) => unknown;
  };
  writeGate?: { readonly onWrite: () => void; readonly wait: Promise<void> };
  revisions?: boolean;
  onClosed?: () => void;
  fail?: VaultFailureInjector;
} = {}) {
  const created = createMemoryVault({ fail: options.fail });
  const vault = options.vault ?? created.vault;
  const kind = options.kind ?? makeKind();
  const writeGate = options.writeGate;
  const sessionVault = writeGate === undefined
    ? vault
    : new Proxy(vault, {
        get(target, property) {
          if (property === 'write') {
            return async (path: WorkspacePath, data: Uint8Array) => {
              writeGate.onWrite();
              await writeGate.wait;
              return target.write(path, data);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
  const ref = {
    documentId: documentId('doc-1'),
    kindId: documentKindId('froglight.test'),
    location: { resourceId: RES },
  };
  const revisions = options.revisions === false ? null : new VaultRevisionService({
    vault,
    resolveResource: () => PATH,
  });
  const session = new DocumentSessionImpl<TestModel>({
    ref,
    kind,
    vault: sessionVault,
    revisions,
    resolveResourcePath: (id) => (id === RES ? PATH : undefined),
    onClosed: options.onClosed,
  });
  return { vault, session };
}

/** Write a file, creating parent directories first (portable helper). */
async function writeFile(
  vault: ReturnType<typeof createMemoryVault>['vault'],
  path: WorkspacePath,
  data: Uint8Array,
): Promise<void> {
  const parent = parentPath(path);
  if (parent !== null) {
    await ensureDirectory(vault, parent);
  }
  await vault.write(path, data);
}

/** Assert that `fn` throws a FroglightError with the given code. */
function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.unreachable('expected the call to throw');
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

describe('DocumentSession open/reload', () => {
  it('cancels asynchronous decode when the session closes', async () => {
    let finish!: () => void;
    let decodeCurrent: (() => boolean) | undefined;
    const kind = {
      ...makeKind(),
      decodeAsync: async (_data: Uint8Array, _ref: DocumentRef, isCurrent: () => boolean) => {
        decodeCurrent = isCurrent;
        await new Promise<void>((resolve) => { finish = resolve; });
        return isCurrent()
          ? { model: { text: 'decoded' }, metadata: {}, relationships: [] }
          : null;
      },
    };
    const { vault, session } = makeSession({ kind });
    await writeFile(vault, PATH, utf8Encode('stored'));
    const opening = session.open();
    await Promise.resolve();
    expect(session.state).toBe('opening');
    expect(decodeCurrent?.()).toBe(true);
    await session.close();
    expect(decodeCurrent?.()).toBe(false);
    finish();
    await opening;
    expect(session.state).toBe('closed');
  });
  it('opens by decoding the stored resource into the model', async () => {
    const { vault, session } = makeSession();
    await writeFile(vault, PATH, utf8Encode('hello'));
    await session.open();
    expect(session.state).toBe('open');
    expect(session.dirty).toBe(false);
    expect(session.model.text).toBe('hello');
  });

  it('open failure transitions to error and throws', async () => {
    const { session } = makeSession();
    try {
      await session.open();
      expect.unreachable();
    } catch (error) {
      expect(session.state).toBe('error');
      expect(isFroglightError(error)).toBe(true);
    }
  });

  it('open twice is a no-op once open', async () => {
    const { vault, session } = makeSession();
    await writeFile(vault, PATH, utf8Encode('hello'));
    await session.open();
    await session.open();
    expect(session.state).toBe('open');
  });

  it('onDidChangeDirty fires on transitions, not on redundant marks', async () => {
    const { vault, session } = makeSession();
    await writeFile(vault, PATH, utf8Encode('stored'));
    await session.open();
    const seen: boolean[] = [];
    const subscription = session.onDidChangeDirty((dirty) => seen.push(dirty));
    session.markDirty();
    session.markDirty();
    expect(seen).toEqual([true]);
    await session.save();
    expect(seen).toEqual([true, false]);
    subscription.dispose();
    session.markDirty();
    expect(seen).toEqual([true, false]);
  });

  it('reload discards unsaved changes', async () => {
    const { vault, session } = makeSession();
    await writeFile(vault, PATH, utf8Encode('stored'));
    await session.open();
    session.model.text = 'unsaved edit';
    session.markDirty();
    await writeFile(vault, PATH, utf8Encode('stored-v2'));
    await session.reload();
    expect(session.model.text).toBe('stored-v2');
    expect(session.dirty).toBe(false);
    expect(session.state).toBe('open');
  });

  it('reload failure transitions to error and throws', async () => {
    const { vault, session } = makeSession();
    await writeFile(vault, PATH, utf8Encode('stored'));
    await session.open();
    await vault.remove(PATH);
    try {
      await session.reload();
      expect.unreachable();
    } catch (error) {
      expect(session.state).toBe('error');
      expect(isFroglightError(error)).toBe(true);
    }
  });

  it('open on an unknown resource throws UNKNOWN_RESOURCE', async () => {
    const { vault } = createMemoryVault();
    const kind = makeKind();
    const ref = {
      documentId: documentId('doc-1'),
      kindId: documentKindId('froglight.test'),
      location: { resourceId: resourceId('res-gone') },
    };
    const session = new DocumentSessionImpl<TestModel>({
      ref,
      kind,
      vault,
      revisions: null,
      resolveResourcePath: () => undefined,
    });
    try {
      await session.open();
      expect.unreachable();
    } catch (error) {
      expect((error as FroglightError).code).toBe('UNKNOWN_RESOURCE');
    }
  });
});

describe('DocumentSession close and admitted writes', () => {
  it('waits for a vault write already admitted by save before closing', async () => {
    let entered!: () => void;
    let release!: () => void;
    const writeEntered = new Promise<void>((resolve) => { entered = resolve; });
    const writeGate = {
      onWrite: () => entered(),
      wait: new Promise<void>((resolve) => { release = resolve; }),
    };
    const { vault, session } = makeSession({ writeGate });
    await writeFile(vault, PATH, utf8Encode('stored'));
    await session.open();
    session.model.text = 'committed before close';
    session.markDirty();

    const saving = session.save();
    await writeEntered;
    let closed = false;
    const closing = session.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await Promise.all([saving, closing]);
    expect(closed).toBe(true);
    expect(new TextDecoder().decode(await vault.read(PATH))).toBe('committed before close');
  });

  it('finishes close and owner cleanup when an admitted write fails', async () => {
    let entered!: () => void;
    let failWrite!: (error: Error) => void;
    const writeEntered = new Promise<void>((resolve) => { entered = resolve; });
    const writeGate = {
      onWrite: () => entered(),
      wait: new Promise<void>((_resolve, reject) => { failWrite = reject; }),
    };
    let closedCount = 0;
    const { vault, session } = makeSession({ writeGate, onClosed: () => { closedCount++; } });
    await writeFile(vault, PATH, utf8Encode('stored'));
    await session.open();
    session.model.text = 'will fail';
    session.markDirty();
    const saving = session.save();
    await writeEntered;
    const closing = session.close();
    failWrite(new Error('disk failed'));
    await Promise.all([saving, closing]);
    expect(session.state).toBe('closed');
    expect(closedCount).toBe(1);
  });
});

describe('DocumentSession save', () => {
  it('finishes a stable snapshot while edits continue during encoding', async () => {
    let signalStarted!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { signalStarted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const kind = {
      ...makeKind(),
      encodeAsync: async (model: TestModel, _ref: DocumentRef, isCurrent: () => boolean) => {
        calls++;
        if (calls === 1) {
          signalStarted();
          await gate;
        }
        return isCurrent() ? utf8Encode(model.text) : null;
      },
    };
    const { vault, session } = makeSession({ kind });
    await writeFile(vault, PATH, utf8Encode('stored'));
    await session.open();
    session.model.text = 'first snapshot';
    session.markDirty();

    const saving = session.save();
    await entered;
    session.model.text = 'latest snapshot';
    session.markDirty();
    release();

    const result = await saving;
    expect(result.committed).toBe(true);
    expect(calls).toBe(1);
    expect(new TextDecoder().decode(await vault.read(PATH))).toBe('first snapshot');
    expect(session.dirty).toBe(true);
    expect((await session.save()).committed).toBe(true);
    expect(new TextDecoder().decode(await vault.read(PATH))).toBe('latest snapshot');
    expect(session.dirty).toBe(false);
  });

  it('does not commit or reopen when the session closes during cooperative encoding', async () => {
    let signalStarted!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { signalStarted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const kind = {
      ...makeKind(),
      encodeAsync: async (_model: TestModel, _ref: DocumentRef, isCurrent: () => boolean) => {
        signalStarted();
        await gate;
        return isCurrent() ? utf8Encode('new') : null;
      },
    };
    const { vault, session } = makeSession({ kind });
    await writeFile(vault, PATH, utf8Encode('stored'));
    await session.open();
    session.model.text = 'new';
    session.markDirty();
    const saving = session.save();
    await entered;
    await session.close();
    release();

    const result = await saving;
    expect(result.committed).toBe(false);
    expect(session.state).toBe('closed');
    expect(new TextDecoder().decode(await vault.read(PATH))).toBe('stored');
  });

  it('keeps the canonical commit when a derived projection fails', async () => {
    const failure = new Error('projection failed');
    const kind = { ...makeKind(), projectCommitted: () => { throw failure; } };
    const { vault, session } = makeSession({ kind });
    await writeFile(vault, PATH, utf8Encode('stored'));
    await session.open();
    session.model.text = 'committed';
    session.markDirty();

    const result = await session.save();
    expect(result.committed).toBe(true);
    expect(result.error).toBeNull();
    expect(result.derivedError).toBe(failure);
    expect(new TextDecoder().decode(await vault.read(PATH))).toBe('committed');
    expect(session.state).toBe('open');
  });

  it('detaches nested committed projection values before the vault write yields', async () => {
    let signalWrite!: () => void;
    let releaseWrite!: () => void;
    const writeStarted = new Promise<void>((resolve) => { signalWrite = resolve; });
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const kind = {
      ...makeKind(),
      projectCommitted: (model: TestModel) => ({
        metadata: { properties: { nested: model.nested } },
        relationships: [],
      }),
    };
    const { vault, session } = makeSession({
      kind,
      revisions: false,
      writeGate: { onWrite: signalWrite, wait: writeGate },
    });
    await writeFile(vault, PATH, utf8Encode('stored'));
    await session.open();
    session.model.text = 'saved';
    const nested = { label: 'committed' };
    session.model.nested = nested;
    session.markDirty();
    let observedProjection: unknown;
    session.onPostCommit((_result, _data, projection) => {
      observedProjection = projection;
    });

    const saving = session.save();
    await writeStarted;
    nested.label = 'newer unsaved edit';
    session.markDirty();
    releaseWrite();
    const result = await saving;

    expect(result.committed).toBe(true);
    expect(session.dirty).toBe(true);
    expect(
      (observedProjection as { metadata: { properties: { nested: { label: string } } } })
        .metadata.properties.nested.label,
    ).toBe('committed');
  });

  it('saves the model to the canonical resource and records a revision', async () => {
    const { vault, session } = makeSession();
    await writeFile(vault, PATH, utf8Encode('stored'));
    await session.open();
    session.model.text = 'edited';
    session.markDirty();
    const result = await session.save();
    expect(result.committed).toBe(true);
    expect(result.error).toBeNull();
    expect(result.derivedError).toBeNull();
    expect(result.revision).not.toBeNull();
    expect(session.lastSavedRevision).toBe(requireValue(result.revision).revisionId);
    expect(session.dirty).toBe(false);
    expect(session.state).toBe('open');
    expect(new TextDecoder().decode(await vault.read(PATH))).toBe('edited');
  });

  it('save never rejects on storage failure: reports error and enters error state', async () => {
    // Fail writes only after the setup file is in place.
    let failWrites = false;
    const { vault, session } = makeSession({
      fail: (op) => (op === 'write' && failWrites ? new Error('disk full') : null),
    });
    await writeFile(vault, PATH, utf8Encode('stored'));
    await session.open();
    failWrites = true;
    session.model.text = 'edited';
    session.markDirty();
    const result = await session.save();
    expect(result.committed).toBe(false);
    expect(result.error).not.toBeNull();
    expect(session.lastError).not.toBeNull();
    expect(session.state).toBe('error');
    // The failed save did not mark the model clean.
    expect(session.dirty).toBe(true);
  });

  it('save with revisions disabled reports revision null', async () => {
    const { vault, session } = makeSession({ revisions: false });
    await writeFile(vault, PATH, utf8Encode('stored'));
    await session.open();
    const result = await session.save();
    expect(result.committed).toBe(true);
    expect(result.revision).toBeNull();
    expect(session.lastSavedRevision).toBeNull();
  });

  it('post-commit listener failures become derivedError, not commit failure', async () => {
    const { vault, session } = makeSession();
    await writeFile(vault, PATH, utf8Encode('stored'));
    await session.open();
    session.onPostCommit(() => {
      throw new Error('listener boom');
    });
    const result = await session.save();
    expect(result.committed).toBe(true);
    expect(result.derivedError).not.toBeNull();
    expect(session.lastDerivedError).not.toBeNull();
    expect(session.state).toBe('open');
    expect(new TextDecoder().decode(await vault.read(PATH))).toBe('stored');
  });

  it('onPostCommit listeners observe the committed result', async () => {
    const { vault, session } = makeSession();
    await writeFile(vault, PATH, utf8Encode('stored'));
    await session.open();
    // Wrapper object: property narrowing is invalidated by the closure
    // assignment, so the observed result stays observable.
    const observed: { result: SaveResult | null } = { result: null };
    session.onPostCommit((result) => {
      observed.result = result;
    });
    await session.save();
    expect(observed.result?.committed).toBe(true);
  });

  it('onStateChange reports the full lifecycle', async () => {
    const { vault, session } = makeSession();
    await writeFile(vault, PATH, utf8Encode('stored'));
    const states: string[] = [];
    session.onStateChange((state) => states.push(state));
    await session.open();
    await session.save();
    await session.close();
    expect(states).toEqual(['opening', 'open', 'saving', 'open', 'closing', 'closed']);
  });

  it('onStateChange listener errors propagate to the triggering operation', async () => {
    const { vault, session } = makeSession();
    await writeFile(vault, PATH, utf8Encode('stored'));
    session.onStateChange(() => {
      throw new Error('listener boom');
    });
    await expect(session.open()).rejects.toThrow('listener boom');
    // The listener error interrupts the transition: the session remains in
    // the state it was entering ('opening'), never reaching 'open'.
    expect(session.state).toBe('opening');
  });

  it('save asserts the session is open (SESSION_BUSY)', async () => {
    const { session } = makeSession();
    expect(session.canRetrySave).toBe(false);
    await expect(session.save()).rejects.toMatchObject({ code: 'SESSION_BUSY' });
  });
});

describe('DocumentSession dirty/close', () => {
  it('markDirty requires an open session (SESSION_BUSY)', async () => {
    const { session } = makeSession();
    expectCode(() => session.markDirty(), 'SESSION_BUSY');
  });

  it('close is idempotent and invokes onClosed once', async () => {
    const { vault } = makeSession();
    await writeFile(vault, PATH, utf8Encode('stored'));
    let closed = 0;
    // Reuse the same vault so the session can open the stored resource.
    const { session } = makeSession({ vault, onClosed: () => { closed += 1; } });
    await session.open();
    await session.close();
    await session.close();
    expect(session.state).toBe('closed');
    expect(closed).toBe(1);
  });

  it('reopen after close works (session is reusable)', async () => {
    const { vault, session } = makeSession();
    await writeFile(vault, PATH, utf8Encode('v1'));
    await session.open();
    await session.close();
    await writeFile(vault, PATH, utf8Encode('v2'));
    await session.open();
    expect(session.model.text).toBe('v2');
    expect(session.state).toBe('open');
  });
});

describe('DocumentSession revision integration', () => {
  it('each save appends a revision, newest first', async () => {
    const { vault, session } = makeSession();
    await writeFile(vault, PATH, utf8Encode('v1'));
    await session.open();
    session.model.text = 'v2';
    session.markDirty();
    await session.save();
    session.model.text = 'v3';
    session.markDirty();
    await session.save();
    const svc = new VaultRevisionService({ vault, resolveResource: () => PATH });
    const revisions = await svc.listRevisions(documentId('doc-1'));
    expect(revisions).toHaveLength(2);
    expect(requireValue(revisions[0], 'first revision').documentId).toBe('doc-1');
  });
});

describe('editing during an asynchronous save', () => {
  it('preserves edits made after encoding and serializes a follow-up save', async () => {
    const { vault, session } = makeSession({ revisions: false });
    await writeFile(vault, PATH, utf8Encode('stored'));
    await session.open();
    session.model.text = 'first';
    session.markDirty();
    const firstSave = session.save();
    session.model.text = 'second';
    expect(() => session.markDirty()).not.toThrow();
    const secondSave = session.save();
    expect((await firstSave).committed).toBe(true);
    expect((await secondSave).committed).toBe(true);
    expect(new TextDecoder().decode(await vault.read(PATH))).toBe('second');
    expect(session.dirty).toBe(false);
  });

  it('keeps unsaved edits dirty while post-commit work finishes', async () => {
    const { vault, session } = makeSession({ revisions: false });
    await writeFile(vault, PATH, utf8Encode('stored'));
    await session.open();
    session.model.text = 'first';
    session.markDirty();
    let signalEntered: () => void = () => undefined;
    let releaseSave: () => void = () => undefined;
    const entered = new Promise<void>(resolve => { signalEntered = resolve; });
    const release = new Promise<void>(resolve => { releaseSave = resolve; });
    const subscription = session.onPostCommit(async () => { signalEntered(); await release; });
    const saving = session.save();
    await entered;
    session.model.text = 'unsaved';
    expect(() => session.markDirty()).not.toThrow();
    releaseSave();
    await saving;
    expect(session.dirty).toBe(true);
    expect(new TextDecoder().decode(await vault.read(PATH))).toBe('first');
    subscription.dispose();
    await session.save();
    expect(new TextDecoder().decode(await vault.read(PATH))).toBe('unsaved');
  });
});

describe('DocumentSession contentRevision', () => {
  it('exposes the opened bytes revision once per open', async () => {
    const { vault, session } = makeSession({ revisions: false });
    expect(session.contentRevision).toBeNull();
    await writeFile(vault, PATH, utf8Encode('hello'));
    await session.open();
    expect(session.contentRevision).toBe(checksumOf(utf8Encode('hello')));
    expect(
      (
        session.openMetadata as Record<string, unknown>
      )['document.contentRevision'],
    ).toBe(session.contentRevision);
  });

  it('refreshes the revision on save and reload', async () => {
    const { vault, session } = makeSession({ revisions: false });
    await writeFile(vault, PATH, utf8Encode('v1'));
    await session.open();
    const opened = session.contentRevision;
    session.model.text = 'v2';
    session.markDirty();
    await session.save();
    expect(session.contentRevision).not.toBe(opened);
    await writeFile(vault, PATH, utf8Encode('v3-external'));
    await session.reload();
    expect(session.contentRevision).not.toBe(opened);
    expect(
      (
        session.openMetadata as Record<string, unknown>
      )['document.contentRevision'],
    ).toBe(session.contentRevision);
  });
});


describe('DocumentSession content notifications', () => {
  it('emits every edited model including dirty/saving edits, separately from dirty edges', async () => {
    const { vault, session } = makeSession({ revisions: false });
    await writeFile(vault, PATH, utf8Encode('stored'));
    await session.open();
    const content: string[] = [];
    const dirty: boolean[] = [];
    const sub = session.onDidChangeContent(() => content.push(session.model.text));
    const dirtySub = session.onDidChangeDirty(value => dirty.push(value));
    session.model.text = 'first';
    session.markDirty();
    session.model.text = 'second';
    session.markDirty();
    const saving = session.save();
    expect(session.state).toBe('saving');
    session.model.text = 'during save';
    session.markDirty();
    await saving;
    expect(content).toEqual(['first', 'second', 'during save']);
    expect(dirty).toEqual([true]);
    expect(session.dirty).toBe(true);
    sub.dispose();
    sub.dispose();
    session.model.text = 'after disposal';
    session.markDirty();
    await session.save();
    expect(content).toHaveLength(3);
    expect(dirty).toEqual([true, false]);
    dirtySub.dispose();
    await session.close();
  });
});

describe('transient save recovery', () => {
  it('retries the retained dirty model without reads or advancing revisions on failure', async () => {
    const { session, vault } = makeSession();
    await writeFile(vault, PATH, utf8Encode('stored'));
    await session.open();
    const model = session.model;
    const base = session.contentRevision;
    model.text = 'unsaved';
    session.markDirty();
    const write = vault.write.bind(vault);
    const read = vault.read.bind(vault);
    let reads = 0;
    let attempts = 0;
    const failure = new FroglightError('IO', 'transient write failure');
    vault.read = async path => { if (path === PATH) reads++; return read(path); };
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vault.write = async (path, bytes) => {
      if (path === PATH && ++attempts === 1) throw failure;
      if (path === PATH) await gate;
      return write(path, bytes);
    };
    const failed = await session.save();
    expect(failed.committed).toBe(false);
    expect(session.state).toBe('error');
    expect(session.lastError).toBe(failure);
    expect(session.canRetrySave).toBe(true);
    expect(session.model).toBe(model);
    expect(session.dirty).toBe(true);
    expect(session.contentRevision).toBe(base);
    expect(session.lastSavedRevision).toBeNull();
    model.text = 'retained dirty content';
    session.markDirty();
    const retry = session.save();
    const concurrent = session.save();
    expect(session.lastError).toBe(failure);
    expect(session.dirty).toBe(true);
    release();
    expect((await retry).committed).toBe(true);
    expect((await concurrent).committed).toBe(true);
    expect(attempts).toBe(2);
    expect(reads).toBe(0);
    expect(session.state).toBe('open');
    expect(session.canRetrySave).toBe(false);
    expect(session.lastError).toBeNull();
    expect(session.dirty).toBe(false);
    expect(session.model).toBe(model);
    expect(session.contentRevision).toBe(checksumOf(utf8Encode('retained dirty content')));
    expect(session.lastSavedRevision).not.toBeNull();
    expect(new TextDecoder().decode(await read(PATH))).toBe('retained dirty content');
    await session.close();
  });

  it('does not retry a conflict write or alter its base revision', async () => {
    const { session, vault } = makeSession({ revisions: false });
    await writeFile(vault, PATH, utf8Encode('base'));
    await session.open();
    const base = session.contentRevision;
    session.model.text = 'local'; session.markDirty();
    let writes = 0;
    vault.write = async () => { writes++; throw new FroglightError('CONFLICT', 'base mismatch'); };
    expect((await session.save()).committed).toBe(false);
    expect(session.canRetrySave).toBe(false);
    await expect(session.save()).rejects.toMatchObject({ code: 'SESSION_BUSY' });
    expect(() => session.markDirty()).toThrow();
    expect(writes).toBe(1);
    expect(session.contentRevision).toBe(base);
    expect(session.model.text).toBe('local');
    expect(session.dirty).toBe(true);
  });

  it('does not retry an open failure even when its error is transient IO', async () => {
    const { session, vault } = makeSession();
    let writes = 0;
    vault.read = async () => { throw new FroglightError('IO', 'read failed'); };
    vault.write = async () => { writes++; };
    await expect(session.open()).rejects.toMatchObject({ code: 'IO' });
    expect(session.canRetrySave).toBe(false);
    await expect(session.save()).rejects.toMatchObject({ code: 'SESSION_BUSY' });
    expect(writes).toBe(0);
  });

  it('does not reuse save-retry eligibility after closing and failing to decode on reopen', async () => {
    const { vault } = createMemoryVault();
    const kind = makeKind();
    const session = new DocumentSessionImpl<TestModel>({ vault, kind,
      ref: { documentId: documentId('retry'), kindId: kind.id, location: { resourceId: RES } },
      revisions: null, resolveResourcePath: () => PATH });
    await writeFile(vault, PATH, utf8Encode('base'));
    await session.open(); session.model.text = 'dirty'; session.markDirty();
    const write = vault.write.bind(vault);
    vault.write = async () => { throw new Error('temporary write failure'); };
    await session.save();
    await session.close();
    vault.write = write;
    kind.decode = () => { throw new Error('invalid document'); };
    await expect(session.open()).rejects.toThrow('invalid document');
    expect(session.canRetrySave).toBe(false);
    await expect(session.save()).rejects.toMatchObject({ code: 'SESSION_BUSY' });
  });
});


it('allows input during a large save and keeps that newer edit dirty', async () => {
  const { vault, session } = makeSession({ revisions: false });
  await writeFile(vault, PATH, utf8Encode('initial'));
  await session.open();
  session.model.text = 'x'.repeat(8 * 1024 * 1024);
  session.markDirty();
  let inputAccepted = false;
  const input = setTimeout(() => {
    inputAccepted = true;
    session.model.text = 'newer input';
    session.markDirty();
  }, 0);
  try {
    const result = await session.save();
    expect(result.committed).toBe(true);
    expect(inputAccepted).toBe(true);
    expect(session.dirty).toBe(true);
    expect(session.contentRevision).toBe(checksumOf(await vault.read(PATH)));
    await session.save();
    await session.reload();
    expect(session.model.text).toBe('newer input');
  } finally {
    clearTimeout(input);
    await session.close();
  }
});
