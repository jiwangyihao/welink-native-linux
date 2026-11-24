'use strict';

// Deterministic, offline state-machine verification. All receipts below are
// synthetic provider input; this does not claim a live call or server admission.
const assert = require('assert/strict');
const { createP2pCalls, normalizeP2p, decodeP2pCreate, terminalResult,
  CREATE_RESPONSE_TIMEOUT_MS } = require('./meeting_p2p_call');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const error = (code, message = String(code)) => Object.assign(new Error(message), { code });
const params = (callRequestId = 'request-A', call_type = 0) => ({
  callRequestId, callee_num: 'peer-number', call_type,
  user_info: {
    caller_info: { name: 'Caller supplied name', number: 'NOT-the-authenticated-self', account_id: 'ignored-caller-account' },
    callee_info: { name: 'Peer name', account_id: 'peer-account', number: 'NOT-the-dialed-number' }
  }
});
const context = () => ({ self: { number: 'self-number', name: 'Authenticated name', thirdUserId: 'self-account' },
  subject: 'Original localized subject', language: 'en-US', timeZoneID: '56' });
function response(conferenceID = 'conference-A', extra = {}) {
  return { action: 'ConfManagement', type: 'CREATECONF', sequence: 'correlated-test-sequence',
    data: JSON.stringify({ returnCode: 0, returnDesc: '', data: [{ conferenceID,
      immediatelyConfStartMode: 3, accessNumber: 'returned-access', mediaTypes: 'Voice,Video,Data',
      passwordEntry: [{ conferenceRole: 'chair', password: 'returned-chair-secret' }], ...extra }] }) };
}
async function flush() { await Promise.resolve(); await Promise.resolve(); }
function harness({ transmitted = true } = {}) {
  const creations = [], joins = [], ends = [], notifications = [];
  let clock = 1700000000000;
  const calls = createP2pCalls({ now: () => clock,
    beginCreate(body, options) {
      const pending = deferred();
      const status = { transmissionAttempted: transmitted, cancelRequested: false, retired: false, settled: false };
      const item = { body, options, status, pending };
      creations.push(item);
      return { result: pending.promise, state: () => ({ ...status }),
        cancel() {
          status.cancelRequested = true;
          if (!status.transmissionAttempted && !status.settled) {
            status.settled = true;
            pending.reject(error('MANAGEMENT_REQUEST_CANCELLED'));
          }
          return { ...status };
        },
        retire() {
          status.retired = true;
          if (!status.settled) {
            status.settled = true;
            pending.reject(error('MANAGEMENT_REQUEST_ABORTED'));
          }
        }
      };
    },
    joinCaller(created, joinContext) {
      const pending = deferred();
      joins.push({ created, context: joinContext, pending });
      return pending.promise;
    },
    endConference(conferenceID, endContext) {
      const pending = deferred();
      ends.push({ conferenceID, context: endContext, pending });
      return pending.promise;
    },
    emit(frame, state) { notifications.push({ frame, state }); }
  });
  const bind = (type, values = {}) => ({ type, attemptId: calls.state().attemptId,
    conferenceID: calls.state().conferenceID, ...values });
  const created = async (promise, id = 'conference-A', extra = {}) => {
    const item = creations[creations.length - 1];
    item.status.settled = true;
    item.pending.resolve(response(id, extra));
    return promise;
  };
  return { calls, creations, joins, ends, notifications, bind, created,
    time: value => { clock = value; }, records: () => notifications.filter(n => n.frame.notify === 33) };
}

async function verify() {
  assert.equal(CREATE_RESPONSE_TIMEOUT_MS, 10000);
  const normalized = normalizeP2p(params(), context());
  assert.deepEqual(normalized.callerInfo, { number: 'self-number', nickname: 'Caller supplied name', thirdUserId: 'self-account' });
  assert.deepEqual(normalized.calleeInfo, { number: 'peer-number', nickname: 'Peer name', thirdUserId: 'peer-account' });
  assert.equal(normalized.mediaType, 0);
  assert.equal(normalized.body.mediaTypes, 'Voice,Video,Data');
  assert.equal(normalized.body.immediatelyConfStartMode, 3);
  assert.deepEqual(normalized.body.confConfigInfo, { isAutoMute: false, isHardTerminalAutoMute: false });
  assert.deepEqual(normalized.body.attendees.map(a => [a.phone, a.role, a.isAutoInvite]),
    [['self-number', 1, 0], ['peer-number', 0, 1]]);
  assert.equal(normalized.body.ctd, undefined);
  assert.equal(normalized.body.length, undefined); // Native zero length is omitted, not CTD's 60.
  assert.equal(normalized.body.token, undefined);
  assert.throws(() => decodeP2pCreate({ ...response(), data: JSON.stringify({ returnCode: 403, returnDesc: 'denied' }) }),
    { code: 100000403 });
  const withApp = normalizeP2p(params(), { ...context(), appId: 'real-configured-app' });
  assert.deepEqual(withApp.body.attendees[1], { appId: 'real-configured-app', accountId: 'peer-account',
    name: 'Peer name', role: 0, isAutoInvite: 1 });
  assert.throws(() => normalizeP2p({ ...params(), call_type: 17 }, context()), { code: 'INVALID_PARAMS' });
  assert.throws(() => normalizeP2p(params(), { self: {} }), { code: 'INVALID_PARAMS' });
  assert.throws(() => decodeP2pCreate(response('conference-A', { immediatelyConfStartMode: 0 })), { code: 'P2P_MODE_MISMATCH' });
  assert.throws(() => decodeP2pCreate(response('')), { code: 'INVALID_SERVICE_RESPONSE' });
  assert.throws(() => decodeP2pCreate({ ...response(), type: 'CANCELCONF' }), { code: 'INVALID_SERVICE_RESPONSE' });

  // Creation acceptance, local admission, peer ringing and peer establishment
  // are four distinct facts. Repeated updates do not reset connected duration.
  {
    const h = harness();
    const start = h.calls.start(params(), context());
    assert.equal(h.calls.state().phase, 'creating');
    assert.equal(h.calls.getState('other-owner').phase, 'idle');
    await assert.rejects(h.calls.start(params('request-B'), context()), { code: 'CALL_PENDING' });
    assert.deepEqual(h.creations[0].options, { responseTimeoutMs: 10000 });
    const result = await h.created(start);
    assert.equal(result.callState.creationConfirmed, true);
    assert.equal(result.callState.callerJoined, false);
    assert.equal(result.callState.peerEstablished, false);
    assert.equal(h.joins.length, 1);
    assert.equal(h.joins[0].context.isVideo, false);
    assert.equal(h.joins[0].created.conference.accessNumber, 'returned-access');
    assert.equal(h.joins[0].created.conference.passwordEntry[0].password, 'returned-chair-secret');
    assert.deepEqual(h.notifications.map(n => n.frame.notify), [63]);
    assert.deepEqual(h.notifications[0].frame.param, { reason: '', reason_code: 0 });
    assert.equal(h.calls.handleEvent(h.bind('participant', { number: 'self-number', state: '0', isSelf: true })), false);
    assert.equal(h.calls.handleEvent(h.bind('participant', { number: 'unrelated', state: '0' })), false);
    assert.equal(h.calls.handleEvent(h.bind('participant', { count: 2, state: '0' })), false);
    assert.equal(h.calls.handleEvent(h.bind('participant', { number: 'peer-number', state: '0', conferenceID: 'other' })), false);
    assert.equal(h.calls.handleEvent(h.bind('invite-result', { callNumber: 'peer-number', resultCode: 0 })), true);
    assert.equal(h.calls.state().peerEstablished, false);
    h.joins[0].pending.resolve({ callerMembership: 'synthetic-MMR-membership' });
    await flush();
    assert.equal(h.calls.state().phase, 'waiting_peer');
    assert.equal(h.calls.handleEvent(h.bind('participant', { number: 'peer-number', state: '1' })), true);
    assert.equal(h.calls.state().phase, 'ringing');
    h.time(1700000012000);
    const peer = h.bind('participant', { number: 'peer-number', thirdUserId: 'peer-account', state: '0' });
    assert.equal(h.calls.handleEvent(peer), true);
    assert.equal(h.calls.state().phase, 'connected');
    h.time(1700000018000);
    assert.equal(h.calls.handleEvent(peer), true);
    assert.equal(h.records().length, 0);
    assert.equal(h.calls.handleEvent(h.bind('participant', { number: 'peer-number', state: '3' })), true);
    assert.equal(h.records().length, 0);
    const exit = h.bind('exit', { confEndReason: 7 });
    h.time(1700000020000);
    assert.equal(h.calls.handleEvent(exit), true);
    assert.deepEqual(h.records()[0].frame, { category: 'nativewnd', description: 'OnP2PConfRecordNotify', notify: 33,
      result: 0, param: { callerInfo: normalized.callerInfo, calleeInfo: normalized.calleeInfo,
        startTime: 1700000012, endTime: 1700000020, isCallOut: true, mediaType: 0,
        isCallEstablished: true, resultCode: 414100086, resultMsg: 'peer hangs up' } });
    assert.equal(h.records()[0].frame.param.callId, undefined);
    assert.equal(h.calls.state().endConfirmed, false);
    assert.equal(h.calls.handleEvent(exit), false);
    assert.equal(h.records().length, 1);
    const next = h.calls.start(params('request-B', 1), context());
    await h.created(next, 'conference-B');
    assert.equal(h.joins[1].context.isVideo, true);
    assert.equal(h.calls.handleEvent(exit), false);
    h.calls.retire();
    h.joins[1].pending.resolve({ callerMembership: 'stale' });
    await flush();
    assert.equal(h.calls.state().phase, 'idle');
    assert.equal(h.records().length, 1);
  }

  // Participant refusal and invite failure are not conference-end events.
  {
    const h = harness();
    await h.created(h.calls.start(params(), context()));
    h.joins[0].pending.resolve({ callerMembership: true });
    await flush();
    h.calls.handleEvent(h.bind('invite-result', { callNumber: 'peer-number', resultCode: 17 }));
    h.calls.handleEvent(h.bind('participant', { thirdUserId: 'peer-account', state: '7' }));
    assert.equal(h.calls.state().phase, 'refused');
    assert.equal(h.records().length, 0);
    h.calls.handleEvent(h.bind('exit', { confEndReason: 3 }));
    assert.equal(h.records()[0].frame.param.resultCode, 414100076);
    assert.equal(h.records()[0].frame.param.isCallEstablished, false);
  }
  // Peer notifications can precede the caller's join receipt: CREATECONF
  // already instructed the server to invite that peer.
  {
    const h = harness();
    await h.created(h.calls.start(params(), context()));
    h.calls.handleEvent(h.bind('participant', { number: 'peer-number', state: '1' }));
    assert.equal(h.calls.state().phase, 'joining_caller');
    h.joins[0].pending.resolve({ callerMembership: true });
    await flush();
    assert.equal(h.calls.state().phase, 'ringing');
    h.calls.handleEvent(h.bind('participant', { number: 'peer-number', state: '0' }));
    h.calls.handleEvent(h.bind('participant', { number: 'peer-number', state: '3' }));
    assert.equal(h.calls.state().phase, 'left');
    assert.equal(h.calls.state().peerEstablished, true);
    assert.equal(h.records().length, 0);
    h.calls.retire();
  }
  {
    const h = harness();
    await h.created(h.calls.start(params(), context()));
    h.time(1700000010000);
    h.calls.handleEvent(h.bind('participant', { number: 'peer-number', state: '0' }));
    assert.equal(h.calls.state().peerEstablished, false);
    h.time(1700000015000);
    h.calls.handleEvent(h.bind('participant', { number: 'peer-number', state: '3' }));
    h.time(1700000020000);
    h.joins[0].pending.reject(error(414100048, 'synthetic caller admission failure'));
    await flush();
    assert.equal(h.records().length, 1);
    assert.equal(h.records()[0].frame.param.isCallEstablished, false);
    assert.equal(h.records()[0].frame.param.startTime, 1700000000);
    assert.equal(h.records()[0].frame.param.endTime, 1700000020);
  }
  {
    const h = harness();
    await h.created(h.calls.start(params(), context()));
    h.time(1700000010000);
    h.calls.handleEvent(h.bind('participant', { number: 'peer-number', state: '0' }));
    assert.equal(h.calls.state().peerEstablished, false);
    h.time(1700000020000);
    h.joins[0].pending.resolve({ callerMembership: true });
    await flush();
    assert.equal(h.calls.state().peerEstablished, true);
    h.time(1700000025000);
    h.calls.handleEvent(h.bind('exit', { confEndReason: 7 }));
    assert.equal(h.records()[0].frame.param.isCallEstablished, true);
    assert.equal(h.records()[0].frame.param.startTime, 1700000020);
    assert.equal(h.records()[0].frame.param.endTime, 1700000025);
  }

  // Cancellation before sending dispatches neither create nor end. Cancellation
  // after sending retains the same request and only ends the ID it returns.
  {
    const h = harness({ transmitted: false });
    const start = h.calls.start(params(), context());
    await h.calls.cancel(h.calls.state().attemptId);
    const result = await start;
    assert.equal(result.callState.phase, 'cancelled_before_send');
    assert.equal(h.joins.length + h.ends.length + h.notifications.length, 0);
  }
  {
    const h = harness();
    const start = h.calls.start(params(), context());
    const id = h.calls.state().attemptId;
    await assert.rejects(h.calls.cancel('not-this-attempt'), { code: 'CALL_ATTEMPT_MISMATCH' });
    const intent = await h.calls.cancel(id);
    assert.equal(intent.phase, 'cancel_requested');
    assert.equal(intent.endConfirmed, false);
    assert.equal(h.creations[0].status.retired, false);
    await h.created(start);
    assert.equal(h.joins.length, 0);
    assert.equal(h.ends.length, 1);
    assert.equal(h.ends[0].conferenceID, 'conference-A');
    assert.equal(h.records().length, 0);
    const end = h.calls.cancel(id);
    assert.equal(h.ends.length, 1);
    h.ends[0].pending.resolve({ resultCode: 0, resultMsg: '', response: 'synthetic-end-operation-result' });
    await end;
    assert.deepEqual(h.notifications.map(n => n.frame.notify), [63, 33]);
    assert.equal(h.calls.state().endResultConfirmed, true);
    assert.equal(h.calls.state().endConfirmed, false);
    assert.equal(h.records()[0].frame.param.isCallEstablished, false);
    assert.equal(h.records()[0].frame.param.resultCode, 0);
  }

  // Lost CREATECONF is not recoverable by a guessed meeting/call ID, and does
  // not permanently block a new user-initiated call (no additional guarantee).
  {
    const h = harness();
    const start = h.calls.start(params(), context());
    const rejected = assert.rejects(start, { code: 'MANAGEMENT_CONNECTION_CLOSED' });
    await h.calls.cancel(h.calls.state().attemptId);
    h.creations[0].pending.reject(error('MANAGEMENT_CONNECTION_CLOSED'));
    await rejected;
    assert.equal(h.calls.state().creationOutcome, 'unknown');
    assert.equal(h.calls.state().terminal, true);
    assert.equal(h.notifications.length + h.ends.length + h.joins.length, 0);
    const next = h.calls.start(params(), context());
    const nextRejected = assert.rejects(next, { code: 'CALL_RETIRED' });
    h.calls.retire();
    await nextRejected;
    assert.equal(h.notifications.length, 0);
  }
  for (const extra of [{ conferenceID: '' }, { immediatelyConfStartMode: 0 }]) {
    const h = harness();
    const start = h.calls.start(params(), context());
    const rejected = assert.rejects(start);
    h.creations[0].pending.resolve(response('conference-A', extra));
    await rejected;
    assert.equal(h.joins.length + h.ends.length + h.notifications.length, 0);
  }
  {
    const h = harness();
    const start = h.calls.start(params(), context());
    const rejected = assert.rejects(start, { code: 412100043 });
    h.creations[0].pending.resolve({ ...response(), data: JSON.stringify({ returnCode: 412100043, returnDesc: 'synthetic refusal' }) });
    await rejected;
    assert.equal(h.calls.state().creationOutcome, 'refused');
    assert.equal(h.records().length, 0);
    assert.equal(h.notifications[0].frame.notify, 63);
    assert.equal(h.notifications[0].frame.result, 412100043);
  }
  {
    const h = harness();
    const start = h.calls.start(params(), context());
    const rejected = assert.rejects(start, { code: 'MANAGEMENT_TIMEOUT', nativeResultCode: 414100003 });
    h.creations[0].pending.reject(error('MANAGEMENT_TIMEOUT'));
    await rejected;
    assert.equal(h.calls.state().creationOutcome, 'unknown');
    assert.equal(h.notifications[0].frame.notify, 63);
    assert.equal(h.notifications[0].frame.result, 414100003);
    assert.equal(h.records().length + h.ends.length + h.joins.length, 0);
  }

  // Join failure consumes the same local record after 63, without inventing
  // peer success, a legacy call ID, or confirmation of server termination.
  {
    const h = harness();
    await h.created(h.calls.start(params(), context()));
    h.joins[0].pending.reject(error(414100048, 'synthetic join failure'));
    await flush();
    assert.deepEqual(h.notifications.map(n => n.frame.notify), [63, 33]);
    assert.equal(h.calls.state().phase, 'join_failed');
    assert.equal(h.records()[0].frame.param.resultCode, 414100048);
    assert.equal(h.records()[0].frame.param.isCallEstablished, false);
    assert.equal(h.ends.length, 0);
  }
  // An end-operation refusal must not become a successful terminal record.
  {
    const h = harness();
    await h.created(h.calls.start(params(), context()));
    const end = h.calls.cancel(h.calls.state().attemptId);
    h.ends[0].pending.resolve({ resultCode: 403, resultMsg: 'synthetic end refusal' });
    await end;
    assert.equal(h.calls.state().phase, 'end_failed');
    assert.equal(h.records().length, 0);
    assert.equal(h.calls.state().cancellationAvailable, true);
    const retry = h.calls.cancel(h.calls.state().attemptId);
    assert.equal(h.ends.length, 2);
    h.ends[1].pending.resolve({ resultCode: 0, resultMsg: '', endConfirmed: true });
    await retry;
    assert.equal(h.calls.state().endConfirmed, true);
    assert.equal(h.records().length, 1);
    h.joins[0].pending.reject(error(414100048));
    await flush();
    assert.equal(h.records().length, 1);
  }
  // The native established test uses both authenticated CMS attendees, not
  // an HRTC/media-success surrogate. A control-only receipt stays labelled so.
  {
    const h = harness();
    await h.created(h.calls.start(params(), context()));
    h.calls.handleEvent(h.bind('participant', { participantId:'self-pid', number:'self-number',
      thirdUserId:'self-account', state:'0' }));
    assert.equal(h.calls.state().callerJoined, false);
    assert.equal(h.calls.state().localControlEstablished, true);
    assert.equal(h.calls.state().peerEstablished, false);
    assert.equal(h.calls.handleEvent(h.bind('participant', { participantId:'self-pid',
      number:'peer-number', thirdUserId:'peer-account', state:'0' })), false);
    h.time(1700000005000);
    h.calls.handleEvent(h.bind('participant', { participantId:'peer-pid', number:'peer-number',
      thirdUserId:'peer-account', state:'0' }));
    assert.equal(h.calls.state().peerEstablished, true);
    assert.equal(h.calls.state().callerJoined, false);
    assert.equal(h.calls.handleEvent(h.bind('exit', {participantId:'other-pid', confEndReason:7})), false);
    h.time(1700000008000);
    h.calls.handleEvent(h.bind('exit', {participantId:'self-pid', confEndReason:7}));
    const record = h.records()[0].frame.param;
    assert.equal(record.startTime, 1700000005);
    assert.equal(record.endTime, 1700000008);
    assert.equal(record.isCallEstablished, true);
    assert.equal(record.isCallOut, true);
    h.joins[0].pending.reject(error(414100048, 'late admission failure'));
    await flush();
    assert.equal(h.records().length, 1);
  }
  const invitation = (id = 'incoming-A') => ({ attemptId:id, conferenceID:'invited-'+id, p2p:true, mediaType:0 });
  {
    const h = harness();
    assert.throws(() => h.calls.incoming({...invitation(), p2p:false}, context()), {code:'INVALID_PARAMS'});
    h.calls.incoming(invitation(), context());
    assert.equal(h.calls.state().isCallOut, false);
    assert.equal(h.calls.state().creationConfirmed, false);
    assert.equal(h.calls.state().cancellationAvailable, false);
    assert.equal(h.notifications.length, 0);
    await assert.rejects(h.calls.cancel(h.calls.state().attemptId), {code:'CALL_NOT_JOINED'});
    h.calls.handleEvent(h.bind('participant', {participantId:'peer', number:'peer-number',
      nickname:'Actual caller', thirdUserId:'peer-account', state:'0'}));
    h.calls.handleEvent(h.bind('participant', {participantId:'self', number:'self-number', state:'0'}));
    assert.equal(h.calls.state().peerEstablished, false, 'An invitation without acceptance is not an answered call');
    h.calls.handleEvent(h.bind('decision', {decision:'accept'}));
    h.time(1700000007000);
    h.calls.handleEvent(h.bind('participant', {participantId:'self', number:'self-number', state:'0'}));
    assert.equal(h.calls.state().peerEstablished, true);
    assert.equal(h.calls.handleEvent(h.bind('withdrawn')), false, 'Finishing ringing does not hang up an admitted call');
    h.time(1700000010000);
    h.calls.handleEvent(h.bind('exit', {participantId:'self', confEndReason:7}));
    const record = h.records()[0].frame.param;
    assert.equal(record.isCallOut, false);
    assert.equal(record.startTime, 1700000007);
    assert.equal(record.endTime, 1700000010);
    assert.deepEqual(record.callerInfo, {number:'peer-number', nickname:'Actual caller', thirdUserId:'peer-account'});
    assert.deepEqual(record.calleeInfo, {number:'self-number', nickname:'Authenticated name', thirdUserId:'self-account'});
    assert.equal(record.resultCode, 414100086);
    assert.equal(h.notifications.length, 1, 'No incoming notify63 is fabricated');
  }
  for (const [acceptFirst, earlySelf] of [[false, false], [true, false], [false, true]]) {
    const h = harness();
    h.calls.incoming(invitation(), context());
    if (acceptFirst) h.calls.handleEvent(h.bind('decision', {decision:'accept'}));
    if (earlySelf) {
      h.calls.handleEvent(h.bind('participant', {participantId:'self', number:'self-number',
        thirdUserId:'self-account', state:'0'}));
      assert.equal(h.calls.state().localControlEstablished, true);
      assert.equal(h.calls.state().decision, null);
      assert.equal(h.calls.state().peerEstablished, false);
    }
    const withdrawn = h.bind('withdrawn');
    assert.equal(h.calls.handleEvent(withdrawn), true);
    const record = h.records()[0].frame.param;
    assert.equal(record.isCallEstablished, false);
    assert.equal(record.isCallOut, false);
    assert.equal('resultCode' in record, false, 'An unknown withdrawal reason must not claim cancellation success');
    assert.deepEqual(record.callerInfo, {number:'', nickname:'', thirdUserId:''});
    assert.equal(h.calls.handleEvent(h.bind('decision', {decision:'accept'})), false);
    assert.equal(h.calls.handleEvent(h.bind('participant', {participantId:'peer', number:'peer-number', state:'0'})), false);
    assert.equal(h.calls.handleEvent(withdrawn), false);
    h.calls.incoming(invitation('incoming-B'), context());
    assert.equal(h.calls.handleEvent(withdrawn), false);
    assert.equal(h.calls.state().phase, 'incoming');
    assert.equal(h.records().length, 1);
  }
  {
    const h = harness();
    h.calls.incoming(invitation(), context());
    h.calls.handleEvent(h.bind('decision', {decision:'decline'}));
    assert.equal(h.records().length, 0, 'A decline click is not its result');
    assert.equal(h.calls.handleEvent(h.bind('decline-result', {resultCode:0, conferenceID:'wrong'})), false);
    h.calls.handleEvent(h.bind('decline-result', {resultCode:0, resultMsg:''}));
    assert.equal(h.calls.state().phase, 'declined');
    assert.equal(h.records()[0].frame.param.resultCode, 0);
    assert.equal(h.calls.handleEvent(h.bind('decline-result', {resultCode:0})), false);
    assert.equal(h.records().length, 1);
  }
  for (const [confEndReason, resultCode] of [[1, 414100074], [2, 414100075], [3, 414100076],
    [4, 414100077], [5, 414100080], [6, 414100081], [7, 414100086], [8, 111072521]])
    assert.equal(terminalResult({ confEndReason }).resultCode, resultCode);
  assert.equal(terminalResult({ reason: 'Session timer expired' }).resultCode, 414100041);
  assert.equal(terminalResult({ reason: 'unknown-unmapped-input' }), null);
  assert.equal(terminalResult({ type: 'exit', reason: 'unknown-unmapped-input' }).resultCode, 0);
  assert.equal(terminalResult({ type: 'exit', reason: '403' }).resultCode, 100000403);
  assert.equal(terminalResult({ resultCode: '0' }), null);
  console.log('PASS native P2P deterministic lifecycle; synthetic receipts only, no live call attempted');
}

verify().catch(error => { console.error(error); process.exitCode = 1; });
