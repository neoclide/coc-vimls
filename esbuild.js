const { build } = require('esbuild')

build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  external: ['coc.nvim'],
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  outfile: 'lib/index.js',
}).catch(error => {
  console.error(error)
  process.exitCode = 1
})
