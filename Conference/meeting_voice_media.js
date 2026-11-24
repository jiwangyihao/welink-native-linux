/* Trusted meeting MAIN-world adapter for the inspected HRTC 1.10.96 ABI.
 * No capture API, credentials, voiceprints, Node APIs or remote endpoints.
 *
 * Install before the vendor creates its first main stream:
 *   voice = __welinkInstallVoiceMedia({ host, getLocalStream, getClient });
 *   // In the existing SDK factory wrapper, for NON-SCREEN streams:
 *   return voice.guardStream(sdk.createStream(config));
 *   // In observeClient's publish wrapper, BEFORE invoking the SDK:
 *   voice.beforePublish(client, stream);
 *   // First in the store/connection-state pulse, and after selection changes:
 *   voice.pulse();
 * Await configure(false)/dispose() on revocation/account/window retirement;
 * do not put revocation behind a pending capture or native-processing promise.
 * An already-created selected stream is guarded by configure()/pulse(). A
 * post-publication observer alone cannot protect the first captured samples.
 *
 * host.voiceOpen() resolves only after native RDY1, with { id: opaqueString }.
 * host.voiceProcess(id, Float32Array(640)) resolves Float32Array(640): exactly
 * four 160-sample, normalized, mono, 16 kHz frames; at most one request in flight.
 * host.voiceClose(id) must revoke/kill pending work and acknowledge {closed:true}.
 * The host independently enforces the current account/window/session owner.
 *
 * Web Audio does the actual hardware-to-16kHz conversion. No sample-rate
 * relabelling, interpolation, ScriptProcessor fallback or raw bypass is used.
 * The static Blob worklet must be allowed by the page's existing CSP; a CSP,
 * sample-rate or autoplay failure mutes rather than weakening that policy.
 * Mixed/screen/custom audio is not filtered. A detected main-stream mixer
 * blocks the microphone without disabling its unrelated screen-audio track.
 * Mute/disable removes our processed track via the ordinary SDK path: the
 * vendor's next explicit Unmute captures again. configure(true) never does.
 */
(() => {
  'use strict';
  // The packaged offline renderer loads this same static file in its worklet;
  // no blob/eval CSP exception or second processor implementation is needed.
  if (typeof AudioWorkletProcessor === 'function' && typeof registerProcessor === 'function') {
    workletModule();
    return;
  }
  if (window.__welinkInstallVoiceMedia) return;
  const RATE = 16000;
  const BATCH = 640;
  const CONTROL_MS = 4000;
  const PROCESS_MS = 200;

  // Serialized static code, not code received from the host or a web page.
  function workletModule() {
    'use strict';
    class VoiceUplinkProcessor extends AudioWorkletProcessor {
      constructor() {
        super();
        this.input = new Float32Array(2560);
        this.output = new Float32Array(2560);
        this.packet = new Float32Array(640);
        this.inputRead = this.inputWrite = this.inputCount = 0;
        this.outputRead = this.outputWrite = this.outputCount = 0;
        this.sequence = 0;
        this.rendered = false;
        this.running = false;
        this.failed = false;
        this.stopped = false;
        this.port.onmessage = event => this.message(event.data);
        if (sampleRate !== 16000) this.fail('AUDIO_RATE_MISMATCH');
      }
      fail(code) {
        if (this.failed || this.stopped) return;
        this.failed = true;
        this.running = false;
        this.input.fill(0);
        this.output.fill(0);
        if (this.packet) this.packet.fill(0);
        this.inputCount = this.outputCount = 0;
        this.port.postMessage({ type: 'failed', code });
      }
      message(message) {
        if (!message || this.stopped || this.failed) return;
        if (message.type === 'stop') {
          this.running = false;
          this.stopped = true;
          this.input.fill(0);
          this.output.fill(0);
          if (this.packet) this.packet.fill(0);
          return;
        }
        if (message.type === 'start' && !this.running && this.sequence === 0) {
          this.running = true;
          return;
        }
        if (message.type !== 'processed' || !this.running || this.packet ||
            message.sequence !== this.sequence ||
            !(message.samples instanceof Float32Array) || message.samples.length !== 640 ||
            !(message.input instanceof Float32Array) || message.input.length !== 640 ||
            this.outputCount + 640 > this.output.length) {
          this.fail('AUDIO_QUEUE_INVALID');
          return;
        }
        for (let i = 0; i < 640; ++i) {
          const value = message.samples[i];
          if (!Number.isFinite(value) || Math.abs(value) > 1) {
            this.fail('AUDIO_RESULT_INVALID');
            return;
          }
          this.output[this.outputWrite] = value;
          this.outputWrite = (this.outputWrite + 1) % this.output.length;
        }
        this.outputCount += 640;
        this.packet = message.input;
        this.packet.fill(0);
        this.send();
      }
      send() {
        if (!this.running || !this.packet || this.inputCount < 640) return;
        const packet = this.packet;
        for (let i = 0; i < 640; ++i) {
          packet[i] = this.input[this.inputRead];
          this.input[this.inputRead] = 0;
          this.inputRead = (this.inputRead + 1) % this.input.length;
        }
        this.inputCount -= 640;
        this.packet = null;
        this.port.postMessage({ type: 'process', sequence: ++this.sequence, input: packet }, [packet.buffer]);
      }
      process(inputs, outputs) {
        const target = outputs[0] && outputs[0][0];
        if (target) target.fill(0); // Underrun/startup/failure is always silence.
        if (this.stopped) return false;
        if (!this.running || this.failed || !target) return true;
        const source = inputs[0] && inputs[0][0];
        if (!source || source.length !== target.length || inputs[0].length !== 1) {
          this.fail('AUDIO_INPUT_LOST');
          return true;
        }
        if (this.inputCount + source.length > this.input.length) {
          this.fail('AUDIO_QUEUE_OVERFLOW');
          return true;
        }
        const firstOutput = !this.rendered && this.outputCount > 0;
        for (let i = 0; i < source.length; ++i) {
          const value = source[i];
          if (!Number.isFinite(value)) {
            this.fail('AUDIO_INPUT_INVALID');
            target.fill(0);
            return true;
          }
          this.input[this.inputWrite] = Math.max(-1, Math.min(1, value));
          this.inputWrite = (this.inputWrite + 1) % this.input.length;
          if (this.outputCount) {
            target[i] = this.output[this.outputRead];
            this.output[this.outputRead] = 0;
            this.outputRead = (this.outputRead + 1) % this.output.length;
            --this.outputCount;
          }
        }
        // A processed sample, including intentional silence, has reached the
        // output bus. Neither native open nor merely filling the queue proves this.
        if (firstOutput) {
          this.rendered = true;
          this.port.postMessage({ type: 'rendered' });
        }
        this.inputCount += source.length;
        this.send();
        return true;
      }
    }
    registerProcessor('welink-private-voice-uplink', VoiceUplinkProcessor);
  }

  window.__welinkInstallVoiceMedia = function installVoiceMedia({ host, getLocalStream, getClient } = {}) {
    for (const name of ['voiceOpen', 'voiceProcess', 'voiceClose']) {
      if (!host || typeof host[name] !== 'function') throw new TypeError('Missing voice host method: ' + name);
    }
    if (typeof getLocalStream !== 'function' || typeof getClient !== 'function')
      throw new TypeError('Voice media requires genuine HRTC owner accessors');

    const guards = new Map();
    let requested = false, disposed = false, owner = null, ownerBound = false;
    let unavailable = false;
    let current = null, opening = null, closing = null, failure = null;
    let heartbeat = null, disposal = null, configurationEpoch = 0;

    function fault(code) {
      return Object.assign(new Error('Private microphone protection: ' + code), { code });
    }
    function bounded(promise, milliseconds, code) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(fault(code)), milliseconds);
        Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); },
          error => { clearTimeout(timer); reject(error); });
      });
    }
    function selected(guard) {
      return !disposed && getLocalStream() === guard.stream && getClient() === owner;
    }
    function live(track) { return !!track && track.kind === 'audio' && track.readyState === 'live'; }
    function trackOf(guard) { return guard.original.getAudioTrack.call(guard.stream); }
    function sdkMuted(guard) {
      const track = guard.stream.getAudioHRTCTrack();
      if (!track || typeof track.getTrackMuted !== 'function') throw fault('SDK_AUDIO_STATE_UNAVAILABLE');
      const muted = track.getTrackMuted();
      if (typeof muted !== 'boolean') throw fault('SDK_AUDIO_STATE_UNAVAILABLE');
      return muted;
    }
    function plainTrack(guard) {
      const track = trackOf(guard);
      const published = guard.original.getPublishAudioTrack.call(guard.stream);
      if (published && published !== track) throw fault('MIXED_AUDIO_UNSUPPORTED');
      if (guard.stream.audioSource_) throw fault('CUSTOM_AUDIO_UNSUPPORTED');
      return track;
    }
    function mute(guard) {
      // Only the selected/previously-owned main microphone, never a mixer or
      // a camera/auxiliary sender. The ordinary SDK propagates its mute state.
      try {
        const track = trackOf(guard);
        if (track && track.kind === 'audio') track.enabled = false;
      } catch (_) { /* Still attempt the independent ordinary SDK mute. */ }
      try { guard.original.muteAudio.call(guard.stream); } catch (_) { /* Retire stops our owned tracks too. */ }
    }
    function snapshot() {
      const processing = !!(requested && !failure && current && current.ready && current.rendered && !current.stopped);
      return { enabled: requested, armed: requested && !disposed && !failure, processing, protected: processing,
        stopped: (!current || current.stopped) && !opening && !closing,
        state: disposed ? 'disposed' : failure ? 'blocked' : current && !current.stopped ?
          processing ? 'protected' : 'preparing' : requested ? 'armed' : 'disabled',
        reason: failure, sampleRate: RATE, batchSamples: BATCH };
    }
    function closeNative(entry) {
      if (entry.invalidOpen) return Promise.reject(fault('VOICE_OPEN_INVALID'));
      if (!entry.id) return Promise.resolve({ closed: !entry.openPending });
      if (entry.nativeClose) return entry.nativeClose;
      let operation;
      try { operation = Promise.resolve(host.voiceClose(entry.id)); }
      catch (error) { operation = Promise.reject(error); }
      closing = operation;
      operation.then(result => {
        if (result && result.closed === true && closing === operation) closing = null;
      }, () => {});
      entry.nativeClose = bounded(operation, CONTROL_MS, 'VOICE_CLOSE_TIMEOUT').then(result => {
        if (!result || result.closed !== true) throw fault('VOICE_CLOSE_UNCONFIRMED');
        return { closed: true };
      });
      entry.nativeClose.catch(() => { failure = 'VOICE_CLOSE_UNCONFIRMED'; });
      return entry.nativeClose;
    }
    async function revokeNative(entry) {
      if (entry.openPending) {
        // A late successful Open still owns a native process. Never acknowledge
        // Stop merely because the page has not received its handle yet.
        await bounded(entry.openOperation.catch(() => {}), CONTROL_MS, 'VOICE_REVOKE_TIMEOUT');
      }
      return closeNative(entry);
    }
    function retire(entry, reason, remove = true, preserveMuteState = false) {
      if (!entry) return Promise.resolve({ closed: !opening && !closing });
      if (entry.cleanup) return entry.cleanup;
      entry.stopped = true;
      entry.ready = false;
      ++entry.guard.epoch;
      if (!preserveMuteState) {
        entry.guard.hold = true;
        mute(entry.guard);
      }
      for (const [track, type, listener] of entry.listeners) track.removeEventListener(type, listener);
      entry.listeners.length = 0;
      if (entry.source) { entry.source.enabled = false; entry.source.stop(); }
      // stop(), rather than enabled=false, preserves the SDK's existing device
      // switch intent when it copies the ended track's enabled flag to capture.
      if (entry.output) entry.output.stop();
      if (entry.node) {
        entry.node.port.onmessage = null;
        entry.node.onprocessorerror = null;
        try { entry.node.port.postMessage({ type: 'stop' }); } catch (_) { /* detached */ }
        entry.node.port.close();
        entry.node.disconnect();
      }
      if (entry.input) entry.input.disconnect();
      if (entry.context) entry.context.onstatechange = null;
      let removal = Promise.resolve();
      if (remove && selected(entry.guard)) {
        const track = trackOf(entry.guard);
        if (track && (track === entry.output || track === entry.raw)) {
          // removeTrack removes the audio track synchronously before its SDK
          // publication promise settles; no raw track is ever reinserted.
          try { removal = Promise.resolve(entry.guard.original.removeTrack.call(entry.guard.stream, track)); }
          catch (error) { removal = Promise.reject(error); }
        }
      }
      let contextClose = Promise.resolve();
      if (entry.context && entry.context.state !== 'closed') {
        try { contextClose = entry.context.close(); }
        catch (error) { contextClose = Promise.reject(error); }
      }
      entry.cleanup = Promise.all([
        bounded(removal, CONTROL_MS, 'SDK_AUDIO_REMOVE_TIMEOUT'),
        bounded(contextClose, CONTROL_MS, 'AUDIO_CONTEXT_CLOSE_TIMEOUT'),
        revokeNative(entry)
      ]).then(results => ({ closed: results[2].closed, reason }));
      entry.cleanup.catch(() => { failure = 'VOICE_CLEANUP_UNCONFIRMED'; });
      return entry.cleanup;
    }
    function block(guard, code) {
      failure = code;
      if (guard) { guard.hold = true; mute(guard); }
      if (current && !current.stopped) retire(current, code).catch(() => {});
      return fault(code);
    }
    function check(entry) {
      if (entry.stopped || !requested || failure || !selected(entry.guard) ||
          !owner || owner.getConnectionState() !== 'CONNECTED') throw fault('VOICE_OWNER_CHANGED');
      if (entry.guard.capture && entry.guard.capture.epoch !== entry.guard.epoch)
        throw fault('MICROPHONE_CAPTURE_CANCELLED');
      const track = plainTrack(entry.guard);
      if (track !== entry.raw && track !== entry.output) throw fault('MICROPHONE_REPLACED');
      if (!live(entry.source) || !entry.source.enabled || entry.source.muted)
        throw fault('MICROPHONE_SOURCE_UNAVAILABLE');
      if (entry.installed && (!live(entry.output) || !entry.output.enabled || sdkMuted(entry.guard)))
        throw fault('MICROPHONE_MUTED');
    }
    function listen(entry, track, type) {
      const listener = () => block(entry.guard, type === 'mute' ? 'MICROPHONE_SOURCE_MUTED' : 'MICROPHONE_ENDED');
      track.addEventListener(type, listener);
      entry.listeners.push([track, type, listener]);
    }
    async function process(entry, message) {
      if (entry.stopped) return;
      if (!message || message.type !== 'process' || entry.processing ||
          !(message.input instanceof Float32Array) || message.input.length !== BATCH ||
          message.input.byteLength !== BATCH * 4 || message.sequence !== entry.sequence + 1)
        throw fault('AUDIO_QUEUE_INVALID');
      check(entry);
      for (const value of message.input) if (!Number.isFinite(value) || Math.abs(value) > 1)
        throw fault('AUDIO_INPUT_INVALID');
      entry.processing = true;
      entry.sequence = message.sequence;
      try {
        const result = await bounded(host.voiceProcess(entry.id, message.input), PROCESS_MS, 'VOICE_PROCESS_TIMEOUT');
        if (entry.stopped) return;
        check(entry);
        if (!(result instanceof Float32Array) || result.length !== BATCH || result.byteLength !== BATCH * 4)
          throw fault('VOICE_RESULT_INVALID');
        for (const value of result) if (!Number.isFinite(value) || Math.abs(value) > 1)
          throw fault('VOICE_RESULT_INVALID');
        const samples = result.byteOffset === 0 && result.buffer.byteLength === BATCH * 4 ? result : result.slice();
        const transfer = samples.buffer === message.input.buffer ? [samples.buffer] : [samples.buffer, message.input.buffer];
        entry.node.port.postMessage({ type: 'processed', sequence: message.sequence,
          samples, input: message.input }, transfer);
      } finally {
        entry.processing = false;
        if (message.input.buffer.byteLength) message.input.fill(0);
      }
    }
    async function start(entry) {
      try {
        if (entry.previousCleanup) await entry.previousCleanup;
        check(entry);
        if (opening || closing) throw fault('VOICE_HOST_BUSY');
        const AudioContextClass = window.AudioContext;
        if (typeof AudioContextClass !== 'function' || typeof window.AudioWorkletNode !== 'function')
          throw fault('AUDIO_WORKLET_UNAVAILABLE');
        entry.context = new AudioContextClass({ sampleRate: RATE, latencyHint: 'interactive' });
        if (entry.context.sampleRate !== RATE || !entry.context.audioWorklet) throw fault('AUDIO_RATE_UNAVAILABLE');
        const packaged = window.location?.protocol === 'file:' &&
          window.location.pathname.endsWith('/meeting_offline.html');
        const url = packaged ? new URL('meeting_voice_media.js', window.location.href).href :
          URL.createObjectURL(new Blob(['(', workletModule.toString(), ')();'], { type: 'text/javascript' }));
        try { await bounded(entry.context.audioWorklet.addModule(url), CONTROL_MS, 'AUDIO_WORKLET_LOAD_TIMEOUT'); }
        finally { if (!packaged) URL.revokeObjectURL(url); }
        check(entry);
        entry.node = new AudioWorkletNode(entry.context, 'welink-private-voice-uplink', {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
          channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers'
        });
        entry.node.port.onmessage = event => {
          if (entry.stopped || current !== entry) return;
          if (event.data?.type === 'rendered') {
            if (entry.ready) entry.rendered = true;
            return;
          }
          if (event.data && event.data.type === 'failed') {
            block(entry.guard, 'AUDIO_WORKLET_FAILED');
            return;
          }
          process(entry, event.data).catch(error => {
            if (!entry.stopped) block(entry.guard, error.code || 'VOICE_PROCESS_FAILED');
          });
        };
        entry.node.onprocessorerror = () => block(entry.guard, 'AUDIO_WORKLET_FAILED');
        entry.input = entry.context.createMediaStreamSource(new MediaStream([entry.source]));
        const destination = entry.context.createMediaStreamDestination();
        destination.channelCount = 1;
        entry.output = destination.stream.getAudioTracks()[0];
        if (!live(entry.output)) throw fault('PROCESSED_TRACK_UNAVAILABLE');
        entry.output.enabled = false;
        entry.input.connect(entry.node);
        entry.node.connect(destination); // Never connected to the speaker destination.
        entry.openPending = true;
        const open = Promise.resolve().then(() => host.voiceOpen());
        entry.openOperation = open;
        opening = open;
        open.then(result => {
          entry.openPending = false;
          if (result && typeof result.id === 'string' && result.id.length && result.id.length <= 128) {
            if (opening === open) opening = null;
            entry.id = result.id;
            if (entry.stopped) closeNative(entry).catch(() => {});
          } else entry.invalidOpen = true;
        }, () => { entry.openPending = false; if (opening === open) opening = null; });
        const opened = await bounded(open, CONTROL_MS, 'VOICE_OPEN_TIMEOUT');
        if (!opened || !entry.id) throw fault('VOICE_OPEN_INVALID');
        check(entry);
        await bounded(entry.context.resume(), CONTROL_MS, 'AUDIO_CONTEXT_RESUME_TIMEOUT');
        check(entry);
        if (entry.context.state !== 'running') throw fault('AUDIO_CONTEXT_SUSPENDED');
        // A live clone is mandatory: HRTC DP.replaceTrack stops its old local
        // track. Only a processed, initially disabled track enters the SDK.
        entry.replacing = true;
        await bounded(entry.guard.original.replaceTrack.call(entry.guard.stream, entry.output, 'audio'),
          CONTROL_MS, 'SDK_AUDIO_REPLACE_TIMEOUT');
        entry.replacing = false;
        check(entry);
        if (trackOf(entry.guard) !== entry.output) throw fault('SDK_AUDIO_REPLACE_UNCONFIRMED');
        // This restores only the processed track's pre-existing user intent.
        // The source clone was enabled before gating, or by explicit Unmute.
        if (entry.explicitUnmute) {
          if (entry.guard.original.unmuteAudio.call(entry.guard.stream) !== true)
            throw fault('SDK_AUDIO_UNMUTE_FAILED');
        } else {
          if (sdkMuted(entry.guard)) throw fault('MICROPHONE_MUTED');
          entry.output.enabled = true;
        }
        entry.installed = true;
        check(entry);
        entry.ready = true;
        listen(entry, entry.output, 'ended');
        entry.context.onstatechange = () => {
          if (!entry.stopped && entry.ready && entry.context.state !== 'running')
            block(entry.guard, 'AUDIO_CONTEXT_STOPPED');
        };
        entry.node.port.postMessage({ type: 'start' });
        return snapshot();
      } catch (error) {
        entry.replacing = false;
        if (!entry.stopped) block(entry.guard, error.code || 'VOICE_START_FAILED');
        throw error;
      }
    }
    function ensure(guard, explicitUnmute = false) {
      if (!requested || disposed) return null;
      if (!selected(guard)) throw block(guard, 'VOICE_OWNER_CHANGED');
      guard.owned = true;
      if (guard.capture && guard.capture.epoch !== guard.epoch)
        throw block(guard, 'MICROPHONE_CAPTURE_CANCELLED');
      if (failure) throw block(guard, failure);
      const raw = plainTrack(guard);
      if (guard.hold && !explicitUnmute) { mute(guard); return null; }
      if (current && !current.stopped) {
        if (current.guard !== guard || (raw !== current.raw && raw !== current.output))
          throw block(guard, 'MICROPHONE_REPLACED');
        return current;
      }
      if (!raw) return null;
      if (!live(raw) || raw.muted !== false || typeof raw.enabled !== 'boolean' ||
          (!explicitUnmute && (!raw.enabled || sdkMuted(guard)))) {
        // Browser mute can clear without an owner action. Latch a real SDK/
        // track mute before publication; a later pulse must not release raw.
        guard.hold = true;
        mute(guard);
        return null;
      }
      if (!owner || owner.getConnectionState() !== 'CONNECTED') {
        mute(guard);
        throw block(guard, 'VOICE_SESSION_NOT_CONNECTED');
      }
      const source = raw.clone();
      if (explicitUnmute) source.enabled = true; // Only the genuine owner's Unmute call permits this.
      raw.enabled = false; // Before the first await and before SDK publication.
      const entry = { guard, raw, source, output: null, context: null, node: null, input: null,
        id: null, openPending: false, sequence: 0, processing: false, ready: false, rendered: false,
        stopped: false, installed: false, replacing: false, explicitUnmute, listeners: [],
        previousCleanup: current && current.stopped ? current.cleanup : null };
      current = entry;
      listen(entry, source, 'ended');
      listen(entry, source, 'mute');
      entry.start = start(entry);
      entry.start.catch(() => {});
      return entry;
    }
    function protect(guard) {
      try { return ensure(guard); }
      catch (error) { throw block(guard, error.code || 'VOICE_GUARD_FAILED'); }
    }
    function guardStream(stream) {
      if (!stream || typeof stream.isAuxiliary !== 'function' || typeof stream.getType !== 'function')
        throw fault('SDK_STREAM_ABI_MISMATCH');
      if (stream.isAuxiliary() || stream.screen_ || stream.getType() !== 'local') return stream;
      if (guards.has(stream)) return stream;
      const names = ['getAudioTrack', 'getPublishAudioTrack', 'replaceTrack', 'initialize',
        'addAudioTrackCapture', 'switchDevice', 'muteAudio', 'unmuteAudio', 'removeTrack', 'close'];
      for (const name of names) if (typeof stream[name] !== 'function') throw fault('SDK_STREAM_ABI_MISMATCH');
      if (typeof stream.getAudioHRTCTrack !== 'function') throw fault('SDK_STREAM_ABI_MISMATCH');
      const guard = { stream, original: {}, descriptors: {}, wrappers: {}, epoch: 0, capture: null,
        hold: false, owned: false };
      for (const name of names) {
        guard.original[name] = stream[name];
        guard.descriptors[name] = Object.getOwnPropertyDescriptor(stream, name);
      }
      function patch(name, wrapper) {
        Object.defineProperty(stream, name, { configurable: true, writable: true, value: wrapper });
        guard.wrappers[name] = wrapper;
      }
      function capture(name, isAudio) {
        patch(name, async function (...args) {
          if (!isAudio(args)) return guard.original[name].apply(this, args);
          if (unavailable && (name !== 'initialize' || stream.audio_ || stream.audioSource_))
            throw block(guard, 'PNR_FILTER_CONTROLS_UNAVAILABLE');
          if (guard.owned && getLocalStream() !== stream) throw block(guard, 'VOICE_OWNER_CHANGED');
          if (!requested || disposed || getLocalStream() !== stream && name !== 'initialize')
            return guard.original[name].apply(this, args);
          if (guard.capture) throw block(guard, 'MICROPHONE_OPERATION_IN_PROGRESS');
          const pending = name === 'switchDevice' && current && !current.stopped && current.guard === guard ?
            retire(current, 'MICROPHONE_DEVICE_SWITCH', false, true) : Promise.resolve();
          const token = { epoch: guard.epoch, method: name, invoking: false };
          token.done = new Promise((resolve, reject) => { token.resolve = resolve; token.reject = reject; });
          token.done.catch(() => {});
          guard.capture = token;
          try {
            await pending;
            if (token.epoch !== guard.epoch || disposed || !requested) throw fault('MICROPHONE_CAPTURE_CANCELLED');
            let operation;
            token.invoking = true;
            try { operation = guard.original[name].apply(this, args); }
            finally { token.invoking = false; }
            const value = await operation;
            if (token.epoch !== guard.epoch) throw fault('MICROPHONE_CAPTURE_CANCELLED');
            if (getLocalStream() === stream) {
              const entry = protect(guard);
              if (entry) await entry.start;
            }
            return value;
          } catch (error) {
            if (requested && !disposed) block(guard, error.code || 'MICROPHONE_CAPTURE_FAILED');
            throw error;
          } finally {
            try {
              if (token.epoch !== guard.epoch || disposed || !requested) {
                guard.hold = true;
                mute(guard);
                const track = trackOf(guard);
                if (track) {
                  track.stop();
                  if (getLocalStream() === stream && getClient() === owner && !disposed) {
                    await bounded(guard.original.removeTrack.call(stream, track), CONTROL_MS,
                      'SDK_AUDIO_REMOVE_TIMEOUT');
                  } else guard.original.close.call(stream, { audio: true, video: false });
                }
              }
              token.resolve();
            } catch (error) {
              failure = 'MICROPHONE_CAPTURE_CLEANUP_FAILED';
              token.reject(error);
              throw error;
            } finally {
              if (guard.capture === token) guard.capture = null;
              if (disposed) restore(guard);
            }
          }
        });
      }
      try {
        patch('getPublishAudioTrack', function () {
          if (unavailable) { guard.hold = true; mute(guard); return null; }
          if (guard.hold) mute(guard);
          else if (requested && !disposed && (getLocalStream() === stream || guard.owned)) protect(guard);
          return guard.original.getPublishAudioTrack.call(this);
        });
        capture('initialize', () => true);
        capture('addAudioTrackCapture', () => true);
        capture('switchDevice', args => args[0] === 'audio');
        patch('muteAudio', function (...args) {
          ++guard.epoch;
          if (requested || guard.owned) guard.hold = true;
          if (current && current.guard === guard && !current.stopped)
            retire(current, 'MICROPHONE_MUTED').catch(() => {});
          return guard.original.muteAudio.apply(this, args);
        });
        patch('unmuteAudio', function (...args) {
          if (disposed || guard.owned && getLocalStream() !== stream) return false;
          if (unavailable) return Promise.reject(block(guard, 'PNR_FILTER_CONTROLS_UNAVAILABLE'));
          if (!requested || getLocalStream() !== stream) {
            guard.hold = false; // An explicit owner Unmute, never configure(false).
            return guard.original.unmuteAudio.apply(this, args);
          }
          if (failure) return Promise.reject(fault(failure));
          try {
            guard.hold = false;
            const entry = ensure(guard, true);
            if (!entry) return false;
            if (entry.ready) return guard.original.unmuteAudio.apply(this, args);
            // The inspected app awaits this method via its asynchronous
            // sdkWrapper. Do not report unmute success before protection exists.
            return entry.start.then(() => {
              check(entry);
              return guard.original.unmuteAudio.apply(stream, args);
            });
          } catch (error) { return Promise.reject(block(guard, error.code || 'VOICE_UNMUTE_FAILED')); }
        });
        patch('removeTrack', function (track, ...args) {
          if (guard.capture && guard.capture.method === 'initialize' && guard.capture.invoking)
            return guard.original.removeTrack.call(this, track, ...args);
          if (track && track.kind === 'audio') {
            ++guard.epoch;
            if (requested || guard.owned) guard.hold = true;
            if (current && current.guard === guard && !current.stopped)
              retire(current, 'MICROPHONE_REMOVED', false).catch(() => {});
          }
          return guard.original.removeTrack.call(this, track, ...args);
        });
        patch('close', function (options) {
          // initializeImpl starts reset()->close() synchronously. That SDK
          // housekeeping is not a user cancellation of the ensuing capture.
          // Once initialize yields, a genuine Close cancels the token normally.
          if (guard.capture && guard.capture.method === 'initialize' && guard.capture.invoking)
            return guard.original.close.apply(this, arguments);
          if (!options || options.audio !== false) {
            ++guard.epoch;
            if (requested || guard.owned) guard.hold = true;
            if (current && current.guard === guard && !current.stopped)
              retire(current, 'MICROPHONE_CLOSED', false).catch(() => {});
          }
          return guard.original.close.apply(this, arguments);
        });
        guards.set(stream, guard);
      } catch (error) {
        restore(guard);
        throw error;
      }
      return stream;
    }
    function restore(guard) {
      for (const [name, wrapper] of Object.entries(guard.wrappers)) {
        if (guard.stream[name] !== wrapper) continue;
        if (guard.descriptors[name]) Object.defineProperty(guard.stream, name, guard.descriptors[name]);
        else delete guard.stream[name];
      }
      guards.delete(guard.stream);
    }
    function beforePublish(client, stream) {
      if (!stream || stream.isAuxiliary() || stream.screen_) return;
      const held = guards.get(stream);
      if (held && held.hold) mute(held);
      if (!requested || disposed) return;
      if (client !== getClient() || stream !== getLocalStream()) throw fault('UNSELECTED_MAIN_STREAM');
      guardStream(stream);
      const guard = guards.get(stream);
      if (!guard) throw fault('SDK_STREAM_ABI_MISMATCH');
      if (!ownerBound) { owner = client; ownerBound = true; }
      // HRTC removeTrack republishes the now audio-less main stream. During
      // fail-closed teardown that is the acknowledgement we must await, not a
      // request to restart a failed filter. Both real SDK audio getters must
      // be empty; an ended/muted raw track or a live mixer never qualifies.
      if (current?.stopped && current.guard === guard && !trackOf(guard) &&
          !guard.original.getPublishAudioTrack.call(stream)) return;
      if (unavailable) { guard.hold = true; mute(guard); return; }
      protect(guard); // Synchronous raw-track gate; never waits on nested SDK publish.
    }
    function pulse() {
      if (disposed) return snapshot();
      try {
        const client = getClient();
        const stream = getLocalStream();
        if (requested && client && !ownerBound) { owner = client; ownerBound = true; }
        if (requested && ownerBound && client !== owner) {
          if (current && !current.stopped) retire(current, 'VOICE_OWNER_CHANGED', false).catch(() => {});
          failure = 'VOICE_OWNER_CHANGED';
        }
        if (current && !current.stopped && (stream !== current.guard.stream || client !== owner))
          retire(current, 'VOICE_OWNER_CHANGED', false).catch(() => {});
        if (stream) {
          guardStream(stream);
          const guard = guards.get(stream);
          if (!guard) { if (requested) failure = 'MAIN_MICROPHONE_UNAVAILABLE'; return snapshot(); }
          if (requested) guard.owned = true;
          if (unavailable) { guard.hold = true; mute(guard); return snapshot(); }
          for (const [name, wrapper] of Object.entries(guard.wrappers))
            if (stream[name] !== wrapper) throw block(guard, 'VOICE_HOOK_REPLACED');
          if (requested) {
            if (current && !current.stopped && current.installed &&
                (!current.output.enabled || sdkMuted(guard))) {
              retire(current, 'MICROPHONE_MUTED').catch(() => {});
            } else if (current && !current.stopped) check(current);
            else if (!guard.capture) protect(guard);
          }
        }
      } catch (error) {
        failure = error.code || 'VOICE_STATE_UNAVAILABLE';
        if (current && !current.stopped) retire(current, failure).catch(() => {});
      }
      return snapshot();
    }
    async function configure(enabled, filterUnavailable = false) {
      if (typeof enabled !== 'boolean') throw new TypeError('Voice media enabled must be boolean');
      if (disposed) throw fault('VOICE_MEDIA_DISPOSED');
      const revision = ++configurationEpoch;
      requested = enabled;
      unavailable = enabled && filterUnavailable === true;
      if (!enabled) {
        clearInterval(heartbeat);
        heartbeat = null;
        const captures = [];
        for (const guard of guards.values()) {
          ++guard.epoch;
          if (guard.capture) captures.push(bounded(guard.capture.done, CONTROL_MS, 'MICROPHONE_CAPTURE_STOP_TIMEOUT'));
          if (guard.owned || guard.capture) { guard.hold = true; mute(guard); }
        }
        const [stopped] = await Promise.all([retire(current, 'VOICE_DISABLED'), ...captures]);
        if (revision !== configurationEpoch) throw fault('VOICE_CONFIGURATION_SUPERSEDED');
        if (!stopped.closed || opening || closing) throw fault('VOICE_STOP_UNCONFIRMED');
        failure = null;
        return { ...snapshot(), enabled: false, stopped: true, closed: true };
      }
      if (unavailable) {
        failure = 'PNR_FILTER_CONTROLS_UNAVAILABLE';
        for (const guard of guards.values()) { ++guard.epoch; guard.hold = true; mute(guard); }
        pulse();
        await retire(current, failure);
        if (revision !== configurationEpoch) throw fault('VOICE_CONFIGURATION_SUPERSEDED');
        return snapshot();
      }
      if (current && current.stopped) await current.cleanup;
      if (revision !== configurationEpoch) throw fault('VOICE_CONFIGURATION_SUPERSEDED');
      if (opening || closing) throw fault('VOICE_HOST_BUSY');
      owner = getClient();
      ownerBound = !!owner;
      failure = null;
      if (!heartbeat) heartbeat = setInterval(pulse, 100);
      pulse();
      if (failure) throw fault(failure);
      if (current && !current.stopped) await current.start;
      if (revision !== configurationEpoch) throw fault('VOICE_CONFIGURATION_SUPERSEDED');
      return snapshot();
    }
    function dispose() {
      if (disposal) return disposal;
      ++configurationEpoch;
      requested = false;
      clearInterval(heartbeat);
      heartbeat = null;
      // Gate/remove while selected() still recognizes this owner.
      const stopped = retire(current, 'VOICE_MEDIA_DISPOSED');
      disposed = true;
      const captures = [];
      for (const guard of guards.values()) {
        ++guard.epoch;
        if (guard.capture) captures.push(bounded(guard.capture.done, CONTROL_MS, 'MICROPHONE_CAPTURE_STOP_TIMEOUT'));
        if (guard.owned || guard.capture) { guard.hold = true; mute(guard); }
        // Retain a mute-only guard until a pending real SDK capture settles.
        if (!guard.capture) restore(guard);
      }
      disposal = Promise.all([stopped, ...captures]).then(([result]) => {
        if (!result.closed || opening || closing) throw fault('VOICE_STOP_UNCONFIRMED');
        return { ...snapshot(), enabled: false, stopped: true, closed: true };
      });
      return disposal;
    }
    return Object.freeze({ configure, pulse, dispose, guardStream, beforePublish, state: snapshot });
  };
})();
