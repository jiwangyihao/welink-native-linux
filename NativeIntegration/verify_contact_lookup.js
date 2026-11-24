#!/usr/bin/env node
'use strict';
// Parent-run, offline regression against actual shipped factories, not a replacement consumer.
// node NativeIntegration/verify_contact_lookup.js --app /image/resources/app --expect fixed
// --expect legacy records the two original failures on the sealed baseline.
// Authority: contact 99202 dealContactList preserves request order/duplicates and emits {};
// contact 35046 getContactByNewWorkId matches provider workId and also emits {}.
// IM 43875/78205 are the IPC adapters; 93444 owns canonical cache writes; 1511/47994
// owns the account->work-ID cache alias. No response index authorizes an identity.
// A placeholder is unresolved, NOT proof of nonexistence: existing provider catches may
// also yield no records. Native Contact/contact_records.inc select_records returns only
// database rows (_retlen=0 when absent); collect_rows projects ACCOUNT as account and
// reports SQLite failures separately. It does not manufacture the per-request {} slots.
const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const acorn = require(process.env.WELINK_TEST_ACORN || 'acorn');
function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}
const app = option('--app');
const expected = option('--expect', 'fixed');
const only = option('--only');
assert.ok(app, '--app requires an assembled resources/app directory');
assert.ok(['legacy', 'fixed'].includes(expected), '--expect must be legacy or fixed');
assert.ok(only === undefined || only === 'ambiguity', '--only supports ambiguity');
assert.ok(!only || expected === 'fixed', '--only ambiguity requires --expect fixed');
const clone = value => JSON.parse(JSON.stringify(value));
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
  visit(acorn.parse(source, { ecmaVersion: 'latest' }), node => {
    if (node.type === 'Property' && node.key.type === 'Literal' && typeof node.key.value === 'number' &&
        /FunctionExpression$/.test(node.value.type)) modules.set(node.key.value, node.value);
  });
  return id => {
    const node = modules.get(id);
    assert.ok(node, relative + ': missing module ' + id);
    return {
      text: '(' + source.slice(node.start, node.end) + ')',
      find(type, name) {
        const matches = [];
        visit(node, child => { if (child.type === type && child.id?.name === name) matches.push(child); });
        assert.equal(matches.length, 1, relative + ': unique ' + name);
        const match = matches[0];
        return source.slice(match.start, match.end);
      },
      value(name) { return this.find('VariableDeclarator', name).slice(name.length + 1); },
      function(name) { return this.find('FunctionDeclaration', name); }
    };
  };
}
const empty = value => value == null || (typeof value === 'object' ? Object.keys(value).length === 0 : value === '');
function run(source, globals) { return vm.runInNewContext(source, globals, { timeout: 10000 }); }
const helpers = {
  53930: Object.defineProperty,
  14881: value => value && value.__esModule ? value : { default: value },
  48079: value => value.map, 86226: value => value.forEach,
  96319: value => value.filter, 71426: value => value.find, 18979: value => value.slice,
  61240: Promise, 49763: Array.from, 59261: Set, 29550: Date.now,
  8628: value => value.includes, 29544: Object.assign,
  271: (object, key, value) => Object.defineProperty(object, key, { value, enumerable: true, configurable: true, writable: true })
};
function factory(module, dependencies, window) {
  const exports = {};
  run(module.text, { window, isNullOrEmpty: empty, handleAccountPrint: () => '[masked]' })(
    {}, exports, id => {
      const available = { ...helpers, ...dependencies };
      assert.ok(Object.prototype.hasOwnProperty.call(available, id), 'unexpected dependency ' + id);
      return available[id];
    });
  return exports;
}
function projectProvider(module) {
  return run('(' + module.value('dealContactList') + ')', {
    window: { contactCoreCommon: { isSelfAccount: () => false } },
    isNullOrEmpty: empty, _objectSpread: Object.assign
  });
}
function retryProvider(module, records) {
  const calls = [];
  const Pedestal = { async callMethod(method, payload) {
    calls.push({ method, payload: clone(payload) });
    if (method === 'method://contact/getContactForImport') {
      assert.equal(payload.type, 1);
      return { data: records.filter(row => payload.value.includes(row.workId.toLowerCase())).map(row => ({ userId: row.account })) };
    }
    assert.equal(method, 'fixture://canonical-contact-detail');
    return records.filter(row => payload.list.includes(row.account.toLowerCase()));
  } };
  const declarations = ['_regeneratorRuntime', 'asyncGeneratorStep', '_asyncToGenerator']
    .map(name => module.function(name)).join('\n');
  const query = run(declarations + '\n(' + module.value('getContactByNewWorkId') + ')', {
    isNullOrEmpty: empty, Pedestal, logger: { info() {} },
    _commonFile_logic_enumApi__WEBPACK_IMPORTED_MODULE_8__: { mw: { CNO_140: { DEFINE: 'fixture://canonical-contact-detail' } } }
  });
  return { query, calls };
}
function environment(common, reducers, settings = {}) {
  const records = { infos: [], errors: [], debug: [] }, calls = [], writes = [], statuses = [];
  const logger = { info: (...args) => records.infos.push(args), error: (...args) => records.errors.push(args),
    warn: (...args) => records.errors.push(args), debug: (...args) => records.debug.push(args) };
  const state = { loginConfig: { tenantid: 'fixture-tenant' }, user: { userMap: {}, w3accountMap: {} } };
  const handlers = { primary: async () => [], retry: async () => [], outer: async () => ({ code: 0, message: 'success', data: [] }), ...settings };
  const window = { isRedblue: !!settings.redblue, $uuid: 'fixture-self', getLogger: () => () => logger,
    Pedestal: { async callMethod(method, payload) {
      calls.push({ method, payload: clone(payload) });
      if (method === 'method://contact/getContactListByAccountList') return handlers.primary(payload);
      if (method === 'method://contact/getContactByNewWorkId') return handlers.retry(payload);
      assert.equal(method, 'method://contact/getOuterUserInfoList');
      return handlers.outer(payload);
    } } };
  // Execute the actual reducer against a synthetic mutable draft; no renderer/IPC exists.
  const reducer = factory(reducers(47994), { 41261: { produce: callback => callback }, 52987: { deepClone: clone } }, window).default;
  const store = { $imState: () => state, globalDispatch(action) {
    writes.push(clone(action));
    state.user = reducer(state.user, action);
  } };
  const directory = factory(common(43875), { 7169: { getOuterCropName: () => true } }, window);
  const workDirectory = factory(common(78205), {}, window);
  const consumer = factory(common(93444), {
    83691: store, 43875: directory, 78205: workDirectory,
    40754: { updateUserStatus: value => statuses.push(value) },
    54589: { USERSTATE: { ONLINE: 1 } },
    5722: { isRobotUser: row => row.fixtureRobot === true },
    86647: { splitByNum(list, size) { const result = []; for (let index = 0; index < list.length; index += size) result.push(list.slice(index, index + size)); return result; } }
  }, window).default;
  return { consumer, state, handlers, records, calls, writes, statuses, window };
}
function primaryCalls(env) { return env.calls.filter(call => call.method === 'method://contact/getContactListByAccountList'); }
function retryCalls(env) { return env.calls.filter(call => call.method === 'method://contact/getContactByNewWorkId'); }
function outcomes(env) { return env.records.infos.filter(args => args[0] === 'getUserInfoByContact outcomes').at(-1)?.[1]; }
function privateFree(env) {
  assert.doesNotMatch(JSON.stringify(env.records), /fixture-account|fixture-name|fixture-mail|fixture-secret|fixture-work/,
    'lookup diagnostics must contain counts, not request identifiers or response payloads');
}
async function settledWithin(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('contact promise did not settle')), 2000); })]); }
  finally { clearTimeout(timer); }
}
let groups = 0;
async function ambiguityCases(common, reducers) {
  const canonical = { account: 'ncanonical', workId: '217', name: 'fixture-name-canonical' };
  const other = { ...canonical, account: 'nother', name: 'fixture-name-other' };
  const userIds = [canonical.account, other.account, 'n217'];
  // Intentionally omit isSaveStore: this must exercise the normal reducer path.
  const env = environment(common, reducers, { redblue: true, primary: async () => [canonical, other] });
  const query = () => env.consumer.getUsersDetail({ userIds, shouldReturn: true, isRetryWordId: true });
  assert.deepEqual(clone(await query()).map(row => row.account), [canonical.account, other.account]);
  assert.deepEqual(Object.keys(env.state.user.userMap).sort(), [canonical.account, other.account]);
  assert.equal(Object.prototype.hasOwnProperty.call(env.state.user.w3accountMap, 'n217'), false,
    'the reducer must not persist a last-writer-wins alias for two canonical contacts');

  const callsBeforeCache = primaryCalls(env).length;
  assert.deepEqual(clone(await env.consumer.getUsersDetail({
    userIds: [canonical.account, other.account], shouldReturn: true
  })).map(row => row.account), [canonical.account, other.account]);
  assert.equal(primaryCalls(env).length, callsBeforeCache, 'both canonical contacts remain usable from cache');

  // A later one-row result must not erase the other cached claimant or make
  // the previously ambiguous lookup resolve to that row via a persisted alias.
  env.handlers.primary = async () => [canonical];
  assert.deepEqual(clone(await query()).map(row => row.account), [canonical.account, other.account]);
  assert.equal(Object.prototype.hasOwnProperty.call(env.state.user.w3accountMap, 'n217'), false);
  assert.deepEqual(clone(await env.consumer.getUsersDetail({
    userIds: ['n217'], shouldReturn: true, isRetryWordId: true
  })), []);
  assert.equal(env.state.user.userMap[other.account].account, other.account);
  privateFree(env); ++groups;

  const noSave = environment(common, reducers, { redblue: true, primary: async () => [canonical, other] });
  const transient = await noSave.consumer.getUsersDetail({
    userIds, shouldReturn: true, isSaveStore: false, isRetryWordId: true
  });
  assert.deepEqual(clone(transient).map(row => row.account), [canonical.account, other.account]);
  assert.equal(noSave.writes.length, 0);
  ++groups;
}
async function cases(directory, contactRelative) {
  const common = bundle(directory + '/common.js'), reducers = bundle(directory + '/1511.js');
  if (only === 'ambiguity') { await ambiguityCases(common, reducers); return; }
  const contact = bundle(contactRelative), project = projectProvider(contact(99202));
  const first = { account: 'fixture-account-a', name: 'fixture-name-a', foreign_name: 'fixture-name-en', email: 'fixture-mail', nick_name: 'fixture-secret-remark' };
  const second = { account: 'fixture-account-b', name: 'fixture-name-b' };
  const list = [first.account, 'fixture-account-unresolved', first.account, second.account];
  const response = project(list, { [first.account]: first, [second.account]: second });
  assert.deepEqual(clone(response).map(row => row.account || null), [first.account, null, first.account, second.account]);
  const mixed = environment(common, reducers, { primary: async () => response });
  const result = await mixed.consumer.getUserInfoByContact({ userIds: list });
  assert.deepEqual(clone(result).map(row => row.account), [first.account, first.account, second.account]);
  assert.deepEqual(Object.keys(mixed.state.user.userMap).sort(), [first.account, second.account]);
  assert.equal(mixed.state.user.userMap[first.account].englishName, first.foreign_name);
  assert.equal(mixed.state.user.userMap[first.account].shouldGetUserMap, false);
  assert.equal(mixed.state.user.userMap['fixture-account-unresolved'], undefined);
  const emptyPrimary = environment(common, reducers, { redblue: true, retry: async () => [first] });
  const emptyResult = await emptyPrimary.consumer.getUserInfoByContact({ userIds: [first.account], isRetryWordId: true });
  if (expected === 'legacy') {
    assert.equal(mixed.records.errors.length, 1, 'baseline reports the provider placeholder as an error');
    assert.match(mixed.records.errors[0][0], /getUserInfoByContact end has error data/);
    assert.equal(mixed.records.errors[0][1], 1);
    assert.equal(retryCalls(emptyPrimary).length, 0, 'baseline fails to retry an empty primary result');
    assert.deepEqual(clone(emptyResult), []);
    ++groups;
    return;
  }
  assert.equal(mixed.records.errors.length, 0, 'the provider empty slot is unresolved, not malformed');
  assert.equal(outcomes(mixed).unresolvedCount, 1);
  assert.equal(outcomes(mixed).placeholderCount, 1);
  assert.equal(outcomes(mixed).resolvedCount, 3, 'valid duplicate rows must not collapse');
  assert.equal(response[0].nick_name, first.nick_name, 'the provider-owned row must not be mutated');
  assert.equal(retryCalls(emptyPrimary).length, 1);
  assert.deepEqual(clone(emptyResult).map(row => row.account), [first.account]);
  privateFree(mixed); ++groups;

  const malformed = environment(common, reducers, {
    primary: async () => [second, {}, null, { name: 'fixture-secret-without-account' }, { account: '' }, { account: 4 }, [], undefined, first]
  });
  const retained = await malformed.consumer.getUserInfoByContact({ userIds: list });
  assert.deepEqual(clone(retained).map(row => row.account), [second.account, first.account], 'match by canonical account, never response position');
  assert.equal(malformed.records.errors.length, 1);
  assert.equal(malformed.records.errors[0][1].invalidCount, 6);
  assert.deepEqual(Object.keys(malformed.state.user.userMap).sort(), [first.account, second.account]);
  assert.equal(outcomes(malformed).unresolvedCount, 1);
  privateFree(malformed); ++groups;

  const external = { ...first, isExternal: '2' };
  const enrichment = environment(common, reducers, { primary: async () => [null, external, second],
    outer: async () => ({ code: 0, message: 'success', data: [{ ...external, relation: 1, mobile: 'fixture-secret-mobile' }] }) });
  const enriched = await enrichment.consumer.getUserInfoByContact({ userIds: [first.account, second.account] });
  assert.deepEqual(clone(enriched).map(row => row.account), [first.account, second.account]);
  assert.equal(enrichment.records.errors[0][1].invalidCount, 1);
  assert.equal(enrichment.state.user.userMap[first.account].mobile, 'fixture-secret-mobile');
  privateFree(enrichment); ++groups;

  const outerFailure = Object.assign(new Error('fixture-secret-enrichment'), { code: 'E_OUTER_FIXTURE' });
  const outerRows = Array.from({ length: 51 }, (_, index) => ({ account: 'fixture-account-outer-' + index, isExternal: '2' }));
  let outerBatchCount = 0;
  const outerBatches = environment(common, reducers, { primary: async () => outerRows, outer: async () => {
    if (++outerBatchCount === 2) throw outerFailure;
    return { code: 0, message: 'success', data: [] };
  } });
  await assert.rejects(outerBatches.consumer.getUserInfoByContact({ userIds: outerRows.map(row => row.account) }), error => error === outerFailure);
  assert.equal(outerBatchCount, 2, 'every enrichment batch must be awaited, not fire-and-forget');
  assert.equal(outerBatches.writes.length, 0);
  privateFree(outerBatches); ++groups;

  for (const invalid of [null, undefined, false, {}, 'fixture-secret-container', { length: 0 }]) {
    const env = environment(common, reducers, { primary: async () => invalid });
    await assert.rejects(env.consumer.getUserInfoByContact({ userIds: list }), error => error.name === 'TypeError');
    assert.equal(env.writes.length, 0);
    privateFree(env);
  }
  ++groups;

  const canonical = { account: 'ncanonical', workId: '217', name: 'fixture-name-work' };
  const retry = retryProvider(contact(35046), [canonical]);
  const work = environment(common, reducers, { redblue: true, retry: payload => retry.query(payload) });
  const workResult = await work.consumer.getUsersDetail({ userIds: ['n217', 'prefix_217', 'n217', 'missing'], shouldReturn: true, isSaveStore: false, isRetryWordId: true });
  assert.deepEqual(clone(workResult).map(row => row.account), ['ncanonical', 'ncanonical', 'ncanonical']);
  assert.deepEqual(retryCalls(work)[0].payload.list, ['n217', 'prefix_217', 'missing']);
  assert.equal(retry.calls.length, 2, 'use actual import-to-canonical-detail work-ID provider');
  assert.equal(work.writes.length, 0);
  assert.deepEqual(work.state.user.w3accountMap, {});
  assert.equal(outcomes(work).unresolvedCount, 1);
  assert.equal(work.records.errors.length, 0);
  privateFree(work); ++groups;

  const omission = environment(common, reducers, { redblue: true, primary: async () => [first], retry: async () => [canonical] });
  await omission.consumer.getUserInfoByContact({ userIds: [first.account, 'n217', first.account], isRetryWordId: true });
  assert.deepEqual(retryCalls(omission)[0].payload.list, ['n217']);
  assert.equal(omission.state.user.w3accountMap.n217, 'ncanonical');
  assert.equal(omission.state.user.userMap.n217, undefined, 'an alias is not a replacement canonical account');
  assert.equal(outcomes(omission).unresolvedCount, 0);
  privateFree(omission); ++groups;

  const missing = environment(common, reducers, { primary: async ({ list }) => project(list, {}), retry: async () => [] });
  const partial = { name: 'fixture-secret-message-fallback', shouldGetUserMap: true };
  missing.state.user.userMap[first.account] = partial;
  assert.deepEqual(clone(await missing.consumer.getUserInfoByContact({ userIds: [first.account], isRetryWordId: true })), []);
  assert.equal(missing.writes.length, 0);
  assert.equal(missing.state.user.userMap[first.account], partial);
  missing.handlers.primary = async () => [first];
  assert.deepEqual(clone(await missing.consumer.getUsersDetail({ userIds: [first.account], shouldReturn: true })).map(row => row.account), [first.account]);
  assert.equal(primaryCalls(missing).length, 2, 'unresolved identities must remain eligible for later lookup');
  const cachedCalls = primaryCalls(missing).length;
  assert.deepEqual(clone(await missing.consumer.getUsersDetail({ userIds: [first.account, first.account], shouldReturn: true })).map(row => row.account), [first.account, first.account]);
  assert.equal(primaryCalls(missing).length, cachedCalls, 'valid cache entries suppress only their own repeated lookup');
  privateFree(missing); ++groups;

  for (const stage of ['primary', 'retry', 'outer']) {
    const failure = Object.assign(new Error('fixture-secret-transport-failure'), { code: 'E_FIXTURE', status: 503 });
    const env = environment(common, reducers, { primary: async () => stage === 'outer' ? [external] : [first], retry: async () => [] });
    env.handlers[stage] = async () => { throw failure; };
    await assert.rejects(env.consumer.getUserInfoByContact({ userIds: [first.account, 'unresolved'], isRetryWordId: true }), error => error === failure);
    if (stage === 'retry') assert.equal(env.state.user.userMap[first.account].account, first.account, 'retry failure must not discard valid primary cache writes');
    else assert.equal(env.writes.length, 0);
    privateFree(env);
  }
  const invalidRetry = environment(common, reducers, { primary: async () => [first, null], retry: async () => ({ error: 'fixture-secret-error' }) });
  await assert.rejects(invalidRetry.consumer.getUserInfoByContact({ userIds: [first.account, 'unresolved'], isRetryWordId: true }), error => error.name === 'TypeError');
  assert.equal(invalidRetry.state.user.userMap[first.account].account, first.account);
  assert.equal(invalidRetry.records.errors[0][1].invalidCount, 1);
  privateFree(invalidRetry); ++groups;

  for (const stage of ['primary', 'retry']) {
    const env = environment(common, reducers, { primary: async () => [first], retry: async () => [second] });
    env.handlers[stage] = async () => { env.state.loginConfig.tenantid = 'changed-tenant'; return [stage === 'primary' ? first : second]; };
    assert.deepEqual(clone(await env.consumer.getUserInfoByContact({ userIds: [first.account, second.account], isRetryWordId: true })), []);
    assert.equal(env.writes.length, 0, 'a tenant change must not write stale contact records');
  }
  ++groups;

  const robotEnv = environment(common, reducers, { primary: async () => [{ fixtureRobot: true }, { ...first, fixtureRobot: true }] });
  await robotEnv.consumer.getUserInfoByContact({ userIds: list });
  assert.equal(robotEnv.statuses.length, 1);
  assert.equal(robotEnv.statuses[0].userAccount, first.account);
  assert.equal(robotEnv.records.errors[0][1].invalidCount, 1);
  privateFree(robotEnv); ++groups;

  await ambiguityCases(common, reducers);

  let release;
  const failure = new Error('fixture-secret-large-request');
  const largeIds = Array.from({ length: 101 }, (_, index) => 'large-' + index);
  const large = environment(common, reducers, { primary: () => new Promise((_, reject) => { release = () => reject(failure); }) });
  const rejected = large.consumer.getUsersDetail({ userIds: largeIds, shouldReturn: true, isRetryWordId: true });
  const queued = large.consumer.getUsersDetail({ userIds: largeIds, shouldReturn: true, isSaveStore: false, isRetryWordId: true });
  large.handlers.primary = async () => [];
  large.handlers.retry = async () => [{ account: largeIds[0], name: 'fixture-name-large' }];
  const completion = settledWithin(Promise.allSettled([rejected, queued]));
  release();
  const states = await completion;
  assert.equal(states[0].status, 'rejected'); assert.equal(states[0].reason, failure);
  assert.equal(states[1].status, 'fulfilled'); assert.deepEqual(clone(states[1].value).map(row => row.account), [largeIds[0]]);
  assert.equal(large.consumer.pending, null);
  assert.equal(large.writes.length, 0);
  assert.equal(retryCalls(large).length, 1, 'queued requests retain the work-ID retry flag');
  privateFree(large); ++groups;
}
(async () => {
  await cases('pedestal/im/static/js', 'pedestal/contact/js/contact.js');
  await cases('plugin/im/dist/im/static/js', 'plugin/contact/dist/contact/js/contact.js');
  console.log(JSON.stringify({ result: 'passed', expected, only, groups, scope: 'actual IM adapters/consumer/reducer and contact projections in both bundle copies; synthetic data only; no network/profile access' }));
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
