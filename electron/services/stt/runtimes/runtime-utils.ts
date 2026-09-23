import * as fs from 'fs';
import * as path from 'path';
import { execFile, execSync } from 'child_process';

/**
 * Locations a bundled runtime binary may live in:
 * packaged resources, the dev-time repo, and the user's PATH.
 */
export function resolveBundledBinary(names: string[]): string | null {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const roots: string[] = [];

  const packagedResources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (packagedResources) {
    roots.push(path.join(packagedResources, 'bin'));
    roots.push(path.join(packagedResources, 'app.asar.unpacked', 'electron', 'resources', 'bin'));
  }
  roots.push(path.join(process.cwd(), 'electron', 'resources', 'bin'));
  roots.push(path.join(process.cwd(), 'resources', 'bin'));

  for (const name of names) {
    for (const root of roots) {
      const candidate = path.join(root, `${name}${suffix}`);
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        // ignore
      }
    }
    try {
      const found = execSync(
        process.platform === 'win32' ? `where ${name}` : `which ${name}`,
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
      )
        .split('\n')[0]
        .trim();
      if (found && fs.existsSync(found)) return found;
    } catch {
      // not on PATH
    }
  }

  return null;
}

/** Run a binary, resolving with stdout and rejecting on spawn failure. */
export function execCapture(
  binary: string,
  args: string[],
  timeoutMs: number
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

/** Drop CLI banner/log noise that is not transcript content. */
const NOISE = /^(load_backend|ggml_|read_audio|parakeet_|system_info|whisper_|Processing file:|sherpa-onnx|Started|Done|\s*$)/i;

export function cleanTranscriptLines(stdout: string): string {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !NOISE.test(line));

  const decoded: string[] = [];
  for (const line of lines) {
    const jsonText = extractSherpaJsonText(line);
    if (jsonText !== null) {
      if (jsonText) decoded.push(jsonText);
      continue;
    }
    decoded.push(line);
  }
  return decoded.join(' ').trim();
}

/** sherpa-onnx-offline emits one JSON object per utterance. */
function extractSherpaJsonText(line: string): string | null {
  if (!line.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(line) as { text?: unknown };
    return typeof parsed.text === 'string' ? parsed.text.trim() : '';
  } catch {
    return null;
  }
}