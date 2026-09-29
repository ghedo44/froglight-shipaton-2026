/**
 * Below-keyboard slot claims (keyboard coordinator split).
 *
 * Slot-claim state (keyboard vs. surface vs. held) lives in the
 * ShellController in `../keyboard-inset.js`, which retains the public shell
 * API; the pure inset-selection rule lives here and the controller calls
 * it, so slot policy is owned in exactly one place.
 */

/** Select the reserved bottom inset given slot and keyboard state. */
export function selectSlotInset(input: {
  readonly slotClaimed: boolean;
  readonly pendingKeyboard: boolean;
  readonly surfaceHeight: number;
  readonly keyboardHeight: number;
}): number {
  return input.slotClaimed || input.pendingKeyboard
    ? input.surfaceHeight
    : input.keyboardHeight;
}
