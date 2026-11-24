'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fileURLToPath, pathToFileURL } = require('url');
const { MeetingNativeWeb, PROTOCOL } = require('./meeting_native_web');
const { IssuedMeetingSites } = require('./meeting_guest_site');
const { RESPONSE_TAG, resolveInvitation, createNativeIssuerTransport, issuerError } = require('./meeting_issuer_request');
const { createMeetingWindowMenu } = require('./meeting_menu');
const { createParticipantDirectory } = require('./meeting_directory_host');
const { createMeetingComplaints } = require('./meeting_complaint_host');
const { SdkMediaLog } = require('./meeting_sdk_log');
const { MeetingVoiceSession } = require('./meeting_voice_session');
const { captureRenderWindows } = require('./meeting_render_host');
const { nativeRenderSurfaces } = require('./meeting_render_surface_host');

const CHANNEL = 'welink-native-meeting-v1';
const TOKEN_REQUEST = CHANNEL + '-token-request';
const TOKEN_REPLY = CHANNEL + '-token-reply';
const CONFIG_REQUEST = CHANNEL + '-config-request';
const CONFIG_REPLY = CHANNEL + '-config-reply';
const EVENT = CHANNEL + '-event';
const OWNER_REPLY_TIMEOUT_MS = 30000;
const PICKER_PREFIX = CHANNEL + '-picker-';
const PICKER_FILE = path.join(__dirname, 'meeting_picker.html');
const PICKER_PRELOAD = path.join(__dirname, 'meeting_picker_preload.js');
const DEVICES_FILE = path.join(__dirname, 'meeting_devices.html');
const DEVICES_PRELOAD = path.join(__dirname, 'meeting_devices_preload.js');
const DEVICE_KINDS = new Set(['audioinput', 'audiooutput', 'videoinput']);
const HOST_OPERATIONS = new Set(['host.window.info', 'host.window.setVisible', 'host.window.capture',
  'host.render.windows', 'host.render.surfaces',
  'host.network.show', 'host.ui.shareAudio.configure', 'host.capability.configure',
  'host.ui.recordTip.configure',
  'host.directory.answer', 'host.directory.failed',
  'host.settings.devices', 'host.network.info', 'host.paths.configure']);

function failure(code, message) {
  // Electron's invoke rejection preserves the message, not custom Error fields.
  return Object.assign(new Error(code + ': ' + message), { code });
}

function errorData(error) {
  const result = { code: error.code === undefined ? 'HOST_OPERATION_FAILED' : error.code,
    message: String(error.message || error) };
  if (error.details !== undefined) result.details = error.details;
  if (error.status !== undefined) result.status = error.status;
  return result;
}

function windowInformation(window) {
  if (!window || window.isDestroyed()) return { exists: false };
  const handle = window.getNativeWindowHandle();
  return { exists: true, id: window.id, webContentsId: window.webContents.id,
    nativeHandle: { encoding: 'hex', value: handle.toString('hex'), byteLength: handle.length },
    bounds: window.getBounds(), contentBounds: window.getContentBounds(),
    visible: window.isVisible(), focused: window.isFocused(),
    minimized: window.isMinimized(), maximized: window.isMaximized() };
}

function realFile(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'file:' || parsed.hostname)
    throw failure('UNTRUSTED_SENDER', 'Only a local application file may own the meeting bridge');
  const filename = fs.realpathSync(fileURLToPath(parsed));
  if (!fs.statSync(filename).isFile())
    throw failure('UNTRUSTED_SENDER', 'The owner document must be an application file');
  return filename;
}

function serviceOrigin(value) {
  if (typeof value !== 'string' || !value.trim())
    throw failure('ORIGIN_REQUIRED', 'The actual configured meeting service origin is required');
  let url;
  try { url = new URL(value); }
  catch (_) { throw failure('INVALID_ORIGIN', 'The meeting service origin is not a valid URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw failure('INVALID_ORIGIN', 'A credential-free HTTPS meeting service origin is required');
  return url.origin;
}

function originOf(value) {
  try { return new URL(value).origin; } catch (_) { return ''; }
}

/* Install before the conference service registers. The service must first bind
 * token/config request and event listeners in the renderer owning its C library.
 * Register with the real configured origin; the reply {protocol, instance, origin}
 * is ownership, NOT engine readiness. Forward every engine message to webState in
 * that renderer, in order. Token replies are raw strings, never base64 wrappers.
 * Await call(dispose)/this disposer before native logout/reset or app quit. The
 * disposer resolves [{reason, reply}], retaining real localCleanup/serverLogout
 * reports, including failed cleanup replies. It never loads or resets native C.
 * Install this file, the picker files, and the existing meeting_native_web helpers
 * together in app/native; appRoot is the real application's resource directory.
 */
function installMeetingMain({ electron, appRoot }) {
  if (!electron || !electron.ipcMain || !electron.BrowserWindow || !electron.dialog)
    throw new TypeError('The main-process Electron API is required');
  if (typeof appRoot !== 'string' || !path.isAbsolute(appRoot))
    throw new TypeError('An absolute application resource directory is required');
  const root = fs.realpathSync(appRoot);
  if (!fs.statSync(root).isDirectory()) throw new TypeError('appRoot must be a directory');
  const { ipcMain, BrowserWindow, dialog } = electron;
  const sdkLog = new SdkMediaLog();
  const serviceFile = path.join(root, 'plugin/conference/dist/hwmService.html');
  const invitationFile = path.join(root, 'plugin/conference/dist/index.html');
  let invitationViewId;
  const issuedSites = new IssuedMeetingSites({ webContents: electron.webContents });
  const issuerTransport = createNativeIssuerTransport({ appRoot: root });
  let voice = null, voiceRetiring = null;
  function releaseVoice(frame) {
    if (!voice || (frame && voice.frame !== frame)) return voiceRetiring || Promise.resolve();
    const retired = voice;
    voice = null;
    const pending = retired.release();
    voiceRetiring = pending;
    pending.finally(() => { if (voiceRetiring === pending) voiceRetiring = null; }).catch(() => {});
    return pending;
  }
  async function localVoice(event, trusted, envelope) {
    if (trusted.filename !== serviceFile) throw failure('UNTRUSTED_SENDER', 'Only the local conference service may change voice settings');
    if (envelope.operation === 'release') {
      const rooms = owner?.frame === trusted.frame && owner.bridge.anonymousVoice;
      if (rooms?.room) await rooms.retire(rooms.room.owner);
      await releaseVoice(trusted.frame);
      return { released: true };
    }
    if (voiceRetiring) await voiceRetiring;
    if (stopping || event.sender.isDestroyed() || event.sender.mainFrame !== trusted.frame ||
        (owner && (owner.frame !== trusted.frame || owner.closing || owner.logoutCalls)))
      throw failure('OWNER_CLOSING', 'The voice command belongs to a retired service');
    const meeting = owner?.frame === trusted.frame ? owner.bridge : null;
    const rooms = meeting?.anonymousVoice, room = rooms?.room;
    const anonymous = !!(meeting?.mediaOwner.anonymous || meeting?.offline?.active);
    if (envelope.operation === 'scope') return anonymous ?
      { scope: 'anonymous-room-memory', roomId: room && !room.retired ? room.id : null } :
      { scope: 'local-account' };
    if (anonymous || envelope.anonymousRoom !== undefined) {
      if (!anonymous || !room || room.retired || envelope.anonymousRoom !== room.id || !room.session.current())
        throw failure('VOICE_SESSION_CHANGED', 'The anonymous voice command belongs to a different or retired room');
      if (envelope.account !== null && envelope.account !== undefined)
        throw failure('VOICE_ANONYMOUS_ACCOUNT_FORBIDDEN', 'Anonymous enrollment never binds a workplace account');
      if (envelope.operation === 'agree') {
        if (envelope.value !== false)
          throw failure('VOICE_LOCAL_CONSENT_REQUIRED', 'Read and agree to the local statement in this room’s recorder');
        return rooms.disable();
      }
      if (envelope.operation === 'show') {
        if (envelope.value === true) return rooms.show();
        if (envelope.value !== false) throw failure('INVALID_ARGUMENT', 'Expected recorder visibility');
        const receipt = await room.session.host.show(false);
        if (!receipt.ok) throw failure(receipt.error, 'The anonymous recorder did not close');
        return receipt;
      }
      if (envelope.operation === 'configure') {
        const receipt = await room.session.host.configure(envelope.value);
        if (!receipt.ok) throw failure(receipt.error, 'The anonymous reading prompts were not configured');
        return receipt;
      }
      throw failure('VOICE_ANONYMOUS_ACCOUNT_FORBIDDEN', 'Account voice operations do not apply to an anonymous room');
    }
    if (voice && voice.frame !== trusted.frame) throw failure('OWNER_BUSY', 'Another service owns the local voice settings');
    if (!voice) {
      voice = new MeetingVoiceSession({ electron, appRoot: root, contents: event.sender, frame: trusted.frame,
        getMeeting: () => owner?.frame === trusted.frame ? owner.bridge : null,
        onLost: () => { releaseVoice(trusted.frame).catch(() => console.warn('Local voice cleanup unconfirmed')); } });
    }
    return voice.command(envelope.operation, envelope.account, envelope.value);
  }
  let sdkLogOwner = null, serviceQueue = Promise.resolve();
  // Serialize the ownership decision, log switch and registration. Cleanup can
  // outlive the service document when the desktop recycles a BrowserWindow.
  function withService(event, trusted, operation) {
    const contents = event.sender;
    const current = () => {
      if (stopping || contents.isDestroyed() || contents.mainFrame !== trusted.frame ||
          realFile(trusted.frame.url) !== trusted.filename)
        throw failure('OWNER_CLOSING', 'The requesting conference document has retired');
    };
    const pending = serviceQueue.then(async () => {
      current();
      const previous = owner;
      if (previous && (!live(previous) || previous.closing)) {
        if (!live(previous) && previous.live) loseOwner(previous, 'owner-replaced');
        await closeOwner(previous, 'owner-replaced');
        current();
      }
      return operation(current);
    });
    serviceQueue = pending.catch(() => {});
    return pending;
  }

  async function configureSdkLog(frame, directory, initial, current) {
    if (owner && (owner.frame !== frame || owner.closing || !live(owner)))
      throw failure('NOT_MEETING_OWNER', 'Another conference service owns the log destination');
    if (initial && sdkLogOwner === frame) return;
    if (owner?.bridge.ready) {
      const record = owner;
      const reply = await record.bridge.callPage('sdkLog.flush');
      current();
      if (!accepts(record)) throw failure('OWNER_CLOSING', 'The previous log owner has retired');
      if (reply?.flushed !== true)
        throw failure('SDK_LOG_UNCONFIRMED', 'The media engine did not flush its previous log destination');
    }
    const receipt = sdkLog.configure(directory);
    if (receipt.ok) sdkLogOwner = frame;
    else if (initial) throw failure(receipt.code, 'The initial meeting SDK log destination was not accepted');
    return { ...receipt, nativeCommand: 1046, scope: 'hrtc-media-log', adapterLogChanged: false };
  }
  const tokens = new Map();
  const configs = new Map();
  const cleanupReplies = [];
  let owner = null;
  let stopping = false;
  let disposal = null;

  function trustedFrame(event) {
    const contents = event.sender;
    const frame = event.senderFrame;
    if (!contents || contents.isDestroyed() || !frame || frame !== contents.mainFrame)
      throw failure('UNTRUSTED_SENDER', 'Only the application main frame may own the meeting bridge');
    let filename;
    try { filename = realFile(frame.url); }
    catch (_) { throw failure('UNTRUSTED_SENDER', 'The owner is not a real local application file'); }
    const relative = path.relative(root, filename);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
      throw failure('UNTRUSTED_SENDER', 'The owner file is outside the application');
    return { frame, filename };
  }

  function live(record) {
    if (!record.live || record.contents.isDestroyed()) return false;
    try { return record.contents.mainFrame === record.frame; } catch (_) { return false; }
  }

  function accepts(record) {
    return !stopping && owner === record && live(record) && !record.closing && !record.logoutCalls;
  }

  function acceptsToken(record) {
    // Cleanup may need the current native credential solely to protect it from
    // browser revocation. Real owner loss/final disposal, not UI shutdown, ends IPC.
    return owner === record && live(record) && !record.bridge.disposed;
  }

  function finishToken(id, error, token) {
    const pending = tokens.get(id);
    if (!pending) return;
    tokens.delete(id);
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve(token);
  }

  function finishConfig(id, error, config) {
    const pending = configs.get(id);
    if (!pending) return;
    configs.delete(id);
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve(config);
  }

  function cancelInteractions(record, cancelTokens = false) {
    record.directory?.cancel();
    if (cancelTokens) {
      for (const [id, pending] of tokens) {
        if (pending.owner === record)
          finishToken(id, failure('TOKEN_REQUEST_CANCELLED', 'The native authentication owner is unavailable'));
      }
    }
    // Unlike native-token protection, management configuration is business-only:
    // logout/disposal cancels it even while the owner can still answer token IPC.
    for (const [id, pending] of configs) {
      if (pending.owner === record)
        finishConfig(id, failure('MANAGEMENT_CONFIG_CANCELLED', 'The meeting management configuration request was cancelled'));
    }
    for (const controller of record.dialogs) controller.abort();
  }

  function sendOwner(record, channel, message) {
    if (!live(record)) return false;
    try { record.frame.send(channel, message); return true; }
    catch (_) { loseOwner(record, 'owner-send-failed'); return false; }
  }

  function getAccessToken(record) {
    if (!acceptsToken(record))
      return Promise.reject(failure('OWNER_UNAVAILABLE', 'The native authentication owner is unavailable'));
    const id = crypto.randomBytes(16).toString('hex');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finishToken(id,
        failure('TOKEN_REPLY_TIMEOUT', 'The native authentication owner did not supply its raw access token')),
      OWNER_REPLY_TIMEOUT_MS);
      timer.unref();
      tokens.set(id, { owner: record, resolve, reject, timer });
      if (!sendOwner(record, TOKEN_REQUEST, { id }))
        finishToken(id, failure('OWNER_UNAVAILABLE', 'The native authentication owner is unavailable'));
    });
  }

  function receiveToken(event, message) {
    if (!message || typeof message !== 'object' || typeof message.id !== 'string') return;
    const pending = tokens.get(message.id);
    // Unknown, duplicate and late replies cannot supply a subsequent request.
    if (!pending || !acceptsToken(pending.owner) || event.sender !== pending.owner.contents ||
        event.senderFrame !== pending.owner.frame) return;
    try {
      const trusted = trustedFrame(event);
      if (trusted.filename !== pending.owner.filename) return;
    } catch (_) { return; }
    if (message.error !== undefined && message.error !== null) {
      finishToken(message.id, failure('NATIVE_TOKEN_UNAVAILABLE', 'The native authentication owner rejected the token request'));
    } else if (typeof message.token !== 'string' || !message.token.trim() || /[\r\n\0]/.test(message.token)) {
      finishToken(message.id, failure('INVALID_NATIVE_TOKEN', 'A nonempty raw access token is required'));
    } else {
      // No Buffer/base64 decoding, trimming, token fallback or credential logging.
      finishToken(message.id, null, message.token);
    }
  }

  function getManagementConfig(record, purpose = 'management') {
    if (!accepts(record))
      return Promise.reject(failure('OWNER_UNAVAILABLE', 'The management configuration owner is unavailable'));
    const id = crypto.randomBytes(16).toString('hex');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finishConfig(id,
        failure('MANAGEMENT_CONFIG_TIMEOUT', 'The owner did not supply its initialized management configuration')),
      OWNER_REPLY_TIMEOUT_MS);
      timer.unref();
      configs.set(id, { owner: record, purpose, resolve, reject, timer });
      if (!sendOwner(record, CONFIG_REQUEST, { id, purpose }))
        finishConfig(id, failure('OWNER_UNAVAILABLE', 'The management configuration owner is unavailable'));
    });
  }

  function receiveConfig(event, message) {
    if (!message || typeof message !== 'object' || typeof message.id !== 'string') return;
    const pending = configs.get(message.id);
    if (!pending || !accepts(pending.owner) || event.sender !== pending.owner.contents ||
        event.senderFrame !== pending.owner.frame) return;
    try {
      const trusted = trustedFrame(event);
      if (trusted.filename !== pending.owner.filename) return;
    } catch (_) { return; }
    if (message.error !== undefined && message.error !== null) {
      const code = pending.purpose === 'p2p' && message.error?.code === 412100043 ? 412100043 : 'MANAGEMENT_CONFIG_UNAVAILABLE';
      finishConfig(message.id, code === 412100043 ?
        Object.assign(new Error('Not logged in, not available.:此业务未登录不可用'), {code}) :
        failure(code, 'The service could not supply its current conference configuration'));
      return;
    }
    const config = message.config;
    if (!config || typeof config !== 'object' || Array.isArray(config) ||
        (Object.getPrototypeOf(config) !== Object.prototype && Object.getPrototypeOf(config) !== null) ||
        Object.keys(config).length === 0) {
      finishConfig(message.id, failure('INVALID_MANAGEMENT_CONFIG', 'The initialized management configuration snapshot is required'));
      return;
    }
    // Preserve the successful auth_init snapshot exactly. Main supplies no
    // server/device/proxy defaults, transformations, cached fallback or logging.
    finishConfig(message.id, null, config);
  }

  function dialogScope(record, externalSignal) {
    if (!accepts(record)) throw failure('OWNER_UNAVAILABLE', 'The meeting owner cannot authorize a dialog');
    const controller = new AbortController();
    const abort = () => controller.abort();
    record.dialogs.add(controller);
    if (externalSignal) {
      externalSignal.addEventListener('abort', abort, { once: true });
      if (externalSignal.aborted) abort();
    }
    return {
      signal: controller.signal,
      release() {
        record.dialogs.delete(controller);
        if (externalSignal) externalSignal.removeEventListener('abort', abort);
      }
    };
  }

  function dialogParent(record) {
    const meeting = record.bridge.offline?.window || record.bridge.window;
    if (meeting && !meeting.isDestroyed()) return meeting;
    const parent = record.parentWindow;
    return parent && !parent.isDestroyed() ? parent : null;
  }

  async function confirm(record, options) {
    const scope = dialogScope(record, options.signal);
    const meeting = record.bridge.window;
    try {
      const parent = dialogParent(record);
      const settings = { type: 'question', defaultId: 0, cancelId: 0, noLink: true,
        ...options, signal: scope.signal };
      const result = await (parent ? dialog.showMessageBox(parent, settings) : dialog.showMessageBox(settings));
      return !scope.signal.aborted && accepts(record) && record.bridge.window === meeting && result.response === 1;
    } finally { scope.release(); }
  }

  async function requestPermission(record, request) {
    const mediaOrigin = record.bridge.mediaOrigin;
    if (!accepts(record) || !request || !request.details || request.details.isMainFrame !== true ||
        originOf(request.details.requestingUrl) !== mediaOrigin ||
        (request.details.securityOrigin && originOf(request.details.securityOrigin) !== mediaOrigin)) return false;
    let message;
    let detail = 'Meeting service: ' + mediaOrigin;
    switch (request.permission) {
      case 'media':
        // The existing helper grants Chromium's session-wide `media` permission,
        // not a per-device grant. Ask explicitly for that full scope, even when
        // only one type is requested now; never silently extend an audio grant.
        message = 'Allow this meeting service to access your microphone and camera?';
        detail += '\nThis permission covers both microphone and camera access until this meeting browser session is cleared.';
        break;
      case 'display-capture':
        message = 'Allow this meeting service to share a screen or window you choose?';
        detail += '\nYou must separately select the screen or window to share.';
        break;
      case 'speaker-selection':
        message = 'Allow this meeting service to select an audio output device?';
        break;
      default: return false;
    }
    return confirm(record, { title: 'WeLink meeting permission', message, detail, buttons: ['Deny', 'Allow'] });
  }

  function selectDesktopSource(record, sources, options = {}) {
    const scope = dialogScope(record, options.signal);
    return showSourcePicker({ electron, sources, scope, parent: dialogParent(record),
      systemAudio: options.systemAudio === true, watermark: options.watermark });
  }

  async function chooseNativeFile(record, method, settings, signal) {
    const scope = dialogScope(record, signal);
    let aborted;
    const cancelled = new Promise(resolve => {
      aborted = () => resolve({ canceled: true });
      scope.signal.addEventListener('abort', aborted, { once: true });
      if (scope.signal.aborted) aborted();
    });
    try {
      if (scope.signal.aborted) return { canceled: true };
      const parent = dialogParent(record);
      // A directory selection configures only future dialog defaults. No caller
      // can turn a directory or supplied path into authorization to write a file.
      // Electron 22's file dialogs have no AbortSignal option. Release cancelled
      // operations immediately; never consume a late path after owner loss.
      const selected = await Promise.race([cancelled,
        parent ? dialog[method](parent, settings) : dialog[method](settings)]);
      if (scope.signal.aborted || !accepts(record)) return { canceled: true };
      return selected;
    } finally {
      scope.signal.removeEventListener('abort', aborted);
      scope.release();
    }
  }

  function chooseRecordingFile(record, { extension, signal }) {
    const suffix = extension.replace(/^[.]/, '');
    const filename = 'meeting-recording.' + suffix;
    return chooseNativeFile(record, 'showSaveDialog', {
      title: 'Save conference recording', buttonLabel: 'Choose recording file',
      defaultPath: record.paths.recording ? path.join(record.paths.recording, filename) : filename,
      filters: [{ name: 'Recording', extensions: [suffix] }], properties: ['showOverwriteConfirmation']
    }, signal);
  }

  function confirmRecordingPermission(record, request) {
    const detail = ['Participant: ' + JSON.stringify(request.participantId),
      'Meeting: ' + JSON.stringify(request.conferenceID)];
    if (request.name !== undefined) detail.push('Name: ' + JSON.stringify(request.name));
    return confirm(record, { title: 'Local recording permission',
      message: 'Allow this participant to record the conference locally?',
      detail: detail.join('\n'), buttons: ['Deny', 'Allow recording'], signal: request.signal });
  }

  async function openExternal(record, value) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password)
      throw failure('UNSUPPORTED_EXTERNAL_URL', 'Only credential-free HTTPS links may open outside the meeting');
    if (!await confirm(record, { title: 'Open meeting link', message: 'Open this link in your browser?',
      detail: url.href, buttons: ['Cancel', 'Open link'] }))
      throw failure('EXTERNAL_URL_CANCELLED', 'Opening the external link was cancelled');
    return electron.shell.openExternal(url.href);
  }

  function requireHostOwner(record) {
    if (!accepts(record)) throw failure('OWNER_UNAVAILABLE', 'The meeting host operation was cancelled');
  }

  async function meetingData(record, operation, params = {}) {
    requireHostOwner(record);
    const reply = await record.bridge.handle({ protocol: PROTOCOL,
      id: 'host-' + record.bridge.instance + '-' + ++record.hostSequence, operation, params });
    requireHostOwner(record);
    if (!reply.ok) throw Object.assign(new Error(reply.error.message), reply.error);
    return reply.data;
  }

  function meetingWindow(record) {
    requireHostOwner(record);
    const window = record.bridge.window;
    if (!window || window.isDestroyed())
      throw failure('MEETING_WINDOW_ABSENT', 'The genuine meeting window is not open');
    return window;
  }

  async function setWindowVisible(record, params) {
    if (typeof params.visible !== 'boolean')
      throw failure('INVALID_ARGUMENT', 'visible must be an explicit boolean');
    if (params.visible) await meetingData(record, 'initialize');
    const window = meetingWindow(record);
    if (params.visible) window.show();
    else window.hide();
    const result = windowInformation(window);
    if (result.visible !== params.visible) {
      const error = failure('WINDOW_VISIBILITY_UNCONFIRMED', 'The meeting window did not reach the requested visibility');
      error.details = result;
      throw error;
    }
    return result;
  }

  async function configurePaths(record, params) {
    const kind = params.kind;
    if (kind !== 'recording' && kind !== 'screenshots')
      throw failure('INVALID_ARGUMENT', 'kind must be recording or screenshots');
    let directory = params.directory;
    if (directory === undefined) {
      const selected = await chooseNativeFile(record, 'showOpenDialog', {
        title: kind === 'recording' ? 'Choose recording save-dialog directory' : 'Choose screenshot save-dialog directory',
        ...(record.paths[kind] ? { defaultPath: record.paths[kind] } : {}),
        properties: ['openDirectory']
      });
      requireHostOwner(record);
      if (selected.canceled) return { kind, canceled: true, directory: record.paths[kind],
        usage: 'save-dialog-default-only' };
      if (!Array.isArray(selected.filePaths) || selected.filePaths.length !== 1)
        throw failure('INVALID_DIRECTORY_SELECTION', 'The directory dialog did not return one directory');
      directory = selected.filePaths[0];
    }
    if (typeof directory !== 'string' || !path.isAbsolute(directory))
      throw failure('INVALID_DIRECTORY', 'An existing absolute directory is required');
    const canonical = await fs.promises.realpath(directory);
    const stat = await fs.promises.stat(canonical);
    if (!stat.isDirectory()) throw failure('INVALID_DIRECTORY', 'The configured path is not a directory');
    requireHostOwner(record);
    record.paths[kind] = canonical;
    return { kind, canceled: false, directory: canonical, usage: 'save-dialog-default-only' };
  }

  async function writeScreenshot(record, filename, png, signal, checkPolicy) {
    const task = (async () => {
      let file;
      let identity;
      let problem;
      try {
        requireHostOwner(record);
        if (signal.aborted) throw failure('SCREENSHOT_CANCELLED', 'The screenshot save was cancelled');
        file = await fs.promises.open(filename, 'wx', 0o600);
        identity = await file.stat({ bigint: true });
        if (!identity.isFile()) throw failure('INVALID_SCREENSHOT_FILE', 'The screenshot destination is not a regular file');
        if (signal.aborted) throw failure('SCREENSHOT_CANCELLED', 'The screenshot save was cancelled');
        await file.writeFile(png);
        await file.sync();
        await checkPolicy();
        const written = await file.stat({ bigint: true });
        if (written.size !== BigInt(png.length))
          throw failure('SCREENSHOT_WRITE_INCOMPLETE', 'The saved screenshot size does not match the captured PNG');
      } catch (error) { problem = error; }
      if (file) {
        try { await file.close(); }
        catch (error) {
          record.hostCleanupErrors.push(errorData(error));
          if (!problem) problem = error;
        }
      }
      if (!problem && (signal.aborted || !accepts(record)))
        problem = failure('SCREENSHOT_CANCELLED', 'The screenshot save was cancelled');
      if (problem && file) {
        try {
          if (!identity) throw failure('SCREENSHOT_CLEANUP_UNCONFIRMED', 'Cannot identify the incomplete screenshot file safely');
          const current = await fs.promises.lstat(filename, { bigint: true });
          if (!current.isFile() || current.dev !== identity.dev || current.ino !== identity.ino)
            throw failure('SCREENSHOT_FILE_CHANGED', 'The incomplete screenshot path no longer identifies the created file');
          await fs.promises.unlink(filename);
        } catch (error) {
          if (error.code !== 'ENOENT') record.hostCleanupErrors.push(errorData(error));
        }
      }
      if (problem) throw problem;
      return { canceled: false, filePath: filename, bytesWritten: png.length };
    })();
    record.hostFiles.add(task);
    task.then(() => record.hostFiles.delete(task), () => record.hostFiles.delete(task));
    return task;
  }

  async function captureWindow(record, params) {
    if (params.save !== undefined && typeof params.save !== 'boolean')
      throw failure('INVALID_ARGUMENT', 'save must be a boolean');
    const window = meetingWindow(record);
    let expected = { requireCapture: true };
    const checkPolicy = async () => {
      requireHostOwner(record);
      if (record.bridge.window !== window || record.bridge.offline?.active || window.isDestroyed())
        throw failure('MEETING_WINDOW_CHANGED', 'The captured meeting window was closed or replaced');
      const policy = await record.bridge.renderForHost('render.inspect', expected);
      requireHostOwner(record);
      if (!policy?.sessionKey || !policy.conferenceId || record.bridge.window !== window || window.isDestroyed())
        throw failure('MEETING_WINDOW_CHANGED', 'No current authorized meeting picture');
      expected = { requireCapture: true, sessionKey: policy.sessionKey, conferenceId: policy.conferenceId,
        policyRevision: policy.policyRevision };
    };
    await checkPolicy();
    const image = await window.webContents.capturePage();
    await checkPolicy();
    if (image.isEmpty()) throw failure('SCREENSHOT_EMPTY', 'The actual meeting window returned an empty image');
    const png = image.toPNG();
    if (!png.length) throw failure('SCREENSHOT_EMPTY', 'The actual meeting window returned an empty PNG');
    const result = { windowId: window.id, source: 'meeting-window-webContents',
      format: 'png', size: image.getSize(), dataUrl: 'data:image/png;base64,' + png.toString('base64') };
    if (params.save !== true) return result;
    const scope = dialogScope(record);
    try {
      const filename = 'meeting-screenshot.png';
      const selected = await chooseNativeFile(record, 'showSaveDialog', {
        title: 'Save meeting window screenshot', buttonLabel: 'Save new screenshot',
        defaultPath: record.paths.screenshots ? path.join(record.paths.screenshots, filename) : filename,
        filters: [{ name: 'PNG screenshot', extensions: ['png'] }], properties: ['showOverwriteConfirmation']
      }, scope.signal);
      requireHostOwner(record);
      if (scope.signal.aborted) throw failure('SCREENSHOT_CANCELLED', 'The screenshot save was cancelled');
      await checkPolicy();
      if (selected.canceled) return { ...result, save: { canceled: true } };
      if (typeof selected.filePath !== 'string' || !path.isAbsolute(selected.filePath))
        throw failure('INVALID_SCREENSHOT_FILE', 'The save dialog did not return an absolute file path');
      const saved = await writeScreenshot(record, selected.filePath, png, scope.signal, checkPolicy);
      return { ...result, save: saved };
    } finally { scope.release(); }
  }

  async function deviceState(record) {
    const devices = await meetingData(record, 'devices.list');
    const state = await meetingData(record, 'state.get');
    if (!Array.isArray(devices) || devices.some(device => !device || typeof device.kind !== 'string' ||
        typeof device.deviceId !== 'string' || typeof device.label !== 'string') ||
        !state || typeof state.joined !== 'boolean' || !state.selectedDevices)
      throw failure('INVALID_DEVICE_STATE', 'The genuine runtime did not provide device and selection state');
    const policy = {};
    for (const kind of DEVICE_KINDS) {
      const blocked = state.joined && ((kind === 'audioinput' && !state.audioEnabled) ||
        (kind === 'videoinput' && !state.videoEnabled));
      policy[kind] = { selectable: !blocked, mode: state.joined ? 'connected-session' : 'premeeting-preference-only',
        reason: blocked ? 'This input is off. Enable it yourself in the meeting controls before switching; settings will not start capture.' :
          state.joined ? 'Applies to the connected meeting. No microphone or camera enable command is sent.' :
            'Saves the real vendor preference only. No device is activated before joining.' };
    }
    return { devices, state, policy };
  }

  async function selectDevice(record, params) {
    if (!DEVICE_KINDS.has(params.kind) || typeof params.deviceId !== 'string' || !params.deviceId)
      throw failure('INVALID_DEVICE_SELECTION', 'An explicitly selected enumerated device is required');
    const before = await deviceState(record);
    if (!before.devices.some(device => device.kind === params.kind && device.deviceId === params.deviceId))
      throw failure('DEVICE_NOT_FOUND', 'The selected device is not in the current genuine enumeration');
    if (!before.policy[params.kind].selectable)
      throw failure('DEVICE_CAPTURE_DISABLED', before.policy[params.kind].reason);
    const selection = await meetingData(record, 'device.select', { kind: params.kind, deviceId: params.deviceId });
    const after = await deviceState(record);
    if (before.state.joined !== after.state.joined || before.state.sessionKey !== after.state.sessionKey)
      throw failure('CONFERENCE_CHANGED', 'The device selection belongs to a different media session');
    if (!selection || typeof selection.active !== 'boolean' || !selection.selection ||
        selection.selection[params.kind] !== params.deviceId || after.state.selectedDevices[params.kind] !== params.deviceId) {
      const error = failure('DEVICE_SELECTION_UNCONFIRMED', 'The genuine runtime did not retain the selected device');
      error.details = { selection, state: after.state };
      throw error;
    }
    if (params.kind === 'audiooutput' && after.state.joined) {
      const routing = selection.routing;
      if (!routing || !Number.isSafeInteger(routing.sinkCount) || routing.sinkCount < 0 ||
          routing.verified !== (routing.sinkCount > 0) || selection.active !== routing.verified)
        throw failure('DEVICE_SELECTION_UNCONFIRMED', 'The runtime did not verify actual receiving audio sinks');
    }
    return { ...after, selection, selectionVerified: true,
      effect: selection.active ? 'connected-session-selection' : after.state.joined ? 'connected-preference-only' : 'premeeting-preference-only' };
  }

  async function openDeviceSettings(record) {
    requireHostOwner(record);
    if (!record.settings) {
      const scope = dialogScope(record);
      let settings;
      settings = createDeviceSettings({ electron, scope, parent: dialogParent(record),
        readDevices: () => deviceState(record), selectDevice: params => selectDevice(record, params),
        onClosed: error => {
          if (error) record.hostCleanupErrors.push(errorData(error));
          if (record.settings === settings) record.settings = null;
        } });
      record.settings = settings;
    }
    const settings = record.settings;
    await settings.opened;
    requireHostOwner(record);
    if (settings.window.isDestroyed()) throw failure('SETTINGS_CLOSED', 'The device settings window was closed');
    settings.window.show();
    settings.window.focus();
    if (!settings.window.isVisible()) throw failure('SETTINGS_NOT_VISIBLE', 'The device settings window did not become visible');
    return { opened: true, window: windowInformation(settings.window), selection: 'user-mediated',
      premeeting: 'preference-only; active:false', capture: 'Settings never sends microphone or camera enable operations' };
  }

  async function networkInformation(record) {
    let rtc = { available: false, reason: 'The real meeting media engine is not initialized' };
    if (record.bridge.ready && record.bridge.window && !record.bridge.window.isDestroyed())
      rtc = { available: true, source: 'MeetingNativeWeb state.get', state: await meetingData(record, 'state.get') };
    const connectivity = electron.net && typeof electron.net.isOnline === 'function' ?
      { available: true, online: electron.net.isOnline(), source: 'Electron net.isOnline',
        scope: 'Operating-system connectivity indication, not meeting reachability or quality' } :
      { available: false, reason: 'This Electron runtime does not expose an online indication' };
    return { serviceOrigin: record.origin, mediaOrigin: record.bridge.mediaOrigin, rtc, connectivity,
      quality: { available: false, reason: 'The installed meeting runtime exposes no measured RTC quality scores' } };
  }

  async function showNetwork(record) {
    let information;
    let refresh;
    do {
      information = await networkInformation(record);
      const detail = ['Observed at: ' + new Date().toISOString(),
        'Configured HTTPS meeting service: ' + information.serviceOrigin,
        'No HTTPS reachability probe was performed; the configured address is not proof of connectivity.'];
      if (information.mediaOrigin !== information.serviceOrigin) detail.push('Guest meeting site: ' + information.mediaOrigin);
      if (information.rtc.available) {
        detail.push('RTC connection state: ' + information.rtc.state.connection,
          'Joined to the real RTC room: ' + information.rtc.state.joined);
      } else detail.push('RTC state unavailable: ' + information.rtc.reason);
      detail.push(information.connectivity.available ?
        'OS online indication: ' + information.connectivity.online + ' (not meeting reachability or quality)' :
        'OS online indication unavailable: ' + information.connectivity.reason,
      'RTC quality scores: unavailable. No quality, latency, loss or bandwidth measurements are invented.');
      refresh = await confirm(record, { title: 'Meeting connection information',
        message: 'Observed meeting and host connection state', detail: detail.join('\n'),
        buttons: ['Close', 'Refresh'] });
    } while (refresh);
    requireHostOwner(record);
    return { shown: true, information };
  }

  // Host operations share the normal protocol reply envelope. Settings confirms
  // that its real UI opened, not that a selection occurred. capture({save:true})
  // always asks for a new filename; paths.configure({kind,directory?}) only sets
  // a dialog default. Native handles are lossless hex bytes, not guessed integers.
  // network.info queries state; network.show presents those observations visibly.
  async function handleHost(record, message) {
    try {
      requireHostOwner(record);
      const params = message.params === undefined ? {} : message.params;
      if (!params || typeof params !== 'object' || Array.isArray(params))
        throw failure('INVALID_ARGUMENT', 'Host operation params must be an object');
      let data;
      switch (message.operation) {
        case 'host.window.info': data = windowInformation(record.bridge.window); break;
        case 'host.window.setVisible': data = await setWindowVisible(record, params); break;
        case 'host.window.capture': data = await captureWindow(record, params); break;
        case 'host.render.windows':
          data = await captureRenderWindows(record, params, {
            requireOwner: requireHostOwner, dialogScope, chooseNativeFile, nativeImage: electron.nativeImage,
            renderData: async (owner, operation, renderParams) => {
              requireHostOwner(owner);
              const data = await owner.bridge.renderForHost(operation, renderParams);
              requireHostOwner(owner);
              return data;
            }
          });
          break;
        case 'host.render.surfaces':
          data = await nativeRenderSurfaces(record, params, {requireOwner:requireHostOwner, dialog});
          break;
        case 'host.settings.devices': data = await openDeviceSettings(record); break;
        case 'host.directory.answer': data = await record.directory.answer(params); break;
        case 'host.directory.failed': data = await record.directory.answer(params, true); break;
        case 'host.network.show': data = await showNetwork(record); break;
        case 'host.network.info': data = await networkInformation(record); break;
        case 'host.paths.configure': data = await configurePaths(record, params); break;
        case 'host.ui.recordTip.configure': data = await record.bridge.configureRecordingTip(params.enabled); break;
        case 'host.capability.configure':
          data = await record.bridge.configureNativeCapability(params);
          if (record.menu) record.menu.update();
          break;
        case 'host.ui.shareAudio.configure':
          data = record.bridge.configureShareAudio(params.enabled);
          if (record.menu) record.menu.update();
          break;
        default: throw failure('UNSUPPORTED_OPERATION', 'Unknown main-process meeting host operation');
      }
      requireHostOwner(record);
      return { protocol: PROTOCOL, id: message.id, ok: true, data };
    } catch (error) { return { protocol: PROTOCOL, id: message.id, ok: false, error: errorData(error) }; }
  }

  async function settleHostFiles(record, reply) {
    await Promise.allSettled([...record.hostFiles]);
    return { ...reply, hostCleanup: { complete: record.hostCleanupErrors.length === 0,
      errors: record.hostCleanupErrors.slice() } };
  }

  function closeOwner(record, reason, request) {
    if (record.closing) return record.closing;
    ++record.issuerEpoch;
    issuedSites.clear();
    if (record.menu) record.menu.dispose();
    cancelInteractions(record, !live(record));
    const voiceDone = releaseVoice(record.frame).catch(error => { record.hostCleanupErrors.push(errorData(error)); });
    const message = request || { protocol: PROTOCOL, id: 'main-dispose-' + record.bridge.instance,
      operation: 'dispose', params: {} };
    record.closing = record.bridge.handle(message).then(async reply => {
      await voiceDone;
      return settleHostFiles(record, reply);
    }).then(reply => {
      cleanupReplies.push({ reason, reply });
      if (!reply.ok || !reply.hostCleanup.complete)
        console.warn('WeLink cleanup returned a failure; inspect localCleanup, serverLogout and hostCleanup separately.');
      return reply;
    }, error => {
      // Unexpected rejection is not a successful local cleanup or remote logout.
      cleanupReplies.push({ reason, error: { code: 'CLEANUP_REPLY_UNAVAILABLE',
        message: 'The genuine meeting helper did not return its cleanup report' } });
      throw error;
    }).finally(() => {
      cancelInteractions(record, true);
      record.detach();
      record.bridge.removeListener('engine', record.engine);
      record.bridge.removeListener('event', record.event);
      record.live = false;
      if (sdkLogOwner === record.frame) sdkLogOwner = null;
      if (owner === record) owner = null;
    });
    return record.closing;
  }

  function loseOwner(record, reason) {
    if (!record.live) return;
    record.live = false;
    if (record.menu) record.menu.dispose();
    // closeOwner may already be awaiting orderly cleanup; owner loss must still
    // reject its pending token reads immediately rather than wait for timeouts.
    cancelInteractions(record, true);
    closeOwner(record, reason).catch(() => {
      console.error('WeLink browser cleanup did not return a lifecycle reply; remote logout is not confirmed.');
    });
  }

  function bindOwner(event, trusted, origin) {
    const record = { contents: event.sender, frame: trusted.frame, filename: trusted.filename, origin,
      parentWindow: BrowserWindow.fromWebContents(event.sender), bridge: null,
      live: true, closing: null, logoutCalls: 0, issuerEpoch: 0, dialogs: new Set(),
      hostSequence: 0, paths: { recording: null, screenshots: null },
      hostFiles: new Set(), hostCleanupErrors: [], settings: null, menu: null };
    record.bridge = new MeetingNativeWeb({ electron, origin, appRoot: root, parentWindow: record.parentWindow || undefined,
      takeIssuedGuestSite: params => accepts(record) && record.filename === serviceFile ? issuedSites.take(record.origin, params) : null,
      sdkLog: sdkLogOwner === trusted.frame ? sdkLog : null,
      getVoiceSession: () => voice?.frame === record.frame && accepts(record) ? voice : null,
      getComplaints: () => record.complaints,
      getAccessToken: () => getAccessToken(record),
      getManagementConfig: () => getManagementConfig(record),
      getCallContext: () => getManagementConfig(record, 'p2p'),
      getOfflineConfig: async () => ({ ...await getManagementConfig(record, 'offline'),
        offlineJoinConfigPath: path.join(root, 'plugin/conference/HwmSdk/offlineJoinIp.json') }),
      onRenderSurfaces: async action => {
        const reply = await handleHost(record, {protocol:PROTOCOL, id:'offline-render-' + ++record.hostSequence,
          operation:'host.render.surfaces', params:{action}});
        if (!reply.ok) throw failure(reply.error?.code || 'RENDER_SURFACE_FAILED', reply.error?.message || 'Native render operation failed');
        return reply.data;
      },
      requestOfflinePermission: permission => accepts(record) && ['media', 'speaker-selection'].includes(permission) &&
        confirm(record, { title: 'WeLink 离线会议权限', message: permission === 'media' ?
          '允许此离线会议使用麦克风和摄像头吗？' : '允许此离线会议选择音频输出设备吗？', buttons: ['拒绝', '允许'] }),
      askOfflineDevice: kind => accepts(record) && confirm(record, { title:'WeLink 离线会议',
        message:kind === 'microphone' ? '主持人邀请你开启麦克风。是否开启？' : '主持人邀请你开启摄像头。是否开启？',
        buttons:['拒绝','开启'] }),
      requestPermission: request => requestPermission(record, request),
      selectDesktopSource: (sources, options) => selectDesktopSource(record, sources, options),
      selectProtectedDesktopSource: (sources, options) => selectDesktopSource(record, sources, options),
      chooseRecordingFile: request => chooseRecordingFile(record, request),
      confirmRecordingPermission: request => confirmRecordingPermission(record, request),
      openExternal: url => openExternal(record, url) });
    record.engine = message => sendOwner(record, EVENT, { kind: 'engine', message });
    record.complaints = createMeetingComplaints({ electron, isCurrent: () => accepts(record),
      getContext: () => getManagementConfig(record, 'complaint'), confirm: options => confirm(record, options),
      onResult: receipt => {
        if (!accepts(record)) return;
        sendOwner(record, EVENT, { kind:'event', message:{ protocol:PROTOCOL, instance:record.bridge.instance,
          event:'participant-report-result', data:receipt } });
        if (receipt.state === 'cancelled') return;
        void confirm(record, { type:receipt.serverAccepted ? 'info' : 'warning', title:'参会者举报',
          message:receipt.serverAccepted ? '官方审核服务已受理举报。' : '未能确认官方审核服务受理举报。',
          detail:receipt.code, buttons:['关闭'] }).catch(() => {});
      } });
    record.directory = createParticipantDirectory({ electron, bridge: record.bridge, complaints:record.complaints, isActive: () => accepts(record),
      requestOwner: data => sendOwner(record, EVENT, { kind: 'event', message: { protocol: PROTOCOL,
        instance: record.bridge.instance, event: 'directory-query', data } }) });
    record.event = message => {
      if (message.event === 'directory-invalidated') { record.directory.invalidate(message.data?.requestId); return; }
      if ((message.event === 'meeting-lifecycle' && ['left','closed','joined'].includes(message.data?.state)) ||
          (message.event === 'media-authentication-changed' && !message.data?.authenticated)) record.directory.cancel();
      sendOwner(record, EVENT, { kind: 'event', message });
    };
    record.bridge.on('engine', record.engine);
    record.bridge.on('event', record.event);
    const destroyed = () => loseOwner(record, 'owner-destroyed');
    const gone = () => loseOwner(record, 'owner-renderer-gone');
    const navigating = (navigationEvent, url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) loseOwner(record, 'owner-navigation');
    };
    record.contents.on('destroyed', destroyed);
    record.contents.on('render-process-gone', gone);
    record.contents.on('did-start-navigation', navigating);
    record.detach = () => {
      record.contents.removeListener('destroyed', destroyed);
      record.contents.removeListener('render-process-gone', gone);
      record.contents.removeListener('did-start-navigation', navigating);
    };
    owner = record;
    try {
      record.menu = createMeetingWindowMenu({ electron, bridge: record.bridge, protocol: PROTOCOL,
        participantContext: (window, params) => record.directory.context(window, params),
        isActive: () => accepts(record),
        hostOperation: (operation, params, id) => handleHost(record, { protocol: PROTOCOL, id, operation, params }),
        confirmEnd: () => confirm(record, { title: 'End meeting for everyone',
          message: 'End this meeting for every participant?',
          detail: 'The genuine meeting service will verify that you are the current host.',
          buttons: ['Cancel', 'End meeting'] }),
        showError: (operation, error) => confirm(record, { type: 'error', title: 'Meeting action failed',
          message: 'The meeting operation did not complete.',
          detail: operation + '\n' + String(error.code) + ': ' + error.message, buttons: ['Close'] }),
        onCleanupError: error => record.hostCleanupErrors.push(errorData(error)),
        onResult: (operation, reply) => sendOwner(record, EVENT, { kind: 'event',
          message: { protocol: PROTOCOL, instance: record.bridge.instance, event: 'host-menu-result',
            data: { operation, reply } } }) });
    } catch (error) {
      loseOwner(record, 'menu-installation-failed');
      throw error;
    }
    return record;
  }

  async function invoke(event, envelope) {
    const trusted = trustedFrame(event);
    if (stopping) throw failure('BROKER_DISPOSED', 'The main-process meeting broker is disposed');
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope))
      throw failure('INVALID_MESSAGE', 'Expected a meeting broker request');
    if (envelope.kind === 'resolve-invitation') {
      const record = owner, caller = event.sender, epoch = record?.issuerEpoch;
      let navigated = false;
      const invalidate = (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) navigated = true; };
      const current = () => !navigated && record?.filename === serviceFile && record.issuerEpoch === epoch &&
        accepts(record) && !caller.isDestroyed() && caller.mainFrame === trusted.frame &&
        realFile(trusted.frame.url) === invitationFile;
      try {
        if (trusted.filename !== invitationFile || !record || !current())
          throw failure('ISSUER_CONTEXT_UNAVAILABLE', 'No active invitation and conference service owner');
        caller.on('did-start-navigation', invalidate);
        if (!invitationViewId) {
          const manifest = JSON.parse(fs.readFileSync(path.join(root, 'plugin/conference/config.json'), 'utf8'));
          const matches = manifest.views.filter(view => view.entry === 'dist/index.html');
          if (matches.length !== 1 || !matches[0].viewID)
            throw failure('ISSUER_CONTEXT_UNAVAILABLE', 'The registered invitation view is missing');
          invitationViewId = matches[0].viewID;
        }
        const originatingView = { viewId: invitationViewId, userAgent: caller.getUserAgent() };
        const context = await getManagementConfig(record, 'issuer');
        if (!current() || serviceOrigin(context.origin) !== record.origin)
          throw failure('ISSUER_CHANGED', 'The configured meeting issuer changed');
        const result = await resolveInvitation(record.origin, envelope,
          { transport: issuerTransport, context, originatingView, isCurrent: current });
        if (!current()) throw failure('ISSUER_CHANGED', 'The invitation owner changed');
        if (result.grantParams) issuedSites.issue(trusted.frame, result.issuer, result.grantParams);
        return { tag: RESPONSE_TAG, ok: true, response: result.response, requestURL: result.requestURL };
      } catch (error) { return { tag: RESPONSE_TAG, ok: false, error: issuerError(error) }; }
      finally { caller.removeListener('did-start-navigation', invalidate); }
    }
    if (envelope.kind === 'voice') {
      try { return { ok: true, data: await localVoice(event, trusted, envelope) }; }
      catch (error) { return { ok: false, error: errorData(error) }; }
    }
    if (envelope.kind === 'sdk-log-configure') {
      if (trusted.filename !== serviceFile) throw failure('UNTRUSTED_SENDER', 'Only the local conference service may set its SDK log directory');
      return withService(event, trusted, current => configureSdkLog(trusted.frame, envelope.directory, false, current));
    }
    if (envelope.kind === 'register') {
      const origin = serviceOrigin(envelope.origin);
      return withService(event, trusted, async current => {
        if (owner) {
          if (owner.contents !== event.sender || owner.frame !== trusted.frame || owner.filename !== trusted.filename)
            throw failure('OWNER_BUSY', 'Another conference service owns the meeting bridge');
          if (owner.origin !== origin)
            throw failure('OWNER_ORIGIN_CHANGED', 'Dispose the previous meeting owner before changing its service origin');
        } else {
          if (trusted.filename === serviceFile) {
            await configureSdkLog(trusted.frame, envelope.sdkLogDirectory, true, current);
            current();
          }
          bindOwner(event, trusted, origin);
        }
        return { protocol: PROTOCOL, instance: owner.bridge.instance, origin: owner.origin };
      });
    }
    if (envelope.kind !== 'call') throw failure('INVALID_MESSAGE', 'Unknown meeting broker request kind');
    const record = owner;
    if (!record || !live(record) || record.contents !== event.sender || record.frame !== trusted.frame ||
        record.filename !== trusted.filename)
      throw failure('NOT_MEETING_OWNER', 'Register this service main frame before calling the meeting bridge');
    if (record.closing) throw failure('OWNER_CLOSING', 'The browser meeting session is being disposed');
    const message = envelope.message;
    const valid = message && message.protocol === PROTOCOL &&
      (typeof message.id === 'string' || typeof message.id === 'number');
    if (valid && ['watermark.set', 'ui.configure', 'conference.leave', 'conference.end'].includes(message.operation))
      record.directory.cancel();
    if (valid && HOST_OPERATIONS.has(message.operation)) return handleHost(record, message);
    if (valid && message.operation === 'dispose') return closeOwner(record, 'requested-dispose', message);
    if (valid && message.operation === 'session.logout') {
      ++record.logoutCalls;
      ++record.issuerEpoch;
      issuedSites.clear();
      if (record.menu) record.menu.suspend();
      cancelInteractions(record);
      const voiceDone = releaseVoice(record.frame).catch(error => { record.hostCleanupErrors.push(errorData(error)); });
      try { const reply = await record.bridge.handle(message); await voiceDone; return await settleHostFiles(record, reply); }
      finally { --record.logoutCalls; }
    }
    return record.bridge.handle(message);
  }

  ipcMain.handle(CHANNEL, invoke);
  ipcMain.on(TOKEN_REPLY, receiveToken);
  ipcMain.on(CONFIG_REPLY, receiveConfig);
  return function disposeMeetingMain() {
    if (!disposal) {
      stopping = true;
      issuedSites.clear();
      ipcMain.removeHandler(CHANNEL);
      disposal = (owner ? closeOwner(owner, 'broker-disposed') : Promise.resolve())
        .then(() => cleanupReplies.slice())
        .finally(async () => {
          ipcMain.removeListener(TOKEN_REPLY, receiveToken);
          ipcMain.removeListener(CONFIG_REPLY, receiveConfig);
          await serviceQueue;
          issuerTransport.close();
          await releaseVoice();
          const closed = sdkLog.close();
          if (!closed.ok) throw failure(closed.code, 'The meeting SDK log could not be closed');
        });
    }
    return disposal;
  };
}

function createDeviceSettings({ electron, scope, parent, readDevices, selectDevice, onClosed }) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const channel = PICKER_PREFIX + nonce;
  let window;
  let filename;
  try {
    filename = fs.realpathSync(DEVICES_FILE);
    window = new electron.BrowserWindow({ width: 760, height: 620, minWidth: 520, minHeight: 420,
      show: false, title: 'Meeting devices', ...(parent ? { parent, modal: true } : {}),
      webPreferences: { preload: DEVICES_PRELOAD, additionalArguments: ['--welink-native-meeting-picker=' + nonce],
        partition: channel, sandbox: true, contextIsolation: true, nodeIntegration: false,
        webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, devTools: false } });
  } catch (error) { scope.release(); throw error; }
  let closed = false;
  let closing = false;
  let pending = 0;
  let serial = Promise.resolve();
  const finish = () => {
    if (closed) return;
    closed = true;
    electron.ipcMain.removeHandler(channel);
    scope.signal.removeEventListener('abort', finish);
    scope.release();
    let closeError;
    try { if (!window.isDestroyed()) window.destroy(); }
    catch (error) { closeError = error; }
    onClosed(closeError);
  };
  const requestClose = () => {
    closing = true;
    // A user closing settings does not undo a real device operation in flight.
    // Owner loss, in contrast, destroys the UI immediately through its signal.
    if (!pending) finish();
  };
  try {
    scope.signal.addEventListener('abort', finish, { once: true });
    window.setMenu(null);
    const contents = window.webContents;
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.session.setPermissionCheckHandler(() => false);
    contents.session.setPermissionRequestHandler((requester, permission, callback) => callback(false));
    const allowedURL = pathToFileURL(DEVICES_FILE).href;
    contents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: details.url !== allowedURL }));
    contents.on('will-navigate', event => { event.preventDefault(); requestClose(); });
    contents.on('will-attach-webview', event => event.preventDefault());
    contents.on('render-process-gone', finish);
    window.on('close', event => { event.preventDefault(); requestClose(); });
    window.on('closed', finish);
    electron.ipcMain.handle(channel, (event, message) => {
      if (closed || window.isDestroyed() || event.sender !== contents || !event.senderFrame ||
          event.senderFrame !== contents.mainFrame || realFile(event.senderFrame.url) !== filename)
        throw failure('UNTRUSTED_SETTINGS', 'Only the owned device settings main frame may select devices');
      if (!message || typeof message !== 'object') throw failure('INVALID_SETTINGS_MESSAGE', 'Expected a device settings action');
      if (message.kind === 'close') { requestClose(); return; }
      if (closing || (message.kind !== 'load' && message.kind !== 'select'))
        throw failure('INVALID_SETTINGS_MESSAGE', 'The device settings action is unavailable');
      ++pending;
      const task = serial.then(() => {
        if (closed || scope.signal.aborted) throw failure('SETTINGS_CLOSED', 'The device settings window was closed');
        return message.kind === 'load' ? readDevices() : selectDevice({ kind: message.deviceKind, deviceId: message.deviceId });
      });
      const reply = task.then(data => ({ ok: true, data }), error => ({ ok: false, error: errorData(error) }));
      serial = reply.then(() => {});
      return reply.finally(() => {
        --pending;
        if (closing && !pending) finish();
      });
    });
    if (scope.signal.aborted) {
      finish();
      throw failure('SETTINGS_CLOSED', 'The device settings window was cancelled');
    }
    const opened = window.loadFile(DEVICES_FILE).then(() => {
      if (closed || scope.signal.aborted) throw failure('SETTINGS_CLOSED', 'The device settings window was closed');
      window.show();
    }).catch(error => { finish(); throw error; });
    return { window, opened };
  } catch (error) { finish(); throw error; }
}

function showSourcePicker({ electron, sources, scope, parent, systemAudio = false, watermark }) {
  if (!Array.isArray(sources) || sources.some(source => !source || typeof source.id !== 'string' ||
      !source.id || typeof source.name !== 'string')) {
    scope.release();
    return Promise.reject(failure('INVALID_CAPTURE_SOURCES', 'The desktop capturer returned an invalid source list'));
  }
  if (scope.signal.aborted) { scope.release(); return Promise.resolve(null); }
  const nonce = crypto.randomBytes(16).toString('hex');
  const channel = PICKER_PREFIX + nonce;
  const ids = new Set(sources.map(source => source.id));
  let window;
  let pickerFile;
  try {
    pickerFile = fs.realpathSync(PICKER_FILE);
    window = new electron.BrowserWindow({ width: 640, height: 500, minWidth: 400, minHeight: 300,
      show: false, title: 'Choose a screen or window', ...(parent ? { parent, modal: true } : {}),
      webPreferences: { preload: PICKER_PRELOAD, additionalArguments: ['--welink-native-meeting-picker=' + nonce],
        partition: channel, sandbox: true, contextIsolation: true, nodeIntegration: false,
        webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, devTools: false } });
  } catch (error) { scope.release(); return Promise.reject(error); }
  return new Promise((resolve, reject) => {
    let settled = false, presented = false;
    const finish = (error, id = null) => {
      if (settled) return;
      settled = true;
      electron.ipcMain.removeHandler(channel);
      scope.signal.removeEventListener('abort', aborted);
      scope.release();
      try { if (!window.isDestroyed()) window.destroy(); }
      catch (closeError) { if (!error) error = closeError; }
      if (error) reject(error);
      else resolve(id);
    };
    const aborted = () => finish(null);
    scope.signal.addEventListener('abort', aborted, { once: true });
    try {
      window.setMenu(null);
      const contents = window.webContents;
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      contents.session.setPermissionCheckHandler(() => false);
      contents.session.setPermissionRequestHandler((requester, permission, callback) => callback(false));
      const pickerURL = pathToFileURL(PICKER_FILE).href;
      contents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: details.url !== pickerURL }));
      contents.on('will-navigate', event => { event.preventDefault(); finish(null); });
      contents.on('will-attach-webview', event => event.preventDefault());
      contents.on('render-process-gone', () => finish(failure('PICKER_RENDERER_GONE', 'The source picker closed unexpectedly')));
      window.on('closed', () => finish(null));
      electron.ipcMain.handle(channel, async (event, message) => {
        if (settled || window.isDestroyed() || event.sender !== contents || !event.senderFrame ||
            event.senderFrame !== contents.mainFrame || realFile(event.senderFrame.url) !== pickerFile)
          throw failure('UNTRUSTED_PICKER', 'Only the owned source picker may select a source');
        if (!message || typeof message !== 'object') throw failure('INVALID_PICKER_MESSAGE', 'Expected a source picker action');
        if (message.kind === 'sources') return { sources, systemAudio };
        if (message.kind === 'cancel') { finish(null); return; }
        if (message.kind === 'select' && presented && message.systemAudio === systemAudio &&
            typeof message.id === 'string' && ids.has(message.id)) {
          if (watermark && !await contents.executeJavaScript("window.__welinkPickerWatermark.ensure('meeting-ui').enabled"))
            throw failure('WATERMARK_ENFORCEMENT_LOST', 'The source picker is no longer protected');
          if (settled || scope.signal.aborted) return;
          finish(null, message.id);
          return;
        }
        throw failure('INVALID_CAPTURE_SOURCE', 'Select one of the real returned desktop sources');
      });
      window.loadFile(PICKER_FILE).then(async () => {
        if (settled || scope.signal.aborted || window.isDestroyed()) return;
        if (watermark) {
          // Only this sealed local document receives the same enforced visual policy;
          // do not expose a native dialog or any source names before it is ready.
          const factory = fs.readFileSync(path.join(__dirname, 'meeting_native_web_watermark.js'), 'utf8');
          const setup = `(() => { const guard = window.__welinkCreateNativeWatermark({onViolation: () => window.close()});
            Object.defineProperty(window, '__welinkPickerWatermark', {value: guard});
            guard.configure(${JSON.stringify(watermark)}); return guard.ensure('meeting-ui').enabled; })()`;
          if (!await contents.executeJavaScript(factory + '\n;' + setup))
            throw failure('WATERMARK_ENFORCEMENT_LOST', 'Could not protect the source picker');
        }
        if (!settled && !scope.signal.aborted && !window.isDestroyed()) { presented = true; window.show(); }
      }).catch(error => finish(error));
      if (scope.signal.aborted) aborted();
    } catch (error) { finish(error); }
  });
}

module.exports = { installMeetingMain };
