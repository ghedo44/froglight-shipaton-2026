import nx from '@nx/eslint-plugin';

// Vite is build tooling only. These option fragments are shared by
// the global ban and the native-adapter override below so the two blocks
// cannot drift apart.
const viteImportBanPaths = [
  {
    name: 'vite',
    message:
      'Vite is build tooling only. Keep it in vite.config.ts.',
  },
  {
    name: 'vite-plugin-pwa',
    message:
      'Vite PWA plugin is build tooling only. Keep it in vite.config.ts.',
  },
];

const viteImportBanPatterns = [
  {
    group: ['@vitejs/*', 'vite-*', 'vite-plugin-*'],
    message: 'Vite plugins are build tooling only. Keep them in vite.config.ts.',
  },
];

const tauriImportBanPatterns = [
  {
    group: ['@tauri-apps/*'],
    message:
      'Tauri APIs stay under the native adapter layer (apps/native). Shared packages must use capability contracts.',
  },
];

export default [
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  {
    ignores: [
      '**/dist',
      '**/out-tsc',
      '**/vitest.config.*.timestamp*',
      '**/dev-dist',
      '**/src-tauri/target',
      '**/src-tauri/gen',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: ['^.*/eslint(\\.base)?\\.config\\.[cm]?[jt]s$'],
          // The Firebase SDK is lazy-loaded by both app hosts (dynamic
          // import only when configured), so the provider package must
          // not be imported statically — except for its SDK-free seams
          // (env resolution, unconfigured remote, local storage), which
          // the startup path needs before deciding whether to load the
          // SDK at all.
          checkDynamicDependenciesExceptions: [
            '@froglight/provider-firebase/config-env',
            '@froglight/provider-firebase/sync-storage',
          ],
          depConstraints: [
            {
              sourceTag: 'layer:runtime',
              onlyDependOnLibsWithTags: ['layer:runtime'],
            },
            {
              sourceTag: 'layer:sdk',
              onlyDependOnLibsWithTags: ['layer:runtime', 'layer:capability'],
            },
            {
              sourceTag: 'layer:capability',
              onlyDependOnLibsWithTags: ['layer:runtime', 'layer:capability'],
            },
            {
              sourceTag: 'layer:provider',
              onlyDependOnLibsWithTags: [
                'layer:runtime',
                'layer:capability',
                'layer:provider',
              ],
            },
            {
              sourceTag: 'layer:plugin',
              onlyDependOnLibsWithTags: [
                'layer:runtime',
                'layer:sdk',
                'layer:capability',
                'layer:plugin',
              ],
            },
            {
              sourceTag: 'layer:application',
              onlyDependOnLibsWithTags: [
                'layer:runtime',
                'layer:sdk',
                'layer:capability',
                'layer:provider',
                'layer:plugin',
                'layer:application',
              ],
            },
            {
              sourceTag: 'layer:app',
              onlyDependOnLibsWithTags: [
                'layer:runtime',
                'layer:sdk',
                'layer:capability',
                'layer:provider',
                'layer:plugin',
                'layer:application',
              ],
            },
            {
              sourceTag: 'platform:shared',
              onlyDependOnLibsWithTags: ['platform:shared'],
            },
            {
              sourceTag: 'platform:web',
              onlyDependOnLibsWithTags: ['platform:shared', 'platform:web'],
            },
            {
              sourceTag: 'platform:native',
              onlyDependOnLibsWithTags: [
                'platform:shared',
                'platform:native',
                'platform:headless',
              ],
            },
            {
              sourceTag: 'platform:headless',
              onlyDependOnLibsWithTags: [
                'platform:shared',
                'platform:headless',
              ],
            },
            {
              sourceTag: 'authority:trusted',
              onlyDependOnLibsWithTags: [
                'authority:trusted',
                'authority:portable',
              ],
            },
            {
              sourceTag: 'authority:portable',
              onlyDependOnLibsWithTags: [
                'authority:portable',
                'authority:trusted',
              ],
            },
            {
              sourceTag: 'authority:sandboxed',
              onlyDependOnLibsWithTags: [
                'authority:sandboxed',
                'authority:portable',
              ],
            },
            {
              sourceTag: 'authority:native',
              onlyDependOnLibsWithTags: [
                'authority:native',
                'authority:trusted',
                'authority:portable',
              ],
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      '**/*.ts',
      '**/*.tsx',
      '**/*.cts',
      '**/*.mts',
      '**/*.js',
      '**/*.jsx',
      '**/*.cjs',
      '**/*.mjs',
    ],
    rules: {
      // Vite is build tooling only. Vite-specific APIs must not leak
      // into runtime, SDK, document, workspace, or capability contracts.
      // Nx tags enforce package direction; these rules enforce bare npm imports.
      'no-restricted-imports': [
        'error',
        {
          paths: viteImportBanPaths,
          patterns: [...tauriImportBanPatterns, ...viteImportBanPatterns],
        },
      ],
      // import.meta.env is Vite/Node build-time config and must not leak into
      // domain/runtime contracts. import.meta.url/dirname (used by tests and
      // vitest configs) remain allowed.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "MemberExpression[object.type='MetaProperty'][object.meta.name='import'][object.property.name='env']",
          message:
            'import.meta.env (Vite/Node build-time config) must not leak into shipped code. Pass config through providers instead.',
        },
      ],
    },
  },
  {
    // The native host adapter is the only place Tauri IPC may be imported.
    // This redefines the ban without the `@tauri-apps` pattern; Vite tooling
    // stays banned even here (it belongs in vite.config.ts only).
    files: ['apps/native/**/*.ts', 'apps/native/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: viteImportBanPaths,
          patterns: viteImportBanPatterns,
        },
      ],
    },
  },
  {
    // Build/test configs are the only place Vite/Vitest tooling imports belong.
    files: [
      '**/vite.config.ts',
      '**/vite.config.mts',
      '**/vite.config.js',
      '**/vite.config.mjs',
      '**/vitest.config.ts',
      '**/vitest.config.mts',
      '**/vitest.config.js',
      '**/vitest.config.mjs',
    ],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-syntax': 'off',
    },
  },
];
