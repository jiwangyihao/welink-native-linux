'use strict';

/* Electron MAIN-process owner for the real Huawei Linux WebRTC runtime.
 * New IPC contract (not the legacy DLL bus):
 *   handle({protocol:'welink-native-web/1', id, operation, params})
 *     -> {protocol, id, ok:true, data} | {protocol, id, ok:false, error:{code,message}}
 * Events: 'engine' carries engine-ready/engine-unavailable with instance/sdkVersion;
 * 'event' carries actual vendor and media-state/device-change notifications.
 * Parent supplies getAccessToken() returning the REAL, un-base64-encoded USG
 * token, requestPermission(), and (unless sourceId is supplied) a source picker.
 * CTD additionally requires getManagementConfig(): the exact successful native
 * auth_init configuration snapshot (same server/port/userAgent/deviceId and
 * configured proxy/CA fields). No current-environment or identity fallback.
 * The independent management WSS request never substitutes the CMS channel.
 * Management operations use the native token provider directly, without opening
 * a media window. engine.capabilities remains the actual HRTC capability report;
 * engine.managementCapabilities separately describes the authenticated services.
 * conference.joinAnonymous clears this browser session and uses #/j without
 * native token/nonce acquisition. A foreign ONLINE prefixed link additionally
 * requires synchronous options.takeIssuedGuestSite(params) issuer attestation;
 * params themselves never authorize a new site. origin is immutable ACCOUNT
 * authority; mediaOrigin is the current isolated browser authority, not account
 * authority. Every browser token, permission and pending reply belongs to that
 * particular ephemeral media owner. Failure reports include actual cleanup.
 * conference.invite uses current-meeting CMS; inviteByToken is explicit HTTP.
 * Recording destinations are chosen only in main (chooseRecordingFile or the
 * native save dialog). The page receives opaque handles, never filesystem paths.
 * session.logout revokes only browser-derived credentials, then clears this
 * isolated session locally even when revocation fails. Its serverLogout report
 * distinguishes confirmed HTTP 200, native-owned tokens and unconfirmed logout.
 * Native logout remains the parent's responsibility; credentials never leave main.
 * Do not log requests, callback payloads or URLs: they can contain credentials.
 */
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createMeetingServices, normalizeInvitation, capabilities: MANAGEMENT_CAPABILITIES } = require('./meeting_native_web_services');
const { createManagementTransport } = require('./meeting_native_web_management');
const { createP2pCalls } = require('./meeting_p2p_call');
const { OfflineConference } = require('./meeting_offline_session');
const { MeetingRenderSurfaceHost } = require('./meeting_render_surface_host');
const { AnonymousVoiceRooms } = require('./meeting_voice_anonymous');
const requireOnlineLinkVariant = require('../shared/meeting_link_admission');
const { IncomingMeetingInvite } = require('./meeting_incoming_invite');
const { P2pMiniWindow } = require('./meeting_p2p_mini');
const snapshotPolicy = require('./meeting_snapshot_policy');
const nativeCapabilityContract = require('./meeting_native_capabilities');
const customBackgroundHost = require('./meeting_custom_background_host');

const PROTOCOL = 'welink-native-web/1';
const OPERATIONS = new Set(['initialize', 'devices.list', 'device.select', 'conference.join',
  'conference.joinAnonymous', 'conference.joinLink', 'conference.invite', 'participant.rename', 'language.set', 'audio.noise.set', 'features.get',
  'conference.joinOffline',
  'conference.leave', 'conference.end', 'audio.setEnabled', 'video.setEnabled', 'screen.start', 'screen.stop',
  'screen.audioInputs', 'recording.capabilities', 'recording.start', 'recording.stop',
  'screen.setPermission', 'screen.permission',
  'background.state', 'background.choose', 'background.apply', 'background.clear',
  'moderation.state', 'moderation.microphoneConsent', 'moderation.control',
  'recording.requestPermission', 'recording.answerPermission', 'recording.grant',
  'watermark.set', 'watermark.state', 'watermark.ensure', 'ui.configure', 'ui.state',
  'capabilities.get', 'error.describe', 'call.p2p.start', 'call.p2p.cancel', 'call.outbound.state',
  'state.get', 'window.show', 'window.p2pMini.toggle', 'session.logout', 'dispose', ...Object.keys(MANAGEMENT_CAPABILITIES)]);
const SERVICE_HEADERS = new Set(['x-invoke-from', 'x-cms-type', 'x-query-type',
  'x-conference-authorization', 'x-password', 'x-login-type']);
const TOKEN_PATH = '/v1/usg/acs/token';
const RECORDING_PERMISSION_EVENTS = new Set(['recording-permission-request', 'recording-permission-answer']);
const RUNTIME_EVENTS = new Set(['media-state', 'devices-changed', 'recording-state',
  'meeting-lifecycle', 'p2p-control', 'policy-violation', 'ui-custom-click', 'directory-invalidated', ...RECORDING_PERMISSION_EVENTS]);
const VENDOR_EVENTS = new Set(['login', 'logout', 'token-changed', 'user-info', 'joined',
  'left', 'join-result', 'leave-result', 'return-pre-meeting']);

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}
function originOf(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.origin : '';
  } catch { return ''; }
}

function validAccessToken(value) {
  return typeof value === 'string' && value.length > 0 && !/[\r\n]/.test(value);
}

class MeetingNativeWeb extends EventEmitter {
  constructor(options) {
    super();
    this.options = options || {};
    if (typeof this.options.origin !== 'string' || !this.options.origin.trim())
      throw failure('ORIGIN_REQUIRED', 'The configured HTTPS meeting service origin is required');
    let server;
    try { server = new URL(this.options.origin); }
    catch (_) { throw failure('INVALID_ORIGIN', 'The configured meeting service origin is not a valid URL'); }
    if (server.protocol !== 'https:' || server.username || server.password || server.search || server.hash)
      throw failure('INVALID_ORIGIN', 'A credential-free HTTPS meeting service origin is required');
    Object.defineProperty(this, 'origin', { value: server.origin, enumerable: true });
    Object.defineProperty(this, 'mediaOrigin', { enumerable: true, get: () => this.mediaOwner.origin });
    this.electron = this.options.electron || require('electron');
    this.instance = crypto.randomBytes(16).toString('hex');
    this.channel = 'welink-native-meeting-' + this.instance;
    this.partition = this.channel + '-' + crypto.randomBytes(16).toString('hex');
    this.mediaOwner = { origin: this.origin, partition: this.partition, retired: false };
    this.accountSession = null;
    this.accountSessionReady = null;
    this.accountRequests = new Set();
    this.ownerEpoch = 0;
    this.logoutRequests = 0;
    this.logoutPromise = null;
    this.window = null;
    this.session = null;
    this.sessionReady = null;
    this.ready = null;
    this.voiceRequested = false;
    this.voiceRevision = 0;
    this.anonymousVoice = new AnonymousVoiceRooms({ electron: this.electron,
      appRoot: this.options.appRoot || path.resolve(__dirname, '..'),
      onError: error => this.emit('event', { protocol: PROTOCOL, instance: this.instance,
        event: 'anonymous-voice-error', data: { code: error.code || 'VOICE_CLEANUP_FAILED' } }) });
    this.initializing = null;
    this.disposed = false;
    this.engineSequence = 0;
    this.serial = Promise.resolve();
    this.p2pEvents = Promise.resolve();
    this.p2pIncomingEpoch = 0;
    this.p2pMini = new P2pMiniWindow(this);
    this.webToken = '';
    this.browserTokens = new Set();
    this.protectedNativeTokens = new Set();
    this.browserWebContents = new Set();
    this.confirmedBrowserLogouts = new Set();
    this.pendingBrowserLogouts = new Map();
    this.failedBrowserLogouts = new Map();
    this.browserInventoryComplete = true; // No browser window has been opened.
    this.loggingOut = false;
    this.retiring = false;
    this.disposeRequested = false;
    this.policyEpoch = 0;
    this.policyIntents = { watermark: 0, ui: 0 };
    this.policyPending = new Set();
    this.nativeUiCount = 0;
    this.watermarkConfiguration = null;
    this.uiConfiguration = null;
    this.watermarkApproved = false;
    this.uiApproved = false;
    this.policyRestoreWindow = null;
    this.policyShutdown = null;
    this.lastMediaState = null;
    this.lastMeetingLifecycle = null;
    this.userInfo = null;
    this.selectedSource = null;
    this.screenStartPending = false;
    this.shareAudioEnabled = false;
    this.nativeCapabilityConfiguration = new Map();
    this.nativeCapabilityRevisions = new Map();
    this.outputRequest = null;
    this.screenCancellationEpoch = 0;
    this.screenDenialConfigured = false;
    this.captureSelections = new Set();
    this.invitedCaptureRequests = new Map();
    this.recordingCancellationEpoch = 0;
    this.recordTipEnabled = true;
    this.recordTipRevision = 0;
    this.managementCancellationEpoch = 0;
    this.recordingStart = null;
    this.recordingPermissionPrompts = new Set();
    this.recordingRequests = new Map();
    this.recordingFiles = new Map();
    this.recordingReceipts = new Map();
    this.allowedPermissions = new Set();
    this.incomingInvite = new IncomingMeetingInvite({ electron: this.electron,
      getParent: () => this.options.parentWindow && !this.options.parentWindow.isDestroyed() ? this.options.parentWindow : this.window,
      isCurrent: () => this.mediaOrigin === this.origin && !!this.window && !this.window.isDestroyed() &&
        !this.disposed && !this.retiring && !this.loggingOut && !!this.webToken });
    this.runtimeSource = ['../shared/meeting_link_admission.js', 'meeting_native_web_watermark.js', 'meeting_native_web_ui.js',
      'meeting_native_web_capture.js', 'meeting_native_web_recording.js',
      'meeting_native_web_recording_tip.js',
      'meeting_invited_share.js',
      'meeting_snapshot_policy.js',
      'meeting_render_windows.js',
      'meeting_render_surface.js',
      'meeting_voice_media.js',
      'meeting_custom_background_policy.js', 'meeting_custom_background.js',
      'meeting_sdk_log_catalog.js', 'meeting_sdk_log_runtime.js',
      'meeting_moderation_capabilities.js', 'meeting_moderation_capabilities_web.js',
      'meeting_native_web_recording_control.js', 'meeting_native_capabilities.js', 'meeting_native_web_runtime.js']
      .map(name => fs.readFileSync(path.join(__dirname, name), 'utf8')).join('\n;\n');
    this.management = typeof this.options.getManagementConfig === 'function' ? createManagementTransport({
      origin: this.origin, getConfig: () => this.options.getManagementConfig(),
      getAccessToken: () => this.nativeAccessToken()
    }) : null;
    this.meetingServices = createMeetingServices({
      request: (method, servicePath, options) => this.requestMeetingService(method, servicePath, options),
      requestManagement: this.management ? (type, body) => this.management.request(type, body) : undefined,
      requestManagementAttempt: this.management ? (type, body) => this.management.begin(type, body) : undefined
    });
    this.p2p = this.management && typeof this.options.getCallContext === 'function' ? createP2pCalls({
      beginCreate: (body, settings) => this.management.begin('CREATECONF', body, settings),
      joinCaller: (created, context) => this.joinP2pCaller(created, context),
      endConference: (id, context) => this.endP2pConference(id, context),
      emit: (frame, state) => {
        if (frame.notify === 33) {
          this.p2pMini.restore();
          if (state.isCallOut === false) this.incomingInvite.cancel();
          this.stopP2pObservation(state);
        }
        this.emit('event', { protocol: PROTOCOL, instance: this.instance, event: 'p2p-native-notify', data: frame });
        this.emit('event', { protocol: PROTOCOL, instance: this.instance, event: 'p2p-call-state', data: state });
      }
    }) : null;
    this.offline = typeof this.options.getOfflineConfig === 'function' ? new OfflineConference({
      electron:this.electron, parentWindow:this.options.parentWindow, getConfig:this.options.getOfflineConfig,
      getSession:this.options.getOfflineSession, permission:this.options.requestOfflinePermission,
      askDevice:this.options.askOfflineDevice, anonymousVoice:this.anonymousVoice,
      onRenderSurfaces:this.options.onRenderSurfaces,
      notify:data => this.emit('event', {protocol:PROTOCOL, instance:this.instance, event:'offline-conference', data})
    }) : null;
    this.electron.ipcMain.handle(this.channel, (event, message) => this.receive(event, message));
  }

  resetMediaSite(origin = this.origin) {
    // A retired partition is never reused, even for another invitation at the
    // same site. Old request observers retain their old token sets, not these.
    if (this.window && !this.window.isDestroyed())
      throw failure('MEDIA_OWNER_BUSY', 'The existing media window must be closed before changing its site');
    this.mediaOwner.retired = true;
    this.partition = this.channel + '-' + crypto.randomBytes(16).toString('hex');
    this.mediaOwner = { origin, partition: this.partition, retired: false };
    this.session = null;
    this.sessionReady = null;
    this.ready = null;
    this.webToken = '';
    this.userInfo = null;
    this.lastMediaState = null;
    this.lastMeetingLifecycle = null;
    this.browserTokens = new Set();
    this.browserWebContents = new Set();
    this.confirmedBrowserLogouts = new Set();
    this.pendingBrowserLogouts = new Map();
    this.failedBrowserLogouts = new Map();
    this.browserInventoryComplete = true;
    this.allowedPermissions.clear();
    this.recordingReceipts.clear();
    this.voiceRequested = false;
    ++this.voiceRevision;
    this.cancelScreenStart();
  }

  requireMediaOwner(owner, window) {
    if (owner !== this.mediaOwner || owner.retired ||
        (window !== undefined && (window !== this.window || !window || window.isDestroyed())))
      throw failure('MEDIA_OWNER_CHANGED', 'The media request belongs to a retired browser session');
  }

  scheduleGuestRetirement(owner = this.mediaOwner) {
    if (owner.origin === this.origin || owner.retirement || owner.retired || this.disposed || this.loggingOut) return;
    const task = this.serial.then(async () => {
      if (owner !== this.mediaOwner || owner.retired || this.disposed || this.loggingOut) return;
      const report = await this.retireIdleBrowserSession(owner);
      this.emit('event', { protocol: PROTOCOL, instance: this.instance,
        event: 'guest-session-cleanup', data: report });
    }).catch(error => {
      this.emit('event', { protocol: PROTOCOL, instance: this.instance, event: 'guest-session-cleanup',
        data: { errors: [this.publicLogoutError(error, 'guest-session-cleanup')] } });
    }).finally(() => { owner.retirement = null; });
    owner.retirement = task;
    this.serial = task.catch(() => {});
  }

  hideMeetingWindow() {
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    try {
      window.hide();
      if (!window.isDestroyed() && window.isVisible())
        throw failure('WINDOW_HIDE_UNCONFIRMED', 'The meeting window did not become hidden');
    } catch (error) {
      // Never remove a visual policy from a window which could still expose
      // content. Closing this owned window is safer than unprotected teardown.
      if (!window.isDestroyed()) window.destroy();
      throw error;
    }
  }

  async ensureMeetingPolicies() {
    if (this.disposed || this.retiring || this.loggingOut)
      throw failure('SESSION_LOGOUT_IN_PROGRESS', 'The meeting owner is being retired');
    if (!this.watermarkApproved || !this.uiApproved || this.policyPending.size)
      throw failure('MEETING_POLICY_NOT_CONFIGURED', 'Authoritative watermark and UI policies must be applied before meeting content is exposed');
    return this.callPage('policies.ensure');
  }

  async showMeetingWindow() {
    if (this.offline?.window) return this.offline.active.view.show();
    const window = this.window;
    const epoch = this.policyEpoch;
    const policies = await this.ensureMeetingPolicies();
    if (epoch !== this.policyEpoch || window !== this.window || !window || window.isDestroyed() ||
        this.retiring || this.policyPending.size)
      throw failure('POLICY_REQUEST_RETIRED', 'The meeting owner changed before display');
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    if (!window.isVisible()) throw failure('WINDOW_SHOW_UNCONFIRMED', 'The protected meeting window did not become visible');
    return { visible: true, focused: window.isFocused(), policies };
  }

  schedulePolicyShutdown(source, error) {
    this.hideMeetingWindow();
    const detail = { source, code: error.code || 'POLICY_ENFORCEMENT_LOST',
      message: String(error.message || error), ...(error.details === undefined ? {} : { details: error.details }) };
    try {
      this.emit('event', { protocol: PROTOCOL, instance: this.instance, event: 'policy-violation', data: detail });
    } finally {
      if (!this.policyShutdown && !this.disposed && !this.disposeRequested) {
        const shutdown = this.execute('session.logout');
        this.policyShutdown = shutdown;
        shutdown.then(report => this.emit('event', { protocol: PROTOCOL, instance: this.instance,
          event: 'policy-cleanup', data: report }), failure => this.emit('event', { protocol: PROTOCOL,
          instance: this.instance, event: 'policy-cleanup', data: {
            error: this.publicLogoutError(failure, 'policy-cleanup'), report: failure.details } }))
          .finally(() => { if (this.policyShutdown === shutdown) this.policyShutdown = null; })
          .catch(() => {});
      }
    }
  }

  configureMeetingPolicy(operation, params) {
    const source = operation === 'watermark.set' ? 'watermark' : 'ui';
    const intent = ++this.policyIntents[source];
    for (const selection of this.captureSelections) selection.abort();
    const epoch = this.policyEpoch;
    this.policyPending.add(source);
    if (source === 'watermark') this.watermarkApproved = false;
    else this.uiApproved = false;
    const task = (async () => {
      if (source === 'watermark' && params?.content !== '' && this.nativeUiCount)
        throw failure('WATERMARK_NATIVE_UI_BUSY', 'A native/owner dialog is still open; a mandatory watermark cannot be confirmed for it');
      if (this.disposed) throw failure('DISPOSED', 'The meeting owner was disposed');
      if (this.retiring || this.loggingOut)
        throw failure('SESSION_LOGOUT_IN_PROGRESS', 'The meeting owner is being retired');
      if (this.window && !this.window.isDestroyed() && this.window.isVisible())
        this.policyRestoreWindow = this.window;
      this.hideMeetingWindow();
      await this.initialize();
      if (epoch !== this.policyEpoch || intent !== this.policyIntents[source] || this.retiring)
        throw failure('POLICY_REQUEST_RETIRED', 'The policy request belongs to a retired owner or revision');
      const window = this.window;
      const result = await this.callPage(operation, params);
      if (epoch !== this.policyEpoch || intent !== this.policyIntents[source] ||
          window !== this.window || this.disposed || this.retiring)
        throw failure('POLICY_REQUEST_RETIRED', 'The policy owner changed while configuration was applied');
      if (source === 'watermark') {
        this.watermarkConfiguration = { content: params.content, color: params.color };
        if (this.offline?.window) await this.offline.active.view.watermark(this.watermarkConfiguration);
        this.watermarkApproved = true;
      } else {
        if (!result || !result.configuration || typeof result.configuration !== 'object' ||
            Array.isArray(result.configuration) || result.configuration.customButtonStatus !== null)
          throw failure('INVALID_UI_CONFIGURATION_REPLY', 'The provider did not return a replay-safe confirmed UI policy');
        this.uiConfiguration = result.configuration;
        this.uiApproved = true;
      }
      this.policyPending.delete(source);
      if (!this.policyPending.size && this.watermarkApproved && this.uiApproved &&
          this.policyRestoreWindow === this.window && this.window && !this.window.isDestroyed()) {
        await this.showMeetingWindow();
        this.policyRestoreWindow = null;
      }
      return result;
    })().catch(error => {
      if (epoch === this.policyEpoch && intent === this.policyIntents[source] &&
          !['DISPOSED', 'SESSION_LOGOUT_IN_PROGRESS', 'POLICY_REQUEST_RETIRED'].includes(error.code))
        this.schedulePolicyShutdown(source, error);
      throw error;
    }).finally(() => {
      if (intent === this.policyIntents[source]) this.policyPending.delete(source);
    });
    // Configuration itself runs immediately. Later operations still wait for
    // both the prior work and the completed policy application.
    this.serial = Promise.allSettled([this.serial, task]).then(() => {});
    return task;
  }

  initializeSession() {
    if (!this.sessionReady) {
      const owner = this.mediaOwner;
      this.sessionReady = Promise.resolve().then(async () => {
        this.requireMediaOwner(owner);
        const session = this.electron.session.fromPartition(owner.partition);
        this.session = session;
        this.watchBrowserLogouts(session, owner);
        if (this.hasOutputMonitorRoute()) session.setDisplayMediaRequestHandler((request, reply) => {
          if (owner !== this.mediaOwner || owner.retired) return reply(null);
          this.selectOutputCapture(request).then(reply, () => reply(null));
        });
        if (this.options.proxyRules) await session.setProxy({ proxyRules: this.options.proxyRules });
        this.requireMediaOwner(owner);
        return session;
      });
    }
    return this.sessionReady;
  }

  initializeAccountSession() {
    // Account HTTP never shares a cookie/auth-cache partition with any page,
    // including the primary browser. In particular a guest cannot plant cookies
    // on native requests or observe tokens from their response/session state.
    if (!this.accountSessionReady) {
      this.accountSessionReady = Promise.resolve().then(async () => {
        const session = this.electron.session.fromPartition(this.channel + '-account-' + crypto.randomBytes(16).toString('hex'));
        this.accountSession = session;
        if (this.options.proxyRules) await session.setProxy({ proxyRules: this.options.proxyRules });
        return session;
      });
    }
    return this.accountSessionReady;
  }

  voiceSession() {
    if (this.mediaOwner.anonymous) return this.anonymousVoice.session(this.mediaOwner);
    return this.mediaOrigin === this.origin ? this.options.getVoiceSession?.() : null;
  }

  anonymousVoiceState() { return this.anonymousVoice.state(); }
  configureAnonymousVoiceCapability(enabled) { return this.anonymousVoice.configure(enabled); }
  showAnonymousVoiceEnrollment() { return this.anonymousVoice.show(); }
  disableAnonymousVoiceProtection() { return this.anonymousVoice.disable(); }

  async configureCustomBackground(enabled) {
    if (typeof enabled !== 'boolean') throw failure('INVALID_ARGUMENT', 'enabled must be boolean');
    if (this.offline?.active) throw failure('BACKGROUND_PROVIDER_UNAVAILABLE', 'The offline provider has no verified custom-background policy');
    if (!this.ready || !this.window || this.window.isDestroyed())
      throw failure('ENGINE_NOT_READY', 'Initialize the real meeting provider before configuring custom backgrounds');
    return this.callPage('background.configure', { enabled });
  }

  async configureVoiceProtection(enabled, expectedVoice) {
    const voice = this.voiceSession();
    const retiringRoom = this.anonymousVoice.room;
    const retiringAnonymous = !enabled && retiringRoom?.owner === this.mediaOwner &&
      retiringRoom.session === expectedVoice;
    if (expectedVoice && voice !== expectedVoice && !retiringAnonymous) {
      if (!enabled) return { enabled: false, stopped: true, scope: 'retired-voice-owner' };
      throw failure('VOICE_NOT_AUTHORIZED', 'The voiceprint belongs to a different account or anonymous room');
    }
    if (typeof enabled !== 'boolean' || (enabled && !voice?.requested()))
      throw failure('VOICE_NOT_AUTHORIZED', 'No current local voice protection request');
    const revision = ++this.voiceRevision;
    this.voiceRequested = enabled;
    const unavailable = enabled && !voice.allowed();
    const window = this.window;
    if (!window || window.isDestroyed()) return { enabled, armed: enabled && !unavailable, protected: false,
      processing: false, stopped: true, state: unavailable ? 'blocked' : enabled ? 'armed' : 'disabled' };
    if (!this.ready && this.initializing) {
      try { await this.initializing; }
      catch (err) { if (enabled || !window.isDestroyed()) throw err; }
    }
    if (revision !== this.voiceRevision) throw failure('VOICE_SESSION_CHANGED', 'The audio policy changed during configuration');
    if (window.isDestroyed() || this.window !== window) {
      if (enabled) throw failure('VOICE_SESSION_CHANGED', 'The media document was replaced');
      return { enabled: false, stopped: true };
    }
    const result = await this.callPage('voice.configure', { enabled, unavailable });
    if (revision !== this.voiceRevision || result?.enabled !== enabled || (unavailable ?
        result.state !== 'blocked' || result.protected !== false : enabled ? result.armed !== true : result.stopped !== true))
      throw failure('VOICE_MEDIA_UNCONFIRMED', 'The microphone owner did not confirm the requested voice policy');
    if (this.lastMediaState) this.lastMediaState = { ...this.lastMediaState, voiceProtection: result };
    return result;
  }

  engineUnavailable(reason) {
    this.renderSurfaceHost?.stop('RENDER_ENGINE_RETIRED').catch(() => {});
    this.p2pMini.restore();
    this.incomingInvite.cancel();
    const voice = this.voiceSession();
    if (voice) voice.filter.stop().catch(() => console.warn('Native voice process retirement unconfirmed'));
    if (this.mediaOwner.anonymous) {
      this.anonymousVoice.retire(this.mediaOwner).catch(() => console.warn('Anonymous voice deletion unconfirmed'));
      // A new document must never inherit the old room's microphone grant.
      this.allowedPermissions.clear();
      if (['document-navigation', 'renderer-gone'].includes(reason) && this.window && !this.window.isDestroyed())
        this.window.destroy();
    }
    this.ready = null;
    for (const controller of this.recordingPermissionPrompts) controller.abort();
    for (const request of this.invitedCaptureRequests.values()) request.controller.abort();
    if (this.recordingRequests.size) {
      ++this.recordingCancellationEpoch;
      this.cancelRecordingAuthorization();
      this.abortRecordingOutputs().catch(error => this.reportRecordingFailure(error));
    }
    this.emit('engine', { protocol: PROTOCOL, instance: this.instance,
      sequence: ++this.engineSequence, event: 'engine-unavailable', reason });
  }

  async initialize(entryRoute = '/login') {
    if (this.disposed) throw failure('DISPOSED', 'The meeting bridge was disposed');
    if (this.retiring || this.loggingOut) throw failure('SESSION_LOGOUT_IN_PROGRESS', 'The browser meeting session is being cleared');
    if (this.ready) return this.ready;
    if (this.initializing) return this.initializing;
    const task = this.initializeWindow(entryRoute).finally(() => {
      if (this.initializing === task) this.initializing = null;
    });
    this.initializing = task;
    return task;
  }

  async initializeWindow(entryRoute) {
    const { BrowserWindow } = this.electron;
    const owner = this.mediaOwner;
    if (this.window && !this.window.isDestroyed())
      throw failure('ENGINE_NOT_READY', 'An existing media window must be explicitly retired before it can be replaced');
    await this.initializeSession();
    this.requireMediaOwner(owner);
    if (this.disposed || this.retiring || this.loggingOut)
      throw failure('SESSION_LOGOUT_IN_PROGRESS', 'The browser meeting session is being cleared');
    const window = new BrowserWindow({
      width: 1100, height: 760, show: false,
      parent: this.options.parentWindow,
      title: 'WeLink conference',
      webPreferences: {
        partition: owner.partition,
        preload: path.join(__dirname, 'meeting_native_web_preload.js'),
        additionalArguments: ['--welink-meeting-channel=' + this.channel],
        nodeIntegration: false, contextIsolation: true, sandbox: true,
        // Canvas/MediaRecorder must keep advancing while this dedicated window
        // is hidden or minimized; no capture is started by this preference.
        backgroundThrottling: false,
        webSecurity: true, allowRunningInsecureContent: false
      }
    });
    this.window = window;
    this.browserWebContents.add(window.webContents.id);
    this.browserInventoryComplete = false;
    this.session.setPermissionCheckHandler((contents, permission, requestingOrigin) =>
      this.mediaOwner === owner && !owner.retired && this.window === window &&
      !this.retiring && !this.loggingOut && !this.disposed &&
      contents === window.webContents && originOf(requestingOrigin) === owner.origin &&
      originOf(contents.getURL()) === owner.origin && this.allowedPermissions.has(permission));
    this.session.setPermissionRequestHandler((contents, permission, callback, details) => {
      if (this.mediaOwner !== owner || owner.retired || this.window !== window ||
          this.retiring || this.loggingOut || this.disposed || contents !== window.webContents ||
          originOf(contents.getURL()) !== owner.origin ||
          (details.requestingUrl && originOf(details.requestingUrl) !== owner.origin) ||
          (details.securityOrigin && originOf(details.securityOrigin) !== owner.origin) ||
          !['media', 'display-capture', 'speaker-selection'].includes(permission) ||
          typeof this.options.requestPermission !== 'function') return callback(false);
      // Electron 22 reports a display request as media with no device types.
      // Do not turn a screen permission into a cached microphone/camera grant.
      if (permission === 'media' && Array.isArray(details.mediaTypes) && !details.mediaTypes.length)
        permission = 'display-capture';
      Promise.resolve(this.options.requestPermission({ permission, details })).then(allowed => {
        allowed = allowed === true && this.mediaOwner === owner && !owner.retired &&
          this.window === window && !window.isDestroyed() && !this.loggingOut && !this.retiring && !this.disposed &&
          originOf(contents.getURL()) === owner.origin;
        if (allowed === true) this.allowedPermissions.add(permission);
        callback(allowed === true);
      }, () => callback(false));
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => {
      if (this.mediaOwner !== owner || owner.retired || originOf(url) !== owner.origin) event.preventDefault();
    });
    window.webContents.on('will-redirect', (event, url) => {
      if (this.mediaOwner !== owner || owner.retired || originOf(url) !== owner.origin) event.preventDefault();
    });
    window.webContents.on('did-start-navigation', (event, url, inPage, isMainFrame) => {
      if (isMainFrame && !inPage && this.window === window && this.ready)
        this.engineUnavailable('document-navigation');
    });
    window.webContents.on('render-process-gone', () => {
      if (this.window === window) this.engineUnavailable('renderer-gone');
    });
    window.on('closed', () => {
      if (this.window !== window) return;
      if (this.lastMediaState && (this.lastMediaState.joined || this.lastMediaState.roomJoined) &&
          this.lastMeetingLifecycle?.state !== 'left') {
        this.emit('event', { protocol: PROTOCOL, instance: this.instance, event: 'meeting-lifecycle',
          data: { state: 'closed', source: 'window-close', localOnly: true, lastObserved: this.lastMediaState } });
      }
      if (this.policyRestoreWindow === window) this.policyRestoreWindow = null;
      this.window = null;
      this.webToken = '';
      this.userInfo = null;
      this.engineUnavailable('window-closed');
      this.scheduleGuestRetirement(owner);
    });
    try {
      const url = new URL('/webrtc/', owner.origin);
      url.searchParams.set('lang', this.options.language === 'en-US' ? 'en-US' : 'zh-CN');
      url.hash = entryRoute;
      await window.loadURL(url.href);
      this.requireMediaOwner(owner, window);
      if (owner.anonymous) await this.anonymousVoice.attach({ owner, window,
        isCurrent: () => this.mediaOwner === owner && !owner.retired && this.window === window &&
          !this.disposed && !this.retiring && !this.loggingOut,
        configure: (enabled, voice) => this.configureVoiceProtection(enabled, voice),
        getState: () => this.lastMediaState?.voiceProtection });
      if (this.disposed || this.retiring || this.loggingOut)
        throw failure('SESSION_LOGOUT_IN_PROGRESS', 'Meeting initialization was retired');
      await window.webContents.executeJavaScript(this.runtimeSource);
      this.requireMediaOwner(owner, window);
      const session = this.voiceSession();
      this.voiceRequested = !!session?.requested();
      let result = await this.callPage('initialize', { sdkLog: !!this.options.sdkLog,
        voiceHost: !!owner.anonymous || (owner.origin === this.origin && typeof this.options.getVoiceSession === 'function'),
        voiceScope: owner.anonymous ? 'anonymous-room-memory' : 'local-account',
        voiceEnabled: this.voiceRequested, voiceUnavailable: this.voiceRequested && !session.allowed() });
      if (!this.recordTipEnabled) await this.callPage('recordTip.configure', { enabled: false });
      for (const [type, isEnable] of this.nativeCapabilityConfiguration) {
        if (type === 10) await this.callPage('background.configure', { enabled: isEnable });
        else await this.callPage('capability.configure', { type, isEnable });
      }
      if (this.watermarkApproved && this.watermarkConfiguration)
        await this.callPage('watermark.set', this.watermarkConfiguration);
      // Room state is deliberately absent from the confirmed replay snapshot.
      if (this.uiConfiguration && (this.uiApproved || this.policyPending.has('ui')))
        await this.callPage('ui.configure', this.uiConfiguration);
      if (this.screenDenialConfigured)
        await this.callPage('screen.setPermission', { allowed: false });
      // Refresh the actual capability report after replaying confirmed policy.
      result = await this.callPage('initialize');
      if (!result || result.ready !== true || typeof result.sdkVersion !== 'string' || !result.sdkVersion)
        throw failure('ENGINE_NOT_READY', 'The actual HRTC initialization did not report readiness');
      this.requireMediaOwner(owner, window);
      if (this.disposed || this.retiring || this.loggingOut)
        throw failure('SESSION_LOGOUT_IN_PROGRESS', 'Meeting initialization was retired');
      this.ready = { protocol: PROTOCOL, instance: this.instance, event: 'engine-ready',
        sequence: ++this.engineSequence, sdkVersion: result.sdkVersion,
        vendorAsset: result.vendorAsset, capabilities: result.capabilities,
        managementCapabilities: this.meetingServices.capabilities };
      this.emit('engine', this.ready);
      return this.ready;
    } catch (error) {
      if (owner === this.mediaOwner && this.window === window)
        this.engineUnavailable(error.code || 'initialization-failed');
      if (!window.isDestroyed()) window.destroy();
      throw error;
    }
  }

  callPage(operation, params = {}) {
    const owner = this.mediaOwner;
    const window = this.window;
    if (!this.window || this.window.isDestroyed())
      return Promise.reject(failure('ENGINE_NOT_READY', 'The genuine meeting window is absent'));
    if (owner.retired)
      return Promise.reject(failure('MEDIA_OWNER_CHANGED', 'The media owner has been retired'));
    if (originOf(window.webContents.getURL()) !== owner.origin)
      return Promise.reject(failure('ORIGIN_CHANGED', 'The meeting page left its bound media service origin'));
    if (owner.origin !== this.origin && operation === 'conference.join')
      return Promise.reject(failure('ACCOUNT_MEDIA_REQUIRED', 'Native account handoff requires the primary media window'));
    const invocation = 'window.__welinkNativeMeeting.invoke(' + JSON.stringify(operation) + ',' + JSON.stringify(params) + ')';
    const userGesture = ['conference.join', 'conference.joinAnonymous', 'conference.joinLink',
      'audio.setEnabled', 'video.setEnabled', 'screen.start', 'recording.start', 'device.select'].includes(operation);
    return window.webContents.executeJavaScript(invocation, userGesture)
      .then(reply => {
        this.requireMediaOwner(owner, window);
        if (originOf(window.webContents.getURL()) !== owner.origin)
          throw failure('ORIGIN_CHANGED', 'The meeting document changed while the operation was pending');
        if (!reply || typeof reply.ok !== 'boolean')
          throw failure('INVALID_RUNTIME_REPLY', 'The media runtime returned an invalid control reply');
        if (!reply.ok) {
          const error = reply.error || {};
          const rejected = failure(error.code === undefined ? 'MEDIA_OPERATION_FAILED' : error.code,
            String(error.message || 'The genuine media operation failed'));
          if (Object.prototype.hasOwnProperty.call(error, 'details')) rejected.details = error.details;
          throw rejected;
        }
        return operation === 'recording.start' || operation === 'recording.stop' ?
          this.recordingResult(reply.data) : reply.data;
      });
  }

  async receive(event, message) {
    if (!this.window || this.window.isDestroyed() || this.mediaOwner.retired || this.disposed ||
        event.sender !== this.window.webContents || !event.senderFrame ||
        event.senderFrame !== this.window.webContents.mainFrame ||
        originOf(event.senderFrame.url) !== this.mediaOrigin ||
        originOf(event.sender.getURL()) !== this.mediaOrigin)
      throw failure('UNTRUSTED_SENDER', 'Rejected a foreign or retired meeting bridge sender');
    if (!message || typeof message !== 'object') throw failure('INVALID_MESSAGE', 'Expected a bridge request');
    const owner = this.mediaOwner;
    const window = this.window;
    if (message.operation === 'render-surfaces-invalidate')
      return this.renderSurfaceHost?.invalidate(event.sender, message.data) || {retired:true};
    if (message.operation === 'custom-background-assets') {
      if (!this.nativeCapabilityEnabled(10) || this.retiring || this.loggingOut)
        throw failure('NATIVE_CAPABILITY_DISABLED', 'Custom background processing is disabled');
      const assets = await customBackgroundHost.loadAssets();
      this.requireMediaOwner(owner, window);
      return assets;
    }
    if (['voice-open', 'voice-process', 'voice-close'].includes(message.operation)) {
      const voice = this.voiceSession();
      if (message.operation === 'voice-close') {
        if (typeof message.id !== 'string') throw failure('INVALID_ARGUMENT', 'Missing local audio handle');
        return voice ? voice.filter.close(message.id) : { closed: true };
      }
      if (!voice?.allowed() || !this.voiceRequested || this.disposed || this.retiring || this.loggingOut)
        throw failure('VOICE_NOT_AUTHORIZED', 'The local voice grant is not active');
      return message.operation === 'voice-open' ? voice.open() : voice.process(message.id, message.pcm);
    }
    if (message.operation === 'sdk-log-write' || message.operation === 'incoming-invite') {
      if (message.operation === 'sdk-log-write') {
        if (!this.options.sdkLog || this.disposed) throw failure('SDK_LOG_UNAVAILABLE', 'No local media log sink');
        try { return await this.options.sdkLog.write(message.batch); }
        catch (error) { throw failure('SDK_LOG_WRITE_FAILED', 'The local media log write failed'); }
      }
      if (this.mediaOrigin !== this.origin)
        throw failure('ACCOUNT_MEDIA_REQUIRED', 'A guest page cannot request native account invitations');
      if (message.optType === 1) { this.incomingInvite.cancel(); return null; }
      if (message.optType !== 0 || this.disposed || this.retiring || this.loggingOut || !this.webToken) return null;
      return this.incomingInvite.present({ p2p: message.p2p === true, subject: message.subject, mediaType: message.mediaType });
    }
    if (['recording-open', 'recording-write', 'recording-close', 'recording-abort'].includes(message.operation)) {
      try {
        switch (message.operation) {
          case 'recording-open': return await this.openRecordingFile(message);
          case 'recording-write': return await this.writeRecordingFile(message);
          case 'recording-close': return await this.closeRecordingFile(message);
          case 'recording-abort': return await this.abortRecordingFile(message);
        }
      } catch (error) {
        // Node filesystem errors include the selected path in message/stack.
        // Preserve the actual error code without exposing that path to the page.
        const code = error && typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ?
          error.code : 'RECORDING_FILE_FAILED';
        throw failure(code, `Recording file operation failed (${code})`);
      }
    }
    if (message.operation === 'capture-source-cancel') {
      const request = this.invitedCaptureRequests.get(message.requestId);
      const current = request && request.owner === owner && request.window === window;
      if (current) request.controller.abort();
      return { requestId: message.requestId, cancelled: !!current };
    }
    if (message.operation === 'capture-sources') {
      const id = message.invitationRequestId;
      let request;
      if (id !== undefined && id !== null) {
        if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id) || this.invitedCaptureRequests.has(id))
          throw failure('INVALID_CAPTURE_REQUEST', 'Expected a unique invitation capture attempt');
        if (!this.nativeCapabilityEnabled(1)) throw failure('NATIVE_CAPABILITY_DISABLED', 'Sharing invitations are disabled');
        request = { controller: new AbortController(), owner, window };
        this.invitedCaptureRequests.set(id, request);
      }
      try {
        const sessionKey = await this.requireScreenGrant();
        this.requireMediaOwner(owner, window);
        if (request?.controller.signal.aborted) throw failure('CAPTURE_CANCELLED', 'The sharing invitation was revoked');
        const selected = await this.captureSources(message.types, sessionKey, false, request?.controller.signal);
        this.requireMediaOwner(owner, window);
        return JSON.stringify([selected]);
      } finally {
        if (request && this.invitedCaptureRequests.get(id) === request) this.invitedCaptureRequests.delete(id);
      }
    }
    if (message.operation === 'capture-environment') {
      const system = this.hasOutputMonitorRoute();
      return { platform: process.platform, electronVersion: process.versions.electron || null,
        nativeDisplayMediaConfigured: system, displayAudio: system ? 'system' : 'unavailable' };
    }
    if (message.operation === 'recording-permission-prompt')
      return this.promptRecordingPermission(message.data);
    if (message.operation === 'runtime-event') {
      if (!RUNTIME_EVENTS.has(message.event))
        throw failure('INVALID_EVENT', 'Unknown media runtime event');
      let name = message.event;
      let data = message.data;
      if (name === 'policy-violation') {
        if (!data || !['watermark', 'ui'].includes(data.source))
          throw failure('INVALID_POLICY_EVENT', 'The policy violation has no verified source');
        this.schedulePolicyShutdown(data.source, data);
        return;
      }
      if (name === 'p2p-control') {
        const epoch = this.ownerEpoch;
        const incomingEpoch = this.p2pIncomingEpoch;
        const task = this.p2pEvents.then(async () => {
          if (this.mediaOrigin !== this.origin || !this.p2p || this.disposed || this.retiring || this.loggingOut ||
              epoch !== this.ownerEpoch) return false;
          let accepted;
          if (data?.type === 'incoming') {
            if (!this.webToken || this.lastMediaState?.joined || this.offline?.active) return false;
            const context = await this.options.getCallContext();
            this.requireOwnerEpoch(epoch);
            if (!this.webToken || this.loggingOut || incomingEpoch !== this.p2pIncomingEpoch) return false;
            this.p2p.incoming(data, context);
            accepted = true;
          } else accepted = this.p2p.handleEvent(data);
          if (accepted)
            this.emit('event', { protocol: PROTOCOL, instance: this.instance, event: 'p2p-call-state', data: this.p2p.state() });
          return accepted;
        });
        this.p2pEvents = task.catch(() => false);
        return task;
      }
      if (name === 'media-state') this.lastMediaState = data;
      if (name === 'media-state' && data?.joined && this.mediaOrigin === this.origin && this.p2p?.state().pending) {
        const call = this.p2p.state();
        if (String(data.conferenceId) === call.conferenceID &&
            this.p2p.handleEvent({type:'caller-joined', attemptId:call.attemptId,
              conferenceID:call.conferenceID, participantId:String(data.participantId)}))
          this.emit('event', { protocol:PROTOCOL, instance:this.instance, event:'p2p-call-state', data:this.p2p.state() });
      }
      if (name === 'meeting-lifecycle') this.lastMeetingLifecycle = data;
      if (name === 'media-state') this.p2pMini.reconcile();
      if (name === 'meeting-lifecycle' && ['left','closed'].includes(data?.state)) this.p2pMini.restore();
      if (name === 'recording-state' && data && RECORDING_PERMISSION_EVENTS.has(data.event)) {
        name = data.event;
        data = data.data;
      }
      if (name === 'recording-state') data = this.recordingResult(data);
      this.emit('event', { protocol: PROTOCOL, instance: this.instance, event: name, data });
      if (name === 'meeting-lifecycle' && data?.state === 'left') this.scheduleGuestRetirement();
      if (name === 'meeting-lifecycle' && data?.state === 'left' && owner.anonymous)
        await this.anonymousVoice.retire(owner);
      return;
    }
    if (message.operation === 'vendor-event') {
      if (!VENDOR_EVENTS.has(message.name)) throw failure('INVALID_EVENT', 'Unknown vendor event');
      if (owner.anonymous && ['logout', 'left', 'return-pre-meeting'].includes(message.name))
        await this.anonymousVoice.retire(owner);
      if (message.name === 'login' || message.name === 'token-changed') {
        const value = message.data && message.data.token;
        if (typeof value !== 'string' || (value && !validAccessToken(value)))
          throw failure('INVALID_TOKEN_EVENT', 'Vendor token event is malformed');
        if (this.mediaOrigin !== this.origin && this.protectedNativeTokens.has(value))
          throw failure('NATIVE_TOKEN_OWNED', 'A guest page cannot claim a native account credential');
        this.webToken = value;
        if (!value) { this.incomingInvite.cancel(); this.retireIncomingP2p(); }
        if (value) {
          this.browserTokens.add(value);
          this.browserInventoryComplete = false;
        }
        this.emit('event', { protocol: PROTOCOL, instance: this.instance, event: 'media-authentication-changed',
          data: { authenticated: value.length > 0 } });
      } else if (message.name === 'logout') {
        this.incomingInvite.cancel();
        this.retireIncomingP2p();
        this.webToken = '';
        this.userInfo = null;
        this.emit('event', { protocol: PROTOCOL, instance: this.instance, event: 'media-authentication-changed',
          data: { authenticated: false } });
      } else if (message.name === 'user-info') {
        this.userInfo = message.data && message.data.userInfo;
        this.emit('event', { protocol: PROTOCOL, instance: this.instance, event: 'media-user-info-changed' });
      } else {
        this.emit('event', { protocol: PROTOCOL, instance: this.instance, event: message.name, data: message.data });
      }
      return;
    }
    if (message.operation === 'home') {
      this.emit('event', { protocol: PROTOCOL, instance: this.instance, event: 'show-home' });
      if (this.options.parentWindow && !this.options.parentWindow.isDestroyed()) this.options.parentWindow.show();
      return;
    }
    if (message.operation === 'open-url') {
      const url = new URL(message.url);
      if (url.protocol !== 'https:' || url.username || url.password || typeof this.options.openExternal !== 'function')
        throw failure('UNSUPPORTED_EXTERNAL_URL', 'No approved external URL handler is available');
      if (!this.watermarkApproved || this.policyPending.has('watermark'))
        throw failure('MEETING_POLICY_NOT_CONFIGURED', 'External meeting content requires an authoritative watermark policy');
      await this.callPage('watermark.ensure', { scope: 'popup' });
      this.requireMediaOwner(owner, window);
      if (this.retiring || this.loggingOut)
        throw failure('SESSION_LOGOUT_IN_PROGRESS', 'The external-content request belongs to a retiring owner');
      return this.options.openExternal(url.href);
    }
    throw failure('UNKNOWN_HOST_OPERATION', 'Unknown meeting host operation');
  }

  cancelScreenStart() {
    ++this.screenCancellationEpoch;
    this.selectedSource = null;
    this.outputRequest = null;
    for (const selection of this.captureSelections) selection.abort();
  }

  async runUnprotectedDialog(action, { signal, cancellationCode = 'DIALOG_CANCELLED' } = {}) {
    if (signal?.aborted) throw failure(cancellationCode, 'The dialog operation was cancelled');
    if (!this.watermarkApproved || this.policyPending.has('watermark') || this.retiring || this.disposed)
      throw failure('MEETING_POLICY_NOT_CONFIGURED', 'A current authoritative policy is required before opening host UI');
    if (this.watermarkConfiguration?.content)
      throw failure('WATERMARK_NATIVE_UI_UNAVAILABLE', 'Required watermarking cannot be enforced on native or externally owned dialogs');
    const epoch = this.policyEpoch;
    const intent = this.policyIntents.watermark;
    const window = this.window;
    const scope = await this.callPage('watermark.ensure', { scope: 'native-ui' });
    if (signal?.aborted) throw failure(cancellationCode, 'The dialog operation was cancelled');
    if (!scope || scope.ready !== true || scope.enabled !== false ||
        epoch !== this.policyEpoch || intent !== this.policyIntents.watermark ||
        window !== this.window || this.retiring || this.disposed)
      throw failure('POLICY_REQUEST_RETIRED', 'The host-dialog policy changed before display');
    ++this.nativeUiCount;
    try {
      const result = await action();
      if (signal?.aborted) throw failure(cancellationCode, 'The dialog operation was cancelled');
      if (epoch !== this.policyEpoch || intent !== this.policyIntents.watermark ||
          window !== this.window || this.retiring || this.disposed)
        throw failure('POLICY_REQUEST_RETIRED', 'A retired dialog cannot authorize a later operation');
      return result;
    } finally {
      --this.nativeUiCount;
    }
  }

  hasOutputMonitorRoute() {
    return process.platform === 'linux' && typeof this.session?.setDisplayMediaRequestHandler === 'function';
  }

  async requireScreenGrant() {
    const owner = this.mediaOwner;
    const window = this.window;
    if (!this.ready || this.disposed || this.retiring || this.loggingOut)
      throw failure('APP_SCREEN_SHARE_DENIED', 'Screen capture requires an active meeting');
    const p = await this.callPage('screen.permission');
    this.requireMediaOwner(owner, window);
    if (!p?.joined || p.allowed !== true || p.providerAndApp !== 'allowed' ||
        !p.sessionKey || p.sessionKey !== p.grantSessionKey)
      throw failure('APP_SCREEN_SHARE_DENIED', 'This meeting has not authorized screen capture');
    await this.ensureMeetingPolicies();
    this.requireMediaOwner(owner, window);
    return p.sessionKey;
  }

  async selectOutputCapture(request) {
    const ticket = this.outputRequest;
    const valid = () => this.shareAudioEnabled && this.outputRequest === ticket &&
      this.window === ticket.window && !ticket.window.isDestroyed() && !this.disposed && !this.retiring &&
      request.frame === ticket.window.webContents.mainFrame && originOf(request.frame.url) === this.mediaOrigin;
    if (!ticket || ticket.used || !request.userGesture || !request.videoRequested || !request.audioRequested ||
        originOf(request.securityOrigin) !== this.mediaOrigin || !valid())
      throw failure('CAPTURE_CANCELLED', 'No authorized computer-sound request');
    ticket.used = true;
    const source = await this.captureSources(['screen', 'window'], ticket.sessionKey, true);
    if (!valid()) throw failure('CAPTURE_CANCELLED', 'The computer-sound request was retired');
    // The PulseAudio protocol (including pipewire-pulse) resolves this to the
    // default sink's monitor, never to the default microphone.
    return { video: source, audio: { id: '@DEFAULT_MONITOR@', name: 'Computer sound (default output)' } };
  }

  async configureRecordingTip(enabled) {
    if (typeof enabled !== 'boolean') throw failure('INVALID_ARGUMENT', 'Recording confirmation must be a boolean');
    const revision = ++this.recordTipRevision;
    await this.initialize();
    const window = this.window;
    const current = () => revision === this.recordTipRevision && this.window === window && window &&
      !window.isDestroyed() && this.ready && !this.retiring && !this.disposed && !this.loggingOut;
    if (!current()) throw failure('RECORDING_TIP_RETIRED', 'Recording confirmation belongs to a retired owner');
    const receipt = await this.callPage('recordTip.configure', { enabled });
    if (!current() || receipt?.configured !== true || receipt.enabled !== enabled ||
        receipt.scope !== 'local-recording-confirmation' || receipt.grantsRecording !== false)
      throw failure('RECORDING_TIP_UNCONFIRMED', 'The active meeting page did not apply recording confirmation');
    this.recordTipEnabled = enabled;
    return receipt;
  }
  nativeCapabilityEnabled(type) {
    return this.nativeCapabilityConfiguration.get(type) !== false;
  }

  async configureNativeCapability(params) {
    const { type, isEnable, definition } = nativeCapabilityContract.validate(params);
    if (this.disposed || this.retiring || this.loggingOut)
      throw failure('CAPABILITY_OWNER_RETIRED', 'The capability owner is retiring');
    if (type === 7) return this.configureAnonymousVoiceCapability(isEnable);
    if (type === 12) {
      const provider = this.options.getComplaints?.();
      if (!provider) throw nativeCapabilityContract.unavailable(type, isEnable);
      return provider.configure(isEnable);
    }
    if (type === 13) {
      if (!this.p2pMini) throw nativeCapabilityContract.unavailable(type, isEnable);
      return this.p2pMini.configure(isEnable);
    }
    if (this.offline?.active) {
      if (![0, 2, 3, 4].includes(type)) throw nativeCapabilityContract.unavailable(type, isEnable);
      const receipt = await this.offline.configureCapability(type, isEnable);
      return { ...receipt, capability: definition.capability, scope: definition.scope };
    }
    const owner = this.mediaOwner;
    const revision = (this.nativeCapabilityRevisions.get(type) || 0) + 1;
    this.nativeCapabilityRevisions.set(type, revision);
    // Revocation is immediate, including an open recording file/consent dialog.
    // Enabling is persisted only after the active renderer confirms enforcement.
    if (!isEnable) {
      if (type !== 3) this.nativeCapabilityConfiguration.set(type, false);
      if (type === 6) {
        ++this.recordingCancellationEpoch;
        this.cancelRecordingAuthorization();
      }
      if (type === 9) for (const controller of this.recordingPermissionPrompts) controller.abort();
      if (type === 1) for (const request of this.invitedCaptureRequests.values()) request.controller.abort();
    }
    await this.initialize();
    const window = this.window;
    const current = () => this.nativeCapabilityRevisions.get(type) === revision && this.mediaOwner === owner &&
      !owner.retired && this.window === window && window && !window.isDestroyed() &&
      !!this.ready && !this.disposed && !this.retiring && !this.loggingOut;
    if (!current()) throw failure('CAPABILITY_OWNER_RETIRED', 'Capability configuration belongs to a retired owner');
    let receipt;
    if (type === 10) {
      const background = await this.configureCustomBackground(isEnable);
      receipt = { ...background, type, capability: definition.capability, serverPermissionGranted: false,
        osPermissionGranted: false, serverCapabilityAcknowledged: false };
    } else receipt = await this.callPage('capability.configure', { type, isEnable });
    if (!current()) throw failure('CAPABILITY_CONFIGURATION_SUPERSEDED', 'A later capability change or owner retirement superseded this request');
    if (receipt?.configured !== true || receipt.type !== type || receipt.enabled !== isEnable ||
        receipt.capability !== definition.capability || receipt.scope !== definition.scope ||
        receipt.serverPermissionGranted !== false || receipt.osPermissionGranted !== false)
      throw failure('CAPABILITY_ENFORCEMENT_UNCONFIRMED', 'The real capability consumers did not confirm enforcement');
    // Microphone consent belongs to the room and device, never the replay journal.
    if (type !== 3) this.nativeCapabilityConfiguration.set(type, isEnable);
    return receipt;
  }


  configureShareAudio(enabled) {
    if (typeof enabled !== 'boolean') throw failure('INVALID_ARGUMENT', 'enabled must be a boolean');
    this.shareAudioEnabled = enabled;
    if (!enabled && this.outputRequest) this.cancelScreenStart();
    return { configured: true, enabled, scope: 'local-share-audio-ui',
      serverPermissionGranted: false, osPermissionGranted: false };
  }

  async captureSources(types, sessionKey, systemAudio, signal) {
    if (!Array.isArray(types) || types.some(type => type !== 'screen' && type !== 'window'))
      throw failure('INVALID_CAPTURE_TYPES', 'Invalid screen-capture source types');
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal) {
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    }
    const epoch = this.policyEpoch, intent = this.policyIntents.watermark;
    let cancel;
    const cancelled = new Promise((resolve, reject) => {
      cancel = () => reject(failure('CAPTURE_CANCELLED', 'Screen source selection was cancelled'));
      controller.signal.addEventListener('abort', cancel, { once: true });
    });
    this.captureSelections.add(controller);
    let id = this.selectedSource;
    try {
      if (controller.signal.aborted) throw failure('CAPTURE_CANCELLED', 'The capture attempt was revoked before source enumeration');
      const sources = await Promise.race([
        this.electron.desktopCapturer.getSources({ types, thumbnailSize: { width: 0, height: 0 } }), cancelled
      ]);
      if (!id || systemAudio) {
        const protectedPicker = !!this.watermarkConfiguration?.content;
        const choose = protectedPicker ? this.options.selectProtectedDesktopSource : this.options.selectDesktopSource;
        if (typeof choose !== 'function')
          throw failure('SOURCE_SELECTION_REQUIRED', 'A policy-compatible source picker is required');
        const offered = sources.filter(source => !id || source.id === id).map(source =>
          ({ id: source.id, name: source.name, displayId: source.display_id }));
        const ask = () => choose(offered, { signal: controller.signal, systemAudio,
          watermark: protectedPicker ? this.watermarkConfiguration : null });
        id = await Promise.race([protectedPicker ? ask() : this.runUnprotectedDialog(ask,
          { signal: controller.signal, cancellationCode: 'CAPTURE_CANCELLED' }), cancelled]);
      }
      if (!id || controller.signal.aborted || sessionKey !== await this.requireScreenGrant() ||
          controller.signal.aborted || epoch !== this.policyEpoch || intent !== this.policyIntents.watermark)
        throw failure('CAPTURE_CANCELLED', 'The source selection was cancelled or its meeting changed');
      const selected = sources.find(source => source.id === id);
      if (!selected) throw failure('CAPTURE_CANCELLED', 'No real screen source was selected');
      return { id: selected.id, name: selected.name, display_id: selected.display_id };
    } finally {
      if (signal) signal.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', cancel);
      this.captureSelections.delete(controller);
    }
  }

  async promptRecordingPermission(data) {
    if (!this.nativeCapabilityEnabled(9))
      throw failure('NATIVE_CAPABILITY_DISABLED', 'Local-recording permission requests are disabled');
    if (!data || typeof data !== 'object' || Array.isArray(data) ||
        typeof data.requestId !== 'string' || !data.requestId ||
        typeof data.participantId !== 'string' || !data.participantId ||
        !((typeof data.conferenceID === 'string' && data.conferenceID.length > 0) ||
          (Number.isSafeInteger(data.conferenceID) && data.conferenceID > 0)) ||
        (data.name !== undefined && typeof data.name !== 'string'))
      throw failure('INVALID_RECORDING_PERMISSION_REQUEST', 'A verified participant recording request is required');
    const window = this.window;
    if (!window || window.isDestroyed() || originOf(window.webContents.getURL()) !== this.mediaOrigin)
      throw failure('ENGINE_NOT_READY', 'The genuine meeting window is absent');
    const controller = new AbortController();
    this.recordingPermissionPrompts.add(controller);
    const request = { requestId: data.requestId, participantId: data.participantId,
      conferenceID: data.conferenceID, signal: controller.signal };
    if (data.name !== undefined) request.name = data.name;
    try {
      let allowed;
      if (typeof this.options.confirmRecordingPermission === 'function') {
        allowed = await this.runUnprotectedDialog(() => this.options.confirmRecordingPermission(request)) === true;
      } else {
        const detail = [`Participant: ${JSON.stringify(request.participantId)}`,
          `Meeting: ${JSON.stringify(request.conferenceID)}`];
        if (request.name !== undefined) detail.push(`Name: ${JSON.stringify(request.name)}`);
        const result = await this.runUnprotectedDialog(() => this.electron.dialog.showMessageBox(window, {
          type: 'question', title: 'Local recording permission',
          message: 'Allow this participant to record the conference locally?',
          detail: detail.join('\n'), buttons: ['Deny', 'Allow recording'],
          defaultId: 0, cancelId: 0, noLink: true, signal: controller.signal
        }));
        allowed = result.response === 1;
      }
      // Only the user's current decision; the controller still checks role and
      // session and waits for real server state before granting recording.
      return !controller.signal.aborted && this.nativeCapabilityEnabled(9) && allowed === true &&
        this.window === window && !window.isDestroyed() && originOf(window.webContents.getURL()) === this.mediaOrigin;
    } finally { this.recordingPermissionPrompts.delete(controller); }
  }

  publicRecordingReceipt(receipt) {
    return { handleId: receipt.handleId, bytesWritten: receipt.bytesWritten,
      mimeType: receipt.mimeType, extension: receipt.extension };
  }

  recordingResult(data) {
    if (!data || typeof data !== 'object' || !data.receipt) return data;
    const receipt = this.recordingReceipts.get(data.receipt.handleId);
    if (!receipt) throw failure('INVALID_RECORDING_RECEIPT', 'The recording receipt does not identify a completed file');
    // Only main-to-parent RPC/events use this helper. File IPC returns the
    // path-free receipt above, and inbound page receipt fields are not trusted.
    return { ...data, receipt: { ...receipt } };
  }

  reportRecordingFailure(error) {
    this.emit('event', { protocol: PROTOCOL, instance: this.instance, event: 'recording-state',
      data: { state: 'error', error: { code: error.code || 'RECORDING_FILE_FAILED',
        message: 'Recording output cleanup failed' } } });
  }

  cancelRecordingAuthorization() {
    const request = this.recordingStart;
    if (request) {
      request.cancelled = true;
      request.authorized = false;
      request.controller.abort();
    }
  }

  async startRecording(params, epoch) {
    if (epoch !== this.recordingCancellationEpoch)
      throw failure('RECORDING_CANCELLED', 'The queued recording start was cancelled');
    if (this.recordingStart || this.recordingFiles.size)
      throw failure('RECORDING_ACTIVE', 'A recording output is already active');
    const request = { requestId: crypto.randomBytes(16).toString('hex'),
      controller: new AbortController(), authorized: true, cancelled: false,
      openUsed: false, openPromise: null, entry: null, window: this.window };
    this.recordingStart = request;
    this.recordingRequests.set(request.requestId, request);
    try {
      const result = await this.callPage('recording.start', { ...params, requestId: request.requestId });
      if (request.cancelled) throw failure('RECORDING_CANCELLED', 'Recording start was cancelled');
      if (!request.entry)
        throw failure('RECORDING_SINK_NOT_OPEN', 'The recording runtime did not open an authorized output');
      return result;
    } catch (error) {
      try { await this.abortRecordingFile({ requestId: request.requestId }); }
      catch (cleanupError) { this.reportRecordingFailure(cleanupError); }
      throw error;
    } finally {
      request.authorized = false;
      if (this.recordingStart === request) this.recordingStart = null;
      if (!request.entry || request.entry.state === 'aborted' || request.entry.state === 'closed')
        this.recordingRequests.delete(request.requestId);
    }
  }

  openRecordingFile({ requestId, mimeType, extension }) {
    const request = this.recordingRequests.get(requestId);
    if (!request || request !== this.recordingStart || !request.authorized ||
        request.cancelled || request.window !== this.window || request.openUsed)
      throw failure('RECORDING_NOT_AUTHORIZED', 'No trusted recording start authorizes this output');
    if (typeof mimeType !== 'string' || !/^(audio|video)\/[A-Za-z0-9.+-]+(?:[ \t]*;[^\r\n\0]+)?$/.test(mimeType) ||
        typeof extension !== 'string' || !/^\.?[a-zA-Z0-9]{1,10}$/.test(extension))
      throw failure('INVALID_RECORDING_FORMAT', 'The recording format is invalid');
    request.openUsed = true;
    request.openPromise = this.createRecordingFile(request, mimeType, extension);
    return request.openPromise;
  }

  async chooseRecordingDestination(request, mimeType, extension) {
    const signal = request.controller.signal;
    let cancel;
    const cancelled = new Promise((resolve, reject) => {
      cancel = () => reject(failure('RECORDING_CANCELLED', 'Recording destination selection was cancelled'));
      if (signal.aborted) cancel();
      else signal.addEventListener('abort', cancel, { once: true });
    });
    try {
      const suffix = extension.replace(/^\./, '');
      const choice = this.runUnprotectedDialog(() => typeof this.options.chooseRecordingFile === 'function' ?
        this.options.chooseRecordingFile({ requestId: request.requestId, mimeType, extension, signal }) :
        this.electron.dialog.showSaveDialog(request.window, {
          title: 'Save conference recording', defaultPath: `meeting-recording.${suffix}`,
          filters: [{ name: 'Recording', extensions: [suffix] }]
        }), { signal, cancellationCode: 'RECORDING_CANCELLED' });
      const selected = await Promise.race([choice, cancelled]);
      if (signal.aborted || request.cancelled)
        throw failure('RECORDING_CANCELLED', 'Recording destination selection was cancelled');
      const selectedPath = typeof selected === 'string' ? selected :
        selected && !selected.canceled ? selected.filePath : null;
      if (!selectedPath) throw failure('RECORDING_CANCELLED', 'No recording destination was selected');
      if (typeof selectedPath !== 'string' || !path.isAbsolute(selectedPath))
        throw failure('INVALID_RECORDING_DESTINATION', 'The selected recording destination must be an absolute path');
      return selectedPath;
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }

  async createRecordingFile(request, mimeType, extension) {
    try {
      const selectedPath = await this.chooseRecordingDestination(request, mimeType, extension);
      if (request.cancelled || !request.authorized || this.disposed || this.window !== request.window)
        throw failure('RECORDING_CANCELLED', 'Recording output authorization was cancelled');
      // Exclusive creation is mandatory even if the native dialog offered to
      // overwrite an existing file. No alternate-name retry or truncation.
      const file = await fs.promises.open(selectedPath, 'wx', 0o600);
      const entry = { handleId: crypto.randomBytes(16).toString('hex'), requestId: request.requestId,
        path: selectedPath, mimeType, extension, file, dev: null, ino: null,
        bytesWritten: 0, nextSequence: 0, state: 'opening', error: null,
        tail: Promise.resolve(), closePromise: null, abortPromise: null, abortRequested: false };
      request.entry = entry;
      this.recordingFiles.set(entry.handleId, entry);
      const stat = await file.stat({ bigint: true });
      entry.dev = stat.dev;
      entry.ino = stat.ino;
      if (!stat.isFile()) throw failure('INVALID_RECORDING_DESTINATION', 'The recording output is not a regular file');
      if (request.cancelled || !request.authorized || this.disposed || this.window !== request.window)
        throw failure('RECORDING_CANCELLED', 'Recording output authorization was cancelled');
      entry.state = 'open';
      return { handleId: entry.handleId };
    } catch (error) {
      if (request.entry) {
        try { await this.discardRecordingFile(request.entry); }
        catch (cleanupError) { this.reportRecordingFailure(cleanupError); }
      }
      throw error;
    }
  }

  queueRecordingIO(entry, work) {
    const task = entry.tail.then(work);
    entry.tail = task.catch(error => { if (!entry.error) entry.error = error; });
    return task;
  }

  writeRecordingFile({ handleId, sequence, chunk }) {
    const entry = this.recordingFiles.get(handleId);
    if (!entry || entry.state !== 'open' || entry.abortRequested)
      throw failure('RECORDING_NOT_OPEN', 'The recording output is not open for writes');
    if (!Number.isSafeInteger(sequence) || sequence !== entry.nextSequence)
      throw failure('RECORDING_SEQUENCE_MISMATCH', 'Recording chunks must arrive in sequence');
    if (!(chunk instanceof ArrayBuffer) || chunk.byteLength === 0)
      throw failure('INVALID_RECORDING_CHUNK', 'Recording chunks must be nonempty ArrayBuffers');
    if (entry.error) throw entry.error;
    const buffer = Buffer.from(chunk);
    ++entry.nextSequence;
    return this.queueRecordingIO(entry, async () => {
      if (entry.error) throw entry.error;
      let written = 0;
      while (written < buffer.length) {
        if (entry.abortRequested) throw failure('RECORDING_CANCELLED', 'Recording output was aborted');
        const remaining = buffer.length - written;
        const result = await entry.file.write(buffer, written, remaining, null);
        if (!Number.isInteger(result.bytesWritten) || result.bytesWritten <= 0 || result.bytesWritten > remaining)
          throw failure('RECORDING_WRITE_FAILED', 'The recording file write did not make valid progress');
        written += result.bytesWritten;
        entry.bytesWritten += result.bytesWritten;
      }
      return { handleId, sequence, bytesWritten: written };
    });
  }

  async closeRecordingFile({ handleId }) {
    const completed = this.recordingReceipts.get(handleId);
    if (completed) return this.publicRecordingReceipt(completed);
    const entry = this.recordingFiles.get(handleId);
    if (!entry || entry.abortRequested)
      throw failure('RECORDING_NOT_OPEN', 'The recording output cannot be closed');
    if (entry.closePromise) return entry.closePromise;
    if (entry.state !== 'open') throw failure('RECORDING_NOT_OPEN', 'The recording output cannot be closed');
    entry.state = 'closing';
    entry.closePromise = this.queueRecordingIO(entry, async () => {
      if (entry.error) throw entry.error;
      if (entry.abortRequested) throw failure('RECORDING_CANCELLED', 'Recording output was aborted');
      await entry.file.sync();
      await entry.file.close();
      entry.file = null;
      const stat = await fs.promises.lstat(entry.path, { bigint: true });
      if (stat.dev !== entry.dev || stat.ino !== entry.ino)
        throw failure('RECORDING_FILE_REPLACED', 'The selected recording file was replaced');
      if (entry.abortRequested) throw failure('RECORDING_CANCELLED', 'Recording output was aborted');
      const receipt = this.publicRecordingReceipt(entry);
      this.recordingReceipts.set(handleId, { ...receipt, path: entry.path });
      entry.state = 'closed';
      this.recordingFiles.delete(handleId);
      this.recordingRequests.delete(entry.requestId);
      return receipt;
    }).catch(async error => {
      try { await this.discardRecordingFile(entry); }
      catch (cleanupError) { this.reportRecordingFailure(cleanupError); }
      throw error;
    });
    return entry.closePromise;
  }

  discardRecordingFile(entry) {
    if (entry.state === 'closed') return Promise.resolve({ handleId: entry.handleId, aborted: false });
    if (entry.state === 'aborted') return Promise.resolve(entry.abortReceipt);
    if (entry.abortPromise) return entry.abortPromise;
    entry.abortRequested = true;
    entry.state = 'aborting';
    entry.abortPromise = (async () => {
      await entry.tail;
      if (entry.file) {
        await entry.file.close();
        entry.file = null;
      }
      let removed = false;
      if (entry.dev !== null && entry.ino !== null) {
        try {
          const stat = await fs.promises.lstat(entry.path, { bigint: true });
          // Never unlink a replacement file/symlink at the user's chosen path.
          if (stat.dev === entry.dev && stat.ino === entry.ino) {
            await fs.promises.unlink(entry.path);
            removed = true;
          }
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      entry.state = 'aborted';
      this.recordingFiles.delete(entry.handleId);
      this.recordingRequests.delete(entry.requestId);
      entry.abortReceipt = { handleId: entry.handleId, aborted: true, removed, bytesWritten: entry.bytesWritten };
      return entry.abortReceipt;
    })().catch(error => {
      entry.state = 'failed';
      entry.abortPromise = null;
      throw error;
    });
    return entry.abortPromise;
  }

  async abortRecordingFile({ requestId, handleId }) {
    if (typeof requestId !== 'string' && typeof handleId !== 'string')
      throw failure('INVALID_RECORDING_ABORT', 'A recording request or handle is required');
    let request = typeof requestId === 'string' ? this.recordingRequests.get(requestId) : null;
    let entry = typeof handleId === 'string' ? this.recordingFiles.get(handleId) : null;
    if (entry && requestId !== undefined && entry.requestId !== requestId)
      throw failure('INVALID_RECORDING_ABORT', 'Recording request and handle do not match');
    if (!request && entry) request = this.recordingRequests.get(entry.requestId);
    if (request) {
      request.cancelled = true;
      request.authorized = false;
      request.controller.abort();
      // Picker cancellation settles promptly. If exclusive open was already
      // in flight, wait for its descriptor/identity so a late file is cleaned.
      if (request.openPromise) await request.openPromise.catch(() => {});
      entry = entry || request.entry;
      if (handleId !== undefined && entry && entry.handleId !== handleId)
        throw failure('INVALID_RECORDING_ABORT', 'Recording request and handle do not match');
      if (!entry) {
        this.recordingRequests.delete(request.requestId);
        return { requestId: request.requestId, aborted: true };
      }
    }
    if (entry) return this.discardRecordingFile(entry);
    return { ...(requestId === undefined ? {} : { requestId }),
      ...(handleId === undefined ? {} : { handleId }), aborted: false };
  }

  async stopRecordingForDispose() {
    try {
      return await this.callPage('recording.stop');
    } catch (error) {
      // The real recorder rejects NOT_RECORDING when idle. Disposal may proceed
      // only when main also has no pending start or output; no stop/receipt is
      // fabricated, and prior recording, write and status failures still reject.
      if (error.code === 'NOT_RECORDING' && this.recordingStart === null &&
          this.recordingRequests.size === 0 && this.recordingFiles.size === 0) return null;
      throw error;
    }
  }

  async abortRecordingOutputs() {
    this.cancelRecordingAuthorization();
    const results = await Promise.allSettled([...this.recordingRequests.keys()].map(requestId =>
      this.abortRecordingFile({ requestId })));
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  }

  watchBrowserLogouts(session, owner = this.mediaOwner) {
    const { browserTokens, browserWebContents, pendingBrowserLogouts,
      confirmedBrowserLogouts, failedBrowserLogouts } = this;
    const filter = { urls: [owner.origin + TOKEN_PATH + '*'] };
    const matches = details => {
      if (details.method !== 'DELETE') return false;
      try {
        const url = new URL(details.url);
        return url.origin === owner.origin && !url.username && !url.password && url.pathname === TOKEN_PATH;
      } catch (_) { return false; }
    };
    const finish = (id, outcome) => {
      const pending = pendingBrowserLogouts.get(id);
      if (!pending) return;
      pendingBrowserLogouts.delete(id);
      clearTimeout(pending.timer);
      if (outcome.status === 200) {
        confirmedBrowserLogouts.add(pending.token);
        failedBrowserLogouts.delete(pending.token);
      } else failedBrowserLogouts.set(pending.token, outcome);
      pending.resolve(outcome);
    };
    session.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
      if (!matches(details)) return callback({ requestHeaders: details.requestHeaders });
      if (owner.retired) return callback({ cancel: true });
      const headers = details.requestHeaders || {};
      const value = name => {
        const key = Object.keys(headers).find(key => key.toLowerCase() === name);
        const header = key === undefined ? undefined : headers[key];
        return Array.isArray(header) ? header[0] : header;
      };
      const token = value('x-auth-token');
      const access = value('x-access-token');
      // This also prevents the vendor's delayed automatic logout from deleting
      // a token owned by native C. A logout callback is NOT revocation evidence.
      if (this.protectedNativeTokens.has(token) || this.protectedNativeTokens.has(access)) {
        if (validAccessToken(token)) browserTokens.add(token);
        if (this.protectedNativeTokens.has(access)) browserTokens.add(access);
        return callback({ cancel: true });
      }
      if (browserWebContents.has(details.webContentsId) && validAccessToken(token) &&
          !pendingBrowserLogouts.has(details.id)) {
        browserTokens.add(token);
        let resolve;
        const promise = new Promise(done => { resolve = done; });
        const timer = setTimeout(() => finish(details.id, {
          error: failure('BROWSER_LOGOUT_TIMEOUT', 'The observed browser token DELETE timed out')
        }), 45000);
        pendingBrowserLogouts.set(details.id, { token, promise, resolve, timer });
      }
      callback({ requestHeaders: details.requestHeaders });
    });
    session.webRequest.onCompleted(filter, details => {
      if (matches(details)) finish(details.id, { status: details.statusCode });
    });
    session.webRequest.onErrorOccurred(filter, details => {
      if (matches(details)) finish(details.id, { error: failure(
        details.error || 'BROWSER_LOGOUT_TRANSPORT_ERROR',
        'The observed browser token DELETE failed: ' + String(details.error || 'transport error')) });
    });
  }

  async readBrowserCredentials() {
    const owner = this.mediaOwner;
    if (!this.window || this.window.isDestroyed()) {
      if (!this.browserInventoryComplete)
        throw failure('BROWSER_CREDENTIALS_UNAVAILABLE', 'The closed browser credential inventory could not be confirmed');
      return;
    }
    // Internal-only runtime operation: deliberately absent from OPERATIONS.
    const credentials = await this.callPage('session.credentials');
    this.requireMediaOwner(owner);
    if (!credentials || !Array.isArray(credentials.accessTokens) ||
        credentials.accessTokens.some(token => !validAccessToken(token)))
      throw failure('INVALID_BROWSER_CREDENTIALS', 'The real vendor store returned an invalid credential inventory');
    for (const token of credentials.accessTokens) this.browserTokens.add(token);
    if (validAccessToken(this.webToken)) this.browserTokens.add(this.webToken);
    this.browserInventoryComplete = true;
  }

  async revokeBrowserCredential(token) {
    const owner = this.mediaOwner;
    if (!this.browserTokens.has(token))
      throw failure('BROWSER_TOKEN_UNOWNED', 'Only this media session may revoke its observed browser credentials');
    if (this.protectedNativeTokens.has(token))
      throw failure('NATIVE_TOKEN_OWNED', 'The native owner must revoke its own USG credential');
    if (this.confirmedBrowserLogouts.has(token)) return;
    const pending = [...this.pendingBrowserLogouts.values()].filter(item => item.token === token);
    if (pending.length) await Promise.all(pending.map(item => item.promise));
    this.requireMediaOwner(owner);
    if (this.confirmedBrowserLogouts.has(token)) return;
    const observed = this.failedBrowserLogouts.get(token);
    if (observed) {
      this.failedBrowserLogouts.delete(token);
      if (observed.error) throw observed.error;
      const error = failure(String(observed.status), 'The observed browser token DELETE returned HTTP ' + observed.status);
      error.status = observed.status;
      throw error;
    }
    // Vendor portal logout p(): DELETE /v1/usg/acs/token?timeout=false with
    // X-Auth-Token. Do not use getAccessToken() here or substitute native auth.
    const response = await this.#requestService('DELETE', TOKEN_PATH,
      { query: { timeout: false } }, token, false, owner);
    const data = response.data && typeof response.data === 'object' ? response.data : {};
    const code = data.error_code === undefined ? data.returnCode : data.error_code;
    if (response.status !== 200 || (code !== undefined && code !== 0 && !/^0+$/.test(String(code)))) {
      const error = failure(code === undefined ? String(response.status) : code,
        data.error_msg || data.returnDesc || 'The real token service rejected browser logout');
      error.status = response.status;
      throw error; // In particular, never reinterpret HTTP 401 as success.
    }
    this.confirmedBrowserLogouts.add(token);
  }

  publicLogoutError(error, stage) {
    const redact = value => {
      let text = String(value);
      for (const token of this.browserTokens) text = text.split(token).join('[redacted]');
      for (const token of this.protectedNativeTokens) text = text.split(token).join('[redacted]');
      return text;
    };
    const result = { stage, code: redact(error && error.code !== undefined ? error.code : 'SESSION_LOGOUT_FAILED'),
      message: redact(error && error.message || 'The browser session operation failed') };
    if (error && Number.isInteger(error.status)) result.status = error.status;
    // No request headers, response cookies, raw credential lists or error config.
    return result;
  }

  cancelManagementRequests() {
    ++this.managementCancellationEpoch;
    this.p2p?.retire();
    this.meetingServices.retireCalls();
    if (this.management) this.management.cancel();
    for (const request of this.accountRequests) request.abort();
  }

  async retireIdleBrowserSession(owner = this.mediaOwner, epoch = this.ownerEpoch) {
    this.requireOwnerEpoch(epoch);
    this.requireMediaOwner(owner);
    const window = this.window;
    let closed = false;
    if (window && !window.isDestroyed()) {
      const requireIdle = async () => {
        this.requireOwnerEpoch(epoch);
        this.requireMediaOwner(owner, window);
        if (!this.ready)
          throw failure('ENGINE_NOT_READY', 'The existing media membership cannot be confirmed before replacement');
        const state = await this.callPage('state.get');
        this.requireOwnerEpoch(epoch);
        this.requireMediaOwner(owner, window);
        if (!state || typeof state.joined !== 'boolean' || state.ready === false ||
            (state.roomJoined !== undefined && typeof state.roomJoined !== 'boolean') ||
            (state.anonymousJoin != null && (typeof state.anonymousJoin !== 'object' ||
              typeof state.anonymousJoin.pending !== 'boolean')))
          throw failure('INVALID_MEDIA_STATE', 'The genuine meeting runtime did not report a readable membership state');
        if (state.joined || state.roomJoined || state.anonymousJoin?.pending ||
            (state.connection !== undefined && state.connection !== 'DISCONNECTED'))
          throw failure('ALREADY_IN_CONFERENCE', 'The existing meeting became active or pending before session replacement');
        if (this.recordingStart || this.recordingRequests.size || this.recordingFiles.size || this.screenStartPending)
          throw failure('MEDIA_OWNER_BUSY', 'Finish the current media operation before replacing its browser session');
      };
      await requireIdle();
      // Inventory is read-only. Until the final state check succeeds, do not
      // stop voice/recording, revoke tokens, hide/dispose the page, or clear its
      // grants: vendor/UI membership can change independently of this.serial.
      await this.readBrowserCredentials();
      await requireIdle();
      // No cleanup await is allowed between the final idle observation and
      // closing this exact window. All network revocation and storage cleanup
      // run only after the old page can no longer start another membership.
      window.destroy();
      if (!window.isDestroyed())
        throw failure('WINDOW_CLOSE_UNCONFIRMED', 'The idle meeting window did not close');
      closed = true;
    } else if (this.initializing) {
      throw failure('ENGINE_NOT_READY', 'An initializing media owner cannot be replaced without explicit logout');
    }
    this.requireOwnerEpoch(epoch);
    this.requireMediaOwner(owner);
    const report = await this.logoutSession();
    if (closed) report.localCleanup.window = 'closed';
    return report;
  }

  logoutSession(options = {}) {
    if (this.logoutPromise) return this.logoutPromise;
    const task = this.clearBrowserSession(options).finally(() => {
      if (this.logoutPromise === task) this.logoutPromise = null;
    });
    this.logoutPromise = task;
    return task;
  }

  async clearBrowserSession({ screenStop, recordingStop } = {}) {
    this.p2pMini.restore();
    this.p2pMini.enabled = true;
    ++this.recordTipRevision;
    this.recordTipEnabled = true;
    this.cancelManagementRequests();
    ++this.policyEpoch;
    this.retiring = true;
    const errors = [];
    const outcomes = new Map();
    const cleanup = { window: 'absent', storage: 'not-created', cache: 'not-created',
      authCache: 'not-created', connections: 'not-created', recordingFiles: 'pending' };
    let receipt;
    let inventoryFailed = false;
    const run = async (stage, action) => {
      try { return { ok: true, value: await action() }; }
      catch (error) { errors.push(this.publicLogoutError(error, stage)); return { ok: false }; }
    };
    this.loggingOut = true;
    this.cancelScreenStart();
    ++this.recordingCancellationEpoch;
    ++this.voiceRevision;
    this.voiceRequested = false;
    try {
      if (this.offline?.active) await run('offline-retirement', () => this.offline.retire());
      if (this.mediaOwner.anonymous) await run('anonymous-voice-retirement', () => this.anonymousVoice.retire(this.mediaOwner));
      await run('window-hide', () => this.hideMeetingWindow());
      const voice = this.options.getVoiceSession?.();
      if (voice) await run('voice-stop', () => voice.filter.stop());
      if (screenStop) await run('screen-stop', () => screenStop);
      if (recordingStop || (this.window && !this.window.isDestroyed() && this.ready)) {
        const stopped = await run('recording-stop', () => recordingStop || this.stopRecordingForDispose());
        if (stopped.ok && stopped.value && stopped.value.receipt) receipt = stopped.value.receipt;
      }
      const files = await run('recording-output-cleanup', () => this.abortRecordingOutputs());
      cleanup.recordingFiles = files.ok ? 'cleared' : 'failed';
      const beforeLeave = await run('credentials-before-leave', () => this.readBrowserCredentials());
      if (!beforeLeave.ok) inventoryFailed = true;
      if (this.window && !this.window.isDestroyed() && this.ready) {
        const state = await run('conference-state', async () => {
          const current = await this.callPage('state.get');
          if (!current || typeof current.joined !== 'boolean')
            throw failure('INVALID_MEDIA_STATE', 'The genuine meeting runtime did not report its joined state');
          return current;
        });
        if (!state.ok || (state.value && state.value.joined))
          await run('conference-leave', () => this.callPage('conference.leave'));
        await run('media-dispose', () => this.callPage('dispose'));
      }
      // A post-leave snapshot still works after runtime disposal. Re-read after
      // revocations to include actual refreshed tokens, never retry the same token
      // during this operation. Automatic logout is skipped only on observed 200.
      for (;;) {
        const inventory = await run('browser-credentials', () => this.readBrowserCredentials());
        if (!inventory.ok) inventoryFailed = true;
        let processed = false;
        for (const token of this.browserTokens) {
          if (outcomes.has(token)) continue;
          processed = true;
          if (this.protectedNativeTokens.has(token)) {
            outcomes.set(token, 'native-owned');
            continue;
          }
          const revoked = await run('browser-token-delete', () => this.revokeBrowserCredential(token));
          outcomes.set(token, revoked.ok ? 'confirmed' : 'unconfirmed');
        }
        if (!inventory.ok || !processed) break;
      }
    } finally {
      // Local cleanup is unconditional: network failure must not keep a logged-in
      // page or its isolated browser storage alive. It is not server confirmation.
      const window = this.window;
      if (window && !window.isDestroyed()) {
        const closed = await run('window-cleanup', () => {
          window.destroy();
          if (!window.isDestroyed()) throw failure('WINDOW_CLOSE_UNCONFIRMED', 'The meeting window did not close');
        });
        cleanup.window = closed.ok ? 'closed' : 'failed';
      }
      if (this.window && this.window.isDestroyed()) this.window = null;
      this.webToken = '';
      this.userInfo = null;
      this.selectedSource = null;
      this.allowedPermissions.clear();
      if (this.sessionReady) await run('browser-session-ready', () => this.sessionReady);
      if (this.session) {
        const tasks = [['storage', 'clearStorageData'], ['cache', 'clearCache'],
          ['authCache', 'clearAuthCache'], ['connections', 'closeAllConnections']];
        await Promise.all(tasks.map(async ([name, method]) => {
          const cleared = await run(name + '-cleanup', () => this.session[method]());
          cleanup[name] = cleared.ok ? 'cleared' : 'failed';
        }));
      }
      if (this.accountSessionReady) await run('account-session-ready', () => this.accountSessionReady);
      if (this.accountSession) {
        const session = this.accountSession;
        await Promise.all([['accountStorage', 'clearStorageData'], ['accountCache', 'clearCache'],
          ['accountAuthCache', 'clearAuthCache'], ['accountConnections', 'closeAllConnections']]
          .map(async ([name, method]) => {
            const cleared = await run(name + '-cleanup', () => session[method]());
            cleanup[name] = cleared.ok ? 'cleared' : 'failed';
          }));
        this.accountSession = null;
        this.accountSessionReady = null;
      }
      // Include terminal HTTP outcomes from an automatic logout that raced the
      // final snapshot. Each observer has its own finite timeout; no retry occurs.
      await Promise.all([...this.pendingBrowserLogouts.values()].map(item => item.promise));
      this.loggingOut = false;
      this.retiring = this.disposeRequested || this.logoutRequests > 0;
      this.engineUnavailable('session-logout');
    }
    let revoked = 0, protectedNative = 0, unconfirmed = 0;
    for (const token of this.browserTokens) {
      if (this.protectedNativeTokens.has(token)) ++protectedNative;
      else if (outcomes.get(token) === 'confirmed') ++revoked;
      else if (!outcomes.has(token) && this.confirmedBrowserLogouts.has(token)) ++revoked;
      else ++unconfirmed;
    }
    if (inventoryFailed) this.browserInventoryComplete = false;
    const inventoryConfirmed = this.browserInventoryComplete && !inventoryFailed;
    const status = unconfirmed || !inventoryConfirmed ? 'unconfirmed' : protectedNative ? 'native-owned' :
      revoked ? 'confirmed' : 'not-required';
    if (unconfirmed && !errors.some(error => error.stage === 'browser-token-delete'))
      errors.push({ stage: 'browser-token-delete', code: 'BROWSER_LOGOUT_UNCONFIRMED',
        message: 'Not every observed browser credential has a confirmed token DELETE' });
    const report = { localCleanup: cleanup, localCleanupComplete: !Object.values(cleanup).includes('failed'),
      serverLogout: { status, confirmed: status === 'confirmed', credentials: this.browserTokens.size,
        revoked, protectedNative, unconfirmed, inventoryConfirmed },
      ...(receipt ? { receipt } : {}), errors };
    if (!this.window || this.window.isDestroyed()) this.resetMediaSite();
    else {
      // A window which refused destruction cannot authorize a new media owner.
      this.mediaOwner.retired = true;
      this.retiring = true;
    }
    return report;
  }

  async nativeAccessToken() {
    if (this.disposed) throw failure('DISPOSED', 'The meeting bridge was disposed');
    const epoch = this.managementCancellationEpoch;
    if (this.retiring || this.loggingOut)
      throw failure('MANAGEMENT_REQUEST_ABORTED', 'The account request belongs to a retiring owner');
    if (typeof this.options.getAccessToken !== 'function')
      throw failure('AUTH_PROVIDER_MISSING', 'The native USG authentication provider is not connected');
    const token = await this.options.getAccessToken();
    if (!validAccessToken(token)) throw failure('AUTH_REQUIRED', 'A genuine raw USG access token is required');
    this.protectedNativeTokens.add(token);
    if (this.disposed || this.retiring || this.loggingOut || epoch !== this.managementCancellationEpoch)
      throw failure('MANAGEMENT_REQUEST_ABORTED', 'The native token request was retired');
    if (this.mediaOrigin !== this.origin && this.browserTokens.has(token))
      throw failure('NATIVE_TOKEN_OWNED', 'A guest credential collides with the native account credential');
    return token;
  }

  async requestMeetingService(method, servicePath, options = {}) {
    const epoch = this.managementCancellationEpoch;
    const token = await this.nativeAccessToken();
    if (epoch !== this.managementCancellationEpoch)
      throw failure('MANAGEMENT_REQUEST_ABORTED', 'The account changed while obtaining its access token');
    return this.requestAuthenticatedService(method, servicePath, options, token);
  }

  requestAuthenticatedService(method, servicePath, options, token, accessTokenHeader = true) {
    if (!this.protectedNativeTokens.has(token))
      return Promise.reject(failure('AUTH_REQUIRED', 'Only a native-owned token may use the account HTTP transport'));
    return this.#requestService(method, servicePath, options, token, accessTokenHeader, null);
  }

  async #requestService(method, servicePath, { body, query, headers } = {}, token, accessTokenHeader, owner) {
    if (this.disposed) throw failure('DISPOSED', 'The meeting bridge was disposed');
    const epoch = this.managementCancellationEpoch;
    if (owner) {
      this.requireMediaOwner(owner);
      if (method !== 'DELETE' || servicePath !== TOKEN_PATH || accessTokenHeader || !this.browserTokens.has(token))
        throw failure('BROWSER_TOKEN_UNOWNED', 'Browser credentials may only be revoked at their owning site');
    } else if (this.retiring || this.loggingOut) {
      throw failure('MANAGEMENT_REQUEST_ABORTED', 'The account HTTP request belongs to a retiring owner');
    }
    const authority = owner ? owner.origin : this.origin;
    if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method))
      throw failure('INVALID_SERVICE_METHOD', 'Unsupported meeting service method');
    if (typeof servicePath !== 'string' || !servicePath.startsWith('/') ||
        servicePath.startsWith('//') || /[?#\\]/.test(servicePath))
      throw failure('INVALID_SERVICE_PATH', 'A relative meeting service path is required');
    const endpoint = new URL(servicePath, authority);
    if (endpoint.origin !== authority || endpoint.username || endpoint.password)
      throw failure('INVALID_SERVICE_ORIGIN', 'Meeting service requests cannot leave the trusted origin');
    if (query !== undefined) {
      if (!query || typeof query !== 'object' || Array.isArray(query))
        throw failure('INVALID_SERVICE_QUERY', 'Meeting service query must be an object');
      for (const [name, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue;
        if (!['string', 'number', 'boolean'].includes(typeof value))
          throw failure('INVALID_SERVICE_QUERY', 'Meeting service query values must be scalar');
        endpoint.searchParams.set(name, String(value));
      }
    }
    const serviceHeaders = { 'Content-Type': 'application/json;charset=UTF-8' };
    if (headers !== undefined) {
      if (!headers || typeof headers !== 'object' || Array.isArray(headers))
        throw failure('INVALID_SERVICE_HEADERS', 'Meeting service headers must be an object');
      for (const [name, value] of Object.entries(headers)) {
        if (!SERVICE_HEADERS.has(name.toLowerCase()) || !['string', 'number'].includes(typeof value) ||
            /[\r\n]/.test(String(value)))
          throw failure('INVALID_SERVICE_HEADER', 'Only vendor management metadata headers are accepted');
        serviceHeaders[name] = String(value);
      }
    }
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (!validAccessToken(token))
      throw failure('AUTH_REQUIRED', 'A genuine raw USG access token is required');
    if (method === 'DELETE' && endpoint.pathname === TOKEN_PATH && this.protectedNativeTokens.has(token))
      throw failure('NATIVE_TOKEN_OWNED', 'The native owner must revoke its own USG credential');
    serviceHeaders['X-Auth-Token'] = token;
    if (accessTokenHeader) serviceHeaders['X-Access-Token'] = token; // Portal module 19.
    const session = await (owner ? this.initializeSession() : this.initializeAccountSession());
    if (owner) this.requireMediaOwner(owner);
    else if (epoch !== this.managementCancellationEpoch || this.disposed || this.retiring || this.loggingOut)
      throw failure('MANAGEMENT_REQUEST_ABORTED', 'The account HTTP request was retired before dispatch');
    if (owner && this.protectedNativeTokens.has(token))
      throw failure('NATIVE_TOKEN_OWNED', 'The native owner must revoke its own USG credential');
    return new Promise((resolve, reject) => {
      let settled = false;
      const request = this.electron.net.request({ method, url: endpoint.href,
        session, useSessionCookies: false, redirect: 'error' });
      if (!owner) this.accountRequests.add(request);
      const timer = setTimeout(() => {
        finish(failure('SERVICE_TIMEOUT', 'The genuine meeting service request timed out'));
        request.abort();
      }, 45000);
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!owner) this.accountRequests.delete(request);
        if (!error && (owner ? owner !== this.mediaOwner || owner.retired :
            epoch !== this.managementCancellationEpoch || this.disposed || this.retiring || this.loggingOut))
          error = failure('SERVICE_ABORTED', 'The service reply belongs to a retired owner');
        error ? reject(error) : resolve(result);
      };
      request.on('error', error => finish(error));
      request.on('abort', () => finish(failure('SERVICE_ABORTED', 'The meeting service request was aborted')));
      request.on('response', response => {
        const chunks = [];
        let size = 0;
        response.on('error', error => finish(error));
        response.on('aborted', () => finish(failure('SERVICE_RESPONSE_ABORTED', 'The meeting service response was interrupted')));
        response.on('data', chunk => {
          if (settled) return;
          size += chunk.length;
          if (size > 1024 * 1024) {
            finish(failure('SERVICE_RESPONSE_TOO_LARGE', 'The meeting service returned an oversized response'));
            request.abort();
          } else chunks.push(chunk);
        });
        response.on('end', () => {
          if (settled) return;
          const text = Buffer.concat(chunks, size).toString('utf8');
          let data = text || null;
          if (text) {
            try { data = JSON.parse(text); } catch (_) {
              // Preserve non-JSON error bodies and their actual HTTP status;
              // the service layer rejects malformed successful responses.
            }
          }
          finish(null, { status: response.statusCode, data, headers: response.headers });
        });
      });
      try {
        for (const [name, value] of Object.entries(serviceHeaders)) request.setHeader(name, value);
        if (payload !== undefined) request.write(payload);
        request.end();
      } catch (error) { finish(error); request.abort(); }
    });
  }

  async createJoinNonce() {
    const owner = this.mediaOwner;
    if (owner.origin !== this.origin || this.retiring || this.loggingOut)
      throw failure('ACCOUNT_MEDIA_REQUIRED', 'A native handoff nonce requires the primary media owner');
    // Exact skipnonce endpoint/response consumed by the genuine WebRTC app.
    // create-once-token accessToken is not a join nonce.
    const response = await this.requestMeetingService('POST', '/v1/usg/acs/auth/skipnonce');
    this.requireMediaOwner(owner);
    if (this.retiring || this.loggingOut)
      throw failure('ACCOUNT_MEDIA_REQUIRED', 'The native handoff owner was retired');
    const body = response.data;
    if (response.status !== 200 || !body || typeof body !== 'object' ||
        typeof body.nonce !== 'string' || !body.nonce) {
      const error = failure(body && body.error_code || 'NONCE_EXCHANGE_REJECTED',
        body && body.error_msg || 'The real token service rejected the handoff');
      error.status = response.status;
      error.response = response;
      throw error;
    }
    return body.nonce;
  }

  admitJoin(operation, params) {
    if (!params || typeof params !== 'object' || Array.isArray(params))
      throw failure('INVALID_ARGUMENT', 'A meeting join request is required');
    const signed = operation === 'conference.joinLink';
    const anonymous = operation === 'conference.joinAnonymous';
    if (signed) {
      if (typeof params.random !== 'string' || !params.random ||
          (params.nick_name !== undefined && typeof params.nick_name !== 'string') ||
          (params.confId !== undefined && typeof params.confId !== 'string'))
        throw failure('INVALID_ARGUMENT', 'Signed-link entry requires random and optional nick_name/confId strings');
    } else if (anonymous) {
      if (typeof params.conf_id !== 'string' || !params.conf_id.trim() ||
          typeof params.nick_name !== 'string' || !params.nick_name.trim() ||
          (params.conf_pwd !== undefined && typeof params.conf_pwd !== 'string'))
        throw failure('INVALID_ARGUMENT', 'Anonymous join requires conf_id, nick_name and optional conf_pwd');
    } else if (typeof params.confId !== 'string' || !params.confId ||
        (params.password !== undefined && typeof params.password !== 'string') ||
        (params.name !== undefined && typeof params.name !== 'string')) {
      throw failure('INVALID_JOIN_REQUEST', 'Native account join requires a conference ID and optional password/name strings');
    }
    for (const field of signed || anonymous ? ['isopen_mic', 'isopen_cam'] : ['openMic', 'openCamera']) {
      if (params[field] !== undefined && typeof params[field] !== 'boolean')
        throw failure('INVALID_ARGUMENT', 'Media choices must be explicit booleans');
    }
    requireOnlineLinkVariant(params, false);
    let site;
    if (params.site_url !== undefined) {
      if (typeof params.site_url !== 'string' || !params.site_url || /[\s\\]/.test(params.site_url))
        throw failure('INVALID_LINK_SITE', 'A credential-free HTTPS link site is required');
      try { site = new URL(params.site_url); }
      catch (_) { throw failure('INVALID_LINK_SITE', 'A credential-free HTTPS link site is required'); }
      if (site.protocol !== 'https:' || site.username || site.password || site.hostname.includes('*'))
        throw failure('LINK_ORIGIN_UNAVAILABLE', 'A credential-free HTTPS link site is required');
    }
    // This capability is consumed in main, synchronously, before queueing or
    // touching the current meeting. Neither URI fields nor an async/thenable
    // callback can authorize a site; the issuer owner binds the original params.
    const issued = signed && typeof this.options.takeIssuedGuestSite === 'function' ?
      this.options.takeIssuedGuestSite(params) : null;
    let origin = this.origin;
    if (issued !== null && issued !== undefined) {
      if (typeof issued !== 'string' || originOf(issued) !== issued || !site ||
          site.origin !== issued || site.hostname.includes('*') ||
          typeof params.idPrefix !== 'string' || !params.idPrefix ||
          params.idPrefix === 'null' || params.idPrefix === 'undefined')
        throw failure('INVALID_ISSUED_GUEST_SITE', 'The issuer grant must name this ONLINE prefixed link’s canonical HTTPS origin');
      origin = issued;
    }
    requireOnlineLinkVariant(params, false, origin);
    if (site && site.origin !== origin)
      throw failure('LINK_ORIGIN_UNAVAILABLE', 'Unattested links cannot leave the native account service origin');
    // Retain only the actual page contract. In particular caller-supplied
    // tokens/nonces never ride along with a guest invitation.
    const fields = signed ? ['random', 'nick_name', 'confId', 'idPrefix', 'site_url', 'isOfflineJoin', 'isopen_mic', 'isopen_cam'] :
      anonymous ? ['conf_id', 'nick_name', 'conf_pwd', 'isopen_mic', 'isopen_cam'] :
        ['confId', 'password', 'name', 'openMic', 'openCamera'];
    const request = {};
    for (const field of fields) if (params[field] !== undefined) request[field] = params[field];
    return { origin, params: Object.freeze(request) };
  }

  requireOwnerEpoch(epoch) {
    if (epoch !== this.ownerEpoch || this.disposed || this.retiring || this.loggingOut)
      throw failure('SESSION_LOGOUT_IN_PROGRESS', 'The request belongs to a retired meeting owner');
  }

  requireCleanSessionReport(report) {
    if (report.errors.length || !report.localCleanupComplete || !report.serverLogout.inventoryConfirmed) {
      const first = report.errors[0];
      const error = failure(first ? first.code : 'ANONYMOUS_SESSION_UNAVAILABLE',
        first ? first.message : 'The previous browser authentication could not be cleared');
      if (first && first.status !== undefined) error.status = first.status;
      error.details = report;
      throw error;
    }
  }

  async prepareAnonymousSession(origin = this.origin, epoch = this.ownerEpoch, anonymous = true) {
    this.requireOwnerEpoch(epoch);
    const owner = this.mediaOwner;
    if (this.window || this.session || this.sessionReady || this.browserTokens.size) {
      // Vendor joinFlow uses userPortalToken whenever it exists. A new route
      // alone is not anonymous: revoke at the old site's authority, clear its
      // actual partition, and protect native-owned tokens from browser logout.
      this.requireCleanSessionReport(await this.retireIdleBrowserSession(owner, epoch));
    }
    this.requireOwnerEpoch(epoch);
    if (this.mediaOrigin !== origin) this.resetMediaSite(origin);
    this.mediaOwner.anonymous = anonymous;
    return this.mediaOwner;
  }

  async setScreenPermission(params) {
    if (!params || typeof params.allowed !== 'boolean')
      throw failure('INVALID_ARGUMENT', 'allowed must be boolean');
    if (this.disposed) throw failure('DISPOSED', 'The meeting owner was disposed');
    if (this.retiring || this.loggingOut)
      throw failure('SESSION_LOGOUT_IN_PROGRESS', 'The meeting owner is being retired');
    const epoch = this.policyEpoch;
    if (!this.ready) {
      if (params.allowed || params.sessionKey !== undefined)
        throw failure('CONFERENCE_REQUIRED', 'A positive screen grant requires a live joined session');
      this.screenDenialConfigured = true;
      this.cancelScreenStart();
      return { allowed: false, configured: true, sharing: false, runtimeApplied: false,
        scope: 'host-and-future-runtime-denial', grantsServerPermission: false, grantsOsPermission: false };
    }
    const permission = await this.callPage('screen.permission');
    if (params.sessionKey !== undefined && params.sessionKey !== permission.sessionKey)
      throw failure('CONFERENCE_CHANGED', 'The screen permission belongs to a different meeting session');
    if (epoch !== this.policyEpoch || this.retiring)
      throw failure('POLICY_REQUEST_RETIRED', 'The screen permission owner changed');
    if (!params.allowed) this.cancelScreenStart();
    const result = await this.callPage('screen.setPermission', params.allowed ? { ...params, sessionKey: permission.sessionKey } : params);
    if (epoch !== this.policyEpoch || this.retiring)
      throw failure('POLICY_REQUEST_RETIRED', 'The screen permission owner changed');
    this.screenDenialConfigured = result.allowed === false;
    return { ...result, runtimeApplied: true };
  }

  p2pCapability() {
    return { supported: !!this.p2p, available: !!this.p2p && !this.disposed && !this.retiring,
      mode: 3, startNotification: 63, recordNotification: 33 };
  }

  async startP2p(params) {
    if (!this.p2p) throw failure('P2P_PROVIDER_UNAVAILABLE', 'No native conference account owner');
    const epoch = this.ownerEpoch;
    this.requireOwnerEpoch(epoch);
    if (this.lastMediaState?.joined || this.offline?.active)
      throw failure('ALREADY_IN_CONFERENCE', 'Leave the current conference before starting a call');
    const context = await this.options.getCallContext();
    this.requireOwnerEpoch(epoch);
    try {
      const result = await this.p2p.start(params, context);
      if (result.cancelled) throw Object.assign(failure('CALL_CANCELLED', 'The local call was cancelled before transmission'),
        { details: { callState: result.callState } });
      // CREATECONF includes the chairman password. Return only the native
      // receipt and the public attempt snapshot; never the provider response.
      return { notify: 63, result: result.resultCode, param: { reason: result.resultMsg, reason_code: result.resultCode },
        dialAccepted: !result.callState.cancelRequested, callState: result.callState };
    } catch (error) {
      if (Number.isInteger(error.nativeResultCode))
        throw Object.assign(failure(error.nativeResultCode, ''), { details: error.details });
      throw error;
    }
  }

  async joinP2pCaller(created, context) {
    const epoch = this.ownerEpoch;
    const check = () => {
      this.requireOwnerEpoch(epoch);
      const call = this.p2p.state();
      if (call.attemptId !== context.attemptId || call.conferenceID !== created.conferenceID || call.cancelRequested || call.terminal)
        throw failure('CALL_RETIRED', 'The calling participant no longer owns this admission');
    };
    check();
    if (this.mediaOrigin !== this.origin || this.mediaOwner.anonymous) await this.prepareAnonymousSession(this.origin, epoch, false);
    check(); await this.initialize(); check(); await this.ensureMeetingPolicies(); check();
    await this.callPage('call.p2p.watch', { attemptId: context.attemptId, conferenceID: created.conferenceID });
    check(); const nonce = await this.createJoinNonce(); check();
    const chair = created.conference.passwordEntry?.find(entry => entry.conferenceRole === 'chair');
    await this.showMeetingWindow(); check();
    const joined = await this.callPage('conference.join', { confId: created.conferenceID, password: chair?.password || '',
      name: context.callerInfo.nickname, openCamera: context.isVideo, openMic: true, nonce });
    check();
    if (!joined?.joined || String(joined.conferenceId) !== created.conferenceID || !joined.participantId)
      throw failure('P2P_JOIN_UNCONFIRMED', 'The caller was not admitted to the created conference');
    return joined;
  }

  stopP2pObservation(call) {
    if (this.ready && this.mediaOrigin === this.origin && !this.disposed)
      this.callPage('call.p2p.unwatch', { attemptId: call.attemptId }).catch(() => {});
  }

  retireIncomingP2p() {
    ++this.p2pIncomingEpoch;
    const call = this.p2p?.state();
    if (call?.isCallOut === false) {
      this.stopP2pObservation(call);
      this.p2p.retire();
      this.emit('event', {protocol:PROTOCOL, instance:this.instance, event:'p2p-call-state', data:this.p2p.state()});
    }
  }

  async endP2pConference(id, context) {
    if (this.lastMediaState?.joined && String(this.lastMediaState.conferenceId) === id) {
      await this.callPage(context.isCallOut === false ? 'conference.leave' : 'conference.end');
      return { resultCode: 0, resultMsg: '', endConfirmed: true };
    }
    if (context.isCallOut === false)
      throw failure('CALL_NOT_JOINED', 'A callee cannot terminate the caller conference before admission');
    const end = await this.meetingServices.execute('conference.cancel', { conferenceID: id, type: 1 });
    return { resultCode: end.data?.returnCode ?? 0, resultMsg: end.data?.returnDesc || '', endConfirmed: true };
  }

  // Main-process-only media export; the registered host supplies either the
  // note Save gate or a separate explicit native-X11 live-export consent.
  renderForHost(operation, params = {}) {
    if (!['render.inspect', 'render.capture', 'render.surface.inspect', 'render.surface.open', 'render.surface.frame', 'render.surface.close'].includes(operation))
      return Promise.reject(failure('UNSUPPORTED_OPERATION', 'Unknown internal render operation'));
    if (this.disposed || this.retiring || this.loggingOut)
      return Promise.reject(failure('CONFERENCE_CHANGED', 'The render owner is retiring'));
    if (this.offline?.active) {
      const room = this.offline.active;
      const check = () => {
        if (this.offline.active !== room || !this.offline.state().joined || !room.view?.live())
          throw failure('NOT_IN_CONFERENCE', 'The offline conference is not connected');
        if (operation === 'render.capture' || operation === 'render.surface.inspect' || operation === 'render.surface.open' || operation === 'render.surface.frame' || params.requireCapture === true)
          snapshotPolicy.requireAllowed(room.control.getState().screenshotPolicy);
      };
      check();
      return room.view.request(operation, params).then(reply => { check(); return reply; });
    }
    // Enumeration/capture cannot bootstrap a room, authenticate or open media.
    if (!this.ready || !this.window || this.window.isDestroyed())
      return Promise.reject(failure('NOT_IN_CONFERENCE', 'No initialized conference render window exists'));
    return this.callPage(operation, params);
  }

  renderSurfacesForHost(params) {
    if (!this.renderSurfaceHost)
      this.renderSurfaceHost = new MeetingRenderSurfaceHost({bridge:this, electron:this.electron});
    if (params.action === 'stop') return this.renderSurfaceHost.stop();
    if (params.action === 'inspect') return this.renderSurfaceHost.inspect();
    if (params.action === 'reserve-start') return this.renderSurfaceHost.reserveStart();
    if (params.action === 'start') return this.renderSurfaceHost.start(params.expected, params.reservation);
    return Promise.reject(failure('INVALID_ARGUMENT', 'Unknown native surface control'));
  }

  execute(operation, params = {}) {
    if (!OPERATIONS.has(operation)) return Promise.reject(failure('UNSUPPORTED_OPERATION', 'Unknown meeting operation'));
    if (operation.startsWith('moderation.')) {
      if (this.disposed || this.retiring || this.loggingOut)
        return Promise.reject(failure('MODERATION_SESSION_RETIRED', 'The conference moderation owner is retiring'));
      if (this.offline?.active) {
        if (operation === 'moderation.state') return Promise.resolve(this.offline.moderationState());
        if (operation === 'moderation.microphoneConsent') return this.offline.microphoneConsent(params);
        return this.offline.moderationControl(params);
      }
      if (!this.ready || !this.window || this.window.isDestroyed())
        return Promise.reject(failure('NOT_IN_CONFERENCE', 'No current provider moderation owner exists'));
      const owner = this.mediaOwner, window = this.window;
      return this.callPage(operation, params).then(result => { this.requireMediaOwner(owner, window); return result; });
    }
    if (['conference.leave', 'conference.end', 'session.logout', 'dispose'].includes(operation))
      this.renderSurfaceHost?.stop('RENDER_CONFERENCE_RETIRED').catch(() => {});
    if (operation === 'window.p2pMini.toggle') return this.p2pMini.toggle(params.attemptId);
    if (operation.startsWith('background.')) {
      if (this.disposed || this.retiring || this.loggingOut || !this.ready || !this.window ||
          this.window.isDestroyed() || this.offline?.active)
        return Promise.reject(failure('BACKGROUND_PROVIDER_UNAVAILABLE', 'No current web-meeting background owner'));
      if (operation === 'background.choose') return customBackgroundHost.chooseBackground(this);
      if (operation === 'background.apply' && !this.nativeCapabilityEnabled(10))
        return Promise.reject(failure('NATIVE_CAPABILITY_DISABLED', 'Custom backgrounds are disabled'));
      // Do not bootstrap a room, activate a camera or inherit a queued owner's
      // file selection. The page rechecks the exact live owner and permission.
      return this.callPage(operation, {});
    }
    if ((operation === 'recording.start' && !this.nativeCapabilityEnabled(6)) ||
        (operation === 'recording.requestPermission' && (!this.nativeCapabilityEnabled(6) || !this.nativeCapabilityEnabled(9))))
      return Promise.reject(failure('NATIVE_CAPABILITY_DISABLED', 'The application disabled this local-recording operation'));
    let admission;
    if (['conference.join', 'conference.joinAnonymous', 'conference.joinLink'].includes(operation)) {
      try { admission = this.admitJoin(operation, params); }
      catch (error) { return Promise.reject(error); }
      params = admission.params;
    }
    const requestOwner = this.mediaOwner;
    const ownerEpoch = this.ownerEpoch;
    if (operation === 'conference.joinOffline') {
      if (!this.offline) return Promise.reject(failure('OFFLINE_PROVIDER_MISSING', 'The conference service has no offline configuration'));
      if (this.disposed || this.retiring || this.loggingOut || this.lastMediaState?.joined || this.p2p?.state().pending)
        return Promise.reject(failure('CONFERENCE_BUSY','Another meeting or call owns this session'));
      return this.offline.join(params, this.watermarkApproved ? this.watermarkConfiguration : null,
        () => ownerEpoch === this.ownerEpoch && !this.disposed && !this.retiring && !this.loggingOut);
    }
    if (this.offline?.active) {
      if (operation === 'conference.leave') return this.offline.leave();
      if (operation === 'state.get') return Promise.resolve(this.offline.state());
      if (operation === 'window.show') return this.showMeetingWindow();
      if (operation === 'audio.setEnabled' || operation === 'video.setEnabled')
        return this.offline.setDevice(operation === 'audio.setEnabled' ? 'microphone' : 'camera', params.enabled);
      if (operation === 'devices.list') return this.offline.active.view?.request('devices') ?? Promise.resolve([]);
      if (operation === 'device.select') return this.offline.selectDevice(params);
      if (operation === 'conference.join' || operation === 'conference.joinAnonymous' || operation === 'conference.joinLink')
        return Promise.reject(failure('CONFERENCE_BUSY','Leave the active offline conference first'));
    }
    if ((operation === 'conference.leave' || operation === 'conference.end') && this.p2p?.state().pending) {
      const call = this.p2p.state();
      return this.p2p.cancel(call.attemptId).then(value => {
        if (value.phase === 'end_failed') throw failure(value.error.code, value.error.message);
        return value;
      });
    }
    if (operation === 'call.p2p.start') return this.startP2p(params);
    if (operation === 'call.p2p.cancel') {
      if (!this.p2p || this.retiring || this.disposed) return Promise.reject(failure('CALL_RETIRED', 'No current call owner'));
      return this.p2p.cancel(params.attemptId);
    }
    if (operation === 'call.outbound.state') {
      if (typeof params.callRequestId !== 'string' || !params.callRequestId)
        return Promise.reject(failure('INVALID_ARGUMENT', 'The requesting dial window must identify itself'));
      const direct = this.p2p?.getState(params.callRequestId);
      return direct?.attemptId ? Promise.resolve(direct) : this.meetingServices.execute('call.ctd.state', params);
    }
    if (operation === 'call.ctd.start') {
      // Let same-tick retirement win, but never queue a second dial behind the first call's result.
      const epoch = this.managementCancellationEpoch;
      return Promise.resolve().then(() => {
        if (epoch !== this.managementCancellationEpoch || this.retiring || this.loggingOut || this.disposed)
          throw failure('MANAGEMENT_REQUEST_ABORTED', 'The outbound call owner has retired');
        return this.meetingServices.execute(operation, params);
      });
    }
    if (operation === 'call.ctd.state' || operation === 'call.ctd.cancel') {
      if (this.retiring || this.disposed || this.loggingOut)
        return Promise.reject(failure('SESSION_CHANGED', 'The outbound call owner has retired'));
      return this.meetingServices.execute(operation, params);
    }
    if (operation === 'capabilities.get') return Promise.resolve({
      disposed: this.disposed, mediaReady: !!this.ready, p2pCall: this.p2pCapability(),
      managementCapabilities: this.meetingServices.capabilities,
      policyConfiguration: { watermark: this.watermarkApproved, ui: this.uiApproved }
    });
    if (operation === 'error.describe')
      return this.ready && !this.disposed && !this.retiring && !this.loggingOut ? this.callPage(operation, params) : Promise.resolve(null);
    if (operation === 'watermark.set' || operation === 'ui.configure')
      return this.configureMeetingPolicy(operation, params);
    if (operation === 'screen.setPermission') {
      const update = this.setScreenPermission(params);
      this.serial = Promise.allSettled([this.serial, update]).then(() => {});
      return update;
    }
    const startEpoch = this.screenCancellationEpoch;
    const recordingEpoch = this.recordingCancellationEpoch;
    const managementEpoch = this.managementCancellationEpoch;
    if (operation === 'recording.stop') {
      ++this.recordingCancellationEpoch;
      this.cancelRecordingAuthorization();
      const stop = this.disposed ? Promise.reject(failure('DISPOSED', 'The media bridge was disposed')) :
        this.ready ? this.callPage(operation, params) :
          Promise.reject(failure('ENGINE_NOT_READY', 'The genuine recording runtime is not ready to confirm a stop'));
      this.serial = Promise.allSettled([this.serial, stop]).then(() => {});
      return stop;
    }
    let disposeRecordingStop = null;
    let disposeScreenStop = null;
    let disposeWindowError = null;
    if (operation === 'dispose' || operation === 'session.logout') {
      ++this.ownerEpoch;
      ++this.logoutRequests;
      this.incomingInvite.cancel();
      this.retiring = true;
      if (operation === 'dispose') this.disposeRequested = true;
      ++this.policyEpoch;
      try {
        this.hideMeetingWindow();
        // Disposal queues behind initialization. Abort its provisional window
        // now; ready media still goes through real leave/recording cleanup.
        if (this.initializing && !this.ready && this.window && !this.window.isDestroyed())
          this.window.destroy();
      } catch (error) {
        // A window failure must not strand the retirement counter or skip
        // credential/storage cleanup. Preserve it in the actual logout report.
        disposeWindowError = this.publicLogoutError(error, 'window-retirement');
      }
      this.cancelManagementRequests();
      const pendingScreenStart = this.screenStartPending;
      this.cancelScreenStart();
      ++this.recordingCancellationEpoch;
      this.cancelRecordingAuthorization();
      if (this.ready) {
        // recording.stop does not cancel the renderer's pendingScreen. Send the
        // actual screen.stop before waiting on either main or renderer queues.
        if (pendingScreenStart) disposeScreenStop = this.callPage('screen.stop');
        disposeRecordingStop = this.stopRecordingForDispose();
      }
      if (disposeScreenStop || disposeRecordingStop)
        this.serial = Promise.allSettled([this.serial, disposeScreenStop, disposeRecordingStop]).then(() => {});
    }
    if (operation === 'screen.stop') {
      this.cancelScreenStart();
      // Deliver cancellation now, not after an unresolved start/picker. The
      // renderer serializes the actual stop behind its cancelled start cleanup.
      const stop = this.disposed ? Promise.reject(failure('DISPOSED', 'The media bridge was disposed')) :
        this.ready ? this.callPage(operation, params) :
          Promise.reject(failure('ENGINE_NOT_READY', 'The genuine meeting runtime is not ready to confirm a stop'));
      this.serial = Promise.allSettled([this.serial, stop]).then(() => {});
      return stop;
    }
    const task = this.serial.then(async () => {
      if (this.disposed) throw failure('DISPOSED', 'The media bridge was disposed');
      if (this.retiring && operation !== 'dispose' && operation !== 'session.logout' &&
          !Object.prototype.hasOwnProperty.call(this.meetingServices.capabilities, operation))
        throw failure('SESSION_LOGOUT_IN_PROGRESS', 'The queued media operation belongs to a retiring owner');
      if (operation === 'screen.start' && startEpoch !== this.screenCancellationEpoch)
        throw failure('CAPTURE_CANCELLED', 'The queued screen start was cancelled');
      if (operation === 'recording.start' && recordingEpoch !== this.recordingCancellationEpoch)
        throw failure('RECORDING_CANCELLED', 'The queued recording start was cancelled');
      if (operation === 'dispose' || operation === 'session.logout') {
        let report;
        try {
          report = await this.logoutSession({ screenStop: disposeScreenStop, recordingStop: disposeRecordingStop });
          if (disposeWindowError) report.errors.unshift(disposeWindowError);
        } finally {
          --this.logoutRequests;
          this.retiring = this.disposeRequested || this.logoutRequests > 0 || this.mediaOwner.retired;
          if (operation === 'dispose') {
            this.disposed = true;
            if (this.management) this.management.dispose();
            this.electron.ipcMain.removeHandler(this.channel);
            this.engineUnavailable('disposed');
            if (report) report.disposed = true;
          }
        }
        if (report.errors.length) {
          const first = report.errors[0];
          const error = failure(first.code, first.message);
          if (first.status !== undefined) error.status = first.status;
          error.details = report;
          throw error;
        }
        return report;
      }
      if (Object.prototype.hasOwnProperty.call(this.meetingServices.capabilities, operation)) {
        if (managementEpoch !== this.managementCancellationEpoch)
          throw failure('MANAGEMENT_REQUEST_ABORTED', 'The queued meeting service request belongs to a retired owner operation');
        return this.meetingServices.execute(operation, params);
      }
      this.requireOwnerEpoch(ownerEpoch);
      this.requireMediaOwner(requestOwner);
      if (operation === 'initialize') return this.initialize();
      if (operation === 'conference.joinAnonymous' || operation === 'conference.joinLink') {
        const owner = await this.prepareAnonymousSession(admission.origin, ownerEpoch);
        try {
          // Use the real anonymous UI, its challenge and signed-ticket flow.
          // No native token/skipnonce acquisition is permitted on this path.
          await this.initialize('/j');
          this.requireOwnerEpoch(ownerEpoch);
          this.requireMediaOwner(owner);
          await this.showMeetingWindow();
          this.requireOwnerEpoch(ownerEpoch);
          const result = await this.callPage(operation, params);
          this.requireOwnerEpoch(ownerEpoch);
          this.requireMediaOwner(owner);
          return result;
        } catch (error) {
          // Even initialization/display failure can leave a live vendor auth
          // saga. Clean only this admission's owner, never a later meeting.
          if (owner === this.mediaOwner) {
            let cleanup;
            try { cleanup = await this.logoutSession(); }
            catch (cleanupError) {
              cleanup = { localCleanupComplete: false,
                errors: [this.publicLogoutError(cleanupError, 'anonymous-session-cleanup')] };
            }
            error.details = { operationDetails: error.details, anonymousSessionCleanup: cleanup };
          }
          throw error;
        }
      }
      if (operation === 'conference.join' && (this.mediaOrigin !== this.origin || this.mediaOwner.anonymous))
        await this.prepareAnonymousSession(this.origin, ownerEpoch, false);
      await this.initialize();
      if (operation === 'recording.start') return this.startRecording(params, recordingEpoch);
      if (operation === 'window.show') return this.showMeetingWindow();
      if (operation === 'conference.invite')
        return this.callPage(operation, normalizeInvitation(params));
      if (operation === 'language.set') {
        const result = await this.callPage(operation, params);
        this.options.language = result.language;
        return result;
      }
      if (operation === 'features.get') {
        const result = await this.callPage(operation, params);
        const pageCapabilities = result.setEnableCapability;
        const miniSupported = !!this.p2pMini;
        const miniAvailable = miniSupported && this.p2pMini.eligible();
        const miniCapability = { ...nativeCapabilityContract.definitions[13],
          supported: miniSupported, available: miniAvailable, boundary: miniSupported ? null :
            nativeCapabilityContract.definitions[13].boundary,
          enabled: miniSupported ? this.p2pMini.enabled : false, active: !!this.p2pMini?.saved,
          scope: 'local-p2p-compact-window', provider: 'linux-native-call-window',
          configurationAvailable: miniSupported && !this.disposed && !this.retiring && !this.loggingOut,
          reason: !miniSupported ? 'P2P_MINI_WINDOW_UNAVAILABLE' : !this.p2pMini.enabled ?
            'NATIVE_CAPABILITY_DISABLED' : miniAvailable ? null : 'P2P_MINI_WINDOW_NOT_ELIGIBLE',
          requirements: ['current-account-site', 'established-active-p2p-call', 'approved-meeting-policies',
            'visible-connected-owner-window'],
          serverCapabilityAcknowledged: false, nativeSdkServerSupportVerified: false,
          serverPermissionGranted: false, osPermissionGranted: false };
        const background = await this.callPage('background.state', {});
        const complaint = this.options.getComplaints?.()?.status();
        const hostTypes = new Map([[7, { ...this.anonymousVoiceState(), supported: true }],
          [10, background], [12, complaint ? { ...complaint, supported: true } : { supported: false }],
          [13, miniCapability]]);
        const types = pageCapabilities.types.map(value => ({ ...value, ...hostTypes.get(value.type) }));
        return { ...result, 'call.p2p.start': this.p2pCapability(),
          setEnableCapability: { ...pageCapabilities,
            supportedTypes: types.filter(value => value.supported).map(value => value.type), types },
          managementCapabilities: this.meetingServices.capabilities };
      }
      if (operation === 'conference.join') {
        const owner = this.mediaOwner;
        await this.ensureMeetingPolicies();
        const nonce = await this.createJoinNonce();
        this.requireOwnerEpoch(ownerEpoch);
        this.requireMediaOwner(owner);
        await this.showMeetingWindow();
        this.requireOwnerEpoch(ownerEpoch);
        this.requireMediaOwner(owner);
        return this.callPage(operation, { ...params, nonce });
      }
      if ((operation === 'conference.leave' || operation === 'conference.end') && this.mediaOrigin !== this.origin) {
        const owner = this.mediaOwner;
        const result = await this.callPage(operation, params);
        this.requireMediaOwner(owner);
        let cleanup;
        try {
          cleanup = await this.retireIdleBrowserSession(owner, ownerEpoch);
          this.requireCleanSessionReport(cleanup);
        } catch (error) {
          error.details = { operationResult: result, ...(cleanup ? { guestSessionCleanup: cleanup } :
            { cleanupError: this.publicLogoutError(error, 'idle-guest-retirement') }) };
          throw error;
        }
        return result;
      }
      if (operation === 'screen.start') {
        if (startEpoch !== this.screenCancellationEpoch)
          throw failure('CAPTURE_CANCELLED', 'Screen sharing was cancelled before capture began');
        if (!params.sourceId && typeof this.options.selectDesktopSource !== 'function')
          throw failure('SOURCE_SELECTION_REQUIRED', 'Screen sharing requires an explicit source picker');
        if (params.audio === true && !this.shareAudioEnabled)
          throw failure('SHARED_AUDIO_DISABLED', 'Sharing sound is disabled by the application');
        if (params.audio === true && params.audioInputId === undefined) {
          if (!this.hasOutputMonitorRoute()) throw failure('SYSTEM_AUDIO_ROUTE_UNAVAILABLE', 'No Linux output monitor route');
          const sessionKey = await this.requireScreenGrant();
          if (!this.shareAudioEnabled || startEpoch !== this.screenCancellationEpoch)
            throw failure('CAPTURE_CANCELLED', 'The computer-sound request was cancelled');
          this.outputRequest = { sessionKey, window: this.window, used: false };
        }
        this.selectedSource = params.sourceId || null;
        this.screenStartPending = true;
        try { return await this.callPage(operation, params); }
        finally { this.screenStartPending = false; this.selectedSource = null; this.outputRequest = null; }
      }
      return this.callPage(operation, params);
    });
    this.serial = task.catch(() => {});
    return task;
  }

  async handle(request) {
    if (!request || request.protocol !== PROTOCOL || (typeof request.id !== 'string' && typeof request.id !== 'number'))
      throw failure('INVALID_PROTOCOL', 'Expected the explicit native-WebRTC protocol');
    try {
      return { protocol: PROTOCOL, id: request.id, ok: true,
        data: await this.execute(request.operation, request.params || {}) };
    } catch (error) {
      const rejected = { code: error.code === undefined ? 'MEDIA_OPERATION_FAILED' : error.code,
        message: String(error.message || error) };
      if (error.details !== undefined) rejected.details = error.details;
      if (error.status !== undefined) rejected.status = error.status;
      if (error.response !== undefined) rejected.response = error.response;
      return { protocol: PROTOCOL, id: request.id, ok: false, error: rejected };
    }
  }
}

module.exports = { MeetingNativeWeb, PROTOCOL };
