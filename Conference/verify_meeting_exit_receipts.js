#!/usr/bin/env node
'use strict';

// Deterministic event replay, not a live conference. The adapter runs inside a
// page closure: load its actual command, observer and waiter, supplying only
// the provider state, SDK promise and clock at their boundaries.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const acorn = require('acorn');

const file = process.argv[2] || path.join(__dirname, 'meeting_native_web_runtime.js');
const source = fs.readFileSync(file, 'utf8');
const ast = acorn.parse(source, { ecmaVersion: 'latest' });
const declarations = ast.body[0].expression.callee.body.body;
const parts = ['fail', 'requireFunction', 'requireJoined', 'waitState', 'recordFailure', 'observeClient', 'leave'].map(name => {
  const node = declarations.find(n => n.type === 'FunctionDeclaration' && n.id.name === name);
  assert.ok(node, `Missing runtime declaration: ${name}`);
  return source.slice(node.start, node.end);
});
const bind = vm.compileFunction(`'use strict';
  const { vendor, recording, rtc, snapshot, state, setTimeout, clearTimeout } = provider;
  const waiters = new Set(), failures = [], completedLeaves = new WeakSet(), observedClients = new Map();
  const managedAux = new Map(), published = new WeakSet();
  const moderation = null; // No moderation controller participates in this leave-only replay.
  let sequence = 0, disposed = false;
  function pulse() { for (const check of Array.from(waiters)) check(); }
  ${parts.join('\n')}
  observeClient(provider.client);
  return { leave, pulse };`, ['provider']);

function room(role = 'host') {
  let resolveLeave, rejectLeave, deadline;
  const leaveReceipt = new Promise((resolve, reject) => { resolveLeave = resolve; rejectLeave = reject; });
  const client = Object.assign(new EventEmitter(), {
    leave() { return leaveReceipt; },
    join() { throw Error('unexpected join'); },
    publish() { throw Error('unexpected publish'); },
    unpublish() { throw Error('unexpected unpublish'); },
    // Crucial: HRTC's retired object need not emit one more state transition.
    getConnectionState() { return 'CONNECTED'; }
  });
  const track = { readyState: 'live', enabled: false };
  const media = { rtcClient: client, localStream: { getAudioTrack: () => track, getVideoTrack: () => null } };
  const conf = { modalTips: { stopConfReason: '' } };
  const current = { joined: true, roomJoined: true, connection: 'CONNECTED' };
  const actions = [];
  const stopped = 'stop conf hungup';
  const vendor = {
    constants: { HOST: 'host', STOP_CONF_REASON: { CONF_IS_STOP: stopped } },
    selectors: { selectOwn: () => ({ role }), selectConf: () => conf },
    store: { dispatch: action => actions.push(action) },
    actions: { onEndConf: () => 'end', leaveConfBySelf: () => 'leave' }
  };
  const { leave, pulse } = bind({ client, vendor, recording: { state: () => ({ state: 'idle' }) },
    rtc: () => media, snapshot: () => ({ ...current }), state: () => conf,
    setTimeout: callback => (deadline = callback), clearTimeout: () => { deadline = undefined; } });
  return {
    actions, client, leave,
    serverEnd() { conf.modalTips.stopConfReason = stopped; pulse(); },
    clearReason() { conf.modalTips.stopConfReason = ''; pulse(); },
    dropTransport() { current.joined = false; current.connection = 'DISCONNECTED'; pulse(); },
    releaseRoom() { media.rtcClient = null; media.localStream = null; current.joined = current.roomJoined = false; current.connection = 'DISCONNECTED'; pulse(); },
    stopTrack() { track.readyState = 'ended'; pulse(); },
    async finishSdk() { const actual = client.leave(); resolveLeave(); await actual; },
    async failSdk() { const actual = client.leave(); rejectLeave(Object.assign(Error('SDK refused leave'), { code: 'SDK_REJECT' })); await assert.rejects(actual, { code: 'SDK_REJECT' }); },
    expire() { assert.equal(typeof deadline, 'function', 'operation already completed'); deadline(); }
  };
}

test('host end succeeds after HRTC leaves a retired CONNECTED object behind', async () => {
  const r = room();
  const done = r.leave(true);
  assert.deepEqual(r.actions, ['end']);
  r.serverEnd(); r.clearReason(); r.stopTrack(); r.releaseRoom(); await r.finishSdk();
  assert.equal(r.client.getConnectionState(), 'CONNECTED');
  assert.equal((await done).roomJoined, false);
});

test('transport loss is not a leave receipt', async () => {
  const r = room(); const done = r.leave(true);
  r.serverEnd(); r.dropTransport(); r.stopTrack(); r.expire();
  await assert.rejects(done, { code: 'TIMEOUT' });
});

test('local leave alone does not end a conference for everybody', async () => {
  const r = room(); const done = r.leave(true);
  r.stopTrack(); r.releaseRoom(); await r.finishSdk(); r.expire();
  await assert.rejects(done, { code: 'TIMEOUT' });
});

test('a muted but live track still blocks a confirmed host exit', async () => {
  const r = room(); const done = r.leave(true);
  r.serverEnd(); r.releaseRoom(); await r.finishSdk(); r.expire();
  await assert.rejects(done, { code: 'TIMEOUT' });
});

test('provider rejection is preserved even if the room disappeared', async () => {
  const r = room(); const done = r.leave(true); const rejection = assert.rejects(done, { code: 'SDK_REJECT' });
  r.serverEnd(); r.stopTrack(); r.releaseRoom(); await r.failSdk(); await rejection;
});

test('a participant can leave but cannot issue a host end', async () => {
  const r = room('participant');
  await assert.rejects(r.leave(true), { code: 'HOST_DENIED' });
  assert.deepEqual(r.actions, []);
  const done = r.leave(false);
  r.stopTrack(); r.releaseRoom(); await r.finishSdk();
  assert.deepEqual(r.actions, ['leave']); assert.equal((await done).joined, false);
});
