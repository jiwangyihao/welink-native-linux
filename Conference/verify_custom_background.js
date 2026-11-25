'use strict';
/* Isolated QA only: use NativeBuild/validation/run_meeting_regressions.py with
 * a fresh profile and private Xvfb/network namespace, keeping the sandbox ON.
 * Packaged Electron needs a staged MAIN entrypoint, not a script pathname.
 * The retained software-rendering run used --use-gl=angle --use-angle=swiftshader
 * --disable-dev-shm-usage --disable-gpu-memory-buffer-video-frames. Set these
 * before app readiness; a canvas source still needs working capture/encoding.
 * QA fixture only, NOT an app/package asset:
 *   https://raw.githubusercontent.com/scikit-image/scikit-image/v0.24.0/skimage/data/astronaut.png
 *   SHA256 88431cd9653ccd539741b555fb0a46b61558b301d4110412b5bc28b5e3ea6cb5
 * NASA photograph of Eileen Collins, public domain, as documented at
 * https://scikit-image.org/docs/stable/api/skimage.data.html#skimage.data.astronaut
 *
 * This is a real local transport, not a simulated provider acknowledgement.
 * HRTC's LocalStream.replaceTrack/removeTrack stop/update real browser tracks;
 * its publish callback binds those exact tracks to real RTCRtpSenders. Two
 * RTCPeerConnections with no ICE servers encode, send, receive and decode them.
 * Assertions sample the RECIPIENT video, never the compositor's preview.
 * Provider authorization is not claimed by this isolated local fixture test.
 */
const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const backgroundHost = require('./meeting_custom_background_host');
const FIXTURE_SHA256 = '88431cd9653ccd539741b555fb0a46b61558b301d4110412b5bc28b5e3ea6cb5';

async function verifyCustomBackground({ electron, native = __dirname,
  personFixture = '/tmp/welink-custom-background-qa/astronaut.png' } = {}) {
  if (!electron?.BrowserWindow) throw Error('This verifier requires Electron MAIN, not Node');
  const fixture = fs.readFileSync(personFixture);
  assert.equal(crypto.createHash('sha256').update(fixture).digest('hex'), FIXTURE_SHA256,
    'Use the pinned, approved public-domain NASA fixture, never a private photograph');
  assert.deepEqual(backgroundHost.imageHeader(fixture), { mime: 'image/png', width: 512, height: 512 });
  assert.throws(() => backgroundHost.imageHeader(Buffer.from('<svg onload="fetch()"></svg>')), /PNG or JPEG|static PNG/);
  const bomb = Buffer.from(fixture); bomb.writeUInt32BE(65535, 16);
  assert.throws(() => backgroundHost.imageHeader(bomb), /dimensions/);
  const assets = await backgroundHost.loadAssets();
  const sdkSource = fs.readFileSync(path.join(native, 'vendor', 'hrtc-12.eb3d2838.js'), 'utf8');
  const source = fs.readFileSync(path.join(native, 'meeting_custom_background.js'), 'utf8');
  const server = http.createServer((request, response) => {
    if (request.url !== '/') { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><meta charset="utf-8"><title>Local custom-background QA</title>' +
      '<h1>Local recipient — public-domain NASA fixture only</h1><p>No meeting account, camera or microphone is used.</p>' +
      '<div id="recipient"></div>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const session = electron.session.fromPartition('qa-custom-background-' + crypto.randomUUID());
  const blockedRequests = [];
  let permissionRequests = 0;
  session.setPermissionCheckHandler(() => false);
  session.setPermissionRequestHandler((_contents, _permission, reply) => { ++permissionRequests; reply(false); });
  session.webRequest.onBeforeRequest((details, done) => {
    const url = new URL(details.url);
    const allowed = url.origin === origin || url.protocol === 'blob:' || url.protocol === 'data:';
    if (!allowed) blockedRequests.push(url.origin); // No paths or credentials retained.
    done({ cancel: !allowed });
  });
  const window = new electron.BrowserWindow({ width: 760, height: 750, show: true,
    webPreferences: { session, nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) console.error('Background QA renderer:', message);
  });
  const evaluate = code => window.webContents.executeJavaScript(code, true);
  let result;
  try {
    await window.loadURL(origin + '/');
    await evaluate(sdkSource + '\n;true');
    await evaluate(source + '\n;true');
    await evaluate(`window.__qaBackgroundAssets=${JSON.stringify(assets)};window.__qaPerson=${JSON.stringify(fixture.toString('base64'))};true`);
    result = await evaluate(`(async () => {
      const assert=(condition,message)=>{if(!condition)throw Error(message);};
      const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
      const until=async(check,label,timeout=25000)=>{const end=performance.now()+timeout;while(performance.now()<end){if(await check())return;await pause(40);}throw Error('Timed out: '+label);};
      const reject=async(work,code)=>{let seen;try{await work();}catch(error){seen=error.code;}assert(seen===code,'Expected '+code+', received '+seen);};
      const module={exports:{}};
      webpackChunkweb_rtc.find(chunk=>chunk[1][91012])[1][91012](module,module.exports,{g:globalThis});
      const sdk=module.exports;
      assert(sdk.VERSION==='1.10.96','Wrong HRTC ABI');
      const decoded=Uint8Array.from(atob(window.__qaPerson),c=>c.charCodeAt(0));
      const person=await createImageBitmap(new Blob([decoded],{type:'image/png'}));
      delete window.__qaPerson;
      const camera=document.createElement('canvas');camera.width=512;camera.height=512;
      const cameraContext=camera.getContext('2d');let phase=0,draws=0;
      const draw=()=>{cameraContext.drawImage(person,0,0,512,512);if(phase){cameraContext.fillStyle='rgba(25,200,45,0.22)';cameraContext.fillRect(0,0,512,512);}++draws;};
      draw();const drawTimer=setInterval(draw,33), input=camera.captureStream(30), inputTrack=input.getVideoTracks()[0];
      // Explicit generated camera fixture via the public SDK videoSource option.
      // No MediaDevices.getUserMedia call or OS permission is substituted.
      const stream=sdk.createStream({userId:'local-background-qa',videoSource:inputTrack.clone()});
      await stream.initialize();
      assert(stream.getType()==='local'&&!stream.isAuxiliary(),'Not a genuine local camera stream');
      const initialTrack=stream.getVideoTrack(), profileId=stream.getStreamInfo().videoProfiles.find(p=>p.hasTrack).resolutionId;
      const outgoing=new RTCPeerConnection({iceServers:[]}), incoming=new RTCPeerConnection({iceServers:[]});
      const sender=outgoing.addTrack(initialTrack,new MediaStream([initialTrack]));
      const video=document.createElement('video');video.muted=true;video.autoplay=true;video.playsInline=true;
      video.width=512;video.height=512;document.getElementById('recipient').appendChild(video);
      incoming.ontrack=event=>{video.srcObject=new MediaStream([event.track]);video.play().catch(error=>{throw error;});};
      const gather=pc=>pc.iceGatheringState==='complete'?Promise.resolve():new Promise(resolve=>{const changed=()=>{if(pc.iceGatheringState==='complete'){pc.removeEventListener('icegatheringstatechange',changed);resolve();}};pc.addEventListener('icegatheringstatechange',changed);});
      try {
        await outgoing.setLocalDescription(await outgoing.createOffer());await gather(outgoing);
        await incoming.setRemoteDescription(outgoing.localDescription);
        await incoming.setLocalDescription(await incoming.createAnswer());await gather(incoming);
        await outgoing.setRemoteDescription(incoming.localDescription);
        await until(()=>outgoing.connectionState==='connected'&&video.videoWidth===512,'local recipient connected');
      } catch(error) {
        // Report real transport/decode state, not SDP, addresses or a preview.
        // Keep the original connection, width and timeout requirements intact.
        const describe=async pc=>{
          const stats=Array.from((await pc.getStats()).values());
          return {connectionState:pc.connectionState,iceConnectionState:pc.iceConnectionState,
            iceGatheringState:pc.iceGatheringState,
            localCandidates:stats.filter(value=>value.type==='local-candidate').length,
            remoteCandidates:stats.filter(value=>value.type==='remote-candidate').length,
            successfulCandidatePairs:stats.filter(value=>value.type==='candidate-pair'&&value.state==='succeeded').length,
            video:stats.filter(value=>(value.type==='inbound-rtp'||value.type==='outbound-rtp')&&value.kind==='video')
              .map(value=>({type:value.type,bytesSent:value.bytesSent,bytesReceived:value.bytesReceived,
                framesEncoded:value.framesEncoded,framesDecoded:value.framesDecoded}))};
        };
        try {
          error.message+='; '+JSON.stringify({outgoing:await describe(outgoing),incoming:await describe(incoming),
            recipient:{width:video.videoWidth,height:video.videoHeight,readyState:video.readyState,
              error:video.error?.message||null}});
        } catch(diagnosticError) {error.message+='; RTC diagnostics unavailable: '+diagnosticError.message;}
        throw error;
      }
      const notifications=[];
      const transport={
        getSymbol:()=> 'local-loopback-background-recipient',
        getPublishVideoSender:type=>{assert(type==='main','Auxiliary stream was touched');return [sender];},
        async publish(value){assert(value===stream,'Foreign stream publication');const track=value.getVideoTrack(profileId);if(sender.track!==track)await sender.replaceTrack(track||null);},
        mediaStatusChangedNotify(...args){notifications.push({event:'media-state',args});},
        setCameraOperationInfo(...args){notifications.push({event:'camera-operation',args});},
        setCameraCaptureReport(...args){notifications.push({event:'camera-capture',args});}
      };
      stream.addClient(transport);
      let permitted=true,providerAllowed=true,sessionKey='qa-local-owner',joined=true,assetRequests=0;
      const background=window.__welinkInstallCustomBackground({
        host:{customBackgroundAssets:async()=>{++assetRequests;return window.__qaBackgroundAssets;}},
        getLocalStream:()=>stream,getClient:()=>transport,
        getContext:()=>({sessionKey,joined,provider:{allowed:providerAllowed,reason:providerAllowed?null:'BACKGROUND_PROVIDER_FORCED'},
          cameraAllowed:permitted,cameraIntent:!stream.isVideoMuted(),
          cameraOpen:!stream.isVideoMuted()&&stream.getVideoTrack()?.readyState==='live'&&stream.getVideoTrack().enabled})
      });
      const sample=document.createElement('canvas');sample.width=512;sample.height=512;const sampleContext=sample.getContext('2d',{willReadFrequently:true});
      const frames=async(count=4)=>{for(let i=0;i<count;i++)await new Promise((resolve,reject)=>{const id=setTimeout(()=>reject(Error('Recipient frame stalled')),5000);video.requestVideoFrameCallback(()=>{clearTimeout(id);resolve();});});};
      const pixels=()=>{sampleContext.drawImage(video,0,0,512,512);return sampleContext.getImageData(0,0,512,512).data;};
      const difference=(a,b)=>{let total=0;for(let i=0;i<a.length;i+=4)total+=Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])+Math.abs(a[i+2]-b[i+2]);return total/(a.length/4*3);};
      const makeImport=color=>{const image=document.createElement('canvas');image.width=128;image.height=128;const ctx=image.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,128,128);return {sessionKey,revision:background.state().revision,importId:crypto.randomUUID().replaceAll('-',''),mime:'image/png',width:128,height:128,base64:image.toDataURL('image/png').split(',')[1]};};
      const blue=(v,i)=>v[i]<65&&v[i+1]<100&&v[i+2]>170;
      const magenta=(v,i)=>v[i]>170&&v[i+1]<90&&v[i+2]>140;
      window.__qaBackgroundCleanup=async()=>{await background.dispose();stream.removeClient(transport);stream.close();inputTrack.stop();outgoing.close();incoming.close();clearInterval(drawTimer);person.close();video.srcObject=null;delete window.__qaBackgroundAssets;};
      await frames();const baseline=pixels();
      await background.configure(true);
      await background.importImage(makeImport('rgb(15,40,225)'));
      assert(assetRequests===0&&!background.state().activeFrames,'Import started segmentation or claimed active frames');
      assert(sender.track===initialTrack&&initialTrack.readyState==='live','Import replaced the camera');
      providerAllowed=false;
      await reject(()=>background.apply(),'BACKGROUND_PROVIDER_FORCED');
      assert(sender.track===initialTrack,'Forced provider policy changed the sender');
      providerAllowed=true;permitted=false;
      await reject(()=>background.apply(),'BACKGROUND_CAMERA_NOT_PERMITTED');
      assert(sender.track===initialTrack,'Denied camera changed the sender');
      permitted=true;stream.muteVideo();
      await reject(()=>background.apply(),'BACKGROUND_CAMERA_CLOSED');
      assert(sender.track===initialTrack&&!initialTrack.enabled,'Closed camera was opened or replaced');
      assert(assetRequests===0,'Denied or closed camera loaded processing assets');
      stream.unmuteVideo();await frames();
      await background.apply();
      await until(()=>background.state().activeFrames&&background.state().outgoingFrames>=5,'segmented outgoing RTP frame counters');
      await frames();const after=pixels(), active=background.state(), processed=sender.track;
      assert(processed!==initialTrack&&initialTrack.readyState==='ended','HRTC did not replace its real local track');
      let foreground=0,replaced=0;const total=512*512;
      for(let i=0;i<after.length;i+=4){const diff=Math.abs(after[i]-baseline[i])+Math.abs(after[i+1]-baseline[i+1])+Math.abs(after[i+2]-baseline[i+2]);if(!blue(after,i)&&diff<80)foreground++;if(blue(after,i)&&diff>100)replaced++;}
      assert(foreground/total>0.10,'Recipient lost the foreground (static background instead of segmentation)');
      assert(replaced/total>0.10,'Recipient background unchanged (preview-only or pass-through effect)');
      phase=1;await frames(20);const moving=pixels();let movingForeground=0,stableBackground=0;
      for(let i=0;i<after.length;i+=4){const diff=Math.abs(moving[i]-after[i])+Math.abs(moving[i+1]-after[i+1])+Math.abs(moving[i+2]-after[i+2]);if(!blue(after,i)&&!blue(moving,i)&&diff>24)movingForeground++;if(blue(after,i)&&blue(moving,i)&&diff<35)stableBackground++;}
      assert(movingForeground/total>0.05,'Real recipient foreground does not follow source-frame changes: '+JSON.stringify({foreground:foreground/total,replaced:replaced/total,moving:movingForeground/total,stable:stableBackground/total,meanChange:difference(moving,after)}));
      assert(stableBackground/total>0.10,'Foreground changes incorrectly replace the imported background');
      phase=0;await background.clear();await frames(12);const restored=pixels();
      assert(!background.state().imported&&!background.state().activeFrames,'Clear retained import/effect state');
      assert(processed.readyState==='ended'&&sender.track?.readyState==='live','Clear did not stop output and restore real camera clone');
      assert(difference(restored,baseline)<18,'Recipient did not return to the original camera after Clear');
      await background.importImage(makeImport('rgb(15,40,225)'));await background.apply();
      await until(()=>background.state().activeFrames,'second activation');
      const previous=sender.track;
      await background.importImage(makeImport('rgb(220,25,190)'));
      assert(previous.readyState==='ended'&&!background.state().activeFrames,'Import replacement retained active old image');
      await background.apply();await until(()=>background.state().activeFrames,'replacement image activation');await frames();
      const second=pixels();let magentaPixels=0;for(let i=0;i<second.length;i+=4)if(magenta(second,i))magentaPixels++;
      assert(magentaPixels/total>0.10,'Recipient did not receive the replacement imported image');
      const beforeDevice=sender.track,newInput=inputTrack.clone();
      await stream.replaceTrack(newInput,'video',profileId);await frames();
      assert(beforeDevice.readyState==='ended'&&sender.track===newInput&&!background.state().activeFrames,'Device/track replacement kept a stale processor');
      await background.apply();await until(()=>background.state().activeFrames,'replacement camera activation');
      const beforeMute=sender.track;stream.muteVideo();
      assert(beforeMute.readyState==='ended','SDK mute did not synchronously revoke the outgoing processor');
      await until(()=>!stream.getVideoTrack(profileId)&&sender.track===null,'closed camera SDK and actual sender cleanup');
      await reject(()=>background.apply(),'BACKGROUND_CAMERA_CLOSED');
      assert(sender.track===null&&!background.state().activeFrames,'Closed camera was recaptured or still published');
      await stream.addTrack(inputTrack.clone(),profileId);stream.unmuteVideo();
      await background.apply();await until(()=>background.state().activeFrames,'explicit camera restart activation');
      const revoked=sender.track;await background.configure(false);await frames();
      assert(revoked.readyState==='ended'&&sender.track?.readyState==='live','Capability revoke did not restore authorized original camera');
      assert(!background.state().enabled&&!background.state().imported&&!background.state().activeFrames,'Capability revoke retained owned state');
      // The ordinary provider camera-off consumer calls removeTrack through
      // its synchronous sdkWrapper and immediately polls getVideoTrack again.
      // Inactive background guards must retain that observable SDK contract.
      const beforeCameraOff=sender.track, cameraOff=stream.removeTrack(beforeCameraOff);
      assert(stream.getVideoTrack()===null&&beforeCameraOff.readyState==='ended',
        'Camera-off consumer still sees the removed track before the SDK promise settles');
      await cameraOff;
      assert(sender.track===null&&!background.state().activeFrames,'Camera-off retained the actual outgoing sender');
      await stream.addTrack(inputTrack.clone(),profileId);stream.unmuteVideo();
      await background.configure(true);await background.importImage(makeImport('rgb(15,40,225)'));await background.apply();
      await until(()=>background.state().activeFrames,'final session-owned activation');
      const oldOwner=sender.track;sessionKey='qa-replacement-owner';background.pulse();
      assert(oldOwner.readyState==='ended'&&!background.state().imported,'Session replacement retained old image or outgoing frames');
      await until(()=>sender.track===null,'old session output removed');
      const decodedReport=Array.from((await incoming.getStats()).values()).find(value=>value.type==='inbound-rtp'&&value.kind==='video');
      assert(decodedReport?.framesDecoded>20,'No actual video frames decoded at local recipient');
      const report={actualSdk:sdk.VERSION,processor:'MediaPipe Selfie Segmentation 0.1.1675465747',
        foregroundFraction:foreground/total,replacedBackgroundFraction:replaced/total,
        movingForegroundFraction:movingForeground/total,stableBackgroundFraction:stableBackground/total,
        restoredMeanError:difference(restored,baseline),outgoingFrames:active.outgoingFrames,
        recipientFramesDecoded:decodedReport.framesDecoded,generatedSourceFrames:draws,
        closedCameraUnchanged:true,unpermittedCameraUnchanged:true,forcedPolicyRefused:true,
        replacementImageReceived:true,replacementTrackRetired:true,capabilityRevocationRestored:true,
        cameraRemovalSynchronous:true,cameraOffSenderReleased:true,
        sessionReplacementRevoked:true,assetRequests,providerAuthorizationTested:false};
      await window.__qaBackgroundCleanup();delete window.__qaBackgroundCleanup;
      return report;
    })().catch(error => ({ failure: { message: error.message || error.getMsg?.() || String(error),
      code: error.code ?? error.getCode?.(), stack: error.stack } }))`);
    if (result.failure) throw Object.assign(new Error(result.failure.message), result.failure);
    assert.equal(permissionRequests, 0, 'The generated fixture requested a real device permission');
    assert.deepEqual(blockedRequests, [], 'A model/SDK attempted an external request; all such requests were blocked');
    return { ...result, fixture: { sha256: FIXTURE_SHA256, attribution: 'NASA / Eileen Collins; public domain',
      source: 'https://raw.githubusercontent.com/scikit-image/scikit-image/v0.24.0/skimage/data/astronaut.png',
      packaged: false }, permissionRequests, externalRequests: blockedRequests.length };
  } finally {
    if (!window.isDestroyed()) {
      try { await evaluate('window.__qaBackgroundCleanup ? window.__qaBackgroundCleanup() : Promise.resolve()'); } catch {}
      window.destroy();
    }
    await session.clearStorageData();
    await new Promise(resolve => server.close(resolve));
  }
}
module.exports = verifyCustomBackground;
if (require.main === module) {
  const electron = require('electron');
  // Keep MAIN alive until the verifier's session/server cleanup has completed.
  electron.app.on('window-all-closed', () => {});
  electron.app.whenReady().then(() => verifyCustomBackground({ electron, personFixture: process.argv[2] }))
    .then(report => { console.log(JSON.stringify(report, null, 2)); electron.app.exit(0); },
      error => { console.error(error.stack || error); electron.app.exit(1); });
}
