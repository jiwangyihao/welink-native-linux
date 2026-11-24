'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { pathToFileURL } = require('url');

const PAGE = path.join(__dirname, 'meeting_voice_recorder.html');
const PRELOAD = path.join(__dirname, 'meeting_voice_recorder_preload.js');
const PAGE_URL = pathToFileURL(PAGE).href;
const PREFIX = 'welink-native-voice-recorder-';
const RECORD_BYTES = 2384;
const SAMPLE_RATE = 16000;
const MIN_SAMPLES = 5 * SAMPLE_RATE;
const MAX_SAMPLES = 10 * SAMPLE_RATE;
const HEADER_BYTES = 48;
const MAGIC = Buffer.from('WLVOICE1', 'ascii');
const DIR_FLAGS = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
const READ_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
const CREATE_FLAGS = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
const uid = process.getuid();

function fault(code) { const error = new Error(code); error.code = code; return error; }
function failed(error, fields = {}) { return { ok: false, error, ...fields }; }
// Keep the child process's stderr private. Its exit codes come from meeting_voice_worker.c.
function enrollmentExitError(code) {
  switch (code) {
    case 65: return 'VOICE_ENROLLMENT_REJECTED';
    case 69: case 126: case 127: return 'VOICE_WORKER_UNAVAILABLE';
    case 78: return 'VOICE_MODEL_UNAVAILABLE';
    default: return 'VOICE_ENROLLMENT_FAILED';
  }
}
const enrollmentErrors = new Set(['VOICE_CAPTURE_RETIRED', 'VOICE_OPERATION_RETIRED',
  'VOICE_ENROLLMENT_REJECTED', 'VOICE_MODEL_UNAVAILABLE', 'VOICE_WORKER_UNAVAILABLE', 'VOICE_WORKER_TIMEOUT']);
function fdPath(handle, name = '') { return '/proc/self/fd/' + handle.fd + (name ? '/' + name : ''); }
function privateFile(stat) {
  return stat.isFile() && stat.uid === uid && (stat.mode & 0o777) === 0o600 && stat.nlink === 1;
}
function requirePrivateFile(stat) {
  if (!privateFile(stat)) throw fault('VOICE_STORAGE_UNSAFE');
}
function stateExists(file) {
  try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function stopConfirmed(value) {
  return value !== false && !(value && (value.ok === false || value.stopped === false || value.voiceShieldDisabled === false));
}
function promptsFrom(value) {
  if (!value || !Array.isArray(value.readingTextList) || value.readingTextList.length > 128)
    throw fault('VOICE_PROMPTS_INVALID');
  return value.readingTextList.map(item => {
    if (!item || typeof item !== 'object' || typeof item.title !== 'string' ||
        typeof item.content !== 'string' || item.title.length > 1024 || item.content.length > 32768 ||
        !((typeof item.language === 'string' && item.language.length <= 128) ||
          (typeof item.language === 'number' && Number.isFinite(item.language))))
      throw fault('VOICE_PROMPTS_INVALID');
    return { title: item.title, content: item.content, language: item.language };
  });
}

/**
 * Main-process-only enrollment owner. The trusted campus command router owns
 * account authentication and statement presentation. No PCM or voiceprint is
 * returned to that router or to a renderer. onEnrolled may rebind protection to
 * an existing meeting capture, but must never acquire a microphone.
 *
 * All mutations have an epoch. Revocation invalidates memory, closes the local
 * document and calls stopUplink synchronously, before its first await. Storage
 * work is serialized, and the final check + rename + in-memory commit contains
 * no await; a retired enrollment cannot commit behind an account switch.
 */
class VoiceHost {
  constructor({ electron, appRoot, profileDir, getParent, stopUplink, onEnrolled, anonymousRoom, onRevoke }) {
    if (!electron || typeof electron.BrowserWindow !== 'function' || !electron.ipcMain ||
        typeof electron.ipcMain.handle !== 'function' || typeof getParent !== 'function' ||
        typeof stopUplink !== 'function' || (onEnrolled !== undefined && typeof onEnrolled !== 'function') ||
        typeof appRoot !== 'string' || !path.isAbsolute(appRoot) || appRoot.includes('\0') ||
        typeof profileDir !== 'string' || !path.isAbsolute(profileDir) || profileDir.includes('\0'))
      throw new TypeError('A local Electron host, profile, account owner and uplink stopper are required');
    this.electron = electron;
    this.appRoot = path.resolve(appRoot);
    this.modelDir = path.join(this.appRoot, 'plugin', 'conference', 'HwmSdk', 'mmrModel');
    this.profileDir = path.resolve(profileDir);
    this.getParent = getParent;
    this.stopUplink = stopUplink;
    this.onEnrolled = onEnrolled;
    // Anonymous identity is an unexported room-lifetime object, never an account
    // name/hash, origin-wide guest record, or disk-storage key.
    if (anonymousRoom !== undefined && (!anonymousRoom || typeof anonymousRoom !== 'object'))
      throw new TypeError('Anonymous enrollment requires a dedicated room owner');
    this._anonymous = anonymousRoom || null;
    this.onRevoke = onRevoke;
    this._owner = this._anonymous;
    this._epoch = 0;
    this._released = false;
    this._granted = false;
    this._record = null;
    this._suspended = false;
    this._prompts = this._anonymous ? [{
      title: '本次匿名会议 / This anonymous meeting', language: 'zh-CN / en-US',
      content: '这是我为本次匿名会议录制的声音。我会用自然的语速连续朗读，声纹只在本机本次会议中使用。\nThis is my voice for this anonymous meeting. I am reading naturally. My voiceprint stays on this device for this meeting only.'
    }] : [];
    this._recorder = null;
    this._workers = new Set();
    this._windows = new Set();
    this._revoked = new Set();
    this._tail = Promise.resolve();
  }

  _enqueue(work) {
    const pending = this._tail.then(work);
    this._tail = pending.catch(() => {});
    return pending;
  }

  _current(epoch, owner) { return !this._released && this._epoch === epoch && this._owner === owner; }
  _forgetRecord() { if (this._record) this._record.fill(0); this._record = null; }
  _replaceRecord(record) { this._forgetRecord(); this._record = record ? Buffer.from(record) : null; }

  hasEnrollment() {
    if (this._released || !this._owner || !this._granted || this._suspended ||
        !this._record || this._record.length !== RECORD_BYTES || this._workers.size) return false;
    for (const recorder of this._windows) if (!recorder.current()) return false;
    return true;
  }

  recordForFilter() { return this.hasEnrollment() ? Buffer.from(this._record) : null; }

  _stopUplink() {
    try { return Promise.resolve(this.stopUplink()).then(stopConfirmed, () => false); }
    catch (_) { return Promise.resolve(false); }
  }

  _retire(stopUplink) {
    ++this._epoch;
    this._suspended = false;
    const recorder = this._recorder;
    this._recorder = null;
    if (recorder) recorder.freeze();
    // These calls happen before a public operation yields, including revoke.
    const uplink = stopUplink ? this._stopUplink() : Promise.resolve(true);
    const windows = Array.from(this._windows, item => item.close());
    const workers = Array.from(this._workers, item => item.cancel());
    return Promise.all([uplink, Promise.all(windows), Promise.all(workers)]).then(([disabled, closed, stopped]) => ({
      voiceShieldDisabled: disabled,
      recorderClosed: closed.every(Boolean),
      workerStopped: stopped.every(Boolean)
    }));
  }

  capabilities() {
    if (!this._probe) {
      const worker = path.join(this.appRoot, 'native', 'lib', 'welink-voice-worker');
      this._probe = new Promise(resolve => {
        execFile(worker, ['capabilities', this.modelDir], { cwd: this.appRoot, timeout: 2000, maxBuffer: 1024,
          killSignal: 'SIGKILL', encoding: 'utf8' }, (error, stdout) => {
          let caps;
          try { if (!error) caps = JSON.parse(stdout); } catch (_) { /* Unreadable means unavailable. */ }
          resolve(caps?.version === 1 && typeof caps.enroll === 'boolean' && typeof caps.filter === 'boolean'
            ? { enroll: caps.enroll, filter: caps.filter } : { enroll: false, filter: false });
        });
      }).finally(() => { this._probe = null; });
    }
    return this._probe;
  }

  _cleanupOK(cleanup) { return cleanup.voiceShieldDisabled && cleanup.recorderClosed && cleanup.workerStopped; }

  async configure(value) {
    if (this._released) return failed('VOICE_OWNER_RELEASED', { promptsStored: false, promptCount: 0 });
    let prompts;
    try { prompts = promptsFrom(value); }
    catch (_) { return failed('VOICE_PROMPTS_INVALID', { promptsStored: false, promptCount: this._prompts.length }); }
    const cleanup = this._retire(false);
    const epoch = this._epoch, owner = this._owner;
    this._prompts = prompts;
    return this._enqueue(async () => {
      const result = await cleanup;
      if (!this._current(epoch, owner)) return failed('VOICE_OPERATION_RETIRED', { promptsStored: false, promptCount: this._prompts.length });
      if (!this._cleanupOK(result)) return failed('VOICE_CLEANUP_FAILED', { promptsStored: true, promptCount: prompts.length,
        recorderClosed: result.recorderClosed, workerStopped: result.workerStopped });
      return { ok: true, promptsStored: true, promptCount: prompts.length };
    });
  }

  async bind(account) {
    if (this._released) return failed('VOICE_OWNER_RELEASED', { bound: false });
    if (this._anonymous) return failed('VOICE_ANONYMOUS_ACCOUNT_FORBIDDEN', { bound: false });
    if (account !== null && account !== undefined && typeof account !== 'string')
      return failed('VOICE_ACCOUNT_INVALID', { bound: false });
    const owner = account ? crypto.createHash('sha256').update('welink-native-local-voice\0').update(account, 'utf8').digest('hex') : null;
    this._granted = false;
    this._forgetRecord();
    const cleanup = this._retire(true);
    this._owner = owner;
    const epoch = this._epoch;
    return this._enqueue(async () => {
      const result = await cleanup;
      if (!this._current(epoch, owner)) return failed('VOICE_OPERATION_RETIRED', { bound: false });
      if (!this._cleanupOK(result)) return failed('VOICE_CLEANUP_FAILED', { bound: !!owner, isAgreed: false, enrolled: false, ...result });
      if (!owner) return { ok: true, bound: false, isAgreed: false, enrolled: false };
      let loaded;
      try { loaded = this._revoked.has(owner) ? null : await this._loadState(owner); }
      catch (_) { return failed('VOICE_STORAGE_FAILED', { bound: true, isAgreed: false, enrolled: false }); }
      if (!this._current(epoch, owner)) {
        if (loaded && loaded.record) loaded.record.fill(0);
        return failed('VOICE_OPERATION_RETIRED', { bound: false });
      }
      if (loaded) { this._granted = true; this._replaceRecord(loaded.record); if (loaded.record) loaded.record.fill(0); }
      return { ok: true, bound: true, isAgreed: this._granted, enrolled: this.hasEnrollment() };
    });
  }

  async agree(value) {
    // A service/API call is not anonymous biometric consent. Only this host's
    // scriptless recorder can accept the displayed local statement.
    if (value === true && this._anonymous) return failed('VOICE_LOCAL_CONSENT_REQUIRED', { consentUpdated: false, isAgreed: this._granted });
    if (typeof value !== 'boolean') return failed('VOICE_CONSENT_INVALID', { consentUpdated: false, isAgreed: this._granted });
    if (this._released) return failed('VOICE_OWNER_RELEASED', { consentUpdated: false, isAgreed: false });
    const owner = this._owner;
    if (!value) {
      this._granted = false;
      this._forgetRecord();
      if (owner && !this._anonymous) this._revoked.add(owner);
      const cleanup = this._retire(true);
      // Deletion is not conditional on cleanup succeeding, nor on the old owner
      // still being current. A later bind must not resurrect a failed revoke.
      return this._enqueue(async () => {
        let deleted = !owner;
        try { if (owner) { await this._deleteState(owner); deleted = true; } } catch (_) {}
        const result = await cleanup;
        const stopped = this._cleanupOK(result);
        const receipt = {
          consentUpdated: deleted, isAgreed: false, voiceprintDeleted: deleted, grantDeleted: deleted,
          deletionFailed: !deleted, cleanupFailed: !stopped, ...result
        };
        if (!deleted || !stopped) return failed(!deleted ? (stopped ? 'VOICE_DELETE_FAILED' : 'VOICE_DELETE_AND_DISABLE_FAILED') : 'VOICE_DISABLE_FAILED', receipt);
        return { ok: true, ...receipt };
      });
    }
    if (!owner) return failed('VOICE_ACCOUNT_REQUIRED', { consentUpdated: false, isAgreed: false });
    const previous = this._granted && this._record ? Buffer.from(this._record) : null;
    this._granted = false;
    const cleanup = this._retire(true);
    const epoch = this._epoch;
    return this._enqueue(async () => {
      try {
        const result = await cleanup;
        const receipt = { consentUpdated: false, isAgreed: false, voiceprintDeleted: false, grantDeleted: false, ...result };
        if (!this._current(epoch, owner)) return failed('VOICE_OPERATION_RETIRED', receipt);
        if (!this._cleanupOK(result)) return failed('VOICE_DISABLE_FAILED', receipt);
        await this._storeState(owner, previous, () => this._current(epoch, owner), () => {
          this._granted = true;
          this._replaceRecord(previous);
          this._revoked.delete(owner);
        });
        if (!this._current(epoch, owner)) return failed('VOICE_OPERATION_RETIRED', receipt);
        return { ok: true, ...receipt, consentUpdated: true, isAgreed: true };
      } catch (error) {
        return failed(error.code === 'VOICE_OPERATION_RETIRED' ? error.code : 'VOICE_STORAGE_FAILED', {
          consentUpdated: false, isAgreed: this._current(epoch, owner) && this._granted,
          voiceprintDeleted: false, grantDeleted: false, voiceShieldDisabled: true
        });
      } finally { if (previous) previous.fill(0); }
    });
  }

  async show(visible, requestRevision) {
    if (typeof visible !== 'boolean') return failed('VOICE_VISIBILITY_INVALID', { visible: false, recordingStarted: false });
    if (this._released) return failed('VOICE_OWNER_RELEASED', { visible: false, recordingStarted: false });
    if (!visible) {
      const cleanup = this._retire(false);
      return this._enqueue(async () => {
        const result = await cleanup;
        return { ok: this._cleanupOK(result), ...(!this._cleanupOK(result) ? { error: 'VOICE_CLEANUP_FAILED' } : {}),
          visible: Array.from(this._windows).some(item => item.visible()), recordingStarted: false,
          recorderClosed: result.recorderClosed, workerStopped: result.workerStopped };
      });
    }
    if (this._anonymous && (!Number.isSafeInteger(requestRevision) || requestRevision < 1))
      return failed('VOICE_REQUEST_RETIRED', { visible: false, recordingStarted: false });
    const epoch = this._epoch, owner = this._owner;
    if (!owner) return failed('VOICE_ACCOUNT_REQUIRED', { visible: false, recordingStarted: false });
    return this._enqueue(async () => {
      if (!this._current(epoch, owner)) return failed('VOICE_OPERATION_RETIRED', { visible: false, recordingStarted: false });
      if (this._recorder) return { ok: true, visible: this._recorder.visible(), recordingStarted: false };
      if (this._windows.size || this._workers.size) return failed('VOICE_CLEANUP_FAILED', { visible: false, recordingStarted: false });
      try { return await this._openRecorder(epoch, owner, requestRevision); }
      catch (_) { return failed('VOICE_WINDOW_FAILED', { visible: false, recordingStarted: false }); }
    });
  }

  async release() {
    this._released = true;
    this._granted = false;
    this._forgetRecord();
    this._owner = null;
    this._prompts = [];
    const cleanup = this._retire(true);
    return this._enqueue(async () => {
      const result = await cleanup;
      return { ok: this._cleanupOK(result), released: true,
        ...(!this._cleanupOK(result) ? { error: 'VOICE_CLEANUP_FAILED' } : {}), ...result };
    });
  }

  async _accountDirectory(owner, create) {
    if (!/^[a-f0-9]{64}$/.test(owner)) throw fault('VOICE_STORAGE_UNSAFE');
    let current = await fs.promises.open('/', DIR_FLAGS);
    try {
      // Open one component at a time through a pinned directory descriptor.
      // Neither a profile ancestor nor an account entry may be a symlink.
      for (const component of this.profileDir.split('/').filter(Boolean)) {
        const next = await fs.promises.open(fdPath(current, component), DIR_FLAGS);
        await current.close(); current = next;
      }
      const profile = await current.stat();
      if (!profile.isDirectory() || profile.uid !== uid || (profile.mode & 0o022)) throw fault('VOICE_STORAGE_UNSAFE');
      for (const component of ['native-voice-enrollment', owner]) {
        if (create) {
          try { await fs.promises.mkdir(fdPath(current, component), { mode: 0o700 }); }
          catch (error) { if (error.code !== 'EEXIST') throw error; }
        }
        const next = await fs.promises.open(fdPath(current, component), DIR_FLAGS);
        await current.close(); current = next;
        const stat = await current.stat();
        if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o777) !== 0o700) throw fault('VOICE_STORAGE_UNSAFE');
      }
      return current;
    } catch (error) { await current.close().catch(() => {}); throw error; }
  }

  async _loadState(owner) {
    let directory;
    try { directory = await this._accountDirectory(owner, false); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    let file, data;
    try {
      const denied = stateExists(fdPath(directory, 'revoked'));
      if (denied) { requirePrivateFile(denied); if (denied.size !== 0) throw fault('VOICE_STORAGE_UNSAFE'); return null; }
      try { file = await fs.promises.open(fdPath(directory, 'state'), READ_FLAGS); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      const stat = await file.stat(); requirePrivateFile(stat);
      if (stat.size !== HEADER_BYTES && stat.size !== HEADER_BYTES + RECORD_BYTES) throw fault('VOICE_RECORD_INVALID');
      data = await file.readFile();
      if (data.length !== stat.size || !data.subarray(0, 8).equals(MAGIC) ||
          data.subarray(8, 40).toString('hex') !== owner || data[40] > 1 ||
          data.length !== HEADER_BYTES + data[40] * RECORD_BYTES || data.subarray(41, HEADER_BYTES).some(byte => byte !== 0))
        throw fault('VOICE_RECORD_INVALID');
      return { record: data[40] ? Buffer.from(data.subarray(HEADER_BYTES)) : null };
    } finally {
      if (data) data.fill(0);
      try { if (file) await file.close(); } finally { await directory.close(); }
    }
  }

  async _storeState(owner, record, current, apply) {
    if (this._anonymous) {
      if (owner !== this._anonymous || !current()) throw fault('VOICE_OPERATION_RETIRED');
      apply(); // Memory only; there is deliberately no anonymous storage path.
      return;
    }
    const directory = await this._accountDirectory(owner, true);
    const temporary = 'state.new-' + crypto.randomBytes(16).toString('hex');
    const temporaryPath = fdPath(directory, temporary), statePath = fdPath(directory, 'state');
    const data = Buffer.alloc(HEADER_BYTES + (record ? RECORD_BYTES : 0));
    MAGIC.copy(data); Buffer.from(owner, 'hex').copy(data, 8); data[40] = record ? 1 : 0;
    if (record) record.copy(data, HEADER_BYTES);
    let file, committed = false;
    try {
      file = await fs.promises.open(temporaryPath, CREATE_FLAGS, 0o600);
      await file.chmod(0o600);
      await file.writeFile(data);
      await file.sync();
      const written = await file.stat(); requirePrivateFile(written);
      if (!current()) throw fault('VOICE_OPERATION_RETIRED');
      const present = fs.lstatSync(temporaryPath);
      if (present.ino !== written.ino || present.dev !== written.dev || !privateFile(present)) throw fault('VOICE_STORAGE_UNSAFE');
      const previous = stateExists(statePath); if (previous) requirePrivateFile(previous);
      const deniedPath = fdPath(directory, 'revoked'), denied = stateExists(deniedPath);
      if (denied) { requirePrivateFile(denied); if (denied.size !== 0) throw fault('VOICE_STORAGE_UNSAFE'); }
      // This short synchronous section is the transaction's linearization
      // point. An asynchronous rename would let a stale owner win a revoke.
      fs.renameSync(temporaryPath, statePath);
      committed = true;
      if (denied) fs.unlinkSync(deniedPath);
      fs.fsyncSync(directory.fd);
      apply();
    } catch (error) {
      if (committed) {
        try { fs.unlinkSync(statePath); fs.fsyncSync(directory.fd); } catch (_) {}
      }
      throw error;
    } finally {
      data.fill(0);
      try { if (file) await file.close(); } finally {
        try {
          try { await fs.promises.unlink(temporaryPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        } finally { await directory.close(); }
      }
    }
  }

  async _deleteState(owner) {
    if (this._anonymous) return; // agree(false)/release already zeroed all memory.
    const directory = await this._accountDirectory(owner, true);
    let denial;
    try {
      // A deny marker prevents a failed deletion from being mistaken for an
      // existing grant after restart. A later explicit agreement removes it.
      try {
        try { denial = await fs.promises.open(fdPath(directory, 'revoked'), CREATE_FLAGS, 0o600); }
        catch (error) { if (error.code !== 'EEXIST') throw error; denial = await fs.promises.open(fdPath(directory, 'revoked'), READ_FLAGS); }
        const stat = await denial.stat(); requirePrivateFile(stat);
        if (stat.size !== 0) throw fault('VOICE_STORAGE_UNSAFE');
        await denial.sync();
      } catch (_) { /* Still attempt all record deletions if the marker failed. */ }
      let deletionFailed = false;
      const names = fs.readdirSync(fdPath(directory)).filter(name => name === 'state' || /^state\.new-[a-f0-9]{32}$/.test(name));
      for (const name of names) {
        try { fs.unlinkSync(fdPath(directory, name)); }
        catch (error) { if (error.code !== 'ENOENT') deletionFailed = true; }
      }
      try { fs.fsyncSync(directory.fd); } catch (_) { deletionFailed = true; }
      if (fs.readdirSync(fdPath(directory)).some(name => name === 'state' || /^state\.new-[a-f0-9]{32}$/.test(name))) deletionFailed = true;
      if (deletionFailed) throw fault('VOICE_DELETE_FAILED');
    } finally { try { if (denial) await denial.close(); } finally { await directory.close(); } }
  }

  _dismiss(recorder) {
    if (this._recorder !== recorder) return;
    const cleanup = this._retire(false);
    this._enqueue(() => cleanup).catch(() => {});
  }

  _openRecorder(epoch, owner, requestRevision) {
    const parent = this.getParent();
    if (!parent || parent.isDestroyed()) throw fault('VOICE_WINDOW_FAILED');
    const parentContents = parent.webContents, parentFrame = parentContents.mainFrame;
    if (parentContents.isDestroyed() || !parentFrame) throw fault('VOICE_WINDOW_FAILED');
    const parentProcess = parentFrame.processId, parentRouting = parentFrame.routingId;
    const nonce = crypto.randomBytes(16).toString('hex'), channel = PREFIX + nonce;
    const documentURL = PAGE_URL + '#' + nonce;
    let window, contents, frame, frameProcess, frameRouting, navigationStarted = false, shown = false;
    let frozen = false, settled = false, resolveReady, closePending;
    const listeners = [];
    const ready = new Promise(resolve => { resolveReady = resolve; });
    const settle = receipt => { if (!settled) { settled = true; resolveReady(receipt); } };
    const listen = (target, name, handler) => {
      target.on(name, handler); listeners.push(() => target.removeListener(name, handler));
    };
    const currentOwner = () => {
      try {
        return !frozen && this._recorder === recorder && this._current(epoch, owner) &&
          this.getParent() === parent && !parent.isDestroyed() && parent.webContents === parentContents &&
          !parentContents.isDestroyed() && parentContents.mainFrame === parentFrame &&
          parentFrame.processId === parentProcess && parentFrame.routingId === parentRouting;
      } catch (_) { return false; }
    };
    const currentDocument = () => {
      try {
        return currentOwner() && !!frame && !window.isDestroyed() && !contents.isDestroyed() &&
          contents.mainFrame === frame && frame.processId === frameProcess && frame.routingId === frameRouting &&
          frame.url === documentURL && contents.getURL() === documentURL;
      } catch (_) { return false; }
    };
    const visible = () => { try { return !!window && !window.isDestroyed() && window.isVisible() && !window.isMinimized(); } catch (_) { return false; } };
    const microphoneAllowed = () => currentDocument() && visible() && this._granted &&
      !!recorder.capture && recorder.capture.phase === 'armed' && Date.now() <= recorder.capture.permissionUntil;
    const denySession = () => {
      if (!contents) return;
      const session = contents.session;
      try { session.setPermissionCheckHandler(() => false); } catch (_) {}
      try { session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false)); } catch (_) {}
      try { session.webRequest.onBeforeRequest((_request, callback) => callback({ cancel: true })); } catch (_) {}
    };
    const freeze = () => {
      if (frozen) return;
      frozen = true;
      if (recorder.timer) clearTimeout(recorder.timer);
      recorder.timer = null;
      denySession();
      try { this.electron.ipcMain.removeHandler(channel); } catch (_) {}
      for (const remove of listeners.splice(0)) { try { remove(); } catch (_) {} }
      try { if (contents && !contents.isDestroyed()) contents.send(channel, { kind: 'retired' }); } catch (_) {}
      settle(failed('VOICE_OPERATION_RETIRED', { visible: false, recordingStarted: false }));
    };
    const close = () => {
      freeze();
      if (closePending) return closePending;
      closePending = new Promise(resolve => {
        let done = false, timer;
        const finish = stopped => {
          if (done) return; done = true; clearTimeout(timer);
          try { if (window) window.removeListener('closed', closed); } catch (_) {}
          try { if (contents) contents.removeListener('destroyed', destroyed); } catch (_) {}
          if (stopped) this._windows.delete(recorder);
          resolve(stopped);
        };
        const confirmed = () => (!window || window.isDestroyed()) && (!contents || contents.isDestroyed());
        const closed = () => { if (confirmed()) finish(true); };
        const destroyed = () => { if (confirmed()) finish(true); };
        timer = setTimeout(() => finish(confirmed()), 2000);
        timer.unref();
        try {
          if (window) window.on('closed', closed);
          if (contents) contents.on('destroyed', destroyed);
          if (window && !window.isDestroyed()) window.destroy();
          if (confirmed()) finish(true);
        } catch (_) { finish(false); }
      });
      const pending = closePending;
      pending.then(stopped => { if (!stopped && closePending === pending) closePending = null; });
      return pending;
    };
    const recorder = { epoch, owner, requestRevision, channel, capture: null, timer: null, freeze, close, visible,
      current: currentDocument, send: value => { if (currentDocument()) contents.send(channel, value); } };
    this._recorder = recorder;
    this._windows.add(recorder);
    const cancel = () => this._dismiss(recorder);
    const denyNavigation = event => { event.preventDefault(); cancel(); };
    try {
      window = new this.electron.BrowserWindow({
        width: 600, height: 600, minWidth: 420, minHeight: 460, title: '本地声纹录制', parent,
        modal: false, show: false, alwaysOnTop: false, fullscreenable: false, maximizable: false,
        webPreferences: {
          preload: PRELOAD, additionalArguments: ['--welink-voice-recorder=' + nonce], partition: channel,
          sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false,
          nodeIntegrationInSubFrames: false, webSecurity: true, allowRunningInsecureContent: false,
          webviewTag: false, devTools: false, spellcheck: false, autoplayPolicy: 'user-gesture-required'
        }
      });
      window.setMenu(null); contents = window.webContents;
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      const session = contents.session;
      session.setPermissionCheckHandler((requester, permission, _origin, details = {}) =>
        requester === contents && permission === 'media' && details.mediaType === 'audio' &&
        details.isMainFrame !== false && microphoneAllowed());
      session.setPermissionRequestHandler((requester, permission, callback, details = {}) => {
        const allowed = requester === contents && permission === 'media' && details.isMainFrame === true &&
          (details.requestingUrl === PAGE_URL || details.requestingUrl === documentURL) &&
          Array.isArray(details.mediaTypes) && details.mediaTypes.length === 1 && details.mediaTypes[0] === 'audio' &&
          microphoneAllowed() && !recorder.capture.permissionUsed;
        if (allowed) recorder.capture.permissionUsed = true;
        callback(allowed);
      });
      if (typeof session.setDevicePermissionHandler === 'function') session.setDevicePermissionHandler(() => false);
      if (typeof session.setDisplayMediaRequestHandler === 'function') session.setDisplayMediaRequestHandler((_request, callback) => callback({}));
      session.webRequest.onBeforeRequest((request, callback) => callback({
        cancel: request.webContentsId !== contents.id || request.resourceType !== 'mainFrame' ||
          (request.url !== PAGE_URL && request.url !== documentURL)
      }));
      listen(this.electron.app, 'before-quit', cancel);
      listen(parent, 'close', cancel); listen(parent, 'closed', cancel);
      listen(parentContents, 'destroyed', cancel); listen(parentContents, 'render-process-gone', cancel);
      listen(parentContents, 'did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) cancel(); });
      listen(window, 'close', event => { event.preventDefault(); cancel(); });
      listen(window, 'closed', cancel); listen(window, 'hide', cancel); listen(window, 'minimize', cancel);
      listen(contents, 'destroyed', cancel); listen(contents, 'render-process-gone', cancel); listen(contents, 'preload-error', cancel);
      listen(contents, 'will-navigate', denyNavigation); listen(contents, 'will-redirect', denyNavigation);
      listen(contents, 'will-attach-webview', denyNavigation);
      listen(contents, 'did-fail-load', (_event, _code, _description, _url, isMainFrame) => { if (isMainFrame) cancel(); });
      listen(contents, 'did-start-navigation', (_event, url, inPlace, isMainFrame) => {
        if (navigationStarted || !isMainFrame || inPlace || url !== documentURL) { cancel(); return; }
        navigationStarted = true;
      });
      this.electron.ipcMain.handle(channel, async (event, message) => {
        if (!currentDocument() || event.sender !== contents || event.senderFrame !== frame ||
            event.senderFrame !== contents.mainFrame || !message || typeof message !== 'object')
          return failed('VOICE_DOCUMENT_RETIRED');
        if (message.kind === 'ready') {
          if (!shown) {
            if (typeof window.showInactive !== 'function') { cancel(); return failed('VOICE_WINDOW_FAILED'); }
            window.showInactive(); shown = visible();
            if (!shown) { cancel(); return failed('VOICE_WINDOW_FAILED'); }
            settle({ ok: true, visible: true, recordingStarted: false });
          }
          return { ok: true };
        }
        if (message.kind === 'close') { cancel(); return { ok: true }; }
        if (message.kind === 'consent' && this._anonymous) {
          if (!visible() || (message.agreed && recorder.capture) || typeof message.agreed !== 'boolean')
            return failed('VOICE_CONSENT_INVALID');
          if (!message.agreed) return this.onRevoke ? this.onRevoke() : this.agree(false);
          this._granted = true;
          return { ok: true, consentUpdated: true, isAgreed: true, scope: 'anonymous-room-memory' };
        }
        if (message.kind === 'record') return this._beginCapture(recorder);
        const capture = recorder.capture;
        if (!capture || message.captureId !== capture.id) return failed('VOICE_CAPTURE_RETIRED');
        if (message.kind === 'started' && capture.phase === 'armed' && visible() && this._granted) {
          capture.phase = 'capturing';
          clearTimeout(recorder.timer); recorder.timer = setTimeout(cancel, 20000); recorder.timer.unref();
          return { ok: true };
        }
        if (message.kind === 'abort') {
          capture.phase = 'cancelled'; clearTimeout(recorder.timer); recorder.timer = null;
          const stopped = !capture.worker || await capture.worker.cancel();
          if (recorder.capture === capture) recorder.capture = null;
          if (currentDocument()) this._suspended = false;
          if (!stopped) { cancel(); return failed('VOICE_CLEANUP_FAILED', { workerStopped: false, recordingStarted: false }); }
          return { ok: true, workerStopped: true, recordingStarted: false };
        }
        if (message.kind === 'finish' && capture.phase === 'capturing') return this._finishCapture(recorder, capture, message);
        return failed('VOICE_CAPTURE_INVALID');
      });
      const ownerWatch = setInterval(() => {
        if (!currentOwner() || (frame && !currentDocument()) || (shown && !visible())) cancel();
      }, 250);
      ownerWatch.unref(); listeners.push(() => clearInterval(ownerWatch));
      const loadTimeout = setTimeout(cancel, 15000); loadTimeout.unref(); listeners.push(() => clearTimeout(loadTimeout));
      window.loadFile(PAGE, { hash: nonce }).then(async () => {
        if (!currentOwner()) { cancel(); return; }
        frame = contents.mainFrame; frameProcess = frame.processId; frameRouting = frame.routingId;
        if (!navigationStarted || !currentDocument()) { cancel(); return; }
        const capabilities = await this.capabilities();
        if (!currentDocument()) { cancel(); return; }
        clearTimeout(loadTimeout);
        recorder.send({ kind: 'initialize', isAgreed: this._granted, enrolled: this.hasEnrollment(),
          enrollmentAvailable: capabilities.enroll, anonymous: !!this._anonymous,
          readingTextList: this._prompts.map(item => ({ ...item })) });
      }).catch(cancel);
    } catch (_) { cancel(); }
    return ready;
  }

  _beginCapture(recorder) {
    if (!recorder.current() || !recorder.visible() || !this._granted || recorder.capture ||
        !this._prompts.some(item => item.content.trim())) return failed('VOICE_CAPTURE_NOT_ALLOWED');
    const capture = { id: crypto.randomBytes(16).toString('hex'), phase: 'preparing', permissionUntil: 0, permissionUsed: false, worker: null };
    recorder.capture = capture; this._suspended = true;
    // Replacing an existing record must first stop the old filter, even if the
    // later native enrollment fails and the old persisted record is retained.
    const stopped = this._stopUplink();
    return this._enqueue(async () => {
      const [disabled, capability] = await Promise.all([stopped, this.capabilities()]);
      if (!recorder.current() || recorder.capture !== capture || !this._granted) return failed('VOICE_CAPTURE_RETIRED');
      if (!disabled || this._workers.size) {
        recorder.capture = null; this._suspended = false;
        return failed('VOICE_DISABLE_FAILED');
      }
      if (!capability.enroll) {
        recorder.capture = null; this._suspended = false;
        return failed('VOICE_ENROLLMENT_UNAVAILABLE');
      }
      capture.phase = 'armed'; capture.permissionUntil = Date.now() + 30000;
      recorder.timer = setTimeout(() => this._dismiss(recorder), 30000); recorder.timer.unref();
      return { ok: true, captureAuthorized: true, captureId: capture.id, sampleRate: SAMPLE_RATE, maxSamples: MAX_SAMPLES };
    });
  }

  async _finishCapture(recorder, capture, message) {
    capture.phase = 'processing'; clearTimeout(recorder.timer); recorder.timer = null;
    let pcm, record;
    try {
      if (message.sampleRate !== SAMPLE_RATE || !(message.samples instanceof ArrayBuffer) ||
          message.samples.byteLength % 4 || message.samples.byteLength < MIN_SAMPLES * 4 || message.samples.byteLength > MAX_SAMPLES * 4)
        return failed('VOICE_CAPTURE_LENGTH_INVALID', { enrollmentStored: false });
      pcm = Buffer.from(message.samples);
      for (let offset = 0; offset < pcm.length; offset += 4) {
        const sample = pcm.readFloatLE(offset);
        if (!Number.isFinite(sample) || sample < -1 || sample > 1) return failed('VOICE_CAPTURE_INVALID', { enrollmentStored: false });
      }
      if (!recorder.current() || !this._granted || recorder.capture !== capture) return failed('VOICE_CAPTURE_RETIRED', { enrollmentStored: false });
      capture.worker = this._enroll(pcm);
      record = await capture.worker.result;
      return await this._enqueue(async () => {
        const current = () => recorder.current() && this._granted && recorder.capture === capture && capture.phase === 'processing';
        if (!current()) return failed('VOICE_CAPTURE_RETIRED', { enrollmentStored: false });
        await this._storeState(recorder.owner, record, current, () => { this._replaceRecord(record); this._suspended = false; });
        const receipt = { ok: true, enrollmentStored: true, enrolled: true, activationRequested: false,
          scope: this._anonymous ? 'anonymous-room-memory' : 'local-account', persisted: !this._anonymous };
        if (current() && this.onEnrolled) {
          receipt.activationRequested = true;
          try {
            const result = await this.onEnrolled(recorder.requestRevision);
            receipt.activationSucceeded = result?.enabled === true && result.armed === true;
            receipt.processing = result?.processing === true;
            if (!receipt.activationSucceeded) receipt.activationError = 'VOICE_ACTIVATION_FAILED';
          } catch (_) { receipt.activationSucceeded = false; receipt.activationError = 'VOICE_ACTIVATION_FAILED'; }
        }
        if (!current()) return failed('VOICE_CAPTURE_RETIRED', { enrollmentStored: false });
        return receipt;
      });
    } catch (error) {
      return failed(enrollmentErrors.has(error.code) ? error.code : 'VOICE_ENROLLMENT_FAILED',
        { enrollmentStored: false });
    } finally {
      if (pcm) pcm.fill(0); if (record) record.fill(0);
      if (recorder.capture === capture) recorder.capture = null;
      if (recorder.current()) this._suspended = false;
    }
  }

  _enroll(pcm) {
    const executable = path.join(this.appRoot, 'native', 'lib', 'welink-voice-worker');
    const output = Buffer.alloc(RECORD_BYTES);
    let child, length = 0, rejection = null, closed = false, timeout, killTimer, resolveClosed, resolveResult, rejectResult;
    let inputFailed = false;
    const ended = new Promise(resolve => { resolveClosed = resolve; });
    const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    // Cancellation can precede the caller attaching its await continuation.
    result.catch(() => {});
    const worker = {
      result,
      cancel: () => {
        if (closed) return Promise.resolve(true);
        rejection = rejection || 'VOICE_CAPTURE_RETIRED';
        try { child.stdin.destroy(); child.kill('SIGTERM'); } catch (_) {}
        if (!killTimer) {
          killTimer = setTimeout(() => { try { if (!closed) child.kill('SIGKILL'); } catch (_) {} }, 250);
          killTimer.unref();
        }
        return new Promise(resolve => {
          const timer = setTimeout(() => resolve(false), 2500); timer.unref();
          ended.then(() => { clearTimeout(timer); resolve(true); });
        });
      }
    };
    this._workers.add(worker);
    const finish = (code, signal) => {
      if (closed) return; closed = true;
      clearTimeout(timeout); clearTimeout(killTimer); this._workers.delete(worker);
      pcm.fill(0); resolveClosed();
      if (!rejection && !inputFailed && code === 0 && !signal && length === RECORD_BYTES) resolveResult(Buffer.from(output));
      else rejectResult(fault(rejection || enrollmentExitError(signal || length ? null : code)));
      output.fill(0);
    };
    try {
      child = spawn(executable, ['enroll', this.modelDir], { cwd: this.appRoot, stdio: ['pipe', 'pipe', 'ignore'], shell: false, windowsHide: true });
      child.once('error', () => { rejection = 'VOICE_WORKER_UNAVAILABLE'; if (!child.pid) finish(null, null); });
      child.once('close', finish);
      child.stdout.on('data', data => {
        if (length + data.length > RECORD_BYTES) { rejection ||= 'VOICE_ENROLLMENT_FAILED'; worker.cancel(); return; }
        data.copy(output, length); length += data.length;
      });
      child.stdout.on('error', () => { rejection ||= 'VOICE_ENROLLMENT_FAILED'; worker.cancel(); });
      child.stdin.on('error', error => {
        // An early model/open failure may close stdin before its exit status arrives.
        inputFailed = true;
        if (error.code !== 'EPIPE') { rejection ||= 'VOICE_ENROLLMENT_FAILED'; worker.cancel(); }
      });
      timeout = setTimeout(() => { rejection = 'VOICE_WORKER_TIMEOUT'; worker.cancel(); }, 120000); timeout.unref();
      child.stdin.end(pcm, () => pcm.fill(0));
    } catch (_) { rejection = 'VOICE_WORKER_UNAVAILABLE'; finish(null, null); }
    return worker;
  }
}

module.exports = { VoiceHost };
