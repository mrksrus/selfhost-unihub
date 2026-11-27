// A call's sound through UniHub, off the page's main thread (call-media.ts
// starts it): the microphone's 20 ms pieces are encoded to Opus, encrypted
// and sent over the call's WebSocket; what arrives is checked, opened,
// decoded and handed to the playback worklet. The server only passes the
// frames on (api/src/contracts/chat.ts, ChatCallMediaFrame).

/** One direction's AES-GCM key and the 4 bytes that begin its nonces, the frame number the other 8. */
export interface CallMediaKeys { send: CryptoKey; sendSalt: Uint8Array<ArrayBuffer>; receive: CryptoKey; receiveSalt: Uint8Array<ArrayBuffer> }

/** Constant size and rate, so the server cannot tell speech from silence or mute; TCP loses nothing, so no FEC. */
export const callEncoder = (sampleRate: number): AudioEncoderConfig => ({ codec: 'opus', sampleRate, numberOfChannels: 1, bitrate: 24_000, bitrateMode: 'constant',
  opus: { frameDuration: 20_000, usedtx: false, useinbandfec: false } });
export const CALL_DECODER: AudioDecoderConfig = { codec: 'opus', sampleRate: 48_000, numberOfChannels: 1 };

export type CallMediaCommand =
  | { t: 'start'; url: string; rate: number; keys: CallMediaKeys; capture: MessagePort; play: MessagePort }
  | { t: 'send'; on: boolean };
/** `heard`: frames arrived (at most twice a second); `open`: the socket opened; `refused`: it did not open and a plain GET said why. */
export type CallMediaEvent = { t: 'heard' } | { t: 'open' } | { t: 'refused'; code: string | null; error: string | null };

const HEADER = 7;
const AUDIO = 1;
/** How far behind the highest frame number one may still arrive. */
const WINDOW = 50;
/** More than this waiting in the socket (about 1.5 s of sound) and new frames are dropped rather than sent late. */
const BUFFERED = 8192;
const BACKOFF = [500, 1000, 2000, 4000, 5000];

const nonce = (salt: Uint8Array, sequence: number) => {
  const iv = new Uint8Array(12);
  iv.set(salt);
  new DataView(iv.buffer).setUint32(8, sequence);
  return iv;
};

/** A frame: the header in clear and as additional data, then [kind][Opus packet] encrypted. */
export async function sealFrame(key: CryptoKey, salt: Uint8Array, sequence: number, packet: Uint8Array) {
  const frame = new Uint8Array(HEADER + 1 + packet.length + 16);
  frame[0] = 1;
  new DataView(frame.buffer).setUint32(3, sequence);
  const plain = new Uint8Array(1 + packet.length);
  plain[0] = AUDIO;
  plain.set(packet, 1);
  const header = frame.subarray(0, HEADER);
  frame.set(new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce(salt, sequence), additionalData: header }, key, plain)), HEADER);
  return frame;
}

/** The Opus packet of a frame, or null for one that is not a version 1 audio frame under this key. */
export async function openFrame(key: CryptoKey, salt: Uint8Array, frame: Uint8Array<ArrayBuffer>) {
  if (frame.length < HEADER + 1 + 16 || frame[0] !== 1) return null;
  const sequence = new DataView(frame.buffer, frame.byteOffset).getUint32(3);
  try {
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce(salt, sequence), additionalData: frame.subarray(0, HEADER) }, key, frame.subarray(HEADER)));
    return plain[0] === AUDIO ? { sequence, packet: plain.subarray(1) } : null;
  } catch {
    return null;
  }
}

/** True for a frame number not seen before and at most 50 behind the highest: TCP keeps order, so only a replaying server fails it. */
export function replayCheck() {
  let highest = -1;
  const seen = new Set<number>();
  return (sequence: number) => {
    if (highest - sequence > WINDOW || seen.has(sequence)) return false;
    seen.add(sequence);
    if (sequence > highest) {
      highest = sequence;
      for (const old of seen) if (highest - old > WINDOW) seen.delete(old);
    }
    return true;
  };
}

function start({ url, rate, keys, capture, play }: Extract<CallMediaCommand, { t: 'start' }>) {
  let socket: WebSocket | null = null, tries = 0, timer: ReturnType<typeof setTimeout> | undefined, probed = false;
  let sending = true, sequence = 0, timestamp = 0, heard = 0, last = -1;
  let out = Promise.resolve(), received = Promise.resolve();
  const fresh = replayCheck();

  const encoder = new AudioEncoder({
    output: chunk => {
      if (socket?.readyState !== WebSocket.OPEN || socket.bufferedAmount > BUFFERED) return;
      const packet = new Uint8Array(chunk.byteLength);
      chunk.copyTo(packet);
      const number = sequence++;
      // Sealing is asynchronous; the chain keeps the frames in order, as the receiver plays them as they come.
      out = out.then(async () => { const frame = await sealFrame(keys.send, keys.sendSalt, number, packet); if (socket?.readyState === WebSocket.OPEN) socket.send(frame); }).catch(() => undefined);
    },
    error: () => undefined,
  });
  encoder.configure(callEncoder(rate));
  const decoder = new AudioDecoder({
    output: data => {
      const samples = new Float32Array(data.numberOfFrames);
      data.copyTo(samples, { planeIndex: 0, format: 'f32-planar' });
      data.close();
      play.postMessage(samples, [samples.buffer]);
    },
    error: () => undefined,
  });
  decoder.configure(CALL_DECODER);

  capture.onmessage = ({ data }: MessageEvent<Float32Array<ArrayBuffer>>) => {
    if (sending && encoder.state === 'configured') encoder.encode(new AudioData({ format: 'f32-planar', sampleRate: rate, numberOfFrames: data.length, numberOfChannels: 1, timestamp, data }));
    timestamp += data.length * 1e6 / rate;
  };

  const receive = async (frame: Uint8Array<ArrayBuffer>) => {
    const opened = await openFrame(keys.receive, keys.receiveSalt, frame);
    if (!opened || !fresh(opened.sequence) || decoder.state !== 'configured') return;
    // Frames the server dropped are silence, so the buffer does not wait for them.
    for (let gap = Math.min(opened.sequence - last - 1, 10); last >= 0 && gap > 0; gap--) play.postMessage(new Float32Array(960));
    last = Math.max(last, opened.sequence);
    decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: opened.sequence * 20_000, data: opened.packet }));
    if (Date.now() - heard > 500) { heard = Date.now(); postMessage({ t: 'heard' } satisfies CallMediaEvent); }
  };

  // A refused socket tells nothing of why: the same address without the upgrade answers with the server's reason.
  const probe = async () => {
    const answer = await fetch(url, { credentials: 'same-origin' }).catch(() => null);
    if (!answer || answer.ok) return;
    const body = await answer.json().catch(() => null) as { code?: string; error?: string } | null;
    // A socket that opened meanwhile has answered the question.
    if (socket?.readyState === WebSocket.OPEN) return;
    probed = true;
    postMessage({ t: 'refused', code: body?.code ?? null, error: body?.error ?? null } satisfies CallMediaEvent);
  };

  const connect = () => {
    clearTimeout(timer);
    socket?.close();
    const ws = socket = new WebSocket(url.replace(/^http/, 'ws'));
    ws.binaryType = 'arraybuffer';
    let opened = false;
    ws.onopen = () => {
      opened = true;
      tries = 0;
      // A later failure, on another network perhaps, is asked about again.
      probed = false;
      postMessage({ t: 'open' } satisfies CallMediaEvent);
    };
    ws.onmessage = ({ data }) => { if (data instanceof ArrayBuffer) received = received.then(() => receive(new Uint8Array(data))).catch(() => undefined); };
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null;
      if (!opened && !probed) void probe();
      timer = setTimeout(connect, BACKOFF[Math.min(tries++, BACKOFF.length - 1)]);
    };
  };
  // A new network: the old socket may be dead without knowing it.
  addEventListener('online', connect);
  connect();
  return (on: boolean) => { sending = on; };
}

let send: ((on: boolean) => void) | null = null;
// Only in the Worker: tests import the frame functions.
if ('WorkerGlobalScope' in globalThis) {
  onmessage = ({ data }: MessageEvent<CallMediaCommand>) => {
    if (data.t === 'start') send ??= start(data);
    else send?.(data.on);
  };
}
