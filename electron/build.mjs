import * as esbuild from 'esbuild';
import * as fs from 'fs';
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

  reportNativeRuntimes();
}

/**
 * The Core ML helper and sherpa-onnx binaries are built outside this script
 * (`npm run build:native` on macOS, prebuilt DLLs on Windows). Report presence
 * instead of failing, so `npm run build` works on machines without them.
 */
function reportNativeRuntimes() {
  const binDir = path.resolve(__dirname, 'resources', 'bin');
  const expected = process.platform === 'win32' ? ['sherpa-onnx-offline.exe'] : ['parakeet-coreml'];
  const found = expected.filter((name) => fs.existsSync(path.join(binDir, name)));

  if (found.length === 0) {
    console.warn(
      `[native] No bundled STT runtime found in ${binDir}. ` +
        `Core ML models will not run until "npm run build:native" is run (macOS) ` +
        `or the sherpa-onnx binary is placed there (Windows). ` +
        `The legacy ggml parakeet-cli fallback remains available.`
    );
    return;
  }
  console.log(`[native] Bundled STT runtime(s) present: ${found.join(', ')}`);
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
