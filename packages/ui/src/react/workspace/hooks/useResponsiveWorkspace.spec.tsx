// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useResponsiveWorkspace } from './useResponsiveWorkspace.js';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

describe('responsive workspace transitions', () => {
  const roots: ReturnType<typeof createRoot>[] = [];

  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await act(async () => root.unmount());
    }
    vi.unstubAllGlobals();
  });

  it.each([1400, 1024, 390])(
    'dismisses transient chrome from initial width %i and restores the wide preference',
    async (initialWidth) => {
      let inspectorVisible = true;
      const latest: {
        current: ReturnType<typeof useResponsiveWorkspace> | null;
      } = { current: null };
      const setInspectorVisible = vi.fn((visible: boolean) => {
        inspectorVisible = visible;
        render();
      });
      const host = document.createElement('div');
      const root = createRoot(host);
      roots.push(root);
      vi.stubGlobal('matchMedia', () => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }));

      function Harness(): null {
        latest.current = useResponsiveWorkspace({
          inspectorVisible,
          setInspectorVisible,
        });
        return null;
      }
      function render(): void {
        root.render(<Harness />);
      }

      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: initialWidth,
      });
      await act(async () => render());
      expect(inspectorVisible).toBe(initialWidth === 1400);

      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: 1024,
      });
      await act(async () => window.dispatchEvent(new Event('resize')));
      expect(latest.current?.presentation.layout).toBe('medium');
      expect(inspectorVisible).toBe(false);

      await act(async () => latest.current?.setMobileDrawerOpen(true));
      await act(async () => latest.current?.closeMobileDrawers());
      expect(latest.current?.mobileDrawerOpen).toBe(false);
      expect(inspectorVisible).toBe(false);

      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: 1400,
      });
      await act(async () => window.dispatchEvent(new Event('resize')));
      expect(latest.current?.presentation.layout).toBe('wide');
      expect(inspectorVisible).toBe(true);
    },
  );
});
