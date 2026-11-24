#!/usr/bin/env electron
'use strict';
/* Run ONLY on an isolated Xvfb display, against the assembled app:
 * WELINK_RENDER_TEST_DISPLAY=1 xvfb-run -a electron --no-sandbox 
 *   Conference/verify_render_windows.js /absolute/image/resources/app
 * Prerequisites: Electron, xdotool, Xvfb, acorn (or WELINK_TEST_ACORN).
 * No account, production server, real camera/microphone or desktop capture.
 * Generated calibration frames cross real loopback RTCPeerConnections. Native
 * dialogs are operated on this isolated display, never on the user's desktop.
 * The exact packaged me, module383 uploader, module90 DOM helpers and TinyMCE
 * run against a real local HTTP upload fixture, not a claimed cloud service.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const acorn = require(process.env.WELINK_TEST_ACORN || 'acorn');
const electron = require('electron');
const { app, BrowserWindow, dialog, ipcMain, nativeImage } = electron;
const run = promisify(execFile);
const root = path.resolve(process.argv[2] || '');
const native = name => path.join(root, 'native', name);
const read = name => fs.readFileSync(name, 'utf8');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const error = (code, message = code) => Object.assign(new Error(message), { code });
let temp, meeting, note, obscurer, server;
const proof = { checks: [], scope: 'isolated-electron-render-and-campus-note-consumer',
  notProved: ['live-campus-authentication/admission', 'production-note-upload', 'Win32-HWND-ABI'] };
const checked = name => proof.checks.push(name);
function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) { for (const child of value) walk(child, visit); }
    else if (value && typeof value.type === 'string') walk(value, visit);
  }
}
function extractCampus() {
  const text = read(path.join(root, 'plugin/conference/dist/js/listenAndNote.js'));
  const ast = acorn.parse(text, { ecmaVersion: 'latest' });
  let modules;
  walk(ast, node => { if (node.type === 'ArrayExpression' && node.elements.length > 637) modules ||= node.elements; });
  assert(modules?.[637], 'pinned note webpack module637');
  const vars = {};
  walk(modules[637].body, node => {
    if (node.type === 'VariableDeclarator' && ['me', 'Q'].includes(node.id?.name) && node.init) {
      const value = text.slice(node.init.start, node.init.end);
      if (node.id.name === 'Q' && !value.includes('wrapId')) return;
      if (node.id.name === 'me' && !value.includes('filePath')) return;
      vars[node.id.name] = value;
    }
  });
  assert(vars.me?.includes('__welinkRenderNotes.current'), 'packed post-upload stale-note guard');
  assert(vars.Q && text.includes('nativeRenderNotes.request') && text.includes('nativeRenderNotes.receive'));
  return { ...vars, helpers: Object.fromEntries([90, 87, 383].map(id => [id, text.slice(modules[id].start, modules[id].end)])) };
}
function facadeMethods() {
  const text = read(native('meeting_service.js')), ast = acorn.parse(text, { ecmaVersion: 'latest' });
  const methods = [];
  walk(ast, node => {
    if (node.type === 'MethodDefinition' && ['getRenderWindowInfo', 'rejected'].includes(node.key?.name))
      methods.push(text.slice(node.start, node.end));
  });
  assert.equal(methods.length, 2);
  return new Function('flag', 'operationError', 'return class { ' + methods.join('\n') + ' }')(
    (value, name) => { if (value === true || value === 1) return true; if (value === false || value === 0) return false; throw error('INVALID_ARGUMENT', name); }, error);
}
async function page(expression, window = meeting) { return window.webContents.executeJavaScript(expression); }
async function mediaOperation(operation, params = {}) {
  const reply = await page(`(() => {try {return {ok:true,value:proofRender.${operation === 'render.capture' ? 'capture' : 'inspect'}(${JSON.stringify(params)})}}catch(e){return {ok:false,code:e.code,message:e.message}}})()`);
  if (!reply.ok) throw error(reply.code, reply.message);
  return reply.value;
}
async function expectCode(action, code) {
  await assert.rejects(action, e => e.code === code, code);
}
async function driveFileDialog(action) {
  let id;
  for (let i = 0; i < 150; i++) {
    try { id = (await run('xdotool', ['search', '--onlyvisible', '--name', '^Render snapshot verifier$'])).stdout.trim().split('\n').pop(); }
    catch (_) {}
    if (id) break;
    await sleep(100);
  }
  assert(id, 'actual native save dialog became visible');
  await run('xdotool', ['windowfocus', '--sync', id]);
  if (action.beforeAccept) await action.beforeAccept();
  await run('xdotool', ['key', '--window', id, action.cancel ? 'Escape' : 'Return']);
}
async function installMedia() {
  meeting = new BrowserWindow({ width: 1100, height: 800, show: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  await meeting.loadURL('data:text/html,<html><body style="margin:0;background:%2300ff00"><main id="media"></main></body></html>');
  await page(['meeting_native_web_watermark.js','meeting_snapshot_policy.js','meeting_render_windows.js'].map(name=>read(native(name))).join('\n'));
  await page(`(async () => {
    const root=document.getElementById('media');
    const state=window.proofState={joined:true,sessionKey:'fixture-room-1',conferenceId:'fixture-conference',localSharing:false,sources:[],source:'loopback-rtc-fixture'};
    window.proofPeers=[];window.proofTimers=[];
    function gather(pc){return pc.iceGatheringState==='complete'?Promise.resolve():new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(Error('ICE gathering timed out')),10000);
      pc.addEventListener('icegatheringstatechange',()=>{if(pc.iceGatheringState==='complete'){clearTimeout(timeout);resolve()}});
    })}
    async function stream(color,kind,left){
      const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;
      const context=canvas.getContext('2d');
      const paint=()=>{context.fillStyle=color;context.fillRect(0,0,640,360);context.fillStyle='#ffffff';context.fillRect(12,12,30,30)};
      paint();proofTimers.push(setInterval(paint,80));
      const source=canvas.captureStream(12), sender=new RTCPeerConnection({iceServers:[]}), receiver=new RTCPeerConnection({iceServers:[]});
      proofPeers.push({sender,receiver,source});
      const video=document.createElement('video');video.muted=true;video.autoplay=true;video.playsInline=true;
      video.style.cssText='position:absolute;left:'+left+'px;top:20px;width:480px;height:270px;object-fit:contain';root.append(video);
      const incoming=new Promise(resolve=>receiver.ontrack=event=>{video.srcObject=event.streams[0];resolve(event.track)});
      sender.addTrack(source.getVideoTracks()[0],source);
      await sender.setLocalDescription(await sender.createOffer());await gather(sender);
      await receiver.setRemoteDescription(sender.localDescription);
      await receiver.setLocalDescription(await receiver.createAnswer());await gather(receiver);
      await sender.setRemoteDescription(receiver.localDescription);
      const track=await incoming;await video.play();
      await new Promise((resolve,reject)=>{const deadline=Date.now()+10000;const tick=()=>{
        if(video.readyState>=2&&video.videoWidth&&track.muted===false)return resolve();
        if(Date.now()>deadline)return reject(Error('No decoded loopback frame'));setTimeout(tick,40)};tick()});
      state.sources.push({track,kind});return video;
    }
    window.proofCamera=await stream('#b41923','camera',20);
    window.proofShare=await stream('#174f9d','shared-content',20);
    window.proofWatermark=__welinkCreateNativeWatermark({onViolation:e=>{window.proofPolicyFailure=e.code}});
    proofWatermark.configure({content:'LOCAL RENDER VERIFIER',color:'#999999'});
    window.proofRender=__welinkCreateRenderWindows({root,watermark:proofWatermark,getState:()=>state,
      ensurePolicy: needsImage => { if (needsImage) __welinkSnapshotPolicy.requireAllowed(__welinkSnapshotPolicy.decision(window.proofShotPolicy));
        return {ready:proofWatermark.ensure('meeting-ui').ready}; }});
    window.proofShotPolicy = 0;
    return true;
  })()`);
  meeting.webContents.setZoomFactor(1.5);
  obscurer = new BrowserWindow({ width: 1100, height: 800, show: true, backgroundColor: '#00ff00',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  await obscurer.loadURL('data:text/html,<body style="background:%2300ff00">Unrelated verifier window</body>');
}
async function localServer() {
  let uploaded = 0;
  const tinyRoot = path.join(root, 'plugin/conference/dist/1.2.120/static/tinymce');
  server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'POST' && url.pathname.startsWith('/mcloud/mag/ProxyForText/usg/meetingroom_common/api/meeting/note/file/upload/')) {
        const chunks=[]; for await (const chunk of request) chunks.push(chunk);
        const bytes=Buffer.concat(chunks);
        assert(bytes.length && bytes.includes(Buffer.from([137,80,78,71,13,10,26,10])), 'real multipart upload contains saved PNG');
        const name='upload-'+ ++uploaded+'.png';
        // Store the actual uploaded file bytes, excluding the multipart framing.
        const start=bytes.indexOf(Buffer.from([137,80,78,71,13,10,26,10]));
        const end=bytes.indexOf(Buffer.from('IEND'),start)+8;
        assert(end>start);
        fs.writeFileSync(path.join(temp,name),bytes.subarray(start,end),{flag:'wx',mode:0o600});
        response.setHeader('Content-Type','application/json');
        response.end(JSON.stringify({code:200,response:{fileUrl:base+'/uploaded/'+name,obsId:name}}));return;
      }
      if (url.pathname === '/note') {
        response.setHeader('Content-Type','text/html');
        response.end('<!doctype html><html><body><div id="editor" style="height:480px;overflow:auto"><p id="cursor">Notes</p></div><script src="/tiny/tinymce.min.js"></script></body></html>');return;
      }
      let filename;
      if (url.pathname.startsWith('/tiny/')) {
        filename=path.resolve(tinyRoot,decodeURIComponent(url.pathname.slice(6)));
        assert(filename.startsWith(tinyRoot+path.sep));
      } else if (url.pathname.startsWith('/uploaded/')) filename=path.join(temp,path.basename(url.pathname));
      else { response.writeHead(404);response.end();return; }
      response.setHeader('Content-Type',filename.endsWith('.js')?'application/javascript':filename.endsWith('.css')?'text/css':filename.endsWith('.png')?'image/png':'application/octet-stream');
      response.end(await fs.promises.readFile(filename));
    } catch(e) { response.writeHead(500);response.end(String(e)); }
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  return {base,uploads:()=>uploaded};
}
async function installConsumer(campus, base) {
  note = new BrowserWindow({width:900,height:700,show:true,webPreferences:{nodeIntegration:true,contextIsolation:false,sandbox:false,backgroundThrottling:false}});
  await note.loadURL(base+'/note');
  ipcMain.on('render-proof-window',(event,method,args)=>{
    assert.equal(event.sender,note.webContents);assert(['setAlwaysOnTop','moveTop','focus'].includes(method));note[method](...args);
  });
  await page(`(async()=>{
    window.__welinkRenderNotes=require(${JSON.stringify(native('meeting_render_notes.js'))});
    window.__dirname=${JSON.stringify(path.join(root,'plugin/conference/dist'))};
    const editors=await tinymce.init({selector:'#editor',inline:true,menubar:false,toolbar:false,skin:false,content_css:false,plugins:[],promotion:false});
    window.proofNoteStore={conferenceID:'fixture-conference',noteId:'note-fixture',tinymce:{editors},isStartAI:false,subtitleMessage:[],subtitleHistorialMsg:[]};
    window.proofNotices=[];window.proofUploads=[];
    const c={getStore:key=>proofNoteStore[key],setStore:(key,value)=>proofNoteStore[key]=value};
    const ue=console,D=console,f={a:value=>value,c:value=>value};
    window.coreLogger={getLogger:()=>()=>console};window.Noop=()=>{};
    window.isNullOrEmpty=value=>value==null||value===''||String(value)==='NaN'||value.length===0||typeof value==='object'&&Object.keys(value).length===0;
    window.escapeXSS=value=>String(value).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    window.$getState=()=>proofNoteStore;
    const nativeRenderNotes=window.__welinkRenderNotes;
    const nativeNoteContext=window.__welinkRenderNoteContext=()=>({conferenceId:c.getStore('conferenceID'),noteId:c.getStore('noteId')});
    window.Pedestal={remote:{getCurrentWindow:()=>Object.fromEntries(['setAlwaysOnTop','moveTop','focus'].map(name=>[name,(...args)=>require('electron').ipcRenderer.send('render-proof-window',name,args)]))},
      callMethod:async(method,params)=>{
        if(method==='method://private_conference/hwm/getRenderWindowInfoList')return require('electron').ipcRenderer.invoke('render-proof-request',params);
        if(method==='method://pedestal/getToken')return {crypt_token:'fixture-local-token'};
        if(method==='method://pedestal/getEnvInfo')return {middleEndAddress:'render-verifier.invalid'};
        if(method==='method://conference/getUsgToken')return btoa('fixture-usg-token');
        if(method==='method://pedestal/getSystemProxyOverride')return '';
        throw Error('Unexpected consumer method '+method);
      }};
    window.coreRsHttp={uploadFile:async request=>{
      if(!request.url.startsWith('https://render-verifier.invalid/'))throw Error('No production upload is permitted');
      const bytes=require('fs').readFileSync(request.filePath),boundary='render-proof-boundary';
      const body=Buffer.concat([Buffer.from('--'+boundary+'\\r\\nContent-Disposition: form-data; name="file"; filename="picture.png"\\r\\nContent-Type: image/png\\r\\n\\r\\n'),bytes,Buffer.from('\\r\\n--'+boundary+'--\\r\\n')]);
      proofUploads.push({filePath:request.filePath,url:request.url,bytes:bytes.length});
      const response=await fetch(${JSON.stringify(base)}+new URL(request.url).pathname,{method:'POST',headers:{'Content-Type':'multipart/form-data; boundary='+boundary},body});
      const data=await response.text();
      if(window.proofChangeDuringUpload){proofNoteStore.noteId='different-note';window.proofChangeDuringUpload=false}
      request.resultCallback({param:{ret:0,rsp_body:{rsp_code:response.status,rsp_msg:data}}});
    }};
    const cache={12:f},factories=${JSON.stringify(campus.helpers)};
    function load(id){if(cache[id])return cache[id];const module={exports:{}};cache[id]=module.exports;(0,eval)('('+factories[id]+')')(module,module.exports,load);return module.exports}
    load.d=(exports,key,get)=>Object.defineProperty(exports,key,{enumerable:true,get});
    const _=load(90),ce=load(87),h=load(383);
    const Q=${campus.Q};
    window.proofMe=${campus.me};
    window.proofNoteRequest=()=>__welinkRenderNotes.request({Pedestal,getContext:nativeNoteContext,insert:proofMe,notify:value=>proofNotices.push(value)});
    window.proofFocus=()=>{const editor=editors[0];editor.focus();editor.selection.select(editor.getBody(),true);editor.selection.collapse(false)};
    proofFocus();return true;
  })()`, note);
}
async function verify() {
  assert.equal(process.env.WELINK_RENDER_TEST_DISPLAY,'1','refusing native-dialog automation outside an explicitly isolated Xvfb display');
  assert(process.env.DISPLAY && app?.whenReady, 'Electron/X11 is required');
  for(const filename of ['meeting_render_host.js','meeting_render_notes.js','meeting_render_windows.js'])assert(fs.statSync(native(filename)).isFile());
  const campus=extractCampus();
  await app.whenReady();
  temp=fs.mkdtempSync(path.join(os.tmpdir(),'welink-render-proof-'));
  await installMedia();
  const {captureRenderWindows}=require(native('meeting_render_host.js'));
  const {MeetingNativeWeb,PROTOCOL}=require(native('meeting_native_web.js'));
  const rawBroker=Object.create(MeetingNativeWeb.prototype);
  rawBroker.callPage=()=>{throw Error('A direct broker call must not reach raw frame capture')};
  for(const operation of ['render.inspect','render.capture']) {
    const denied=await rawBroker.handle({protocol:PROTOCOL,id:'unapproved-'+operation,operation,params:{sessionKey:'fixture-room-1'}});
    assert.equal(denied.ok,false);assert.equal(denied.error.code,'UNSUPPORTED_OPERATION');assert.equal(denied.data,undefined);
  }
  checked('direct registered broker render calls cannot reach the renderer or return pixels');
  const bridge=new EventEmitter();bridge.window=meeting;bridge.ready=true;
  bridge.callPage=mediaOperation;bridge.renderForHost=MeetingNativeWeb.prototype.renderForHost;
  const record={bridge,paths:{screenshots:temp},hostFiles:new Set(),hostCleanupErrors:[]};
  let owner=true,dialogAction={},dialogs=0;
  const deps={nativeImage,requireOwner:()=>{if(!owner)throw error('OWNER_UNAVAILABLE')},renderData:(_record,op,params)=>bridge.renderForHost(op,params),
    dialogScope:(_record,signal)=>({signal,release(){}}),
    chooseNativeFile:async(_record,method,settings,signal)=>{
      dialogs++;const action=dialogAction;dialogAction={};
      const automation=driveFileDialog(action);
      const selected=await Promise.race([dialog[method](meeting,{...settings,title:'Render snapshot verifier'}),
        new Promise(resolve=>signal.addEventListener('abort',()=>resolve({canceled:true}),{once:true})),
        new Promise((_,reject)=>setTimeout(()=>reject(Error('Native save dialog did not complete')),30000))]);
      await automation;if(action.afterSelection)await action.afterSelection(selected);return selected;
    }};
  const invoke=params=>captureRenderWindows(record,params,deps);
  owner=false;await expectCode(()=>invoke({isSavePic:true}),'OWNER_UNAVAILABLE');owner=true;
  assert.equal(dialogs,0);checked('retired owner cannot enumerate or save render media');
  const listed=await invoke({isSavePic:false});
  assert.equal(dialogs,0);assert.equal(listed.nativeHandleSupported,false);assert.equal(listed.targets.length,2);
  assert.equal(listed.filePath,'');assert.equal(listed.selectedTargetIds.length,1);
  for(const target of listed.targets) {
    assert(target.sourceSize.width>0&&target.sourceSize.height>0,'a receiver decoded a real frame');
    assert(target.sourceSize.width<=640&&target.sourceSize.height<=360,'no CSS/upscaled dimensions are used as source resolution');
  }
  assert.equal(listed.devicePixelRatio,1.5);
  assert.equal(fs.readdirSync(temp).length,0);checked('metadata-only has no dialog, image encoding or file side effects');
  await page('window.proofShotPolicy=1');await expectCode(()=>invoke({isSavePic:true}),'SCREENSHOT_FORBIDDEN');
  await page('window.proofShotPolicy=undefined');await expectCode(()=>invoke({isSavePic:true}),'SCREENSHOT_POLICY_UNKNOWN');
  assert.equal(dialogs,0);assert.equal(fs.readdirSync(temp).length,0);await page('window.proofShotPolicy=0');
  checked('forbidden and unconfirmed screenshot policy open no dialog and create no file');
  const saved=await invoke({isSavePic:true,conferenceId:'fixture-conference'});
  assert.equal(saved.status,'saved');
  const selectedSource=saved.targets.find(target=>target.id===saved.selectedTargetIds[0]);
  assert.deepEqual(saved.size,selectedSource.sourceSize,'PNG preserves the observed receiver frame size, not the requested sender resolution');
  proof.mediaSize={enumerated:listed.targets.map(target=>target.sourceSize),saved:saved.size};
  const bytes=fs.readFileSync(saved.filePath);assert.equal(bytes.length,saved.save.bytesWritten);
  assert.equal(fs.statSync(saved.filePath).mode&0o777,0o600);
  const bitmap=nativeImage.createFromBuffer(bytes).toBitmap();
  let green=0,blue=0,watermarkPixels=0;
  for(let i=0;i<bitmap.length;i+=4){const b=bitmap[i],g=bitmap[i+1],r=bitmap[i+2];if(g>220&&r<30&&b<30)green++;if(b>110&&r<80&&g<130)blue++;if(Math.abs(r-g)<20&&Math.abs(g-b)<20&&r>60&&r<210)watermarkPixels++}
  assert.equal(green,0,'neither the green desktop-overlapping window nor page background entered the PNG');
  assert(blue>saved.size.width*saved.size.height/2&&watermarkPixels>200,'real shared-content pixels and rendered watermark are present');
  checked('actual native Save, 0600 durable PNG, shared-content selection, watermark, zoom/overlap isolation');
  const inbound=await page(`Promise.all(proofPeers.map(async p=>Array.from((await p.receiver.getStats()).values()).filter(s=>s.type==='inbound-rtp').map(s=>({bytesReceived:s.bytesReceived,framesDecoded:s.framesDecoded}))))`);
  assert(inbound.flat().every(s=>s.bytesReceived>0&&s.framesDecoded>0));proof.rtp=inbound;checked('real loopback RTP decoded by Electron');
  const count=()=>fs.readdirSync(temp).length;
  let before=count();dialogAction={cancel:true};const canceled=await invoke({isSavePic:true});
  assert.equal(canceled.status,'canceled');assert.equal(canceled.filePath,'');assert.equal(count(),before);checked('native Cancel creates no file');
  dialogAction={beforeAccept:()=>page("proofState.sessionKey='fixture-room-2'")};
  await expectCode(()=>invoke({isSavePic:true}),'CONFERENCE_CHANGED');assert.equal(count(),before);checked('room switch while save dialog is open rejects before writing');
  dialogAction={beforeAccept:()=>page("proofWatermark.configure({content:'CHANGED POLICY',color:'#999999'})")};
  await expectCode(()=>invoke({isSavePic:true}),'RENDER_POLICY_CHANGED');assert.equal(count(),before);checked('watermark revision change rejects stale capture');
  dialogAction={beforeAccept:()=>page('window.proofShotPolicy=1')};
  await expectCode(()=>invoke({isSavePic:true}),'SCREENSHOT_FORBIDDEN');assert.equal(count(),before);
  await page('window.proofShotPolicy=0');checked('host screenshot prohibition during the save dialog prevents any file publication');
  let collision;
  dialogAction={afterSelection:selected=>{collision=selected.filePath;fs.writeFileSync(collision,'existing-file',{flag:'wx'});}};
  await expectCode(()=>invoke({isSavePic:true}),'EEXIST');assert.equal(read(collision),'existing-file');checked('exclusive save never replaces an existing file');
  const Facade=facadeMethods(),service=new Facade(),broadcasts=[];
  service.bridge={registration:true,intent:1,generation:1,callRegistered:(op,params)=>{assert.equal(op,'host.render.windows');return invoke(params)}};
  service.Pedestal={sendBroadcast:async(topic,receipt)=>{
    assert.equal(topic,'broadcast://private_conference/hwm/onGetRenderWindowInfoListResult');broadcasts.push(receipt);
    if(note&&!note.isDestroyed())await page(`window.__welinkRenderNotes.receive(${JSON.stringify(receipt)})`,note);
  }};
  ipcMain.handle('render-proof-request',(_event,params)=>service.getRenderWindowInfo(params));
  const dialogsBeforeInvalid=dialogs;
  const invalid=await service.getRenderWindowInfo({isSavePic:true,filePath:'/unrequested.png'});
  assert.equal(invalid.param.reason_code,'INVALID_ARGUMENT');assert.equal(dialogs,dialogsBeforeInvalid);
  service.bridge.registration=false;
  const unregistered=await service.getRenderWindowInfo({isSavePic:true});
  assert.equal(unregistered.param.reason_code,'NOT_IN_CONFERENCE');assert.equal(dialogs,dialogsBeforeInvalid);
  service.bridge.registration=true;checked('no arbitrary destination inputs or implicit registration/authentication');
  await page('proofState.joined=false');
  const noMeeting=await service.getRenderWindowInfo({isSavePic:true,requestId:'absent-room'});
  assert.notEqual(noMeeting.result,0);assert.equal(noMeeting.param.reason_code,'NOT_IN_CONFERENCE');assert.equal(noMeeting.param.filePath,'');
  assert.equal(broadcasts.at(-1).notify,1039);checked('no-meeting returns a coherent failure broadcast, never an ACK-only success');
  await page('proofState.joined=true;proofCamera.style.display="none";proofShare.style.display="none"');
  const noMedia=await service.getRenderWindowInfo({isSavePic:true,requestId:'absent-media'});
  assert.equal(noMedia.param.reason_code,'NO_RENDER_MEDIA');assert.equal(noMedia.param.filePath,'');checked('audio-only/no rendered video has no saved picture');
  await page('proofCamera.style.display="";proofShare.style.display=""');
  const local=await localServer();await installConsumer(campus,local.base);
  const beforeSharing={dialogs,files:count(),uploads:local.uploads()};
  await page('proofState.localSharing=true');
  const sharingBlocked=await page('proofNoteRequest()',note);
  assert.equal(sharingBlocked.param.reason_code,'LOCAL_SHARING_ACTIVE');assert.equal(sharingBlocked.param.filePath,'');
  assert.equal(dialogs,beforeSharing.dialogs);assert.equal(count(),beforeSharing.files);assert.equal(local.uploads(),beforeSharing.uploads);
  assert.equal(await page('tinymce.activeEditor.getBody().querySelectorAll("img").length',note),0);
  await page('proofState.localSharing=false');
  checked('local sharing blocks note save before the dialog, file creation or upload; remote shared content remains eligible');
  const noteResult=await page('proofNoteRequest()',note);
  assert.equal(noteResult.result,0);assert.equal(noteResult.noteInsertion.completed,true);assert.equal(local.uploads(),1);
  await page('Promise.all(Array.from(tinymce.activeEditor.getBody().querySelectorAll("img"),image=>image.decode()))',note);
  assert.equal(await page('tinymce.activeEditor.getBody().querySelector("img").naturalWidth',note),noteResult.param.size.width);
  assert.equal(await page('tinymce.activeEditor.getBody().querySelectorAll("img").length',note),1);
  assert.equal(await page('tinymce.activeEditor.getBody().querySelector("img").getAttribute("width")',note),'240');
  checked('exact packaged me -> original module383 upload -> actual TinyMCE cursor image');
  await page('proofNoteStore.isStartAI=true;tinymce.activeEditor.setContent("<div class=wrap-div id=ai-wrap><p>Transcript</p></div>");proofNoteStore.wrapId="ai-wrap";proofFocus()',note);
  const aiResult=await page('proofNoteRequest()',note);
  assert.equal(aiResult.result,0);assert.equal(local.uploads(),2);
  await page('Promise.all(Array.from(tinymce.activeEditor.getBody().querySelectorAll("img"),image=>image.decode()))',note);
  assert.equal(await page('!!document.getElementById("ai-wrap").nextElementSibling.querySelector("img")',note),true);
  checked('exact packaged me AI-wrap insertion and original Q cursor dispatch');
  const images=await page('tinymce.activeEditor.getBody().querySelectorAll("img").length',note);
  await page('proofChangeDuringUpload=true;proofFocus()',note);
  const stale=await page('proofNoteRequest()',note);
  assert.equal(stale.param.reason_code,'NOTE_CONTEXT_CHANGED');assert.equal(local.uploads(),3);
  assert.equal(await page('tinymce.activeEditor.getBody().querySelectorAll("img").length',note),images);
  checked('note change during genuine local upload blocks stale insertion');
  await page(`__welinkRenderNotes.receive(${JSON.stringify(noteResult)})`,note);
  assert.equal(local.uploads(),3);checked('late/duplicate/unrequested broadcasts cannot upload an arbitrary path');
  await page('proofPeers.forEach(p=>{p.sender.close();p.receiver.close();p.source.getTracks().forEach(t=>t.stop())});proofTimers.forEach(clearInterval);proofState.sources=[]');
  await expectCode(()=>invoke({isSavePic:true}),'NO_RENDER_MEDIA');checked('track teardown removes render targets');
  assert.equal(record.hostFiles.size,0);assert.deepEqual(record.hostCleanupErrors,[]);
  proof.outputDirectory=temp;proof.savedPicture=saved.filePath;
  console.log(JSON.stringify(proof,null,2));
}
verify().then(()=>{for(const win of [note,obscurer,meeting])if(win&&!win.isDestroyed())win.destroy();server?.close();app.exit(0);},cause=>{
  console.error(cause.stack||cause);for(const win of [note,obscurer,meeting])if(win&&!win.isDestroyed())win.destroy();server?.close();app.exit(1);
});
