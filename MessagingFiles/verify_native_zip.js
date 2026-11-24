#!/usr/bin/env electron
'use strict';
// Real ia32 SDK plus an independent ZIP reader; all files are synthetic.
// Requires python3, Info-ZIP zip, and a sparse TMPDIR with 2 GiB + 65,573 bytes
// + 64 MiB free. The dense large copy is deleted before ZIP creation. No network,
// desktop provider, account/profile, or vendor JavaScript is used by this proof.
const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
if (!process.argv[2] || !process.argv[3]) throw new Error('Usage: verify_native_zip.js LIBRARY FFI_PATH');
assert.equal(process.arch, 'ia32');
const ffi = require(path.resolve(process.argv[3]));
const flags = ffi.DynamicLibrary.FLAGS;
const dl = new ffi.DynamicLibrary(path.resolve(process.argv[2]), flags.RTLD_NOW | (flags.RTLD_NODELETE || 0));
const bind = (name, result, args) => ffi.ForeignFunction(dl.get(name), result, args);
const init = bind('NativeToolsInitService', 'int', ['string', 'pointer']);
const send = bind('NativeToolsSendMsg', 'void', ['string']);
const dispatch = bind('NativeToolsDispatchCallbacks', 'int', []);
const shutdown = bind('NativeToolsShutdown', 'void', []);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'welink-native-zip-'));
const pending = new Map();
let serial = 0, pump;
function failPending(error) {
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
  pending.clear();
}
const callback = ffi.Callback('void', ['string'], text => {
  try {
    const reply = JSON.parse(text), waiter = pending.get(reply.sno);
    if (waiter) {
      pending.delete(reply.sno);
      clearTimeout(waiter.timer);
      waiter.resolve(reply);
    }
  } catch (error) {
    failPending(error);
  }
});
global.nativeZipProofPins = [dl, callback, init, send, dispatch, shutdown];
function request(cmd, param, timeout = 15000) {
  const sno = ++serial;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(sno);
      reject(new Error('Native-tools command ' + cmd + ' callback timed out'));
    }, timeout);
    pending.set(sno, { resolve, reject, timer });
    send(JSON.stringify({ cmd, sno, param }));
  });
}
function independent(action, args = [], timeout = 15000) {
  const result = spawnSync('python3', [path.join(__dirname, 'verify_native_zip_fixture.py'), action, root, ...args], {
    encoding: 'utf8', timeout, maxBuffer: 1024 * 1024
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}
function expectEof(reply, filePath, total) {
  assert.equal(reply.result, 0);
  assert.deepEqual(reply.param, {
    file_path: filePath, total_num: total, cur_num: total, end_of_archive: true
  });
}
async function verifyIterator(filePath, streams, password = '') {
  const opened = await request(1, { file_path: filePath, password });
  assert.equal(opened.result, 0, filePath);
  assert.equal(opened.param.file_path, filePath);
  assert.equal(opened.param.total_num, streams.length, 'directories must not count as files');
  const received = [];
  // Preserve the consumer's do/while(cur_num < total_num) completion rule,
  // with the explicit EOF branch required for archives containing no files.
  let current = 0, total = 0;
  do {
    const reply = await request(2, { file_path: filePath });
    assert.equal(reply.result, 0, filePath);
    if (reply.param.end_of_archive === true) {
      expectEof(reply, filePath, streams.length);
      assert.equal(received.length, streams.length, 'premature EOF must not lose a file');
      break;
    }
    assert.equal(reply.param.end_of_archive, false);
    assert.equal(reply.param.file_path, filePath);
    assert.equal(reply.param.total_num, streams.length);
    assert.equal(reply.param.cur_num, received.length + 1);
    assert.ok(received.length < streams.length, 'iterator returned an invented file');
    assert.equal(reply.param.file_stream, streams[received.length]);
    received.push(reply.param.file_stream);
    current = reply.param.cur_num;
    total = reply.param.total_num;
  } while (current < total);
  assert.deepEqual(received, streams);
  if (streams.length) expectEof(await request(2, { file_path: filePath }), filePath, streams.length);
  assert.equal((await request(3, { file_path: filePath })).result, 0);
  assert.equal((await request(2, { file_path: filePath })).result, 1, 'closed archive must not report EOF');
}
async function rejectArchive(filePath, password = '') {
  const opened = await request(1, { file_path: filePath, password });
  if (opened.result === 0) {
    const reply = await request(2, { file_path: filePath });
    assert.equal(reply.result, 1, 'damaged, unsupported or unauthorized archive must not succeed: ' + filePath);
    assert.notEqual(reply.param && reply.param.end_of_archive, true);
  } else {
    assert.equal(opened.result, 1);
  }
  assert.equal((await request(2, { file_path: filePath })).result, 1,
    'an archive failure must not turn into clean EOF on the next read');
  await request(3, { file_path: filePath });
}
(async () => {
  try {
    assert.equal(init(root, callback), 0);
    pump = setInterval(() => {
      const status = dispatch();
      if (status < 0) failPending(new Error('Native dispatch failed: ' + status));
    }, 5);
    const fixtures = independent('create');
    const input = path.join(root, 'input');
    fs.mkdirSync(input, { mode: 0o700 });
    fs.mkdirSync(path.join(input, '子目录'), { mode: 0o700 });
    const contents = {
      '文档甲.txt': '中文内容\nembedded\u0000byte\n',
      '子目录/文档乙.txt': '{"value":17,"text":"第二个文件"}\n',
      'plain.txt': 'plain ASCII content\n'
    };
    for (const [name, content] of Object.entries(contents))
      fs.writeFileSync(path.join(input, name), content, { mode: 0o600 });
    const archive = path.join(root, '中文归档.zip');
    assert.equal((await request(17, { dir_path: input, zip_file_name: archive })).result, 0);
    const unicode = independent('unicode', [JSON.stringify(contents)]);
    console.log('PASS independent ZIP reader: Unicode names, nested directory, content and CRC');

    for (const fixture of fixtures.valid)
      await verifyIterator(path.join(root, 'fixtures', fixture.file), fixture.streams);
    for (const file of fixtures.damaged)
      await rejectArchive(path.join(root, 'fixtures', file));
    const truncatedAfterOpen = path.join(root, 'fixtures', 'truncated-after-open.zip');
    fs.copyFileSync(path.join(root, 'fixtures', 'empty.zip'), truncatedAfterOpen);
    const emptyOpened = await request(1, { file_path: truncatedAfterOpen });
    assert.equal(emptyOpened.result, 0);
    assert.equal(emptyOpened.param.total_num, 0);
    fs.truncateSync(truncatedAfterOpen, 10);
    assert.equal((await request(2, { file_path: truncatedAfterOpen })).result, 1,
      'cached libarchive EOF must not hide a truncated end record');
    assert.equal((await request(2, { file_path: truncatedAfterOpen })).result, 1);
    assert.equal((await request(3, { file_path: truncatedAfterOpen })).result, 1);
    const changedCount = path.join(root, 'fixtures', 'count-changed-after-open.zip');
    fs.copyFileSync(path.join(root, 'fixtures', 'empty.zip'), changedCount);
    assert.equal((await request(1, { file_path: changedCount })).result, 0);
    const mismatchedEnd = fs.readFileSync(changedCount);
    mismatchedEnd.writeUInt16LE(1, 8);
    mismatchedEnd.writeUInt16LE(1, 10);
    fs.writeFileSync(changedCount, mismatchedEnd);
    assert.equal((await request(2, { file_path: changedCount })).result, 1,
      'a complete but count-mismatched footer must not become cached EOF success');
    assert.equal((await request(2, { file_path: changedCount })).result, 1);
    assert.equal((await request(3, { file_path: changedCount })).result, 1);
    const protectedZip = path.join(root, 'fixtures', 'protected.zip');
    await rejectArchive(protectedZip);
    await rejectArchive(protectedZip, 'wrong-password');
    await verifyIterator(protectedZip, [fixtures.passwordStream], fixtures.password);
    console.log('PASS native ZIP iteration: file-only counts, trailing directories, empty archives, CRC/truncation and passwords');

    const copied = path.join(root, 'large-copy.bin');
    assert.equal((await request(18, {
      src_path: path.join(root, 'large-input', 'sparse.bin'), dest_path: copied
    }, 180000)).result, 0, 'command 18 must stream files beyond 2 GiB on ia32');
    const copy = independent('copy', [], 180000);
    assert.equal(copy.copiedBytes, fixtures.largeSize);
    fs.unlinkSync(copied);

    const largeZip = path.join(root, 'large.zip');
    assert.equal((await request(17, {
      dir_path: path.join(root, 'large-input'), zip_file_name: largeZip
    }, 180000)).result, 0, 'command 17 must archive files beyond 2 GiB on ia32');
    const large = independent('large-zip', [], 180000);
    assert.equal(large.archivedBytes, fixtures.largeSize);
    const largeOpened = await request(1, { file_path: largeZip });
    assert.equal(largeOpened.result, 0);
    assert.equal(largeOpened.param.total_num, 1);
    assert.equal((await request(2, { file_path: largeZip })).result, 1,
      'JSON file_stream must retain its intentional INT_MAX bound');
    assert.equal((await request(2, { file_path: largeZip })).result, 1,
      'oversize JSON rejection must not become EOF success');
    const peakRssKiB = process.resourceUsage().maxRSS;
    assert.ok(peakRssKiB < 512 * 1024, 'native streaming exceeded the 512 MiB resident-memory budget');
    console.log('PASS native large-file streaming: full copied/archive bytes and CRC verified by bounded independent readers');
    console.log(JSON.stringify({
      passed: true, ...unicode, independentReader: true, fileOnlyCounts: true,
      trailingDirectories: true, emptyArchives: true, completeEndRecords: true,
      directoryIntegrity: true, zip64: true, damagedArchiveRejected: true,
      passwordChecks: true, jsonStreamSizeBound: true, ...copy, ...large, peakRssKiB
    }));
  } finally {
    if (pump) clearInterval(pump);
    for (const waiter of pending.values()) clearTimeout(waiter.timer);
    shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
