'use strict';

const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');
const { randomBytes } = require('crypto');
const CHANNEL = 'welink-native-im-adapter-v1';
const installations = new WeakMap();

// One trusted IM service main frame owns this channel. HWNDs supplied by a
// renderer are never used as authority or as native dialog parents on Linux.
function installImAdapterMain({ electron, appRoot }) {
  if (process.platform !== 'linux') return null;
  const { ipcMain, BrowserWindow, dialog } = electron;
  if (installations.has(ipcMain)) return installations.get(ipcMain);
  const root = fs.realpathSync(appRoot);
  const allowed = new Set(['pedestal/index.html', 'plugin/im/dist/index.html']
    .map(name => path.join(root, name)));
  let owner = null;
  const dialogs = new Map();
  const cancelled = new Set();

  function trusted(frame) {
    if (!frame || frame.parent) return false;
    try {
      const url = new URL(frame.url);
      return url.protocol === 'file:' && !url.host &&
        allowed.has(fs.realpathSync(fileURLToPath(url)));
    } catch (_) { return false; }
  }
  function fromOwner(event, message) {
    return owner && event.sender === owner.contents && event.senderFrame === owner.frame &&
      event.senderFrame === event.sender.mainFrame && trusted(event.senderFrame) &&
      message && message.owner === owner.token;
  }
  function closeJob(job) {
    job.cancelled = true;
    if (job.window && !job.window.isDestroyed()) job.window.destroy();
  }
  function revoke() {
    for (const job of dialogs.values()) closeJob(job);
    dialogs.clear();
    cancelled.clear();
    owner = null;
  }
  function register(contents, frame) {
    if (contents.isDestroyed() || frame !== contents.mainFrame || !trusted(frame)) {
      throw new Error('IM adapter requires a trusted application main frame');
    }
    if (owner) {
      if (owner.contents !== contents || owner.frame !== frame) throw new Error('IM adapter already has an owner');
      return { owner: owner.token };
    }
    owner = { contents, frame, token: randomBytes(32).toString('hex'), epoch: 0 };
    const registered = owner;
    const revoked = () => { if (owner === registered) revoke(); };
    contents.once('destroyed', revoked);
    contents.once('render-process-gone', revoked);
    contents.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => {
      if (isMainFrame && !inPlace) revoked();
    });
    return { owner: owner.token };
  }
  function cancel(event, message) {
    if (!fromOwner(event, message) || !Number.isInteger(message.epoch) ||
        !Number.isInteger(message.id)) return;
    if (!message.id) cancelled.add(message.epoch);
    for (const job of dialogs.values()) {
      if (job.epoch === message.epoch && (!message.id || job.id === message.id)) closeJob(job);
    }
  }
  ipcMain.on(CHANNEL, (event, message) => {
    if (message && message.operation === 'cancel') cancel(event, message);
  });
  ipcMain.handle(CHANNEL, async (event, message) => {
    if (message && message.operation === 'register') return register(event.sender, event.senderFrame);
    if (!fromOwner(event, message)) throw new Error('Unregistered IM adapter owner');
    if (message.operation !== 'save-dialog' || !Number.isInteger(message.id) || message.id <= 0 ||
        !Number.isInteger(message.epoch) || message.epoch <= 0 || message.epoch > 0xffffffff ||
        message.epoch < owner.epoch || cancelled.has(message.epoch)) throw new Error('Invalid IM adapter request');
    const { fileName, fileType, suffix } = message.param || {};
    if (typeof fileName !== 'string' || !fileName || fileName.includes('\0')) throw new Error('Invalid save filename');
    if (fileType !== undefined && typeof fileType !== 'string' || suffix !== undefined && typeof suffix !== 'string') {
      throw new Error('Invalid save filter');
    }
    owner.epoch = message.epoch;
    const key = `${message.epoch}:${message.id}`;
    if (dialogs.has(key)) throw new Error('Duplicate IM adapter request');
    const registered = owner;
    const parent = BrowserWindow.fromWebContents(event.sender);
    // A private transient parent lets cancellation close only this native
    // dialog, without destroying the real application/service window.
    const host = new BrowserWindow({ width: 1, height: 1, show: false,
      parent: parent || undefined, modal: !!parent, skipTaskbar: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const job = { id: message.id, epoch: message.epoch, window: host, cancelled: false };
    dialogs.set(key, job);
    try {
      const extensions = (suffix || '*').split(/[;,|]/).map(value => value.trim().replace(/^\*?\./, ''))
        .filter(value => value === '*' || /^[A-Za-z0-9_-]+$/.test(value));
      const result = await dialog.showSaveDialog(host, { defaultPath: fileName,
        filters: [{ name: fileType || 'Files', extensions: extensions.length ? extensions : ['*'] }],
        properties: ['showOverwriteConfirmation', 'createDirectory'] });
      if (job.cancelled || owner !== registered || !trusted(registered.frame) || cancelled.has(job.epoch)) {
        throw new Error('IM adapter dialog cancelled');
      }
      let filePath = result.canceled ? '' : result.filePath || '';
      const extension = extensions.length === 1 && extensions[0] !== '*' ? extensions[0] : '';
      if (filePath && extension && !path.extname(path.basename(filePath))) filePath += `.${extension}`;
      const isExceed = !!filePath && (Buffer.byteLength(filePath) >= 4096 ||
        filePath.split(path.sep).some(part => Buffer.byteLength(part) > 255));
      return { filePath: isExceed ? '' : filePath, isExceed };
    } finally {
      dialogs.delete(key);
      if (!host.isDestroyed()) host.destroy();
    }
  });
  const api = Object.freeze({
    registerOwner(contents) { return register(contents, contents.mainFrame); },
    revokeOwner: revoke
  });
  installations.set(ipcMain, api);
  return api;
}

module.exports = { installImAdapterMain };
