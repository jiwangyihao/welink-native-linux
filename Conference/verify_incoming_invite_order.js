#!/usr/bin/env electron
'use strict';

// Deliver synthetic notifications at the verified vendor's decoded CMS boundary.
// The original sagas, Redux store, Electron preload, main broker and prompts run unchanged.
// No network login, actual telephone, media permissions or production meeting.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const electron = require('electron');
const { app, BrowserWindow } = electron;
const native = process.env.WELINK_TEST_NATIVE, www = process.env.WELINK_TEST_WWW;
if (![native, www].every(p => p && path.isAbsolute(p))) throw Error('Set WELINK_TEST_NATIVE and WELINK_TEST_WWW');
const { MeetingNativeWeb } = require(path.join(native, 'meeting_native_web'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-incoming-order-'));
const origin = 'https://meeting.invalid';
app.setPath('userData', profile);
app.on('window-all-closed', () => {});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, label) {
  const deadline = Date.now() + 6000;
  do { const value = await test(); if (value) return value; await delay(20); } while (Date.now() < deadline);
  throw Error('Did not observe ' + label);
}
const authRequests = [];
const heldAuthReplies = [], exchangedNonces = [];
function serveAssets(session) {
  const mime = {'.js':'application/javascript', '.css':'text/css', '.html':'text/html'};
  session.protocol.interceptBufferProtocol('https', (request, reply) => {
    const u = new URL(request.url);
    if (u.origin === origin && u.pathname === '/v1/usg/acs/auth/skipnonce') {
      authRequests.push(request.method);
      if (request.method === 'POST') { heldAuthReplies.push(reply); return; }
      if (request.method === 'GET') exchangedNonces.push(u.searchParams.get('skipNonce'));
      return reply({statusCode:403, mimeType:'application/json', data:Buffer.from('{"error_code":"QA.REFUSED","error_msg":"Isolated admission refusal"}')});
    }
    if (u.origin !== origin || request.method !== 'GET' || !u.pathname.startsWith('/webrtc/')) return reply({error:-10});
    const file = path.resolve(www, u.pathname.slice(8) || 'index.html');
    if (!file.startsWith(www + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return reply({error:-6});
    reply({mimeType:mime[path.extname(file)] || 'application/octet-stream', data:fs.readFileSync(file)});
  });
}
async function main() {
  await app.whenReady();
  app.on('session-created', serveAssets);
  let mediaPrompts = 0, joins = 0;
  const records = [];
  const owner = new MeetingNativeWeb({electron, origin, requestPermission:async () => { ++mediaPrompts; return false; },
    getManagementConfig:async () => ({server:'meeting.invalid', port:443, userAgent:'IsolatedP2P', deviceId:'qa'}),
    getCallContext:async () => ({self:{number:'999000001', name:'Local QA', thirdUserId:'local-qa-account'}})});
  owner.on('event', e => {
    if (e.event === 'meeting-lifecycle' && e.data?.state === 'joined') ++joins;
    if (e.event === 'p2p-native-notify' && e.data?.notify === 33) records.push(e.data);
  });
  await owner.execute('initialize');
  const view = owner.window.webContents;
  const evaluate = code => view.executeJavaScript(code);
  await evaluate(`(() => {
    let load; window.webpackChunkweb_rtc.push([['qa-invite-order'],{},r=>{load=r}]);
    const app=load(36176), constants=load(62467), selectors=load(53765), router=load(51361);
    const action=constants.CONF_MSG_TYPE.LOCAL_CONTROL, type=constants.LOCAL_NOTIFY_TYPE.INVITE_TO_JOIN;
    window.testIncoming=(conferenceID,optType,subject) => app.sagaMiddleware.run(router.handleConfWsMessage,
      router.confWsHandler[action],{action,type,sequence:crypto.randomUUID(),data:JSON.stringify({conferenceID,optType,subject,p2p:1,mediaType:'Voice'})}).toPromise();
    window.testPending=()=>{const s=app.store.getState();return selectors.selectIsJoiningConf(s)?selectors.selectInviteToJoinInfo(s)?.conferenceID:null};
    window.testAnswerState=()=>{const s=app.store.getState();return {joining:selectors.selectIsInviteJoining(s),id:window.testPending()};};
    return window.hwCloudMeeting.onLogin({token:'loopback-only-incoming-account'});
  })()`);
  const prompt = () => BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && w.webContents.getURL().includes('/meeting_incoming_invite.html#'));
  const send = (id, kind, subject) => evaluate(`testIncoming(${JSON.stringify(id)},${kind},${JSON.stringify(subject)})`);
  const shown = async (id, subject) => {
    const win = await until(() => { const w = prompt(); return w?.isVisible() && w; }, 'the incoming-call window');
    assert.equal(await evaluate('testPending()'), id);
    assert.equal(await win.webContents.executeJavaScript('document.querySelector("#subject").textContent'), subject);
    assert.equal(await win.webContents.executeJavaScript('document.querySelector("#accept").disabled'), false);
    return win;
  };
  const a = '900000301', b = '900000302';
  await send(a, 0, 'First local invitation'); await shown(a, 'First local invitation');
  await send(a, 1, 'First local invitation'); await until(() => !prompt(), 'first withdrawal');
  await send(b, 0, 'Second local invitation'); const second = await shown(b, 'Second local invitation');
  await send(a, 1, 'First local invitation');
  assert.equal(await evaluate('testPending()'), b, 'A stale withdrawal cleared the newer pending invitation');
  assert.equal((await shown(b, 'Second local invitation')).id, second.id, 'A stale withdrawal replaced the newer prompt');
  await send(b, 1, 'Second local invitation'); await until(() => !prompt(), 'matching withdrawal');
  assert.equal(await evaluate('testPending()'), null); assert.equal(joins, 0); assert.equal(mediaPrompts, 0);
  assert.equal(records.length, 2);
  for (const {param} of records) {
    assert.equal(param.isCallOut, false);
    assert.equal(param.isCallEstablished, false);
    assert.equal('resultCode' in param, false, 'FINISH_INVITE has no known numeric terminal reason');
    assert.deepEqual(param.callerInfo, {number:'', nickname:'', thirdUserId:''});
    assert.equal(param.calleeInfo.number, '999000001');
  }
  await send(a, 0, 'Late duplicate invitation');
  await send(a, 1, 'Late duplicate withdrawal');
  assert.equal(records.length, 2);
  assert.equal(prompt(), undefined);
  async function accept(id) {
    const win = await shown(id, 'Incoming ' + id);
    win.focus();
    const point = await win.webContents.executeJavaScript(`(()=>{const b=document.getElementById('accept'),r=b.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
    for (const type of ['mouseDown','mouseUp']) win.webContents.sendInputEvent({type,...point,button:'left',clickCount:1});
    await until(() => !prompt(), 'the accepted prompt to close');
  }
  const c = '900000303', d = '900000304';
  await send(c,0,'Incoming '+c); await accept(c);
  await send(c,1,'Incoming '+c); await send(d,0,'Incoming '+d); await shown(d,'Incoming '+d);
  // The pinned provider delays accepted admission by 1500ms. Cross that delay
  // while the replacement prompt is live, without clicking anything in it.
  await delay(2000);
  assert.deepEqual(authRequests, [], 'The old answer started authentication for the replacement');
  assert.equal((await evaluate('testAnswerState()')).joining, false, 'The old answer marked the replacement as accepted');
  assert.equal(await evaluate('testPending()'), d);
  await accept(d);
  await until(() => authRequests.length, 'actual provider authentication after independently accepting the replacement');
  assert.deepEqual(authRequests, ['POST']);
  // The first authentication step is on the wire. Withdraw it before giving
  // the provider a real HTTP response. Only a newly accepted invite may exchange a nonce.
  const e = '900000305';
  await send(d,1,'Incoming '+d);
  assert.equal((await evaluate('testAnswerState()')).joining, false, 'Withdrawal left a pending admission');
  const previouslySent = authRequests.length;
  const succeed = (reply,nonce) => reply({statusCode:200,mimeType:'application/json',data:Buffer.from(JSON.stringify({nonce}))});
  succeed(heldAuthReplies.shift(),'retired-invitation');
  await send(e,0,'Incoming '+e); await shown(e,'Incoming '+e);
  assert.equal(authRequests.length,previouslySent,'A withdrawn invitation exchanged its nonce');
  assert.equal((await evaluate('testAnswerState()')).joining, false, 'The replacement inherited the withdrawn join flag');
  await accept(e);
  await until(() => heldAuthReplies.length, 'second explicitly authorised POST');
  succeed(heldAuthReplies.shift(),'current-invitation');
  await until(() => exchangedNonces.includes('current-invitation'), 'current invitation nonce exchange');
  assert.deepEqual(exchangedNonces,['current-invitation']);
  assert.deepEqual(authRequests,['POST','POST','GET']);
  assert.equal(joins,0,'dispatching an answer must not report a joined room');
  assert.equal(records.length, 4, 'Each withdrawn incoming attempt has one terminal record');
  assert(records.every(frame => frame.param.isCallOut === false && frame.param.isCallEstablished === false));
  await evaluate('window.hwCloudMeeting.onLogout()');
  console.log('INCOMING_ORDER ' + JSON.stringify({staleWithdrawalIgnored:true, samePrompt:true, matchingWithdrawalClosed:true,
    staleAcceptanceDispatched:false, explicitAcceptanceTarget:d, lateAuthenticationIgnored:true,
    terminalRecords:records.length, unknownWithdrawalReasonPreserved:true, joins, mediaPrompts}));
}
const timer = setTimeout(() => { console.error('Incoming invitation test deadline'); app.exit(2); }, 60000);
main().then(() => { clearTimeout(timer); app.exit(0); }, err => { clearTimeout(timer); console.error(err.stack || err); app.exit(1); });
app.once('quit', () => fs.rmSync(profile, {recursive:true, force:true}));
