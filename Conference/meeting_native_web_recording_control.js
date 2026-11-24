'use strict';

/* Authoritative local-record control, recovered from HIT APP HwmSdk 100.10.5:
 * tup_confctrl.dll uportal_ReportClientRecordState (0x10069710):
 *   LocalNotify/ParticipantInfoNotify, pinfoMap.ClientRecState = 0/1.
 * uportal_AllowAttendeeRecordImpl (0x10030750):
 *   ConfControl/ALLOWCLIENTRECORD, participantID + allowClientRecord.
 * uportal_RequestLocalRecordPermission (0x1006a4c0) and answer (0x100316b0):
 *   CUSTOM_TRANS with the exact LOCAL_RECORD_PERMISSION_REQUST spelling.
 * Native request selects a host/cohost advertising capability 19. Native
 * dealClientCapabilities (0x100269d0) maps local-record support to 8 and request
 * support to 19. No authorization is manufactured from those capability bits.
 * The real server's own ALLOW_CLIENT_REC and supportClientRecord remain decisive.
 * No MediaRecorder, file writer, or synthetic media is implemented in this layer.
 */
(() => {
  if (window.__welinkCreateNativeRecordingControl) return;
  const REQUEST = 'LOCAL_RECORD_PERMISSION_REQUST';
  const ANSWER = 'ANSWER_LOCAL_RECORD_PERMISSION_REQUEST';
  const has = (object, key) => object && Object.prototype.hasOwnProperty.call(object, key);
  const numericFlag = value => value === true || value === 1 || value === '1' ? true :
    value === false || value === 0 || value === '0' ? false : null;
  const identity = value => value === null || value === undefined ? '' : String(value);
  const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
  const error = (code, message, details) => Object.assign(new Error(message), { code, details });

  window.__welinkCreateNativeRecordingControl = function ({ vendor, getSession, emit, promptPermission }) {
    if (!vendor || typeof vendor.getWebsocket !== 'function' || typeof vendor.uuid !== 'function' ||
        typeof getSession !== 'function' || typeof vendor.store?.subscribe !== 'function')
      throw error('RECORD_CONTROL_ABI_UNAVAILABLE', 'The genuine CMS control bindings are absent');
    let disposed = false;
    let recorderAvailable = false;
    let recordingEnabled = true, requestsEnabled = true;
    let outgoing = null;
    let lastAuthorization = '';
    const controls = new Map();
    const incoming = new Map();
    const watchers = new Set();
    const sockets = new Map();

    function facts() {
      const state = vendor.store.getState();
      const own = vendor.selectors.selectOwn(state);
      const collection = own.role === vendor.constants.AUDIENCE
        ? vendor.selectors.selectAudiences(state) : vendor.selectors.selectParticipants(state);
      const actor = collection && collection[own.id];
      const basic = vendor.selectors.selectConfBasicInfo(state) || {};
      const dynamic = vendor.selectors.selectConfDynamicInfo(state) || {};
      const info = vendor.selectors.selectConfInitData(state) || {};
      const session = getSession();
      return { state, own, actor, basic, dynamic, info, session };
    }
    function manager(f) {
      return f.own.role === vendor.constants.HOST || numericFlag(f.actor?.pinfoMap?.IS_COHOST) === true;
    }
    function authorization(snapshot) {
      const f = facts();
      if (!recordingEnabled) return { state: 'denied', reason: 'NATIVE_CAPABILITY_DISABLED',
        sessionKey: f.session.sessionKey || '' };
      if (disposed || !f.session.joined || !f.session.sessionKey ||
          snapshot && snapshot.sessionKey !== f.session.sessionKey)
        return { state: 'unknown', reason: 'CONFERENCE_NOT_ACTIVE', sessionKey: f.session.sessionKey || '' };
      const supported = numericFlag(f.basic.supportClientRecord);
      const permission = numericFlag(f.actor?.pinfoMap?.ALLOW_CLIENT_REC);
      if (supported === false) return { state: 'denied', reason: 'SERVER_LOCAL_RECORD_DISABLED', sessionKey: f.session.sessionKey };
      if (supported === null || permission === null)
        return { state: 'unknown', reason: 'SERVER_RECORD_PERMISSION_NOT_RECEIVED', sessionKey: f.session.sessionKey };
      return { state: permission ? 'allowed' : 'denied',
        reason: permission ? 'SERVER_GRANTED' : 'HOST_PERMISSION_REQUIRED',
        sessionKey: f.session.sessionKey, clientRecMode: f.dynamic.clientRecMode };
    }
    function assertSession(expected) {
      const f = facts();
      if (disposed || !f.session.joined || !f.info.conferenceID || !f.info.participantID ||
          expected && expected !== f.session.sessionKey)
        throw error('CONFERENCE_CHANGED', 'The authenticated recording conference is no longer active');
      return f;
    }
    function ensureSignal(signal) {
      if (signal?.aborted) throw error('ABORTED', 'The recording control operation was canceled');
    }
    function packet(action, type, data) {
      return { action, type, sequence: vendor.uuid(), data: JSON.stringify(data) };
    }
    function send(message, expected, signal) {
      ensureSignal(signal);
      assertSession(expected);
      const socket = vendor.getWebsocket();
      if (!socket || socket.readyState !== WebSocket.OPEN)
        throw error('CMS_TRANSPORT_OFFLINE', 'The real conference-control connection is not open');
      watchSocket(socket);
      socket.send(JSON.stringify(message));
      return { confirmed: true, scope: 'transport-accepted', sequence: message.sequence };
    }
    function publish(event, data) {
      if (typeof emit === 'function') Promise.resolve(emit(event, data)).catch(() => {});
    }
    function waitState(predicate, sessionKey, signal, timeout = 30000) {
      return new Promise((resolve, reject) => {
        let timer, settled = false;
        const finish = (failure, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          watchers.delete(check);
          signal?.removeEventListener('abort', aborted);
          failure ? reject(failure) : resolve(value);
        };
        const aborted = () => finish(error('ABORTED', 'The recording control operation was canceled'));
        const check = () => {
          try {
            ensureSignal(signal);
            const f = assertSession(sessionKey);
            const value = predicate(f);
            if (value) finish(null, value);
          } catch (failure) { finish(failure); }
        };
        timer = setTimeout(() => finish(error('CONTROL_TIMEOUT', 'The real recording state change was not confirmed')), timeout);
        watchers.add(check);
        signal?.addEventListener('abort', aborted, { once: true });
        check();
      });
    }
    function requestControl(type, data, sessionKey, signal) {
      const request = packet(vendor.constants.CONF_MSG_TYPE.CONF_CONTROL, type, data);
      return new Promise((resolve, reject) => {
        let timer;
        const finish = (failure, value) => {
          if (!controls.delete(request.sequence)) return;
          clearTimeout(timer);
          signal?.removeEventListener('abort', aborted);
          failure ? reject(failure) : resolve(value);
        };
        const aborted = () => finish(error('ABORTED', 'The recording control request was canceled'));
        controls.set(request.sequence, { type, sessionKey, finish, socket: vendor.getWebsocket() });
        timer = setTimeout(() => finish(error('CONTROL_TIMEOUT', 'No genuine CMS recording-control response arrived')), 30000);
        signal?.addEventListener('abort', aborted, { once: true });
        try { send(request, sessionKey, signal); }
        catch (failure) { finish(failure); }
      });
    }
    function controlData(f, participantID) {
      const token = vendor.selectors.selectLoginInfo(f.state)?.accessToken;
      if (typeof token !== 'string' || !token) throw error('AUTH_REQUIRED', 'The actual meeting token is absent');
      return { conferenceID: f.info.conferenceID, participantID, confToken: 'Basic ' + btoa(token) };
    }
    function member(f, participantId) {
      const lists = [vendor.selectors.selectParticipants(f.state), vendor.selectors.selectAudiences(f.state)];
      for (const list of lists) {
        const found = Object.values(list || {}).find(value => identity(value.pid) === identity(participantId));
        if (found) return found;
      }
      return null;
    }
    async function grant({ participantId, allowed, signal } = {}) {
      if (typeof allowed !== 'boolean' || !identity(participantId)) throw error('INVALID_ARGUMENT', 'A real participant ID and boolean grant are required');
      const f = assertSession();
      if (!manager(f)) throw error('HOST_PERMISSION_REQUIRED', 'Only the current host/cohost may change recording grants');
      if (numericFlag(f.basic.supportClientRecord) !== true)
        throw error('SERVER_LOCAL_RECORD_UNAVAILABLE', 'The server has not enabled local recording for this conference');
      if (!member(f, participantId)) throw error('PARTICIPANT_NOT_FOUND', 'The target is not in the actual conference');
      const data = { ...controlData(f, identity(participantId)), allowClientRecord: allowed ? 1 : 0 };
      await requestControl('ALLOWCLIENTRECORD', data, f.session.sessionKey, signal);
      return waitState(current => {
        const target = member(current, participantId);
        if (!target) throw error('PARTICIPANT_LEFT', 'The recording-grant target left the conference');
        return numericFlag(target.pinfoMap?.ALLOW_CLIENT_REC) === allowed
          ? { confirmed: true, participantId: identity(participantId), allowed, source: 'server-participant-state' } : false;
      }, f.session.sessionKey, signal);
    }
    function supportsRequests(value) {
      const map = value.pinfoMap || {};
      const raw = has(map, 'CLIENT_CAPABILITIES_V2') ? map.CLIENT_CAPABILITIES_V2 : map.CLIENT_CAPABILITIES;
      return typeof raw === 'string' && raw.split(',').includes('19');
    }
    function recipient(f) {
      const members = Object.values(vendor.selectors.selectParticipants(f.state) || {});
      const eligible = value => identity(value.pid) !== identity(f.info.participantID) && supportsRequests(value);
      return members.find(value => eligible(value) && identity(value.pinfoMap?.ROLE) === identity(vendor.constants.HOST)) ||
        members.find(value => eligible(value) && numericFlag(value.pinfoMap?.IS_COHOST) === true);
    }
    function requestPermission({ signal, timeoutMs = 120000 } = {}) {
      if (!requestsEnabled || !recordingEnabled)
        throw error('NATIVE_CAPABILITY_DISABLED', 'The local application disabled recording or recording-permission requests');
      const f = assertSession();
      ensureSignal(signal);
      const current = authorization(f.session);
      if (current.state === 'allowed') return Promise.resolve({ allowed: true, source: 'server-participant-state' });
      if (numericFlag(f.basic.supportClientRecord) === false) throw error('SERVER_LOCAL_RECORD_DISABLED', 'The conference does not permit local recording');
      if (numericFlag(f.basic.supportClientRecord) === null)
        throw error('SERVER_RECORD_PERMISSION_NOT_RECEIVED', 'The real recording policy has not arrived');
      if (manager(f)) throw error('SERVER_RECORD_PERMISSION_NOT_RECEIVED', 'Host permission must come from the real server state, not a local override');
      if (outgoing) throw error('PERMISSION_REQUEST_PENDING', 'A real recording-permission request is already pending');
      const target = recipient(f);
      if (!target) throw error('NO_SUPPORTED_RECORD_HOST', 'No current host/cohost advertises the genuine local-record request capability');
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw error('INVALID_ARGUMENT', 'Permission timeout must be positive');
      const request = packet(vendor.constants.CONF_MSG_TYPE.CONF_CONTROL, vendor.constants.CONF_CONTROL_TYPE.CUSTOM_TRANS, {});
      request.data = JSON.stringify({ conferenceID: f.info.conferenceID, from: identity(f.info.participantID),
        transType: 0, participants: [identity(target.pid)], msgType: 0, msgID: REQUEST,
        msg: JSON.stringify({ requestLocalRecordPermission: 1, sequence: request.sequence }) });
      return new Promise((resolve, reject) => {
        let timer;
        const finish = (failure, value) => {
          if (!outgoing || outgoing.id !== request.sequence) return;
          outgoing = null;
          clearTimeout(timer);
          signal?.removeEventListener('abort', aborted);
          failure ? reject(failure) : resolve(value);
        };
        const aborted = () => finish(error('ABORTED', 'The recording-permission request was canceled'));
        outgoing = { id: request.sequence, sessionKey: f.session.sessionKey, recipient: identity(target.pid), finish };
        timer = setTimeout(() => finish(error('PERMISSION_REQUEST_TIMEOUT', 'The host did not grant recording permission')), timeoutMs);
        signal?.addEventListener('abort', aborted, { once: true });
        try { send(request, f.session.sessionKey, signal); }
        catch (failure) { finish(failure); }
      });
    }
    async function answerPermission({ requestId, allow, signal } = {}) {
      if (!requestsEnabled) throw error('NATIVE_CAPABILITY_DISABLED', 'Local-record permission requests are disabled');
      if (typeof allow !== 'boolean') throw error('INVALID_ARGUMENT', 'The user must explicitly approve or refuse recording');
      const saved = incoming.get(requestId);
      if (!saved) throw error('PERMISSION_REQUEST_NOT_FOUND', 'The real recording-permission request is no longer pending');
      const f = assertSession(saved.sessionKey);
      if (!manager(f)) throw error('HOST_PERMISSION_REQUIRED', 'The local user no longer has host/cohost rights');
      if (!member(f, saved.participantId)) throw error('PARTICIPANT_LEFT', 'The requesting participant left');
      if (allow) await grant({ participantId: saved.participantId, allowed: true, signal });
      if (!requestsEnabled || incoming.get(requestId) !== saved)
        throw error('PERMISSION_REQUEST_NOT_FOUND', 'The recording-permission prompt was retired');
      const request = packet(vendor.constants.CONF_MSG_TYPE.CONF_CONTROL, vendor.constants.CONF_CONTROL_TYPE.CUSTOM_TRANS, {});
      request.data = JSON.stringify({ conferenceID: f.info.conferenceID, from: identity(f.info.participantID),
        transType: 0, participants: [saved.participantId], msgType: 0, msgID: ANSWER,
        msg: JSON.stringify({ answerType: allow ? 1 : 0, sequence: request.sequence }) });
      const result = send(request, saved.sessionKey, signal);
      incoming.delete(requestId);
      publish('recording-permission-answer', { requestId, participantId: saved.participantId, allowed: allow });
      return { ...result, allowed: allow };
    }
    async function reportStatus({ sessionKey, state, signal } = {}) {
      const f = assertSession(sessionKey);
      if (state !== 'recording' && state !== 'stopped') throw error('INVALID_ARGUMENT', 'Unknown local-record state');
      if (state === 'recording' && authorization(f.session).state !== 'allowed')
        throw error('LOCAL_RECORD_PERMISSION_REQUIRED', 'The real server has not granted local recording');
      const data = { ...controlData(f, f.info.participantID), pinfoMap: { ClientRecState: state === 'recording' ? 1 : 0 } };
      return send(packet(vendor.constants.CONF_MSG_TYPE.LOCAL_NOTIFY,
        vendor.constants.LOCAL_NOTIFY_TYPE.PARTICIPANT_INFO_NOTIFY, data), sessionKey, signal);
    }
    function changed() {
      if (disposed) return;
      const current = authorization();
      const encoded = JSON.stringify(current);
      if (encoded !== lastAuthorization) {
        lastAuthorization = encoded;
        publish('recording-authorization', current);
      }
      if (outgoing) {
        if (current.sessionKey !== outgoing.sessionKey || !getSession().joined)
          outgoing.finish(error('CONFERENCE_CHANGED', 'The recording-permission request conference ended'));
        else if (current.state === 'allowed') outgoing.finish(null, { allowed: true, source: 'server-participant-state' });
      }
      for (const pending of Array.from(controls.values()))
        if (!getSession().joined || pending.sessionKey !== current.sessionKey)
          pending.finish(error('CONFERENCE_CHANGED', 'The recording control conference ended'));
      for (const [id, request] of incoming)
        if (!getSession().joined || request.sessionKey !== current.sessionKey) incoming.delete(id);
      for (const check of Array.from(watchers)) check();
    }
    function received(message) {
      if (disposed || !message || typeof message !== 'object') return;
      let data;
      try { data = parse(message.data); } catch { return; }
      if (!data || typeof data !== 'object') return;
      const pending = controls.get(message.sequence);
      if (pending && message.type === pending.type && has(data, 'returnCode')) {
        try {
          assertSession(pending.sessionKey);
          if (data.returnCode === 0 || data.returnCode === '0') pending.finish(null, data);
          else pending.finish(error(data.returnCode, data.returnDesc || 'The real CMS recording control failed'));
        } catch (failure) { pending.finish(failure); }
      }
      if (outgoing && message.sequence === outgoing.id && has(data, 'returnCode') && data.returnCode !== 0 && data.returnCode !== '0')
        outgoing.finish(error(data.returnCode, data.returnDesc || 'The recording-permission request failed'));
      if (message.type !== vendor.constants.CONF_CONTROL_TYPE.CUSTOM_TRANS || data.msgID !== REQUEST && data.msgID !== ANSWER) return;
      let body, f;
      try { body = parse(data.msg); f = assertSession(); } catch { return; }
      if (!body || identity(data.conferenceID) !== identity(f.info.conferenceID) || !member(f, data.from) ||
          has(data, 'to') && identity(data.to) !== identity(f.info.participantID)) return;
      if (data.msgID === ANSWER) {
        if (outgoing && outgoing.sessionKey === f.session.sessionKey && outgoing.recipient === identity(data.from)) {
          if (body.answerType === 0 || body.answerType === '0') outgoing.finish(error('LOCAL_RECORD_PERMISSION_DENIED', 'The host refused local recording'));
          else if (body.answerType === 1 || body.answerType === '1') changed(); // An answer is not a server permission grant.
        }
        return;
      }
      if (!requestsEnabled || !manager(f) || numericFlag(body.requestLocalRecordPermission) !== true || !identity(body.sequence)) return;
      const id = identity(body.sequence);
      if (incoming.has(id)) return;
      const participant = member(f, data.from);
      const request = { requestId: id, participantId: identity(data.from), conferenceID: f.info.conferenceID,
        name: participant.pinfoMap?.NAME || '', sessionKey: f.session.sessionKey };
      incoming.set(id, request);
      publish('recording-permission-request', request);
      if (typeof promptPermission === 'function') {
        Promise.resolve(promptPermission(request)).then(allow => answerPermission({ requestId: id, allow: allow === true }))
          .catch(failure => publish('recording-permission-answer-error', { requestId: id, code: failure.code || 'PERMISSION_REPLY_FAILED' }));
      }
    }
    /* onConfMessage Redux actions only carry ConfControl/Subscribe responses,
     * not LocalNotify CUSTOM_TRANS. Listen to the same real native WebSocket
     * used by the vendor, without replacing its existing onmessage handler. */
    function watchSocket(socket) {
      if (!socket || sockets.has(socket) || disposed) return;
      if (typeof socket.addEventListener !== 'function')
        throw error('RECORD_CONTROL_ABI_UNAVAILABLE', 'The verified CMS socket is not a native WebSocket');
      const message = event => {
        if (socket !== vendor.getWebsocket() || typeof event.data !== 'string') return;
        try { received(JSON.parse(event.data)); } catch (failure) {
          publish('recording-control-error', { code: failure.code || 'INVALID_RECORD_CONTROL_MESSAGE' });
        }
      };
      const closed = () => {
        socket.removeEventListener('message', message);
        socket.removeEventListener('close', closed);
        sockets.delete(socket);
        for (const pending of Array.from(controls.values()))
          if (pending.socket === socket)
            pending.finish(error('CMS_TRANSPORT_CLOSED', 'The actual recording control connection closed'));
      };
      sockets.set(socket, { message, closed });
      socket.addEventListener('message', message);
      socket.addEventListener('close', closed);
    }
    const unsubscribe = vendor.store.subscribe(changed);
    const originalSend = WebSocket.prototype.send;
    function advertise(data) {
      if (!disposed && this === vendor.getWebsocket()) watchSocket(this);
      if (!disposed && this === vendor.getWebsocket() && typeof data === 'string') {
        let outgoing;
        try { outgoing = JSON.parse(data); } catch { return originalSend.call(this, data); }
        if (outgoing.action === vendor.constants.CONF_MSG_TYPE.CONF_CONTROL && outgoing.type === vendor.constants.CONF_CONTROL_TYPE.JOIN_RTC_CONF ||
            outgoing.action === vendor.constants.CONF_MSG_TYPE.SUBSCRIBE) {
          const body = parse(outgoing.data);
          if (!body || typeof body.clientCapabilities !== 'string') throw error('RECORD_CONTROL_ABI_UNAVAILABLE', 'The real join capability shape changed');
          const capabilities = new Set(body.clientCapabilities.split(',').filter(Boolean));
          if (recorderAvailable && recordingEnabled) capabilities.add('8');
          else capabilities.delete('8');
          if (requestsEnabled && typeof promptPermission === 'function') capabilities.add('19');
          else capabilities.delete('19');
          body.clientCapabilities = Array.from(capabilities).join(',');
          data = JSON.stringify({ ...outgoing, data: JSON.stringify(body) });
        }
      }
      return originalSend.call(this, data);
    }
    WebSocket.prototype.send = advertise;
    watchSocket(vendor.getWebsocket());
    function capabilities() {
      const f = facts();
      return { controlAvailable: !disposed, recorderAvailable: recorderAvailable && recordingEnabled,
        recordingEnabled, requestsEnabled, authorization: authorization(f.session),
        canRequestPermission: !!(recordingEnabled && requestsEnabled && f.session.joined && !manager(f) &&
          numericFlag(f.basic.supportClientRecord) === true && recipient(f)),
        canGrant: !!(f.session.joined && manager(f) && numericFlag(f.basic.supportClientRecord) === true),
        transportOpen: vendor.getWebsocket()?.readyState === WebSocket.OPEN,
        statusReportScope: 'transport-accepted', clientCapabilityIds: { localRecord: '8', permissionRequest: '19' } };
    }
    function configureCapability(type, enabled) {
      if (disposed) throw error('DISPOSED', 'The recording control owner was retired');
      if (typeof enabled !== 'boolean' || type !== 6 && type !== 9)
        throw error('INVALID_ARGUMENT', 'Expected local-recording or local-record-request capability');
      if (type === 6) recordingEnabled = enabled;
      else requestsEnabled = enabled;
      if (!enabled) {
        if (outgoing) outgoing.finish(error('NATIVE_CAPABILITY_DISABLED', 'Recording permission requests were disabled'));
        if (type === 9) incoming.clear(); // A later answer cannot grant permission for a retired prompt.
      }
      changed();
      return { configured: true, type, enabled };
    }
    function dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      for (const [socket, listeners] of sockets) {
        socket.removeEventListener('message', listeners.message);
        socket.removeEventListener('close', listeners.closed);
      }
      sockets.clear();
      if (WebSocket.prototype.send === advertise) WebSocket.prototype.send = originalSend;
      if (outgoing) outgoing.finish(error('DISPOSED', 'The recording controller was disposed'));
      for (const pending of Array.from(controls.values())) pending.finish(error('DISPOSED', 'The recording controller was disposed'));
      for (const check of Array.from(watchers)) check();
      incoming.clear();
    }
    return Object.freeze({ authorization, reportStatus, requestPermission, answerPermission, grant, capabilities, dispose,
      configureCapability, setRecordingAvailable(value) { recorderAvailable = value === true; } });
  };
})();
