'use strict';
/* Run only on a NEW, isolated Xvfb server (never the user's DISPLAY):
 * WELINK_RENDER_TEST_DISPLAY=isolated xvfb-run -a -s '-screen 0 1280x960x24 -nolisten tcp +extension Composite' \
 *   ELECTRON --no-sandbox Conference/meeting_render_surface_verify.js ASSEMBLED_APP
 * An Openbox WM is recommended for native-dialog keyboard handling. All tracks
 * here are locally generated canvas MediaStreamTracks; no real conference,
 * account, network, camera, microphone, screen permission or upload is used.
 * The parent runs this after assembling the real worker and its private libs.
 */
const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const {execFile} = require('child_process');
const {promisify} = require('util');
const {EventEmitter} = require('events');
const electron = require('electron');
const {app, BrowserWindow, ipcMain, dialog, Menu} = electron;
const exec = promisify(execFile);
if (process.env.WELINK_RENDER_TEST_DISPLAY !== 'isolated' || !process.env.DISPLAY)
  throw Error('This verifier requires its own isolated Xvfb DISPLAY');
const root = path.resolve(process.argv[2] || '');
const native = path.join(root,'native');
const {MeetingRenderSurfaceHost, nativeRenderSurfaces} = require(path.join(native,'meeting_render_surface_host'));
const {MeetingNativeWeb} = require(path.join(native,'meeting_native_web'));
const directory = fs.mkdtempSync(path.join(os.tmpdir(),'welink-native-render-proof-'));
app.setPath('userData',path.join(directory,'profile'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
const observations = [];
let window, owner;
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
const probePath = path.join(__dirname,'meeting_render_surface_probe.py');
async function probe(request) {
  const {stdout} = await exec('python3',[probePath,JSON.stringify(request)],{timeout:15000,maxBuffer:1024*1024});
  return JSON.parse(stdout);
}
function checked(name, data = {}) { observations.push({name,...data}); console.log('PASS '+name); }
async function until(check, message, timeout = 8000) {
  const end = Date.now()+timeout;
  while (Date.now()<end) { const result = await check(); if (result) return result; await sleep(70); }
  throw Error('Timed out: '+message);
}
async function js(source) { return window.webContents.executeJavaScript(source); }
async function noWindows(ids) {
  await until(async () => (await probe({xids:ids,pixels:false})).windows.every(w => !w.exists),'native XIDs destroyed');
}
async function driveDialog(allow, beforeAccept) {
  const {stdout} = await exec('xdotool',['search','--sync','--onlyvisible','--name','^Native conference video access$'],{timeout:10000});
  const id = stdout.trim().split(/\s+/).at(-1);
  assert(/^[0-9]+$/.test(id));
  await exec('xdotool',['windowactivate','--sync',id]);
  await exec('xdotool',['windowfocus','--sync',id]);
  if (beforeAccept) await beforeAccept();
  if (!allow) { await exec('xdotool',['key','Escape']); return; }
  // A genuine button press, not a mocked dialog response or renderer grant.
  const {stdout:geometry} = await exec('xdotool',['getwindowgeometry','--shell',id]);
  const values = Object.fromEntries(geometry.trim().split('\n').map(line => line.split('=')));
  await exec('xdotool',['mousemove','--window',id,String(Number(values.WIDTH)-100),String(Number(values.HEIGHT)-24),'click','1']);
}
const fixture = `
(() => {
  const watermark = window.__welinkCreateNativeWatermark({onViolation:()=>{}});
  watermark.configure({content:'LOCAL TEST',color:'#999999'});
  let localSharing = false;
  let joined = false, forbidden = 0, generation = 1;
  const streams = [], videos = [], sources = [], colors = [];
  function add(color) {
    const canvas = document.createElement('canvas'); canvas.width=320; canvas.height=180;
    const context=canvas.getContext('2d',{alpha:false});
    const index=sources.length; colors[index]=color;
    context.fillStyle=color; context.fillRect(0,0,320,180);
    const stream=canvas.captureStream(30), track=stream.getVideoTracks()[0];
    const video=document.createElement('video'); video.muted=true; video.autoplay=true;
    video.style.cssText='position:absolute;left:'+(20+index*360)+'px;top:180px;width:320px;height:180px;object-fit:contain;object-position:50% 50%;';
    video.srcObject=stream; document.body.append(video); video.play();
    const timer=setInterval(()=>{context.fillStyle=colors[index];context.fillRect(0,0,320,180);},33);
    streams.push({canvas,context,stream,track,timer}); videos.push(video); sources.push({track,kind:index===1?'shared-content':'camera'});
  }
  add('rgb(220,20,20)'); add('rgb(20,20,220)');
  const note=window.__welinkCreateRenderWindows({watermark,
    ensurePolicy:needsPixels=>{if(needsPixels) window.__welinkSnapshotPolicy.requireAllowed(window.__welinkSnapshotPolicy.decision(forbidden)); return {ready:true};},
    getState:()=>({joined,sessionKey:'generated-fixture-'+generation,conferenceId:'LOCAL-GENERATED-ONLY',localSharing,
      source:'isolated-generated-tracks-not-provider-admission',sources})});
  const surface=window.__welinkCreateRenderSurface({collect:expected=>note.surfaceEntries(expected),watermark,
    invalidate:data=>window.surfaceVerifierHost.invalidate(data)});
  window.fixture={
    invoke(operation,params) {
      if(operation==='render.inspect') return note.inspect(params);
      if(operation==='render.surface.inspect') return note.surfaceEntries(params).receipt;
      if(operation==='render.capture') return note.capture(params);
      if(operation==='render.surface.open') return surface.open(params);
      if(operation==='render.surface.frame') return surface.frame(params);
      if(operation==='render.surface.close') return surface.close(params);
      throw Error('Unexpected fixture operation');
    },
    joined(value){joined=value;if(!value)generation++;surface.pulse();},
    policy(value){forbidden=value;surface.pulse();},
    localSharing(value){localSharing=value;surface.pulse();},
    color(index,value){colors[index]=value;},
    layout(){videos[0].style.left='45px';videos[0].style.top='195px';videos[0].style.width='240px';videos[0].style.height='135px';},
    remove(index){videos[index].remove();streams[index].track.stop();clearInterval(streams[index].timer);surface.pulse();},
    watermark(){watermark.configure({content:'REVISED TEST WATERMARK',color:'#999999'});},
    watermarkText(content){watermark.configure({content,color:'#999999'});},
    watermarkReady(){return watermark.state().ready && getComputedStyle(document.documentElement).display!=='none';},
    tileSize(width,height){videos[1].style.width=width+'px';videos[1].style.height=height+'px';surface.pulse();},
    ready(){return videos.every(video=>video.readyState>=2 && video.videoWidth>0 && !video.paused);},
  };
})();`;

async function main() {
  await app.whenReady();
  window = new BrowserWindow({x:30,y:30,width:900,height:650,frame:true,show:true,title:'Isolated native render verifier',
    webPreferences:{preload:path.join(__dirname,'meeting_render_surface_verify_preload.js'),sandbox:true,
      contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  window.setMenu(null);
  window.webContents.session.setPermissionRequestHandler((_contents,_permission,done)=>done(false));
  window.webContents.session.setPermissionCheckHandler(()=>false);
  window.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']},(_request,done)=>done({cancel:true}));
  await window.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#121212;color:white}h1{font:20px sans-serif;margin:20px}</style></head><body><h1>Isolated generated tracks. No real meeting or devices.</h1></body></html>'));
  for (const filename of ['meeting_native_web_watermark.js','meeting_snapshot_policy.js','meeting_render_windows.js','meeting_render_surface.js'])
    await js(fs.readFileSync(path.join(native,filename),'utf8'));
  await js(fixture);
  await until(()=>js('fixture.ready()'),'decoded generated video tracks');
  const bridge = new EventEmitter();
  bridge.on('event', event => {
    if (event.event === 'render-surfaces-changed') {
      const state={status:event.data.status,reason:event.data.reason,frameSequence:event.data.frameSequence,
        windows:event.data.surfaces.map(surface=>({xid:surface.xid,bounds:surface.nativeBounds}))};
      observations.push({name:'native-surface-state',...state}); console.log('SURFACE-STATE '+JSON.stringify(state));
    }
  });
  let inspectionGate = null;
  function deferInspection(number) {
    let reached, release;
    const entered = new Promise(resolve => { reached=resolve; });
    const held = new Promise(resolve => { release=resolve; });
    inspectionGate = {remaining:number, reached, held};
    return {entered, release};
  }
  let holdNextFrame;
  let geometryRecorded = false;
  Object.assign(bridge,{window,electron,instance:'isolated-native-surface-verifier',disposed:false,retiring:false,loggingOut:false,
    async renderForHost(operation,params) {
      const reply = await js('Promise.resolve().then(()=>fixture.invoke('+JSON.stringify(operation)+','+JSON.stringify(params || {})+')).then(data=>({ok:true,data}),e=>({ok:false,error:{code:e.code,message:e.message}}))');
      if (!reply.ok) throw Object.assign(new Error(reply.error.message),reply.error);
      if (operation === 'render.surface.frame' && holdNextFrame) {
        const notify = holdNextFrame; holdNextFrame = null;
        await new Promise(release => notify({release, viewport:reply.data.viewport}));
      }
      if (operation === 'render.surface.inspect' && inspectionGate && --inspectionGate.remaining === 0) {
        const gate = inspectionGate; inspectionGate = null;
        gate.reached(); await gate.held; // Delay a REAL renderer receipt, not its policy or pixels.
      }
      if (operation === 'render.surface.frame' && !geometryRecorded) {
        geometryRecorded = true;
        const xid=window.getNativeWindowHandle().readUInt32LE(0);
        const geometry={viewport:reply.data.viewport,bounds:window.getBounds(),content:window.getContentBounds(),
          external:await probe({xids:[xid],pixels:false}),
          frameExtents:(await exec('xprop',['-id',String(xid),'_NET_FRAME_EXTENTS'])).stdout.trim()};
        observations.push({name:'native-client-geometry',...geometry});
        console.log('GEOMETRY '+JSON.stringify(geometry));
      }
      return reply.data;
    }});
  owner = new MeetingRenderSurfaceHost({bridge,electron});
  bridge.renderSurfacesForHost = params => {
    if (params.action==='reserve-start') return owner.reserveStart();
    if (params.action==='start') return owner.start(params.expected,params.reservation);
    return params.action==='stop' ? owner.stop() : owner.inspect();
  };
  ipcMain.handle('welink-render-surface-verifier-invalidate',(event,data)=>{
    assert.equal(event.sender,window.webContents); assert.equal(event.senderFrame,window.webContents.mainFrame);
    observations.push({name:'renderer-invalidation',...data});
    console.log('RENDERER-INVALIDATION '+JSON.stringify(data));
    return owner.invalidate(event.sender,data);
  });
  const record={bridge};
  const control=action=>nativeRenderSurfaces(record,{action},{dialog,requireOwner:r=>assert.equal(r,record)});
  async function allow() {
    await Promise.all([control('start'),driveDialog(true)]);
    return until(async()=>{const state=await owner.inspect();return state.status==='ready' && state.surfaces.length ? state : false;},'first painted native receipt');
  }
  const parent=window.getNativeWindowHandle().readUInt32LE(0);
  const empty=await owner.inspect(); assert.equal(empty.surfaces.length,0); assert.equal(owner.worker,null);
  await assert.rejects(control('start'),e=>e.code==='NOT_IN_CONFERENCE');
  assert.equal(owner.worker,null);
  for (const op of ['render.surface.inspect','render.surface.open','render.surface.frame','render.capture'])
    await assert.rejects(MeetingNativeWeb.prototype.execute.call({},op,{}),e=>e.code==='UNSUPPORTED_OPERATION');
  checked('no pre-meeting windows, device grants, or public raw-pixel broker operation');
  await js('fixture.joined(true)');
  for (const policy of ['1','undefined']) {
    await js('fixture.policy('+policy+')');
    await assert.rejects(control('start'));
    assert.equal(owner.worker,null);
    const metadata=await bridge.renderForHost('render.inspect',{}); assert.equal(metadata.nativeHandleSupported,false);
  }
  checked('denied and unknown screenshot policy prevent native export; note metadata remains unchanged');
  await js('fixture.policy(0)');
  await Promise.all([assert.rejects(control('start'),e=>e.code==='RENDER_CONSENT_DENIED'),driveDialog(false)]);
  assert.equal(owner.worker,null); checked('real native dialog cancellation creates no surface');
  for (const inspectionNumber of [1,2]) {
    const baseline = await probe({scene:parent,pixels:false});
    const gate = deferInspection(inspectionNumber);
    const outcome = control('start').then(value=>({value}),error=>({error}));
    await Promise.all([
      Promise.race([gate.entered, outcome.then(result=>{throw Error('Start returned before the held inspection: '+(result.error?.code || 'success'));})]),
      inspectionNumber===2 ? driveDialog(true) : Promise.resolve()
    ]);
    const stopped = await control('stop');
    assert.equal(stopped.status,'stopped'); assert.equal(owner.worker,null);
    gate.release();
    const cancelled = await outcome;
    assert.equal(cancelled.error?.code,'RENDER_START_CANCELLED');
    await sleep(200);
    assert.equal(owner.lease,null); assert.equal(owner.worker,null);
    assert.deepEqual((await owner.inspect()).surfaces,[]);
    assert.deepEqual((await probe({scene:parent,pixels:false})).ownerTree.children,baseline.ownerTree.children);
    checked(inspectionNumber===1 ? 'Stop cancels a Start awaiting pre-consent inspection' :
      'Stop cancels an already-approved Start awaiting final inspection; no worker or XIDs appear afterward');
  }
  const duringConsent = control('start').then(value=>({value}),error=>({error}));
  await driveDialog(true,()=>control('stop'));
  assert.equal((await duringConsent).error?.code,'RENDER_START_CANCELLED');
  assert.equal(owner.worker,null); assert.equal(owner.lease,null);
  checked('Stop during the real consent dialog prevents a later Allow click from exporting video');
  const before=await probe({scene:parent,pixels:false});
  let receipt=await allow();
  assert.equal(receipt.nativeHandleSupported,true); assert.equal(receipt.win32Abi,false); assert.equal(receipt.handleKind,'x11-window');
  assert.equal(receipt.surfaces.length,2);
  const ids=receipt.surfaces.map(s=>s.xid);
  assert.equal(new Set(ids).size,2); assert(!ids.includes(parent));
  const first=await probe({xids:ids,scene:parent});
  assert.deepEqual(first.rootChildren,before.rootChildren,'export must not add top-level windows');
  assert.equal(first.scene.sha256,before.scene.sha256,'manually redirected native windows must not change the visible scene');
  for(const surface of first.windows) {
    assert(surface.exists); assert.equal(surface.parent,parent); assert.equal(surface.inputRectangles,0);
    assert(surface.image && surface.image.nonSolidPixels>50,'independent readback must contain watermark glyph pixels');
    const expected=receipt.surfaces.find(s=>s.xid===surface.xid).nativeBounds;
    for(const key of ['x','y','width','height']) assert.equal(surface[key],expected[key]);
  }
  assert(first.windows[0].image.dominant[0]>first.windows[0].image.dominant[2]+100);
  assert(first.windows[1].image.dominant[2]>first.windows[1].image.dominant[0]+100);
  checked('two distinct genuine X11 children expose the correct watermarked camera/share tracks without duplicate presentation',{receipt,external:first});
  await js('fixture.localSharing(true)');
  await assert.rejects(bridge.renderForHost('render.inspect',{requireCapture:true}),e=>e.code==='LOCAL_SHARING_ACTIVE');
  assert.equal((await owner.inspect()).status,'ready');
  await js('fixture.localSharing(false)');
  checked('native track export does not change the note-only local-sharing screenshot guard');
  await js("fixture.color(0,'rgb(20,220,20)');fixture.color(1,'rgb(220,220,20)')");
  const changed=await until(async()=>{
    const state=await probe({xids:ids});
    return state.windows.every(w=>w.image) && state.windows[0].image.dominant[1]>150 && state.windows[0].image.dominant[0]<80 &&
      state.windows[1].image.dominant[0]>150 && state.windows[1].image.dominant[1]>150 ? state : false;
  },'independent X11 process observes changing track pixels');
  assert.notEqual(changed.windows[0].image.sha256,first.windows[0].image.sha256);
  assert.notEqual(changed.windows[1].image.sha256,first.windows[1].image.sha256);
  checked('existing native XIDs receive evolving pixels, not snapshot files or owner-window aliases',{external:changed});
  await js('fixture.layout()');
  receipt=await until(async()=>{
    const r=await owner.inspect();
    assert.notEqual(r.status,'stopped','Native export retired during resize: '+r.reason);
    return r.surfaces[0]?.nativeBounds.width===240 ? r : false;
  },'native geometry follows the video');
  const moved=await probe({xids:receipt.surfaces.map(s=>s.xid)});
  assert.equal(moved.windows[0].x,45+receipt.owner.contentOffset.x);
  assert.equal(moved.windows[0].y,195+receipt.owner.contentOffset.y);
  assert.equal(moved.windows[0].width,240); assert.equal(moved.windows[0].height,135);
  checked('native window geometry follows visible physical-pixel layout',{external:moved});
  window.webContents.setZoomFactor(1.25);
  const zoomLayout=await bridge.renderForHost('render.inspect',{});
  const visible=zoomLayout.targets[0].bounds.visible, scale=zoomLayout.devicePixelRatio;
  const zoomWidth=Math.floor((visible.x+visible.width)*scale)-Math.ceil(visible.x*scale);
  receipt=await until(async()=>{const r=await owner.inspect();return r.surfaces[0]?.nativeBounds.width===zoomWidth ? r : false;},'native geometry follows browser zoom');
  const zoomed=await probe({xids:receipt.surfaces.map(s=>s.xid)});
  assert.equal(zoomed.windows[0].width,zoomWidth);
  checked('browser zoom maps to actual native physical pixels, not fabricated CSS handles',{external:zoomed});
  const beforeMenu = receipt, menuIds = beforeMenu.surfaces.map(s => s.xid);
  const heldFrame = await new Promise(resolve => { holdNextFrame = resolve; });
  try {
    window.setMenu(Menu.buildFromTemplate([{label:'Render verifier',submenu:[{label:'Geometry verifier',enabled:false}]}]));
    window.setMenuBarVisibility(true);
    await until(() => {
      const content = window.getContentBounds();
      return Math.abs(content.height * heldFrame.viewport.width / content.width - heldFrame.viewport.height) > 1;
    }, 'native menu layout commits while a real old-size frame is in flight');
  } finally { heldFrame.release(); }
  receipt=await until(async()=>{const r=await owner.inspect();return r.owner?.contentOffset.y>0 ? r : false;},'native menu content offset');
  assert.equal(receipt.leaseId, beforeMenu.leaseId, 'A layout update must not manufacture a new consent');
  await noWindows(menuIds);
  assert(receipt.surfaces.every(s => !menuIds.includes(s.xid)), 'Old XIDs must not be reused for a different layout within this lease');
  checked('late old-size frame clears previous XIDs before the corrected layout resumes');
  const menuGeometry=await probe({xids:receipt.surfaces.map(s=>s.xid)});
  const menuTarget=receipt.surfaces[0];
  assert.equal(menuGeometry.windows[0].y,Math.ceil(menuTarget.bounds.visible.y*scale)+receipt.owner.contentOffset.y);
  checked('native menu bar and WM frame extents preserve the actual content origin',{external:menuGeometry,offset:receipt.owner.contentOffset});
  const retired=receipt.surfaces.map(s=>s.xid);
  await js('fixture.remove(0)');
  receipt=await until(async()=>{const r=await owner.inspect();return r.status==='ready' && r.surfaces.length===1 ? r : false;},'track teardown retires exported windows');
  await noWindows(retired); assert(!retired.includes(receipt.surfaces[0].xid));
  checked('track removal destroys old XIDs rather than aliasing them to a surviving track');
  async function protectedMeetingAfterRejection(ids, label) {
    await until(()=>!owner.lease,'unsupported watermark tile retires native export');
    await noWindows(ids);
    assert.equal(await js('fixture.watermarkReady()'),true);
    assert.equal(window.isVisible(),true);
    // The first video has been removed. This left-side region contains only
    // the meeting background and authoritative watermark, not labels/video.
    const protectedScene=await probe({scene:parent,sceneCrop:{x:20,y:100,width:340,height:450},pixels:false});
    assert(protectedScene.scene?.nonSolidPixels>50,'the legitimate meeting must remain externally viewable and watermarked');
    checked(label,{external:protectedScene});
  }
  const tooSmallIds=receipt.surfaces.map(s=>s.xid);
  await js('fixture.tileSize(150,90)');
  await protectedMeetingAfterRejection(tooSmallIds,'undersized native tile releases its XID without blanking the watermarked meeting');
  await js('fixture.tileSize(320,320);fixture.watermarkText(\"X\".repeat(180))');
  assert.equal(await js('fixture.watermarkReady()'),true);
  receipt=await allow();
  const longWatermarkIds=receipt.surfaces.map(s=>s.xid);
  await js('fixture.tileSize(320,180)');
  await protectedMeetingAfterRejection(longWatermarkIds,'full watermark fit failure releases old XID; no truncation, scaling or meeting-wide blanking');
  await js('fixture.watermarkText(\"LOCAL TEST\")');
  receipt=await allow();
  let retiredIds=receipt.surfaces.map(s=>s.xid);
  await js('fixture.policy(1)'); await until(()=>!owner.lease,'screenshot denial revokes lease'); await noWindows(retiredIds);
  assert.equal((await owner.inspect()).surfaces.length,0); checked('new screenshot denial releases every exported XID');
  await js('fixture.policy(0)'); receipt=await allow(); retiredIds=receipt.surfaces.map(s=>s.xid);
  await js('fixture.policy(undefined)'); await until(()=>!owner.lease,'unknown policy revokes lease'); await noWindows(retiredIds);
  checked('unknown screenshot policy also revokes already-running native export');
  await js('fixture.policy(0)'); receipt=await allow(); retiredIds=receipt.surfaces.map(s=>s.xid);
  await js('fixture.watermark()'); await until(()=>!owner.lease,'watermark change revokes old pixels'); await noWindows(retiredIds);
  checked('watermark revision change destroys all old-watermark windows');
  receipt=await allow(); retiredIds=receipt.surfaces.map(s=>s.xid); window.hide();
  await until(()=>!owner.lease,'hidden meeting retires native surfaces'); await noWindows(retiredIds);
  window.show(); await sleep(200); assert.equal((await owner.inspect()).surfaces.length,0);
  checked('hide revokes export; showing the meeting does not silently restore consent');
  app.commandLine.appendSwitch('ozone-platform','wayland');
  const inspection=await bridge.renderForHost('render.inspect',{requireCapture:true});
  await assert.rejects(owner.start(inspection),e=>e.code==='NATIVE_WAYLAND_UNSUPPORTED');
  app.commandLine.removeSwitch('ozone-platform'); assert.equal(owner.worker,null);
  checked('native-Wayland mode fails explicitly without fake XIDs or desktop-capture fallback');
  receipt=await allow(); retiredIds=receipt.surfaces.map(s=>s.xid);
  clearTimeout(owner.timer); owner.timer=null;
  await until(()=>!owner.lease,'native worker independent 1500ms lease watchdog',5000); await noWindows(retiredIds);
  checked('stalled frame producer is independently retired by the native worker watchdog');
  receipt=await allow(); retiredIds=receipt.surfaces.map(s=>s.xid);
  await js('fixture.joined(false)'); await until(()=>!owner.lease,'room teardown'); await noWindows(retiredIds);
  await assert.rejects(control('start'),e=>e.code==='NOT_IN_CONFERENCE');
  checked('room teardown releases all exported XIDs and prohibits pre-meeting restart');
  await js('fixture.joined(true)'); receipt=await allow(); retiredIds=receipt.surfaces.map(s=>s.xid);
  await window.loadURL('data:text/html,Retired isolated document');
  await until(()=>!owner.lease,'document navigation revokes owner'); await noWindows(retiredIds);
  checked('document replacement releases all native windows');
  await owner.stop();
  fs.writeFileSync(path.join(directory,'evidence.json'),JSON.stringify({scope:'isolated generated MediaStreamTracks; no production meeting',observations},null,2));
  console.log('EVIDENCE '+path.join(directory,'evidence.json'));
}
main().then(()=>app.exit(0),async error=>{
  console.error(error.stack || error);
  fs.writeFileSync(path.join(directory,'failure.json'),JSON.stringify({error:String(error.stack || error),lastSurfaceState:owner?.last,observations},null,2));
  try { await owner?.stop('VERIFIER_EXIT'); } catch (_) {}
  app.exit(1);
});
