// Node echoback: PortAudio(PAmac.node) + AECM WASM (16kHz mono, 64-sample blocks)
// Usage: node echoback.js [--passthrough] [--no-linear] [--no-nonlinear] [latency_ms]

const path = require('path');
const assert = require('assert');

// CLI args
let passthrough = false;
let enableLinear = true;
let enableNonlinear = true;
let latencyMs = 200; // default
for (const arg of process.argv.slice(2)) {
  if (arg === '--passthrough' || arg === '-p') {
    passthrough = true;
  } else if (arg === '--no-linear') {
    enableLinear = false;
  } else if (arg === '--no-nonlinear') {
    enableNonlinear = false;
  } else if (arg === '--linear-only') {
    enableLinear = true; enableNonlinear = false;
  } else if (arg === '--nonlinear-only') {
    enableLinear = false; enableNonlinear = true;
  } else if (arg === '--help' || arg === '-h') {
    console.error('Usage: node echoback.js [--passthrough] [--no-linear] [--no-nonlinear] [latency_ms]');
    process.exit(0);
  } else if (/^\d+$/.test(arg)) {
    latencyMs = Math.max(1, Math.min(10000, parseInt(arg, 10)));
  } else {
    console.error('Unknown arg:', arg);
  }
}

const kSr = 16000;
const kBlock = 64; // 4ms @ 16k
const kBlocksPerSec = 250;
const latencySamplesTarget = Math.floor((kSr * latencyMs) / 1000);

// PAmac.node
let PortAudio = null;
if (process.platform === 'darwin') {
  PortAudio = require('./PAmac.node');
} else {
  console.error('Only macOS (PAmac.node) is supported here.');
  process.exit(1);
}

PortAudio.initSampleBuffers(kSr, kSr, kBlock);
PortAudio.startMic();
PortAudio.startSpeaker();

// AECM WASM
const AECMModule = require('./dist/aecm_wasm.js');

// Small FIFO helpers
function pushArray(dstArr, src) { for (let i = 0; i < src.length; i++) dstArr.push(src[i]|0); }
function popBlockI16(arr) {
  if (arr.length < kBlock) return null;
  const out = new Int16Array(kBlock);
  for (let i = 0; i < kBlock; i++) out[i] = arr.shift();
  return out;
}

function toInt16Array(x) {
  if (!x) return new Int16Array();
  if (ArrayBuffer.isView(x)) {
    if (x instanceof Int16Array) return x;
    // reinterpret Node Buffer or other typed arrays as Int16
    return new Int16Array(x.buffer, x.byteOffset, Math.floor(x.byteLength / 2));
  }
  if (Buffer.isBuffer(x)) {
    return new Int16Array(x.buffer, x.byteOffset, Math.floor(x.byteLength / 2));
  }
  // assume JS number[] of int16
  const out = new Int16Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i]|0;
  return out;
}

(async () => {
  const mod = await AECMModule();

  const h = mod._aecm_create();
  assert(h !== 0);
  if (!passthrough) {
    mod._aecm_set_bypass_supmask(h, enableLinear ? 0 : 1);
    mod._aecm_set_bypass_nlp(h, enableNonlinear ? 0 : 1);
  }

  const bytes = kBlock * 2;
  const pRef = mod._malloc(bytes);
  const pCap = mod._malloc(bytes);
  const pOut = mod._malloc(bytes);

  let recQ = [];
  let refQ = [];
  let jitterQ = [];
  let needJitter = true;
  let lastDelay = -2; // -2: uninitialized, -1: no estimate

  let erleIn = 0.0, erleOut = 0.0, erleBlocks = 0;

  console.error(`echoback (16k mono): mode=${passthrough ? 'passthrough' : (enableLinear && enableNonlinear ? 'aecm' : (!enableLinear ? 'nonlinear-only' : 'linear-only'))}, latency_ms=${latencyMs} (samples=${latencySamplesTarget})`);

  function processBlocks() {
    // run as many 64-sample blocks as we can
    let producedBlocks = 0;
    for (;;) {
      if (recQ.length < kBlock) break;
      const rec = popBlockI16(recQ);
      let ref = null;
      if (refQ.length >= kBlock) ref = popBlockI16(refQ); else ref = new Int16Array(kBlock);

      let out;
      if (passthrough) {
        out = rec;
      } else {
        // copy to HEAP and run
        mod.HEAP16.set(ref, pRef >> 1);
        mod.HEAP16.set(rec, pCap >> 1);
        const status = mod._aecm_process(h, pRef, pCap, pOut);
        if (status === 0) {
          out = mod.HEAP16.subarray(pOut >> 1, (pOut >> 1) + kBlock);
          // clone because subarray view is tied to wasm memory
          out = new Int16Array(out);
        } else {
          out = rec;
        }

        // delay logging
        const dblk = mod._aecm_get_last_delay_blocks(h);
        if (dblk >= 0 && dblk !== lastDelay) {
          const ms = Math.floor(dblk * 1000 / kBlocksPerSec);
          console.error(`[AECM] 推定遅延が変化: ${dblk} ブロック (約 ${ms} ms)`);
          lastDelay = dblk;
        }

        // ERLE-approx logging once per second
        let ein = 0, eout = 0;
        for (let i = 0; i < kBlock; i++) { const x = rec[i]; const y = out[i]; ein += x*x; eout += y*y; }
        erleIn += ein; erleOut += eout; erleBlocks += 1;
        if (erleBlocks >= kBlocksPerSec) {
          const ratio = (erleIn + 1e-9) / (erleOut + 1e-9);
          const erleDb = 10 * Math.log10(ratio);
          console.error(`[AECM] 1秒平均キャンセル量: ${erleDb.toFixed(1)} dB`);
          erleIn = erleOut = 0; erleBlocks = 0;
        }
      }

      // next ref comes from processed output
      for (let i = 0; i < kBlock; i++) refQ.push(out[i]);

      // accumulate to local jitter
      for (let i = 0; i < kBlock; i++) jitterQ.push(out[i]);
      if (needJitter && jitterQ.length > latencySamplesTarget) needJitter = false;

      // produce speaker block from jitter
      let mixed = new Int16Array(kBlock);
      if (!needJitter && jitterQ.length >= kBlock) {
        for (let i = 0; i < kBlock; i++) mixed[i] = jitterQ.shift();
      } else {
        // silence until jitter filled
        mixed.fill(0);
      }
      PortAudio.pushSamplesForPlay(mixed);
      producedBlocks++;
    }
    return producedBlocks;
  }

  const tickMs = 4; // 64 / 16000 * 1000
  const timer = setInterval(() => {
    // fetch mic samples
    const recBuf = PortAudio.getRecordedSamples();
    const recArr = toInt16Array(recBuf);
    if (recArr.length > 0) {
      pushArray(recQ, recArr);
      // consume from PAmac buffer
      if (typeof PortAudio.discardRecordedSamples === 'function') {
        PortAudio.discardRecordedSamples(recArr.length);
      }
    }
    processBlocks();
  }, tickMs);

  function shutdown() {
    clearInterval(timer);
    try { PortAudio && PortAudio.stopMic && PortAudio.stopMic(); } catch {}
    try { PortAudio && PortAudio.stopSpeaker && PortAudio.stopSpeaker(); } catch {}
    mod._free(pRef); mod._free(pCap); mod._free(pOut);
    mod._aecm_destroy(h);
  }

  process.on('SIGINT', () => { console.error('stopped.'); shutdown(); process.exit(0); });
})();
