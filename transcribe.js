#!/usr/bin/env node

import 'dotenv/config';
import { promisify } from 'util';
import { exec } from 'child_process';
import { createRequire } from 'module';
import WebSocket from 'ws';

const execAsync = promisify(exec);
const require = createRequire(import.meta.url);
const record = require('node-record-lpcm16');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

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

const PARTIAL_STAGE_HINTS = new Set(['partial', 'delta', 'updated', 'created', 'in_progress']);
const FINAL_STAGE_HINTS = new Set(['completed', 'complete', 'final', 'finished', 'done']);

let ws;
let mic;
let micStream;
let closing = false;
let lastPartial = '';

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

async function ensurePrerequisites() {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY が設定されていません (.env または環境変数で指定してください)');
  }
  await execAsync('sox --version').catch(() => {
    throw new Error('SoX が見つかりません。`brew install sox` でインストールしてください');
  });
}

async function connectToRealtimeAPI() {
  const url = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview';
  const socket = new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1',
    },
  });

  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
    socket.once('unexpected-response', (_req, res) => {
      reject(new Error(`Unexpected response: ${res.statusCode} ${res.statusMessage}`));
    });
  });
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
    console.error('マイク開始失敗:', error.message);
    cleanup(1);
    return;
  }

  micStream = mic.stream();
  micStream.on('data', handleMicData);
  micStream.on('error', (error) => {
    console.error('マイクエラー:', error.message);
  });
}

function stopMic() {
  if (!mic) return;
  if (micStream) {
    micStream.removeListener('data', handleMicData);
    micStream.removeAllListeners('error');
    micStream = null;
  }
  try {
    mic.stop();
  } catch (_) {}
  mic = null;
}

function handleMicData(chunk) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(
      JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: chunk.toString('base64'),
      })
    );
  }
}

function logPartial(text) {
  if (!text) return;
  if (text === lastPartial) return;
  lastPartial = text;
  console.log(`[partial] ${text}`);
}

function logFinal(text) {
  const normalized = ensureTrailingPunctuation(text.trim());
  if (!normalized) return;
  lastPartial = '';
  console.log(normalized);
}

async function processTranscriptPayload(transcript, stageHint) {
  const text = typeof transcript === 'string' ? transcript : '';
  const stage = typeof stageHint === 'string' ? stageHint.toLowerCase() : '';
  if (FINAL_STAGE_HINTS.has(stage)) {
    logFinal(text);
    return true;
  }
  if (text) {
    logPartial(text);
    return true;
  }
  if (PARTIAL_STAGE_HINTS.has(stage)) {
    lastPartial = '';
    return true;
  }
  return false;
}

async function handleTranscriptionEnvelope(message) {
  if (!message?.type) return false;

  if (message.type.startsWith('conversation.item.input_audio_transcription.')) {
    const stage = message.type.split('.').pop();
    const transcript = extractTranscript(message);
    return processTranscriptPayload(transcript, stage);
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
      return processTranscriptPayload(transcript, stage);
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
      logPartial(transcript);
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

function cleanup(exitCode = 0) {
  if (closing) return;
  closing = true;
  stopMic();
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close();
  }
  setTimeout(() => {
    process.exit(exitCode);
  }, 0);
}

async function main() {
  await ensurePrerequisites();

  console.log('Realtime API に接続しています...');
  try {
    ws = await connectToRealtimeAPI();
  } catch (error) {
    console.error('Realtime API 接続失敗:', error.message);
    process.exit(1);
    return;
  }

  ws.on('close', () => {
    if (!closing) {
      console.error('Realtime API との接続が切断されました');
      cleanup(0);
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket エラー:', error.message);
  });

  ws.on('message', async (data) => {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch (error) {
      console.error('メッセージ解析エラー:', error.message);
      return;
    }
    if (await handleTranscriptionEnvelope(message)) {
      return;
    }
    if (message.type === 'error') {
      console.error('API エラー:', message.error?.message ?? '詳細不明');
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

  console.log('マイク入力を開始します (Ctrl+C で終了)');
  startMic();
}

process.on('SIGINT', () => cleanup(0));
process.on('SIGTERM', () => cleanup(0));

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
