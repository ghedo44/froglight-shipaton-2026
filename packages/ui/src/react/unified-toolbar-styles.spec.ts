/**
 * Responsive pins for the unified document toolbar stylesheet.
 *
 * No second toolbar row may ever be created: the top-bar center and every
 * floating island compact with internal scroll, the submitted-input popover
 * floats above document flow, controls share compact geometry across inputs,
 * and contextual appearance honors reduced motion. These are content
 * assertions on the compiled colocated stylesheet (class names carry the
 * CSS-module hash suffix, matched loosely) — the production Chromium
 * geometry gates in the toolbar specs remain the visual end-state check.
 */

import { describe, expect, it } from 'vitest';
import css from './UnifiedToolbar.module.css?inline';

const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
// CSS-module hashes: `._fl-topbar-center_c405ea`, etc.
const hashed = (name: string): string => `\\.${name}_[A-Za-z0-9]+`;

describe('unified toolbar stylesheet (responsive pins)', () => {
  it('keeps the top-bar center to one scrolling row', () => {
    expect(clean).toMatch(
      new RegExp(
        `${hashed('_fl-topbar-center')}\\s*\\{[^}]*overflow-x:\\s*auto`,
      ),
    );
    expect(clean).not.toMatch(
      new RegExp(
        `${hashed('_fl-topbar-center')}\\s*\\{[^}]*flex-wrap:\\s*wrap`,
      ),
    );
  });

  it('lets floating islands scroll internally instead of overlapping', () => {
    expect(clean).toMatch(
      new RegExp(
        `${hashed('_fl-floating-island')}\\s*\\{[^}]*overflow-x:\\s*auto`,
      ),
    );
  });

  it('floats the submitted-input popover above flow without adding a row', () => {
    expect(clean).toMatch(
      new RegExp(
        `${hashed('_fl-document-tool-popover')}\\s*\\{[^}]*position:\\s*absolute`,
      ),
    );
  });

  it('keeps the diagnostics list compact and scrollable inside its popover', () => {
    // The generic diagnostics popover reuses the floating popover layer;
    // its list scrolls internally with a bounded width so long diagnostic
    // text never creates a second toolbar row.
    expect(clean).toMatch(
      new RegExp(
        `${hashed('_fl-document-tool-diagnostics')}\\s*\\{[^}]*overflow:\\s*auto`,
      ),
    );
    expect(clean).toMatch(
      new RegExp(
        `${hashed('_fl-document-tool-diagnostics')}\\s*\\{[^}]*max-width:`,
      ),
    );
  });

  it('activates toolbar taps immediately for touch/pen (no double-tap zoom)', () => {
    expect(clean).toMatch(/touch-action:\s*manipulation/);
  });

  it('keeps the category strip scrollable on narrow split panes', () => {
    // No `overflow: visible` on the categories row: overflow menus portal
    // into the pane layer, so the strip scrolls internally instead of
    // clipping categories on narrow panes.
    expect(clean).not.toMatch(
      new RegExp(
        `${hashed('_fl-toolbar-categories')}\\s*\\{[^}]*overflow:\\s*visible`,
      ),
    );
  });

  it('projects compact below the shared workspace breakpoint', () => {
    expect(clean).toMatch(/@media\s*\(max-width:\s*760px\)/);
  });

  it('keeps the selection toolbar inside safe areas and above the keyboard', () => {
    expect(clean).toMatch(/--fl-keyboard-safe-bottom/);
    expect(clean).toMatch(/--fl-safe-area-top/);
  });

  it('lets pen/touch input pass through the overlay except on islands', () => {
    // The floating layer is a stable coordinate space that never blocks
    // drawing, selection, or gestures; only actual toolbar islands and
    // popovers intercept pointer events.
    expect(clean).toMatch(
      new RegExp(
        `${hashed('_fl-floating-layer')}\\s*\\{[^}]*pointer-events:\\s*none`,
      ),
    );
    expect(clean).toMatch(
      new RegExp(
        `${hashed('_fl-floating-island')}\\s*\\{[^}]*pointer-events:\\s*auto`,
      ),
    );
  });

  // grouped-slot geometry: the floating secondary stays a
  // pane-scoped hovering island — absolute inset-0 layer, clipped, stacked
  // below selection/popovers. Verbatim shelf order, cross-layer
  // dedupe, and the 5-group surface all render inside
  // these islands, so anchoring/clipping/z-index are pinned here while
  // the slot-box itself stays pinned in shelf-slots.spec.
  it('keeps the floating layer pane-scoped with clipping and stacking', () => {
    expect(clean).toMatch(
      new RegExp(
        `${hashed('_fl-floating-layer')}\\s*\\{[^}]*position:\\s*absolute`,
      ),
    );
    expect(clean).toMatch(
      new RegExp(`${hashed('_fl-floating-layer')}\\s*\\{[^}]*inset:\\s*0`),
    );
    expect(clean).toMatch(
      new RegExp(`${hashed('_fl-floating-layer')}\\s*\\{[^}]*z-index:\\s*3`),
    );
    expect(clean).toMatch(
      new RegExp(
        `${hashed('_fl-floating-layer')}\\s*\\{[^}]*overflow:\\s*clip`,
      ),
    );
  });

  it('anchors floating strips to pane edges with safe-area insets', () => {
    expect(clean).toMatch(
      new RegExp(
        `${hashed('_fl-floating-strip')}\\s*\\{[^}]*position:\\s*absolute`,
      ),
    );
    expect(clean).toMatch(
      new RegExp(
        `${hashed('_fl-floating-strip')}\\s*\\{[^}]*left:\\s*0[^}]*right:\\s*0`,
      ),
    );
    // Top edge: 8px offset plus notch-safe padding.
    expect(clean).toMatch(
      new RegExp(
        `${hashed('_fl-floating-strip')}${hashed('_strip-top')}\\s*\\{[^}]*top:\\s*8px[^}]*var\\(--fl-safe-area-left\\)`,
      ),
    );
    expect(clean).toMatch(
      new RegExp(
        `${hashed('_fl-floating-strip')}${hashed('_strip-top')}\\s*\\{[^}]*var\\(--fl-safe-area-right\\)`,
      ),
    );
    // Bottom edge clears the pane edge plus the keyboard-aware inset
    // (the dock already ends at the keyboard top) with notch padding.
    expect(clean).toMatch(
      new RegExp(
        `${hashed('_fl-floating-strip')}${hashed('_strip-bottom')}\\s*\\{[^}]*var\\(--fl-keyboard-aware-bottom`,
      ),
    );
    // Mid-pane floats hold their side inset around notches.
    expect(clean).toMatch(
      new RegExp(
        `${hashed('_fl-floating-slot-float')}${hashed('_slot-left')}\\s*\\{[^}]*var\\(--fl-safe-area-left\\)`,
      ),
    );
    expect(clean).toMatch(
      new RegExp(
        `${hashed('_fl-floating-slot-float')}${hashed('_slot-right')}\\s*\\{[^}]*var\\(--fl-safe-area-right\\)`,
      ),
    );
  });

  it('keeps selection and popovers stacked with overflow bounds', () => {
    // Viewport-anchored selection floats above islands; submitted-input
    // popovers float above that — never a second toolbar row.
    expect(clean).toMatch(
      new RegExp(
        `${hashed('_fl-selection-toolbar-slot')}\\s*\\{[^}]*position:\\s*fixed`,
      ),
    );
    expect(clean).toMatch(
      new RegExp(
        `${hashed('_fl-selection-toolbar-slot')}\\s*\\{[^}]*z-index:\\s*4`,
      ),
    );
    expect(clean).toMatch(
      new RegExp(
        `${hashed('_fl-document-tool-popover')}\\s*\\{[^}]*z-index:\\s*5`,
      ),
    );
    // Islands scroll internally within pane bounds; the selection island
    // additionally clamps to notches + keyboard with internal scroll.
    expect(clean).toMatch(
      new RegExp(
        `${hashed('_fl-floating-island')}\\s*\\{[^}]*max-width:\\s*100%`,
      ),
    );
    expect(clean).toMatch(
      new RegExp(
        `${hashed('_fl-selection-toolbar-slot')}\\s+${hashed('_fl-floating-island')}[^\\{]*\\{[^}]*overflow:\\s*auto`,
      ),
    );
    expect(clean).toMatch(
      new RegExp(
        `${hashed('_fl-selection-toolbar-slot')}\\s+${hashed('_fl-floating-island')}[^\\{]*\\{[^}]*var\\(--fl-keyboard-safe-bottom`,
      ),
    );
  });

  it('exposes mixed state distinctly and honors reduced motion', () => {
    expect(clean).toMatch(/\[aria-pressed='mixed'\]/);
    expect(clean).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?animation:\s*none/,
    );
  });
});
