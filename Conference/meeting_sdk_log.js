'use strict';

/* Linux host sink for the pinned HRTC 1.10.96 logger, not an Electron log.
 * module.exports = { SdkMediaLog }; all methods are synchronous and await-safe.
 *
 * configure(absoluteDirectory): only a canonical absolute .../conference/HwmSdk
 * destination. Existing ancestors are opened one component at a time with
 * O_NOFOLLOW; only the final conference/HwmSdk components may be created. The
 * final directory must be owned by the effective user and mode 0700. Output
 * must be an owned, single-link, mode-0600 regular file. No chmod of preexisting
 * paths, symlink following, truncating opens, or path-bearing error receipts.
 *
 * Success: {ok:true,catalog:1,configured:true,changed:boolean,retiredClosed:true,
 *           maxBytes:1048576}. Failure: {ok:false,code,configured:boolean,
 *           changed:boolean,retiredClosed:boolean}. Invalid/unopenable new
 * destinations leave the old output active. A close error AFTER a successful
 * switch reports changed:true instead of pretending the switch was rolled back.
 *
 * write({catalog:1,batch:positiveSafeInteger,events:[1..catalogueSize,...]}):
 * at most 64 finite catalogue IDs, no other fields. Only host-owned literals
 * and host write timestamps reach disk. The SDK call's dynamic data never does.
 * Success: {ok:true,catalog:1,batch,accepted:count,rotated:boolean} after fsync.
 * Failure: {ok:false,code,catalog:1,batch,accepted:0,committed:boolean,
 *           partial:boolean}. No receipt contains an output path or OS error.
 * Invalid batches report batch:0; failed writes are NOT successful flushes.
 *
 * hrtc.log is capped at 1 MiB with atomic single-generation rollover (no archive).
 * The reserved .hrtc.log.next is written/fsynced before replacing the current
 * file. A pre-rename error keeps the old file and FD untouched. At most two
 * 1-MiB files exist transiently; a safe stale staging file is removed at configure.
 * Append failures try to roll back only this batch; partial:true reports failure
 * to do so. committed:true denotes a renamed batch whose directory-sync/retired-
 * FD-close failed, NOT confirmed persistence. The runtime must not retry such
 * failures silently. All writes/configures/closes run in invocation order.
 *
 * Parent: flush the page controller before switching destinations, dispose it
 * before close(), and route directories from the trusted campus frame only.
 * close(): {ok:true,closed:true} or {ok:false,code:'SDK_LOG_CLOSE_FAILED',closed:false}.
 * The sink is terminal after close; repeated close returns its original receipt.
 */
const fs = require('fs');
const path = require('path');
const catalogue = require('./meeting_sdk_log_catalog');

const MAX_BYTES = 1024 * 1024;
const OUTPUT = 'hrtc.log';
const STAGING = '.hrtc.log.next';
const DIRECTORY_FLAGS = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
const OUTPUT_FLAGS = fs.constants.O_WRONLY | fs.constants.O_APPEND |
  fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
const CREATE_FLAGS = OUTPUT_FLAGS | fs.constants.O_CREAT | fs.constants.O_EXCL;
const UID = typeof process.geteuid === 'function' ? process.geteuid() : -1;
const lines = catalogue.events.map(entry =>
  ` [HRTC ${catalogue.sdkVersion}] [${entry.severity}] [event:${entry.id}] ${entry.text}\n`);

class LogError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function reject(code) { throw new LogError(code); }
function codeOf(error, fallback) { return error instanceof LogError ? error.code : fallback; }
function relativeTo(fd, name) { return `/proc/self/fd/${fd}/${name}`; }
function sameNode(left, right) { return left.dev === right.dev && left.ino === right.ino; }

function closeFd(fd) {
  if (fd === null || fd === undefined) return true;
  try { fs.closeSync(fd); return true; } catch (_) { return false; }
}

function release(active) {
  if (!active) return true;
  const file = closeFd(active.fd);
  const directory = closeFd(active.directoryFd);
  active.fd = null;
  active.directoryFd = null;
  return file && directory;
}

function checkDirectory(stat, final) {
  if (!stat.isDirectory() || stat.nlink < 1) reject('SDK_LOG_UNSAFE_DIRECTORY');
  if (final) {
    if (stat.uid !== UID || (stat.mode & 0o7777) !== 0o700) reject('SDK_LOG_UNSAFE_DIRECTORY');
  } else if ((stat.uid !== UID && stat.uid !== 0) ||
      ((stat.mode & 0o022) !== 0 && !(stat.uid === 0 && (stat.mode & 0o1000) !== 0))) {
    // Root-owned sticky /tmp is allowed. Untrusted writable ancestors are not.
    reject('SDK_LOG_UNSAFE_DIRECTORY');
  }
}

function checkFile(stat) {
  if (!stat.isFile() || stat.uid !== UID || stat.nlink !== 1 ||
      (stat.mode & 0o7777) !== 0o600 || !Number.isSafeInteger(stat.size) ||
      stat.size < 0 || stat.size > MAX_BYTES) reject('SDK_LOG_UNSAFE_FILE');
}

function openDirectory(directory) {
  if (typeof directory !== 'string' || directory.length === 0 || directory.includes('\0') ||
      Buffer.byteLength(directory) >= 4096 || !path.isAbsolute(directory) ||
      path.normalize(directory) !== directory || path.basename(directory) !== 'HwmSdk' ||
      path.basename(path.dirname(directory)) !== 'conference') reject('SDK_LOG_INVALID_DIRECTORY');
  const parts = directory.slice(1).split('/');
  let fd = null;
  try {
    fd = fs.openSync('/', DIRECTORY_FLAGS);
    for (let index = 0; index < parts.length; ++index) {
      checkDirectory(fs.fstatSync(fd), false);
      const name = relativeTo(fd, parts[index]);
      let child;
      try { child = fs.openSync(name, DIRECTORY_FLAGS); }
      catch (error) {
        if (error.code !== 'ENOENT' || index < parts.length - 2) throw error;
        try { fs.mkdirSync(name, { mode: 0o700 }); }
        catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw mkdirError; }
        child = fs.openSync(name, DIRECTORY_FLAGS);
      }
      const parent = fd;
      fd = child;
      if (!closeFd(parent)) reject('SDK_LOG_CLOSE_FAILED');
    }
    const stat = fs.fstatSync(fd);
    checkDirectory(stat, true);
    return { directoryFd: fd, directoryNode: stat };
  } catch (error) {
    closeFd(fd);
    throw error;
  }
}

function checkNamedFile(directoryFd, name, fd) {
  const actual = fs.fstatSync(fd);
  const named = fs.lstatSync(relativeTo(directoryFd, name));
  checkFile(actual);
  checkFile(named);
  if (!sameNode(actual, named)) reject('SDK_LOG_UNSAFE_FILE');
  return actual;
}

function checkActive(active) {
  const directory = fs.fstatSync(active.directoryFd);
  checkDirectory(directory, true);
  if (!sameNode(directory, active.directoryNode)) reject('SDK_LOG_UNSAFE_DIRECTORY');
  const file = checkNamedFile(active.directoryFd, OUTPUT, active.fd);
  if (!sameNode(file, active.fileNode)) reject('SDK_LOG_UNSAFE_FILE');
  return file;
}

function removeStaleStage(directoryFd) {
  const filename = relativeTo(directoryFd, STAGING);
  let stat;
  try { stat = fs.lstatSync(filename); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  // Never follow/remove an unsafe preexisting staging link or special file.
  checkFile(stat);
  fs.unlinkSync(filename);
}

function openOutput(directory) {
  const active = openDirectory(directory);
  active.fd = null;
  let created = false;
  try {
    const filename = relativeTo(active.directoryFd, OUTPUT);
    try { active.fd = fs.openSync(filename, CREATE_FLAGS, 0o600); created = true; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      active.fd = fs.openSync(filename, OUTPUT_FLAGS);
    }
    active.fileNode = checkNamedFile(active.directoryFd, OUTPUT, active.fd);
    removeStaleStage(active.directoryFd);
    fs.fsyncSync(active.fd);
    if (created) fs.fsyncSync(active.directoryFd);
    return active;
  } catch (error) {
    release(active);
    throw error;
  }
}

function validateBatch(batch) {
  if (!batch || typeof batch !== 'object' || Array.isArray(batch)) return null;
  const fields = Object.getOwnPropertyDescriptors(batch);
  if (Reflect.ownKeys(fields).length !== 3 || !fields.catalog || !fields.batch || !fields.events ||
      !Object.prototype.hasOwnProperty.call(fields.catalog, 'value') ||
      !Object.prototype.hasOwnProperty.call(fields.batch, 'value') ||
      !Object.prototype.hasOwnProperty.call(fields.events, 'value') ||
      fields.catalog.value !== catalogue.version || !Number.isSafeInteger(fields.batch.value) ||
      fields.batch.value < 1) return null;
  const events = fields.events.value;
  if (!Array.isArray(events) || events.length < 1 || events.length > catalogue.batchLimit) return null;
  const entries = Object.getOwnPropertyDescriptors(events);
  if (Reflect.ownKeys(entries).length !== events.length + 1) return null;
  const codes = [];
  for (let index = 0; index < events.length; ++index) {
    const entry = entries[index];
    if (!entry || !Object.prototype.hasOwnProperty.call(entry, 'value') ||
        !Number.isInteger(entry.value) || entry.value < 1 || entry.value > lines.length) return null;
    codes.push(entry.value);
  }
  return { number: fields.batch.value, codes };
}

function writeAll(fd, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const written = fs.writeSync(fd, buffer, offset, buffer.length - offset, null);
    if (written <= 0) reject('SDK_LOG_WRITE_FAILED');
    offset += written;
  }
}

function writeFailure(batch, code, committed = false, partial = false) {
  return { ok: false, code, catalog: catalogue.version, batch, accepted: 0, committed, partial };
}

class SdkMediaLog {
  constructor() {
    this.active = null;
    this.closed = false;
    this.closeReceipt = null;
  }

  configure(directory) {
    const failed = code => ({ ok: false, code, configured: !!this.active,
      changed: false, retiredClosed: true });
    if (this.closed) return failed('SDK_LOG_CLOSED');
    if (process.platform !== 'linux' || UID < 0 || !fs.constants.O_NOFOLLOW || !fs.constants.O_DIRECTORY)
      return failed('SDK_LOG_PLATFORM');
    let candidate;
    try { candidate = openOutput(directory); }
    catch (error) { return failed(codeOf(error, 'SDK_LOG_OPEN_FAILED')); }
    if (this.active && sameNode(this.active.directoryNode, candidate.directoryNode) &&
        sameNode(this.active.fileNode, candidate.fileNode)) {
      if (!release(candidate)) return failed('SDK_LOG_CLOSE_FAILED');
      return { ok: true, catalog: catalogue.version, configured: true,
        changed: false, retiredClosed: true, maxBytes: MAX_BYTES };
    }
    const previous = this.active;
    this.active = candidate;
    const retiredClosed = release(previous);
    if (!retiredClosed) return { ok: false, code: 'SDK_LOG_CLOSE_FAILED', configured: true,
      changed: true, retiredClosed: false };
    return { ok: true, catalog: catalogue.version, configured: true,
      changed: true, retiredClosed: true, maxBytes: MAX_BYTES };
  }

  write(batch) {
    let decoded;
    try { decoded = validateBatch(batch); } catch (_) { decoded = null; }
    if (!decoded) return writeFailure(0, 'SDK_LOG_INVALID_BATCH');
    if (this.closed) return writeFailure(decoded.number, 'SDK_LOG_CLOSED');
    if (!this.active) return writeFailure(decoded.number, 'SDK_LOG_NOT_CONFIGURED');
    const timestamp = new Date().toISOString();
    const buffer = Buffer.from(decoded.codes.map(id => timestamp + lines[id - 1]).join(''), 'utf8');
    let before;
    try { before = checkActive(this.active).size; }
    catch (error) { return writeFailure(decoded.number, codeOf(error, 'SDK_LOG_WRITE_FAILED')); }
    if (before + buffer.length > MAX_BYTES) return this.rotate(decoded, buffer);
    try {
      writeAll(this.active.fd, buffer);
      fs.fsyncSync(this.active.fd);
      return { ok: true, catalog: catalogue.version, batch: decoded.number,
        accepted: decoded.codes.length, rotated: false };
    } catch (error) {
      let partial = true;
      try {
        checkActive(this.active);
        fs.ftruncateSync(this.active.fd, before);
        fs.fsyncSync(this.active.fd);
        partial = false;
      } catch (_) { /* The failure receipt explicitly reports uncertain partial output. */ }
      return writeFailure(decoded.number, codeOf(error, 'SDK_LOG_WRITE_FAILED'), false, partial);
    }
  }

  rotate(decoded, buffer) {
    const active = this.active;
    let fd = null;
    let stageNode = null;
    let committed = false;
    let retiredClosed = true;
    let errorCode = null;
    try {
      fd = fs.openSync(relativeTo(active.directoryFd, STAGING), CREATE_FLAGS, 0o600);
      stageNode = checkNamedFile(active.directoryFd, STAGING, fd);
      writeAll(fd, buffer);
      fs.fsyncSync(fd);
      checkActive(active);
      stageNode = checkNamedFile(active.directoryFd, STAGING, fd);
      // Unlike rename-current-then-open, this atomic replacement cannot strand
      // the live FD under a different name if staging or rename fails.
      fs.renameSync(relativeTo(active.directoryFd, STAGING), relativeTo(active.directoryFd, OUTPUT));
      committed = true;
      const previous = active.fd;
      active.fd = fd;
      active.fileNode = stageNode;
      fd = null;
      try { fs.fsyncSync(active.directoryFd); }
      finally { retiredClosed = closeFd(previous); }
    } catch (error) {
      errorCode = codeOf(error, 'SDK_LOG_ROTATE_FAILED');
    } finally {
      if (fd !== null) {
        // Only remove a staging inode created by this operation. Never unlink
        // an EEXIST occupant or a replacement link installed by somebody else.
        try {
          // Revalidate the open FD against the name even if the initial stat
          // failed before stageNode was recorded.
          checkNamedFile(active.directoryFd, STAGING, fd);
          fs.unlinkSync(relativeTo(active.directoryFd, STAGING));
        } catch (_) { /* Leave unverifiable paths untouched. */ }
        if (!closeFd(fd) && !errorCode) errorCode = 'SDK_LOG_CLOSE_FAILED';
      }
    }
    if (!retiredClosed && !errorCode) errorCode = 'SDK_LOG_CLOSE_FAILED';
    if (errorCode) return writeFailure(decoded.number, errorCode, committed);
    return { ok: true, catalog: catalogue.version, batch: decoded.number,
      accepted: decoded.codes.length, rotated: true };
  }

  close() {
    if (this.closeReceipt) return this.closeReceipt;
    this.closed = true;
    const closed = release(this.active);
    this.active = null;
    this.closeReceipt = closed ? { ok: true, closed: true } :
      { ok: false, code: 'SDK_LOG_CLOSE_FAILED', closed: false };
    return this.closeReceipt;
  }
}

module.exports = { SdkMediaLog };
