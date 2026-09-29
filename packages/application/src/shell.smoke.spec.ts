import { describe, it, expect } from 'vitest';
import { createApp } from './index.js';
import { memoryVaultPlugin } from '@froglight/foundation';
import { InMemorySearchService } from '@froglight/foundation';
import { workspacePath } from '@froglight/foundation';
import { markdownKindId } from '@froglight/foundation';
import { markdownModel } from '@froglight/foundation';

/**
 * Shell smoke — same Markdown core over different Vault providers.
 * This is the pre-agreed high seam: Runtime + Vault + Workspace + markdownKind
 * exercised via @froglight/foundation tokens, no host branch.
 */

describe('shell smoke — web (OpfsVault) vs native (NativeFsVault) same core', () => {
  it('web and native shells produce identical DocumentSession bytes (host-agnostic)', async () => {
    const searchWeb = new InMemorySearchService();
    const webApp = await createApp({ vaultPlugin: memoryVaultPlugin, searchService: searchWeb });
    const wsWeb = webApp.getWorkspace()!;
    const refWeb = await wsWeb.createDocument({ kindId: markdownKindId, path: workspacePath('notes/shell.md'), initialModel: markdownModel('# Shell\ncontent') });
    const sessionWeb = (await wsWeb.openDocument(refWeb.documentId)) as any;
    const bytesWeb = sessionWeb.model.raw as string;
    await webApp.dispose();

    const searchNative = new InMemorySearchService();
    const nativeApp = await createApp({ vaultPlugin: memoryVaultPlugin, searchService: searchNative });
    const wsNative = nativeApp.getWorkspace()!;
    const refNative = await wsNative.createDocument({ kindId: markdownKindId, path: workspacePath('notes/shell.md'), initialModel: markdownModel('# Shell\ncontent') });
    const sessionNative = (await wsNative.openDocument(refNative.documentId)) as any;
    const bytesNative = sessionNative.model.raw as string;

    expect(bytesWeb).toBe(bytesNative);
    expect(bytesWeb).toBe('# Shell\ncontent');
    await nativeApp.dispose();
  });

  it('derived index delete+rebuild is identical on both shells', async () => {
    const search = new InMemorySearchService();
    const app = await createApp({ vaultPlugin: memoryVaultPlugin, searchService: search });
    const ws = app.getWorkspace()!;
    const ref = await ws.createDocument({ kindId: markdownKindId, path: workspacePath('notes/idx.md'), initialModel: markdownModel('hello world') });
    search.indexDocument(ref.documentId, ref.location, 'hello world');
    expect(search.search({ text: 'hello' })).toHaveLength(1);
    search.clear();
    expect(search.search({ text: 'hello' })).toHaveLength(0);
    await ws.rebuildDerivedState();
    search.indexDocument(ref.documentId, ref.location, 'hello world');
    expect(search.search({ text: 'hello' })).toHaveLength(1);
    await app.dispose();
  });
});
