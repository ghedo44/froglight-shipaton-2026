/**
 * Preparation-priority ordering tests.
 *
 * Canonical paint order controls visual stacking; preparation order
 * serves the viewport first. These tests pin the banding contract:
 * visible remainder → prefetch margin → rest, canonical within bands,
 * prepared ids excluded, paint order untouched.
 */

import { describe, expect, it } from 'vitest';
import { orderByPreparationPriority } from './incremental-scene.js';

describe('orderByPreparationPriority', () => {
  it('serves visible remainder before offscreen canonical heads', () => {
    // Thousands of offscreen objects precede one visible stroke.
    const order = [
      ...Array.from({ length: 2000 }, (_, i) => `off${i}`),
      'visible-late',
    ];
    const queue = orderByPreparationPriority(
      order,
      () => false,
      new Set(['visible-late']),
      new Set(['visible-late']),
    );
    expect(queue[0]).toBe('visible-late');
    expect(queue).toHaveLength(2001);
    // Canonical order preserved within the rest band.
    expect(queue.slice(1, 4)).toEqual(['off0', 'off1', 'off2']);
  });

  it('orders bands visible → prefetch → rest, canonical within bands', () => {
    const order = ['a', 'b', 'c', 'd', 'e', 'f'];
    const queue = orderByPreparationPriority(
      order,
      () => false,
      new Set(['e']),
      new Set(['e', 'b', 'f']),
    );
    expect(queue).toEqual(['e', 'b', 'f', 'a', 'c', 'd']);
  });

  it('excludes already-prepared ids without disturbing bands', () => {
    const order = ['a', 'b', 'c', 'd'];
    const prepared = new Set(['b']);
    const queue = orderByPreparationPriority(
      order,
      (id) => prepared.has(id),
      new Set(['c']),
      new Set(['c', 'a']),
    );
    expect(queue).toEqual(['c', 'a', 'd']);
  });

  it('returns an empty queue when everything is prepared', () => {
    expect(
      orderByPreparationPriority(
        ['a', 'b'],
        () => true,
        new Set(['a']),
        new Set(),
      ),
    ).toEqual([]);
  });

  it('ignores unknown viewport ids (never invents work)', () => {
    const queue = orderByPreparationPriority(
      ['a', 'b'],
      () => false,
      new Set(['ghost']),
      new Set(),
    );
    expect(queue).toEqual(['a', 'b']);
  });

  it('never mutates the canonical order array', () => {
    const order = ['b', 'a', 'c'];
    const snapshot = [...order];
    orderByPreparationPriority(order, () => false, new Set(['c']), new Set());
    expect(order).toEqual(snapshot);
  });
});
