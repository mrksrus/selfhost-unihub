// A call's sound through UniHub (src/lib/chat/call-media.ts): the microphone
// in 20 ms pieces to the media Worker, and the other end's decoded sound out
// of a jitter buffer. Both talk to the Worker over a MessagePort they are sent.

class CallCaptureProcessor extends AudioWorkletProcessor {
  out: MessagePort | null = null;
  size = Math.round(sampleRate / 50);
  buffer = new Float32Array(this.size);
  filled = 0;

  constructor() {
    super();
    this.port.onmessage = event => { this.out = event.data; };
  }

  process(inputs: Float32Array[][]) {
    const samples = inputs[0]?.[0];
    if (!samples || !this.out) return true;
    for (let index = 0; index < samples.length; index++) {
      this.buffer[this.filled++] = samples[index];
      if (this.filled < this.size) continue;
      this.out.postMessage(this.buffer, [this.buffer.buffer]);
      this.buffer = new Float32Array(this.size);
      this.filled = 0;
    }
    return true;
  }
}

/** 20 ms at the playback context's 48,000 a second. */
const FRAME = 960;

/**
 * Plays from a queue that starts at 60 ms of sound. Run dry, it plays silence
 * and waits for 20 ms more (up to 200); more than 100 ms over that, it drops the
 * oldest; ten seconds without running dry, it waits for 20 ms less (down to 40).
 */
class CallPlaybackProcessor extends AudioWorkletProcessor {
  queue: Float32Array[] = [];
  offset = 0;
  queued = 0;
  target = 3 * FRAME;
  playing = false;
  steady = 0;

  constructor() {
    super();
    this.port.onmessage = event => {
      (event.data as MessagePort).onmessage = ({ data }: MessageEvent<Float32Array>) => {
        this.queue.push(data);
        this.queued += data.length;
        while (this.queued > this.target + 5 * FRAME) {
          this.queued -= this.queue.shift()!.length - this.offset;
          this.offset = 0;
        }
      };
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    const out = outputs[0][0];
    if (!this.playing && this.queued >= this.target) this.playing = true;
    if (!this.playing) return true;
    for (let index = 0; index < out.length; index++) {
      const frame = this.queue[0];
      if (!frame) {
        this.playing = false;
        this.target = Math.min(this.target + FRAME, 10 * FRAME);
        this.steady = 0;
        return true;
      }
      out[index] = frame[this.offset++];
      this.queued--;
      if (this.offset === frame.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }
    // 128 samples a block: 3,750 blocks are ten seconds.
    if (++this.steady > 3750 && this.target > 2 * FRAME) {
      this.target -= FRAME;
      this.steady = 0;
    }
    return true;
  }
}

registerProcessor('call-capture', CallCaptureProcessor);
registerProcessor('call-playback', CallPlaybackProcessor);
