// Repo-root PostCSS config — auto-loaded by every Vite transform in this
// workspace (app dev servers, production builds, and Vitest CSS handling).
//
// Single purpose: prepend the Froglight cascade-layer order to every
// stylesheet. Layer priority follows first declaration, and component
// structure (`@layer components`) must outrank global element defaults
// (`@layer globals`): without a leading declaration, whichever stylesheet
// the bundler emits first wins, so a `button` reset can silently beat
// `.btn` and leave launcher buttons, tabs, and modals unstyled. Reading
// the order from `packages/ui/src/styles/layers.css` keeps that file the
// single source; `themeLayerOrder` in `packages/ui/src/theme.ts` mirrors
// it for the runtime-injected bundle (pinned by `theme-shell.spec.ts`).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const layersParams = readFileSync(
  join(root, 'packages', 'ui', 'src', 'styles', 'layers.css'),
  'utf8',
)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .trim()
  .replace(/^@layer\s+/, '')
  .replace(/;\s*$/, '');

const normalize = (value) => value.replace(/\s+/g, '');

const froglightLayerOrder = () => ({
  postcssPlugin: 'froglight-layer-order',
  Once(cssRoot, { result }) {
    // `from` keeps the Vite query (`layers.css?inline`): strip it before
    // matching, or the layers source gets its own declaration twice.
    const from = (result.opts.from ?? '').split('?', 1)[0];
    // The layers source declares the order itself; anything already
    // starting with the identical statement needs no duplicate.
    if (from.endsWith('layers.css')) return;
    const first = cssRoot.first;
    if (
      first?.type === 'atrule' &&
      first.name === 'layer' &&
      first.nodes === undefined &&
      normalize(first.params) === normalize(layersParams)
    ) {
      return;
    }
    cssRoot.prepend({ name: 'layer', params: layersParams });
  },
});
froglightLayerOrder.postcss = true;

export default {
  plugins: [froglightLayerOrder()],
};
