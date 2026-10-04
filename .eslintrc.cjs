module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  env: {
    browser: true,
    es2022: true,
    node: true,
  },
  ignorePatterns: [
    'out/',
    'node_modules/',
    'web/pulseq-bundle.js',
  ],
  rules: {
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-inferrable-types': 'off',
    '@typescript-eslint/no-non-null-assertion': 'off',
    '@typescript-eslint/no-unused-vars': [
      'warn',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      },
    ],
  },
  overrides: [
    {
      // The simulator core runs unchanged in browsers, VS Code webviews, Node
      // workers, Deno and tests, so it may not touch Node built-ins or host
      // globals. Host-specific code lives in src/sim/platform/.
      files: ['src/sim/**/*.ts'],
      excludedFiles: ['src/sim/platform/node.ts'],
      rules: {
        'no-restricted-imports': ['error', {
          patterns: [{
            group: ['node:*', 'fs', 'fs/*', 'path', 'os', 'crypto', 'worker_threads', 'child_process', 'zlib'],
            message: 'src/sim must stay isomorphic; put host-specific code in src/sim/platform/.',
          }],
        }],
        'no-restricted-globals': ['error',
          { name: 'Buffer', message: 'Use Uint8Array; src/sim must stay isomorphic.' },
          { name: 'process', message: 'src/sim must stay isomorphic.' },
          { name: 'require', message: 'src/sim must stay isomorphic.' },
          { name: '__dirname', message: 'src/sim must stay isomorphic.' },
          { name: 'window', message: 'src/sim must stay isomorphic; reach host APIs through globalThis in src/sim/platform/.' },
          { name: 'document', message: 'src/sim must stay isomorphic.' },
        ],
      },
    },
  ],
};
