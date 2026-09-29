import type { DocumentToolControl } from '@froglight/foundation';
import type { IconName } from '../icons.js';
import { resolveIconPath } from '../icons.js';
import type {
  DocumentToolbarContext,
  DocumentToolbarRegistry,
} from '../document-toolbar-registry.js';
import type { ToolbarCompositionRegistry } from './composition-registry.js';

/** Sandbox-safe toolbar manifest. It contains no callbacks, DOM, CSS, or registry handles. */
export interface CommunityToolbarContribution {
  readonly id: string;
  readonly targetCategoryId: string;
  readonly label: string;
  readonly icon?: IconName;
  readonly commandId: string;
  readonly order?: number;
  readonly showInSqueeze?: boolean;
}

export interface CommunityToolbarCommandBroker {
  execute(
    pluginId: string,
    commandId: string,
    context: Pick<DocumentToolbarContext, 'pane' | 'documentId' | 'kindId'>,
  ): boolean | Promise<boolean>;
}

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export function validateCommunityToolbarContribution(
  value: CommunityToolbarContribution,
): readonly string[] {
  const errors: string[] = [];
  if (!SAFE_ID.test(value.id))
    errors.push('id must be a stable namespaced identifier');
  if (!SAFE_ID.test(value.targetCategoryId))
    errors.push('targetCategoryId is invalid');
  if (!SAFE_ID.test(value.commandId)) errors.push('commandId is invalid');
  if (value.label.trim().length === 0 || value.label.length > 80)
    errors.push('label must contain 1–80 characters');
  // Trusted-side icon allowlist: the icon must resolve through
  // the approved FrogLight registry at validation time — never an arbitrary
  // path/DOM payload. A missing icon stays valid (label-only control); a
  // regex-valid but unregistered name is rejected fail-closed so the UI can
  // never render an empty <path d="">. Live registry overrides (including
  // the R8 pen names) resolve automatically via resolveIconPath.
  if (
    value.icon !== undefined &&
    (typeof value.icon !== 'string' ||
      resolveIconPath(value.icon) === undefined)
  )
    errors.push(`icon '${String(value.icon)}' is not an approved FrogLight icon`);
  if (value.order !== undefined && !Number.isFinite(value.order))
    errors.push('order must be finite');
  return errors;
}

/**
 * Trusted host adapter for a validated community manifest. The returned
 * disposer owns both structure and execution registrations; a missing target
 * category remains dormant in the composition resolver and revives safely.
 */
export function registerCommunityToolbarContribution(input: {
  readonly pluginId: string;
  readonly manifest: CommunityToolbarContribution;
  readonly composition: ToolbarCompositionRegistry;
  readonly controls: DocumentToolbarRegistry;
  readonly broker: CommunityToolbarCommandBroker;
  readonly kindIds?: readonly string[];
}): { dispose(): void } {
  const errors = validateCommunityToolbarContribution(input.manifest);
  if (errors.length > 0) throw new TypeError(errors.join('; '));
  if (!SAFE_ID.test(input.pluginId)) throw new TypeError('pluginId is invalid');
  const semanticRole = `community.${input.pluginId}.${input.manifest.id}`;
  const controlId = `${semanticRole}.command`;
  const control: DocumentToolControl = {
    kind: 'button',
    id: controlId,
    group: 'community',
    label: input.manifest.label,
    shortLabel: input.manifest.label,
    ...(input.manifest.icon !== undefined ? { icon: input.manifest.icon } : {}),
    semanticRole,
  };
  const structure = input.composition.registerItem({
    id: `${semanticRole}.item`,
    categoryId: input.manifest.targetCategoryId,
    semanticRole,
    order: input.manifest.order,
    projections:
      input.manifest.showInSqueeze === true
        ? ['normal', 'compact', 'squeeze']
        : ['normal', 'compact'],
  });
  const execution = input.controls.register({
    id: `${semanticRole}.owner`,
    order: input.manifest.order,
    when: (context) => input.kindIds?.includes(context.kindId) ?? true,
    controls: () => [control],
    execute: (context, id) =>
      id === controlId
        ? input.broker.execute(
            input.pluginId,
            input.manifest.commandId,
            context,
          )
        : false,
  });
  return {
    dispose(): void {
      execution.dispose();
      structure.dispose();
    },
  };
}
