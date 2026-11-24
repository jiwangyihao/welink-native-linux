#!/usr/bin/env electron
'use strict';
// Native window acceptance, not a call-admission test. Membership comes from
// a local fixture; geometry, stacking, renderer, video track and WM are real.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { app, BrowserWindow, screen } = require('electron');
const { P2pMiniWindow } = require(path.join(process.env.WELINK_TEST_NATIVE, 'meeting_p2p_mini'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-mini-'));
app.setPath('userData', path.join(tmp,'profile'));
app.on('window-all-closed', () => {});
const sleep = ms => new Promise(done => setTimeout(done,ms));
async function until(test, label) {
  const end = Date.now()+4000;
  while(Date.now()<end){if(await test())return;await sleep(25);}
  throw Error(label);
}
async function run() {
  await app.whenReady();
  const w = new BrowserWindow({show:false, width:920, height:600, x:70, y:70,
    webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  const other = new BrowserWindow({show:false,width:750,height:455,webPreferences:{sandbox:true}});
  try {
    await w.loadURL('data:text/html,<meta charset=utf-8><canvas width=320 height=180></canvas><video autoplay muted playsinline></video>');
    await other.loadURL('about:blank');other.show();w.show();
    const evalPage = code => w.webContents.executeJavaScript(code);
    await evalPage(`(async()=>{const c=document.querySelector('canvas'),g=c.getContext('2d'),video=document.querySelector('video');let n=0;
      setInterval(()=>{g.fillStyle=n++%2?'red':'blue';g.fillRect(0,0,c.width,c.height)},30);
      video.srcObject=c.captureStream(20);await video.play();return true;})()`);
    const id=w.getNativeWindowHandle().toString('hex'), normal=w.getBounds(), otherBounds=other.getBounds();
    const media={joined:true,conferenceId:'local-room'};
    let call={kind:'p2p',pending:true,peerEstablished:true,attemptId:'fixture-call',conferenceID:media.conferenceId};
    const bridge={electron:{screen},window:w,ready:true,origin:'https://fixture.invalid',mediaOrigin:'https://fixture.invalid',
      disposed:false,retiring:false,loggingOut:false,watermarkApproved:true,uiApproved:true,policyPending:new Set(),
      lastMediaState:media,p2p:{state:()=>call}};
    const mini=new P2pMiniWindow(bridge);
    await assert.rejects(mini.toggle('another-call'),{code:'P2P_MINI_UNAVAILABLE'});
    call.peerEstablished=false; await assert.rejects(mini.toggle(call.attemptId),{code:'P2P_MINI_UNAVAILABLE'});call.peerEstablished=true;
    media.conferenceId='other-room';assert.equal(mini.eligible(),false);media.conferenceId=call.conferenceID;
    const before=await evalPage(`(()=>{const v=document.querySelector('video');return {time:v.currentTime,track:v.srcObject.getVideoTracks()[0].id};})()`);
    const small=await mini.toggle(call.attemptId);assert(small.compact&&w.isAlwaysOnTop());
    assert(small.bounds.width<normal.width&&small.bounds.height<normal.height);assert.deepEqual(w.getBounds(),small.bounds);
    assert.equal(w.getNativeWindowHandle().toString('hex'),id);assert.deepEqual(other.getBounds(),otherBounds);
    await until(()=>evalPage(`document.querySelector('video').currentTime>${before.time}+0.05`),'video stopped during resize');
    assert.equal(await evalPage(`document.querySelector('video').srcObject.getVideoTracks()[0].id`),before.track);
    const restored=await mini.toggle(call.attemptId);assert.equal(restored.compact,false);assert.deepEqual(w.getBounds(),normal);
    await mini.toggle(call.attemptId);const disabled=await mini.configure(false);assert.equal(disabled.active,false);assert.equal(disabled.enabled,false);
    assert.equal(w.isAlwaysOnTop(),false);assert.deepEqual(w.getBounds(),normal);await assert.rejects(mini.toggle(call.attemptId),{code:'P2P_MINI_UNAVAILABLE'});
    assert.equal((await mini.configure(true)).enabled,true);await mini.toggle(call.attemptId);
    call={...call,pending:false,peerEstablished:false};mini.reconcile();await until(()=>!w.isAlwaysOnTop()&&w.getBounds().width===normal.width,'terminal call did not restore window');
    assert.equal(mini.eligible(),false);assert.deepEqual(other.getBounds(),otherBounds);
    console.log('P2P_MINI '+JSON.stringify({normal:[normal.width,normal.height],compact:[small.bounds.width,small.bounds.height],
      sameNativeWindow:true,sameLiveVideoTrack:true,wrongCallDenied:true,disabledRestores:true,hangupRestores:true}));
  } finally { other.destroy();w.destroy(); }
}
const deadline=setTimeout(()=>{console.error('Native compact window deadline');app.exit(2)},24000);
run().then(()=>{clearTimeout(deadline);app.exit(0)},err=>{console.error(err.stack||err);app.exit(1)});
app.once('quit',()=>fs.rmSync(tmp,{recursive:true,force:true}));
