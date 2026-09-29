/**
 * WebView drop guard: the shell must never navigate away on an OS file drop.
 *
 * Froglight's file explorer handles drops over its own tree, but a drop
 * anywhere else (editor area, empty pane, sidebar gaps) — or one the tree
 * guards do not recognize — otherwise falls through to the WebView default:
 * navigating to the file URL, which replaces the entire app with a file
 * viewer. This guard suppresses that default at the window in capture
 *  `preventDefault` only, following the doctrine:
 * propagation is never stopped, so the explorer's own import handlers
 * still receive every event.
 *
 * Framework-free and host-free: mounted once by `mountFroglightApp` so web
 * and native shells share it; headless compositions never touch the DOM.
 */

type DropGuardScope = Pick<Window, 'addEventListener' | 'removeEventListener'>;

/**
 * Install window-level `dragover`/`drop` suppression. Returns an
 * uninstaller that removes exactly the listeners it installed. No-op
 * without a DOM scope.
 */
export function installWebviewDropGuard(
  scope?: DropGuardScope | Document | null,
): () => void {
  const target =
    scope ??
    (typeof window === 'undefined'
      ? null
      : (window as unknown as DropGuardScope));
  if (target === null || target === undefined) return () => undefined;
  const suppress = (event: Event): void => {
    event.preventDefault();
  };
  target.addEventListener('dragover', suppress, true);
  target.addEventListener('drop', suppress, true);
  let installed = true;
  return () => {
    if (!installed) return;
    installed = false;
    target.removeEventListener('dragover', suppress, true);
    target.removeEventListener('drop', suppress, true);
  };
}
