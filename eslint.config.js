import js from '@eslint/js';
import importX from 'eslint-plugin-import-x';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Ported from @jessety/eslint-config, which is eslintrc-only and pinned to
// @typescript-eslint v5 — neither of which work with ESLint's flat config.
// Only the two import rules the old config actually turned on are enabled here;
// import-x's `recommended` preset would add resolver-backed rules that duplicate
// what `tsc` already checks under NodeNext resolution.

export default tseslint.config(
  {
    ignores: ['build/', 'coverage/', 'node_modules/'],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    plugins: { 'import-x': importX },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      /* Stylistic rules that survived the move to Prettier */
      'comma-dangle': ['warn', 'always-multiline'],
      'linebreak-style': ['warn', 'unix'],
      'no-multiple-empty-lines': ['error', { max: 2, maxEOF: 1 }],
      'no-trailing-spaces': 'warn',
      'quote-props': ['warn', 'as-needed'],
      semi: 'warn',
      'spaced-comment': ['warn', 'always'],

      /* Correctness */
      curly: 'error',
      eqeqeq: 'error',
      'no-await-in-loop': 'error',
      'no-eval': 'error',
      'no-extend-native': 'error',
      'no-throw-literal': 'error',
      'no-useless-escape': 'error',
      'require-atomic-updates': 'off',

      /* Style preferences */
      'lines-between-class-members': [
        'warn',
        'always',
        { exceptAfterSingleLine: true },
      ],
      'no-bitwise': 'warn',
      'no-console': 'off',
      'no-undef-init': 'warn',
      'no-var': 'warn',
      'one-var': ['warn', 'never'],
      'prefer-const': ['warn', { destructuring: 'all' }],
      'prefer-template': 'warn',

      /* TypeScript */
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { args: 'none' }],
      '@typescript-eslint/no-inferrable-types': 'off',

      /* Imports */
      'import-x/no-default-export': 'warn',
      'import-x/order': [
        'warn',
        {
          groups: [
            'external',
            'internal',
            ['parent', 'sibling', 'index'],
            'builtin',
            'object',
          ],
          pathGroupsExcludedImportTypes: ['builtin'],
          'newlines-between': 'never',
          alphabetize: { order: 'asc', caseInsensitive: true },
          warnOnUnassignedImports: false,
        },
      ],
    },
  },
  {
    files: [
      '**/*.{test,spec}.{ts,js,mjs,cjs}',
      '**/__fixtures__/**',
      '**/__tests__/**',
    ],
    languageOptions: {
      globals: globals.jest,
    },
    rules: {
      'no-console': 'warn',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-empty-function': 'off',
    },
  },
  {
    // This file has to default-export the config array
    files: ['eslint.config.js'],
    rules: { 'import-x/no-default-export': 'off' },
  },
);
