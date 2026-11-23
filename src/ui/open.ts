import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const EDGE_PATHS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

/**
 * Open the UI in a chromeless app window when Edge is available so it feels like
 * a desktop app, otherwise fall back to the default browser.
 */
export function openUi(url: string): void {
  if (process.platform === 'win32') {
    const edge = EDGE_PATHS.find((p) => existsSync(p));
    const [cmd, args] = edge
      ? [edge, [`--app=${url}`, '--window-size=1280,820']]
      : ['cmd', ['/c', 'start', '', url]];
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false });
      child.unref();
      return;
    } catch {
      /* fall through */
    }
  }
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    const child = spawn(opener, [url], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {
    /* user can open the URL manually */
  }
}
