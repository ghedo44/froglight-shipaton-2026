import type { CommandService } from '@froglight/foundation';
import type {
  CommunityToolbarHost,
  CommunityToolbarManifest,
} from '@froglight/plugin-platform';
import type { IconName } from '../icons.js';
import type { DocumentToolbarRegistry } from '../document-toolbar-registry.js';
import type { ToolbarCompositionRegistry } from './composition-registry.js';
import {
  registerCommunityToolbarContribution,
  type CommunityToolbarCommandBroker,
} from './community-contribution.js';

/**
 * Trusted host bridge for community toolbar contributions.
 *
 * Single execution owner, sandbox-safe DTO, broker routing. Community code
 * never receives React, DOM, CSS, handles, or registry objects: it passes
 * a validated manifest through the platform facade, and this host owns
 * both structure (composition item) and execution (control + broker) as
 * one reversible effect. Dormant categories stay dormant; disposal removes
 * both registrations together.
 *
 * Dependency direction: ui → plugin-platform. The host implements the
 * platform's `CommunityToolbarHost` contract; the platform never imports
 * ui registries.
 */
export function createCommunityToolbarHost(input: {
  readonly composition: ToolbarCompositionRegistry;
  readonly controls: DocumentToolbarRegistry;
  readonly commands: Pick<CommandService, 'execute'>;
}): CommunityToolbarHost {
  const broker: CommunityToolbarCommandBroker = {
    execute: (pluginId, commandId) => {
      void pluginId;
      // Fail-closed: an unregistered command resolves to false, never a
      // throw into the toolbar. The toolbar context (pane/document/kind)
      // is intentionally not forwarded to global commands.
      return input.commands.execute(commandId).then(
        (result) => result.ok === true,
        () => false,
      );
    },
  };
  return {
    registerToolbar(pluginId: string, manifest: CommunityToolbarManifest) {
      // Trusted-side re-validation (defense in depth): the facade already
      // validated, but the host is the authority boundary and never trusts
      // the crossing.
      return registerCommunityToolbarContribution({
        pluginId,
        manifest: {
          id: manifest.id,
          targetCategoryId: manifest.targetCategoryId,
          label: manifest.label,
          ...(manifest.icon !== undefined
            ? { icon: manifest.icon as IconName }
            : {}),
          commandId: manifest.commandId,
          ...(manifest.order !== undefined ? { order: manifest.order } : {}),
          ...(manifest.showInSqueeze !== undefined
            ? { showInSqueeze: manifest.showInSqueeze }
            : {}),
        },
        composition: input.composition,
        controls: input.controls,
        broker,
      });
    },
  };
}
