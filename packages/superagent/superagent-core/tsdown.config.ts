import { defineConfig } from 'tsdown'

/** Build the journal entry and the separately exported dispatch helpers. */
export default defineConfig({
  entry: { index: 'lib/types/index.js', dispatch: 'lib/types/dispatch.js' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  outputOptions: { chunkFileNames: 'shared-[hash].js' },
})
