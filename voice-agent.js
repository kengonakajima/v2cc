#!/usr/bin/env node

import 'dotenv/config';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';
import path from 'path';
import process from 'process';
import OpenAI from 'openai';
import { getToolDefinitions, routeToolCall } from './tool-router.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY が設定されていません (.env で指定してください)');
  process.exit(1);
}

const MODEL_ID = process.env.OPENAI_MODEL ?? 'gpt-5-mini';
const TRANSCRIBE_PATH = path.join(__dirname, 'transcribe.js');
const MAX_TOOL_ITERATIONS = Number.parseInt(process.env.VOICE_AGENT_TOOL_LOOP_MAX ?? '3', 10);
const MAX_HISTORY_ITEMS = Number.parseInt(process.env.VOICE_AGENT_HISTORY_LIMIT ?? '20', 10);
const TRANSCRIBE_STATUS_PATTERNS = [
  /Realtime API/, /マイク入力を開始します/, /WebSocket エラー/, /API エラー/, /Fatal error/,
];

const client = new OpenAI({ apiKey: OPENAI_API_KEY });
const toolDefinitions = getToolDefinitions();
const hasTools = toolDefinitions.length > 0;

const conversation = [];
const pendingUtterances = [];
let processingQueue = false;
let shuttingDown = false;

const baseSystemPrompt =
  process.env.VOICE_AGENT_SYSTEM_PROMPT ??
  'You are a proactive Japanese voice assistant.\n' +
    '- Summaries should be concise.\n' +
    '- When a custom tool is required, choose it and explain the action in Japanese.';

addToConversation(createMessage('system', baseSystemPrompt));

startTranscriber();
setupSignalHandlers();

function startTranscriber() {
  console.error('[voice-agent] transcribe.js を起動します');
  const child = spawn(process.execPath, [TRANSCRIBE_PATH], {
    stdio: ['inherit', 'pipe', 'inherit'],
  });

  const rl = createInterface({ input: child.stdout });
  rl.on('line', handleTranscribeLine);

  child.on('exit', (code, signal) => {
    if (shuttingDown) {
      return;
    }
    const suffix = signal ? `signal=${signal}` : `code=${code}`;
    console.error(`[voice-agent] transcribe.js が終了しました (${suffix})`);
    process.exit(typeof code === 'number' ? code : 1);
  });

  process.on('exit', () => {
    shuttingDown = true;
    child.kill('SIGTERM');
  });
}

function setupSignalHandlers() {
  process.on('SIGINT', () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error('\n[voice-agent] SIGINT を受信しました。終了します');
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error('\n[voice-agent] SIGTERM を受信しました。終了します');
    process.exit(0);
  });
}

function handleTranscribeLine(rawLine) {
  const line = rawLine.trim();
  if (!line) return;

  if (line.startsWith('[partial]')) {
    const text = line.slice('[partial]'.length).trim();
    process.stdout.write(`\r[speech:partial] ${text}`);
    return;
  }

  if (TRANSCRIBE_STATUS_PATTERNS.some((pattern) => pattern.test(line))) {
    console.error(`[transcribe] ${line}`);
    return;
  }

  process.stdout.write('\r');
  console.log(`[speech:final] ${line}`);
  enqueueUtterance({ text: line, timestamp: Date.now() });
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
    const { textOutputs, toolCalls } = dissectResponse(response);

    textOutputs.forEach((output) => {
      console.log(`[assistant] ${output}`);
      addToConversation(createMessage('assistant', output));
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
