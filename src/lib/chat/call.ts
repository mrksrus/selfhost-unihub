// Voice calls on this device: one logic for the browser, the installed web
// app and the Android app's call screen (/call). The server rings and carries
// the signals as rows (contracts/chat.ts); the sound goes from device to
// device over the browser's own RTCPeerConnection, encrypted by WebRTC, and
// through UniHub (call-media.ts) while that connection is not up. The
// caller makes every offer, a restart included, so there is no negotiation to
// settle. One tab of the device holds a call (a Web Lock): only that tab
// touches the microphone and the connection; the others show that it is held
// elsewhere. Nothing of a signal is kept beyond the call.
import { ApiError, hasCode, policyRefusal } from '@/lib/api-error';
import { onAppEvent } from '@/lib/app-events';
import { chatApi, unreachable } from '@/lib/chat-api';
import { fromBase64Url, toBase64Url } from '@/lib/chat/bytes';
import { CallMedia, callKey, callMediaKeys } from '@/lib/chat/call-media';
import type { ChatCall, ChatCallAnswerResponse, ChatCallOutcome, ChatCallStartRequest, ChatCallStartResponse, ChatIceServer } from '../../../api/src/contracts/chat';

const ALIVE_MS = 30_000;
/** A connection not up this long after it was first tried or broke ends the call as failed. */
const RECONNECT_MS = 30_000;
const BATCH_MS = 250;
/** The server's ring time and a margin for its sweep, from when this page first saw the call (the device's clock may be off): a call still ringing then stops here without waiting for a hint. */
const RING_MS = 45_000 + 5_000;
const LOCK = 'unihub-call:';
/** The server path carries the call while the other end's frames came this recently. */
const HEARD_MS = 2000;

/**
 * - `calling`: this person called and it rings on the other side (play the ring-back);
 * - `ringing`: someone calls this person (play the ring; answer or decline);
 * - `connecting`: answered, the connection is being made;
 * - `active`: the sound flows;
 * - `reconnecting`: the connection broke and is being made again; after 30 seconds the call fails;
 * - `ended`: see `ended`.
 */
export type CallState = 'calling' | 'ringing' | 'connecting' | 'active' | 'reconnecting' | 'ended';

/**
 * Why the call ended as this tab saw it: `hung-up` (after it was answered, by
 * either), `declined`, `busy` (the other person is on another call),
 * `no-answer` (nobody answered in time), `cancelled` (the caller hung up while
 * it rang), `failed` (it could not connect, or the connection did not come
 * back), `answered-elsewhere` (another device of this person took it),
 * `other-tab` (another tab of this browser holds a call), `microphone` (refused
 * or missing; the call was not started or not answered), `refused` (the server
 * refused the start: calls off, the person cannot be called, already on a call).
 */
export type CallEnding = 'hung-up' | 'declined' | 'busy' | 'no-answer' | 'cancelled' | 'failed' | 'answered-elsewhere' | 'other-tab' | 'microphone' | 'refused';

export interface CallView {
  /** null while the start is on its way, and for a start the server refused. */
  id: string | null;
  conversation_id: string | null;
  /** The other person, by the directory's name. */
  peer: { user_id: string | null; name: string };
  /** The other person called. */
  incoming: boolean;
  state: CallState;
  ended: CallEnding | null;
  /** The server's or the device's words for `busy`, `refused`, `failed` (when known) and `microphone`. */
  reason: string | null;
  /** When it was answered (the call's time counts from here). */
  answered_at: string | null;
  muted: boolean;
  /** This tab holds the call: its microphone and connection. */
  here: boolean;
  /** The sound the screens play now. */
  sound: 'ring' | 'ringback' | null;
  /** The browser refused to play the other person's sound until a tap: the screens offer one that calls `play()`. */
  silenced: boolean;
  /** The start was refused under the administrator's rule on calls (`reason` says for whom): the screens keep "Call" greyed for that person. */
  forbidden: boolean;
  /** The sound goes through UniHub's server now, not directly between the devices. */
  through_server: boolean;
  /** Why a failed call could not go through UniHub either, where it is known. */
  cause?: CallCause | null;
}

/** `proxy`: the reverse proxy refused the call's WebSocket; `busy`: UniHub carries too many calls; or which browser cannot carry the path. */
export type CallCause = 'proxy' | 'busy' | 'this-browser' | 'other-browser';

export interface ChatCalls {
  subscribe(listener: () => void): () => void;
  /** The call to show; it keeps its identity until something in it changes. An ended call stays until `dismiss()` or the next call. */
  snapshot(): CallView | null;
  /** Fetches the current call; also done on a hint, a reconnect, when the page shows and every 30 seconds during a call. */
  sync(): Promise<void>;
  /** Calls a person or the other person of a direct chat (`name` is shown until the server answers). */
  start(target: ChatCallStartRequest, name: string): Promise<void>;
  /** Answers the ringing call; `id` names the call to answer when the page was opened for it (/call?id=). */
  answer(id?: string): Promise<void>;
  decline(): Promise<void>;
  hangUp(): Promise<void>;
  mute(muted: boolean): void;
  /** Plays the other person's sound after the browser refused it (`silenced`); call it from a tap. */
  play(): void;
  dismiss(): void;
}

/** `key`: this end's public half for the server path (empty without one), and whether it can carry the path. */
type Signal = { t: 'offer' | 'answer'; sdp: string } | { t: 'candidates'; c: RTCIceCandidateInit[] } | { t: 'restart' } | { t: 'key'; k: string; media: boolean };

const ENDINGS: Record<ChatCallOutcome, CallEnding> = { answered: 'hung-up', missed: 'no-answer', cancelled: 'cancelled', declined: 'declined', busy: 'busy', failed: 'failed' };
const said = (error: unknown) => policyRefusal(error)?.reason ?? (error instanceof Error ? error.message : null);

class Calls implements ChatCalls {
  private readonly listeners = new Set<() => void>();
  private readonly stops: (() => void)[] = [];
  private view: CallView | null = null;
  /** Calls the person put away here (declined, dismissed): not shown again. */
  private readonly dismissed = new Set<string>();
  private pc: RTCPeerConnection | null = null;
  private stream: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private unlock: (() => void) | null = null;
  /** The server path: this end's key and whether it can carry the path, the other end's half, this end's media, the other end's last frame, why the socket was refused. */
  private own: { key: Awaited<ReturnType<typeof callKey>> | null; able: boolean } | null = null;
  private peer: { key: Uint8Array<ArrayBuffer> | null; media: boolean } | null = null;
  private media: CallMedia | null = null;
  private started = false;
  private heardAt = 0;
  private refusal: CallCause | null = null;
  private watch: ReturnType<typeof setInterval> | undefined;
  /** The other end's signals read so far; candidates to post, and received ones waiting for the remote description. */
  private after = 0;
  private outgoing: RTCIceCandidateInit[] = [];
  private incoming: RTCIceCandidateInit[] = [];
  private batch: ReturnType<typeof setTimeout> | undefined;
  private alive: ReturnType<typeof setInterval> | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private ring: { id: string; timer: ReturnType<typeof setTimeout> } | null = null;
  private syncing: Promise<void> | null = null;
  private syncAgain = false;
  private closed = false;
  /** Raised by every end: an action that waited compares the number it began with to know the call is still its own. */
  private attempt = 0;

  constructor(private readonly me: string) {}

  open() {
    const later = () => void this.sync().catch(() => undefined);
    const onOnline = () => { later(); this.reconnect(); };
    const onVisible = () => { if (document.visibilityState === 'visible') later(); };
    const onHide = () => this.leave();
    this.stops.push(
      onAppEvent('unihub:chat-call', later),
      // The live stream came back: hints may have been lost.
      onAppEvent('unihub:chat-changed', id => { if (id === null) later(); }),
    );
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pagehide', onHide);
    this.stops.push(() => window.removeEventListener('online', onOnline), () => document.removeEventListener('visibilitychange', onVisible),
      () => window.removeEventListener('pagehide', onHide));
    later();
  }

  close() {
    this.leave();
    this.closed = true;
    if (this.ring) clearTimeout(this.ring.timer);
    this.stops.forEach(stop => stop());
    this.listeners.clear();
  }

  /** The page goes: a held call ends now rather than when the server misses its sign of life. */
  private leave() {
    const id = this.view?.id;
    if (!this.holds()) return;
    this.finish('hung-up');
    if (id) void chatApi.endCall(id, false, true).catch(() => undefined);
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  snapshot = () => this.view;

  private set(view: CallView | null) {
    const next = view && { ...view, sound: view.state === 'ringing' ? 'ring' as const : view.state === 'calling' ? 'ringback' as const : null };
    if (this.closed || JSON.stringify(next) === JSON.stringify(this.view)) return;
    this.view = next;
    this.listeners.forEach(listener => listener());
  }

  private update(fields: Partial<CallView>) {
    if (this.view) this.set({ ...this.view, ...fields });
  }

  private holds() {
    return !!this.view?.here && this.view.state !== 'ended';
  }

  private stale(attempt: number) {
    return attempt !== this.attempt;
  }

  private viewOf(call: ChatCall, here: boolean): CallView {
    const incoming = call.callee_user_id === this.me;
    return { id: call.id, conversation_id: call.conversation_id, incoming, ended: null, reason: null, answered_at: call.answered_at, muted: false, here, sound: null, silenced: false, forbidden: false, through_server: false,
      peer: incoming ? { user_id: call.caller_user_id, name: call.caller_name } : { user_id: call.callee_user_id, name: call.callee_name },
      state: call.state === 'ringing' ? (incoming ? 'ringing' : 'calling') : 'connecting' };
  }

  // --- Following the server ----------------------------------------------------------------

  sync(): Promise<void> {
    if (this.syncing) { this.syncAgain = true; return this.syncing; }
    this.syncing = (async () => {
      do {
        this.syncAgain = false;
        await this.syncOnce();
      } while (this.syncAgain && !this.closed);
    })().finally(() => { this.syncing = null; });
    return this.syncing;
  }

  private async syncOnce() {
    try {
      const call = await chatApi.currentCall();
      const view = this.view;
      if (!this.holds()) return this.show(call);
      // A start on its way names no call yet.
      if (!view?.id) return;
      // Gone from the current call: its sign of life answers how it ended.
      const attempt = this.attempt;
      const now = call?.id === view.id ? call : await chatApi.callAlive(view.id);
      if (!this.stale(attempt)) await this.follow(now);
    } catch (error) {
      // Offline, signed out, or a device that has not joined Chat: no call to show.
      if (!(error instanceof ApiError)) throw error;
    }
  }

  /** The call this tab holds, as the server has it now. */
  private async follow(call: ChatCall) {
    // Whether it was answered tells a failure of the other side from one of the connection.
    if (call.state === 'ended') {
      this.update({ answered_at: call.answered_at });
      const ending = ENDINGS[call.outcome ?? 'failed'];
      return this.finish(ending, null, false, ending === 'failed' ? this.why() : null);
    }
    if (call.state !== 'active') return;
    if (this.view!.state === 'calling') {
      this.update({ state: 'connecting', answered_at: call.answered_at });
      this.connectBy();
      void this.offerMedia(this.attempt);
    }
    if (this.pc) await this.readSignals();
  }

  /** A call this tab does not hold: one that rings here, or one held elsewhere. */
  private show(call: ChatCall | null) {
    const view = this.view;
    // An ending of this tab stays until dismissed; one about a call going on elsewhere goes with that call.
    if (view?.state === 'ended' && (call ? call.id === view.id : view.here)) return;
    if (!call || this.dismissed.has(call.id) || (call.caller_user_id === this.me && !call.this_device)) return this.set(null);
    // This device's call (all tabs of a browser are one device), and this tab does not hold it.
    if (call.this_device) {
      this.set({ ...this.viewOf(call, false), state: 'ended', ended: 'other-tab' });
      return this.endUnheld(call);
    }
    if (call.state === 'ringing') {
      this.ringUntil(call);
      return this.set(this.viewOf(call, false));
    }
    this.set(view?.id === call.id ? { ...view, state: 'ended', ended: 'answered-elsewhere' } : null);
  }

  /** A call of this device that no tab holds (the answer to its start or answer was lost): it ends as failed. */
  private endUnheld(call: ChatCall) {
    // A tab holds the lock from before it starts or answers until its call ends here.
    void navigator.locks?.request(`${LOCK}${this.me}`, { ifAvailable: true }, async lock => {
      if (!lock) return;
      if (this.view?.id === call.id) this.set({ ...this.view, state: 'ended', ended: 'failed', here: true });
      await chatApi.endCall(call.id, true).catch(() => undefined);
    }).catch(() => undefined);
  }

  // --- Actions -----------------------------------------------------------------------------

  async start(target: ChatCallStartRequest, name: string) {
    const view = this.view;
    // Calling back the person whose call rings here answers it, as the server does when both call at once.
    if (view?.state === 'ringing' && view.id && ('user_id' in target ? view.peer.user_id === target.user_id : view.conversation_id === target.conversation_id)) return this.answer(view.id);
    if (view && view.state !== 'ended') throw new Error('You are on a call.');
    const attempt = this.attempt;
    this.set({ id: null, conversation_id: 'conversation_id' in target ? target.conversation_id : null, peer: { user_id: 'user_id' in target ? target.user_id : null, name },
      incoming: false, state: 'calling', ended: null, reason: null, answered_at: null, muted: false, here: true, sound: null, silenced: false, forbidden: false, through_server: false });
    if (!await this.take(attempt)) return;
    let answer: ChatCallStartResponse;
    try {
      answer = await chatApi.startCall(target);
    } catch (error) {
      // Only the answer may have been lost: while this tab holds the lock, a call of this device is the one it made.
      const made = unreachable(error) && !this.stale(attempt) ? await chatApi.currentCall().catch(() => null) : null;
      if (made?.this_device && !this.stale(attempt)) void chatApi.endCall(made.id, true).catch(() => undefined);
      if (!this.stale(attempt)) this.finish(hasCode(error, 'CHAT_CALL_BUSY') ? 'busy' : unreachable(error) ? 'failed' : 'refused', said(error), !!policyRefusal(error));
      return;
    }
    // Hung up before the server answered: the call it made ends too; the other person's own call, found ringing, is theirs.
    if (this.stale(attempt)) { if (answer.started) void chatApi.endCall(answer.call.id).catch(() => undefined); return; }
    // Both called at once: the other person's call is the one, and this answers it.
    if (!answer.started) {
      this.set({ ...this.viewOf(answer.call, true), state: 'connecting' });
      return this.accept(answer.call.id, attempt);
    }
    this.set(this.viewOf(answer.call, true));
    this.ringUntil(answer.call);
    await this.connect(answer.call.id, answer.ice_servers, true, attempt);
  }

  private ringUntil(call: ChatCall) {
    if (this.ring?.id === call.id) return;
    if (this.ring) clearTimeout(this.ring.timer);
    this.ring = { id: call.id, timer: setTimeout(() => void this.ringOver(call.id), RING_MS) };
  }

  /** The ring time is over and no end arrived: ask once more, then stop ringing here (the caller's side ends the call). */
  private async ringOver(id: string) {
    this.ring = null;
    await this.sync().catch(() => undefined);
    const view = this.view;
    if (view?.id !== id) return;
    if (view.state === 'ringing') {
      this.dismissed.add(id);
      this.set(null);
    } else if (view.state === 'calling' && view.here) {
      this.finish('no-answer');
      await chatApi.endCall(id).catch(() => undefined);
    }
  }

  async answer(id?: string) {
    if (id && this.view?.id !== id) await this.sync();
    const view = this.view;
    if (view?.state !== 'ringing' || !view.id || (id && view.id !== id)) return;
    const attempt = this.attempt;
    this.set({ ...view, state: 'connecting', here: true });
    if (await this.take(attempt)) await this.accept(view.id, attempt);
  }

  private async accept(id: string, attempt: number) {
    let answer: ChatCallAnswerResponse;
    try {
      answer = await chatApi.answerCall(id);
    } catch (error) {
      if (this.stale(attempt)) return;
      this.finish(hasCode(error, 'CHAT_CALL_ANSWERED') ? 'answered-elsewhere' : hasCode(error, 'CHAT_CALL_ENDED') ? 'cancelled' : 'failed', hasCode(error, 'CHAT_CALL_ENDED') ? null : said(error));
      // The server may have taken the answer: no call stays with nobody behind it.
      if (unreachable(error)) void chatApi.endCall(id, true).catch(() => undefined);
      return;
    }
    // Hung up while the server answered: the call it took ends too.
    if (this.stale(attempt)) { void chatApi.endCall(id).catch(() => undefined); return; }
    this.update({ answered_at: answer.call.answered_at });
    await this.connect(id, answer.ice_servers, false, attempt);
    void this.offerMedia(attempt);
    // The offer waits among the signals.
    await this.sync();
  }

  async decline() {
    const view = this.view;
    if (view?.state !== 'ringing' || !view.id) return;
    this.dismissed.add(view.id);
    this.set(null);
    await chatApi.endCall(view.id).catch(() => undefined);
  }

  async hangUp() {
    const view = this.view;
    if (!view || view.state === 'ended') return;
    if (!view.here) return this.decline();
    this.finish(view.state === 'calling' ? 'cancelled' : 'hung-up');
    if (!view.id) return;
    // Both may hang up at once, or it was answered just then: the server says how it ended.
    const call = await chatApi.endCall(view.id).catch(() => null);
    if (call?.outcome && this.view?.id === view.id && this.view.state === 'ended') this.update({ ended: ENDINGS[call.outcome] });
  }

  mute(muted: boolean) {
    if (!this.holds()) return;
    this.stream?.getAudioTracks().forEach(track => { track.enabled = !muted; });
    this.update({ muted });
  }

  play() {
    const audio = this.audio, media = this.media;
    const silenced = (silenced: boolean) => { if (audio === this.audio && media === this.media) this.update({ silenced }); };
    void Promise.all([audio?.play(), media?.play()]).then(() => silenced(false), () => silenced(true));
  }

  dismiss() {
    if (this.view?.state !== 'ended') return;
    if (this.view.id) this.dismissed.add(this.view.id);
    this.set(null);
  }

  // --- The tab, the microphone and the connection ------------------------------------------

  /** This tab's hold on calls and the microphone; false, with the call ended here, when either is refused. */
  private async take(attempt: number) {
    const locked = await this.lock(attempt);
    if (this.stale(attempt)) return false;
    if (!locked) {
      this.update({ here: false });
      this.finish('other-tab');
      return false;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      if (!this.stale(attempt)) this.finish('microphone', error instanceof Error && error.name === 'NotFoundError' ? 'This device has no microphone.' : 'Allow the microphone for UniHub to make and take calls.');
      return false;
    }
    // Hung up while the browser asked.
    if (this.stale(attempt)) {
      stream.getTracks().forEach(track => track.stop());
      return false;
    }
    this.stream = stream;
    return true;
  }

  private lock(attempt: number) {
    if (!navigator.locks) return Promise.resolve(true);
    return new Promise<boolean>(resolve => {
      void navigator.locks.request(`${LOCK}${this.me}`, { ifAvailable: true }, lock => {
        resolve(!!lock);
        // Hung up before the lock came: it goes at once.
        return lock && !this.stale(attempt) ? new Promise<void>(release => { this.unlock = release; }) : undefined;
      }).catch(() => resolve(false));
    });
  }

  private async connect(id: string, iceServers: ChatIceServer[], caller: boolean, attempt: number) {
    try {
      await this.connectNow(id, iceServers, caller);
    } catch {
      // A connection closed by a hang-up rejects what it was doing.
      if (!this.stale(attempt)) await this.fail();
    }
  }

  private async connectNow(id: string, iceServers: ChatIceServer[], caller: boolean) {
    const pc = this.pc = new RTCPeerConnection({ iceServers });
    for (const track of this.stream!.getTracks()) pc.addTrack(track, this.stream!);
    pc.ontrack = ({ track, streams: [remote] }) => {
      if (track.kind !== 'audio' || !remote || typeof Audio === 'undefined') return;
      this.audio ??= new Audio();
      this.audio.srcObject = remote;
      this.play();
    };
    pc.onicecandidate = ({ candidate }) => { if (candidate) this.queue(candidate.toJSON()); };
    pc.onconnectionstatechange = () => this.connection(pc);
    this.alive = setInterval(() => void chatApi.callAlive(id).then(() => this.sync()).catch(() => undefined), ALIVE_MS);
    if (caller) await this.offer(pc);
    else this.connectBy();
  }

  private connectBy() {
    this.deadline ??= setTimeout(() => void this.fail(), RECONNECT_MS);
  }

  private connection(pc: RTCPeerConnection) {
    if (pc !== this.pc) return;
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') this.reconnect();
    this.refresh();
  }

  /**
   * Which path carries the sound: the direct connection while it is up; otherwise this end sends
   * through the server and plays what the server brings. The call is active while either carries it.
   */
  private refresh() {
    const pc = this.pc, view = this.view;
    if (!pc || !view || !this.holds() || view.state === 'calling') return;
    const direct = pc.connectionState === 'connected';
    const server = !direct && Date.now() - this.heardAt < HEARD_MS;
    this.media?.route(!direct);
    if (direct || server) {
      clearTimeout(this.deadline);
      this.deadline = undefined;
      this.update({ state: 'active', through_server: server });
    } else {
      if (view.state === 'active') this.update({ state: 'reconnecting', through_server: false });
      this.connectBy();
    }
  }

  // --- Through the server ------------------------------------------------------------------

  /** This end of the server path: its key, and whether this browser can carry the path, go to the other end. */
  private async offerMedia(attempt: number) {
    if (!this.stream) return;
    const [key, media] = await Promise.all([callKey().catch(() => null), CallMedia.open(this.stream)]);
    if (this.stale(attempt) || !key) media?.close();
    if (this.stale(attempt)) return;
    this.own = { key, able: !!(key && media) };
    this.media = key ? media : null;
    await this.signal({ t: 'key', k: key ? toBase64Url(key.raw) : '', media: this.own.able });
    await this.startMedia();
  }

  /** Starts the path once both halves are known; where the other end cannot carry it, this end's media goes. */
  private async startMedia() {
    const { own, peer, media } = this, id = this.view?.id, attempt = this.attempt;
    if (!own?.key || !peer || !media || !id || this.started || !this.holds()) return;
    this.started = true;
    const incoming = this.view!.incoming;
    const keys = peer.key && peer.media ? await callMediaKeys(id, own.key.pair, incoming ? peer.key : own.key.raw, incoming ? own.key.raw : peer.key, !incoming).catch(() => null) : null;
    if (this.stale(attempt)) return;
    if (!keys) {
      media.close();
      this.media = null;
      return;
    }
    // The page's own origin: the socket goes through the request boundary as every request.
    media.start(new URL(`/api/chat/calls/${id}/media`, location.href).href, keys, {
      heard: () => { if (media !== this.media) return; this.heardAt = Date.now(); this.refresh(); },
      opened: () => { if (media === this.media) this.refusal = null; },
      refused: code => { if (media === this.media) this.refusal = code === 'CHAT_CALL_MEDIA_UPGRADE' ? 'proxy' : code === 'CHAT_CALL_MEDIA_BUSY' ? 'busy' : null; },
      track: () => { if (media === this.media) this.play(); },
    });
    // Frames that stop arriving are noticed without an event.
    this.watch = setInterval(() => this.refresh(), 1000);
    this.refresh();
  }

  /** Why neither path carried the call, where it is known. */
  private why(): CallCause | null {
    if (this.own && !this.own.able) return 'this-browser';
    if (this.peer && !this.peer.media) return 'other-browser';
    return this.refusal;
  }

  /** A broken connection or a change of network: the caller restarts it, the callee asks for that. */
  private reconnect() {
    if (!this.holds() || !this.pc || this.view!.state === 'calling') return;
    if (this.view!.incoming) void this.signal({ t: 'restart' });
    else void this.restart().catch(() => undefined);
  }

  private async restart() {
    const pc = this.pc!;
    // An offer is out: its answer comes first.
    if (pc.signalingState !== 'stable') return;
    const iceServers = await chatApi.callIce(this.view!.id!);
    if (pc !== this.pc) return;
    pc.setConfiguration({ iceServers });
    pc.restartIce();
    await this.offer(pc);
  }

  private async offer(pc: RTCPeerConnection) {
    await pc.setLocalDescription(await pc.createOffer());
    if (pc === this.pc) await this.signal({ t: 'offer', sdp: pc.localDescription!.sdp });
  }

  /** Candidates go out in batches of a quarter second. */
  private queue(candidate: RTCIceCandidateInit) {
    this.outgoing.push(candidate);
    // shortcut: a batch is not split at the signal's 16,384 characters; a quarter second gathers a handful of candidates.
    this.batch ??= setTimeout(() => {
      this.batch = undefined;
      void this.signal({ t: 'candidates', c: this.outgoing.splice(0) });
    }, BATCH_MS);
  }

  private async signal(signal: Signal) {
    const id = this.view?.id;
    if (!id || !this.holds()) return;
    // A lost signal is made up for by a restart, or the call fails; an ended call shows on the next sync.
    await chatApi.callSignal(id, JSON.stringify(signal)).catch(() => this.sync());
  }

  private async readSignals() {
    const id = this.view!.id!;
    for (let more = true; more && this.pc;) {
      const page = await chatApi.callSignals(id, this.after);
      if (this.view?.id !== id) return;
      this.after = page.after;
      for (const { payload } of page.signals) await this.receive(payload);
      more = page.signals.length === 100;
    }
  }

  private async receive(payload: string) {
    const pc = this.pc;
    if (!pc) return;
    try {
      const signal = JSON.parse(payload) as Signal;
      if (signal.t === 'offer' && this.view!.incoming && typeof signal.sdp === 'string') {
        await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
        await this.addCandidates(pc, this.incoming.splice(0));
        await pc.setLocalDescription(await pc.createAnswer());
        if (pc === this.pc) await this.signal({ t: 'answer', sdp: pc.localDescription!.sdp });
      } else if (signal.t === 'answer' && !this.view!.incoming && typeof signal.sdp === 'string' && pc.signalingState === 'have-local-offer') {
        await pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
        await this.addCandidates(pc, this.incoming.splice(0));
      } else if (signal.t === 'candidates' && Array.isArray(signal.c)) {
        if (pc.remoteDescription) await this.addCandidates(pc, signal.c);
        else this.incoming.push(...signal.c);
      } else if (signal.t === 'restart' && !this.view!.incoming) {
        await this.restart();
      } else if (signal.t === 'key' && !this.peer && typeof signal.k === 'string') {
        this.peer = { key: signal.k ? fromBase64Url(signal.k) : null, media: signal.media === true };
        // Not awaited: the signals behind it (candidates) do not wait for the key's arithmetic.
        void this.startMedia();
      }
    } catch {
      // A signal this connection cannot take costs only itself: a restart or the deadline follows.
    }
  }

  private async addCandidates(pc: RTCPeerConnection, candidates: RTCIceCandidateInit[]) {
    // One of an earlier restart, or malformed: skipped.
    for (const candidate of candidates) await pc.addIceCandidate(candidate).catch(() => undefined);
  }

  private async fail() {
    const id = this.view?.id;
    this.finish('failed', null, false, this.why());
    if (id) await chatApi.endCall(id, true).catch(() => undefined);
  }

  /** Ends the call here; nothing of it is left: microphone, connections, the server path, timers, the tab's lock. */
  private finish(ending: CallEnding, reason: string | null = null, forbidden = false, cause: CallCause | null = null) {
    this.attempt++;
    clearTimeout(this.batch);
    clearInterval(this.alive);
    clearTimeout(this.deadline);
    clearInterval(this.watch);
    this.batch = this.alive = this.deadline = this.watch = undefined;
    if (this.ring) clearTimeout(this.ring.timer);
    this.ring = null;
    this.pc?.close();
    this.pc = null;
    this.media?.close();
    this.own = this.peer = this.media = this.refusal = null;
    this.started = false;
    this.heardAt = 0;
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;
    if (this.audio) this.audio.srcObject = null;
    this.audio = null;
    this.unlock?.();
    this.unlock = null;
    this.after = 0;
    this.outgoing = [];
    this.incoming = [];
    if (this.view) this.set({ ...this.view, state: 'ended', ended: ending, reason, silenced: false, forbidden, through_server: false, cause });
  }
}

// --- One per page, for the signed-in person -----------------------------------------------

let current: { calls: Calls; userId: string; users: number } | null = null;

/** Calls for a person on this page; the app takes the shared one through acquireChatCalls. */
export function startChatCalls(userId: string) {
  const calls = new Calls(userId);
  calls.open();
  return calls;
}

/** The person's calls on this page, started on first use; release when done (the last release stops them and ends a held call). */
export function acquireChatCalls(userId: string): { calls: ChatCalls; release: () => void } {
  if (current?.userId !== userId) {
    current?.calls.close();
    current = { calls: startChatCalls(userId), userId, users: 0 };
  }
  const held = current;
  held.users++;
  let released = false;
  return {
    calls: held.calls,
    release: () => {
      if (released) return;
      released = true;
      held.users--;
      // A page that remounts takes it again before this runs.
      setTimeout(() => {
        if (held.users || current !== held) return;
        held.calls.close();
        current = null;
      });
    },
  };
}
