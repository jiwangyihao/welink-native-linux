#!/usr/bin/env node
'use strict';
// Use the actual packaged system/chat handlers and the Linux admission guard. Replace
// only I/O with an isolated, synthetic issuer and a terminal observer; never join a meeting.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const acorn = require(process.env.WELINK_TEST_ACORN || 'acorn');
const root = path.resolve(process.argv[2]);
const src = p => fs.readFileSync(path.join(root, p), 'utf8');
const dist = 'plugin/conference/dist/';
const entry = src(dist + 'index.html');
const scripts = Array.from(entry.matchAll(/<script[^>]+src="([^"]+)"/g), m => m[1]);
const i = scripts.indexOf('../../../native/meeting_invitation_uri.js');
assert(i >= 0 && i < scripts.indexOf('./js/bundle.js'));
const bundle = src(dist + 'js/bundle.js');
const methods = {}, vars = {};
let issuerReferences = 0;
const work = [{node:acorn.parse(bundle, { ecmaVersion: 'latest' }),functionDepth:0}];
while (work.length) {
  const {node:n,functionDepth} = work.pop();
  if (!n || typeof n !== 'object') continue;
  if (n.type === 'Identifier' && n.name === 'nativeResolveInvitation') issuerReferences++;
  if (n.type === 'ObjectExpression') {
    const key = n.properties.find(p => p.key?.name === 'key')?.value?.value;
    const fn = n.properties.find(p => p.key?.name === 'value')?.value;
    if (fn?.type === 'FunctionExpression' && ['schemaProcess','joinConfByLink','openJoinConfByLink','newJoinConfByLink'].includes(key)) {
      const text = bundle.slice(fn.start, fn.end);
      if (/\b(?:Ki|as)\(|__welinkInvitation/.test(text)) { assert(!methods[key], key); methods[key] = text; }
    }
  }
  if (n.type === 'Property' && ['method://conference/schemaRequest','method://conference/openLinkEnterConf'].includes(n.key.value)) {
    assert(!methods[n.key.value]); methods[n.key.value] = bundle.slice(n.value.start, n.value.end);
  }
  if (n.type === 'VariableDeclarator' && n.init && ['Ki','as','Rc','Wc','nativeResolveInvitation'].includes(n.id?.name)) {
    const text = bundle.slice(n.init.start, n.init.end);
    if (n.id.name === 'nativeResolveInvitation') assert(functionDepth > 0, 'lookup helper remains lexical, but is not a response authority');
    if (n.id.name === 'nativeResolveInvitation' || text === 'Ki' || text === 'window.__welinkInvitation.parse' || text.includes('rs.newJoinConfByLink(e.confLink)') || text.includes('newJoinConfByLinkWithObjParam result')) {
      assert(!vars[n.id.name], n.id.name); vars[n.id.name] = text;
    }
  }
  const childDepth = functionDepth + (['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression'].includes(n.type) ? 1 : 0);
  for (const v of Object.values(n)) {
    if (Array.isArray(v)) { for (const node of v) work.push({node,functionDepth:childDepth}); }
    else if (v && typeof v === 'object') work.push({node:v,functionDepth:childDepth});
  }
}
assert.equal(issuerReferences,3,'one operation helper and the two public-link lookups');
for (const text of [methods.openJoinConfByLink,methods['method://conference/openLinkEnterConf']])
  assert(!text.includes('coreRsHttp.get'), 'public-link renderer must not perform an issuer request');
assert(!vars.nativeResolveInvitation.includes('issued-site'));
const requireOnline = require(path.join(root, 'shared/meeting_link_admission.js'));
const { IssuedMeetingSites } = require(path.join(root, 'native/meeting_guest_site.js'));
const { resolveInvitation, RESPONSE_TAG, issuerError } = require(path.join(root, 'native/meeting_issuer_request.js'));
let clock = 0, issuerFrame, issuerContents;
const issuerOwners = new WeakMap();
const issuedSites = new IssuedMeetingSites({webContents:{fromFrame:frame=>issuerOwners.get(frame)},now:()=>clock});
const method = k => 'method://conference/' + k;
const id = '202612345';
const site = 'https://meeting.invalid/next/conferences?route=A%2FB&zone=1';
const guestSite = 'https://guest.invalid:8443/next/conferences?route=A%2FB&zone=1';
const ticket = 'test+opaque%2B&part=#end==', nick = '测试 + A%20', prefix = 'SITE + A%=2';
const pwd = 'test/password+= tail%24';
let returned, observed, lookup, xy, ordinary, admission, response, publicRequests, downgrade;
let issuerResponse, registrations, registered, registrationReply, registrationError, registrationGate;
let beforeRegistration, beforeAdmission, handoffURI, logCalls, toasts;
let preparations, prepareReply, resolverCalls, lookupEnvelope, requestGate, beforeNativeReply, current;
let rawIssuerReply, requestContext, originatingView, configuredIssuer;
const unexpected = () => { throw Error('unanticipated meeting path'); };
const empty = x => x == null || x === '';
const recordLog = (...args) => { logCalls.push(args); };
const log = { info:recordLog, debug:recordLog, error:recordLog };
const store = {isUsgEnable:true, isOpenMicDe:0, isOpenCameraDe:0, meetingLoginUrl:'meeting.invalid'};
// This boundary invokes the actual main resolver with a synthetic native I/O
// terminal. The renderer cannot supply the native reply, context or authority.
async function resolveFromMain(envelope) {
  resolverCalls++; lookupEnvelope = { ...envelope };
  let resolved;
  try {
    resolved = await resolveInvitation(configuredIssuer, envelope, {
      context: requestContext, originatingView, isCurrent: () => current,
      transport: { async request(request, settings) {
        lookup = request; publicRequests++;
        assert.equal(new URL(request.url).origin, configuredIssuer);
        assert.equal(new URL(request.url).pathname, '/v1/mmc/management/conferences/authConf');
        assert.deepEqual(Object.keys(request.header).sort(), ['User-Agent','X-Password']);
        assert.equal(request.body, '{}');
        assert.equal(settings.tlsParam.tls_mode, 1);
        beforeNativeReply?.();
        if (requestGate) await requestGate;
        return rawIssuerReply || { result: 0, param: {
          resp_code: issuerResponse.result ? 200 : 403, recv_body: JSON.stringify(issuerResponse.recv_body)
        } };
      } }
    });
  } catch (error) { return {tag:RESPONSE_TAG,ok:false,error:issuerError(error)}; }
  if (resolved.grantParams) {
    registrations++; registered = {issuer:resolved.issuer,params:{...resolved.grantParams}};
    beforeRegistration?.();
    if (registrationGate) await registrationGate;
    if (registrationError) throw registrationError;
    if (registrationReply?.ok !== true) return registrationReply;
    if (!current) return {tag:RESPONSE_TAG,ok:false,error:{code:'ISSUER_CHANGED'}};
    try { issuedSites.issue(issuerFrame,resolved.issuer,resolved.grantParams); }
    catch (error) { return {tag:RESPONSE_TAG,ok:false,error:issuerError(error)}; }
  }
  return {tag:RESPONSE_TAG,ok:true,response:resolved.response,requestURL:resolved.requestURL};
}
const window = { $getState: () => store, Toast:p=>toasts.push(p), uiToast:p=>toasts.push(p),
  require(name) {
    assert.equal(name, 'electron');
    return {ipcRenderer:{async invoke(channel, envelope) {
      assert.equal(channel, 'welink-native-meeting-v1');
      assert.equal(envelope.kind, 'resolve-invitation');
      assert.equal(preparations, 1);
      return resolveFromMain(envelope);
    }}};
  } };
const ctx = vm.createContext({window, URL, atob, TextDecoder, console, isNullOrEmpty:empty, Zi:log, Lc:log, os:log, Mi:log,
  $getState:()=>store, Aa:{getStore:k=>k===undefined?store:k==='isUserLogined'?false:k==='loginIntent'?1:undefined,setStore(){}},
  ha:{getConfAndCallState:()=>({state:false})}, Yi:{async setCameraStateToSDK(){},async setMicStateToSDK(){}},
  fi:async()=>nick, coreUt:{utUiEvent(){}}, constant:{UT_EVENT_NAME:{}}, On:{a:x=>x}, Ca:code=>String(code),
  coreRsHttp:{get:unexpected},
  Pedestal:{async callMethod(op, p){
    if (op==='method://private_conference/hwm/prepareInvitationResolver') { preparations++; assert.equal(p,undefined); return prepareReply; }
    if (op==='method://pedestal/getMeetingLoginUrl') return store.meetingLoginUrl;
    if (op==='method://pedestal/showLoading'||op==='method://pedestal/closeLoading') return;
    assert.equal(op,'method://private_conference/hwm/joinConfByLink'); admission++; observed={...p};
    beforeAdmission?.(p);
    const configured = new URL('https://' + store.meetingLoginUrl).origin;
    const granted = issuedSites.take(configured,p);
    try { requireOnline(p,downgrade,granted||configured); } catch(err) { returned={result:1,param:{reason_code:err.code,details:err.details}};return returned; }
    ordinary++; return response;
  }}, $i:{addToLoginedQueue:unexpected}, Hi:unexpected, qc:0,
  is:async()=>{xy++;return {result:8};}, rs:{JoinConfByLink_XY:async()=>{xy++;return {result:8};}}});
const invitationSource = src('native/meeting_invitation_uri.js');
assert(!/\bipcRenderer\b|welink-native-meeting-v1/.test(invitationSource),'global field helper must not send IPC');
vm.runInContext(invitationSource,ctx);
function load(text){ assert.equal(typeof text,'string'); return vm.runInContext('((nativeResolveInvitation)=>('+text+'))(('+vars.nativeResolveInvitation+'))',ctx); }
for (const k of ['Ki','as','Rc','Wc']) ctx[k]=load(vars[k]);
ctx.e={schemaProcess:load(methods.schemaProcess),joinConfByLink:load(methods.joinConfByLink),openJoinConfByLink:load(methods.openJoinConfByLink)};
const originalJoin = ctx.e.joinConfByLink;
ctx.e.joinConfByLink = async p => { handoffURI=p.confLink; return originalJoin(p); };
ctx.Ji=ctx.e;ctx.rs.newJoinConfByLink=load(methods.newJoinConfByLink);
const system=load(methods[method('schemaRequest')]);const chat=load(methods[method('openLinkEnterConf')]);
const esc=encodeURIComponent, scheme='hwwelink://welinksoftclient', signed=(q)=>scheme+'/page/link?'+q;
function reset(p) {
  issuedSites.clear(); clock=0;
  issuerFrame={url:'file:///synthetic/app/plugin/conference/dist/index.html',processId:7,routingId:11,frameTreeNodeId:13};
  issuerContents=new EventEmitter();issuerContents.mainFrame=issuerFrame;issuerContents.isDestroyed=()=>false;
  issuerOwners.set(issuerFrame,issuerContents);
  observed=lookup=returned=registered=handoffURI=lookupEnvelope=null;
  xy=ordinary=admission=publicRequests=registrations=preparations=resolverCalls=0;downgrade=false;ctx.qc=0;
  beforeRegistration=beforeAdmission=registrationGate=registrationError=beforeNativeReply=requestGate=rawIssuerReply=null;logCalls=[];toasts=[];
  registrationReply=prepareReply={ok:true};store.meetingLoginUrl='meeting.invalid';
  current=true;configuredIssuer='https://meeting.invalid';
  requestContext={envInfo:{proxyAddress:'',proxyPort:'0',caCertPath:'/synthetic/ca.pem'},
    appInfo:{appVersionName:'1.0',appVersionCode:1},userAgent:'ServiceUA',viewId:'hwmService',
    fuseInfo:{module:{blackList:[]},request:{blackList:[]}}};
  originatingView={userAgent:'SyntheticUA',viewId:'conference'};
  issuerResponse={result:true,recv_body:{siteUrl:site,random:ticket,idPrefix:p}};
  response={result:37,param:{reason_code:'ISOLATED_PROVIDER_BOUNDARY'}};
}
const checks=[];
function blocked(r,fields){ assert.equal(r,returned);assert.equal(r.param.reason_code,'LINK_VARIANT_UNAVAILABLE');assert.equal(r.param.details.joinAttempted,false);assert.deepEqual(r.param.details.unsupportedFields,fields);assert.equal(ordinary,0);assert.equal(xy,0); }
function onlineResult(r){ assert.equal(r,response);assert.equal(admission,1);assert.equal(ordinary,1);assert.equal(xy,0); }
function sameFields(expectPrefix,offline,confId=id,expectedSite=site){ assert.deepEqual(observed,{site_url:expectedSite,random:ticket,nick_name:nick,idPrefix:expectPrefix,confId,isOfflineJoin:offline}); }
const direct = (uri) => system({schema:uri,willLogin:false});
function publicURL(id,params=''){ return 'https://invite.invalid/#/j/'+esc(id)+'/'+esc(pwd)+(params?'?'+params:''); }
(async()=>{
  reset();const signedInput=signed('site_url='+esc(Buffer.from(site).toString('base64'))+'&random='+esc(ticket)+'&conferenceID='+id+'&user_name='+esc(nick)+'&idPrefix='+esc(prefix)+'&joinType=offline');
  let r=await direct(signedInput);sameFields(prefix,true);blocked(r,['isOfflineJoin']);checks.push('base64 site/prefix/offline and escaped opaque ticket retained');
  reset();r=await direct(signed('site_url=https://meeting.invalid&random=QA+raw==&conferenceID='+id+'&user_name=test'));assert.equal(observed.random,'QA+raw==');assert.equal(r,response);assert.equal(ordinary,1);checks.push('legacy raw plus and trailing padding; real nonzero response propagated');
  // Golden wires produced by the portal's published default scheme builder, encodeType 0 / 1.
  const portalSite = 'https://meeting.invalid/next/conferences?route=A%2FB';
  const portalPrefix = '站点-A', portalTicket = 'QA+opaque/9==';
  const packed = 'aHR0cHM6Ly9tZWV0aW5nLmludmFsaWQvbmV4dC9jb25mZXJlbmNlcz9yb3V0ZT1BJTJGQiZyYW5kb209UUErb3BhcXVlLzk9PSZpZFByZWZpeD3nq5nngrktQQ==';
  for (const wire of [portalSite + '&random=' + portalTicket + '&idPrefix=' + portalPrefix, packed]) {
    reset(); r = await direct(signed('site_url=' + wire));
    assert.deepEqual(observed, {site_url:portalSite, random:portalTicket, idPrefix:portalPrefix,
      nick_name:nick, confId:'', isOfflineJoin:false});
    onlineResult(r);
  }
  checks.push('official plaintext and UTF-8 Base64 invitations preserve nested site, ticket and prefix');
  const nextHop = portalSite + '&zone=1', opaque = 'QA+%2F==', owningSite = '站点%2FA';
  const issuer = nextHop + '&random=' + opaque + '&idPrefix=' + owningSite;
  const options = '&joinType=offline&conferenceID=' + id + '&user_name=' + esc(nick);
  for (const wire of [issuer, Buffer.from(issuer, 'utf8').toString('base64')]) {
    reset(); r = await direct(signed('site_url=' + wire + options));
    assert.deepEqual(observed, {site_url:nextHop, random:opaque, idPrefix:owningSite,
      nick_name:nick, confId:id, isOfflineJoin:true});
    blocked(r, ['isOfflineJoin']);
    for (const duplicate of ['&%72andom=other', '&idPrefix=other', '&site_url=other']) {
      reset(); r = await direct(signed('site_url=' + wire + options + duplicate));
      assert.equal(r.param.reason_code, 'INVALID_MEETING_INVITATION');
      assert.equal(publicRequests + admission + xy, 0);
    }
  }
  checks.push('plaintext and packed issuer bytes survive appended offline options; outer overrides rejected');
  reset(); r = await direct(signed('site_url=' + packed + '&joinType=offline'));
  assert.equal(observed.idPrefix, portalPrefix); blocked(r, ['isOfflineJoin']);
  for (const shadow of ['&idPrefix=other', '&random=other']) {
    reset(); r = await direct(signed('site_url=' + packed + shadow));
    assert.equal(r.param.reason_code, 'INVALID_MEETING_INVITATION'); assert.equal(publicRequests+admission+xy,0);
  }
  checks.push('outer offline marker retained; conflicting inner and outer issuer fields never dispatched');
  for(const way of ['system','chat']){
    reset(prefix);const publicId='1234567890',url=publicURL(publicId,'joinType=offline&idPrefix='+esc(prefix));
    r=way==='system'?await direct(scheme+'/conference/joinconf?meetingLink='+esc(url)+'&name='+esc(nick)):await chat({confLink:url});
    assert.equal(publicRequests,1);assert.equal(lookup.header['X-Password'],pwd);assert.equal(new URL(lookup.url).searchParams.get('conferenceID'),publicId);sameFields(prefix,true,publicId);blocked(r,['isOfflineJoin']);checks.push(way+': nested escaped credentials, prefix, offline and 10-digit ID preserved');
    reset(prefix);const noMarker=publicURL(id);r=way==='system'?await direct(scheme+'/conference/joinconf?meetingLink='+esc(noMarker)):await chat({confLink:noMarker});sameFields(prefix,false);onlineResult(r);assert.equal(registrations,0);checks.push(way+': same-origin issuer-only prefix and terminal provider result retained without a grant');
    reset('DIFFERENT');const conflicting=publicURL(id,'idPrefix='+esc(prefix));r=way==='system'?await direct(scheme+'/conference/joinconf?meetingLink='+esc(conflicting)):await chat({confLink:conflicting});assert.equal(r.param.reason_code,'INVALID_MEETING_INVITATION');assert.equal(admission,0);assert.equal(xy,0);checks.push(way+': conflicting site discarded before dispatch');
  }
  for (const longId of ['1000000001', '120000000001']) {
    const issuerLink = 'https://MEETING.invalid:443/#/j/' + longId + '/' + esc(pwd);
    for (const entry of ['chat', 'system']) {
      reset(prefix);
      r = entry === 'chat' ? await chat({confLink:issuerLink}) : await direct(scheme + '/conference/joinconf?meetingLink=' + esc(issuerLink));
      assert.equal(publicRequests,1); assert.equal(new URL(lookup.url).origin,'https://meeting.invalid');
      assert.equal(lookup.header['X-Password'],pwd); sameFields(prefix,false,longId); onlineResult(r);
    }
    reset(); r = await chat({confLink:issuerLink});
    assert.equal(publicRequests,1); assert.equal(ordinary,1); assert.equal(xy,0); assert.equal(r,response);
    for (const legacy of [issuerLink + '?meetingType=8', issuerLink.replace(':443/',':8443/'),
      issuerLink.replace('https:', 'http:'), issuerLink.replace('MEETING.invalid:443', 'meeting.invalid.external.invalid')]) {
      reset(prefix); r = await chat({confLink:legacy});
      assert.equal(r.result,8); assert.equal(xy,1); assert.equal(publicRequests+admission,0);
    }
    checks.push(longId.length+'-digit chat/system links: same issuer supplies prefix; ordinary provider failure and legacy XY routes preserved');
  }
  reset();downgrade=true;r=await direct(signed('site_url='+esc(site)+'&random='+esc(ticket)+'&conferenceID='+id+'&user_name='+esc(nick)));sameFields(undefined,false);blocked(r,[]);assert.equal(r.param.details.reason,'SERVER_DOWNGRADE');checks.push('server downgrade stays independent from explicit offline flag');
  for(const uri of [signed('site_url=a&idPrefix=x&idPrefix=y'),signed('site_url=x&random=%EA'),scheme+'/conference/joinconf?meetingLink='+esc(publicURL(id,'joinType=offline'))+'&joinType=online']){
    reset();r=await direct(uri);assert.equal(r.param.reason_code,'INVALID_MEETING_INVITATION');assert.equal(publicRequests+admission+xy,0);
  }checks.push('ambiguous or malformed input rejected before issuer or provider');
  reset();r=await chat({confLink:publicURL(id)});sameFields(undefined,false);assert.equal(r,response);assert.equal(ordinary,1);checks.push('ordinary chat invite retains issuer ticket and returns provider failure');
  for (const way of ['system','chat']) {
    const enter = (url=publicURL(id)) => way==='system' ?
      direct(scheme+'/conference/joinconf?meetingLink='+esc(url)) : chat({confLink:url});
    reset(prefix);issuerResponse.recv_body.siteUrl=guestSite;
    r=await enter();sameFields(prefix,false,id,guestSite);onlineResult(r);
    assert.equal(publicRequests,1);assert.equal(registrations,1);
    assert.equal(registered.issuer,'https://meeting.invalid');
    assert.notEqual(registered.issuer,new URL(publicURL(id)).origin);
    assert.deepEqual(Object.keys(registered).sort(),['issuer','params']);
    assert.deepEqual(Object.keys(lookupEnvelope).sort(),['confId','expectedPrefix','joinType','kind','password']);
    assert.equal(lookupEnvelope.confId,id);assert.equal(lookupEnvelope.password,pwd);
    const {nick_name:ignoredNick,...boundFields}=observed;
    assert.deepEqual(registered.params,boundFields);
    assert.equal(issuedSites.take(registered.issuer,registered.params),null);
    assert.equal(JSON.stringify(logCalls).includes(ticket),false);
    assert.equal(JSON.stringify(logCalls).includes(pwd),false);
    if (way==='system') {
      const handed=window.__welinkInvitation.parse(handoffURI);
      assert.deepEqual(Object.keys(handed).sort(),['conferenceID','idPrefix','random','site_url','user_name']);
      assert.equal(handed.random,ticket);assert.equal(handed.site_url,guestSite);
    }
    checks.push(way+': main-owned fixed-origin request grants only its own response; public host is not issuer, and no grant is serialized');

    reset(prefix);issuerResponse.recv_body.siteUrl=guestSite;
    let release, reached;
    registrationGate=new Promise(resolve=>{release=resolve;});
    const attempted=new Promise(resolve=>{reached=resolve;});
    beforeRegistration=()=>reached();
    const pending=enter();
    await Promise.race([attempted,pending.then(()=>{throw Error('Issuer registration was skipped');})]);
    assert.equal(admission+ordinary,0);release();r=await pending;
    onlineResult(r);assert.equal(registrations,1);assert.equal(publicRequests,1);
    checks.push(way+': one protected request is used once and provider dispatch awaits main issuance');

    for (const reply of [{ok:false,error:{code:'UNTRUSTED_SENDER',message:ticket}},null,undefined,{ok:'true'}]) {
      reset(prefix);issuerResponse.recv_body.siteUrl=guestSite;registrationReply=reply;
      r=await enter();assert.equal(r.param.reason_code,'ISSUED_SITE_UNAVAILABLE');
      assert.equal(publicRequests,1);assert.equal(registrations,1);assert.equal(admission+ordinary+xy,0);
      assert.equal(JSON.stringify(r).includes(ticket),false);assert.equal(JSON.stringify(logCalls).includes(ticket),false);
    }
    reset(prefix);issuerResponse.recv_body.siteUrl=guestSite;registrationError=new Error(ticket);
    r=await enter();assert.equal(r.param.reason_code,'ISSUED_SITE_UNAVAILABLE');
    assert.equal(admission+ordinary+xy,0);assert.equal(JSON.stringify(logCalls).includes(ticket),false);
    checks.push(way+': refused, rejected or malformed IPC receipt stops the join and never echoes ticket data');

    reset(prefix);issuerResponse.recv_body.siteUrl=guestSite;
    r=await enter(publicURL(id,'joinType=offline&idPrefix='+esc(prefix)));
    blocked(r,['isOfflineJoin']);assert.equal(registrations,0);assert.equal(publicRequests,1);
    reset();issuerResponse.recv_body.siteUrl=guestSite;
    r=await enter();assert.equal(r.param.reason_code,'LINK_ORIGIN_UNAVAILABLE');
    assert.equal(registrations,0);assert.equal(ordinary+xy,0);
    checks.push(way+': offline or prefix-free cross-site invitations never receive a grant');

    for (const change of [
      {siteUrl:'http://guest.invalid'}, {siteUrl:'https://user:pass@guest.invalid'},
      {siteUrl:'https://@guest.invalid'}, {siteUrl:'https:///guest.invalid'}, {siteUrl:'https://*.invalid'},
      {idPrefix:'null'}, {idPrefix:'undefined'}, {idPrefix:' '}, {idPrefix:'x\n'},
      {random:'x\n'}, {idPrefix:42}
    ]) {
      reset(prefix);Object.assign(issuerResponse.recv_body,{siteUrl:guestSite},change);
      r=await enter();assert.equal(r.param.reason_code,'INVALID_MEETING_INVITATION');
      assert.equal(publicRequests,1);assert.equal(registrations+admission+ordinary+xy,0);
    }
    checks.push(way+': malformed or credential-bearing issuer fields cannot issue or dispatch');

    for (const retire of [
      ()=>{clock=60000;},
      ()=>{issuerContents.emit('did-start-navigation',{},issuerFrame.url,false,true);},
      ()=>{issuerFrame.url+='?different-document';},
      ()=>{issuedSites.clear();},
      ()=>{store.meetingLoginUrl='foreign.invalid';},
      p=>{p.random+='altered';},
      p=>{p.idPrefix+='altered';},
      p=>{p.confId+='altered';},
      p=>{p.site_url=guestSite+'&altered=1';}
    ]) {
      reset(prefix);issuerResponse.recv_body.siteUrl=guestSite;beforeAdmission=retire;
      r=await enter();assert.equal(r.param.reason_code,'LINK_ORIGIN_UNAVAILABLE');
      assert.equal(publicRequests,1);assert.equal(registrations,1);assert.equal(admission,1);assert.equal(ordinary+xy,0);
    }
    checks.push(way+': expired, navigated, retired, foreign-account or altered admission cannot consume the dedicated grant');

    reset(prefix);issuerResponse={result:false,recv_body:{resp_code:403,error_code:403}};
    r=await enter(publicURL(id,'trusted=true&issuer='+esc('https://guest.invalid')));
    if (way==='system') assert.equal(r.result,403); else assert.equal(r,undefined);
    assert.equal(toasts.length,1);assert.equal(publicRequests,1);assert.equal(registrations+admission+ordinary+xy,0);
    checks.push(way+': authConf failure keeps the original challenge/failure path; caller issuer/trusted claims cannot attest');
  }
  reset(prefix);
  const supplied=window.__welinkInvitation.issued({siteUrl:guestSite,random:ticket,idPrefix:prefix},
    {confId:id,trusted:true},nick,'https://meeting.invalid/v1/mmc/management/conferences/authConf?conferenceID='+id);
  assert.equal(supplied.fields.random,ticket);
  assert.equal(publicRequests+registrations+admission,0);
  assert.equal(window.nativeResolveInvitation,undefined);assert.equal(ctx.nativeResolveInvitation,undefined);
  r=await ctx.Wc(window.__welinkInvitation.nativeParams(supplied.fields));
  assert.equal(r.param.reason_code,'LINK_ORIGIN_UNAVAILABLE');assert.equal(ordinary+registrations+publicRequests,0);
  checks.push('globally callable field validation has no issuance side effects; supplied reply/request URL cannot grant a site');
  for (const dispatch of [
    () => direct(signed('site_url='+esc(guestSite)+'&random='+esc(ticket)+'&idPrefix='+esc(prefix)+'&conferenceID='+id+'&trusted=true&issuer='+esc('https://meeting.invalid'))),
    () => ctx.e.joinConfByLink({confLink:signed('site_url='+esc(guestSite)+'&random='+esc(ticket)+'&idPrefix='+esc(prefix)+'&conferenceID='+id),trusted:true}),
    () => ctx.Wc({site_url:guestSite,random:ticket,idPrefix:prefix,confId:id,isOfflineJoin:false,trusted:true})
  ]) {
    reset();r=await dispatch();assert.equal(r.param.reason_code,'LINK_ORIGIN_UNAVAILABLE');
    assert.equal(publicRequests+registrations+ordinary+xy,0);
  }
  checks.push('raw schemes and existing external/public method calls cannot mint or supply a cross-site grant');
  for (const url of [publicURL(id).replace('https://','https://user:pass@'),publicURL(id).replace('https://','https://@')]) {
    for (const way of ['system','chat']) {
      reset(prefix);r=way==='system'?await direct(scheme+'/conference/joinconf?meetingLink='+esc(url)):await chat({confLink:url});
      assert.equal(r.param.reason_code,'INVALID_MEETING_INVITATION');
      assert.equal(publicRequests+registrations+admission+ordinary+xy,0);
    }
  }
  checks.push('credential-bearing public links are rejected before issuer lookup');
  for (const way of ['system','chat']) {
    const enter = () => way==='system' ?
      direct(scheme+'/conference/joinconf?meetingLink='+esc(publicURL(id))) : chat({confLink:publicURL(id)});
    for (const prepared of [null,{ok:false},{ok:'true'}]) {
      reset(prefix);prepareReply=prepared;
      r=await enter();assert.equal(r.param.reason_code,'ISSUED_SITE_UNAVAILABLE');
      assert.equal(preparations,1);assert.equal(resolverCalls+publicRequests+registrations+admission,0);
    }
    reset(prefix);issuerResponse.recv_body.siteUrl=guestSite;
    let release, reached;
    requestGate=new Promise(resolve=>{release=resolve;});
    const requested=new Promise(resolve=>{reached=resolve;});
    beforeNativeReply=()=>reached();
    const pending=enter();
    await Promise.race([requested,pending.then(()=>{throw Error('Protected operation was skipped');})]);
    assert.equal(publicRequests,1);assert.equal(admission+registrations,0);
    current=false;release();r=await pending;
    assert.equal(r.param.reason_code,'ISSUER_CHANGED');
    assert.equal(publicRequests,1);assert.equal(admission+registrations,0);
    assert.equal(JSON.stringify(r).includes(ticket),false);
    checks.push(way+': preparation failure and native completion after owner retirement cannot issue or dispatch');
  }

  const scoped=()=>({kind:'resolve-invitation',confId:id,password:pwd});
  for (const supplied of [
    {issuer:'https://guest.invalid'},{site_url:guestSite},{random:ticket},{params:{site_url:guestSite,random:ticket}},
    {requestURL:'https://guest.invalid/authConf'},{result:true},{recv_body:{siteUrl:guestSite,random:ticket}},
    {reply:{siteUrl:guestSite,random:ticket}},{context:{envInfo:{proxyAddress:'foreign.invalid'}}},
    {confId:4},{confId:'bad\nid'},{password:42},{password:'bad\r\nX-Token: injected'},{joinType:'foreign'}
  ]) {
    reset(prefix);r=await resolveFromMain({...scoped(),...supplied});
    assert.equal(r.ok,false);assert.equal(r.error.code,'INVALID_MEETING_INVITATION');
    assert.equal(publicRequests+registrations+admission,0);
  }
  checks.push('protected operation accepts only the scoped ID/password mapping, never an authority, response, ticket or request context');

  reset(prefix);
  store.meetingLoginUrl='renderer-selected.invalid';
  requestContext.envInfo={proxyAddress:'proxy.invalid',proxyPort:'8443',proxyAccount:'synthetic-proxy-user',
    proxyPassword:'synthetic-proxy-password',caCertPath:'/synthetic/issuer-ca.pem',isSupportCACertCheck:false};
  requestContext.userInfo={account:'synthetic-workplace-user',tenantid:'synthetic-tenant'};
  r=await resolveFromMain(scoped());
  assert.equal(r.ok,true);assert.equal(publicRequests,1);assert.equal(new URL(lookup.url).origin,configuredIssuer);
  assert.equal(lookup.header['User-Agent'],'SyntheticUA WeLink/'+(process.platform==='win32'?'Windows':'Mac')+'/1.0.1/conference');
  assert.equal(lookup.header['X-Password'],pwd);
  assert.equal(JSON.stringify(lookup).includes('synthetic-workplace-user'),false);
  assert.equal(JSON.stringify(lookup).includes('synthetic-proxy-password'),false);
  assert.equal(lookup.header['User-Agent'].includes('ServiceUA'),false);
  assert.equal(lookup.header['User-Agent'].endsWith('/hwmService'),false);
  checks.push('verified invitation caller supplies the original user-agent and view ID, while service context supplies proxy/CA');

  for (const code of [403,'100620002']) {
    reset(prefix);
    const denial={code,resp_code:403,error_code:code,message:'Synthetic genuine service denial',
      siteUrl:guestSite,random:ticket,idPrefix:prefix};
    rawIssuerReply={result:0,param:{resp_code:200,recv_body:JSON.stringify(denial)}};
    r=await resolveFromMain(scoped());
    assert.equal(r.ok,true);assert.equal(r.response.result,false);assert.deepEqual(r.response.recv_body,denial);
    assert.equal(r.response.code,code);assert.equal(publicRequests,1);assert.equal(registrations+admission,0);
  }
  for (const status of [301,302,307,308]) {
    reset(prefix);
    rawIssuerReply={result:0,param:{resp_code:status,recv_body:JSON.stringify({siteUrl:guestSite,random:ticket,idPrefix:prefix}),
      out_header:[{header_name:'Location',header_value:'https://foreign.invalid/'}]}};
    r=await resolveFromMain(scoped());
    assert.equal(r.ok,false);assert.equal(r.error.code,'ISSUER_REDIRECT_UNAVAILABLE');
    assert.equal(publicRequests,1);assert.equal(registrations+admission,0);
    assert.equal(JSON.stringify(r).includes(ticket),false);
  }
  reset(prefix);rawIssuerReply={result:160,reason:ticket,param:null};
  r=await resolveFromMain(scoped());assert.equal(r.error.code,'ISSUER_REQUEST_UNAVAILABLE');
  assert.equal(publicRequests,1);assert.equal(registrations+admission,0);
  assert.equal(JSON.stringify(r).includes(ticket),false);
  reset(prefix);rawIssuerReply={result:0,param:{resp_code:403}};
  r=await resolveFromMain(scoped());assert.equal(r.ok,true);assert.equal(r.response.result,false);
  assert.equal(r.response.resp_code,403);assert.deepEqual(r.response.recv_body,{});
  checks.push('service business denial and empty HTTP errors retain facade semantics; redirects/network errors cannot grant or retry');

  for (const fuse of [
    {module:{blackList:['conference']}},
    {request:{blackList:['https://meeting.invalid/v1/mmc/management/conferences/']}}
  ]) {
    reset(prefix);requestContext.fuseInfo=fuse;
    r=await resolveFromMain(scoped());
    assert.equal(r.ok,true);assert.equal(r.response.result,false);assert.equal(r.response.code,-1001);
    assert.equal(publicRequests+registrations+admission,0);
  }
  checks.push('conference module fuse applies despite a distinct hwmService context; request fuse still blocks before native I/O');
  reset(prefix);requestContext.fuseInfo={module:{blackList:['hwmService']}};
  r=await resolveFromMain(scoped());
  assert.equal(r.ok,true);assert.equal(publicRequests,1);
  reset(prefix);originatingView=undefined;
  r=await resolveFromMain(scoped());
  assert.equal(r.ok,false);assert.equal(r.error.code,'ISSUER_CONTEXT_UNAVAILABLE');
  assert.equal(publicRequests+registrations+admission,0);
  checks.push('service-only caller metadata cannot substitute for the separately verified originating frame');
  issuedSites.clear();
  console.log(JSON.stringify({build:JSON.parse(src('native/build.json')).build,checks,liveMeetings:0,networkRequests:0}));
})().catch(err=>{console.error(err.stack);process.exitCode=1;});
