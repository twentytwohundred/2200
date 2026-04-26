import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'cli/main': 'src/cli/main.ts',
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
})
