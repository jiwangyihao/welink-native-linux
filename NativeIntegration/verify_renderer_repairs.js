#!/usr/bin/env node
'use strict';
// Checks the assembled consumer functions. --ui additionally uses real Electron
// windows/clipboard on an isolated X server, never a signed-in user session.
const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const acorn = require(process.env.WELINK_QA_ACORN || 'acorn');
const option = process.argv.indexOf('--app');
assert(option >= 0 && process.argv[option + 1], 'Supply --app ASSEMBLED_APP');
const appRoot = path.resolve(process.argv[option + 1]);
const ui = process.argv.includes('--ui');
let groups = 0;
const plain = value => JSON.parse(JSON.stringify(value));
function visit(node, fn) {
  if (!node || typeof node.type !== 'string') return;
  fn(node);
  for (const child of Object.values(node)) {
    if (Array.isArray(child)) child.forEach(value => visit(value, fn));
    else if (child && typeof child === 'object') visit(child, fn);
  }
}
function source(relative) {
  const text = fs.readFileSync(path.join(appRoot, relative), 'utf8');
  const tree = acorn.parse(text, { ecmaVersion: 'latest' });
  function one(predicate) {
    const found = [];
    visit(tree, node => { if (predicate(node, text.slice(node.start, node.end))) found.push(node); });
    assert.equal(found.length, 1, relative + ' unique target');
    return text.slice(found[0].start, found[0].end);
  }
  return { one, assignment(name) {
    const expression = one(node => node.type === 'AssignmentExpression' &&
      node.left.type === 'MemberExpression' && node.left.property.name === name &&
      /FunctionExpression$/.test(node.right.type));
    return expression.slice(expression.indexOf('=') + 1);
  } };
}
function evaluate(expression, context) { return vm.runInNewContext('(' + expression + ')', context, { timeout: 10000 }); }
async function imCases(directory) {
  const bundle = source(directory + '/common.js');
  const requests = [];
  let response = { result: 0, data: { msgIds: ['new'], serverTimeStamp: 9 } };
  const window = { isRedblue: false };
  const sync = evaluate(bundle.assignment('dealSyncEmojiReplay'), {
    window, W: { default: n => n === 1 }, Ee: { queryConvEmojiReply: async data => { requests.push(data); return response; } },
    E: { default: Array.from }, _: { default: Set }, ze: { dealSyncReplies: async () => 'redblue' }
  });
  for (const rcType of [6, 10, 16, 18, 20, 22, 101]) {
    const result = await sync({ rcId: 'non-chat', rcType, isSyncEmojiReply: true });
    assert.deepEqual(plain(result), { rcId: 'non-chat', isSyncEmojiReply: false });
  }
  assert.equal(requests.length, 0, 'Non-chat sessions must not request emoji replies');
  for (const rcType of [0, 1]) {
    const result = await sync({ rcId: 'chat', rcType, isSyncEmojiReply: true, emojiReplyMsgIds: ['old', 'new'], queryTimestamp: 7 });
    assert.deepEqual(plain(result), { rcId: 'chat', emojiReplyMsgIds: ['old', 'new'], queryTimestamp: 9, isSyncEmojiReply: false });
    assert.deepEqual(plain(requests.pop()), { chatType: rcType, groupId: rcType === 1 ? 'chat' : '', targetAccount: rcType === 0 ? 'chat' : '', queryTimestamp: 7 });
  }
  response = { result: 1 };
  assert.equal((await sync({ rcId: 'chat', rcType: 0, isSyncEmojiReply: true })).isSyncEmojiReply, true, 'Real server failure must remain retryable');
  window.isRedblue = true;
  assert.equal(await sync({ isSyncEmojiReply: true }), 'redblue');
  ++groups;

  const actions = [], updates = [], persisted = [];
  let broadcast = 0;
  const state = { session: {}, officialAccount: { detailMap: { node: { groupId: 'group', isVip: '0' } }, boxMessageMap: {}, boxRcIdMap: {} } };
  const record = { msgId: 'withdrawn', userAccount: 'node', isRead: 0 };
  const context = {
    w: { info() {}, debug() {} }, l: { default: Object.keys }, u: { default: value => value },
    g: { $imState: () => state, globalDispatch: action => actions.push(action) },
    R: { getBoxRcIdByGroupId: id => id === 'group' ? 'box' : null },
    A: { default: { getDB: () => ({ querySpecialMsgRecord: async () => record,
      querySpecialMsgRecordList: async () => [record], addSpecialMsgRecord: async ({ info }) => { persisted.push(info); return info; } }) } },
    E: { default: { runAndDel() {}, broadcastAllUnReadNum: () => ++broadcast } },
    I: { updateOrAddSession: value => updates.push(value) }, S: { updateSessionItem: value => updates.push(value) },
    N: { isChineseLanguage: () => false }, P: (...args) => updates.push(args)
  };
  const boxUpdate = bundle.one((node, text) => node.type === 'VariableDeclarator' && node.id.name === 'x' && text.includes('boxMessageMap') && text.includes('boxRcIdMap'));
  context.x = evaluate(boxUpdate.slice(boxUpdate.indexOf('=') + 1), context);
  const withdraw = evaluate(bundle.assignment('withdrawal'), context);
  state.officialAccount.boxMessageMap.box = [record, { msgId: 'next', senderName: 'next sender', showText: 'next text', serverSendTime: '5' }];
  state.officialAccount.boxRcIdMap.box = ['missing-session', 'other'];
  state.session.other = { unReadCount: 3 };
  await withdraw({ serviceNodeId: 'node', messageId: 'withdrawn' });
  assert.equal(persisted[0].isDelete, 1);
  assert.deepEqual(plain(actions.map(a => a.type)), ['DELETE_BOX_MESSAGE_BY_MSGID', 'DEL_OFFICIAL_MSG']);
  assert(updates.some(u => u.rcId === 'box' && u.unReadCount === 3));
  assert(updates.some(u => Array.isArray(u) && u[0] === 'box' && u[1] === 'next sender：next text'));
  assert.equal(broadcast, 1);
  actions.length = 0;
  delete state.officialAccount.detailMap.node;
  await withdraw({ serviceNodeId: 'node', messageId: 'withdrawn' });
  assert.deepEqual(plain(actions.map(a => a.type)), ['DEL_OFFICIAL_MSG'], 'Missing detail must not abort withdrawal');
  assert.equal(broadcast, 2);
  state.officialAccount.detailMap.node = { groupId: 'group', isVip: '0' };
  delete state.officialAccount.boxRcIdMap.box;
  await withdraw({ serviceNodeId: 'node', messageId: 'withdrawn' });
  assert.equal(broadcast, 3, 'Missing box list must not abort unread refresh');
  ++groups;
}
async function sharingPolicyCases() {
  const bundle = source('plugin/conference/dist/js/hwmService.js');
  const name = property => property.key && (property.key.name || property.key.value);
  const policyExpression = bundle.one(node => node.type === 'ArrowFunctionExpression' && node.async &&
    node.params[0]?.type === 'ObjectPattern' && node.params[0].properties.some(property => name(property) === 'Meeting$Share'));
  const consumerExpression = bundle.one(node => node.type === 'ArrowFunctionExpression' && node.async &&
    node.params.length === 1 && node.body.type === 'BlockStatement' &&
    node.body.body.some(statement => statement.type === 'VariableDeclaration' &&
      statement.declarations.some(declaration => declaration.id.type === 'ObjectPattern' &&
        declaration.id.properties.some(property => name(property) === 'permissionConfig'))));
  const cases = [
    { label: 'external enterprise denied', relation: true, setting: '0', usg: true, expected: false },
    { label: 'external enterprise allowed', relation: true, setting: '1', usg: true, expected: true },
    { label: 'same enterprise retains original policy', relation: false, setting: '0', usg: true, expected: true },
    { label: 'unknown enterprise explicitly allowed externally', setting: '1', usg: true, expected: true },
    { label: 'unknown enterprise external denial retained', setting: '0', usg: true, expected: false },
    { label: 'unknown enterprise missing policy denied', usg: true, expected: false },
    { label: 'unknown enterprise unrecognized policy denied', setting: 'unexpected', usg: true, expected: false },
    { label: 'unknown enterprise non-string policy denied', setting: 1, usg: true, expected: false },
    { label: 'anonymous sharing denial retained', relation: false, setting: '1', usg: false, anonymousDenied: true, expected: false },
    { label: 'anonymous allowed policy retained', relation: false, setting: '1', usg: false, expected: true },
    { label: 'unknown enterprise anonymous denial retained', setting: '1', usg: false, anonymousDenied: true, expected: false },
    { label: 'unknown enterprise anonymous policy is independent', setting: '0', usg: false, expected: true },
    { label: 'non-Linux external denial retained', platform: 'win32', relation: true, setting: '0', usg: true, expected: false }
  ];
  for (const test of cases) {
    const decisions = [], pending = [], values = new Map([['isUsgEnable', test.usg]]);
    const store = { getStore: key => values.get(key), setStore: (key, value) => values.set(key, value) };
    const logger = { info() {}, debug() {} };
    const api = {
      setShareScreenPermission(value) { assert.equal(typeof value, 'boolean'); decisions.push(value); return Promise.resolve({ result: 0 }); },
      callOtherNumBtnConfigUISdk() {}, sendUpdateOneRoomConfigUISdk() {}
    };
    const Pedestal = {
      async callMethod(method, query) {
        if (method === 'method://conference/getConfTenantConfig') return {
          confConfig: { isOneRoomType: 0, meetingExtNoticeSwitch: '0' },
          permissionConfig: { 'Meeting$Share': test.setting }
        };
        assert.equal(method, 'method://private_conference/publicQueryDB');
        assert.equal(query, 'meetingAnoShareList');
        return JSON.stringify(test.anonymousDenied ? [{ switch: '0' }] : []);
      },
      sendBroadcast() {}
    };
    const window = { require(module) {
      assert.equal(module, 'os');
      return { platform: () => test.platform || 'linux' };
    } };
    const policy = evaluate(policyExpression, { o: { a: store }, d: logger, Pedestal, window,
      isNullOrEmpty: value => value == null || value === '', s: { default: api } });
    const consumer = evaluate(consumerExpression, { g: logger, o: { a: value => value }, a: store, Pedestal,
      window,
      i: { default: api }, r: { a: params => { const result = policy(params); pending.push(result); return result; },
        c() { throw new Error('Unexpected extended-meeting notification'); } } });
    const detail = { conf_id: 'private-room', displayConferenceId: 'public-room',
      guest_join_uri: 'https://meeting.invalid/#/j/12345', conf_subject: 'Policy regression', role: 0 };
    if (test.relation !== undefined) detail.isOtherCorpConf = test.relation;
    await consumer({ detail });
    await Promise.all(pending);
    assert.deepEqual(decisions, [test.expected], test.label);
    if (test.relation === undefined)
      assert.equal(values.get('confInfo').isOtherCorpConf, undefined,
        'A sharing grant must not fabricate same-company identity for other controls');
  }
  ++groups;
}

async function linkCase(relative) {
  const bundle = source(relative);
  const fn = bundle.one((node, text) => /FunctionExpression$/.test(node.type) && text.includes('queryWebDefaultValue') && text.includes('openMessageLink') && !text.includes('__esModule'));
  const opened = [];
  const deps = { openMessageLink: async value => opened.push(value), isMac: () => false,
    queryWebDefaultValue() { throw new Error('Linux attempted the Windows registry'); } };
  const context = { process: { platform: 'linux' }, i: deps, o: deps, u: deps, n: deps, l: deps, r: deps };
  await evaluate(fn, context)('https://example.invalid/location');
  assert.deepEqual(opened, ['https://example.invalid/location']);
  ++groups;
}
async function surfaceCases() {
  assert(process.versions.electron, '--ui requires Electron, not Node');
  const { app, BrowserWindow, clipboard, nativeImage } = require('electron');
  await app.whenReady();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'welink-renderer-surfaces-'));
  let win;
  try {
    const preview = source('plugin/previewPicture/dist/js/bundle.js');
    const copy = preview.one((node, text) => node.type === 'ConditionalExpression' && text.startsWith('"linux"===process.platform?') && text.includes('Cannot decode clipboard image'));
    const image = nativeImage.createFromBitmap(Buffer.alloc(8 * 6 * 4, 0x72), { width: 8, height: 6 });
    const src = path.join(temp, '中文 % # image.png');
    fs.writeFileSync(src, image.toPNG());
    const html = '<img src="file://' + encodeURI(src) + '" data-path="' + src + '">';
    const context = { process: { platform: 'linux' }, info: null, src, _html: html,
      external_electron_namespaceObject: { clipboard, nativeImage }, Pedestal: { copyImageToClipBoard() { throw new Error('Windows helper invoked'); } } };
    evaluate('()=>(' + copy + ')', context)();
    assert.deepEqual(clipboard.readImage().getSize(), { width: 8, height: 6 });
    assert.equal(clipboard.readImage().toPNG().toString('hex'), image.toPNG().toString('hex'));
    assert(clipboard.availableFormats().includes('image/png'));
    assert(clipboard.readHTML().includes('data-path='));
    context.src = path.join(temp, 'missing.png');
    assert.throws(evaluate('()=>(' + copy + ')', context), /Cannot decode clipboard image/);
    assert.equal(clipboard.readImage().getSize().width, 8, 'Decode failure must not replace the clipboard');
    ++groups;

    win = new BrowserWindow({ width: 640, height: 240, webPreferences: { nodeIntegration: true, contextIsolation: false } });
    await win.loadURL('data:text/html,' + encodeURIComponent('<!doctype html><div class="suit-head-win" style="background:#145082;padding:16px;font:18px sans-serif"><div><span id="title">WeLink Linux title</span></div></div>'));
    const files = [];
    function walk(directory) { for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const p = path.join(directory, item.name);
      if (item.isDirectory() && item.name !== 'node_modules') walk(p);
      else if (item.isFile() && item.name.endsWith('.js') && fs.readFileSync(p, 'utf8').includes('.suit-head-win')) files.push(p);
    } }
    walk(appRoot);
    let helpers = 0;
    for (const file of files) {
      const bundle = source(path.relative(appRoot, file));
      const declaration = bundle.one((node, text) => node.type === 'VariableDeclaration' &&
        node.declarations.some(d => d.init?.type === 'BinaryExpression' && d.init.operator === '!==' && d.init.left.value === 'darwin') &&
        text.includes('document.querySelector') && text.includes('".suit-head-win"'));
      // Include the real following style expression without invoking unrelated IPC setup.
      const style = bundle.one((node, text) => node.type === 'LogicalExpression' &&
        text.includes('.style.color="#fff"') && text.includes('&&') &&
        node.right.type === 'AssignmentExpression');
      const prefix = style.match(/^([A-Za-z_$][\w$]*)/)[1];
      const code = '(function(){let ' + prefix + '=true;' + declaration + style + ';})()';
      await win.webContents.executeJavaScript('document.querySelector("#title").style.color="";' + code);
      assert.equal(await win.webContents.executeJavaScript('getComputedStyle(document.querySelector("#title")).color'), 'rgb(255, 255, 255)');
      await win.webContents.executeJavaScript('document.querySelector(".suit-head-win").className="missing-header";' + code);
      await win.webContents.executeJavaScript('document.querySelector(".missing-header").className="suit-head-win";');
      ++helpers;
    }
    assert.equal(helpers, 37);
    const screenshot = process.env.WELINK_QA_SCREENSHOT;
    if (screenshot) fs.writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
    ++groups;
    return { imageClipboard: true, actualDomThemeHelpers: helpers, scope: 'Real Electron clipboard and DOM fixtures using assembled consumer expressions; not signed-in UI acceptance' };
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
(async () => {
  let surface;
  await sharingPolicyCases();
  if (ui) surface = await surfaceCases();
  else {
    for (const directory of ['pedestal/im/static/js', 'plugin/im/dist/im/static/js']) {
      await imCases(directory); await linkCase(directory + '/6337.js');
    }
    await linkCase('plugin/im/dist/im/static/js/MessagePositionCardComp.chunk.js');
  }
  console.log(JSON.stringify({ passed: true, groups, surface, scope: 'Synthetic isolated regressions; no account or network access' }));
  if (ui) require('electron').app.exit(0);
})().catch(error => { console.error(error.stack || error); if (ui) require('electron').app.exit(1); else process.exitCode = 1; });
