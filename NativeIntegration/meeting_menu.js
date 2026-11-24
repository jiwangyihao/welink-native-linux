'use strict';

// Per-window Linux menu for the real MeetingNativeWeb owner. Menu state is read
// from runtime replies/events, never from a click or a native MenuItem checkbox.
// The verified vendor ABI (62467 in main.3ee85ed7.js) exports HOST = "1";
// screen.audioInputs reports that actual role. conference.end rechecks it itself.
const HOST_ROLE = '1';
const RECORDING_ACTIVE = new Set(['preparing', 'starting', 'recording', 'stopping']);
const RECORDING_IDLE = new Set(['idle', 'stopped', 'failed']);
const backgroundMenu = require('./meeting_custom_background_menu');

function createMeetingWindowMenu({ electron, bridge, protocol, isActive, hostOperation,
  confirmEnd, showError, onResult, onCleanupError, participantContext }) {
  if (!electron.Menu || typeof electron.Menu.buildFromTemplate !== 'function' || !electron.app)
    throw new Error('The native Electron window-menu API is required');
  let disposed = false;
  let window = null;
  let menu = null;
  let epoch = 0;
  let sequence = 0;
  let pending = null;
  let state = null;
  let recording = null;
  let sharing = null;
  let stateError = null;
  let refreshing = null;
  let refreshTimer = null;
  let attachTask = null;
  let removeWindowListeners = null;
  let refreshAgain = false;

  function alive() {
    return !disposed && window && !window.isDestroyed() && bridge.window === window && isActive();
  }

  function ready() {
    return alive() && !bridge.disposed && !bridge.loggingOut && !!bridge.ready;
  }

  async function query(operation, params = {}) {
    const target = window;
    const observedEpoch = epoch;
    const id = 'menu-' + bridge.instance + '-' + ++sequence;
    // Guard after the existing helper queue drains: a stale read must not use
    // handle()'s implicit initialization path to reopen a closed media window.
    await bridge.serial;
    if (!ready() || window !== target || epoch !== observedEpoch)
      return errorReply(id, 'MEETING_WINDOW_CHANGED', 'The meeting window changed before its state could be read');
    return bridge.handle({ protocol, id, operation, params });
  }

  function errorReply(id, code, message) {
    return { protocol, id, ok: false, error: { code, message } };
  }

  function currentRecording() {
    return state && state.recording && typeof state.recording.state === 'string' ? state.recording.state : null;
  }

  function allowed(action) {
    if (!alive()) return false;
    if (action === 'network') return true;
    if (action === 'render-stop') return !!bridge.renderSurfaceHost?.lease;
    if (action === 'p2p-mini') return bridge.p2pMini.eligible();
    if (!ready()) return false;
    if (action === 'voice-enroll' || action === 'voice-disable') {
      const voice = bridge.anonymousVoiceState();
      return voice.roomAvailable && (action === 'voice-enroll' ? voice.enabled : voice.requested || voice.enrolled);
    }
    if (action === 'devices') return bridge.ready.capabilities && bridge.ready.capabilities.deviceSelection === true;
    if (!state || state.ready !== true || state.joined !== true) return false;
    if (action === 'render-start') return !bridge.renderSurfaceHost?.lease;
    if (backgroundMenu.isAction(action)) return backgroundMenu.allowed(action, state, bridge);
    const capabilities = bridge.ready.capabilities || {};
    switch (action) {
      case 'microphone': return capabilities.audio === true && typeof state.audioEnabled === 'boolean';
      case 'camera': return capabilities.video === true && typeof state.videoEnabled === 'boolean';
      case 'share-start': return capabilities.screenShare === true && state.screenSharing === false &&
        sharing && sharing.permission && sharing.permission.state === 'allowed';
      case 'share-audio': return bridge.shareAudioEnabled && allowed('share-start') &&
        sharing.displayCapture?.nativeAudioScope === 'system' && sharing.device?.mainAudioTrack === 'live';
      case 'share-stop': return state.screenSharing === true;
      case 'record-start': {
        if (!bridge.nativeCapabilityEnabled(6) || !RECORDING_IDLE.has(currentRecording()) || !recording || !recording.permission ||
            recording.permission.state !== 'allowed' || !recording.vendor ||
            recording.vendor.recorderAvailable !== true || recording.vendor.controlAvailable !== true ||
            recording.vendor.transportOpen !== true || !recording.browser || !recording.media) return false;
        const browser = recording.browser;
        const audio = recording.media.audioSources > 0;
        const video = recording.media.videoSources > 0;
        return browser.mediaRecorder === true && (audio || video) &&
          (!audio || browser.audioMixing === true) && (!video || browser.canvasCapture === true) &&
          (video ? Array.isArray(browser.videoMimeTypes) && browser.videoMimeTypes.length > 0 :
            Array.isArray(browser.audioMimeTypes) && browser.audioMimeTypes.length > 0);
      }
      case 'record-stop': return RECORDING_ACTIVE.has(currentRecording());
      case 'record-permission': return bridge.nativeCapabilityEnabled(6) && bridge.nativeCapabilityEnabled(9) &&
        recording && recording.permission && recording.permission.state !== 'allowed' &&
        recording.vendor && recording.vendor.canRequestPermission === true && recording.vendor.transportOpen === true;
      case 'leave': return capabilities.leave === true;
      case 'end': return capabilities.endConference === true && sharing && sharing.permission && sharing.permission.role === HOST_ROLE;
      default: return false;
    }
  }

  function update() {
    if (!menu || !window || window.isDestroyed()) return;
    const item = id => menu.getMenuItemById(id);
    const status = item('meeting-status');
    const compact = item('p2p-mini');
    compact.visible = bridge.p2pMini.eligible();
    compact.enabled = compact.visible && !pending && !bridge.p2pMini.changing;
    compact.label = bridge.p2pMini.saved ? '还原通话窗口 / Restore call window' : '一对一通话小窗 / Compact call window';
    status.label = pending ? 'Operation pending: ' + pending :
      !ready() ? 'Meeting engine unavailable' : stateError ? 'Meeting state unavailable: ' + stateError.code :
        state && state.joined ? 'RTC: ' + state.connection : 'Not in a connected meeting';
    item('microphone').label = state && state.audioEnabled === true ? 'Mute microphone' :
      state && state.audioEnabled === false ? 'Enable microphone…' : 'Microphone state unavailable';
    item('camera').label = state && state.videoEnabled === true ? 'Turn camera off' :
      state && state.videoEnabled === false ? 'Enable camera…' : 'Camera state unavailable';
    const permission = recording && recording.permission;
    item('record-status').label = 'Local recording: ' + (currentRecording() || 'unavailable') +
      '; server permission: ' + (permission ? permission.state : 'unknown');
    item('share-audio').visible = bridge.shareAudioEnabled;
    item('record-start').visible = bridge.nativeCapabilityEnabled(6);
    item('record-permission').visible = bridge.nativeCapabilityEnabled(6) && bridge.nativeCapabilityEnabled(9);
    const exporting = !!bridge.renderSurfaceHost?.lease;
    item('render-start').visible = !exporting;
    item('render-start').enabled = !pending && allowed('render-start');
    item('render-stop').visible = exporting;
    item('render-stop').enabled = !pending && allowed('render-stop');
    const voice = bridge.anonymousVoiceState();
    item('voice-status').visible = voice.roomAvailable;
    item('voice-status').label = '匿名声纹 / Anonymous voice: ' + voice.state +
      (voice.reason ? ' (' + voice.reason + ')' : '');
    for (const action of ['voice-enroll', 'voice-disable']) {
      item(action).visible = voice.roomAvailable;
      item(action).enabled = !pending && allowed(action);
    }
    for (const action of ['devices', 'network', 'microphone', 'camera', 'share-start', 'share-audio', 'share-stop',
      'record-start', 'record-stop', 'record-permission', 'leave', 'end'])
      item(action).enabled = !pending && !refreshing && allowed(action) === true;
    backgroundMenu.update(menu, state, bridge, !!pending || !!refreshing);
  }

  function scheduleRefresh() {
    if (!ready()) { update(); return; }
    if (pending || refreshing) { refreshAgain = true; return; }
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      refresh().catch(() => {});
    }, 50);
  }

  async function refresh() {
    if (!ready()) { update(); return; }
    if (refreshing) return refreshing;
    const observedEpoch = epoch;
    const observedWindow = window;
    const valid = () => ready() && epoch === observedEpoch && window === observedWindow;
    const work = (async () => {
      const reply = await query('state.get');
      if (!valid()) return;
      if (!reply.ok || !reply.data || reply.data.ready !== true || typeof reply.data.joined !== 'boolean') {
        state = null;
        recording = null;
        sharing = null;
        stateError = reply.ok ? { code: 'INVALID_MEDIA_STATE', message: 'The runtime did not return current meeting state' } : reply.error;
        return;
      }
      state = reply.data;
      stateError = null;
      recording = null;
      sharing = null;
      // Initialization/anonymous login reads state only. These capability reads
      // enumerate existing inputs/authorization; they never start media capture.
      if (!state.joined) return;
      const [recordReply, shareReply] = await Promise.all([
        query('recording.capabilities'), query('screen.audioInputs')
      ]);
      if (!valid()) return;
      if (recordReply.ok) recording = recordReply.data;
      if (shareReply.ok && shareReply.data) sharing = shareReply.data.capabilities;
    })();
    const tracked = work.catch(error => {
      if (!valid()) return;
      state = null;
      recording = null;
      sharing = null;
      stateError = { code: error.code || 'MENU_STATE_UNAVAILABLE', message: String(error.message || error) };
    }).finally(() => {
      if (refreshing !== tracked) return;
      refreshing = null;
      update();
      if (refreshAgain && !pending) { refreshAgain = false; scheduleRefresh(); }
    });
    refreshing = tracked;
    update();
    return tracked;
  }

  function command(action, attemptId) {
    if (backgroundMenu.isAction(action)) return backgroundMenu.command(action);
    switch (action) {
      case 'render-start': return { operation:'host.render.surfaces', params:{ action:'start' }, host:true };
      case 'render-stop': return { operation:'host.render.surfaces', params:{ action:'stop' }, host:true };
      case 'p2p-mini': return { operation: 'window.p2pMini.toggle', params: { attemptId } };
      case 'voice-enroll': return { operation: 'voice.anonymous.enroll', params: {}, voice: true };
      case 'voice-disable': return { operation: 'voice.anonymous.disable', params: {}, voice: true };
      case 'devices': return { operation: 'host.settings.devices', params: {}, host: true };
      case 'network': return { operation: 'host.network.show', params: {}, host: true };
      case 'microphone': return { operation: 'audio.setEnabled', params: { enabled: !state.audioEnabled } };
      case 'camera': return { operation: 'video.setEnabled', params: { enabled: !state.videoEnabled } };
      case 'share-start': return { operation: 'screen.start', params: { audio: false } };
      case 'share-audio': return { operation: 'screen.start', params: { audio: true } };
      case 'share-stop': return { operation: 'screen.stop', params: {} };
      case 'record-start': return { operation: 'recording.start', params: {} };
      case 'record-stop': return { operation: 'recording.stop', params: {} };
      case 'record-permission': return { operation: 'recording.requestPermission', params: {} };
      case 'leave': return { operation: 'conference.leave', params: {} };
      case 'end': return { operation: 'conference.end', params: {} };
      default: throw new Error('Unknown meeting menu action');
    }
  }

  async function run(action) {
    const id = 'menu-' + bridge.instance + '-' + ++sequence;
    if (!alive() || pending) {
      const reply = errorReply(id, 'MENU_UNAVAILABLE', 'The meeting menu is unavailable or another action is pending');
      onResult(action, reply);
      return reply;
    }
    const actionEpoch = epoch;
    const attemptId = action === 'p2p-mini' ? bridge.p2p?.state().attemptId : undefined;
    pending = action;
    update();
    let operation = action;
    let reply;
    try {
      if (action !== 'network' && action !== 'render-stop') await refresh();
      if (!alive() || epoch !== actionEpoch || allowed(action) !== true) {
        reply = errorReply(id, 'MENU_ACTION_UNAVAILABLE', 'Current meeting state does not authorize this menu action');
      } else {
        if (action !== 'network' && action !== 'render-stop') await bridge.serial;
        if (!alive() || epoch !== actionEpoch || allowed(action) !== true)
          throw Object.assign(new Error('Current meeting state no longer authorizes this action'),
            { code: 'MENU_ACTION_UNAVAILABLE' });
        const request = command(action, attemptId);
        operation = request.operation;
        if (action === 'end' && !await confirmEnd()) {
          reply = errorReply(id, 'MENU_ACTION_CANCELLED', 'Ending the meeting was cancelled');
        } else if (!alive() || epoch !== actionEpoch) {
          reply = errorReply(id, 'MEETING_WINDOW_CHANGED', 'The meeting window changed before the operation began');
        } else {
          reply = request.voice ? { protocol, id, ok: true, data: action === 'voice-enroll' ?
            await bridge.showAnonymousVoiceEnrollment() : await bridge.disableAnonymousVoiceProtection() } :
            request.host ? await hostOperation(operation, request.params, id) :
              await bridge.handle({ protocol, id, operation, params: request.params });
        }
      }
    } catch (error) {
      reply = errorReply(id, error.code || 'MENU_OPERATION_FAILED', String(error.message || error));
      if (error.details !== undefined) reply.error.details = error.details;
    }
    try {
      // Forward the actual backend envelope. Successful request submission is
      // never converted into a recording permission grant or a checked state.
      onResult(operation, reply);
      if (!reply.ok && reply.error.code !== 'MENU_ACTION_CANCELLED' && alive() && epoch === actionEpoch)
        await showError(operation, reply.error);
    } finally {
      pending = null;
      update();
      refreshAgain = false;
      scheduleRefresh();
    }
    return reply;
  }

  function click(action) {
    return () => { run(action).catch(() => {
      // The original backend reply was already forwarded; an unavailable error
      // dialog must not turn that reply into success or log credential payloads.
      if (alive()) console.warn('The meeting menu could not display its operation result.');
    }); };
  }

  function clearWindow() {
    ++epoch;
    if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
    refreshing = null;
    refreshAgain = false;
    state = null;
    recording = null;
    sharing = null;
    stateError = null;
    if (removeWindowListeners) { removeWindowListeners(); removeWindowListeners = null; }
    try { if (window && !window.isDestroyed()) window.setMenu(null); }
    catch (error) { onCleanupError(error); }
    window = null;
    menu = null;
  }

  function attach() {
    if (disposed || !isActive()) return;
    const candidate = bridge.window;
    if (!candidate || candidate.isDestroyed() || candidate === window) return;
    clearWindow();
    window = candidate;
    const entry = (id, label) => ({ id, label, enabled: false, type: 'normal', click: click(id) });
    menu = electron.Menu.buildFromTemplate([{ label: 'Meeting', submenu: [
      { id: 'meeting-status', label: 'Reading actual meeting state…', enabled: false },
      entry('p2p-mini', '一对一通话小窗 / Compact call window'),
      entry('render-start', '授权逐路视频窗口… / Export video windows…'),
      entry('render-stop', '停止逐路视频输出 / Stop video export'),
      { type: 'separator' }, entry('devices', 'Device settings…'), entry('network', 'Connection information…'),
      { type: 'separator' }, entry('microphone', 'Microphone state unavailable'), entry('camera', 'Camera state unavailable'),
      ...backgroundMenu.template(entry),
      { type: 'separator' }, { id: 'voice-status', label: '匿名声纹 / Anonymous voice', enabled: false },
      entry('voice-enroll', '本次匿名会议声纹保护… / Enroll voice for this room…'),
      entry('voice-disable', '停用并删除本次声纹 / Disable and delete this room’s voiceprint'),
      { type: 'separator' }, entry('share-start', 'Share a screen or window (video only)…'),
      entry('share-audio', '共享画面和电脑声音 / Share with computer sound…'), entry('share-stop', 'Stop sharing'),
      { type: 'separator' }, { id: 'record-status', label: 'Local recording state unavailable', enabled: false },
      entry('record-start', 'Record existing meeting media…'), entry('record-stop', 'Stop local recording'),
      entry('record-permission', 'Request recording permission from the meeting host…'),
      { type: 'separator' }, entry('leave', 'Leave meeting'), entry('end', 'End meeting for everyone (host)…')
    ] }]);
    const submenu = menu.items[0].submenu;
    submenu.on('menu-will-show', scheduleRefresh);
    candidate.on('focus', scheduleRefresh);
    const contextMenu = (_event, params) => {
      if (participantContext && ready()) participantContext(candidate, params);
    };
    const contents = candidate.webContents;
    contents.on('context-menu', contextMenu);
    const closed = () => { if (window === candidate) clearWindow(); };
    candidate.on('closed', closed);
    removeWindowListeners = () => {
      if (!contents.isDestroyed()) contents.removeListener('context-menu', contextMenu);
      submenu.removeListener('menu-will-show', scheduleRefresh);
      candidate.removeListener('focus', scheduleRefresh);
      candidate.removeListener('closed', closed);
    };
    // Never call Menu.setApplicationMenu: only this genuine media window changes.
    candidate.setMenu(menu);
    candidate.setAutoHideMenuBar(false);
    candidate.setMenuBarVisibility(true);
    update();
    scheduleRefresh();
  }

  function safeAttach() {
    try { attach(); }
    catch (error) {
      clearWindow();
      const reply = errorReply('menu-' + bridge.instance + '-' + ++sequence,
        error.code || 'MENU_INSTALLATION_FAILED', String(error.message || error));
      onResult('host.menu.install', reply);
    }
  }

  function onCreated() {
    if (attachTask) return;
    // BrowserWindow emits creation before MeetingNativeWeb assigns .window.
    attachTask = setImmediate(() => { attachTask = null; safeAttach(); });
  }

  function onEngine(message) {
    if (!message || message.protocol !== protocol || message.instance !== bridge.instance) return;
    if (message.event === 'engine-unavailable') { clearWindow(); return; }
    if (message.event === 'engine-ready') { safeAttach(); scheduleRefresh(); }
  }

  function onEvent(message) {
    if (!message || message.protocol !== protocol || message.instance !== bridge.instance || !alive()) return;
    if (['p2p-call-state', 'native-capability-changed', 'render-surfaces-changed'].includes(message.event)) update();
    if (message.event === 'media-state' && message.data && typeof message.data.joined === 'boolean') {
      state = message.data;
      stateError = null;
      recording = null;
      sharing = null;
      update();
      scheduleRefresh();
    } else if (['joined', 'left', 'recording-state', 'recording-permission-request',
      'recording-permission-answer', 'return-pre-meeting'].includes(message.event)) scheduleRefresh();
  }

  bridge.on('engine', onEngine);
  bridge.on('event', onEvent);
  electron.app.on('browser-window-created', onCreated);
  safeAttach();
  return {
    update,
    suspend: clearWindow,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (attachTask) { clearImmediate(attachTask); attachTask = null; }
      bridge.removeListener('engine', onEngine);
      bridge.removeListener('event', onEvent);
      electron.app.removeListener('browser-window-created', onCreated);
      clearWindow();
    }
  };
}

module.exports = { createMeetingWindowMenu };
