'use strict';

const crypto = require('crypto');
const path = require('path');
const {spawn} = require('child_process');
const failure = (code, message = code) => Object.assign(new Error(message), {code});
function requireX11(electron) {
  if (process.platform !== 'linux') throw failure('NATIVE_PLATFORM_UNSUPPORTED', 'Native render surfaces are implemented for Linux X11');
  if (electron?.app?.commandLine?.getSwitchValue('ozone-platform') === 'wayland' || !process.env.DISPLAY && process.env.WAYLAND_DISPLAY)
    throw failure('NATIVE_WAYLAND_UNSUPPORTED', 'Native Wayland has no exportable XIDs; an actual X11/Xwayland Electron client is required');
  if (!process.env.DISPLAY) throw failure('X11_DISPLAY_UNAVAILABLE', 'No X11 display is available for native video surfaces');
}
const FORMAT = 'linux-native-render-surfaces/1';
const MAX_PIXELS = 4 * 1024 * 1024;
const PERIOD = 100;

// Separate from the note PNG path. A lease exposes watermarked media to other
// clients of the SAME X server. X11 is not a security boundary: a consumer may
// retain a named pixmap/readback after revocation. We destroy our windows and
// connection, not resources already copied into another process. Native Wayland
// deliberately has no fake XID or portal/desktop-capture fallback.
class MeetingRenderSurfaceHost {
  constructor({bridge, electron, workerPath = path.join(__dirname, 'lib', 'welink-render-surface-worker')}) {
    this.bridge = bridge; this.electron = electron; this.workerPath = workerPath;
    this.lease = null; this.worker = null; this.timer = null; this.revision = 0;
    this.startEpoch = 0;
    this.slotSequence = 0; this.slots = new Map(); this.pending = null;
    this.last = this.empty('stopped');
    this.event = message => {
      if (!this.lease) return;
      const data = message?.data;
      if (message?.event === 'policy-violation' ||
          !this.lease.offline && message?.event === 'meeting-lifecycle' && (data?.state === 'left' || data?.sessionKey !== this.lease.sessionKey) ||
          !this.lease.offline && message?.event === 'media-state' && (!data?.joined || data.sessionKey !== this.lease.sessionKey) ||
          this.lease.offline && message?.event === 'offline-conference' && (data?.type === 'snapshot-policy' && data.decision !== 'allowed' || data?.type === 'state' && data.state !== 'joined'))
        this.stop('RENDER_OWNER_OR_POLICY_RETIRED').catch(() => {});
    };
    this.bridge.on('event', this.event);
  }
  empty(status, reason = null) {
    return {interface:FORMAT, operation:'host.render.surfaces', platform:'linux', win32Abi:false,
      handleKind:'x11-window', nativeHandleSupported:false, status, reason, surfaces:[],
      filePath:'', presentation:'xcomposite-manual-redirect', captureScope:'rendered-conference-media-only',
      consumer:'XCompositeNameWindowPixmap+XGetImage', nativeWaylandSupported:false,
      limits:{maxSurfaces:16, maxEdge:4096, maxTotalPixels:MAX_PIXELS},
      visual:'24/32-depth, 32-bpp little-endian TrueColor RGB888'};
  }
  currentWindow() { return this.bridge.offline?.active?.view?.window || this.bridge.window; }
  check(lease) {
    const window = lease?.window;
    if (!lease || this.lease !== lease || this.bridge.disposed || this.bridge.retiring || this.bridge.loggingOut ||
        this.currentWindow() !== window || !window || window.isDestroyed() || window.webContents.isDestroyed() ||
        window.webContents.getURL() !== lease.url)
      throw failure('RENDER_LEASE_RETIRED', 'The conference document no longer owns these native surfaces');
    if (!window.isVisible() || window.isMinimized()) throw failure('RENDER_WINDOW_HIDDEN', 'Native export requires a visible meeting window');
  }
  expected(lease) { return {sessionKey:lease.sessionKey, conferenceId:lease.conferenceId, policyRevision:lease.policyRevision, requireCapture:true}; }
  emit() {
    this.bridge.emit('event', {protocol:'welink-native-web/1', instance:this.bridge.instance,
      event:'render-surfaces-changed', data:this.last});
    const view = this.bridge.offline?.active?.view;
    if (view?.live() && view.renderSurfaceOwner === this)
      view.request('render.surface.status', this.last).catch(() => {});
  }
  reserveStart() {
    const epoch = ++this.startEpoch;
    return Object.freeze({assertCurrent:() => {
      if (epoch !== this.startEpoch || this.bridge.disposed || this.bridge.retiring || this.bridge.loggingOut)
        throw failure('RENDER_START_CANCELLED', 'The pending native-video consent or start was cancelled');
    }});
  }
  async start(expected, reservation = this.reserveStart()) {
    reservation.assertCurrent();
    const retiring = this.stop('RENDER_LEASE_REPLACED', true);
    await retiring;
    reservation.assertCurrent();
    requireX11(this.electron);
    const window = this.currentWindow();
    if (!window || window.isDestroyed()) throw failure('NOT_IN_CONFERENCE');
    const inspected = await this.bridge.renderForHost('render.surface.inspect', {...expected, requireCapture:true});
    reservation.assertCurrent();
    const handle = window.getNativeWindowHandle();
    if (!Buffer.isBuffer(handle) || handle.length < 4 || handle.length > 8 || handle.subarray(4).some(byte => byte !== 0) || !handle.readUInt32LE(0))
      throw failure('NOT_AN_X11_WINDOW', 'Electron did not return an X11 client window ID');
    const lease = this.lease = {leaseId:crypto.randomUUID(), window, url:window.webContents.getURL(),
      sessionKey:inspected.sessionKey, conferenceId:inspected.conferenceId, policyRevision:inspected.policyRevision,
      parentXid:handle.readUInt32LE(0), offline:this.bridge.offline?.active?.view?.window === window, sequence:0, cleanup:[]};
    const retire = () => this.stop('RENDER_WINDOW_RETIRED').catch(() => {});
    const listen = (target, event) => { target.on(event, retire); lease.cleanup.push(() => target.removeListener(event, retire)); };
    for (const event of ['hide', 'minimize', 'closed']) listen(window, event);
    for (const event of ['render-process-gone', 'destroyed']) listen(window.webContents, event);
    const navigate = (_event, _url, inPage, main) => { if (main && !inPage) retire(); };
    window.webContents.on('did-start-navigation', navigate);
    lease.cleanup.push(() => window.webContents.removeListener('did-start-navigation', navigate));
    if (this.electron.powerMonitor) for (const event of ['lock-screen', 'suspend']) listen(this.electron.powerMonitor, event);
    if (this.bridge.offline?.active?.view) this.bridge.offline.active.view.renderSurfaceOwner = this;
    try {
      this.check(lease);
      await this.bridge.renderForHost('render.surface.open', {leaseId:lease.leaseId, ...this.expected(lease)});
      this.check(lease);
      await this.tick(lease);
      this.check(lease);
      this.schedule(lease);
      return this.last;
    } catch (error) { if (this.lease === lease) await this.stop(error.code || 'RENDER_START_FAILED'); throw error; }
  }
  schedule(lease) {
    if (this.lease !== lease) return;
    this.timer = setTimeout(async () => {
      this.timer = null;
      try { await this.tick(lease); this.schedule(lease); }
      catch (error) { if (this.lease === lease) await this.stop(error.code || 'RENDER_FRAME_FAILED'); }
    }, PERIOD);
    this.timer.unref?.();
  }
  async invalidate(contents, message) {
    const lease = this.lease;
    if (!lease || contents !== lease.window.webContents || message?.leaseId !== lease.leaseId) return {retired:true};
    if (message.reason === 'RENDER_SOURCES_CHANGED') {
      ++this.revision;
      this.last = {...this.empty('refreshing', message.reason), leaseId:lease.leaseId}; this.emit();
      await this.clearWorker(lease);
      return {retired:true};
    }
    await this.stop('RENDER_SOURCE_OR_POLICY_RETIRED');
    return {retired:true};
  }
  async startWorker(lease) {
    this.check(lease);
    if (this.worker) return this.worker.ready;
    const processHandle = spawn(this.workerPath, [String(lease.parentXid), String(process.pid)], {
      stdio:['pipe','pipe','ignore'], windowsHide:true, env:process.env
    });
    const worker = this.worker = {process:processHandle, pending:null, buffer:'', ready:null, queue:Promise.resolve()};
    worker.closed = new Promise(resolve => processHandle.once('close', resolve));
    worker.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(failure('RENDER_WORKER_TIMEOUT')), 1500);
      worker.pending = {resolve:value => {clearTimeout(timer); resolve(value);}, reject:error => {clearTimeout(timer); reject(error);}};
    });
    const abort = error => {
      worker.pending?.reject(error); worker.pending = null;
      if (this.worker === worker) this.stop(error.code || 'RENDER_WORKER_EXITED').catch(() => {});
    };
    processHandle.once('error', error => abort(failure('RENDER_WORKER_UNAVAILABLE', error.message)));
    processHandle.once('exit', () => abort(failure('RENDER_WORKER_EXITED')));
    processHandle.stdin.on('error', () => abort(failure('RENDER_WORKER_PIPE_CLOSED')));
    processHandle.stdout.on('data', chunk => {
      worker.buffer += chunk.toString('utf8');
      if (worker.buffer.length > 16384) return abort(failure('INVALID_RENDER_WORKER_REPLY'));
      let newline;
      while ((newline = worker.buffer.indexOf('\n')) !== -1) {
        const line = worker.buffer.slice(0,newline); worker.buffer = worker.buffer.slice(newline+1);
        let message;
        try { message = JSON.parse(line); } catch (_) { return abort(failure('INVALID_RENDER_WORKER_REPLY')); }
        if (message.error) return abort(failure(message.error));
        const pending = worker.pending; worker.pending = null;
        if (!pending) return abort(failure('UNEXPECTED_RENDER_WORKER_REPLY'));
        pending.resolve(message);
      }
    });
    const ready = await worker.ready;
    this.check(lease);
    if (this.worker !== worker || ready?.ready !== true || ready.parentXid !== lease.parentXid)
      throw failure('INVALID_RENDER_WORKER_REPLY');
    return ready;
  }
  async sendFrame(lease, frame, revision = this.revision) {
    await this.startWorker(lease);
    this.check(lease);
    const worker = this.worker;
    const task = worker.queue.then(() => {
      this.check(lease);
      if (this.worker !== worker || revision !== this.revision) return null;
      const bounds = lease.window.getBounds(), content = lease.window.getContentBounds();
      const scale = frame.viewport.width / content.width;
      const dx = Math.round((content.x - bounds.x) * scale), dy = Math.round((content.y - bounds.y) * scale);
      if (![dx,dy].every(n => Number.isInteger(n) && n >= 0 && n <= 4096) || !Number.isFinite(scale) || scale <= 0)
        throw failure('RENDER_GEOMETRY_UNSUPPORTED', 'The Electron content origin cannot be mapped to native pixels');
      // A menu/resize can commit after Chromium composited this frame. An
      // empty batch destroys prior XIDs without ever sending its stale pixels.
      const layoutPending = Math.abs(content.height * scale - frame.viewport.height) > 1;
      const frames = layoutPending ? [] : frame.frames;
      const chunks = [], header = Buffer.alloc(28), sequence = ++lease.sequence;
      header.writeUInt32LE(0x31535257,0); header.writeUInt32LE(sequence,4);
      header.writeUInt32LE(frames.length,8); header.writeUInt32LE(frame.viewport.width,12); header.writeUInt32LE(frame.viewport.height,16);
      header.writeUInt32LE(dx,20); header.writeUInt32LE(dy,24);
      chunks.push(header);
      for (const item of frames) {
        const key = item.target.id + '\0' + item.target.trackId;
        if (!this.slots.has(key)) this.slots.set(key, ++this.slotSequence);
        const entry = Buffer.alloc(20), b = item.bounds;
        [this.slots.get(key), b.x, b.y, b.width, b.height].forEach((value,i) => entry.writeUInt32LE(value,i*4));
        chunks.push(entry, Buffer.from(item.rgba.buffer, item.rgba.byteOffset, item.rgba.byteLength));
      }
      return new Promise((resolve,reject) => {
        const timer = setTimeout(() => { reject(failure('RENDER_WORKER_TIMEOUT')); this.releaseWorker().catch(() => {}); }, 1500);
        worker.pending = {resolve:value => {
          clearTimeout(timer);
          if (value.sequence !== sequence) return reject(failure('INVALID_RENDER_WORKER_REPLY'));
          if (layoutPending) value.layoutPending = true;
          resolve(value);
        }, reject:error => {clearTimeout(timer); reject(error);}};
        worker.process.stdin.cork();
        for (const chunk of chunks) worker.process.stdin.write(chunk);
        worker.process.stdin.uncork();
      });
    });
    worker.queue = task.catch(() => {});
    return task;
  }
  async clearWorker(lease) {
    if (!this.worker || !this.viewport) { this.slots.clear(); return; }
    // Keep the X connection alive on track replacement. X resource IDs are then
    // monotonically allocated instead of reusing the retired client's ID base.
    const task = this.sendFrame(lease, {frames:[], viewport:this.viewport});
    this.clearing = task;
    try { await task; this.slots.clear(); }
    finally { if (this.clearing === task) this.clearing = null; }
  }
  validateFrame(lease, frame) {
    if (!frame || frame.leaseId !== lease.leaseId || frame.sessionKey !== lease.sessionKey || frame.conferenceId !== lease.conferenceId ||
        frame.policyRevision !== lease.policyRevision || !Array.isArray(frame.frames) || frame.frames.length > 16 ||
        !frame.viewport || ![frame.viewport.width,frame.viewport.height].every(n => Number.isInteger(n) && n > 0 && n <= 32767))
      throw failure('INVALID_NATIVE_RENDER_FRAME');
    let pixels = 0;
    const keys = new Set();
    for (const item of frame.frames) {
      const b = item?.bounds, target = item?.target;
      if (!b || !target || typeof target.id !== 'string' || typeof target.trackId !== 'string' ||
          ![b.x,b.y,b.width,b.height].every(Number.isInteger) || b.x < 0 || b.y < 0 || b.width < 1 || b.height < 1 ||
          b.width > 4096 || b.height > 4096 || b.x + b.width > frame.viewport.width || b.y + b.height > frame.viewport.height ||
          (pixels += b.width*b.height) > MAX_PIXELS || !ArrayBuffer.isView(item.rgba) || item.rgba.byteLength !== b.width*b.height*4 ||
          item.watermark?.revision !== lease.policyRevision || item.watermark?.enabled !== frame.watermark?.enabled ||
          frame.watermark?.enabled && item.watermark?.painted !== true)
        throw failure('INVALID_NATIVE_RENDER_FRAME');
      const key = target.id + '\0' + target.trackId;
      if (keys.has(key)) throw failure('INVALID_NATIVE_RENDER_FRAME'); keys.add(key);
    }
    return keys;
  }
  async tick(lease) {
    if (this.pending) return this.pending;
    const revision = this.revision;
    const task = (async () => {
      this.check(lease);
      if (this.clearing) await this.clearing;
      const frame = await this.bridge.renderForHost('render.surface.frame', {leaseId:lease.leaseId, ...this.expected(lease)});
      this.check(lease);
      if (revision !== this.revision) return;
      const keys = this.validateFrame(lease, frame);
      this.viewport = frame.viewport;
      if ([...this.slots.keys()].some(key => !keys.has(key))) await this.clearWorker(lease);
      this.check(lease);
      const response = await this.sendFrame(lease, frame, revision);
      this.check(lease);
      if (revision !== this.revision || !response) return;
      if (response.layoutPending === true) {
        if (!Array.isArray(response.surfaces) || response.surfaces.length) throw failure('INVALID_RENDER_WORKER_REPLY');
        this.slots.clear();
        const now = performance.now();
        lease.layoutDeadline ??= now + 1500;
        if (now >= lease.layoutDeadline) throw failure('RENDER_GEOMETRY_UNSUPPORTED', 'Native and rendered geometry did not converge');
        if (this.last.reason !== 'RENDER_LAYOUT_CHANGED') {
          this.last = {...this.empty('refreshing', 'RENDER_LAYOUT_CHANGED'), leaseId:lease.leaseId};
          this.emit();
        }
        return;
      }
      lease.layoutDeadline = undefined;
      if (!response.contentOffset || ![response.contentOffset.x,response.contentOffset.y].every(n => Number.isInteger(n) && n >= 0 && n <= 4096) ||
          !Array.isArray(response.surfaces) || response.surfaces.length !== frame.frames.length)
        throw failure('INVALID_RENDER_WORKER_REPLY');
      const surfaces = frame.frames.map(item => {
        const slot = this.slots.get(item.target.id + '\0' + item.target.trackId);
        const native = response.surfaces.find(s => s.slot === slot);
        if (!native || !Number.isInteger(native.xid) || native.xid <= 0 || native.xid === lease.parentXid ||
            native.x !== item.bounds.x + response.contentOffset.x || native.y !== item.bounds.y + response.contentOffset.y ||
            native.width !== item.bounds.width || native.height !== item.bounds.height) throw failure('INVALID_RENDER_WORKER_REPLY');
        return {...item.target, kind:'x11-composite-window', xid:native.xid, watermark:item.watermark,
          nativeBounds:{x:native.x,y:native.y,width:native.width,height:native.height, unit:'physical-px', relativeTo:'owner-x11-client'}};
      });
      if (new Set(surfaces.map(s => s.xid)).size !== surfaces.length) throw failure('INVALID_RENDER_WORKER_REPLY');
      const changed = JSON.stringify(surfaces) !== JSON.stringify(this.last.surfaces);
      this.last = {...this.empty(surfaces.length ? 'ready' : 'no-media'), nativeHandleSupported:true,
        leaseId:lease.leaseId, sessionKey:lease.sessionKey, conferenceId:lease.conferenceId, policyRevision:lease.policyRevision,
        owner:{browserWindowId:lease.window.id, webContentsId:lease.window.webContents.id, parentXid:lease.parentXid, contentOffset:response.contentOffset},
        frameSequence:response.sequence, frameTime:Date.now(), watchdogMs:1500, frameIntervalMs:PERIOD,
        watermark:frame.watermark, surfaces, lifetime:'current-consented-document-and-live-visible-track'};
      if (changed) this.emit();
    })();
    this.pending = task;
    try { await task; }
    catch (error) {
      // A source-change invalidation destroys the old XIDs immediately; its
      // in-flight paint is intentionally retired, not a failure of the lease.
      if (this.lease !== lease || revision === this.revision) throw error;
    } finally { if (this.pending === task) this.pending = null; }
  }
  async inspect() {
    const lease = this.lease;
    if (!lease) return this.last;
    try {
      this.check(lease);
      await this.bridge.renderForHost('render.surface.inspect', this.expected(lease));
      this.check(lease);
      if (this.pending) await this.pending;
      this.check(lease);
      return this.last;
    } catch (error) { if (this.lease === lease) await this.stop(error.code || 'RENDER_LEASE_RETIRED'); throw error; }
  }
  async releaseWorker() {
    const worker = this.worker; this.worker = null; this.slots.clear();
    if (!worker) return this.workerClosing;
    worker.pending?.reject(failure('RENDER_WORKER_RETIRED')); worker.pending = null;
    worker.process.kill('SIGKILL');
    const closing = worker.closed;
    this.workerClosing = closing;
    try { await closing; } finally { if (this.workerClosing === closing) this.workerClosing = null; }
  }
  async stop(reason = 'RENDER_EXPORT_STOPPED', preserveStart = false) {
    if (!preserveStart) ++this.startEpoch;
    const lease = this.lease; this.lease = null; ++this.revision;
    this.pending = null;
    clearTimeout(this.timer); this.timer = null;
    this.last = {...this.empty('stopped', reason), ...(lease ? {leaseId:lease.leaseId} : {})};
    for (const cleanup of lease?.cleanup || []) cleanup();
    const close = this.releaseWorker();
    if (lease) {
      // Native release comes first, even if the renderer is hung or gone.
      Promise.resolve().then(() => this.bridge.renderForHost('render.surface.close', {leaseId:lease.leaseId})).catch(() => {});
    }
    await close;
    if (lease && !this.lease) this.emit();
    return this.last;
  }
}

async function nativeRenderSurfaces(record, params, {requireOwner, dialog}) {
  if (!params || Object.keys(params).some(key => !['action','conferenceId'].includes(key)) ||
      !['start','inspect','stop'].includes(params.action) || params.conferenceId !== undefined && (typeof params.conferenceId !== 'string' || !params.conferenceId))
    throw failure('INVALID_ARGUMENT', 'Native surfaces accept action:start/inspect/stop and an optional conferenceId');
  requireOwner(record);
  if (params.action !== 'start') {
    const result = await record.bridge.renderSurfacesForHost(params); requireOwner(record); return result;
  }
  requireX11(record.bridge.electron);
  if (record.renderSurfaceConsentPending) throw failure('RENDER_CONSENT_BUSY');
  record.renderSurfaceConsentPending = true;
  try {
    const reservation = record.bridge.renderSurfacesForHost({action:'reserve-start'});
    const current = () => { requireOwner(record); reservation.assertCurrent(); };
    const inspected = await record.bridge.renderForHost('render.surface.inspect', {requireCapture:true,
      ...(params.conferenceId === undefined ? {} : {conferenceId:params.conferenceId})});
    current();
    const window = record.bridge.offline?.active?.view?.window || record.bridge.window;
    if (!window || window.isDestroyed() || !window.isVisible() || window.isMinimized()) throw failure('RENDER_WINDOW_HIDDEN');
    const decision = await dialog.showMessageBox(window, {type:'warning', title:'Native conference video access',
      message:'Allow local X11 applications to read the currently visible conference video tracks?',
      detail:'This exposes live video in separate native X11 surfaces, without additional visible windows. The current authoritative watermark policy is ' +
        (inspected.watermark.enabled ? 'enabled' : 'explicitly disabled') +
        '. Other applications connected to this X server can read and retain those pixels. Access stops when this meeting is hidden, left, locked, or its privacy policy changes. This does not grant camera or screen-sharing permission, and does not save or attach a note picture.',
      buttons:['Cancel','Allow native video access'], defaultId:0, cancelId:0, noLink:true});
    current();
    if (decision.response !== 1) throw failure('RENDER_CONSENT_DENIED', 'Native video access was not approved');
    if ((record.bridge.offline?.active?.view?.window || record.bridge.window) !== window) throw failure('CONFERENCE_CHANGED');
    return await record.bridge.renderSurfacesForHost({action:'start', reservation,
      expected:{sessionKey:inspected.sessionKey, conferenceId:inspected.conferenceId, policyRevision:inspected.policyRevision}});
  } finally { record.renderSurfaceConsentPending = false; }
}
module.exports = {MeetingRenderSurfaceHost, nativeRenderSurfaces};
