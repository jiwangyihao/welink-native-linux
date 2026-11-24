'use strict';

const path = require('node:path');
const { randomBytes } = require('node:crypto');
const ORIGIN = 'https://css-complain-drcn.platform.dbankcloud.cn';
const STATIC = 'https://h5hosting-drcn.dbankcdn.cn';
const SUBMIT = '/api/v2/h5/complaints/submit';
const CAP = 'HWM_SDK_CAPABILITY_SUPPORT_COMPLAIN';
const fail = (code, message) => Object.assign(new Error(message), { code });
const invalid = () => fail('COMPLAINT_CONTEXT_CHANGED', '会议、账号或选中的参会者已更改');
const plain = (v, max = 512) => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(v);

// HwmComplainInfo is a notification to the integrator, not a submission result.
// The campus app's contact-detail -> ui://basic/complain uses the official ACCOUNT
// report category (1/1), appId 5006134617, reporter account as deviceId, no AT.
// Name the category accurately: not chat history, a meeting recording, or a
// made-up conference subSceneId. Include only the fields disclosed in the dialog.
function formContext(target, reporter) {
  if (!plain(target?.userUuid) || !plain(target?.conferenceID) || !plain(target?.sessionKey) ||
      !plain(reporter?.account) || reporter.account === target.userUuid || !target.reportable)
    throw invalid();
  const text = (v,limit) => plain(v,limit) ? v : '';
  return { appId:'5006134617', deviceId:reporter.account, accessToken:'', sceneId:'1', subSceneId:'1',
    additionalContext:{ complaintAccountId:target.userUuid, complaintAccountName:text(target.displayName,256),
      complaintAccountProfileURL:'', complaintAccountAvatar:'', tenantId:text(reporter.tenantId,256),
      tenantName:text(reporter.tenantName,256), conferenceID:target.conferenceID, confSubject:text(target.subject,512) } };
}

// Only a binary-built main-process caller may specify a test endpoint. Production
// always uses ORIGIN; renderer input never chooses a URL, account or HTTP headers.
function createMeetingComplaints({ electron, getContext, isCurrent, confirm, onResult, testOrigin }) {
  const origin=testOrigin || ORIGIN;
  if (testOrigin && !/^https:\/\/127\.0\.0\.1:[0-9]+$/.test(testOrigin)) throw new TypeError('Tests require loopback HTTPS');
  let enabled=true, attempt=null, last=null;
  function status() { return {type:12, capability:CAP, scope:'authenticated-roster-participant-report', enabled,
    state:attempt?'open':last?.state||'idle', serverAccepted:last?.state==='accepted',
    category:'participant-account-in-meeting', serverPermissionGranted:false, osPermissionGranted:false}; }
  function finish(a,state,code) {
    if (!a || attempt!==a) return;
    attempt=null;
    const receipt={state,code,serverAccepted:state==='accepted',requestId:a.id,
      source:'official-complaint-service',category:'participant-account-in-meeting'};
    last=receipt;
    a.clean();
    if (a.win && !a.win.isDestroyed()) a.win.destroy();
    a.resolve(receipt); if(onResult) onResult(receipt);
  }
  function cancel(code='COMPLAINT_CANCELLED') { if(attempt)finish(attempt,'cancelled',code); }
  function configure(value) {
    if(typeof value!=='boolean')throw fail('INVALID_ARGUMENT','举报开关必须是布尔值');
    enabled=value;if(!value)cancel('NATIVE_CAPABILITY_DISABLED');
    return {...status(),configured:true};
  }
  async function open({parent,target,verify}) {
    if (!enabled) throw fail('NATIVE_CAPABILITY_DISABLED','此客户端已关闭会议内举报');
    if (attempt) throw fail('COMPLAINT_BUSY','已有一个举报窗口');
    const a={id:randomBytes(16).toString('hex'),win:null,clean() {},resolve:null};
    const done=new Promise(resolve=>{a.resolve=resolve;});attempt=a;last=null;
    const valid=()=>attempt===a && enabled && !parent.isDestroyed() && isCurrent();
    const check=async()=>{if(!valid() || !await verify() || !valid())throw invalid();};
    try {
      await check();const reporter=await getContext();await check();
      if (reporter.disabled===true) throw fail('COMPLAINT_TENANT_DISABLED','当前租户已关闭投诉举报');
      const data=formContext(target,reporter);
      const title=data.additionalContext.complaintAccountName||target.userUuid;
      const yes=await confirm({type:'question',title:'举报当前会议的参会者',
        message:'打开官方审核表单，举报参会者「'+title+'」的账号？',
        detail:'将向华为官方审核服务提供举报人账号、被举报人账号及名称、租户和本场会议编号、主题。不会自动发送聊天记录、截图、录音或会议令牌。只有你在表单内提交后才会发送举报。',
        buttons:['取消','打开官方举报表单'],defaultId:0,cancelId:0});
      await check();if(!yes){finish(a,'cancelled','USER_CANCELLED');return done;}
      const { BrowserWindow, ipcMain }=electron,sess=electron.session.fromPartition('wl-report-'+a.id);
      const channel='welink-report-'+a.id;
      const win=a.win=new BrowserWindow({parent,modal:true,show:false,width:800,height:660,title:'举报参会者 · 官方审核服务',
        webPreferences:{session:sess,preload:path.join(__dirname,'meeting_complaint_preload.js'),additionalArguments:['--welink-report='+a.id],
          sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,webviewTag:false,devTools:false}});
      const wc=win.webContents,dbg=wc.debugger;
      win.setMenu(null);wc.setWindowOpenHandler(()=>({action:'deny'}));
      sess.setPermissionRequestHandler((_wc,_p,cb)=>cb(false));sess.setPermissionCheckHandler(()=>false);
      sess.on('will-download',event=>event.preventDefault());
      let used=false, observing=false, formSuccess=false, responseOK=false, requestId=null, cancelled=false, completing=false;
      const parse=value=>{try{return new URL(value);}catch{return null;}};
      const same=url=>{const u=parse(url);return !!u && u.origin===origin && !u.username && !u.password;};
      const samePage=evt=>valid() && evt.sender===wc && evt.senderFrame && evt.senderFrame===wc.mainFrame && same(evt.senderFrame.url);
      const isSubmit=url=>same(url) && parse(url).pathname===SUBMIT;
      const retire=()=>finish(a,'cancelled','COMPLAINT_CONTEXT_CHANGED');
      async function maybeComplete(){
        if(!responseOK||!formSuccess||completing||!valid())return;
        completing=true;try{await check();finish(a,'accepted','SERVICE_ACCEPTED');}catch{retire();}
      }
      async function verifyReporter() {
        await check();
        const currentReporter = await getContext();
        await check();
        if (currentReporter?.account !== reporter.account || currentReporter.disabled) throw invalid();
      }
      async function init(evt) {
        if (!samePage(evt) || used) return null;
        used = true;
        await verifyReporter();
        return samePage(evt) ? JSON.stringify(data) : null;
      }
      function submitted(evt){if(samePage(evt)&&requestId){formSuccess=true;void maybeComplete();}}
      function network(_event,method,p){
        if (!valid() || cancelled) return;
        if (method==='Network.requestWillBeSent' && p.request?.method==='POST' && isSubmit(p.request.url)) {
          requestId=p.requestId; responseOK=false;formSuccess=false;completing=false;
        } else if (requestId && p.requestId===requestId) {
          if (method==='Network.responseReceived') a.httpOK=isSubmit(p.response.url) && p.response.status>=200 && p.response.status<300;
          if (method==='Network.loadingFailed') { a.httpOK=false;requestId=null; }
          if (method==='Network.loadingFinished' && a.httpOK && p.encodedDataLength<=262144) {
            const id=requestId; a.httpOK=false;
            // Examine only the matched submit RESPONSE, never read a complaint,
            // attachment, session token, or any other request/response body.
            dbg.sendCommand('Network.getResponseBody',{requestId:id}).then(r=>{
              if(!valid()||requestId!==id||typeof r.body!=='string'||r.body.length>350000)return;
              const body=JSON.parse(r.base64Encoded?Buffer.from(r.body,'base64').toString('utf8'):r.body);
              responseOK=body?.code==='0';if(responseOK)void maybeComplete();
              else { last={state:'rejected',serverAccepted:false};formSuccess=false; }
            }).catch(()=>{});
          }
        }
      }
      sess.webRequest.onBeforeRequest((details,cb)=>{
        const u=parse(details.url); const local=u && ['data:','blob:'].includes(u.protocol) && details.resourceType!=='mainFrame';
        const asset=u && u.origin===STATIC && u.pathname.startsWith('/sandbox/cc/WiseSupport/complainh5next-production/') && details.method==='GET' && details.resourceType!=='mainFrame';
        if(!valid()||!u||(!same(u.href)&&!asset&&!local))return cb({cancel:true});
        if(same(u.href)&&details.method==='POST' && (u.pathname===SUBMIT || u.pathname==='/api/v2/h5/complaints/attachments')) {
          if (!observing || !used) return cb({cancel:true});
          return verifyReporter().then(()=>cb({cancel:false}),()=>{cb({cancel:true});retire();});
        }
        cb({cancel:false});
      });
      ipcMain.handle(channel+'-init',init);ipcMain.on(channel+'-done',submitted);
      const leaving=(ev,url)=>{if(!same(url)){ev.preventDefault();retire();}};
      wc.on('will-navigate',leaving);wc.on('will-redirect',leaving);wc.on('will-attach-webview',ev=>ev.preventDefault());
      win.once('closed',()=>finish(a,last?.state==='rejected'?'rejected':'cancelled',last?.state==='rejected'?'SERVICE_REJECTED':'FORM_CLOSED'));
      wc.once('render-process-gone',()=>finish(a,'failed','REPORT_RENDERER_GONE'));
      a.clean=()=>{cancelled=true;ipcMain.removeHandler(channel+'-init');ipcMain.removeListener(channel+'-done',submitted);
        dbg.removeListener('message',network);if(dbg.isAttached())dbg.detach();sess.webRequest.onBeforeRequest(null);
        sess.closeAllConnections().catch(()=>{});sess.clearStorageData().catch(()=>{});};
      await check(); await win.loadURL(origin+'/?lang='+(reporter.language==='en-US'?'en-us':'zh-cn'));
      dbg.attach('1.3');dbg.on('message',network);await dbg.sendCommand('Network.enable');
      observing = true;
      await check(); if(!same(wc.getURL()))throw invalid();win.show();
    } catch (err) { if(attempt===a) finish(a,'failed',err.code||'REPORT_FORM_FAILED'); }
    return done;
  }
  return Object.freeze({open,cancel,configure,status});
}
module.exports={createMeetingComplaints,formContext};
