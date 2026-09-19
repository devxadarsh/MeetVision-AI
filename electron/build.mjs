import * as esbuild from 'esbuild';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const isWatch = process.argv.includes('--watch');

const commonConfig = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  external: ['electron'],
  tsconfig: path.resolve(__dirname, 'tsconfig.json'),
  alias: {
    '@shared': path.resolve(rootDir, 'shared'),
  },
};

async function build() {
  const mainCtx = await esbuild.context({
    ...commonConfig,
    entryPoints: [path.resolve(__dirname, 'main.ts')],
    outfile: path.resolve(rootDir, 'dist-electron/main.js'),
  });

  const preloadCtx = await esbuild.context({
    ...commonConfig,
    entryPoints: [path.resolve(__dirname, 'preload.ts')],
    outfile: path.resolve(rootDir, 'dist-electron/preload.js'),
  });

  if (isWatch) {
    await Promise.all([mainCtx.watch(), preloadCtx.watch()]);
    console.log('[esbuild] Watching electron main and preload...');
  } else {
    await Promise.all([mainCtx.rebuild(), preloadCtx.rebuild()]);
    await Promise.all([mainCtx.dispose(), preloadCtx.dispose()]);
    console.log('[esbuild] Built electron main and preload successfully.');
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
