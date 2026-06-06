import * as esbuild from 'esbuild';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outFile = path.join(root, 'public', 'app.js');

await mkdir(path.dirname(outFile), { recursive: true });

await esbuild.build({
  entryPoints: [path.join(root, 'src/frontend/app.ts')],
  outfile: outFile,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2020'],
  sourcemap: true,
  logLevel: 'info',
});
