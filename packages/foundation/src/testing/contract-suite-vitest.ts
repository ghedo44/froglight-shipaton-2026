/**
 * Vitest adapter for the portable vault contract suite.
 *
 * Maps each suite case onto a vitest `it`. The same adapter is used by the
 * in-memory reference provider and the native provider package, so all
 * providers are exercised through identical assertions.
 */

import { describe, it } from 'vitest';
import {
  createVaultContractSuite,
  type VaultContractSuiteOptions,
} from '../vault/contract-suite.js';

/** Register the full contract suite as a vitest `describe` block. */
export function registerVaultContractSuite(
  suiteName: string,
  options: VaultContractSuiteOptions,
): void {
  describe(suiteName, () => {
    const cases = createVaultContractSuite(options);
    for (const suiteCase of cases) {
      it(suiteCase.name, async () => {
        await suiteCase.run();
      });
    }
  });
}
