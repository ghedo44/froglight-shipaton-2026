import { describe, expect, it } from 'vitest';
import { createServiceProbe } from '@froglight/runtime';
import {
  documentPresentationToken,
  documentRegistryToken,
  markdownKind,
  pdfKind,
  memoryVaultPlugin,
} from '@froglight/foundation';
import { createApp } from './index.js';
import { firstPartyDocumentFeatures } from './document-features.js';

describe('first-party document feature closure', () => {
  it('registers one kind, presentation and optional outline per declaration', async () => {
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      documentFeatures: firstPartyDocumentFeatures,
    });
    const probe = createServiceProbe({
      pluginId: 'test.document-presentation-probe',
      token: documentPresentationToken,
    });
    const kindProbe = createServiceProbe({
      pluginId: 'test.document-kind-probe',
      token: documentRegistryToken,
    });
    try {
      await app.runtime.registerSlot({
        id: 'test-presentations',
        plugin: probe.plugin,
      });
      await app.runtime.registerSlot({
        id: 'test-kinds',
        plugin: kindProbe.plugin,
      });
      const presentations = probe.get();
      const registry = kindProbe.get();
      expect(presentations).not.toBeNull();
      for (const feature of firstPartyDocumentFeatures) {
        expect(app.getDocumentKind(feature.kind.id)).toBe(feature.kind);
        expect(presentations?.get(feature.kind.id)?.icon).toBe(
          feature.presentation?.icon,
        );
        expect(presentations?.get(feature.kind.id)?.label).toBe(
          feature.presentation?.label,
        );
        const accepted = [
          ...(feature.kind.creation ? [feature.kind.creation.extension] : []),
          ...(feature.kind.importExtensions ?? []),
        ];
        if (accepted.length > 0) {
          expect(accepted.every((extension) => extension.startsWith('.'))).toBe(
            true,
          );
          for (const extension of accepted) {
            expect(registry?.forImportExtension(extension)).toBe(feature.kind);
          }
        }
        if (feature.outline) {
          expect(app.getOutlineRegistry().get(feature.kind.id)).toBe(
            feature.outline,
          );
        }
      }
      expect(presentations?.get(pdfKind.id)?.label).toBe('PDF');

      const markdown = firstPartyDocumentFeatures[0]!;
      await app.runtime.removeSlot(
        `document-feature:${markdown.kind.id}:presentation`,
      );
      expect(presentations?.get(markdown.kind.id)).toBeNull();
      expect(app.getDocumentKind(markdown.kind.id)).toBe(markdown.kind);
      expect(app.getOutlineRegistry().get(markdown.kind.id)).toBe(
        markdown.outline,
      );
    } finally {
      await app.dispose();
    }
  });

  it('withdraws editor and reader slots without withdrawing the kind', async () => {
    const editor = {
      id: 'test.markdown-editor',
      kindIds: [markdownKind.id],
      createEditor: (): never => {
        throw new Error('Mount is outside this test');
      },
    };
    const reader = {
      id: 'test.markdown-reader',
      kindIds: [markdownKind.id],
      createReader: (): never => {
        throw new Error('Mount is outside this test');
      },
    };
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      documentFeatures: [{ kind: markdownKind, editor, reader }],
    });
    try {
      expect(app.getDocumentEditor(markdownKind.id)).toBe(editor);
      expect(app.getDocumentReader(markdownKind.id)).toBe(reader);
      await app.runtime.removeSlot(
        `document-feature:${markdownKind.id}:editor`,
      );
      expect(app.getDocumentEditor(markdownKind.id)).toBeNull();
      expect(app.getDocumentReader(markdownKind.id)).toBe(reader);
      expect(app.getDocumentKind(markdownKind.id)).toBe(markdownKind);
    } finally {
      await app.dispose();
    }
  });
});
