#!/usr/bin/env node
'use strict';
const assert = require('assert').strict;
const { apply } = require('./meeting_audio_output');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

(async () => {
  const gate = deferred();
  let calls = 0, finished = false;
  const delayed = { sinkId: 'old', setSinkId(id) { calls++; return gate.promise.then(() => { this.sinkId = id; }); } };
  const pending = apply({ elements: [delayed, delayed], deviceId: 'new', ensureCurrent() {} }).then(value => { finished = true; return value; });
  await Promise.resolve();
  assert.equal(finished, false, 'An unresolved browser routing promise must not become success');
  assert.equal(delayed.sinkId, 'old');
  gate.resolve();
  assert.deepEqual(await pending, { sinkCount: 1, verified: true });
  assert.equal(calls, 1, 'One actual sink must not be routed twice merely because it has two owners');
  assert.equal(delayed.sinkId, 'new');

  const first = { sinkId: 'old', async setSinkId(id) { this.sinkId = id; } };
  const rejected = { sinkId: 'old', setSinkId() { return Promise.reject(Object.assign(new Error('Output was disconnected'), { name: 'NotFoundError', code: 8 })); } };
  await assert.rejects(apply({ elements: [first, rejected], deviceId: 'new', ensureCurrent() {} }), error => {
    assert.equal(error.code, 'AUDIO_OUTPUT_SELECTION_FAILED');
    assert.deepEqual(error.details, { appliedOutputs: 1, totalOutputs: 2, causeName: 'NotFoundError', causeCode: 8 });
    return true;
  });
  assert.equal(rejected.sinkId, 'old');
  assert.equal(first.sinkId, 'new', 'Failure must not pretend already-completed device effects were rolled back');

  await assert.rejects(apply({ elements: [{ sinkId: 'old', async setSinkId() {} }], deviceId: 'new', ensureCurrent() {} }),
    error => error.code === 'AUDIO_OUTPUT_UNCONFIRMED');
  let current = true;
  const changed = deferred();
  const receiver = { sinkId: 'old', async setSinkId(id) { await changed.promise; this.sinkId = id; } };
  const stale = apply({ elements: [receiver], deviceId: 'new', ensureCurrent() {
    if (!current) throw Object.assign(new Error('Meeting changed'), { code: 'CONFERENCE_CHANGED' });
  } });
  current = false; changed.resolve();
  await assert.rejects(stale, error => error.code === 'CONFERENCE_CHANGED');
  assert.deepEqual(await apply({ elements: [], deviceId: 'new', ensureCurrent() {} }), { sinkCount: 0, verified: false });
  await assert.rejects(apply({ elements: [{}], deviceId: 'new', ensureCurrent() {} }), error => error.code === 'AUDIO_OUTPUT_UNAVAILABLE');
  console.log(JSON.stringify({ passed: true, boundary: 'Output completion and ownership contract with controlled receiver promises; actual Electron/HRTC acceptance is separate.' }));
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
