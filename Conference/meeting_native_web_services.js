'use strict';

/* Real meeting-management services; no SDK emulation and no implicit join/capture.
 * Factory: createMeetingServices({request, requestManagement, requestManagementAttempt}); request is the
 * parent's authenticated, same-origin HTTPS transport. HTTP results retain
 * {status, data, headers}, unwrapping only legacy {returnCode, data} envelopes.
 * Invitation HTTP 200 acknowledgements may have an empty body. The optional
 * requestManagement(type, body) sends genuine USG management WebSocket requests,
 * injects the raw USG token, and returns the sequence-matched original frame.
 * CTD results retain that frame without inventing an HTTP status.
 * requestManagementAttempt is transport.begin; it enables per-attempt CTD
 * cancellation. call.ctd.state({callRequestId?}) exposes only that local attempt;
 * call.ctd.cancel({attemptId}) records intent, never a fabricated end result.
 * start returns callState alongside real results; only phase=created is dial
 * acceptance. phase=not_sent is local abort, cancelled requires an accepted
 * conference.cancel(type=1), and unknown/end_failed forbid duplicate redial.
 * retireCalls must run before account teardown; it never issues an end request.
 * Errors retain response, actual status and vendor code; transport errors propagate unchanged.
 *
 * Provenance (public static reads, not inferred routes): portal-main.13b7727d.js
 * module 800 loads /cmp/; its manifest identifies main.59cd8020.chunk.js.
 * That bundle's module 15 defines every route below, module 5 defines offset/limit
 * pagination, modules 984/970 define booking/edit/cycle actions, and module 972
 * defines VMR actions. /cmp/static/js/29.f191837a.chunk.js identifies scheduling
 * 11.13bc5526, editing 4.eb849fbc, list 12.28b8054f, and VMR 14.824390bc bundles.
 * Portal module 28 recognizes legacy returnCode=0 and rejects HTTP 204.
 * Original tup_confctrl.dll corroborates creation/booking response arrays and
 * /v1/usg/dcs/member/vmr/{id}, gustPwd/chairPwd/allowGustFirst spelling.
 *
 * Inputs: create/schedule use {body: MMCBody} or original {createConfInfo} /
 * {book_conf_info_uportal}. update uses {conferenceID, body} or
 * {modify_conf_info_uportal:{confid,...}}. The original UISDK createConf object
 * {subject,isVideo,attendees:[{number,name,uuid}],vmrId,noPassword,...} is also
 * accepted directly. ID aliases confId/conf_id match hwmService.getConfInfo.
 * Body times are the vendor's UTC strings; no local-time reinterpretation occurs.
 * Native mic/camera preferences are returned as joinPreferences, never sent to MMC.
 * List/detail accept offset/limit, pageIndex/pageSize or page_index/page_size;
 * all:true follows actual server pagination. Details default to 20 attendees
 * (100 for native conf_id); vmr.list with no pagination returns all personal and
 * special VMR pages, as hwmService.getVMRList requires. Explicit pagination returns
 * one page (personal unless specialVmr:true). Aggregation preserves real pages.
 * Native detail/VMR response translations are returned under native, without
 * result/code success stubs. VMR id is the resource ID; vmrId is the dialable ID.
 * Cycle schedule/update use {body} / {conferenceID,body}; occurrence update adds
 * body.cycleSubConfID. Modern cycle cancel takes {conferenceID}; occurrence cancel
 * takes {conferenceID,cycleSubConfIDs:[...]}. cycle.list takes {conferenceID,
 * status:0|1,...pagination} (default TOBEHELD=1). Legacy cycle cancellation uses
 * {conferenceID}; legacy.occurrences.cancel takes {conferenceIDs:[...]}.
 * These are separate real portal paths, not fallback retries between APIs.
 *
 * Invitations: conference.inviteByToken takes {conferenceID, conferenceToken}
 * or {conferenceID, chairmanPwd}, plus {attendees}, {body:{attendees}}, or
 * {num_of_attendee,attendee_info}. Official meeting_21_0030.html documents
 * POST /v1/mmc/control/conferences/participants with X-Conference-Authorization.
 * meeting_21_0027.html documents GET /v1/mmc/control/conferences/token with
 * X-Password and X-Login-Type:1; its response.data.token is NOT a USG token.
 * An HTTP 200 reply acknowledges invitation submission, not recipient attendance.
 * normalizeInvitation returns the CMS DTO by default, for the parent's current-
 * conference operation. WebRTC module 2500.addAttendees -> module 51339 sends
 * ConfControl/INVITE, sequence=traceId, with attendees unchanged. The response
 * carries returnCode; later InviteResultNotify carries per-recipient resultCode.
 * tup_confctrl.dll uportal_AddAttendee (VA 0x1002f540) corroborates CMS fields
 * and its forced isAutoInvite=1. HTTP and CMS-only attendee fields stay separate.
 *
 * conference.pstnNumbers takes {} or {corpId}, and queries the authenticated
 * user's /v1/usg/acs/ap/userservicedata. WebRTC module 33556.getUserServiceData
 * defines that GET and optional corpId. tup_login.dll JsonParseUSGUserServiceData
 * (0x1001e324) passes corpCfg to JsonParseUSGCorpCfgInfo; 0x100190ee reads
 * pstnNumber. This is the configured number used by the native notify1036
 * pstnAccessNumber result, returned here under native.pstnNumber, unchanged.
 * Missing/empty configuration is unavailable, never a guessed phone number.
 *
 * call.ctd.start takes {caller_number,callee_number,callRequestId?}; the optional
 * renderer correlation ID is local metadata, never part of the wire body.
 * The original Windows facade calls BookCtdConf, not /opengw/number/{number}/ctd. Its request
 * is ConfManagement/CREATECONF with ctd:true (tup_confctrl.dll 0x10033620,
 * 0x100360b0, 0x1007ca00). The separate management socket uses the authenticated
 * USG host, /v1/usg/wss/websocket?agent={userAgent}, raw X-Auth-Token, and
 * tup_service_protocol (0x1007f720; tup_httptrans.dll 0x10023b5d, 0x10028494).
 * The parent owns that transport, its handshake credentials, request sequence,
 * timeout and teardown; the browser's current-conference CMS is not a fallback.
 * Native getBookConfResult (0x10028030) requires returnCode=0 and data[0].
 * Completion is server creation/auto-invitation acceptance, not call connection.
 * Without requestManagement the instance's call.ctd.start capability is false.
 *
 * Boundary: retain the original method://conference/bookConfOutside,
 * editConfOutside, cancelConfOutSide, openBookMeetingDialog and
 * method://private_conference/getConfDetailByConfID middle-ground facades.
 * bookMeeting.js bookConfApi/editCloudConf use
 * mcloud/mag/ProxyForText/usg/meetingroom_common/api/meeting/v1/HWCloud
 * (edit: /oneroom/update/{bookingId}). rooms/materialPermission/oneRoomConfig/
 * weLinkVO are NOT MMC fields and must not be routed through this module.
 */

const { createPendingCallController } = require('./meeting_pending_call');

const CONFERENCES = '/v1/mmc/management/conferences';
const CYCLES = '/v1/mmc/management/cycleconferences';
const VMRS = '/v1/usg/dcs/member/vmr';
const PORTAL_HEADERS = Object.freeze({ 'X-Invoke-From': 'portal' });
const capabilities = Object.freeze({
  'conference.create': true,
  'conference.schedule': true,
  'conference.update': true,
  'conference.cancel': true,
  'conference.list': true,
  'conference.details': true,
  'conference.inviteByToken': true,
  'conference.pstnNumbers': true,
  'call.ctd.start': true,
  'call.ctd.state': true,
  'call.ctd.cancel': true,
  'vmr.list': true,
  'vmr.update': true,
  'conference.cycle.schedule': true,
  'conference.cycle.update': true,
  'conference.cycle.cancel': true,
  'conference.cycle.list': true,
  'conference.cycle.occurrence.update': true,
  'conference.cycle.occurrence.cancel': true,
  'conference.cycle.legacy.cancel': true,
  'conference.cycle.legacy.occurrences.cancel': true
});
const BODY_FIELDS = new Set([
  'subject', 'startTime', 'length', 'mediaTypes', 'timeZoneID', 'attendees',
  'vmrID', 'vmrFlag', 'conferenceType', 'isAutoRecord', 'recordAuthType',
  'recordType', 'recordAuxStream', 'confConfigInfo', 'cycleParams', 'description',
  'duration', 'picDisplay', 'picLayouts', 'confResType', 'concurrentParticipants',
  'liveChannelID', 'liveRoomName', 'liveAddress', 'auxAddress', 'liveUrl',
  'cycleSubConfID', 'enableWaitingRoom'
]);
const VMR_FIELDS = new Set([
  'vmrName', 'chairPwd', 'gustPwd', 'allowGustFirst', 'gustFirstNotice',
  'supportWaitingRoom', 'callInRestriction'
]);
const ID_FIELDS = ['conferenceID', 'confId', 'conf_id'];
const PAGE_FIELDS = ['offset', 'limit', 'pageIndex', 'pageSize', 'page_index', 'page_size', 'all'];
const LIST_FIELDS = ['userUUID', 'queryAll', 'status', 'searchKey', 'queryConfMode'];
const ATTENDEE_TYPES = ['normal', 'telepresence', 'terminal', 'outside',
  'customnumber', 'mobile', 'anonymous', 'telephone', 'board'];
const INVITATION_FIELDS = ['attendees', 'body', 'num_of_attendee', 'attendee_info'];
const HTTP_INVITEE_FIELDS = new Set([
  'userUUID', 'accountId', 'name', 'role', 'phone', 'phone2', 'phone3',
  'email', 'sms', 'type', 'deptUUID', 'deptName'
]);
const CMS_INVITEE_FIELDS = new Set([
  'userUUID', 'accountId', 'appId', 'name', 'role', 'phone', 'isMute',
  'sms', 'type', 'isAutoInvite', 'aliasCN', 'aliasEN'
]);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function invalid(message) {
  const error = new TypeError(message);
  error.code = 'INVALID_PARAMS';
  return error;
}
function record(value, name) {
  if (!object(value)) throw invalid(`${name} must be an object`);
  return value;
}
function keys(value, allowed, name = 'params') {
  record(value, name);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw invalid(`${name} contains unsupported field ${key}`);
  }
}
function pick(source, names) {
  const result = {};
  for (const name of names) if (own(source, name) && source[name] !== undefined) result[name] = source[name];
  return result;
}
function alias(source, names) {
  let value;
  for (const name of names) {
    if (!own(source, name) || source[name] === undefined) continue;
    if (value !== undefined && value !== source[name]) throw invalid(`Conflicting ${names.join('/')} values`);
    value = source[name];
  }
  return value;
}
function identifier(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalid(`${name} must be a nonempty service identifier`);
  return value;
}
function conferenceID(params) {
  return identifier(alias(params, ID_FIELDS), 'conferenceID');
}
function integer(value, name, minimum) {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < minimum) throw invalid(`${name} must be an integer >= ${minimum}`);
  return number;
}
function flag(value, name) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  throw invalid(`${name} must be boolean or 0/1`);
}
function put(target, key, value) {
  if (value !== undefined) target[key] = value;
}
function mapFields(source, mapping) {
  const result = {};
  for (const [from, to] of Object.entries(mapping)) put(result, to, source[from]);
  return result;
}

function pagination(params, defaultLimit) {
  const page = alias(params, ['pageIndex', 'page_index']);
  const size = alias(params, ['pageSize', 'page_size']);
  if ((page !== undefined || size !== undefined) && (own(params, 'offset') || own(params, 'limit'))) {
    throw invalid('Use offset/limit or pageIndex/pageSize, not both');
  }
  const limit = integer(size === undefined ? (params.limit === undefined ? defaultLimit : params.limit) : size, 'limit', 1);
  const offset = page === undefined ? integer(params.offset === undefined ? 0 : params.offset, 'offset', 0) :
    (integer(page, 'pageIndex', 1) - 1) * limit;
  if (!Number.isSafeInteger(offset)) throw invalid('Pagination offset is too large');
  return { offset, limit };
}
function hasPagination(params) {
  return PAGE_FIELDS.slice(0, -1).some(key => own(params, key));
}

// bookMeeting.js gives the numeric attendee table and booking media masks:
// AUDIO=1, VIDEO=5, VOICE_DATA=17, MULTIMEDIA=21. Create uses a separate flag.
function nativeAttendee(attendee) {
  record(attendee, 'attendee');
  const result = mapFields(attendee, {
    name: 'name', number: 'phone', email: 'email', sms: 'sms', role: 'role',
    is_mute: 'isMute', isMute: 'isMute', deptName: 'deptName', hideType: 'hideType'
  });
  put(result, 'userUUID', alias(attendee, ['user_uuid', 'uuid', 'userUUID']));
  put(result, 'accountId', alias(attendee, ['acount_id', 'account_id', 'accountId', 'account']));
  if (attendee.type !== undefined) {
    if (typeof attendee.type === 'string' && ATTENDEE_TYPES.includes(attendee.type)) result.type = attendee.type;
    else {
      const type = integer(attendee.type, 'attendee.type', 0);
      if (type >= ATTENDEE_TYPES.length) throw invalid('Unsupported native attendee type');
      result.type = ATTENDEE_TYPES[type];
    }
  }
  return result;
}

function normalizeInvitation(params, provider = 'cms') {
  keys(params, new Set(INVITATION_FIELDS));
  if (provider !== 'cms' && provider !== 'http') throw invalid('Unknown invitation provider');
  const shapes = ['attendees', 'body', 'attendee_info'].filter(key => own(params, key));
  if (shapes.length !== 1) throw invalid('Use one invitation attendee shape');
  const native = shapes[0] === 'attendee_info';
  if (!native && own(params, 'num_of_attendee')) throw invalid('num_of_attendee requires attendee_info');
  let attendees;
  if (shapes[0] === 'body') {
    keys(params.body, new Set(['attendees']), 'body');
    attendees = params.body.attendees;
  } else attendees = params[shapes[0]];
  if (!Array.isArray(attendees) || !attendees.length) throw invalid('attendees must be a nonempty array');
  if (native && integer(params.num_of_attendee, 'num_of_attendee', 1) !== attendees.length) {
    throw invalid('num_of_attendee does not match attendee_info');
  }
  const fields = provider === 'cms' ? CMS_INVITEE_FIELDS : HTTP_INVITEE_FIELDS;
  return { attendees: attendees.map(attendee => {
    record(attendee, 'attendee');
    let translated;
    if (native) {
      const mapped = nativeAttendee(attendee);
      // NativeWndService::AddAttendee reads number/name/account_id/user_uuid,
      // is_mute/role/type/sms/email; uportal_AddAttendee omits email and forces
      // isAutoInvite=1. A requested CMS-only mute cannot be lost on HTTP.
      if (provider === 'http' && (own(attendee, 'is_mute') || own(attendee, 'isMute'))) {
        throw invalid('Native invite mute settings require the current-conference CMS provider');
      }
      translated = pick(mapped, fields);
      if (translated.name === undefined) translated.name = '';
      if (translated.type === undefined) translated.type = ATTENDEE_TYPES[0];
      if (provider === 'cms') translated.isAutoInvite = 1;
    } else {
      keys(attendee, fields, 'attendee');
      translated = { ...attendee };
    }
    if (typeof translated.phone !== 'string' || !translated.phone) throw invalid('attendee.phone must be a nonempty string');
    if (typeof translated.name !== 'string') throw invalid('attendee.name must be a string');
    if (provider === 'http' && translated.name.length > 96) throw invalid('HTTP attendee.name must contain at most 96 characters');
    if (typeof translated.type !== 'string' || !translated.type) throw invalid('attendee.type must be a nonempty string');
    return translated;
  }) };
}

function ctdBody(params) {
  keys(params, new Set(['caller_number', 'callee_number', 'callRequestId']));
  callRequestId(params.callRequestId);
  for (const key of ['caller_number', 'callee_number']) {
    if (typeof params[key] !== 'string' || !params[key]) throw invalid(`${key} must be a nonempty string`);
  }
  // NativeWndService::BookCtdConf (hwm_winconfui.dll 0x106995a0) zeroes
  // BookConfParam, sets two normal attendees, caller role=1 and callee role=0.
  // hwm_sdk_ext.dll 0x100d5f20/0x100e7a80 preserves size=0 and empty subject.
  // uportal_BookConf/BuildCtdConfManageBasicInfo supply the fixed fields below.
  const attendee = (phone, role) => ({
    accountId: '', name: '', role, phone, email: '', sms: '',
    isMute: 0, isAutoInvite: 1, type: 'normal'
  });
  return {
    ctd: true, size: 0, length: 60, confType: 'FUTURE', subject: '',
    mediaTypes: 'Voice', welcomeVoiceEnable: 0, isAutoRecord: 0,
    recordType: 0, multiStreamFlag: 0, timeZoneID: '56', language: 'zh-CN',
    recordAuxStream: 1,
    attendees: [attendee(params.caller_number, 1), attendee(params.callee_number, 0)],
    confConfigInfo: {
      confExtendProperties: [{ propertyKey: 'supportWatermark', propertyValue: false }]
    }
  };
}

function callRequestId(value) {
  if (value !== undefined && (typeof value !== 'string' || !value || value.length > 128))
    throw invalid('callRequestId must be a nonempty local request identifier of at most 128 characters');
  return value;
}

function ctdResult(operation, response) {
  if (!object(response) || response.action !== 'ConfManagement' || response.type !== 'CREATECONF' ||
      typeof response.sequence !== 'string' || !response.sequence || typeof response.data !== 'string') {
    throw malformed(operation, response, 'ConfManagement/CREATECONF response frame');
  }
  let body;
  try { body = JSON.parse(response.data); }
  catch (_) { throw malformed(operation, response, 'JSON data'); }
  if (!object(body) || !Number.isInteger(body.returnCode)) throw malformed(operation, response, 'integer returnCode');
  if (body.returnCode !== 0) {
    const error = serviceError(operation, response, body.returnCode, body.returnDesc);
    error.details = { creationRefused: true, resultConfirmed: true, transmissionAttempted: true };
    throw error;
  }
  if (!Array.isArray(body.data) || !body.data.length) throw malformed(operation, response, 'conference array');
  body.data.forEach(conf => validateConference(conf, operation, response));
  return { transport: 'websocket', data: body.data, response,
    conference: body.data[0], conferenceID: body.data[0].conferenceID };
}
function bookingMedia(value) {
  if (value === 5 || value === 21 || value === true) return 'HDVideo,Voice,Data';
  if (value === 0 || value === 1 || value === 17 || value === false) return 'Voice,Data';
  throw invalid('Unsupported booking media_type');
}
function createMedia(value, name) {
  // hwmService.createConf forwards createConfInfo.media_type unchanged to
  // UISDK isVideo, so both create entry shapes must use the same 0/1 flag.
  return flag(value, name) ? 'HDVideo,Voice,Data' : 'Voice,Data';
}
function nativeBody(source, isCreate) {
  record(source, 'native conference');
  const body = mapFields(source, {
    subject: 'subject', start_time: 'startTime', conf_len: 'length', time_zone: 'timeZoneID',
    vmr_id: 'vmrID', vmr_flag: 'vmrFlag', record_operation_mode: 'isAutoRecord',
    isAutoRecord: 'isAutoRecord', record_type: 'recordType', record_aux_stream: 'recordAuxStream',
    bookSelectRecordPlaybackPermission: 'recordAuthType', description: 'description'
  });
  if (source.media_type !== undefined) {
    body.mediaTypes = isCreate ? createMedia(source.media_type, 'media_type') : bookingMedia(source.media_type);
  }
  if (source.attendee !== undefined) {
    if (!Array.isArray(source.attendee)) throw invalid('attendee must be an array');
    body.attendees = source.attendee.map(nativeAttendee);
  }
  const config = source.ex_config_info === undefined ? {} : record(source.ex_config_info, 'ex_config_info');
  const translated = mapFields(config, {
    call_in_restriction: 'callInRestriction', is_send_conference: 'isSendPublic',
    is_send_notify: 'isSendNotify', is_send_sms: 'isSendSms',
    is_send_calendar_notify: 'isSendCalendar', guestPwd: 'guestPwd', vmrIDType: 'vmrIDType',
    allowGuestStartConf: 'allowGuestStartConf', joinBeforeHostTime: 'joinBeforeHostTime',
    is_open_waiting_room: 'enableWaitingRoom'
  });
  const free = alias(config, ['is_guest_free_pwd']);
  const noPassword = free === undefined ? source.nopassword : free;
  if (noPassword !== undefined) translated.isGuestFreePwd = flag(noPassword, 'nopassword');
  if (Object.keys(translated).length) body.confConfigInfo = translated;
  put(body, 'cycleParams', config.cycleParams);
  return body;
}
function uiSdkBody(source) {
  // isVideo and createConfInfo.media_type are the same observed create flag,
  // not the booking/edit media mask.
  const body = pick(source, ['subject', 'isAutoRecord']);
  put(body, 'vmrID', source.vmrId);
  if (source.isVideo !== undefined) body.mediaTypes = createMedia(source.isVideo, 'isVideo');
  if (source.attendees !== undefined) {
    if (!Array.isArray(source.attendees)) throw invalid('attendees must be an array');
    body.attendees = source.attendees.map(nativeAttendee);
  }
  const config = {};
  if (source.noPassword !== undefined) config.isGuestFreePwd = flag(source.noPassword, 'noPassword');
  put(config, 'callInRestriction', source.callInRestrictionType);
  if (Object.keys(config).length) body.confConfigInfo = config;
  return body;
}
function conferenceBody(params, mode) {
  const wrappers = ['body', 'createConfInfo', 'book_conf_info_uportal', 'modify_conf_info_uportal'];
  const present = wrappers.filter(name => own(params, name));
  if (present.length > 1) throw invalid('Use one conference body shape');
  let body;
  let source;
  if (present.length) {
    keys(params, new Set([...ID_FIELDS, ...wrappers, 'initNativeWndInfo']));
    source = record(params[present[0]], present[0]);
    body = present[0] === 'body' ? { ...source } : nativeBody(source, present[0] === 'createConfInfo');
  } else {
    keys(params, new Set(['subject', 'isAutoRecord', 'attendees', 'vmrId', 'isCameraOn',
      'isMicOn', 'noPassword', 'callInRestrictionType', 'isVideo']));
    source = params;
    body = uiSdkBody(source);
  }
  keys(body, BODY_FIELDS, 'body');
  if (body.attendees !== undefined && !Array.isArray(body.attendees)) throw invalid('body.attendees must be an array');
  if (body.confConfigInfo !== undefined) record(body.confConfigInfo, 'confConfigInfo');
  if (body.cycleParams !== undefined) record(body.cycleParams, 'cycleParams');
  // module 984: regular immediate/future requests use 0; cycle endpoint uses 2.
  const cycle = mode.startsWith('cycle');
  const occurrence = mode === 'cycle-occurrence-update';
  if (!occurrence) {
    const type = cycle ? 2 : 0;
    if (body.conferenceType !== undefined && body.conferenceType !== type) throw invalid('conferenceType conflicts with operation');
    body.conferenceType = type;
  }
  if (mode === 'create' && body.startTime) throw invalid('Immediate creation does not accept startTime; use conference.schedule');
  if ((mode === 'schedule' || mode === 'cycle-schedule') && (typeof body.startTime !== 'string' || !body.startTime)) {
    throw invalid('Scheduled conferences require the vendor UTC startTime');
  }
  if (mode === 'cycle-schedule' && !body.cycleParams) throw invalid('Cycle scheduling requires cycleParams');
  if (occurrence) identifier(body.cycleSubConfID, 'cycleSubConfID');
  // Preserve server defaults when omitted; never select another VMR or account.
  if (body.vmrID !== undefined) {
    if (body.vmrID !== '' && body.vmrID !== null) identifier(body.vmrID, 'vmrID');
    const vmrFlag = body.vmrID ? 1 : 0;
    if (body.vmrFlag !== undefined && Number(body.vmrFlag) !== vmrFlag) throw invalid('vmrFlag conflicts with vmrID');
    body.vmrFlag = vmrFlag;
  }
  const joinPreferences = {};
  const camera = alias(source, ['isOpenCameraDe', 'isCameraOn']);
  const mic = alias(source, ['isOpenMicDe', 'isMicOn']);
  if (camera !== undefined) joinPreferences.isCameraOn = flag(camera, 'isCameraOn');
  if (mic !== undefined) joinPreferences.isMicOn = flag(mic, 'isMicOn');
  return { body, joinPreferences };
}

function serviceError(operation, response, code, message) {
  const error = new Error(message || `Meeting service rejected ${operation}`);
  error.name = 'MeetingServiceError';
  error.code = code;
  error.status = response && response.status;
  error.response = response;
  return error;
}
function malformed(operation, response, field) {
  return serviceError(operation, response, 'INVALID_SERVICE_RESPONSE', `Invalid ${operation} response: ${field}`);
}
function zero(code) {
  return code === 0 || (typeof code === 'string' && /^0+$/.test(code));
}
function accepted(operation, response, invitationAck = false) {
  if (!object(response) || !Number.isInteger(response.status)) throw malformed(operation, response, 'HTTP status');
  const value = response.data;
  let code;
  let message;
  if (object(value)) {
    code = value.error_code !== undefined ? value.error_code : value.returnCode;
    message = value.error_msg || value.returnDesc;
    if (code === undefined && own(value, 'code')) { code = value.code; message = value.message; }
  }
  if (response.status < 200 || response.status >= 300 || response.status === 204 ||
      (invitationAck && response.status !== 200) || (code !== undefined && !zero(code))) {
    throw serviceError(operation, response, code === undefined ? String(response.status) : code, message);
  }
  if (invitationAck && (value === undefined || value === null || value === '')) {
    return { status: response.status, data: value, headers: response.headers };
  }
  if (!object(value) && !Array.isArray(value)) throw malformed(operation, response, 'JSON body');
  if (object(value) && own(value, 'returnCode') && !own(value, 'data')) {
    // Ack-only legacy responses carry their own success marker, not invented data.
    return { status: response.status, data: value, headers: response.headers };
  }
  return { status: response.status, data: object(value) && own(value, 'returnCode') ? value.data : value, headers: response.headers };
}
function validateConference(value, operation, response) {
  if (!object(value) || typeof value.conferenceID !== 'string' || !value.conferenceID) throw malformed(operation, response, 'conferenceID');
  return value;
}
function pageInfo(page, operation, response) {
  if (!object(page) || !Array.isArray(page.data)) throw malformed(operation, response, 'paged data array');
  let offset, limit, count;
  try {
    offset = integer(page.offset, 'offset', 0);
    limit = integer(page.limit, 'limit', 1);
    count = integer(page.count, 'count', 0);
  } catch (_) { throw malformed(operation, response, 'offset/limit/count'); }
  if (page.data.length > limit) throw malformed(operation, response, 'page length');
  return { offset, limit, count };
}
function nativeDetails(data) {
  const conf = data.conferenceData;
  const info = mapFields(conf, {
    conferenceID: 'conf_id', subject: 'conf_subject', startTime: 'start_time', endTime: 'end_time',
    accessNumber: 'access_number', scheduserName: 'scheduser_name', vmrID: 'vmr_id',
    vmrConferenceID: 'vmr_conferenceid', vmrFlag: 'vmr_flag', isAutoRecord: 'is_auto_record',
    recordType: 'record_type', recordAuxStream: 'record_aux_stream', guestJoinUri: 'guest_join_uri',
    chairJoinUri: 'chair_join_uri'
  });
  if (typeof conf.mediaTypes === 'string') info.media_type = /Video/.test(conf.mediaTypes) ? 1 : 0;
  if (Array.isArray(conf.passwordEntry)) {
    for (const entry of conf.passwordEntry) {
      if (entry.conferenceRole === 'chair') put(info, 'chairman_pwd', entry.password);
      if (entry.conferenceRole === 'general') put(info, 'guest_pwd', entry.password);
    }
  }
  if (object(conf.confConfigInfo)) info.ex_config_info = mapFields(conf.confConfigInfo, {
    isSendCalendar: 'isEmailCalenderOn', isSendNotify: 'isMailOn', isGuestFreePwd: 'is_guest_free_pwd',
    isSendSms: 'is_send_sms', callInRestriction: 'joinConfRestrictionType'
  });
  return { confDetailInfo: info, confAttendee: data.data.data.map(attendee => {
    const translated = mapFields(attendee, {
      accountId: 'acount_id', userUUID: 'user_uuid', email: 'email', isMute: 'is_mute',
      name: 'name', phone: 'number', role: 'role', sms: 'sms'
    });
    if (attendee.type !== undefined) {
      const type = ATTENDEE_TYPES.indexOf(attendee.type);
      translated.type = type === -1 ? attendee.type : type;
    }
    return translated;
  }) };
}
function nativeVmrs(groups) {
  // 14.824390bc queries personal/special resources separately with specialVmr.
  // Do not assume /member/vmr returns the login-only vmrMode field. Original
  // bundle.js declares PERSONAL_CONF_ID=1, PRIVATE_CONF_ID=2; cmp 11 ENABLE=0.
  const vmrs = [];
  for (const group of groups) {
    for (const item of group.data) {
      const vmr = mapFields(item, { id: 'vmr_id', vmrId: 'conf_id', vmrName: 'conf_subject',
        chairPwd: 'chairman_pwd', gustPwd: 'guest_pwd', vmrPkgParties: 'max_parties' });
      put(vmr, 'user_name', item.vmrName);
      vmr.site_call_type = group.specialVmr ? 2 : 1;
      if (item.status !== undefined) vmr.vmr_status = item.status === 0;
      vmrs.push(vmr);
    }
  }
  const personal = vmrs.find(item => item.site_call_type === 1);
  return { vmrInfo: personal || null, specVmrInfo: vmrs.filter(item => item !== personal) };
}

function createMeetingServices({ request, requestManagement, requestManagementAttempt }) {
  if (typeof request !== 'function') throw invalid('request must be a function');
  if (requestManagement !== undefined && typeof requestManagement !== 'function') throw invalid('requestManagement must be a function');
  if (requestManagementAttempt !== undefined && typeof requestManagementAttempt !== 'function')
    throw invalid('requestManagementAttempt must be a function');
  const pendingCall = requestManagementAttempt ? createPendingCallController({
    kind: 'ctd', beginCreate: body => requestManagementAttempt('CREATECONF', body),
    decodeCreate: response => ctdResult('call.ctd.start', response),
    endConference: id => execute('conference.cancel', { conferenceID: id, type: 1 })
  }) : null;
  const serviceCapabilities = Object.freeze({ ...capabilities,
    'call.ctd.start': !!(requestManagement || pendingCall),
    'call.ctd.state': !!pendingCall, 'call.ctd.cancel': !!pendingCall });
  async function call(operation, method, path, options) {
    return accepted(operation, await request(method, path, options));
  }
  async function collect(operation, path, query, headers, all, details = false) {
    const pages = [];
    let result;
    let items;
    let next = query.offset;
    let first;
    for (;;) {
      const current = await call(operation, 'GET', path, { query: { ...query, offset: next }, headers });
      const page = details ? current.data && current.data.data : current.data;
      const paging = pageInfo(page, operation, current);
      if (paging.offset !== next) throw malformed(operation, current, 'returned offset');
      if (details) validateConference(current.data.conferenceData, operation, current);
      if (!result) { result = current; first = paging; items = page.data.slice(); }
      else {
        if (details && current.data.conferenceData.conferenceID !== result.data.conferenceData.conferenceID) throw malformed(operation, current, 'changed conferenceID');
        items.push(...page.data);
      }
      pages.push(current.data);
      if (!all || paging.offset + page.data.length >= paging.count) break;
      if (!page.data.length) throw malformed(operation, current, 'empty page before count');
      next = paging.offset + page.data.length;
    }
    if (pages.length > 1) {
      const combined = { ...(details ? result.data.data : result.data), offset: first.offset,
        limit: items.length, count: first.count, data: items };
      result = { ...result, data: details ? { ...result.data, data: combined } : combined, pages };
    }
    return result;
  }
  async function execute(operation, params = {}) {
    if (!own(capabilities, operation)) {
      const error = new Error(`Unsupported meeting service operation: ${operation}`);
      error.code = 'UNSUPPORTED_OPERATION';
      throw error;
    }
    record(params, 'params');
    switch (operation) {
      case 'call.ctd.start': {
        const body = ctdBody(params);
        if (pendingCall) return pendingCall.start(body, {
          retryKey: JSON.stringify([params.caller_number, params.callee_number]), callRequestId: params.callRequestId
        });
        if (!requestManagement) {
          const error = new Error('The genuine USG management WebSocket provider is not connected');
          error.code = 'CTD_PROVIDER_UNAVAILABLE';
          throw error;
        }
        return ctdResult(operation, await requestManagement('CREATECONF', body));
      }
      case 'call.ctd.state':
      case 'call.ctd.cancel': {
        keys(params, new Set(operation === 'call.ctd.state' ? ['callRequestId'] : ['attemptId']));
        if (!pendingCall)
          throw Object.assign(new Error('The genuine pending-call management provider is not connected'),
            { code: 'CTD_PROVIDER_UNAVAILABLE' });
        return operation === 'call.ctd.state' ? pendingCall.getState(callRequestId(params.callRequestId)) :
          pendingCall.cancel(params.attemptId);
      }
      case 'conference.inviteByToken': {
        keys(params, new Set([...ID_FIELDS, ...INVITATION_FIELDS, 'conferenceToken', 'chairmanPwd']));
        const id = conferenceID(params);
        const body = normalizeInvitation(pick(params, INVITATION_FIELDS), 'http');
        const credentials = ['conferenceToken', 'chairmanPwd'].filter(key => own(params, key));
        if (credentials.length !== 1) throw invalid('Use conferenceToken or chairmanPwd, not both');
        const credential = params[credentials[0]];
        if (typeof credential !== 'string' || !credential || /[\r\n]/.test(credential)) {
          throw invalid(`${credentials[0]} must be a nonempty header-safe string`);
        }
        let token = credential;
        if (credentials[0] === 'chairmanPwd') {
          const response = await request('GET', '/v1/mmc/control/conferences/token', {
            query: { conferenceID: id }, headers: { 'X-Password': credential, 'X-Login-Type': 1 }
          });
          const authorization = accepted(operation, response);
          if (!object(authorization.data) || !object(authorization.data.data) ||
              typeof authorization.data.data.token !== 'string' || !authorization.data.data.token ||
              /[\r\n]/.test(authorization.data.data.token)) {
            throw malformed(operation, response, 'data.token');
          }
          token = authorization.data.data.token;
        }
        // Never retry an invitation with another provider or credential: an
        // interrupted reply cannot tell us whether recipients were already called.
        return accepted(operation, await request('POST', '/v1/mmc/control/conferences/participants', {
          query: { conferenceID: id }, headers: { 'X-Conference-Authorization': token }, body
        }), true);
      }
      case 'conference.pstnNumbers': {
        keys(params, new Set(['corpId']));
        const query = {};
        if (params.corpId !== undefined) query.corpId = identifier(params.corpId, 'corpId');
        const response = await request('GET', '/v1/usg/acs/ap/userservicedata', { query });
        const result = accepted(operation, response);
        if (!object(result.data) || !object(result.data.corpCfg)) {
          throw malformed(operation, response, 'corpCfg');
        }
        const number = result.data.corpCfg.pstnNumber;
        if (number === undefined || number === '') {
          throw serviceError(operation, response, 'PSTN_NUMBER_UNAVAILABLE',
            'The real corporate configuration does not provide a PSTN access number');
        }
        if (typeof number !== 'string') throw malformed(operation, response, 'corpCfg.pstnNumber');
        result.native = { pstnNumber: number };
        return result;
      }
      case 'conference.create':
      case 'conference.schedule':
      case 'conference.update':
      case 'conference.cycle.schedule':
      case 'conference.cycle.update':
      case 'conference.cycle.occurrence.update': {
        const updating = operation.endsWith('.update');
        const cycle = operation.includes('.cycle.');
        const occurrence = operation.includes('.occurrence.');
        const mode = occurrence ? 'cycle-occurrence-update' : `${cycle ? 'cycle-' : ''}${updating ? 'update' : operation.endsWith('.create') ? 'create' : 'schedule'}`;
        const { body, joinPreferences } = conferenceBody(params, mode);
        const options = { body };
        if (!updating || cycle) options.headers = PORTAL_HEADERS;
        if (updating) {
          const native = params.modify_conf_info_uportal;
          const id = alias(params, ID_FIELDS);
          if (native && native.confid !== undefined && id !== undefined && native.confid !== id) throw invalid('Conflicting native and service conference IDs');
          options.query = { conferenceID: identifier(id === undefined && native ? native.confid : id, 'conferenceID') };
        }
        const path = occurrence ? `${CONFERENCES}/cyclesubconf` : cycle ? CYCLES : CONFERENCES;
        const result = await call(operation, updating ? 'PUT' : 'POST', path, options);
        // Portal 984 requires the creation array; edit sagas (970) only inspect
        // service success. Native getModifyConfResult also supports array replies.
        if (!updating && (!Array.isArray(result.data) || !result.data.length)) throw malformed(operation, result, 'conference array');
        if (Array.isArray(result.data)) {
          result.data.forEach(conf => validateConference(conf, operation, result));
          if (result.data.length) {
            result.conference = result.data[0];
            result.conferenceID = result.conference.conferenceID;
          }
        }
        if (Object.keys(joinPreferences).length) result.joinPreferences = joinPreferences;
        return result;
      }
      case 'conference.cancel':
      case 'conference.cycle.cancel':
      case 'conference.cycle.legacy.cancel': {
        const legacy = operation === 'conference.cycle.legacy.cancel';
        keys(params, new Set([...ID_FIELDS, ...(legacy ? [] : ['type'])]));
        const query = { conferenceID: conferenceID(params) };
        if (params.type !== undefined) query.type = integer(params.type, 'type', 0);
        if (query.type !== undefined && query.type !== 0 && query.type !== 1) throw invalid('type must be 0 or 1');
        if (operation === 'conference.cycle.cancel') {
          if (query.type !== undefined && query.type !== 1) throw invalid('Modern cycle cancellation uses type 1');
          query.type = 1; // module 15: ONLINE
        }
        const path = operation === 'conference.cancel' ? CONFERENCES :
          operation === 'conference.cycle.cancel' ? CYCLES : `${CONFERENCES}/cycle`;
        return call(operation, 'DELETE', path, { query, headers: legacy ? undefined : PORTAL_HEADERS });
      }
      case 'conference.cycle.occurrence.cancel': {
        keys(params, new Set([...ID_FIELDS, 'cycleSubConfIDs']));
        if (!Array.isArray(params.cycleSubConfIDs) || !params.cycleSubConfIDs.length) throw invalid('cycleSubConfIDs must be a nonempty array');
        params.cycleSubConfIDs.forEach(id => identifier(id, 'cycleSubConfID'));
        return call(operation, 'DELETE', `${CONFERENCES}/cyclesubconf`, {
          query: { conferenceID: conferenceID(params), type: 1 },
          body: { cycleSubConfIDs: params.cycleSubConfIDs }, headers: PORTAL_HEADERS
        });
      }
      case 'conference.cycle.legacy.occurrences.cancel': {
        keys(params, new Set(['conferenceIDs']));
        if (!Array.isArray(params.conferenceIDs) || !params.conferenceIDs.length) throw invalid('conferenceIDs must be a nonempty array');
        params.conferenceIDs.forEach(id => identifier(id, 'conferenceID'));
        return call(operation, 'POST', `${CONFERENCES}/cycle/confList/delete`, {
          body: { conferenceIDs: params.conferenceIDs }
        });
      }
      case 'conference.list':
      case 'conference.cycle.list': {
        const cycle = operation === 'conference.cycle.list';
        const fields = cycle ? ['status'] : LIST_FIELDS;
        keys(params, new Set([...PAGE_FIELDS, ...fields, ...(cycle ? ID_FIELDS : [])]));
        const query = { ...pick(params, fields), ...pagination(params, 10) };
        if (cycle) {
          query.conferenceID = conferenceID(params);
          query.status = params.status === undefined ? 1 : integer(params.status, 'status', 0);
          if (query.status > 1) throw invalid('Cycle status must be 0 or 1');
        }
        const result = await collect(operation, cycle ? `${CONFERENCES}/cycle` : CONFERENCES,
          query, cycle ? undefined : PORTAL_HEADERS, params.all === undefined ? false : flag(params.all, 'all'));
        result.data.data.forEach(conf => validateConference(conf, operation, result));
        return result;
      }
      case 'conference.details': {
        keys(params, new Set([...ID_FIELDS, ...PAGE_FIELDS, 'searchKey', 'type', 'queryType']));
        const query = { ...pagination(params, own(params, 'conf_id') ? 100 : 20),
          conferenceID: conferenceID(params), searchKey: params.searchKey === undefined ? '' : params.searchKey };
        const type = params.type === undefined ? 0 : integer(params.type, 'type', 0);
        const queryType = params.queryType === undefined ? 0 : integer(params.queryType, 'queryType', 0);
        if (type > 2 || queryType > 1) throw invalid('Invalid detail type/queryType');
        const headers = { ...PORTAL_HEADERS, 'X-Cms-Type': type, 'X-Query-Type': queryType };
        const result = await collect(operation, `${CONFERENCES}/confDetail`, query, headers,
          params.all === undefined ? false : flag(params.all, 'all'), true);
        result.native = nativeDetails(result.data);
        return result;
      }
      case 'vmr.list': {
        keys(params, new Set([...PAGE_FIELDS, 'specialVmr', 'searchKey']));
        const all = params.all === undefined ? !hasPagination(params) : flag(params.all, 'all');
        const query = { ...pick(params, ['searchKey']), ...pagination(params, 10) };
        if (params.specialVmr !== undefined) query.specialVmr = flag(params.specialVmr, 'specialVmr');
        else if (!all) query.specialVmr = false;
        let result;
        let groups;
        if (all && params.specialVmr === undefined) {
          const personal = await collect(operation, VMRS, { ...query, specialVmr: false }, PORTAL_HEADERS, true);
          const special = await collect(operation, VMRS, { ...query, specialVmr: true }, PORTAL_HEADERS, true);
          const data = [...personal.data.data, ...special.data.data];
          groups = [{ data: personal.data.data, specialVmr: false }, { data: special.data.data, specialVmr: true }];
          result = { status: personal.status, headers: personal.headers,
            data: { offset: query.offset, limit: data.length, count: Number(personal.data.count) + Number(special.data.count), data },
            pages: [...(personal.pages || [personal.data]), ...(special.pages || [special.data])] };
        } else {
          result = await collect(operation, VMRS, query, PORTAL_HEADERS, all);
          groups = [{ data: result.data.data, specialVmr: query.specialVmr }];
        }
        for (const vmr of result.data.data) {
          if (!object(vmr) || typeof vmr.id !== 'string' || !vmr.id || typeof vmr.vmrId !== 'string' || !vmr.vmrId) throw malformed(operation, result, 'VMR id/vmrId');
        }
        result.native = nativeVmrs(groups);
        return result;
      }
      case 'vmr.update': {
        keys(params, new Set(['id', 'vmrId', 'vmr_id', 'body', 'vmrName', 'conf_subject',
          'hostPwd', 'chairman_pwd', 'guestPwd', 'guest_pwd', ...VMR_FIELDS]));
        const id = identifier(alias(params, ['id', 'vmrId', 'vmr_id']), 'VMR resource id');
        let body;
        if (own(params, 'body')) {
          const extras = Object.keys(params).filter(key => !['id', 'vmrId', 'vmr_id', 'body'].includes(key));
          if (extras.length) throw invalid('Use body or direct VMR fields, not both');
          body = { ...record(params.body, 'body') };
        } else {
          body = pick(params, VMR_FIELDS);
          put(body, 'vmrName', alias(params, ['vmrName', 'conf_subject']));
          put(body, 'chairPwd', alias(params, ['chairPwd', 'hostPwd', 'chairman_pwd']));
          put(body, 'gustPwd', alias(params, ['gustPwd', 'guestPwd', 'guest_pwd']));
        }
        keys(body, VMR_FIELDS, 'body');
        if (!Object.keys(body).length) throw invalid('VMR update requires fields to change');
        return call(operation, 'PUT', `${VMRS}/${encodeURIComponent(id)}`, { body, headers: PORTAL_HEADERS });
      }
    }
  }
  return { execute, capabilities: serviceCapabilities, retireCalls: () => pendingCall && pendingCall.retire() };
}

module.exports = { createMeetingServices, capabilities, normalizeInvitation };
