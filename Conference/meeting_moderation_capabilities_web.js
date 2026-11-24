/* Actual WebRTC moderation consumers, pinned to main.3ee85ed7 modules
 * 51361/86989 (CMS), 2500/491 (device invitation actions/workers), 58909
 * (ANSWER_MUTE/ANSWER_VIDEO), 7283 (host controls). CO_HOST/isCohost is the
 * Windows 100.10.5 tup_confctrl uportal_ApplyCoHost wire format (RVA 0x6DC80).
 * Server roles, waiting-room orders and forced-close orders are never filtered.
 */
(() => {
  'use strict';
  if (window.__welinkCreateModerationCapabilities) return;
  window.__welinkCreateModerationCapabilities = function ({ vendor, loadModule, getSession, setMedia, onViolation }) {
    const api = window.__welinkModerationCapabilities, c = vendor.constants, store = vendor.store;
    if (!api || typeof getSession !== 'function' || typeof setMedia !== 'function')
      throw new Error('The shared moderation policy and genuine media owner are required');
    const { error, flag, supports } = api, policy = api.createPolicy(), actions = loadModule(2500);
    for (const [key, id] of Object.entries({ WAITING_ROOM: '4', INVITE_OPEN_MICROPHONE: '10', INVITE_OPEN_CAMERA: '11', HOST_CLOSE_CAMERA: '12' }))
      if (c.CLIENT_CAPABILITIES?.[key] !== id) throw error('CAPABILITY_ABI_MISMATCH', 'Moderation wire binding changed: ' + key);
    for (const key of ['sendInviteOpenMicrophoneToCms', 'sendInviteOpenCameraToCms', 'sendSubscribe'])
      if (typeof vendor.common[key] !== 'function') throw error('CAPABILITY_ABI_MISMATCH', 'Missing moderation consumer: ' + key);
    const answerTypes = { microphone: actions.answerInviteMicrophone().type, camera: actions.answerInviteCamera().type };
    const pending = new Map(), operations = new Set(), controls = new Map(), sockets = new Map(), streams = new WeakSet();
    const originalDispatch = store.dispatch, mediaDevices = navigator.mediaDevices, getUserMedia = mediaDevices?.getUserMedia;
    let disposed = false, refreshBusy = false, dialog = null, lastAdvertisement = null, serverAdvertisement = null;
    let lastResult = null, lastScope = '', lastDevices = '', localSerial = 0;
    const run = (fn, ...args) => vendor.sagaMiddleware.run(fn, ...args).toPromise();
    const report = failure => { if (!disposed) { lastResult = { code: failure.code || 'MODERATION_FAILED', message: failure.message }; render(); } };
    const modal = kind => kind === 'camera' ? c.MODAL_STATE.HOST_OPEN_CAMERA_MODAL : c.MODAL_STATE.HOST_OPEN_MICROPHONE_MODAL;
    function facts() {
      const current = store.getState(), session = getSession(), info = vendor.selectors.selectConfInitData(current) || {};
      const own = vendor.selectors.selectOwn(current) || {}, participants = vendor.selectors.selectParticipants(current) || {};
      const audiences = vendor.selectors.selectAudiences(current) || {}, selection = vendor.selectors.selectDevices(current) || {};
      const login = vendor.selectors.selectLoginInfo(current) || {}, self = participants[own.id] || audiences[own.id];
      const account = login.user?.userId || login.user?.account || login.account || '';
      const devices = String(selection.audioInput || '') + '/' + String(selection.videoInput || '');
      const scope = session.joined && info.conferenceID && info.participantID ?
        [session.sessionKey, info.conferenceID, info.participantID, account, devices].join('|') : '';
      return { current, session, info, own, participants, audiences, self, devices, scope,
        basic: vendor.selectors.selectConfBasicInfo(current) || {}, rtc: vendor.selectors.selectRtc(current) || {} };
    }
    function assertRoom() {
      const f = facts();
      if (disposed || !f.scope) throw error('NOT_IN_CONFERENCE', 'A current admitted media room is required');
      return f;
    }
    function valid(record) {
      return !disposed && !record.cancelled && record.scope === facts().scope && !!record.scope &&
        (record.kind !== 'camera' || policy.allowed(4));
    }
    function assertRecord(record) {
      if (!valid(record)) throw error('MODERATION_INVITATION_REVOKED', 'The invitation/room/device was retired before media opened');
    }
    function cancelModal(kind) {
      store.dispatch(vendor.actions.cancelModalState(modal(kind)));
      if (kind === 'microphone') store.dispatch(vendor.actions.cancelModalState(c.MODAL_STATE.HOST_OPEN_ALL_MICROPHONE_MODAL));
    }
    function stopTrack(record) {
      for (const stream of record.captures) for (const track of stream.getTracks()) {
        if (track.kind === (record.kind === 'microphone' ? 'audio' : 'video')) track.stop();
      }
      // A pending unmute may reuse the established SDK stream without another
      // getUserMedia. Retire its track immediately; never wait for the prompt.
      const stream = facts().rtc.localStream;
      const track = record.kind === 'microphone' ? stream?.getAudioTrack?.() : stream?.getVideoTrack?.();
      if (record.started && track) track.stop();
    }
    function retire(kind, reason, clearConsent = false) {
      if (clearConsent) policy.revoke();
      if (dialog) { dialog.finish(false); dialog = null; }
      for (const record of operations) if (!kind || record.kind === kind) {
        record.cancelled = true; record.reason = reason; stopTrack(record);
      }
      for (const [key, record] of pending) if (!kind || key === kind) {
        record.cancelled = true; pending.delete(key); cancelModal(key);
      }
    }
    function refreshScope() {
      const f = facts();
      if (f.scope !== lastScope || f.devices !== lastDevices) {
        retire(null, 'room-account-or-device-changed', true);
        policy.bind(f.scope); lastScope = f.scope; lastDevices = f.devices;
        serverAdvertisement = null;
        for (const request of controls.values()) request.finish(error('MODERATION_SESSION_RETIRED', 'The control request lost its room owner'));
      }
      return f;
    }
    function requestConsent(params = {}) {
      if (params.allow === false) { retire('microphone', 'local-consent-revoked', true); advertiseCurrent(); render(); return Promise.resolve(state()); }
      const f = assertRoom(); refreshScope();
      if (dialog) throw error('CONSENT_DIALOG_PENDING', 'A microphone consent dialog is already open');
      return new Promise((resolve, reject) => {
        const node = document.createElement('dialog'), text = document.createElement('p');
        node.id = 'welink-moderation-consent'; node.setAttribute('aria-label', 'Microphone reopen consent');
        text.textContent = '仅本次会议和当前麦克风：允许主持人请求重新开启麦克风，不再逐次提醒。系统媒体许可仍然必需。离会、切换账号或设备即失效，可随时撤销。\nFor this meeting and current device only: allow host requests to reopen your microphone without another reminder. System media permission is still required. Leaving or changing account/device revokes this consent.';
        const deny = document.createElement('button'), allow = document.createElement('button');
        deny.textContent = '不允许 / Do not allow'; allow.textContent = '允许本次会议 / Allow for this meeting';
        node.append(text, deny, allow); document.body.appendChild(node);
        let done = false;
        const finish = accepted => {
          if (done) return; done = true; node.close(); node.remove(); dialog = null;
          if (!accepted) return reject(error('MICROPHONE_CONSENT_REQUIRED', 'Microphone reminder suppression was not consented to locally'));
          try { if (facts().scope !== f.scope) throw error('MODERATION_SESSION_RETIRED', 'The room or device changed during consent');
            policy.grant(f.scope); resolve(state()); } catch (failure) { reject(failure); }
        };
        dialog = { finish };
        deny.addEventListener('click', event => { if (event.isTrusted) finish(false); });
        allow.addEventListener('click', event => { if (event.isTrusted) finish(true); });
        node.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
        node.showModal(); deny.focus();
      });
    }
    function reply(kind, accepted, inviter) {
      const f = assertRoom();
      store.dispatch(kind === 'microphone' ? actions.setMicrophoneInviterParticipantID(inviter) : actions.setCameraInviterParticipantID(inviter));
      return run(kind === 'microphone' ? vendor.common.sendInviteOpenMicrophoneToCms : vendor.common.sendInviteOpenCameraToCms,
        kind === 'microphone' ? accepted ? c.INVITE_MICROPHONE_ANSWER.AGREE : c.INVITE_MICROPHONE_ANSWER.DIS_AGREE :
          accepted ? c.INVITE_CAMERA_ANSWER.AGREE : c.INVITE_CAMERA_ANSWER.DIS_AGREE).then(() => ({ transportQueued: true,
            conferenceID: f.info.conferenceID, serverOperationAcknowledged: false }));
    }
    async function answer(kind, accepted) {
      const record = pending.get(kind);
      if (!record) throw error('MODERATION_INVITATION_MISSING', 'No current device invitation owns this answer');
      assertRecord(record); pending.delete(kind); cancelModal(kind);
      if (!accepted) return reply(kind, false, record.inviter);
      operations.add(record); record.started = true;
      try {
        assertRecord(record);
        await setMedia(kind, true);
        assertRecord(record);
        await reply(kind, true, record.inviter);
        record.completed = true;
        return { opened: true, kind, localConsent: true, serverPermissionGranted: false };
      } catch (failure) {
        stopTrack(record);
        if (facts().scope === record.scope) {
          await setMedia(kind, false).catch(report);
          await reply(kind, false, record.inviter).catch(report);
        }
        throw failure;
      } finally { operations.delete(record); }
    }
    function guardedDispatch(action) {
      for (const kind of ['microphone', 'camera']) if (action?.type === answerTypes[kind]) {
        const accepted = kind === 'microphone' ? action.payload?.answer === c.INVITE_MICROPHONE_ANSWER.AGREE :
          action.payload === c.INVITE_CAMERA_ANSWER.AGREE;
        answer(kind, accepted).catch(report); return action;
      }
      return originalDispatch(action);
    }
    store.dispatch = guardedDispatch; // Installed before the existing invited-share dispatch owner.
    function* incoming(packet) {
      if (disposed || packet.action !== c.CONF_MSG_TYPE.LOCAL_CONTROL) return packet;
      const data = typeof packet.data === 'string' ? JSON.parse(packet.data) : packet.data;
      if (!data || typeof data !== 'object') return packet;
      const f = refreshScope();
      if (data.conferenceID !== undefined && String(data.conferenceID) !== String(f.info.conferenceID)) return null;
      const mine = String(data.participantID) === String(f.own.id);
      if (mine && [c.LOCAL_NOTIFY_TYPE.MOVE_TO_WAITING_ROOM, c.LOCAL_NOTIFY_TYPE.HANGUP, c.LOCAL_NOTIFY_TYPE.REJOIN_CONF].includes(packet.type))
        retire(null, 'server-admission-or-leave', true);
      const microphone = packet.type === c.LOCAL_NOTIFY_TYPE.MUTE || packet.type === c.LOCAL_NOTIFY_TYPE.MUTE_ALL;
      const camera = packet.type === c.LOCAL_NOTIFY_TYPE.VIDEO;
      if ((!microphone && !camera) || !mine && packet.type !== c.LOCAL_NOTIFY_TYPE.MUTE_ALL) return packet;
      const kind = microphone ? 'microphone' : 'camera', open = microphone ? data.isMute === 0 : data.status === c.INVITE_CAMERA_STATUS.ON;
      if (!open) { retire(kind, 'server-forced-close'); return packet; }
      // The original microphone handler can auto-open when inviteMic or bit10
      // is absent. Always interpose before that worker; no server bit is consent.
      if (!f.scope) return null;
      retire(kind, 'superseded-invitation');
      const record = { kind, inviter: data.inviterParticipantID || '', scope: f.scope, serial: ++localSerial,
        cancelled: false, started: false, captures: new Set() };
      pending.set(kind, record);
      if (camera && !policy.allowed(4)) { pending.delete(kind); yield reply(kind, false, record.inviter); return null; }
      if (microphone && policy.microphoneAutomatic()) { answer(kind, true).catch(report); return null; }
      store.dispatch(microphone ? actions.setMicrophoneInviterParticipantID(record.inviter) : actions.setCameraInviterParticipantID(record.inviter));
      store.dispatch(vendor.actions.setModalState(microphone && packet.type === c.LOCAL_NOTIFY_TYPE.MUTE_ALL ?
        c.MODAL_STATE.HOST_OPEN_ALL_MICROPHONE_MODAL : modal(kind)));
      return null;
    }
    function captureRecord(kind) { return [...operations].find(record => record.kind === kind); }
    function guardedGetUserMedia(constraints) {
      const records = [constraints?.audio && captureRecord('microphone'), constraints?.video && captureRecord('camera')].filter(Boolean);
      for (const record of records) assertRecord(record);
      return getUserMedia.call(this, constraints).then(stream => {
        for (const record of records) record.captures.add(stream);
        try { for (const record of records) assertRecord(record); }
        catch (failure) { for (const track of stream.getTracks()) track.stop(); throw failure; }
        return stream;
      });
    }
    if (typeof getUserMedia !== 'function') throw error('CAPABILITY_ABI_MISMATCH', 'The genuine media-permission boundary is missing');
    mediaDevices.getUserMedia = guardedGetUserMedia;
    function guardStream(stream) {
      if (!stream || streams.has(stream)) return stream;
      streams.add(stream);
      for (const [method, kind] of [['unmuteAudio', 'microphone'], ['unmuteVideo', 'camera'],
        ['addAudioTrackCapture', 'microphone'], ['addVideoTrackCapture', 'camera']]) {
        const original = stream[method];
        if (typeof original !== 'function') continue;
        stream[method] = function (...args) {
          const record = captureRecord(kind);
          if (record) assertRecord(record);
          const result = original.apply(this, args);
          if (!record) return result;
          const finished = value => {
            try { assertRecord(record); } catch (failure) { stopTrack(record); throw failure; }
            return value;
          };
          return result && typeof result.then === 'function' ? result.then(finished) : finished(result);
        };
      }
      return stream;
    }
    function requestShape(packet, body) {
      if (packet.action !== c.CONF_MSG_TYPE.CONF_CONTROL) return null;
      if (packet.type === 'CO_HOST') return { operation: 'cohost', enabled: flag(body.isCohost) };
      if (packet.type === c.CONF_CONTROL_TYPE.MOVE_TO_WAITING_ROOM) return { operation: 'waiting', enabled: true };
      if (packet.type === c.CONF_CONTROL_TYPE.VIDEO) return { operation: 'camera', enabled: body.status === c.INVITE_CAMERA_STATUS.ON };
      if (packet.type === c.CONF_CONTROL_TYPE.MUTE) return { operation: 'microphone', enabled: body.isMute === 0 };
      return null;
    }
    function authorize(operation, participantID, enabledValue, f = assertRoom()) {
      return api.authorize({ operation, participantID, enabledValue, ownID: f.own.id, ownRole: f.own.role,
        target: f.participants[participantID] || f.audiences[participantID], self: f.self, basic: f.basic, enabled: policy.allowed });
    }
    function outgoing(packet) {
      const f = refreshScope(), socket = vendor.getWebsocket(); watchSocket(socket);
      if (!packet || typeof packet !== 'object') return packet;
      const body = typeof packet.data === 'string' ? JSON.parse(packet.data) : packet.data;
      if (!body || typeof body !== 'object') return packet;
      if (packet.action === c.CONF_MSG_TYPE.SUBSCRIBE || packet.action === c.CONF_MSG_TYPE.CONF_CONTROL && packet.type === c.CONF_CONTROL_TYPE.JOIN_RTC_CONF) {
        body.clientCapabilities = policy.advertise(body.clientCapabilities);
        lastAdvertisement = { conferenceID: body.conferenceID || '', participantID: f.info.participantID || '',
          clientCapabilities: body.clientCapabilities, sequence: packet.sequence, transport: 'queued', serverCapabilityAcknowledged: false };
        packet = { ...packet, data: JSON.stringify(body) };
      }
      const request = requestShape(packet, body);
      if (request) authorize(request.operation, body.participantID, request.enabled, f);
      if (packet.action === c.CONF_MSG_TYPE.CONF_CONTROL && packet.type === c.CONF_CONTROL_TYPE.MUTE_ALL && body.isMute === 0) {
        for (const participant of Object.values(f.participants)) if (String(participant.pid) !== String(f.own.id))
          authorize('microphone', participant.pid, true, f);
      }
      return packet;
    }
    function received(socket, event) {
      if (socket !== vendor.getWebsocket() || typeof event.data !== 'string') return;
      let packet, body;
      try { packet = JSON.parse(event.data); body = typeof packet.data === 'string' ? JSON.parse(packet.data) : packet.data; } catch (_) { return; }
      const request = controls.get(packet.sequence);
      if (request && request.socket === socket && packet.action === c.CONF_MSG_TYPE.CONF_CONTROL && packet.type === request.type &&
          body && Object.prototype.hasOwnProperty.call(body, 'returnCode')) {
        if (request.scope !== facts().scope) request.finish(error('MODERATION_SESSION_RETIRED', 'The server reply belongs to a retired room'));
        else if (body.returnCode !== 0 && body.returnCode !== '0') request.finish(error(body.returnCode, body.returnDesc || 'The server refused moderation'));
        else request.finish(null, { serverOperationAcknowledged: true, operation: request.operation, participantID: request.participantID,
          membershipChanged: false, serverPermissionGranted: false, source: 'correlated-CMS-response' });
      }
      // Preserve server evidence without interpreting a Subscribe success as a
      // capability acceptance. Only an actual self-membership echo is shown.
      if (packet.action === c.CONF_MSG_TYPE.PARTICIPANTS_NOTIFY) {
        const items = Array.isArray(body) ? body : packet.participants || body?.participants;
        if (Array.isArray(items)) {
          const self = items.find(item => String(item.pid) === String(facts().own.id));
          const value = self?.pinfoMap?.CLIENT_CAPABILITIES_V2 ?? self?.pinfoMap?.CLIENT_CAPABILITIES;
          if (typeof value === 'string') serverAdvertisement = { clientCapabilities: value, source: 'CMS-ParticipantsNotify',
            matchesAdvertisement: !!lastAdvertisement && value.split(',').sort().join(',') === lastAdvertisement.clientCapabilities.split(',').sort().join(',') };
        }
      }
    }
    function watchSocket(socket) {
      if (!socket || sockets.has(socket) || disposed) return;
      const message = event => received(socket, event), close = () => {
        retire(null, 'control-transport-closed', true);
        for (const request of controls.values()) if (request.socket === socket) request.finish(error('CMS_TRANSPORT_CLOSED', 'The moderation control socket closed'));
        socket.removeEventListener('message', message); socket.removeEventListener('close', close); sockets.delete(socket);
      };
      socket.addEventListener('message', message); socket.addEventListener('close', close); sockets.set(socket, { message, close });
    }
    async function control(params = {}) {
      const { operation, participantID, enabled } = params, f = assertRoom();
      if (typeof participantID !== 'string' || !participantID || operation !== 'waiting' && typeof enabled !== 'boolean')
        throw error('INVALID_ARGUMENT', 'A current participant ID and boolean enabled are required');
      authorize(operation, participantID, operation === 'waiting' ? true : enabled, f);
      const socket = vendor.getWebsocket();
      if (!socket || socket.readyState !== WebSocket.OPEN) throw error('CMS_TRANSPORT_CLOSED', 'The genuine CMS connection is not open');
      const login = vendor.selectors.selectLoginInfo(f.current) || {};
      if (typeof login.accessToken !== 'string' || !login.accessToken) throw error('CMS_AUTHORIZATION_MISSING', 'No genuine conference control token is available');
      const type = { cohost: 'CO_HOST', waiting: c.CONF_CONTROL_TYPE.MOVE_TO_WAITING_ROOM,
        microphone: c.CONF_CONTROL_TYPE.MUTE, camera: c.CONF_CONTROL_TYPE.VIDEO }[operation];
      const body = { conferenceID: f.info.conferenceID, participantID, confToken: 'Basic ' + btoa(login.accessToken) };
      if (operation === 'cohost') body.isCohost = enabled ? 1 : 0;
      if (operation === 'microphone') body.isMute = enabled ? 0 : 1;
      if (operation === 'camera') body.status = enabled ? c.INVITE_CAMERA_STATUS.ON : c.INVITE_CAMERA_STATUS.OFF;
      const sequence = vendor.uuid(); watchSocket(socket);
      return new Promise((resolve, reject) => {
        const request = { socket, scope: f.scope, type, operation, participantID, finish(failure, value) {
          if (!controls.delete(sequence)) return; clearTimeout(request.timer);
          if (failure) reject(failure); else { lastResult = value; render(); resolve(value); }
        } };
        request.timer = setTimeout(() => request.finish(error('MODERATION_CONTROL_TIMEOUT', 'No correlated CMS moderation response')), 15000);
        controls.set(sequence, request);
        try { socket.send(JSON.stringify({ action: c.CONF_MSG_TYPE.CONF_CONTROL, type, sequence, data: JSON.stringify(body) })); }
        catch (failure) { request.finish(failure); }
      });
    }
    function advertiseCurrent() {
      if (disposed || !facts().scope) return;
      run(vendor.common.sendSubscribe, c.All_Guest_SubscribeType, false).catch(report);
    }
    async function configure(type, enabled) {
      refreshScope();
      if (type === 3 && !enabled && !policy.state().microphoneConsent) await requestConsent();
      if (type === 3 && enabled) retire('microphone', 'reminders-restored', true);
      if (type === 4 && !enabled) retire('camera', 'camera-invitations-disabled');
      policy.configure(type, enabled);
      advertiseCurrent(); render();
      return { configured: true, type, enabled, enforcement: 'real-CMS-consumers-and-membership-advertisement',
        advertisedOn: facts().scope ? 'real-subscribe-and-next-join' : 'next-real-join-or-subscribe',
        serverCapabilityAcknowledged: false, serverPermissionGranted: false, osPermissionGranted: false,
        microphoneConsent: policy.state().microphoneConsent };
    }
    const panel = document.createElement('details'); panel.id = 'welink-moderation-controls';
    panel.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:1100;max-width:380px;padding:8px;background:#fff;color:#222;border:1px solid #999;font:13px sans-serif';
    const summary = document.createElement('summary'); summary.textContent = '会议管理与设备同意 / Moderation & consent';
    const status = document.createElement('p'), choice = document.createElement('select'), buttons = document.createElement('div');
    choice.setAttribute('aria-label', 'Moderation participant');
    const consent = document.createElement('button'); consent.id = 'welink-microphone-room-consent';
    consent.addEventListener('click', event => { if (!event.isTrusted) return;
      (policy.state().microphoneConsent ? requestConsent({ allow: false }) : configure(3, false)).catch(report); });
    const controlsUi = [];
    for (const [operation, enabled, label] of [['cohost', true, '设为联席主持人 / Make cohost'], ['cohost', false, '撤销联席主持人 / Remove cohost'],
      ['waiting', true, '移至等候室 / Move to waiting room'], ['microphone', true, '邀请开启麦克风 / Invite microphone'],
      ['microphone', false, '静音 / Mute'], ['camera', true, '邀请开启摄像头 / Invite camera'], ['camera', false, '关闭摄像头 / Close camera']]) {
      const button = document.createElement('button'); button.textContent = label;
      button.addEventListener('click', event => { if (event.isTrusted) control({ operation, enabled, participantID: choice.value }).catch(report); });
      controlsUi.push({ button, operation, enabled }); buttons.appendChild(button);
    }
    choice.addEventListener('change', render); panel.append(summary, status, consent, choice, buttons); document.body.appendChild(panel);
    function render() {
      if (disposed || refreshBusy) return;
      refreshBusy = true;
      try {
        const f = refreshScope(), role = api.role(f.self, f.own.role, policy.allowed(0));
        panel.hidden = !f.scope;
        consent.textContent = policy.state().microphoneConsent ? '撤销麦克风重开同意 / Revoke microphone consent' : '本次会议不再提醒麦克风重开 / Allow room microphone requests';
        status.textContent = '服务器角色 / Server role: ' + role.kind + (role.cohost && !role.canModerate ? ' (local cohost capability disabled)' : '') +
          (lastResult ? '\n' + (lastResult.message || 'CMS response received; membership remains server-controlled') : '');
        const selected = choice.value, entries = Object.values({ ...f.participants, ...f.audiences }).filter(item => String(item.pid) !== String(f.own.id));
        const signature = entries.map(item => item.pid + ':' + (item.pinfoMap?.NAME || '')).join('|');
        if (choice.dataset.members !== signature) {
          choice.dataset.members = signature; choice.replaceChildren();
          for (const item of entries) { const option = document.createElement('option'); option.value = String(item.pid);
            option.textContent = item.pinfoMap?.NAME || String(item.pid); choice.appendChild(option); }
          if (entries.some(item => String(item.pid) === selected)) choice.value = selected;
        }
        for (const item of controlsUi) { try { authorize(item.operation, choice.value, item.enabled, f); item.button.disabled = false; }
          catch (_) { item.button.disabled = true; } }
        choice.hidden = buttons.hidden = !role.canModerate;
        guardStream(f.rtc.localStream); watchSocket(vendor.getWebsocket());
      } catch (failure) { onViolation?.(failure); }
      finally { refreshBusy = false; }
    }
    function state() {
      const f = refreshScope();
      return { ...policy.state(), role: api.role(f.self, f.own.role, policy.allowed(0)),
        pendingInvitations: [...pending.keys()], advertisement: lastAdvertisement, serverMembershipAdvertisement: serverAdvertisement,
        lastControl: lastResult, serverOrdersAlwaysEnforced: true };
    }
    function ensure() {
      if (disposed || !panel.isConnected || mediaDevices.getUserMedia !== guardedGetUserMedia)
        throw error('CAPABILITY_ENFORCEMENT_LOST', 'The moderation consent/media owner was replaced');
    }
    function deviceChanged() { retire(null, 'device-change', true); advertiseCurrent(); render(); }
    const unsubscribe = store.subscribe(render);
    mediaDevices.addEventListener('devicechange', deviceChanged);
    function dispose() {
      if (disposed) return;
      retire(null, 'document-retired', true); disposed = true; unsubscribe();
      for (const request of controls.values()) request.finish(error('MODERATION_SESSION_RETIRED', 'The moderation owner was retired'));
      for (const [socket, handlers] of sockets) { socket.removeEventListener('message', handlers.message); socket.removeEventListener('close', handlers.close); }
      sockets.clear(); panel.remove(); mediaDevices.removeEventListener('devicechange', deviceChanged);
      if (mediaDevices.getUserMedia === guardedGetUserMedia) mediaDevices.getUserMedia = getUserMedia;
      if (store.dispatch === guardedDispatch) store.dispatch = originalDispatch;
    }
    render();
    return Object.freeze({ configure, incoming, outgoing, state, ensure, guardStream, control, requestConsent, dispose,
      revoke: () => { retire(null, 'owner-revoked', true); }, deviceChanged });
  };
})();
