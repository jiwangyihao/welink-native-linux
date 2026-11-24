'use strict';

// Only this report window's original top-level form receives the selected
// participant context. No Node integration, meeting token or address-book dump.
const { contextBridge, ipcRenderer } = require('electron');
const flag = process.argv.find(value => /^--welink-report=[0-9a-f]{32}$/.test(value));
if (flag && process.isMainFrame) {
  const channel = 'welink-report-' + flag.split('=')[1];
  let contextRequest;
  contextBridge.exposeInMainWorld('complainJSInterface', {
    async complainAddInfo(callback) {
      const context = await (contextRequest ||= ipcRenderer.invoke(channel + '-init'));
      if (typeof callback === 'function') callback(context);
      return context;
    },
    afterSubmit(value) {
      if (typeof value !== 'string' || value.length > 4096) return;
      try { if (JSON.parse(value)?.type === 'afterSubmit') ipcRenderer.send(channel + '-done'); } catch (_) {}
    }
  });
}
