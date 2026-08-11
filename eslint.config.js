import eslint from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import prettier from 'eslint-config-prettier';

export default [
  eslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: {
        afterAll: 'readonly',
        beforeAll: 'readonly',
        describe: 'readonly',
        expect: 'readonly',
        it: 'readonly',
        process: 'readonly',
      },
      parser: tsParser,
      parserOptions: {
        projectService: true,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-namespace': 'off',
    },
  },
  prettier,
  {
    ignores: ['dist/', 'node_modules/'],
  },
];
