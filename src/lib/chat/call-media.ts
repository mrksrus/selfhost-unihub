// A call's sound through UniHub, for while the two devices cannot connect
// directly (call.ts decides when): the microphone goes through a capture
// worklet to a Worker (call-media.worker.ts) that encodes, encrypts and sends
// it over the call's WebSocket; the other end's sound comes back through a
// playback worklet. The key is agreed per call by the two ends (ECDH through
// the call's signals, which the server only passes on), so the server cannot
// open the frames.
import { concat } from '@/lib/chat/bytes';
import { CALL_DECODER, callEncoder, type CallMediaCommand, type CallMediaEvent, type CallMediaKeys } from '@/lib/chat/call-media.worker';

const CURVE = { name: 'ECDH', namedCurve: 'P-256' } as const;
const INFO = new TextEncoder().encode('unihub call 1');

/** This end's key for one call; the private half cannot leave the page and goes with the call. */
export async function callKey() {
  const pair = await crypto.subtle.generateKey(CURVE, false, ['deriveBits']);
  return { pair, raw: new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)) };
}

/** Both directions' keys, bound to the call and to both ends' public halves. */
export async function callMediaKeys(callId: string, own: CryptoKeyPair, callerKey: Uint8Array<ArrayBuffer>, calleeKey: Uint8Array<ArrayBuffer>, caller: boolean): Promise<CallMediaKeys> {
  const peer = await crypto.subtle.importKey('raw', caller ? calleeKey : callerKey, CURVE, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, own.privateKey, 256);
  const hkdf = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
  const info = concat(INFO, callerKey, calleeKey);
  const bytes = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode(callId), info }, hkdf, 40 * 8));
  // Caller to callee: key 0-15, salt 32-35; callee to caller: key 16-31, salt 36-39.
  const key = (at: number, use: KeyUsage) => crypto.subtle.importKey('raw', bytes.slice(at, at + 16), 'AES-GCM', false, [use]);
  const [send, receive] = caller ? [0, 1] : [1, 0];
  return { send: await key(send * 16, 'encrypt'), sendSalt: bytes.slice(32 + send * 4, 36 + send * 4),
    receive: await key(receive * 16, 'decrypt'), receiveSalt: bytes.slice(32 + receive * 4, 36 + receive * 4) };
}

export interface CallMediaEvents {
  /** Frames of the other end arrive. */
  heard(): void;
  /** The socket did not open: the server's code and words (a plain GET of it answered them). */
  refused(code: string | null, error: string | null): void;
  /** The other end's sound is ready to play. */
  track(): void;
}

export class CallMedia {
  private worker: Worker | null = null;
  private loop: RTCPeerConnection[] = [];
  private readonly audio = new Audio();

  private constructor(private readonly contexts: AudioContext[], private readonly capture: AudioWorkletNode, private readonly playback: AudioWorkletNode,
    private readonly output: MediaStream) {}

  /** The server path for this microphone; null where this browser cannot carry it (no WebCodecs Opus, no worklets). */
  static async open(stream: MediaStream): Promise<CallMedia | null> {
    if (typeof AudioEncoder === 'undefined' || typeof AudioDecoder === 'undefined' || typeof AudioWorkletNode === 'undefined') return null;
    const contexts: AudioContext[] = [];
    try {
      // Made after the microphone: on Android a context made before it is reported to play as media.
      const capture = new AudioContext();
      contexts.push(capture);
      const [encoder, decoder] = await Promise.all([AudioEncoder.isConfigSupported(callEncoder(capture.sampleRate)), AudioDecoder.isConfigSupported(CALL_DECODER)]);
      if (!encoder.supported || !decoder.supported) throw new Error('No Opus in this browser');
      // The decoder gives 48,000 samples a second.
      const playback = capture.sampleRate === 48_000 ? capture : new AudioContext({ sampleRate: 48_000 });
      if (playback !== capture) contexts.push(playback);
      await Promise.all(contexts.map(context => context.audioWorklet.addModule('/call-media-worklet.js')));
      const input = new AudioWorkletNode(capture, 'call-capture', { numberOfOutputs: 0 });
      capture.createMediaStreamSource(stream).connect(input);
      const output = new AudioWorkletNode(playback, 'call-playback', { numberOfInputs: 0, outputChannelCount: [1] });
      const destination = playback.createMediaStreamDestination();
      output.connect(destination);
      return new CallMedia(contexts, input, output, destination.stream);
    } catch {
      contexts.forEach(context => void context.close());
      return null;
    }
  }

  /** Opens the socket at `url` (the call's media route) and starts sending and playing. */
  start(url: string, keys: CallMediaKeys, events: CallMediaEvents) {
    const worker = this.worker = new Worker(new URL('./call-media.worker.ts', import.meta.url), { type: 'module' });
    const capture = new MessageChannel(), play = new MessageChannel();
    this.capture.port.postMessage(capture.port1, [capture.port1]);
    this.playback.port.postMessage(play.port1, [play.port1]);
    worker.onmessage = ({ data }: MessageEvent<CallMediaEvent>) => { if (data.t === 'heard') events.heard(); else events.refused(data.code, data.error); };
    worker.postMessage({ t: 'start', url, rate: this.contexts[0].sampleRate, keys, capture: capture.port2, play: play.port2 } satisfies CallMediaCommand, [capture.port2, play.port2]);

    // The sound plays from a connection of the page to itself: browsers take such sound out of the
    // microphone as an echo, and the Android app plays it as it plays a direct call's.
    const [from, to] = this.loop = [new RTCPeerConnection(), new RTCPeerConnection()];
    from.onicecandidate = ({ candidate }) => { if (candidate) void to.addIceCandidate(candidate).catch(() => undefined); };
    to.onicecandidate = ({ candidate }) => { if (candidate) void from.addIceCandidate(candidate).catch(() => undefined); };
    to.ontrack = ({ track }) => {
      this.audio.srcObject = new MediaStream([track]);
      events.track();
    };
    // A change of network takes the addresses it ran on.
    from.oniceconnectionstatechange = () => {
      if (from.iceConnectionState !== 'failed') return;
      from.restartIce();
      void this.negotiate();
    };
    from.addTrack(this.output.getAudioTracks()[0], this.output);
    void this.negotiate();
  }

  private async negotiate() {
    const [from, to] = this.loop;
    try {
      await from.setLocalDescription();
      await to.setRemoteDescription(from.localDescription!);
      await to.setLocalDescription();
      await from.setRemoteDescription(to.localDescription!);
    } catch {
      // Closed with the call.
    }
  }

  /** `true`: send through the server and play its sound; `false` while the direct connection carries the call. */
  route(server: boolean) {
    this.worker?.postMessage({ t: 'send', on: server } satisfies CallMediaCommand);
    this.audio.muted = !server;
  }

  /** Plays after the browser refused it (call it from a tap too). */
  play() {
    this.contexts.forEach(context => void context.resume());
    return this.audio.srcObject ? this.audio.play() : Promise.resolve();
  }

  close() {
    this.worker?.terminate();
    this.loop.forEach(connection => connection.close());
    this.contexts.forEach(context => void context.close());
    this.audio.srcObject = null;
  }
}
