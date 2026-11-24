/* Native-X11 export source. This never acquires, plays, or publishes a track.
 * Only the note renderer's already-visible, room-owned MediaStream entries may
 * feed the native compositor. Every exported frame gets its own final watermark.
 * The main owner polls with backpressure; this page cannot open a native XID.
 */
(() => {
  'use strict';
  if (window.__welinkCreateRenderSurface) return;
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
  window.__welinkCreateRenderSurface = ({ collect, watermark, invalidate }) => {
    let lease = null, observed = [], unsubscribe = null, mutation = null;
    const canvases = new Map(), trackListeners = new Map();
    function notify(reason) {
      if (lease) Promise.resolve(invalidate({ leaseId: lease.leaseId, reason })).catch(() => {});
    }
    function close(expected) {
      if (expected?.leaseId && lease && expected.leaseId !== lease.leaseId) return {closed:false, retired:true};
      lease = null; observed = [];
      unsubscribe?.(); unsubscribe = null; mutation?.disconnect(); mutation = null;
      document.removeEventListener('visibilitychange', pulse);
      window.removeEventListener('pagehide', pagehide);
      for (const [track, fn] of trackListeners) for (const event of ['ended', 'mute', 'unmute']) track.removeEventListener(event, fn);
      trackListeners.clear();
      for (const canvas of canvases.values()) { canvas.width = 0; canvas.height = 0; }
      canvases.clear();
      return { closed: true };
    }
    function retire(reason) { notify(reason); close(); }
    function pagehide() { retire('RENDER_DOCUMENT_RETIRED'); }
    function source() {
      if (!lease) fail('RENDER_SURFACE_CLOSED', 'No consented native render lease');
      if (document.visibilityState !== 'visible') fail('RENDER_WINDOW_HIDDEN', 'Native media export requires a visible meeting');
      return collect(lease);
    }
    function watch(entries) {
      const changed = observed.length !== entries.length || entries.some((e, i) => observed[i]?.video !== e.video || observed[i]?.track !== e.track);
      if (changed) notify('RENDER_SOURCES_CHANGED');
      observed = entries.map(({video, track}) => ({video, track}));
      const tracks = new Set(entries.map(e => e.track));
      for (const [track, fn] of trackListeners) if (!tracks.has(track)) {
        for (const event of ['ended', 'mute', 'unmute']) track.removeEventListener(event, fn);
        trackListeners.delete(track);
      }
      for (const track of tracks) if (!trackListeners.has(track)) {
        const fn = () => pulse(); trackListeners.set(track, fn);
        for (const event of ['ended', 'mute', 'unmute']) track.addEventListener(event, fn);
      }
      const videos = new Set(entries.map(e => e.video));
      for (const [video, canvas] of canvases) if (!videos.has(video)) {
        canvas.width = 0; canvas.height = 0; canvases.delete(video);
      }
    }
    function pulse() {
      if (!lease) return;
      try { const entries = source().allEntries; watch(entries); prepare(entries); }
      catch (error) { retire(error.code || 'RENDER_POLICY_LOST'); }
    }
    function open(params) {
      close();
      if (!params || typeof params.leaseId !== 'string' || !params.sessionKey || !params.conferenceId || params.policyRevision === undefined)
        fail('RENDER_LEASE_REQUIRED', 'Native export must be opened by its current main-process owner');
      lease = { leaseId: params.leaseId, sessionKey: params.sessionKey, conferenceId: params.conferenceId, policyRevision: params.policyRevision };
      try {
        const initial = source();
        // Initial observation does not revoke the just-issued lease.
        observed = initial.allEntries.map(({video, track}) => ({video, track}));
        watch(initial.allEntries);
        prepare(initial.allEntries);
        unsubscribe = watermark.subscribe(() => retire('RENDER_WATERMARK_CHANGED'));
        mutation = new MutationObserver(pulse);
        mutation.observe(document.documentElement, { childList: true, subtree: true, attributes: true,
          attributeFilter: ['style', 'class', 'hidden', 'src'] });
        document.addEventListener('visibilitychange', pulse);
        window.addEventListener('pagehide', pagehide);
        return { leaseId: lease.leaseId, sessionKey: lease.sessionKey };
      } catch (error) { close(); throw error; }
    }
    function position(value, free) {
      if (/^-?\d+(?:\.\d+)?%$/.test(value)) return Number.parseFloat(value) * free / 100;
      if (/^-?\d+(?:\.\d+)?px$/.test(value)) return Number.parseFloat(value);
      fail('RENDER_STYLE_UNSUPPORTED', 'The video object position cannot be represented by the native surface');
    }
    function paint(entry, canvas, bounds, ratio) {
      const {video} = entry, style = getComputedStyle(video), rect = video.getBoundingClientRect();
      const clips = [];
      if (['borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth','paddingTop','paddingRight','paddingBottom','paddingLeft']
          .some(key => Number.parseFloat(style[key]) !== 0))
        fail('RENDER_STYLE_UNSUPPORTED', 'A decorated video content box cannot be exported as raw track pixels');
      // Do not silently strip privacy-affecting CSS effects. Object fit and the
      // usual local-camera mirror are rendered; exotic transforms fail closed.
      for (let element = video; element; element = element.parentElement) {
        const css = getComputedStyle(element);
        if (Number(css.opacity) !== 1 || css.filter !== 'none' || css.clipPath !== 'none' ||
            css.mixBlendMode !== 'normal' || css.clip !== 'auto' || (css.maskImage && css.maskImage !== 'none') ||
            (css.webkitMaskImage && css.webkitMaskImage !== 'none') || (element !== video && css.transform !== 'none'))
          fail('RENDER_STYLE_UNSUPPORTED', 'A transformed, filtered or masked video cannot be exported faithfully');
        if (element === video || /hidden|clip|scroll|auto/.test(css.overflowX + ' ' + css.overflowY) || css.contain.includes('paint')) {
          const box = element.getBoundingClientRect();
          const radii = ['borderTopLeftRadius','borderTopRightRadius','borderBottomRightRadius','borderBottomLeftRadius'].map(key => {
            const [x,y=x] = css[key].split(/\s+/);
            return {x:position(x,box.width), y:position(y,box.height)};
          });
          if (radii.some(radius => radius.x || radius.y) || css.contain.includes('paint')) clips.push({box,radii,ownVideo:element===video});
        }
      }
      let mirrorX = false, mirrorY = false;
      if (style.transform !== 'none') {
        const matrix = new DOMMatrixReadOnly(style.transform);
        if (!matrix.is2D || matrix.b || matrix.c || Math.abs(matrix.a) !== 1 || Math.abs(matrix.d) !== 1)
          fail('RENDER_STYLE_UNSUPPORTED', 'Only axis-aligned video mirrors can be exported');
        mirrorX = matrix.a < 0; mirrorY = matrix.d < 0;
      }
      const context = canvas.getContext('2d', {alpha:false, willReadFrequently:true});
      if (!context) fail('RENDER_CANVAS_UNAVAILABLE', 'Native export requires a real decoded frame canvas');
      watermark.prepareSnapshot(context, canvas.width, canvas.height);
      context.setTransform(1, 0, 0, 1, 0, 0); context.fillStyle = '#000'; context.fillRect(0, 0, canvas.width, canvas.height);
      let w = rect.width, h = rect.height;
      const fit = Math.min(w / video.videoWidth, h / video.videoHeight);
      switch (style.objectFit) {
        case 'contain': w = video.videoWidth * fit; h = video.videoHeight * fit; break;
        case 'cover': { const cover = Math.max(w / video.videoWidth, h / video.videoHeight); w = video.videoWidth * cover; h = video.videoHeight * cover; break; }
        case 'none': w = video.videoWidth; h = video.videoHeight; break;
        case 'scale-down': { const scale = Math.min(1, fit); w = video.videoWidth * scale; h = video.videoHeight * scale; break; }
        case 'fill': break;
        default: fail('RENDER_STYLE_UNSUPPORTED', 'Unknown video fit mode');
      }
      const pos = style.objectPosition.split(/\s+/);
      if (pos.length !== 2) fail('RENDER_STYLE_UNSUPPORTED', 'Unsupported video object position');
      const x = position(pos[0], rect.width - w), y = position(pos[1], rect.height - h);
      context.save();
      context.scale(ratio, ratio);
      context.translate(-bounds.x / ratio, -bounds.y / ratio);
      for (const clip of clips) {
        if (typeof context.roundRect !== 'function') fail('RENDER_STYLE_UNSUPPORTED', 'Rounded video crops require canvas roundRect support');
        const {box} = clip; let radii = clip.radii;
        if (clip.ownVideo && mirrorX) radii = [radii[1],radii[0],radii[3],radii[2]];
        if (clip.ownVideo && mirrorY) radii = [radii[3],radii[2],radii[1],radii[0]];
        context.beginPath(); context.roundRect(box.x,box.y,box.width,box.height,radii); context.clip();
      }
      context.translate(rect.left,rect.top);
      if (mirrorX || mirrorY) { context.translate(mirrorX ? rect.width : 0, mirrorY ? rect.height : 0); context.scale(mirrorX ? -1 : 1, mirrorY ? -1 : 1); }
      context.drawImage(video, x, y, w, h);
      context.restore();
      return { context, painted: watermark.paintSnapshot(context, canvas.width, canvas.height) };
    }
    function prepare(entries) {
      if (typeof watermark.prepareSnapshot !== 'function')
        fail('RENDER_PROVIDER_UNAVAILABLE', 'Native tiles require non-destructive authoritative watermark preflight');
      if (entries.length > 16) fail('RENDER_SURFACE_LIMIT', 'At most 16 visible native surfaces can be exported');
      const ratio = devicePixelRatio;
      if (!Number.isFinite(ratio) || ratio <= 0) fail('RENDER_GEOMETRY_UNSUPPORTED', 'No physical pixel scale');
      let pixels = 0;
      return entries.map(entry => {
        const visible = entry.target.bounds.visible;
        // Round INWARD: never export a source pixel outside the visible crop.
        const x = Math.ceil(visible.x * ratio), y = Math.ceil(visible.y * ratio);
        const width = Math.floor((visible.x + visible.width) * ratio) - x;
        const height = Math.floor((visible.y + visible.height) * ratio) - y;
        if (width < 1 || height < 1 || width > 4096 || height > 4096 || (pixels += width * height) > 4 * 1024 * 1024)
          fail('RENDER_SURFACE_LIMIT', 'Native visible frame dimensions exceed the bounded compositor');
        let canvas = canvases.get(entry.video);
        if (!canvas) { canvas = document.createElement('canvas'); canvases.set(entry.video, canvas); }
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
        const bounds = {x,y,width,height};
        const context = canvas.getContext('2d', {alpha:false, willReadFrequently:true});
        if (!context) fail('RENDER_CANVAS_UNAVAILABLE', 'Native export requires a decoded frame canvas');
        watermark.prepareSnapshot(context, width, height);
        return {entry,canvas,bounds,ratio};
      });
    }
    function frame(params) {
      if (!lease || params?.leaseId !== lease.leaseId) fail('RENDER_LEASE_RETIRED', 'The native surface lease changed');
      const current = source(); watch(current.allEntries);
      const prepared = prepare(current.allEntries);
      const viewport = {width:Math.round(innerWidth*devicePixelRatio),height:Math.round(innerHeight*devicePixelRatio)};
      const frames = prepared.map(({entry,canvas,bounds,ratio}) => {
        const {context,painted} = paint(entry,canvas,bounds,ratio);
        if (painted.revision !== current.receipt.policyRevision) fail('RENDER_POLICY_CHANGED', 'Watermark changed during native rendering');
        return {target:entry.target,bounds,watermark:painted,rgba:context.getImageData(0,0,bounds.width,bounds.height).data};
      });
      const after = source();
      if (after.allEntries.length !== current.allEntries.length || current.allEntries.some((entry,i) =>
          after.allEntries[i]?.track !== entry.track || after.allEntries[i]?.video !== entry.video))
        fail('RENDER_SOURCE_CHANGED', 'A native video source was retired during composition');
      return { leaseId: lease.leaseId, ...current.receipt, viewport, frames };
    }
    return Object.freeze({ open, frame, pulse, close });
  };
})();
