/* Private cmd1050, NOT public EnableCapability/HwmCapabilityType.
 * Reference: hwmsdk-electron-110.9.20.zip, HwmPrivateUISdkMeetingServiceDef.h:371-404,
 * SHA256 6ed4d6e8e6bb255469895e5319c15a2f5d509f9d4265ef4d3ed9e7467b3f7733.
 * https://obs-client.obs.cn-north-1.myhuaweicloud.com/HWMeeting/sdk/hwmsdk-electron-110.9.20.zip
 * SetEnableCapability's actual signature uses HwmSDKCapabilityType; its parameter
 * comment incorrectly says HwmCapabilityType. This reference is not a claim that
 * every newer enum is present in the campus Windows 100.10.5 DLL.
 * Consumer ABI: main.6297930e.js modules 51361/86989 (CMS routing), 90620/36133
 * (RTM routing), 51339/33287 (CIM/RTM sends), 62467 (wire capability IDs), 58909
 * (share invitation answer), and 404.58f826ce.chunk.js (chat message classes).
 */
(function (root) {
  'use strict';
  const names = [
    'SUPPORT_TO_BE_COHOST', 'SUPPORT_INVITED_SHARING', 'SUPPORT_MOVED_TO_WAITING_ROOM',
    'SUPPORT_INVITED_OPEN_MIC_TIPS', 'SUPPORT_INVITED_OPEN_CAM', 'SUPPORT_PRIVATE_CHAT',
    'SUPPORT_CLIENT_LOCAL_RECORDING', 'SUPPORT_ANONYMOUS_USE_PNR', 'SUPPORT_REQUEST_CLOUD_RECORD',
    'SUPPORT_REQUEST_LOCAL_RECORD', 'SUPPORT_ADD_VRBK_IMAGE', 'SUPPORT_WAITING_ROOM_CHAT',
    'SUPPORT_COMPLAIN', 'SUPPORT_P2P_MINI_WINDOW'
  ];
  const pageTypes = Object.freeze([0, 1, 2, 3, 4, 5, 6, 8, 9, 11]);
  const supportedTypes = Object.freeze(names.map((_, type) => type));
  const scopes = Object.freeze({ 0: 'cohost-membership', 1: 'local-sharing-invitations',
    2: 'waiting-room-membership', 3: 'room-device-microphone-reminder', 4: 'camera-invitations-and-close',
    5: 'local-private-chat', 6: 'local-recording', 7: 'anonymous-room-memory',
    8: 'local-cloud-record-requests', 9: 'local-record-permission-requests',
    10: 'current-meeting-local-camera', 11: 'local-waiting-room-chat',
    12: 'authenticated-roster-participant-report', 13: 'local-p2p-compact-window' });
  const error = (code, message, details) => Object.assign(new Error(message), { code, details });
  const definitions = Object.freeze(names.map((name, type) => Object.freeze({ type,
    capability: 'HWM_SDK_CAPABILITY_' + name, scope: scopes[type], supported: true, boundary: null })));
  function validate(params = {}) {
    if (!params || typeof params !== 'object' || Array.isArray(params))
      throw error('INVALID_ARGUMENT', 'Capability parameters must be an object');
    const { type = 0, isEnable = true } = params;
    if (!Number.isSafeInteger(type) || type < 0 || typeof isEnable !== 'boolean')
      throw error('INVALID_ARGUMENT', 'Capability type must be a nonnegative integer and isEnable must be a boolean');
    if (type >= definitions.length) throw error('UNKNOWN_NATIVE_CAPABILITY',
      type === 14 ? 'HWM_SDK_CAPABILITY_BUTT is a sentinel, not a capability' : 'No such enumerant exists in the pinned private capability ABI',
      { nativeCommand: 1050, type, requestedEnable: isEnable, capabilityChanged: false });
    return { type, isEnable, definition: definitions[type] };
  }
  function unavailable(type, isEnable) {
    const definition = definitions[type];
    return error('NATIVE_CAPABILITY_UNAVAILABLE', 'The current provider cannot configure ' + definition.capability,
      { nativeCommand: 1050, type, capability: definition.capability, requestedEnable: isEnable,
        supportedTypes: [...supportedTypes], capabilityChanged: false, applied: false });
  }
  const contract = Object.freeze({ definitions, supportedTypes, validate, unavailable,
    enumType: 'HwmSDKCapabilityType', referenceVersion: '110.9.20', nativeCommand: 1050 });
  if (typeof module === 'object' && module.exports) module.exports = contract;
  if (!root || root.__welinkCreateNativeCapabilities) return;
  root.__welinkNativeCapabilityContract = contract;
  root.__welinkCreateNativeCapabilities = function ({ vendor, loadModule, configureRecording, invitedShareGuard, moderation, onViolation }) {
    const c = vendor.constants, store = vendor.store;
    const cms = loadModule(51361).confWsHandler, rtm = loadModule(90620).chatWsHandler;
    const chat = loadModule(36133), modes = c.MODAL_STATE;
    const expected = { INVITE_OPEN_SHARE: '2', PRIVATE_CHAT: '7', REQUEST_CLOUD_RECORD: '18', WAITING_ROOM_CHAT: '17' };
    for (const [name, value] of Object.entries(expected)) if (c.CLIENT_CAPABILITIES?.[name] !== value)
      throw error('CAPABILITY_ABI_MISMATCH', 'The pinned client capability binding changed: ' + name);
    for (const name of ['selectOwn', 'selectWaitingRoomInfo', 'selectView']) if (typeof vendor.selectors[name] !== 'function')
      throw error('CAPABILITY_ABI_MISMATCH', 'Missing provider selector ' + name);
    for (const name of ['cancelModalState']) if (typeof vendor.actions[name] !== 'function')
      throw error('CAPABILITY_ABI_MISMATCH', 'Missing provider action ' + name);
    if (typeof vendor.common.sendInviteOpenShareToCms !== 'function' ||
        typeof configureRecording !== 'function' || typeof invitedShareGuard?.revoke !== 'function' ||
        typeof WebSocket?.prototype.send !== 'function')
      throw error('CAPABILITY_ABI_MISMATCH', 'Missing actual invitation, recording or transport binding');
    const enabled = new Map(pageTypes.map(type => [type, true]));
    const configured = new Set(), blocked = Object.create(null), bindings = [];
    const wireIds = { 1: ['2'], 5: ['7'], 6: ['8'], 8: ['18'], 9: ['19'], 11: ['17'] };
    let disposed = false, syncing = false;
    const style = document.createElement('style');
    style.textContent = '.welink-capability-hidden-chat{display:none!important}#welink-capability-policy{position:fixed;right:8px;top:8px;z-index:2147483646;max-width:440px;padding:6px 10px;background:#fff4d5;color:#402e00;border:1px solid #997000;font:12px sans-serif;pointer-events:none;white-space:pre-line}';
    document.head.appendChild(style);
    const status = document.createElement('div');
    status.id = 'welink-capability-policy'; status.setAttribute('role', 'status'); status.hidden = true;
    document.body.appendChild(status);
    function notice(type) {
      blocked[type] = (blocked[type] || 0) + 1;
      refresh();
    }
    function reject(type) {
      notice(type);
      throw error('NATIVE_CAPABILITY_DISABLED', definitions[type].capability + ' is disabled by this application', { type });
    }
    const allowed = type => !disposed && enabled.get(type) !== false;
    const current = () => store.getState();
    const own = () => vendor.selectors.selectOwn(current()) || {};
    function waitingChannel(id) {
      const info = vendor.selectors.selectWaitingRoomInfo(current()) || {};
      return id !== undefined && id !== null && id !== '' &&
        [info.cimGroupId, info.waitingRoomIMGroupId].some(value => value !== undefined && String(value) === String(id));
    }
    function messageAllowed(message, waiting = false) {
      if (!message || typeof message !== 'object') return false;
      const privateMessage = [true, 1, '1'].includes(message.messageOptions?.isPrivate);
      if (!allowed(5) && privateMessage) { notice(5); return false; }
      if (!allowed(11) && (waiting || waitingChannel(message.channelId))) { notice(11); return false; }
      return true;
    }
    function wrap(map, key, filter) {
      const original = map?.[key];
      if (typeof key !== 'string' || typeof original !== 'function')
        throw error('CAPABILITY_ABI_MISMATCH', 'Missing genuine capability message route: ' + key);
      function* guarded(...args) {
        if (disposed) return yield* original(...args);
        const selected = yield* filter(args[0]);
        if (selected !== null) return yield* original(selected, ...args.slice(1));
      }
      map[key] = guarded;
      bindings.push({ map, key, original, guarded });
    }
    wrap(cms, c.CONF_MSG_TYPE.LOCAL_CONTROL, function* (packet) {
      if (moderation) {
        packet = yield* moderation.incoming(packet);
        if (packet === null) return null;
      }
      if (!allowed(1) && packet.type === c.LOCAL_NOTIFY_TYPE.INVITE_SHARE) {
        const body = JSON.parse(packet.data);
        if (body.share === c.INVITE_SHARE_STATUS.ON && String(body.participantID) === String(own().id)) {
          notice(1);
          yield* vendor.common.sendInviteOpenShareToCms(c.INVITE_SHARE_ANSWER.DIS_AGREE);
          return null;
        }
      }
      return packet; // Never suppress a host stop-sharing, mute, camera-close or admission command.
    });
    for (const [key, waiting] of [[c.CONF_MSG_TYPE.CONF_IM_NOTIFY, false], [c.CONF_MSG_TYPE.WAITING_ROOM_IM_NOTIFY, true]])
      wrap(cms, key, function* (packet) {
        if (!Array.isArray(packet.confMessages)) return packet;
        const messages = packet.confMessages.filter(message => messageAllowed(message, waiting));
        return messages.length === packet.confMessages.length ? packet : { ...packet, confMessages: messages };
      });
    wrap(cms, c.CONF_MSG_TYPE.CONF_CONTROL, function* (packet) {
      if (packet.type !== c.CONF_CONTROL_TYPE.QUERY_MESSAGE) return packet;
      const body = JSON.parse(packet.data);
      if (!Array.isArray(body.messageList)) return packet;
      const list = body.messageList.filter(message => messageAllowed(message));
      return list.length === body.messageList.length ? packet :
        { ...packet, data: JSON.stringify({ ...body, messageList: list, msgTotalCount: list.length }) };
    });
    wrap(rtm, chat.ACTION_CHAT.RTM_MESSAGE_NOTIFY, function* (packet) {
      return messageAllowed(JSON.parse(packet.msgBody).rtmMessage) ? packet : null;
    });
    wrap(rtm, chat.ACTION_CHAT.CHANNEL_QUERY, function* (packet) {
      const body = JSON.parse(packet.msgBody);
      if (!Array.isArray(body.rtmMessages)) return packet;
      const list = body.rtmMessages.filter(message => messageAllowed(message));
      return list.length === body.rtmMessages.length ? packet : { ...packet, msgBody: JSON.stringify({ ...body, rtmMessages: list }) };
    });
    const originalSend = WebSocket.prototype.send;
    function guardedSend(data) {
      if (disposed || typeof data !== 'string') return originalSend.call(this, data);
      const isCms = this === vendor.getWebsocket(), isRtm = this === current().chat?.socket;
      if (!isCms && !isRtm) return originalSend.call(this, data);
      let packet;
      try { packet = JSON.parse(data); } catch (_) { return originalSend.call(this, data); }
      if (!packet || typeof packet !== 'object') return originalSend.call(this, data);
      if (isCms) {
        if (moderation) { packet = moderation.outgoing(packet); data = JSON.stringify(packet); }
        const relevant = packet.action === c.CONF_MSG_TYPE.SUBSCRIBE ||
          packet.action === c.CONF_MSG_TYPE.CONF_CONTROL && [c.CONF_CONTROL_TYPE.JOIN_RTC_CONF,
            c.LOCAL_NOTIFY_TYPE.SEND_MESSAGE, c.CONF_CONTROL_TYPE.CUSTOM_TRANS, c.CONF_CONTROL_TYPE.ANSWER_SHARE, 'AUX_SHARE'].includes(packet.type);
        if (!relevant) return originalSend.call(this, data);
        const body = typeof packet.data === 'string' ? JSON.parse(packet.data) : packet.data;
        if (body && typeof body.clientCapabilities === 'string') {
          const remove = new Set(pageTypes.filter(type => !allowed(type)).flatMap(type => wireIds[type] || []));
          body.clientCapabilities = body.clientCapabilities.split(',').filter(id => !remove.has(id)).join(',');
          data = JSON.stringify({ ...packet, data: JSON.stringify(body) });
        }
        if (packet.action === c.CONF_MSG_TYPE.CONF_CONTROL && packet.type === c.LOCAL_NOTIFY_TYPE.SEND_MESSAGE) {
          const message = body?.confMessage;
          if (!messageAllowed(message)) reject(!allowed(5) && [true, 1, '1'].includes(message?.messageOptions?.isPrivate) ? 5 : 11);
        }
        if (!allowed(8) && packet.type === c.CONF_CONTROL_TYPE.CUSTOM_TRANS &&
            body?.msgID === c.CUSTOM_TRANS_MSG_ID.START_CLOUD_RECORD_REQUEST) reject(8);
        if (!allowed(1) && packet.type === c.CONF_CONTROL_TYPE.ANSWER_SHARE && body?.share === c.INVITE_SHARE_ANSWER.AGREE) reject(1);
        if (packet.type === 'AUX_SHARE' && Number(body?.isShare) === c.AUX_SHARE_VALUE.SHARE)
          invitedShareGuard.assertPublish(vendor.selectors.selectRtc(current()).localAuxStream);
      } else if (packet.msgCode === chat.CHAT_MSG.SEND_MSG) {
        const message = JSON.parse(packet.msgBody).rtmMessage;
        if (!messageAllowed(message)) reject(!allowed(5) && [true, 1, '1'].includes(message?.messageOptions?.isPrivate) ? 5 : 11);
      }
      return originalSend.call(this, data);
    }
    WebSocket.prototype.send = guardedSend;
    function ensure() {
      if (disposed) throw error('CAPABILITY_OWNER_RETIRED', 'The capability document was retired');
      invitedShareGuard.ensure();
      if (moderation) moderation.ensure();
      if (WebSocket.prototype.send !== guardedSend || !style.isConnected || !style.sheet?.cssRules.length ||
          !status.isConnected || bindings.some(binding => binding.map[binding.key] !== binding.guarded))
        throw error('CAPABILITY_ENFORCEMENT_LOST', 'A real capability transport or UI guard was replaced');
    }
    function refresh() {
      if (disposed || syncing) return;
      syncing = true;
      try {
        ensure();
        const disabled = pageTypes.filter(type => !allowed(type));
        const text = disabled.length ? '应用已禁用 / Disabled by application:\n' + disabled.map(type => definitions[type].scope).join(', ') : '';
        if (status.textContent !== text) status.textContent = text;
        if (status.hidden !== !disabled.length) status.hidden = !disabled.length;
        const waitingLabel = vendor.messages.get('chat.waiting-room-to-all');
        const waitingPrivate = vendor.messages.get('chat.private-chat-waiting-room');
        for (const row of document.querySelectorAll('.hw-meeting-chat-model')) {
          const privateMarker = row.querySelector('.hw-meeting-msg-private');
          const waiting = privateMarker?.textContent === waitingPrivate ||
            Array.from(row.querySelectorAll('.hw-meeting-chat-private')).some(node => node.textContent === waitingLabel);
          const hidden = !allowed(5) && !!privateMarker || !allowed(11) && waiting;
          if (row.classList.contains('welink-capability-hidden-chat') !== hidden)
            row.classList.toggle('welink-capability-hidden-chat', hidden);
        }
        const view = vendor.selectors.selectView(current()) || {};
        const modal = !allowed(1) ? modes.HOST_OPEN_SHARE_MODAL : null;
        const cloudModal = !allowed(8) ? modes.GUEST_REQUEST_RECORD_CONFIRM : null;
        for (const value of [modal, cloudModal]) if (value !== null &&
            (view.modalState === value || view.waitModalStates?.includes(value))) store.dispatch(vendor.actions.cancelModalState(value));
      } catch (failure) { if (typeof onViolation === 'function') onViolation(failure); else throw failure; }
      finally { syncing = false; }
    }
    const observer = new MutationObserver(refresh);
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'hidden'] });
    const unsubscribe = store.subscribe(refresh);
    function state() {
      ensure();
      return { supported: true, available: true, enumType: contract.enumType, referenceVersion: contract.referenceVersion,
        supportedTypes: [...pageTypes], defaults: 'Existing provider features enabled; never permission grants',
        types: definitions.map(definition => ({ ...definition, supported: pageTypes.includes(definition.type),
          enabled: enabled.get(definition.type) ?? null, configured: configured.has(definition.type) })), blocked: { ...blocked },
        moderation: moderation ? moderation.state() : null,
        serverPermissionGranted: false, osPermissionGranted: false,
        negotiation: 'Filtered genuine join/subscribe capability payloads; no fabricated server acknowledgement' };
    }
    async function configure(params) {
      const { type, isEnable, definition } = validate(params);
      if (!pageTypes.includes(type)) throw unavailable(type, isEnable);
      ensure();
      const moderationReceipt = [0, 2, 3, 4].includes(type) ?
        await (moderation ? moderation.configure(type, isEnable) : Promise.reject(unavailable(type, isEnable))) : null;
      enabled.set(type, isEnable);
      configured.add(type);
      if (type === 1 && !isEnable) await invitedShareGuard.revoke();
      if (type === 6 || type === 9) await configureRecording(type, isEnable);
      refresh(); ensure();
      return { configured: true, type, enabled: isEnable, capability: definition.capability, scope: definition.scope,
        enforcement: 'active-local-consumers', advertisedOn: 'next-real-join-or-subscribe',
        serverCapabilityAcknowledged: false, serverPermissionGranted: false, osPermissionGranted: false,
        ...(moderationReceipt || {}) };
    }
    function dispose() {
      if (disposed) return;
      disposed = true; observer.disconnect(); unsubscribe();
      if (WebSocket.prototype.send === guardedSend) WebSocket.prototype.send = originalSend;
      for (const binding of bindings.reverse()) if (binding.map[binding.key] === binding.guarded) binding.map[binding.key] = binding.original;
      for (const row of document.querySelectorAll('.welink-capability-hidden-chat')) row.classList.remove('welink-capability-hidden-chat');
      style.remove(); status.remove();
    }
    refresh();
    return Object.freeze({ configure, state, ensure, dispose, allowed });
  };
})(typeof window === 'object' ? window : null);
