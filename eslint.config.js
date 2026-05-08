// @ts-check
import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      '.tscache/**',
      // Test fixtures spawned as child processes; not part of the
      // TS project graph, intentionally untyped.
      'tests/**/fixtures/**',
      // Workspace members own their own ESLint config and verify pipeline.
      'apps/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Developer-runnable scripts under `scripts/` are checked
          // against the default project rather than the per-file
          // tsconfig discovery the project service does for src/tests.
          // Keeps them lintable without forcing every smoke into the
          // build graph.
          allowDefaultProject: ['scripts/*.ts'],
        },
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
    },
  },
  {
    // Config files live outside the TS project graph; disable type-aware rules.
    files: ['*.config.ts', '*.config.js', 'eslint.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // One-off operator helpers under scripts/ run against ESM bundles
    // and parse loose JSON state files; the strict-type rules add
    // friction without value here. Keep them parsed and basic-checked.
    files: ['scripts/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/restrict-plus-operands': 'off',
      '@typescript-eslint/prefer-optional-chain': 'off',
    },
  },
)
