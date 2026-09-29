import type {
  DatabaseProperty,
  EvaluatedDatabaseRow,
  PropertyValue,
} from '@froglight/foundation';

/** Flatten an evaluated view for exchange; canonical backup uses portable bundles. */
export function databaseRowsToCsv(
  properties: readonly DatabaseProperty[],
  rows: readonly EvaluatedDatabaseRow[],
  spreadsheetSafe: boolean,
): string {
  const headers = [
    'Resource ID',
    'Title',
    'Kind',
    'Path',
    ...properties.map((property) => `${property.name} [${property.id}]`),
  ];
  const lines = [
    headers.map((value) => csvCell(value, spreadsheetSafe)).join(','),
    ...rows.map((row) =>
      [
        row.resourceId,
        row.title,
        row.kindId,
        row.path,
        ...properties.map((property) => row.values[property.id] ?? null),
      ]
        .map((value) => csvCell(value, spreadsheetSafe))
        .join(','),
    ),
  ];
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

function csvCell(value: PropertyValue, spreadsheetSafe: boolean): string {
  const text =
    value === null
      ? ''
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
  const safe =
    spreadsheetSafe &&
    typeof value === 'string' &&
    /^[\s\p{Cc}]*[=+\-@＝＋－＠]/u.test(text)
      ? `\t${text}`
      : text;
  return `"${safe.replaceAll('"', '""')}"`;
}
