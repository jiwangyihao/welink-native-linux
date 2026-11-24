/* MAIN-world capture factory; no Node APIs and no automatic device acquisition.
 *
 * Dependency contract (these are bridge fields, NOT Huawei protocol fields):
 *   captureDisplay(constraints) -> Promise<MediaStream>: the genuine browser
 *     display API, or the host's user-selected Electron desktop capture. Keep
 *     the original function before installing this adapter; do not recurse
 *     through navigator.mediaDevices.getDisplayMedia after replacing it.
 *   mediaDevices: the real navigator.mediaDevices, including getUserMedia,
 *     getSupportedConstraints and enumerateDevices.
 *   getState() -> { sessionKey, joined, sharingPermission, localStream }:
 *     sessionKey changes on every join; sharingPermission is 'allowed',
 *     'denied' or 'unknown', derived from the actual vendor sharing gates.
 *     localStream is the genuine current HRTC LocalStream, not serialized IPC.
 *   subscribe(listener) -> unsubscribe: synchronous vendor-state notifications.
 *   onCaptureStopped({ stream, auxStream, reason, cleanupError }): nonthrowing synchronous
 *     notification. The owner must close/unpublish the matching genuine aux
 *     stream through its existing vendor stop saga, including during disposal.
 *     Stopping browser tracks alone is NOT evidence of successful unpublish.
 *
 * getDisplayMedia(constraints, { audioSource, deviceId, signal }) is suitable
 * for the HRTC display-capture hook. audioSource is 'display' (default) or
 * 'audio-input'. The latter requires a concrete, explicitly user-selected
 * audioinput deviceId from listAudioInputs(), never 'default'/'communications'.
 * This API deliberately calls it a selected input, not proven system audio:
 * the host/UI must identify an actual output-routed input and disclose its
 * scope (including possible conference playback) before selection. No label
 * heuristic, microphone fallback, PULSE_SOURCE change or device creation is
 * performed. Linux Chromium 104 excludes raw PulseAudio monitor devices; an
 * explicitly configured real remap source can expose output as an input.
 *
 * For audio sharing the owner must create the genuine HRTC stream with
 * { screen: true, screenAudio: true }, initialize it using this capture hook,
 * then call bindScreenAudio(auxStream) BEFORE the normal vendor publication.
 * This only prepares the SDK's real mixer; await the vendor publish outcome
 * before announcing sharing. The existing main audio track is required (it
 * may be muted). This helper never captures/unmutes/replaces a microphone.
 * The owner must keep the vendor AUX_SHARE/freeShare/multiShare gates, rather
 * than replacing them with a local checkbox or a successful browser capture.
 *
 * Recording belongs to the separate authorized recording factory, not this
 * capture module. MediaRecorder availability does not grant recording rights.
 * The WebRTC requestLocalRecordPermission payload asks for cloud recording
 * (START_CLOUD_RECORD_REQUEST -> MMRRECORD), not a local-file recording grant.
 * Native SDK evidence separately identifies ALLOW_CLIENT_REC, CLIENTRECMODE
 * and ParticipantInfoNotify.ClientRecState. Only the verified permission/status
 * adapter may translate those contracts; never synthesize approval from a role.
 *
 * Evidence: vendor/hrtc-12.eb3d2838.js (initAuxStream,
 * bindScreenAudio2RelatedStreamImpl, getPublishAudioTrack); WebRTC module
 * 55375 (sharing) and handleGusetRecordRequest/sendConfRecord (cloud recording).
 * Browser/host boundaries:
 * https://www.electronjs.org/docs/latest/api/session#sessetdisplaymediarequesthandlerhandler-opts
 * https://raw.githubusercontent.com/chromium/chromium/104.0.5112.114/media/audio/pulse/audio_manager_pulse.cc
 * https://www.freedesktop.org/wiki/Software/PulseAudio/Documentation/User/Modules/#module-remap-source
 * https://w3c.github.io/mediacapture-record/#dom-mediarecorder-start
 */
(() => {
  'use strict';
  if (window.__welinkCreateNativeWebCapture) return;

  window.__welinkCreateNativeWebCapture = function createNativeWebCapture(deps) {
    for (const name of ['captureDisplay', 'getState', 'subscribe', 'onCaptureStopped']) {
      if (!deps || typeof deps[name] !== 'function')
        throw new TypeError('Missing capture dependency: ' + name);
    }
    const devices = deps.mediaDevices;
    const active = new Set();
    const captures = new WeakMap();
    let disposed = false;

    function error(code, message) {
      return Object.assign(new Error(message), { code });
    }
    function permissionError(state, sessionKey) {
      if (disposed) return error('DISPOSED', 'The capture helper was disposed');
      if (!state || !state.joined || !state.sessionKey)
        return error('NOT_JOINED', 'Screen capture requires a current conference');
      if (sessionKey !== undefined && state.sessionKey !== sessionKey)
        return error('CONFERENCE_CHANGED', 'The capture belongs to a previous conference');
      if (state.sharingPermission !== 'allowed')
        return error(state.sharingPermission === 'denied' ? 'SHARING_DENIED' : 'SHARING_PERMISSION_UNKNOWN',
          'Vendor screen-sharing authorization is not granted');
      return null;
    }
    function release(entry, reason) {
      if (entry.stopped) return;
      entry.stopped = true;
      entry.reason = reason;
      active.delete(entry);
      if (entry.signal) entry.signal.removeEventListener('abort', entry.abort);
      for (const [track, listener] of entry.listeners) track.removeEventListener('ended', listener);
      for (const stream of entry.streams) for (const track of stream.getTracks()) track.stop();
      let cleanupError = null;
      try {
        // Clear both SDK binding references, not only the aux capture tracks.
        // The SDK keeps the main audio source connected to its mixer output.
        if (entry.aux && entry.main) entry.main.closeScreenShareAudio();
      } catch (failure) {
        cleanupError = failure;
      }
      entry.bound = cleanupError ? null : false;
      if (entry.ready) deps.onCaptureStopped({ stream: entry.output, auxStream: entry.aux,
        reason, cleanupError });
    }
    function own(entry, stream) {
      if (!stream || typeof stream.getTracks !== 'function')
        throw error('INVALID_CAPTURE_RESULT', 'The capture API did not return a MediaStream');
      if (entry.stopped) {
        for (const track of stream.getTracks()) track.stop();
        throw error(entry.reason, 'The pending capture was cancelled');
      }
      entry.streams.add(stream);
      for (const track of stream.getTracks()) {
        const listener = () => release(entry, 'SOURCE_ENDED');
        entry.listeners.set(track, listener);
        track.addEventListener('ended', listener);
      }
    }
    function ensureCurrent(entry) {
      if (entry.stopped) throw error(entry.reason, 'The capture is no longer active');
      const failure = permissionError(deps.getState(), entry.sessionKey);
      if (failure) throw failure;
    }
    function requireTrack(stream, kind) {
      const tracks = kind === 'video' ? stream.getVideoTracks() : stream.getAudioTracks();
      if (tracks.length !== 1 || tracks[0].readyState !== 'live' || !tracks[0].enabled)
        throw error(kind === 'audio' ? 'AUDIO_NOT_CAPTURED' : 'VIDEO_NOT_CAPTURED',
          'Capture did not supply exactly one live, enabled ' + kind + ' track');
      return tracks[0];
    }
    function hasExactDeviceCapture() {
      return !!(devices && typeof devices.getUserMedia === 'function' &&
        typeof devices.getSupportedConstraints === 'function' && devices.getSupportedConstraints().deviceId);
    }
    function reconcile() {
      const state = deps.getState();
      for (const entry of active) {
        const failure = permissionError(state, entry.sessionKey);
        if (failure) release(entry, failure.code);
        else if (entry.main && state.localStream !== entry.main) release(entry, 'MAIN_STREAM_CHANGED');
        else if (entry.output && entry.output.getTracks().some(track => track.readyState === 'ended'))
          release(entry, 'SOURCE_ENDED');
      }
    }
    const unsubscribe = deps.subscribe(reconcile);
    if (typeof unsubscribe !== 'function')
      throw new TypeError('Capture subscribe must return an unsubscribe function');

    async function listAudioInputs() {
      if (disposed) throw error('DISPOSED', 'The capture helper was disposed');
      if (!devices || typeof devices.enumerateDevices !== 'function')
        throw error('DEVICE_ENUMERATION_UNAVAILABLE', 'The browser cannot enumerate audio inputs');
      const available = await devices.enumerateDevices();
      return available.filter(device => device.kind === 'audioinput' && device.deviceId &&
        device.deviceId !== 'default' && device.deviceId !== 'communications').map(device => ({
        kind: device.kind, deviceId: device.deviceId, label: device.label
      }));
    }

    async function getDisplayMedia(constraints, options = {}) {
      const state = deps.getState();
      const failure = permissionError(state);
      if (failure) throw failure;
      if (!constraints || !constraints.video)
        throw error('VIDEO_REQUIRED', 'HRTC screen sharing requires display video');
      const wantsAudio = !!constraints.audio;
      const source = wantsAudio ? options.audioSource || 'display' : 'none';
      if (!['none', 'display', 'audio-input'].includes(source))
        throw error('INVALID_AUDIO_SOURCE', 'Select display audio or a specific audio input');
      if (source === 'audio-input') {
        if (!hasExactDeviceCapture())
          throw error('EXACT_DEVICE_SELECTION_UNAVAILABLE', 'Exact audio-device selection is unavailable');
        if (typeof options.deviceId !== 'string' || !options.deviceId ||
            options.deviceId === 'default' || options.deviceId === 'communications')
          throw error('AUDIO_DEVICE_REQUIRED', 'Select a concrete output-routed audio input');
      }
      if (options.signal && options.signal.aborted)
        throw error('CAPTURE_CANCELLED', 'Capture was cancelled');
      const entry = { sessionKey: state.sessionKey, source, streams: new Set(), listeners: new Map(),
        output: null, aux: null, main: null, bound: false, ready: false, stopped: false, reason: null,
        signal: options.signal, abort: null };
      active.add(entry);
      if (entry.signal) {
        entry.abort = () => release(entry, 'CAPTURE_CANCELLED');
        entry.signal.addEventListener('abort', entry.abort, { once: true });
      }
      try {
        // Invoke before the first await: preserve the display API's user gesture.
        const stream = await deps.captureDisplay({ ...constraints,
          audio: source === 'display' ? constraints.audio : false });
        own(entry, stream);
        entry.output = stream;
        ensureCurrent(entry);
        requireTrack(stream, 'video');
        if (source !== 'display' && stream.getAudioTracks().length)
          throw error('UNEXPECTED_DISPLAY_AUDIO', 'The display API returned unrequested audio');
        if (source === 'audio-input') {
          const input = await devices.getUserMedia({ video: false, audio: {
            deviceId: { exact: options.deviceId },
            echoCancellation: false, noiseSuppression: false, autoGainControl: false
          } });
          own(entry, input);
          ensureCurrent(entry);
          const audio = requireTrack(input, 'audio');
          if (audio.getSettings().deviceId !== options.deviceId)
            throw error('AUDIO_DEVICE_MISMATCH', 'The browser did not capture the explicitly selected device');
          stream.addTrack(audio);
        }
        if (wantsAudio) requireTrack(stream, 'audio');
        ensureCurrent(entry);
        entry.ready = true;
        captures.set(stream, entry);
        return stream;
      } catch (failure) {
        release(entry, failure.code || failure.name || 'CAPTURE_FAILED');
        throw failure;
      }
    }

    function bindScreenAudio(auxStream) {
      if (!auxStream || typeof auxStream.getVideoTrack !== 'function')
        throw error('VENDOR_ABI_MISMATCH', 'Missing genuine HRTC screen-audio API: getVideoTrack');
      const video = auxStream.getVideoTrack();
      const entry = Array.from(active).find(item => item.ready && item.output.getVideoTracks()[0] === video);
      if (!entry) throw error('CAPTURE_NOT_OWNED', 'The HRTC stream does not use this helper\'s display capture');
      const alreadyBound = !!entry.aux;
      try {
        const state = deps.getState();
        const failure = permissionError(state);
        if (failure) throw failure;
        for (const name of ['getAudioTrack', 'getPublishAudioTrack', 'bindScreenAudio2RelatedStream']) {
          if (typeof auxStream[name] !== 'function')
            throw error('VENDOR_ABI_MISMATCH', 'Missing genuine HRTC screen-audio API: ' + name);
        }
        ensureCurrent(entry);
        const audio = requireTrack(entry.output, 'audio');
        if (auxStream.getAudioTrack() !== audio)
          throw error('SCREEN_AUDIO_NOT_INITIALIZED', 'Initialize HRTC with screenAudio:true before binding audio');
        const main = state.localStream;
        const mainTrack = main && typeof main.getAudioTrack === 'function' && main.getAudioTrack();
        if (!mainTrack || mainTrack.readyState !== 'live')
          throw error('MAIN_AUDIO_TRACK_MISSING', 'HRTC needs an existing main audio track for screen-audio binding');
        if (typeof main.closeScreenShareAudio !== 'function')
          throw error('VENDOR_ABI_MISMATCH', 'HRTC screen-audio unbinding is unavailable');
        for (const other of active) {
          if (other !== entry && other.main === main && other.aux)
            throw error('AUDIO_ALREADY_BOUND', 'The main HRTC stream already has a screen-audio binding');
        }
        if (entry.aux) {
          if (entry.aux !== auxStream || entry.main !== main)
            throw error('AUDIO_ALREADY_BOUND', 'The capture is already bound to another HRTC stream');
          return inspect(entry.output);
        }
        entry.aux = auxStream;
        entry.main = main;
        // false preserves the existing main-track mute state. The true branch
        // can create a main track and is deliberately not used as a fallback.
        auxStream.bindScreenAudio2RelatedStream(main, false);
        entry.bound = true;
        const mixed = auxStream.getPublishAudioTrack();
        if (!mixed || mixed === audio || mixed.readyState !== 'live')
          throw error('SCREEN_AUDIO_BIND_FAILED', 'HRTC did not prepare a live mixed audio track');
        return inspect(entry.output);
      } catch (failure) {
        if (!alreadyBound) {
          // Keep the genuine aux identity for owner teardown even when failure
          // occurs before establishing a mixer binding.
          entry.aux = auxStream;
          release(entry, failure.code || failure.name || 'SCREEN_AUDIO_BIND_FAILED');
        }
        throw failure;
      }
    }

    function trackState(track) {
      return track ? { present: true, readyState: track.readyState, enabled: track.enabled,
        muted: track.muted } : { present: false };
    }
    function inspect(stream) {
      const entry = captures.get(stream);
      if (!entry) throw error('CAPTURE_NOT_OWNED', 'Unknown display capture');
      return { source: entry.source, stopped: entry.stopped, reason: entry.reason,
        video: trackState(stream.getVideoTracks()[0]), audio: trackState(stream.getAudioTracks()[0]),
        sdkAudioBound: entry.bound,
        sdkPublishAudioTrack: entry.bound === null ? null :
          trackState(entry.bound && entry.aux.getPublishAudioTrack()) };
    }
    function stop(stream) {
      const entry = captures.get(stream);
      if (!entry) throw error('CAPTURE_NOT_OWNED', 'Unknown display capture');
      release(entry, 'STOP_REQUESTED');
    }
    function dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      for (const entry of active) release(entry, 'DISPOSED');
    }

    return Object.freeze({ getDisplayMedia, listAudioInputs, bindScreenAudio, inspect, stop, dispose,
      browserCapabilities: () => ({ displayCaptureConfigured: typeof deps.captureDisplay === 'function',
        exactAudioInputCapture: hasExactDeviceCapture(),
        audioInputEnumeration: !!(devices && typeof devices.enumerateDevices === 'function'),
        mediaRecorderAvailable: typeof window.MediaRecorder === 'function' }) });
  };
})();
