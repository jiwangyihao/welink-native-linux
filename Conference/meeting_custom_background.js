/* Genuine outgoing-camera segmentation, pinned to HRTC 1.10.96. No capture,
 * unmute, remote image, persistent history, credentials or consent API exists
 * here. MediaPipe uses only integrity-checked local assets supplied by main.
 * Import/configuration receipts are deliberately distinct from RTP frame proof.
 */
(() => {
  'use strict';
  const fault = (code, message = code) => Object.assign(new Error(message), { code });
  const live = track => track?.kind === 'video' && track.readyState === 'live';
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  function bounded(promise, ms, code) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(fault(code)), ms); })])
      .finally(() => clearTimeout(timer));
  }
  function bytes(base64) {
    const text = atob(base64), result = new Uint8Array(text.length);
    for (let i = 0; i < text.length; ++i) result[i] = text.charCodeAt(i);
    return result;
  }
  function cover(ctx, image, width, height) {
    const scale = Math.max(width / image.width, height / image.height);
    const w = image.width * scale, h = image.height * scale;
    ctx.drawImage(image, (width - w) / 2, (height - h) / 2, w, h);
  }
  function canvas(width, height) {
    const result = document.createElement('canvas'); result.width = width; result.height = height;
    return result;
  }
  window.__welinkInstallCustomBackground = function ({ host, getContext, getLocalStream, getClient, changed = () => {} }) {
    let enabled = false, configured = false, disposed = false, revision = 0;
    let image = null, receipt = null, current = null, loading = null, assetUrls = null, library = null;
    let busy = null, lastError = null, timer = null;
    const guards = new Map();
    function context() { return getContext(); }
    function permission(cameraRequired = false) {
      const c = context();
      if (disposed) return { ...c, reason: 'BACKGROUND_DISPOSED' };
      if (!enabled) return { ...c, reason: 'NATIVE_CAPABILITY_DISABLED' };
      if (!c.joined || !c.sessionKey) return { ...c, reason: 'NOT_IN_CONFERENCE' };
      if (!c.provider.allowed) return { ...c, reason: c.provider.reason };
      if (cameraRequired && !c.cameraAllowed) return { ...c, reason: 'BACKGROUND_CAMERA_NOT_PERMITTED' };
      if (cameraRequired && !c.cameraOpen) return { ...c, reason: 'BACKGROUND_CAMERA_CLOSED' };
      return { ...c, reason: null };
    }
    function requirePermission(cameraRequired) {
      const c = permission(cameraRequired);
      if (c.reason) throw fault(c.reason, c.provider?.prerequisite || 'Use the ordinary provider controls to permit and open the camera first');
      return c;
    }
    function state() {
      const c = permission(), entry = current;
      const activeFrames = !!entry && !entry.stopped && entry.installed && entry.rtpFrames > 0 &&
        performance.now() - entry.lastRtpAt < 3000 && !permission(true).reason;
      return { supported: true, configured, enabled, revision, sessionKey: c.sessionKey || null,
        scope: 'current-meeting-local-camera', provider: 'local-mediapipe-selfie-segmentation-0.1.1675465747',
        providerPolicy: c.provider, reason: c.reason || lastError,
        prerequisite: c.provider?.prerequisite || (c.reason ? 'A policy-authorized connected meeting is required' : null),
        ui: { importAvailable: !c.reason && !busy, applyAvailable: !permission(true).reason && !!image && !busy,
          clearAvailable: !!image || !!entry, localFilesOnly: true },
        imported: receipt ? { ...receipt } : null, activeFrames,
        processing: !!entry && !entry.stopped && entry.rendered > 0,
        publicationConfirmed: !!entry?.installed, processedFrames: entry?.rendered || 0,
        outgoingFrames: entry?.rtpFrames || 0, publishedResolutions: entry?.installed ? entry.layers.length : 0,
        activeResolutions: entry?.installed ? Array.from(entry.activeLayers.values()).filter(at => performance.now() - at < 3000).length : 0,
        remoteReceptionConfirmed: false, cameraPermissionGranted: false, cameraOpened: false,
        state: disposed ? 'disposed' : busy ? 'preparing' : activeFrames ? 'active-outgoing-frames' :
          entry ? 'awaiting-outgoing-frames' : image ? 'imported-not-applied' : enabled ? 'import-enabled' : 'disabled' };
    }
    function notify() { changed(state()); }
    async function processor() {
      if (!loading) loading = (async () => {
        const bundle = await host.customBackgroundAssets();
        if (bundle.version !== '0.1.1675465747' || bundle.license !== 'Apache-2.0')
          throw fault('BACKGROUND_ASSETS_UNAVAILABLE');
        assetUrls = new Map();
        for (const [name, data] of Object.entries(bundle.assets)) {
          if (!/^selfie_segmentation(?:[._a-z0-9])*\.(?:js|wasm|data|binarypb|tflite)$/.test(name))
            throw fault('BACKGROUND_ASSET_NAME');
          const type = name.endsWith('.js') ? 'text/javascript' : name.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream';
          assetUrls.set(name, URL.createObjectURL(new Blob([bytes(data)], { type })));
        }
        library = document.createElement('script');
        library.src = assetUrls.get('selfie_segmentation.js');
        await bounded(new Promise((resolve, reject) => {
          library.onload = resolve; library.onerror = () => reject(fault('BACKGROUND_SCRIPT_POLICY_BLOCKED'));
          document.head.appendChild(library);
        }), 15000, 'BACKGROUND_ASSET_LOAD_TIMEOUT');
        if (typeof window.SelfieSegmentation !== 'function') throw fault('BACKGROUND_PROCESSOR_UNAVAILABLE');
      })();
      await loading;
      const model = new window.SelfieSegmentation({ locateFile(name) {
        if (!assetUrls.has(name)) throw fault('BACKGROUND_ASSET_NOT_PACKAGED');
        return assetUrls.get(name); // No CDN, relative request or remote fallback.
      } });
      // The published solution exposes InferenceCalculator.use_cpu_inference.
      // Use real local TFLite/WASM inference consistently, including ia32 hosts
      // whose software WebGL cannot render the GPU model's float attachments.
      model.setOptions({ modelSelection: 1, selfieMode: false, useCpuInference: true });
      return model;
    }
    function profiles(stream) {
      const values = stream.getStreamInfo().videoProfiles;
      if (!Array.isArray(values)) throw fault('BACKGROUND_SDK_ABI_MISMATCH');
      return values.filter(profile => profile.hasTrack).map(profile => {
        const track = stream.getVideoTrack(profile.resolutionId), hrtc = stream.getVideoHRTCTrack(profile.resolutionId);
        if (!live(track) || !track.enabled || track.muted || hrtc?.getTrackMuted() !== false)
          throw fault('BACKGROUND_CAMERA_CLOSED');
        const settings = track.getSettings();
        const width = settings.width || profile.width, height = settings.height || profile.height;
        if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
            width > 4096 || height > 4096 || width * height > 8 * 1024 * 1024)
          throw fault('BACKGROUND_CAMERA_BOUNDS');
        return { id: profile.resolutionId, track, width, height };
      });
    }
    function selected(entry) {
      return getLocalStream() === entry.stream && getClient() === entry.client && context().sessionKey === entry.sessionKey;
    }
    function valid(entry) {
      return current === entry && !entry.stopped && selected(entry) && revision === entry.revision &&
        !permission(true).reason && image === entry.image;
    }
    function check(entry) { if (!valid(entry)) throw fault('BACKGROUND_OWNER_CHANGED'); }
    function quarantine(entry) {
      if (!entry || entry.stopped) return;
      entry.stopped = true;
      entry.installed = false;
      clearTimeout(entry.next);
      for (const layer of entry.layers) {
        // A stopped camera cannot keep emitting its last foreground frame.
        layer.output.enabled = false; layer.output.stop();
        layer.canvas.width = 1; layer.canvas.height = 1;
      }
      entry.video.pause(); entry.video.srcObject = null;
    }
    async function retire(entry, restore, skipTrack) {
      if (!entry) return;
      if (entry.retiring) return entry.retiring;
      quarantine(entry);
      if (!restore || !selected(entry) || !context().cameraAllowed || !context().cameraIntent)
        for (const layer of entry.layers) layer.source.stop();
      const work = (async () => {
        let failure = null;
        try {
          if (entry.replacing) await bounded(entry.replacing, 5000, 'BACKGROUND_REPLACE_RETIRE_TIMEOUT');
          for (const layer of entry.layers) {
            const actual = entry.stream.getVideoTrack(layer.id);
            if (actual !== layer.output || actual === skipTrack) continue; // A newer or caller-owned removal wins.
            if (restore && selected(entry) && context().cameraAllowed && context().cameraIntent && live(layer.source) &&
                entry.stream.getVideoHRTCTrack(layer.id)?.getTrackMuted() === false) {
              // SDK DP.replaceTrack stops the previous track. Transfer the live
              // source clone, rather than recapturing a camera or reviving a mute.
              await bounded(entry.guard.original.replaceTrack.call(entry.stream, layer.source, 'video', layer.id),
                5000, 'BACKGROUND_RESTORE_TIMEOUT');
              layer.restored = entry.stream.getVideoTrack(layer.id) === layer.source;
              if (!layer.restored) throw fault('BACKGROUND_RESTORE_UNCONFIRMED');
            } else {
              await bounded(entry.guard.original.removeTrack.call(entry.stream, layer.output), 5000, 'BACKGROUND_REMOVE_TIMEOUT');
            }
          }
        } catch (error) {
          failure = error;
          // A failed restoration must not leave our frame or clone transmitting.
          for (const layer of entry.layers) {
            const actual = entry.stream.getVideoTrack(layer.id);
            if (actual === layer.output || actual === layer.source) actual.stop();
          }
        } finally {
          for (const layer of entry.layers) {
            layer.source.removeEventListener('ended', entry.ended);
            layer.source.removeEventListener('mute', entry.ended);
            if (!layer.restored || failure) layer.source.stop();
          }
          // MediaPipe close must not race an outstanding send/results callback.
          let closeLater = false;
          const pending = entry.sending || entry.initializing;
          if (pending) {
            try { await bounded(pending, 5000, 'BACKGROUND_PROCESS_RETIRE_TIMEOUT'); }
            catch (error) {
              closeLater = true;
              failure ||= error;
              // A late wasm callback still owns the graph until it settles.
              pending.finally(() => entry.model?.close()).catch(() => {});
            }
          }
          if (entry.model && !closeLater) await entry.model.close();
          if (current === entry) current = null;
          if (failure) lastError = failure.code || 'BACKGROUND_CLEANUP_FAILED';
          notify();
        }
        if (failure) throw failure;
      })();
      entry.retiring = work;
      return work;
    }
    function stopNow(reason, restore, skipTrack) {
      ++revision;
      const entry = current;
      lastError = reason;
      quarantine(entry);
      const work = retire(entry, restore, skipTrack);
      work.catch(() => {});
      return work;
    }
    function guardStream(stream) {
      if (!stream || stream.isAuxiliary() || stream.getType() !== 'local') return stream;
      if (guards.has(stream)) return stream;
      const guard = { original: {}, wrappers: {}, descriptors: {} };
      for (const name of ['replaceTrack', 'removeTrack', 'close', 'muteVideo', 'switchDevice', 'addVideoTrackCapture']) {
        if (typeof stream[name] !== 'function') throw fault('BACKGROUND_SDK_ABI_MISMATCH');
        guard.original[name] = stream[name]; guard.descriptors[name] = Object.getOwnPropertyDescriptor(stream, name);
      }
      function wrap(name, fn) {
        guard.wrappers[name] = fn;
        Object.defineProperty(stream, name, { configurable: true, writable: true, value: fn });
      }
      function interrupt(reason, restore, skipTrack) {
        return current?.stream === stream ? stopNow(reason, restore, skipTrack) : null;
      }
      function stopSources() {
        if (current?.stream !== stream) return;
        quarantine(current);
        for (const layer of current.layers) layer.source.stop();
      }
      wrap('muteVideo', function (...args) {
        // Synchronous revocation precedes provider's mute and any async cleanup.
        stopSources();
        try { return guard.original.muteVideo.apply(this, args); }
        finally { interrupt('BACKGROUND_CAMERA_CLOSED', false); }
      });
      wrap('close', function (...args) {
        const video = args[0]?.video !== false;
        if (video) stopSources();
        try { return guard.original.close.apply(this, args); }
        finally { if (video) interrupt('BACKGROUND_CAMERA_CLOSED', false); }
      });
      wrap('removeTrack', function (track, ...args) {
        // Provider 491 polls getVideoTrack after sdkWrapper(removeTrack), which
        // does not await the returned promise. Preserve HRTC's synchronous
        // detach before waiting for publication or background cleanup.
        const retirement = track?.kind === 'video' ? interrupt('BACKGROUND_CAMERA_REPLACED', true, track) : null;
        const removal = guard.original.removeTrack.call(this, track, ...args);
        return retirement ? Promise.all([removal, retirement]).then(([result]) => result) : removal;
      });
      wrap('replaceTrack', async function (track, type, ...args) {
        if (type === 'video') await interrupt('BACKGROUND_CAMERA_REPLACED', true);
        return guard.original.replaceTrack.call(this, track, type, ...args);
      });
      wrap('switchDevice', async function (type, ...args) {
        if (type === 'video') await interrupt('BACKGROUND_CAMERA_REPLACED', true);
        return guard.original.switchDevice.call(this, type, ...args);
      });
      wrap('addVideoTrackCapture', async function (...args) {
        await interrupt('BACKGROUND_CAMERA_REPLACED', true);
        return guard.original.addVideoTrackCapture.apply(this, args);
      });
      guards.set(stream, guard);
      return stream;
    }
    async function importImage(params) {
      const c = requirePermission(false);
      if (params.revision !== revision) throw fault('BACKGROUND_OWNER_CHANGED', 'The background import selection was superseded');
      if (params.sessionKey !== c.sessionKey || typeof params.importId !== 'string' || !/^[a-f0-9]{32}$/.test(params.importId) ||
          !['image/png', 'image/jpeg'].includes(params.mime) || typeof params.base64 !== 'string' ||
          params.base64.length > 6990508 || !/^[A-Za-z0-9+/]*={0,2}$/.test(params.base64))
        throw fault('BACKGROUND_IMAGE_INVALID');
      if (![params.width, params.height].every(n => Number.isInteger(n) && n >= 64 && n <= 4096) ||
          params.width * params.height > 8 * 1024 * 1024) throw fault('BACKGROUND_IMAGE_BOUNDS');
      await stopNow(null, true);
      const token = revision;
      let bitmap, abandoned = false;
      // Use the browser's native orientation default: sealed Electron 22 does
      // not expose the newer "from-image" enum. Validate actual decoded bounds.
      const decoded = createImageBitmap(new Blob([bytes(params.base64)], { type: params.mime }));
      decoded.then(result => { if (abandoned) result.close(); }, () => {});
      try {
        bitmap = await bounded(decoded, 10000, 'BACKGROUND_IMAGE_DECODE_TIMEOUT');
        if (bitmap.width < 64 || bitmap.height < 64 || bitmap.width > 4096 || bitmap.height > 4096 ||
            bitmap.width * bitmap.height > 8 * 1024 * 1024 ||
            !((bitmap.width === params.width && bitmap.height === params.height) ||
              (bitmap.width === params.height && bitmap.height === params.width))) throw fault('BACKGROUND_IMAGE_BOUNDS');
        requirePermission(false);
        if (revision !== token || c.sessionKey !== context().sessionKey) throw fault('BACKGROUND_OWNER_CHANGED');
        image?.close(); image = bitmap; bitmap = null;
        receipt = { importId: params.importId, width: image.width, height: image.height,
          mime: params.mime, sessionKey: c.sessionKey, persisted: false };
        lastError = null; notify(); return state();
      } finally { abandoned = true; bitmap?.close(); }
    }
    async function apply() {
      requirePermission(true);
      if (!image || receipt.sessionKey !== context().sessionKey) throw fault('BACKGROUND_IMAGE_REQUIRED');
      if (busy) throw fault('BACKGROUND_OPERATION_PENDING');
      const work = start(); busy = work; notify();
      try { return await work; }
      finally { if (busy === work) busy = null; notify(); }
    }
    async function start() {
      await retire(current, true);
      const c = requirePermission(true), stream = getLocalStream(), client = getClient();
      if (!image || receipt?.sessionKey !== c.sessionKey) throw fault('BACKGROUND_IMAGE_REQUIRED');
      if (!stream || !client || typeof client.getPublishVideoSender !== 'function') throw fault('BACKGROUND_SDK_ABI_MISMATCH');
      if (stream.screen_ || stream.isAuxiliary()) throw fault('BACKGROUND_NOT_CAMERA');
      guardStream(stream);
      const tracks = profiles(stream);
      if (!tracks.length) throw fault('BACKGROUND_CAMERA_CLOSED');
      const entry = { stream, client, guard: guards.get(stream), sessionKey: c.sessionKey,
        revision: ++revision, image, layers: [], rendered: 0, rtpFrames: 0, lastRtpAt: 0,
        installed: false, stopped: false, video: document.createElement('video'), counters: new Map(), activeLayers: new Map() };
      current = entry;
      entry.ended = () => { if (!entry.stopped) stopNow('BACKGROUND_CAMERA_ENDED', false); };
      try {
        for (const track of tracks) {
          const surface = canvas(track.width, track.height), ctx = surface.getContext('2d', { alpha: false });
          if (!ctx || typeof surface.captureStream !== 'function') throw fault('BACKGROUND_CANVAS_UNAVAILABLE');
          const output = surface.captureStream(0).getVideoTracks()[0], source = track.track.clone();
          if (!live(output) || typeof output.requestFrame !== 'function' || !live(source)) throw fault('BACKGROUND_TRACK_UNAVAILABLE');
          source.addEventListener('ended', entry.ended);
          source.addEventListener('mute', entry.ended);
          entry.layers.push({ ...track, canvas: surface, ctx, output, source, restored: false });
        }
        const largest = entry.layers.reduce((a, b) => a.width * a.height > b.width * b.height ? a : b);
        entry.video.muted = true; entry.video.playsInline = true;
        entry.video.srcObject = new MediaStream([largest.source]);
        await bounded(entry.video.play(), 10000, 'BACKGROUND_VIDEO_START_FAILED'); check(entry);
        const until = performance.now() + 5000;
        while (!entry.video.videoWidth) { if (performance.now() > until) throw fault('BACKGROUND_NO_CAMERA_FRAMES'); await delay(20); check(entry); }
        entry.composite = canvas(largest.width, largest.height);
        entry.compositeContext = entry.composite.getContext('2d');
        const created = processor().then(async model => {
          if (!valid(entry)) { await model.close(); throw fault('BACKGROUND_OWNER_CHANGED'); }
          entry.model = model;
          return model;
        });
        await bounded(created, 20000, 'BACKGROUND_MODEL_LOAD_TIMEOUT'); check(entry);
        entry.model.onResults(result => {
          if (!valid(entry)) return;
          if (!result.segmentationMask || !result.image) throw fault('BACKGROUND_MASK_UNAVAILABLE');
          const ctx = entry.compositeContext, width = entry.composite.width, height = entry.composite.height;
          ctx.save(); ctx.clearRect(0, 0, width, height);
          ctx.globalCompositeOperation = 'copy'; ctx.drawImage(result.segmentationMask, 0, 0, width, height);
          ctx.globalCompositeOperation = 'source-in'; ctx.drawImage(result.image, 0, 0, width, height);
          ctx.globalCompositeOperation = 'destination-over'; cover(ctx, entry.image, width, height); ctx.restore();
          for (const layer of entry.layers) {
            layer.ctx.drawImage(entry.composite, 0, 0, layer.width, layer.height); layer.output.requestFrame();
          }
          ++entry.rendered;
        });
        entry.initializing = entry.model.initialize();
        await bounded(entry.initializing, 20000, 'BACKGROUND_MODEL_START_FAILED'); check(entry);
        entry.sending = entry.model.send({ image: entry.video });
        await bounded(entry.sending, 5000, 'BACKGROUND_SEGMENTATION_TIMEOUT'); check(entry);
        if (!entry.rendered) throw fault('BACKGROUND_NO_SEGMENTED_FRAME');
        for (const layer of entry.layers) {
          check(entry);
          if (stream.getVideoTrack(layer.id) !== layer.track || !layer.track.enabled) throw fault('BACKGROUND_CAMERA_REPLACED');
          entry.replacing = entry.guard.original.replaceTrack.call(stream, layer.output, 'video', layer.id);
          await bounded(entry.replacing, 5000, 'BACKGROUND_REPLACE_TIMEOUT'); entry.replacing = null; check(entry);
          if (stream.getVideoTrack(layer.id) !== layer.output) throw fault('BACKGROUND_REPLACE_UNCONFIRMED');
        }
        const senders = client.getPublishVideoSender('main');
        if (!Array.isArray(senders) || !entry.layers.every(layer => senders.some(sender => sender.track === layer.output)))
          throw fault('BACKGROUND_PUBLICATION_UNCONFIRMED');
        entry.installed = true;
        await sampleOutgoing(entry); check(entry);
        pump(entry);
        lastError = null; notify(); return state();
      } catch (error) {
        lastError = error.code || 'BACKGROUND_PROCESSOR_FAILED';
        await retire(entry, true);
        throw error;
      }
    }
    async function sampleOutgoing(entry) {
      const senders = entry.client.getPublishVideoSender('main');
      if (!entry.layers.every(layer => senders.some(sender => sender.track === layer.output)))
        throw fault('BACKGROUND_PUBLICATION_LOST');
      for (const sender of senders) {
        if (!entry.layers.some(layer => layer.output === sender.track)) continue;
        const track = sender.track;
        const reports = await bounded(sender.getStats(), 5000, 'BACKGROUND_STATS_TIMEOUT');
        if (!valid(entry)) return;
        for (const report of reports.values()) {
          if (report.type !== 'outbound-rtp' || report.isRemote || (report.kind || report.mediaType) !== 'video' ||
              !Number.isFinite(report.framesEncoded)) continue;
          const key = track.id + ':' + report.id, before = entry.counters.get(key);
          entry.counters.set(key, report.framesEncoded);
          if (before !== undefined && report.framesEncoded > before) {
            entry.rtpFrames += report.framesEncoded - before; entry.lastRtpAt = performance.now();
            entry.activeLayers.set(track.id, entry.lastRtpAt);
          }
        }
      }
    }
    function pump(entry) {
      entry.next = setTimeout(async () => {
        if (!valid(entry)) { stopNow('BACKGROUND_OWNER_CHANGED', true); return; }
        try {
          entry.sending = entry.model.send({ image: entry.video });
          await bounded(entry.sending, 5000, 'BACKGROUND_SEGMENTATION_TIMEOUT'); check(entry);
          if (performance.now() - (entry.lastStatsAt || 0) > 1000) {
            entry.lastStatsAt = performance.now(); await sampleOutgoing(entry); notify();
          }
          if (valid(entry)) pump(entry);
        } catch (error) { if (!entry.stopped) stopNow(error.code || 'BACKGROUND_PROCESSOR_FAILED', true); }
      }, 66); // Single inference in flight; no backlog or hidden extra captures.
    }
    function pulse() {
      if (disposed) return;
      const c = permission(true), entry = current;
      if (entry && !entry.stopped && (c.reason || !selected(entry) ||
          entry.installed && entry.layers.some(layer => entry.stream.getVideoTrack(layer.id) !== layer.output)))
        stopNow(c.reason || 'BACKGROUND_CAMERA_REPLACED', true);
      if (receipt && receipt.sessionKey !== c.sessionKey) {
        stopNow('BACKGROUND_OWNER_CHANGED', false);
        image?.close(); image = null; receipt = null;
      }
    }
    async function clear() {
      await stopNow(null, true);
      image?.close(); image = null; receipt = null; lastError = null; notify(); return state();
    }
    async function configure(value) {
      if (typeof value !== 'boolean') throw fault('INVALID_ARGUMENT');
      if (disposed) throw fault('BACKGROUND_DISPOSED');
      configured = true; enabled = value;
      if (!value) await clear();
      if (value && !timer) timer = setInterval(pulse, 200);
      if (!value && timer) { clearInterval(timer); timer = null; }
      notify(); return state();
    }
    async function dispose() {
      if (disposed) return;
      enabled = false; disposed = true;
      clearInterval(timer); timer = null;
      await stopNow('BACKGROUND_DISPOSED', false);
      image?.close(); image = null; receipt = null;
      for (const [stream, guard] of guards) for (const [name, wrapper] of Object.entries(guard.wrappers)) {
        if (stream[name] !== wrapper) continue; // Preserve another feature's later wrapper.
        const original = guard.descriptors[name];
        if (original) Object.defineProperty(stream, name, original); else delete stream[name];
      }
      guards.clear();
      if (loading) { try { await loading; } catch {} }
      library?.remove();
      if (assetUrls) for (const url of assetUrls.values()) URL.revokeObjectURL(url);
      assetUrls = null; notify();
    }
    return Object.freeze({ configure, importImage, apply, clear, state, pulse, guardStream, dispose });
  };
})();
