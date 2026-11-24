#!/usr/bin/env electron
'use strict';

// Parent-run, isolated network namespace + Xvfb only. No production account,
// telephone, physical device, conference, or active desktop is used.
// Required: WELINK_TEST_NATIVE=<sealed image/resources/app/native> and
// WELINK_TEST_WWW=<pinned /webrtc asset root, containing index.html>.
// Run as a non-root user with that image's sandboxed Electron and setuid sandbox
// helper; do not pass --no-sandbox. Put the image's native libraries on
// LD_LIBRARY_PATH. Requires openssl and native/vendor/management/node_modules/ws.
// Reuses verify_meeting_management.js (keep it next to this file).
// Only TLS/USG/CMS counterpart services are synthetic. The facade, service,
// renderer, broker, pinned vendor login/notification sagas, preload and prompts
// are real. No store mutation, fake SDK result, or injected provider callback.
// This proves two-party CMS establishment and terminal callbacks, NOT HRTC media:
// admission nonce requests are held, and the check requires zero media joins.
const assert = require('assert').strict;
const fs = require('fs'), os = require('os'), path = require('path');
const { X509Certificate, randomUUID } = require('crypto');
const electron = require('electron');
const { app, BrowserWindow, ipcMain } = electron;
const native = process.env.WELINK_TEST_NATIVE, www = process.env.WELINK_TEST_WWW;
if (![native, www].every(value => value && path.isAbsolute(value)))
  throw Error('Set absolute WELINK_TEST_NATIVE and WELINK_TEST_WWW');
const { MeetingNativeWeb, PROTOCOL } = require(path.join(native, 'meeting_native_web'));
const { Fixture, provision, deferred, TOKEN } = require('./verify_meeting_management');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-p2p-receipts-'));
const channel = 'welink-native-meeting-v1';
const self = { number:'999000001', name:'Local caller', thirdUserId:'local-self' };
const peer = { number:'999000002', name:'Local peer', thirdUserId:'local-peer' };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, label) {
  const deadline = Date.now() + 10000;
  do { const value = await test(); if (value) return value; await delay(20); } while (Date.now() < deadline);
  throw Error('Did not observe ' + label);
}
app.setPath('userData', path.join(root, 'profile'));
app.on('window-all-closed', () => {});

class PeerFixture extends Fixture {
  constructor(certs) {
    super(certs);
    this.cms = null;
    this.cmsFrames = [];
    this.issuedNonces = new Set();
    this.holdAdmission = false;
    this.held = [];
    this.holdEnd = false;
    this.heldEnds = [];
    this.accountLogins = 0;
    this.created = deferred();
    this.declined = deferred();
    this.nextConference = '900000601';
  }
  upgrade(request, socket, head) {
    const url = new URL(request.url, this.origin);
    if (url.pathname === '/v1/usg/wss/websocket') return super.upgrade(request, socket, head);
    try {
      assert.equal(url.pathname, '/v1/mmc/control/websocket/conn');
      assert.equal(request.headers.origin, this.origin);
      assert(this.issuedNonces.delete(url.searchParams.get('nonce')), 'CMS did not redeem a real local USG nonce');
      assert.equal(url.searchParams.get('tokenPrefix'), TOKEN.slice(0,3) + 'corp:local-corpuuid:local-self');
      this.wss.handleUpgrade(request, socket, head, ws => {
        ws.controlPeer = true;
        this.wss.emit('connection', ws, request);
      });
    } catch (error) { this.faults.push(error); socket.destroy(); }
  }
  connection(socket) {
    socket.on('error', error => this.faults.push(error));
    if (socket.controlPeer) this.cms = socket;
    socket.on('message', data => {
      try {
        const frame = JSON.parse(data.toString());
        const body = typeof frame.data === 'string' ? JSON.parse(frame.data) : frame.data;
        if (!socket.controlPeer) {
          if (frame.action === 'PING') { socket.send(JSON.stringify({action:'PONG'})); return; }
          assert.equal(frame.action, 'ConfManagement'); assert.equal(frame.type, 'CREATECONF');
          assert.equal(body.immediatelyConfStartMode, 3);
          assert.deepEqual(body.attendees.map(p => [p.phone,p.isAutoInvite]), [[self.number,0],[peer.number,1]]);
          assert.equal(body.mediaTypes, 'Voice,Video,Data');
          this.records.push({packet:frame});
          const conferenceID = this.nextConference;
          this.created.resolve({frame, conferenceID, reply:() => socket.send(JSON.stringify({...frame,
            data:JSON.stringify({returnCode:0,data:[{conferenceID,immediatelyConfStartMode:3,
              accessNumber:conferenceID,passwordEntry:[{conferenceRole:'chair',password:'local-chair-only'}]}]})}))});
          return;
        }
        this.cmsFrames.push({frame,body});
        if (frame.action === 'ConfControl' && frame.type === 'INVITETOJOIN' && body.optType === 2) {
          this.declined.resolve({frame,body,reply:(extra={}) => socket.send(JSON.stringify({...frame,...extra,
            data:JSON.stringify({conferenceID:body.conferenceID,returnCode:0,returnDesc:''})}))});
        } else if (frame.action === 'HeartBeat' || frame.type === 'ConfHeartBeat') {
          socket.send(JSON.stringify({...frame,data:JSON.stringify({returnCode:0})}));
        }
      } catch (error) { this.faults.push(error); socket.terminate(); }
    });
  }
  async http(request, response) {
    const url = new URL(request.url, this.origin);
    const reply = (data, status=200) => {
      const bytes = Buffer.from(JSON.stringify(data));
      response.writeHead(status, {'Content-Type':'application/json','Content-Length':bytes.length}); response.end(bytes);
    };
    try {
      if (request.method === 'GET' && url.pathname.startsWith('/webrtc/')) {
        const file = path.resolve(www, decodeURIComponent(url.pathname.slice(8)) || 'index.html');
        assert(file.startsWith(www + path.sep));
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404); response.end(); return; }
        const mime = {'.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json',
          '.svg':'image/svg+xml','.png':'image/png','.woff':'font/woff','.woff2':'font/woff2'};
        response.writeHead(200, {'Content-Type':mime[path.extname(file)] || 'application/octet-stream'});
        fs.createReadStream(file).pipe(response); return;
      }
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString();
      const body = raw && request.headers['content-type']?.includes('application/json') ? JSON.parse(raw) : raw || undefined;
      this.httpRecords.push({method:request.method,path:url.pathname,query:Object.fromEntries(url.searchParams),body});
      if (url.pathname === '/v1/usg/acs/auth/account') {
        assert.equal(request.method, 'POST');
        assert.equal(request.headers.authorization, 'Basic ' + Buffer.from('local-p2p:loopback-only').toString('base64'));
        assert.equal(body.account, 'local-p2p'); ++this.accountLogins;
        reply({accessToken:TOKEN,refreshToken:'local-refresh',validPeriod:3600,expireTime:Date.now()+3600000,
          createTime:Date.now(),utcTime:Date.now(),firstLogin:false,loggedIn:true,
          user:{userId:self.thirdUserId,companyId:'local-corp',name:self.name,ucloginAccount:'local-p2p',serviceAccount:'local-p2p'}});
      } else if (url.pathname === '/v1/usg/acs/ap/userservicedata') {
        assert.equal(request.headers['x-auth-token'], TOKEN);
        reply({corpCfg:{},serviceTp:{opsUri:this.origin+'/ops',rtcInfo:{appId:'local-control-only'},siteInfoList:[{
          priority:0,siteName:'isolated',accessStrategy:{service_access_node:{webRtcProxyUri:new URL(this.origin).host,
            rtcUri:new URL(this.origin).host,imWebSocketUri:''}}}]}});
      } else if (url.pathname === '/v1/usg/acs/auth/skipnonce' && request.method === 'POST') {
        assert.equal(request.headers['x-auth-token'], TOKEN);
        if (this.holdAdmission) { this.held.push({response,reply}); return; }
        const nonce = randomUUID(); this.issuedNonces.add(nonce); reply({nonce});
      } else if (url.pathname === '/v1/mmc/management/conferences' && request.method === 'DELETE') {
        assert.equal(request.headers['x-auth-token'], TOKEN); assert.equal(url.searchParams.get('type'),'1');
        const end = {conferenceID:url.searchParams.get('conferenceID'),reply:()=>reply({returnCode:0,data:{}})};
        if (this.holdEnd) this.heldEnds.push(end); else end.reply();
      } else if (url.pathname === '/v1/usg/acs/token' && request.method === 'DELETE') {
        response.writeHead(204); response.end();
      } else if (url.pathname === '/ops' && request.method === 'POST') {
        reply({});
      } else {
        // The login page's optional branding/privacy queries are not a call or
        // membership receipt. No unrecognized admission receives success.
        reply({error_code:'QA.UNSUPPORTED',error_msg:'No such isolated peer route'},404);
      }
    } catch (error) { this.faults.push(error); reply({error_code:'QA.ASSERTION'},500); }
  }
  notify(conferenceID, action, type, data) {
    assert(this.cms && this.cms.readyState === 1, 'The authenticated provider CMS socket is not open');
    const frame = {action,type,conferenceID,sequence:randomUUID(),msgID:randomUUID(),msgMode:1,
      data:action === 'ParticipantsNotify' ? data : JSON.stringify(data)};
    this.cms.send(JSON.stringify(frame)); return frame;
  }
  invite(id, optType=0) {
    return this.notify(id,'LocalControl','INVITETOJOIN',{conferenceID:id,optType,p2p:1,mediaType:'Voice',subject:'Incoming '+id});
  }
  party(id, pid, number, account, status='0') {
    return this.notify(id,'ParticipantsNotify','',[{pid,pinfoMap:{STATE:status,TEL:number,THIRDACCOUNT:account,NAME:pid,
      ROLE:'1',MUTE:'1',CAMERASTATE:'0',SHARE:'0'}}]);
  }
  hangup(id, pid='local-participant') {
    return this.notify(id,'LocalControl','HANGUP',{conferenceID:id,participantID:pid,confEndReason:7});
  }
  releaseAdmission() {
    for (const held of this.held.splice(0)) if (!held.response.destroyed)
      held.reply({error_code:'QA.ADMISSION_HELD',error_msg:'Control-only test; no media admission'},403);
    this.holdAdmission = false;
  }
}

const compiled = fs.readFileSync(path.join(native,'../plugin/conference/dist/js/hwmService.js'),'utf8');
function facade(name, needle) {
  const key = '{key:'+JSON.stringify(name)+',value:';
  for (let offset=0;;) {
    const at=compiled.indexOf(key,offset); assert.notEqual(at,-1,'Missing packaged '+name);
    const start=at+key.length,end=compiled.indexOf('}},{key:',start); assert(end>start);
    const body=compiled.slice(start,end+1); if(body.includes(needle)) return body; offset=start;
  }
}
const dial = facade('startCall','ae.startCall(');
async function service(origin) {
  const campus=path.join(root,'campus'), docs=path.join(campus,'plugin/conference/dist'), logs=path.join(root,'logs');
  fs.mkdirSync(docs,{recursive:true}); fs.mkdirSync(path.join(logs,'conference'),{recursive:true});
  fs.mkdirSync(path.join(campus,'plugin/conference/HwmSdk'),{recursive:true});
  fs.writeFileSync(path.join(campus,'plugin/conference/HwmSdk/offlineJoinIp.json'),
    JSON.stringify({Domains:{httpProxyUri:'unused-cms.invalid'}}));
  const file=path.join(docs,'hwmService.html'); fs.writeFileSync(file,'<!doctype html><meta charset=utf-8><title>Local P2P service</title>');
  const w=new BrowserWindow({show:false,webPreferences:{nodeIntegration:true,contextIsolation:false,sandbox:false}});
  await w.loadFile(file);
  await w.webContents.executeJavaScript(`
    const store={compassUrlEnable:true,compassUrl:${JSON.stringify(origin)},isUserLogined:false,isServerDowngrade:false};
    window.frames=[];window.statuses=[];window.notices=[];window.notifyJsTupCallback=e=>frames.push(e);
    window.addEventListener('callStatusChange',e=>statuses.push(e.detail.callStatus));
    const pedestal={logRootPath:${JSON.stringify(logs)},appdataRootPath:${JSON.stringify(root)},sendBroadcast:(k,v)=>notices.push([k,v]),callMethod:async m=>{
      if(m==='method://pedestal/getEnvInfo')return {ffiPath:${JSON.stringify(path.join(native,'../libraries/node_extends/node-ffi/ffi-napi'))}};
      if(m==='method://pedestal/getProxyInfo')return {};if(m==='method://pedestal/getLogStoragePath')return ${JSON.stringify(logs)};
      throw Error('unexpected pedestal lookup '+m);
    }};
    const m={a:x=>x},ne={info(){}},ae=require(${JSON.stringify(path.join(native,'meeting_service'))}).createService({window,Pedestal:pedestal,sdk:{},getStore:()=>({getStore:k=>k===undefined?store:store[k],setStore:(k,v)=>{store[k]=v;}})});true`);
  return w;
}
async function shownPrompt(id) {
  const w=await until(()=>BrowserWindow.getAllWindows().find(win=>!win.isDestroyed() && win.isVisible() &&
    win.webContents.getURL().includes('/meeting_incoming_invite.html#')),'incoming prompt '+id);
  await until(()=>w.webContents.executeJavaScript('!document.getElementById("accept").disabled'),'ready prompt');
  assert.equal(await w.webContents.executeJavaScript('document.getElementById("subject").textContent'),'Incoming '+id);
  return w;
}
async function clickPrompt(id, kind) {
  const w=await shownPrompt(id);
  const point=await w.webContents.executeJavaScript(`(()=>{const r=document.getElementById(${JSON.stringify(kind)}).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  w.focus();
  for(const type of ['mouseDown','mouseUp'])w.webContents.sendInputEvent({type,...point,button:'left',clickCount:1});
  await until(()=>w.isDestroyed(),'consumed prompt');
}
async function main() {
  await app.whenReady();
  const certs=provision(root), fixture=new PeerFixture(certs); await fixture.start();
  let mediaPrompts=0,mediaJoins=0;
  const bridge=new MeetingNativeWeb({electron,origin:fixture.origin,getAccessToken:async()=>TOKEN,
    getManagementConfig:async()=>fixture.config(),getCallContext:async()=>({self}),
    requestPermission:async()=>{++mediaPrompts;return false;}});
  const fp=new X509Certificate(certs.cert).fingerprint256;
  const pin=(req,done)=>done(req.hostname==='127.0.0.1' &&
    new X509Certificate(req.certificate.data).fingerprint256===fp?0:-3);
  (await bridge.initializeAccountSession()).setCertificateVerifyProc(pin);
  (await bridge.initializeSession()).setCertificateVerifyProc(pin);
  const w=await service(fixture.origin), records=[],starts=[];
  const evaluate=code=>w.webContents.executeJavaScript(code);
  let latestCallState = null;
  bridge.on('event',ev=>{
    if(ev.event==='meeting-lifecycle' && ev.data?.state==='joined')++mediaJoins;
    if(ev.event==='p2p-call-state')latestCallState=ev.data;
    if(ev.event==='p2p-native-notify'){
      if(ev.data.notify===33)records.push(ev.data); if(ev.data.notify===63)starts.push(ev.data);
    }
    w.webContents.send(channel+'-event',{kind:'event',message:ev});
  });
  ipcMain.handle(channel,(event,envelope)=>{
    assert.equal(event.sender,w.webContents); assert.equal(event.senderFrame,w.webContents.mainFrame);
    if(envelope.kind==='register')return {protocol:PROTOCOL,instance:bridge.instance,origin:fixture.origin};
    return bridge.handle(envelope.message);
  });
  const callState=async()=>latestCallState || {};
  const terminal=async count=>{
    await until(()=>records.length===count,'terminal native record '+count);
    await until(async()=> (await evaluate('frames.filter(e=>e.notify===33).length'))===count,'campus callback '+count);
  };
  try {
    assert.equal((await evaluate('ae.prepareInvitationResolver()')).ok,true);
    await bridge.execute('initialize');
    await bridge.execute('watermark.set',{content:'',color:'#999999'});
    await bridge.execute('ui.configure',{isUserLogined:false,customButtonStatus:null});
    const view=bridge.window.webContents;
    // This is the vendor login command (not setLoginInfo or an onLogin success
    // injection). Its unchanged worker performs actual authenticated HTTP.
    await view.executeJavaScript(`new Promise((resolve,reject)=>{
      let load;webpackChunkweb_rtc.push([['qa-peer-login'],{},r=>{load=r}]);
      window.qaLoad=load;
      load(36176).store.dispatch(load(86658).electronLogin({username:'local-p2p',password:'loopback-only',successCB:()=>resolve(true),failCB:()=>reject(Error('local login failed'))}));
    })`);
    assert.equal(fixture.accountLogins,1);
    await until(()=>bridge.webToken===TOKEN,'provider login callback');
    async function connectCms() {
      fixture.holdAdmission=false;
      await view.executeJavaScript(`(()=>{const load=qaLoad,app=load(36176),cms=load(38746),c=load(62467);
        app.sagaMiddleware.run(cms.cmsWebsocketConnect,false,c.Cms_Socket_Register_Type.LOGIN_BUT_NO_JOIN);return true;})()`);
      await until(()=>fixture.cms?.readyState===1,'authenticated CMS socket');
      fixture.holdAdmission=true;
    }
    await connectCms();
    const outgoing={calleeNum:peer.number,isVideo:false,callRequestId:randomUUID(),userInfo:{
      caller_info:{name:self.name},callee_info:{name:peer.name,account_id:peer.thirdUserId}}};
    const pending=evaluate(`(${dial}).call({},${JSON.stringify(outgoing)})`);
    const create=await until(()=>fixture.records.length && fixture.created.promise,'mode-3 creation'); create.reply();
    const receipt=await pending;
    assert.equal(receipt.notify,63); assert.equal(receipt.result,0); assert.equal(receipt.callState.callRequestId,outgoing.callRequestId);
    assert.equal(receipt.callState.peerEstablished,false);
    assert(!JSON.stringify(receipt).includes('local-chair-only'));
    await until(()=>fixture.held.length,'caller admission dispatched');
    fixture.party('wrong-conference','other',peer.number,peer.thirdUserId);
    fixture.party(create.conferenceID,'local-participant',self.number,self.thirdUserId);
    await until(async()=>(await callState()).localControlEstablished,'own control membership');
    fixture.party(create.conferenceID,'local-participant',peer.number,peer.thirdUserId);
    await delay(100); assert.equal((await callState()).peerEstablished,false,'Own participant falsely answered the call');
    fixture.party(create.conferenceID,'remote-participant',peer.number,peer.thirdUserId);
    await until(async()=>(await callState()).peerEstablished,'remote established receipt');
    assert.equal((await callState()).callerJoined,false);
    await delay(1100);
    const ended=fixture.hangup(create.conferenceID);
    await terminal(1); fixture.cms.send(JSON.stringify(ended)); await delay(80);
    assert.equal(records.length,1);
    assert.equal(records[0].param.isCallOut,true); assert.equal(records[0].param.isCallEstablished,true);
    assert.equal(records[0].param.resultCode,414100086); assert.equal(records[0].param.calleeInfo.number,peer.number);
    assert(records[0].param.endTime-records[0].param.startTime>=1);
    fixture.releaseAdmission(); await connectCms();

    const incoming='900000602'; fixture.invite(incoming); await clickPrompt(incoming,'accept');
    await until(()=>fixture.held.length,'accepted invitation admission request');
    fixture.party(incoming,'local-participant',self.number,self.thirdUserId);
    fixture.party(incoming,'remote-participant',peer.number,peer.thirdUserId);
    await until(async()=>(await callState()).peerEstablished,'incoming remote establishment');
    assert.equal((await callState()).callerJoined,false);
    await delay(1100); fixture.hangup(incoming); await terminal(2);
    assert.equal(records[1].param.isCallOut,false); assert.equal(records[1].param.isCallEstablished,true);
    assert.equal(records[1].param.callerInfo.number,peer.number); assert.equal(records[1].param.calleeInfo.number,self.number);
    assert.equal(records[1].param.resultCode,414100086);
    fixture.releaseAdmission(); await connectCms();

    const declined='900000603'; fixture.invite(declined); await clickPrompt(declined,'decline');
    const rejection=await until(()=>fixture.cmsFrames.some(x=>x.body?.conferenceID===declined && x.body.optType===2) && fixture.declined.promise,'real decline request');
    assert.equal(records.length,2); rejection.reply({sequence:'unrelated-sequence'}); await delay(80); assert.equal(records.length,2);
    rejection.reply(); await terminal(3); rejection.reply(); await delay(80); assert.equal(records.length,3);
    assert.equal(records[2].param.isCallEstablished,false); assert.equal(records[2].param.isCallOut,false);
    assert.equal(records[2].param.resultCode,0,'Preserve the actual decline-operation response, not an invented reason');
    assert.equal(fixture.held.length,0,'Declining attempted admission');

    const cancelled='900000604'; fixture.invite(cancelled); await clickPrompt(cancelled,'accept');
    fixture.invite(cancelled,1); await terminal(4);
    assert.equal(records[3].param.isCallEstablished,false); assert.equal('resultCode' in records[3].param,false);
    fixture.party(cancelled,'remote-participant',peer.number,peer.thirdUserId); fixture.invite(cancelled,1);
    const replacement='900000605'; fixture.invite(replacement);
    await until(async()=> (await callState()).conferenceID===replacement,'replacement incoming attempt');
    fixture.invite(cancelled,1);
    await delay(1700);
    assert.equal(fixture.held.length,0,'Cancelled acceptance authenticated the replacement');
    assert.equal((await callState()).conferenceID,replacement); assert.equal((await callState()).decision,null);
    // A valid self attendee is not the user's acceptance. FINISH must release
    // this unanswered owner and allow the next actual invitation to be shown.
    const selfOnlyPrompt=await shownPrompt(replacement);
    fixture.party(replacement,'local-participant',self.number,self.thirdUserId);
    await until(async()=>(await callState()).localControlEstablished,'early self control receipt');
    assert.equal((await callState()).decision,null);
    assert.equal((await callState()).peerEstablished,false);
    fixture.invite(replacement,1); await terminal(5);
    assert.equal(records[4].param.isCallEstablished,false);
    assert.equal('resultCode' in records[4].param,false);
    await until(()=>selfOnlyPrompt.isDestroyed(),'unanswered prompt withdrawal');
    const afterSelf='900000607'; fixture.invite(afterSelf);
    const replacementPrompt=await shownPrompt(afterSelf);
    assert.equal((await callState()).conferenceID,afterSelf);
    assert.equal((await callState()).decision,null);
    fixture.invite(replacement,1); await delay(80);
    assert.equal(records.length,5);
    assert.equal(replacementPrompt.isDestroyed(),false,'A duplicate withdrawal closed the replacement');
    fixture.invite(afterSelf,1); await terminal(6);
    // A real remote answer can win before the successful cancellation receipt.
    // The record then remains established; an answer delivered after that
    // terminal receipt cannot resurrect or duplicate it.
    fixture.created=deferred(); fixture.nextConference='900000606'; fixture.holdEnd=true;
    const raceDial=evaluate(`(${dial}).call({},${JSON.stringify({...outgoing,callRequestId:randomUUID()})})`);
    const raceCreate=await until(()=>fixture.records.length===2 && fixture.created.promise,'second mode-3 creation');
    raceCreate.reply(); assert.equal((await raceDial).result,0);
    await until(()=>fixture.held.length,'second caller admission');
    const attempt=(await callState()).attemptId;
    const cancelling=evaluate(`ae.cancelPendingCall(${JSON.stringify({kind:'p2p',attemptId:attempt})})`);
    await until(()=>fixture.heldEnds.length,'exact conference cancellation request');
    assert.equal(fixture.heldEnds[0].conferenceID,fixture.nextConference);
    fixture.party(fixture.nextConference,'local-participant',self.number,self.thirdUserId);
    fixture.party(fixture.nextConference,'remote-participant',peer.number,peer.thirdUserId);
    await until(async()=>(await callState()).peerEstablished,'answer racing cancellation');
    assert.equal((await callState()).cancelRequested,true);
    fixture.heldEnds.shift().reply(); assert.equal((await cancelling).result,0); await terminal(7);
    fixture.hangup(fixture.nextConference);
    fixture.party(fixture.nextConference,'remote-participant',peer.number,peer.thirdUserId);
    await delay(80);
    assert.equal(records.length,7); assert.equal(starts.length,2);
    assert.equal(records[6].param.isCallEstablished,true);
    assert.equal(records[6].param.resultCode,0);
    assert.equal(mediaJoins,0); assert.equal(mediaPrompts,0);
    const callbackFrames=await evaluate('frames.filter(e=>e.notify===33)'); assert.deepEqual(callbackFrames,records);
    const statuses=await evaluate('statuses'); assert(statuses.includes(1)); assert.equal(statuses.at(-1),0);
    fixture.check();
    console.log('P2P_PEER_RECEIPTS '+JSON.stringify({scope:'authenticated CMS control membership, not HRTC media',
      peerAnswered:true,incomingAnswered:true,terminalRecords:records.length,exactOnce:true,
      lateAcceptanceIgnored:true,cancelAnswerRaceCorrelated:true,unknownWithdrawalReasonPreserved:true,mediaJoins,mediaPrompts,
      earlySelfWithdrawalReleased:true,replacementPromptAfterWithdrawal:true,
      records:records.map(frame=>frame.param)}));
  } catch (error) {
    console.error('P2P_FAILURE',error.stack || error);
    console.error('PEER_HTTP',JSON.stringify(fixture.httpRecords.map(({method,path})=>({method,path}))));
    throw error;
  } finally {
    fixture.releaseAdmission(); ipcMain.removeHandler(channel);
    for (const end of fixture.heldEnds.splice(0)) end.reply();
    await bridge.execute('dispose'); w.destroy(); await fixture.stop();
  }
}
const timer=setTimeout(()=>{console.error('P2P peer receipt deadline');app.exit(2);},90000);
main().then(()=>{clearTimeout(timer);app.exit(0)},error=>{clearTimeout(timer);console.error(error.stack||error);app.exit(1)});
app.once('quit',()=>fs.rmSync(root,{recursive:true,force:true}));
