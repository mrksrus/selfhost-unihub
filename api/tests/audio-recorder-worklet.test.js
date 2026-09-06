const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createRecorder() {
  let Recorder;
  const messages = [];
  class AudioWorkletProcessor {
    constructor() {
      this.port = { postMessage: (message, transfer) => {
        messages.push(structuredClone(message, { transfer: transfer || [] }));
      } };
    }
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../public/audio-recorder-worklet.js'), 'utf8'), {
    AudioWorkletProcessor,
    registerProcessor: (_name, Class) => { Recorder = Class; },
    ArrayBuffer,
    DataView,
  });
  return { recorder: new Recorder(), messages };
}

function samplesFrom(messages) {
  return messages.filter(message => message.type === 'pcm').flatMap(message => {
    const view = new DataView(message.buffer);
    return Array.from({ length: message.samples }, (_, index) => view.getInt16(index * 2, true));
  });
}

test('PCM batches preserve every sample across render boundaries with 32 times fewer transfers', () => {
  const { recorder, messages } = createRecorder();
  const expected = [];
  for (let render = 0; render < 96; render += 1) {
    const samples = Float32Array.from({ length: 128 }, (_, index) => Math.sin((render * 128 + index) / 50));
    expected.push(...Array.from(samples, value => Math.trunc(value < 0 ? value * 0x8000 : value * 0x7fff)));
    recorder.process([[samples]]);
  }
  assert.equal(messages.length, 3);
  assert.deepEqual(samplesFrom(messages), expected);
});

test('pause/resume/stop flush partial PCM before acknowledgement without gaps or duplicates', () => {
  const { recorder, messages } = createRecorder();
  recorder.process([[Float32Array.from([0, 1, -1])]]);
  recorder.port.onmessage({ data: { type: 'pause' } });
  recorder.process([[Float32Array.from([0.3, 0.4])]]);
  recorder.port.onmessage({ data: { type: 'resume' } });
  recorder.process([[Float32Array.from([0.5, -0.5])]]);
  recorder.port.onmessage({ data: { type: 'stop' } });
  recorder.process([[Float32Array.from([1, 1])]]);
  assert.deepEqual(samplesFrom(messages), [0, 32767, -32768, 16383, -16384]);
  assert.deepEqual(messages.map(message => message.type), ['pcm', 'pcm', 'stopped']);
  assert.equal(messages[0].buffer.byteLength, 6);
  assert.equal(messages[1].buffer.byteLength, 4);
});

test('PCM batching handles variable render quanta and clips input safely', () => {
  const { recorder, messages } = createRecorder();
  recorder.process([[new Float32Array(5000).fill(2)]]);
  recorder.process([[Float32Array.from([-2, Number.NaN])]]);
  recorder.port.onmessage({ data: { type: 'stop' } });
  const samples = samplesFrom(messages);
  assert.equal(samples.length, 5002);
  assert.ok(samples.slice(0, 5000).every(value => value === 32767));
  assert.deepEqual(samples.slice(-2), [-32768, 0]);
});
