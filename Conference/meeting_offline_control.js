'use strict';

/* Native explicit-offline / native-login-412100044 control owner.
 * hwm_conf RVAs: StartLinkOfflineJoin 0x18A6B0, StartOfflineJoinProc 0x18AEF0,
 * user-token result 0x1874C0, existing-session query result 0x187280,
 * StartJoinConf 0x18A4C0, RTC success/report 0x1D2520.
 * tup_confctrl: JOIN_RTC_CONF 0x401A0, JoinConfNotify 0x40F90,
 * QueryConfInfoForJoin 0x63C20, Subscribe 0x725E0, LeaveConfNotify 0x41580.
 * The invitation's site/prefix are never a control authority or a web tenant.
 * getConfig/getSession are main-process capabilities, NOT renderer payloads.
 */
const fs = require('fs');
const snapshotPolicy = require('./meeting_snapshot_policy');
const moderation = require('./meeting_moderation_capabilities');
const { queryUserToken, openControlSession, ControlSession, authority,
  failure, object, text } = require('./meeting_offline_transport');

const CAPABILITIES = ''; // Moderation membership bits are assembled by the shared policy.
const WAITING_SUBSCRIPTIONS = Object.freeze([
  'ConfBasicInfoNotify', 'LocalControl', 'OperationResultNotify', 'WaitingRoomInfoNotify',
  'WaitingRoomImNotify', 'ConfDynamicInfoNotify', 'WaitingRoomManagerListNotify'
]);
const CONFERENCE_SUBSCRIPTIONS = Object.freeze([
  'ConfBasicInfoNotify', 'ConfDynamicInfoNotify', 'ParticipantsNotify', 'AttendeesNotify',
  'InviteResultNotify', 'DeviceInfoNotify', 'LocalControl', 'CustomMultiPicNotify',
  'OperationResultNotify', 'WaitingRoomInfoNotify', 'WaitingListNotify', 'AudiencesNotify', 'ConferenceStatesNotify'
]);
const IDENTITY_FIELDS = Object.freeze([
  'tmpUserID', 'orgID', 'tmpAccountID', 'tmpName', 'spID', 'tmpLoginAccount', 'opsAddress'
]);

function snapshot(value) { return JSON.parse(JSON.stringify(value)); }
function string(value, name, empty = false, max = 4096) {
  text(value, name, empty);
  if (value.length > max) throw failure('INVALID_OFFLINE_INPUT', name + ' is too long');
  return value;
}
function normalizeInput(input, context) {
  if (!object(input) || (input.isOfflineJoin !== true && context.isServerDowngrade !== true))
    throw failure('OFFLINE_VARIANT_REQUIRED', 'Explicit offline entry or the native server-downgrade result is required');
  return {
    confId: string(input.confId, 'conference ID', false, 64),
    random: string(input.random === undefined ? '' : input.random, 'invitation random', true),
    idPrefix: string(input.idPrefix === undefined ? '' : input.idPrefix, 'site prefix', true, 32),
    site_url: string(input.site_url === undefined ? '' : input.site_url, 'invitation site', true),
    nick_name: string(input.nick_name, 'display name', false, 256),
    password: string(input.password === undefined ? '' : input.password, 'conference password', true, 256),
    isMicOn: input.isMicOn === true, isCameraOn: input.isCameraOn === true,
    isOfflineJoin: input.isOfflineJoin === true
  };
}
function routeAddress(value, defaultPort = 443) {
  if (typeof value !== 'string' || !value) return null;
  const first = value.split(';')[0];
  if (/[\s\0\\]/.test(first)) throw failure('INVALID_OFFLINE_AUTHORITY', 'Invalid configured control address');
  const explicitScheme = first.includes('://');
  const url = authority(explicitScheme ? first : 'https://' + first);
  if (!explicitScheme && !url.port && defaultPort !== 443) url.port = String(defaultPort);
  return url.origin;
}
async function resolveRoutes(config) {
  // ConfigOfflineJoinParam supplies originUsgAddr. Native CDB72 selects Intl
  // from that configured address, not the invitation's next-hop host.
  const originAddress = config.origin || config.server || '';
  if (config.region !== undefined && !['domestic', 'international'].includes(config.region))
    throw failure('INVALID_OFFLINE_CONFIG', 'The configured offline region is invalid');
  const international = config.region === 'international' ||
    (config.region === undefined && originAddress.includes('intl.'));
  const template = config.offlineJoinTemplate;
  const serviceTp = object(config.serviceTp) ? config.serviceTp : object(template) && template.serviceTp;
  const routes = [];
  if (object(serviceTp) && Array.isArray(serviceTp.siteInfoList)) {
    // OfflineJoinTemplate::SetGuaranteedIpAddresses (CE7B0): priority,
    // accessStrategy.service_access_node plus nearbyMediaNodeName. Preserve
    // source order at equal priority and never make routes from media domains.
    const sites = serviceTp.siteInfoList.filter(site => object(site) && Number.isInteger(site.priority))
      .slice().sort((a, b) => a.priority - b.priority);
    for (const site of sites) {
      const strategy = site.accessStrategy;
      if (!object(strategy) || !object(strategy.service_access_node)) continue;
      const node = strategy.service_access_node;
      for (const [field, port] of [['httpProxyUri', 443], ['backHttpProxyUri', 443], ['regionProxyAddrs', 8443]]) {
        const origin = routeAddress(node[field], port);
        if (origin && !routes.some(route => route.origin === origin)) routes.push({
          origin, nearbyMediaNodeName: typeof strategy.nearbyMediaNodeName === 'string' ? strategy.nearbyMediaNodeName : '',
          priority: site.priority, source: 'template', field
        });
      }
    }
  }
  if (!routes.length) {
    let packaged = config.offlineJoinConfig;
    if (!packaged && config.offlineJoinConfigPath) {
      string(config.offlineJoinConfigPath, 'packaged offline configuration path');
      packaged = JSON.parse(await fs.promises.readFile(config.offlineJoinConfigPath, 'utf8'));
    }
    const region = international ? 'DomainsIntl' : 'Domains';
    const origin = object(packaged) && object(packaged[region]) && routeAddress(packaged[region].httpProxyUri);
    if (!origin) throw failure(414100020, 'The installed offline control route is unavailable');
    routes.push({ origin, nearbyMediaNodeName: '', source: 'package', region });
  }
  return { routes, serviceTp: serviceTp || null, offlineJoinTemplate: template || null };
}
function checkConferenceMode(reply) {
  // Native parser initializes to COMMON and compares the returned string to
  // COMMON case-insensitively (tup_confctrl 20310). Do not web-join this branch.
  if (typeof reply.confMode !== 'string' || reply.confMode.toUpperCase() === 'COMMON')
    throw failure(414100070, 'This conference mode does not support native offline admission');
}
function identity(reply) {
  const scoped = {};
  for (const key of IDENTITY_FIELDS) if (reply[key] !== undefined) scoped[key] = reply[key];
  return scoped;
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function bounded(promise, timeoutMs, message) {
  let timer;
  return Promise.race([promise, new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(failure('OFFLINE_MEDIA_TIMEOUT', message)), timeoutMs);
  })]).finally(() => clearTimeout(timer));
}
function transportFailure(error) {
  // Route alternatives are used only before an admission result. A business
  // rejection, certificate failure or redirect never becomes a downgrade/retry.
  return ['ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND',
    'EAI_AGAIN', 'ETIMEDOUT', 'OFFLINE_TOKEN_TIMEOUT'].includes(error && error.code);
}

function createOfflineControl({ getConfig, getSession, media, notify = () => {}, timeoutMs = 45000,
  moderationPolicy = moderation.createPolicy() }) {
  if (typeof getConfig !== 'function' || !media || typeof media.join !== 'function' ||
      typeof media.leave !== 'function' || typeof media.setMicrophone !== 'function' ||
      typeof media.setCamera !== 'function' || typeof notify !== 'function' ||
      !Number.isInteger(timeoutMs) || timeoutMs <= 0)
    throw failure('OFFLINE_PROVIDER_MISSING', 'A real configuration, media owner and positive timeout are required');
  if (getSession !== undefined && typeof getSession !== 'function')
    throw failure('OFFLINE_PROVIDER_MISSING', 'The established-session provider must be a function');
  let active = null, disposed = false;
  let roomSerial = 0, invitationSerial = 0;
  function bindModeration(attempt) {
    const devices = attempt.mediaReceipt || {};
    moderationPolicy.bind(attempt.state === 'joined' && !attempt.stopped ?
      [attempt.serial, attempt.input.confId, attempt.participantID, devices.microphoneId || '', devices.cameraId || ''].join('|') : '');
  }
  function revokeInvitations(attempt, kind, clearConsent = false) {
    if (clearConsent) moderationPolicy.revoke();
    for (const [key, invite] of attempt.mediaInvites) if (!kind || key === kind) {
      invite.cancelled = true; attempt.mediaInvites.delete(key);
    }
    for (const invite of attempt.mediaOperations) if (!kind || invite.kind === kind) {
      invite.cancelled = true;
      // setDevice(false) invalidates the renderer's deviceRevision immediately,
      // including an initialize waiting on a genuine browser permission prompt.
      Promise.resolve(media[invite.kind === 'microphone' ? 'setMicrophone' : 'setCamera'](false)).catch(() => {});
    }
  }

  function owned(attempt) {
    return !disposed && active === attempt && attempt.context.isCurrent() &&
      !(attempt.context.signal && attempt.context.signal.aborted);
  }
  function current(attempt) {
    if (!owned(attempt) || attempt.stopped) throw failure('OFFLINE_RETIRED', 'The offline join was retired');
  }
  function event(attempt, value) {
    // Even terminal callbacks must never escape into a replacement account.
    if (active !== attempt || !attempt.context.isCurrent()) return;
    try { notify({ conferenceID: attempt.input.confId, participantID: attempt.participantID || '', ...value }); }
    catch (_) { /* UI notification errors cannot change authenticated membership. */ }
  }
  function state(attempt, value, extra = {}) {
    attempt.state = value;
    bindModeration(attempt);
    event(attempt, { type: 'state', state: value, ...extra });
  }
  function mediaContext(attempt) {
    return {
      confID: attempt.input.confId, conferenceID: attempt.input.confId,
      participantID: attempt.participantID, displayName: attempt.input.nick_name,
      isMicOn: attempt.input.isMicOn, isCameraOn: attempt.input.isCameraOn,
      identity: snapshot(attempt.identity), serviceTp: attempt.routeConfig.serviceTp,
      offlineJoinTemplate: attempt.routeConfig.offlineJoinTemplate,
      route: { ...attempt.route }, timeoutMs,
      isCurrent: () => owned(attempt) && !attempt.stopped,
      signal: attempt.mediaAbort.signal,
      onFailure: error => { stop(attempt, error || failure('OFFLINE_MEDIA_LOST', 'The media room was lost')).catch(() => {}); }
    };
  }
  function queued(attempt, operation) {
    attempt.work = attempt.work.then(() => { current(attempt); return operation(); })
      .catch(error => { if (!attempt.stopped) return stop(attempt, error); });
  }
  async function subscribe(attempt, types, cancel = false) {
    current(attempt);
    await attempt.session.subscribe(attempt.input.confId, types, moderationPolicy.advertise(CAPABILITIES), cancel);
    current(attempt);
  }
  function startConfHeart(attempt) {
    if (attempt.heartbeat) return;
    attempt.heartbeat = setInterval(() => {
      if (attempt.heartPending || attempt.stopped) return;
      attempt.heartPending = true;
      Promise.resolve().then(() => {
        current(attempt);
        return attempt.session.request('LocalNotify', 'ConfHeartBeat', {
          conferenceID: attempt.input.confId, participantID: attempt.participantID
        });
      }).catch(error => stop(attempt, error)).finally(() => { attempt.heartPending = false; });
    }, 30000);
  }
  function rememberDevices(attempt, receipt) {
    if (!receipt || typeof receipt.microphone !== 'boolean' || typeof receipt.camera !== 'boolean')
      throw failure('OFFLINE_MEDIA_UNCONFIRMED', 'The media owner did not report actual device state');
    attempt.input.isMicOn = receipt.microphone;
    attempt.input.isCameraOn = receipt.camera;
    attempt.mediaReceipt = { ...attempt.mediaReceipt, ...receipt };
    bindModeration(attempt);
  }
  async function joinMedia(attempt, grant) {
    current(attempt);
    state(attempt, 'joining');
    const receipt = await bounded(Promise.resolve().then(() => media.join(grant, mediaContext(attempt))),
      timeoutMs, 'The RTC room did not confirm admission');
    current(attempt);
    if (!receipt || receipt.roomJoined !== true || receipt.connection !== 'CONNECTED' ||
        String(receipt.participantID) !== attempt.participantID ||
        String(receipt.conferenceID) !== attempt.input.confId)
      throw failure('OFFLINE_MEDIA_UNCONFIRMED', 'The media provider did not confirm this admitted participant');
    rememberDevices(attempt, receipt);
    // This is the native report after media success, not a local forged event.
    const report = {
      conferenceID: attempt.input.confId, participantID: attempt.participantID,
      mute: attempt.input.isMicOn ? 0 : 1, cameraState: attempt.input.isCameraOn ? 1 : 0,
      // DeviceManager: 0 = connected, 1 = audio disconnected (12D740).
      // video describes the video-capable room, not whether a camera is open.
      video: 1, audioState: 0, enableCollaborate: Number(grant.enableCollaborate) === 1 ? 1 : 0
    };
    await attempt.session.request('LocalNotify', 'JoinConfNotify', report);
    current(attempt);
    await subscribe(attempt, CONFERENCE_SUBSCRIPTIONS);
    state(attempt, 'joined');
    attempt.completion.resolve({ joined: true, conferenceID: attempt.input.confId, confID: attempt.input.confId,
      participantID: attempt.participantID, role: grant.role, source: 'native-offline-control', media: receipt });
  }
  async function admit(attempt) {
    current(attempt);
    attempt.waitingKind = null;
    const input = attempt.input;
    const request = {
      conferenceID: input.confId, pwd: attempt.password, nickName: input.nick_name,
      userAgent: attempt.config.userAgent, supportExtendPayload: true,
      clientCapabilities: moderationPolicy.advertise(CAPABILITIES), mikeState: input.isMicOn ? 0 : 1,
      cameraState: input.isCameraOn ? 1 : 0, deviceID: attempt.config.deviceId
    };
    if (attempt.route.nearbyMediaNodeName) request.nearbyMediaNodeName = attempt.route.nearbyMediaNodeName;
    // Retain the exact correlated admission across cancellation. A leased
    // socket stays alive, so discarding its late participant would leak a join.
    attempt.admissionPending = true;
    const admission = attempt.admission = attempt.session.request('ConfControl', 'JOIN_RTC_CONF', request).then(grant => {
      if (grant.conferenceID !== undefined && String(grant.conferenceID) !== input.confId)
        throw failure('OFFLINE_CONFERENCE_MISMATCH', 'Admission returned another conference');
      attempt.participantID = string(String(grant.participantID === undefined ? '' : grant.participantID), 'admitted participant ID');
      attempt.grant = grant;
      attempt.basic = { ...attempt.basic, ...(grant.confBasicInfo || {}) };
      attempt.members[attempt.participantID] = { pid: attempt.participantID, pinfoMap: {
        ROLE: String(grant.role), ...(grant.pinfoMap || {}) } };
      attempt.memberGroups.ParticipantsNotify[attempt.participantID] = attempt.members[attempt.participantID];
      attempt.screenshotPolicy = snapshotPolicy.decision(grant.confDynamicInfo?.forbiddenScreenShots ?? grant.forbiddenScreenShots);
      return grant;
    });
    let grant;
    try { grant = await admission; }
    finally { attempt.admissionPending = false; }
    current(attempt);
    startConfHeart(attempt);
    if (String(grant.role) === '2' && ![true, 1, '1'].includes(grant.allowAudience)) {
      await subscribe(attempt, ['ConferenceStatesNotify']);
      attempt.waitingKind = 'audience';
      state(attempt, 'waiting', { waitingReason: 'audience' });
      return;
    }
    if (grant.enterWaitingRoom === true || grant.enterWaitingRoom === 1 || grant.enterWaitingRoom === '1') {
      await subscribe(attempt, WAITING_SUBSCRIPTIONS);
      attempt.waitingKind = 'room';
      state(attempt, 'waiting');
      return;
    }
    await joinMedia(attempt, grant);
  }
  async function remoteMedia(attempt, frame, data) {
    const microphone = frame.type === 'MUTE' || frame.type === 'MUTEALL';
    if (frame.type !== 'MUTEALL' && String(data.participantID) !== attempt.participantID) return;
    const close = microphone ? data.isMute === 1 : data.status === 0;
    const open = microphone ? data.isMute === 0 : data.status === 1;
    if (!close && !open) throw failure('INVALID_OFFLINE_CONTROL', 'Invalid native media control value');
    const kind = microphone ? 'microphone' : 'camera';
    if (close) {
      revokeInvitations(attempt, kind);
      // The same intent fields feed JOIN_RTC_CONF and the next media context.
      // A close received while waiting must also revoke that future capture.
      if (microphone) attempt.input.isMicOn = false;
      else attempt.input.isCameraOn = false;
      // Waiting membership has no admitted media room; close is already
      // satisfied there and must never create one merely to process the order.
      if (attempt.state === 'waiting' && !attempt.mediaReceipt) return;
      const method = microphone ? 'setMicrophone' : 'setCamera';
      if (typeof media[method] !== 'function')
        throw failure('OFFLINE_MEDIA_CONTROL_MISSING', 'The media owner cannot apply ' + kind + ' control');
      const receipt = await media[method](false);
      current(attempt);
      rememberDevices(attempt, receipt);
      attempt.mediaInvites.delete(kind);
      await reportDevices(attempt);
    } else {
      if (attempt.state !== 'joined') return;
      // Remote requests never grant device consent. Disabled camera invitations
      // receive the original protocol refusal; forced close above is unconditional.
      revokeInvitations(attempt, kind);
      const invitation = { kind, id: String(++invitationSerial), scope: moderationPolicy.state().scope,
        inviterParticipantID: data.inviterParticipantID || '', type: frame.type, cancelled: false };
      attempt.mediaInvites.set(kind, invitation);
      if (kind === 'camera' && !moderationPolicy.allowed(4))
        return answerMediaInvitation(kind, false, invitation.id);
      if (kind === 'microphone' && moderationPolicy.microphoneAutomatic()) {
        answerMediaInvitation(kind, true, invitation.id).catch(error => event(attempt,
          { type: 'moderation-error', code: error.code, message: error.message }));
        return;
      }
      event(attempt, { type: 'media-invitation', kind, invitationId: invitation.id,
        inviterParticipantID: invitation.inviterParticipantID });
    }
  }
  async function applyRole(attempt, role) {
    role = String(role);
    if (!['0', '1', '2'].includes(role)) throw failure('INVALID_OFFLINE_CONTROL', 'Unknown server participant role');
    if (role === String(attempt.grant?.role)) return;
    revokeInvitations(attempt, null, true);
    if (attempt.state === 'joined') {
      if (typeof media.setRole !== 'function') throw failure('OFFLINE_MEDIA_CONTROL_MISSING', 'The media owner cannot apply a server role change');
      const receipt = await media.setRole(role);
      current(attempt); rememberDevices(attempt, receipt); await reportDevices(attempt);
    }
    attempt.grant = { ...attempt.grant, role };
  }
  async function notification(attempt, frame) {
    current(attempt);
    let data = frame.data;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); }
      catch (_) { throw failure('INVALID_OFFLINE_CONTROL', 'The control notification is not JSON'); }
    }
    if (object(data) && data.conferenceID !== undefined && String(data.conferenceID) !== attempt.input.confId) return;
    if (frame.conferenceID !== undefined && String(frame.conferenceID) !== attempt.input.confId) return;
    if (frame.action === 'ConfBasicInfoNotify') {
      const info = data?.confBasicInfo || data || frame;
      attempt.basic = { ...attempt.basic, ...info };
    }
    if (frame.action === 'ParticipantsNotify' || frame.action === 'AudiencesNotify') {
      const list = Array.isArray(data) ? data : frame.participants || frame.audiences || data?.participants || data?.audiences;
      if (Array.isArray(list)) {
        const previousRole = attempt.members[attempt.participantID]?.pinfoMap?.ROLE;
        const group = frame.msgMode === 0 ? Object.create(null) : attempt.memberGroups[frame.action]; // Provider ALL.
        for (const member of list) if (member && member.pid !== undefined) {
          const id = String(member.pid), previous = group[id];
          if (member.mode === 1) { delete group[id]; continue; } // Provider REMOVE.
          if (member.mode === 0 && object(member.pinfoMap))
            group[id] = { ...previous, ...member, pinfoMap: { ...previous?.pinfoMap, ...member.pinfoMap } };
        }
        attempt.memberGroups[frame.action] = group;
        attempt.members = { ...attempt.memberGroups.AudiencesNotify, ...attempt.memberGroups.ParticipantsNotify };
        const role = attempt.members[attempt.participantID]?.pinfoMap?.ROLE;
        if (role !== undefined && role !== previousRole) await applyRole(attempt, role);
      }
      event(attempt, { type: 'moderation-state', moderation: moderationState() });
    }
    if (frame.action === 'ConfDynamicInfoNotify') {
      const info = data?.confDynamicInfo || frame.confDynamicInfo || data || frame;
      if (Object.prototype.hasOwnProperty.call(info, 'forbiddenScreenShots')) {
        attempt.screenshotPolicy = snapshotPolicy.decision(info.forbiddenScreenShots);
        event(attempt, { type: 'snapshot-policy', decision: attempt.screenshotPolicy });
      }
    }
    event(attempt, { type: 'control', frame });
    if (frame.action === 'ConferenceStatesNotify') {
      const info = object(data) ? data : frame;
      if (info.conferenceState === 'Conclude')
        return stop(attempt, failure('OFFLINE_CONFERENCE_ENDED', 'Conference control concluded this conference'), false);
      if (attempt.waitingKind === 'audience' && info.conferenceState === 'Created' &&
          [true, 1, '1'].includes(info.allowAudience)) return admit(attempt);
    }
    if (frame.action !== 'LocalControl' || !object(data)) return;
    if (frame.type === 'ROLESWITCHOVER' && String(data.participantID) === attempt.participantID) {
      await applyRole(attempt, data.role);
      const self = attempt.members[attempt.participantID];
      if (self) self.pinfoMap = { ...self.pinfoMap, ROLE: String(data.role) };
      event(attempt, { type: 'moderation-state', moderation: moderationState() });
      return;
    }
    if (frame.type === 'MUTE' || frame.type === 'MUTEALL' || frame.type === 'VIDEO')
      return remoteMedia(attempt, frame, data);
    if (frame.type === 'HANGUP' && String(data.participantID) === attempt.participantID) {
      const error = failure(data.reason === undefined ? 'OFFLINE_HANGUP' : data.reason, 'Conference control ended this participant');
      return stop(attempt, error, false);
    }
    if (frame.type === 'ALLOWWAITINGPARTICIPANT' && String(data.participantID) === attempt.participantID &&
        attempt.state === 'waiting' && attempt.waitingKind === 'room') {
      await subscribe(attempt, WAITING_SUBSCRIPTIONS, true);
      return admit(attempt); // release is NOT a grant; native obtains another one
    }
    if (frame.type === 'MOVETOWAITINGROOM' && String(data.participantID) === attempt.participantID && attempt.state === 'joined') {
      revokeInvitations(attempt, null, true);
      await media.leave();
      current(attempt);
      attempt.mediaReceipt = null;
      await subscribe(attempt, CONFERENCE_SUBSCRIPTIONS, true);
      await subscribe(attempt, WAITING_SUBSCRIPTIONS);
      attempt.waitingKind = 'room';
      state(attempt, 'waiting');
    }
    if (frame.type === 'REJOIN_CONF' && attempt.state === 'joined' &&
        String(data.conferenceID) === attempt.input.confId && object(data.signatureInfo)) {
      revokeInvitations(attempt, null, true);
      await media.leave();
      current(attempt);
      attempt.mediaReceipt = null;
      attempt.grant = { ...attempt.grant, signatureInfo: data.signatureInfo };
      return joinMedia(attempt, attempt.grant);
    }
  }
  async function reportDevices(attempt) {
    current(attempt);
    return attempt.session.request('LocalNotify', 'ParticipantInfoNotify', {
      conferenceID: attempt.input.confId, participantID: attempt.participantID,
      pinfoMap: { MUTE: attempt.input.isMicOn ? '0' : '1', CAMERA_STATE: attempt.input.isCameraOn ? '1' : '0' }
    });
  }
  async function prepare(attempt) {
    const rawConfig = await getConfig();
    current(attempt);
    if (!object(rawConfig)) throw failure('INVALID_OFFLINE_CONFIG', 'Offline configuration is missing');
    attempt.config = snapshot(rawConfig);
    text(attempt.config.userAgent, 'user agent');
    text(attempt.config.deviceId, 'device ID');
    attempt.routeConfig = await resolveRoutes(attempt.config);
    current(attempt);
    let lease;
    if (getSession) lease = await getSession();
    if (lease && (!owned(attempt) || attempt.stopped)) {
      if (typeof lease.release === 'function') await lease.release();
      current(attempt);
    }
    current(attempt);
    if (lease) {
      attempt.release = typeof lease.release === 'function' ? lease.release : null;
      const session = lease.session;
      if (!(session instanceof ControlSession) || session.connectionType !== 1 || session.closed ||
          !session.isCurrent() || !attempt.routeConfig.routes.some(route => route.origin === session.origin))
        throw failure('INVALID_OFFLINE_SESSION', 'The established control session is not current for these configured routes');
      attempt.session = session;
      attempt.ownsSession = false;
      attempt.route = attempt.routeConfig.routes.find(route => route.origin === session.origin);
      attempt.identity = object(lease.identity) ? snapshot(lease.identity) : {};
      attach(attempt);
      const info = await session.request('ConfControl', 'QueryConfInfoForJoin', {
        conferenceID: attempt.input.confId, password: attempt.input.password, random: attempt.input.random
      });
      current(attempt);
      checkConferenceMode(info);
      attempt.password = typeof info.password === 'string' ? info.password : attempt.input.password;
    } else {
      let admission;
      for (let i = 0; i < attempt.routeConfig.routes.length; ++i) {
        attempt.route = attempt.routeConfig.routes[i];
        try {
          admission = await queryUserToken(attempt.route.origin, attempt.input, attempt.config, {
            timeoutMs, isCurrent: () => owned(attempt) && !attempt.stopped, signal: attempt.requestAbort.signal
          });
          break;
        } catch (error) {
          current(attempt);
          if (!transportFailure(error)) throw error;
          if (i === attempt.routeConfig.routes.length - 1) {
            if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN')
              throw failure(414100020, 'Curl host exception.:curl主机异常');
            throw error;
          }
        }
      }
      current(attempt);
      checkConferenceMode(admission);
      attempt.password = typeof admission.password === 'string' ? admission.password : attempt.input.password;
      attempt.identity = identity(admission);
      const authorization = string(admission.wssToken, 'temporary control token');
      // Fresh token clears JWT state, as HandleQueryUserTokenResult does.
      attempt.session = await openControlSession({ origin: attempt.route.origin, config: attempt.config,
        authorization, jwtAuthorization: '', timeoutMs, isCurrent: () => owned(attempt) && !attempt.stopped,
        signal: attempt.requestAbort.signal });
      delete admission.wssToken;
      current(attempt);
      attach(attempt);
    }
    await admit(attempt);
  }
  function attach(attempt) {
    attempt.onNotification = frame => {
      // Retire device-start ownership before joining the serialized CMS work
      // queue. A stale local dialog may otherwise complete ahead of a close.
      let data; try { data = typeof frame.data === 'string' ? JSON.parse(frame.data) : frame.data; } catch (_) {}
      if (frame.action === 'LocalControl' && object(data) &&
          (data.conferenceID === undefined || String(data.conferenceID) === attempt.input.confId) &&
          (String(data.participantID) === attempt.participantID || frame.type === 'MUTEALL')) {
        if ((frame.type === 'MUTE' || frame.type === 'MUTEALL') && data.isMute === 1) revokeInvitations(attempt, 'microphone');
        if (frame.type === 'VIDEO' && data.status === 0) revokeInvitations(attempt, 'camera');
        if (['MOVETOWAITINGROOM', 'HANGUP', 'REJOIN_CONF'].includes(frame.type)) revokeInvitations(attempt, null, true);
      }
      queued(attempt, () => notification(attempt, frame));
    };
    attempt.onClosed = error => { if (!attempt.stopped) stop(attempt, error, false).catch(() => {}); };
    attempt.session.on('notification', attempt.onNotification);
    attempt.session.on('closed', attempt.onClosed);
  }
  function stop(attempt, reason, sendLeave = true) {
    if (attempt.stopPromise) {
      if (!owned(attempt) && attempt.session && !attempt.session.closed)
        attempt.session.close(failure('OFFLINE_RETIRED', 'The retiring conference cannot retain its control lease'));
      return attempt.stopPromise;
    }
    const stopped = deferred();
    attempt.stopPromise = stopped.promise;
    const canSend = owned(attempt);
    attempt.stopped = true;
    revokeInvitations(attempt, null, true);
    moderationPolicy.bind('');
    clearInterval(attempt.heartbeat);
    attempt.mediaAbort.abort();
    if (attempt.session) {
      if (attempt.onNotification) attempt.session.removeListener('notification', attempt.onNotification);
      if (attempt.onClosed) attempt.session.removeListener('closed', attempt.onClosed);
    }
    if (!attempt.session || (!attempt.participantID && !attempt.admission)) attempt.requestAbort.abort();
    state(attempt, reason ? 'failed' : 'leaving', reason ? { error: { code: reason.code, message: reason.message,
      ...(reason.serverResult ? { serverResult: reason.serverResult } : {}) } } : {});
    attempt.completion.reject(reason || failure('OFFLINE_JOIN_CANCELLED', 'The offline join was cancelled'));
    (async () => {
      let leaveError, leaveConfirmed = false;
      // Stop media immediately, but retain a current lease until its exact
      // JOIN result and final LeaveConfNotify are known. Never return an open
      // session containing an unconfirmed admission to the session provider.
      const session = attempt.session;
      if (session && attempt.ownsSession) session.isCurrent = () => owned(attempt);
      const mediaDisposal = bounded(Promise.resolve().then(() => media.leave()), timeoutMs,
        'Media disposal did not complete').then(() => null, error => error);
      if (session && (!canSend || (!sendLeave && attempt.admissionPending)))
        session.close(failure('OFFLINE_RETIRED', 'The retiring admission cannot retain its control session'));
      if (session && attempt.admission) {
        try { await attempt.admission; }
        catch (error) {
          // A correlated nonzero returnCode is a known refusal; timeout,
          // malformed grant, socket loss or retirement is not such a receipt.
          if (!error.serverResult) {
            leaveError = Object.assign(failure('OFFLINE_ADMISSION_UNCONFIRMED',
              'The cancelled admission is unconfirmed; its control session was retired'), { cause: error });
            session.close(leaveError);
          }
        }
      }
      if (session && sendLeave && attempt.participantID && !leaveError && !session.closed && owned(attempt)) {
        try {
          // This may be the participant from a late successful admission.
          await session.request('LocalNotify', 'LeaveConfNotify', {
            conferenceID: attempt.input.confId, participantID: attempt.participantID
          });
          leaveConfirmed = true;
        } catch (error) { leaveError = error; session.close(error); }
      }
      if (session && sendLeave && attempt.participantID && !leaveConfirmed && !leaveError && (!owned(attempt) || session.closed)) {
        leaveError = failure('OFFLINE_LEAVE_UNCONFIRMED', 'The participant leave was not confirmed before retirement');
        session.close(leaveError);
      }
      attempt.requestAbort.abort();
      const mediaError = await mediaDisposal;
      if (!leaveError && mediaError) leaveError = mediaError;
      if (session && attempt.ownsSession) session.close();
      if (attempt.release) { try { await attempt.release(); } catch (error) { if (!leaveError) leaveError = error; } }
      if (attempt.context.signal) attempt.context.signal.removeEventListener('abort', attempt.abort);
      attempt.admission = null;
      attempt.session = null;
      attempt.release = null;
      attempt.mediaReceipt = null;
      attempt.identity = {};
      attempt.password = '';
      attempt.input.password = '';
      attempt.input.random = '';
      attempt.grant = null;
      attempt.config = null;
      attempt.routeConfig = null;
      attempt.mediaInvites.clear();
      if (!reason) state(attempt, leaveError ? 'failed' : 'left', leaveError ? { error: { code: leaveError.code, message: leaveError.message } } : {});
      if (active === attempt) active = null;
      if (leaveError && !reason) throw leaveError;
      return { ...(reason ? { disposed: true, mediaReleased: !mediaError } : { left: true }),
        conferenceID: attempt.input.confId, participantID: attempt.participantID || '' };
    })().then(stopped.resolve, stopped.reject);
    return attempt.stopPromise;
  }
  function join(input, context = {}) {
    if (disposed) return Promise.reject(failure('DISPOSED', 'The offline conference owner was disposed'));
    if (active) return Promise.reject(failure('OFFLINE_BUSY', 'An offline conference is already owned'));
    if (typeof context.isCurrent !== 'function') return Promise.reject(failure('INVALID_OFFLINE_OWNER', 'A live account/document owner is required'));
    let normalized;
    try { normalized = normalizeInput(input, context); }
    catch (error) { return Promise.reject(error); }
    const attempt = active = { input: normalized, context, completion: deferred(), identity: {},
      serial: ++roomSerial, members: Object.create(null), basic: {}, mediaOperations: new Set(),
      memberGroups: { ParticipantsNotify: Object.create(null), AudiencesNotify: Object.create(null) },
      participantID: '', state: 'connecting', screenshotPolicy: 'unknown', ownsSession: true, stopped: false,
      work: Promise.resolve(), requestAbort: new AbortController(), mediaAbort: new AbortController(), mediaInvites: new Map() };
    attempt.abort = () => { stop(attempt, failure('OFFLINE_RETIRED', 'The offline owner was retired'), false).catch(() => {}); };
    if (context.signal) context.signal.addEventListener('abort', attempt.abort, { once: true });
    state(attempt, 'connecting');
    queued(attempt, () => prepare(attempt));
    return attempt.completion.promise;
  }
  async function setDevice(kind, enabled) {
    const attempt = active;
    if (!attempt || attempt.state !== 'joined') throw failure('OFFLINE_NOT_JOINED', 'No offline media participant is joined');
    current(attempt);
    const method = kind === 'microphone' ? 'setMicrophone' : 'setCamera';
    if (typeof media[method] !== 'function') throw failure('OFFLINE_MEDIA_CONTROL_MISSING', 'The media owner cannot control this device');
    const receipt = await media[method](enabled === true);
    current(attempt);
    rememberDevices(attempt, receipt);
    await reportDevices(attempt);
    return receipt;
  }
  async function answerMediaInvitation(kind, accepted, invitationId) {
    const attempt = active, invitation = attempt?.mediaInvites.get(kind);
    if (!attempt || !['microphone', 'camera'].includes(kind) || !invitation ||
        invitationId !== undefined && invitation.id !== invitationId)
      throw failure('OFFLINE_INVITATION_MISSING', 'There is no current device invitation');
    current(attempt);
    const valid = () => owned(attempt) && !attempt.stopped && attempt.state === 'joined' && !invitation.cancelled &&
      invitation.scope === moderationPolicy.state().scope && (kind !== 'camera' || moderationPolicy.allowed(4));
    if (!valid() && accepted) throw failure('MODERATION_INVITATION_REVOKED', 'The device invitation is no longer current');
    attempt.mediaInvites.delete(kind);
    let agreed = accepted === true, mediaError;
    if (agreed) {
      attempt.mediaOperations.add(invitation);
      try {
        const receipt = await setDevice(kind, true);
        if (!valid()) {
          await setDevice(kind, false);
          throw failure('MODERATION_INVITATION_REVOKED', 'The room/device invitation was revoked during capture');
        }
        agreed = kind === 'microphone' ? receipt.microphone : receipt.camera;
      } catch (error) { agreed = false; mediaError = error; }
      finally { attempt.mediaOperations.delete(invitation); }
    }
    current(attempt);
    const body = { conferenceID: attempt.input.confId, participantID: attempt.participantID,
      inviterParticipantID: invitation.inviterParticipantID, confToken: attempt.session.authorization,
      answer: kind === 'microphone' ? (agreed ? 0 : 1) : (agreed ? 3 : 2) };
    const result = await attempt.session.request('ConfControl', kind === 'microphone' ? 'ANSWER_MUTE' : 'ANSWER_VIDEO', body);
    if (mediaError) throw mediaError;
    return { ...result, accepted: agreed, serverOperationAcknowledged: true, serverPermissionGranted: false };
  }
  async function reportLocalDevices(receipt) {
    const attempt = active;
    if (!attempt || attempt.state !== 'joined' || receipt?.conferenceID !== attempt.input.confId ||
        String(receipt.participantID) !== attempt.participantID) return;
    current(attempt);
    rememberDevices(attempt, receipt);
    await reportDevices(attempt);
    event(attempt, { type: 'moderation-state', moderation: moderationState() });
  }
  function moderationState() {
    const attempt = active;
    return { ...moderationPolicy.state(),
      role: moderation.role(attempt?.members[attempt?.participantID], attempt?.grant?.role, moderationPolicy.allowed(0)),
      participants: attempt ? Object.values(attempt.members).map(member => ({ participantID: String(member.pid),
        name: member.pinfoMap?.NAME || '', role: moderation.role(member) })) : [],
      serverOrdersAlwaysEnforced: true };
  }
  async function configureCapability(type, enabled) {
    if (type === 3 && enabled && active) revokeInvitations(active, 'microphone', true);
    if (type === 4 && !enabled && active) revokeInvitations(active, 'camera');
    moderationPolicy.configure(type, enabled);
    if (active?.session && !active.stopped && ['joined', 'waiting'].includes(active.state)) {
      await subscribe(active, active.state === 'waiting' ? WAITING_SUBSCRIPTIONS : CONFERENCE_SUBSCRIPTIONS);
      event(active, { type: 'moderation-state', moderation: moderationState() });
    }
    return { configured: true, type, enabled, enforcement: 'native-CMS-admission-and-real-media',
      advertisedOn: active ? 'real-subscribe-and-next-join' : 'next-real-join',
      serverCapabilityAcknowledged: false, serverPermissionGranted: false, osPermissionGranted: false };
  }
  function grantMicrophoneConsent(scope) {
    const attempt = active;
    if (!attempt || attempt.state !== 'joined') throw failure('OFFLINE_NOT_JOINED', 'A current room is required for microphone consent');
    current(attempt); bindModeration(attempt); moderationPolicy.grant(scope); return moderationState();
  }
  async function revokeMicrophoneConsent() {
    if (active) revokeInvitations(active, 'microphone', true); else moderationPolicy.revoke();
    if (active?.state === 'joined') await subscribe(active, CONFERENCE_SUBSCRIPTIONS);
    return moderationState();
  }
  function deviceChanged() {
    if (active) {
      revokeInvitations(active, null, true);
      if (active.state === 'joined') queued(active, () => subscribe(active, CONFERENCE_SUBSCRIPTIONS));
    }
  }
  async function moderationControl(params = {}) {
    const attempt = active;
    if (!attempt || attempt.state !== 'joined') throw failure('OFFLINE_NOT_JOINED', 'A current room is required for moderation');
    current(attempt);
    const { operation, participantID, enabled } = params;
    if (typeof participantID !== 'string' || !participantID || operation !== 'waiting' && typeof enabled !== 'boolean')
      throw failure('INVALID_ARGUMENT', 'Expected participantID and boolean enabled');
    moderation.authorize({ operation, participantID, enabledValue: operation === 'waiting' ? true : enabled,
      ownID: attempt.participantID, ownRole: attempt.grant?.role, self: attempt.members[attempt.participantID],
      target: attempt.members[participantID], basic: attempt.basic, enabled: moderationPolicy.allowed });
    const body = { conferenceID: attempt.input.confId, participantID, confToken: attempt.session.authorization };
    if (operation === 'cohost') body.isCohost = enabled ? 1 : 0;
    if (operation === 'microphone') body.isMute = enabled ? 0 : 1;
    if (operation === 'camera') body.status = enabled ? 1 : 0;
    const type = { cohost: 'CO_HOST', waiting: 'MOVETOWAITINGROOM', microphone: 'MUTE', camera: 'VIDEO' }[operation];
    await attempt.session.request('ConfControl', type, body);
    current(attempt);
    return { operation, participantID, serverOperationAcknowledged: true, membershipChanged: false,
      serverPermissionGranted: false, source: 'correlated-CMS-response' };
  }
  function leave() { return active ? stop(active, null) : Promise.resolve({ left: true }); }
  function dispose() {
    if (disposed) return Promise.resolve();
    disposed = true;
    return active ? stop(active, failure('OFFLINE_RETIRED', 'The offline conference owner was disposed'), false) : Promise.resolve();
  }
  return Object.freeze({ join, leave, dispose, setMicrophone: enabled => setDevice('microphone', enabled),
    setCamera: enabled => setDevice('camera', enabled), answerMediaInvitation, reportLocalDevices,
    configureCapability, moderationState, moderationControl, grantMicrophoneConsent, revokeMicrophoneConsent, deviceChanged,
    getState: () => active ? { state: active.state, conferenceID: active.input.confId, participantID: active.participantID,
      screenshotPolicy: active.screenshotPolicy } : { state: 'idle' } });
}

module.exports = { createOfflineControl, resolveRoutes };
