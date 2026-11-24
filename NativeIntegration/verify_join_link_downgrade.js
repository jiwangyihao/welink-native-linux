#!/usr/bin/env node
'use strict';

// Exercise the real Linux service and IPC admission path, without an account or network.
// Drive actual authenticate/requestNative/store publication; substitute only the external SDK, account and broker.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const root = process.argv[2] ? path.resolve(process.argv[2]) : __dirname;
const { createService } = require(path.join(root, 'meeting_service.js'));
const ipc = new EventEmitter();
const notices = [], calls = [], store = { isServerDowngrade: false };
const invite = Object.freeze({ random: 'synthetic-invitation', confId: 'test-room', isOfflineJoin: false });
let init = 0, registers = 0, duringRegister;
const callbacks = new Map();
let loginResult = 0, holdLogin;
const notify = (id, response) => { const cb = callbacks.get(id); assert.equal(typeof cb, 'function'); cb(response); };
const sdk = {
  setNotifyFunc(id, cb) { if (cb) callbacks.set(id, cb); else callbacks.delete(id); },
  setMultiNotifyFunc(id, cb) { callbacks.set(id, cb); },
  removeNotify(id) { callbacks.delete(id); },
  usgLogin() {
    const result = loginResult;
    if (holdLogin) holdLogin(callbacks.get(1032));
    else queueMicrotask(() => notify(1032, { result, param: { reason_code: result } }));
    return { result: 0 }; // Immediate acknowledgement, not the business result.
  },
  getMeetingToken() {
    queueMicrotask(() => notify(1001, { result: 0, param: {token:'fixture-only'} }));
    return { result: 0 };
  }
};
ipc.invoke = async (_channel, envelope) => {
  if (envelope.kind === 'voice') {
    if (envelope.operation === 'release') return {ok:true,data:{released:true}};
    assert.equal(envelope.operation,'bind'); assert.equal(envelope.account,'fixture-user');
    return {ok:true,data:{bound:true}};
  }
  if (envelope.kind === 'register') {
    registers++;
    if (duringRegister) await duringRegister();
    return {protocol:'welink-native-web/1', origin:'https://example.invalid', instance:'test-bridge'};
  }
  if (envelope.message.operation === 'dispose') return {protocol:envelope.message.protocol,id:envelope.message.id,
    ok:true,data:{localCleanupComplete:true,serverLogout:{status:'no-browser-session'}}};
  calls.push(envelope.message);
  // A dispatched online request is NOT evidence that a conference was joined.
  return {protocol:envelope.message.protocol,id:envelope.message.id,ok:false,
    error:{code:'SYNTHETIC_PROVIDER_REJECTION',message:'test boundary: no meeting was contacted'}};
};
const serviceWindow = Object.assign(new EventTarget(), {require:()=>({ipcRenderer:ipc}),
  CustomEvent:class extends Event { constructor(type, opts) {super(type);this.detail=opts.detail;} }, btoa:s=>Buffer.from(s).toString('base64')});
const service = createService({window:serviceWindow, sdk,
  getStore:()=>({getStore:k=>store[k],setStore:(k,v)=>{store[k]=v;}}), Pedestal:{
    callMethod:async method=>{
      if (method==='method://pedestal/getLogStoragePath') return '/unused';
      if (method==='method://pedestal/getUserInfo') return {account:'fixture-user'};
      assert.equal(method,'method://pedestal/getToken'); return {crypt_token:'fixture-only'};
    }, sendBroadcast:async (event, payload)=>{notices.push({event,payload});}}});
async function login(code) { loginResult=code;const r=await service.usgLogin();assert.equal(r.result,code); }
service.bridge.initializeAuth = async () => { ++init; };
function isDowngrade(r) {
  assert.notEqual(r.result,0);
  assert.equal(r.param.reason_code,'LINK_VARIANT_UNAVAILABLE');
  assert.equal(r.param.details.reason,'SERVER_DOWNGRADE');
  assert.equal(r.param.details.joinAttempted,false);assert.equal(r.param.details.fallbackAttempted,false);
  assert.deepEqual(notices.at(-1),{event:'broadcast://private_conference/hwm/notifyCheckAnonymouseJoinConf',payload:r.param});
  assert(!JSON.stringify(r).includes(invite.random));
}
(async()=>{
  await login(412100044);assert.equal(store.isServerDowngrade,true);const initAfterLogin=init;
  isDowngrade(await service.newJoinConfByLink(invite));assert.equal(init,initAfterLogin);assert.equal(registers,0);assert.equal(calls.length,0);
  await login(0);assert.equal(store.isServerDowngrade,false);
  let entered, resume;const enteredRegistration=new Promise(r=>{entered=r;});const registrationGate=new Promise(r=>{resume=r;});
  duringRegister=async()=>{entered();await registrationGate;};
  const pending=service.newJoinConfByLink(invite);await enteredRegistration;await login(412100044);resume();
  isDowngrade(await pending);assert.equal(calls.length,0);
  const direct=service.bridge.callRegistered('conference.joinLink', {...invite,isServerDowngrade:false});
  await assert.rejects(direct, e=>e.code==='LINK_VARIANT_UNAVAILABLE'&&e.details.reason==='SERVER_DOWNGRADE');assert.equal(calls.length,0);
  await login(430200002);assert.equal(store.isServerDowngrade,false); // An unrelated result is not a downgrade.
  const result=await service.newJoinConfByLink(invite);assert.equal(result.param.reason_code,'SYNTHETIC_PROVIDER_REJECTION');
  assert.equal(calls.length,1);assert.equal(calls[0].operation,'conference.joinLink');assert.deepEqual(calls[0].params,invite);
  assert.equal(notices.length,3);assert.deepEqual(notices[2].payload,result.param);
  await login(412100044);const logout=await service.usgLogout();assert.equal(logout.result,0);assert.equal(store.isServerDowngrade,false);
  let enteredSdk;const nativePending=new Promise(ok=>{enteredSdk=ok;});holdLogin=enteredSdk;loginResult=412100044;
  const retired=service.usgLogin();const late=await nativePending;await service.usgLogout();late({result:412100044,param:{reason_code:412100044}});
  assert.notEqual((await retired).result,0);assert.equal(store.isServerDowngrade,false);assert.equal(calls.length,1);
  console.log('PASS native 1032 completion -> store -> public link result: downgrade blocks dispatch before and during registration; success, unrelated error and logout clear it; late callback cannot restore it.');
})().catch(e=>{console.error(e);process.exitCode=1;});
