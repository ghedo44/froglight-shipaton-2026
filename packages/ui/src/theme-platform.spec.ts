import { describe, expect, it } from 'vitest';
import { defaultThemeCss } from './theme.js';
import titlebarModuleCss from './react/Titlebar.module.css?inline';
import workspaceModuleCss from './react/WorkspaceView.module.css?inline';

/**
 * Platform window geometry lives in `@layer platform` blocks inside the
 * owning component modules — not in the runtime theme bundle. The bundle
 * carries only the environment token values; geometry selectors stay with
 * the components that render them.
 *
 * NOTE: `?inline` module imports expose compiled CSS with hashed class
 * names (`._fl-sidebar_<hash>`), so assertions use hash-agnostic
 * substrings (the original names survive hashing) rather than literal
 * selectors.
 */
describe('platform window geometry (component-owned)', () => {
  it('the bundle defines safe-area environment values and no geometry selectors', () => {
    for (const token of [
      '--fl-safe-area-top',
      '--fl-safe-area-bottom',
      '--fl-safe-area-left',
      '--fl-safe-area-right',
    ]) {
      expect(defaultThemeCss, `missing ${token}`).toContain(token);
    }
    for (const selector of [
      '.froglight-layout',
      '.fl-titlebar',
      '.fl-activity',
      '.fl-sidebar',
      '.fl-right-sidebar',
      '.titlebar-inspector-toggle',
    ]) {
      expect(defaultThemeCss, `geometry ${selector}`).not.toContain(selector);
    }
  });

  it('the workspace module reserves the top safe area in its own grid row', () => {
    expect(workspaceModuleCss).toContain('@layer platform {');
    // Compiled: `._froglight-layout_<hash> { grid-template-rows: … }`.
    expect(workspaceModuleCss).toContain('froglight-layout');
    expect(workspaceModuleCss).toContain('grid-template-rows:');
    expect(workspaceModuleCss).toContain(
      'calc(var(--fl-layout-tab-height) + var(--fl-safe-area-top))',
    );
  });

  it('the rails clear the OS-owned top inset independently', () => {
    expect(workspaceModuleCss).toContain(
      'var(--fl-safe-area-top) + (var(--fl-layout-tab-height) - 34px) / 2',
    );
    expect(workspaceModuleCss).toContain('fl-sidebar');
    expect(workspaceModuleCss).toContain('fl-right-sidebar');
    expect(workspaceModuleCss).toContain('padding-top: var(--fl-safe-area-top)');
  });

  it('the desktop inspector toggle offsets below the top safe area', () => {
    expect(workspaceModuleCss).toContain('titlebar-inspector-toggle');
    expect(workspaceModuleCss).toContain(
      'var(--fl-safe-area-top) + (var(--fl-layout-tab-height) - 28px) / 2',
    );
  });

  it('the titlebar reserves the safe area in normal flow', () => {
    expect(titlebarModuleCss).toContain('@layer platform {');
    expect(titlebarModuleCss).toContain('fl-titlebar');
    expect(titlebarModuleCss).toContain(
      'height: calc(var(--fl-layout-tab-height) + var(--fl-safe-area-top))',
    );
    expect(titlebarModuleCss).toContain(
      'calc(var(--fl-layout-header-height) + var(--fl-safe-area-top))',
    );
  });

  it('the compact titlebar keeps the toggle in the flex row with a safe-area margin', () => {
    expect(workspaceModuleCss).toContain('@media (max-width: 760px)');
    expect(workspaceModuleCss).toContain('fl-titlebar-inspector');
    expect(workspaceModuleCss).toContain('display: none');
    expect(workspaceModuleCss).toContain('position: static');
    expect(workspaceModuleCss).toContain('margin-inline-end: calc(');
    expect(workspaceModuleCss).toContain('max(4px, var(--fl-safe-area-right))');
  });

  it('the document clips horizontally while closed mobile drawers hide', () => {
    // Document-level clip is a global default, not component geometry.
    expect(defaultThemeCss).toMatch(
      /@layer globals \{[\s\S]*?overflow-x: clip[\s\S]*?\n\}/,
    );
    expect(workspaceModuleCss).toContain('contain: layout paint');
    expect(workspaceModuleCss).toContain('fl-right-sidebar');
    expect(workspaceModuleCss).toContain('visibility: hidden');
  });

  it('the shell keeps a stable layout height with private track variables', () => {
    // Geometry state rides `--_*` implementation variables, never theme
    // API: symmetric sidebar tracks collapse to zero when hidden.
    expect(workspaceModuleCss).toContain(
      '--_left-sidebar-track: var(--fl-layout-sidebar-width)',
    );
    expect(workspaceModuleCss).toContain(
      '--_right-sidebar-track: var(--fl-layout-right-sidebar-width)',
    );
    expect(workspaceModuleCss).toContain('--_left-sidebar-track: 0px');
    expect(workspaceModuleCss).toContain('--_right-sidebar-track: 0px');
    expect(workspaceModuleCss).toContain('position: fixed');
    expect(workspaceModuleCss).toContain('height: 100%');
  });
});
