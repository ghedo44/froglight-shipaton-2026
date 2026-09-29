/**
 * External-PDF → notebook import flow.
 *
 * Page selection, password prompting, toasting, and drawer closing arrive as
 * dependencies; the retry loop (password required / incorrect → reprompt,
 * dismissal aborts, other failures report) is pure orchestration and
 * unit-testable.
 */

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface PdfImportInput {
  readonly name: string;
  readonly bytes: Uint8Array;
}

export interface PdfImportDeps {
  readonly importPdfAsNotebook?: (
    input: PdfImportInput & {
      readonly password?: string;
      readonly selectedPageIndexes?: readonly number[];
    },
    opts: { readonly pane: string },
  ) => Promise<{ readonly pageCount: number }>;
  readonly focusedPane: string;
  /** Resolves the page selection, null on dismissal, undefined for all pages. */
  readonly selectPages: () => Promise<readonly number[] | null | undefined>;
  /** Resolves the entered password, or null when dismissed. */
  readonly promptPassword: (previousWasIncorrect: boolean) => Promise<string | null>;
  readonly toast: (text: string, kind?: 'ok' | 'error') => void;
  readonly closeDrawers: () => void;
}

export async function importPdfAsNotebookFlow(
  deps: PdfImportDeps,
  input: PdfImportInput,
): Promise<void> {
  const {
    importPdfAsNotebook,
    focusedPane,
    selectPages,
    promptPassword,
    toast,
    closeDrawers,
  } = deps;
  if (importPdfAsNotebook === undefined) {
    toast('PDF import is unavailable in this profile', 'error');
    return;
  }
  let selectedPageIndexes: readonly number[] | undefined;
  try {
    const selection = await selectPages();
    if (selection === null) return;
    selectedPageIndexes = selection;
  } catch (error) {
    toast(errorMessage(error), 'error');
    return;
  }
  let password: string | undefined;
  for (;;) {
    try {
      const result = await importPdfAsNotebook(
        {
          ...input,
          ...(password !== undefined ? { password } : {}),
          ...(selectedPageIndexes !== undefined ? { selectedPageIndexes } : {}),
        },
        { pane: focusedPane },
      );
      toast(
        `Imported ${result.pageCount} PDF page${result.pageCount === 1 ? '' : 's'} as a notebook`,
      );
      closeDrawers();
      return;
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null
          ? (error as { code?: unknown }).code
          : undefined;
      if (code !== 'PDF_PASSWORD_REQUIRED' && code !== 'PDF_PASSWORD_INCORRECT') {
        toast(`PDF import failed: ${errorMessage(error)}`, 'error');
        return;
      }
      const entered = await promptPassword(code === 'PDF_PASSWORD_INCORRECT');
      if (entered === null) return;
      password = entered;
    }
  }
}
