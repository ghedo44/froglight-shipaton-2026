/**
 * Tests for the namespaced settings store.
 *
 * Keys are dot-namespaced (`area.name`) so plugins never collide without a
 * central registry.
 */

import { describe, expect, it } from 'vitest';
import {
  InMemorySettingsService,
  assertSettingsKey,
  isValidSettingsKey,
  type SettingsValue,
} from './settings.js';
import { FroglightError, isFroglightError } from './errors.js';

describe('isValidSettingsKey / assertSettingsKey', () => {
  it('accepts dot-namespaced keys with two or more segments', () => {
    expect(isValidSettingsKey('area.name')).toBe(true);
    expect(isValidSettingsKey('a.b.c')).toBe(true);
    expect(isValidSettingsKey('froglight.editor.font-size')).toBe(true);
    expect(isValidSettingsKey('a.b_1-C')).toBe(true);
  });

  it('rejects keys without a namespace', () => {
    expect(isValidSettingsKey('single')).toBe(false);
    expect(isValidSettingsKey('')).toBe(false);
    expect(isValidSettingsKey('.leading')).toBe(false);
    expect(isValidSettingsKey('trailing.')).toBe(false);
    expect(isValidSettingsKey('a..b')).toBe(false);
    expect(isValidSettingsKey('a b')).toBe(false);
    expect(isValidSettingsKey(5)).toBe(false);
    expect(isValidSettingsKey(null)).toBe(false);
  });

  it('assertSettingsKey throws INVALID_SETTINGS_KEY', () => {
    try {
      assertSettingsKey('nope');
      expect.unreachable();
    } catch (error) {
      expect(isFroglightError(error)).toBe(true);
      expect(error).toBeInstanceOf(FroglightError);
      expect((error as FroglightError).code).toBe('INVALID_SETTINGS_KEY');
    }
    const ok: unknown = 'area.name';
    assertSettingsKey(ok);
    expect(ok).toBe('area.name');
  });
});

describe('InMemorySettingsService', () => {
  it('get returns undefined for unset keys', () => {
    const service = new InMemorySettingsService();
    expect(service.get('area.name')).toBeUndefined();
  });

  it('set/get round-trips all value kinds', () => {
    const service = new InMemorySettingsService();
    service.set('area.str', 'hello');
    service.set('area.num', 42);
    service.set('area.bool', true);
    service.set('area.null', null);
    expect(service.get('area.str')).toBe('hello');
    expect(service.get('area.num')).toBe(42);
    expect(service.get('area.bool')).toBe(true);
    expect(service.get('area.null')).toBeNull();
  });

  it('set rejects invalid keys with INVALID_SETTINGS_KEY', () => {
    const service = new InMemorySettingsService();
    try {
      service.set('nope', 1);
      expect.unreachable();
    } catch (error) {
      expect((error as FroglightError).code).toBe('INVALID_SETTINGS_KEY');
    }
  });

  it('remove deletes a key; no-op when absent', () => {
    const service = new InMemorySettingsService();
    service.set('area.name', 'x');
    service.remove('area.name');
    expect(service.get('area.name')).toBeUndefined();
    expect(() => service.remove('area.missing')).not.toThrow();
  });

  it('entries returns a snapshot map', () => {
    const service = new InMemorySettingsService();
    service.set('area.a', 1);
    service.set('area.b', 2);
    const snapshot = service.entries();
    expect(snapshot.get('area.a')).toBe(1);
    expect(snapshot.size).toBe(2);
    // Mutating the snapshot does not affect the store.
    (snapshot as Map<string, SettingsValue>).set('area.a', 999);
    expect(service.get('area.a')).toBe(1);
  });

  it('onChange notifies with key and new value; remove reports undefined', () => {
    const service = new InMemorySettingsService();
    const events: Array<[string, unknown]> = [];
    const dispose = service.onChange((key, value) => events.push([key, value]));
    service.set('area.a', 1);
    service.set('area.a', 2);
    service.remove('area.a');
    expect(events).toEqual([
      ['area.a', 1],
      ['area.a', 2],
      ['area.a', undefined],
    ]);
    dispose.dispose();
    service.set('area.a', 3);
    expect(events).toHaveLength(3);
  });

  it('onChange disposer stops notifications', () => {
    const service = new InMemorySettingsService();
    let count = 0;
    const dispose = service.onChange(() => {
      count += 1;
    });
    dispose.dispose();
    service.set('area.a', 1);
    expect(count).toBe(0);
  });
});