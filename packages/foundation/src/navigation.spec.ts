/**
 * Tests for the workspace navigation history.
 *
 * Navigation is a Froglight-owned service: editor-neutral,
 * resource-based, with back/forward semantics like a browser history.
 * `current`/`canGoBack`/`canGoForward` are getters; `current` is `null`
 * when history is empty.
 */

import { describe, expect, it } from 'vitest';
import { InMemoryNavigationService } from './navigation.js';
import { resourceId } from './identity.js';

describe('InMemoryNavigationService', () => {
  it('starts empty: no current entry, cannot navigate', () => {
    const service = new InMemoryNavigationService();
    expect(service.current).toBeNull();
    expect(service.canGoBack).toBe(false);
    expect(service.canGoForward).toBe(false);
  });

  it('push sets the current entry', () => {
    const service = new InMemoryNavigationService();
    service.push({ resourceId: resourceId('res-a') });
    expect(service.current).toEqual({ resourceId: 'res-a' });
  });

  it('push with an address keeps the address', () => {
    const service = new InMemoryNavigationService();
    service.push({ resourceId: resourceId('res-a'), address: 'cell/2' });
    expect(service.current).toEqual({ resourceId: 'res-a', address: 'cell/2' });
  });

  it('normalizes undefined addresses out of stored entries', () => {
    const service = new InMemoryNavigationService();
    service.push({ resourceId: resourceId('res-a'), address: undefined });
    const current = service.current;
    expect(current).toEqual({ resourceId: 'res-a' });
    expect('address' in (current as object)).toBe(false);
  });

  it('back/forward walk the history', () => {
    const service = new InMemoryNavigationService();
    service.push({ resourceId: resourceId('res-a') });
    service.push({ resourceId: resourceId('res-b') });
    service.push({ resourceId: resourceId('res-c') });
    expect(service.current).toEqual({ resourceId: 'res-c' });
    expect(service.canGoBack).toBe(true);
    expect(service.canGoForward).toBe(false);
    service.back();
    expect(service.current).toEqual({ resourceId: 'res-b' });
    service.back();
    expect(service.current).toEqual({ resourceId: 'res-a' });
    expect(service.canGoBack).toBe(false);
    service.forward();
    expect(service.current).toEqual({ resourceId: 'res-b' });
    service.forward();
    expect(service.current).toEqual({ resourceId: 'res-c' });
    expect(service.canGoForward).toBe(false);
  });

  it('back/forward are no-ops at the edges', () => {
    const service = new InMemoryNavigationService();
    service.push({ resourceId: resourceId('res-a') });
    service.back();
    expect(service.current).toEqual({ resourceId: 'res-a' });
    service.forward();
    expect(service.current).toEqual({ resourceId: 'res-a' });
  });

  it('push truncates the forward branch', () => {
    const service = new InMemoryNavigationService();
    service.push({ resourceId: resourceId('res-a') });
    service.push({ resourceId: resourceId('res-b') });
    service.push({ resourceId: resourceId('res-c') });
    service.back();
    service.back();
    service.push({ resourceId: resourceId('res-x') });
    expect(service.current).toEqual({ resourceId: 'res-x' });
    expect(service.canGoForward).toBe(false);
    service.back();
    expect(service.current).toEqual({ resourceId: 'res-a' });
  });

  it('replace swaps the current entry without growing history', () => {
    const service = new InMemoryNavigationService();
    service.push({ resourceId: resourceId('res-a') });
    service.push({ resourceId: resourceId('res-b') });
    service.replace({ resourceId: resourceId('res-b2') });
    expect(service.current).toEqual({ resourceId: 'res-b2' });
    service.back();
    expect(service.current).toEqual({ resourceId: 'res-a' });
    service.forward();
    expect(service.current).toEqual({ resourceId: 'res-b2' });
  });

  it('replace on an empty history sets the first entry', () => {
    const service = new InMemoryNavigationService();
    service.replace({ resourceId: resourceId('res-a') });
    expect(service.current).toEqual({ resourceId: 'res-a' });
    expect(service.canGoBack).toBe(false);
    expect(service.canGoForward).toBe(false);
  });

  it('clear resets the history', () => {
    const service = new InMemoryNavigationService();
    service.push({ resourceId: resourceId('res-a') });
    service.push({ resourceId: resourceId('res-b') });
    service.clear();
    expect(service.current).toBeNull();
    expect(service.canGoBack).toBe(false);
    expect(service.canGoForward).toBe(false);
  });

  it('onChange fires on push/back/forward/replace/clear', () => {
    const service = new InMemoryNavigationService();
    const events: string[] = [];
    const dispose = service.onChange(() => events.push('change'));
    service.push({ resourceId: resourceId('res-a') });
    service.push({ resourceId: resourceId('res-b') });
    service.back();
    service.forward();
    service.replace({ resourceId: resourceId('res-c') });
    service.clear();
    expect(events).toEqual(['change', 'change', 'change', 'change', 'change', 'change']);
    dispose.dispose();
    service.push({ resourceId: resourceId('res-d') });
    expect(events).toHaveLength(6);
  });

  it('current returns a copy', () => {
    const service = new InMemoryNavigationService();
    service.push({ resourceId: resourceId('res-a'), address: 'x' });
    const current = service.current;
    (current as { address: string }).address = 'MUTATED';
    expect(service.current).toEqual({ resourceId: 'res-a', address: 'x' });
  });
});