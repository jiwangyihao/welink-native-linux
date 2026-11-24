#!/usr/bin/env electron
'use strict';
// Parent-run: stage this verifier as the test app under the selected sealed ia32
// runtime's private-namespace/drop-UID, sandbox-enabled launch procedure.
// Never launch an untouched image/resources/app: that starts WeLink, not this test.
// --app /tested/image/resources/app selects the consumer/native inputs.
// Run on a private X server. No account services, network, or user profile are loaded.
// ZIP coverage ends at a validating JSONL fixture sink, not encrypted SQLite.
const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const acorn = require(process.env.WELINK_TEST_ACORN || 'acorn');
const { app, BrowserWindow } = require('electron');

// These two test windows and their native view wrappers have process-bounded
// ownership. Keep the complete tree rooted even after explicit destruction:
// Electron must not finalize a WebContentsView from a GC weak callback while
// later preparation runs after its creation context has been torn down.
const rendererOwners = globalThis.__welinkRendererFileReceiptOwners = [];
function phase(name, directory) {
  console.log(JSON.stringify({ suite: 'renderer-file-receipts', phase: name, ...(directory ? { directory } : {}) }));
}

function visit(node, callback) {
  if (!node || typeof node.type !== 'string') return;
  callback(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) for (const child of value) visit(child, callback);
    else if (value && typeof value === 'object') visit(value, callback);
  }
}

function readModules(appRoot, directory) {
  const modules = new Map();
  for (const filename of ['vendors.js', 'im.js', 'common.js', '2473.js']) {
    const source = fs.readFileSync(path.join(appRoot, directory, filename), 'utf8');
    visit(acorn.parse(source, { ecmaVersion: 'latest' }), node => {
      if (node.type === 'Property' && node.key.type === 'Literal' &&
          typeof node.key.value === 'number' && /FunctionExpression$/.test(node.value.type)) {
        modules.set(node.key.value, { node: node.value, source });
      }
    });
  }
  function select(id, predicate) {
    assert.ok(modules.has(id), directory + ': missing webpack module ' + id);
    const module = modules.get(id), matches = [];
    visit(module.node, node => { if (predicate(node)) matches.push(node); });
    assert.equal(matches.length, 1, directory + ': expected one consumer in module ' + id);
    return { node: matches[0], source: module.source };
  }
  function binding(id, name) {
    const { node, source } = select(id, node => node.type === 'VariableDeclarator' && node.id.name === name && node.init);
    return source.slice(node.init.start, node.init.end);
  }
  const factories = {};
  function include(id) {
    if (Object.hasOwn(factories, id)) return;
    assert.ok(modules.has(id), directory + ': missing dependency ' + id);
    const { node, source } = modules.get(id);
    factories[id] = source.slice(node.start, node.end);
    const requireName = node.params[2] && node.params[2].name;
    if (!requireName) return;
    visit(node, child => {
      if (child.type === 'CallExpression' && child.callee.type === 'Identifier' && child.callee.name === requireName &&
          child.arguments.length === 1 && typeof child.arguments[0].value === 'number') include(child.arguments[0].value);
    });
  }
  // Instantiate only file utilities and the native loader/callback machinery,
  // never im.js's service bootstrap or the editor component/account hooks.
  for (const id of [33055, 73119, 29500, 61240, 36067, 33550, 43671, 16397,
    43420, 11265, 29550, 42963]) include(id);
  const method = select(18752, node => node.type === 'CallExpression' &&
    node.arguments[1] && node.arguments[1].value === 'copyFileByStream');
  const zipMethods = {};
  for (const name of ['openZipFile', 'decompressZipNextFile', 'closeZipFile']) {
    const { node, source } = select(18752, node => node.type === 'MethodDefinition' && node.key.name === name);
    zipMethods[name] = 'function' + source.slice(node.value.start, node.value.end);
  }
  const zip = {};
  for (const name of ['K', 'F', 'q', 'Z', 'W', 'k']) zip[name] = binding(97245, name);
  return {
    factories,
    copyMethod: method.source.slice(method.node.arguments[2].start, method.node.arguments[2].end),
    prepareScreenshot: binding(88233, 'be'), zipMethods, zip
  };
}

function makeArchives(root) {
  const rows = [
    { msgId: 'fixture-message-1', contentType: 1, sendTime: '1700000000001', content: 'first synthetic record' },
    { msgId: 'fixture-message-2', contentType: 1, sendTime: '1700000000002', content: 'second synthetic record 文件' }
  ];
  // Independent standard-library producer, with no downloaded or account data.
  // Stored entries make the CRC-corruption case deterministic across zlib builds.
  execFileSync('python3', ['-I', '-c', String.raw`
import json, pathlib, struct, sys, zipfile
root = pathlib.Path(sys.argv[1])
rows = json.loads(sys.argv[2])
def archive(name, entries):
    with zipfile.ZipFile(root / name, 'w', compression=zipfile.ZIP_STORED) as target:
        for filename, content in entries:
            target.writestr(filename, content)
first, second = (json.dumps(row, ensure_ascii=False) + '\n' for row in rows)
archive('empty.zip', [])
archive('directories.zip', [('history/', ''), ('history/nested/', '')])
archive('trailing-directory.zip', [('history.jsonl', first), ('trailing/', '')])
archive('multiple.zip', [('first.jsonl', first), ('second.jsonl', second), ('trailing/', '')])
archive('bad-json.zip', [('broken.jsonl', '{invalid JSON\n'), ('unread.jsonl', second)])
(root / 'bad-open.zip').write_bytes(b'not a ZIP archive')
archive('corrupt.zip', [('first.jsonl', first), ('second.jsonl', second)])
with zipfile.ZipFile(root / 'corrupt.zip') as source:
    offset = source.infolist()[0].header_offset
data = bytearray((root / 'corrupt.zip').read_bytes())
name_size, extra_size = struct.unpack_from('<HH', data, offset + 26)
data[offset + 30 + name_size + extra_size] ^= 1
(root / 'corrupt.zip').write_bytes(data)
(root / 'corrupt-eof-flag.zip').write_bytes(data)
`, root, JSON.stringify(rows)], { timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
  return [
    { file: 'empty.zip', rows: [], total: 0, reads: 1, success: true, shown: false },
    { file: 'directories.zip', rows: [], total: 0, reads: 1, success: true, shown: true },
    { file: 'trailing-directory.zip', rows: rows.slice(0, 1), total: 1, reads: 1, success: true, shown: true },
    { file: 'multiple.zip', rows, total: 2, reads: 2, success: true, shown: false },
    { file: 'bad-open.zip', rows: [], reads: 0, error: 'open' },
    { file: 'corrupt.zip', rows: [], total: 2, reads: 1, error: 'read' },
    { file: 'corrupt-eof-flag.zip', rows: [], total: 2, reads: 1, error: 'read', injectEof: true },
    { file: 'bad-json.zip', rows: [], total: 2, reads: 1, error: 'parse' }
  ];
}

async function rendererProof(input) {
  const assert = window.require('assert').strict;
  const fs = window.require('fs');
  const path = window.require('path');
  assert.equal(process.arch, 'ia32');
  const domTimer = window.setTimeout(() => {}, 60000);
  assert.equal(typeof domTimer, 'number', 'Use an actual renderer, not Electron-as-Node');
  window.clearTimeout(domTimer);
  const logs = [];
  const logger = {};
  for (const level of ['debug', 'info', 'warn', 'error']) logger[level] = (...args) => logs.push({ level, args });
  window.getLogger = () => () => logger;
  const cache = {};
  function webpack(id) {
    if (Object.hasOwn(cache, id)) return cache[id].exports;
    assert.ok(Object.hasOwn(input.factories, id), 'Unexpected webpack dependency ' + id);
    const module = cache[id] = { exports: {} };
    const factory = new Function('require', 'return (' + input.factories[id] + ');')(window.require);
    factory(module, module.exports, webpack);
    return module.exports;
  }
  webpack.g = window;
  webpack.o = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  webpack.d = (exports, definitions) => {
    for (const key of Object.keys(definitions)) {
      if (!webpack.o(exports, key)) Object.defineProperty(exports, key, { enumerable: true, get: definitions[key] });
    }
  };
  webpack.r = exports => {
    Object.defineProperty(exports, '__esModule', { value: true });
    if (typeof Symbol !== 'undefined' && Symbol.toStringTag) Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
  };
  webpack.n = module => {
    const getter = module && module.__esModule ? () => module.default : () => module;
    webpack.d(getter, { a: getter });
    return getter;
  };
  const native = window.require(input.native);
  const NativeTools = webpack(73119).default;
  const FFICallback = webpack(29500).default;
  let callback;
  const tools = new NativeTools(text => {
    const reply = JSON.parse(text);
    callback.runAndDelete(reply.sno, reply);
  });
  callback = new FFICallback(tools);
  const service = { tools, ffiCallback: callback, logger };
  const createCopyMethod = new Function('d', 'return function(){return (' + input.copyMethod + ');};');
  const copyByStream = createCopyMethod({ default: webpack(61240) }).call(service);
  const nativeReplies = [];
  let alterReceipt = null;
  service.copyFileByStream = async args => {
    let timer;
    try {
      const reply = await Promise.race([
        copyByStream(args),
        new Promise((resolve, reject) => {
          timer = window.setTimeout(() => reject(new Error('Native copy callback timed out')), 10000);
        })
      ]);
      nativeReplies.push(reply);
      return alterReceipt ? alterReceipt(reply) : reply;
    } finally { window.clearTimeout(timer); }
  };
  const registry = webpack(36067).default;
  registry.setInstance('nativetoolService', service);
  registry.setInstance('PathUseCase', {
    getPathByFileName(name) {
      assert.equal(name, 'screenshotPath');
      return filename => path.join(input.screenshots, filename);
    }
  });
  const helper = webpack(33055);
  const fsExtra = webpack(21605);
  const prepare = new Function('H', 'V', 'P', 'ce', 'return (' + input.prepareScreenshot + ');')(
    webpack(33550), webpack(43671), helper, fs);
  const zipCalls = [];
  let archiveCase;
  for (const [name, source] of Object.entries(input.zipMethods)) {
    const method = new Function('d', 'return (' + source + ');')({ default: webpack(61240) });
    service[name] = async args => {
      let timer;
      try {
        const reply = await Promise.race([
          method.call(service, args),
          new Promise((resolve, reject) => {
            timer = window.setTimeout(() => reject(new Error('Native ZIP callback timed out: ' + name)), 10000);
          })
        ]);
        zipCalls.push({ name, args, reply });
        // A failure must not become success even if an EOF flag is present.
        if (name === 'decompressZipNextFile' && archiveCase.injectEof) {
          assert.notEqual(reply.result, 0);
          return { ...reply, param: { ...reply.param, end_of_archive: true } };
        }
        return reply;
      } finally { window.clearTimeout(timer); }
    };
  }
  // This is a durable, validating consumer sink, not a substitute claim of
  // native/encrypted database acceptance. Presentation normalization is outside
  // this regression: validate exactly what saveZipData supplies at that seam.
  function validateRecord(record) {
    try {
      const expected = archiveCase.expected.find(row => row.msgId === record.msgId);
      assert.ok(expected, 'Unexpected decoded message: ' + record.msgId);
      assert.deepEqual(record, expected);
    } catch (error) { archiveCase.sinkErrors.push(error.message); throw error; }
  }
  registry.setInstance('dbImpl', {
    async bulkInsertMessage(rows) {
      ++archiveCase.insertions;
      try {
        assert.ok(Array.isArray(rows) && rows.length > 0, 'Never insert an empty or fabricated message batch');
        for (const row of rows) {
          validateRecord(row);
          assert.ok(!archiveCase.ids.has(row.msgId), 'Duplicate message insertion: ' + row.msgId);
          archiveCase.ids.add(row.msgId);
        }
        fs.appendFileSync(archiveCase.sink, rows.map(row => JSON.stringify(row) + '\n').join(''));
      } catch (error) { archiveCase.sinkErrors.push(error.message); throw error; }
    }
  });
  async function archiveCases() {
    const outcomes = [];
    const constants = webpack(43420);
    const config = new Function('t', 'U', 'return (' + input.zip.k + ');')({}, 60);
    for (const fixture of input.archives) {
      const filePath = path.join(input.root, fixture.file);
      const before = zipCalls.length;
      archiveCase = { ...fixture, expected: fixture.rows.map(row => ({ ...row,
        chatContentType: row.contentType, serverSendTime: row.sendTime })),
        sink: filePath + '.jsonl', ids: new Set(), insertions: 0, sinkErrors: [] };
      fs.writeFileSync(archiveCase.sink, '');
      const timers = [], sleeps = [], progress = [], states = [], removed = [], normalized = [];
      const remove = new Function('l', 'E', 'M', 'L', 'handleLocalPath', 'return (' + input.zip.W + ');')(
        { default: webpack(61240) }, { default: webpack(42963).default }, { default: fsExtra }, logger, value => value);
      const saveZipData = new Function('b', 'p', 'f', 'u', 'L', 's', 'w', 'o', 'k', 'V', 'j', 'T', 'W',
        'let P;const F=(' + input.zip.F + '),q=(' + input.zip.q + '),Z=(' + input.zip.Z + ');return (' + input.zip.K + ');')(
        { default: webpack(16397).default }, constants,
        { $imState: () => ({ messageSync: { isShow: !!fixture.shown } }) },
        { default: webpack(29550) }, logger, { default: webpack(11265) },
        // Deterministic animation clock only; native dispatch uses real timers.
        { sleep: async delay => { sleeps.push(delay); } },
        { default: (fn, delay, ...args) => { timers.push({ fn, delay, args }); return timers.length; } },
        config, action => progress.push(action), action => states.push(action),
        { default: async record => { validateRecord(record); normalized.push(JSON.parse(JSON.stringify(record))); } },
        target => { const removing = remove(target); removed.push(removing); return removing; });
      await saveZipData({ filePath, password: '' });
      assert.equal(timers.length, fixture.success ? 1 : 0, fixture.file + ': completion must be scheduled exactly once, and never on failure');
      assert.equal(progress.length, fixture.success ? 1 : 0, fixture.file + ': truthful terminal progress');
      if (fixture.success) {
        assert.deepEqual(progress, [{ payload: { progress: 100 } }]);
        assert.equal(timers[0].delay, 1000 * config.doneTime);
        assert.equal(states.length, 0, 'Do not complete before the existing completion timer');
        await timers[0].fn(...timers[0].args);
      }
      await Promise.all(removed);
      assert.equal(removed.length, 1, fixture.file + ': remove the archive exactly once');
      assert.equal(fs.existsSync(filePath), false);
      assert.equal(states.length, 1, fixture.file + ': exactly one terminal state');
      assert.equal(states[0].payload.taskStatus, fixture.success ?
        (fixture.shown ? constants.TaskStatus.Success : constants.TaskStatus.Done) : constants.TaskStatus.Failed);
      assert.equal(archiveCase.sinkErrors.length, 0, 'Unexpected/duplicate record must not be hidden by the consumer catch');
      const persisted = fs.readFileSync(archiveCase.sink, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
      assert.deepEqual(persisted, archiveCase.expected, fixture.file + ': exact persisted synthetic records');
      assert.deepEqual(normalized, archiveCase.expected);
      assert.equal(archiveCase.insertions, fixture.rows.length, fixture.file + ': exact batch count for one-record entries');
      const calls = zipCalls.slice(before);
      const opens = calls.filter(call => call.name === 'openZipFile');
      const reads = calls.filter(call => call.name === 'decompressZipNextFile');
      const closes = calls.filter(call => call.name === 'closeZipFile');
      assert.equal(opens.length, 1);
      assert.equal(reads.length, fixture.reads, fixture.file + ': stop after clean completion or the first failure');
      assert.equal(closes.length, 1, fixture.file + ': close exactly once');
      if (fixture.error === 'open') assert.notEqual(opens[0].reply.result, 0);
      else {
        assert.equal(opens[0].reply.result, 0);
        assert.equal(opens[0].reply.param.total_num, fixture.total, 'Native count must exclude directories');
        // A native read failure already discards its handle; the consumer must
        // still close once, without turning that failed close into completion.
        assert.equal(closes[0].reply.result, fixture.error === 'read' ? 1 : 0);
        assert.equal(sleeps[0], 1000 * config.syncingTime);
      }
      if (fixture.error === 'read') {
        assert.notEqual(reads[0].reply.result, 0, 'Damaged archive must remain a real native failure');
      } else for (const [index, call] of reads.entries()) {
        assert.equal(call.reply.result, 0);
        assert.equal(call.reply.param.total_num, fixture.total);
        assert.equal(call.reply.param.cur_num, fixture.total ? index + 1 : 0);
        assert.equal(call.reply.param.end_of_archive, fixture.total === 0);
        assert.equal(Object.hasOwn(call.reply.param, 'file_stream'), fixture.total > 0);
      }
      outcomes.push({ file: fixture.file, success: !!fixture.success,
        messages: persisted.length, reads: reads.length, closes: closes.length });
    }
    return outcomes;
  }
  const initialized = tools.LoadLibrary(input.ffi, input.appRoot, input.logs);
  assert.equal(initialized.result, 0, 'Load the genuine native tools provider: ' + initialized.resultDes);
  try {
    const missing = path.join(input.root, 'nonexistent-source.png');
    const missingDest = path.join(input.root, 'nonexistent-target.png');
    let failedCopy;
    await assert.rejects(helper.copyFile(missing, missingDest), error => {
      failedCopy = error;
      assert.equal(error.cause.code, 'ENOENT', 'Keep the actual fs-extra failure');
      assert.equal(error.nativeResponse.result, 1, 'Keep the actual native failure receipt');
      assert.match(error.message, /copyFileByStream/);
      assert.match(error.message, /ENOENT/);
      return true;
    });
    assert.ok(failedCopy);
    assert.equal(nativeReplies.length, 1, 'The real native fallback must have run');
    assert.equal(fs.existsSync(missingDest), false);
    let readyPath;
    await assert.rejects(async () => { readyPath = await prepare(missing); });
    assert.equal(readyPath, undefined, 'The actual screenshot consumer must not publish a nonexistent target');
    assert.equal(fs.existsSync(path.join(input.screenshots, path.basename(missing))), false);
    assert.equal(nativeReplies.length, 2);
    assert.equal(nativeReplies[1].result, 1);

    const content = Buffer.from('synthetic copy\u0000binary\nUnicode: 文件\n');
    const source = path.join(input.root, 'normal.png');
    const destination = path.join(input.root, 'normal-copy.png');
    fs.writeFileSync(source, content);
    await helper.copyFile(source, destination);
    assert.deepEqual(fs.readFileSync(destination), content);
    assert.equal(await prepare(source), path.join(input.screenshots, 'normal.png'));
    assert.deepEqual(fs.readFileSync(path.join(input.screenshots, 'normal.png')), content);
    assert.equal(nativeReplies.length, 2, 'Successful fs-extra copies must not call native fallback');

    // Inject only a primary-provider failure. The fallback is still the actual
    // native code, and success is checked against bytes read from disk, not a
    // fabricated result=0 response.
    const originalCopy = fsExtra.copy;
    const primaryFailure = Object.assign(new Error('synthetic fs-extra permission failure'), { code: 'EACCES' });
    fsExtra.copy = async () => { throw primaryFailure; };
    try {
      const fallbackSource = path.join(input.root, 'fallback.png');
      fs.writeFileSync(fallbackSource, content);
      assert.equal(await prepare(fallbackSource), path.join(input.screenshots, 'fallback.png'));
      assert.deepEqual(fs.readFileSync(path.join(input.screenshots, 'fallback.png')), content);
      assert.equal(nativeReplies.length, 3);
      assert.equal(nativeReplies[2].result, 0, 'A genuine native success must remain usable');
    } finally { fsExtra.copy = originalCopy; }

    // Corrupt genuine failure receipts at the renderer boundary; none of these
    // cases creates a successful provider or a destination file.
    const invalidReceipts = [undefined, null, {}, [], false, 0, '0',
      { result: null }, { result: false }, { result: '0' }, { result: 1, resultDes: 'native failure detail' }, { result: -1 }];
    for (const receipt of invalidReceipts) {
      alterReceipt = () => receipt;
      await assert.rejects(helper.copyFile(missing, missingDest), error => {
        assert.equal(error.cause.code, 'ENOENT');
        assert.equal(error.nativeResponse, receipt);
        assert.equal(fs.existsSync(missingDest), false);
        return true;
      });
    }
    const rejected = new Error('native transport rejection');
    alterReceipt = () => { throw rejected; };
    await assert.rejects(helper.copyFile(missing, missingDest), error => error === rejected);
    alterReceipt = null;
    assert.ok(logs.some(entry => entry.level === 'error' && entry.args[0] === primaryFailure));
    const archives = await archiveCases();
    return { passed: true, directory: input.directory, realNativeCopies: nativeReplies.length,
      missingSourceRejected: true, screenshotReadiness: true, normalCopy: true,
      nativeFallbackBytes: true, invalidReceiptsRejected: invalidReceipts.length,
      archiveScope: 'shipped ZIP completion consumer with validating JSONL sink, not SQLite acceptance', archives };
  } finally { tools.NativeToolsShutdown(); native.stopAll(); }
}

(async () => {
  assert.equal(process.platform, 'linux');
  assert.equal(process.arch, 'ia32', 'Use the selected sealed ia32 runtime with this verifier staged as the test app');
  const index = process.argv.indexOf('--app');
  assert.ok(index >= 0 && process.argv[index + 1], '--app requires an assembled resources/app directory');
  const appRoot = path.resolve(process.argv[index + 1]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'welink-renderer-file-receipts-'));
  fs.mkdirSync(path.join(root, 'runtime'));
  app.setPath('userData', path.join(root, 'runtime'));
  app.disableHardwareAcceleration();
  const results = [];
  const inputs = [];
  try {
    for (const [index, directory] of ['pedestal/im/static/js', 'plugin/im/dist/im/static/js'].entries()) {
      const fixture = path.join(root, String(index));
      fs.mkdirSync(fixture);
      for (const name of ['screenshots', 'logs']) fs.mkdirSync(path.join(fixture, name));
      phase('preparing-consumers', directory);
      const input = { ...readModules(appRoot, directory), archives: makeArchives(fixture), appRoot, directory, root: fixture,
        screenshots: path.join(fixture, 'screenshots'), logs: path.join(fixture, 'logs'),
        native: path.join(appRoot, 'native/ffi.js'),
        ffi: path.join(appRoot, 'libraries/node_extends/node-ffi/ffi-napi') };
      inputs.push(input);
      phase('consumers-prepared', directory);
    }
    // Parse both sealed bundle copies before any renderer/view exists. The
    // runtime inputs remain the exact extracted factories, not replacements.
    await app.whenReady();
    for (const input of inputs) {
      const { directory } = input;
      const window = new BrowserWindow({ show: false, webPreferences: {
        nodeIntegration: true, contextIsolation: false, sandbox: false
      } });
      const owner = { directory, window, webContents: window.webContents };
      rendererOwners.push(owner);
      owner.contentView = window.contentView;
      owner.childViews = owner.contentView ? Array.from(owner.contentView.children) : [];
      owner.webContents.session.webRequest.onBeforeRequest((details, callback) => {
        callback({ cancel: !details.url.startsWith('data:') });
      });
      phase('loading-renderer', directory);
      await window.loadURL('data:text/html,<body>Isolated renderer file receipts</body>');
      phase('running-consumer-proof', directory);
      results.push(await owner.webContents.executeJavaScript('(' + rendererProof.toString() + ')(' + JSON.stringify(input) + ')'));
      phase('consumer-proof-complete', directory);
    }
    const report = { passed: true, scope: 'both shipped renderer copies; synthetic files only', results };
    if (process.env.WELINK_TEST_OUTPUT)
      fs.writeFileSync(path.join(process.env.WELINK_TEST_OUTPUT, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify(report));
    phase('report-published');
  } finally {
    try {
      for (const owner of rendererOwners) {
        if (owner.window.isDestroyed()) continue;
        phase('closing-renderer', owner.directory);
        await new Promise(resolve => {
          owner.window.once('closed', resolve);
          owner.window.destroy();
        });
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
})().then(() => app.exit(0), error => { console.error(error.stack || error); app.exit(1); });
