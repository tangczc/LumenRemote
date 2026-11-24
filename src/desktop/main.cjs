'use strict';

/**
 * Lumen Remote — Electron shell.
 *
 * The engine (capture, codec, transport, signalling) runs in a child process
 * using Electron's bundled Node, so the installer needs no external Node
 * runtime. This process owns the window and lifecycle only.
 */

const { app, BrowserWindow, Menu, ipcMain, dialog, shell, nativeTheme, screen } = require('electron');
const { spawn } = require('node:child_process');
const { existsSync, mkdirSync, copyFileSync } = require('node:fs');
const { join } = require('node:path');
const http = require('node:http');
const net = require('node:net');

const isDev = !app.isPackaged;
const engineDir = isDev ? join(__dirname, '..', '..', 'build') : join(process.resourcesPath, 'engine');

let mainWindow = null;
let engineChild = null;
/** Window bounds to restore when leaving the "being controlled" mini panel. */
let normalBounds = null;

const HOST_PANEL_SIZE = {
  expanded: { width: 344, height: 200 },
  collapsed: { width: 300, height: 58 },
};

function freePort(start) {
  return new Promise((resolve) => {
    const tryPort = (port) => {
      const srv = net.createServer();
      srv.once('error', () => tryPort(port + 1));
      srv.once('listening', () => srv.close(() => resolve(port)));
      srv.listen(port, '127.0.0.1');
    };
    tryPort(start);
  });
}

function waitForHttp(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error(`engine did not start: ${url}`));
        else setTimeout(attempt, 150);
      });
      req.setTimeout(1000, () => req.destroy());
    };
    attempt();
  });
}

// No application menu: the default View menu binds F11 to *window*
// fullscreen, which fights the page's session fullscreen (the toolbar
// hiding and viewport reporting key off the element being fullscreen).
// The page handles F11 itself; hiding the menu bar alone was not enough
// because the accelerator still fired behind it.
Menu.setApplicationMenu(null);

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#0b0d13',
    autoHideMenuBar: true,
    title: 'Lumen Remote',
    // Native Windows caption buttons over a frameless canvas: keeps the design
    // intact while giving users familiar window affordances.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0f1218', symbolColor: '#98a1b6', height: 44 },
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => {
    mainWindow = null;
  });
  return win;
}

/**
 * Builds before the state directory was pinned wrote beside the working
 * directory. Carry that file over so an existing device ID is not lost.
 */
function migrateLegacyState(stateDir) {
  const target = join(stateDir, 'app-state.json');
  if (existsSync(target)) return;
  const roots = isDev
    ? [join(__dirname, '..', '..')]
    : [join(process.resourcesPath, '..'), process.cwd()];
  for (const root of roots) {
    const source = join(root, '.rd-state', 'app-state.json');
    if (!existsSync(source)) continue;
    try {
      mkdirSync(stateDir, { recursive: true });
      copyFileSync(source, target);
    } catch {
      /* fall back to a fresh identity */
    }
    return;
  }
}

async function startEngine() {
  const entry = join(engineDir, 'app-main.mjs');
  if (!existsSync(entry)) {
    dialog.showErrorBox('引擎缺失', `找不到 ${entry}\n请先运行 npm run build:engine`);
    app.quit();
    return;
  }

  const uiPort = await freePort(7800);
  mainWindow = createWindow();

  // Pin the state directory to the per-user app data folder. Without this the
  // engine writes beside whatever the current working directory happens to be,
  // so launching from a shortcut and from Explorer would use different device
  // IDs and settings.
  const stateDir = join(app.getPath('userData'), 'state');
  migrateLegacyState(stateDir);

  engineChild = spawn(process.execPath, [entry, '--no-open', '--ui', String(uiPort)], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      RD_RESOURCES_DIR: engineDir,
      RD_STATE_DIR: stateDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  engineChild.stdout.setEncoding('utf8');
  engineChild.stderr.setEncoding('utf8');
  engineChild.stdout.on('data', (d) => process.stdout.write(`[engine] ${d}`));
  engineChild.stderr.on('data', (d) => process.stderr.write(`[engine] ${d}`));
  engineChild.on('exit', (code) => {
    engineChild = null;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('engine-exit', { code });
  });

  try {
    await waitForHttp(`http://127.0.0.1:${uiPort}/`);
    if (mainWindow && !mainWindow.isDestroyed()) await mainWindow.loadURL(`http://127.0.0.1:${uiPort}/`);
  } catch (err) {
    dialog.showErrorBox('引擎启动失败', String((err && err.message) || err));
  }
}

function killEngine() {
  if (!engineChild) return;
  try {
    engineChild.kill();
  } catch {
    /* already gone */
  }
  engineChild = null;
}

ipcMain.handle('lumen:quit', () => app.quit());
ipcMain.handle('lumen:restart', async () => {
  killEngine();
  await startEngine();
  return { ok: true };
});
ipcMain.handle('lumen:open-external', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
});

/**
 * Shrink the window into a bottom-right status card while this machine is being
 * controlled, and put it back afterwards. Keeping it always on top means the
 * user can still see — and abort — an active session without hunting for the app.
 */
ipcMain.handle('lumen:host-panel', (_e, mode) => {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return { ok: false };

  if (mode === 'off') {
    win.setAlwaysOnTop(false);
    win.setMinimumSize(960, 640);
    if (normalBounds) {
      win.setBounds(normalBounds);
      normalBounds = null;
    }
    return { ok: true };
  }

  const size = HOST_PANEL_SIZE[mode] || HOST_PANEL_SIZE.expanded;
  if (!normalBounds) {
    normalBounds = win.getBounds();
    win.setMinimumSize(200, 48);
  }

  const area = screen.getDisplayMatching(win.getBounds()).workArea;
  const x = Math.round(area.x + area.width - size.width - 16);
  const y = Math.round(area.y + area.height - size.height - 16);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setBounds({ x, y, width: size.width, height: size.height });
  return { ok: true };
});

nativeTheme.themeSource = 'dark';

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(startEngine);

  app.on('window-all-closed', () => {
    killEngine();
    app.quit();
  });

  app.on('before-quit', killEngine);
}
