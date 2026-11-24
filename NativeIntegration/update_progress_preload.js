'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('nativeUpdate', Object.freeze({
  cancel: () => ipcRenderer.send('welink-native-update-progress-cancel'),
  observe: callback => ipcRenderer.on('welink-native-update-progress', (_event, value) => callback(value))
}));
