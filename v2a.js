#!/usr/bin/env node

import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import WebSocket from 'ws';
import blessed from 'blessed';

const require = createRequire(import.meta.url);
const record = require('node-record-lpcm16');

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SCREEN_LABEL = ' V2A ';
const DETECTED_MAX_DISPLAY = 60;
const TARGET_REFRESH_INTERVAL_MS = 5000;
const VOLUME_UPDATE_INTERVAL_MS = 500;
const SEND_COUNT_UPDATE_INTERVAL_MS = 500;
const DETECT_AUTO_OFF_TIMEOUT_MS = 3 * 60 * 1000;
const TRANSCRIPT_AUTO_OFF_TIMEOUT_MS = 5 * 60 * 1000;
const STATUS_COUNTDOWN_UPDATE_INTERVAL_MS = 1000;
const VOLUME_SILENT_THRESHOLD_DB = -60;
const VOLUME_BAR_LENGTH = 20;
const MESSAGE_MAX_LENGTH = 60;

const TRAILING_PUNCTUATION_REGEX = /[。．\.?!！？、，]$/u;
const LATIN_ENDING_REGEX = /[A-Za-z0-9]$/;
const POLITE_BASE_ENDINGS = [
  'です',
  'でした',
  'でしょう',
  'でしょ',
  'ます',
  'ました',
  'ません',
  'ませんでした',
];
const POLITE_SUFFIXES = ['ね', 'よ', 'よね'];
const POLITE_QUESTION_SUFFIXES = ['か', 'かね', 'かしら'];
const JAPANESE_POLITE_ENDINGS = new Set([
  ...POLITE_BASE_ENDINGS,
  ...POLITE_BASE_ENDINGS.flatMap((base) => [
    ...POLITE_SUFFIXES.map((suffix) => `${base}${suffix}`),
    ...POLITE_QUESTION_SUFFIXES.map((suffix) => `${base}${suffix}`),
  ]),
]);

function hasJapanesePoliteEnding(text) {
  for (const ending of JAPANESE_POLITE_ENDINGS) {
    if (text.endsWith(ending)) {
      return true;
    }
  }
  return false;
}

function ensureTrailingPunctuation(text) {
  if (!text) return text;
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  if (TRAILING_PUNCTUATION_REGEX.test(trimmed.slice(-1))) {
    return trimmed;
  }
  if (hasJapanesePoliteEnding(trimmed)) {
    return `${trimmed}。`;
  }
  if (LATIN_ENDING_REGEX.test(trimmed.slice(-1))) {
    return `${trimmed}.`;
  }
  return trimmed;
}

const MODE_SEQUENCE = ['off', 'detect', 'active'];
const MODE_LABELS = {
  off: '{red-fg}OFF{/red-fg}',
  detect: '{yellow-fg}DETECT{/yellow-fg}',
  active: '{green-fg}ACTIVE{/green-fg}',
};
const PARTIAL_STAGE_HINTS = new Set(['partial', 'delta', 'updated', 'created', 'in_progress']);

const FINAL_STAGE_HINTS = new Set(['completed', 'complete', 'final', 'finished', 'done']);

function extractTranscript(message) {
  let best = '';
  const seen = new Set();
  const consider = (value) => {
    if (typeof value !== 'string') return;
    const text = value.trim();
    if (!text) return;
    if (seen.has(text)) return;
    seen.add(text);
    if (text.length >= best.length) {
      best = text;
    }
  };

  const visit = (node) => {
    if (!node) return;
    if (typeof node === 'string') {
      consider(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const entry of node) {
        visit(entry);
      }
      return;
    }
    if (typeof node !== 'object') return;

    consider(node.transcript);
    consider(node.text);
    consider(node.value);

    if ('partial' in node) visit(node.partial);
    if ('delta' in node) visit(node.delta);
    if ('content' in node) visit(node.content);
    if ('item' in node) visit(node.item);
    if (Array.isArray(node.items)) {
      for (const item of node.items) {
        visit(item);
      }
    }
  };

  visit(message);
  return best;
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

function calculateDecibels(buffer) {
  if (!buffer || buffer.length === 0) return -Infinity;
  let sum = 0;
  const samples = buffer.length / 2;
  for (let i = 0; i < buffer.length; i += 2) {
    const sample = buffer.readInt16LE(i);
    sum += sample * sample;
  }
  if (samples === 0) return -Infinity;
  const rms = Math.sqrt(sum / samples);
  if (rms === 0) return -Infinity;
  return 20 * Math.log10(rms / 32768);
}

function formatVolumeLine(db) {
  if (!Number.isFinite(db) || db <= VOLUME_SILENT_THRESHOLD_DB) {
    return 'Volume: [                    ] Silent';
  }
  const clamped = Math.max(VOLUME_SILENT_THRESHOLD_DB, Math.min(0, db));
  const ratio = (clamped - VOLUME_SILENT_THRESHOLD_DB) / Math.abs(VOLUME_SILENT_THRESHOLD_DB);
  const filled = Math.max(0, Math.min(VOLUME_BAR_LENGTH, Math.round(ratio * VOLUME_BAR_LENGTH)));
  const bar = '█'.repeat(filled).padEnd(VOLUME_BAR_LENGTH, ' ');
  return `Volume: [${bar}] ${db.toFixed(1)} dB`;
}

function formatDetectedLine(text = '') {
  if (!text) return 'Detected: ';
  const suffix = text.length > DETECTED_MAX_DISPLAY ? text.slice(-DETECTED_MAX_DISPLAY) : text;
  return `Detected: ${suffix}`;
}

function truncateForMessage(text, limit = MESSAGE_MAX_LENGTH) {
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

async function fetchSendTargets() {
  const scriptPath = path.join(__dirname, 'send_to_terminals.sh');
  try {
    const { stdout } = await execFileAsync(scriptPath, ['--list-targets']);
    const lines = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const targets = [];
    for (const line of lines) {
      if (!line.includes('|')) continue;
      const [id, label] = line.split('|');
      if (!id) continue;
      targets.push({ id, label: label || id });
    }
    return targets;
  } catch (error) {
    return [];
  }
}

async function sendToTarget(targetId, text) {
  if (!targetId) throw new Error('送信先が未設定です');
  const scriptPath = path.join(__dirname, 'send_to_terminals.sh');
  await execFileAsync(scriptPath, ['--target', targetId, text]);
}

function createUI(handlers = {}) {
  const screen = blessed.screen({
    smartCSR: true,
    title: 'V2A',
    autoPadding: true,
    fullUnicode: true,
  });
  screen.unicode = true;
  screen.program.unicode = true;
  screen.program.disableMouse();
  screen.program.hideCursor();

  const frame = blessed.box({
    top: 'center',
    left: 'center',
    width: '80%',
    height: 10,
    border: { type: 'line' },
    label: SCREEN_LABEL,
    tags: true,
  });

  const statusLine = blessed.text({
    top: 0,
    left: 1,
    tags: true,
    content: 'Status: {red-fg}OFF{/red-fg}',
  });
  const volumeLine = blessed.text({ top: 1, left: 1, content: 'Volume: [                    ] Silent' });
  const detectedLine = blessed.text({ top: 2, left: 1, content: 'Detected: ' });
  const sendToLine = blessed.text({ top: 3, left: 1, content: 'Send To: 未設定' });
  const sendCountLine = blessed.text({ top: 4, left: 1, content: '送信回数: 0' });
  const messageLine = blessed.text({ top: 5, left: 1, width: '100%-2', content: '' });
  const helpLine = blessed.text({
    top: 6,
    left: 1,
    width: '100%-2',
    content: '[Enter] 状態切替 (OFF→Detect→Active)   ←/↑ 前   →/↓ 次   r:更新   q:終了',
  });

  frame.append(statusLine);
  frame.append(volumeLine);
  frame.append(detectedLine);
  frame.append(sendToLine);
  frame.append(sendCountLine);
  frame.append(messageLine);
  frame.append(helpLine);
  screen.append(frame);
  screen.render();

  const { toggle, prevTarget, nextTarget, refreshTargets, quit } = handlers;

  screen.key(['enter'], () => toggle && toggle());
  screen.key(['left', 'up'], () => prevTarget && prevTarget());
  screen.key(['right', 'down'], () => nextTarget && nextTarget());
  screen.key(['r'], () => refreshTargets && refreshTargets());
  screen.key(['q', 'C-c'], () => quit && quit());

  return {
    screen,
    setStatus(mode, extra) {
      const label = MODE_LABELS[mode] ?? (mode ? mode.toUpperCase() : '{red-fg}OFF{/red-fg}');
      const suffix = extra ? ` ${extra}` : '';
      statusLine.setContent(`Status: ${label}${suffix}`);
      screen.render();
    },
    setVolume(db) {
      volumeLine.setContent(formatVolumeLine(db));
      screen.render();
    },
    setDetected(text) {
      detectedLine.setContent(formatDetectedLine(text));
      screen.render();
    },
    setSendTo(label) {
      sendToLine.setContent(`Send To: ${label ?? '未設定'}`);
      screen.render();
    },
    setSendCount(count) {
      sendCountLine.setContent(`送信回数: ${count}`);
      screen.render();
    },
    setMessage(message) {
      messageLine.setContent(message ?? '');
      screen.render();
    },
    destroy() {
      screen.destroy();
    },
  };
}

async function ensurePrerequisites() {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY が設定されていません (.env または環境変数で指定してください)');
  }
  try {
    await execAsync('sox --version');
  } catch (error) {
    throw new Error('SoX が見つかりません。`brew install sox` でインストールしてください');
  }
}

async function connectToRealtimeAPI() {
  const url = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview';
  const ws = new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1',
    },
  });

  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => {
      reject(new Error(`Unexpected response: ${res.statusCode} ${res.statusMessage}`));
    });
  });
}

async function main() {
  await ensurePrerequisites();

  const state = {
    mode: 'off',
    targets: [],
    targetIndex: -1,
    partialText: '',
    closing: false,
    sendCount: 0,
    detectModeExpiresAt: null,
    transcriptTimeoutExpiresAt: null,
  };

  let ws;
  let mic;
  let micStream;
  let targetInterval;
  let detectAutoOffTimer;
  let transcriptAutoOffTimer;
  let statusCountdownInterval;
  let audioBuffer = [];
  let lastVolumeDisplay = Date.now();
  let lastSendCountDisplay = Date.now();

  const ui = createUI({
    toggle: handleToggle,
    prevTarget: () => moveTarget(-1),
    nextTarget: () => moveTarget(1),
    refreshTargets: () => refreshTargets(true),
    quit: () => cleanup(),
  });

  ui.setMessage('送信先を取得しています...');
  ui.setSendCount(state.sendCount);
  lastSendCountDisplay = Date.now();

  async function refreshTargets(showMessage = false) {
    const prevTargets = state.targets;
    const prevTargetId = prevTargets[state.targetIndex]?.id;
    const newTargets = await fetchSendTargets();
    const changed =
      newTargets.length !== prevTargets.length ||
      newTargets.some((target, index) => target.id !== prevTargets[index]?.id);

    if (!changed) {
      if (showMessage) {
        ui.setMessage('候補は変化していません');
      }
      return;
    }

    state.targets = newTargets;
    let message = null;

    if (prevTargetId) {
      const index = newTargets.findIndex((target) => target.id === prevTargetId);
      state.targetIndex = index >= 0 ? index : -1;
      if (index === -1) {
        message = '選択中の送信先が見つからなくなりました';
      }
    } else if (state.targetIndex >= newTargets.length) {
      state.targetIndex = -1;
    }

    if (state.targetIndex === -1 && state.mode === 'active') {
      applyMode('detect');
      message = '送信先がなくなったため解析モードに戻りました';
    }

    updateSendToLine();

    if (showMessage) {
      if (!message) {
        const labels = newTargets.map((t) => t.label).join(', ');
        message = newTargets.length ? `候補更新: ${labels}` : '候補なし';
      }
      ui.setMessage(message);
    } else if (message) {
      ui.setMessage(message);
    }
  }

  function formatRemainingTime(expiresAt) {
    const remainingMs = Math.max(0, expiresAt - Date.now());
    const remainingSeconds = Math.ceil(remainingMs / 1000);
    const minutes = Math.floor(remainingSeconds / 60);
    const seconds = remainingSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }

  function updateStatusLine() {
    const extras = [];
    if (state.mode === 'detect' && typeof state.detectModeExpiresAt === 'number') {
      extras.push(`残り ${formatRemainingTime(state.detectModeExpiresAt)}`);
    }
    if (state.mode !== 'off' && typeof state.transcriptTimeoutExpiresAt === 'number') {
      extras.push(`無入力 ${formatRemainingTime(state.transcriptTimeoutExpiresAt)}`);
    }
    const extraText = extras.length ? `(${extras.join(' / ')})` : '';
    ui.setStatus(state.mode, extraText);
  }

  function handleMicData(chunk) {
    audioBuffer.push(chunk);
    const now = Date.now();
    if (now - lastVolumeDisplay >= VOLUME_UPDATE_INTERVAL_MS) {
      const combined = Buffer.concat(audioBuffer);
      const db = calculateDecibels(combined);
      ui.setVolume(db);
      audioBuffer = [];
      lastVolumeDisplay = now;
    }

    if (state.mode !== 'off' && ws?.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: chunk.toString('base64'),
        })
      );
      state.sendCount += 1;
      if (now - lastSendCountDisplay >= SEND_COUNT_UPDATE_INTERVAL_MS) {
        ui.setSendCount(state.sendCount);
        lastSendCountDisplay = now;
      }
    }
  }

  function handleMicError(error) {
    ui.setMessage(`マイクエラー: ${error.message}`);
  }

  function startMic() {
    if (mic) return;
    try {
      mic = record.record({
        sampleRate: 24000,
        channels: 1,
        audioType: 'raw',
        threshold: 0,
        silence: '10.0',
        recordProgram: 'sox',
      });
    } catch (error) {
      ui.setMessage(`マイク開始失敗: ${error.message}`);
      cleanup(1);
      return;
    }

    micStream = mic.stream();
    micStream.on('data', handleMicData);
    micStream.on('error', handleMicError);
    audioBuffer = [];
    lastVolumeDisplay = Date.now();
    try {
      ui.setVolume(-Infinity);
    } catch (_) {}
  }

  function stopMic() {
    if (!mic) return;
    if (micStream) {
      micStream.removeListener('data', handleMicData);
      micStream.removeListener('error', handleMicError);
      micStream = null;
    }
    try {
      mic.stop();
    } catch (error) {
      // ignore stop errors
    }
    mic = null;
    audioBuffer = [];
    lastVolumeDisplay = Date.now();
    try {
      ui.setVolume(-Infinity);
    } catch (_) {}
  }

  function ensureStatusCountdownInterval() {
    if (!statusCountdownInterval) {
      statusCountdownInterval = setInterval(() => {
        updateStatusLine();
      }, STATUS_COUNTDOWN_UPDATE_INTERVAL_MS);
    }
  }

  function stopStatusCountdownIntervalIfIdle() {
    if (!detectAutoOffTimer && !transcriptAutoOffTimer && statusCountdownInterval) {
      clearInterval(statusCountdownInterval);
      statusCountdownInterval = null;
    }
  }

  function clearDetectAutoOffTimer() {
    if (detectAutoOffTimer) {
      clearTimeout(detectAutoOffTimer);
      detectAutoOffTimer = null;
    }
    state.detectModeExpiresAt = null;
    stopStatusCountdownIntervalIfIdle();
  }

  function scheduleDetectAutoOff() {
    clearDetectAutoOffTimer();
    state.detectModeExpiresAt = Date.now() + DETECT_AUTO_OFF_TIMEOUT_MS;
    detectAutoOffTimer = setTimeout(() => {
      if (state.mode === 'detect') {
        applyMode('off', 'Detectモードが3分経過したためOFFに戻りました');
      }
    }, DETECT_AUTO_OFF_TIMEOUT_MS);
    ensureStatusCountdownInterval();
    updateStatusLine();
  }

  function clearTranscriptAutoOffTimer() {
    if (transcriptAutoOffTimer) {
      clearTimeout(transcriptAutoOffTimer);
      transcriptAutoOffTimer = null;
    }
    state.transcriptTimeoutExpiresAt = null;
    stopStatusCountdownIntervalIfIdle();
  }

  function scheduleTranscriptAutoOff() {
    clearTranscriptAutoOffTimer();
    if (state.mode === 'off') {
      updateStatusLine();
      return;
    }
    state.transcriptTimeoutExpiresAt = Date.now() + TRANSCRIPT_AUTO_OFF_TIMEOUT_MS;
    transcriptAutoOffTimer = setTimeout(() => {
      if (state.mode !== 'off') {
        applyMode('off', '解析結果が5分間届かなかったためOFFに戻りました');
      }
    }, TRANSCRIPT_AUTO_OFF_TIMEOUT_MS);
    ensureStatusCountdownInterval();
    updateStatusLine();
  }

  function noteTranscriptActivity() {
    if (state.mode === 'off') return;
    scheduleTranscriptAutoOff();
  }

  function applyMode(newMode, message) {
    if (!MODE_SEQUENCE.includes(newMode)) {
      return false;
    }
    if (newMode === 'active') {
      if (!state.targets.length || state.targetIndex === -1) {
        return false;
      }
    }
    if (state.mode === newMode) {
      if (message) {
        ui.setMessage(message);
      }
      return true;
    }
    const previousMode = state.mode;
    state.mode = newMode;
    if (state.mode === 'off') {
      clearDetectAutoOffTimer();
      clearTranscriptAutoOffTimer();
      stopMic();
      state.sendCount = 0;
      ui.setSendCount(state.sendCount);
      lastSendCountDisplay = Date.now();
    } else {
      startMic();
      scheduleTranscriptAutoOff();
    }
    if (previousMode === 'detect' && state.mode !== 'detect') {
      clearDetectAutoOffTimer();
    }
    if (state.mode === 'detect') {
      scheduleDetectAutoOff();
    } else {
      updateStatusLine();
    }
    if (newMode === 'off' || newMode === 'active') {
      updatePartialTranscript('');
    }
    if (message) {
      ui.setMessage(message);
    }
    return true;
  }

  function updateSendToLine() {
    const target = state.targets[state.targetIndex];
    ui.setSendTo(target ? target.label : '未設定');
  }

  function moveTarget(direction) {
    if (!state.targets.length) {
      ui.setMessage('送信先候補がありません');
      return;
    }
    if (state.targetIndex === -1) {
      state.targetIndex = direction > 0 ? 0 : state.targets.length - 1;
    } else {
      const next = (state.targetIndex + direction + state.targets.length) % state.targets.length;
      state.targetIndex = next;
    }
    const target = state.targets[state.targetIndex];
    updateSendToLine();
    ui.setMessage(`選択: ${target.label}`);
  }

  function handleToggle() {
    const currentIndex = MODE_SEQUENCE.indexOf(state.mode);
    const nextIndex = (currentIndex + 1) % MODE_SEQUENCE.length;
    let candidate = MODE_SEQUENCE[nextIndex];
    let message = null;

    if (candidate === 'active') {
      if (!state.targets.length) {
        candidate = 'off';
        message = '送信先候補がないためOFFに戻りました';
      } else if (state.targetIndex === -1) {
        candidate = 'off';
        message = '送信先を選択してください (矢印キー)。OFFに戻ります';
      } else {
        message = `送信を開始します: ${state.targets[state.targetIndex].label}`;
      }
    } else if (candidate === 'detect') {
      message = '解析モードに切り替えました';
    } else {
      message = '送信を停止しました';
    }

    applyMode(candidate, message);
  }

  function updatePartialTranscript(raw) {
    const text = state.mode === 'off' ? '' : typeof raw === 'string' ? raw : '';
    if (text !== state.partialText) {
      state.partialText = text;
      ui.setDetected(text);
    }
  }

  async function handleFinalTranscript(raw) {
    const normalized = typeof raw === 'string' ? raw.trim() : '';
    if (!normalized) {
      return;
    }

    const finalized = ensureTrailingPunctuation(normalized);

    if (state.mode === 'active') {
      updatePartialTranscript('');
    } else {
      updatePartialTranscript(finalized);
    }

    if (state.mode === 'active' && state.targetIndex !== -1) {
      const target = state.targets[state.targetIndex];
      try {
        await sendToTarget(target.id, finalized);
        ui.setMessage(`送信 (${target.label}): ${truncateForMessage(finalized)}`);
      } catch (error) {
        ui.setMessage(`送信失敗 (${target.label}): ${error.message}`);
      }
    } else {
      ui.setMessage(`転写: ${truncateForMessage(finalized)}`);
    }
  }

  async function processTranscriptPayload(transcript, stageHint) {
    const text = typeof transcript === 'string' ? transcript : '';
    const stage = typeof stageHint === 'string' ? stageHint.toLowerCase() : '';
    if (FINAL_STAGE_HINTS.has(stage)) {
      await handleFinalTranscript(text);
      if (text) {
        noteTranscriptActivity();
      }
      return true;
    }

    if (text) {
      updatePartialTranscript(text);
      noteTranscriptActivity();
      return true;
    }

    if (PARTIAL_STAGE_HINTS.has(stage)) {
      updatePartialTranscript('');
      return true;
    }

    return false;
  }

  async function handleTranscriptionEnvelope(message) {
    if (!message?.type) return false;

    if (message.type.startsWith('conversation.item.input_audio_transcription.')) {
      const stage = message.type.split('.').pop();
      const transcript = extractTranscript(message);
      await processTranscriptPayload(transcript, stage);
      return true;
    }

    if (message.type === 'conversation.item.created' || message.type === 'conversation.item.updated') {
      const items = [];
      if (message.item) items.push(message.item);
      if (Array.isArray(message.items)) items.push(...message.items);
      let handled = false;
      for (const item of items) {
        if (item?.type === 'input_audio_transcription') {
          const stage = item.status || item.state || (message.type === 'conversation.item.updated' ? 'updated' : 'created');
          const transcript = extractTranscript(item);
          if (await processTranscriptPayload(transcript, stage)) {
            handled = true;
          }
        }
      }
      if (handled) return true;
    }

    if (message.type === 'conversation.item.delta') {
      const delta = message.delta;
      if (delta?.type === 'input_audio_transcription') {
        const stage = delta.status || delta.state || 'delta';
        const transcript = extractTranscript(delta);
        await processTranscriptPayload(transcript, stage);
        return true;
      }
      if (Array.isArray(delta?.items)) {
        let handled = false;
        for (const item of delta.items) {
          if (item?.type === 'input_audio_transcription') {
            const stage = item.status || item.state || 'delta';
            const transcript = extractTranscript(item);
            if (await processTranscriptPayload(transcript, stage)) {
              handled = true;
            }
          }
        }
        if (handled) return true;
      }
    }

    if (message.type === 'response.output_text.delta' || message.type === 'response.delta') {
      const transcript = extractTranscript(message);
      if (transcript) {
        updatePartialTranscript(transcript);
        noteTranscriptActivity();
        return true;
      }
      if (Array.isArray(message.delta?.items)) {
        let handled = false;
        for (const item of message.delta.items) {
          if (item?.type === 'input_audio_transcription') {
            const stage = item.status || item.state || 'delta';
            const transcript = extractTranscript(item);
            if (await processTranscriptPayload(transcript, stage)) {
              handled = true;
            }
          }
        }
        if (handled) return true;
      }
    }

    return false;
  }

  async function cleanup(exitCode = 0) {
    if (state.closing) return;
    state.closing = true;
    clearDetectAutoOffTimer();
    clearTranscriptAutoOffTimer();
    if (targetInterval) clearInterval(targetInterval);
    stopMic();
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
    ui.destroy();
    process.exit(exitCode);
  }

  process.on('SIGINT', () => cleanup(0));
  process.on('SIGTERM', () => cleanup(0));

  await refreshTargets(true);
  updateStatusLine();
  updateSendToLine();

  ui.setMessage('Realtime API に接続しています...');

  try {
    ws = await connectToRealtimeAPI();
  } catch (error) {
    ui.setMessage(`Realtime API 接続失敗: ${error.message}`);
    await cleanup(1);
    return;
  }

  ws.on('close', () => {
    if (!state.closing) {
      ui.setMessage('Realtime API との接続が切断されました');
      cleanup(0);
    }
  });

  ws.on('error', (error) => {
    ui.setMessage(`WebSocket エラー: ${error.message}`);
  });

  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());
      if (await handleTranscriptionEnvelope(message)) {
        return;
      }
      if (message.type === 'error') {
        ui.setMessage(`API エラー: ${message.error?.message ?? '詳細不明'}`);
      }
    } catch (error) {
      ui.setMessage(`メッセージ処理エラー: ${error.message}`);
    }
  });

  ws.send(
    JSON.stringify({
      type: 'session.update',
      session: {
        modalities: ['audio', 'text'],
        instructions:
          'You are a Japanese transcription assistant. Transcribe exactly what the user says in Japanese. Never output Korean characters. Always use Japanese (hiragana, katakana, or kanji) for transcription.',
        voice: 'alloy',
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        input_audio_transcription: {
          model: 'whisper-1',
        },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 200,
        },
        temperature: 0.8,
      },
    })
  );

  ui.setMessage('現在はOFFモードです。[Enter]で検出を開始できます');

  targetInterval = setInterval(() => {
    refreshTargets().catch((error) => {
      ui.setMessage(`候補更新エラー: ${error.message}`);
    });
  }, TARGET_REFRESH_INTERVAL_MS);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
