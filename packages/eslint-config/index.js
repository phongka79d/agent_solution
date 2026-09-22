'use strict';

/**
 * @agentos/eslint-config
 *
 * Shared ESLint 8 configuration for the Gate P0 monorepo. Its single job is to make the package
 * dependency DAG of `implement/02-project-structure.md` section 2 machine-checkable: every
 * workspace artifact may import only the packages it is granted, and the forbidden lists below are
 * the executable half of that contract.
 *
 * Two export surfaces are provided so both ESLint 8 configuration formats work:
 *
 * 1. Flat config presets - `base`, `api`, `worker`, `commandCenter`, `coreEngine`, `skills`,
 *    `adapters`, `database`, `secondBrain`, `widget`. Each named export is a flat config ARRAY,
 *    ready to be used directly by a package's `eslint.config.js`:
 *
 *    import { database } from '@agentos/eslint-config';
 *    export default database;
 *
 * 2. Classic (eslintrc) presets - `eslintrcPresets`, plain config objects containing only a `rules`
 *    key, consumable from a legacy `.eslintrc.cjs`:
 *
 *    const { eslintrcPresets } = require('@agentos/eslint-config');
 *    module.exports = { ...eslintrcPresets.database };
 *
 * @typedef {import('eslint').Linter.Config} EslintConfig
 */

const tsParser = require('@typescript-eslint/parser');

/**
 * Every file type a preset lints. The flat config arrays are consumed from a package root, so these
 * globs are relative to that package.
 *
 * @type {readonly string[]}
 */
const LINTED_FILES = Object.freeze([
  '**/*.js',
  '**/*.cjs',
  '**/*.mjs',
  '**/*.ts',
  '**/*.tsx',
  '**/*.mts',
  '**/*.cts',
]);

/**
 * Dev-only shared config packages. They are workspace tooling and are therefore the only
 * `@agentos/*` import any leaf package may reach.
 *
 * @type {readonly string[]}
 */
const SHARED_DEV_CONFIG_PACKAGES = Object.freeze([
  '@agentos/typescript-config',
  '@agentos/eslint-config',
]);

/**
 * Browser/UI packages. Only `apps/command-center` may import them; the gateway, the worker, and
 * every library compile without a DOM.
 *
 * @type {readonly string[]}
 */
const UI_PACKAGES = Object.freeze(['react', 'react-dom', 'next', 'next/*', '@agentos/storefront-widget']);

/**
 * Data-store drivers. A browser-rendered application must never hold one.
 *
 * @type {readonly string[]}
 */
const DATASTORE_DRIVERS = Object.freeze(['pg', 'pg/*', 'ioredis', 'ioredis/*']);

/**
 * Paths that are not importable edges: another artifact's private module tree, the application
 * trees, and `services/mock-erp` (outside the pnpm workspace).
 *
 * @type {readonly string[]}
 */
const PRIVATE_MODULE_TREES = Object.freeze([
  '@agentos/*/src/*',
  '@agentos/*/dist/*',
  'apps/*',
  'services/*',
]);

/**
 * `@agentos/*` runtime packages, with the dev config packages re-allowed for the leaf packages that
 * legitimately extend them (`!` entries un-restrict a previously matched pattern).
 *
 * @type {readonly string[]}
 */
const AGENTOS_RUNTIME_IMPORTS_ONLY = Object.freeze([
  '@agentos/*',
  ...SHARED_DEV_CONFIG_PACKAGES.map((packageName) => `!${packageName}`),
]);

/**
 * One entry per named preset. `patterns` is the `no-restricted-imports` patterns group; negated
 * patterns (`!...`) re-allow the granted contract subpath, exactly as the DAG requires.
 *
 * @type {Record<string, { patterns: readonly string[], message: string }>}
 */
const PRESET_DEFINITIONS = Object.freeze({
  base: {
    patterns: PRIVATE_MODULE_TREES,
    message:
      'Packages are imported through their published exports. Private module trees, apps/*, and services/* are not importable edges (implement/02 section 2).',
  },
  api: {
    patterns: [...UI_PACKAGES, ...PRIVATE_MODULE_TREES],
    message:
      'apps/api must not import browser/UI packages: it is a Node gateway that serves /api/v1 (implement/02 section 2).',
  },
  worker: {
    patterns: [...UI_PACKAGES, ...PRIVATE_MODULE_TREES],
    message:
      'apps/worker must not import browser/UI packages: it is a Node durable worker (implement/02 section 2).',
  },
  commandCenter: {
    patterns: [
      '@agentos/database',
      '@agentos/database/*',
      '@agentos/core-engine',
      '@agentos/core-engine/*',
      '@agentos/adapters',
      '@agentos/adapters/*',
      '@agentos/skills',
      '@agentos/skills/*',
      ...DATASTORE_DRIVERS,
      ...PRIVATE_MODULE_TREES,
    ],
    message:
      'apps/command-center consumes /api/v1 over HTTPS only: no database driver, orchestrator, adapter, skill, or Redis client may be imported (implement/02 section 2).',
  },
  coreEngine: {
    paths: ['@agentos/database', '@agentos/adapters', '@agentos/skills'],
    patterns: [
      '@agentos/database/!(contracts)',
      '@agentos/database/!(contracts)/**',
      '@agentos/adapters/*',
      '@agentos/skills/*',
      ...PRIVATE_MODULE_TREES,
    ],
    message:
      'packages/core-engine may consume @agentos/database/contracts and @agentos/second-brain only; the database root, adapters, skills, and apps/* are forbidden (implement/02 section 2).',
  },
  skills: {
    paths: ['@agentos/core-engine', '@agentos/database'],
    patterns: [
      '@agentos/core-engine/!(contracts)',
      '@agentos/core-engine/!(contracts)/**',
      '@agentos/database/!(contracts)',
      '@agentos/database/!(contracts)/**',
      ...PRIVATE_MODULE_TREES,
    ],
    message:
      'packages/skills may import @agentos/core-engine/contracts and @agentos/database/contracts only; both package roots are forbidden (implement/02 section 2).',
  },
  adapters: {
    paths: ['@agentos/core-engine', '@agentos/skills', '@agentos/database'],
    patterns: [
      '@agentos/core-engine/!(contracts)',
      '@agentos/core-engine/!(contracts)/**',
      '@agentos/skills/*',
      '@agentos/database/*',
      ...PRIVATE_MODULE_TREES,
    ],
    message:
      'packages/adapters holds a type-only edge and may import @agentos/core-engine/contracts only; the core-engine root, skills, and database are forbidden (implement/02 section 2).',
  },
  database: {
    patterns: [...AGENTOS_RUNTIME_IMPORTS_ONLY, ...PRIVATE_MODULE_TREES],
    message:
      'packages/database is a leaf: no @agentos/* runtime import is allowed, only the shared dev config packages (implement/02 section 2).',
  },
  secondBrain: {
    patterns: [...AGENTOS_RUNTIME_IMPORTS_ONLY, ...PRIVATE_MODULE_TREES],
    message:
      'packages/second-brain is a leaf: no @agentos/* runtime import is allowed, only the shared dev config packages (implement/02 section 2).',
  },
  widget: {
    patterns: [...AGENTOS_RUNTIME_IMPORTS_ONLY, ...PRIVATE_MODULE_TREES],
    message:
      'packages/storefront-widget has zero runtime dependencies: no @agentos/* runtime import is allowed (implement/02 section 2).',
  },
});

/**
 * Builds the `no-restricted-imports` rule value for one preset.
 *
 * @param {{ patterns: readonly string[], message: string }} definition
 * @returns {[string, { patterns: { group: readonly string[], message: string }[] }]}
 */
function restrictedImportsRule(definition) {
  return [
    'error',
    {
      paths: (definition.paths ?? []).map((name) => ({
        name,
        message: definition.message,
      })),
      patterns: [
        {
          group: definition.patterns,
          message: definition.message,
        },
      ],
    },
  ];
}

/**
 * Builds the flat config array for one named preset: the shared TypeScript parser setup plus the
 * forbidden-import enforcement.
 *
 * @param {string} name
 * @returns {EslintConfig[]}
 */
function createFlatPreset(name) {
  const definition = PRESET_DEFINITIONS[name];

  if (definition === undefined) {
    throw new Error(`UNKNOWN_ESLINT_PRESET: '${name}' is not an @agentos/eslint-config preset`);
  }

  return [
    {
      ignores: ['**/dist/**', '**/.next/**', '**/coverage/**'],
    },
    {
      name: `agentos/${name}/language-options`,
      files: [...LINTED_FILES],
      languageOptions: {
        parser: tsParser,
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    {
      name: `agentos/${name}/forbidden-imports`,
      files: [...LINTED_FILES],
      rules: {
        'no-restricted-imports': restrictedImportsRule(definition),
      },
    },
  ];
}

/**
 * Flat config array per preset name.
 *
 * @type {Record<string, EslintConfig[]>}
 */
const flatPresets = Object.fromEntries(
  Object.keys(PRESET_DEFINITIONS).map((name) => [name, createFlatPreset(name)]),
);

/**
 * Classic eslintrc-compatible config per preset name (`rules` only, no flat-config keys).
 *
 * @type {Record<string, { rules: Record<string, unknown> }>}
 */
const eslintrcPresets = Object.fromEntries(
  Object.entries(PRESET_DEFINITIONS).map(([name, definition]) => [
    name,
    { rules: { 'no-restricted-imports': restrictedImportsRule(definition) } },
  ]),
);

/**
 * Resolves a flat config preset by name.
 *
 * @param {string} name One of `presetNames`.
 * @returns {EslintConfig[]} Flat config array ready for `export default`.
 * @throws {Error} When `name` is not a known preset.
 */
function flat(name) {
  const preset = flatPresets[name];

  if (preset === undefined) {
    throw new Error(`UNKNOWN_ESLINT_PRESET: '${name}' is not an @agentos/eslint-config preset`);
  }

  return preset;
}

/**
 * Resolves a classic eslintrc-compatible preset by name.
 *
 * @param {string} name One of `presetNames`.
 * @returns {{ rules: Record<string, unknown> }} Config object consumable from `.eslintrc.cjs`.
 * @throws {Error} When `name` is not a known preset.
 */
function eslintrc(name) {
  const preset = eslintrcPresets[name];

  if (preset === undefined) {
    throw new Error(`UNKNOWN_ESLINT_PRESET: '${name}' is not an @agentos/eslint-config preset`);
  }

  return preset;
}

const {
  base,
  api,
  worker,
  commandCenter,
  coreEngine,
  skills,
  adapters,
  database,
  secondBrain,
  widget,
} = flatPresets;

/**
 * Names of every exported flat config preset.
 *
 * @type {readonly string[]}
 */
const presetNames = Object.freeze(Object.keys(PRESET_DEFINITIONS));

module.exports = {
  base,
  api,
  worker,
  commandCenter,
  coreEngine,
  skills,
  adapters,
  database,
  secondBrain,
  widget,
  flatPresets,
  eslintrcPresets,
  presetNames,
  lintedFiles: LINTED_FILES,
  flat,
  eslintrc,
};
