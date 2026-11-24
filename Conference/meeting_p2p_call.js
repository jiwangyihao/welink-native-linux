'use strict';

const crypto = require('crypto');

// HIT APP 7.47.6 / SDK 100.10.5, original ia32 binaries:
// hwm_winconfui!StartP2pConf 0x6CB270: video-capable creation, camera chosen
// separately; self role=1/invite=0, peer role=0/invite=1. tup_confctrl
// 0x3469D,0x34F47: mode 3 and both auto-mute flags false. CREATECONF's
// operation timer is 10 one-second ticks (0x3A454,0x7BC39,0x7CDC9).
// hwm_conf!P2PConfRecord 0x18E230/0x18DCB0: one local accumulator, consumed
// by join failure or conference exit, NOT by create/CTD acceptance.
const CREATE_RESPONSE_TIMEOUT_MS = 10000;
const CREATE_TIMEOUT_RESULT = 414100003; // tup_confctrl 0xCE14 -> 0x159C0, event 0x402.
const PARTICIPANT_STATES = Object.freeze({
  '0': 'connected', '1': 'ringing', '2': 'joining', '3': 'left',
  '4': 'nonexistent', '5': 'busy', '6': 'no_response', '7': 'refused', '8': 'failed'
});
// tup_confctrl!uportal_OnRecvConfCtrlCmdHangUp 0x4D030. These are the
// confEndReason enum, NOT ParticipantsNotify.STATE or InviteResultNotify codes.
const END_REASONS = Object.freeze({
  1: [414100074, 'chair end conf'], 2: [414100075, 'timeover end conf'],
  3: [414100076, 'callee refused'], 4: [414100077, 'callee timeout'],
  5: [414100080, 'projection failed'], 6: [414100081, 'projection end'],
  7: [414100086, 'peer hangs up'], 8: [111072521, 'anti harassment']
});
const END_TEXT = Object.freeze({
  'chair hungup': 414100043, 'stop conf hungup': 414100044,
  FORCE_STOP_CONFLICT_CONF: 414100044, 'Session timer expired': 414100041,
  'no rtp stream MCU hungup': 414100042, 'wait timeout hungup': 414100061,
  'disActive hung up': 414100069, 'force open camera hang up': 414100078
});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function failure(code, message) { return Object.assign(new Error(message), { code }); }
function string(value, name, maxBytes, required = false) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || (required && !value) || value.includes('\0') ||
      Buffer.byteLength(value) > maxBytes) throw failure('INVALID_PARAMS', `${name} is invalid`);
  return value;
}

function normalizeP2p(params, context) {
  if (!object(params) || !object(context) || !object(context.self))
    throw failure('INVALID_PARAMS', 'P2P requires original cmd63 parameters and authenticated self identity');
  if (params.call_type !== 0 && params.call_type !== 1)
    throw failure('INVALID_PARAMS', 'call_type must be 0 (audio) or 1 (video)');
  const users = params.user_info;
  if (!object(users) || !object(users.caller_info) || !object(users.callee_info))
    throw failure('INVALID_PARAMS', 'user_info.caller_info and user_info.callee_info are required');
  // meeting_adapter 0x1FAAF-0x201D0 reads ONLY caller name, callee name,
  // callee_num and callee account_id. Self number/account come from login.
  // Do not substitute caller_info.number, callee_info.number, account names,
  // conference subjects, or generated values for these identities.
  const callerInfo = Object.freeze({
    number: string(context.self.number, 'self.number', 127, true),
    nickname: string(users.caller_info.name || context.self.name, 'caller name', 255),
    thirdUserId: string(context.self.thirdUserId, 'self.thirdUserId', 128)
  });
  const calleeInfo = Object.freeze({
    number: string(params.callee_num, 'callee_num', 127, true),
    nickname: string(users.callee_info.name, 'callee name', 255),
    thirdUserId: string(users.callee_info.account_id, 'callee account_id', 128)
  });
  const appId = string(context.appId, 'appId', 128);
  const attendee = (info, role, isAutoInvite) => {
    // tup_confctrl 0x35704-0x357FA uses appId+third-account when BOTH
    // exist, otherwise the original phone branch (0x35853-0x35A45).
    const identity = appId && info.thirdUserId ? { appId, accountId: info.thirdUserId } :
      { phone: info.number, accountId: '', email: '', sms: '', type: 'normal', isMute: 0 };
    return { ...identity, name: info.nickname, role, isAutoInvite };
  };
  const callRequestId = params.callRequestId === undefined ? undefined :
    string(params.callRequestId, 'callRequestId', 128, true);
  const language = context.language === undefined ? 'zh-CN' : context.language;
  if (language !== 'zh-CN' && language !== 'en-US')
    throw failure('INVALID_PARAMS', 'The native conference prompt language must be zh-CN or en-US');
  return {
    callerInfo, calleeInfo, mediaType: params.call_type, callRequestId,
    body: {
      conferenceType: 0, subject: string(context.subject, 'subject', 384), groupuri: '',
      // Audio calls still create the native 0x13 capability mask. Only the
      // caller join camera state follows call_type (hwm_sdk_ext 0xE886A).
      mediaTypes: 'Voice,Video,Data', welcomeVoiceEnable: 0, immediatelyConfStartMode: 3,
      timeZoneID: string(context.timeZoneID === undefined ? '56' : context.timeZoneID, 'timeZoneID', 15),
      language, isAutoRecord: 0, recordType: 0, vmrFlag: 0, vmrID: '',
      attendees: [attendee(callerInfo, 1, 0), attendee(calleeInfo, 0, 1)],
      confConfigInfo: { isAutoMute: false, isHardTerminalAutoMute: false }
    }
  };
}

function decodeP2pCreate(frame) {
  if (!object(frame) || frame.action !== 'ConfManagement' || frame.type !== 'CREATECONF' ||
      typeof frame.sequence !== 'string' || !frame.sequence || typeof frame.data !== 'string')
    throw failure('INVALID_SERVICE_RESPONSE', 'A correlated ConfManagement/CREATECONF response is required');
  let body;
  try { body = JSON.parse(frame.data); }
  catch (_) { throw failure('INVALID_SERVICE_RESPONSE', 'CREATECONF data is not JSON'); }
  if (!object(body) || !Number.isInteger(body.returnCode))
    throw failure('INVALID_SERVICE_RESPONSE', 'CREATECONF has no integer returnCode');
  if (body.returnCode !== 0) {
    // tup_confctrl 0x29454 -> 0x13900 adds the native service namespace to
    // positive short codes; hwm_utils!GetGlobalErrorCode preserves these codes.
    const resultCode = body.returnCode > 0 && body.returnCode < 100000000 ?
      body.returnCode + 100000000 : body.returnCode;
    const error = failure(resultCode, typeof body.returnDesc === 'string' ? body.returnDesc : '');
    error.details = { creationRefused: true, resultConfirmed: true, returnCode: body.returnCode };
    throw error;
  }
  const conference = Array.isArray(body.data) && body.data[0];
  if (!object(conference) || typeof conference.conferenceID !== 'string' || !conference.conferenceID)
    throw failure('INVALID_SERVICE_RESPONSE', 'CREATECONF did not return an exact conferenceID');
  // An ordinary two-person conference is not P2P. The original decoder at
  // tup_confctrl 0x29AD3 explicitly tests the returned start mode for 3.
  if (conference.immediatelyConfStartMode !== 3)
    throw failure('P2P_MODE_MISMATCH', 'CREATECONF did not return P2P start mode 3');
  return { conferenceID: conference.conferenceID, conference, response: frame,
    resultCode: 0, resultMsg: typeof body.returnDesc === 'string' ? body.returnDesc : '' };
}

function terminalResult(event) {
  if (Number.isInteger(event.resultCode))
    return { resultCode: event.resultCode, resultMsg: typeof event.resultMsg === 'string' ? event.resultMsg : '' };
  if (Number.isInteger(event.confEndReason) && END_REASONS[event.confEndReason]) {
    const [resultCode, resultMsg] = END_REASONS[event.confEndReason];
    return { resultCode, resultMsg };
  }
  if (typeof event.reason === 'string' && Object.prototype.hasOwnProperty.call(END_TEXT, event.reason))
    return { resultCode: END_TEXT[event.reason], resultMsg: event.reason };
  if (event.type === 'exit' && (Number.isInteger(event.confEndReason) || typeof event.reason === 'string')) {
    // Actual Hangup notifications zero-initialize the result (0x4D08D).
    // Unknown textual reasons preserve zero; a decimal reason uses atoi and
    // the same service namespace conversion at 0x4D5B4-0x4D5CF.
    const parsed = typeof event.reason === 'string' ? parseInt(event.reason, 10) : 0;
    const code = Number.isInteger(parsed) && parsed >= -2147483648 && parsed <= 2147483647 ? parsed : 0;
    return { resultCode: code > 0 && code < 100000000 ? code + 100000000 : code,
      resultMsg: typeof event.reason === 'string' ? event.reason : '' };
  }
  return null;
}

/* Providers and event contract:
 * beginCreate(body, {responseTimeoutMs}) -> real management {result,state,cancel,retire}.
 * joinCaller(created, context) -> Promise of actual caller membership; never just
 *   an IPC/HTTP/RTC command acknowledgement. created contains the untouched
 *   conference (including accessNumber/passwordEntry), conferenceID and response.
 *   context adds attemptId, conferenceID, isVideo and callerInfo to start context.
 * endConference(conferenceID, context) -> actual operation receipt with numeric
 *   resultCode and resultMsg. Success permits the local native-style record,
 *   but does not claim remote termination unless receipt.endConfirmed===true.
 * emit(nativeFrame, state) delivers ONLY notify63 and terminal notify33. Any
 *   additional UI phase notifications belong to the parent, not fake SDK events.
 * handleEvent requires BOTH attemptId and conferenceID for every provider event:
 *   participant: number/thirdUserId and state (ParticipantsNotify.STATE), isSelf?
 *   invite-result: callNumber and resultCode (not a terminal call record)
 *   caller-joined: actual membership; join-failed: actual numeric resultCode
 *   exit: confEndReason, known native reason text, or numeric resultCode/resultMsg.
 * No count heuristic, local ringing timeout, lost-ID search, automatic create
 * retry, or permanent redial lock. Retirement is local account teardown only.
 */
function createP2pCalls({ beginCreate, joinCaller, endConference, emit, now = Date.now }) {
  if ([beginCreate, joinCaller, endConference, emit, now].some(fn => typeof fn !== 'function'))
    throw new TypeError('P2P requires real create, caller join, end, notification and clock providers');
  let current = null;
  let generation = 0;

  function live(call) { return current === call && !call.retired && call.generation === generation; }
  function state(call = current) {
    if (!call) return { kind: 'p2p', phase: 'idle', attemptId: null, pending: false,
      cancellationAvailable: false, cancelRequested: false, creationConfirmed: false,
      callerJoined: false, peerEstablished: false, terminal: false, retired: false };
    const transmitted = call.handle?.state().transmissionAttempted === true;
    return {
      kind: 'p2p', attemptId: call.id, callRequestId: call.normalized.callRequestId,
      phase: call.phase, pending: !call.terminal && !call.retired,
      transmissionAttempted: transmitted, cancelRequested: call.cancelRequested,
      cancellationAvailable: !call.terminal && !call.retired && !call.cancelRequested &&
        (call.isCallOut || call.callerJoined),
      creationConfirmed: call.isCallOut && !!call.created, creationOutcome: call.creationOutcome,
      conferenceID: call.created?.conferenceID, callerJoined: call.callerJoined, isCallOut: call.isCallOut,
      localControlEstablished: call.selfState === 'connected', decision: call.decision,
      peerState: call.peerState, peerEstablished: call.peerEstablished, inviteResult: call.inviteResult,
      endAttempted: call.endAttempted, endResultConfirmed: call.endResultConfirmed,
      endConfirmed: call.endConfirmed, terminal: call.terminal, retired: call.retired,
      recordEmitted: call.recordEmitted, ...(call.error ? { error: call.error } : {})
    };
  }
  function getState(callRequestId) {
    return state(callRequestId !== undefined && current?.normalized.callRequestId !== callRequestId ? null : current);
  }
  function errorInfo(error) {
    return { code: error?.code || 'P2P_PROVIDER_FAILURE', message: error?.message || 'The P2P provider failed' };
  }
  function notifyStart(call, resultCode, resultMsg) {
    if (!live(call) || call.startNotified) return;
    call.startNotified = true;
    emit({ category: 'nativewnd', description: 'OnStartCallResult', notify: 63,
      result: resultCode, param: { reason: resultMsg, reason_code: resultCode } }, state(call));
  }
  function finish(call, result, phase) {
    if (!live(call) || call.terminal) return false;
    call.terminal = true;
    call.phase = phase;
    // Windows' record is local lifecycle evidence, not server-end proof. The
    // end time is consumption time; start resets once the identified peer joins.
    if (call.created && result) {
      call.recordEmitted = true;
      const param = { callerInfo: { ...call.normalized.callerInfo }, calleeInfo: { ...call.normalized.calleeInfo },
        startTime: call.startTime, endTime: Math.floor(now() / 1000), isCallOut: call.isCallOut,
        mediaType: call.normalized.mediaType, isCallEstablished: call.peerEstablished, ...result };
      emit({ category: 'nativewnd', description: 'OnP2PConfRecordNotify', notify: 33, result: 0, param }, state(call));
    }
    return true;
  }
  function establish(call) {
    // hwm_conf 0xFA46C-0xFA495 requires both attendees in the P2P context.
    // A peer who joined and left before caller admission never established
    // this call, and must not reset its unanswered-call start time.
    if ((call.isCallOut || call.decision === 'accept') &&
        (call.callerJoined || call.selfState === 'connected') && call.peerState === 'connected' && !call.peerEstablished) {
      call.peerEstablished = true;
      call.startTime = Math.floor(now() / 1000);
    }
  }
  function observeJoined(call, participantId) {
    if (!live(call) || call.terminal) return;
    if (typeof participantId === 'string' && participantId && participantId !== call.peerParticipantId)
      call.selfParticipantId = participantId;
    call.callerJoined = true;
    establish(call);
    if (!call.cancelRequested) call.phase = call.peerState || 'waiting_peer';
  }
  function joinFailed(call, error) {
    if (!live(call) || call.terminal) return;
    call.error = errorInfo(error);
    const result = terminalResult({ resultCode: error?.resultCode ?? error?.code, resultMsg: error?.resultMsg ?? error?.message });
    finish(call, result, 'join_failed');
  }
  function dispatchJoin(call) {
    call.phase = 'joining_caller';
    const context = { ...call.context, attemptId: call.id, conferenceID: call.created.conferenceID,
      isVideo: call.normalized.mediaType === 1, callerInfo: call.normalized.callerInfo };
    // Defer promise settlement, including synchronous provider failure, so the
    // create result remains distinct from the later join-failure record.
    let admission;
    try { admission = joinCaller(call.created, context); }
    catch (error) { admission = Promise.reject(error); }
    call.joinTask = Promise.resolve(admission).then(receipt => {
      if (!live(call) || call.terminal) return;
      call.joinReceipt = receipt;
      observeJoined(call, receipt?.participantId);
    }, error => joinFailed(call, error));
  }
  function end(call) {
    if (call.endTask) return call.endTask;
    if (!live(call) || call.terminal || !call.created) return Promise.resolve(state(call));
    call.phase = 'ending';
    call.endAttempted = true;
    call.endTask = (async () => {
      try {
        const receipt = await endConference(call.created.conferenceID,
          { ...call.context, attemptId: call.id, conferenceID: call.created.conferenceID,
            callerJoined: call.callerJoined, isCallOut: call.isCallOut });
        if (!live(call) || call.terminal) return state(call);
        if (!object(receipt) || !Number.isInteger(receipt.resultCode))
          throw failure('INVALID_SERVICE_RESPONSE', 'P2P end requires an actual numeric operation result');
        call.endResultConfirmed = true;
        if (receipt.resultCode !== 0) throw failure(receipt.resultCode, receipt.resultMsg || 'Conference end failed');
        call.endConfirmed = receipt.endConfirmed === true;
        finish(call, terminalResult(receipt), 'ended');
      } catch (error) {
        if (live(call) && !call.terminal) {
          call.error = errorInfo(error);
          call.phase = 'end_failed';
          call.cancelRequested = false;
        }
      }
      return state(call);
    })();
    call.endTask.then(() => { call.endTask = null; });
    return call.endTask;
  }
  async function create(call) {
    try {
      call.handle = beginCreate(call.normalized.body, { responseTimeoutMs: CREATE_RESPONSE_TIMEOUT_MS });
      const frame = await call.handle.result;
      if (!live(call)) throw failure('CALL_RETIRED', 'The call belongs to a retired account session');
      call.created = decodeP2pCreate(frame);
      call.creationOutcome = 'created';
      // The callee invitation instruction is already in CREATECONF. There is
      // no claim that caller admission was a no-ring barrier.
      call.phase = 'created';
      // hwm_conf 0x13E852 posts the create-result event before dispatching
      // EnterConfOneKeyEx at 0x13EA75. Neither event waits for peer connection.
      notifyStart(call, call.created.resultCode, call.created.resultMsg);
      if (!live(call)) throw failure('CALL_RETIRED', 'The call belongs to a retired account session');
      if (!call.terminal) {
        if (call.cancelRequested) void end(call);
        else dispatchJoin(call);
      }
      return { ...call.created, result: 0, callState: state(call) };
    } catch (error) {
      if (!live(call)) throw failure('CALL_RETIRED', 'The call belongs to a retired account session');
      call.error = errorInfo(error);
      if (error?.details?.creationRefused === true) {
        call.creationOutcome = 'refused';
        call.phase = 'create_refused';
      } else if (call.handle?.state().transmissionAttempted) {
        call.creationOutcome = 'unknown';
        call.phase = 'create_failed';
      } else {
        call.creationOutcome = 'not_sent';
        call.phase = call.cancelRequested ? 'cancelled_before_send' : 'create_failed';
      }
      call.terminal = true;
      // A missing response/ID is not a native call record, and does not become
      // one by inventing a call ID or a successful termination callback.
      if (error?.code === 'MANAGEMENT_TIMEOUT' && call.creationOutcome === 'unknown') {
        error.nativeResultCode = CREATE_TIMEOUT_RESULT;
        notifyStart(call, CREATE_TIMEOUT_RESULT, '');
      } else if (Number.isInteger(error?.code)) notifyStart(call, error.code, error.message || '');
      if (call.cancelRequested && call.creationOutcome === 'not_sent' && error?.code === 'MANAGEMENT_REQUEST_CANCELLED')
        return { cancelled: true, callState: state(call) };
      if (!(error instanceof Error)) error = failure('P2P_PROVIDER_FAILURE', call.error.message);
      error.details = { ...error.details, callState: state(call) };
      throw error;
    }
  }
  function start(params, context) {
    if (current && !current.terminal && !current.retired)
      return Promise.reject(failure('CALL_PENDING', 'Another P2P call is active'));
    let normalized;
    try { normalized = normalizeP2p(params, context); }
    catch (error) { return Promise.reject(error); }
    const call = { id: crypto.randomUUID(), normalized, context: { ...context }, generation,
      phase: 'creating', created: null, handle: null, creationOutcome: 'pending', isCallOut: true,
      cancelRequested: false, callerJoined: false, selfState: null, selfParticipantId: null,
      peerParticipantId: null, peerEstablished: false, peerState: null, decision: null,
      startTime: Math.floor(now() / 1000), startNotified: false, recordEmitted: false,
      endAttempted: false, endResultConfirmed: false, endConfirmed: false, endTask: null,
      retired: false, terminal: false, error: null };
    current = call;
    return create(call);
  }
  function incoming(invitation, context) {
    if (!object(invitation) || !object(context?.self) || invitation.p2p !== true)
      throw failure('INVALID_PARAMS', 'An authenticated P2P invitation is required');
    const id = string(invitation.attemptId, 'attemptId', 128, true);
    const conferenceID = string(invitation.conferenceID, 'conferenceID', 128, true);
    if (current?.id === id && current.created?.conferenceID === conferenceID) return state();
    if (current && !current.terminal && !current.retired)
      throw failure('CALL_PENDING', 'Another P2P call is active');
    const mediaType = invitation.mediaType;
    if (mediaType !== 0 && mediaType !== 1)
      throw failure('INVALID_PARAMS', 'The invitation has no recognized call media type');
    // The pinned Web INVITE_TO_JOIN parser does not expose caller identity.
    // Keep unknown native record fields empty, never use subject as a name or
    // number. An accepted P2P invitation can bind its peer from CMS attendees.
    const normalized = {
      callerInfo: { number: '', nickname: '', thirdUserId: '' },
      calleeInfo: {
        number: string(context.self.number, 'self.number', 127, true),
        nickname: string(context.self.name, 'self.name', 255),
        thirdUserId: string(context.self.thirdUserId, 'self.thirdUserId', 128)
      }, mediaType
    };
    current = { id, normalized, context: { ...context }, generation, isCallOut: false,
      phase: 'incoming', created: { conferenceID }, handle: null, creationOutcome: 'invited',
      cancelRequested: false, callerJoined: false, selfState: null, selfParticipantId: null,
      peerParticipantId: null, peerEstablished: false, peerState: null, decision: null,
      startTime: Math.floor(now() / 1000), startNotified: false, recordEmitted: false,
      endAttempted: false, endResultConfirmed: false, endConfirmed: false, endTask: null,
      retired: false, terminal: false, error: null };
    return state();
  }
  function cancel(attemptId) {
    const call = current;
    if (!call || typeof attemptId !== 'string' || call.id !== attemptId)
      return Promise.reject(failure('CALL_ATTEMPT_MISMATCH', 'Cancellation must identify the current P2P attempt'));
    if (call.terminal || call.retired) return Promise.resolve(state(call));
    if (!call.isCallOut && !call.callerJoined)
      return Promise.reject(failure('CALL_NOT_JOINED', 'Use the current invitation decision before callee admission'));
    call.cancelRequested = true;
    if (call.created) return end(call);
    call.phase = 'cancel_requested';
    // Before transmission cancel prevents dispatch. After transmission it
    // retains the original bounded response waiter, then ends only the exact
    // returned ID. Socket loss/timeout remains unknown; no recovery is assumed.
    call.handle?.cancel();
    return Promise.resolve(state(call));
  }
  function matchesIdentity(identity, event) {
    let matched = false;
    for (const key of ['number', 'thirdUserId']) {
      if (typeof event[key] !== 'string' || !event[key] || !identity[key]) continue;
      if (event[key] !== identity[key]) return false;
      matched = true;
    }
    return matched;
  }
  function participant(call, event) {
    if (!Object.prototype.hasOwnProperty.call(PARTICIPANT_STATES, event.state)) return false;
    const self = call.isCallOut ? call.normalized.callerInfo : call.normalized.calleeInfo;
    const peer = call.isCallOut ? call.normalized.calleeInfo : call.normalized.callerInfo;
    const pid = typeof event.participantId === 'string' && event.participantId ? event.participantId : null;
    const own = matchesIdentity(self, event);
    if (event.isSelf === true || own || pid && pid === call.selfParticipantId) {
      // A provider's local pid is useful only with the authenticated self
      // identity; a self row claiming the dialled peer never answers the call.
      if (!own || !pid || pid === call.peerParticipantId) return false;
      call.selfParticipantId = pid;
      call.selfState = PARTICIPANT_STATES[event.state];
      establish(call);
      if (!call.cancelRequested && call.peerEstablished) call.phase = 'connected';
      return true;
    }
    if (['number', 'thirdUserId'].some(key => self[key] && event[key] === self[key])) return false;
    if (!call.isCallOut && !peer.number && !peer.thirdUserId) {
      if (!pid || ![event.number, event.thirdUserId].some(value => typeof value === 'string' && value)) return false;
      // Binding is permitted only inside the server's explicit P2P context.
      // Names and participant counts alone never establish a party.
      peer.number = string(event.number, 'peer.number', 127);
      peer.thirdUserId = string(event.thirdUserId, 'peer.thirdUserId', 128);
      peer.nickname = string(event.nickname, 'peer.nickname', 255);
    }
    if (!matchesIdentity(peer, event) || call.peerParticipantId && pid && pid !== call.peerParticipantId) return false;
    if (pid) call.peerParticipantId = pid;
    call.peerState = PARTICIPANT_STATES[event.state];
    establish(call);
    if (!call.cancelRequested)
      call.phase = call.callerJoined || call.selfState === 'connected' ? call.peerState : 'joining_caller';
    return true;
  }
  function handleEvent(event) {
    const call = current;
    if (!object(event) || !call || !live(call) || call.terminal || !call.created ||
        event.attemptId !== call.id || event.conferenceID !== call.created.conferenceID) return false;
    if (event.type === 'participant') return participant(call, event);
    if (event.type === 'decision' && !call.isCallOut) {
      if (call.decision || !['accept', 'decline'].includes(event.decision)) return false;
      call.decision = event.decision;
      call.phase = event.decision === 'accept' ? 'joining_callee' : 'declining';
      return true;
    }
    if (event.type === 'decline-result' && !call.isCallOut && call.decision === 'decline') {
      const result = terminalResult(event);
      if (!result) return false;
      if (result.resultCode !== 0) {
        call.error = { code: result.resultCode, message: result.resultMsg };
        call.phase = 'decline_failed';
        return true;
      }
      return finish(call, result, 'declined');
    }
    if (event.type === 'withdrawn' && !call.isCallOut) {
      // A self attendee may arrive while the invitation is still unanswered.
      // Only an accepted call's membership makes FINISH_INVITE non-terminal.
      if (call.decision === 'accept' && (call.callerJoined || call.selfState === 'connected')) return false;
      // FINISH_INVITE carries no reason in the pinned parser. Its terminal
      // notification is real, but a numeric SIP/cancel/refusal result is unknown.
      return finish(call, {}, 'withdrawn');
    }
    if (event.type === 'invite-result') {
      const peer = call.isCallOut ? call.normalized.calleeInfo : call.normalized.callerInfo;
      if (event.callNumber !== peer.number || !Number.isInteger(event.resultCode)) return false;
      call.inviteResult = event.resultCode;
      return true;
    }
    if (event.type === 'caller-joined') { observeJoined(call, event.participantId); return true; }
    if (event.type === 'join-failed') {
      if (!Number.isInteger(event.resultCode)) return false;
      joinFailed(call, { code: event.resultCode, message: event.resultMsg });
      return true;
    }
    if (event.type === 'exit') {
      if (event.participantId !== undefined && event.participantId !== call.selfParticipantId) return false;
      const result = terminalResult(event);
      if (!result) return false;
      return finish(call, result, 'ended');
    }
    return false;
  }
  function retire() {
    const call = current;
    ++generation;
    current = null;
    if (call) {
      call.retired = true;
      call.phase = 'retired';
      call.handle?.retire();
    }
    return state();
  }
  return Object.freeze({ start, incoming, state: () => state(), getState, cancel, handleEvent, retire });
}

module.exports = { createP2pCalls, normalizeP2p, decodeP2pCreate, terminalResult, CREATE_RESPONSE_TIMEOUT_MS };
