import { workspacePath } from '../paths.js';
import type { VaultService } from '../vault/contract.js';

/** Find existing raster attachments without reading their bytes. */
export async function searchMarkdownImageFiles(
  vault: VaultService | null,
  query: string,
): Promise<readonly string[]> {
  if (vault === null) return [];
  const pending = [''];
  const matches: string[] = [];
  let inspected = 0;
  const needle = query.toLocaleLowerCase();
  while (pending.length > 0 && inspected < 2000 && matches.length < 40) {
    const dir = pending.shift()!;
    let entries;
    try {
      entries = await vault.list(workspacePath(dir));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++inspected > 2000) break;
      if (entry.name === '.froglight') continue;
      const path = dir === '' ? entry.name : `${dir}/${entry.name}`;
      if (entry.kind === 'directory') pending.push(path);
      else if (
        /\.(?:png|jpe?g|gif|webp|avif)$/i.test(path) &&
        path.toLocaleLowerCase().includes(needle)
      )
        matches.push(path);
    }
  }
  return matches;
}
