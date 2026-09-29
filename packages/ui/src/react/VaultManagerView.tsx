/**
 * Vault switcher header view — declarative React over the vault-manager
 * service boundary.
 *
 * Behavior freeze of the previous imperative `render` builder
 * (`el.classList.add('vault-switcher')` with no children, handlers, or
 * service reads): same class, same empty content, same outcome. The
 * `VaultManagerService` stays the framework-free source of truth in
 * `vault-manager.ts`; this component owns no presentation state because
 * the frozen view has none.
 *
 * No colocated stylesheet: no CSS rule targets `.vault-switcher`
 * repo-wide, so there is nothing to move.
 */
export function VaultManagerView(): React.ReactElement {
  return <div className="vault-switcher" />;
}
