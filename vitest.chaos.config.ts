import { defineConfig } from 'vitest/config'

/**
 * Isolated config for chaos tests (SIGKILL + restart of real supervisor/agent
 * processes, timing their reconnect). These are load-sensitive: run alongside
 * the full suite they lose the CPU race and flake on timing. Here they run in
 * a SINGLE fork with file-parallelism off, so the bounce/reconnect path gets
 * dedicated CPU and the result reflects real behavior, not scheduler noise.
 *
 * `pnpm test` runs the main suite first, then this pass (see package.json).
 */
export default defineConfig({
  test: {
    include: ['tests/chaos/**/*.test.ts'],
    globals: false,
    environment: 'node',
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
})
