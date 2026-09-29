import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  currentInteractionCapabilities,
  pointerDragSlop,
  workspacePresentationPolicy,
  type WorkspaceInteractionCapabilities,
} from './interaction-policy.js';

function capabilities(
  overrides: Partial<WorkspaceInteractionCapabilities> & {
    readonly pointer: WorkspaceInteractionCapabilities['pointer'];
  },
): WorkspaceInteractionCapabilities {
  return {
    coarse: false,
    supportsHover: true,
    anyCoarse: false,
    anyHover: true,
    ...overrides,
  };
}

describe('workspace interaction policy', () => {
  const mouse = capabilities({ pointer: 'mouse' });
  const touch = capabilities({
    pointer: 'touch',
    coarse: true,
    supportsHover: false,
    anyCoarse: true,
    anyHover: false,
  });
  // iPad + trackpad / touchscreen laptop: fine primary, touch available.
  const hybrid = capabilities({
    pointer: 'mouse',
    coarse: true,
    anyCoarse: true,
  });
  // Pen-only precise input: fine, never coarse (no device sniffing).
  const pen = capabilities({ pointer: 'pen' });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubMatchMedia(matches: (query: string) => boolean): void {
    // This spec runs in node (no jsdom `window`): stub the host surface the
    // policy reads.
    vi.stubGlobal('window', {
      matchMedia: (query: string) => ({
        matches: matches(query),
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }),
    });
  }

  it('separates compact, medium, and wide presentation from input density', () => {
    expect(
      workspacePresentationPolicy({ width: 600, capabilities: mouse }),
    ).toMatchObject({
      layout: 'compact',
      showBottomNavigation: true,
      allowVisibleSplit: false,
    });
    expect(
      workspacePresentationPolicy({ width: 1024, capabilities: touch }),
    ).toMatchObject({
      layout: 'medium',
      showActivityRail: true,
      sidebarMode: 'overlay',
      inspectorMode: 'overlay',
      controlDensity: 'touch',
      allowVisibleSplit: true,
    });
    expect(
      workspacePresentationPolicy({ width: 1400, capabilities: touch }),
    ).toMatchObject({
      layout: 'wide',
      showActivityRail: true,
      controlDensity: 'touch',
    });
  });

  it('uses pointer-specific drag slop', () => {
    expect(pointerDragSlop('mouse')).toBe(4);
    expect(pointerDragSlop('pen')).toBe(6);
    expect(pointerDragSlop('touch')).toBe(12);
  });

  it('keeps touch density for hybrid fine-primary + touch-available hosts', () => {
    expect(
      workspacePresentationPolicy({ width: 1024, capabilities: hybrid }),
    ).toMatchObject({ layout: 'medium', controlDensity: 'touch' });
    expect(
      workspacePresentationPolicy({ width: 1400, capabilities: hybrid }),
    ).toMatchObject({ layout: 'wide', controlDensity: 'touch' });
  });

  it('keeps pen precise input dense while touch stays touch', () => {
    for (const width of [768, 1024, 1400]) {
      expect(
        workspacePresentationPolicy({ width, capabilities: pen })
          .controlDensity,
      ).toBe('compact');
      expect(
        workspacePresentationPolicy({ width, capabilities: touch })
          .controlDensity,
      ).toBe('touch');
    }
  });

  it('derives touch availability from any-pointer, not the primary alone', () => {
    // Hybrid: fine primary, coarse available anywhere.
    stubMatchMedia(
      (query) =>
        query === '(any-pointer: coarse)' || query === '(any-hover: hover)',
    );
    expect(currentInteractionCapabilities()).toMatchObject({
      pointer: 'mouse',
      coarse: true,
      anyCoarse: true,
    });
    // Fine-only desktop: no coarse anywhere, hover available.
    stubMatchMedia(
      (query) => query === '(hover: hover)' || query === '(any-hover: hover)',
    );
    expect(currentInteractionCapabilities()).toMatchObject({
      pointer: 'mouse',
      coarse: false,
      supportsHover: true,
      anyCoarse: false,
      anyHover: true,
    });
    // Coarse-only touch: primary coarse implies touch availability.
    stubMatchMedia((query) => query === '(pointer: coarse)');
    expect(currentInteractionCapabilities()).toMatchObject({
      pointer: 'touch',
      coarse: true,
    });
  });
});
