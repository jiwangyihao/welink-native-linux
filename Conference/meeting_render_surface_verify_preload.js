'use strict';
// Test-only preload for a fresh isolated Xvfb profile; never packaged as a page capability.
const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('surfaceVerifierHost', {
  invalidate: data => ipcRenderer.invoke('welink-render-surface-verifier-invalidate', data)
});
