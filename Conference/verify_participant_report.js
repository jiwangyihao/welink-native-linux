// Run only in the private Xvfb and loopback network namespace. No production accounts or requests.
'use strict';
const {app, BrowserWindow, dialog} = require('electron');
const electron = require('electron'), https = require('https'), fs = require('fs'), os = require('os');
const path = require('path'), assert = require('assert/strict'), crypto = require('crypto');
const {execFileSync, execFile} = require('child_process');
const run = require('util').promisify(execFile);
const native = process.env.WELINK_TEST_NATIVE, output = process.env.WELINK_REPORT_QA_OUTPUT;
if (!native || !output || process.env.WELINK_REPORT_QA !== 'isolated') throw Error('An isolated test launcher is required');
const {createMeetingComplaints} = require(path.join(native, 'meeting_complaint_host'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-report-'));
app.setPath('userData', path.join(tmp, 'profile')); app.disableHardwareAcceleration();
const sleep = ms => new Promise(r => setTimeout(r,ms));
async function until(fn, message) {
  const end=Date.now()+6500; let value;
  do { if ((value=await fn())) return value; await sleep(40); } while(Date.now()<end);
  throw Error('Timed out: '+message);
}
const form = `<!doctype html><meta charset="utf-8"><title>QA report loading</title>
<h1>Isolated participant report</h1><p id="status"></p><form><button type="submit">Submit test report</button></form>
<script>(async()=>{try {
 const bridge=window.complainJSInterface, info=JSON.parse(await bridge.complainAddInfo());
 const button=document.querySelector('button');
 document.querySelector('form').onsubmit=async e=>{e.preventDefault();button.disabled=true;
   const r=await fetch('/api/v2/h5/complaints/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(info)});
   const reply=await r.json(); if(r.ok && reply.code==='0') bridge.afterSubmit(JSON.stringify({type:'afterSubmit'}));
   else {document.querySelector('#status').textContent='Rejected'; document.title='QA report rejected';}
 };
 button.focus();document.title='QA report ready';
 }catch(e){document.title='QA report init failed: '+e.message}})()</script>`;
const selected={reportable:true,sessionKey:'qa-room-session',conferenceID:'qa-local-room',userUuid:'qa-subject',displayName:'Selected QA attendee'};
const reporter={account:'qa-reporter',disabled:false,language:'en-US'};
let origin, fingerprint, server, parent, live=true, authorizedTarget=true, policy, mode='success';
let attempts=0;const received=[], results=[];
const trace = (event, detail = '') => console.log('REPORT_TRACE', event, detail);
app.on('browser-window-created', (_e, win) => {
  const wc=win.webContents, id=wc.id;
  win.on('show', () => trace('show', id)); win.on('closed', () => trace('closed', id));
  wc.on('did-start-navigation', (_event,url) => trace('navigation', id+' '+url.split('?')[0].slice(0,70)));
  wc.on('did-fail-load', (_event, code, reason) => trace('load-error', id+' '+code+' '+reason));
  wc.on('did-finish-load', () => trace('loaded', id+' '+wc.getTitle()));
  wc.on('preload-error', (_event,_path,err) => trace('preload-error', id+' '+err.message));
  wc.on('page-title-updated', (_event,title) => trace('title', id+' '+title));
  wc.on('render-process-gone', (_event,d) => trace('renderer-gone', id+' '+d.reason));
});
app.on('certificate-error',(e,_wc,url,_reason,cert,cb)=>{
 let ok=false;try{ok=new URL(url).origin===origin && new crypto.X509Certificate(cert.data).fingerprint256===fingerprint;}catch{}
 if(ok)e.preventDefault();cb(ok);
});
const confirm = async options => (await dialog.showMessageBox(parent,{...options,noLink:true})).response===1;
async function answerConfirmation(accept){
 const id=(await run('xdotool',['search','--sync','--onlyvisible','--name','^举报当前会议的参会者$'],{timeout:6500})).stdout.trim().split(/\s+/).pop();
 assert.match(id,/^\d+$/);await run('xdotool',['windowactivate','--sync',id],{timeout:2000});
 await run('xdotool',['key','--clearmodifiers',...(accept?['Right','Return']:['Escape'])]);
}
const opened=()=>policy.open({parent,target:selected,verify:async()=>{
 trace('verify target',authorizedTarget);return authorizedTarget;
}});
async function show(){
 const done=opened(); let early;
 done.then(receipt=>{early=receipt;},error=>{early={code:error.code,message:error.message};});
 await answerConfirmation(true);
 const win=await until(()=>{
   if (early) throw Error('Report closed before displaying the form: '+JSON.stringify(early));
   const w=BrowserWindow.getAllWindows().find(v=>v!==parent);
   if(w?.webContents.getTitle().includes('init failed')) throw Error(w.webContents.getTitle());
   return w?.isVisible() && w.webContents.getTitle()==='QA report ready' && w;},'scoped form initialization');
 return {win,done};
}
async function submit(win) {
  const wc=win.webContents;
  const point=await wc.executeJavaScript(`(() => {
    const b=document.querySelector('button[type=submit]'), r=b.getBoundingClientRect();
    if (b.disabled || !r.width || !r.height) throw Error('Submit button is not available');
    return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)};
  })()`);
  win.focus();wc.focus();
  await until(()=>win.isFocused() && wc.executeJavaScript('document.hasFocus()'),'report input focus');
  for (const type of ['mouseDown','mouseUp']) wc.sendInputEvent({type,...point,button:'left',clickCount:1});
  await until(()=>win.isDestroyed() || wc.executeJavaScript('document.querySelector("button[type=submit]").disabled'),
    'report submission handler');
  trace('submit dispatched',wc.isDestroyed()?'closed':wc.id);
}
async function main(){
 await app.whenReady();
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1','-keyout',path.join(tmp,'key'),'-out',path.join(tmp,'cert')],{stdio:'ignore'});
 const cert=fs.readFileSync(path.join(tmp,'cert')),key=fs.readFileSync(path.join(tmp,'key'));
 fingerprint=new crypto.X509Certificate(cert).fingerprint256;
 server=https.createServer({key,cert},(req,res)=>{
  if(req.method==='GET' && new URL(req.url,'https://localhost').pathname==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(form);return;}
  if(req.method!=='POST'||req.url!=='/api/v2/h5/complaints/submit'){res.writeHead(404);res.end();return;}
  let data='';req.setEncoding('utf8');req.on('data',v=>{data+=v;});req.on('end',()=>{received.push(JSON.parse(data));++attempts;
   trace('local POST', mode+' '+attempts);
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({code:mode==='success'?'0':'E_DENIED'}));});
 });key.fill(0);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='https://127.0.0.1:'+server.address().port;
 parent=new BrowserWindow({width:480,height:320,show:true,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true}});
 await parent.loadURL('data:text/html,<h1>Isolated current meeting</h1>');
 policy=createMeetingComplaints({electron,testOrigin:origin,getContext:async()=>reporter,isCurrent:()=>live,confirm,onResult:r=>results.push(r)});
 const cancelled=opened();await answerConfirmation(false);assert.equal((await cancelled).code,'USER_CANCELLED');assert.equal(attempts,0);
 let f=await show();await submit(f.win);
 await until(()=>attempts===1,'first submission at the HTTPS server');
 await until(()=>results.some(r=>r.serverAccepted),'client receipt matching the server response');
 const accepted=await f.done;
 assert.equal(accepted.state,'accepted');assert.equal(accepted.serverAccepted,true);assert.equal(attempts,1);
 assert.equal(received[0].additionalContext.complaintAccountId,selected.userUuid);assert.equal(received[0].deviceId,reporter.account);
 assert.equal(received[0].additionalContext.conferenceID,selected.conferenceID);assert.equal(received[0].accessToken,'');
 mode='denied';f=await show();await submit(f.win);await until(()=>f.win.webContents.getTitle()==='QA report rejected','business refusal in visible form');
 f.win.close();const denied=await f.done;assert.equal(denied.state,'rejected');assert.equal(denied.serverAccepted,false);assert.equal(attempts,2);
 f=await show();authorizedTarget=false;await submit(f.win);const changed=await f.done;
 assert.equal(changed.serverAccepted,false);assert.equal(changed.code,'COMPLAINT_CONTEXT_CHANGED');assert.equal(attempts,2);
 authorizedTarget=true;f=await show();policy.configure(false);assert.equal((await f.done).serverAccepted,false);
 await assert.rejects(opened(),e=>e.code==='NATIVE_CAPABILITY_DISABLED');assert.equal(attempts,2);
 fs.writeFileSync(output,JSON.stringify({ok:true,scope:'private loopback TLS, synthetic identities; no official reports',posts:attempts,results:results.map(({state,code,serverAccepted})=>({state,code,serverAccepted}))},null,2));console.log('REPORT_RESULT '+output);
}
function exit(code) {
  policy?.cancel();
  for (const win of BrowserWindow.getAllWindows()) if (win!==parent && !win.isDestroyed()) win.destroy();
  if(parent && !parent.isDestroyed()) parent.destroy();
  server?.close();app.exit(code);
}
const watchdog=setTimeout(()=>{console.error('Report verification timed out');exit(1);},50000);
main().then(()=>{clearTimeout(watchdog);exit(0);},e=>{console.error(e.stack||e);exit(1);});
