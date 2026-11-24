/* Render-window adaptation for the Linux conference note consumer. No HWNDs,
 * desktop capture, new camera access, hidden playback or synthetic video input.
 * Only currently rendered MediaStream video tracks supplied by the room owner
 * may contribute pixels. Layout metadata is CSS pixels; saved pixels are decoded
 * source frames in a separate, bounded composition, not a desktop screenshot. */
(() => {
  'use strict';
  if (window.__welinkCreateRenderWindows) return;
  const MAX_EDGE = 4096, MAX_PIXELS = 8 * 1024 * 1024;
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
  window.__welinkCreateRenderWindows = function createRenderWindows({ getState, ensurePolicy, watermark, root = document }) {
    if (typeof getState !== 'function' || typeof ensurePolicy !== 'function' || typeof watermark?.paintSnapshot !== 'function')
      throw new TypeError('Render snapshots require the room owner and authoritative watermark');
    const ids = new WeakMap();
    let sequence = 0;
    function visible(video) {
      let rect = video.getBoundingClientRect();
      let left = Math.max(0, rect.left), top = Math.max(0, rect.top);
      let right = Math.min(innerWidth, rect.right), bottom = Math.min(innerHeight, rect.bottom);
      for (let element = video; element; element = element.parentElement) {
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) return null;
        if (element !== video && /(hidden|clip|scroll|auto)/.test(style.overflowX + ' ' + style.overflowY)) {
          const clip = element.getBoundingClientRect();
          if (/(hidden|clip|scroll|auto)/.test(style.overflowX)) { left = Math.max(left, clip.left); right = Math.min(right, clip.right); }
          if (/(hidden|clip|scroll|auto)/.test(style.overflowY)) { top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom); }
        }
      }
      if (right <= left || bottom <= top) return null;
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        visible: { x: left, y: top, width: right - left, height: bottom - top }, unit: 'css-px' };
    }
    function collect(expected = {}, pixels = false, nativeSurface = false) {
      const state = getState();
      if (!state?.joined || !state.sessionKey || !state.conferenceId)
        fail('NOT_IN_CONFERENCE', 'No active connected conference owns render media');
      if (expected.sessionKey !== undefined && expected.sessionKey !== state.sessionKey ||
          expected.conferenceId !== undefined && String(expected.conferenceId) !== String(state.conferenceId))
        fail('CONFERENCE_CHANGED', 'The render request belongs to a different conference session');
      const policy = ensurePolicy(pixels || expected.requireCapture === true);
      if (!nativeSurface && (pixels || expected.requireCapture === true) && state.localSharing !== false)
        fail(state.localSharing === true ? 'LOCAL_SHARING_ACTIVE' : 'LOCAL_SHARING_UNKNOWN',
          state.localSharing === true ? 'Stop sharing your screen before saving a conference picture to the note' :
            'The conference has not confirmed its local screen-sharing state');
      const visual = watermark.ensure('render-snapshot');
      if (expected.policyRevision !== undefined && expected.policyRevision !== visual.revision)
        fail('RENDER_POLICY_CHANGED', 'The watermark changed while the snapshot was being saved');
      const allowed = new Map();
      for (const source of state.sources || []) {
        const track = source.track;
        if (track instanceof MediaStreamTrack && track.kind === 'video' && track.readyState === 'live' && track.enabled && !track.muted)
          allowed.set(track, source);
      }
      const entries = [], seen = new Set();
      for (const video of root.querySelectorAll('video')) {
        if (!(video.srcObject instanceof MediaStream) || video.readyState < 2 || video.paused || video.ended || !video.videoWidth || !video.videoHeight) continue;
        const tracks = video.srcObject.getVideoTracks();
        if (tracks.length !== 1 || !allowed.has(tracks[0]) || seen.has(tracks[0])) continue;
        const bounds = visible(video);
        if (!bounds) continue;
        const track = tracks[0], source = allowed.get(track);
        seen.add(track);
        if (!ids.has(video)) ids.set(video, 'media-element-' + ++sequence);
        entries.push({ video, track, target: { id: ids.get(video), kind: 'html-video-media-stream',
          trackId: track.id, mediaKind: source.kind || 'conference-video',
          sourceSize: { width: video.videoWidth, height: video.videoHeight }, bounds } });
      }
      const targets = entries.map(entry => entry.target);
      const shared = entries.filter(entry => entry.target.mediaKind === 'shared-content');
      const selected = shared.length ? shared : entries;
      return { entries: selected, allEntries: entries, receipt: { sessionKey: state.sessionKey, conferenceId: String(state.conferenceId),
        source: state.source, targets, selectedTargetIds: selected.map(entry => entry.target.id),
        localSharing: typeof state.localSharing === 'boolean' ? state.localSharing : null,
        compositing: 'decoded-source-frames; UI and overlapping-window pixels excluded',
        nativeHandleSupported: false, handleKind: null, status: entries.length ? 'ready' : 'no-media',
        reason: entries.length ? null : 'NO_RENDER_MEDIA',
        policyRevision: visual.revision, watermark: { enabled: visual.enabled, revision: visual.revision },
        policy: policy?.ready === true ? 'enforced' : 'watermark-enforced',
        captureScope: 'rendered-conference-media-only', layout: 'source-frame-grid',
        devicePixelRatio, filePath: '' } };
    }
    function inspect(params = {}) { return collect(params).receipt; }
    function capture(params = {}) {
      if (!params.sessionKey) fail('RENDER_SESSION_REQUIRED', 'Capture requires a previously inspected conference session');
      const { entries, receipt } = collect(params, true);
      if (!entries.length) fail('NO_RENDER_MEDIA', 'The active conference has no decoded, visible video or shared-content frame');
      const columns = Math.ceil(Math.sqrt(entries.length)), rows = Math.ceil(entries.length / columns);
      const cellWidth = Math.max(...entries.map(entry => entry.video.videoWidth));
      const cellHeight = Math.max(...entries.map(entry => entry.video.videoHeight));
      const naturalWidth = columns * cellWidth, naturalHeight = rows * cellHeight;
      const scale = Math.min(1, MAX_EDGE / naturalWidth, MAX_EDGE / naturalHeight,
        Math.sqrt(MAX_PIXELS / (naturalWidth * naturalHeight)));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(naturalWidth * scale));
      canvas.height = Math.max(1, Math.floor(naturalHeight * scale));
      try {
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) fail('RENDER_CANVAS_UNAVAILABLE', 'No real canvas can encode the conference frame');
        context.fillStyle = '#000'; context.fillRect(0, 0, canvas.width, canvas.height);
        const cells = [];
        entries.forEach((entry, index) => {
          const width = canvas.width / columns, height = canvas.height / rows;
          const fit = Math.min(width / entry.video.videoWidth, height / entry.video.videoHeight);
          const w = entry.video.videoWidth * fit, h = entry.video.videoHeight * fit;
          const x = index % columns * width + (width - w) / 2;
          const y = Math.floor(index / columns) * height + (height - h) / 2;
          context.drawImage(entry.video, x, y, w, h);
          cells.push({ targetId: entry.target.id, x, y, width: w, height: h });
        });
        const painted = watermark.paintSnapshot(context, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/png');
        if (!dataUrl.startsWith('data:image/png;base64,')) fail('RENDER_ENCODING_FAILED', 'The captured media did not encode as PNG');
        // Check track identity, room and policy again before any pixels cross IPC.
        const after = collect(params, true);
        if (painted.revision !== receipt.policyRevision || after.receipt.policyRevision !== receipt.policyRevision ||
            entries.some(entry => !after.entries.some(value => value.video === entry.video && value.track === entry.track)))
          fail('RENDER_SOURCE_CHANGED', 'A rendered source or policy changed during capture');
        return { ...receipt, status: 'captured', format: 'png', size: { width: canvas.width, height: canvas.height },
          scale, cells, watermark: painted, dataUrl };
      } finally { canvas.width = 0; canvas.height = 0; }
    }
    // Native surfaces use all authorized visible tracks, not the note's shared-
    // content-first grid. Their pixel gate is the same strict snapshot policy.
    return Object.freeze({ inspect, capture, surfaceEntries: expected => collect(expected, true, true) });
  };
})();
