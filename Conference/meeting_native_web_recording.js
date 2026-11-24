/* MAIN-world local recording of existing, genuinely authorized meeting media.
 * No getUserMedia/getDisplayMedia, SDK simulation, transport guessing or MP4
 * renaming. Canvas/WebAudio produce only a recording mix of supplied real tracks.
 *
 * Dependency contract (normalized bridge objects, NOT vendor wire fields):
 *   getState() -> { sessionKey:string, joined:boolean, audioStreams:(HRTCStream|MediaStream)[],
 *     videoLayout:[{stream:HRTCStream,resolutionId?,x,y,width,height}], ... }
 *     Omitted start audio/video choices select existing media kinds. Explicit
 *     true never silently downgrades; the output track kinds stay fixed once started.
 *     Rectangles are normalized 0..1. Supply only media authorized for this
 *     recording, including only actually published local media. The real actor
 *     is participants[selectOwn().id], or audiences[id] for the audience role;
 *     selectOwn() itself does NOT contain pinfoMap. Additional snapshot fields
 *     (actor, BasicInfo, etc.) pass unchanged to the authorization adapter.
 *   subscribe(listener) -> unsubscribe: synchronous policy/media notifications.
 *   authorization(snapshot) -> {state:'allowed'|'denied'|'unknown',reason?}:
 *     synchronous, backed by the proven tenant/host/participant policy and grant.
 *     Unknown is never permission. No role, browser API, or file picker grants it.
 *   watermark: the SAME authoritative __welinkCreateNativeWatermark instance
 *     used to gate meeting show/join, with synchronous ensure, paint, state and
 *     subscribe methods. Unknown policy is never approval. Enabled policy blocks
 *     audio-only recording; it never adds a video track or captures another source.
 *     Every real video frame is painted last, including on policy changes.
 *     Policy loss stops recording and aborts/quarantines the partial sink.
 *   reportStatus({sessionKey,state:'recording'|'stopped',signal?})
 *     -> Promise<{confirmed:true}>: resolves only after actual vendor acceptance;
 *     rejects transport/service failures. The caller implements the proven wire
 *     mapping; this module never synthesizes those protocol fields or an ACK.
 *   sink.open({mimeType,extension,signal}) -> Promise<opaqueHandle|null>:
 *     user-selected output, null means cancelled. Honor signal where possible.
 *   sink.write(handle,ArrayBuffer,{sequence,mimeType}) -> Promise<bytesWritten>:
 *     acknowledge only bytes actually written; partial writes are errors here.
 *   sink.close(handle) -> Promise<receipt>: commit/close actual output, not merely
 *     enqueue it. The receipt is returned unchanged; no file path is invented.
 *   sink.abort(handle,error) -> Promise<void>: discard/quarantine partial output.
 *   onState?(summary), onError?(error): nonthrowing notifications.
 *
 * The start notification is sent only after MediaRecorder's real start event.
 * Chunks are held until that notification is confirmed. Revocation stops media
 * immediately and aborts partial output. Normal stop drains all ordered chunks,
 * closes the real sink, and confirms the stop notification before succeeding.
 * Status evidence retains the reporter's scope: transport-accepted is not a
 * fabricated server acknowledgment or permission grant.
 * A status-report failure after a successful file close is an error containing
 * the real output receipt, not a fabricated recording-complete event.
 * Borrowed SDK tracks are never stopped, enabled, disabled, replaced or cloned.
 * Only this factory's canvas/destination tracks and AudioContext are destroyed.
 * The host must keep the renderer's recording clock running when backgrounded
 * (Electron backgroundThrottling); timer throttling is not extra video frames.
 *
 * https://w3c.github.io/mediacapture-record/
 * https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/captureStream
 * https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/createMediaStreamDestination
 */
(() => {
  'use strict';
  if (window.__welinkCreateNativeWebRecording) return;

  window.__welinkCreateNativeWebRecording = function createNativeWebRecording(deps) {
    for (const name of ['getState', 'subscribe', 'authorization', 'reportStatus', 'confirmStart']) {
      if (!deps || typeof deps[name] !== 'function') throw new TypeError('Missing recording dependency: ' + name);
    }
    for (const name of ['open', 'write', 'close', 'abort']) {
      if (!deps.sink || typeof deps.sink[name] !== 'function') throw new TypeError('Missing recording sink: ' + name);
    }
    for (const name of ['ensure', 'paint', 'state', 'subscribe']) {
      if (!deps.watermark || typeof deps.watermark[name] !== 'function')
        throw new TypeError('Missing authoritative recording watermark dependency: ' + name);
    }
    let current = null, disposed = false;
    const VIDEO_TYPES = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm', 'video/mp4'];
    const AUDIO_TYPES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'];

    function error(code, message) { return Object.assign(new Error(message), { code }); }
    function deferred() {
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      // Observe early rejection without changing the promise returned to callers.
      promise.catch(() => {});
      return { promise, resolve, reject };
    }
    function summary(session = current) {
      return session ? { state: session.phase, mimeType: session.mimeType,
        media: { audio: session.options.audio, video: session.options.video },
        watermark: { ...session.watermark, paintedRevision: session.paintedRevision },
        bytesWritten: session.bytes, chunksWritten: session.chunks, pendingBytes: session.pendingBytes,
        audioSources: session.audioNodes.size, videoSources: session.videoNodes.size,
        receipt: session.receipt, statusReports: session.statusReports } : { state: 'idle' };
    }
    function notify(session) { if (typeof deps.onState === 'function') deps.onState(summary(session)); }
    function addFailure(session, failure) {
      const value = failure instanceof Error ? failure : error('RECORDING_FAILED', String(failure));
      if (!session.error) session.error = value;
      else if (session.error !== value) session.cleanupErrors.push({ code: value.code || value.name, message: value.message });
      return value;
    }
    function authorize(snapshot) {
      const permission = deps.authorization(snapshot);
      if (!permission || permission.state !== 'allowed')
        throw error(permission && permission.state === 'denied' ? 'RECORDING_DENIED' : 'RECORDING_PERMISSION_UNKNOWN',
          permission && permission.reason || 'A verified vendor local-record grant is required');
      return permission;
    }
    function ensureWatermark(options) {
      const scope = options.video ? 'local-recording-video' : 'local-recording-audio';
      const result = deps.watermark.ensure(scope);
      if (!result || result.ready !== true || result.scope !== scope || typeof result.enabled !== 'boolean' ||
          !Number.isSafeInteger(result.revision) || result.enabled && !options.video)
        throw error('RECORDING_WATERMARK_UNCONFIRMED', 'The authoritative watermark did not approve the actual recording kind');
      return result;
    }
    function sameSession(session, snapshot) {
      return !!snapshot && snapshot.joined === true && snapshot.sessionKey === session.sessionKey;
    }
    function activeSnapshot(session) {
      if (session.error) throw session.error;
      if (session.stopRequested) throw error('RECORDING_CANCELLED', 'Recording was stopped');
      const snapshot = deps.getState();
      if (!sameSession(session, snapshot)) throw error('RECORDING_SESSION_ENDED', 'The authorized meeting session ended');
      authorize(snapshot);
      session.watermark = ensureWatermark(session.options);
      return snapshot;
    }
    function supportedTypes(types) {
      return typeof window.MediaRecorder === 'function' && typeof window.MediaRecorder.isTypeSupported === 'function' ?
        types.filter(type => window.MediaRecorder.isTypeSupported(type)) : [];
    }
    function capabilities() {
      let permission;
      try {
        const result = deps.authorization(deps.getState());
        permission = result && ['allowed', 'denied', 'unknown'].includes(result.state) ?
          { state: result.state, reason: result.reason || null } : { state: 'unknown', reason: 'INVALID_AUTHORIZATION_RESULT' };
      } catch (failure) { permission = { state: 'unknown', reason: failure.code || 'AUTHORIZATION_UNAVAILABLE' }; }
      return { browser: { mediaRecorder: typeof window.MediaRecorder === 'function',
        canvasCapture: typeof window.HTMLCanvasElement === 'function' &&
          typeof window.HTMLCanvasElement.prototype.captureStream === 'function',
        audioMixing: typeof window.AudioContext === 'function',
        videoMimeTypes: supportedTypes(VIDEO_TYPES), audioMimeTypes: supportedTypes(AUDIO_TYPES) },
        permission, watermark: deps.watermark.state() };
    }
    function readInputs(snapshot, options) {
      if (!Array.isArray(snapshot.audioStreams) || !Array.isArray(snapshot.videoLayout))
        throw error('INVALID_RECORDING_STATE', 'Actual audio streams and video layout are required');
      const audio = new Map(), video = [];
      if (options.audio) for (const stream of snapshot.audioStreams) {
        let tracks;
        if (stream && typeof stream.getAudioTrack === 'function') tracks = [stream.getAudioTrack()];
        else if (stream instanceof MediaStream) tracks = stream.getAudioTracks();
        else throw error('VENDOR_ABI_MISMATCH', 'Recording requires a genuine HRTC stream or its actual incoming MediaStream');
        // The SDK's audioStreams4TopN exposes real MediaStreams, while local
        // streams additionally expose a mute getter. Never build a fake SDK object.
        const sdkMuted = typeof stream.isAudioMuted === 'function' && stream.isAudioMuted();
        for (const track of tracks) {
          if (!track || track.readyState !== 'live') continue;
          if (track.kind !== 'audio') throw error('INVALID_RECORDING_TRACK', 'HRTC did not return an audio track');
          audio.set(track, !!audio.get(track) || track.enabled && !sdkMuted);
        }
      }
      if (options.video) for (const item of snapshot.videoLayout) {
        if (!item || !item.stream || typeof item.stream.getVideoTrack !== 'function')
          throw error('VENDOR_ABI_MISMATCH', 'Recording requires genuine HRTC video-stream accessors');
        const { x, y, width, height } = item;
        if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0 ||
            x + width > 1 || y + height > 1)
          throw error('INVALID_RECORDING_LAYOUT', 'Video rectangles must be positive normalized rectangles inside the canvas');
        const track = item.stream.getVideoTrack(item.resolutionId);
        if (!track || track.readyState !== 'live') continue;
        if (track.kind !== 'video') throw error('INVALID_RECORDING_TRACK', 'HRTC did not return a video track');
        video.push({ track, x, y, width, height, visible: track.enabled &&
          (typeof item.stream.isVideoMuted !== 'function' || !item.stream.isVideoMuted(item.resolutionId)) });
      }
      return { audio, video };
    }
    function releaseInputs(session) {
      clearTimeout(session.timer);
      session.timer = null;
      for (const [track, listener] of session.trackListeners) track.removeEventListener('ended', listener);
      session.trackListeners.clear();
      for (const node of session.audioNodes.values()) { node.source.disconnect(); node.gain.disconnect(); }
      session.audioNodes.clear();
      for (const video of session.videoNodes.values()) { video.pause(); video.srcObject = null; }
      session.videoNodes.clear();
      session.layout = [];
    }
    function reconcile(session, snapshot) {
      const inputs = readInputs(snapshot, session.options);
      for (const [track, node] of session.audioNodes) if (!inputs.audio.has(track)) {
        node.source.disconnect(); node.gain.disconnect(); session.audioNodes.delete(track);
      }
      for (const [track, audible] of inputs.audio) {
        let node = session.audioNodes.get(track);
        if (!node) {
          const source = session.audioContext.createMediaStreamSource(new MediaStream([track]));
          const gain = session.audioContext.createGain();
          source.connect(gain); gain.connect(session.destination);
          node = { source, gain };
          session.audioNodes.set(track, node);
        }
        node.gain.gain.value = audible ? 1 : 0;
      }
      const videoTracks = new Set(inputs.video.map(item => item.track));
      for (const [track, element] of session.videoNodes) if (!videoTracks.has(track)) {
        element.pause(); element.srcObject = null; session.videoNodes.delete(track);
      }
      for (const track of videoTracks) if (!session.videoNodes.has(track)) {
        const element = document.createElement('video');
        element.muted = true;
        element.playsInline = true;
        element.srcObject = new MediaStream([track]);
        session.videoNodes.set(track, element);
        element.play().catch(failure => {
          // Removing a participant can cancel that element's pending play().
          if (!session.stopRequested && session.videoNodes.get(track) === element) failSession(session, failure);
        });
      }
      session.layout = inputs.video;
      const tracks = new Set([...inputs.audio.keys(), ...videoTracks]);
      for (const [track, listener] of session.trackListeners) if (!tracks.has(track)) {
        track.removeEventListener('ended', listener); session.trackListeners.delete(track);
      }
      for (const track of tracks) if (!session.trackListeners.has(track)) {
        const listener = () => changed(session);
        session.trackListeners.set(track, listener);
        track.addEventListener('ended', listener);
      }
      return inputs;
    }
    function draw(session) {
      const canvas = session.canvas, context = session.context;
      try {
        const approval = session.watermark = ensureWatermark(session.options);
        context.fillStyle = '#000';
        context.fillRect(0, 0, canvas.width, canvas.height);
        let frames = 0;
        for (const item of session.layout) {
          const video = session.videoNodes.get(item.track);
          if (!item.visible || !item.track.enabled || item.track.readyState !== 'live' || !video ||
              video.readyState < 2 || !video.videoWidth || !video.videoHeight) continue;
          const width = item.width * canvas.width, height = item.height * canvas.height;
          const scale = Math.min(width / video.videoWidth, height / video.videoHeight);
          const drawnWidth = video.videoWidth * scale, drawnHeight = video.videoHeight * scale;
          context.drawImage(video, item.x * canvas.width + (width - drawnWidth) / 2,
            item.y * canvas.height + (height - drawnHeight) / 2, drawnWidth, drawnHeight);
          ++frames;
        }
        // This must remain AFTER every drawImage: UI overlays do not enter a
        // canvas capture, and marking a borrowed SDK track would affect the call.
        const painted = deps.watermark.paint(context, canvas.width, canvas.height);
        if (!painted || painted.revision !== approval.revision || painted.enabled !== approval.enabled ||
            painted.painted !== approval.enabled)
          throw error('RECORDING_WATERMARK_UNCONFIRMED', 'The frame watermark was not painted under the current policy');
        session.paintedRevision = painted.painted ? painted.revision : null;
        return frames;
      } catch (failure) {
        // Never leave just-drawn, unmarked meeting pixels on a capturing canvas
        // while stop/abort drains. These are our pixels, not borrowed media.
        context.save();
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.globalAlpha = 1;
        context.globalCompositeOperation = 'copy';
        context.fillStyle = '#000';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.restore();
        throw failure;
      }
    }
    function pump(session) {
      if (session.stopRequested || session.error) return;
      try {
        activeSnapshot(session);
        if (draw(session)) session.firstFrame.resolve();
        session.timer = setTimeout(() => pump(session), 1000 / session.options.frameRate);
      } catch (failure) { failSession(session, failure); }
    }
    function changed(session = current) {
      if (!session || session.finalized || session.stopRequested) return;
      try {
        const snapshot = deps.getState();
        if (!sameSession(session, snapshot)) { stopSession(session); return; }
        authorize(snapshot);
        session.watermark = ensureWatermark(session.options);
        if (!session.graphReady) return;
        const inputs = reconcile(session, snapshot);
        if (!inputs.audio.size && !inputs.video.length) stopSession(session);
        else if (session.options.video) draw(session);
      } catch (failure) { failSession(session, failure); }
    }
    function abortable(session, promise) { return Promise.race([promise, session.cancelled.promise]); }
    async function confirmedStatus(session, state, signal) {
      const result = await deps.reportStatus({ sessionKey: session.sessionKey, state, signal });
      if (!result || result.confirmed !== true)
        throw error('RECORDING_STATUS_UNCONFIRMED', 'The vendor did not confirm the actual recording status');
      session.statusReports[state] = { confirmed: true, scope: result.scope ?? null, sequence: result.sequence ?? null };
    }
    function chunk(session, blob) {
      if (!blob || !blob.size || session.error) return;
      session.pendingBytes += blob.size;
      if (session.pendingBytes > session.options.maxPendingBytes) {
        session.pendingBytes -= blob.size;
        failSession(session, error('RECORDING_BUFFER_LIMIT', 'Pending encoded media exceeds the configured output buffer limit'));
        return;
      }
      const sequence = session.sequence++;
      session.writes = session.writes.then(async () => {
        await session.writeGate.promise;
        if (session.error) throw session.error;
        const bytes = await blob.arrayBuffer();
        if (session.error) throw session.error;
        const written = await deps.sink.write(session.handle, bytes, { sequence, mimeType: session.mimeType });
        if (written !== bytes.byteLength) throw error('RECORDING_SHORT_WRITE', 'The sink did not confirm every encoded byte');
        session.bytes += written;
        ++session.chunks;
      }).finally(() => { session.pendingBytes -= blob.size; });
      session.writes.catch(failure => failSession(session, failure));
    }
    function failSession(session, failure) {
      if (session.finalized) {
        if (typeof deps.onError === 'function') deps.onError(failure);
        return;
      }
      addFailure(session, failure);
      session.started.reject(session.error);
      session.writeGate.reject(session.error);
      session.cancelled.reject(session.error);
      session.control.abort();
      stopSession(session);
    }
    function stopSession(session) {
      if (session.stopRequested) return session.done.promise;
      session.stopRequested = true;
      if (session.phase !== 'recording' && !session.error) {
        addFailure(session, error('RECORDING_CANCELLED', 'Recording was cancelled before start was confirmed'));
        session.started.reject(session.error);
        session.writeGate.reject(session.error);
        session.cancelled.reject(session.error);
        session.control.abort();
      }
      session.phase = 'stopping';
      releaseInputs(session);
      notify(session);
      if (session.recorder && session.recorder.state !== 'inactive') {
        try { session.recorder.stop(); }
        catch (failure) { addFailure(session, failure); session.ended.resolve(); }
      } else session.ended.resolve();
      finalize(session);
      return session.done.promise;
    }
    async function finalize(session) {
      if (session.finalizing) return;
      session.finalizing = true;
      let receipt = null;
      try {
        await session.preparing.catch(() => {});
        await session.ended.promise;
        try { await session.writes; } catch (failure) { addFailure(session, failure); }
        if (!session.error && !session.bytes) addFailure(session, error('EMPTY_RECORDING', 'MediaRecorder produced no written media'));
        if (session.handle !== undefined && session.handle !== null) {
          if (session.error) {
            try { await deps.sink.abort(session.handle, session.error); }
            catch (failure) { addFailure(session, failure); }
          } else {
            try {
              receipt = await deps.sink.close(session.handle);
              session.receipt = receipt ?? null;
              if (receipt === undefined || receipt === null)
                throw error('RECORDING_OUTPUT_UNCONFIRMED', 'The file sink did not return a committed-output receipt');
            }
            catch (failure) {
              addFailure(session, failure);
              try { await deps.sink.abort(session.handle, failure); } catch (cleanup) { addFailure(session, cleanup); }
            }
          }
        }
        if (session.reportAttempted) {
          // Serialize STOP after the actual START request; a late START ACK
          // must not re-enable the server's recording indication after STOP.
          try { await session.startReport; } catch (failure) { addFailure(session, failure); }
          try { await confirmedStatus(session, 'stopped'); }
          catch (failure) { addFailure(session, failure); }
        }
      } catch (failure) { addFailure(session, failure); }
      finally {
        releaseInputs(session);
        for (const track of session.ownedTracks) track.stop();
        if (session.audioContext) {
          try {
            if (session.audioContext.state !== 'closed') await session.audioContext.close();
          } catch (failure) { addFailure(session, failure); }
        }
        if (session.canvas) { session.canvas.width = 0; session.canvas.height = 0; }
        session.finalized = true;
        session.phase = session.error ? 'failed' : 'stopped';
        notify(session);
        if (session.error) {
          session.error.details = { ...session.error.details, mimeType: session.mimeType,
            bytesWritten: session.bytes, chunksWritten: session.chunks, receipt,
            cleanupErrors: session.cleanupErrors, statusReports: session.statusReports };
          session.done.reject(session.error);
          if (typeof deps.onError === 'function') deps.onError(session.error);
        } else session.done.resolve({ state: 'stopped', mimeType: session.mimeType,
          bytesWritten: session.bytes, chunksWritten: session.chunks, receipt, statusReports: session.statusReports });
      }
    }
    async function prepare(session) {
      const options = session.options;
      activeSnapshot(session);
      await abortable(session, deps.confirmStart(session.sessionKey, session.control.signal));
      activeSnapshot(session); // Authorization can change while the user decides.
      const opening = Promise.resolve(deps.sink.open({ mimeType: session.mimeType,
        extension: session.extension, signal: session.control.signal })).then(async handle => {
        if (handle === undefined || handle === null) throw error('RECORDING_CANCELLED', 'No recording file was selected');
        if (session.control.signal.aborted) {
          await deps.sink.abort(handle, session.error || error('RECORDING_CANCELLED', 'Recording was cancelled'));
          throw session.error || error('RECORDING_CANCELLED', 'Recording was cancelled');
        }
        session.handle = handle;
        return handle;
      });
      opening.catch(failure => { if (session.finalized && typeof deps.onError === 'function') deps.onError(failure); });
      await abortable(session, opening);
      let snapshot = activeSnapshot(session);
      const initial = readInputs(snapshot, options);
      if (options.audio && !initial.audio.size) throw error('RECORDING_AUDIO_UNAVAILABLE', 'No existing meeting audio track is available');
      if (options.video && !initial.video.some(item => item.visible))
        throw error('RECORDING_VIDEO_UNAVAILABLE', 'No existing visible meeting video is available');
      if (options.audio) {
        session.audioContext = new AudioContext();
        session.audioContext.addEventListener('statechange', () => {
          if (session.graphReady && !session.stopRequested && session.audioContext.state !== 'running')
            failSession(session, error('RECORDING_AUDIO_SUSPENDED', 'The real recording audio mixer stopped running'));
        });
        session.destination = session.audioContext.createMediaStreamDestination();
        for (const track of session.destination.stream.getTracks()) { session.ownedTracks.add(track); session.output.addTrack(track); }
        await abortable(session, session.audioContext.resume());
        if (session.audioContext.state !== 'running') throw error('RECORDING_AUDIO_SUSPENDED', 'The real audio mixer did not start');
      }
      if (options.video) {
        session.canvas = document.createElement('canvas');
        session.canvas.width = options.width; session.canvas.height = options.height;
        session.context = session.canvas.getContext('2d', { alpha: false });
        if (!session.context) throw error('CANVAS_UNAVAILABLE', 'The browser could not create the recording canvas');
        session.canvas.addEventListener('contextlost', () => {
          if (!session.stopRequested)
            failSession(session, error('RECORDING_WATERMARK_CONTEXT_LOST', 'The actual recording canvas lost its drawing context'));
        });
      }
      snapshot = activeSnapshot(session);
      reconcile(session, snapshot);
      session.graphReady = true;
      if (options.video) {
        pump(session);
        await abortable(session, session.firstFrame.promise);
        activeSnapshot(session);
        if (!draw(session)) throw error('RECORDING_VIDEO_UNAVAILABLE', 'No actual meeting video frame is ready');
        for (const track of session.canvas.captureStream(options.frameRate).getTracks()) {
          session.ownedTracks.add(track); session.output.addTrack(track);
        }
      }
      activeSnapshot(session);
      session.recorder = new MediaRecorder(session.output, { mimeType: session.mimeType });
      session.recorder.addEventListener('dataavailable', event => chunk(session, event.data));
      session.recorder.addEventListener('error', event => failSession(session, event.error || error('MEDIA_RECORDER_FAILED', 'The real recorder failed')));
      session.recorder.addEventListener('stop', () => {
        session.ended.resolve();
        if (!session.stopRequested) stopSession(session);
      });
      session.recorder.addEventListener('start', () => {
        if (session.stopRequested || session.error) return;
        try { activeSnapshot(session); }
        catch (failure) { failSession(session, failure); return; }
        const actualMimeType = session.recorder.mimeType;
        if (!actualMimeType || actualMimeType.split(';')[0] !== session.mimeType.split(';')[0]) {
          failSession(session, error('RECORDING_CONTAINER_CHANGED', 'The recorder did not retain the selected container'));
          return;
        }
        session.mimeType = actualMimeType;
        session.reportAttempted = true;
        session.startReport = confirmedStatus(session, 'recording', session.control.signal);
        session.startReport.then(() => {
          try {
            activeSnapshot(session);
            session.phase = 'recording';
            session.writeGate.resolve();
            session.started.resolve(summary(session));
            notify(session);
          } catch (failure) { failSession(session, failure); }
        }, failure => failSession(session, failure));
      }, { once: true });
      session.phase = 'starting';
      session.recorder.start(options.timeslice);
      notify(session);
    }
    function start(options = {}) {
      if (disposed) return Promise.reject(error('DISPOSED', 'The recording factory was disposed'));
      if (current && !current.finalized) return Promise.reject(error('RECORDING_ACTIVE', 'A recording is already active'));
      try {
        const snapshot = deps.getState();
        if (!snapshot || snapshot.joined !== true || typeof snapshot.sessionKey !== 'string' || !snapshot.sessionKey)
          throw error('NOT_IN_CONFERENCE', 'A genuine current meeting session is required');
        authorize(snapshot);
        if (options.audio !== undefined && typeof options.audio !== 'boolean' ||
            options.video !== undefined && typeof options.video !== 'boolean' ||
            options.mimeType !== undefined && typeof options.mimeType !== 'string')
          throw error('INVALID_RECORDING_OPTIONS', 'Audio/video choices must be boolean and MIME type must be a string');
        if (typeof window.MediaRecorder !== 'function' || typeof window.MediaStream !== 'function')
          throw error('RECORDING_BROWSER_API_UNAVAILABLE', 'The browser recording APIs are unavailable');
        const present = readInputs(snapshot, { audio: options.audio !== false, video: options.video !== false });
        const settings = { audio: options.audio === undefined ? present.audio.size > 0 : options.audio,
          video: options.video === undefined ? present.video.some(item => item.visible) : options.video,
          width: options.width === undefined ? 1280 : options.width, height: options.height === undefined ? 720 : options.height,
          frameRate: options.frameRate === undefined ? 15 : options.frameRate,
          timeslice: options.timeslice === undefined ? 1000 : options.timeslice,
          maxPendingBytes: options.maxPendingBytes === undefined ? 64 * 1024 * 1024 : options.maxPendingBytes };
        if (!settings.audio && !settings.video) throw error('NO_RECORDING_MEDIA', 'No selected existing meeting media is available');
        if (![settings.width, settings.height, settings.timeslice, settings.maxPendingBytes].every(value => Number.isSafeInteger(value) && value > 0) ||
            !Number.isFinite(settings.frameRate) || settings.frameRate <= 0)
          throw error('INVALID_RECORDING_OPTIONS', 'Recording dimensions, rate and buffer limits must be positive');
        const watermark = ensureWatermark(settings);
        if (settings.audio && typeof window.AudioContext !== 'function' ||
            settings.video && (typeof window.HTMLCanvasElement !== 'function' || typeof window.HTMLCanvasElement.prototype.captureStream !== 'function'))
          throw error('RECORDING_BROWSER_API_UNAVAILABLE', 'The requested browser recording APIs are unavailable');
        const types = settings.video ? settings.audio ? VIDEO_TYPES : ['video/webm;codecs=vp8', 'video/webm', 'video/mp4'] : AUDIO_TYPES;
        const mimeType = options.mimeType === undefined ? supportedTypes(types)[0] : supportedTypes([options.mimeType])[0];
        if (!mimeType) throw error('RECORDING_CODEC_UNAVAILABLE', 'The browser does not support the requested recording format');
        const baseType = mimeType.split(';')[0];
        const extension = { 'video/webm': 'webm', 'audio/webm': 'webm', 'video/mp4': 'mp4', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg' }[baseType] || null;
        const session = { sessionKey: snapshot.sessionKey, options: settings, mimeType, extension,
          phase: 'preparing', control: new AbortController(), started: deferred(), done: deferred(),
          cancelled: deferred(), writeGate: deferred(), ended: deferred(), firstFrame: deferred(), output: new MediaStream(),
          ownedTracks: new Set(), audioNodes: new Map(), videoNodes: new Map(), trackListeners: new Map(), layout: [],
          timer: null, audioContext: null, destination: null, canvas: null, context: null, recorder: null,
          handle: undefined, receipt: null, writes: Promise.resolve(), bytes: 0, chunks: 0, sequence: 0, pendingBytes: 0,
          statusReports: { recording: null, stopped: null },
          watermark, paintedRevision: null,
          error: null, cleanupErrors: [], graphReady: false, reportAttempted: false, startReport: null,
          stopRequested: false, finalizing: false, finalized: false, preparing: null };
        current = session;
        session.preparing = prepare(session);
        session.preparing.catch(failure => failSession(session, failure));
        notify(session);
        return session.started.promise;
      } catch (failure) { return Promise.reject(failure); }
    }
    function stop() {
      if (!current) return Promise.reject(error('NOT_RECORDING', 'No recording has been started'));
      if (current.finalized) return current.done.promise;
      return stopSession(current);
    }
    const unsubscribe = deps.subscribe(() => changed());
    if (typeof unsubscribe !== 'function') throw new TypeError('Recording subscribe must return an unsubscribe function');
    let unsubscribeWatermark;
    try {
      unsubscribeWatermark = deps.watermark.subscribe(() => changed());
      if (typeof unsubscribeWatermark !== 'function')
        throw new TypeError('Watermark subscribe must return an unsubscribe function');
    } catch (failure) { unsubscribe(); throw failure; }
    async function dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      unsubscribeWatermark();
      if (current && !current.finalized) await stopSession(current);
    }
    return Object.freeze({ start, stop, dispose, capabilities, state: () => summary() });
  };
})();
