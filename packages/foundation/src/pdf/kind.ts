import type { DocumentKindDescriptor } from '../documents.js';
import { documentKindId } from '../identity.js';

export interface PdfSourceModel {
  readonly bytes: Uint8Array;
}

export const pdfKindId = documentKindId('froglight.pdf');

export const pdfKind: DocumentKindDescriptor<PdfSourceModel> = {
  id: pdfKindId,
  importExtensions: ['.pdf'],
  recognize: (value) =>
    value === pdfKindId ||
    (typeof value === 'string' && value.toLocaleLowerCase('en-US').endsWith('.pdf')),
  decode: (bytes) => ({
    model: { bytes: bytes.slice() },
    metadata: {},
    relationships: [],
  }),
  encode: (model) => model.bytes.slice(),
  searchText: () => '',
};
