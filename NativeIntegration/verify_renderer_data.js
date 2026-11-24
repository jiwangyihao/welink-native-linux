#!/usr/bin/env node
'use strict';
// Parent-run deterministic checks against the assembled JS, without login or network.
// node NativeIntegration/verify_renderer_data.js --app /image/resources/app
const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const acorn = require(process.env.WELINK_TEST_ACORN || 'acorn');
const option = process.argv.indexOf('--app');
assert.ok(option >= 0 && process.argv[option + 1], '--app requires an assembled resources/app directory');
const app = path.resolve(process.argv[option + 1]);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'welink-renderer-data-'));
let cases = 0;
function ok() { ++cases; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function visit(node, callback) {
  if (!node || typeof node.type !== 'string') return;
  callback(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) for (const child of value) visit(child, callback);
    else if (value && typeof value === 'object') visit(value, callback);
  }
}
function bundle(relative) {
  const source = fs.readFileSync(path.join(app, relative), 'utf8');
  const modules = new Map();
  visit(acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script' }), node => {
    if (node.type === 'Property' && node.key.type === 'Literal' && typeof node.key.value === 'number' &&
        /FunctionExpression$/.test(node.value.type)) modules.set(node.key.value, source.slice(node.value.start, node.value.end));
  });
  return id => {
    assert.ok(modules.has(id), relative + ': missing webpack module ' + id);
    const text = '(' + modules.get(id) + ')';
    const tree = acorn.parse(text, { ecmaVersion: 'latest' }).body[0].expression;
    return {
      text,
      find(predicate) {
        const matches = [];
        visit(tree, node => { if (predicate(node)) matches.push(node); });
        assert.equal(matches.length, 1, relative + ': unique function/branch in ' + id);
        return text.slice(matches[0].start, matches[0].end);
      },
      function(name) { return this.find(node => node.type === 'FunctionDeclaration' && node.id.name === name); },
      value(name) { return this.find(node => node.type === 'VariableDeclarator' && node.id.name === name).slice(name.length + 1); },
      assignment(name) {
        const assignment = this.find(node => node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression' &&
          !node.left.computed && node.left.property.name === name && /FunctionExpression$/.test(node.right.type));
        return assignment.slice(assignment.indexOf('=') + 1);
      }
    };
  };
}
function run(text, globals = {}) { return vm.runInNewContext(text, globals, { timeout: 10000 }); }
function logger() {
  const errors = [], infos = [];
  return { errors, infos, error(...args) { errors.push(args); }, info(...args) { infos.push(args); }, debug() {}, warn(...args) { errors.push(args); } };
}
function factory(module, dependencies, window) {
  const exports = {};
  const requireModule = id => {
    if (id === 53930) return Object.defineProperty;
    if (id === 14881) return value => value && value.__esModule ? value : { default: value };
    assert.ok(Object.hasOwn(dependencies, id), 'unexpected dependency ' + id);
    return dependencies[id];
  };
  run(module.text, { window })( {}, exports, requireModule );
  return exports;
}
function store(initial) {
  let value = initial, reducing = false;
  const subscribers = new Set();
  return {
    subscribers,
    getState() { assert.ok(!reducing, 'getState must not run inside a reducer'); return value; },
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
    dispatch(next, reducerRead) {
      reducing = true;
      try { if (reducerRead) reducerRead(); value = next; } finally { reducing = false; }
      for (const subscriber of subscribers) subscriber();
    }
  };
}
async function imCases(directory) {
  const common = bundle(directory + '/common.js'), init = bundle(directory + '/7326.js'), entry = bundle(directory + '/im.js');
  const log = logger();
  const cache = fs.mkdtempSync(path.join(temp, 'suit-avatar-')) + path.sep;
  const pendingAvatars = {}, stat = run(common(63711).value('s'), { i: () => fs });
  const lookup = run('(' + common(98153).function('wi') + ')',
    { Ii: cache, Ti: { q5: stat }, Oi: pendingAvatars, c: () => log });
  const avatar = cache + 'cached_timestamp_0.png';
  fs.writeFileSync(avatar, 'cached fixture');
  assert.deepEqual(clone(lookup('cached')), { src: avatar, time: fs.statSync(avatar).mtimeMs });
  assert.deepEqual(clone(lookup('missing')), { src: '', time: 0 });
  assert.deepEqual(pendingAvatars, { missing: 1 });
  assert.equal(log.errors.length, 0);
  // A pathname loop is an actual filesystem fault, not a missing avatar.
  fs.symlinkSync('loop_timestamp_0.png', cache + 'loop_timestamp_0.png');
  lookup('loop');
  assert.match(log.errors.pop().join(' '), /ELOOP/);
  ok();
  let registryStore;
  const window = { Pedestal: { viewID: 'pedestal' }, getLogger: () => () => log,
    require: name => { assert.equal(name, 'os'); return { platform: () => 'linux' }; } };
  const api = factory(common(83691), {
    84196: {}, 96119: { isImMainUI: () => window.Pedestal.viewID === 'pedestal' }, 7509: {},
    36067: { getInstance(name) { assert.equal(name, 'reduxStore'); return registryStore; } }
  }, window);
  const initialize = factory(init(19398), { 83691: api }, window).initImStore;
  const state = { session: { map: {} }, user: { userMap: {} }, account: { uuid: 'fixture' } };
  window.store = store({ im: state });
  let nativeStarts = 0, eventRegistrations = 0;
  factory(entry(27219), {
    94161: { __esModule: true, default() { assert.equal(api.imStore.state, state); ++nativeStarts; return Promise.resolve('native-ready'); } },
    98924: {}, 83691: api, 19398: { initImStore: initialize }, 91977: {}, 33356: {},
    25007: { registerEvent() { assert.equal(api.imStore.state, state); ++eventRegistrations; } },
    16274: {}, 62285: {}, 58950: {}, 9905: { imReducers: {} }
  }, window);
  assert.equal(await window.WelinkImCore.initIM(), 'native-ready');
  assert.equal(nativeStarts, 1); assert.equal(eventRegistrations, 1);
  assert.equal(Object.getOwnPropertyDescriptor(api.imStore, 'state').get, undefined);
  initialize(); initialize(); assert.equal(window.store.subscribers.size, 1);
  const next = { ...state, account: { uuid: 'next-fixture' } };
  window.store.dispatch({ im: next }, () => assert.equal(api.imStore.state, state));
  assert.equal(api.imStore.state, next);
  const oldStore = window.store;
  delete window.store;
  window.Pedestal.viewID = 'imWindow'; registryStore = store(state);
  initialize(); assert.equal(oldStore.subscribers.size, 0); assert.equal(api.imStore.state, state);
  registryStore.dispatch(next, () => assert.equal(api.imStore.state, state));
  assert.equal(api.imStore.state, next);
  registryStore = { getState() { throw new Error('real-store-failure'); } };
  assert.throws(initialize, /real-store-failure/); ok();

  // Execute the actual grouping decision and full-sync implementation, not a rewritten predicate.
  const recent = common(87951);
  const route = recent.find(node => node.type === 'ConditionalExpression' && node.consequent.type === 'AwaitExpression' &&
    node.consequent.argument.type === 'CallExpression' && node.consequent.argument.callee.name === 'Jt');
  const full = common(77174).assignment('initSessionGroup');
  const groupLog = logger(), saved = [], groups = [];
  let groupResponse = { result: 0, conversationGroups: [], serverTime: 'server-full-cursor' }, groupError;
  const fullSync = run('(' + full + ')', {
    _: { async getConversationGrouping() { if (groupError) throw groupError; return groupResponse; } },
    v: { globalDispatch(action) { groups.push(action); } }, h: { SESSION_GROUP_TYPE: { CUSTOM: 1 }, SESSION_GROUP_SYNC_TIME: 'group-cursor' },
    i: { default: () => Array.prototype.values }, r: { default: () => Array.prototype.filter }, d: { default: () => Array.prototype.includes },
    I: { default: { getDB: () => ({ async addConversationGroupList() {}, async addUserKeyValue(value) { saved.push(value); } }) } },
    U: groupLog, C: { loggerError(value) { groupLog.error(value); } },
    q: async () => ({ requestFlag: true, conversationInfos: [{ rcId: 'synthetic-group-member' }] }), Z: async () => {}
  });
  for (const cursor of [undefined, null, '', 0, '0']) {
    let incremental = false;
    await run('(async()=>(' + route + '))()', { d: cursor, Jt: async () => { incremental = true; }, $e: { initSessionGroup: fullSync } });
    assert.equal(incremental, false); assert.equal(saved.at(-1).value, 'server-full-cursor');
  }
  for (const cursor of ['1700000000000', 1700000000000, 'bad-server-cursor']) {
    let received;
    const count = saved.length;
    await run('(async()=>(' + route + '))()', { d: cursor, Jt: async value => { received = value; }, $e: { initSessionGroup: fullSync } });
    assert.equal(received, cursor); assert.equal(saved.length, count);
  }
  groupResponse = { result: 0, conversationGroups: [{ type: 1, conversationGroupId: 'synthetic-group' }], serverTime: 'server-full-nonempty' };
  await fullSync(); assert.equal(saved.at(-1).value, 'server-full-nonempty'); assert.equal(groupLog.errors.length, 0);
  groupResponse = { result: 401 }; const savedCount = saved.length;
  await fullSync(); assert.equal(saved.length, savedCount); assert.ok(groupLog.errors.length);
  groupError = new Error('group-transport-failure'); await assert.rejects(fullSync, error => error === groupError);
  const deltaSaves = [], memberChanges = [], deltaLog = logger();
  let deltaResponse = { result: 0, changedGroupings: [{ conversationGroupId: 'synthetic-group', addedConversations: ['a'], removedConversations: ['b'] }], syncTime: 'server-delta-cursor' };
  let deltaRequest, deltaError;
  const delta = run('(' + recent.value('Jt') + ')', {
    We: { async getConversationGrouping() { return { result: 0, conversationGroups: [] }; }, async getChangedGroupingConversations(cursor) { deltaRequest = cursor; if (deltaError) throw deltaError; return deltaResponse; } },
    V: { $imState: () => ({ sessionGroup: { groupList: [], customGroupMap: {}, currentSessionGroup: 'recent' } }), globalDispatch() {} },
    p: { default: () => Array.prototype.filter }, M: { default: () => Array.prototype.includes }, m: { default: () => Array.prototype.findIndex },
    Qe: { SESSION_GROUP_SYNC_TIME: 'group-cursor', SESSION_GROUP_TYPE: { CUSTOM: 1 }, SERVER_ERROR_CODE: { GROUPING_CONVERSATION_QUERY_EXCEED_TIME: 1547 } },
    Ie: { default: { getDB: () => ({ async addConversationGroupList() {}, async addUserKeyValue(value) { deltaSaves.push(value); } }) } },
    $e: { async addMemberToGroup(values) { memberChanges.push(['add', clone(values)]); }, async delMemberFromGroup(values) { memberChanges.push(['delete', clone(values)]); } },
    pt: deltaLog
  });
  await delta('1700000000000');
  assert.equal(deltaRequest, '1700000000000'); assert.equal(deltaSaves[0].value, 'server-delta-cursor');
  assert.deepEqual(memberChanges, [['add', ['a']], ['delete', ['b']]]); assert.equal(deltaLog.errors.length, 0);
  deltaResponse = { result: 503 }; await delta('1700000000000');
  assert.equal(deltaSaves.length, 1); assert.equal(deltaLog.errors.length, 1);
  deltaError = new Error('group-delta-transport'); await assert.rejects(delta('1700000000000'), error => error === deltaError);
  ok();

  const emoji = common(43649);
  const code = emoji.function('J') + ';' + emoji.function('ae') + ';' + emoji.function('de') + ';de';
  async function syncCase({ cursor = '10', cached = [], visible = cached, changes = [], full = false, dataMissing = false, relationMissing = false, responseError, transport, database }) {
    const state = { account: { uuid: 'fixture' }, editor: { emoji: { emojiMap: { custom: clone(visible) } } } };
    const db = clone(cached), writes = [], actions = [], log = logger();
    const sync = run(code, {
      k: { CUSTOM_EMOJI_TYPE: 'custom', EMOJI_RESPONSE_CODE: { SUCCESS: 0 } }, C: { DELETE_TYPE: { DELETE: 1 } },
      O: { $imState: () => state }, y: { CUSTOM_EMOJI_TIMESTAMP: 'emoji-cursor' }, Z: log,
      h: { default: () => Array.prototype.forEach }, _: { default: () => Array.prototype.reduce },
      g: { default: () => Array.prototype.includes }, f: { default: Object.values },
      m: { default: () => Array.prototype.sort }, S: { default: () => Array.prototype.findIndex },
      Y: { async queryEmojiRelation(account, time) {
        assert.equal(account, 'fixture'); assert.equal(time, full ? '0' : cursor);
        if (transport) throw transport;
        return { errorCode: responseError || 0, data: dataMissing ? null : relationMissing ? { lastSyncTime: 'unusable-without-relations' } : { changeRelation: clone(changes), lastSyncTime: 'server-emoji-cursor' } };
      } },
      j: { default: { getDB: () => ({
        async queryUserKeyValue() { return { value: cursor }; }, async queryCustomEmoji() { return clone(db); },
        async deleteCustomEmoji({ emojiIdList }) { if (database) throw database; writes.push(['delete', clone(emojiIdList)]); for (let i = db.length - 1; i >= 0; --i) if (emojiIdList.includes(db[i].emojiId)) db.splice(i, 1); },
        async addCustomEmojiList(list) { if (database) throw database; writes.push(['add', clone(list)]); for (const item of list) { const index = db.findIndex(value => value.emojiId === item.emojiId); if (index < 0) db.push(clone(item)); else db[index] = clone(item); } },
        async addUserKeyValue(value) { if (database) throw database; writes.push(['cursor', clone(value)]); }
      }) } },
      Q: { default: { getApi: () => ({ syncAllGlobalDispatch(action) { actions.push(clone(action)); state.editor.emoji.emojiMap.custom = action.payload.list; } }) } }
    });
    await sync('fixture', full);
    return { db, writes, actions, log };
  }
  const a = { emojiId: 'a', indexNo: 1 }, b = { emojiId: 'b', indexNo: 2 };
  let result = await syncCase({});
  assert.equal(result.log.errors.length, 0); assert.deepEqual(result.actions[0].payload.list, []); assert.equal(result.actions.length, 1);
  result = await syncCase({ cached: [a], changes: [] });
  assert.deepEqual(result.actions[0].payload.list.map(value => value.emojiId), ['a']); assert.equal(result.actions.length, 1);
  result = await syncCase({ visible: [a], dataMissing: true });
  assert.deepEqual(result.actions[0].payload.list, [a]); assert.equal(result.log.errors.length, 0);
  assert.equal(result.writes.length, 0, 'absent data must not advance the incremental cursor');
  for (const options of [
    { full: true, dataMissing: true },
    { cursor: '0', dataMissing: true },
    { full: true, relationMissing: true }
  ]) {
    result = await syncCase({ cached: [a], ...options });
    assert.deepEqual(result.db, [a]); assert.deepEqual(result.actions[0].payload.list, [a]);
    assert.equal(result.writes.length, 0, 'missing relations must not reset the cache or cursor');
    assert.equal(result.log.errors.length, 0);
  }
  result = await syncCase({ cached: [a], full: true, changes: null });
  assert.deepEqual(result.db, [a]); assert.equal(result.writes.length, 0);
  assert.equal(result.log.errors.length, 1, 'malformed explicit relations remain a real error');
  result = await syncCase({ cached: [a], full: true, changes: [] });
  assert.deepEqual(result.db, []); assert.deepEqual(result.actions[0].payload.list, []); assert.equal(result.log.errors.length, 0);
  assert.deepEqual(result.writes.filter(value => value[0] === 'delete'), [['delete', ['a']]]);
  assert.deepEqual(result.writes.filter(value => value[0] === 'cursor'), [['cursor', { key: 'emoji-cursor', value: 'server-emoji-cursor' }]]);
  assert.equal(result.actions.length, 1, 'an explicit empty full snapshot clears the visible list once');
  result = await syncCase({ cached: [a], changes: [b], full: true });
  assert.deepEqual(result.db.map(value => value.emojiId), ['b']); assert.deepEqual(result.actions[0].payload.list.map(value => value.emojiId), ['b']);
  assert.equal(result.actions.length, 1); assert.equal(result.writes.filter(value => value[0] === 'cursor').length, 1);
  assert.equal(result.writes.at(-1)[1].value, 'server-emoji-cursor');
  result = await syncCase({ cached: [a, b], changes: [{ emojiId: 'a', state: 1 }] });
  assert.deepEqual(result.db.map(value => value.emojiId), ['b']); assert.deepEqual(result.actions[0].payload.list.map(value => value.emojiId), ['b']);
  result = await syncCase({ cached: [a], changes: [{ emojiId: 'a', state: 1 }] });
  assert.deepEqual(result.db, []); assert.deepEqual(result.actions[0].payload.list, []); assert.equal(result.log.errors.length, 0);
  result = await syncCase({ cached: [a], responseError: 503 });
  assert.ok(result.log.errors.length); assert.equal(result.writes.length, 0); assert.deepEqual(result.db, [a]);
  for (const field of ['transport', 'database']) {
    const error = new Error(field + '-failure'); await assert.rejects(syncCase({ cached: [a], [field]: error }), value => value === error);
  }
  ok();

  // Module 42991: IM login timeout timer must not arm while already online and
  // must cancel any prior timer so repeated LoginSuccess updates cannot leak it.
  const netPingState = { global: { isOnline: true }, serverConfig: { maa_uri: 'im.invalid:443', isSupportProxy: false } };
  const pingTimers = new Map(); let nextPingId = 0, connectCalls = 0;
  const pingLog = logger();
  const netPingWindow = {
    require: name => {
      if (name === 'child_process') return { exec() { throw new Error('Linux tcpping must not shell out'); } };
      assert.equal(name, 'net');
      return {
        createConnection(opts) {
          ++connectCalls;
          const handlers = {};
          return {
            setTimeout() {},
            destroy() {},
            once(ev, fn) { handlers[ev] = fn; if (ev === 'connect') fn(); }
          };
        }
      };
    },
    getLogger: () => () => pingLog
  };
  const netPingExports = {};
  run(common(42991).text, {
    window: netPingWindow,
    process: { platform: 'linux' },
    clearTimeout: id => { pingTimers.delete(id); }
  })({}, netPingExports, id => {
    if (id === 53930) return Object.defineProperty;
    if (id === 14881) return v => v && v.__esModule ? v : { default: v };
    if (id === 56255) return (fn, ms) => { const tid = ++nextPingId; pingTimers.set(tid, { fn, ms }); return tid; };
    if (id === 83691) return { $imState: () => netPingState };
    throw new Error('unexpected netPing dep ' + id);
  });
  netPingExports.tcppingImLoginTiming();
  assert.equal(pingTimers.size, 0, 'Already-online IM must not arm 15s login timeout timer');
  netPingState.global.isOnline = false;
  netPingExports.tcppingImLoginTiming();
  assert.equal(pingTimers.size, 1);
  const firstTid = [...pingTimers.keys()][0];
  netPingExports.tcppingImLoginTiming();
  assert.equal(pingTimers.size, 1, 'Second arm must cancel previous timer');
  assert.equal(pingTimers.has(firstTid), false);
  netPingExports.clearPspingImLoginTiming();
  assert.equal(pingTimers.size, 0);
  netPingExports.tcppingImLoginTiming();
  const activeTimer = [...pingTimers.values()][0];
  activeTimer.fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(connectCalls >= 1, 'Offline 15s timeout must trigger Linux TCP probe');
  assert.equal(pingLog.infos.some(row => String(row[0]).includes('im login timeout 15s')), true);
  ok();

  // Module 25007: loginStateChange (Ve) must skip DB/token/UM re-init when
  // login_status !== LoginSuccess and discard stale awaits superseded by logout.
  const m25007 = common(25007);
  const veHarness = () => {
    const imState = {
      loginConfig: { login_status: 0, isUserLogined: false, loginIntent: 0, tenantid: 't1',
        middle_ground_token: '', middle_ground_onebox_cookie: '' },
      global: { isUseMessagePreview: false, isShowLastMsg: false }
    };
    const trace = [], dispatches = [], dbWaiters = [];
    let holdDb = false;
    const stubLog = logger();
    const ctx = {
      window: { isRedblue: false, dispatchEvent(ev) { trace.push(['event', ev.type]); },
        Pedestal: { callMethod() {}, sendBroadcast() {} } },
      Event: function Event(type) { this.type = type; },
      localStorage: { getItem: () => '0' },
      isNullOrEmpty: v => v == null || v === '',
      handleAccountPrint: v => String(v || ''),
      G: { AccessStatus: { NoLogin: 0, InLogin: 1, LoginSuccess: 2, InLogout: 3 }, CHANGE_MAP_MODE: { CLEAR: 1 } },
      E: { $imState: () => imState, globalDispatch(a) { dispatches.push(a); } },
      de: { syncAllGlobalDispatch(a) {
        dispatches.push(a);
        if (a.type === 'UPDATE_LOGIN_CONFIG') Object.assign(imState.loginConfig, a.payload);
      } },
      De: { default: { clearRedux() {
        trace.push(['clearRedux']);
        imState.loginConfig = { login_status: 0, isUserLogined: false, loginIntent: 0, tenantid: 't1',
          middle_ground_token: '', middle_ground_onebox_cookie: '' };
      } } },
      j: { setKeypadNumber() {} }, Z: {}, Y: { cleanAllModal() {} }, Q: { clearEmoji() {}, clearQuerySysProfileEnableTimer() {} },
      F: { clearVoiceSetting() {}, async queryImSetting() {} }, ne: {}, Se: { default: () => null },
      ve: { default: { clearSessionIds() {} } }, we: { clearScrolls() {} }, ke: stubLog,
      H: { saveEditorDraft() {} }, k: { clearCurrentSelectStatus() {}, initUserLoginStatus() {} },
      O: { clearFailQueue() {} }, Ie: { default: { getApi: () => ({ changeSendingMsgMap() {} }) } },
      y: { cleanFlashTray() {} }, I: { default: { clearTray() {} } }, Ge: { clearQueue() {} },
      Ue: '', Ne: { IMEXTYPE: { INIT: 0, EXPORTING: 1, IMPORTING: 2 } },
      h: { LeaveMsg: { clearMsgIdMap() {} }, LoadDBRecent: { clear() {} } },
      he: { default: {
        getImAndexport: () => ({ Shutdown() {} }),
        getDB: () => ({
          releaseSqliteDBHandler(arg) { trace.push(['releaseDB', arg.info]); },
          initSQLitePrivateDB(arg) {
            trace.push(['initDB', arg.account]);
            if (!holdDb) return Promise.resolve();
            return new Promise(resolve => dbWaiters.push(resolve));
          }
        }),
        getOfflineFile: () => ({ umServerLogout() { trace.push(['umLogout']); } })
      } },
      fe: { sendClearUserStatusBroadcast() {} }, Me: { default: { clear() {} } }, N: { cleanWinModal() {} },
      _: { default: () => Array.prototype.find }, S: { contactAvatarInit(arg) { trace.push(['avatarInit', arg.account]); } },
      Be: tok => { trace.push(['Be', tok]); },
      He: ck => { trace.push(['He', ck]); },
      A: { blueImLogin(cfg) { trace.push(['blueImLogin', cfg.login_status, cfg.uuid]); } },
      ae: { default(cfg) { trace.push(['doImInit', cfg.uuid]); imState.loginConfig = { ...imState.loginConfig, ...cfg }; } },
      $: { updateLanguagesList() {} }, M: { cancelAllFileSend() {}, stopAllFileReceive() {} },
      ge: { syncAllWindowDraft() {} }, te: { clearQueryTimer() {} }
    };
    const Ve = run('let Fe=null,_veSeq=0;' + m25007.function('Ve') + ';Ve', ctx);
    return { Ve, imState, trace, dispatches, dbWaiters, setHoldDb: v => { holdDb = v; } };
  };
  // 1) Normal login -> hourly token refresh -> two-step logout (exact rina sequence)
  const h1 = veHarness();
  await h1.Ve({ login_status: 2, isUserLogined: true, loginIntent: 1, uuid: 'u@t1', tenantid: 't1',
    middle_ground_token: 'tok-1', middle_ground_onebox_cookie: 'ck-1' });
  assert.ok(h1.trace.some(([k, v]) => k === 'initDB' && v === 'u@t1'));
  assert.ok(h1.trace.some(([k, v]) => k === 'Be' && v === 'tok-1'));
  assert.ok(h1.trace.some(([k, v]) => k === 'He' && v === 'ck-1'));
  assert.ok(h1.trace.some(([k, v]) => k === 'doImInit' && v === 'u@t1'));
  h1.trace.length = 0;
  // Hourly token refresh while LoginSuccess
  await h1.Ve({ login_status: 2, isUserLogined: true, loginIntent: 1, uuid: 'u@t1', tenantid: 't1',
    middle_ground_token: 'tok-2', middle_ground_onebox_cookie: 'ck-2' });
  assert.ok(h1.trace.some(([k, v]) => k === 'Be' && v === 'tok-2'));
  assert.ok(h1.trace.some(([k, v]) => k === 'He' && v === 'ck-2'));
  assert.equal(h1.trace.some(([k]) => k === 'doImInit'), false);
  h1.trace.length = 0;
  // Logout broadcast #1 (stale token still on payload, status=0) + broadcast #2 (cleared)
  await h1.Ve({ login_status: 0, isUserLogined: false, loginIntent: 1, uuid: 'u@t1', tenantid: 't1',
    middle_ground_token: 'tok-2', middle_ground_onebox_cookie: 'ck-2' });
  await h1.Ve({ login_status: 0, isUserLogined: false, loginIntent: 0, uuid: '', tenantid: 't1',
    middle_ground_token: '', middle_ground_onebox_cookie: '' });
  assert.equal(h1.trace.some(([k]) => k === 'initDB'), false, 'Logout must never re-open SQLite DB');
  assert.equal(h1.trace.some(([k]) => k === 'Be'), false, 'Logout must never invoke getCloudDiskToken via Be');
  assert.equal(h1.trace.some(([k]) => k === 'He'), false, 'Logout must never invoke umServerReLogin via He');
  assert.ok(h1.trace.some(([k]) => k === 'releaseDB'), 'Logout must release SQLite DB');
  assert.ok(h1.trace.some(([k]) => k === 'umLogout'), 'Logout must call umServerLogout');
  assert.ok(h1.trace.some(([k, st]) => k === 'blueImLogin' && st === 0), 'Logout must notify IM SDK');
  // 2) Async race: LoginSuccess suspended in initSQLitePrivateDB, superseded by logout
  const h2 = veHarness();
  h2.setHoldDb(true);
  const pLogin = h2.Ve({ login_status: 2, isUserLogined: true, loginIntent: 1, uuid: 'u@t1', tenantid: 't1',
    middle_ground_token: 'tok-stale', middle_ground_onebox_cookie: 'ck-stale' });
  assert.equal(h2.dbWaiters.length, 1);
  await h2.Ve({ login_status: 0, isUserLogined: false, loginIntent: 0, uuid: '', tenantid: 't1',
    middle_ground_token: '', middle_ground_onebox_cookie: '' });
  h2.dbWaiters.shift()();
  await pLogin;
  assert.equal(h2.trace.some(([k]) => k === 'Be'), false, 'Superseded login must not invoke Be after logout');
  assert.equal(h2.trace.some(([k]) => k === 'He'), false, 'Superseded login must not invoke He after logout');
  assert.equal(h2.trace.some(([k, st]) => k === 'blueImLogin' && st === 2), false,
    'Superseded login must not invoke blueImLogin(2) after logout');
  ok();
}
async function avatarCases(relative) {
  const contact = bundle(relative), producer = contact(77594), download = contact(85975);
  const log = logger(), main = fs.mkdtempSync(path.join(temp, 'main-')) + '/', incoming = fs.mkdtempSync(path.join(temp, 'incoming-')) + '/';
  const account = 'fixture@example.invalid', name = account + '_timestamp_0.png';
  const published = [], requests = [];
  let nodeFs = fs, requestError, ack = 0, response;
  const appService = {
    getAvatarPath: () => main, getTempAvatarPath: () => incoming, getNodeFs: () => nodeFs,
    async copyFile(from, to) { await fs.promises.copyFile(from, to); },
    async isFileExist(file) { try { await fs.promises.access(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
  };
  const context = vm.createContext({
    console, fs, Promise, URL, Date, setTimeout, clearTimeout, logger: log,
    window: { isRedblue: false, contactState: () => ({ myInfo: { account: 'self@example.invalid' } }) },
    contactState: () => ({ login: { account: 'self@example.invalid' } }),
    contactAppService: appService, contactCoreCommon: { getSelfAccount: () => 'self@example.invalid' },
    isNullOrEmpty: value => value == null || value === '' || typeof value === 'object' && Object.keys(value).length === 0,
    handleAccountPrint: value => value, autoGenerateEntry: (name, entry) => name + entry,
    contactLogger: { getLogger: () => () => log },
    __webpack_require__: id => { if (id === 6113) return crypto; if (id === 57147) return fs; throw new Error('Unexpected checksum dependency ' + id); },
    _defineProperty: (object, key, value) => { object[key] = value; return object; },
    updateAvatarMap: value => published.push(value), checkSamePersonAvatarExcept: async () => {},
    contactConstant: { AS_AVATAR_RESP_CODE: { SUCCESS: 200, NO_AVATAR: 404, NO_CHANGE: 304, AUTHENTICATION_ERROR: 401, SERVER_ERROR: 500, OTHER_ERROR: -1 } },
    _util__WEBPACK_IMPORTED_MODULE_0__: { yN: () => false }, _publicFunc__WEBPACK_IMPORTED_MODULE_1__: {},
    addressServer: { async downloadHeadPortrait(request) { requests.push(request); if (requestError) throw requestError; if (ack === 0) request.resultCallback(response); return { result: ack }; } }
  });
  function evaluate(code) { return vm.runInContext(code, context, { timeout: 10000 }); }
  for (const name of ['_typeof', '_regeneratorRuntime', 'asyncGeneratorStep', '_asyncToGenerator']) {
    // Some Babel modules inline _asyncToGenerator at their only use.
    const module = name === '_asyncToGenerator' ? download : producer;
    evaluate(module.function(name));
  }
  evaluate('var getImgCheckSum=' + download.value('getImgCheckSum') + ';var getAvatarRealPath=' + download.value('getAvatarRealPath') + ';');
  evaluate(download.function('avatarDownFailed') + ';' + download.function('_dealDownloadAsAvatarResult') + ';');
  evaluate('var dealDownloadAsAvatarResult=_dealDownloadAsAvatarResult;var downloadAvatarLogic=' + producer.value('downloadAvatarLogic') + ';');
  evaluate('var checkLocalAvatarPath=' + download.value('checkLocalAvatarPath') + ';');
  const search = context.downloadAvatarLogic, deal = context._dealDownloadAsAvatarResult;
  function body(code, tag) {
    const header = [{ name: 'ID', value: account }];
    if (tag !== undefined) header.push({ name: 'ETag', value: tag });
    Object.defineProperty(header, 'query', { value: key => header.find(value => value.name === key.name) });
    return { account, param: { ret: 0, rsp_body: { rsp_code: code, header } } };
  }
  for (const url of ['', null, 'null']) {
    const result = await search({ account, avatarUrl: url });
    assert.equal(result.avatarRequestSkipped, 'no-url'); await deal(result);
  }
  assert.equal(requests.length, 0); assert.equal(log.errors.length, 0); assert.equal(published.length, 0);
  fs.writeFileSync(main + name, 'cached-avatar');
  let result = await search({ account, avatarUrl: 'https://example.invalid/avatar' });
  assert.equal(result.avatarRequestSkipped, 'cached'); await deal(result);
  assert.equal(requests.length, 0); assert.equal(log.errors.length, 0);
  assert.equal(await context.checkLocalAvatarPath(account), main + name);
  fs.unlinkSync(main + name);
  assert.equal(await context.checkLocalAvatarPath(account), '');
  response = body(404);
  result = await search({ account, avatarUrl: 'https://example.invalid/avatar' });
  assert.equal(requests.length, 1); assert.equal(requests[0].avatarUrl, 'https://example.invalid/avatar'); await deal(result);
  await deal(body(304, 'not-a-downloaded-file'));
  assert.equal(log.errors.length, 0); assert.equal(published.length, 0);
  const bytes = Buffer.from('synthetic-avatar-bytes'), digest = crypto.createHash('md5').update(bytes).digest('hex');
  fs.writeFileSync(incoming + name, bytes); await deal(body(200, '"' + digest + '"'));
  assert.deepEqual(fs.readFileSync(main + name), bytes); assert.equal(published.length, 1);
  fs.unlinkSync(main + name); fs.writeFileSync(incoming + name, 'truncated');
  await deal(body(200, digest)); assert.equal(published.length, 1); assert.equal(fs.existsSync(incoming + name), false); assert.ok(log.errors.length);
  const count = log.errors.length; await deal(body(200, digest));
  assert.equal(published.length, 1); assert.equal(log.errors.length, count + 1); assert.equal(log.errors.at(-1)[1].code, 'ENOENT');
  await deal({}); await deal({ param: { ret: 128 } });
  assert.equal(log.errors.length, count + 3);
  await deal({ avatarRequestSkipped: 'cached', param: { ret: 128 } });
  assert.equal(log.errors.length, count + 4, 'skip metadata must not hide a transport error');
  requestError = new Error('avatar-transport-failure');
  await assert.rejects(search({ account, avatarUrl: 'https://example.invalid/avatar' }), error => error === requestError);
  requestError = undefined;
  const denied = Object.assign(new Error('cache permission denied'), { code: 'EACCES' });
  nodeFs = { stat(file, callback) { callback(denied); } };
  await assert.rejects(search({ account, avatarUrl: 'https://example.invalid/avatar' }), error => error === denied);
  context.fs = { promises: { stat: async () => { throw denied; } } };
  await assert.rejects(context.checkLocalAvatarPath(account), error => error === denied);
  context.fs = fs; nodeFs = fs;
  ack = 503;
  result = await search({ account, avatarUrl: 'https://example.invalid/avatar' });
  assert.equal(result.param.ret, 503); const errors = log.errors.length; await deal(result); assert.equal(log.errors.length, errors + 1);
  // Successful acknowledgement is not a completed download: retain the result timeout.
  let timeoutCallback;
  context.setTimeout = callback => { timeoutCallback = callback; return 1; };
  context.clearTimeout = () => {};
  let notified;
  const requested = new Promise(resolve => { notified = resolve; });
  context.addressServer.downloadHeadPortrait = async () => { notified(); return { result: 0 }; };
  const timedOut = search({ account, avatarUrl: 'https://example.invalid/avatar' });
  await requested; timeoutCallback();
  await assert.rejects(timedOut, error => error.code === 'ETIMEDOUT');
  // Both the IPC wrapper and queued download wrapper must preserve rejections.
  const ipcError = new Error('avatar-ipc-failure');
  context._pluginCommunication_plugMethods__WEBPACK_IMPORTED_MODULE_0__ = { u8: async () => { throw ipcError; } };
  evaluate(download.function('contactDownAvatar') + ';' + download.function('_contactDownAvatar') + ';');
  await assert.rejects(context.contactDownAvatar({ account, avatarUrl: 'https://example.invalid/avatar' }), error => error === ipcError);
  context.isStop = false; context.checkCanDownloadAvatar = () => true; context._objectSpread = Object.assign;
  evaluate(download.function('downloadAsAvatar'));
  await assert.rejects(context.downloadAsAvatar({ account, avatarUrl: 'https://example.invalid/avatar' }), error => error === ipcError);
  ok();
}
(async () => {
  try {
    for (const directory of ['pedestal/im/static/js', 'plugin/im/dist/im/static/js']) await imCases(directory);
    for (const relative of ['pedestal/contact/js/contact.js', 'plugin/contact/dist/contact/js/contact.js']) await avatarCases(relative);
    console.log(JSON.stringify({ result: 'passed', groups: cases, scope: 'both IM and contact bundle copies; no network or account access' }));
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
