#!/usr/bin/env electron
'use strict';
// Two release dial controls and the release service/renderer/main bridge. The
// campus dispatcher, authenticated test identity and TLS servers are local fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { X509Certificate } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const electron = require('electron');
const { app, BrowserWindow, ipcMain } = electron;
const { Fixture, provision, deferred, observed, ctdParams, TOKEN } = require('./verify_meeting_management');
const native = process.env.WELINK_TEST_NATIVE;
if (!native || !path.isAbsolute(native)) throw Error('An absolute packaged native directory is required');
const { MeetingNativeWeb, PROTOCOL } = require(path.join(native, 'meeting_native_web'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-dial-window-'));
app.setPath('userData', path.join(root, 'profile'));
app.on('window-all-closed', () => {});
const run = (win, code) => win.webContents.executeJavaScript(code);
const json = JSON.stringify;
async function openPage(name, html, show) {
  const file = path.join(root, name + '.html');
  fs.writeFileSync(file, '<!doctype html><meta charset="utf-8">' + html);
  const win = new BrowserWindow({ show, width: 640, height: 420, useContentSize: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: false } });
  await win.loadFile(file);
  return win;
}
function waitText(win, selector, phrase) {
  return run(win, `new Promise((resolve,reject)=>{
    const find=()=>{const node=document.querySelector(${json(selector)});if(node?.textContent.includes(${json(phrase)})){observer.disconnect();clearTimeout(timer);resolve(node.textContent)}};
    const observer=new MutationObserver(find); const timer=setTimeout(()=>{observer.disconnect();reject(Error('Missing dial status: '+document.body.innerText))},6000);
    observer.observe(document.body,{childList:true,subtree:true,characterData:true});find();})`);
}
async function main() {
  await app.whenReady();
  const certs = provision(root), fixture = new Fixture(certs);
  await fixture.start();
  const bridge = new MeetingNativeWeb({ electron, origin: fixture.origin, getAccessToken: async () => TOKEN,
    getManagementConfig: async () => fixture.config() });
  const fingerprint = new X509Certificate(certs.cert).fingerprint256;
  (await bridge.initializeAccountSession()).setCertificateVerifyProc((req, done) => done(
    req.hostname === '127.0.0.1' && new X509Certificate(req.certificate.data).fingerprint256 === fingerprint ? 0 : -3));
  const wins = [];
  try {
    const svc = await openPage('service', '<title>Local conference service</title><body></body>', false); wins.push(svc);
    const logs = path.join(root, 'logs'); fs.mkdirSync(path.join(logs, 'conference'), { recursive: true });
    const config = { compassUrlEnable: true, compassUrl: fixture.origin };
    const environment = { ffiPath: path.join(path.dirname(native), 'libraries/node_extends/node-ffi/ffi-napi') };
    await run(svc, `window.nativeNotifications=[];window.notifyJsTupCallback=msg=>window.nativeNotifications.push(msg);
      const pedestal={logRootPath:${json(logs)},appdataRootPath:${json(root)},callMethod:async m=>{
        switch(m){case 'method://pedestal/getLogStoragePath':return ${json(logs)};case 'method://pedestal/getEnvInfo':return ${json(environment)};
        case 'method://pedestal/getProxyInfo':return {};default:throw Error('Unexpected campus method '+m)}}};
      window.service=require(${json(path.join(native,'meeting_service'))}).createService({window,Pedestal:pedestal,sdk:{},getStore:()=>({getStore:k=>k===undefined?${json(config)}:undefined})});true`);
    const channel = 'welink-native-meeting-v1';
    ipcMain.handle(channel, (event, envelope) => {
      assert.equal(event.sender, svc.webContents); assert.equal(event.senderFrame, svc.webContents.mainFrame);
      if (envelope.kind === 'register') { assert.equal(envelope.origin, fixture.origin); return { protocol: PROTOCOL, instance: bridge.instance, origin: fixture.origin }; }
      assert.equal(envelope.kind, 'call'); return bridge.handle(envelope.message);
    });
    const prepare = await run(svc, 'service.prepareInvitationResolver()'); assert.equal(prepare.ok, true, 'actual renderer registration failed');
    const control = pathToFileURL(path.join(native, 'meeting_dial.js')).href;
    const css = pathToFileURL(path.join(path.dirname(native), 'plugin/callRecord/dist/css/keypad.css')).href;
    const html = `<title>Local callback test</title><link rel="stylesheet" href="${css}"><body><script>window.language={KEYPAD:'Keypad'};window.Pedestal={callMethod:(m,p)=>require('electron').ipcRenderer.invoke('qa-dial',m,p)};</script><script src="${control}"></script></body>`;
    const one = await openPage('one', html, true), two = await openPage('two', html, true); wins.push(one, two);
    ipcMain.handle('qa-dial', (event, method, p) => {
      assert([one.webContents,two.webContents].includes(event.sender));
      const name = method.slice('method://conference/'.length);
      if (name === 'startCall') return run(svc, `service.startCtdCall(${json({ caller_number: ctdParams.caller_number, callee_number: p.calleeNum, callRequestId: p.callRequestId })})`);
      assert(['getPendingCall','cancelPendingCall'].includes(name));
      return run(svc, `service[${json(name)}](${json(p)})`);
    });
    const dial = `window.dialResult=window.__welinkStartDial({calleeNum:${json(ctdParams.callee_number)},isVideo:false});true`;
    fixture.mode = 'held'; const request = fixture.creationNotice = deferred();
    const endSeen = deferred(), releaseEnd = deferred(), http = fixture.http.bind(fixture);
    fixture.http = async (req,res) => {
      if (req.method === 'DELETE') { endSeen.resolve(new URL(req.url, fixture.origin)); await releaseEnd.promise; }
      return http(req,res);
    };
    await run(one, dial); const creation = await observed(request.promise,'call from the first window');
    await waitText(one, '[role=status]', 'waiting for service confirmation');
    await run(two,dial); assert.equal(await run(two,'window.dialResult'),false);
    await waitText(two,'[role=alert]','Another call request is still pending');
    assert.equal(await run(two,'!!document.querySelector("[role=status] button")'),false);
    one.focus(); const xy = await run(one, `(()=>{const el=document.querySelector('[role=status] button');if(!el||el.disabled)throw Error('No actionable cancel button');const r=el.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    for (const type of ['mouseDown','mouseUp']) one.webContents.sendInputEvent({type,...xy,button:'left',clickCount:1});
    await waitText(one,'[role=status]','Cancellation requested. Waiting for the original call result');
    assert.equal(fixture.httpRecords.length,0);
    const exactID='900000099'; creation.reply({ returnCode:0, data:[{conferenceID:exactID,subject:'Local delayed callback'}] });
    const url=await observed(endSeen.promise,'correlated HTTP end'); assert.equal(url.searchParams.get('conferenceID'),exactID); assert.equal(url.searchParams.get('type'),'1');
    await waitText(one,'[role=status]','Requesting that this call be ended'); assert.equal(await run(one,'!!document.querySelector("[role=alert]")'),false);
    releaseEnd.resolve(); assert.equal(await run(one,'window.dialResult'),false);
    const finalText=await waitText(one,'[role=alert]','The service confirmed this call was ended.');
    const screenshot=await one.webContents.capturePage(); assert(!screenshot.isEmpty());
    assert.equal(fixture.records.length,1); assert.equal(fixture.httpRecords.filter(r=>r.method==='DELETE').length,1); fixture.check();
    console.log('DIAL_WINDOW '+json({creates:fixture.records.length,ends:1,endedMeeting:exactID,secondWindowRefused:true,confirmedOnlyAfterEndReply:true,finalText,window:screenshot.getSize()}));
  } finally {
    for(const win of wins) if(!win.isDestroyed()) win.destroy();
    ipcMain.removeHandler('qa-dial'); ipcMain.removeHandler('welink-native-meeting-v1');
    await bridge.execute('dispose'); await fixture.stop();
  }
}
const timer=setTimeout(()=>{console.error('Dial window deadline');app.exit(2);},45000);
main().then(()=>{clearTimeout(timer);app.exit(0);},e=>{clearTimeout(timer);console.error(e.stack||e);app.exit(1);});
app.once('quit',()=>fs.rmSync(root,{recursive:true,force:true}));
