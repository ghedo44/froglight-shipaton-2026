/**
 * Test helper: assert a value is present and return it narrowed.
 *
 * Specs prefer this over non-null assertions so lint stays clean while
 * failing loudly when an expected value is missing.
 */

export function requireValue<T>(value: T | null | undefined, label = 'value'): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${label} to be present`);
  }
  return value;
}
