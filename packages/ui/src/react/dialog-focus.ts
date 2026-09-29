/** Keep keyboard traversal within the current modal, including nested dialogs. */
export function trapDialogFocus(
  event: KeyboardEvent,
  dialog: HTMLElement | null,
): void {
  if (dialog === null) return;
  const controls = [
    ...dialog.querySelectorAll<HTMLElement>(
      'button, input, select, textarea, a[href], [tabindex]',
    ),
  ].filter((element) => {
    const style = getComputedStyle(element);
    return (
      element.tabIndex >= 0 &&
      !element.hasAttribute('disabled') &&
      !element.closest('[hidden], [inert]') &&
      style.display !== 'none' &&
      style.visibility !== 'hidden'
    );
  });
  const first = controls[0];
  const last = controls.at(-1);
  if (!first || !last) return;
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !dialog.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}
