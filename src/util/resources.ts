import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/**
 * Locate static resources (`ui/public`, `injector.ps1`) in both execution
 * modes: running from TypeScript via tsx, and running from the bundled
 * CommonJS build inside Electron. The desktop shell sets
 * `RD_RESOURCES_DIR` so the bundled path does not have to guess.
 */
export function resourcesDir(): string {
  const env = process.env.RD_RESOURCES_DIR;
  if (env && existsSync(env)) return resolve(env);

  const candidates = [join(process.cwd(), 'src'), join(process.cwd(), 'build'), join(process.cwd(), 'resources')];
  for (const dir of candidates) {
    if (existsSync(join(dir, 'ui', 'public', 'index.html'))) return dir;
  }
  return dirname(process.execPath);
}

export function publicDir(): string {
  const env = process.env.RD_PUBLIC_DIR;
  if (env && existsSync(env)) return resolve(env);
  return join(resourcesDir(), 'ui', 'public');
}

export function injectorScript(): string {
  const env = process.env.RD_INJECTOR_SCRIPT;
  if (env && existsSync(env)) return resolve(env);
  return join(resourcesDir(), 'host', 'injector.ps1');
}

/**
 * Locate FFmpeg.
 *
 * A copy shipped with the app wins, because a fresh install has to encode on
 * machines that never installed FFmpeg (that showed up as `spawn ffmpeg ENOENT`
 * on a second PC). Then an explicit override, then PATH, then the usual Windows
 * package-manager locations.
 */
export function ffmpegBinary(): string {
  const override = process.env.RD_FFMPEG;
  if (override && existsSync(override)) return resolve(override);
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  for (const root of [join(resourcesDir(), 'ffmpeg'), join(process.cwd(), 'vendor', 'ffmpeg')]) {
    const bundled = join(root, exe);
    if (existsSync(bundled)) return bundled;
  }
  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
    for (const dir of [
      join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Links'),
      'C:\\ProgramData\\chocolatey\\bin',
      join(programFiles, 'ffmpeg', 'bin'),
    ]) {
      const candidate = join(dir, exe);
      if (existsSync(candidate)) return candidate;
    }
  }
  // Last resort: let the OS resolve it from PATH.
  return exe;
}

/** True when the resolved FFmpeg actually runs; a PATH entry may not exist. */
export function ffmpegAvailable(path = ffmpegBinary()): boolean {
  try {
    const probe = spawnSync(path, ['-version'], { timeout: 5000, stdio: 'ignore' });
    return !probe.error && probe.status === 0;
  } catch {
    return false;
  }
}
