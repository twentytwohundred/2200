import { defineConfig, configDefaults } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Chaos tests SIGKILL + restart real supervisor/agent processes and time
    // their reconnect. Run concurrently with ~190 other files (16 workers
    // saturating the CPU) they starve and flake on timing ... so they are
    // excluded here and run isolated, single-fork, via vitest.chaos.config.ts
    // (`pnpm test` runs both passes). See tests/chaos/.
    exclude: [...configDefaults.exclude, 'tests/chaos/**'],
    globals: false,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.config.ts', '**/index.ts', '**/types.ts'],
      thresholds: {
        statements: 0,
        branches: 0,
        functions: 0,
        lines: 0,
      },
    },
  },
})
