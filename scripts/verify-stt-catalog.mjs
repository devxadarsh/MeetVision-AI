#!/usr/bin/env node
/**
 * Verifies every download URL declared in shared/stt-model-catalog.ts against
 * the live Hugging Face repo trees.
 *
 * The catalog is hand-curated and Core ML repos are multi-variant, so a typo in
 * a bundle path silently becomes an HTTP 404 at download time. This checks file
 * existence (and declared sizes for files >= 1 MB) for all 6 models on all 4
 * platform targets.
 *
 * Usage: npm run verify:stt-catalog
 * Requires network access. Exits non-zero when anything is off.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const workDir = await mkdtemp(join(tmpdir(), 'stt-catalog-'));
const bundlePath = join(workDir, 'catalog.mjs');

async function fetchTree(repo) {
  const res = await fetch(`https://huggingface.co/api/models/${repo}/tree/main?recursive=true`);
  if (!res.ok) throw new Error(`${repo}: HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error(`${repo}: ${JSON.stringify(data).slice(0, 120)}`);
  const map = new Map();
  for (const item of data) {
    if (item.type === 'file') map.set(item.path, item.size ?? 0);
  }
  return map;
}

await build({
  entryPoints: [join(root, 'shared', 'stt-model-catalog.ts')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outfile: bundlePath,
  logLevel: 'error',
});

const { STT_MODEL_CATALOG, STT_PLATFORMS } = await import(bundlePath);
const trees = new Map();
let problems = 0;

for (const entry of STT_MODEL_CATALOG) {
  for (const platform of STT_PLATFORMS) {
    const artifact = entry.artifacts[platform];
    if (!artifact) continue;

    if (!trees.has(artifact.repo)) {
      try {
        trees.set(artifact.repo, await fetchTree(artifact.repo));
      } catch (err) {
        console.error(`${entry.id} [${platform}] ${artifact.repo}\n  REPO ERROR: ${err.message}`);
        problems++;
        continue;
      }
    }

    const files = trees.get(artifact.repo);
    const missing = artifact.files.filter((f) => !files.has(f.path));
    const drift =
      missing.length === 0
        ? artifact.files
            .filter((f) => f.bytes >= 1e6)
            .filter((f) => {
              const actual = files.get(f.path);
              return actual > 0 && Math.abs(actual - f.bytes) / actual > 0.01;
            })
        : [];

    if (missing.length === 0 && drift.length === 0) {
      const total = artifact.files.reduce((s, f) => s + f.bytes, 0);
      console.log(`ok   ${entry.id} [${platform}] ${(total / 1e6).toFixed(1)} MB`);
      continue;
    }

    problems += missing.length + drift.length;
    console.error(`FAIL ${entry.id} [${platform}] ${artifact.repo}`);
    for (const f of missing) console.error(`  missing  ${f.path}`);
    for (const f of drift) {
      const actual = files.get(f.path);
      console.error(
        `  size     ${f.path}: declared ${(f.bytes / 1e6).toFixed(2)} MB, actual ${(actual / 1e6).toFixed(2)} MB`
      );
    }
  }
}

await rm(workDir, { recursive: true, force: true });

if (problems > 0) {
  console.error(`\n${problems} problem(s) found in the STT model catalog.`);
  process.exit(1);
}
console.log('\nSTT model catalog verified: all URLs and sizes match Hugging Face.');