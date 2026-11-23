'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Narrow bridge for the shell. The engine UI (served over loopback HTTP) also
 * receives this API, which is how it knows it runs inside the desktop app and
 * should adapt its window chrome.
 */
contextBridge.exposeInMainWorld('lumen', {
  desktop: true,
  platform: process.platform,
  quit: () => ipcRenderer.invoke('lumen:quit'),
  restart: () => ipcRenderer.invoke('lumen:restart'),
  openExternal: (url) => ipcRenderer.invoke('lumen:open-external', url),
  setHostPanel: (mode) => ipcRenderer.invoke('lumen:host-panel', mode),
  onEngineExit: (cb) => ipcRenderer.on('engine-exit', (_e, payload) => cb(payload)),
});

// Runs before page scripts so CSS can reserve space for the caption buttons and
// make the title bar draggable.
window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.dataset.desktop = '1';
});
