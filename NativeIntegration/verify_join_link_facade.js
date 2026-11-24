#!/usr/bin/env node
'use strict';
// Run the emitted campus facade, not just createService() directly. No account,
// HTTP request, or browser is used: stop the normal path at anonymous preparation.
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const acorn = require(process.env.WELINK_TEST_ACORN || 'acorn');
const app = path.resolve(process.argv[2]);
const native = path.join(app, 'native');
const bundle = fs.readFileSync(path.join(app, 'plugin/conference/dist/js/hwmService.js'), 'utf8');
const { MeetingNativeWeb, PROTOCOL } = require(path.join(native, 'meeting_native_web.js'));
const methods = [];
function walk(n) {
  if (!n || typeof n !== 'object') return;
  if (n.type === 'ObjectExpression') {
    const name = n.properties.find(x => x.key?.name === 'key')?.value?.value;
    const fn = n.properties.find(x => x.key?.name === 'value')?.value;
    if (name === 'newJoinConfByLink' && fn?.type === 'FunctionExpression') {
      const body = bundle.slice(fn.start, fn.end);
      if (body.includes('ae.newJoinConfByLink(')) methods.push(body);
    }
  }
  for (const val of Object.values(n)) if (Array.isArray(val)) val.forEach(walk); else if (val && typeof val === 'object') walk(val);
}
walk(acorn.parse(bundle, {ecmaVersion:'latest'}));
assert.equal(methods.length, 1, 'Unable to uniquely locate the installed application facade');
const fakeAuth = 'QA_TICKET_DO_NOT_ECHO';
let actions, lastResult, lastParams, downgrade = false, retire = false;
const store = {getStore: k => k === 'isServerDowngrade' && downgrade};
const provider = new MeetingNativeWeb({origin:'https://example.invalid', electron:{ipcMain:{handle(){}},
  BrowserWindow:class { constructor() { throw Error('Admission verification must not open a window'); } }}});
provider.prepareAnonymousSession = async () => {
  ++actions.prepare;
  throw Object.assign(new Error('Stop before any session cleanup or network use'), {code:'QA_PROVIDER_BOUNDARY'});
};
const ipc = new EventEmitter();
ipc.invoke = async (_ch, e) => {
  if (e.kind === 'register') { ++actions.register; if (retire) downgrade = true; return {protocol:PROTOCOL, origin:'https://example.invalid', instance:'qa'}; }
  ++actions.dispatch; lastParams=e.message.params; return provider.handle(e.message);
};
const ownerWindow = {require: () => ({ipcRenderer:ipc})};
const service = require(path.join(native, 'meeting_service.js')).createService({window:ownerWindow, sdk:{}, getStore:()=>store,
  Pedestal:{callMethod:async method=>{ assert.equal(method,'method://pedestal/getLogStoragePath');return '/unused'; },
    sendBroadcast:async (event,data) => {assert.equal(event,'broadcast://private_conference/hwm/notifyCheckAnonymouseJoinConf');actions.notify++;lastResult=data;}}});
service.bridge.initializeAuth = async () => {++actions.auth;};
const facade = vm.runInNewContext('('+methods[0]+')', {ne:{info(){}},window:{require:id=>{assert.equal(id,'os');return {platform:()=> 'linux'};}},ae:service});
async function one(name, fields, expected, opts={}) {
  actions={auth:0,register:0,dispatch:0,prepare:0,notify:0};lastResult=lastParams=null;
  downgrade=!!opts.downgrade;retire=!!opts.duringRegister;service.bridge.registration=null;
  const invite=Object.freeze({random:fakeAuth,site_url:'https://example.invalid',...fields});
  const r=await facade(invite);
  assert.notEqual(r.result,0,name);assert.equal(r.param.reason_code,expected,name);
  assert.deepEqual(r.param,lastResult,name);assert.equal(actions.notify,1,name);
  assert(!JSON.stringify(r).includes(fakeAuth),name+' leaked ticket');
  if (expected==='LINK_VARIANT_UNAVAILABLE') {
    assert.equal(r.param.details.joinAttempted,false,name);assert.equal(r.param.details.fallbackAttempted,false,name);
    if (opts.downgrade || opts.duringRegister) assert.equal(r.param.details.reason,'SERVER_DOWNGRADE',name);
    else assert.deepEqual(r.param.details.unsupportedFields,opts.bad,name);
    assert.deepEqual(actions,{auth:retire?1:0,register:retire?1:0,dispatch:0,prepare:0,notify:1},name);
  } else {
    assert.deepEqual(actions,{auth:1,register:1,dispatch:1,prepare:expected==='QA_PROVIDER_BOUNDARY'?1:0,notify:1},name);
    assert.deepEqual(lastParams,invite,name+' modified invitation');
  }
  return {name,...actions,result:r.param.reason_code};
}
(async()=>{
 const cases=[];
 cases.push(await one('issued-online-prefix',{site_url:'https://example.invalid/conferences',idPrefix:'SITE_QA'},'QA_PROVIDER_BOUNDARY'));
 for (const idPrefix of ['null','undefined',42]) cases.push(await one('invalid-prefix-'+idPrefix,{idPrefix},'LINK_VARIANT_UNAVAILABLE',{bad:['idPrefix']}));
 cases.push(await one('prefix-without-issuer',{idPrefix:'SITE_QA',site_url:''},'LINK_VARIANT_UNAVAILABLE',{bad:['idPrefix']}));
 cases.push(await one('offline',{isOfflineJoin:true},'LINK_VARIANT_UNAVAILABLE',{bad:['isOfflineJoin']}));
 cases.push(await one('offline-and-prefix',{isOfflineJoin:1,idPrefix:'SITE_QA'},'LINK_VARIANT_UNAVAILABLE',{bad:['isOfflineJoin']}));
 cases.push(await one('existing-downgrade',{isOfflineJoin:false},'LINK_VARIANT_UNAVAILABLE',{downgrade:true}));
 cases.push(await one('downgrade-in-flight',{},'LINK_VARIANT_UNAVAILABLE',{duringRegister:true}));
 for (const [name,fields] of [['absent',{}],['null-value',{idPrefix:null,isOfflineJoin:false}],['empty',{idPrefix:'',isOfflineJoin:0}]]) cases.push(await one(name,fields,'QA_PROVIDER_BOUNDARY'));
 for (const path of ['/conferences','/next/conferences?route=A%2FB'])
   cases.push(await one('issued-next-hop-'+path,{site_url:'https://example.invalid'+path},'QA_PROVIDER_BOUNDARY'));
 for (const site of ['https://other.invalid/conferences','http://example.invalid/conferences','https://example.invalid:8443/conferences','https://u@example.invalid/conferences'])
   cases.push(await one('untrusted-site-'+site,{site_url:site,idPrefix:'SITE_QA'},'LINK_ORIGIN_UNAVAILABLE'));
 console.log(JSON.stringify({build:JSON.parse(fs.readFileSync(path.join(native,'build.json'),'utf8')).build,pass:true,scope:'Packaged campus facade and Linux renderer; synthetic invitations and isolated IPC/auth boundary; no real meeting or network',cases},null,2));
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
