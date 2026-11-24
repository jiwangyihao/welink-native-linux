'use strict';

const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { execFile } = require('child_process');
const { randomBytes } = require('crypto');
const { adapterError, requireSuccess } = require('./im_adapter_forward');
const fsp = fs.promises;
const IMAGE_DIRECTORIES = ['Audio', 'botAvatar', 'FormImage', 'headImage',
  'originalImgfiles', 'qrCodeImage', 'ScreenShot'];

function createFileMigration({ modules, check, complete, notify }) {
  let active = null;

  function progress(context, param) {
    notify(context, { notify: 331777, description: 'MIGRATIONFILE_E_EVT_PROG_RESULT', param });
  }
  function guard(job) {
    check(job.context);
    if (job.stopped) throw adapterError('File migration stopped', -1, 'ECANCELED');
  }
  async function freeSpace(directory, signal) {
    if (typeof fsp.statfs === 'function') {
      const stat = await fsp.statfs(directory, { bigint: true });
      return Number(stat.bavail * stat.bsize);
    }
    // The shipped Electron 22 embeds Node 16, which predates fs.statfs.
    // execFile uses argv (never a shell) and asks the real mounted filesystem.
    return new Promise((resolve, reject) => {
      execFile('df', ['--output=avail', '-B1', '--', directory], { encoding: 'utf8', signal }, (error, output) => {
        if (error) return reject(error);
        const value = Number(output.trim().split(/\s+/).pop());
        if (!Number.isFinite(value) || value < 0) reject(adapterError('Filesystem free-space query failed'));
        else resolve(value);
      });
    });
  }
  function receiveRoot(directory) {
    const normalized = path.resolve(directory);
    return path.basename(normalized) === 'ReceiveFiles' ? normalized : path.join(normalized, 'ReceiveFiles');
  }
  async function walk(job, directory, relative = '') {
    guard(job);
    let entries;
    try { entries = await fsp.readdir(path.join(directory, relative), { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    guard(job);
    const result = [];
    for (const entry of entries) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) result.push(...await walk(job, directory, name));
      else if (entry.isFile()) {
        const source = path.join(directory, name);
        const stat = await fsp.lstat(source);
        guard(job);
        if (stat.isFile()) result.push({ source, relative: name, stat });
      }
      // Do not traverse links into unrelated account trees. Links left by a
      // completed migration already reference the authoritative destination.
    }
    return result;
  }
  async function selectDownloadedFiles(job, entries) {
    guard(job);
    const load = modules();
    const registry = load(36067).default;
    const sqlite = registry.getInstance('sqliteService');
    if (sqlite.currentAccount !== job.context.account) throw adapterError('The account SQLite service is not initialized');
    const db = registry.getInstance('tupSqlite');
    const names = [...new Set(entries.map(entry => path.basename(entry.source)))];
    const selected = new Set();
    // ImAdapterCmd::QueryHistoryRecordByReceiveFileMsgSend: cmd 57,
    // operationtype 67, keytype 9, chunks of at most 5000 filesystem names.
    // The native query excludes deleted/withdrawn and non-file messages.
    for (let index = 0; index < names.length; index += 5000) {
      guard(job);
      const result = requireSuccess(await job.context.wait(db.queryhistoryrecord(67,
        [{ keytype: 9, match_value: names.slice(index, index + 5000) }], 1)), 'Migration SQLite query');
      guard(job);
      const rows = result.param && result.param._historyrecordlist;
      if (rows === null) continue;
      if (!Array.isArray(rows)) throw adapterError('Migration SQLite query returned no record list');
      for (const row of rows) {
        if (typeof row.showtext !== 'string') continue;
        selected.add(row.showtext);
        if (row.mediatype === load(54589).CHATCONTENTTYPE.VIDEO) selected.add(`${row.showtext}.png`);
      }
    }
    return entries.filter(entry => selected.has(path.basename(entry.source)));
  }
  async function plan(job, options) {
    const roots = options.migrationType === 0 ? IMAGE_DIRECTORIES.map(name => ({
      source: path.join(receiveRoot(options.originReceiveFilesPath), name),
      destination: path.join(receiveRoot(options.destinationReceiveFilesPath), name)
    })) : [{ source: path.resolve(options.originReceiveFilesPath), destination: path.resolve(options.destinationReceiveFilesPath) }];
    const files = [];
    let free = Infinity;
    let required = 0;
    for (const root of roots) {
      guard(job);
      if (root.source === root.destination) continue;
      if (root.destination.startsWith(`${root.source}${path.sep}`) || root.source.startsWith(`${root.destination}${path.sep}`)) {
        throw adapterError('File migration source and destination overlap');
      }
      let source;
      try { source = await fsp.realpath(root.source); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      guard(job);
      await fsp.mkdir(root.destination, { recursive: true, mode: 0o700 });
      guard(job);
      const destination = await fsp.realpath(root.destination);
      guard(job);
      if (source === destination) continue;
      if (destination.startsWith(`${source}${path.sep}`) || source.startsWith(`${destination}${path.sep}`)) {
        throw adapterError('File migration source and destination resolve to overlapping directories');
      }
      let entries = await walk(job, source);
      if (options.migrationType === 1) entries = await selectDownloadedFiles(job, entries);
      const destinationStat = await fsp.stat(destination);
      guard(job);
      for (const entry of entries) {
        files.push({ ...entry, destination: path.join(destination, entry.relative) });
        if (entry.stat.dev !== destinationStat.dev) required += entry.stat.size;
      }
      free = Math.min(free, await freeSpace(destination, job.io.signal));
      guard(job);
    }
    return { files, free, required };
  }
  function sameFile(a, b) {
    return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
  }
  async function move(job, entry) {
    guard(job);
    const before = await fsp.lstat(entry.source);
    if (!before.isFile() || !sameFile(before, entry.stat)) throw adapterError('Source file changed during migration', 16);
    const directory = path.dirname(entry.destination);
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
    guard(job);
    let created = false;
    let temporary = null;
    try {
      try {
        // link+unlink is a no-overwrite same-filesystem move. Unlike rename,
        // it cannot replace an existing destination silently.
        await fsp.link(entry.source, entry.destination);
        created = true;
      } catch (error) {
        if (error.code === 'EEXIST') return 183; // Original ERROR_ALREADY_EXISTS.
        if (error.code !== 'EXDEV') throw error;
        temporary = path.join(directory, `.welink-move-${randomBytes(16).toString('hex')}`);
        const input = fs.createReadStream(entry.source, { flags: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW });
        const output = fs.createWriteStream(temporary, { flags: 'wx', mode: before.mode & 0o777 });
        await pipeline(input, output, { signal: job.io.signal });
        guard(job);
        const copied = await fsp.stat(temporary);
        if (copied.size !== before.size) throw adapterError('Incomplete migration copy');
        await fsp.utimes(temporary, before.atime, before.mtime);
        const handle = await fsp.open(temporary, 'r');
        try { await handle.sync(); } finally { await handle.close(); }
        guard(job);
        try { await fsp.link(temporary, entry.destination); created = true; }
        catch (error) { if (error.code === 'EEXIST') return 183; throw error; }
      }
      guard(job);
      const after = await fsp.lstat(entry.source);
      if (!sameFile(before, after)) throw adapterError('Source file changed during migration', 16);
      guard(job);
      await fsp.unlink(entry.source);
      // Existing SQLite records contain absolute file paths. Preserve their
      // reachability without rewriting encrypted DBs or copying account keys.
      await fsp.symlink(entry.destination, entry.source);
      created = false;
      return 0;
    } finally {
      if (temporary) await fsp.unlink(temporary).catch(() => {});
      if (created) {
        // A cancelled/uncommitted copy still has its original source. Keep
        // the only remaining copy if unlink succeeded but linking failed.
        const sourceExists = await fsp.lstat(entry.source).then(() => true, () => false);
        if (sourceExists) await fsp.unlink(entry.destination).catch(() => {});
      }
    }
  }
  async function start(context) {
    const options = context.request.param;
    if (!options || typeof options !== 'object' ||
        !['originReceiveFilesPath', 'destinationReceiveFilesPath', 'displayAccount', 'account']
          .every(key => typeof options[key] === 'string') ||
        ![0, 1].includes(options.migrationType)) throw adapterError('param is not correct!');
    if (!context.account || options.account !== context.account) throw adapterError('Migration account does not match the active account');
    if (![options.originReceiveFilesPath, options.destinationReceiveFilesPath].every(value => path.isAbsolute(value) && !value.includes('\0'))) {
      throw adapterError('Migration requires native absolute paths');
    }
    if (active) {
      if (active.context.epoch !== context.epoch) throw adapterError('Previous file migration is stopping');
      // Original migrationFileStartup ignores a second start while running.
      complete(context, 0, null);
      return;
    }
    const job = { context, stopped: false, io: new AbortController() };
    active = job;
    const abort = () => { job.stopped = true; job.io.abort(); };
    context.signal.addEventListener('abort', abort, { once: true });
    let errorCount = 0;
    try {
      check(context);
      // Acknowledgement means a real worker has been accepted, not that files
      // have moved. Progress/status notifications carry the actual outcome.
      if (!complete(context, 0, null)) return;
      const { files, free, required } = await plan(job, options);
      if (required > free) {
        progress(context, { notifyType: 'statusNotify', status: 'failed',
          originTotalSize: (required / 1073741824).toFixed(2), freeSize: (free / 1073741824).toFixed(2) });
        return;
      }
      let count = 0;
      for (const entry of files) {
        guard(job);
        let result;
        try { result = await move(job, entry); }
        catch (error) {
          if (job.stopped || context.signal.aborted) throw error;
          result = Number.isInteger(error.result) ? error.result : Math.abs(error.errno || 1);
          ++errorCount;
        }
        ++count;
        progress(context, { notifyType: 'progressNotify', fileName: path.basename(entry.source),
          curCount: count, totalCount: files.length, percent: String(Math.floor(count * 100 / files.length)),
          result, errorType: 'move' });
      }
      progress(context, { notifyType: 'statusNotify', status: 'finish', errorCount });
    } catch (error) {
      if (!context.signal.aborted) {
        check(context);
        if (job.stopped) progress(context, { notifyType: 'statusNotify', status: 'finish', errorCount });
        else progress(context, { notifyType: 'statusNotify', status: 'finish', errorCount: errorCount + 1,
          reason: error.message });
      }
    } finally {
      context.signal.removeEventListener('abort', abort);
      if (active === job) active = null;
    }
  }
  async function stop(context) {
    check(context);
    if (active && active.context.epoch === context.epoch) {
      active.stopped = true;
      active.io.abort();
    }
    complete(context, 0, null);
  }
  return { start, stop };
}

module.exports = { createFileMigration };
