/**
 * SDK-only dogfooding plugin — proves first-party features can build
 * against `@froglight/sdk` facades alone, without raw runtime/provider imports.
 * It demonstrates the plugin platform's SDK-only activation path.
 *
 * It registers a command `froglight.dogfood.ping` via the SDK facades and
 * tracks lifecycle via the runtime's effect ownership. No deep imports, no
 * host branches.
 */

export const DOGFOOD_MANIFEST = {
  manifestVersion: 1 as const,
  id: 'froglight.dogfood',
  version: '1.0.0',
  froglightSdk: '^0.1.0',
  permissions: ['workspace.commands.register', 'workspace.settings.read'] as const,
} as const;

export function createDogfoodActivate() {
  return async ({ facades }: { facades: { commands: { register: (c: any) => { dispose(): void } }; settings: { get: (k: string) => unknown } } }) => {
    const handle = facades.commands.register({
      id: 'froglight.dogfood.ping',
      title: 'Dogfood Ping',
      execute: () => 'pong-dogfood',
    });
    // Demonstrate reading settings via facade (scoped, permission-checked)
    facades.settings.get('froglight.dogfood.enabled');
    return () => handle.dispose();
  };
}
