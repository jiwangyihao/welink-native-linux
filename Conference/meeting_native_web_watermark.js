/* MAIN-world, rendered watermark enforcement for the pinned web meeting runtime.
 *
 * Source evidence: webrtc-main.6297930e.js module 40904 implements DOM fullscreen;
 * 65113/52231 dispatch it with {element}; 7283 opens external portal/record pages.
 * React portals render ordinary document UI. Neither that bundle nor
 * hrtc-12.eb3d2838.js implements a watermark renderer (supportWatermark is only
 * metadata; error 12051015 explicitly describes the unsupported web version).
 * The inspected official Linux preload maps provide no watermark binding.
 * This is consequently a rendered adapter, NOT a vendor/server capability ACK.
 * It never advertises supportWatermark, sends a guessed command, or captures media.
 *
 * __welinkCreateNativeWatermark({onViolation}) -> synchronous methods:
 *   configure({content, color}) -> state. Only content === '' explicitly disables.
 *     Enabled color must be #cccccc, #999999 or #666666. Content comes verbatim
 *     from the authoritative account/tenant policy; this module creates no identity.
 *   ensure(scope) -> {scope, revision, enabled, ready:true, enforcement} or throws.
 *   paint(context,width,height) -> {revision, enabled, painted}; paints LAST onto
 *     an owned, unclipped 2D recording canvas, after all actual meeting pixels.
 *   state(), subscribe(listener) -> unsubscribe, dispose().
 * vendor/loadModule/getSession may also be supplied; no unproven ABI is invoked.
 *
 * Enforced: this document's UI (including its ordinary DOM/React popups) and
 * guarded HTML-container fullscreen; actual frames passed to paint by the local
 * recorder. Not enforced: audio-only recording, outgoing/remote tracks, media-
 * element fullscreen, PiP, other documents/windows, browser/OS/native UI, cloud
 * recording. Requests for those scopes fail while enabled. Browser popups/PiP/
 * native top-layer dialogs are blocked rather than falsely reported protected.
 * The embedding host MUST also deny native/external windows and navigation that
 * bypass this document, gate show/join with ensure('meeting-ui'), and hide/leave
 * on onViolation(error). A renderer cannot watermark another process or window.
 *
 * Before configuration, and on enforcement loss, this document is blanked
 * synchronously. Successful configure means glyph pixels exist, mounted canvases
 * cover the viewport, and surface guards are installed; it is not a server ACK.
 * Failed enforcement is latched until a successful explicit configure. Subscribers
 * run synchronously on configuration/loss/disposal; onViolation receives an Error
 * with code and details {scope,revision}. No policy content appears in notifications.
 * The host hides the meeting window BEFORE dispose, which restores owned hooks.
 */
(() => {
  'use strict';
  if (window.__welinkCreateNativeWatermark) return;
  let owner = null;
  const COLORS = new Set(['#cccccc', '#999999', '#666666']);
  const SCOPES = new Set(['meeting-ui', 'render-snapshot', 'local-recording-video', 'local-recording-audio',
    'outgoing-video', 'remote-video', 'picture-in-picture', 'popup', 'fullscreen-video',
    'native-ui', 'cloud-recording']);
  const CONTAINERS = new Set(['HTML', 'BODY', 'DIV', 'MAIN', 'SECTION', 'ARTICLE', 'ASIDE', 'HEADER', 'FOOTER']);
  const FULLSCREEN_METHODS = ['requestFullscreen', 'webkitRequestFullscreen', 'webkitRequestFullScreen',
    'mozRequestFullScreen', 'mozRequestFullscreen', 'msRequestFullscreen'];
  const OVERLAY_STYLE = 'all:initial!important;position:fixed!important;inset:0!important;' +
    'width:100vw!important;height:100vh!important;min-width:0!important;min-height:0!important;' +
    'max-width:none!important;max-height:none!important;box-sizing:border-box!important;' +
    'display:block!important;visibility:visible!important;opacity:1!important;' +
    'margin:0!important;padding:0!important;border:0!important;outline:0!important;' +
    'z-index:2147483647!important;pointer-events:none!important;overflow:hidden!important;' +
    'transform:none!important;filter:none!important;clip:auto!important;clip-path:none!important;' +
    'mix-blend-mode:normal!important;isolation:isolate!important;animation:none!important;' +
    'transition:none!important;background:transparent!important;';

  window.__welinkCreateNativeWatermark = function createNativeWatermark(deps) {
    if (!deps || typeof deps.onViolation !== 'function') throw new TypeError('Watermark onViolation is required');
    if (owner) throw new Error('A watermark policy already owns this document');
    const root = document.documentElement;
    if (!root) throw new Error('Watermark requires the real meeting document');
    const listeners = new Set(), overlays = new Map(), patches = [], mediaHints = new Map();
    let configured = false, enabled = false, disposed = false, revision = 0, failure = null;
    let content = '', color = null, frame = null, observer = null, pendingFullscreen = null;
    let lockedRoot = null, savedDisplay = null, guardFailure = null, patterns = new WeakMap();
    const token = {};
    owner = token;

    function error(code, message, scope = 'meeting-ui') {
      return Object.assign(new Error(message), { code, details: { scope, revision } });
    }
    function state() {
      return Object.freeze({ state: disposed ? 'disposed' : failure ? 'failed' : !configured ? 'unconfigured' : enabled ? 'enforced' : 'disabled',
        configured, enabled, required: configured && enabled, revision,
        ready: !disposed && configured && !failure, implementation: 'rendered-canvas-adapter',
        scopes: { meetingUi: 'current-document-and-guarded-container-fullscreen', localRecordingVideo: 'paint-required-on-every-frame',
          localRecordingAudio: 'unavailable-when-enabled', outgoingVideo: 'unavailable', remoteVideo: 'unavailable',
          popup: 'unavailable', pictureInPicture: 'unavailable', nativeUi: 'unavailable', cloudRecording: 'unavailable' },
        error: failure ? { code: failure.code, message: failure.message, details: failure.details } : null });
    }
    function broadcast() {
      const value = state();
      for (const listener of listeners) {
        try { listener(value); } catch (ignored) { /* One observer cannot bypass the other policy consumers. */ }
      }
    }
    function blank() {
      const element = document.documentElement;
      if (!element) return;
      if (lockedRoot !== element) {
        lockedRoot = element;
        savedDisplay = { value: element.style.getPropertyValue('display'), priority: element.style.getPropertyPriority('display') };
      }
      if (element.style.getPropertyValue('display') !== 'none' || element.style.getPropertyPriority('display') !== 'important')
        element.style.setProperty('display', 'none', 'important');
    }
    function unblank() {
      if (!lockedRoot) return;
      if (savedDisplay.value) lockedRoot.style.setProperty('display', savedDisplay.value, savedDisplay.priority);
      else lockedRoot.style.removeProperty('display');
      lockedRoot = null;
      savedDisplay = null;
    }
    function lose(cause) {
      const next = cause && cause.code ? cause : error('WATERMARK_ENFORCEMENT_LOST', cause && cause.message || String(cause));
      blank();
      if (!failure && !disposed) {
        failure = next;
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null;
        broadcast();
        try { deps.onViolation(next); } catch (ignored) { /* The local document remains blank. */ }
      }
      return failure || next;
    }
    function fullscreenElement() {
      return document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement || null;
    }
    function buildPattern(context, width, height) {
      const cached = patterns.get(context);
      if (cached && cached.revision === revision && cached.width === width && cached.height === height) return cached.pattern;
      if (width < 200 || height < 120) throw Object.assign(
        error('WATERMARK_SURFACE_TOO_SMALL', 'The visual surface cannot contain a readable watermark'), { renderSizeUnsupported: true });
      const tile = document.createElement('canvas'), ink = tile.getContext('2d');
      if (!ink) throw error('WATERMARK_CANVAS_UNAVAILABLE', 'A real watermark text canvas is required');
      const font = '16px sans-serif', lineHeight = 22, maxWidth = Math.min(260, width - 80);
      ink.font = font;
      const lines = [];
      let line = '';
      for (const character of content) {
        if (character === '\n') { lines.push(line); line = ''; continue; }
        if (line && ink.measureText(line + character).width > maxWidth) { lines.push(line); line = ''; }
        line += character;
      }
      lines.push(line);
      const textWidth = Math.max(...lines.map(value => ink.measureText(value).width));
      const textHeight = lines.length * lineHeight, angle = -Math.PI / 8;
      tile.width = Math.ceil(textWidth * Math.cos(angle) + textHeight * -Math.sin(angle) + 36);
      tile.height = Math.ceil(textWidth * -Math.sin(angle) + textHeight * Math.cos(angle) + 36);
      if (tile.width > width || tile.height > height)
        throw Object.assign(error('WATERMARK_CONTENT_UNRENDERABLE', 'The complete supplied watermark does not fit this visual surface'),
          { renderSizeUnsupported: true });
      ink.translate(tile.width / 2, tile.height / 2);
      ink.rotate(angle);
      ink.font = font;
      ink.textAlign = 'center';
      ink.textBaseline = 'middle';
      ink.lineWidth = 1.5;
      ink.strokeStyle = 'rgba(0,0,0,0.55)';
      ink.fillStyle = color;
      for (let index = 0; index < lines.length; ++index) {
        const y = (index - (lines.length - 1) / 2) * lineHeight;
        ink.strokeText(lines[index], 0, y);
        ink.fillText(lines[index], 0, y);
      }
      // Read only our generated glyphs, never meeting pixels or media.
      const pixels = ink.getImageData(0, 0, tile.width, tile.height).data;
      let hasInk = false;
      for (let index = 3; index < pixels.length; index += 4) if (pixels[index]) { hasInk = true; break; }
      if (!hasInk) throw error('WATERMARK_CONTENT_UNRENDERABLE', 'The supplied watermark has no renderable glyphs');
      const pattern = context.createPattern(tile, 'repeat');
      if (!pattern) throw error('WATERMARK_CANVAS_UNAVAILABLE', 'The browser could not create the rendered watermark pattern');
      patterns.set(context, { revision, width, height, pattern });
      return pattern;
    }
    function paintPixels(context, width, height) {
      if (!context || !context.canvas || context.canvas.width !== width || context.canvas.height !== height ||
          !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 ||
          typeof context.fillRect !== 'function' || typeof context.createPattern !== 'function' ||
          typeof context.isContextLost === 'function' && context.isContextLost())
        throw error('WATERMARK_CANVAS_UNAVAILABLE', 'A live, owned, full-size 2D canvas is required', 'local-recording-video');
      const pattern = buildPattern(context, width, height);
      context.save();
      try {
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.globalAlpha = 1;
        context.globalCompositeOperation = 'source-over';
        context.filter = 'none';
        context.shadowColor = 'transparent';
        context.fillStyle = pattern;
        context.fillRect(0, 0, width, height);
      } finally { context.restore(); }
    }
    function mount(element) {
      if (overlays.has(element)) return overlays.get(element);
      const canvas = document.createElement('canvas');
      canvas.setAttribute('aria-hidden', 'true');
      canvas.style.cssText = OVERLAY_STYLE;
      const context = canvas.getContext('2d');
      if (!context) throw error('WATERMARK_CANVAS_UNAVAILABLE', 'The meeting watermark canvas could not be created');
      const item = { canvas, context, style: canvas.style.cssText, revision: -1 };
      canvas.addEventListener('contextlost', () => {
        if (enabled && overlays.get(element) === item) lose(error('WATERMARK_CONTEXT_LOST', 'The meeting watermark canvas lost its drawing context'));
      });
      overlays.set(element, item);
      element.appendChild(canvas);
      resizeAndPaint(item);
      return item;
    }
    function resizeAndPaint(item, force = false) {
      const width = Math.ceil(window.innerWidth), height = Math.ceil(window.innerHeight);
      if (!force && item.canvas.width === width && item.canvas.height === height && item.revision === revision) return;
      if (item.canvas.width !== width) item.canvas.width = width;
      if (item.canvas.height !== height) item.canvas.height = height;
      item.context.clearRect(0, 0, width, height);
      paintPixels(item.context, width, height);
      item.revision = revision;
    }
    function removeOverlays() {
      for (const item of overlays.values()) item.canvas.remove();
      overlays.clear();
      pendingFullscreen = null;
    }
    function guardMedia() {
      for (const [video, value] of mediaHints) if (!video.isConnected || video.ownerDocument !== document) {
        if (video.disablePictureInPicture === true) video.disablePictureInPicture = value.pip;
        if (video.disableRemotePlayback === true) video.disableRemotePlayback = value.remote;
        mediaHints.delete(video);
      }
      for (const video of document.querySelectorAll('video')) {
        const pip = 'disablePictureInPicture' in video, remote = 'disableRemotePlayback' in video;
        if (!pip && (document.pictureInPictureEnabled || typeof video.requestPictureInPicture === 'function') || !remote && video.remote)
          throw error('WATERMARK_GUARD_UNAVAILABLE', 'Native media playback surfaces cannot be disabled in this browser');
        if (!mediaHints.has(video)) {
          mediaHints.set(video, { pip: video.disablePictureInPicture, remote: video.disableRemotePlayback });
          if (pip) video.disablePictureInPicture = true;
          if (remote) video.disableRemotePlayback = true;
        }
        if (pip && !video.disablePictureInPicture || remote && !video.disableRemotePlayback || video.controls ||
            video.webkitDisplayingFullscreen || video.webkitPresentationMode && video.webkitPresentationMode !== 'inline' ||
            video.remote && video.remote.state !== 'disconnected')
          throw error('WATERMARK_UNSUPPORTED_SURFACE', 'Native media controls, fullscreen, PiP and remote playback cannot carry this watermark');
      }
    }
    function restoreMedia() {
      for (const [video, value] of mediaHints) {
        if (video.disablePictureInPicture === true) video.disablePictureInPicture = value.pip;
        if (video.disableRemotePlayback === true) video.disableRemotePlayback = value.remote;
      }
      mediaHints.clear();
    }
    function check() {
      if (document.documentElement !== root) throw error('WATERMARK_DOCUMENT_REPLACED', 'The guarded meeting document was replaced');
      if (guardFailure) throw guardFailure;
      for (const patch of patches) if (patch.target[patch.name] !== patch.wrapper)
        throw error('WATERMARK_GUARD_LOST', 'A required browser surface guard was replaced');
      if (document.pictureInPictureElement || window.documentPictureInPicture && window.documentPictureInPicture.window ||
          document.querySelector('dialog[open]') || typeof HTMLElement.prototype.showPopover === 'function' && document.querySelector(':popover-open'))
        throw error('WATERMARK_UNSUPPORTED_SURFACE', 'An unprotected native top-layer or picture-in-picture surface is open');
      if (document.querySelector('iframe,object,embed,audio[controls]'))
        throw error('WATERMARK_UNSUPPORTED_SURFACE', 'Secondary documents and native playback controls are outside the enforced meeting surface');
      guardMedia();
      const fullscreen = fullscreenElement(), host = fullscreen || root;
      if (!overlays.has(host)) throw error('WATERMARK_UNGUARDED_FULLSCREEN', 'Fullscreen bypassed the guarded container entry');
      for (const [element, item] of overlays) {
        if (!element.isConnected || item.canvas.parentNode !== element || item.canvas.style.cssText !== item.style ||
            typeof item.context.isContextLost === 'function' && item.context.isContextLost())
          throw error('WATERMARK_OVERLAY_LOST', 'The mounted meeting watermark was removed or changed');
        // Ordinary vendor portals may append siblings. Move our already-rendered
        // overlay above them in the same mutation checkpoint, before rendering.
        if (element.lastElementChild !== item.canvas) element.appendChild(item.canvas);
        resizeAndPaint(item);
      }
      const item = overlays.get(host), bounds = item.canvas.getBoundingClientRect();
      const style = window.getComputedStyle(item.canvas);
      if (style.display !== 'block' || style.visibility !== 'visible' || Number(style.opacity) !== 1 ||
          style.position !== 'fixed' || style.zIndex !== '2147483647' || style.transform !== 'none' || style.filter !== 'none' ||
          bounds.left > 0.5 || bounds.top > 0.5 || bounds.right < window.innerWidth - 0.5 || bounds.bottom < window.innerHeight - 0.5)
        throw error('WATERMARK_OVERLAY_OBSCURED', 'The watermark no longer covers the actual meeting viewport');
      for (let element = host; element; element = element.parentElement) {
        const ancestor = window.getComputedStyle(element);
        if (ancestor.display === 'none' || ancestor.visibility !== 'visible' || Number(ancestor.opacity) !== 1 ||
            ancestor.transform !== 'none' || ancestor.filter !== 'none' || ancestor.perspective !== 'none' ||
            ancestor.clipPath && ancestor.clipPath !== 'none' || ancestor.mixBlendMode !== 'normal')
          throw error('WATERMARK_OVERLAY_OBSCURED', 'A containing surface prevents reliable watermark rendering');
      }
    }
    function verify() {
      if (!configured || !enabled || disposed || failure) return;
      try { check(); } catch (cause) { lose(cause); }
    }
    function tick() {
      frame = null;
      verify();
      if (configured && enabled && !disposed && !failure) frame = requestAnimationFrame(tick);
    }
    function ensure(scope) {
      if (!SCOPES.has(scope)) throw error('WATERMARK_SCOPE_UNKNOWN', 'Unknown watermark enforcement scope', scope);
      if (disposed) throw error('WATERMARK_DISPOSED', 'Watermark policy has been disposed', scope);
      if (failure) throw failure;
      if (!configured) throw error('WATERMARK_POLICY_UNKNOWN', 'An explicit authoritative watermark policy is required', scope);
      if (enabled) {
        if (scope !== 'meeting-ui' && scope !== 'local-recording-video' && scope !== 'render-snapshot')
          throw error('WATERMARK_SCOPE_UNAVAILABLE', 'The enabled visual watermark cannot be enforced for ' + scope, scope);
        try { check(); } catch (cause) { throw lose(cause); }
      }
      return Object.freeze({ scope, revision, enabled, ready: true,
        enforcement: !enabled ? 'explicitly-disabled' : scope === 'meeting-ui' ? 'rendered-document' : 'paint-required-on-every-frame' });
    }
    function paint(context, width, height) {
      const approval = ensure('local-recording-video');
      if (approval.enabled) {
        try { paintPixels(context, width, height); } catch (cause) { throw lose(cause); }
      }
      return Object.freeze({ revision, enabled, painted: enabled });
    }
    // Export-only preflight. A small requested tile is not a failure of the
    // actual meeting watermark. Use the identical complete glyph pattern and
    // policy revision; all non-fit failures keep the existing fail-closed latch.
    function prepareSnapshot(context, width, height) {
      const approval = ensure('render-snapshot');
      if (approval.enabled) {
        try { buildPattern(context, width, height); }
        catch (cause) {
          if (cause.renderSizeUnsupported === true) throw cause;
          throw lose(cause);
        }
      }
      return Object.freeze({ revision, enabled, ready: true, scope: 'render-snapshot' });
    }
    function paintSnapshot(context, width, height) {
      const approval = ensure('render-snapshot');
      if (approval.enabled) {
        try { paintPixels(context, width, height); } catch (cause) { throw lose(cause); }
      }
      return Object.freeze({ revision, enabled, painted: enabled, scope: 'render-snapshot' });
    }
    function patch(target, name, create) {
      if (!target || typeof target[name] !== 'function') return;
      let holder = target;
      while (holder && !Object.prototype.hasOwnProperty.call(holder, name)) holder = Object.getPrototypeOf(holder);
      if (!holder || patches.some(value => value.target === holder && value.name === name)) return;
      const descriptor = Object.getOwnPropertyDescriptor(holder, name), original = holder[name];
      const wrapper = create(original);
      Object.defineProperty(holder, name, { ...descriptor, value: wrapper });
      if (holder[name] !== wrapper) throw error('WATERMARK_GUARD_UNAVAILABLE', 'The browser surface cannot be guarded: ' + name);
      patches.push({ target: holder, name, descriptor, wrapper });
    }
    function guarded() { return !disposed && (!configured || enabled || !!failure); }
    function rejectSurface(scope) {
      throw lose(error('WATERMARK_SCOPE_UNAVAILABLE', 'The required watermark cannot cover this browser surface: ' + scope, scope));
    }
    function enterFullscreen(original) {
      return function guardedFullscreen(...args) {
        if (!guarded()) return Reflect.apply(original, this, args);
        try {
          ensure('meeting-ui');
          if (!(this instanceof HTMLElement) || this.ownerDocument !== document || !this.isConnected || !CONTAINERS.has(this.tagName))
            rejectSurface('fullscreen-video');
          if (pendingFullscreen && pendingFullscreen !== this)
            throw error('WATERMARK_FULLSCREEN_PENDING', 'Another guarded fullscreen transition is in progress');
          pendingFullscreen = this;
          mount(this); // Already painted BEFORE the browser promotes the container.
          const result = Reflect.apply(original, this, args);
          return Promise.resolve(result).then(value => { fullscreenChanged(); ensure('meeting-ui'); return value; }, cause => {
            pendingFullscreen = null;
            fullscreenChanged();
            throw cause;
          });
        } catch (cause) { return Promise.reject(cause); }
      };
    }
    function fullscreenChanged() {
      if (!configured || !enabled || failure || disposed) return;
      const active = fullscreenElement();
      if (active) pendingFullscreen = null;
      for (const [element, item] of overlays) if (element !== root && element !== active &&
          element !== pendingFullscreen && !element.matches(':fullscreen')) {
        overlays.delete(element);
        item.canvas.remove();
      }
      verify();
    }
    function blockEvent(event) {
      if (!guarded()) return;
      const target = event.target instanceof Element ? event.target : null;
      const link = target && target.closest('a[target],area[target],form[target]');
      const external = link && !['', '_self'].includes(link.getAttribute('target').toLowerCase());
      const unsupported = event.type === 'beforetoggle' ? event.newState === 'open' && target && target.hasAttribute('popover') :
        event.type === 'enterpictureinpicture' || event.type === 'beforeprint' || external ||
        target && target.closest('select,[popovertarget]');
      if (event.type === 'contextmenu') { event.preventDefault(); return; }
      if (!unsupported) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      lose(error('WATERMARK_SCOPE_UNAVAILABLE', 'An unsupported native or separate-window surface was requested', 'native-ui'));
      if (document.pictureInPictureElement && typeof document.exitPictureInPicture === 'function')
        document.exitPictureInPicture().catch(() => {});
    }
    function configure(policy) {
      if (disposed) throw error('WATERMARK_DISPOSED', 'Watermark policy has been disposed');
      ++revision;
      try {
        if (!policy || typeof policy.content !== 'string' || policy.content !== '' && !COLORS.has(policy.color))
          throw error('WATERMARK_POLICY_INVALID', 'Authoritative content and a supported tenant color are required');
        if (policy.content !== '' && (!policy.content.trim() || policy.content.length > 4096))
          throw error('WATERMARK_CONTENT_UNRENDERABLE', 'The supplied watermark cannot be rendered completely');
        content = policy.content;
        color = content === '' ? null : policy.color;
        enabled = content !== '';
        configured = true;
        failure = null;
        patterns = new WeakMap();
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null;
        removeOverlays();
        restoreMedia();
        unblank();
        if (enabled) {
          if (!observer || typeof window.requestAnimationFrame !== 'function')
            throw error('WATERMARK_MONITOR_UNAVAILABLE', 'Continuous document enforcement is unavailable');
          mount(root);
          const fullscreen = fullscreenElement();
          if (fullscreen) {
            if (!(fullscreen instanceof HTMLElement) || !CONTAINERS.has(fullscreen.tagName))
              throw error('WATERMARK_UNSUPPORTED_SURFACE', 'An unsupported fullscreen surface is already open');
            mount(fullscreen);
          }
          check();
          frame = requestAnimationFrame(tick);
        }
        broadcast();
        if (failure) throw failure; // A synchronous policy consumer may reject it.
        return state();
      } catch (cause) { throw lose(cause); }
    }
    function subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('Watermark listener must be a function');
      if (disposed) throw error('WATERMARK_DISPOSED', 'Watermark policy has been disposed');
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
    function dispose() {
      if (disposed) return;
      disposed = true;
      broadcast();
      if (frame !== null) cancelAnimationFrame(frame);
      if (observer) observer.disconnect();
      for (const type of ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange'])
        document.removeEventListener(type, fullscreenChanged, true);
      for (const type of ['click', 'auxclick', 'submit', 'beforetoggle', 'enterpictureinpicture', 'contextmenu'])
        document.removeEventListener(type, blockEvent, true);
      window.removeEventListener('resize', verify);
      window.removeEventListener('beforeprint', blockEvent, true);
      for (const value of patches.reverse()) if (value.target[value.name] === value.wrapper)
        Object.defineProperty(value.target, value.name, value.descriptor);
      removeOverlays();
      restoreMedia();
      unblank();
      listeners.clear();
      if (owner === token) owner = null;
    }

    blank();
    try {
      for (const name of FULLSCREEN_METHODS) patch(Element.prototype, name, enterFullscreen);
      for (const name of ['requestPictureInPicture', 'webkitEnterFullscreen', 'webkitEnterFullScreen'])
        patch(window.HTMLVideoElement && HTMLVideoElement.prototype, name, original => function (...args) {
          if (!guarded()) return Reflect.apply(original, this, args);
          try { rejectSurface(name === 'requestPictureInPicture' ? 'picture-in-picture' : 'fullscreen-video'); }
          catch (cause) { return Promise.reject(cause); }
        });
      patch(window.HTMLVideoElement && HTMLVideoElement.prototype, 'webkitSetPresentationMode', original => function (mode, ...args) {
        if (guarded() && mode !== 'inline') rejectSurface('picture-in-picture');
        return Reflect.apply(original, this, [mode, ...args]);
      });
      patch(window.documentPictureInPicture, 'requestWindow', original => function (...args) {
        if (!guarded()) return Reflect.apply(original, this, args);
        try { rejectSurface('picture-in-picture'); } catch (cause) { return Promise.reject(cause); }
      });
      for (const name of ['open', 'print', 'alert', 'confirm', 'prompt']) patch(window, name, original => function (...args) {
        if (guarded()) rejectSurface(name === 'open' ? 'popup' : 'native-ui');
        return Reflect.apply(original, this, args);
      });
      for (const [prototype, name] of [[window.HTMLDialogElement && HTMLDialogElement.prototype, 'showModal'],
        [HTMLElement.prototype, 'showPopover'], [HTMLElement.prototype, 'togglePopover']])
        patch(prototype, name, original => function (...args) {
          if (guarded()) rejectSurface('native-ui');
          return Reflect.apply(original, this, args);
        });
      observer = new MutationObserver(records => {
        if (failure || !configured) { blank(); return; }
        if (!enabled || disposed) return;
        try {
          // Even assigning the same canvas width/height clears its bitmap.
          // Repaint in this mutation checkpoint, without another attribute write.
          for (const item of overlays.values()) if (records.some(record => record.target === item.canvas &&
              (record.attributeName === 'width' || record.attributeName === 'height')))
            resizeAndPaint(item, true);
          check();
        } catch (cause) { lose(cause); }
      });
      observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    } catch (cause) { guardFailure = error('WATERMARK_GUARD_UNAVAILABLE', cause.message); }
    for (const type of ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange'])
      document.addEventListener(type, fullscreenChanged, true);
    for (const type of ['click', 'auxclick', 'submit', 'beforetoggle', 'enterpictureinpicture', 'contextmenu'])
      document.addEventListener(type, blockEvent, true);
    window.addEventListener('resize', verify);
    window.addEventListener('beforeprint', blockEvent, true);
    return Object.freeze({ configure, state, ensure, paint, paintSnapshot, prepareSnapshot, subscribe, dispose });
  };
})();
