'use strict';

const fs = require('fs');
const path = require('path');

function adapterError(message, result = -1, code) {
  const error = new Error(message);
  error.result = result;
  if (code) error.code = code;
  return error;
}
function requireSuccess(response, operation) {
  if (!response || !Number.isInteger(response.result)) throw adapterError(`${operation}: missing provider response`);
  if (response.result !== 0) throw adapterError(response.resultDes || response.param && response.param.reason ||
    `${operation} failed (${response.result})`, response.result);
  return response;
}

function createForwarder({ modules, check, complete, notify, ffiRuntime }) {
  let offlineGeneration = 0;
  const offlineWaiters = new Set();
  if (ffiRuntime) {
    for (const event of ['start', 'stop']) ffiRuntime.onLifecycle(event, name => {
      if (name !== 'tup_offlinefile_logic_api') return;
      ++offlineGeneration;
      for (const reject of offlineWaiters) reject(adapterError('Offline-file session changed', -1, 'EOFFLINE'));
    });
  }
  async function offlineWait(context, promise, generation = offlineGeneration) {
    if (generation !== offlineGeneration) throw adapterError('Offline-file session changed', -1, 'EOFFLINE');
    let rejectStop;
    const stopped = new Promise((_resolve, reject) => { rejectStop = reject; });
    offlineWaiters.add(rejectStop);
    try { return await context.wait(Promise.race([promise, stopped])); }
    finally { offlineWaiters.delete(rejectStop); }
  }
  function vendor(context) {
    check(context);
    const requireModule = modules();
    const registry = requireModule(36067).default;
    const state = requireModule(83691).$imState();
    const account = state.account.uuid;
    const sqlite = registry.getInstance('sqliteService');
    if (!account || context.account !== account || sqlite.currentAccount !== account) {
      throw adapterError('The account SQLite service is not initialized');
    }
    return { registry, state, account, db: registry.getInstance('tupSqlite'),
      im: registry.getInstance('tupIm'), convert: requireModule(2891),
      constants: requireModule(54589), storage: requireModule(51936), ui: requireModule(43420),
      content: requireModule(66704).default, helpers: requireModule(4096),
      parse: requireModule(22644), paths: requireModule(43671),
      send: requireModule(31117), messagePolicy: requireModule(27646),
      messageCard: requireModule(91202).default, names: requireModule(5722),
      ids: requireModule(67810), html: requireModule(71989), escape: requireModule(49758),
      sensitive: requireModule(96464), media: registry.getInstance('mediaService'),
      offlineService: registry.getInstance('offlineFileService'),
      offline: registry.getInstance('tupOfflineFile'), events: requireModule(41512).default };
  }
  async function sql(context, operation) {
    check(context);
    const result = requireSuccess(await context.wait(operation()), 'SQLite');
    check(context);
    return result;
  }
  async function rateLimit(context) {
    const param = context.request.param;
    if (!param || typeof param !== 'object' || Array.isArray(param)) throw adapterError('param is not correct!');
    // This is the original adapter's genuine no-op for a missing list, not a
    // successful mutation. Command 154 implements the same sliding limiter.
    if (!Array.isArray(param.msgList)) {
      complete(context, 0, typeof param.currentTimestamp === 'string' ? { currentTimestamp: param.currentTimestamp } : null);
      return;
    }
    const v = vendor(context);
    const response = await sql(context, () => v.db._service({ cmd: 154,
      description: 'tup_adapter_group_chat_limit', param }, 154));
    complete(context, 0, response.param);
  }
  async function records(context, v, ids) {
    if (ids.some(id => typeof id !== 'string' || !id)) throw adapterError('msgIdList is empty');
    const type = v.storage.HISTORYRECORD_TYPE.HISTORYRECORD_MESSAGEID;
    const response = await sql(context, () => v.db.queryhistoryrecord(type,
      [{ keytype: type, match_value: ids.join(',') }], 1));
    const rows = response.param && response.param._historyrecordlist;
    if (!Array.isArray(rows) || !rows.length) throw adapterError('QueryHistoryRecordByMsgId is empty');
    const messages = await context.wait(v.convert.convertMessage2JsList(rows));
    check(context);
    return messages;
  }
  async function hydrate(context, v, original, options) {
    // Use the matched parser's exported, non-UI consumers. In particular,
    // parseCard recognizes quoted/combined cards and parseUm recovers files
    // from history rows whose FILELIST was not populated.
    const message = { ...original, isAppMsg: 0 };
    const type = v.constants.CHATCONTENTTYPE;
    if (message.chatContentType === type.CARD) {
      message.cardInfo = await context.wait(v.parse.parseCard(message));
      check(context);
    } else if (message.chatContentType === type.OUT_SHAR) {
      const parsed = v.parse.parseOutShare(message);
      if (parsed) Object.assign(message, parsed);
    }
    message.isAppMsg = original.isAppMsg;
    if (!message.fileList || !message.fileList.length) {
      const parsed = v.content.parse(message.content);
      message.fileList = v.parse.parseUm(parsed.content, message.chatContentType, message.msgId);
    }
    const files = [];
    for (const originalFile of message.fileList || []) {
      check(context);
      const file = { ...originalFile };
      const filename = String(file.file_real_save_name || file.file_name || '').replace(/[\\/]/g, '#');
      if (!filename || filename === '.' || filename === '..') throw adapterError('Invalid media filename');
      const mediaType = file.file_type === 'Img' ? type.IMAGE : message.chatContentType;
      const image = mediaType === type.IMAGE || mediaType === type.IMAGE_TEXT;
      const roots = image ? [options.customizeImagePath, options.defaultImagePath] :
        [options.customizeFilePath, options.defaultFilePath];
      const candidates = [file.file_real_save_path,
        ...roots.filter(root => typeof root === 'string' && path.isAbsolute(root))
          .map(root => path.join(root, image ? 'ScreenShot' : '', filename)),
        v.parse.getFileSavePathByChatContentType(filename, mediaType)];
      let realPath;
      for (const candidate of candidates) {
        if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) continue;
        if (await fs.promises.stat(candidate).then(stat => stat.isFile(), () => false)) {
          realPath = candidate;
          break;
        }
        check(context);
      }
      check(context);
      file.file_real_save_path = realPath || candidates[candidates.length - 1];
      const fullSize = image ? v.paths.getOriginalPathByFileName(filename) : file.file_path;
      file.file_path = typeof fullSize === 'string' && path.isAbsolute(fullSize) &&
        await fs.promises.stat(fullSize).then(stat => stat.isFile(), () => false) ?
        fullSize : file.file_real_save_path;
      check(context);
      files.push(file);
    }
    return { ...message, fileList: files };
  }
  function offlineRequest(context, v, request, generation, accepted) {
    check(context);
    return offlineWait(context, new Promise((resolve, reject) => {
      v.offline.ffiCallback.set(request, response => {
        try { accepted(response); resolve(response); }
        catch (error) { reject(error); }
      });
    }), generation);
  }
  async function upload(context, v, file, options) {
    check(context);
    const generation = offlineGeneration;
    if (context.offlineReadyGeneration !== generation) {
      // Keep the real shared login service's SSO, TLS, proxy and KIA policy.
      // No synthetic token, disabled detector, or unprotected provider is used.
      await offlineWait(context, v.offlineService.umServerLogin(), generation);
      check(context);
      context.offlineReadyGeneration = generation;
    }
    const filePath = file.file_real_save_path || file.file_path;
    if (!filePath || !(await fs.promises.stat(filePath)).isFile()) throw adapterError('Local media file is unavailable');
    check(context);
    let handle = null;
    let settled = false;
    let finished = false;
    const early = [];
    let resolveEnd, rejectEnd;
    const end = new Promise((resolve, reject) => { resolveEnd = resolve; rejectEnd = reject; });
    // Install before enqueueing; a fast native transfer may notify in the same
    // pump turn as its acceptance. Never discard that genuine completion.
    function onEnd(message) {
      if (settled) return;
      if (handle === null) { early.push(message); return; }
      if (message.param && message.param.file_handle === handle) {
        settled = true;
        resolveEnd(message);
      }
    }
    function release() {
      if (handle === null || generation !== offlineGeneration) return;
      const owned = handle;
      handle = null;
      v.offline.ffiCallback.set({ cmd: 589834, description: 'tup_offlinefile_release',
        param: { file_handle: owned } }, () => {});
    }
    function accepted(response) {
      if (generation !== offlineGeneration || !response || response.result !== 0) return;
      const owned = response.param && response.param.pfile_handle;
      if (!Number.isInteger(owned)) return;
      // Capture ownership in the raw callback, even when the cancellable
      // acceptance wait has already rejected and its finally block has run.
      handle = owned;
      if (finished || context.signal.aborted) release();
    }
    function abort() {
      if (!settled) {
        settled = true;
        rejectEnd(adapterError('Media transfer cancelled', -1, 'ECANCELED'));
      }
      release();
    }
    // Attach a rejection handler immediately, including the acceptance phase.
    end.catch(() => {});
    v.events.on('offlineFile_result', onEnd);
    context.signal.addEventListener('abort', abort, { once: true });
    try {
      const response = await offlineRequest(context, v, { cmd: 589830,
        description: 'tup_offlinefile_uploadfile', param: { up_file_info: {
          delete_file: true, file_type: '', file_name: file.file_real_save_name || file.file_name || path.basename(filePath),
          resume_down_url: '', resume_file_id: file.resumeFileId || '', resume_md5: file.resumeMd5 || '',
          resume_up_url: file.resumeUpUrl || '', resume_signature: '',
          use_svn_file: !!(file.use_svn_file || file.buse_svn_file), operation_token: '', group_id: '',
          public_share_link: options.publicShareLink || 0, is_cross_instance: options.isCrossInstance ? 1 : 0,
          file_path: filePath } } }, generation, accepted);
      requireSuccess(response, 'Media upload');
      if (!Number.isInteger(handle)) throw adapterError('Media upload returned no transfer handle');
      check(context);
      for (const message of early) onEnd(message);
      early.length = 0;
      const result = await offlineWait(context, end, generation);
      check(context);
      const responseFile = result.param && result.param.filersp;
      if (!result.param || result.param.code !== 0 || !responseFile || responseFile.status_code !== 200) {
        throw adapterError(responseFile && responseFile.code_msg || 'Media upload failed',
          result.param && result.param.code || responseFile && responseFile.status_code || -1);
      }
      if (!responseFile.url || typeof responseFile.plain_access_code !== 'string') throw adapterError('Incomplete media upload result');
      return { ...file, um_url: responseFile.url, um_plain_access_code: responseFile.plain_access_code, expire: 0 };
    } finally {
      finished = true;
      context.signal.removeEventListener('abort', abort);
      v.events.removeListener('offlineFile_result', onEnd);
      release();
    }
  }
  function linkRequest(context, v, file, update) {
    check(context);
    const date = new Date().toUTCString();
    const linkCode = file.um_url.split('/').pop();
    const login = v.state.loginConfig;
    const token = window.isRedblue ? login.middle_ground_onebox_cookie : login.cloud_disk_token;
    const kind = v.ui.HTTP_E_REQ_TYPE;
    // These are mediaService's exact headers/URLs, sent directly by its real
    // owner-thread transport instead of re-entering it through renderer IPC.
    return context.wait(v.im.httpRequest({
      url: `https://${login.onebox_address}/api/v2/links/${update ? 'forward' : 'node'}`,
      type: update ? kind.HTTP_E_REQ_TYPE_PUT : kind.HTTP_E_REQ_TYPE_GET,
      body: {}, header: [
        { name: 'Authorization', value: v.media.getAuthorization(linkCode, date, file.um_plain_access_code) },
        { name: 'x-usertoken', value: token }, { name: 'Date', value: date },
        { name: 'Content-Type', value: 'application/json' }, { name: 'charset', value: 'UTF-8' }
      ]
    }));
  }
  async function prepareMedia(context, v, message, options, combined) {
    if (!message.fileList || !message.fileList.length) return message;
    const type = v.constants.CHATCONTENTTYPE;
    const files = [];
    let changed = false;
    for (const original of message.fileList) {
      check(context);
      let file = { ...original };
      let expired = !!Number(file.expire) || !file.um_url;
      if (!expired && v.media.localMediaExpire(message)) {
        const result = await linkRequest(context, v, file, false);
        check(context);
        requireSuccess(result, 'Media expiry lookup');
        const status = result.param && result.param.resp_code;
        if (status === 404) expired = true;
        else if (status !== 200) throw adapterError(`Media expiry lookup failed (${status})`, status || -1);
      }
      if (expired) {
        const local = file.file_real_save_path || file.file_path;
        const available = local && await fs.promises.stat(local).then(stat => stat.isFile(), () => false);
        check(context);
        if (!available || !v.helpers.isMediaStatusCanForward(message.status, message.chatContentType)) {
          if (!combined) throw adapterError('status cannot forward or local file does not exist', -1, 'ESKIP');
          file.expire = 1;
        } else {
          try { file = await upload(context, v, file, options); }
          catch (error) {
            check(context);
            if (combined) throw error;
            error.code = 'ESKIP';
            throw error;
          }
        }
        changed = true;
      } else if (file.um_url) {
        const result = await linkRequest(context, v, file, true);
        check(context);
        requireSuccess(result, 'Forward file link');
        const status = result.param && result.param.resp_code;
        if (!(status >= 200 && status < 300)) throw adapterError(`Forward file link failed (${status})`, status || -1);
      }
      files.push(file);
    }
    const result = { ...message, fileList: files };
    if (changed) {
      let content;
      if (message.chatContentType === type.VIDEO && files.length >= 2) content = v.content.buildVideoUm(files);
      else if (message.chatContentType === type.FILE || message.chatContentType === type.IMAGE) content = v.content.buildFileUm(files[0]);
      else if (message.chatContentType === type.IMAGE_TEXT) {
        const parsed = v.content.parse(message.content);
        content = parsed && parsed.content || '';
        content = content.replace(/\/:um_begin\{(.*?)\}\/:um_end/g, (token, body) => {
          const index = message.fileList.findIndex(file => file.um_url === body.split('|')[0]);
          return index < 0 ? token : v.content.buildFileUm(files[index]);
        });
        result.content = v.content.build({ content, html: parsed && parsed.html || '' });
      }
      if (content !== undefined && message.chatContentType !== type.IMAGE_TEXT) {
        result.content = v.content.build({ content: v.html.transformHtml(content) });
      }
    }
    return result;
  }
  function transform(v, original, options) {
    let message = { ...original, chatAtInfo: undefined, receiptState: 0 };
    if (message.quote) {
      const parsed = v.content.parse(message.content);
      const card = JSON.parse(parsed.content);
      const content = card.cardContext && card.cardContext.replyMsg && card.cardContext.replyMsg.content || '';
      message.content = v.content.build({ content: v.html.transformHtml(content), html: parsed.html || '' });
      message.quote = undefined;
    }
    message.isAppMsg = 0;
    if (window.isRedblue && message.chatContentType === v.constants.CHATCONTENTTYPE.CARD) {
      message.appServiceId = ''; message.appServiceName = '';
    }
    if (message.msgExt) {
      try { if (Number(JSON.parse(message.msgExt).appServiceTag) === 1) message.msgExt = ''; } catch (_) {}
    }
    if (message.cardInfo && message.cardInfo.cardType === v.ui.CARD_TYPE.MESSAGE_CARD) message = v.messageCard(message);
    Object.assign(message, { showTranslate: '', translateLang: '', providerCn: '', providerEn: '', translateNum: 0,
      isShowTranslate: false, sendStatus: v.storage.SEND_STATUS.sending, userAccount: v.account,
      senderNativeName: v.names.getChineseNameByAccount(v.account), senderName: v.names.getEnNameByAccount(v.account),
      clientMsgId: v.ids.getMsgId(), msgId: undefined, emojiReply: undefined, id: '', isRead: 1,
      serverSendTime: String(Date.now()), timestamp: String(Date.now()), multiSelected: false, receiptCount: 0,
      recentOwner: options.groupId || options.receiverAccount, groupId: options.groupId || '',
      receiverAccount: options.groupId ? '' : options.receiverAccount,
      chatType: options.groupId ? v.constants.CHATTYPE.GROUP_CHAT : v.constants.CHATTYPE.P2P_CHAT });
    if (message.fileList) message.fileList = message.fileList.map(file => ({ ...file,
      message_server_chat_id_str: message.clientMsgId, recent_owner: message.recentOwner }));
    return message;
  }
  async function store(context, v, message) {
    const record = v.convert.convertMessage2SqLite(message, v.account);
    if (!record) throw adapterError('Message record conversion failed');
    const response = await sql(context, () => v.db.addhistoryrecord(record));
    const id = response.param && response.param.recordId;
    if (id === undefined || id === null || id === '') throw adapterError('SQLite returned no stored record ID');
    message.id = id;
    record.recordid = id;
    return record;
  }
  async function send(context, v, message, record) {
    check(context);
    let response;
    try {
      const isGroup = !!message.groupId;
      const blocked = await context.wait(v.sensitive.checkMsgContainSensWord({ chatContentType: message.chatContentType,
        showText: message.showText || '', isGroup, shouldNotSendUt: true }));
      check(context);
      if (blocked) response = { result: v.ui.ERROR_IM_CHAT_CODE.SENSITIVE_MSG, clientMsgId: message.clientMsgId };
      else {
        const data = { clientMsgId: message.clientMsgId, chatInfo: message };
        response = await context.wait(isGroup ? v.im.GroupChat(data) : v.im.UserChat(data));
        check(context);
        if (!response || !Number.isInteger(response.result)) throw adapterError('IM transport returned no result');
      }
    } catch (error) {
      check(context);
      response = { result: Number.isInteger(error.result) ? error.result : -1,
        resultDes: error.message, clientMsgId: message.clientMsgId };
    }
    notify(context, { notify: 331776, description: 'AppendMsgNotify', param: {
      ...response, clientMsgId: response.clientMsgId || message.clientMsgId, message: record } });
  }
  async function forward(context) {
    const options = context.request.param;
    if (!options || typeof options !== 'object') throw adapterError('param is empty');
    if (!Array.isArray(options.msgIdList) || !options.msgIdList.length) throw adapterError('msgIdList is empty');
    if (typeof options.userAccount !== 'string' || !options.userAccount) throw adapterError('userAccount is empty');
    if (!options.groupId && !options.receiverAccount) throw adapterError('groupId and receiverAccount are empty');
    const v = vendor(context);
    if (options.userAccount !== v.account) throw adapterError('Forwarding account does not match the active account');
    const source = await records(context, v, options.msgIdList);
    const prepared = [];
    for (const original of source) {
      if (!original || original.isDelete || original.iswithdraw ||
          v.messagePolicy.isSpecialMsg(original) || original.showText === '***Private Message***') continue;
      const message = await hydrate(context, v, original, options);
      if (context.operation === 2 && message.chatContentType === v.constants.CHATCONTENTTYPE.VOICE) {
        prepared.push(message);
        continue;
      }
      try { prepared.push(await prepareMedia(context, v, message, options, context.operation === 2)); }
      catch (error) { if (error.code !== 'ESKIP') throw error; }
    }
    if (!prepared.length) {
      if (context.operation === 2) throw adapterError('No forwardable messages');
      // The original loop skips forbidden/unavailable messages and returns
      // an empty parameter, not an invented set of successfully sent records.
      complete(context, 0, null);
      return;
    }
    const outgoing = [];
    if (context.operation === 2) {
      const first = prepared[0];
      const preview = await context.wait(v.helpers.updatePreviewMsg({ messages: prepared,
        toInfo: { rcId: first.recentOwner, rcType: first.chatType }, limitLevel: true,
        isExpiredNeedUpload: false, isUpdateStore: false }));
      check(context);
      if (!preview.cardInfo) throw adapterError('Combined-message nesting limit exceeded');
      let text = v.escape.escapeXSS(JSON.stringify(preview.cardInfo));
      if (window.isRedblue) text = text.replace(/\u2060&#x2f;.{2}/g, match => match.replace('&#x2f;', '\\&#x2f;'));
      const built = await context.wait(v.send.buildMessage({ content: v.content.build({ content: text }),
        chatContentType: v.constants.CHATCONTENTTYPE.CARD,
        groupId: options.groupId || undefined, receiverAccount: options.receiverAccount || undefined }));
      check(context);
      outgoing.push({ ...built.chatInfo, isRead: 1, cardType: preview.cardInfo.cardType,
        cardInfo: preview.cardInfo, combineMessageFileList: preview.combineMessageFileList });
    } else {
      for (const message of prepared) {
        const built = await context.wait(v.send.buildMessage(transform(v, message, options)));
        check(context);
        outgoing.push(built.chatInfo);
      }
    }
    const stored = [];
    for (const message of outgoing) stored.push(await store(context, v, message));
    if (!complete(context, 0, context.operation === 2 ? { newMsg: stored[0] } : { newMsgList: stored })) return;
    if (options.isOnlySaveLocal === 1) return;
    // Keep this activity registered after the storage acknowledgement. Shutdown
    // and cancel(0, epoch) must still stop uploads/sends and suppress late notify.
    for (let i = 0; i < outgoing.length; ++i) await send(context, v, outgoing[i], stored[i]);
  }
  return { forward, rateLimit };
}

module.exports = { createForwarder, adapterError, requireSuccess };
