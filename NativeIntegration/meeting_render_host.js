'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const failure = (code, message) => Object.assign(new Error(message), { code });
const MAX_PNG_BYTES = 48 * 1024 * 1024;

// Uses the same owner, cancellable native file picker and dialog-default paths
// as host.window.capture, but never captures a desktop or whole webContents.
// The scoped renderer supplies only decoded conference media + its watermark.
async function captureRenderWindows(record, params, { requireOwner, renderData, dialogScope, chooseNativeFile, nativeImage }) {
  if (typeof params.isSavePic !== 'boolean') throw failure('INVALID_ARGUMENT', 'isSavePic must be a boolean');
  if (params.conferenceId !== undefined && (typeof params.conferenceId !== 'string' || !params.conferenceId))
    throw failure('INVALID_ARGUMENT', 'conferenceId must identify the requesting note conference');
  requireOwner(record);
  if (record.renderCapturePending) throw failure('RENDER_CAPTURE_BUSY', 'A conference picture request is already in progress');
  const controller = new AbortController();
  const scope = dialogScope(record, controller.signal);
  const window = record.bridge.offline?.window || record.bridge.window;
  let inspected;
  const abort = () => controller.abort();
  const currentWindow = () => record.bridge.offline?.window || record.bridge.window;
  const check = () => {
    requireOwner(record);
    if (scope.signal.aborted || !window || window.isDestroyed() || currentWindow() !== window)
      throw failure('CONFERENCE_CHANGED', 'The render window or its owner was retired');
  };
  const event = message => {
    if (!inspected) return;
    const data = message?.data;
    if (message?.event === 'policy-violation' ||
        message?.event === 'offline-conference' && data?.type === 'snapshot-policy' && data.decision !== 'allowed' ||
        message?.event === 'meeting-lifecycle' && (data?.state === 'left' || data?.sessionKey !== inspected.sessionKey) ||
        message?.event === 'media-state' && (!data?.joined || data.sessionKey !== inspected.sessionKey) ||
        message?.event === 'offline-conference' && data?.type === 'state' && data.state !== 'joined') abort();
  };
  record.renderCapturePending = true;
  record.bridge.on('event', event);
  window?.once('closed', abort);
  const inspect = async expected => {
    check();
    const value = await renderData(record, 'render.inspect', expected);
    check();
    if (!value || !value.sessionKey || !value.conferenceId || !Array.isArray(value.targets) ||
        value.nativeHandleSupported !== false || value.captureScope !== 'rendered-conference-media-only')
      throw failure('INVALID_RENDER_RECEIPT', 'No scoped conference render receipt was returned');
    if (params.isSavePic && value.localSharing !== false)
      throw failure(value.localSharing === true ? 'LOCAL_SHARING_ACTIVE' : 'LOCAL_SHARING_UNKNOWN',
        'A note picture requires a confirmed inactive local screen share');
    return value;
  };
  try {
    // A no-meeting request does not initialize an engine or open a new window.
    if (!window || window.isDestroyed()) throw failure('NOT_IN_CONFERENCE', 'No active conference render window exists');
    inspected = await inspect({ requireCapture: params.isSavePic,
      ...(params.conferenceId === undefined ? {} : { conferenceId: params.conferenceId }) });
    const owner = { platform: process.platform, kind: 'electron-webcontents-media',
      browserWindowId: window.id, webContentsId: window.webContents.id };
    const expected = { sessionKey: inspected.sessionKey, conferenceId: inspected.conferenceId,
      policyRevision: inspected.policyRevision, requireCapture: params.isSavePic };
    if (!params.isSavePic) return { ...inspected, owner, save: { requested: false, canceled: false } };
    if (!inspected.targets.length) throw failure('NO_RENDER_MEDIA', 'The active conference has no decoded visible media frame to save');
    const filename = 'meeting-picture-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex') + '.png';
    const selected = await chooseNativeFile(record, 'showSaveDialog', {
      title: 'Save conference picture for your meeting note', buttonLabel: 'Save picture and attach to note',
      defaultPath: record.paths.screenshots ? path.join(record.paths.screenshots, filename) : filename,
      filters: [{ name: 'PNG conference picture', extensions: ['png'] }], properties: ['showOverwriteConfirmation']
    }, scope.signal);
    check();
    await inspect(expected);
    if (selected.canceled) return { ...inspected, owner, status: 'canceled', filePath: '',
      save: { requested: true, canceled: true } };
    if (typeof selected.filePath !== 'string' || !path.isAbsolute(selected.filePath) || path.extname(selected.filePath).toLowerCase() !== '.png')
      throw failure('INVALID_SCREENSHOT_FILE', 'The save dialog must select a new absolute PNG filename');
    const captured = await renderData(record, 'render.capture', expected);
    check();
    if (!captured || captured.sessionKey !== expected.sessionKey || captured.conferenceId !== expected.conferenceId ||
        captured.policyRevision !== expected.policyRevision || captured.format !== 'png' ||
        typeof captured.dataUrl !== 'string' || !captured.dataUrl.startsWith('data:image/png;base64,') ||
        captured.dataUrl.length > Math.ceil(MAX_PNG_BYTES / 3) * 4 + 22)
      throw failure('INVALID_RENDER_IMAGE', 'The renderer did not return a current bounded PNG media snapshot');
    const png = Buffer.from(captured.dataUrl.slice(22), 'base64');
    if (png.length < 24 || png.length > MAX_PNG_BYTES ||
        !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        png.toString('ascii', 12, 16) !== 'IHDR')
      throw failure('INVALID_RENDER_IMAGE', 'The renderer did not return a PNG image');
    const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
    if (!width || !height || width > 4096 || height > 4096 || width * height > 8 * 1024 * 1024 ||
        width !== captured.size?.width || height !== captured.size?.height)
      throw failure('INVALID_RENDER_IMAGE', 'The returned PNG exceeds the approved image bounds');
    const image = nativeImage.createFromBuffer(png);
    const size = image.getSize();
    if (image.isEmpty() || size.width !== width || size.height !== height)
      throw failure('INVALID_RENDER_IMAGE', 'The returned PNG failed real image decoding');
    // Exclusive 0600 creation: a chosen existing file/symlink is never replaced.
    // Recheck room and policy AFTER durable write, before publishing a path. On
    // cancellation, remove only the exact inode created by this request.
    const task = (async () => {
      let file, identity, problem;
      try {
        await inspect(expected);
        file = await fs.promises.open(selected.filePath, 'wx', 0o600);
        identity = await file.stat({ bigint: true });
        if (!identity.isFile()) throw failure('INVALID_SCREENSHOT_FILE', 'The destination is not a regular file');
        check();
        await file.writeFile(png); await file.sync();
        if ((await file.stat({ bigint: true })).size !== BigInt(png.length))
          throw failure('SCREENSHOT_WRITE_INCOMPLETE', 'The saved PNG length did not match');
        await inspect(expected);
      } catch (error) { problem = error; }
      if (file) {
        try { await file.close(); }
        catch (error) { record.hostCleanupErrors.push({ code: error.code, message: error.message }); problem ||= error; }
      }
      try { check(); } catch (error) { problem ||= error; }
      if (problem && file) {
        try {
          const actual = await fs.promises.lstat(selected.filePath, { bigint: true });
          if (!identity || !actual.isFile() || actual.dev !== identity.dev || actual.ino !== identity.ino)
            throw failure('SCREENSHOT_FILE_CHANGED', 'The incomplete screenshot path no longer identifies our file');
          await fs.promises.unlink(selected.filePath);
        } catch (error) {
          if (error.code !== 'ENOENT') record.hostCleanupErrors.push({ code: error.code, message: error.message });
        }
      }
      if (problem) throw problem;
      return { requested: true, canceled: false, filePath: selected.filePath, bytesWritten: png.length,
        format: 'png', consent: 'native-save-dialog', usage: 'meeting-note-attachment', overwrite: false };
    })();
    record.hostFiles.add(task);
    task.then(() => record.hostFiles.delete(task), () => record.hostFiles.delete(task));
    const save = await task;
    const { dataUrl, ...receipt } = captured;
    return { ...receipt, owner, status: 'saved', filePath: save.filePath, save };
  } finally {
    scope.release();
    record.bridge.removeListener('event', event);
    if (window && !window.isDestroyed()) window.removeListener('closed', abort);
    record.renderCapturePending = false;
  }
}

module.exports = { captureRenderWindows };
