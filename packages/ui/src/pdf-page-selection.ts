import { uiPrompt } from './dialogs.js';

export function parsePdfPageSelection(
  value: string,
): readonly number[] | undefined {
  const normalized = value.trim().toLocaleLowerCase('en-US');
  if (normalized === '' || normalized === 'all') return undefined;
  const pages = new Set<number>();
  for (const part of normalized.split(',')) {
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part.trim());
    if (match === null)
      throw new Error('Use page numbers such as 1-3, 5, 8-10');
    const first = Number(match[1]);
    const last = Number(match[2] ?? match[1]);
    if (first < 1 || last < first)
      throw new Error('Page ranges must start at 1 and run forward');
    if (last > 10_000 || pages.size + last - first + 1 > 10_000) {
      throw new Error('The page selection exceeds the 10,000-page limit');
    }
    for (let page = first; page <= last; page += 1) pages.add(page - 1);
  }
  return [...pages].sort((a, b) => a - b);
}

export async function uiPdfPageSelection(): Promise<
  readonly number[] | undefined | null
> {
  const value = await uiPrompt('Choose PDF pages', {
    description: 'Enter “all”, a range, or a list such as 1-3, 5, 8-10.',
    initialValue: 'all',
    confirmLabel: 'Import pages',
  });
  return value === null ? null : parsePdfPageSelection(value);
}
