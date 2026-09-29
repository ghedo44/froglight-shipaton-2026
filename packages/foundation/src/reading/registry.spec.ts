import { describe, expect, it } from 'vitest';
import { documentKindId, type DocumentKindId } from '../identity.js';
import {
  InMemoryDocumentReaderRegistry,
  type DocumentReaderProvider,
} from './registry.js';

function stubReader(
  id: string,
  kindIds: readonly DocumentKindId[],
): DocumentReaderProvider & { calls: { updates: number; destroys: number } } {
  const calls = { updates: 0, destroys: 0 };
  return {
    id,
    kindIds,
    calls,
    createReader() {
      return {
        update() {
          calls.updates += 1;
        },
        destroy() {
          calls.destroys += 1;
        },
      };
    },
  };
}

describe('InMemoryDocumentReaderRegistry', () => {
  it('resolves a reader by document kind id', () => {
    const registry = new InMemoryDocumentReaderRegistry();
    const markdown = documentKindId('froglight.markdown');
    const provider = stubReader('markdown-reader', [markdown]);
    const registration = registry.register(provider);
    expect(registry.get(markdown)).toBe(provider);
    expect(registry.list()).toEqual([provider]);
    registration.dispose();
    expect(registry.get(markdown)).toBeNull();
  });

  it('lets later registrations shadow earlier ones and restores on dispose', () => {
    const registry = new InMemoryDocumentReaderRegistry();
    const latex = documentKindId('froglight.latex');
    const first = stubReader('latex-reader-a', [latex]);
    const second = stubReader('latex-reader-b', [latex]);
    const disposeFirst = registry.register(first);
    const disposeSecond = registry.register(second);
    expect(registry.get(latex)).toBe(second);
    disposeSecond.dispose();
    expect(registry.get(latex)).toBe(first);
    disposeFirst.dispose();
    expect(registry.get(latex)).toBeNull();
  });

  it('returns null for kinds without a reader (native-readonly fallback)', () => {
    const registry = new InMemoryDocumentReaderRegistry();
    expect(registry.get(documentKindId('froglight.blockpage'))).toBeNull();
  });
});


it('owns disposable change listeners across shadow, withdrawal, and reactivation', () => {
  const registry = new InMemoryDocumentReaderRegistry();
  const kind = documentKindId('froglight.latex');
  const first = stubReader('first', [kind]);
  const next = stubReader('next', [kind]);
  const seen: (string | null)[] = [];
  const subscription = registry.onDidChange(ids => {
    expect(ids).toEqual([kind]);
    seen.push(registry.get(kind)?.id ?? null);
  });
  const a = registry.register(first);
  const b = registry.register(next);
  b.dispose();
  b.dispose();
  a.dispose();
  const c = registry.register(first);
  expect(seen).toEqual(['first', 'next', 'first', null, 'first']);
  subscription.dispose();
  subscription.dispose();
  c.dispose();
  expect(seen).toHaveLength(5);
});

it('rolls back failed registration notifications and informs every listener of restoration', () => {
  const registry = new InMemoryDocumentReaderRegistry();
  const kind = documentKindId('test');
  const first = stubReader('first', [kind]);
  const replacement = stubReader('replacement', [kind]);
  const original = registry.register(first);
  const throwing = registry.onDidChange(() => {
    if (registry.get(kind) === replacement) throw new Error('factory failed');
  });
  const seen: (string | null)[] = [];
  registry.onDidChange(() => { seen.push(registry.get(kind)?.id ?? null); });
  expect(() => registry.register(replacement)).toThrow('factory failed');
  expect(registry.list()).toEqual([first]);
  expect(seen.at(-1)).toBe('first');
  throwing.dispose();
  const retry = registry.register(replacement);
  expect(registry.get(kind)).toBe(replacement);
  // A throwing withdrawal observer must not prevent effect cleanup or other observers.
  registry.onDidChange(() => { throw new Error('observer failed'); });
  expect(() => retry.dispose()).not.toThrow();
  expect(registry.get(kind)).toBe(first);
  original.dispose();
  expect(registry.list()).toEqual([]);
});
