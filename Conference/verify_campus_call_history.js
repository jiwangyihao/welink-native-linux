#!/usr/bin/env electron
'use strict';
// Replay observed P2P_PEER_RECEIPTS records through the two pinned campus
// history handlers, their original DB loader/CRUD code and the sealed ia32 FFI.
// Only the campus environment, contact lookups and unavailable remote sync are
// fixtures. No real user profile, credential, network request or call is used.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { app, BrowserWindow } = require('electron');
const acorn = require(process.env.WELINK_TEST_ACORN || 'acorn');
const native = process.env.WELINK_TEST_NATIVE;
assert(native && path.isAbsolute(native));
const appRoot = path.dirname(native), dir = path.join(appRoot, 'plugin/conference/dist');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-native-history-'));
app.setPath('userData', path.join(root, 'profile'));
const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'records.json'), 'utf8'));
assert(fixtures.peerAnswered && fixtures.incomingAnswered && fixtures.exactOnce);
const read = name => fs.readFileSync(path.join(dir, 'js', name), 'utf8');
const service = read('hwmService.js'), campus = read('bundle.js');
function expression(text, marker) {
  const start = text.indexOf(marker);
  assert(start !== -1 && start === text.lastIndexOf(marker), 'Unrecognized packaged history handler: ' + marker);
  const parsed = acorn.parseExpressionAt(text, start + marker.length, { ecmaVersion: 'latest' });
  const n = parsed.type === 'SequenceExpression' ? parsed.expressions[0] : parsed;
  assert.equal(n.type, 'ArrowFunctionExpression');
  return text.slice(n.start, n.end);
}
// Keep the callback converter, broadcast consumer, and its DB command bus
// verbatim. The minified binding names are release-pinned (as in the packager).
const fieldMarker = 'const{endTime:i,isCallEstablished:r,isCallOut:d';
const converterStart = service.lastIndexOf('u=async e=>', service.indexOf(fieldMarker)) + 2;
const converter = service.slice(converterStart, acorn.parseExpressionAt(service, converterStart, {ecmaVersion:'latest'}).end);
assert(converter.includes('broadcast://private_conference/hwm/p2pConfRecordChange'));
const consume = expression(campus, '"broadcast://private_conference/hwm/p2pConfRecordChange":');
const register = expression(service, 's.a.setNotifyFunc(33,');
const loader = campus.indexOf('let uo=coreLogger.getLogger("dllManager")');
const first = campus.lastIndexOf('function lo(e,t)', loader);
const last = campus.indexOf(',Uo=n(366);', loader);
assert(first >= 0 && first < loader && last > loader);
const store = campus.slice(first, last) + ';';
for (const symbol of ['conference_db_init','conference_db_send_msg','conference_db_single_add_callrecord','conference_db_query_callrecord']) assert(store.includes(symbol));
const sync = expression(campus, 'const Ho=coreLogger.getLogger("logic")("callRecord.api"),Fo=');
const json = JSON.stringify;
async function run() {
  await app.whenReady();
  const w = new BrowserWindow({show:false, webPreferences:{nodeIntegration:true, contextIsolation:false, sandbox:false}});
  w.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']}, (_req, cb) => cb({cancel:true}));
  const page = path.join(root, 'service.html'); fs.writeFileSync(page, '<!doctype html><meta charset="utf-8"><title>Isolated conference history</title>');
  try {
    await w.loadFile(page);
    const stored = await w.webContents.executeJavaScript(`(async () => {
      const root=${json(root)}, uuid='synthetic-history-user', rows=${json(fixtures.records)};
      const a=require('node:assert/strict'),path=require('node:path'), env={ffiPath:${json(path.join(appRoot,'libraries/node_extends/node-ffi/ffi-napi'))}};
      window.__dirname=${json(dir)};
      const n = id => { a.equal(id,92); return path; }, so={a:()=>process.platform==='darwin'};
      const trace=()=>{},logger={debug:trace,info:trace,error:trace,warn:trace},coreLogger={getLogger:()=>()=>logger};
      const coreOsApi={setOsEnvPath:p=>a.equal(path.resolve(p),path.dirname(window.__dirname))};
      const On={a:x=>x},s=On,m=On,D=logger,o=logger,cr=logger,Ho=logger,ir='meeting_pc_p2p_callRecord_add';
      const isNullOrEmpty=x=>x===null||x===undefined||x==='',handleLocalPath=x=>x;
      let seq=0;const Sno=()=>++seq;
      function PromiseObject(){let resolve,reject;const p=new Promise((yes,no)=>{resolve=yes;reject=no});p.resolve=resolve;p.reject=reject;return p;}
      const persisted=[];let nextRow,remoteCalls=0;
      const Uo={b:async()=>({middleEndAddress:'127.0.0.1',crypt_token:''})};
      const coreRsHttp={middleGroundPost:async request=>{a.equal(request.message,'addCallRecordApi');++remoteCalls;return {result:false};}};
      const Pedestal={appdataRootPath:root,logRootPath:path.join(root,'logs'), async callMethod(key){
        switch(key){case 'method://pedestal/getEnvInfo': return env;
          case 'method://pedestal/getCurrLoginStatus':return {loginIntent:true,uuid};
          case 'method://contact/getContactByAccount':case 'method://contact/getContactByCallNumber':return {};
          case 'method://conference/getUsgToken':return '';
          case 'method://hwaUt/addHwaUtData':return;
          default:throw Error('Unexpected campus method '+key);}},sendBroadcast(key,data){
        if(key==='broadcast://private_conference/hwm/p2pConfRecordChange')return consume(data);
        a.equal(key,'broadcast://conference/callRecordChange');persisted.push(data);nextRow();}};
      ${store}
      const Fo=(${sync}), y={d:(${converter})}, notify=(${register}), consume=(${consume});
      Yo.init();await Promise.resolve();await xo({uuid});
      for(const row of rows){let timeout;await new Promise((resolve,reject)=>{
        nextRow=()=>{clearTimeout(timeout);resolve()};timeout=setTimeout(()=>reject(Error('No campus history update')),5000);
        notify({notify:33,result:0,param:row});});}
      a.equal(persisted.length,rows.length);a.equal(remoteCalls,rows.length);
      a.equal((await Wo.unInitDB()).result,0);
      a.equal((await Wo.initDB({dbPath:path.join(root,'conference',uuid),kmcStorePath:path.join(root,'conference'),userAccount:uuid})).result,0);
      const result=await Yo.query({all:true,startTime:1000*(Math.max(...rows.map(r=>r.endTime))+1),limitCount:rows.length+1});
      a.equal((await Wo.unInitDB()).result,0);
      return result.sort((l,r)=>l.autoId-r.autoId);
    })()`);
    assert.equal(stored.length, fixtures.records.length);
    fixtures.records.forEach((frame,i)=>{
      const row=stored[i], remote=frame.isCallOut?frame.calleeInfo:frame.callerInfo;
      assert.equal(row.isCallOut,Number(frame.isCallOut));assert.equal(row.callNumber,remote.number||'');
      assert.equal(row.duration,1000*(frame.endTime-frame.startTime));assert.equal(row.startTime,1000*frame.startTime);
      assert.equal(row.isVideo,frame.mediaType);assert.equal(row.exParam.resultCode,frame.resultCode);
      assert.equal(row.exParam.saveServerSuccess,false);
      if(frame.isCallEstablished) {assert.equal(row.isCallSuccess,3);assert.equal(row.exParam.state,1);}
      if(!frame.isCallEstablished && frame.resultCode===undefined) assert.equal(row.exParam.state,6);
    });
    console.log('CAMPUS_CALL_HISTORY '+JSON.stringify({persistedAfterReopen:stored.length, inbound:stored.filter(r=>!r.isCallOut).length,
      outbound:stored.filter(r=>r.isCallOut).length, connected:stored.filter(r=>r.isCallSuccess===3).length, remoteSync:false}));
  } finally {w.destroy();}
}
run().then(()=>app.exit(0),error=>{console.error(error.stack||error);app.exit(1);});
app.once('quit',()=>fs.rmSync(root,{force:true,recursive:true}));
