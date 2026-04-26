import { rm } from 'node:fs/promises';

import { build } from 'esbuild';

await rm('dist', { recursive: true, force: true });

await build({
  entryPoints: ['src/index.ts', 'src/expr/index.ts', 'src/template/index.ts'],
  outdir: 'dist',
  outbase: 'src',
  format: 'esm',
  target: 'es2022',
  platform: 'neutral',
  sourcemap: true,
  bundle: true,
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  packages: 'external',
  logLevel: 'info',
});