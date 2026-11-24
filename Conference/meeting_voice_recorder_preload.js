'use strict';

// Isolated, sandboxed preload only. The document has no scripts and receives no
// bridge, Node object, IPC function or voiceprint. Every variable prompt is text.
const { ipcRenderer } = require('electron');
const argument = process.argv.find(value => /^--welink-voice-recorder=[a-f0-9]{32}$/.test(value));
const nonce = argument ? argument.split('=')[1] : null;

if (nonce && window.top === window && window.location.protocol === 'file:' &&
    window.location.pathname.endsWith('/meeting_voice_recorder.html') &&
    !window.location.search && window.location.hash === '#' + nonce) {
  const channel = 'welink-native-voice-recorder-' + nonce;
  window.addEventListener('DOMContentLoaded', () => {
    const recordButton = document.getElementById('voice-record');
    const stopButton = document.getElementById('voice-stop');
    const cancelButton = document.getElementById('voice-cancel');
    const promptsSelect = document.getElementById('voice-prompts');
    const title = document.getElementById('voice-prompt-title');
    const content = document.getElementById('voice-prompt-content');
    const language = document.getElementById('voice-language');
    const consent = document.getElementById('voice-consent');
    const status = document.getElementById('voice-status');
    const duration = document.getElementById('voice-duration');
    const agreeButton = document.getElementById('voice-agree');
    const revokeButton = document.getElementById('voice-revoke');
    const statement = document.getElementById('voice-anonymous-statement');
    const privacy = document.getElementById('voice-privacy');
    let anonymous = false, consentPending = false;
    let ready = false, retired = false, agreed = false, enrollmentAvailable = false, prompts = [], active = null;

    const invoke = message => ipcRenderer.invoke(channel, message);
    const state = (name, text) => { document.body.dataset.voiceState = name; status.textContent = text; };
    const selected = () => prompts[Number(promptsSelect.value)];
    const buttons = () => {
      const prompt = selected();
      recordButton.disabled = !ready || retired || !agreed || !enrollmentAvailable || !!active || !prompt || !prompt.content.trim();
      stopButton.disabled = !active || active.phase !== 'recording';
      promptsSelect.disabled = !ready || retired || !!active || prompts.length < 2;
      agreeButton.disabled = !ready || retired || agreed || !!active || consentPending;
      revokeButton.disabled = !ready || retired || consentPending;
    };
    const displayPrompt = () => {
      const prompt = selected();
      title.textContent = prompt ? prompt.title : '';
      content.textContent = prompt ? prompt.content : '尚未设置朗读文字。';
      language.textContent = prompt && String(prompt.language) ? '文本语言标记：' + String(prompt.language) : '';
      buttons();
    };
    const stopDevices = recording => {
      if (!recording) return;
      if (recording.processor) recording.processor.onaudioprocess = null;
      for (const node of [recording.source, recording.mono, recording.processor, recording.silence]) {
        if (node) { try { node.disconnect(); } catch (_) {} }
      }
      if (recording.stream) {
        for (const track of recording.stream.getTracks()) {
          track.onended = null;
          try { track.stop(); } catch (_) {}
        }
        recording.stream = null;
      }
      if (recording.context) {
        const context = recording.context; recording.context = null;
        try { recording.closing = context.close().catch(() => {}); } catch (_) {}
      }
    };
    const wipe = recording => {
      for (const chunk of recording.chunks) chunk.fill(0);
      recording.chunks.length = 0;
      if (recording.audioBuffer) recording.audioBuffer.getChannelData(0).fill(0);
      if (recording.rendered) recording.rendered.getChannelData(0).fill(0);
      if (recording.pcm) new Uint8Array(recording.pcm).fill(0);
      recording.audioBuffer = null; recording.rendered = null; recording.pcm = null;
    };
    const isCurrent = recording => !retired && active === recording && !recording.cancelled;
    const errorText = code => {
      switch (code) {
        case 'VOICE_CAPTURE_LENGTH_INVALID': return '实际录音不足 5 秒，或超出本地录制上限。请重新连续朗读。';
        case 'VOICE_ENROLLMENT_REJECTED': return '本地原生处理程序未接受本次录音，未保存新声纹。请在安静环境中重新朗读。';
        case 'VOICE_MODEL_UNAVAILABLE': return '本地声纹模型缺失或校验失败，未保存新声纹。请检查客户端安装。';
        case 'VOICE_ENROLLMENT_UNAVAILABLE':
        case 'VOICE_WORKER_UNAVAILABLE': return '本地原生声纹处理程序不可用，未保存声纹。';
        case 'VOICE_WORKER_TIMEOUT': return '本地处理未在限定时间内完成，已停止，未保存新声纹。';
        case 'VOICE_DISABLE_FAILED': return '无法确认旧声纹处理已停止，未开始录音。';
        case 'VOICE_CAPTURE_NOT_ALLOWED': return '需要先在原界面同意声纹声明并配置朗读文字，才能开始录制。';
        case 'VOICE_OPERATION_RETIRED':
        case 'VOICE_CAPTURE_RETIRED':
        case 'VOICE_DOCUMENT_RETIRED': return '本次录制已取消，未提交新声纹。';
        case 'VOICE_ENROLLMENT_FAILED': return '本地声纹处理失败，未确认保存新声纹。';
        default: return '本次本地录制或处理失败，未确认保存新声纹。请重试。';
      }
    };
    const abort = async (recording, text) => {
      if (!recording || recording.cancelled) return;
      recording.cancelled = true;
      stopDevices(recording); wipe(recording);
      if (recording.captureId) {
        try { await invoke({ kind: 'abort', captureId: recording.captureId }); } catch (_) {}
      }
      if (active === recording) {
        active = null;
        if (!retired) { state('error', text); buttons(); }
      }
    };

    const finish = async recording => {
      if (!isCurrent(recording) || recording.phase !== 'recording') return;
      recording.phase = 'processing';
      // Device release happens synchronously, before resampling or any IPC.
      stopDevices(recording);
      state('processing', '麦克风已停止。正在本机重采样并由原生程序检查录音…');
      buttons();
      try {
        if (recording.closing) await recording.closing;
        if (!isCurrent(recording)) return;
        const outputLength = Math.min(160000, Math.floor(recording.total * 16000 / recording.sampleRate));
        if (outputLength < 80000) {
          await abort(recording, errorText('VOICE_CAPTURE_LENGTH_INVALID'));
          return;
        }
        // The browser's Web Audio resampler performs the rate conversion and
        // anti-alias filtering; requesting a device rate or dropping samples
        // is not resampling. Input is the actual live AudioContext rate.
        const offline = new OfflineAudioContext(1, outputLength, 16000);
        const audioBuffer = offline.createBuffer(1, recording.total, recording.sampleRate);
        recording.audioBuffer = audioBuffer;
        const samples = audioBuffer.getChannelData(0);
        let offset = 0;
        for (const chunk of recording.chunks) { samples.set(chunk, offset); offset += chunk.length; chunk.fill(0); }
        recording.chunks.length = 0;
        const source = offline.createBufferSource(); source.buffer = audioBuffer;
        source.connect(offline.destination); source.start(0);
        const rendered = await offline.startRendering(); recording.rendered = rendered;
        source.disconnect(); samples.fill(0);
        if (!isCurrent(recording)) return;
        if (rendered.sampleRate !== 16000 || rendered.length !== outputLength) throw new Error('VOICE_RESAMPLING_FAILED');
        const output = rendered.getChannelData(0), pcm = new ArrayBuffer(output.length * 4);
        recording.pcm = pcm;
        const view = new DataView(pcm);
        for (let index = 0; index < output.length; ++index) {
          const sample = output[index];
          if (!Number.isFinite(sample)) throw new Error('VOICE_CAPTURE_INVALID');
          view.setFloat32(index * 4, Math.max(-1, Math.min(1, sample)), true);
        }
        output.fill(0);
        const receipt = await invoke({ kind: 'finish', captureId: recording.captureId, sampleRate: 16000, samples: pcm });
        if (!isCurrent(recording)) return;
        if (receipt && receipt.ok === true && receipt.enrollmentStored === true) {
          state('enrolled', receipt.activationRequested && receipt.activationSucceeded === false ?
            '声纹已登记，但保护尚未就绪；会议麦克风保持阻止状态。请停用并删除或重试。' :
            anonymous ? (receipt.processing ? '本次匿名会议声纹已登记，会议麦克风正在处理。' :
              '本次会议声纹仅在内存中，保护已预备但尚未处理声音。请在会议中手动打开麦克风，并查看处理状态。') :
              '合格声纹已保存在本机当前账号。麦克风已释放；本窗口不会自动开始新的录音。');
        } else state('error', errorText(receipt && receipt.error));
      } catch (_) {
        if (isCurrent(recording)) await abort(recording, errorText(null));
      } finally {
        stopDevices(recording); wipe(recording);
        if (active === recording) { active = null; if (!retired) buttons(); }
      }
    };

    const start = async event => {
      if (!event.isTrusted || recordButton.disabled || retired || active || !agreed) return;
      const recording = { phase: 'requesting', cancelled: false, captureId: null, context: null, stream: null,
        source: null, mono: null, processor: null, silence: null, closing: null, chunks: [], total: 0,
        sampleRate: 0, audioBuffer: null, rendered: null, pcm: null };
      active = recording;
      duration.textContent = '0.0 / 10.0 秒';
      state('requesting', '正在准备录音。仅本次点击允许申请麦克风权限…');
      buttons();
      try {
        // Resume inside the trusted click. This creates no microphone capture;
        // getUserMedia remains after the main-process consent/owner check.
        const context = new AudioContext(); recording.context = context;
        const resumed = context.resume();
        resumed.catch(() => {});
        const receipt = await invoke({ kind: 'record' });
        if (!receipt || receipt.ok !== true || receipt.captureAuthorized !== true ||
            typeof receipt.captureId !== 'string' || receipt.sampleRate !== 16000 || receipt.maxSamples !== 160000) {
          await abort(recording, errorText(receipt && receipt.error)); return;
        }
        recording.captureId = receipt.captureId;
        if (!isCurrent(recording)) {
          try { await invoke({ kind: 'abort', captureId: recording.captureId }); } catch (_) {}
          return;
        }
        await resumed;
        if (!isCurrent(recording)) return;
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: { ideal: 1 }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
          video: false
        });
        if (!isCurrent(recording)) { for (const track of stream.getTracks()) track.stop(); return; }
        recording.stream = stream;
        if (stream.getVideoTracks().length || stream.getAudioTracks().length !== 1) throw new Error('VOICE_DEVICE_INVALID');
        const started = await invoke({ kind: 'started', captureId: recording.captureId });
        if (!isCurrent(recording)) return;
        if (!started || started.ok !== true) throw new Error('VOICE_CAPTURE_RETIRED');
        recording.sampleRate = context.sampleRate;
        if (!Number.isFinite(recording.sampleRate) || recording.sampleRate < 8000 || recording.sampleRate > 192000)
          throw new Error('VOICE_SAMPLE_RATE_INVALID');
        recording.source = context.createMediaStreamSource(stream);
        recording.mono = context.createGain();
        recording.mono.channelCount = 1; recording.mono.channelCountMode = 'explicit';
        recording.mono.channelInterpretation = 'speakers';
        // ScriptProcessor is confined to this scriptless local window. Its
        // output is silence; only bounded input PCM is retained in memory.
        recording.processor = context.createScriptProcessor(2048, 1, 1);
        recording.silence = context.createGain(); recording.silence.gain.value = 0;
        const maxInput = Math.floor(recording.sampleRate * 10);
        recording.processor.onaudioprocess = audioEvent => {
          audioEvent.outputBuffer.getChannelData(0).fill(0);
          if (!isCurrent(recording) || recording.phase !== 'recording') return;
          const input = audioEvent.inputBuffer.getChannelData(0);
          const count = Math.min(input.length, maxInput - recording.total);
          if (count > 0) { recording.chunks.push(new Float32Array(input.subarray(0, count))); recording.total += count; }
          duration.textContent = (recording.total / recording.sampleRate).toFixed(1) + ' / 10.0 秒';
          if (recording.total >= maxInput) finish(recording);
        };
        stream.getAudioTracks()[0].onended = () => { abort(recording, '麦克风已断开，本次录制未完成。'); };
        recording.phase = 'recording';
        recording.source.connect(recording.mono); recording.mono.connect(recording.processor);
        recording.processor.connect(recording.silence); recording.silence.connect(context.destination);
        state('recording', '正在录音，请朗读所选文字。最多采集 10 秒；点击“停止并提交”可提前停止。');
        buttons();
      } catch (_) {
        if (isCurrent(recording)) await abort(recording, '无法获得或使用麦克风，本次录制未完成。请检查系统权限和设备。');
      } finally {
        if (!isCurrent(recording)) { stopDevices(recording); wipe(recording); }
      }
    };

    const retire = () => {
      if (retired) return;
      retired = true; ready = false;
      if (active) { active.cancelled = true; stopDevices(active); wipe(active); active = null; }
      state('retired', '录制窗口已停用，录音设备已释放。'); buttons();
    };
    const receive = (_event, data) => {
      if (!data || typeof data !== 'object') return;
      if (data.kind === 'retired') { retire(); return; }
      if (data.kind !== 'initialize' || ready || retired || typeof data.isAgreed !== 'boolean' || !Array.isArray(data.readingTextList)) return;
      agreed = data.isAgreed;
      anonymous = data.anonymous === true;
      statement.hidden = !anonymous; agreeButton.hidden = !anonymous; revokeButton.hidden = !anonymous;
      if (anonymous) privacy.textContent = '本次匿名会议独立登记，不会使用账号声纹。打开此窗口已请求保护：登记完成前阻止会议麦克风原声传输。请阅读下方声明；同意后仍需单独点击“开始录制”。';
      enrollmentAvailable = data.enrollmentAvailable === true;
      prompts = data.readingTextList.filter(item => item && typeof item.title === 'string' && typeof item.content === 'string' &&
        (typeof item.language === 'string' || typeof item.language === 'number'));
      for (let index = 0; index < prompts.length; ++index) {
        const option = document.createElement('option'); option.value = String(index);
        option.textContent = prompts[index].title || '朗读文本 ' + (index + 1); promptsSelect.appendChild(option);
      }
      ready = true;
      consent.textContent = anonymous ? (agreed ? '已明确同意本次匿名会议声明。' : '尚未同意。请选择“同意本次会议声明”；打开窗口不代表同意。') :
        agreed ? '已同意当前账号的本机声纹声明。' : '尚未同意声纹声明。请先在原界面明确同意；打开或关闭此窗口不会表示同意。';
      if (!enrollmentAvailable) state('unavailable', '本地声纹登记模型不可用，不会使用麦克风。可以撤销并删除；请求保护时不会回退到原声。');
      else state('ready', data.enrolled ? '已有当前所有者的本地声纹。重新录制会先阻止会议麦克风，只有原生检查成功才替换声纹。' :
        '尚未录音。请选择朗读文本，再点击“开始录制”。');
      displayPrompt();
      cancelButton.focus({ preventScroll: true });
      invoke({ kind: 'ready' }).catch(retire);
    };
    const close = event => {
      if (!event.isTrusted || retired) return;
      retire(); invoke({ kind: 'close' }).catch(() => {});
    };
    const changeConsent = async (event, value) => {
      if (!event.isTrusted || !anonymous || retired || !ready || consentPending || (value && (agreed || active))) return;
      consentPending = true;
      if (!value && active) { active.cancelled = true; stopDevices(active); wipe(active); active = null; }
      buttons();
      try {
        const receipt = await invoke({ kind: 'consent', agreed: value });
        if (retired) return;
        if (receipt?.ok !== true || receipt.consentUpdated !== true || receipt.isAgreed !== value)
          throw Error('VOICE_CONSENT_UNCONFIRMED');
        agreed = value;
        consent.textContent = value ? '已明确同意本次会议声明。仅点击“开始录制”才会申请麦克风。' : '已撤销并删除。';
      } catch (_) { if (!retired) state('error', '无法确认同意或删除结果，未授权新的录音。'); }
      finally { consentPending = false; buttons(); }
    };
    const agree = event => changeConsent(event, true);
    const revoke = event => changeConsent(event, false);
    const stop = event => { if (event.isTrusted && active && !stopButton.disabled) finish(active); };
    const changePrompt = event => { if (event.isTrusted && !active) displayPrompt(); };
    const escape = event => { if (event.isTrusted && event.key === 'Escape' && !event.repeat) { event.preventDefault(); close(event); } };
    const hidden = () => {
      if (document.hidden && active && !retired) { retire(); invoke({ kind: 'close' }).catch(() => {}); }
    };
    recordButton.addEventListener('click', start); stopButton.addEventListener('click', stop);
    cancelButton.addEventListener('click', close);
    agreeButton.addEventListener('click', agree); revokeButton.addEventListener('click', revoke);
    promptsSelect.addEventListener('change', changePrompt); window.addEventListener('keydown', escape);
    document.addEventListener('visibilitychange', hidden);
    ipcRenderer.on(channel, receive);
    window.addEventListener('unload', () => {
      retire(); ipcRenderer.removeListener(channel, receive);
      recordButton.removeEventListener('click', start); stopButton.removeEventListener('click', stop);
      cancelButton.removeEventListener('click', close);
      agreeButton.removeEventListener('click', agree); revokeButton.removeEventListener('click', revoke);
      promptsSelect.removeEventListener('change', changePrompt); window.removeEventListener('keydown', escape);
      document.removeEventListener('visibilitychange', hidden);
    }, { once: true });
  }, { once: true });
}
