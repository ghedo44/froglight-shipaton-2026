import type {
  DocumentKindId,
  DocumentPresentationRegistry,
} from '@froglight/foundation';

/** One picker row derived from the live kind and presentation registries. */
export interface NoteKindOption {
  readonly id: string;
  readonly kindId: DocumentKindId;
  readonly label: string;
  readonly description: string;
  readonly extension: string;
  readonly icon: string;
  readonly available: true;
}

export function noteKindOption(
  kind: { readonly id: DocumentKindId; readonly creation?: { readonly label: string; readonly extension: string } },
  presentations?: DocumentPresentationRegistry | null,
): NoteKindOption | null {
  const creation = kind.creation;
  if (!creation) return null;
  const presentation = presentations?.get(kind.id);
  return {
    id: String(kind.id),
    kindId: kind.id,
    label: creation.label,
    description: presentation?.description ?? 'Document',
    extension: creation.extension,
    icon: presentation?.icon ?? 'file',
    available: true,
  };
}
