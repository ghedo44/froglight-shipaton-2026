import { describe, expect, it } from 'vitest';
import css from './WorkspaceView.module.css?inline';

const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');

describe('workspace adaptive layout stylesheet', () => {
  it('keeps the activity rail while removing desktop sidebar tracks in medium mode', () => {
    const medium = [
      ...clean.matchAll(
        /@media\s*\(min-width:\s*761px\)\s*and\s*\(max-width:\s*1179px\)\s*\{([\s\S]*?)\n\s*\}/g,
      ),
    ]
      .map((match) => match[1])
      .find((block) => block?.includes('var(--fl-layout-ribbon-width)'));

    expect(medium).toContain('var(--fl-layout-ribbon-width) minmax(0, 1fr)');
    expect(medium).toContain("'activity titlebar'");
    expect(medium).toContain("'activity main'");
    expect(clean).not.toMatch(
      /\[data-layout='medium'\][^{]*\._fl-activity_[A-Za-z0-9]+\s*\{[^}]*display:\s*none/,
    );
  });

  it('does not apply the wide inline sidebar placement to medium drawers', () => {
    expect(clean).not.toMatch(
      /@media\s*\(min-width:\s*761px\)\s*\{\s*\._fl-sidebar_[A-Za-z0-9]+\s*\{[^}]*position:\s*relative/,
    );
    expect(clean).toMatch(
      /\._froglight-layout_[A-Za-z0-9]+\[data-layout='wide'\]\s+\._fl-sidebar_[A-Za-z0-9]+\s*\{[^}]*position:\s*relative/,
    );
  });
});

describe('document presentation selector tokens', () => {
  it('keeps the compact presentation selector in the toolbar', () => {
    expect(clean).toMatch(
      /\._compact-presentation_[A-Za-z0-9]+ > button\s*\{[^}]*color:\s*var\(--fl-text-secondary\)/,
    );
    for (const name of [
      '--fl-bg-active',
      '--fl-bg-hover',
      '--fl-bg-raised',
      '--fl-shadow-1',
    ]) {
      expect(clean).not.toContain(`var(${name})`);
    }
  });
});

it('uses readable secondary ink for inactive tabs and bottom navigation labels', () => {
  expect(clean).toMatch(
    /\._fl-tab_[A-Za-z0-9]+\s*\{[^}]*color:\s*var\(--fl-text-secondary\)/,
  );
  expect(clean).toMatch(
    /\._bottomnav-button_[A-Za-z0-9]+\s*\{[^}]*color:\s*var\(--fl-text-secondary\)/,
  );
});
