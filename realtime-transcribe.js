#!/usr/bin/env node

import 'dotenv/config';
import { RealtimeClient } from '@openai/realtime-api-beta';
import WebSocket from 'ws';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const record = require('node-record-lpcm16');

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 環境変数からAPIキーを取得
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('Error: OPENAI_API_KEY environment variable is not set');
  console.error('Please set it in .env file or export OPENAI_API_KEY=your-api-key');
  process.exit(1);
}

// テキストをターミナルに送信する関数
async function sendToTerminal(text) {
  try {
    const scriptPath = path.join(__dirname, 'send_to_claude.sh');
    if (fs.existsSync(scriptPath)) {
      await execAsync(`"${scriptPath}" "${text}"`);
      console.log(`✓ Sent: ${text}`);
    } else {
      console.error('Error: send_to_claude.sh not found');
    }
  } catch (error) {
    console.error('Error sending to terminal:', error);
  }
}

// Realtime APIに接続
async function connectToRealtimeAPI() {
  const url = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview';
  
  const ws = new WebSocket(url, {
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1'
    }
  });

  return new Promise((resolve, reject) => {
    ws.on('open', () => {
      console.log('Connected to OpenAI Realtime API');
      
      // セッション設定
      ws.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['audio', 'text'],
          instructions: 'You are a Japanese transcription assistant. Transcribe exactly what the user says in Japanese. Never output Korean characters. Always use Japanese (hiragana, katakana, or kanji) for transcription.',
          voice: 'alloy',
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          input_audio_transcription: {
            model: 'whisper-1'
          },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 200
          },
          temperature: 0.8
        }
      }));
      
      resolve(ws);
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
      reject(error);
    });
  });
}

// メイン処理
async function main() {
  console.log('Starting v2t with OpenAI Realtime API...');
  console.log('Press Ctrl+C to stop\n');
  
  // SoXチェック
  try {
    await execAsync('sox --version');
  } catch (error) {
    console.error('Error: SoX is not installed.');
    console.error('Please install SoX: brew install sox');
    process.exit(1);
  }
  
  // Realtime APIに接続
  const ws = await connectToRealtimeAPI();
  
  // メッセージハンドラ
  ws.on('message', async (data) => {
    const message = JSON.parse(data.toString());
    
    // 音声認識結果を処理
    if (message.type === 'conversation.item.input_audio_transcription.completed') {
      const transcript = message.transcript;
      if (transcript && transcript.trim()) {
        console.log(`Transcribed: ${transcript}`);
        await sendToTerminal(transcript);
      }
    }
    
    // デバッグ用
    if (message.type === 'error') {
      console.error('API Error:', message.error);
    }
  });
  
  // マイク録音を開始
  const mic = record.record({
    sampleRate: 24000, // Realtime APIは24kHzを推奨
    channels: 1,
    audioType: 'raw',
    threshold: 0,
    silence: '10.0',
    recordProgram: 'sox', // or 'arecord' on Linux
  });
  
  const micStream = mic.stream();
  console.log('Listening for speech...');
  
  // 音声データをRealtime APIに送信
  micStream.on('data', (chunk) => {
    if (ws.readyState === WebSocket.OPEN) {
      // 音声データをbase64エンコードして送信
      const base64Audio = chunk.toString('base64');
      ws.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: base64Audio
      }));
    }
  });
  
  micStream.on('error', (error) => {
    console.error('Microphone error:', error);
  });
  
  // 接続が切れた場合の処理
  ws.on('close', () => {
    console.log('Disconnected from OpenAI Realtime API');
    mic.stop();
    process.exit(0);
  });
  
  // 終了処理
  process.on('SIGINT', () => {
    console.log('\nStopping...');
    mic.stop();
    ws.close();
    process.exit(0);
  });
}

// アプリケーション開始
main().catch(console.error);