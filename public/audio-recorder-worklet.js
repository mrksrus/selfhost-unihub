class PcmRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = true;
    this.port.onmessage = (event) => {
      if (event.data?.type === 'pause') {
        this.recording = false;
      } else if (event.data?.type === 'resume') {
        this.recording = true;
      } else if (event.data?.type === 'stop') {
        this.recording = false;
        this.port.postMessage({ type: 'stopped' });
      }
    };
  }

  process(inputs) {
    const samples = inputs[0]?.[0];
    if (!this.recording || !samples?.length) return true;

    const buffer = new ArrayBuffer(samples.length * 2);
    const view = new DataView(buffer);
    for (let index = 0; index < samples.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, samples[index]));
      const value = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      view.setInt16(index * 2, value, true);
    }

    this.port.postMessage({
      type: 'pcm',
      buffer,
      samples: samples.length,
    }, [buffer]);
    return true;
  }
}

registerProcessor('pcm-recorder', PcmRecorderProcessor);
