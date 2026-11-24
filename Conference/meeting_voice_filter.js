'use strict';

const { spawn } = require('child_process');
const { randomBytes } = require('crypto');
const path = require('path');

const SAMPLES = 640, READY = Buffer.from('RDY1');
function failed(code) { return Object.assign(new Error(code), { code }); }

// One main-frame owner, one native filter, one request on the pipe at a time.
// Neither the PNR record nor raw/filtered samples have a filesystem or log sink.
class VoiceFilter {
  constructor(appRoot) {
    this.worker = path.join(appRoot, 'native/lib/welink-voice-worker');
    this.modelDir = path.join(appRoot, 'plugin/conference/HwmSdk/mmrModel');
    this.active = null;
    this.retiring = new Set();
  }

  async open(record) {
    if (!Buffer.isBuffer(record) || record.length !== 2384) throw failed('VOICE_ENROLLMENT_REQUIRED');
    let child;
    try {
      if (this.active || this.retiring.size) throw failed('VOICE_FILTER_BUSY');
      child = spawn(this.worker, ['filter', this.modelDir], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (err) { record.fill(0); throw err; }
    const s = { child, id: randomBytes(16).toString('hex'), ready: false, pending: null, record, closed: null };
    this.active = s;
    let ended;
    s.closed = new Promise(resolve => { ended = resolve; });
    child.once('close', () => {
      if (this.active === s) this.active = null;
      this.rejectPending(s, 'VOICE_FILTER_EXITED');
      if (s.record) { s.record.fill(0); s.record = null; }
      this.retiring.delete(s); ended();
    });
    const interrupt = () => this.retire(s, 'VOICE_FILTER_IO_FAILED');
    child.once('error', interrupt); child.stdin.on('error', interrupt); child.stdout.on('error', interrupt);
    child.stdout.on('data', chunk => {
      const p = s.pending;
      if (this.active !== s) return;
      if (!p || chunk.length > p.buf.length - p.offset) { this.retire(s, 'VOICE_FILTER_PROTOCOL'); return; }
      chunk.copy(p.buf, p.offset); p.offset += chunk.length;
      if (p.offset === p.buf.length) { s.pending = null; clearTimeout(p.timer); p.resolve(p.buf); }
    });
    try {
      const ack = await this.exchange(s, record, READY.length, 10000);
      if (this.active !== s || !ack.equals(READY)) throw failed('VOICE_FILTER_NOT_READY');
      s.ready = true; return { id: s.id };
    } catch (error) { await this.retire(s, 'VOICE_FILTER_NOT_READY'); throw error; }
    finally { record.fill(0); s.record = null; }
  }

  exchange(s, input, bytes, timeout) {
    if (this.active !== s || s.pending) return Promise.reject(failed('VOICE_FILTER_BUSY'));
    return new Promise((resolve, reject) => {
      const p = { buf: Buffer.alloc(bytes), offset: 0, resolve, reject,
        timer: setTimeout(() => this.retire(s, 'VOICE_FILTER_TIMEOUT'), timeout) };
      p.timer.unref(); s.pending = p;
      try { s.child.stdin.write(input, err => { if (err) this.retire(s, 'VOICE_FILTER_IO_FAILED'); }); }
      catch (_) { this.retire(s, 'VOICE_FILTER_IO_FAILED'); }
    });
  }

  async process(id, pcm) {
    const s = this.active;
    if (!s || !s.ready || s.id !== id) throw failed('VOICE_FILTER_RETIRED');
    if (!(pcm instanceof Float32Array) || pcm.length !== SAMPLES || !pcm.every(Number.isFinite))
      throw failed('VOICE_INVALID_AUDIO_BLOCK');
    const buf = await this.exchange(s, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength), pcm.byteLength, 2000);
    if (this.active !== s) throw failed('VOICE_FILTER_RETIRED');
    const output = new Float32Array(buf.buffer, buf.byteOffset, SAMPLES);
    if (!output.every(Number.isFinite)) { await this.retire(s, 'VOICE_FILTER_INVALID_OUTPUT'); throw failed('VOICE_FILTER_INVALID_OUTPUT'); }
    return output;
  }

  rejectPending(s, code) {
    if (!s.pending) return;
    const p = s.pending; s.pending = null; clearTimeout(p.timer); p.buf.fill(0); p.reject(failed(code));
  }

  retire(s, code) {
    if (!s || this.retiring.has(s)) return s?.closed;
    if (this.active !== s) return s.closed;
    this.active = null; this.retiring.add(s); this.rejectPending(s, code);
    s.child.stdin.destroy(); s.child.kill('SIGKILL');
    return s.closed;
  }

  async close(id) {
    const s = this.active?.id === id ? this.active : [...this.retiring].find(item => item.id === id);
    if (s) await this.retire(s, 'VOICE_FILTER_RETIRED');
    return { closed: true };
  }

  async stop() {
    if (this.active) this.retire(this.active, 'VOICE_FILTER_RETIRED');
    await Promise.all([...this.retiring].map(s => s.closed));
    return { stopped: true };
  }
}

module.exports = { VoiceFilter };
