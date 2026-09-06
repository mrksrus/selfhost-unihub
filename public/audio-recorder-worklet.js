class PcmRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = true;
    // 4096 samples keep transfer latency below 100 ms at common sample rates,
    // with 32 times fewer messages/allocations than a 128-frame render quantum.
    this.chunkSamples = 4096;
    this.buffer = new ArrayBuffer(this.chunkSamples * 2);
    this.view = new DataView(this.buffer);
    this.bufferedSamples = 0;
    this.port.onmessage = (event) => {
      if (event.data?.type === 'pause') {
        this.recording = false;
        this.flush();
      } else if (event.data?.type === 'resume') {
        this.recording = true;
      } else if (event.data?.type === 'stop') {
        this.recording = false;
        this.flush();
        // MessagePort ordering ensures the final PCM chunk arrives first.
        this.port.postMessage({ type: 'stopped' });
      }
    };
  }

  flush() {
    if (!this.bufferedSamples) return;
    const samples = this.bufferedSamples;
    const buffer = samples === this.chunkSamples
      ? this.buffer
      : this.buffer.slice(0, samples * 2);
    this.port.postMessage({ type: 'pcm', buffer, samples }, [buffer]);
    this.buffer = new ArrayBuffer(this.chunkSamples * 2);
    this.view = new DataView(this.buffer);
    this.bufferedSamples = 0;
  }

  process(inputs) {
    const samples = inputs[0]?.[0];
    if (!this.recording || !samples?.length) return true;

    for (let index = 0; index < samples.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, samples[index]));
      const value = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      this.view.setInt16(this.bufferedSamples * 2, value, true);
      this.bufferedSamples += 1;
      if (this.bufferedSamples === this.chunkSamples) this.flush();
    }
    return true;
  }
}

registerProcessor('pcm-recorder', PcmRecorderProcessor);
