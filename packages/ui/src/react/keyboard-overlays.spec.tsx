// @vitest-environment jsdom
/**
 * Modal keyboard avoidance.
 *
 * Every input-bearing modal lays out against the keyboard-usable viewport:
 * the backdrop containing block ends at the keyboard top (owned by the
 * stylesheets) so centering lands in the usable region on tablet/desktop,
 * with the same placement on narrow screens. New Note is
 * explicitly covered at desktop width (the iPad regression: keyboard
 * avoidance was phone-breakpoint-only).
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  showContextMenuReact,
  uiConfirmReact,
  uiPromptReact,
} from './overlays.jsx';
import { disposeOverlayHost } from './overlays.jsx';
import { NewNoteModal } from './NewNoteModal.jsx';
import { TEST_NOTE_KINDS } from '../testing/note-kind-options.js';
import newNoteStyles from './NewNoteModal.module.css';
import overlayStyles from './Overlays.module.css';
import {
  attachIosViewportPanGuard,
  VISUAL_VIEWPORT_PAN_VAR,
} from '../platform/keyboard/ios-viewport-pan-guard.js';
import { settle } from './test-support.js';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

function cssSource(name: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(resolve(here, name), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
}

afterEach(async () => {
  if (root !== null) {
    await act(async () => {
      root!.unmount();
    });
  }
  host?.remove();
  root = null;
  host = null;
  disposeOverlayHost();
  document.body
    .querySelectorAll('.froglight-overlay-host')
    .forEach((el) => el.remove());
  document.documentElement.style.removeProperty('--fl-keyboard-inset-height');
  document.documentElement.style.removeProperty(VISUAL_VIEWPORT_PAN_VAR);
  document.getElementById('app')?.removeAttribute('style');
});

describe('modal usable-viewport ownership', () => {
  it('every modal backdrop reserves the effective overlay bottom', () => {
    const shared = cssSource('DialogSurface.module.css');
    const backdrop = shared.match(/\.backdrop\s*\{[^}]*\}/s)?.[0] ?? '';
    expect(backdrop).toContain('--fl-keyboard-overlay-bottom');
    expect(backdrop).toContain('--fl-keyboard-inset-height');
  });

  it('tall dialogs scroll inside the usable box instead of the backdrop', () => {
    // Simple cards stay content-sized but never exceed the backdrop: they
    // scroll internally. Settings keeps an overflow-hidden frame with
    // scrolling columns; the switcher card is bounded with a scrolling
    // list. The backdrop itself is never the scroll owner.
    const overlays = cssSource('Overlays.module.css');
    const modalCard =
      overlays.match(/\.froglight-modal\s*\{[^}]*\}/s)?.[0] ?? '';
    expect(modalCard).toContain('min-height: 0');
    expect(modalCard).toContain('max-height: 100%');
    expect(modalCard).toContain('overflow: hidden');
    expect(cssSource('DialogSurface.module.css')).toMatch(
      /\.body\s*\{[^}]*overflow-y: auto/s,
    );
    const backdropBlock =
      overlays.match(/\.froglight-modal-backdrop\s*\{[^}]*\}/s)?.[0] ?? '';
    expect(backdropBlock).not.toContain('overflow-y: auto');

    const newNote = cssSource('NewNoteModal.module.css');
    const newNoteCard = newNote.match(/\.new-note\s*\{[^}]*\}/s)?.[0] ?? '';
    expect(newNoteCard).toContain('min-height: 0');
    expect(newNoteCard).toContain('max-height: 100%');
    expect(newNoteCard).toContain('overflow: hidden');

    const launcher = cssSource('LauncherView.module.css');
    const vaultCard = launcher.match(/\.vault-modal\s*\{[^}]*\}/s)?.[0] ?? '';
    expect(vaultCard).toContain('min-height: 0');
    expect(vaultCard).toContain('max-height: 100%');
    expect(vaultCard).toContain('overflow: hidden');
    const vaultBackdrop =
      launcher.match(/\.vault-modal-backdrop\s*\{[^}]*\}/s)?.[0] ?? '';
    expect(vaultBackdrop).not.toContain('overflow-y: auto');

    const settings = cssSource('SettingsModal.module.css');
    const settingsFrame =
      settings.match(/\.settings-modal\s*\{[^}]*\}/s)?.[0] ?? '';
    expect(settingsFrame).toContain('overflow: hidden');
    expect(settingsFrame).toContain('min-height: 0');
    expect(settingsFrame).toContain('max-height: 100%');
    const settingsMain =
      settings.match(/\.settings-main\s*\{[^}]*\}/s)?.[0] ?? '';
    expect(settingsMain).toContain('min-height: 0');
    expect(settingsMain).toContain('overflow-y: auto');
    const settingsNav =
      settings.match(/\.settings-nav\s*\{[^}]*\}/s)?.[0] ?? '';
    expect(settingsNav).toContain('min-height: 0');
    const settingsNavList =
      settings.match(/\.settings-nav-list\s*\{[^}]*\}/s)?.[0] ?? '';
    expect(settingsNavList).toContain('overflow-y: auto');

    const switcher = cssSource('SwitcherOverlay.module.css');
    const switcherCard = switcher.match(/\.switcher\s*\{[^}]*\}/s)?.[0] ?? '';
    expect(switcherCard).toContain('max-height: 100%');
    const switcherList =
      switcher.match(/\.switcher-list\s*\{[^}]*\}/s)?.[0] ?? '';
    expect(switcherList).toContain('overflow-y: auto');
  });
});

describe('New Note modal (tablet keyboard avoidance)', () => {
  it('renders a full dialog at desktop width, not only the phone breakpoint', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(createElement(NewNoteModal, { onFinish: () => undefined, options: { kinds: TEST_NOTE_KINDS } }));
    });
    // The iPad regression was that only max-width:760px became
    // keyboard-aware; the backdrop class carrying the usable viewport now
    // renders at every width.
    const backdrop = document.body.querySelector(
      `.${newNoteStyles['new-note-backdrop']}`,
    );
    expect(backdrop).not.toBeNull();
    const dialog = document.body.querySelector(
      `.${newNoteStyles['new-note'].split(' ').join('.')}[role="dialog"]`,
    );
    expect(dialog).not.toBeNull();
  });

  it('keeps dialog content reachable with keyboard inset applied', async () => {
    document.documentElement.style.setProperty(
      '--fl-keyboard-inset-height',
      '300px',
    );
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(createElement(NewNoteModal, { onFinish: () => undefined, options: { kinds: TEST_NOTE_KINDS } }));
    });
    const input = document.body.querySelector<HTMLInputElement>(
      `.${newNoteStyles['new-note-input']}`,
    );
    expect(input).not.toBeNull();
    input!.focus();
    expect(document.activeElement).toBe(input);
  });

  it('tablet dialog uses the keyboard-free viewport above the shortened dock', async () => {
    // iPad-width structural contract (jsdom has no layout engine): the
    // modal usable viewport reserves the effective overlay bottom while
    // `.fl-main` owns the dock inset once; pixel recentering is left for
    // browser/physical acceptance. The shell check is ownership, not
    // spelling: `.fl-main` owns the inset exactly once and pane bodies
    // never subtract it again.
    const shell = cssSource('WorkspaceView.module.css');
    const mainBlock = shell.match(/\.fl-main\s*\{[^}]*\}/s)?.[0] ?? '';
    expect(mainBlock).toContain('--fl-keyboard-inset-height');
    const paneBodyBlock = shell.match(/\.fl-pane-body\s*\{[^}]*\}/s)?.[0] ?? '';
    expect(paneBodyBlock).not.toContain('--fl-keyboard-inset-height');
    const switcher = cssSource('DialogSurface.module.css');
    const switcherBackdrop =
      switcher.match(/\.backdrop\s*\{[^}]*\}/s)?.[0] ?? '';
    expect(switcherBackdrop).toContain('--fl-keyboard-inset-height');

    document.documentElement.style.setProperty(
      '--fl-keyboard-inset-height',
      '300px',
    );
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(createElement(NewNoteModal, { onFinish: () => undefined, options: { kinds: TEST_NOTE_KINDS } }));
    });
    const backdrop = document.body.querySelector(
      `.${newNoteStyles['new-note-backdrop']}`,
    );
    expect(backdrop).not.toBeNull();
    const input = document.body.querySelector<HTMLInputElement>(
      `.${newNoteStyles['new-note-input']}`,
    )!;
    input.focus();
    expect(document.activeElement).toBe(input);
    expect(
      document.documentElement.style.getPropertyValue(
        '--fl-keyboard-inset-height',
      ),
    ).toBe('300px');
  });
});

describe('generic prompt/confirm dialogs', () => {
  it('prompt opens a dialog and settles on Escape', async () => {
    const pending = uiPromptReact('Note name', {
      placeholder: 'Name',
      description: 'Choose a name for this document.',
    });
    await act(async () => {
      await settle();
    });
    expect(
      document.body.querySelector(
        `.${overlayStyles['froglight-modal-backdrop']}`,
      ),
    ).not.toBeNull();
    expect(
      document.body.querySelector(
        `.${overlayStyles['froglight-modal'].split(' ').join('.')}[role="dialog"]`,
      ),
    ).not.toBeNull();
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(
      document.getElementById(dialog.getAttribute('aria-labelledby')!)
        ?.textContent,
    ).toBe('Note name');
    expect(
      document.getElementById(dialog.getAttribute('aria-describedby')!)
        ?.textContent,
    ).toBe('Choose a name for this document.');
    expect(dialog.querySelector('input')?.getAttribute('aria-label')).toBe(
      'Note name',
    );
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
      await settle();
    });
    await expect(pending).resolves.toBeNull();
  });

  it('confirm opens a dialog and settles on Escape', async () => {
    const pending = uiConfirmReact('Delete note?');
    await act(async () => {
      await settle();
    });
    expect(
      document.body.querySelector(
        `.${overlayStyles['froglight-modal-backdrop']}`,
      ),
    ).not.toBeNull();
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
      await settle();
    });
    await expect(pending).resolves.toBe(false);
  });
});

describe('global overlay containing block (iPad regression)', () => {
  it('imperative backdrops mark the fixed surface with the viewport hook', async () => {
    const pending = uiPromptReact('Note name', { placeholder: 'Name' });
    await act(async () => {
      await settle();
    });
    const backdrop = document.body.querySelector(
      `.${overlayStyles['froglight-modal-backdrop']}`,
    ) as HTMLElement | null;
    expect(backdrop).not.toBeNull();
    expect(backdrop!.hasAttribute('data-fl-viewport-overlay')).toBe(true);
    // The host stays a plain positioning hook: no viewport marker, no
    // transform that would reparent the fixed containing block.
    const overlayHost = document.body.querySelector(
      '.froglight-overlay-host',
    ) as HTMLElement | null;
    expect(overlayHost).not.toBeNull();
    expect(overlayHost!.hasAttribute('data-fl-viewport-overlay')).toBe(false);
    expect(overlayHost!.style.transform).toBe('');
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
      await settle();
    });
    await expect(pending).resolves.toBeNull();
  });

  it('pan compensation never transforms the overlay host', async () => {
    const app = document.createElement('div');
    app.id = 'app';
    document.body.append(app);
    try {
      const pending = uiPromptReact('Note name', { placeholder: 'Name' });
      await act(async () => {
        await settle();
      });
      const overlayHost = document.body.querySelector(
        '.froglight-overlay-host',
      ) as HTMLElement | null;
      expect(overlayHost).not.toBeNull();
      const detach = attachIosViewportPanGuard({
        doc: document,
        viewport: {
          pageTop: 84,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        },
        isNativeHost: () => true,
        isIos: () => true,
        keyboardInsetHeight: () => 300,
        windowScrollY: () => 0,
      });
      try {
        expect(app.style.transform).toBe('translateY(84px)');
        expect(overlayHost!.style.transform).toBe('');
      } finally {
        detach();
      }
      await act(async () => {
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
        await settle();
      });
      await expect(pending).resolves.toBeNull();
    } finally {
      app.remove();
    }
  });

  it('global menu surfaces mark the fixed panel, not the host', async () => {
    const handle = showContextMenuReact(
      [{ label: 'Close pane', run: () => undefined }],
      { x: 40, y: 40 },
    );
    try {
      await act(async () => {
        await settle();
      });
      const menu = document.body.querySelector(
        `.${overlayStyles['fl-menu'].split(' ').join('.')}`,
      ) as HTMLElement | null;
      expect(menu).not.toBeNull();
      expect(menu!.hasAttribute('data-fl-viewport-overlay')).toBe(true);
      const overlayHost = document.body.querySelector(
        '.froglight-overlay-host',
      ) as HTMLElement | null;
      expect(overlayHost).not.toBeNull();
      expect(overlayHost!.style.transform).toBe('');
    } finally {
      await act(async () => {
        handle.close();
        await settle();
      });
    }
  });

  it('viewport compensation is self-translation driven by the pan var', () => {
    const shared = cssSource('DialogSurface.module.css');
    expect(shared).toContain('translate:');
    expect(shared).toContain('--fl-visual-viewport-pan-y');
    const overlays = cssSource('Overlays.module.css');
    expect(overlays).not.toContain('will-change: transform');
  });

  it('dialog cards stay ignorant of keyboard height (backdrop owns it)', () => {
    const overlays = cssSource('Overlays.module.css');
    const cardBlock =
      overlays.match(/\.froglight-modal\s*\{[^}]*\}/s)?.[0] ?? '';
    expect(cardBlock).not.toContain('--fl-keyboard-inset-height');
    expect(cardBlock).not.toContain('--fl-keyboard-overlay-bottom');
    const newNote = cssSource('NewNoteModal.module.css');
    const newNoteCard = newNote.match(/\.new-note\s*\{[^}]*\}/s)?.[0] ?? '';
    expect(newNoteCard).not.toContain('--fl-keyboard-inset-height');
    expect(newNoteCard).not.toContain('--fl-keyboard-overlay-bottom');
    const launcher = cssSource('LauncherView.module.css');
    const vaultCard = launcher.match(/\.vault-modal\s*\{[^}]*\}/s)?.[0] ?? '';
    expect(vaultCard).not.toContain('--fl-keyboard-inset-height');
    expect(vaultCard).not.toContain('--fl-keyboard-overlay-bottom');
  });
});
