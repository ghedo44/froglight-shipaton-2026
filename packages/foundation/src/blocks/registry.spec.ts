/**
 * Block Registry lifecycle fixtures: trusted-tier capability,
 * effect-owned reversible registrations, namespaced type ids.
 */

import { describe, expect, it } from 'vitest';
import { FroglightError } from '../errors.js';
import { InMemoryBlockRegistry } from './registry.js';

describe('block registry', () => {
  it('registers, lists, and resolves block types', () => {
    const registry = new InMemoryBlockRegistry();
    const disposer = registry.register({ typeId: 'acme.callout', version: 1 });
    expect(registry.get('acme.callout').version).toBe(1);
    expect(registry.list().map((entry) => entry.typeId)).toEqual(['acme.callout']);
    disposer.dispose();
    expect(registry.list()).toEqual([]);
  });

  it('throws DUPLICATE_BLOCK_TYPE on id collision', () => {
    const registry = new InMemoryBlockRegistry();
    registry.register({ typeId: 'acme.callout', version: 1 });
    try {
      registry.register({ typeId: 'acme.callout', version: 2 });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(FroglightError);
      expect((error as FroglightError).code).toBe('DUPLICATE_BLOCK_TYPE');
    }
  });

  it('rejects non-namespaced type ids at registration', () => {
    const registry = new InMemoryBlockRegistry();
    for (const typeId of ['callout', 'ACME.callout']) {
      try {
        registry.register({ typeId, version: 1 });
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(FroglightError);
        expect((error as FroglightError).code).toBe('INVALID_BLOCK_TYPE_ID');
        expect((error as FroglightError).message).toMatch(/namespaced/);
      }
    }
  });

  it('dispose is idempotent and re-registration after dispose succeeds', () => {
    const registry = new InMemoryBlockRegistry();
    const disposer = registry.register({ typeId: 'acme.callout', version: 1 });
    disposer.dispose();
    disposer.dispose();
    registry.register({ typeId: 'acme.callout', version: 2 });
    expect(registry.get('acme.callout').version).toBe(2);
  });

  it('get of an unknown type throws UNKNOWN_BLOCK_TYPE', () => {
    const registry = new InMemoryBlockRegistry();
    try {
      registry.get('nope.missing');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(FroglightError);
      expect((error as FroglightError).code).toBe('UNKNOWN_BLOCK_TYPE');
    }
  });

  it('round-trips optional presentation hints and removes them on dispose', () => {
    const registry = new InMemoryBlockRegistry();
    const disposer = registry.register({
      typeId: 'acme.callout',
      version: 1,
      label: 'Callout',
      shortLabel: 'Callout',
      hint: 'Highlighted note block',
      keywords: 'note aside admonition',
    });
    expect(registry.get('acme.callout')).toMatchObject({
      label: 'Callout',
      shortLabel: 'Callout',
      hint: 'Highlighted note block',
      keywords: 'note aside admonition',
    });
    expect(registry.list()).toHaveLength(1);
    disposer.dispose();
    expect(registry.list()).toEqual([]);
  });

  it('descriptors without hints remain valid (label falls back to typeId)', () => {
    // Fallback is consumer-side: the registry stores the descriptor as
    // registered (label stays undefined); catalog consumers render
    // `label ?? typeId`. This pins the consumer expression, not registry logic.
    const registry = new InMemoryBlockRegistry();
    const disposer = registry.register({ typeId: 'acme.plain', version: 1 });
    const entry = registry.get('acme.plain');
    expect(entry.label ?? entry.typeId).toBe('acme.plain');
    disposer.dispose();
  });
});
