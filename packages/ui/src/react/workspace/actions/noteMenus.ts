/**
 * Per-pane note ("…") menu entries.
 *
 * Pure menu description: reveal-in-explorer, wiki-link copy, copy, the
 * per-document reading default, and delete. Clipboard, settings, and
 * controller effects arrive as callbacks so the entries stay unit-testable.
 */

import type { MenuEntry } from '../../../menu.js';

export interface NoteMenuContext {
  readonly documentId: string;
  readonly documentTitle: string | null;
  readonly documentPath: string;
  readonly readingDefault: boolean;
  readonly revealInExplorer: () => void;
  readonly writeClipboard: (text: string) => Promise<void>;
  readonly onClipboardUnavailable: () => void;
  readonly makeCopy: (copyPath: string) => void;
  readonly setReadingDefault: (value: boolean) => void;
  /** Applied immediately when the reading default is turned on. */
  readonly applyReadingModeNow: () => void;
  readonly deleteDocument: () => void;
  readonly openProperties?: () => void;
  readonly splitRight?: () => void;
  readonly splitDown?: () => void;
}

export function buildNoteMenuEntries(
  context: NoteMenuContext,
): readonly MenuEntry[] {
  const {
    documentId,
    documentTitle,
    documentPath,
    readingDefault,
    revealInExplorer,
    writeClipboard,
    onClipboardUnavailable,
    makeCopy,
    setReadingDefault,
    applyReadingModeNow,
    deleteDocument,
    openProperties,
    splitRight,
    splitDown,
  } = context;
  return [
    ...(splitRight && splitDown
      ? [
          { label: 'Split right', icon: 'split-right', run: splitRight },
          { label: 'Split down', icon: 'split-down', run: splitDown },
          'separator' as const,
        ]
      : []),
    ...(openProperties
      ? [{ label: 'Properties', icon: 'blocks', run: openProperties }]
      : []),
    {
      label: 'Reveal in file explorer',
      icon: 'folder',
      run: () => revealInExplorer(),
    },
    {
      label: 'Copy wiki-link',
      icon: 'link',
      run: () => {
        const title = documentTitle?.replace(/\.\w+$/i, '') ?? documentId;
        void writeClipboard(`[[${title}]]`).catch(() => {
          onClipboardUnavailable();
        });
      },
    },
    {
      label: 'Make a copy',
      icon: 'file-plus',
      run: () => {
        makeCopy(documentPath.replace(/(\.\w+)?$/i, ' copy$&'));
      },
    },
    'separator',
    {
      label: 'Always open in reading view',
      checked: readingDefault,
      run: () => {
        setReadingDefault(!readingDefault);
        if (!readingDefault) applyReadingModeNow();
      },
    },
    'separator',
    {
      label: 'Delete note',
      icon: 'trash',
      danger: true,
      run: () => deleteDocument(),
    },
  ];
}
