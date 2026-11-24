#!/usr/bin/env electron
'use strict';
// Offline integration acceptance. The owner document and provider invitation state are fixtures;
// the campus service, its IPC, SDK log, HRTC module, inbox preload, prompt and input are real.
const assert = require('assert').strict;
const fs = require('fs'), path = require('path'), os = require('os');
const electron = require('electron'), {app, BrowserWindow} = electron;
const native = process.env.WELINK_TEST_NATIVE, chunk = process.env.WELINK_TEST_HRTC;
const out = process.env.WELINK_TEST_OUTPUT;
if (![native,chunk,out].every(x => x && path.isAbsolute(x))) throw Error('Absolute acceptance paths required');
const q = fs.mkdtempSync(path.join(os.tmpdir(), 'welink-media-io-'));
app.setPath('userData', path.join(q, 'profile'));
app.on('window-all-closed', () => {});
const receipts = { vendor:'HRTC 1.10.96', invited:[], scope:'Synthetic pending invitations and local owner. Real packaged media preload, user controls, HRTC logging and local campus IPC. No conference or server receipt.' };
const pause = ms => new Promise(done => setTimeout(done,ms));
async function until(fn, description) {
  const start = Date.now();
  while (Date.now()-start < 7000) { const value = await fn(); if (value) return value; await pause(30); }
  throw Error('Timed out: '+description);
}
function intercepted(session, doc, html) {
  session.protocol.interceptBufferProtocol('https', (request, reply) => {
    if (request.url === doc) { reply({ mimeType: 'text/html', data: Buffer.from(html) }); return; }
    reply({error:-10});
  });
  session.setPermissionCheckHandler(()=>false);
  session.setPermissionRequestHandler((_wc,_type,cb)=>{ receipts.permissionRequests++; cb(false); });
}
async function run() {
  await app.whenReady();
  const build = JSON.parse(fs.readFileSync(path.join(native,'build.json')));
  receipts.build = build.build; receipts.permissionRequests = 0;
  const vendor = fs.readFileSync(chunk,'utf8');
  const fixtureRoot=path.join(q,'owner'), ownerPath=path.join(fixtureRoot,'plugin/conference/dist/hwmService.html');
  fs.mkdirSync(path.dirname(ownerPath),{recursive:true,mode:0o700}); fs.writeFileSync(ownerPath,'<!doctype html><meta charset=utf-8><title>Offline campus service fixture</title>');
  // Capture the actual owner object, without substituting any production methods.
  const mod=require(path.join(native,'meeting_native_web.js')), Real=mod.MeetingNativeWeb;
  let owner;
  mod.MeetingNativeWeb=class extends Real { constructor(opts){ super(opts); owner=this; } };
  const {installMeetingMain}=require(path.join(native,'meeting_main.js'));
  mod.MeetingNativeWeb=Real;
  const stop=installMeetingMain({electron,appRoot:fixtureRoot});
  const serviceWindow=new BrowserWindow({show:false,webPreferences:{nodeIntegration:true,contextIsolation:false,sandbox:false,partition:'qa-local-service'}});
  await serviceWindow.loadFile(ownerPath);
  const serviceEval = code=>serviceWindow.webContents.executeJavaScript(code);
  const initRoot=path.join(q,'logs-initial'), nextRoot=path.join(q,'logs-next'), invalidRoot=path.join(q,'logs-denied');
  for (const r of [initRoot,nextRoot,invalidRoot]) fs.mkdirSync(r,{mode:0o700});
  const folder = r=>path.join(r,'conference','HwmSdk');
  const logfile = r=>path.join(folder(r),'hrtc.log');
  const origin='https://welink-test.invalid';
  await serviceEval(`window.testService=require(${JSON.stringify(path.join(native,'meeting_service.js'))}).createService({window,Pedestal:{logRootPath:${JSON.stringify(initRoot)},callMethod:async()=>${JSON.stringify(initRoot)}},sdk:{},getStore:()=>({})}); true`);
  const initial = await serviceEval(`testService.setLogPath({logPath:${JSON.stringify(folder(initRoot))}})`);
  assert.equal(initial.result,0,JSON.stringify(initial)); assert.equal(initial.param.nativeCommand,1046);
  assert.equal(owner,undefined,'A log-path change started the meeting owner');
  await serviceEval(`testService.bridge.origin=${JSON.stringify(origin)};testService.bridge.registerBroker()`);
  assert(owner && owner.options.sdkLog,'did not capture the real registered conference owner');
  const media=new BrowserWindow({show:false,webPreferences:{preload:path.join(native,'meeting_native_web_preload.js'),
    partition:owner.partition,sandbox:true,contextIsolation:true,nodeIntegration:false,additionalArguments:['--welink-meeting-channel='+owner.channel]}});
  const mediaURL=origin+'/test'; intercepted(media.webContents.session,mediaURL,'<!doctype html><meta charset=utf-8><title>Offline HRTC source</title>');
  owner.window=media;
  await media.loadURL(mediaURL);
  const mediaEval=s=>media.webContents.executeJavaScript(s);
  await mediaEval(vendor+'\n;true');
  for (const f of ['meeting_sdk_log_catalog.js','meeting_sdk_log_runtime.js']) await mediaEval(fs.readFileSync(path.join(native,f),'utf8')+'\n;true');
  await mediaEval(`(async()=>{const mod={exports:{}};window.webpackChunkweb_rtc.find(x=>x[1][91012])[1][91012](mod,mod.exports,{g:window});
    const sdk=mod.exports;if(sdk.VERSION!=='1.10.96')throw Error('Wrong HRTC version');
    const logger=window.__welinkInstallSdkLog(sdk,window.__welinkMeetingHost.writeSdkLog);
    window.exercise=()=>{const st=sdk.createStream({audio:true,video:false,userId:'QA_NONPERSISTENT_MARKER'});st.close();};
    window.flushLog=()=>logger.flush();window.endLog=()=>logger.dispose();
    window.__welinkNativeMeeting={invoke:async op=>{if(op!=='sdkLog.flush')throw Error('Unexpected fixture operation '+op);await logger.flush();return {ok:true,data:{flushed:true}};}};
    window.decisions=[];window.inviteID='';const host=window.__welinkMeetingHost, iface=window.hwCloudMeeting;
    host.setIncomingInviteIdentity(()=>window.inviteID);iface.registerInviteToJoinResult({callback:p=>decisions.push([window.inviteID,p.optType])});
    window.invite=(id,p2p)=>{window.inviteID=id;iface.onInviteToJoin({optType:0,p2p,subject:'合成邀请 '+id,mediaType:'audio'});return true;};
    window.withdraw=()=>{window.inviteID='';iface.onInviteToJoin({optType:1});return true;};
    await iface.onLogin({token:'QA_NO_ACCOUNT'});return true;})()`);
  // Ready means only the local HRTC logger is available to the broker; no conference is joined.
  owner.ready={sdkVersion:'1.10.96'};
  await mediaEval('exercise();true');
  const next=await serviceEval(`testService.setLogPath({logPath:${JSON.stringify(folder(nextRoot))}})`);
  assert.equal(next.result,0,JSON.stringify(next));
  const first=fs.readFileSync(logfile(initRoot),'utf8'); assert.match(first,/new local stream|closeImpl/);
  await mediaEval('exercise();flushLog()');const second=fs.readFileSync(logfile(nextRoot),'utf8');assert.match(second,/new local stream|closeImpl/);
  fs.mkdirSync(path.dirname(folder(invalidRoot)),{mode:0o700});fs.symlinkSync(folder(initRoot),folder(invalidRoot));
  const failed=await serviceEval(`testService.setLogPath({logPath:${JSON.stringify(folder(invalidRoot))}})`);assert.notEqual(failed.result,0,'linked destination accepted');
  await mediaEval('exercise();flushLog()');const after=fs.readFileSync(logfile(nextRoot),'utf8');assert(after.length>second.length);assert.equal(fs.readFileSync(logfile(initRoot),'utf8'),first);
  assert(![first,after].some(text=>text.includes('QA_NONPERSISTENT_MARKER')||text.includes('QA_NO_ACCOUNT')));
  assert.equal(fs.statSync(logfile(initRoot)).mode&0o777,0o600);assert.equal(fs.statSync(logfile(nextRoot)).mode&0o777,0o600);
  receipts.log={command:1046,firstBytes:Buffer.byteLength(first),secondBytes:Buffer.byteLength(second),afterFailedRotationBytes:Buffer.byteLength(after),oldUnchanged:true,invalidDirectoryRefused:true,private:true,source:'actual HRTC createStream/close, no media acquisition',redacted:true};
  async function prompt(id,p2p) {
    await mediaEval(`invite(${JSON.stringify(id)},${p2p})`);
    return until(async()=>{
      const win=BrowserWindow.getAllWindows().find(w=>!w.isDestroyed()&&w.webContents.getURL().includes('/meeting_incoming_invite.html#'));
      if(!win||!win.isVisible())return false;
      const subject=await win.webContents.executeJavaScript(`document.querySelector('#subject')?.textContent`);
      return subject==='合成邀请 '+id && win;
    },'visible invitation '+id);
  }
  async function choose(win,id) {
    const [x,y] = await win.webContents.executeJavaScript(`(()=>{const b=document.getElementById(${JSON.stringify(id)});if(!b||b.disabled)throw Error('Unavailable invitation choice');const r=b.getBoundingClientRect();return [Math.floor(r.x+r.width/2),Math.floor(r.y+r.height/2)]})()`);
    win.focus();win.webContents.sendInputEvent({type:'mouseDown',x,y,button:'left',clickCount:1});
    win.webContents.sendInputEvent({type:'mouseUp',x,y,button:'left',clickCount:1});
    await until(()=>win.isDestroyed(),'close after '+id);
  }
  const firstInvite=await prompt('P2P',true);assert.equal(await firstInvite.webContents.executeJavaScript(`document.querySelector('#heading').textContent`),'来电邀请');
  const snap=await firstInvite.webContents.capturePage();assert(!snap.isEmpty());fs.writeFileSync(path.join(out,'incoming-invitation.png'),snap.toPNG());
  await choose(firstInvite,'accept');await until(async()=>(await mediaEval('decisions.length'))===1,'accept callback');
  const groupInvite=await prompt('MEETING',false);await choose(groupInvite,'decline');await until(async()=>(await mediaEval('decisions.length'))===2,'decline callback');
  const stale=await prompt('WITHDRAWN',true);await mediaEval('withdraw()');await until(()=>stale.isDestroyed(),'withdrawal closes invite');
  const changed=await prompt('CHANGED',false);await mediaEval(`window.inviteID='SUCCESSOR';true`);await choose(changed,'accept');
  const logout=await prompt('LOGOUT',false);await mediaEval('hwCloudMeeting.onLogout()');await until(()=>logout.isDestroyed(),'logout closes invite');
  const ds=await mediaEval('decisions.slice()');assert.deepEqual(ds,[['P2P',0],['MEETING',2]]);
  receipts.invited=ds;receipts.withdrawnNotAnswered=true;receipts.replacedNotAnswered=true;receipts.logoutNotAnswered=true;assert.equal(receipts.permissionRequests,0);
  await mediaEval('endLog()');owner.ready=null;owner.window=null;media.destroy();
  // Retire only the test broker and isolated documents. No real credentials were supplied.
  owner.webToken='';owner.browserTokens.clear();owner.browserInventoryComplete=true;
  await stop();serviceWindow.destroy();receipts.pass=true;
  fs.writeFileSync(path.join(out,'local-media-acceptance.json'),JSON.stringify(receipts,null,2)+'\n');
  console.log('PASS '+JSON.stringify(receipts));
}
const deadline=setTimeout(()=>{console.error('Acceptance deadline exceeded');app.exit(3);},45000);
run().then(()=>{clearTimeout(deadline);app.exit(0);},err=>{clearTimeout(deadline);console.error(err.stack);app.exit(1);});
app.on('quit',()=>fs.rmSync(q,{recursive:true,force:true}));
