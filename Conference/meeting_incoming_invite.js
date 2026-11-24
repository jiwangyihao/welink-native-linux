'use strict';

const crypto = require('crypto');
const path = require('path');
const { pathToFileURL } = require('url');

const PAGE = path.join(__dirname, 'meeting_incoming_invite.html');
const PRELOAD = path.join(__dirname, 'meeting_incoming_invite_preload.js');
const PAGE_URL = pathToFileURL(PAGE).href;
const CHANNEL_PREFIX = 'welink-native-meeting-incoming-invite-';

function plainText(value, limit) {
  return typeof value === 'string' ? value.slice(0, limit)
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').trim() : '';
}

/**
 * Local decision UI only. The caller authenticates/correlates the vendor invite,
 * applies the returned decision, and calls cancel() on FINISH, logout or owner
 * replacement. No call, join, media operation or provider callback lives here.
 *
 * present({ subject, p2p, mediaType }) resolves 'accept', 'decline', or null.
 * There is no documented invitation deadline, so this UI never invents a
 * 'timeout' result. Closing a live, presented prompt is a decline; destroying
 * it or cancelling its owner is not a decision.
 */
class IncomingMeetingInvite {
  constructor({ electron, getParent, isCurrent }) {
    if (!electron || typeof electron.BrowserWindow !== 'function' || !electron.ipcMain ||
        typeof getParent !== 'function' || typeof isCurrent !== 'function')
      throw new TypeError('An Electron host and current invitation owner are required');
    this.electron = electron;
    this.getParent = getParent;
    this.isCurrent = isCurrent;
    this.active = null;
  }

  present(data = {}) {
    this.cancel();
    let parent, ownerContents, ownerFrame, ownerProcess, ownerRouting, display;
    try {
      parent = this.getParent();
      if (!this.isCurrent() || !parent || parent.isDestroyed()) return Promise.resolve(null);
      ownerContents = parent.webContents;
      if (!ownerContents || ownerContents.isDestroyed()) return Promise.resolve(null);
      ownerFrame = ownerContents.mainFrame;
      if (!ownerFrame) return Promise.resolve(null);
      ownerProcess = ownerFrame.processId;
      ownerRouting = ownerFrame.routingId;
      const value = data && typeof data === 'object' ? data : {};
      // Unknown media codes remain labelled provider text, not guessed audio/video
      // permissions. Only these three display fields cross into the local view.
      display = {
        subject: plainText(value.subject, 512),
        p2p: value.p2p === true || value.p2p === 1 || value.p2p === '1',
        mediaType: plainText(typeof value.mediaType === 'number' && Number.isFinite(value.mediaType) ?
          String(value.mediaType) : value.mediaType, 48)
      };
    } catch (_) { return Promise.resolve(null); }

    return new Promise(resolve => {
      let window, contents, documentURL, frame, frameProcess, frameRouting;
      let settled = false, presented = false, navigationStarted = false;
      const listeners = [], sessionHandlers = [];
      const active = { finish: result => finish(result) };
      this.active = active;

      const currentOwner = () => {
        try {
          return !settled && this.active === active && this.isCurrent() === true &&
            this.getParent() === parent && !parent.isDestroyed() &&
            parent.webContents === ownerContents && !ownerContents.isDestroyed() &&
            ownerContents.mainFrame === ownerFrame && ownerFrame.processId === ownerProcess &&
            ownerFrame.routingId === ownerRouting;
        } catch (_) { return false; }
      };
      const currentDocument = () => {
        try {
          return !!frame && !!window && !window.isDestroyed() && !contents.isDestroyed() &&
            contents.mainFrame === frame && frame.processId === frameProcess &&
            frame.routingId === frameRouting && frame.url === documentURL && contents.getURL() === documentURL;
        } catch (_) { return false; }
      };
      function release(all) {
        for (const remove of all) { try { remove(); } catch (_) {} }
        all.length = 0;
      }
      const finish = result => {
        if (settled) return;
        if (result !== null && (!currentOwner() || !currentDocument())) result = null;
        settled = true;
        if (this.active === active) this.active = null;
        // Remove close/IPC handlers before destroy: programmatic cancellation
        // must never be reinterpreted as the user's close-button decision.
        release(listeners);
        try { if (window && !window.isDestroyed()) window.destroy(); }
        finally { release(sessionHandlers); resolve(result); }
      };
      const cancel = () => finish(null);
      const listen = (target, name, handler) => {
        target.on(name, handler);
        listeners.push(() => target.removeListener(name, handler));
      };
      const denyNavigation = event => { event.preventDefault(); cancel(); };

      try {
        const nonce = crypto.randomBytes(16).toString('hex');
        const channel = CHANNEL_PREFIX + nonce;
        documentURL = PAGE_URL + '#' + nonce;
        window = new this.electron.BrowserWindow({
          width: 480, height: 420, minWidth: 360, minHeight: 320,
          title: display.p2p ? '来电邀请' : '会议邀请', parent, modal: false,
          show: false, alwaysOnTop: false, fullscreenable: false, maximizable: false,
          webPreferences: {
            preload: PRELOAD, additionalArguments: ['--welink-incoming-invite=' + nonce],
            partition: channel, sandbox: true, contextIsolation: true, nodeIntegration: false,
            nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
            webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
            devTools: false, spellcheck: false, autoplayPolicy: 'user-gesture-required'
          }
        });
        window.setMenu(null);
        contents = window.webContents;
        contents.setWindowOpenHandler(() => ({ action: 'deny' }));
        const session = contents.session;
        session.setPermissionCheckHandler(() => false);
        sessionHandlers.push(() => session.setPermissionCheckHandler(null));
        session.setPermissionRequestHandler((_requester, _permission, callback) => callback(false));
        sessionHandlers.push(() => session.setPermissionRequestHandler(null));
        if (typeof session.setDevicePermissionHandler === 'function') {
          session.setDevicePermissionHandler(() => false);
          sessionHandlers.push(() => session.setDevicePermissionHandler(null));
        }
        if (typeof session.setDisplayMediaRequestHandler === 'function') {
          session.setDisplayMediaRequestHandler((_request, callback) => callback({}));
          sessionHandlers.push(() => session.setDisplayMediaRequestHandler(null));
        }
        session.webRequest.onBeforeRequest((request, callback) => callback({
          cancel: request.webContentsId !== contents.id || request.resourceType !== 'mainFrame' ||
            (request.url !== PAGE_URL && request.url !== documentURL)
        }));
        sessionHandlers.push(() => session.webRequest.onBeforeRequest(null));

        // Electron may close the child before its still-live parent on quit.
        // Retire it first so shutdown is cancellation, not a user refusal.
        listen(this.electron.app, 'before-quit', cancel);
        listen(parent, 'close', cancel);
        listen(parent, 'closed', cancel);
        listen(ownerContents, 'destroyed', cancel);
        listen(ownerContents, 'render-process-gone', cancel);
        listen(ownerContents, 'did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
          if (isMainFrame) cancel();
        });
        listen(window, 'close', event => {
          event.preventDefault();
          finish(presented ? 'decline' : null);
        });
        listen(window, 'closed', cancel);
        listen(contents, 'destroyed', cancel);
        listen(contents, 'render-process-gone', cancel);
        listen(contents, 'preload-error', cancel);
        listen(contents, 'will-navigate', denyNavigation);
        listen(contents, 'will-redirect', denyNavigation);
        listen(contents, 'will-attach-webview', denyNavigation);
        listen(contents, 'did-fail-load', (_event, _code, _description, _url, isMainFrame) => {
          if (isMainFrame) cancel();
        });
        listen(contents, 'did-start-navigation', (_event, url, inPlace, isMainFrame) => {
          // Pin one load, not just one URL. Even reloading the same file retires
          // the document; a replacement frame cannot inherit the old decision.
          if (navigationStarted || !isMainFrame || inPlace || url !== documentURL) { cancel(); return; }
          navigationStarted = true;
        });
        listen(this.electron.ipcMain, channel, (event, message) => {
          if (settled) return;
          if (!currentOwner()) { cancel(); return; }
          // The remote vendor page, other windows and child frames cannot send
          // decisions, even if they learn this prompt's random channel name.
          if (event.sender !== contents || !event.senderFrame || event.senderFrame !== frame ||
              event.senderFrame !== contents.mainFrame) return;
          if (!currentDocument()) { cancel(); return; }
          if (!message || typeof message !== 'object') return;
          if (message.kind === 'cancel') { cancel(); return; }
          if (message.kind === 'ready' && !presented) {
            // There is intentionally no focus-stealing show() fallback.
            if (typeof window.showInactive !== 'function') { cancel(); return; }
            try { window.showInactive(); presented = !settled; } catch (_) { cancel(); }
          } else if (presented && (message.kind === 'accept' || message.kind === 'decline')) {
            finish(message.kind);
          }
        });

        // This is an owner-liveness check, not an invitation deadline. The
        // callbacks can retire an owner without any BrowserWindow event.
        const ownerWatch = setInterval(() => {
          if (!currentOwner() || (frame && !currentDocument())) cancel();
        }, 250);
        ownerWatch.unref();
        listeners.push(() => clearInterval(ownerWatch));
        if (!currentOwner()) { cancel(); return; }
        window.loadFile(PAGE, { hash: nonce }).then(() => {
          if (settled) return;
          if (!currentOwner() || window.isDestroyed()) { cancel(); return; }
          frame = contents.mainFrame;
          frameProcess = frame.processId;
          frameRouting = frame.routingId;
          if (!navigationStarted || !currentDocument()) { cancel(); return; }
          contents.send(channel, display);
        }).catch(cancel);
      } catch (_) { cancel(); }
    });
  }

  cancel() {
    if (this.active) this.active.finish(null);
  }
}

module.exports = { IncomingMeetingInvite };
