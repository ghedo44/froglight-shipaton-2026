/**
 * PDF import wiring: the `froglight:import-pdf` event plus the shared flow.
 *
 * The event carries `{ name, bytes }`; malformed payloads report instead of
 * throwing. Page selection, password prompts, toasts, and drawer closing
 * come from the composition root; the retry loop lives in
 * `actions/pdfImport`.
 */

import { useCallback, useEffect } from 'react';
import type { WorkbenchImportExportPort } from '../../../workbench-ports.js';
import { workspaceEvents as events } from '../../../ui-events.js';
import { uiPrompt } from '../../../dialogs.js';
import { uiPdfPageSelection } from '../../../pdf-page-selection.js';
import { importPdfAsNotebookFlow } from '../actions/pdfImport.js';
import type { Notify } from './useToast.js';

export function usePdfImport(input: {
  readonly pdf: WorkbenchImportExportPort;
  readonly focusedPane: string;
  readonly eventTarget: HTMLElement | undefined;
  readonly getRoot: () => HTMLElement | null;
  readonly notify: Notify;
  readonly closeDrawers: () => void;
}): {
  readonly importPdf: (file: {
    readonly name: string;
    readonly bytes: Uint8Array;
  }) => Promise<void>;
} {
  const { pdf, focusedPane, eventTarget, getRoot, notify, closeDrawers } =
    input;

  const importPdf = useCallback(
    async (file: {
      readonly name: string;
      readonly bytes: Uint8Array;
    }): Promise<void> => {
      const importPdfAsNotebook = pdf.importPdfAsNotebook;
      await importPdfAsNotebookFlow(
        {
          importPdfAsNotebook:
            importPdfAsNotebook === undefined
              ? undefined
              : (payload, opts) => importPdfAsNotebook.call(pdf, payload, opts),
          focusedPane,
          selectPages: () => uiPdfPageSelection(),
          promptPassword: (previousWasIncorrect) =>
            uiPrompt(
              previousWasIncorrect
                ? 'That password did not unlock the PDF'
                : 'Unlock PDF',
              {
                description:
                  'The password is used only for this import and is not saved.',
                placeholder: 'PDF password',
                confirmLabel: 'Unlock and import',
                inputType: 'password',
              },
            ),
          toast: notify,
          closeDrawers,
        },
        file,
      );
    },
    [pdf, focusedPane, notify, closeDrawers],
  );

  useEffect(() => {
    const root = eventTarget ?? getRoot();
    if (root === null) return;
    const onImport = (event: Event): void => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (
        typeof detail !== 'object' ||
        detail === null ||
        typeof (detail as { name?: unknown }).name !== 'string' ||
        !((detail as { bytes?: unknown }).bytes instanceof Uint8Array)
      ) {
        notify(
          'PDF import failed: the selected file could not be read',
          'error',
        );
        return;
      }
      void importPdf(detail as { name: string; bytes: Uint8Array });
    };
    root.addEventListener(events.importPdf, onImport);
    return () => root.removeEventListener(events.importPdf, onImport);
  }, [eventTarget, getRoot, importPdf, notify]);

  return { importPdf };
}
