#!/usr/bin/env electron
'use strict';

// Isolated Electron integration. Only HTTPS responses and the two local campus
// documents are fixtures. The broker, grant, media sessions, WebRTC UI, Axios
// and original callback/terminal error path are the release implementations.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const electron = require('electron');
const { app, BrowserWindow } = electron;
const native = process.env.WELINK_TEST_NATIVE, www = process.env.WELINK_TEST_WWW;
if (![native,www].every(p => p && path.isAbsolute(p))) throw Error('Set absolute test native and vendor asset paths');
const { installMeetingMain } = require(path.join(native,'meeting_main.js'));
const { PROTOCOL } = require(path.join(native,'meeting_native_web.js'));
const guest = 'https://guest.meeting.invalid';
let primary;
const resolver = '/v1/mmc/management/conferences/anonymous/clientParams';
const issuerPath = '/v1/mmc/management/conferences/authConf';
const key = 'QA+%2B/foreign&opaque==', canary = 'only-on-the-account-site';
const confId = '100230045', prefix = 'QA-SITE-B', target = guest+'/next/conferences?route=A%2FB';
const password = 'local-issuer-check';
const params = {site_url:target,random:key,idPrefix:prefix,confId,nick_name:'Guest',isOfflineJoin:false};
const ch = 'welink-native-meeting-v1';
const dir = fs.mkdtempSync(path.join(os.tmpdir(),'wl-guest-origin-'));
const media = new Map(), guestSessions = new Set(), received = [];
let issuerRequests=0, leaked=false, joined=false, serial=0;
app.setPath('userData',path.join(dir,'profile'));
app.on('window-all-closed',()=>{});
function jsonReply(reply, statusCode, data) {
  reply({statusCode,mimeType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},data:Buffer.from(JSON.stringify(data))});
}
function intercept(s) {
  s.protocol.interceptBufferProtocol('https',(req,reply)=>{
    const u=new URL(req.url);
    if (u.origin!==primary && u.origin!==guest) return reply({error:-10});
    if (u.origin===guest && (JSON.stringify(req.headers||{}).includes(canary) ||
          JSON.stringify(Object.keys(req.headers||{})).match(/"(?:X-Auth-Token|X-Access-Token|Authorization)"/i))) leaked=true;
    if (u.pathname === issuerPath) throw Error('The Chromium session must not perform the issuer request');
    if (req.method==='GET' && u.pathname.startsWith('/webrtc/')) {
      const name=u.pathname.slice(8)||'index.html', file=path.resolve(www,name);
      if (file.startsWith(www+path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        if (name==='index.html') {
          if (!media.has(s)) media.set(s,new Set()); media.get(s).add(u.origin);
          if (u.origin===guest) guestSessions.add(s);
        }
        const mime={'.js':'application/javascript','.css':'text/css','.html':'text/html'}[path.extname(file)]||'application/octet-stream';
        return reply({mimeType:mime,data:fs.readFileSync(file)});
      }
    }
    if (req.method==='POST' && u.pathname===resolver) {
      const bytes=Buffer.concat((req.uploadData||[]).map(p=>p.bytes||Buffer.alloc(0)));
      let body;try {body=JSON.parse(bytes.toString('utf8'));} catch {body={};}
      received.push({origin:u.origin,session:s,exact:body.random===key,keys:Object.keys(body)});
      return jsonReply(reply,200,{error_code:'QA.GUEST_REFUSED',error_msg:'Local test refusal'});
    }
    return jsonReply(reply,404,{error_code:'QA.NO_ROUTE'});
  });
}
app.on('session-created',s=>intercept(s));
function doc(filename) {
  const w=new BrowserWindow({show:false,webPreferences:{partition:'qa-campus-local',nodeIntegration:true,contextIsolation:false,sandbox:false}});
  return w.loadFile(filename).then(()=>w);
}
function ipc(w,env) {
  return w.webContents.executeJavaScript(`require('electron').ipcRenderer.invoke(${JSON.stringify(ch)},${JSON.stringify(env)})`);
}
async function nativeIssuer() {
  const https = require('https'), http = require('http'), net = require('net');
  const { execFileSync } = require('child_process');
  const cert = label => {
    const crt = path.join(dir,label+'.crt'), priv = path.join(dir,label+'.key');
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN='+label,
      '-addext','subjectAltName=DNS:account.meeting.invalid','-keyout',priv,'-out',crt],{stdio:'ignore'});
    return { crt, priv };
  };
  const trusted = cert('local-issuer'), wrong = cert('other-authority');
  const listen = server => new Promise((resolve,reject) => {
    server.once('error',reject); server.listen(0,'127.0.0.1',()=>resolve(server.address().port));
  });
  const state = { mode:'success', connections:0, userAgent:null };
  const tls = https.createServer({cert:fs.readFileSync(trusted.crt),key:fs.readFileSync(trusted.priv)},(req,res)=>{
    assert.equal(req.method,'GET'); assert.equal(req.url,issuerPath+'?conferenceID='+confId);
    assert.equal(req.headers['x-password'],password); assert.equal(req.headers['user-agent'],state.userAgent);
    for (const h of ['authorization','cookie','x-auth-token','x-access-token','proxy-authorization']) assert.equal(req.headers[h],undefined);
    issuerRequests++;
    if (state.mode==='redirect') { res.writeHead(302,{Location:guest+issuerPath}); res.end(); return; }
    res.writeHead(200,{'Content-Type':'application/json',Connection:'close'});
    res.end(JSON.stringify(state.mode==='deny'?{code:40901,message:'test refusal'}:{siteUrl:target,random:key,idPrefix:prefix}));
  });
  const tlsPort=await listen(tls); primary='https://account.meeting.invalid:'+tlsPort;
  const proxy=http.createServer();
  proxy.on('connect',(req,client,head)=>{
    assert.equal(req.url,new URL(primary).host); state.connections++;
    const upstream=net.connect(tlsPort,'127.0.0.1',()=>{
      client.write('HTTP/1.1 200 Connection established\r\n\r\n');
      if (head.length) upstream.write(head); upstream.pipe(client); client.pipe(upstream);
    });
    const close=()=>{upstream.destroy();client.destroy();};
    client.on('error',close);upstream.on('error',close);client.on('close',close);upstream.on('close',close);
  });
  const proxyPort=await listen(proxy);
  return { state, wrongCA:wrong.crt, env:{proxyAddress:'127.0.0.1',proxyPort,caCertPath:trusted.crt},
    close:()=>{tls.close();proxy.close();} };
}
async function run(){
  await app.whenReady();
  const fixture=await nativeIssuer();
  const root=path.join(dir,'campus'), docs=path.join(root,'plugin/conference/dist');
  fs.mkdirSync(docs,{recursive:true});
  fs.symlinkSync(native,path.join(root,'native'));
  fs.symlinkSync(path.join(path.dirname(native),'libraries'),path.join(root,'libraries'));
  fs.copyFileSync(path.join(path.dirname(native),'plugin/conference/config.json'),path.join(root,'plugin/conference/config.json'));
  fs.mkdirSync(path.join(dir,'logs'),{mode:0o700});
  const page = name=>path.join(docs,name);
  for(const name of ['hwmService.html','index.html','other.html']) fs.writeFileSync(page(name),'<!doctype html><meta charset=utf-8><title>Local QA</title>');
  const stop=installMeetingMain({electron,appRoot:root});
  const issuer=await doc(page('index.html')),service=await doc(page('hwmService.html')),other=await doc(page('other.html'));
  issuer.webContents.setUserAgent('LocalInvitation/40'); service.webContents.setUserAgent('LocalService/40');
  fixture.state.userAgent=issuer.webContents.getUserAgent()+' WeLink/Mac/7.40.1/conference';
  const input={kind:'resolve-invitation',confId,password,expectedPrefix:prefix,joinType:'online'};
  const issue=()=>ipc(issuer,input);
  const configuration={origin:primary,envInfo:fixture.env,appInfo:{appVersionName:'7.40',appVersionCode:1}};
  const setConfig=c=>service.webContents.executeJavaScript(`window.qaConfig=${JSON.stringify(c)};true`);
  const call=(operation,p={})=>ipc(service,{kind:'call',message:{protocol:PROTOCOL,id:++serial,operation,params:p}});
  const join=(p=params)=>call('conference.joinLink',p);
  await setConfig(configuration);
  await service.webContents.executeJavaScript(`const {ipcRenderer}=require('electron');ipcRenderer.on(${JSON.stringify(ch+'-token-request')},(_e,r)=>ipcRenderer.send(${JSON.stringify(ch+'-token-reply')},{id:r.id,token:${JSON.stringify(canary)}}));ipcRenderer.on(${JSON.stringify(ch+'-event')},(_e,r)=>{if(r.message?.event==='meeting-lifecycle'&&r.message?.data?.state==='joined')window.qaJoined=true});true`);
  await service.webContents.executeJavaScript(`ipcRenderer.on(${JSON.stringify(ch+'-config-request')},(_e,r)=>ipcRenderer.send(${JSON.stringify(ch+'-config-reply')},{id:r.id,config:r.purpose==='issuer'?window.qaConfig:null}));true`);
  await ipc(service,{kind:'register',origin:primary,sdkLogDirectory:path.join(dir,'logs','conference','HwmSdk')});
  for (const [op,val] of [['watermark.set',{content:'QA guest',color:'#999999'}],['ui.configure',{isUserLogined:false,customButtonStatus:null}]]) {
    const r=await call(op,val);assert.equal(r.ok,true,JSON.stringify(r.error));
  }
  const accountSession=[...media].find(([,origins])=>origins.has(primary))?.[0];assert(accountSession,'initial policy is not in the primary browser');
  await accountSession.cookies.set({url:primary,domain:'.meeting.invalid',name:'qaAccountCookie',value:canary,secure:true});
  async function denied(p){const before=received.length, windows=guestSessions.size;const r=await join(p);assert.equal(r.ok,false);assert.notEqual(r.error.code,'QA.GUEST_REFUSED');assert.equal(received.length,before);assert.equal(guestSessions.size,windows);}
  await denied({...params,issuer:primary,trusted:true});
  assert.equal((await ipc(other,input)).ok,false); await denied(params);
  await assert.rejects(ipc(issuer,{kind:'issued-site',issuer:primary,params})); await denied(params);
  await setConfig({...configuration,fuseInfo:{module:{blackList:['conference']}}});
  const fused=await issue(); assert.equal(fused.response.code,-1001); assert.equal(fixture.state.connections,0);
  await setConfig({...configuration,envInfo:{...fixture.env,caCertPath:fixture.wrongCA}});
  const untrusted=await issue(); assert.equal(untrusted.ok,false); assert.equal(issuerRequests,0); await denied(params);
  await setConfig({...configuration,fuseInfo:{module:{blackList:['hwmService']}}});
  fixture.state.mode='redirect'; const redirect=await issue(); assert.equal(redirect.error?.code,'ISSUER_REDIRECT_UNAVAILABLE'); await denied(params);
  fixture.state.mode='deny'; const refused=await issue(); assert.equal(refused.response.result,false); assert.equal(refused.response.code,40901); await denied(params);
  fixture.state.mode='success'; assert.equal((await issue()).response.result,true); await issuer.loadFile(page('index.html')); await denied(params);
  assert.equal((await issue()).response.recv_body.random,key); await denied({...params,random:key+'x'});
  const accepted=await join();assert.equal(accepted.error?.code,'QA.GUEST_REFUSED',JSON.stringify(accepted.error));assert.equal(accepted.ok,false);
  assert.equal(received.length,1);assert.equal(received[0].origin,guest);assert(received[0].exact);assert(!received[0].keys.includes('confId') && !received[0].keys.includes('idPrefix'));
  assert.notEqual(accountSession,received[0].session);assert.equal(leaked,false);assert(![...media.values()].some(origins=>origins.size>1));
  await denied(params);
  const primaryReply=await join({...params,site_url:primary+'/conferences'});assert.equal(primaryReply.error?.code,'QA.GUEST_REFUSED',JSON.stringify(primaryReply.error));
  assert.equal(received.length,2);assert.equal(received[1].origin,primary);assert(received[1].exact);assert.notEqual(received[1].session,received[0].session);
  joined=await service.webContents.executeJavaScript('window.qaJoined===true');assert.equal(joined,false);assert.equal(issuerRequests,4);
  const closed=await stop();assert(closed.every(x=>x.reply?.ok && x.reply.hostCleanup?.complete));
  fixture.close();
  for (const w of [issuer,service,other]) w.destroy();
  console.log('GUEST_SITE_PROVIDER '+JSON.stringify({build:JSON.parse(fs.readFileSync(path.join(native,'build.json'))).build,issuerRequests,guestPosts:1,primaryPosts:1,sourceRestored:true,unissuedAndReplayBlocked:true,navigationInvalidated:true,ticketsExact:true,accountCredentialsSentToGuest:false,joined}));
}
const deadline=setTimeout(()=>{console.error('Guest-site integration deadline');app.exit(2);},90000);
run().then(()=>{clearTimeout(deadline);app.exit(0);},err=>{clearTimeout(deadline);console.error(err.stack||err);app.exit(1);});
app.once('quit',()=>fs.rmSync(dir,{recursive:true,force:true}));
