/* Invitation-owned screen-start guard for the pinned WebRTC 55375/2500 workers.
 * The original answerInviteShare action dispatches onStartAuxStreamImpl; that
 * worker initializes capture and sends AUX_SHARE before its ANSWER_SHARE reply.
 * Install before joining/mounting the conference UI, while React useDispatch
 * still obtains the actual store.dispatch. Only explicit invitation actions
 * establish ownership; an ordinary/manual screen share is never reclassified.
 */
(() => {
  'use strict';
  if (window.__welinkCreateInvitedShareGuard) return;
  const error = message => Object.assign(new Error(message), { code: 'NATIVE_CAPABILITY_DISABLED', details: { type: 1 } });
  window.__welinkCreateInvitedShareGuard = function ({ vendor, actions, isEnabled, onBlocked, cancelPicker, stopStream }) {
    const store = vendor.store, originalDispatch = store.dispatch;
    const answerType = actions.answerInviteShare().type, startType = actions.onStartAuxStreamImpl().type;
    if (typeof originalDispatch !== 'function' || typeof answerType !== 'string' || typeof startType !== 'string' ||
        ![isEnabled, cancelPicker, stopStream].every(value => typeof value === 'function'))
      throw new TypeError('The genuine invitation, capture and stream owners are required');
    const records = new Set(), streams = new WeakMap();
    let current = null, captureOwner = null, disposed = false;
    function assert(record) {
      if (record && (record.cancelled || disposed || !isEnabled())) throw error('The sharing invitation was revoked before completion');
    }
    function guardDispatch(action) {
      const invited = action?.type === answerType && action.payload === vendor.constants.INVITE_SHARE_ANSWER.AGREE ||
        action?.type === startType && action.payload?.needSendInviteOpenShareToCms === true;
      if (!invited) return originalDispatch(action);
      if (disposed || !isEnabled()) { onBlocked?.(); throw error('Sharing invitations are disabled'); }
      if (current) return originalDispatch(action);
      const record = { id: crypto.randomUUID(), stream: null, media: null, cancelled: false,
        initialized: false, established: false, publication: null, stopping: null };
      current = record;
      try { return originalDispatch(action); }
      finally { current = null; }
    }
    store.dispatch = guardDispatch;
    function stopTracks(record) {
      if (record.media) for (const track of record.media.getTracks()) track.stop();
    }
    function stop(record) {
      if (record.stopping) return record.stopping;
      record.cancelled = true;
      stopTracks(record);
      record.stopping = (async () => {
        await cancelPicker(record.id);
        if (record.publication) {
          try { await record.publication; } catch (_) { /* Failed publication still owns capture. */ }
        }
        if (record.stream) await stopStream(record.stream, record.client);
      })();
      return record.stopping;
    }
    function guardStream(stream, client) {
      const record = current;
      if (!record) return stream;
      assert(record);
      if (record.stream) throw Object.assign(new Error('The invitation already owns a screen stream'), { code: 'SCREEN_CAPTURE_IN_PROGRESS' });
      const initialize = stream.initialize, close = stream.close;
      if (typeof initialize !== 'function' || typeof close !== 'function') throw new TypeError('Actual HRTC stream initialization and close are required');
      record.stream = stream; record.client = client; records.add(record); streams.set(stream, record);
      stream.initialize = function (...args) {
        assert(record);
        if (captureOwner && captureOwner !== record) throw Object.assign(new Error('Another invitation capture is pending'), { code: 'SCREEN_CAPTURE_IN_PROGRESS' });
        captureOwner = record;
        let result;
        // HRTC 1.10.96 initializeImpl immediately calls reset(), whose first
        // synchronous step is close(). That reset is not user cancellation.
        record.initialReset = true;
        try { result = initialize.apply(this, args); } catch (failure) { result = Promise.reject(failure); }
        finally { record.initialReset = false; }
        return Promise.resolve(result).then(value => {
          assert(record); record.initialized = true; return value;
        }).catch(async failure => {
          record.cancelled = true; stopTracks(record);
          // initialize can finish after an earlier close. Close the real SDK
          // again at that completion boundary, including any late SDK resources.
          await close.call(stream);
          records.delete(record);
          throw failure;
        }).finally(() => { if (captureOwner === record) captureOwner = null; });
      };
      stream.close = function (...args) {
        if (!record.initialReset) {
          record.cancelled = true; stopTracks(record); records.delete(record);
        }
        return close.apply(this, args);
      };
      return stream;
    }
    function capture(operation) {
      const record = captureOwner;
      if (!record) return operation(null);
      assert(record);
      return Promise.resolve(operation(record.id)).then(media => {
        record.media = media;
        try { assert(record); } catch (failure) { stopTracks(record); throw failure; }
        return media;
      });
    }
    function observePublish(stream, publication) {
      const record = streams.get(stream);
      if (!record) return;
      record.publication = publication;
      publication.then(() => {
        if (!record.cancelled) record.established = true;
      }, () => {}).catch(() => {});
    }
    async function revoke() {
      const pending = [...records].filter(record => !record.established);
      for (const record of pending) { record.cancelled = true; stopTracks(record); }
      await Promise.all(pending.map(stop));
      return { cancelledStarts: pending.length };
    }
    function ensure() {
      if (disposed || store.dispatch !== guardDispatch)
        throw Object.assign(new Error('The invitation dispatch guard was replaced'), { code: 'CAPABILITY_ENFORCEMENT_LOST' });
    }
    function dispose() {
      disposed = true;
      if (store.dispatch === guardDispatch) store.dispatch = originalDispatch;
      return revoke();
    }
    return Object.freeze({ guardStream, capture, observePublish, revoke, ensure, dispose,
      assertPublish(stream) { const record = streams.get(stream); if (record && !record.established) assert(record); },
      capturePending() { return !!captureOwner; } });
  };
})();
