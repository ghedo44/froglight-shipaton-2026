import { expect, it } from 'vitest';
import { documentKindId } from '../identity.js';
import { InMemoryDocumentEditorRegistry, type DocumentEditorProvider } from './registry.js';

it('rolls back failed acquisition for every kind and notifies all observers', () => {
  const registry = new InMemoryDocumentEditorRegistry();
  const kinds = [documentKindId('first'), documentKindId('second')];
  const first: DocumentEditorProvider = {
    id: 'original', kindIds: kinds,
    createEditor: () => ({
      focus() { /* no presentation in this registry test */ },
      hasFocus: () => false, execCommand: () => false,
      destroy() { /* no owned presentation */ },
    }),
  };
  const replacement = { ...first, id: 'replacement' };
  const original = registry.register(first);
  const failure = new Error('factory failed');
  const throwing = registry.onDidChange(() => {
    if (registry.get(kinds[0]!) === replacement) throw failure;
  });
  const seen: (string | null)[] = [];
  registry.onDidChange(() => seen.push(registry.get(kinds[0]!)?.id ?? null));
  expect(() => registry.register(replacement)).toThrow(failure);
  expect(kinds.map(kind => registry.get(kind))).toEqual([first, first]);
  expect(registry.list()).toEqual([first]);
  expect(seen).toEqual(['replacement', 'original']);
  throwing.dispose();
  const retry = registry.register(replacement);
  registry.onDidChange(() => { throw new Error('withdrawal observer failed'); });
  let lastObserverCalls = 0;
  registry.onDidChange(() => { lastObserverCalls++; });
  expect(() => retry.dispose()).not.toThrow();
  retry.dispose();
  expect(lastObserverCalls).toBe(1);
  expect(kinds.map(kind => registry.get(kind))).toEqual([first, first]);
  original.dispose();
  expect(registry.list()).toEqual([]);
  expect(lastObserverCalls).toBe(2);
});
