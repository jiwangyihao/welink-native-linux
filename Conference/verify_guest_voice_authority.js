'use strict';

// Host-authority companion to verify_guest_voice.js. Uses real packaged main,
// sandboxed offline document and recorder, but makes no network/media join and
// never supplies a workplace account or fake enrollment. The two HTTPS origins
// are owner-selection fixtures, NOT claims of a successful online meeting.
const assert = require('node:assert/strict');
const path = require('node:path');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function verifyGuestVoiceAuthority({ electron, appRoot }) {
  const native = path.join(appRoot, 'native');
  const { MeetingNativeWeb } = require(path.join(native, 'meeting_native_web'));
  const { OfflineMeetingWindow } = require(path.join(native, 'meeting_offline_window'));
  let accountReads = 0, permissionRequests = 0, view;
  const bridge = new MeetingNativeWeb({ electron, appRoot, origin:'https://primary.invalid',
    getVoiceSession: () => { ++accountReads; return null; } });
  const report = { scope:'host owner selection for anonymous-primary and admitted-guest origins, real local recorder; not online membership', rooms:[] };
  try {
    const enabled = await bridge.configureAnonymousVoiceCapability(true);
    assert.equal(enabled.configured, true); assert.equal(enabled.state, 'no-room');
    assert.equal(enabled.armed, false); assert.equal(enabled.processing, false);
    let previous;
    for (const origin of ['https://primary.invalid', 'https://admitted-guest.invalid']) {
      const owner = await bridge.prepareAnonymousSession(origin);
      assert.equal(owner.anonymous, true);
      assert.equal(bridge.voiceSession(), null);
      assert.equal(accountReads, 0, 'An anonymous room consulted the workplace voice profile');
      const voices = bridge.anonymousVoice;
      let media = null, heldGate = null;
      view = new OfflineMeetingWindow({ electron, requestPermission: () => { ++permissionRequests; return false; },
        onLeave: () => {}, onFailure: error => { throw error; }, onEvent: () => {},
        voice: { session: () => voices.session(owner), state: () => voices.state(),
          show: () => voices.show(), disable: () => voices.disable() } });
      await view.open({content:'ISOLATED AUTHORITY FIXTURE', color:'#999999'}, {});
      const session = await voices.attach({ owner, window:view.window,
        isCurrent: () => bridge.mediaOwner === owner && !owner.retired && view.live(),
        getState: () => media,
        configure: async (active, current) => {
          const result = await view.request('voice.configure', {enabled:active, unavailable:active && !current.allowed()});
          media = result;
          // Delay only delivery of the genuine renderer's acknowledgement.
          // Do not fake policy application, a print, or a media receipt.
          if (active && heldGate) {
            const gate = heldGate; heldGate = null;
            gate.arrived.resolve(result);
            await gate.resume.promise;
          }
          return result;
        } });
      assert.equal(bridge.voiceSession(), session);
      assert.equal(voices.session({ origin }), null, 'Origin equality was mistaken for room identity');
      assert.equal(session.account, null);
      assert.equal(session.host.recordForFilter(), null);
      if (previous) {
        assert.notEqual(voices.room.id, previous.id);
        assert.equal(voices.session(previous.owner), null);
        assert.equal(previous.session.current(), false);
      }
      await assert.rejects(session.command('bind', 'not-an-anonymous-account'), error => error.code === 'VOICE_ANONYMOUS_ACCOUNT_FORBIDDEN');
      assert.equal((await session.host.agree(true)).error, 'VOICE_LOCAL_CONSENT_REQUIRED');
      const gate = heldGate = { arrived:deferred(), resume:deferred() };
      const delayedShow = bridge.showAnonymousVoiceEnrollment();
      const cancelledShow = assert.rejects(delayedShow, error => error.code === 'VOICE_REQUEST_RETIRED');
      assert.equal((await gate.arrived.promise).enabled, true);
      const retiredRequest = session.requestRevision;
      const disabling = bridge.configureAnonymousVoiceCapability(false);
      assert.equal(session.armed, false, 'Disable must revoke the request before its first await');
      assert(session.requestRevision > retiredRequest);
      await disabling;
      assert.equal(media.enabled, false);
      const hasRecorder = () => electron.BrowserWindow.getAllWindows().some(window => !window.isDestroyed() &&
        window.webContents.getURL().includes('/meeting_voice_recorder.html#'));
      assert.equal(hasRecorder(), false);
      gate.resume.resolve();
      await cancelledShow;
      assert.equal(hasRecorder(), false, 'A delayed pre-disable acknowledgement opened a recorder');
      assert.equal(session.requested(), false);
      assert.equal(session.allowed(), false);
      assert.equal(session.host.hasEnrollment(), false);
      assert.equal(session.filter.active, null);
      await assert.rejects(session.apply(retiredRequest), error => error.code === 'VOICE_REQUEST_RETIRED');
      assert.equal((await view.request('voice.state')).enabled, false);
      await bridge.configureAnonymousVoiceCapability(true);
      const shown = await bridge.showAnonymousVoiceEnrollment();
      assert.equal(shown.recordingStarted, false); assert.equal(shown.processing, false);
      assert.equal(shown.state, 'blocked'); assert.equal(shown.enrolled, false);
      await assert.rejects(session.apply(retiredRequest), error => error.code === 'VOICE_REQUEST_RETIRED');
      assert.equal((await bridge.configureVoiceProtection(true, session)).state, 'blocked');
      assert.equal(accountReads, 0);
      const local = electron.BrowserWindow.getAllWindows().find(window => !window.isDestroyed() &&
        window.webContents.getURL().includes('/meeting_voice_recorder.html#'));
      assert(local);
      const page = await local.webContents.executeJavaScript(`({
        anonymous: !document.getElementById('voice-anonymous-statement').hidden,
        disabled: document.getElementById('voice-record').disabled,
        capture: document.body.dataset.voiceState === 'recording'
      })`);
      assert(page.anonymous && page.disabled && !page.capture);
      const disabled = await bridge.configureAnonymousVoiceCapability(false);
      assert.equal(disabled.enabled, false); assert.equal(disabled.processing, false);
      assert.equal(session.host.hasEnrollment(), false);
      assert.equal(media.enabled, false); assert.equal(media.stopped, true);
      assert(local.isDestroyed());
      previous = voices.room;
      await bridge.configureAnonymousVoiceCapability(true);
      const releaseGate = heldGate = { arrived:deferred(), resume:deferred() };
      const releasedShow = bridge.showAnonymousVoiceEnrollment();
      const cancelledByRelease = assert.rejects(releasedShow, error => error.code === 'VOICE_REQUEST_RETIRED');
      assert.equal((await releaseGate.arrived.promise).enabled, true);
      const releasedRequest = session.requestRevision;
      const retiring = voices.retire(owner);
      assert(session.requestRevision > releasedRequest);
      assert.equal(session.current(), false);
      await retiring;
      releaseGate.resume.resolve();
      await cancelledByRelease;
      assert.equal(hasRecorder(), false, 'A delayed acknowledgement opened a recorder after room release');
      await assert.rejects(session.apply(releasedRequest), error => error.code === 'VOICE_REQUEST_RETIRED');
      assert.equal(session.requested(), false);
      assert.equal(session.host.hasEnrollment(), false);
      assert.equal(session.filter.active, null);
      assert.equal((await view.request('voice.state')).enabled, false);
      assert.equal(permissionRequests, 0);
      report.rooms.push({ origin, state:shown.state, consentImplicit:false, accountReads, permissionRequests,
        delayedGateRevoked:true, delayedGateReleased:true, staleActivationRejected:true,
        recorderOpenedAfterDisable:false, recorderOpenedAfterRelease:false });
      assert.equal(session.host.recordForFilter(), null);
      view.close(); view = null;
      await bridge.configureAnonymousVoiceCapability(true);
    }
    assert.equal(permissionRequests, 0, 'Displaying anonymous enrollment requested hardware permission');
    assert.equal(accountReads, 0);
    await bridge.prepareAnonymousSession(bridge.origin, bridge.ownerEpoch, false);
    assert.equal(bridge.mediaOwner.anonymous, false);
    assert.equal(bridge.voiceSession(), null);
    assert.equal(accountReads, 1, 'The original account provider was not restored for an account session');
    report.accountProviderRestoredOnlyAfterExplicitCutover = true;
    return report;
  } finally {
    if (bridge.anonymousVoice.room) await bridge.anonymousVoice.retire(bridge.anonymousVoice.room.owner);
    view?.close();
    electron.ipcMain.removeHandler(bridge.channel);
  }
}

module.exports = { verifyGuestVoiceAuthority };
