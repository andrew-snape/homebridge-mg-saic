import js from '@eslint/js';
import pluginN from 'eslint-plugin-n';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
  js.configs.recommended,
  pluginN.configs['flat/recommended-module'],
  {
    // Global rules that apply to all source files (JS and TS alike).
    rules: {
      'eqeqeq': ['error', 'always'],
      // fetch has been available unflagged since Node 18.0.0; the n/ plugin
      // conservatively marks it as >=21, so override it here.
      'n/no-unsupported-features/node-builtins': ['error', {
        ignores: ['fetch'],
      }],
    },
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.json',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs['recommended'].rules,
      'eqeqeq': ['error', 'always'],
      'no-unused-vars': 'off', // replaced by @typescript-eslint/no-unused-vars
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-undef': 'off', // TypeScript handles this
      // TypeScript files are not CommonJS modules; n/ can't resolve .js
      // imports that map to .ts sources, so skip that check.
      'n/no-missing-import': 'off',
    },
  },
  {
    // Test files may use globals that aren't in the main env.
    files: ['test/**/*.js'],
    rules: {
      'n/no-unpublished-import': 'off',
    },
  },
];
