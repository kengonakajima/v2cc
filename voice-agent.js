#!/usr/bin/env node

import 'dotenv/config';
import process from 'process';
import OpenAI from 'openai';
import { getToolDefinitions, routeToolCall } from './tool-router.js';
import { AudioPlayer } from './audio-player.js';
import { TtsClient } from './tts-client.js';
import { PlaybackQueue } from './playback-queue.js';
import WebSocket from 'ws';
import { createRequire } from 'module';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY が設定されていません (.env で指定してください)');
  process.exit(1);
}

const args = new Set(process.argv.slice(2));
const DEBUG_MIC = args.has('--debug-mic');

const LLM_PROVIDER = (process.env.VOICE_AGENT_LLM_PROVIDER ?? 'openai').toLowerCase();
const MODEL_ID = process.env.OPENAI_MODEL ?? 'gpt-5-mini';
const GROQ_MODEL_ID = process.env.GROQ_MODEL ?? 'gpt-oss-120b';
const MAX_TOOL_ITERATIONS = Number.parseInt(process.env.VOICE_AGENT_TOOL_LOOP_MAX ?? '3', 10);
const MAX_HISTORY_ITEMS = Number.parseInt(process.env.VOICE_AGENT_HISTORY_LIMIT ?? '20', 10);

const client = new OpenAI({ apiKey: OPENAI_API_KEY });
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const toolDefinitions = getToolDefinitions();
const hasTools = toolDefinitions.length > 0;

const ttsDisabledFlag = args.has('--no-tts');
const ttsEnvDisabled = (process.env.VOICE_AGENT_TTS_ENABLED ?? 'true').toLowerCase() === 'false';
const ttsModel = process.env.VOICE_AGENT_TTS_MODEL ?? 'gpt-4o-mini-tts';
const ttsVoice = process.env.VOICE_AGENT_TTS_VOICE ?? 'alloy';
const ttsInstructions =
  process.env.VOICE_AGENT_TTS_INSTRUCTIONS ??
  '必ず日本語で読み上げ、数字は各桁を日本語の読みで発音してください。';

let playbackQueue = null;
let audioPlayerInstance = null;
if (!ttsDisabledFlag && !ttsEnvDisabled) {
  try {
    audioPlayerInstance = new AudioPlayer({
      onStateChange: (state) => {
        if (!micController) return;
        if (state === 'start') {
          micController.pause?.();
        } else if (state === 'stop') {
          micController.resume?.();
        }
      },
    });
    const ttsClient = new TtsClient(client, {
      model: ttsModel,
      voice: ttsVoice,
      instructions: ttsInstructions,
    });
    playbackQueue = new PlaybackQueue({ audioPlayer: audioPlayerInstance, ttsClient, enabled: true });
  } catch (error) {
    console.error(`[voice-agent] TTS 初期化に失敗しました: ${error.message}`);
  }
}

const MIC_SAMPLE_RATE = 24000;
const MIC_BLOCK_SIZE = 960;
const MIC_TICK_MS = Math.max(Math.round((MIC_BLOCK_SIZE / MIC_SAMPLE_RATE) * 1000), 10);

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

const conversation = [];
const pendingUtterances = [];
let processingQueue = false;
let shuttingDown = false;
let realtimeSocket = null;
let micController = null;
let lastPartialTranscript = '';

const baseSystemPrompt =
  process.env.VOICE_AGENT_SYSTEM_PROMPT ??
  'You are a proactive Japanese voice assistant.\n' +
    '- Summaries should be concise.\n' +
    '- When a custom tool is required, choose it and explain the action in Japanese.';

addToConversation(createMessage('system', baseSystemPrompt));

startRealtime().catch((error) => {
  console.error(`[voice-agent] Realtime 初期化エラー: ${error.message}`);
  initiateShutdown(1, null);
});
setupSignalHandlers();

function initiateShutdown(code, reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (reason) {
    console.error(reason);
  }
  const finalize = async () => {
    try {
      if (micController) {
        await Promise.resolve(micController.shutdown?.());
        micController = null;
      }
    } catch (error) {
      console.error(`[voice-agent] マイク停止エラー: ${error.message}`);
    }
    try {
      if (realtimeSocket && realtimeSocket.readyState === WebSocket.OPEN) {
        realtimeSocket.close();
      }
      realtimeSocket = null;
    } catch (error) {
      console.error(`[voice-agent] Realtime 接続終了エラー: ${error.message}`);
    }
    try {
      if (playbackQueue) {
        await playbackQueue.shutdown();
      }
    } catch (error) {
      console.error(`[voice-agent] 終了処理エラー: ${error.message}`);
    } finally {
      process.exit(code);
    }
  };
  finalize();
}

function setupSignalHandlers() {
  const exitHandler = (signal) => {
    initiateShutdown(0, `\n[voice-agent] ${signal} を受信しました。終了します`);
  };

  process.on('SIGINT', () => exitHandler('SIGINT'));
  process.on('SIGTERM', () => exitHandler('SIGTERM'));
}

async function startRealtime() {
  console.error('[voice-agent] Realtime API に接続しています...');
  try {
    realtimeSocket = await connectToRealtimeAPI();
  } catch (error) {
    console.error(`[voice-agent] Realtime API 接続失敗: ${error.message}`);
    initiateShutdown(1, null);
    return;
  }

  realtimeSocket.on('close', () => {
    if (!shuttingDown) {
      initiateShutdown(0, '[voice-agent] Realtime API との接続が切断されました');
    }
  });

  realtimeSocket.on('error', (error) => {
    console.error(`[voice-agent] WebSocket エラー: ${error.message}`);
  });

  realtimeSocket.on('message', async (data) => {
    try {
      await handleRealtimeMessage(data);
    } catch (error) {
      console.error(`[voice-agent] メッセージ処理エラー: ${error.message}`);
    }
  });

  sendSessionConfiguration();

  micController = createMicController({
    onChunk: (buffer) => {
      if (!buffer || buffer.length === 0) return;
      if (realtimeSocket?.readyState !== WebSocket.OPEN) return;
      const base64 = buffer.toString('base64');
      if (DEBUG_MIC) {
        console.log(`[mic] append bytes=${buffer.length} base64=${base64.length}`);
      }
      realtimeSocket.send(
        JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: base64,
        })
      );
    },
    onPause: () => {
      // drop buffered audio on pause to avoid leaking playback audio
    },
    onShutdown: () => {
      // nothing to flush; rely on server VAD
    },
  });

  try {
    micController.start();
  } catch (error) {
    console.error(`[voice-agent] マイク開始失敗: ${error.message}`);
    initiateShutdown(1, null);
  }
}

function createMicController({ onChunk, onPause, onShutdown }) {
  const require = createRequire(import.meta.url);
  const PortAudio = require('./PAmac.node');
  let timer = null;
  let paused = false;
  let started = false;
  let stopped = false;

  function toPcmBuffer(raw) {
    if (!raw) return null;
    if (Buffer.isBuffer(raw)) {
      return raw.length ? raw : null;
    }
    if (ArrayBuffer.isView(raw)) {
      if (raw.byteLength === 0) return null;
      return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
    }
   if (Array.isArray(raw)) {
      if (!raw.length) return null;
      const buf = Buffer.alloc(raw.length * 2);
      for (let i = 0; i < raw.length; i++) {
        buf.writeInt16LE(raw[i] | 0, i * 2);
      }
      if (DEBUG_MIC) {
        console.log(`[mic] converted array samples=${raw.length}`);
      }
      return buf;
    }
    if (typeof raw === 'object' && typeof raw.length === 'number') {
      if (!raw.length) return null;
      const buf = Buffer.alloc(raw.length * 2);
      for (let i = 0; i < raw.length; i++) {
        buf.writeInt16LE(raw[i] | 0, i * 2);
      }
      if (DEBUG_MIC) {
        console.log(`[mic] converted typed object samples=${raw.length}`);
      }
      return buf;
    }
    return null;
  }

  const tick = () => {
    if (stopped) return;
    const raw = PortAudio.getRecordedSamples();
    const buffer = toPcmBuffer(raw);
    if (!buffer || buffer.length === 0) {
      if (DEBUG_MIC) {
        console.log('[mic] no samples');
      }
      return;
    }
    const sampleCount = buffer.length / 2;
    if (!paused) {
      onChunk(buffer);
    } else if (DEBUG_MIC) {
      console.log(`[mic] paused, dropping ${buffer.length} bytes`);
    }
    if (sampleCount > 0 && typeof PortAudio.discardRecordedSamples === 'function') {
      try {
        PortAudio.discardRecordedSamples(sampleCount);
      } catch (_) {}
    }
  };

  return {
    start() {
      if (started) return;
      PortAudio.initSampleBuffers(MIC_SAMPLE_RATE, MIC_SAMPLE_RATE, MIC_BLOCK_SIZE);
      PortAudio.startMic();
      paused = false;
      stopped = false;
      timer = setInterval(tick, MIC_TICK_MS);
      started = true;
    },
    pause() {
      paused = true;
      onPause?.();
      if (DEBUG_MIC) {
        console.log('[mic] paused');
      }
    },
    resume() {
      if (!stopped) {
        paused = false;
        if (DEBUG_MIC) {
          console.log('[mic] resumed');
        }
      }
    },
    shutdown() {
      if (stopped) return;
      stopped = true;
      paused = true;
      onShutdown?.();
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      try {
        PortAudio.stopMic();
      } catch (_) {}
      if (DEBUG_MIC) {
        console.log('[mic] shutdown');
      }
    },
  };
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

function sendSessionConfiguration() {
  if (realtimeSocket?.readyState !== WebSocket.OPEN) return;
  realtimeSocket.send(
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
}

async function handleRealtimeMessage(data) {
  let message;
  try {
    message = JSON.parse(data.toString());
  } catch (error) {
    console.error(`[voice-agent] メッセージ解析エラー: ${error.message}`);
    return;
  }
  if (await handleTranscriptionEnvelope(message)) {
    return;
  }
  if (message.type === 'error') {
    console.error(`[voice-agent] API エラー: ${message.error?.message ?? '詳細不明'}`);
  }
}

function enqueueUtterance(utterance) {
  pendingUtterances.push(utterance);
  if (!processingQueue) {
    processQueue();
  }
}

async function processQueue() {
  processingQueue = true;
  while (pendingUtterances.length) {
    const item = pendingUtterances.shift();
    if (!item) {
      continue;
    }
    await runTurn(item).catch((error) => {
      console.error(`[voice-agent] モデル処理エラー: ${error.message}`);
    });
  }
  processingQueue = false;
}

async function runTurn({ text, timestamp }) {
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }

  console.log(`[voice-agent] LLM へ送信: ${trimmed}`);
  addToConversation(createMessage('user', trimmed));

  let iteration = 0;
  let continueLoop = true;
  while (continueLoop && iteration < MAX_TOOL_ITERATIONS) {
    let textOutputs = [];
    let toolCalls = [];

    if (LLM_PROVIDER === 'groq') {
      if (!GROQ_API_KEY) {
        throw new Error('GROQ_API_KEY が設定されていません (.env で指定してください)');
      }
      const response = await callGroqChat({
        conversation,
        tools: hasTools ? toolDefinitions : null,
      });
      ({ textOutputs, toolCalls } = dissectGroqResponse(response));
    } else {
      const requestBody = {
        model: MODEL_ID,
        input: conversation,
        parallel_tool_calls: false,
      };

      if (hasTools) {
        requestBody.tools = toolDefinitions;
        requestBody.tool_choice = 'auto';
      }

      const response = await client.responses.create(requestBody);
      ({ textOutputs, toolCalls } = dissectResponse(response));
    }

    textOutputs.forEach((output) => {
      console.log(`[assistant] ${output}`);
      addToConversation(createMessage('assistant', output));
      playbackQueue?.enqueue({ text: output });
    });

    if (!toolCalls.length) {
      continueLoop = false;
      break;
    }

    const toolContext = {
      userText: trimmed,
      timestamp,
      conversationSize: conversation.length,
    };

    for (const call of toolCalls) {
      addToConversation({
        type: 'function_call',
        call_id: call.call_id,
        name: call.name,
        arguments: call.arguments,
      });

      const toolOutput = await routeToolCall(call, toolContext).catch((error) => ({
        call_id: call.call_id,
        output: JSON.stringify({ error: error.message }),
      }));

      addToConversation({
        type: 'function_call_output',
        call_id: toolOutput.call_id,
        output: toolOutput.output,
      });
      console.log(`[tool:${call.name}] ${toolOutput.output}`);
    }

    iteration += 1;
  }

  if (iteration >= MAX_TOOL_ITERATIONS) {
    console.error('[voice-agent] ツール呼び出しの繰り返し上限に達しました');
  }
}

function createMessage(role, text) {
  const contentType = role === 'assistant' ? 'output_text' : 'input_text';
  return {
    role,
    type: 'message',
    content: [
      {
        type: contentType,
        text,
      },
    ],
  };
}

function addToConversation(item) {
  conversation.push(item);
  pruneConversation();
}

function pruneConversation() {
  if (conversation.length <= MAX_HISTORY_ITEMS) {
    return;
  }
  const systemMessages = conversation.filter((item) => item.role === 'system');
  const others = conversation.filter((item) => item.role !== 'system');
  const trimmed = others.slice(-MAX_HISTORY_ITEMS);
  conversation.length = 0;
  conversation.push(...systemMessages, ...trimmed);
}

function dissectResponse(response) {
  const textOutputs = [];
  const toolCalls = [];
  const items = Array.isArray(response.output) ? response.output : [];

  for (const item of items) {
    if (item.type === 'message' && Array.isArray(item.content)) {
      const textParts = item.content
        .filter((content) => content && content.type === 'output_text')
        .map((content) => content.text)
        .filter(Boolean);
      if (textParts.length) {
        textOutputs.push(textParts.join(''));
      }
    }

    if (item.type === 'function_call') {
      toolCalls.push({
        call_id: item.call_id,
        name: item.name,
        arguments: item.arguments,
      });
    }
  }

  return { textOutputs, toolCalls };
}

async function callGroqChat({ conversation: items, tools }) {
  const messages = convertConversationToGroqMessages(items);
  const body = {
    model: GROQ_MODEL_ID,
    messages,
  };

  if (Array.isArray(tools) && tools.length) {
    body.tools = normalizeToolsForChat(tools);
    body.tool_choice = 'auto';
  }

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Groq API リクエスト失敗: ${response.status} ${response.statusText} ${errorText}`.trim());
  }

  return response.json();
}

function normalizeToolsForChat(tools) {
  return tools.map((tool) => {
    if (!tool || tool.type !== 'function') {
      return tool;
    }
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    };
  });
}

function convertConversationToGroqMessages(items) {
  const messages = [];
  for (const item of items) {
    if (!item) {
      continue;
    }
    if (item.type === 'message') {
      const role = item.role ?? 'user';
      const text = extractTextFromContent(item.content);
      messages.push({ role, content: text ?? '' });
      continue;
    }
    if (item.type === 'function_call') {
      const callId = item.call_id ?? `call_${Date.now()}`;
      const args = typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {});
      messages.push({
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: callId,
            type: 'function',
            function: {
              name: item.name,
              arguments: args,
            },
          },
        ],
      });
      continue;
    }
    if (item.type === 'function_call_output') {
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id,
        content: item.output ?? '',
      });
    }
  }
  return messages;
}

function extractTextFromContent(content) {
  if (!Array.isArray(content)) {
    return '';
  }
  const parts = [];
  for (const entry of content) {
    if (entry && typeof entry.text === 'string') {
      parts.push(entry.text);
    }
  }
  return parts.join('');
}

function dissectGroqResponse(response) {
  const textOutputs = [];
  const toolCalls = [];
  const choice = Array.isArray(response?.choices) ? response.choices[0] : null;
  const message = choice?.message ?? {};

  const content = message.content;
  if (typeof content === 'string') {
    if (content.trim()) {
      textOutputs.push(content);
    }
  } else if (Array.isArray(content)) {
    const textParts = content
      .map((entry) => {
        if (!entry) return '';
        if (typeof entry === 'string') return entry;
        if (typeof entry?.text === 'string') return entry.text;
        return '';
      })
      .filter(Boolean);
    if (textParts.length) {
      textOutputs.push(textParts.join(''));
    }
  }

  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      if (!call) continue;
      const fn = call.function ?? {};
      let args = fn.arguments;
      if (typeof args === 'object') {
        args = JSON.stringify(args);
      }
      if (typeof args !== 'string') {
        args = '{}';
      }
      toolCalls.push({
        call_id: call.id ?? `call_${Date.now()}`,
        name: fn.name ?? '',
        arguments: args,
      });
    }
  }

  if (!message.tool_calls && message.function_call) {
    const fn = message.function_call;
    const callId = fn?.name ? `call_${Date.now()}` : `call_${Date.now()}`;
    let args = fn?.arguments;
    if (typeof args === 'object') {
      args = JSON.stringify(args);
    }
    if (typeof args !== 'string') {
      args = '{}';
    }
    toolCalls.push({
      call_id: callId,
      name: fn?.name ?? '',
      arguments: args,
    });
  }

  return { textOutputs, toolCalls };
}

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

function logPartial(text) {
  if (!text) return;
  if (text === lastPartialTranscript) return;
  lastPartialTranscript = text;
  process.stdout.write(`\r[speech:partial] ${text}`);
}

async function handleFinalTranscript(raw) {
  const normalized = ensureTrailingPunctuation((raw ?? '').trim());
  if (!normalized) {
    return;
  }
  lastPartialTranscript = '';
  process.stdout.write('\r');
  console.log(`[speech:final] ${normalized}`);
  enqueueUtterance({ text: normalized, timestamp: Date.now() });
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

async function processTranscriptPayload(transcript, stageHint) {
  const text = typeof transcript === 'string' ? transcript : '';
  const stage = typeof stageHint === 'string' ? stageHint.toLowerCase() : '';
  if (FINAL_STAGE_HINTS.has(stage)) {
    await handleFinalTranscript(text);
    return true;
  }
  if (text) {
    logPartial(text);
    return true;
  }
  if (PARTIAL_STAGE_HINTS.has(stage)) {
    lastPartialTranscript = '';
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
