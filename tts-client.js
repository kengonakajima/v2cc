const MAX_SEGMENT_CHARS = Math.max(10, Number.parseInt(process.env.VOICE_AGENT_TTS_SEGMENT_MAX ?? '70', 10));
const TARGET_SEGMENT_CHARS = Math.max(
  5,
  Math.min(MAX_SEGMENT_CHARS, Number.parseInt(process.env.VOICE_AGENT_TTS_SEGMENT_TARGET ?? '30', 10))
);
const PCM_SAMPLE_RATE = 24000;
const CANDIDATE_DELIMITERS = ['。', '．', '.', '！', '!', '？', '?', '、', ',', '，', ';', '；', ':', '：', '※'];
const OPEN_BRACKETS = ['「', '『', '（', '(', '[', '{', '〈', '《', '“', '"'];
const CLOSE_BRACKETS = ['」', '』', '）', ')', ']', '}', '〉', '》', '”', '"'];
const WHITESPACE_REGEX = /\s+/g;
const TOKEN_DELIMITERS = new Set([...CANDIDATE_DELIMITERS, ...OPEN_BRACKETS, ...CLOSE_BRACKETS, ' ']);
const LEADING_BREAK_DELIMITERS = new Set(['※', ...OPEN_BRACKETS]);
const TRAILING_BREAK_DELIMITERS = new Set(['。', '．', '.', '！', '!', '？', '?', ...CLOSE_BRACKETS]);

function splitIntoSegments(text) {
  if (!text) return [];
  const normalized = text.replace(WHITESPACE_REGEX, ' ').trim();
  if (!normalized) return [];

  const tokens = tokenize(normalized);
  const segments = [];
  let current = '';

  for (const token of tokens) {
    if (!token) continue;
    const trimmedToken = token.trim();

    if (shouldBreakBefore(trimmedToken) && current.trim()) {
      segments.push(current.trim());
      current = '';
    }

    if (token.length > MAX_SEGMENT_CHARS) {
      if (current.trim()) {
        segments.push(current.trim());
        current = '';
      }
      segments.push(...fallbackChunk(token));
      continue;
    }

    const merged = `${current}${token}`;
    if (merged.trim().length > MAX_SEGMENT_CHARS) {
      if (current.trim()) {
        segments.push(current.trim());
      }
      current = token;
      continue;
    }

    current = merged;
    if (
      current.trim().length >= TARGET_SEGMENT_CHARS ||
      shouldBreakAfter(trimmedToken)
    ) {
      segments.push(current.trim());
      current = '';
    }
  }

  if (current.trim()) {
    segments.push(current.trim());
  }

  const normalizedSegments = segments.flatMap((segment) =>
    segment.length > MAX_SEGMENT_CHARS ? fallbackChunk(segment) : [segment]
  );

  return mergeShortSegments(normalizedSegments);
}

function tokenize(text) {
  const tokens = [];
  let buffer = '';
  for (const char of text) {
    buffer += char;
    if (TOKEN_DELIMITERS.has(char)) {
      tokens.push(buffer);
      buffer = '';
    }
  }
  if (buffer) {
    tokens.push(buffer);
  }
  return tokens;
}

function shouldBreakBefore(token) {
  if (!token) return false;
  if (token.length > 1) return false;
  return LEADING_BREAK_DELIMITERS.has(token);
}

function shouldBreakAfter(token) {
  if (!token) return false;
  const last = token[token.length - 1];
  return TRAILING_BREAK_DELIMITERS.has(last);
}

function fallbackChunk(text) {
  const chunks = [];
  let cursor = 0;
  while (cursor < text.length) {
    const end = Math.min(cursor + MAX_SEGMENT_CHARS, text.length);
    const chunk = text.slice(cursor, end).trim();
    if (chunk) {
      chunks.push(chunk);
    }
    cursor = end;
  }
  if (!chunks.length) {
    chunks.push(text.trim());
  }
  return chunks;
}

function mergeShortSegments(segments) {
  if (!Array.isArray(segments) || segments.length === 0) {
    return [];
  }
  const merged = [];
  for (const segment of segments) {
    if (!segment) continue;
    if (segment.length <= 10 && merged.length > 0) {
      const previous = merged.pop();
      merged.push(`${previous}${segment.startsWith(' ') ? '' : ''}${segment}`.trim());
    } else {
      merged.push(segment);
    }
  }
  return merged;
}

export class TtsClient {
  constructor(openai, { model = 'gpt-4o-mini-tts', voice = 'alloy', instructions = null } = {}) {
    this.client = openai;
    this.model = model;
    this.voice = voice;
    this.instructions = instructions;
  }

  async synthesize(text, { onSegment } = {}) {
    const trimmed = (text ?? '').trim();
    if (!trimmed) return [];
    const segments = splitIntoSegments(trimmed);
    const immediate = typeof onSegment === 'function';
    const outputs = [];
    for (const segment of segments) {
      console.log(`[tts] segment (${segment.length} chars): ${segment}`);
      try {
        const response = await this.client.audio.speech.create({
          model: this.model,
          voice: this.voice,
          input: segment,
          response_format: 'pcm',
          ...(this.instructions ? { instructions: this.instructions } : {}),
        });
        const arrayBuffer = await response.arrayBuffer();
        const samples = new Int16Array(arrayBuffer);
        const payload = { samples, sampleRate: PCM_SAMPLE_RATE };
        if (immediate) {
          onSegment(payload);
        } else {
          outputs.push(payload);
        }
        console.log(`[tts] received (${segment.length} chars)`);
      } catch (error) {
        throw new Error(`TTS 合成に失敗しました: ${error.message}`);
      }
    }
    return outputs;
  }
}
