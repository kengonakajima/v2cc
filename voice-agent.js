#!/usr/bin/env node

import 'dotenv/config';
import process from 'process';
import OpenAI from 'openai';
import { getToolDefinitions, routeToolCall } from './tool-router.js';
import { TtsClient } from './tts-client.js';
import { PlaybackQueue } from './playback-queue.js';
import WebSocket, { WebSocketServer } from 'ws';
import { generateOpenAIOutputs } from './llm/openai-responder.js';
import { generateGroqOutputs } from './llm/groq-responder.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import http from 'http';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY が設定されていません (.env で指定してください)');
  process.exit(1);
}

const args = new Set(process.argv.slice(2));

const LLM_PROVIDER = (process.env.VOICE_AGENT_LLM_PROVIDER ?? 'openai').toLowerCase();
const MODEL_ID = process.env.OPENAI_MODEL ?? 'gpt-5-mini';
const GROQ_MODEL_ID = process.env.GROQ_MODEL ?? 'gpt-oss-120b';
const MAX_TOOL_ITERATIONS = Number.parseInt(process.env.VOICE_AGENT_TOOL_LOOP_MAX ?? '3', 10);
const MAX_HISTORY_ITEMS = Number.parseInt(process.env.VOICE_AGENT_HISTORY_LIMIT ?? '20', 10);

const client = new OpenAI({ apiKey: OPENAI_API_KEY });
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const toolDefinitions = getToolDefinitions();
const hasTools = toolDefinitions.length > 0;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const browserClientPath = path.resolve(__dirname, 'browser-client.html');
const HTTP_PORT = Number.parseInt(process.env.VOICE_AGENT_HTTP_PORT ?? '3000', 10);
const BROWSER_WS_PORT = Number.parseInt(process.env.VOICE_AGENT_BROWSER_WS_PORT ?? '8080', 10);
const MEETING_NOTES_PATH = path.resolve(__dirname, 'meeting-notes.log');
const WORKSPACE_DIR = path.resolve(__dirname, 'workspace');
const TODOS_FILE_PATH = path.resolve(WORKSPACE_DIR, 'todos.json');
const MSG_SEND_SOUND_PATH = path.resolve(__dirname, 'msgsnd.mp3');
const WORK_SOUND_PATH = path.resolve(__dirname, 'work.mp3');

const todoState = {
  loaded: false,
  nextId: 1,
  todos: [],
};

let notificationSoundBase64 = null;
let workSoundBase64 = null;

let browserClientHtml = '';
try {
  browserClientHtml = fs.readFileSync(browserClientPath, 'utf8');
} catch (error) {
  console.error(`[voice-agent] browser-client.html を読み込めませんでした: ${error.message}`);
}

const httpServer = http.createServer((req, res) => {
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.end('Method Not Allowed');
    return;
  }
  if (!browserClientHtml) {
    res.statusCode = 500;
    res.end('browser-client.html not available');
    return;
  }
  const requestUrl = new URL(req.url ?? '/', `http://localhost:${HTTP_PORT}`);
  if (requestUrl.pathname === '/favicon.ico') {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (requestUrl.pathname === '/' || requestUrl.pathname === '/browser-client.html') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(browserClientHtml);
    return;
  }
  res.statusCode = 404;
  res.end('Not Found');
});

httpServer.listen(HTTP_PORT, () => {
  console.error(`[voice-agent] ブラウザクライアントを開く: http://localhost:${HTTP_PORT}/`);
});

httpServer.on('error', (error) => {
  console.error(`[voice-agent] HTTP サーバーエラー: ${error.message}`);
});

let browserWsServer = null;
const browserClients = new Set();

try {
  browserWsServer = new WebSocketServer({ port: BROWSER_WS_PORT });
  browserWsServer.on('connection', (socket, req) => {
    const requestUrl = new URL(req.url ?? '/', `ws://localhost:${BROWSER_WS_PORT}`);
    if (requestUrl.pathname !== '/audio') {
      socket.close(1008, 'Invalid path');
      return;
    }
    browserClients.add(socket);
    sendTodosSnapshotToSocket(socket).catch((error) => {
      console.error(`[voice-agent] TODO 初期送信失敗: ${error.message}`);
    });
    socket.on('message', (data) => {
      handleBrowserSocketMessage(socket, data);
    });
    socket.on('error', (error) => {
      console.error(`[voice-agent] ブラウザWSエラー: ${error.message}`);
    });
    socket.on('close', () => {
      browserClients.delete(socket);
    });
  });
  browserWsServer.on('listening', () => {
    console.error(`[voice-agent] ブラウザ音声 WebSocket: ws://localhost:${BROWSER_WS_PORT}/audio`);
  });
  browserWsServer.on('error', (error) => {
    console.error(`[voice-agent] ブラウザ WebSocket サーバーエラー: ${error.message}`);
  });
} catch (error) {
  console.error(`[voice-agent] ブラウザ用 WebSocket サーバーを開始できませんでした: ${error.message}`);
}

const ttsDisabledFlag = args.has('--no-tts');
const ttsEnvDisabled = (process.env.VOICE_AGENT_TTS_ENABLED ?? 'true').toLowerCase() === 'false';
const ttsModel = process.env.VOICE_AGENT_TTS_MODEL ?? 'gpt-4o-mini-tts';
const ttsVoice = process.env.VOICE_AGENT_TTS_VOICE ?? 'alloy';
const ttsInstructions =
  process.env.VOICE_AGENT_TTS_INSTRUCTIONS ??
  '必ず日本語で読み上げ、数字は各桁を日本語の読みで発音してください。';

let playbackQueue = null;
if (!ttsDisabledFlag && !ttsEnvDisabled) {
  try {
    const ttsClient = new TtsClient(client, {
      model: ttsModel,
      voice: ttsVoice,
      instructions: ttsInstructions,
    });
    playbackQueue = new PlaybackQueue({
      audioPlayer: createBrowserAudioOutput(),
      ttsClient,
      enabled: true,
    });
  } catch (error) {
    console.error(`[voice-agent] TTS 初期化に失敗しました: ${error.message}`);
  }
}

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
let lastPartialTranscript = '';

const baseSystemPrompt =
  process.env.VOICE_AGENT_SYSTEM_PROMPT ??
  'You are a proactive Japanese voice assistant.\n' +
    '- Summaries should be concise.\n' +
    '- When a custom tool is required, choose it and explain the action in Japanese.\n' +
    '- Speak in natural conversational Japanese. Avoid written list formatting, emojis, excessive symbols, or long strings of numbers. Keep responses brief.\n' +
    '- Prefer sentences no longer than about 30 Japanese characters; insert a line break before starting a new short sentence.\n' +
    '- 会議コンパニオンとして常に傾聴し、議事録はシステム側で自動保存される前提で振る舞う。\n' +
    '- 明確な依頼やあなたの名前「SuperSlack」を含む直接の呼びかけがあるときだけ応答し、冒頭で依頼内容を手短に復唱してから答える。\n' +
    '- 復唱は、もとの依頼内容を一言一句繰り返す必要はなく、とても短い要約を言う。\n' +
    '- 依頼の文章が終わっていない、つまり。記号がないときは、依頼は完成していません。応答をせず待ちます。\n' +            
    '- 依頼が無い発話には応答メッセージを出さない。\n' +
    '- 不要な確認や促し（例: 「何かご用はありますか？」）を繰り返さない。\n' +
    '- When mathematical expressions are needed, describe them verbally without mathematical symbols so they are easy to speak aloud.';

addToConversation(createMessage('system', baseSystemPrompt));

ensureTodosLoaded().then(() => {
  console.log(`[voice-agent] TODO 初期化完了 (${todoState.todos.length} 件)`);
});

loadNotificationSound().catch((error) => {
  console.error(`[voice-agent] 通知音初期化失敗: ${error.message}`);
});

loadWorkSound().catch((error) => {
  console.error(`[voice-agent] ツール通知音初期化失敗: ${error.message}`);
});

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
      if (browserWsServer) {
        try {
          for (const client of browserWsServer.clients) {
            client.close();
          }
        } catch (_) {}
        await new Promise((resolve) => {
          browserWsServer.close(() => resolve());
        });
        browserWsServer = null;
        browserClients.clear();
      }
      if (httpServer) {
        await new Promise((resolve) => {
          httpServer.close(() => resolve());
        });
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

  console.error('[voice-agent] ローカルマイク入力は削除されています。ブラウザ経由の音声のみを利用します。');
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

function handleBrowserSocketMessage(socket, data) {
  if (!data) {
    return;
  }
  let payload;
  try {
    const text = typeof data === 'string' ? data : data.toString();
    payload = JSON.parse(text);
  } catch (error) {
    socket.send(JSON.stringify({ type: 'error', message: `invalid payload: ${error.message}` }));
    return;
  }

  if (!payload || typeof payload !== 'object') {
    socket.send(JSON.stringify({ type: 'error', message: 'payload must be an object' }));
    return;
  }

  switch (payload.type) {
    case 'config': {
      socket.send(JSON.stringify({ type: 'ack', message: 'config received' }));
      break;
    }
    case 'audio': {
      const audioBase64 = typeof payload.data === 'string' ? payload.data : null;
      if (!audioBase64) {
        socket.send(JSON.stringify({ type: 'error', message: 'audio data missing' }));
        return;
      }
      const level = calculateLevelFromBase64(audioBase64);
      if (Number.isFinite(level)) {
        socket.send(
          JSON.stringify({ type: 'server_level', level })
        );
      }
      if (!forwardAudioBase64(audioBase64)) {
        socket.send(JSON.stringify({ type: 'error', message: 'realtime socket not ready' }));
      }
      break;
    }
    case 'end': {
      if (!commitBrowserAudio()) {
        socket.send(JSON.stringify({ type: 'error', message: 'failed to commit audio' }));
      } else {
        socket.send(JSON.stringify({ type: 'ack', message: 'audio committed' }));
      }
      break;
    }
    case 'ping': {
      socket.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
      break;
    }
    default: {
      socket.send(JSON.stringify({ type: 'error', message: 'unknown type' }));
      break;
    }
  }
}

function forwardAudioBase64(base64) {
  if (!realtimeSocket || realtimeSocket.readyState !== WebSocket.OPEN) {
    return false;
  }
  try {
    realtimeSocket.send(
      JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: base64,
      })
    );
    return true;
  } catch (error) {
    console.error(`[voice-agent] 音声フレーム転送エラー: ${error.message}`);
    return false;
  }
}

function commitBrowserAudio() {
  if (!realtimeSocket || realtimeSocket.readyState !== WebSocket.OPEN) {
    return false;
  }
  try {
    realtimeSocket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    return true;
  } catch (error) {
    console.error(`[voice-agent] 音声コミットエラー: ${error.message}`);
    return false;
  }
}

function calculateLevelFromBase64(base64) {
  if (!base64 || typeof base64 !== 'string') {
    return 0;
  }
  const audioBuffer = Buffer.from(base64, 'base64');
  if (!audioBuffer || audioBuffer.length < 2) {
    return 0;
  }
  const sampleCount = Math.floor(audioBuffer.length / 2);
  if (sampleCount === 0) {
    return 0;
  }
  let sumSquares = 0;
  for (let i = 0; i < sampleCount; i += 1) {
    const sample = audioBuffer.readInt16LE(i * 2);
    sumSquares += sample * sample;
  }
  if (sumSquares === 0) {
    return 0;
  }
  const rms = Math.sqrt(sumSquares / sampleCount);
  return Math.max(0, Math.min(1, rms / 32768));
}

function broadcastToBrowserClients(payload) {
  if (!payload) {
    return;
  }
  let message;
  try {
    message = JSON.stringify(payload);
  } catch (error) {
    console.error(`[voice-agent] ブロードキャスト失敗 (JSON 化エラー): ${error.message}`);
    return;
  }
  for (const client of browserClients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    try {
      client.send(message);
    } catch (error) {
      console.error(`[voice-agent] ブラウザ送信エラー: ${error.message}`);
    }
  }
}

function getSafeTodoDescription(description) {
  if (typeof description !== 'string') {
    return '';
  }
  const trimmed = description.trim();
  return trimmed || '';
}

function cloneTodoEntry(entry) {
  return {
    id: entry.id,
    description: entry.description,
    done: entry.done,
  };
}

function loadTodosFromParsed(parsed) {
  if (!Array.isArray(parsed)) {
    todoState.todos = [];
    todoState.nextId = 1;
    return;
  }

  const normalized = [];
  let maxId = 0;

  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const rawId = Number.parseInt(entry.id, 10);
    if (!Number.isFinite(rawId) || rawId <= 0) {
      continue;
    }
    const description = getSafeTodoDescription(entry.description);
    const done = Boolean(entry.done);
    normalized.push({ id: rawId, description, done });
    if (rawId > maxId) {
      maxId = rawId;
    }
  }

  normalized.sort((a, b) => a.id - b.id);
  todoState.todos = normalized;
  todoState.nextId = maxId + 1;
  if (todoState.nextId <= 1) {
    todoState.nextId = 1;
  }
}

function serializeTodos() {
  const payload = todoState.todos.map((entry) => ({
    id: entry.id,
    description: entry.description,
    done: entry.done,
  }));
  return `${JSON.stringify(payload, null, 2)}\n`;
}

async function persistTodos() {
  const json = serializeTodos();
  return fs.promises.writeFile(TODOS_FILE_PATH, json, 'utf8').catch((error) => {
    console.error(`[voice-agent] TODO 書き込み失敗: ${error.message}`);
  });
}

function findTodoIndexById(id) {
  if (!Number.isFinite(id)) {
    return -1;
  }
  return todoState.todos.findIndex((entry) => entry.id === id);
}

async function ensureTodosLoaded() {
  if (todoState.loaded) {
    return;
  }
  await fs.promises.mkdir(WORKSPACE_DIR, { recursive: true }).catch((error) => {
    console.error(`[voice-agent] TODO ディレクトリ作成失敗: ${error.message}`);
  });

  await fs.promises
    .readFile(TODOS_FILE_PATH, 'utf8')
    .then((content) => {
      const parsed = JSON.parse(content);
      loadTodosFromParsed(parsed);
    })
    .catch((error) => {
      if (error && error.code === 'ENOENT') {
        todoState.todos = [];
        todoState.nextId = 1;
        return persistTodos();
      }
      console.error(`[voice-agent] TODO 読み込み失敗: ${error.message}`);
      todoState.todos = [];
      todoState.nextId = 1;
      return persistTodos();
    });

  todoState.loaded = true;
}

async function getTodos() {
  await ensureTodosLoaded();
  return todoState.todos.map(cloneTodoEntry);
}

async function addTodo(description) {
  await ensureTodosLoaded();
  const safeDescription = getSafeTodoDescription(description);
  if (!safeDescription) {
    return null;
  }
  const todo = {
    id: todoState.nextId,
    description: safeDescription,
    done: false,
  };
  todoState.nextId += 1;
  todoState.todos.push(todo);
  await persistTodos();
  return cloneTodoEntry(todo);
}

async function updateTodoDescription(id, description) {
  await ensureTodosLoaded();
  const numericId = Number.parseInt(id, 10);
  const index = findTodoIndexById(numericId);
  if (index < 0) {
    return null;
  }
  const safeDescription = getSafeTodoDescription(description);
  if (!safeDescription) {
    return null;
  }
  const target = todoState.todos[index];
  target.description = safeDescription;
  await persistTodos();
  return cloneTodoEntry(target);
}

async function removeTodo(id) {
  await ensureTodosLoaded();
  const numericId = Number.parseInt(id, 10);
  const index = findTodoIndexById(numericId);
  if (index < 0) {
    return false;
  }
  todoState.todos.splice(index, 1);
  await persistTodos();
  return true;
}

async function setTodoDone(id, done) {
  await ensureTodosLoaded();
  const numericId = Number.parseInt(id, 10);
  const index = findTodoIndexById(numericId);
  if (index < 0) {
    return null;
  }
  const target = todoState.todos[index];
  target.done = Boolean(done);
  await persistTodos();
  return cloneTodoEntry(target);
}

async function loadNotificationSound() {
  try {
    const data = await fs.promises.readFile(MSG_SEND_SOUND_PATH);
    if (data && data.length) {
      notificationSoundBase64 = data.toString('base64');
      console.log('[voice-agent] 通知音を読み込みました');
    }
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      console.error(`[voice-agent] 通知音ファイルが見つかりません: ${MSG_SEND_SOUND_PATH}`);
    } else {
      console.error(`[voice-agent] 通知音読み込み失敗: ${error.message}`);
    }
    notificationSoundBase64 = null;
  }
}

function broadcastNotificationSound() {
  if (!notificationSoundBase64) {
    return;
  }
  broadcastToBrowserClients({
    type: 'audio_notification',
    format: 'mp3',
    audio: notificationSoundBase64,
  });
}

async function loadWorkSound() {
  try {
    const data = await fs.promises.readFile(WORK_SOUND_PATH);
    if (data && data.length) {
      workSoundBase64 = data.toString('base64');
      console.log('[voice-agent] ツール通知音を読み込みました');
    }
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      console.error(`[voice-agent] ツール通知音ファイルが見つかりません: ${WORK_SOUND_PATH}`);
    } else {
      console.error(`[voice-agent] ツール通知音読み込み失敗: ${error.message}`);
    }
    workSoundBase64 = null;
  }
}

function broadcastWorkSound() {
  if (!workSoundBase64) {
    return;
  }
  broadcastToBrowserClients({
    type: 'audio_notification',
    format: 'mp3',
    audio: workSoundBase64,
  });
}

async function getTodoSnapshot() {
  await ensureTodosLoaded();
  return todoState.todos.map(cloneTodoEntry);
}

async function broadcastTodosSnapshot() {
  const todos = await getTodoSnapshot();
  broadcastToBrowserClients({ type: 'todos_sync', todos });
}

async function sendTodosSnapshotToSocket(socket) {
  if (!socket) {
    return;
  }
  await ensureTodosLoaded();
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  const payload = { type: 'todos_sync', todos: todoState.todos.map(cloneTodoEntry) };
  const message = JSON.stringify(payload);
  socket.send(message);
}

const todoApi = {
  async list() {
    return getTodoSnapshot();
  },
  async add(description) {
    const todo = await addTodo(description);
    if (todo) {
      await broadcastTodosSnapshot();
    }
    return todo;
  },
  async remove(id) {
    const removed = await removeTodo(id);
    if (removed) {
      await broadcastTodosSnapshot();
    }
    return removed;
  },
  async update(id, description) {
    const todo = await updateTodoDescription(id, description);
    if (todo) {
      await broadcastTodosSnapshot();
    }
    return todo;
  },
  async setDone(id, done) {
    const todo = await setTodoDone(id, done);
    if (todo) {
      await broadcastTodosSnapshot();
    }
    return todo;
  },
};

function createBrowserAudioOutput() {
  return {
    enqueue(samples, sampleRate) {
      if (!(samples instanceof Int16Array)) {
        return;
      }
      const buffer = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
      const base64 = buffer.toString('base64');
      broadcastToBrowserClients({
        type: 'tts',
        sampleRate,
        audio: base64,
      });
    },
    async shutdown() {
      // no-op for browser audio
    },
  };
}

async function logMeetingNote(text, isoTimestamp) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) {
    return;
  }
  const timestamp = isoTimestamp ?? new Date().toISOString();
  try {
    await fs.promises.appendFile(MEETING_NOTES_PATH, `[${timestamp}] ${trimmed}\n`, 'utf8');
    console.log(`[meeting-note] saved ${timestamp} -> ${trimmed}`);
  } catch (error) {
    console.error(`[voice-agent] 議事録書き込み失敗: ${error.message}`);
    return;
  }
  broadcastToBrowserClients({ type: 'meeting_record', text: trimmed, timestamp });
}

const SILENT_RESPONSES = new Set(['（静かに傾聴）', '（応答なし）', '(silence)', '(no response)']);

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
      ({ textOutputs, toolCalls } = await generateGroqOutputs({
        apiKey: GROQ_API_KEY,
        modelId: GROQ_MODEL_ID,
        conversation,
        tools: hasTools ? toolDefinitions : null,
      }));
    } else {
      ({ textOutputs, toolCalls } = await generateOpenAIOutputs({
        client,
        modelId: MODEL_ID,
        conversation,
        tools: hasTools ? toolDefinitions : null,
      }));
    }

    for (const output of textOutputs) {
      const text = typeof output === 'string' ? output.trim() : '';
      if (!text || SILENT_RESPONSES.has(text)) {
        continue;
      }
      console.log(`[assistant] ${text}`);
      addToConversation(createMessage('assistant', text));
      broadcastToBrowserClients({ type: 'assistant_text', text });
      broadcastNotificationSound();
      playbackQueue?.enqueue({ text });
    }

    if (!toolCalls.length) {
      continueLoop = false;
      break;
    }

    const toolContext = {
      userText: trimmed,
      timestamp,
      conversationSize: conversation.length,
      todoApi,
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
      broadcastWorkSound();
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
  const occurredAtIso = new Date().toISOString();
  await logMeetingNote(normalized, occurredAtIso);
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
