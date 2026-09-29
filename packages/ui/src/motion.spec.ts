// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { applyMotionPreference, isMotionReduced } from './motion.js';

afterEach(() => {
  delete document.documentElement.dataset.flMotion;
  vi.unstubAllGlobals();
});

it('follows changing system motion unless the user explicitly overrides it', () => {
  let systemReduced = true;
  vi.stubGlobal('matchMedia', () => ({ matches: systemReduced }));
  expect(isMotionReduced()).toBe(true);
  const on = applyMotionPreference('on');
  expect(isMotionReduced()).toBe(false);
  on.dispose();
  expect(isMotionReduced()).toBe(true);
  systemReduced = false;
  expect(isMotionReduced()).toBe(false);
  const off = applyMotionPreference('off');
  expect(isMotionReduced()).toBe(true);
  off.dispose();
  expect(isMotionReduced()).toBe(false);
});

it('restores the previous root policy on disposal', () => {
  document.documentElement.dataset.flMotion = 'off';
  const binding = applyMotionPreference('on');
  expect(isMotionReduced()).toBe(false);
  binding.dispose();
  binding.dispose();
  expect(isMotionReduced()).toBe(true);
});
