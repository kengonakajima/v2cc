export class PlaybackQueue {
  constructor({ audioPlayer, ttsClient, enabled = true } = {}) {
    this.audioPlayer = audioPlayer;
    this.ttsClient = ttsClient;
    this.enabled = enabled;
    this.queue = [];
    this.processing = false;
    this.stopped = false;
  }

  enqueue({ text, metadata = {} }) {
    if (!this.enabled || this.stopped) {
      return;
    }
    if (!text || !text.trim()) {
      return;
    }
    this.queue.push({ text, metadata });
    if (!this.processing) {
      this.process();
    }
  }

  async process() {
    if (this.processing) return;
    this.processing = true;
    while (this.queue.length && !this.stopped) {
      const item = this.queue.shift();
      try {
        const segments = await this.ttsClient.synthesize(item.text, {
          onSegment: (segment) => {
            this.audioPlayer.enqueue(segment.samples, segment.sampleRate);
          },
        });
        if (Array.isArray(segments) && segments.length) {
          for (const segment of segments) {
            this.audioPlayer.enqueue(segment.samples, segment.sampleRate);
          }
        }
      } catch (error) {
        console.error(`[playback] TTS エラー: ${error.message}`);
      }
    }
    this.processing = false;
  }

  async shutdown() {
    this.stopped = true;
    this.queue.length = 0;
    if (typeof this.audioPlayer.shutdown === 'function') {
      await this.audioPlayer.shutdown();
    }
  }
}
