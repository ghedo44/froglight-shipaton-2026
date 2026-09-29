/**
 * Tests for the document kind registry.
 *
 * Kinds are registered through the registry with codec functions; the
 * registry is provider-neutral (no editor/DOM/fs types). Registration is a
 * reversible effect via the returned disposer.
 */

import { describe, expect, it } from 'vitest';
import {
  InMemoryDocumentRegistry,
  locationFor,
  newDocumentId,
  newResourceId,
  refFor,
  resolvePathFor,
  type DecodedDocument,
  type DocumentKindDescriptor,
  type DocumentRef,
} from './documents.js';
import {
  documentId,
  documentKindId,
  resourceId,
  type ResourceId,
} from './identity.js';
import { workspacePath } from './paths.js';
import { FroglightError, isFroglightError } from './errors.js';

const kindId = documentKindId('froglight.test');

function makeKind(id = kindId): DocumentKindDescriptor<{ readonly n: number }> {
  return {
    id,
    decode: (data): DecodedDocument<{ readonly n: number }> => {
      const n = Number(new TextDecoder().decode(data));
      return { model: { n }, metadata: { n }, relationships: [] };
    },
    encode: (model): Uint8Array => new TextEncoder().encode(String(model.n)),
  };
}

function refForKind(): DocumentRef {
  return {
    documentId: documentId('doc-1'),
    kindId,
    location: { resourceId: resourceId('res-1') },
  };
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

describe('InMemoryDocumentRegistry', () => {
  it('resolves import aliases from registered kinds and withdraws them with the owner', () => {
    const registry = new InMemoryDocumentRegistry();
    const kind = { ...makeKind(), importExtensions: ['.tex', '.ltx'] };
    const registration = registry.register(kind);
    expect(registry.forImportExtension('.TEX')).toBe(kind);
    expect(registry.forImportExtension('.ltx')).toBe(kind);
    expect(registry.forImportExtension('.md')).toBeNull();
    registration.dispose();
    expect(registry.forImportExtension('.tex')).toBeNull();
  });

  it('registers, gets, and lists kinds', () => {
    const registry = new InMemoryDocumentRegistry();
    const kind = makeKind();
    registry.register(kind);
    expect(registry.get(kindId)).toBe(kind);
    expect(registry.list()).toEqual([kind]);
  });

  it('throws DUPLICATE_DOCUMENT_KIND on id collision', () => {
    const registry = new InMemoryDocumentRegistry();
    registry.register(makeKind());
    expectCode(() => registry.register(makeKind()), 'DUPLICATE_DOCUMENT_KIND');
  });

  it('throws UNKNOWN_DOCUMENT_KIND for missing kinds', () => {
    const registry = new InMemoryDocumentRegistry();
    expectCode(
      () => registry.get(documentKindId('missing')),
      'UNKNOWN_DOCUMENT_KIND',
    );
  });

  it('registration disposer removes the kind (lifecycle-owned)', () => {
    const registry = new InMemoryDocumentRegistry();
    const dispose = registry.register(makeKind());
    expect(registry.list()).toHaveLength(1);
    dispose.dispose();
    expect(registry.list()).toHaveLength(0);
    // Re-registration is possible after disposal.
    registry.register(makeKind());
    expect(registry.list()).toHaveLength(1);
  });

  it('exposes an independent creator only while its plugin kind is registered', () => {
    const registry = new InMemoryDocumentRegistry();
    const changes: number[] = [];
    const subscription = registry.onDidChange(() =>
      changes.push(registry.list().length),
    );
    const pluginKind = {
      ...makeKind(),
      creation: {
        label: 'Plugin page',
        extension: '.plugin',
        createInitialModel: (title: string) => ({ n: title.length }),
      },
    };
    const registration = registry.register(pluginKind);
    expect(registry.get(kindId).creation?.createInitialModel('hello')).toEqual({
      n: 5,
    });
    registration.dispose();
    expect(registry.recognize(kindId)).toBeNull();
    registry.register(pluginKind);
    expect(registry.get(kindId).creation?.label).toBe('Plugin page');
    expect(changes).toEqual([1, 0, 1]);
    subscription.dispose();
  });

  it('recognize matches by id by default', () => {
    const registry = new InMemoryDocumentRegistry();
    const kind = makeKind();
    registry.register(kind);
    expect(registry.recognize(kindId)).toBe(kind);
    expect(registry.recognize('other')).toBeNull();
    expect(registry.recognize(null)).toBeNull();
  });

  it('recognize honors a custom hook', () => {
    const registry = new InMemoryDocumentRegistry();
    const kind = makeKind();
    const registered = {
      ...kind,
      recognize: (id: unknown) => id === 'alias' || id === kindId,
    };
    registry.register(registered);
    expect(registry.recognize('alias')).toBe(registered);
    expect(registry.recognize(kindId)).toBe(registered);
    expect(registry.recognize('nope')).toBeNull();
  });

  it('registered kinds codec round-trips models', () => {
    const registry = new InMemoryDocumentRegistry();
    const kind = makeKind();
    registry.register(kind);
    const ref = refForKind();
    const bytes = kind.encode({ n: 42 }, ref);
    expect(kind.decode(bytes, ref).model).toEqual({ n: 42 });
  });

  it('thrown errors are FroglightErrors with a stable code', () => {
    const registry = new InMemoryDocumentRegistry();
    registry.register(makeKind());
    try {
      registry.register(makeKind());
      expect.unreachable();
    } catch (error) {
      expect(isFroglightError(error)).toBe(true);
      expect(error).toBeInstanceOf(FroglightError);
      expect((error as FroglightError).code).toBe('DUPLICATE_DOCUMENT_KIND');
    }
  });
});

describe('identity/ref helpers', () => {
  it('newDocumentId/newResourceId generate fresh branded ids', () => {
    expect(newDocumentId()).not.toBe(newDocumentId());
    expect(newResourceId()).not.toBe(newResourceId());
  });

  it('refFor builds a whole-resource ref', () => {
    const ref = refFor(documentId('d'), kindId, resourceId('r'));
    expect(ref).toEqual({
      documentId: 'd',
      kindId: 'froglight.test',
      location: { resourceId: 'r' },
    });
  });

  it('locationFor / resolvePathFor round-trip through a path mapping', () => {
    const registry = new InMemoryDocumentRegistry();
    registry.register(makeKind());
    const ref = refFor(documentId('d'), kindId, resourceId('r'));
    const byResource = new Map([
      [ref.location.resourceId, workspacePath('notes/a.md')],
    ]);
    const resolve = (id: ResourceId) => byResource.get(id);
    expect(resolvePathFor(resolve, ref.location.resourceId)).toBe('notes/a.md');
    expect(locationFor(ref.location.resourceId)).toEqual({ resourceId: 'r' });
  });
});
