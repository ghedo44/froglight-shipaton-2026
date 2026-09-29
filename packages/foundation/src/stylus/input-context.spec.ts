import { describe, expect, it } from 'vitest';
import { InMemoryStylusService } from './service.js';
import type { StylusInputContext } from './contract.js';

function fixture() {
  const service = new InMemoryStylusService();
  const seen: StylusInputContext[] = [];
  const unsubscribe = service.onInputContextChange((context) =>
    seen.push(context),
  );
  return { service, seen, unsubscribe };
}

describe('stylus input ownership', () => {
  it('restores default after the sole drawing owner leaves', () => {
    const { service, seen } = fixture();
    const dispose = service.acquireInputContext('drawing');
    expect(service.inputContext()).toBe('drawing');
    dispose();
    expect(service.inputContext()).toBe('default');
    expect(seen).toEqual(['drawing', 'default']);
  });

  it('keeps drawing until the last owner leaves, with idempotent disposal', () => {
    const { service, seen } = fixture();
    const a = service.acquireInputContext('drawing');
    const b = service.acquireInputContext('drawing');
    a();
    a();
    expect(service.inputContext()).toBe('drawing');
    expect(seen).toEqual(['drawing']);
    b();
    b();
    expect(seen).toEqual(['drawing', 'default']);
  });

  it('prioritizes text entry and restores drawing on close', () => {
    const { service, seen } = fixture();
    const drawing = service.acquireInputContext('drawing');
    const text = service.acquireInputContext('text-entry');
    expect(service.inputContext()).toBe('text-entry');
    text();
    text();
    expect(service.inputContext()).toBe('drawing');
    drawing();
    expect(seen).toEqual(['drawing', 'text-entry', 'drawing', 'default']);
  });

  it('publishes only effective changes across multiple text and drawing owners', () => {
    const { service, seen } = fixture();
    const a = service.acquireInputContext('drawing');
    const b = service.acquireInputContext('drawing');
    const x = service.acquireInputContext('text-entry');
    const y = service.acquireInputContext('text-entry');
    x();
    expect(service.inputContext()).toBe('text-entry');
    y();
    expect(service.inputContext()).toBe('drawing');
    a();
    b();
    expect(seen).toEqual(['drawing', 'text-entry', 'drawing', 'default']);
  });

  it('keeps text active when the drawing owner leaves and supports unsubscribe', () => {
    const { service, seen, unsubscribe } = fixture();
    const drawing = service.acquireInputContext('drawing');
    const text = service.acquireInputContext('text-entry');
    drawing();
    expect(seen).toEqual(['drawing', 'text-entry']);
    unsubscribe();
    text();
    expect(service.inputContext()).toBe('default');
    expect(seen).toEqual(['drawing', 'text-entry']);
  });
});
