'use strict';
// Run with the sealed release Electron in a private netns. Only the workplace
// config/identity service and loopback meeting service are fixtures. The campus
// facade methods, native FFI, renderer, IPC, broker, media page and HRTC are real.
const assert = require('assert').strict;
const fs = require('fs'), os = require('os'), path = require('path');
const { X509Certificate } = require('crypto');
const electron = require('electron');
const { app, BrowserWindow, ipcMain } = electron;
const native = process.env.WELINK_TEST_NATIVE;
if (!native || !path.isAbsolute(native)) throw Error('Set WELINK_TEST_NATIVE');
const { installMeetingMain } = require(path.join(native,'meeting_main'));
const { MeetingNativeWeb, PROTOCOL } = require(path.join(native,'meeting_native_web'));
const { Fixture, provision, deferred, observed, TOKEN } = require('./verify_meeting_management');
const root = fs.mkdtempSync(path.join(os.tmpdir(),'wl-native-parity-'));
const campus = path.join(root,'campus'), docs = path.join(campus,'plugin/conference/dist');
fs.mkdirSync(docs,{recursive:true});
fs.mkdirSync(path.join(campus,'plugin/conference/HwmSdk'));
const localPage = path.join(docs,'hwmService.html');
fs.writeFileSync(localPage,'<!doctype html><meta charset=utf-8><title>Isolated campus service</title>');
fs.writeFileSync(path.join(campus,'plugin/conference/HwmSdk/offlineJoinIp.json'),JSON.stringify({Domains:{httpProxyUri:'no-cms-host.invalid'}}));
const logs=path.join(root,'logs');fs.mkdirSync(path.join(logs,'conference'),{recursive:true});
app.setPath('userData',path.join(root,'profile'));app.on('window-all-closed',()=>{});
const compiled=fs.readFileSync(path.join(native,'../plugin/conference/dist/js/hwmService.js'),'utf8');
function method(name,needle) {
  const key='{key:'+JSON.stringify(name)+',value:';
  for(let offset=0;;){const at=compiled.indexOf(key,offset);assert.notEqual(at,-1,name+' not found');
    const start=at+key.length,end=compiled.indexOf('}},{key:',start);assert(end>start);
    const body=compiled.slice(start,end+1);if(body.includes(needle))return body;offset=start;
  }
}
const dial=method('startCall','ae.startCall('), link=method('newJoinConfByLink','ae.newJoinConfByLink(');
const channel='welink-native-meeting-v1', windows=[];
const call=(w,body,params)=>w.webContents.executeJavaScript(`(${body}).call({},${JSON.stringify(params)})`);
const number='999000002', params={calleeNum:number,isVideo:false,userInfo:{caller_info:{name:'Test caller'},callee_info:{name:'Test peer',bind_no:number,mobile:''}},callRequestId:'a'.repeat(32)};
const invite={confId:'1234567890',random:'local-opaque-fixture',nick_name:'Local QA',site_url:'https://untrusted-invitation.invalid',isOfflineJoin:true};
async function service(origin, caCertPath) {
  const w=new BrowserWindow({show:false,webPreferences:{nodeIntegration:true,contextIsolation:false,sandbox:false}});windows.push(w);
  await w.loadFile(localPage);
  await w.webContents.executeJavaScript(`
    const store={compassUrlEnable:true,compassUrl:${JSON.stringify(origin)},isUserLogined:false,isServerDowngrade:false};
    window.notices=[];window.frames=[];window.notifyJsTupCallback=e=>frames.push(e);
    const pedestal={logRootPath:${JSON.stringify(logs)},appdataRootPath:${JSON.stringify(root)},sendBroadcast:(k,v)=>notices.push([k,v]),callMethod:async m=>{
      if(m==='method://pedestal/getEnvInfo')return {ffiPath:${JSON.stringify(path.join(native,'../libraries/node_extends/node-ffi/ffi-napi'))},caCertPath:${JSON.stringify(caCertPath)}};
      if(m==='method://pedestal/getProxyInfo')return {};if(m==='method://pedestal/getLogStoragePath')return ${JSON.stringify(logs)};
      throw Error('unexpected pedestal lookup '+m);
    }};
    const m={a:x=>x}, ne={info(){}}, ae=require(${JSON.stringify(path.join(native,'meeting_service'))}).createService({window,Pedestal:pedestal,sdk:{},getStore:()=>({getStore:k=>k===undefined?store:store[k],setStore:(k,v)=>{store[k]=v;}})});true`);
  return w;
}
async function originalFailures() {
  const stop=installMeetingMain({electron,appRoot:campus});const w=await service('https://login.invalid');
  let surface;
  const onWindow=(_e,win)=>win.once('show',()=>{if(win.webContents.getURL().endsWith('/meeting_offline.html'))surface={id:win.id,visible:win.isVisible(),url:win.webContents.getURL()};});
  app.on('browser-window-created',onWindow);
  try{
    const a=await call(w,dial,params);console.log('PORT_DIAL_RESULT '+JSON.stringify(a));
    assert.equal(a.notify,63);assert.equal(a.result,412100043);assert.equal(a.param.reason_code,412100043);assert.equal(a.dialAccepted,false);
    assert.equal(a.param.reason,'Not logged in, not available.:此业务未登录不可用');
    const b=await call(w,link,invite);console.log('PORT_LINK_RESULT '+JSON.stringify(b));
    assert.equal(b.notify,102);assert.equal(b.result,414100020);assert.equal(b.param.reason_code,414100020);
    assert.equal(b.param.reason,'Curl host exception.:curl主机异常');
    assert(surface?.visible,'no visible packaged offline surface');assert(!BrowserWindow.fromId(surface.id),'failed offline document remained open');
    const notices=await w.webContents.executeJavaScript('notices');assert.equal(notices.length,1);assert.equal(notices[0][1].reason_code,414100020);
    return {notify63:a.result,notify102:b.result,offlineWindowClosed:true};
  }finally{app.removeListener('browser-window-created',onWindow);await stop();w.destroy();}
}
class Mode3Fixture extends Fixture {
  connection(socket){socket.on('message',data=>{try{
    const packet=JSON.parse(data), body=JSON.parse(packet.data);assert.equal(packet.action,'ConfManagement');assert.equal(packet.type,'CREATECONF');
    assert.equal(body.immediatelyConfStartMode,3);assert.deepEqual(body.attendees.map(p=>p.isAutoInvite),[0,1]);assert.equal(body.mediaTypes,'Voice,Video,Data');
    this.records.push({packet});this.received.resolve({reply:()=>socket.send(JSON.stringify({...packet,data:JSON.stringify({returnCode:0,data:[{conferenceID:'900000088',immediatelyConfStartMode:3,accessNumber:'900000088',passwordEntry:[{conferenceRole:'chair',password:'local-only'}]}]})}))});
  }catch(e){this.faults.push(e);socket.terminate();}});}
}
function waitForDialText(w, selector, text) {
  return w.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const probe = () => { const value = document.querySelector(${JSON.stringify(selector)})?.textContent;
      if (value?.includes(${JSON.stringify(text)})) { observer.disconnect(); clearTimeout(timer); resolve(value); } };
    const observer = new MutationObserver(probe), timer = setTimeout(() => { observer.disconnect(); reject(Error('Missing dial status: ' + document.body.innerText)); }, 5000);
    observer.observe(document.body, {childList:true, subtree:true, characterData:true}); probe(); })`);
}
async function outbound(){
  const certs=provision(root), f=new Mode3Fixture(certs);await f.start();
  const bridge=new MeetingNativeWeb({electron,origin:f.origin,getAccessToken:async()=>TOKEN,getManagementConfig:async()=>f.config(),
    getCallContext:async()=>({self:{number:'999000001',name:'Test caller',thirdUserId:'qa-account'}})});
  const fp=new X509Certificate(certs.cert).fingerprint256;
  (await bridge.initializeAccountSession()).setCertificateVerifyProc((req,done)=>done(req.hostname==='127.0.0.1'&&new X509Certificate(req.certificate.data).fingerprint256===fp?0:-3));
  const w=await service(f.origin); const records=[],starts=[];
  const endSeen=deferred(), allowEnd=deferred(), http=f.http.bind(f);
  f.http=async(req,res)=>{if(req.method==='DELETE'){endSeen.resolve(new URL(req.url,f.origin));await allowEnd.promise;}return http(req,res);};
  const dialWindow=new BrowserWindow({show:false,webPreferences:{nodeIntegration:true,contextIsolation:false,backgroundThrottling:false}});
  const dialPage=path.join(root,'keypad.html'), uiChannel='qa-mode3-dial';
  const scriptURL=require('url').pathToFileURL(path.join(native,'meeting_dial.js')).href;
  fs.writeFileSync(dialPage,`<!doctype html><meta charset="utf-8"><title>Mode-3 dial test</title><body><script>window.language={KEYPAD:'Keypad'};window.Pedestal={callMethod:(m,p)=>require('electron').ipcRenderer.invoke('${uiChannel}',m,p)};</script><script src="${scriptURL}"></script></body>`);
  await dialWindow.loadFile(dialPage);dialWindow.show();
  let createReply;
  ipcMain.handle(uiChannel,async(event,method,p)=>{
    assert.equal(event.sender,dialWindow.webContents);assert.equal(event.senderFrame,dialWindow.webContents.mainFrame);
    if(method==='method://conference/startCall') return createReply=await call(w,dial,{...params,callRequestId:p.callRequestId});
    const cmd=method.slice('method://conference/'.length);assert(['getPendingCall','cancelPendingCall'].includes(cmd));
    return w.webContents.executeJavaScript(`ae[${JSON.stringify(cmd)}](${JSON.stringify(p)})`);
  });
  bridge.on('event',ev=>{if(ev.event==='p2p-native-notify'){
    if(ev.data.notify===33)records.push(ev.data);if(ev.data.notify===63)starts.push(ev.data);
    w.webContents.send(channel+'-event',{kind:'event',message:ev});}});
  ipcMain.handle(channel,(event,env)=>{assert.equal(event.sender,w.webContents);assert.equal(event.senderFrame,w.webContents.mainFrame);
    if(env.kind==='register')return {protocol:PROTOCOL,instance:bridge.instance,origin:f.origin};return bridge.handle(env.message);});
  try{
    const prepare=await w.webContents.executeJavaScript('ae.prepareInvitationResolver()');assert.equal(prepare.ok,true);
    f.received=deferred();await dialWindow.webContents.executeJavaScript(`window.dialResult=window.__welinkStartDial({calleeNum:${JSON.stringify(number)},isVideo:false});true`);
    const frame=await observed(f.received.promise,'genuine mode-3 creation');
    await waitForDialText(dialWindow,'[role=status]','waiting for service confirmation');
    dialWindow.focus();const xy=await dialWindow.webContents.executeJavaScript(`(()=>{const b=document.querySelector('[role=status] button');if(!b||b.disabled)throw Error('No cancellation control');const r=b.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
    for(const type of ['mouseDown','mouseUp'])dialWindow.webContents.sendInputEvent({type,...xy,button:'left',clickCount:1});
    await waitForDialText(dialWindow,'[role=status]','Cancellation requested');frame.reply();
    const url=await observed(endSeen.promise,'end for the created call');assert.equal(url.searchParams.get('conferenceID'),'900000088');
    await waitForDialText(dialWindow,'[role=status]','Requesting that this call be ended');
    assert.equal(await dialWindow.webContents.executeJavaScript(`!!document.querySelector('[role=alert]')`),false);
    allowEnd.resolve();assert.equal(await dialWindow.webContents.executeJavaScript('window.dialResult'),false);
    await waitForDialText(dialWindow,'[role=alert]','The service confirmed this call was ended');
    assert.equal(createReply.notify,63);assert.equal(createReply.result,0);assert.equal(createReply.dialAccepted,false);
    const frames=await w.webContents.executeJavaScript('frames.filter(e=>e.notify===33)');
    assert.equal(records.length,1);assert.equal(frames.length,1);assert.equal(frames[0].param.isCallEstablished,false);assert.equal(frames[0].param.calleeInfo.number,number);
    assert.deepEqual(f.httpRecords.filter(q=>q.method==='DELETE').map(q=>q.query),[{conferenceID:'900000088',type:'1'}]);
    f.received=deferred();const pending=call(w,dial,{...params,callRequestId:'b'.repeat(32)});await observed(f.received.promise,'unanswered mode-3 CREATE');
    const timed=await pending;assert.equal(timed.notify,63);assert.equal(timed.result,414100003);assert.equal(records.length,1);assert.equal(f.records.length,2);
    assert.deepEqual(starts.map(ev=>ev.result),[0,414100003]);f.check();
    return {mode:3,createReceipts:starts.map(ev=>ev.result),endedId:'900000088',terminalRecords:frames.length,peerAnswered:false,dialWindowWaitedForEnd:true};
  }finally{allowEnd.resolve();ipcMain.removeHandler(uiChannel);ipcMain.removeHandler(channel);dialWindow.destroy();await bridge.execute('dispose');w.destroy();await f.stop();}
}
async function offlineEntry() {
  const {createPeer}=require('./verify_offline_hrtc_peer');
  let fault, settled, peer, w, stop;
  const checkCert=(event,_contents,url,_error,cert,done)=>{
    const u=new URL(url), ok=!!peer && u.host===new URL(peer.origin).host && ['https:','wss:'].includes(u.protocol) &&
      new X509Certificate(cert.data).fingerprint256===peer.fingerprint;
    if(ok)event.preventDefault();done(ok);
  };
  app.on('certificate-error',checkCert);
  async function until(read,description) {
    const deadline=Date.now()+33000;
    while(Date.now()<deadline){if(fault)throw fault;const v=await read();if(v)return v;
      if(settled)throw Error('Entry completed before '+description+': '+settled.result);
      await new Promise(resolve=>setTimeout(resolve,40));}
    throw Error('No '+description);
  }
  try {
    peer=await createPeer({electron,conferenceDir:native,directory:root,onFailure:e=>{fault=e;}});
    fs.writeFileSync(path.join(campus,'plugin/conference/HwmSdk/offlineJoinIp.json'),JSON.stringify(peer.config.offlineJoinConfig));
    stop=installMeetingMain({electron,appRoot:campus});w=await service(peer.origin,peer.certPath);
    peer.holdJoinNotify(true);
    const join=call(w,link,peer.params).then(reply=>{settled=reply;return reply;},err=>{fault=err;});
    const waiting=await until(()=>w.webContents.executeJavaScript(`(()=>{const s=ae.store.getStore('nativeOfflineMeeting');return s?.state==='waiting'&&s.participantID})()`),'waiting-room participant');
    assert.equal(await w.webContents.executeJavaScript('notices.length'),0);
    assert.equal(peer.transcript.some(ev=>ev.channel==='rtc'),false);
    peer.allowWaiting(waiting);
    await until(()=>peer.pending.notify,'HRTC admission and held JoinConfNotify');
    assert.equal(settled,undefined);assert.equal(await w.webContents.executeJavaScript('notices.length'),0);
    peer.releaseJoinNotify();peer.holdJoinNotify(false);
    const reply=await join;if(fault)throw fault;
    assert.equal(reply.notify,102);assert.equal(reply.result,0);assert.equal(reply.param.reason_code,0);
    const state=reply.param.state;assert.equal(state.joined,true);assert.equal(state.conferenceID,peer.params.confId);
    assert.equal(state.media.source,'offline-hrtc');assert.equal(state.media.roomJoined,true);
    const notices=await w.webContents.executeJavaScript(`notices.filter(([key])=>key==='broadcast://private_conference/hwm/notifyCheckAnonymouseJoinConf')`);
    assert.equal(notices.length,1);assert.equal(notices[0][1].state.participantID,state.participantID);
    const left=await w.webContents.executeJavaScript(`ae.run('conference.leave',{})`);
    assert.equal(left.result,0);assert.equal(left.param.left,true);
    assert(peer.transcript.some(ev=>ev.channel==='rtc'&&ev.operation==='BYE'));
    assert(peer.transcript.some(ev=>ev.channel==='cms'&&ev.operation==='leave-confirmed'));
    return {notify:reply.notify,result:reply.result,joined:true,oneSuccessBroadcast:true,confirmedLeave:true};
  } finally {
    if(stop)await stop();if(w&&!w.isDestroyed())w.destroy();if(peer)await peer.close();
    app.removeListener('certificate-error',checkCert);
  }
}
async function main(){await app.whenReady();
  if(process.argv.includes('--offline-entry')){console.log('CAMPUS_OFFLINE '+JSON.stringify(await offlineEntry()));return;}
  const fail=await originalFailures(),p2p=await outbound();console.log('BRIDGE_PARITY '+JSON.stringify({fail,p2p}));}
const timer=setTimeout(()=>{console.error('parity test deadline');app.exit(2);},75000);
main().then(()=>{clearTimeout(timer);app.exit(0)},err=>{clearTimeout(timer);console.error(err.stack||err);app.exit(1)});
app.once('quit',()=>fs.rmSync(root,{force:true,recursive:true}));
