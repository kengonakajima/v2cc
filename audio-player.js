import process from 'process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const PLAYBACK_SAMPLE_RATE = 24000;
const BLOCK_SIZE = 960; // 40ms @ 24kHz
const TICK_MS = Math.round((BLOCK_SIZE / PLAYBACK_SAMPLE_RATE) * 1000);
const PREFILL_MS = Math.max(0, Number.parseInt(process.env.VOICE_AGENT_AUDIO_PREFILL_MS ?? '100', 10));
const PREFILL_SAMPLES = Math.round((PLAYBACK_SAMPLE_RATE * PREFILL_MS) / 1000);
const IDLE_TIMEOUT_MS = 250;

let PortAudio = null;
let portAudioInitialized = false;

function loadPortAudio() {
  if (PortAudio) return PortAudio;
  if (process.platform !== 'darwin') {
    throw new Error('PAmac.node は macOS 専用です');
  }
  PortAudio = require('./PAmac.node');
  return PortAudio;
}

function normalize(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const value = Math.abs(samples[i]);
    if (value > peak) peak = value;
  }
  if (peak === 0 || peak >= 30000) {
    return samples;
  }
  const scale = 30000 / peak;
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i] * scale)));
  }
  return out;
}

function resampleLinear(int16, fromRate, toRate) {
  if (!Number.isFinite(fromRate) || fromRate <= 0) {
    fromRate = PLAYBACK_SAMPLE_RATE;
  }
  if (fromRate === toRate) {
    return int16;
  }
  const ratio = fromRate / toRate;
  const newLength = Math.max(1, Math.floor(int16.length / ratio));
  const out = new Int16Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const current = int16[idx] ?? 0;
    const next = int16[idx + 1] ?? current;
    out[i] = Math.round(current * (1 - frac) + next * frac);
  }
  return out;
}

export class AudioPlayer {
  constructor({ onStateChange } = {}) {
    this.buffers = [];
    this.bufferOffset = 0;
    this.timer = null;
    this.idleTimestamp = null;
    this.started = false;
    this.stopped = false;
    this.onStateChange = typeof onStateChange === 'function' ? onStateChange : null;
    this.prefillSamples = PREFILL_SAMPLES;
    this.prefillTimer = null;
  }

  ensureStarted() {
    if (this.started) return;
    const pa = loadPortAudio();
    if (!portAudioInitialized) {
      pa.initSampleBuffers(PLAYBACK_SAMPLE_RATE, PLAYBACK_SAMPLE_RATE, BLOCK_SIZE);
      portAudioInitialized = true;
    }
    pa.startSpeaker();
    this.timer = setInterval(() => this.flush(), Math.max(TICK_MS, 10));
    this.started = true;
    this.stopped = false;
    this.clearPrefillTimer();
    this.notifyState('start');
  }

  enqueue(samples, sampleRate = PLAYBACK_SAMPLE_RATE) {
    if (this.stopped) return;
    if (!(samples instanceof Int16Array)) {
      throw new Error('AudioPlayer.enqueue は Int16Array を期待します');
    }
    const resampled = resampleLinear(samples, sampleRate, PLAYBACK_SAMPLE_RATE);
    const normalized = normalize(resampled);
    if (normalized.length === 0) return;
    this.buffers.push(normalized);
    this.idleTimestamp = null;
    if (!this.started) {
      if (!this.prefillSamples || this.getBufferedSampleCount() >= this.prefillSamples) {
        this.ensureStarted();
      } else {
        this.schedulePrefillStart();
      }
    }
  }

  flush() {
    if (!this.buffers.length) {
      if (this.started) {
        if (this.idleTimestamp === null) {
          this.idleTimestamp = Date.now();
        } else if (Date.now() - this.idleTimestamp > IDLE_TIMEOUT_MS) {
          this.pause();
        }
      }
      return;
    }

    const chunk = new Int16Array(BLOCK_SIZE);
    let filled = 0;

    while (filled < BLOCK_SIZE && this.buffers.length) {
      const current = this.buffers[0];
      const remaining = current.length - this.bufferOffset;
      const needed = BLOCK_SIZE - filled;
      const toCopy = Math.min(remaining, needed);
      chunk.set(current.subarray(this.bufferOffset, this.bufferOffset + toCopy), filled);
      filled += toCopy;
      this.bufferOffset += toCopy;

      if (this.bufferOffset >= current.length) {
        this.buffers.shift();
        this.bufferOffset = 0;
      }
    }

    if (filled === 0) {
      return;
    }
    if (filled < BLOCK_SIZE) {
      chunk.fill(0, filled);
    }

    const pa = loadPortAudio();
    pa.pushSamplesForPlay(chunk);
  }

  pause() {
    if (!this.started || this.stopped) return;
    const pa = loadPortAudio();
    try {
      pa.stopSpeaker();
    } catch (_) {}
    this.started = false;
    this.idleTimestamp = null;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.clearPrefillTimer();
    this.notifyState('stop');
  }

  async shutdown() {
    this.stopped = true;
    this.buffers.length = 0;
    this.bufferOffset = 0;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.clearPrefillTimer();
    if (portAudioInitialized) {
      const pa = loadPortAudio();
      try {
        pa.stopSpeaker();
      } catch (_) {}
    }
    this.started = false;
    this.notifyState('stop');
  }

  notifyState(state) {
    try {
      this.onStateChange?.(state);
    } catch (error) {
      console.error(`[audio-player] 状態通知エラー: ${error.message}`);
    }
  }

  getBufferedSampleCount() {
    if (!this.buffers.length) {
      return 0;
    }
    let total = -this.bufferOffset;
    for (const buffer of this.buffers) {
      total += buffer.length;
    }
    return total > 0 ? total : 0;
  }

  schedulePrefillStart() {
    if (this.prefillTimer || !this.getBufferedSampleCount()) {
      return;
    }
    const delay = Math.max(PREFILL_MS, 10);
    this.prefillTimer = setTimeout(() => {
      this.prefillTimer = null;
      if (!this.started && !this.stopped && this.getBufferedSampleCount() > 0) {
        this.ensureStarted();
      }
    }, delay);
  }

  clearPrefillTimer() {
    if (this.prefillTimer) {
      clearTimeout(this.prefillTimer);
      this.prefillTimer = null;
    }
  }
}
