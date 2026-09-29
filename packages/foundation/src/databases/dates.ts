import {
  isDateRange,
  isIsoDate,
  type PropertyValue,
} from '../resource-properties/catalog.js';

/** A date view projects intervals; moving a range preserves its duration. */
export function databaseDateInterval(
  value: PropertyValue,
): { start: string; end: string } | null {
  if (isIsoDate(value)) return { start: value, end: value };
  if (
    isDateRange(value) &&
    isIsoDate(value.start) &&
    isIsoDate(value.end) &&
    Date.parse(value.end) >= Date.parse(value.start)
  )
    return { start: value.start, end: value.end };
  return null;
}

export function moveDatabaseDate(
  value: PropertyValue,
  day: string,
): PropertyValue {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !isIsoDate(day))
    throw new Error('Expected a valid calendar day');
  if (value === null) return day;
  const interval = databaseDateInterval(value);
  if (!interval) throw new Error('Cannot reschedule an invalid date');
  const delta = Date.parse(day) - Date.parse(interval.start.slice(0, 10));
  const shift = (date: string) => {
    const shifted = new Date(Date.parse(date) + delta).toISOString();
    return date.length === 10 ? shifted.slice(0, 10) : shifted;
  };
  return isDateRange(value)
    ? { ...value, start: shift(value.start), end: shift(value.end) }
    : shift(interval.start);
}
