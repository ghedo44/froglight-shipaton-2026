/**
 * Per-document workspace settings are derived configuration, never canonical
 * document content. Opaque document ids are normalized without allowing two
 * different ids to collapse onto the same settings key.
 */
export function documentSettingKey(documentId: string, field: string): string {
  const safe = /^[A-Za-z0-9_-]+$/.test(documentId)
    ? documentId
    : `${documentId.replace(/[^A-Za-z0-9_-]/g, '_')}-${hashId(documentId)}`;
  return `note.${safe}.${field}`;
}

function hashId(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}
