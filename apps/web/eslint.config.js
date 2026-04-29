// @ts-check
import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '.tscache/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      // Boundary discipline (per wiki/epics/15-web-app.md, wiki/decisions/2026-04-29-theme-aware-from-v1.md):
      // The frontend is API-driven. It does not import runtime types or
      // call runtime functions. Block both at lint time.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../../src/*', '../../../src/*', '@runtime/*', '@2200/runtime/*'],
              message:
                'Frontend code does not import runtime types or modules. Talk to the runtime over the documented HTTP+WebSocket API (see wiki/conventions/runtime-api.md).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['*.config.ts', '*.config.js', 'eslint.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: ['tests/**/*.ts', 'tests/**/*.tsx'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
)
