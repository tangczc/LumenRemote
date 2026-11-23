import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Bundles the two engine entrypoints into self-contained CommonJS files so the
 * Electron shell can run them with its bundled Node (`ELECTRON_RUN_AS_NODE`),
 * with no external Node installation required on the user's machine.
 */

const OUT = 'build';
const entries = [
  { in: 'src/app/main.ts', out: 'app-main.mjs' },
  { in: 'src/signaling/main.ts', out: 'signaling-main.mjs' },
];

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

for (const e of entries) {
  await build({
    entryPoints: [e.in],
    outfile: join(OUT, e.out),
    bundle: true,
    platform: 'node',
    target: 'node20',
    // The engine entrypoints use top-level await, which requires ESM output.
    format: 'esm',
    sourcemap: true,
    external: [],
    logLevel: 'warning',
  });
}

// Static resources the bundle resolves at runtime via RD_RESOURCES_DIR.
await cp('src/ui/public', join(OUT, 'ui', 'public'), { recursive: true });
await cp('src/host/injector.ps1', join(OUT, 'host', 'injector.ps1'));

// FFmpeg has to travel with the app: a fresh install on a machine that never
// installed it would otherwise die at session start with `spawn ffmpeg ENOENT`.
// Drop the binary into vendor/ffmpeg/ (ffmpeg.exe on Windows) to include it.
const ffmpegDir = 'vendor/ffmpeg';
if (existsSync(ffmpegDir)) {
  await cp(ffmpegDir, join(OUT, 'ffmpeg'), { recursive: true });
  console.log('ffmpeg bundled');
}

console.log(`engine bundled -> ${OUT}`);
