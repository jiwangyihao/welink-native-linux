'use strict';

// Linux implementation of the conference service's actual operations. This is
// not the macOS hwmsdk.node fallback and does not manufacture legacy SDK events.
const path = require('path');
const { createBridge } = require('./meeting_renderer');
const { nativeDirectoryReply } = require('./meeting_directory');
const nativeCapabilities = require('./meeting_native_capabilities');

let instance;
function flag(value, name) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  throw Object.assign(new Error(`${name} must be an explicit boolean`), { code: 'INVALID_ARGUMENT' });
}
function requiredString(value, name) {
  if (typeof value !== 'string' || !value) throw Object.assign(new Error(`${name} is required`), { code: 'INVALID_ARGUMENT' });
  return value;
}

const WATERMARK_COLORS = ['#cccccc', '#999999', '#666666'];
const UI_METHODS = new Set(['sendConfigUISdk', 'sendCancelConfigUISdk', 'sendCancelFeedbackConfigUISdk',
  'sendUpdateOneRoomConfigUISdk', 'sendOpenDetailConfigUISdk', 'sendExtMeetingConfigUISdk',
  'sendGuestInviteBtnShowConfigUISdk', 'callOtherNumBtnConfigUISdk']);
const UI_CONTROLS = new Set(['invite', 'guest_invite', 'participant_detail', 'vote', 'feedback', 'attendee_access_control']);
// Packaged conference/dist/js/hwmService.js: feature 9; commands 1045..1050.
// statementDialog.js specifies local-only voice shielding, including deletion
// on refusal. None of these acknowledgements is a meeting/recording permission.
// Public platform comparison: https://support.huaweicloud.com/sdkreference-meeting/meeting_22_0001.html
const NATIVE_BOUNDARIES = Object.freeze({
  setEnableCapability: ['NATIVE_CAPABILITY_UNAVAILABLE', 'The requested private HwmSDKCapabilityType has no safe independent provider binding. Per-type operation errors identify the actual boundary; public EnableCapability is a different ABI.']
});
function operationError(code, message, details) {
  return Object.assign(new Error(message), { code, details });
}

class LinuxConferenceService {
  constructor(options) {
    this.window = options.window;
    this.Pedestal = options.Pedestal;
    this.sdk = options.sdk;
    // The original webpack store imports this facade; do not read its export
    // while that circular module graph is still being constructed.
    if (typeof options.getStore !== 'function') throw new TypeError('The real conference store provider is required');
    this.getStore = options.getStore;
    // Reuse module 31's real builders and room/account calculations, but never
    // send their native cmd1005 envelope or resolve a fabricated notification.
    this.uiBuilder = Object.create(options.sdk);
    this.uiBuilder.sendMessage = configuration => configuration;
    this.uiBuilder.getCustomNoteData = () => {
      const info = this.store.getStore('confInfo');
      const evidence = this.store.getStore('nativeMeetingDetails');
      // The original uses !isOtherCorpConf; missing evidence must not become
      // permission. Once known, leave every tenant/account/booking test intact.
      if (!evidence || !evidence.tenantClassificationConfirmed || !info || info.isOtherCorpConf !== false)
        return Promise.resolve([]);
      return this.sdk.getCustomNoteData.call(this.uiBuilder);
    };
    this.bridge = createBridge(options);
    this.confHasInit = false;
    this.hasUsgLogin = false;
    this.callEnabledBySdk = false;
    this.callCapabilityRevision = 0;
    this.initializing = null;
    this.initializingIntent = -1;
    this.name = '';
    this.joinPreferences = { openMic: false, openCamera: false };
    this.lastFailure = null;
    this.membership = null;
    this.appHandlers = null;
    this.uiQueue = Promise.resolve();
    this.eventQueue = Promise.resolve();
    this.logoutPending = false;
    this.logoutPromise = null;
    this.membershipRevision = 0;
    this.p2pStatus = null;
    this.bridge.on('engine', message => {
      if (message.event !== 'engine-ready') this.confHasInit = false;
    });
    this.bridge.on('authentication', reply => {
      if (reply.result !== 0) { this.hasUsgLogin = false; this.publishToken(''); }
    });
    this.bridge.on('token', token => this.publishToken(token));
    this.bridge.on('session-cleared', report => this.sessionCleared(report));
    this.bridge.on('event', message => {
      // Membership is updated synchronously, before any room-policy calculation.
      if (message.event === 'meeting-lifecycle') this.acceptLifecycle(message.data);
      if (message.event === 'media-state') this.acceptMediaState(message.data);
      if (message.event === 'offline-conference' && message.data?.type === 'state') {
        const event = message.data;
        this.store.setStore('nativeOfflineMeeting', event);
        if (event.state === 'joined') this.appHandlers?.confState(3);
        else if (event.state === 'left' || event.state === 'failed') this.appHandlers?.confState(0);
      }
      if (message.event === 'p2p-native-notify' && message.data?.notify === 33) {
        this.window.notifyJsTupCallback(message.data);
      }
      if (message.event === 'p2p-call-state' && message.data?.kind === 'p2p') {
        const status = message.data.pending && !message.data.callerJoined ? 1 : 0;
        if (status !== this.p2pStatus) {
          this.p2pStatus = status;
          this.dispatch('callStatusChange', { callStatus: status });
        }
      }
      if (message.event === 'directory-query') this.answerDirectoryQuery(message.data);
      if (message.event === 'ui-custom-click') {
        const revision = this.membershipRevision;
        const pending = this.eventQueue.then(() => this.handleCustomClick(message.data, revision));
        this.eventQueue = pending.catch(error => this.reportEventFailure(error));
      }
    });
  }

  get store() { return this.getStore(); }

  rejected(error, extra) {
    const code = error && error.code !== undefined ? error.code : 'MEETING_OPERATION_FAILED';
    const reason = error && error.message ? error.message : 'The real meeting operation failed';
    this.lastFailure = { code, reason, details: error && error.details };
    return { result: typeof code === 'number' && code !== 0 ? code : 1,
      param: { reason_code: code, reason, ...(error && error.details !== undefined ? { details: error.details } : {}),
        ...(extra || {}) } };
  }

  async run(operation, params, translate = data => ({ param: data })) {
    try {
      const data = await this.bridge.execute(operation, params);
      return { result: 0, ...translate(data) };
    } catch (error) { return this.rejected(error); }
  }

  bindAppHandlers(handlers) {
    this.appHandlers = handlers;
    return this;
  }

  dispatch(name, detail) {
    this.window.dispatchEvent(new this.window.CustomEvent(name, { detail }));
  }

  publishToken(token) {
    // A successful getMeetingToken response is lease evidence. hasToken in the
    // C capabilities object is only pointer presence and is never consulted.
    const current = typeof token === 'string' && token.length > 0 && !this.logoutPending;
    if (!current) { this.callEnabledBySdk = false; ++this.callCapabilityRevision; }
    const callEnabled = current && this.callEnabledBySdk;
    this.hasUsgLogin = current;
    this.store.setStore('usgToken', current ? this.window.btoa(token) : '');
    this.store.setStore('isUsgEnableReal', current);
    this.store.setStore('isUsgEnable', current && !!this.store.getStore('loginIntent'));
    this.dispatch('tokenChange', { isCallEnable: callEnabled, isUsgEnable: current,
      token: current ? this.window.btoa(token) : '' });
    this.store.setStore('isCallEnable', callEnabled && !!this.store.getStore('loginIntent'));
  }

  async handleNativeTokenNotification(reply) {
    try {
      if (this.logoutPending || !reply || reply.result !== 0 || !reply.param || !reply.param.token) {
        this.publishToken('');
        return;
      }
      // getCallEnable (hwm_login.dll RVA 0x912AC) is independent of USG token validity.
      // A delayed old capability must not undo a newer revocation or change of account.
      const revision = ++this.callCapabilityRevision, generation = this.bridge.generation;
      const intent = this.bridge.intent, owner = this.bridge.account;
      const enabled = reply.param.isCallEnable === true || reply.param.isCallEnable === 1;
      if (!enabled) this.callEnabledBySdk = false;
      const token = await this.bridge.rawToken();
      if (revision !== this.callCapabilityRevision || generation !== this.bridge.generation ||
          intent !== this.bridge.intent || owner !== this.bridge.account || this.logoutPending) return;
      this.callEnabledBySdk = enabled && (reply.param.token === token || reply.param.token === this.window.btoa(token));
      this.publishToken(token);
    } catch (error) { this.publishToken(''); this.reportEventFailure(error); }
  }

  reportEventFailure(error) {
    const result = this.rejected(error);
    this.store.setStore('nativeMeetingError', result.param);
    this.dispatch('nativeMeetingError', result.param);
    return result;
  }

  updateRole(role) {
    // Module 31's host test is exactly role===1. Other provider roles remain
    // symbolic in nativeMeeting; do not invent native SDK cohost/audience enums.
    const mapped = role && role.kind === 'host' ? 1 : 0;
    if (this.store.getStore('role') !== mapped) this.dispatch('roleInfoChange', { role: mapped, nativeRole: role });
  }

  publishLocalSharing(active) {
    const state = active ? 1 : 0;
    const previous = this.store.getStore('shareState')?.param?.state;
    if (previous === state) return;
    const reply = { notify: 3, result: 0, description: 'OnShareStateChange', param: { state } };
    this.store.setStore('shareState', reply); // Seeds a note opened after sharing started.
    if (state || previous === 1) Promise.resolve(this.Pedestal.sendBroadcast(
      'broadcast://private_conference/hwm/onShareStateChange', reply)).catch(error => this.reportEventFailure(error));
  }

  acceptMediaState(state) {
    if (!state || typeof state.joined !== 'boolean') return;
    this.store.setStore('nativeMeetingMedia', state);
    if (state.joined && this.membership && state.sessionKey === this.membership.sessionKey &&
        String(state.conferenceId) === String(this.membership.conferenceId)) {
      if (typeof state.screenSharing === 'boolean') this.publishLocalSharing(state.screenSharing);
      const changed = JSON.stringify(this.membership.role) !== JSON.stringify(state.role);
      this.membership = { ...this.membership, role: state.role, connection: state.connection };
      this.store.setStore('nativeMeeting', this.membership);
      this.updateRole(state.role);
      if (changed) this.sendUpdateOneRoomConfigUISdk().then(reply => {
        if (reply.result !== 0) this.store.setStore('nativeMeetingUiResult', reply);
      });
    }
  }

  acceptLifecycle(event) {
    if (!event || !['joined', 'reconnected', 'left', 'closed'].includes(event.state)) return;
    if (event.state === 'closed') {
      // Window loss is only local cleanup, not evidence of a server-side leave.
      this.publishLocalSharing(false);
      ++this.membershipRevision;
      this.membership = null;
      this.store.setStore('nativeMeeting', event);
      this.store.setStore('role', '');
      this.store.setStore('confInfo', {});
      this.store.setStore('nativeMeetingDetails', null);
      if (this.appHandlers) this.appHandlers.confState(0);
      return;
    }
    if (event.source !== 'hrtc-and-mmr-room-state' || typeof event.sessionKey !== 'string') return;
    if (event.state === 'left') {
      if (!this.membership || event.sessionKey !== this.membership.sessionKey) return;
      this.publishLocalSharing(false);
      ++this.membershipRevision;
      this.membership = null;
      this.store.setStore('nativeMeeting', event);
      this.store.setStore('role', '');
      this.store.setStore('nativeMeetingDetails', null);
      if (this.appHandlers) {
        this.appHandlers.confState(0);
        Promise.resolve(this.appHandlers.meetingLeft()).catch(error => this.reportEventFailure(error));
      }
      this.sendUpdateOneRoomConfigUISdk();
      return;
    }
    if (event.connection !== 'CONNECTED' || !event.conferenceId || !event.participantId) return;
    const previous = this.membership;
    const changed = !previous || previous.sessionKey !== event.sessionKey ||
      String(previous.conferenceId) !== String(event.conferenceId) ||
      String(previous.participantId) !== String(event.participantId);
    // A reconnect of the same membership must not retire its pending details.
    if (changed) ++this.membershipRevision;
    this.membership = { ...event };
    const media = this.store.getStore('nativeMeetingMedia');
    this.publishLocalSharing(media?.sessionKey === event.sessionKey && media.joined === true && media.screenSharing === true);
    this.store.setStore('nativeMeeting', this.membership);
    this.updateRole(event.role);
    if (this.appHandlers) this.appHandlers.confState(3);
    if (changed) {
      // Never reuse another meeting's identity, tenant, password or room data.
      this.store.setStore('nativeMeetingDetails', null);
      this.store.setStore('confInfo', { confId: String(event.displayConferenceId || event.conferenceId),
        privateConfId: String(event.conferenceId) });
      this.loadMeetingInfo(event).catch(error => this.reportEventFailure(error));
    } else this.sendUpdateOneRoomConfigUISdk();
  }

  async loadMeetingInfo(event) {
    const revision = this.membershipRevision;
    const details = await this.bridge.execute('conference.details', { conf_id: String(event.conferenceId) });
    if (!this.membership || revision !== this.membershipRevision || this.membership.sessionKey !== event.sessionKey) return;
    const info = details && details.native && details.native.confDetailInfo;
    if (!info || String(info.conf_id) !== String(event.conferenceId))
      throw operationError('CONFERENCE_DETAILS_UNCONFIRMED', 'The server details do not match the confirmed meeting membership');
    const relation = event.tenantRelation;
    const classification = relation && relation.known === true && typeof relation.isOtherCorpConf === 'boolean' ?
      relation.isOtherCorpConf : undefined;
    const mapped = { ...info, role: this.store.getStore('role'),
      displayConferenceId: String(event.displayConferenceId || event.conferenceId) };
    if (classification !== undefined) mapped.isOtherCorpConf = classification;
    this.store.setStore('nativeMeetingDetails', { source: 'conference.details', tenantClassificationConfirmed: classification !== undefined });
    // Reuse module 49's application handler, including module 423's account and
    // tenant share policy. Its Linux unknown-tenant branch denies local capture.
    // This is a semantic app event, never an SDK notify or a P2P call record.
    this.dispatch('confInfoChange', mapped);
  }

  sessionCleared(report) {
    this.hasUsgLogin = false;
    ++this.membershipRevision;
    this.confHasInit = false;
    this.publishToken('');
    this.store.setStore('nativeMeetingCleanup', report);
    if (report && report.localCleanupComplete === true) {
      this.publishLocalSharing(false);
      this.membership = null;
      this.store.setStore('nativeMeeting', { state: 'closed', localOnly: true, source: 'owner-cleanup' });
      this.store.setStore('role', '');
      this.store.setStore('confInfo', {});
      this.store.setStore('nativeMeetingDetails', null);
      if (this.appHandlers) this.appHandlers.confState(0);
    }
  }

  async handleCustomClick(click, revision) {
    if (!click || !this.membership || revision !== this.membershipRevision ||
        click.sessionKey !== this.membership.sessionKey || String(click.conferenceID) !== String(this.membership.conferenceId))
      throw operationError('CONFERENCE_CHANGED', 'The UI click belongs to an inactive meeting');
    const state = await this.bridge.execute('state.get');
    if (!state.joined || state.sessionKey !== click.sessionKey)
      throw operationError('CONFERENCE_CHANGED', 'The participant is no longer connected to that meeting');
    this.updateRole(state.role);
    if (!this.appHandlers) throw operationError('APP_HANDLER_UNAVAILABLE', 'The original conference UI handlers are not attached');
    const id = click.buttonId;
    if (id === 'minutes' || id === 'listenAndNote') {
      const configuration = await this.buildUiPatch('sendUpdateOneRoomConfigUISdk');
      const room = configuration.patch.customButtonStatus;
      if (!room || room.sessionKey !== click.sessionKey ||
          (id === 'minutes' ? room.minutes === 'hidden' : !room.listenAndNote))
        throw operationError('ROOM_ACTION_DENIED', 'The current account, tenant and booking policy does not allow this room action');
    } else {
      const ui = await this.bridge.execute('ui.state');
      const button = ui.configuration && ui.configuration.toolBar.button.find(item => item.id === id);
      if (!button || button.showAsAction === 'never' || button.isCustomizedClick !== true ||
          id === 'participant_detail' && !this.store.getStore('isUserLogined'))
        throw operationError('UI_ACTION_DENIED', 'The current confirmed UI policy does not allow that action');
    }
    if (!this.membership || revision !== this.membershipRevision || this.membership.sessionKey !== click.sessionKey)
      throw operationError('CONFERENCE_CHANGED', 'The room changed while the UI action was being authorized');
    if (!this.membership.role || !state.role || this.membership.role.kind !== state.role.kind)
      throw operationError('ROLE_CHANGED', 'The participant role changed while the UI action was being authorized');
    if (id === 'participant_detail') {
      if (!click.participant || typeof click.participant.accountID !== 'string' || !click.participant.accountID.includes('@'))
        throw operationError('PARTICIPANT_ACCOUNT_UNAVAILABLE', 'The provider did not supply a workplace account for this participant');
      return this.appHandlers.participant({ accountId: click.participant.accountID });
    }
    if (id === 'invite' || id === 'guest_invite') return this.appHandlers.invite();
    if (id === 'minutes') return this.appHandlers.minutes();
    if (id === 'listenAndNote') return this.appHandlers.listenAndNote();
    throw operationError('UI_ACTION_UNAVAILABLE', 'There is no verified application handler for ' + id);
  }

  initAuth() { return this.bridge.initializeAuth(); }

  requireSession(intent) {
    if (intent !== this.bridge.intent || this.logoutPending || this.bridge.disposed)
      throw operationError('SESSION_CHANGED', 'The conference request belongs to a retired session');
  }

  async prepareInvitationResolver() {
    const intent = this.bridge.intent;
    try {
      await this.bridge.initializeAuth();
      const generation = this.bridge.generation;
      await this.bridge.registerBroker();
      return { ok: intent === this.bridge.intent && generation === this.bridge.generation && !this.bridge.logoutPromise };
    } catch (_) { return { ok: false }; }
  }

  initConf() {
    const intent = this.bridge.intent;
    if (this.initializing && this.initializingIntent === intent) return this.initializing;
    const pending = (async () => {
      try {
        this.requireSession(intent);
        await this.bridge.initializeMedia();
        this.requireSession(intent);
        // Preserve the separate Linux shared-audio UI gate. Private cmd1050
        // type 7 is anonymous PNR, not the Mac public SHARE_AUDIO switch.
        const shareAudio = await this.bridge.execute('host.ui.shareAudio.configure', { enabled: true });
        this.requireSession(intent);
        if (shareAudio?.configured !== true || shareAudio.enabled !== true ||
            shareAudio.scope !== 'local-share-audio-ui' || shareAudio.serverPermissionGranted !== false ||
            shareAudio.osPermissionGranted !== false)
          throw operationError('CAPABILITY_ENFORCEMENT_UNCONFIRMED', 'The shared-audio UI gate was not configured');
        const storage = await this.Pedestal.callMethod('method://pedestal/getLogStoragePath', { timeout: 5000 });
        this.requireSession(intent);
        const logs = typeof storage === 'string' && storage ? storage : this.Pedestal.logRootPath;
        // Confirm cmd50 only after the real engine event reached this C owner.
        const reply = await this.bridge.requestNative('init', [{
          modulePath: path.join(__dirname, 'lib'),
          logPath: path.join(logs, 'conference', 'native'),
          userDataPath: path.join(this.Pedestal.appdataRootPath, 'conference', 'native')
        }], 50);
        this.requireSession(intent);
        this.confHasInit = reply.result === 0;
        return reply;
      } catch (error) {
        if (intent === this.bridge.intent) this.confHasInit = false;
        return this.rejected(error);
      }
    })();
    this.initializing = pending;
    this.initializingIntent = intent;
    pending.finally(() => { if (this.initializing === pending) this.initializing = null; }).catch(() => {});
    return pending;
  }

  async usgLogin() {
    const intent = this.bridge.intent;
    try {
      this.requireSession(intent);
      const reply = await this.bridge.authenticate();
      this.requireSession(intent);
      if (reply.result === 0) await this.bridge.rawToken();
      this.requireSession(intent);
      this.hasUsgLogin = reply.result === 0;
      return reply;
    } catch (error) {
      if (intent === this.bridge.intent) this.hasUsgLogin = false;
      return this.rejected(error);
    }
  }

  async getUsgToken() {
    try { return await this.bridge.legacyToken(); }
    catch (error) { return { ...this.rejected(error), token: '' }; }
  }

  usgLogout() {
    if (this.logoutPromise) return this.logoutPromise;
    this.logoutPending = true;
    this.publishToken('');
    const pending = (async () => {
      try { return await this.bridge.logout(); }
      catch (error) { return this.rejected(error); }
      finally { this.hasUsgLogin = false; this.confHasInit = false; this.logoutPending = false; }
    })();
    this.logoutPromise = pending;
    pending.finally(() => { if (this.logoutPromise === pending) this.logoutPromise = null; }).catch(() => {});
    return pending;
  }

  exitConf() {
    // The registered broker's dispose already retires pending joins, leaves an
    // active room and awaits its real cleanup receipts before native logout.
    // Do not initialize an idle session or send a second conference.leave.
    return this.usgLogout();
  }

  setProxy() { return this.initAuth(); }
  setCAVerification() { return this.initAuth(); }

  async joinConfByID(params) {
    const intent = this.bridge.intent;
    try {
      const info = params && params.joinConfInfo;
      const preferences = params.advanceSet || {};
      if (!info || typeof info !== 'object') throw Object.assign(new Error('joinConfInfo is required'), { code: 'INVALID_ARGUMENT' });
      const initialized = await this.initConf();
      this.requireSession(intent);
      if (initialized.result !== 0) return initialized;
      await this.bridge.execute('screen.setPermission', { allowed: false });
      this.requireSession(intent);
      const state = await this.bridge.execute('conference.join', {
        confId: requiredString(info.conf_id, 'conference ID'),
        password: info.conf_pwd === undefined ? '' : String(info.conf_pwd),
        name: info.name === undefined ? this.name : String(info.name),
        openMic: preferences.isOpenMicDe === undefined ? this.joinPreferences.openMic : flag(preferences.isOpenMicDe, 'isOpenMicDe'),
        openCamera: preferences.isOpenCameraDe === undefined ? this.joinPreferences.openCamera : flag(preferences.isOpenCameraDe, 'isOpenCameraDe')
      });
      return { result: 0, param: { reason_code: 0, reason: '', state } };
    } catch (error) { return this.rejected(error); }
  }

  oneKeyEnterConf(params) { return this.joinConfByID(params); }

  async createConf(params) {
    const intent = this.bridge.intent;
    let created;
    try {
      created = await this.bridge.execute('conference.create', params);
      this.requireSession(intent);
      const initialized = await this.initConf();
      this.requireSession(intent);
      if (initialized.result !== 0) return { ...initialized, createdConference: created.conference };
      await this.bridge.execute('screen.setPermission', { allowed: false });
      this.requireSession(intent);
      const conference = created.conference;
      const passwords = Array.isArray(conference.passwordEntry) ? conference.passwordEntry : [];
      const chair = passwords.find(entry => entry.conferenceRole === 'chair');
      const preferences = created.joinPreferences || {};
      const state = await this.bridge.execute('conference.join', {
        confId: created.conferenceID,
        password: chair && typeof chair.password === 'string' ? chair.password : '',
        name: this.name,
        openMic: preferences.isMicOn === undefined ? this.joinPreferences.openMic : preferences.isMicOn,
        openCamera: preferences.isCameraOn === undefined ? this.joinPreferences.openCamera : preferences.isCameraOn
      });
      return { result: 0, param: { conference, state } };
    } catch (error) {
      return this.rejected(error, created ? { createdConference: created.conference } : undefined);
    }
  }

  async currentMediaState() {
    const window = await this.bridge.execute('host.window.info', {});
    if (!window || typeof window.exists !== 'boolean')
      throw Object.assign(new Error('The actual meeting window state is unavailable'), { code: 'INVALID_WINDOW_STATE' });
    if (!window.exists) return { joined: false, windowPresent: false };
    const state = await this.bridge.execute('state.get');
    if (!state || typeof state.joined !== 'boolean')
      throw Object.assign(new Error('The actual conference state is unavailable'), { code: 'INVALID_MEDIA_STATE' });
    return state;
  }

  async setSelfInfo({ showName }) {
    try {
      if (typeof showName !== 'string')
        throw Object.assign(new Error('showName must be a string'), { code: 'INVALID_ARGUMENT' });
      const state = await this.currentMediaState();
      if (!state.joined) {
        this.name = showName;
        return { result: 0, param: { preferenceOnly: true, active: false, showName } };
      }
      const actual = await this.bridge.execute('participant.rename', { showName });
      this.name = showName;
      return { result: 0, param: actual };
    } catch (error) { return this.rejected(error); }
  }

  enterAnonymousConfWithConfId(params) { return this.run('conference.joinAnonymous', params); }
  addConfAttendee(params) { return this.run('conference.invite', params); }
  changeNativeLangCode(langCode) { return this.run('language.set', { langCode }); }
  async setNoiseReduce({ state }) {
    try { return await this.run('audio.noise.set', { state: flag(state, 'noise reduction') }); }
    catch (error) { return this.rejected(error); }
  }

  startCtdCall(params) {
    return this.run('call.ctd.start', params, data => {
      const state = data?.callState;
      if (state?.phase === 'cancelled' && state.endConfirmed || state?.phase === 'not_sent' && !state.transmissionAttempted)
        return { param: data, dialAccepted: false };
      // ctdResult validates the correlated CREATECONF frame and its conference list.
      if (state?.phase !== 'created' || state.cancelRequested || state.retired || data.transport !== 'websocket' ||
          !data.conferenceID || data.conference?.conferenceID !== data.conferenceID)
        throw operationError('CALL_UNCONFIRMED', 'No confirmed callback conference was returned');
      return { param: data, dialAccepted: true };
    });
  }

  async getPendingCall({ callRequestId } = {}) {
    try {
      if (typeof callRequestId !== 'string' || !/^[0-9a-f]{32}$/.test(callRequestId))
        throw operationError('INVALID_ARGUMENT', 'The dial window must identify its request');
      if (!this.bridge.registration) return { result: 0, param: { kind: 'ctd', phase: 'idle', pending: false } };
      return { result: 0, param: await this.bridge.callRegistered('call.outbound.state', { callRequestId }) };
    } catch (error) { return this.rejected(error); }
  }

  async cancelPendingCall({ kind, attemptId } = {}) {
    try {
      if (kind !== 'ctd' && kind !== 'p2p') throw operationError('INVALID_ARGUMENT', 'Unknown outbound call kind');
      return { result: 0, param: await this.bridge.callRegistered('call.' + kind + '.cancel', { attemptId }) };
    } catch (error) { return this.rejected(error); }
  }
  async getConfPstnNumber() {
    const reply = await this.run('conference.pstnNumbers', {}, data => ({ pstnNumber: data.native.pstnNumber }));
    if (reply.result !== 0) reply.pstnNumber = '';
    return reply;
  }

  getVMRList() { return this.run('vmr.list', {}, data => data.native); }
  changeVmrInfo(params) { return this.run('vmr.update', params); }
  getConfInfo(params) { return this.run('conference.details', params, data => data.native); }

  async setMicState({ state }) {
    try {
      const enabled = flag(state, 'microphone state');
      const current = await this.currentMediaState();
      if (!current.joined) {
        this.joinPreferences.openMic = enabled;
        return { result: 0, param: { preferenceOnly: true, active: false, enabled } };
      }
      const actual = await this.bridge.execute('audio.setEnabled', { enabled });
      this.joinPreferences.openMic = enabled;
      return { result: 0, param: actual };
    } catch (error) { return this.rejected(error); }
  }

  async setCameraState({ state }) {
    try {
      const enabled = flag(state, 'camera state');
      const current = await this.currentMediaState();
      if (!current.joined) {
        this.joinPreferences.openCamera = enabled;
        return { result: 0, param: { preferenceOnly: true, active: false, enabled } };
      }
      const actual = await this.bridge.execute('video.setEnabled', { enabled });
      this.joinPreferences.openCamera = enabled;
      return { result: 0, param: actual };
    } catch (error) { return this.rejected(error); }
  }

  openMediaSet() { return this.run('host.settings.devices', {}); }
  openNetDetect() { return this.run('host.network.show', {}); }
  getConfWindowInfo() { return this.run('host.window.info', {}); }
  getConfWindowPic() { return this.run('host.window.capture', { save: false }); }
  async getRenderWindowInfo(params = {}) {
    let reply;
    const requestId = typeof params?.requestId === 'string' ? params.requestId : '';
    try {
      if (params?.interface === 'native-x11') {
        if (Object.keys(params).some(key => !['interface','action','requestId','conferenceId'].includes(key)) ||
            !['start','inspect','stop'].includes(params.action) ||
            params.requestId !== undefined && (!requestId || requestId.length > 128))
          throw operationError('INVALID_ARGUMENT', 'Native render surfaces require action:start/inspect/stop, not isSavePic');
        if (!this.bridge.registration || this.bridge.logoutPromise)
          throw operationError('NOT_IN_CONFERENCE', 'No registered conference owns native render surfaces');
        const {intent,generation} = this.bridge;
        const data = await this.bridge.callRegistered('host.render.surfaces', {action:params.action,
          ...(params.conferenceId === undefined ? {} : {conferenceId:params.conferenceId})});
        if (intent !== this.bridge.intent || generation !== this.bridge.generation || this.bridge.logoutPromise)
          throw operationError('CONFERENCE_CHANGED', 'The native render lease belongs to a retired conference owner');
        // Deliberately separate from the picture broadcast consumed by notes.
        return {result:0, param:{...data, requestId}};
      }
      if (!params || typeof params !== 'object' || Array.isArray(params) ||
          Object.keys(params).some(key => !['isSavePic', 'requestId', 'conferenceId'].includes(key)) ||
          params.requestId !== undefined && (!requestId || requestId.length > 128))
        throw operationError('INVALID_ARGUMENT', 'Render requests accept only isSavePic and note request/conference identity');
      const isSavePic = params.isSavePic === undefined ? false : flag(params.isSavePic, 'isSavePic');
      if (!this.bridge.registration || this.bridge.logoutPromise)
        throw operationError('NOT_IN_CONFERENCE', 'No current registered conference owns render media');
      const { intent, generation } = this.bridge;
      const data = await this.bridge.callRegistered('host.render.windows', { isSavePic,
        ...(params.conferenceId === undefined ? {} : { conferenceId: params.conferenceId }) });
      if (intent !== this.bridge.intent || generation !== this.bridge.generation || this.bridge.logoutPromise)
        throw operationError('CONFERENCE_CHANGED', 'The picture request belongs to a retired conference owner');
      reply = { result: 0, notify: 1039, description: 'OnGetRenderWindowInfoListResult',
        param: { ...data, requestId } };
    } catch (error) {
      if (params?.interface === 'native-x11')
        return this.rejected(error, {interface:'linux-native-render-surfaces/1', requestId, status:'failed',
          filePath:'', surfaces:[], nativeHandleSupported:false, handleKind:'x11-window', win32Abi:false});
      reply = { ...this.rejected(error, { requestId, status: 'failed', filePath: '', targets: [],
        nativeHandleSupported: false, handleKind: null }), notify: 1039, description: 'OnGetRenderWindowInfoListResult' };
    }
    // The pinned note consumer waits for this broadcast, not the command ACK.
    // This is a Linux adapter receipt, never a synthesized vendor HWND result.
    await this.Pedestal.sendBroadcast('broadcast://private_conference/hwm/onGetRenderWindowInfoListResult', reply);
    return reply;
  }
  setUserSavePath() { return this.run('host.paths.configure', { kind: 'recording' }); }
  setPicPath(directory) { return this.run('host.paths.configure', { kind: 'screenshots', directory }); }

  async startCall({ calleeNum, isVideo, userInfo, callRequestId }) {
    try {
      const receipt = await this.bridge.execute('call.p2p.start', {
        callee_num: calleeNum, call_type: isVideo ? 1 : 0, user_info: userInfo, callRequestId
      });
      if (receipt?.notify !== 63 || !Number.isInteger(receipt.result))
        throw operationError('CALL_UNCONFIRMED', 'No matching native start-call result');
      return { ...receipt, description: 'OnStartCallResult', dialAccepted: receipt.result === 0 && receipt.dialAccepted === true };
    } catch (error) {
      return { ...this.rejected(error), notify: 63, description: 'OnStartCallResult', dialAccepted: false,
        ...(error?.details?.callState ? { callState: error.details.callState } : {}) };
    }
  }


  async setRecordTipState(params) {
    try {
      const enabled = flag(params && params.state, 'recording confirmation');
      const receipt = await this.bridge.execute('host.ui.recordTip.configure', { enabled });
      if (!receipt || receipt.enabled !== enabled || receipt.configured !== true ||
          receipt.scope !== 'local-recording-confirmation' || receipt.grantsRecording !== false)
        throw operationError('RECORDING_TIP_UNCONFIRMED', 'The meeting owner did not confirm the recording prompt setting');
      return { result: 0, param: { ...receipt, applied: true, nativeFeature: 9 } };
    } catch (error) { return this.rejected(error); }
  }

  async answerDirectoryQuery(q) {
    const revision = this.membershipRevision;
    const target = q?.queryInfoList?.length === 1 ? q.queryInfoList[0] : null;
    const current = () => !this.logoutPending && this.store.getStore('isUserLogined') && this.membership &&
      this.membershipRevision === revision && this.membership.sessionKey === q?.sessionKey &&
      String(this.membership.conferenceId) === q.conferenceID;
    if (typeof q?.requestId !== 'string' || !/^[0-9a-f]{32}$/.test(q.requestId)) return;
    try {
      if (!current() || !target || typeof target.userUuid !== 'string' || !target.userUuid ||
          typeof target.sipNumber !== 'string' || !target.sipNumber) throw new Error('Invalid directory query');
      const contacts = await this.Pedestal.callMethod('method://contact/getContactListByAccountList', {
        list: [target.userUuid], entry: 'module_hwm_getUserDepartmentInfo', timeout: 35000
      });
      if (!current()) throw new Error('Meeting changed');
      const result = await this.setCorpDepartMentInfo(nativeDirectoryReply(target, contacts), q.requestId);
      if (result.result !== 0) throw new Error('Directory reply retired');
    } catch (_) {
      // No local name, phone or exception from the address book crosses to the hosted page or logs.
      try { await this.bridge.callRegistered('host.directory.failed', { requestId: q.requestId }); } catch (_) { /* Retired owner. */ }
    }
  }

  async setCorpDepartMentInfo(reply, requestId) {
    if (typeof requestId !== 'string' || !/^[0-9a-f]{32}$/.test(requestId))
      return this.rejected(operationError('DIRECTORY_QUERY_REQUIRED', 'No matching participant-directory request'));
    try {
      const receipt = await this.bridge.callRegistered('host.directory.answer', { requestId, reply });
      if (receipt?.applied !== true) throw operationError('DIRECTORY_UNCONFIRMED', 'The local result was not displayed');
      return { result: 0, param: receipt };
    } catch (error) { return this.rejected(error); }
  }

  async setLogPath(params) {
    try {
      const data = await this.bridge.configureMediaLog(params && params.logPath);
      return { result: 0, param: data };
    } catch (error) { return this.rejected(error); }
  }

  async agreeVoiceprintStatement(isAgreed = false) {
    try {
      if (typeof isAgreed !== 'boolean') throw operationError('INVALID_ARGUMENT', 'Expected a voiceprint consent decision');
      const data = await this.bridge.voiceCommand('agree', isAgreed);
      if (data?.consentUpdated !== true || data.isAgreed !== isAgreed || (!isAgreed &&
          (data.voiceprintDeleted !== true || data.grantDeleted !== true || data.voiceShieldDisabled !== true)))
        throw operationError('VOICE_CONSENT_UNCONFIRMED', 'Local consent, deletion or audio cleanup was not confirmed');
      return { result: 0, param: { ...data, nativeCommand: 1047 } };
    } catch (error) { return this.rejected(error); }
  }

  async showVoiceprintRecordWindow(isShow = false) {
    try {
      if (typeof isShow !== 'boolean') throw operationError('INVALID_ARGUMENT', 'Expected a recorder visibility flag');
      const data = await this.bridge.voiceCommand('show', isShow);
      if (data?.visible !== isShow || data.recordingStarted !== false)
        throw operationError('VOICE_WINDOW_UNCONFIRMED', 'The local recorder did not confirm the requested visibility');
      return { result: 0, param: { ...data, nativeCommand: 1048 } };
    } catch (error) { return this.rejected(error); }
  }

  async configVoiceprintRecordWindow({ readingTextList = [] } = {}) {
    try {
      const data = await this.bridge.voiceCommand('configure', { readingTextList });
      if (data?.promptsStored !== true || data.promptCount !== readingTextList.length)
        throw operationError('VOICE_PROMPTS_UNCONFIRMED', 'The local recorder did not accept the prompts');
      return { result: 0, param: { ...data, nativeCommand: 1049 } };
    } catch (error) { return this.rejected(error); }
  }

  async setEnableCapability(params = {}) {
    try {
      const { type, isEnable, definition } = nativeCapabilities.validate(params);
      if (!definition.supported && type !== 13) throw nativeCapabilities.unavailable(type, isEnable);
      const actual = await this.bridge.execute('host.capability.configure', { type, isEnable });
      if (!actual || actual.configured !== true || actual.type !== type || actual.enabled !== isEnable ||
          actual.capability !== definition.capability || typeof actual.scope !== 'string' || !actual.scope ||
          actual.serverPermissionGranted !== false || actual.osPermissionGranted !== false)
        throw operationError('CAPABILITY_ENFORCEMENT_UNCONFIRMED', 'The owner did not confirm enforcement of the requested private capability');
      return { result: 0, param: { ...actual, nativeCommand: 1050, applied: true,
        enumType: 'HwmSDKCapabilityType', serverCapabilityAcknowledged: false } };
    } catch (error) { return this.rejected(error, { applied: false }); }
  }

  async getErrorMessage({ code } = {}) {
    if (this.lastFailure && String(code) === String(this.lastFailure.code))
      return { result: 0, errMessage: this.lastFailure.reason, source: 'observed-operation-error' };
    const boundary = Object.values(NATIVE_BOUNDARIES).find(([key]) => String(code) === key);
    if (boundary) return { result: 0, errMessage: boundary[1], source: 'native-capability-boundary' };
    const numeric = typeof code === 'number' ? code :
      typeof code === 'string' && /^-?(?:0|[1-9]\d*)$/.test(code) && String(Number(code)) === code ? Number(code) : NaN;
    if (Number.isInteger(numeric) && numeric >= -2147483648 && numeric <= 2147483647 && this.bridge.mediaReady) {
      try {
        const found = await this.bridge.callRegistered('error.describe', { code: numeric });
        if (found?.source === 'active-meeting-provider' && typeof found.errMessage === 'string' && found.errMessage)
          return { result: 0, ...found };
      } catch (_) { /* Owner retirement is not a successful lookup. */ }
    }
    const message = 'No verified error description is available for code ' + String(code);
    return { result: 1, param: { reason_code: 'NATIVE_ERROR_CATALOG_UNAVAILABLE', reason: message },
      errMessage: message, source: 'unavailable-native-error-catalog' };
  }

  async setWaterMark(params) {
    try {
      if (!params || typeof params.content !== 'string')
        throw operationError('INVALID_WATERMARK_POLICY', 'The account/tenant watermark content must be supplied explicitly');
      const color = typeof params.color === 'number' ? WATERMARK_COLORS[params.color] : params.color;
      if (params.content && !WATERMARK_COLORS.includes(color))
        throw operationError('INVALID_WATERMARK_POLICY', 'The original watermark color index does not identify an allowed color');
      const actual = await this.bridge.execute('watermark.set', { content: params.content, color });
      if (!actual || actual.ready !== true || actual.configured !== true)
        throw operationError('WATERMARK_ENFORCEMENT_UNCONFIRMED', 'The actual document did not confirm rendered watermark enforcement');
      return { result: 0, param: { ...actual, scope: 'local-rendered-policy', serverCapabilityAcknowledged: false } };
    } catch (error) { return this.rejected(error); }
  }

  async buildUiPatch(method, args = []) {
    if (!UI_METHODS.has(method)) throw operationError('INVALID_UI_METHOD', 'Unknown original UI configuration builder');
    const membership = this.membership;
    const revision = this.membershipRevision;
    if (method === 'sendUpdateOneRoomConfigUISdk' && !membership)
      return { patch: { isUserLogined: !!this.store.getStore('isUserLogined'), customButtonStatus: null }, unavailable: [] };
    const envelope = await this.sdk[method].apply(this.uiBuilder, args);
    if (method === 'sendUpdateOneRoomConfigUISdk' && revision !== this.membershipRevision)
      throw operationError('CONFERENCE_CHANGED', 'The room policy was calculated for a retired membership');
    const toolbar = envelope && envelope.param && envelope.param.frame && envelope.param.frame.confMenu &&
      envelope.param.frame.confMenu.toolBar;
    if (!toolbar || envelope.description !== 'tup_config_uisdk')
      throw operationError('UI_BUILDER_CONTRACT_CHANGED', 'The original module 31 UI configuration builder returned an unknown contract');
    const patch = { isUserLogined: method === 'sendCancelConfigUISdk' ? false : !!this.store.getStore('isUserLogined') };
    const unavailable = [];
    const evidence = this.store.getStore('nativeMeetingDetails');
    if (method === 'sendUpdateOneRoomConfigUISdk' && (!evidence || !evidence.tenantClassificationConfirmed))
      unavailable.push({ buttonId: 'listenAndNote', reason: 'TENANT_CLASSIFICATION_UNCONFIRMED' });
    if (Array.isArray(toolbar.button)) {
      const buttons = [];
      for (const button of toolbar.button) {
        if (!UI_CONTROLS.has(button.id) || button.id === 'attendee_access_control' && button.showAsAction !== 'never')
          unavailable.push({ buttonId: button.id, requested: button, reason: 'NATIVE_TOOLBAR_CONTROL_UNAVAILABLE' });
        else buttons.push({ ...button });
      }
      if (buttons.length) patch.toolBar = { button: buttons };
    }
    if (method === 'sendCancelConfigUISdk') patch.customButtonStatus = null;
    if (Array.isArray(toolbar.customButton)) {
      if (!this.membership || !membership || membership.sessionKey !== this.membership.sessionKey)
        throw operationError('CONFERENCE_CHANGED', 'The original room configuration belongs to a retired meeting');
      const minutes = toolbar.customButton.find(button => button.id === 'minutes');
      const note = toolbar.customButton.find(button => button.id === 'listenAndNote');
      const labels = {};
      const room = { sessionKey: membership.sessionKey, minutes: 'hidden', listenAndNote: !!note };
      if (minutes) {
        const start = this.sdk.getCustomMinutesData(1).find(button => button.id === 'minutes');
        const pause = this.sdk.getCustomMinutesData(2).find(button => button.id === 'minutes');
        if (start && minutes.title === start.title && minutes.buttonImg === start.buttonImg) room.minutes = 'start';
        else if (pause && minutes.title === pause.title && minutes.buttonImg === pause.buttonImg) room.minutes = 'pause';
        else throw operationError('UI_BUILDER_CONTRACT_CHANGED', 'The original minutes button has no known start/pause mapping');
        labels[room.minutes === 'start' ? 'startMinutes' : 'pauseMinutes'] = { zh: minutes.title, en: minutes.title };
      }
      if (note) {
        const info = this.store.getStore('confInfo');
        if (!evidence || !evidence.tenantClassificationConfirmed || !info || info.isOtherCorpConf !== false) {
          room.listenAndNote = false;
          unavailable.push({ buttonId: 'listenAndNote', reason: 'TENANT_CLASSIFICATION_UNCONFIRMED' });
        } else labels.listenAndNote = { zh: note.title, en: note.title };
      }
      if (Object.keys(labels).length) room.labels = labels;
      patch.customButtonStatus = room;
      for (const button of toolbar.customButton) if (button.buttonPos === 2)
        unavailable.push({ buttonId: button.id, reason: 'NATIVE_SHARING_TOOLBAR_UNAVAILABLE' });
    }
    return { patch, unavailable };
  }

  configureUi(method, args) {
    // Module 422 dispatches several patches concurrently. Serialize them so a
    // later detail/feedback patch cannot supersede initial login enforcement.
    const intent = this.bridge.intent;
    const pending = this.uiQueue.then(async () => {
      try {
        if (intent !== this.bridge.intent || this.logoutPending)
          throw operationError('SESSION_CHANGED', 'The queued UI policy was retired by logout');
        const { patch, unavailable } = await this.buildUiPatch(method, args);
        if (intent !== this.bridge.intent || this.logoutPending)
          throw operationError('SESSION_CHANGED', 'The UI policy was retired by logout');
        const onlyUnsupported = unavailable.length && !patch.toolBar && !Object.prototype.hasOwnProperty.call(patch, 'customButtonStatus');
        if (onlyUnsupported) return this.rejected(operationError('UI_CONTROL_UNAVAILABLE',
          'The requested native toolbar control has no WebRTC binding', { unavailable }), { applied: false });
        const actual = await this.bridge.execute('ui.configure', patch);
        if (!actual || actual.ready !== true || actual.configured !== true ||
            !actual.configuration || actual.configuration.customButtonStatus !== null)
          throw operationError('UI_ENFORCEMENT_UNCONFIRMED', 'The provider did not return a persistent confirmed UI configuration');
        const metadata = { method, enforcement: actual, scope: 'local-rendered-policy',
          serverCapabilityAcknowledged: false, nativeFrameCustomization: false, unavailable };
        if (unavailable.length) return this.rejected(operationError('UI_POLICY_PARTIAL',
          'Supported controls were enforced; the listed native controls are unavailable'), { ...metadata, applied: true });
        return { result: 0, param: metadata };
      } catch (error) { return this.rejected(error); }
    });
    this.uiQueue = pending.then(() => {});
    return pending;
  }

  sendConfigUISdk() { return this.configureUi('sendConfigUISdk'); }
  sendCancelConfigUISdk() { return this.configureUi('sendCancelConfigUISdk'); }
  sendCancelFeedbackConfigUISdk() { return this.configureUi('sendCancelFeedbackConfigUISdk'); }
  sendUpdateOneRoomConfigUISdk() { return this.configureUi('sendUpdateOneRoomConfigUISdk'); }
  sendOpenDetailConfigUISdk(value = true) { return this.configureUi('sendOpenDetailConfigUISdk', [value]); }
  sendExtMeetingConfigUISdk(value = true) { return this.configureUi('sendExtMeetingConfigUISdk', [value]); }
  sendGuestInviteBtnShowConfigUISdk() { return this.configureUi('sendGuestInviteBtnShowConfigUISdk'); }
  callOtherNumBtnConfigUISdk() { return this.configureUi('callOtherNumBtnConfigUISdk'); }

  async newJoinConfByLink(params) {
    const reply = await this.run('conference.joinLink', params);
    const param = reply.result === 0 ? { reason_code: 0, reason: '', state: reply.param } : reply.param;
    await this.Pedestal.sendBroadcast('broadcast://private_conference/hwm/notifyCheckAnonymouseJoinConf', param);
    return { ...reply, notify: 102, description: 'OnAnonymousEnterConfByVerifyLinkResult', param };
  }

  async setShareScreenPermission(allowed = true) {
    try {
      const actual = await this.bridge.execute('screen.setPermission', { allowed: flag(allowed, 'screen sharing permission') });
      return { result: 0, param: { ...actual, scope: 'application-local-capture-override',
        serverPermissionGranted: false, osPermissionGranted: false } };
    } catch (error) { return this.rejected(error); }
  }

  setShowMeetingWindow() { return this.run('window.show'); }
}

module.exports = {
  createService(options) {
    if (!instance) instance = new LinuxConferenceService(options);
    return instance;
  }
};
