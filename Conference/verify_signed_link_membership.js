#!/usr/bin/env node
'use strict';
// Replay only external provider state. The command, waiter and error propagation
// are the packaged page's actual code. No service, media or account is used.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const acorn = require(process.env.WELINK_TEST_ACORN || 'acorn');
const native = path.resolve(process.argv[2]);
const guard = require(path.join(native, '../shared/meeting_link_admission.js'));
const source = fs.readFileSync(path.join(native, 'meeting_native_web_runtime.js'), 'utf8');
const body = acorn.parse(source, {ecmaVersion:'latest'}).body[0].expression.callee.body.body;
const funcs = ['joinAnonymous','fail','requireFunction','waitState','withTimeout','matchesConference','recordFailure'].map(id => {
  const fn = body.find(n => n.type === 'FunctionDeclaration' && n.id.name === id);
  assert(fn, id); return source.slice(fn.start,fn.end);
});
const bind = vm.compileFunction(`'use strict';
  const {vendor,host,window,location,snapshot,state,ownParticipant}=f;
  const ensurePolicies=()=>{}, sessionCredentials=()=>({accessTokens:[]});
  let pendingAnonymousJoin=null,pendingJoinCompletion=null,disposed=false,sequence=0;
  const waiters=new Set(), failures=[];
  function pulse(){ for(const check of [...waiters]) check(); }
  ${funcs.join('\n')}
  return {join: p=>joinAnonymous(p,true),pulse,waiting:()=>waiters.size};`,['f']);
function room() {
  const origin='https://test.invalid', token='synthetic+/%2B&==';
  const old={confID:'old-room'};
  let info=old, connected=false, hasParticipant=false, id='', onFailure;
  let sent; const dispatched=new Promise(resolve=>{sent=resolve;});
  const runtime=bind({window:{__welinkRequireOnlineLinkVariant:guard},location:{origin},
    state:()=>({}),snapshot:()=>({joined:connected,conferenceId:id,displayConferenceId:'display-only'}),
    ownParticipant:()=>hasParticipant?{id:'local-participant'}:null,
    host:{whenRegistered:async()=>{},invokeRegistered:async(name,data)=>{
      sent({name,data});
    }},vendor:{selectors:{selectClientInfo:()=>({confInfo:info}),selectJoin:()=>({})},
      history:{location:{pathname:'/j'},listen:()=>()=>{}},join:{joinFail:()=>({type:'join-fail'})},
      effects:{take:type=>type},sagaMiddleware:{run(fn){const g=fn(); assert.equal(g.next().value,'join-fail');
        onFailure=code=>g.next({payload:{code}});return {isRunning:()=>true,cancel:()=>g.return(),toPromise:()=>Promise.resolve()};}}}});
  const request=runtime.join({site_url:origin+'/conferences',random:token,idPrefix:'SITE',confId:'declared-id'});
  return {request,async entered(){const {name}=await dispatched; assert.equal(name,'join-by-link');},
    resolve(id){info={confID:id};runtime.pulse();}, observe(joined,roomId,participant){connected=joined;id=roomId;hasParticipant=participant;runtime.pulse();},
    fail:code=>onFailure(code),waiting:runtime.waiting};
}
test('signed entry uses fresh issuer identity, connected membership and the local participant', {timeout:3000}, async()=>{
  const r=room();await r.entered();r.observe(true,'old-room',true); assert.equal(r.waiting(),1,'retained resolution must not finish a new request');
  r.observe(false,'',false);r.resolve('real-room'); assert.equal(r.waiting(),1,'ticket resolution is not admission');
  r.observe(true,'real-room',false);assert.equal(r.waiting(),1,'a connected transport without own participant is not admission');
  r.observe(true,'real-room',true);assert.equal((await r.request).conferenceId,'real-room');
});
test('joining the caller-declared room does not override a different ticket resolution', {timeout:3000}, async()=>{
  const r=room();await r.entered();const rejected=assert.rejects(r.request,{code:'CONFERENCE_ID_MISMATCH'});
  r.resolve('issuer-room');r.observe(true,'declared-id',true);await rejected;
});
test('vendor failure is preserved when start was accepted and no room was joined', {timeout:3000}, async()=>{
  const r=room();await r.entered();const rejected=assert.rejects(r.request,{code:'PROVIDER_REFUSAL'});
  r.fail('PROVIDER_REFUSAL');await rejected;
});
