const MAX_SEGMENT_CHARS = 600;
const PCM_SAMPLE_RATE = 24000;

function splitIntoSegments(text) {
  const segments = [];
  let buffer = '';
  const sentences = text
    .replace(/\s+/g, ' ')
    .split(/(?<=[。．.!?！？])/u);

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;
    if (buffer.length + trimmed.length <= MAX_SEGMENT_CHARS) {
      buffer += (buffer ? ' ' : '') + trimmed;
    } else {
      if (buffer) {
        segments.push(buffer);
        buffer = '';
      }
      if (trimmed.length <= MAX_SEGMENT_CHARS) {
        buffer = trimmed;
      } else {
        let start = 0;
        while (start < trimmed.length) {
          segments.push(trimmed.slice(start, start + MAX_SEGMENT_CHARS));
          start += MAX_SEGMENT_CHARS;
        }
      }
    }
  }
  if (buffer) segments.push(buffer);
  if (!segments.length && text.trim()) {
    segments.push(text.trim());
  }
  return segments;
}

export class TtsClient {
  constructor(openai, { model = 'gpt-4o-mini-tts', voice = 'alloy', instructions = null } = {}) {
    this.client = openai;
    this.model = model;
    this.voice = voice;
    this.instructions = instructions;
  }

  async synthesize(text) {
    const trimmed = (text ?? '').trim();
    if (!trimmed) return [];
    const segments = splitIntoSegments(trimmed);
    const outputs = [];
    for (const segment of segments) {
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
        outputs.push({ samples, sampleRate: PCM_SAMPLE_RATE });
      } catch (error) {
        throw new Error(`TTS 合成に失敗しました: ${error.message}`);
      }
    }
    return outputs;
  }
}
