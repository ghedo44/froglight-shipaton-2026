export interface TouchContact {
  readonly id: number;
  readonly x: number;
  readonly y: number;
}

export type PrimaryTouchIds = readonly [number, number];
export type PrimaryTouchPair = readonly [TouchContact, TouchContact];

/**
 * Keep surviving primary contacts, filling vacancies by the lowest pointer id.
 * Selection is independent of iterable order and stable with 3+ contacts.
 */
export function primaryTouchPair(
  contacts: Iterable<TouchContact>,
  previous: PrimaryTouchIds | null = null,
): PrimaryTouchPair | null {
  const byId = new Map<number, TouchContact>();
  for (const contact of contacts) {
    if (
      !Number.isFinite(contact.id) ||
      !Number.isFinite(contact.x) ||
      !Number.isFinite(contact.y)
    )
      continue;
    if (!byId.has(contact.id)) byId.set(contact.id, contact);
  }
  if (byId.size < 2) return null;

  const selected: TouchContact[] = [];
  if (previous !== null) {
    for (const id of previous) {
      const contact = byId.get(id);
      if (contact !== undefined && !selected.some((item) => item.id === id))
        selected.push(contact);
    }
  }
  const remaining = [...byId.values()].sort((a, b) => a.id - b.id);
  for (const contact of remaining) {
    if (selected.length === 2) break;
    if (!selected.some((item) => item.id === contact.id))
      selected.push(contact);
  }
  return selected.length === 2
    ? (selected as [TouchContact, TouchContact])
    : null;
}
