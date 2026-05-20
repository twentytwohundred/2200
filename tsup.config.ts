import { defineConfig } from 'tsup'
import { mkdir, copyFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'cli/main': 'src/cli/main.ts',
    'runtime/agent/bootstrap': 'src/runtime/agent/bootstrap.ts',
    'runtime/supervisor/bootstrap': 'src/runtime/supervisor/bootstrap.ts',
    // The self-upgrade helper runs as a detached child of the daemon
    // (see runtime/install/upgrade-trigger.ts). It needs to be a
    // standalone bundled entry so the spawned process can be invoked
    // by absolute path without depending on the rest of the bundle.
    'runtime/install/upgrade-runner': 'src/runtime/install/upgrade-runner.ts',
  },
  format: ['esm'],
  dts: { entry: { index: 'src/index.ts' } },
  clean: true,
  sourcemap: true,
  target: 'node22',
  outDir: 'dist',
  minify: false,
  splitting: false,
  treeshake: true,
  async onSuccess() {
    // tsup bundles JS/TS only. The runtime reads its onboarding script
    // YAMLs at startup via a path computed from the bundle location;
    // without this copy step those files are absent from dist and
    // `agent spawn` (CLI + HTTP) fails with ENOENT. Mirror the source
    // tree under dist/runtime/onboarding/scripts/.
    const srcDir = 'src/runtime/onboarding/scripts'
    const dstDir = 'dist/runtime/onboarding/scripts'
    await mkdir(dstDir, { recursive: true })
    for (const name of await readdir(srcDir)) {
      if (name.endsWith('.yaml') || name.endsWith('.yml')) {
        await copyFile(join(srcDir, name), join(dstDir, name))
      }
    }
  },
})
