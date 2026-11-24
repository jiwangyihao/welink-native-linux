#!/usr/bin/env electron
'use strict';

// Run the packaged owner, preload, WebRTC router, resolver and Axios in an
// isolated Electron profile. Only the origin's HTTP responses are fixtures.
const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const electron = require('electron');
const { app } = electron;
const native = process.env.WELINK_TEST_NATIVE, www = process.env.WELINK_TEST_WWW;
if (![native, www].every(p => p && path.isAbsolute(p))) throw Error('Set absolute WELINK_TEST_NATIVE and WELINK_TEST_WWW paths');
const { MeetingNativeWeb, PROTOCOL } = require(path.join(native, 'meeting_native_web.js'));
const source = 'https://meeting.invalid';
const resolver = '/v1/mmc/management/conferences/anonymous/clientParams';
const token = 'qa+opaque/part=%2B&tail==';
const refused = 'QA.SIGNED_LINK_REFUSED';
const profile = fs.mkdtempSync(path.join(os.tmpdir(),'wl-signed-link-'));
const requests = [], absent = new Set(), transitions = [];
let engineReady = false, permissions = 0, joinEvents = 0;
app.setPath('userData', profile);
app.on('window-all-closed', () => {});
function summarize() {
  return {engineReady, resolverRequests:requests.length, permissions, joinEvents,
    unservedPaths:[...absent].slice(0,18), transitions:transitions.slice(-8)};
}
async function run() {
  await app.whenReady();
  const owner = new MeetingNativeWeb({electron,origin:source,requestPermission:async()=>{ ++permissions; return false; }});
  owner.on('engine', m=>{if(m.event==='engine-ready') engineReady=true;});
  owner.on('event', m=>{if(m.event==='meeting-lifecycle' && m.data?.state==='joined') ++joinEvents;});
  app.on('session-created',local=>local.protocol.interceptBufferProtocol('https',(req,reply)=>{
    const u=new URL(req.url);
    if(u.origin!==source) return reply({error:-10});
    if(req.method==='GET' && u.pathname.startsWith('/webrtc/')) {
      const name=u.pathname.slice('/webrtc/'.length)||'index.html';
      const f=path.resolve(www,name);
      if(f.startsWith(www+path.sep) && fs.existsSync(f) && fs.statSync(f).isFile()) {
        const mime={'.js':'application/javascript','.css':'text/css','.html':'text/html'}[path.extname(f)] || 'application/octet-stream';
        return reply({mimeType:mime,data:fs.readFileSync(f)});
      }
    }
    if(req.method==='POST' && u.pathname===resolver) {
      const data=Buffer.concat((req.uploadData||[]).map(v=>v.bytes||Buffer.alloc(0)));
      try { requests.push(JSON.parse(data.toString('utf8'))); } catch { requests.push(null); }
      return reply({statusCode:200,mimeType:'application/json',data:Buffer.from(JSON.stringify({error_code:refused,error_msg:'Deliberate local refusal'}))});
    }
    absent.add(u.pathname);
    return reply({statusCode:404,mimeType:'application/json',data:Buffer.from('{"error_code":"QA.NO_ROUTE"}')});
  }));
  app.on('web-contents-created',(_ev,contents)=>{
    contents.on('did-navigate-in-page',(_e,href)=>{
      const u=new URL(href);transitions.push(u.hash.split(/[?#]/)[1]?.split('/').slice(0,2).join('/') || u.pathname);
    });
  });
  // Drive the same policy operations as the desktop app; setting the owner's
  // approval flags would skip both DOM enforcement and the replay on /j.
  for (const [operation,params] of [
    ['watermark.set',{content:'QA guest',color:'#999999'}],
    ['ui.configure',{isUserLogined:false,customButtonStatus:null}]
  ]) {
    const applied=await owner.handle({protocol:PROTOCOL,id:operation,operation,params});
    assert.equal(applied.ok,true,JSON.stringify({operation,error:applied.error?.code}));
  }
  const result = await owner.handle({protocol:PROTOCOL,id:'signed-link-rejection',operation:'conference.joinLink',params:{
    site_url:source+'/conferences?route=A%2FB',idPrefix:'QA-SITE',confId:'000000001',random:token,isOfflineJoin:false
  }});
  assert.equal(requests.length,1,JSON.stringify({code:result.error?.code,...summarize()}));
  assert.equal(requests[0]?.random,token,'Opaque issuer ticket changed before reaching the vendor resolver');
  assert(!('idPrefix' in requests[0]) && !('confId' in requests[0]),'Unexpected caller-provided resolution key');
  assert.equal(result.ok,false);assert.equal(result.error?.code,refused,JSON.stringify({code:result.error?.code,...summarize()}));
  assert.equal(permissions,0);assert.equal(joinEvents,0);assert.equal(engineReady,true);
  console.log('SIGNED_LINK_PROVIDER '+JSON.stringify({build:JSON.parse(fs.readFileSync(path.join(native,'build.json'))).build,
    ticketExact:true,serverError:result.error.code,network:'isolated protocol fixture',...summarize()}));
}
const deadline=setTimeout(()=>{console.error('Signed-link provider deadline '+JSON.stringify(summarize()));app.exit(2);},85000);
run().then(()=>{clearTimeout(deadline);app.exit(0);},err=>{clearTimeout(deadline);console.error(err.stack||err);console.error(JSON.stringify(summarize()));app.exit(1);});
app.once('quit',()=>fs.rmSync(profile,{recursive:true,force:true}));
