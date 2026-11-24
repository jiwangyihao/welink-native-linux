'use strict';

// Electron 22's Linux NativeWindowViews::SetOpacity is explicitly unsupported.
// Use the X11/EWMH window property, not a fabricated Windows addon or a successful
// call to Electron's Linux no-op. The desktop installer requires x11-utils.
const { execFileSync } = require('child_process');
const { fileURLToPath } = require('url');
const path = require('path');
const OPACITY = '_NET_WM_WINDOW_OPACITY';
const MAX_ALPHA = 0xffffffff;
const CURRENT_WINDOW = 'ipc:send_to_main_proc_remote_current_wnd';
const WINDOW_BY_ID = 'ipc:send_to_main_proc_wnd_fromId';
const REMOTE = 'ipc:send_to_main_proc_remote';
const adaptedWindows = new WeakSet();

function x11WindowId(win, app) {
  if (win.isDestroyed()) throw new Error('Cannot change opacity of a destroyed window');
  if (!process.env.DISPLAY || app.commandLine.getSwitchValue('ozone-platform') === 'wayland')
    throw new Error('Native window opacity requires X11 or XWayland; native Wayland is not supported');
  const handle = win.getNativeWindowHandle();
  if (!Buffer.isBuffer(handle) || handle.length !== 4 || handle.readUInt32LE(0) === 0)
    throw new Error('Expected the Linux ia32 Electron X11 window handle');
  return '0x' + handle.readUInt32LE(0).toString(16);
}

function xprop(id, args) {
  try {
    return execFileSync('xprop', ['-id', id, ...args], {
      encoding: 'utf8', timeout: 2000, maxBuffer: 8192, stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (cause) {
    const error = new Error('X11 opacity operation failed; xprop (x11-utils) and an accessible X11 display are required: ' +
      String(cause.stderr || cause.message).trim());
    error.code = 'X11_OPACITY_FAILED';
    error.cause = cause;
    throw error;
  }
}

function installWindowOpacity(win, app) {
  if (adaptedWindows.has(win)) return win;
  win.setOpacity = function(opacity) {
    if (typeof opacity !== 'number' || !Number.isFinite(opacity)) throw new TypeError('Opacity must be a finite number');
    const alpha = Math.round(Math.max(0, Math.min(1, opacity)) * MAX_ALPHA);
    xprop(x11WindowId(win, app), ['-f', OPACITY, '32c', '-set', OPACITY, String(alpha)]);
  };
  win.getOpacity = function() {
    const value = xprop(x11WindowId(win, app), [OPACITY]).trim();
    const match = /^_NET_WM_WINDOW_OPACITY\(CARDINAL\) = ([0-9]+)$/.exec(value);
    if (match && Number(match[1]) <= MAX_ALPHA) return Number(match[1]) / MAX_ALPHA;
    // An absent EWMH property means fully opaque; every other result is an error.
    if (/^_NET_WM_WINDOW_OPACITY:\s+(?:not found\.|no such atom on any window\.)$/.test(value)) return 1;
    throw new Error('Unexpected X11 opacity property: ' + value);
  };
  adaptedWindows.add(win);
  return win;
}

function createMainIpc({ electron, appRoot, startupArgs }) {
  const { ipcMain, BrowserWindow } = electron;
  // HwAppService reads getGlobal('sharedObject').prop1 at cold start. main.jsc
  // does not populate it in this Linux build. Supply the real startup argv at that
  // existing adapter operation; warm URLs still use its second-instance handler.
  const args = startupArgs.slice();
  function localSender(event) {
    const frame = event.senderFrame;
    if (!event.sender || event.sender.isDestroyed() || !frame) throw new Error('The window request sender has retired');
    let filename;
    try { filename = fileURLToPath(frame.url); }
    catch (_) { throw new Error('Native desktop operations require a packaged local renderer'); }
    if (!filename.startsWith(appRoot + path.sep)) throw new Error('Native desktop operations require a packaged local renderer');
  }
  function currentWindow(sender) {
    const owned = BrowserWindow.fromWebContents(sender);
    if (owned) return owned;
    return BrowserWindow.getAllWindows().find(win => win.getBrowserViews().some(view => view.webContents === sender));
  }
  return new Proxy(ipcMain, {
    get(target, property, receiver) {
      if (property !== 'handle') return Reflect.get(target, property, receiver);
      return function(channel, listener) {
        if (![CURRENT_WINDOW, WINDOW_BY_ID, REMOTE].includes(channel)) return target.handle(channel, listener);
        return target.handle(channel, function(event, request, ...rest) {
          if (channel === REMOTE && request && Array.isArray(request.moduleList) &&
              request.moduleList.length === 1 && request.moduleList[0] === 'getGlobal' &&
              Array.isArray(request.args) && request.args.length === 1 && request.args[0] === 'sharedObject') {
            localSender(event);
            return { prop1: args.slice() };
          }
          const current = channel === CURRENT_WINDOW && request && Array.isArray(request.moduleList) &&
            request.moduleList.length === 1 && request.moduleList[0] === 'setOpacity';
          const byId = channel === WINDOW_BY_ID && request && request.type === 'setOpacity';
          if (current || byId) {
            localSender(event);
            if (!Array.isArray(request.args) || request.args.length !== 1) throw new TypeError('setOpacity requires one value');
            const win = current ? currentWindow(event.sender) : BrowserWindow.fromId(request.id);
            if (!win || win.isDestroyed()) throw new Error('The requested window no longer exists');
            return installWindowOpacity(win, electron.app).setOpacity(request.args[0]);
          }
          return listener.call(this, event, request, ...rest);
        });
      };
    }
  });
}

module.exports = { installWindowOpacity, createMainIpc };
