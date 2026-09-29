import { describe, expect, it } from 'vitest';
import { KeyboardInsetStore } from './store.js';

describe('KeyboardInsetStore willHide ordering', () => {
  it('announces hide intent before publishing the closed snapshot', () => {
    const store = new KeyboardInsetStore();
    const order: string[] = [];

    store.onWillHide(() => {
      order.push(`willHide:${store.snapshot().isOpen ? 'open' : 'closed'}`);
    });
    store.subscribe((snapshot) => {
      if (!snapshot.isOpen) order.push('snapshot:closed');
    });

    store.handleNativeEvent('target', {
      height: 300,
      durationMs: 250,
      measurement: 'exact',
    });
    order.length = 0;

    store.handleNativeEvent('willHide', { durationMs: 200 });

    expect(order).toEqual(['willHide:open', 'snapshot:closed']);
    expect(store.snapshot()).toMatchObject({ height: 0, isOpen: false });
    store.dispose();
  });
});
