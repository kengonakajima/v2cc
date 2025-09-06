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

// 音声レベル計算用の変数
let audioBuffer = [];
let lastVolumeDisplay = Date.now();

// PCM16データからデシベル値を計算する関数
function calculateDecibels(buffer) {
  if (buffer.length === 0) return -Infinity;
  
  // PCM16は16ビット符号付き整数（-32768 to 32767）
  let sum = 0;
  const samples = buffer.length / 2; // 2 bytes per sample
  
  for (let i = 0; i < buffer.length; i += 2) {
    // リトルエンディアンで16ビット符号付き整数を読み取り
    const sample = buffer.readInt16LE(i);
    sum += sample * sample;
  }
  
  const rms = Math.sqrt(sum / samples);
  // 最大値32768に対する比率をデシベルに変換
  const db = 20 * Math.log10(rms / 32768);
  
  return db;
}

// 環境変数からAPIキーを取得
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY || OPENAI_API_KEY=='') {
  console.error('Error: OPENAI_API_KEY environment variable is not set');
  console.error('Please set it in .env file or export OPENAI_API_KEY=your-api-key');
  process.exit(1);
}

// テキストをターミナルに送信する関数
async function sendToTerminal(text) {
  try {
    const scriptPath = path.join(__dirname, 'send_to_terminals.sh');
    if (fs.existsSync(scriptPath)) {
      await execAsync(`"${scriptPath}" "${text}"`);
      console.log(`✓ Sent: ${text}`);
    } else {
      console.error('Error: send_to_terminals.sh not found');
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
      console.error('Error details:', {
        message: error.message,
        code: error.code,
        type: error.type
      });
      
      // 特定のエラーメッセージをチェック
      if (error.message && error.message.includes('401')) {
        console.error('Authentication failed. Please check your OPENAI_API_KEY.');
      } else if (error.message && error.message.includes('429')) {
        console.error('Rate limit exceeded or quota reached. Please check your OpenAI account.');
      } else if (error.message && error.message.includes('insufficient_quota')) {
        console.error('OpenAI API quota exceeded. Please add credits to your account.');
      }
      
      reject(error);
    });
    
    // 予期しない切断のハンドリング
    ws.on('unexpected-response', (request, response) => {
      console.error('\nUnexpected response from server:', response.statusCode, response.statusMessage);
      let body = '';
      response.on('data', chunk => body += chunk);
      response.on('end', () => {
        try {
          const errorData = JSON.parse(body);
          console.error('Error details:', errorData);
          
          if (errorData.error) {
            if (errorData.error.code === 'insufficient_quota' || 
                (errorData.error.message && errorData.error.message.includes('quota'))) {
              console.error('\n⚠️  OpenAI API quota exceeded.');
              console.error('Your account has insufficient credits.');
              console.error('Please add credits at: https://platform.openai.com/account/billing');
            } else if (errorData.error.code === 'model_not_found') {
              console.error('\n⚠️  Model not found or not accessible.');
              console.error('Make sure you have access to gpt-4o-realtime-preview');
            }
          }
        } catch (e) {
          console.error('Response body:', body);
        }
      });
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
  let ws;
  try {
    ws = await connectToRealtimeAPI();
  } catch (error) {
    console.error('\nFailed to connect to OpenAI Realtime API');
    console.error('Error:', error.message);
    
    // 特定のエラーに対する追加情報
    if (error.message && error.message.includes('403')) {
      console.error('\n⚠️  Access denied (403). Possible causes:');
      console.error('- Invalid API key');
      console.error('- API key does not have access to Realtime API');
      console.error('- Account does not have access to the model');
    } else if (error.message && error.message.includes('401')) {
      console.error('\n⚠️  Authentication failed (401).');
      console.error('Please check that your OPENAI_API_KEY is valid.');
    } else if (error.message && error.message.includes('ENOTFOUND')) {
      console.error('\n⚠️  Could not resolve API hostname.');
      console.error('Please check your internet connection.');
    }
    
    process.exit(1);
  }
  
  // メッセージハンドラ
  ws.on('message', async (data) => {
    const message = JSON.parse(data.toString());
    
    // 音声認識結果を処理
    if (message.type === 'conversation.item.input_audio_transcription.completed') {
      const transcript = message.transcript;
      if (transcript && transcript.trim()) {
        // 音声レベル表示をクリアして、転写結果を表示
        process.stdout.write('\r' + ' '.repeat(50) + '\r');
        console.log(`Transcribed: ${transcript}`);
        await sendToTerminal(transcript);
      }
    }
    
    // エラーメッセージの詳細表示
    if (message.type === 'error') {
      console.error('\nAPI Error:', message.error);
      if (message.error) {
        console.error('Error details:', {
          type: message.error.type,
          code: message.error.code,
          message: message.error.message,
          param: message.error.param
        });
        
        // 特定のエラータイプに対する追加情報
        if (message.error.code === 'insufficient_quota') {
          console.error('\n⚠️  Your OpenAI account has insufficient quota.');
          console.error('Please add credits at: https://platform.openai.com/account/billing');
        } else if (message.error.code === 'invalid_api_key') {
          console.error('\n⚠️  Invalid API key. Please check your OPENAI_API_KEY.');
        }
      }
    }
    
    // セッションエラーの処理
    if (message.type === 'session.error') {
      console.error('\nSession Error:', message);
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
    // 音声レベルの計算用にバッファに追加
    audioBuffer.push(chunk);
    
    // 0.5秒ごとに音声レベルを表示
    const now = Date.now();
    if (now - lastVolumeDisplay >= 500) {
      // バッファ内の全データを結合
      const combinedBuffer = Buffer.concat(audioBuffer);
      const db = calculateDecibels(combinedBuffer);
      
      // デシベル値を表示（-60dB以上の場合のみ）
      if (db > -60) {
        const level = Math.min(Math.max(0, db + 60), 60); // -60～0dBを0～60にマッピング
        const bars = '█'.repeat(Math.floor(level / 2));
        process.stdout.write(`\rVolume: ${db.toFixed(1)} dB ${bars.padEnd(30, ' ')}`);
      } else {
        process.stdout.write(`\rVolume: Silent                                `);
      }
      
      // バッファをクリア
      audioBuffer = [];
      lastVolumeDisplay = now;
    }
    
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
