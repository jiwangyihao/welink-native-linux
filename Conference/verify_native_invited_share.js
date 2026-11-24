'use strict';
// Focused original-worker race acceptance. The actual HRTC SDK and vendor sagas
// consume locally generated canvas video as an explicit capture-input fixture.
// The real application chooser is opened/cancelled/selected, but its selected
// desktop is NOT captured. No microphone, camera, OS grant, membership or server
// permission is manufactured. AUX_SHARE assertions observe original saga output,
// not claimed network delivery or successful conference publication.
const assert = require('assert').strict;
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  const end = Date.now() + 10000;
  do { const value = await check(); if (value) return value; await pause(20); } while (Date.now() < end);
  throw Error('Invited-share race timed out: ' + label);
}
module.exports = async function verifyInvitedShare({ electron, native, origin, owner, fingerprint }) {
  const { BrowserWindow, ipcMain, desktopCapturer } = electron;
  const channel = 'qa-invited-share-' + crypto.randomUUID(), pending = new Map(), chooserEvents = [];
  const partition = 'qa-invited-share-' + crypto.randomUUID(), session = electron.session.fromPartition(partition);
  session.setCertificateVerifyProc((request, done) => done(request.hostname === '127.0.0.1' &&
    new crypto.X509Certificate(request.certificate.data).fingerprint256 === fingerprint ? 0 : -3));
  let permissionRequests = 0;
  session.setPermissionCheckHandler(() => false);
  session.setPermissionRequestHandler((_contents, _permission, reply) => { permissionRequests++; reply(false); });
  const window = new BrowserWindow({ width: 900, height: 650, show: true,
    webPreferences: { partition, nodeIntegration: true, contextIsolation: false, sandbox: false } });
  const evaluate = code => window.webContents.executeJavaScript(code);
  ipcMain.handle(channel, async (event, message) => {
    assert.equal(event.sender, window.webContents); assert.equal(event.senderFrame, window.webContents.mainFrame);
    if (message.operation === 'cancel') {
      const record = pending.get(message.id);
      if (!record) return { cancelled: false };
      record.controller.abort();
      await record.closed;
      return { cancelled: true };
    }
    assert.equal(message.operation, 'open'); assert.equal(pending.has(message.id), false);
    const controller = new AbortController();
    let closed;
    const record = { controller, closed: new Promise(resolve => { closed = resolve; }) };
    pending.set(message.id, record); chooserEvents.push({ id: message.id, operation: 'open', invited: message.invited });
    try {
      const sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 0, height: 0 } });
      const source = sources.find(value => value.name === window.getTitle()) || sources[0];
      assert(source, 'No actual Xvfb desktop source');
      const id = await owner.options.selectDesktopSource([{ id: source.id, name: source.name, displayId: source.display_id }], { signal: controller.signal });
      chooserEvents.push({ id: message.id, operation: 'selected' });
      return { selected: id };
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      chooserEvents.push({ id: message.id, operation: 'cancelled' });
      return { cancelled: true };
    } finally { pending.delete(message.id); closed(); }
  });
  async function picker() {
    return until(() => BrowserWindow.getAllWindows().find(value => value !== window && !value.isDestroyed() &&
      value.isVisible() && value.webContents.getURL().includes('/meeting_picker.html')), 'real source chooser');
  }
  async function selectPicker(value) {
    await until(() => value.webContents.executeJavaScript(`!document.getElementById('sources').disabled`), 'populated genuine source list');
    const source = await value.webContents.executeJavaScript(`(() => {const r=document.getElementById('sources').getBoundingClientRect();return{x:Math.round(r.x+30),y:Math.round(r.y+20)};})()`);
    for (const type of ['mouseDown', 'mouseUp']) value.webContents.sendInputEvent({ type, ...source, button: 'left', clickCount: 1 });
    await until(() => value.webContents.executeJavaScript(`!document.getElementById('share').disabled`), 'user source selection enables Share');
    const point = await value.webContents.executeJavaScript(`(() => {
      const button = document.getElementById('share');
      if (!button) throw Error('No genuine source choice'); const r = button.getBoundingClientRect();
      return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};
    })()`);
    for (const type of ['mouseDown', 'mouseUp']) value.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
    await until(() => value.isDestroyed(), 'source choice closes picker');
  }
  try {
    await window.loadURL(origin + '/webrtc/#/login');
    await evaluate(fs.readFileSync(path.join(native, 'meeting_invited_share.js'), 'utf8') + '\n;true');
    await evaluate(`(async () => {
      let load; webpackChunkweb_rtc.push([['qa-invitation-races'],{},r => { load=r; }]); await load.e(12);
      const application=load(36176), actions=load(2500), conf=load(65113), c=load(62467), selectors=load(53765), effects=load(14573), sdk=load(91012);
      if(sdk.VERSION!=='1.10.96') throw Error('Wrong actual HRTC');
      if(await sdk.checkSystemRequirements()!==true)throw Error('Actual HRTC system requirements failed');
      const ipc=require('electron').ipcRenderer, channel=${JSON.stringify(channel)}, store=application.store;
      const test=window.invitedShareTest={enabled:true,captures:0,created:[],inputs:[],packets:[],pending:null,initializations:0,errors:[]};
      const run=(fn,...args)=>application.sagaMiddleware.run(fn,...args).toPromise();
      const guard=window.__welinkCreateInvitedShareGuard({vendor:{store,constants:c},actions,isEnabled:()=>test.enabled,
        cancelPicker:id=>ipc.invoke(channel,{operation:'cancel',id}),
        async stopStream(stream){if(selectors.selectRtc(store.getState()).localAuxStream===stream)await run(load(55375).stopAuxStreamImpl);else await stream.close();}});
      test.guard=guard;
      const genuineDisplay=navigator.mediaDevices.getDisplayMedia;
      navigator.mediaDevices.getDisplayMedia=()=>{test.captures++;try{return Promise.resolve(guard.capture(async invitationId=>{
        const id=invitationId||crypto.randomUUID(), canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;
        canvas.getContext('2d').fillRect(0,0,320,180);const media=canvas.captureStream(10);test.inputs.push(media);
        let release;const hold=new Promise(resolve=>{release=resolve;});
        test.pending={id,invited:!!invitationId,release,media};
        const choice=await ipc.invoke(channel,{operation:'open',id,invited:!!invitationId});
        test.pending.choice=choice;
        if(choice.cancelled)await hold;
        return media;
      })).catch(error=>{test.errors.push({stage:'capture-input',code:error.code,message:error.message});throw error;});}catch(error){test.errors.push({stage:'capture-entry',code:error.code,message:error.message});throw error;}};
      const binding=Object.create(sdk,{createStream:{value:function(...args){
        const stream=sdk.createStream(...args);
        if(args[0]?.screen){
          test.created.push(stream);
          const initialize=stream.initialize;
          stream.initialize=function(...values){const result=initialize.apply(this,values);Promise.resolve(result).then(()=>{test.initializations++;},error=>{test.errors.push({code:error.code,message:error.message});});return result;};
          guard.guardStream(stream,null);
        }
        return stream;
      }}});
      store.dispatch(conf.setHrtc(binding));
      const watch=application.sagaMiddleware.run(function*(){for(;;){const action=yield effects.take(conf.confWebsocketSend().type);test.packets.push(action.payload);}});
      test.accept=()=>store.dispatch(actions.answerInviteShare(c.INVITE_SHARE_ANSWER.AGREE));
      test.manual=()=>store.dispatch(actions.onStartAuxStreamImpl({forceShare:false,needSendInviteOpenShareToCms:false}));
      test.disable=async()=>{test.enabled=false;return guard.revoke();};
      test.enable=()=>{test.enabled=true;};
      test.release=()=>{test.pending.release();return true;};
      test.shared=()=>test.packets.filter(value=>value?.type==='AUX_SHARE'&&Number(JSON.parse(value.data).isShare)===Number(c.AUX_SHARE_VALUE.SHARE)).length;
      test.stopped=()=>test.packets.filter(value=>value?.type==='AUX_SHARE'&&Number(JSON.parse(value.data).isShare)===Number(c.AUX_SHARE_VALUE.CLOSE_SHARE)).length;
      test.publishCheck=stream=>{try{guard.assertPublish(stream);return 'allowed';}catch(error){return error.code;}};
      test.hostStop=()=>run(load(12707).viewService.onShareByCMS,false);
      test.dispose=async()=>{watch.cancel();await guard.dispose();navigator.mediaDevices.getDisplayMedia=genuineDisplay;for(const input of test.inputs)for(const track of input.getTracks())track.stop();};
      return true;
    })()`);
    await evaluate('invitedShareTest.disable()');
    const before = await evaluate(`(()=>{try{invitedShareTest.accept();return 'accepted';}catch(error){return error.code;}})()`);
    assert.equal(before, 'NATIVE_CAPABILITY_DISABLED');
    assert.equal(await evaluate('invitedShareTest.captures'), 0); assert.equal(await evaluate('invitedShareTest.shared()'), 0);
    await evaluate('invitedShareTest.enable();invitedShareTest.accept();true');
    let firstPicker;
    try { firstPicker = await picker(); }
    catch (error) {
      console.error('INVITED_START_DIAGNOSTIC', await evaluate(`JSON.stringify({captures:invitedShareTest.captures,created:invitedShareTest.created.length,initializations:invitedShareTest.initializations,errors:invitedShareTest.errors,pending:!!invitedShareTest.pending,packets:invitedShareTest.packets.map(value=>value?.type)})`));
      throw error;
    }
    const firstId = await evaluate('invitedShareTest.pending.id');
    assert.equal(await evaluate('invitedShareTest.pending.invited'), true, 'Original invitation worker lost capture ownership');
    const revoked = await evaluate('invitedShareTest.disable()');
    assert.equal(revoked.cancelledStarts, 1);
    await until(() => firstPicker.isDestroyed(), 'revocation closes actual pending chooser');
    assert.equal(await evaluate('invitedShareTest.shared()'), 0);
    assert.equal(await evaluate('invitedShareTest.publishCheck(invitedShareTest.created[0])'), 'NATIVE_CAPABILITY_DISABLED');
    await evaluate('invitedShareTest.release()');
    await until(() => evaluate(`invitedShareTest.inputs[0].getVideoTracks()[0].readyState==='ended' && !invitedShareTest.guard.capturePending()`), 'late media is stopped and original initialization retires');
    assert.equal(await evaluate('invitedShareTest.shared()'), 0, 'Revoked original worker sent SHARE');
    // A subsequent ordinary start is not an invitation and remains usable even
    // while type1 is disabled; the stale ID cannot cancel its real source picker.
    await evaluate('invitedShareTest.manual();true');
    const manualPicker = await picker();
    const manualId = await evaluate('invitedShareTest.pending.id');
    assert.notEqual(manualId, firstId); assert.equal(await evaluate('invitedShareTest.pending.invited'), false);
    assert.equal(await evaluate(`require('electron').ipcRenderer.invoke(${JSON.stringify(channel)},{operation:'cancel',id:${JSON.stringify(firstId)}}).then(value=>value.cancelled)`), false);
    assert.equal(manualPicker.isDestroyed(), false);
    await selectPicker(manualPicker);
    await until(() => evaluate('invitedShareTest.shared()===1'), 'manual original worker sends SHARE');
    assert.equal(await evaluate('invitedShareTest.publishCheck(invitedShareTest.created[1])'), 'allowed');
    assert.equal(await evaluate('invitedShareTest.inputs[1].getVideoTracks()[0].readyState'), 'live');
    await evaluate('invitedShareTest.hostStop()');
    await until(() => evaluate(`invitedShareTest.inputs[1].getVideoTracks()[0].readyState==='ended' && invitedShareTest.stopped()>0`), 'host stop closes actual manual stream');
    await evaluate('invitedShareTest.dispose()');
    assert.equal(permissionRequests, 0, 'The generated local input requested a device grant');
    return { originalWorker: 'main.3ee85ed7.js:55375', actualSdk: 'HRTC 1.10.96', input: 'generated-local-canvas-video-not-desktop',
      disabledBeforeAccept: { captures: 0, shareRequests: 0 }, pendingInvitationCancelled: true,
      realChooserCancelled: true, lateTrackEnded: true, publicationRejected: true,
      manualSharePreserved: true, staleCancellationIsolated: true, hostStopPreserved: true, permissionRequests, chooserEvents };
  } finally {
    for (const record of pending.values()) record.controller.abort();
    if (!window.isDestroyed()) window.destroy(); ipcMain.removeHandler(channel);
  }
};
