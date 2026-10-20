import { defineConfig } from 'tsdown'

/**
 * The models.dev package ships TWO entries: the catalog service (`index`) and its
 * optional `deepseek-extra-params` plugin, both referenced by package.json
 * exports. The root tsdown builds only `lib/types/index.js`, so this override
 * adds the second entry. Declarations come from `tsc -b` (dts: false).
 */
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/deepseek-extra-params.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
