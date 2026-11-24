'use strict';
const {contextBridge, ipcRenderer} = require('electron');
const arg = process.argv.find(s => /^--welink-offline=[a-f0-9]{32}$/.test(s));
if (arg && window.top === window && location.protocol === 'file:' && location.pathname.endsWith('/meeting_offline.html')) {
  const channel = 'welink-offline-' + arg.slice('--welink-offline='.length);
  let registered = false;
  contextBridge.exposeInMainWorld('offlineHost', {
    voiceOpen: () => ipcRenderer.invoke(channel + '-voice', { operation: 'open' }),
    voiceProcess: (id, pcm) => ipcRenderer.invoke(channel + '-voice', { operation: 'process', id, pcm }),
    voiceClose: id => ipcRenderer.invoke(channel + '-voice', { operation: 'close', id }),
    voiceShow: () => ipcRenderer.invoke(channel + '-voice', { operation: 'show' }),
    voiceDisable: () => ipcRenderer.invoke(channel + '-voice', { operation: 'disable' }),
    voiceState: () => ipcRenderer.invoke(channel + '-voice', { operation: 'state' }),
    bind(handler) {
      if (registered || typeof handler !== 'function') throw Error('Offline media owner already bound or missing');
      registered = true;
      ipcRenderer.on(channel, async (_event, msg) => {
        if (!Number.isSafeInteger(msg?.id)) return;
        try { const data = await handler(msg.operation, msg.params); ipcRenderer.send(channel, {id:msg.id, ok:true, data}); }
        catch (error) { ipcRenderer.send(channel, {id:msg.id, ok:false, code:error?.code, message:String(error?.message || 'Offline media operation failed')}); }
      });
      ipcRenderer.send(channel, {event:'ready'});
    },
    event(event, data) { ipcRenderer.send(channel, {event, data}); },
    invalidateRenderSurfaces: data => ipcRenderer.invoke(channel + '-surfaces', data),
    renderSurfaceControl: action => ipcRenderer.invoke(channel + '-surface-control', action),
    leave() { ipcRenderer.send(channel, {event:'leave'}); }
  });
}
