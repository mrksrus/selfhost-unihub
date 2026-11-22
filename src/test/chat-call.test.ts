// @vitest-environment node
import { ALEX, BLAIR, PASSPHRASES, browser, context, open, pair, server, settled, until, chatDeliveryHooks, type Browser } from './chat-delivery';
import { AsyncLocalStorage } from 'node:async_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startChatCalls } from '@/lib/chat/call';
import { callKey, callMediaKeys, type CallMediaEvents } from '@/lib/chat/call-media';
import { openFrame, replayCheck, sealFrame } from '@/lib/chat/call-media.worker';
import { fromBase64Url } from '@/lib/chat/bytes';
import { open as openSealed, type SealKey } from '@/lib/chat/seal';
import { ChatStore } from '@/lib/chat/store';
import type { ChatThreadCall } from '@/lib/chat/types';

// Calls against the in-memory delivery service's call routes, with a fake
// RTCPeerConnection that connects once both descriptions and a candidate of
// the other side are in, while the network is up, and a fake path through
// the server whose frames, refusals and slow starts the tests make. Real sound
// is the e2e's.

const media = vi.hoisted(() => {
  const state = { unable: new Set<string>(), all: [] as FakeMedia[], gate: null as Promise<void> | null, who: () => '' };
  class FakeMedia {
    user = state.who();
    started: { url: string; events: CallMediaEvents } | null = null;
    server: boolean | null = null;
    closed = false;
    static async open() {
      const user = state.who();
      await state.gate;
      if (state.unable.has(user)) return null;
      const made = new FakeMedia();
      made.user = user;
      state.all.push(made);
      return made;
    }
    start(url: string, _keys: unknown, events: CallMediaEvents) { this.started = { url, events }; }
    route(server: boolean) { this.server = server; }
    async play() {}
    close() { this.closed = true; }
  }
  return { state, FakeMedia };
});
vi.mock('@/lib/chat/call-media', async original => ({ ...await original<typeof import('@/lib/chat/call-media')>(), CallMedia: media.FakeMedia }));

chatDeliveryHooks();

const CASEY = 'casey';
const network = { up: true };
const mic = { allow: true, asked: 0, tracks: [] as { enabled: boolean; stopped: boolean }[], holding: false, held: [] as (() => void)[] };
/** The browser plays the other person's sound only after a tap when `allow` is false. */
const speaker = { allow: true, played: [] as unknown[] };
const VIDEO = { video: true };

class FakeConnection {
  static all: FakeConnection[] = [];
  connectionState: RTCPeerConnectionState = 'new';
  signalingState: RTCSignalingState = 'stable';
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  onicecandidate: ((event: { candidate: unknown }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ontrack: ((event: { track: { kind: string }; streams: unknown[] }) => void) | null = null;
  restarts = 0;
  private heard = 0;
  constructor(public config: RTCConfiguration) { FakeConnection.all.push(this); }
  addTrack() {}
  setConfiguration(config: RTCConfiguration) { this.config = config; }
  restartIce() { this.restarts++; }
  async createOffer() { return { type: 'offer' as const, sdp: `offer ${this.restarts}` }; }
  async createAnswer() { return { type: 'answer' as const, sdp: `answer to ${this.remoteDescription?.sdp}` }; }
  async setLocalDescription(description: RTCSessionDescriptionInit) {
    this.localDescription = description;
    this.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable';
    // Candidates trickle out after the description, then the end of gathering.
    queueMicrotask(() => {
      for (const n of [1, 2]) this.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: `candidate ${n} for ${description.sdp}`, sdpMid: '0' }) } });
      this.onicecandidate?.({ candidate: null });
    });
    this.check();
  }
  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remoteDescription = description;
    this.heard = 0;
    this.ontrack?.({ track: { kind: 'video' }, streams: [VIDEO] });
    this.ontrack?.({ track: { kind: 'audio' }, streams: [{ audio: true }] });
    this.signalingState = description.type === 'answer' ? 'stable' : 'have-remote-offer';
  }
  async addIceCandidate() {
    if (!this.remoteDescription) throw new DOMException('no remote description', 'InvalidStateError');
    this.heard++;
    this.check();
  }
  check() {
    if (network.up && this.signalingState === 'stable' && this.localDescription && this.remoteDescription && this.heard && !['connected', 'closed'].includes(this.connectionState)) this.become('connected');
  }
  become(state: RTCPeerConnectionState) { this.connectionState = state; this.onconnectionstatechange?.(); }
  close() { this.connectionState = 'closed'; }
}
vi.stubGlobal('RTCPeerConnection', FakeConnection);
vi.stubGlobal('location', new URL('https://unihub.example/call'));
vi.stubGlobal('Audio', class {
  srcObject: unknown = null;
  async play() {
    if (!speaker.allow) throw new DOMException('no tap yet', 'NotAllowedError');
    speaker.played.push(this.srcObject);
  }
});
Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => {
  mic.asked++;
  // The browser asks the person; the prompt stays open while `holding`.
  if (mic.holding) await new Promise<void>(resolve => mic.held.push(resolve));
  if (!mic.allow) throw new DOMException('denied', 'NotAllowedError');
  const track = { enabled: true, stopped: false, stop() { this.stopped = true; } };
  mic.tracks.push(track);
  return { getTracks: () => [track], getAudioTracks: () => [track] };
} } });

type Calls = ReturnType<typeof startChatCalls>;
interface Phone { browser: Browser; calls: Calls; view: () => ReturnType<Calls['snapshot']>; as<T>(act: (calls: Calls) => T): T }
const phones: Phone[] = [];

/** A tab of a browser with its calls; a new browser is a new joined chat device of its person. */
function phone(on: Browser | [string, string]): Phone {
  const at = Array.isArray(on) ? browser(...on) : on;
  const id = crypto.randomUUID();
  if (Array.isArray(on)) server.devices.set(id, { id, user_id: at.userId, device: `${at.userId}:${at.device}`, packages: [], last_resort: '', preview: null, joined: true, challenge: null, pair: null });
  const calls = context.run(at, () => startChatCalls(at.userId));
  const made: Phone = { browser: at, calls, view: () => calls.snapshot(), as: act => context.run(at, () => act(calls)) };
  phones.push(made);
  return made;
}

const settle = (ms = 1000) => vi.advanceTimersByTimeAsync(ms);
const live = () => mic.tracks.filter(track => !track.stopped).length;

/** The next `method url` request goes through `wrap`, which sends it to the server with `send`. */
function once(method: string, url: string, wrap: (send: () => Promise<unknown>) => Promise<unknown>) {
  const real = server.handle;
  server.handle = (m, u, body) => {
    if (m !== method || u !== url) return real(m, u, body);
    server.handle = real;
    return wrap(() => real(m, u, body)) as ReturnType<typeof real>;
  };
}
/** A slow network: the request reaches the server only when the returned function is called. */
function hold(method: string, url: string) {
  let open!: () => void;
  const gate = new Promise<void>(resolve => { open = resolve; });
  once(method, url, async send => { await gate; return send(); });
  return open;
}
/** The server does the request, and its answer is lost on the way back. */
const lose = (method: string, url: string) => once(method, url, async send => { await send(); return { error: 'Failed to fetch' }; });
const call = () => [...server.calls.values()].at(-1)!;
const connections = () => FakeConnection.all.filter(pc => pc.connectionState !== 'closed');

/** Alex calls Blair, who has two browsers; Blair's first answers. */
async function answered() {
  const alex = phone([ALEX, 'a1']);
  const blair = phone([BLAIR, 'b1']);
  const blair2 = phone([BLAIR, 'b2']);
  await alex.as(calls => calls.start({ user_id: BLAIR }, 'Blair Example'));
  await settle();
  await blair.as(calls => calls.answer());
  await settle();
  expect(alex.view()).toMatchObject({ state: 'active', here: true });
  expect(blair.view()).toMatchObject({ state: 'active', here: true });
  return { alex, blair, blair2 };
}

describe('a call', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    // A timer runs in the browser that set it, as each tab's own would.
    for (const name of ['setTimeout', 'setInterval'] as const) {
      const fake = globalThis[name] as (callback: () => void, ms?: number) => unknown;
      (globalThis as Record<string, unknown>)[name] = (callback: () => void, ms?: number) => { const run = AsyncLocalStorage.snapshot(); return fake(() => run(callback), ms); };
    }
    server.names.set(CASEY, 'Casey Example');
    server.state.hint = users => phones.filter(item => users.includes(item.browser.userId)).forEach(item => item.as(calls => void calls.sync()));
    Object.assign(network, { up: true });
    Object.assign(mic, { allow: true, asked: 0, tracks: [], holding: false, held: [] });
    Object.assign(speaker, { allow: true, played: [] });
    FakeConnection.all = [];
    Object.assign(media.state, { unable: new Set(), all: [], gate: null, who: () => context.getStore()?.userId ?? '' });
  });
  afterEach(() => {
    phones.splice(0).forEach(item => item.as(calls => calls.close()));
    vi.useRealTimers();
  });

  it('rings every device of the callee, connects the one that answers, mutes, and leaves nothing behind when hung up', async () => {
    const alex = phone([ALEX, 'a1']);
    const blair = phone([BLAIR, 'b1']);
    const blair2 = phone([BLAIR, 'b2']);
    await alex.as(calls => calls.start({ user_id: BLAIR }, 'Blair Example'));
    await settle();
    expect(alex.view()).toMatchObject({ state: 'calling', sound: 'ringback', here: true, incoming: false, peer: { user_id: BLAIR, name: 'Blair Example' } });
    for (const on of [blair, blair2]) expect(on.view()).toMatchObject({ state: 'ringing', sound: 'ring', here: false, incoming: true, peer: { user_id: ALEX, name: 'Alex Example' } });
    // Ringing asks for no microphone and makes no connection.
    expect(mic.asked).toBe(1);

    // The browser refused to play Alex's sound without a tap.
    speaker.allow = false;
    await blair.as(calls => calls.answer());
    await settle();
    expect(alex.view()).toMatchObject({ state: 'active', sound: null, silenced: true });
    speaker.allow = true;
    alex.as(calls => calls.play());
    await settle();
    expect(alex.view()?.silenced).toBe(false);
    // Only the other person's sound plays.
    expect(speaker.played.length).toBeGreaterThan(0);
    expect(speaker.played).not.toContain(VIDEO);
    expect(blair.view()).toMatchObject({ state: 'active', here: true });
    expect(alex.view()!.answered_at).not.toBeNull();
    expect(blair2.view()).toMatchObject({ state: 'ended', ended: 'answered-elsewhere', here: false });
    // Candidates went in batches, not one signal each.
    expect(call().signals.filter(item => !item.payload.includes('"t":"key"')).length).toBeLessThanOrEqual(4);

    alex.as(calls => calls.mute(true));
    expect(alex.view()?.muted).toBe(true);
    expect(mic.tracks[0].enabled).toBe(false);
    // Both ends keep the call alive.
    await settle(31_000);
    expect(call().state).toBe('active');

    await alex.as(calls => calls.hangUp());
    await settle();
    expect(alex.view()).toMatchObject({ state: 'ended', ended: 'hung-up' });
    expect(blair.view()).toMatchObject({ state: 'ended', ended: 'hung-up' });
    // The ending about another device goes with the call.
    expect(blair2.view()).toBeNull();
    expect(mic.tracks.every(track => track.stopped)).toBe(true);
    expect(connections()).toEqual([]);
    expect(server.messages.at(-1)).toMatchObject({ kind: 'call', group_id: null, ciphertext: null, call: { outcome: 'answered' } });
    alex.as(calls => calls.dismiss());
    expect(alex.view()).toBeNull();
  });

  it('ends as declined, as busy, and as no answer when the ring time is over, with or without the server\'s end', async () => {
    const alex = phone([ALEX, 'a1']);
    const blair = phone([BLAIR, 'b1']);
    const casey = phone([CASEY, 'c1']);
    await alex.as(calls => calls.start({ user_id: BLAIR }, 'Blair Example'));
    await settle();
    await blair.as(calls => calls.decline());
    await settle();
    expect(alex.view()).toMatchObject({ state: 'ended', ended: 'declined' });
    expect(blair.view()).toBeNull();
    alex.as(calls => calls.dismiss());

    // Blair is on a call with Casey: Alex hears busy, Blair gets a missed call.
    await casey.as(calls => calls.start({ user_id: BLAIR }, 'Blair Example'));
    await settle();
    await blair.as(calls => calls.answer());
    await settle();
    await alex.as(calls => calls.start({ user_id: BLAIR }, 'Blair Example'));
    expect(alex.view()).toMatchObject({ state: 'ended', ended: 'busy', reason: 'Blair Example is on another call.' });
    expect(server.messages.at(-1)?.call?.outcome).toBe('busy');
    expect(connections()).toHaveLength(2);
    await casey.as(calls => calls.hangUp());
    await settle();
    alex.as(calls => calls.dismiss());

    // The server's sweep ends it.
    await alex.as(calls => calls.start({ user_id: BLAIR }, 'Blair Example'));
    await settle();
    server.ringOver(call().id);
    await settle();
    expect(alex.view()).toMatchObject({ state: 'ended', ended: 'no-answer' });
    expect(blair.view()).toBeNull();
    alex.as(calls => calls.dismiss());

    // No end arrives: both sides stop ringing by themselves, and the caller ends it.
    await alex.as(calls => calls.start({ user_id: BLAIR }, 'Blair Example'));
    await settle();
    server.state.hint = () => {};
    // A device whose clock runs ahead of the server's still rings for the whole ring time.
    call().created_at = new Date(Date.now() - 600_000).toISOString();
    const late = phone(blair.browser);
    await settle(44_000);
    expect(blair.view()?.state).toBe('ringing');
    expect(late.view()?.state).toBe('ringing');
    await settle(10_000);
    expect(blair.view()).toBeNull();
    expect(alex.view()).toMatchObject({ state: 'ended', ended: 'no-answer' });
    expect(call().state).toBe('ended');
    expect(connections()).toEqual([]);
  });

  it('when both hang up at once or call each other at once, there is one call', async () => {
    const { alex, blair } = await answered();
    await Promise.all([alex.as(calls => calls.hangUp()), blair.as(calls => calls.hangUp())]);
    await settle();
    expect([alex.view()?.ended, blair.view()?.ended]).toEqual(['hung-up', 'hung-up']);
    expect(server.messages.filter(item => item.kind === 'call')).toHaveLength(1);
    alex.as(calls => calls.dismiss());
    blair.as(calls => calls.dismiss());

    await Promise.all([alex.as(calls => calls.start({ user_id: BLAIR }, 'Blair Example')), blair.as(calls => calls.start({ user_id: ALEX }, 'Alex Example'))]);
    await settle();
    expect(server.calls.size).toBe(2);
    expect([alex.view()?.state, blair.view()?.state]).toEqual(['active', 'active']);
    expect([alex.view()?.incoming, blair.view()?.incoming].sort()).toEqual([false, true]);
  });

  it('restarts a broken connection, from either side, and fails the call after 30 seconds without one', async () => {
    const { alex, blair } = await answered();
    const [mine, theirs] = connections();

    // Both sides see it break; the caller restarts with fresh connection servers.
    const fail = (state: RTCPeerConnectionState) => { alex.as(() => mine.become(state)); blair.as(() => theirs.become(state)); };
    fail('failed');
    expect(alex.view()?.state).toBe('reconnecting');
    await settle();
    expect(mine.restarts).toBe(1);
    expect([alex.view()?.state, blair.view()?.state]).toEqual(['active', 'active']);

    // Only the callee sees it: it asks the caller for the restart.
    blair.as(() => theirs.become('disconnected'));
    await settle();
    expect(mine.restarts).toBe(2);
    expect(blair.view()?.state).toBe('active');

    // The network stays down.
    network.up = false;
    fail('failed');
    await settle(29_000);
    expect(alex.view()?.state).toBe('reconnecting');
    await settle(1_500);
    expect(alex.view()).toMatchObject({ state: 'ended', ended: 'failed' });
    expect(blair.view()).toMatchObject({ state: 'ended', ended: 'failed' });
    expect(call().outcome).toBe('failed');
    expect(mic.tracks.every(track => track.stopped)).toBe(true);
    expect(connections()).toEqual([]);
  });

  it('a hang-up while the microphone or the server is still answering leaves no microphone on and no call that cannot be stopped', async () => {
    const alex = phone([ALEX, 'a1']);
    const blair = phone([BLAIR, 'b1']);
    const start = () => alex.as(calls => calls.start({ user_id: BLAIR }, 'Blair Example'));
    const ends = async (on: Phone) => {
      await on.as(calls => calls.hangUp());
      await settle();
      expect(call().state).toBe('ended');
      expect(live()).toBe(0);
      alex.as(calls => calls.dismiss());
      blair.as(calls => calls.dismiss());
    };

    // Call, hang up while the browser asks for the microphone, call again, then Allow both.
    mic.holding = true;
    const first = start();
    await settle();
    await alex.as(calls => calls.hangUp());
    await settle();
    const second = start();
    await settle();
    mic.holding = false;
    mic.held.splice(0).forEach(allow => allow());
    await Promise.all([first, second]);
    await settle();
    expect(server.calls.size).toBe(1);
    expect(alex.view()).toMatchObject({ state: 'calling', id: call().id });
    expect(blair.view()).toMatchObject({ state: 'ringing', id: call().id });
    expect(live()).toBe(1);
    await ends(alex);

    // The same with the start on a slow network.
    const open = hold('POST', '/chat/calls');
    const slow = start();
    await settle();
    await alex.as(calls => calls.hangUp());
    await settle();
    await start();
    await settle();
    open();
    await slow;
    await settle();
    expect(server.calls.size).toBe(2);
    expect(alex.view()).toMatchObject({ state: 'calling', id: call().id });
    expect(live()).toBe(1);
    await ends(alex);

    // Blair answers, hangs up while the browser asks, answers Alex's next call, then Allows both.
    await start();
    await settle();
    mic.holding = true;
    const answer = blair.as(calls => calls.answer());
    await settle();
    mic.holding = false;
    await blair.as(calls => calls.hangUp());
    await settle();
    expect(call().outcome).toBe('declined');
    alex.as(calls => calls.dismiss());
    blair.as(calls => calls.dismiss());
    await start();
    await settle();
    mic.holding = true;
    const again = blair.as(calls => calls.answer());
    await settle();
    mic.holding = false;
    mic.held.splice(0).forEach(allow => allow());
    await Promise.all([answer, again]);
    await settle();
    expect([alex.view()?.state, blair.view()?.state]).toEqual(['active', 'active']);
    expect(blair.view()?.id).toBe(call().id);
    expect(live()).toBe(2);
    await ends(blair);
  });

  it('a call of this device that no tab holds, its answer lost, ends as failed', async () => {
    const alex = phone([ALEX, 'a1']);
    const blair = phone([BLAIR, 'b1']);
    lose('POST', '/chat/calls');
    await alex.as(calls => calls.start({ user_id: BLAIR }, 'Blair Example'));
    await settle();
    expect(call()).toMatchObject({ state: 'ended', outcome: 'failed' });
    expect(alex.view()).toMatchObject({ state: 'ended', ended: 'failed' });
    expect(blair.view()).toBeNull();
    alex.as(calls => calls.dismiss());

    await alex.as(calls => calls.start({ user_id: BLAIR }, 'Blair Example'));
    await settle();
    lose('POST', `/chat/calls/${call().id}/answer`);
    await blair.as(calls => calls.answer());
    await settle();
    expect(call()).toMatchObject({ state: 'ended', outcome: 'failed' });
    expect(blair.view()).toMatchObject({ state: 'ended', ended: 'failed' });
    expect(alex.view()).toMatchObject({ state: 'ended', ended: 'failed' });
    expect(live()).toBe(0);
    alex.as(calls => calls.dismiss());

    // Found by a later sync (the network was down until then): no tab of the device holds it.
    const left = { ...call(), id: crypto.randomUUID(), state: 'ringing' as const, outcome: null, answered: null, answered_at: null, signals: [] };
    server.calls.set(left.id, left);
    await alex.as(calls => calls.sync());
    await settle();
    expect(call()).toMatchObject({ id: left.id, state: 'ended', outcome: 'failed' });
    expect(alex.view()).toMatchObject({ id: left.id, state: 'ended', ended: 'failed' });
  });

  it('a refused microphone neither starts nor answers a call', async () => {
    const alex = phone([ALEX, 'a1']);
    const blair = phone([BLAIR, 'b1']);
    mic.allow = false;
    await alex.as(calls => calls.start({ user_id: BLAIR }, 'Blair Example'));
    expect(alex.view()).toMatchObject({ state: 'ended', ended: 'microphone' });
    expect(server.calls.size).toBe(0);

    mic.allow = true;
    alex.as(calls => calls.dismiss());
    await alex.as(calls => calls.start({ user_id: BLAIR }, 'Blair Example'));
    await settle();
    mic.allow = false;
    await blair.as(calls => calls.answer());
    await settle();
    expect(blair.view()).toMatchObject({ state: 'ended', ended: 'microphone' });
    expect(call().state).toBe('ringing');
    expect(alex.view()?.state).toBe('calling');
  });

  it('a second tab does not take a call the first holds; closing the first releases it', async () => {
    const alex = phone([ALEX, 'a1']);
    const blair = phone([BLAIR, 'b1']);
    const blairTab = phone(blair.browser);
    await alex.as(calls => calls.start({ user_id: BLAIR }, 'Blair Example'));
    await settle();
    expect(blairTab.view()?.state).toBe('ringing');
    await blair.as(calls => calls.answer());
    await settle();
    expect(blairTab.view()).toMatchObject({ state: 'ended', ended: 'other-tab', here: false });

    // The other tab cannot place one either: no microphone, no connection.
    const [asked, made] = [mic.asked, FakeConnection.all.length];
    blairTab.as(calls => calls.dismiss());
    await blairTab.as(calls => calls.start({ user_id: CASEY }, 'Casey Example'));
    expect(blairTab.view()).toMatchObject({ state: 'ended', ended: 'other-tab' });
    expect([mic.asked, FakeConnection.all.length]).toEqual([asked, made]);
    blairTab.as(calls => calls.dismiss());

    // The holding tab closes: the call ends, and the other tab can call.
    blair.as(calls => calls.close());
    await settle();
    expect(call()).toMatchObject({ state: 'ended', outcome: 'answered' });
    expect(alex.view()).toMatchObject({ state: 'ended', ended: 'hung-up' });
    await blairTab.as(calls => calls.start({ user_id: ALEX }, 'Alex Example'));
    await settle();
    expect(blairTab.view()).toMatchObject({ state: 'calling', here: true });
  });
});

describe('a call through the server', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    for (const name of ['setTimeout', 'setInterval'] as const) {
      const fake = globalThis[name] as (callback: () => void, ms?: number) => unknown;
      (globalThis as Record<string, unknown>)[name] = (callback: () => void, ms?: number) => { const run = AsyncLocalStorage.snapshot(); return fake(() => run(callback), ms); };
    }
    server.state.hint = users => phones.filter(item => users.includes(item.browser.userId)).forEach(item => item.as(calls => void calls.sync()));
    // No direct connection comes up.
    Object.assign(network, { up: false });
    Object.assign(mic, { allow: true, asked: 0, tracks: [], holding: false, held: [] });
    FakeConnection.all = [];
    Object.assign(media.state, { unable: new Set(), all: [], gate: null, who: () => context.getStore()?.userId ?? '' });
  });
  afterEach(() => {
    phones.splice(0).forEach(item => item.as(calls => calls.close()));
    vi.useRealTimers();
  });
  const of = (user: string) => media.state.all.find(item => item.user === user && !item.closed);
  const heard = (on: Phone) => on.as(() => of(on.browser.userId)!.started!.events.heard());
  /** The keys' arithmetic runs outside the fake timers. */
  const until = (check: () => void) => vi.waitFor(check, { timeout: 5000 });
  async function dialled() {
    const alex = phone([ALEX, 'a1']);
    const blair = phone([BLAIR, 'b1']);
    await alex.as(calls => calls.start({ user_id: BLAIR }, 'Blair Example'));
    await settle();
    await blair.as(calls => calls.answer());
    await settle();
    return { alex, blair };
  }

  it('carries the call while the direct connection is down, hands it to the direct one when that comes, and takes it back when it drops', async () => {
    const { alex, blair } = await dialled();
    // Both ends opened their path to the call's socket; nothing arrived yet.
    await until(() => expect(of(BLAIR)?.started && of(ALEX)?.started).toBeTruthy());
    expect([of(ALEX)?.started?.url, of(BLAIR)?.started?.url].map(url => url && new URL(url).pathname)).toEqual([`/api/chat/calls/${call().id}/media`, `/api/chat/calls/${call().id}/media`]);
    expect([alex.view()?.state, blair.view()?.state]).toEqual(['connecting', 'connecting']);
    heard(alex);
    heard(blair);
    expect(alex.view()).toMatchObject({ state: 'active', through_server: true });
    expect([of(ALEX)!.server, of(BLAIR)!.server]).toEqual([true, true]);

    // The direct connection comes: the server path stops sending and its sound is muted.
    const [mine] = connections();
    alex.as(() => mine.become('connected'));
    expect(alex.view()).toMatchObject({ state: 'active', through_server: false });
    expect(of(ALEX)!.server).toBe(false);
    // It drops: the server path takes over at once while its frames come.
    heard(alex);
    alex.as(() => mine.become('failed'));
    expect(alex.view()).toMatchObject({ state: 'active', through_server: true });
    expect(of(ALEX)!.server).toBe(true);

    // The frames stop too: reconnecting after two seconds, failed after thirty, with the reverse proxy named.
    await settle(3000);
    expect(alex.view()).toMatchObject({ state: 'reconnecting', through_server: false });
    alex.as(() => of(ALEX)!.started!.events.refused('CHAT_CALL_MEDIA_UPGRADE', 'Upgrade required'));
    await settle(30_000);
    expect(alex.view()).toMatchObject({ state: 'ended', ended: 'failed', reason: expect.stringMatching(/reverse proxy/) });
    expect(media.state.all.every(item => item.closed)).toBe(true);
    expect(connections()).toEqual([]);
  });

  it('never starts where the other browser cannot carry it, and says which browser cannot', async () => {
    media.state.unable.add(BLAIR);
    const { alex, blair } = await dialled();
    await until(() => expect(media.state.all.map(item => [item.user, !!item.started, item.closed])).toEqual([[ALEX, false, true]]));
    await settle(31_000);
    expect(alex.view()).toMatchObject({ state: 'ended', ended: 'failed', reason: 'The other person\'s browser cannot carry calls between networks.' });
    expect(blair.view()).toMatchObject({ state: 'ended', ended: 'failed', reason: 'This browser cannot carry calls between networks.' });
  });

  it('a path that is ready only after the call ended is closed and never started', async () => {
    let open!: () => void;
    media.state.gate = new Promise<void>(resolve => { open = resolve; });
    const { alex, blair } = await dialled();
    await alex.as(calls => calls.hangUp());
    await settle();
    const signals = server.messages.length;
    open();
    await settle();
    await until(() => expect(media.state.all.map(item => [item.started, item.closed])).toEqual([[null, true], [null, true]]));
    expect(server.messages.length).toBe(signals);
    expect(blair.view()).toMatchObject({ state: 'ended', ended: 'hung-up' });
  });
});

describe('a call\'s frames through the server', () => {
  it('open only under the key of their direction and call, unchanged, and once', async () => {
    const [alex, blair] = await Promise.all([callKey(), callKey()]);
    const sending = await callMediaKeys('call-1', alex.pair, alex.raw, blair.raw, true);
    const receiving = await callMediaKeys('call-1', blair.pair, alex.raw, blair.raw, false);
    const packet = new Uint8Array([5, 6, 7, 8]);
    const frame = await sealFrame(sending.send, sending.sendSalt, 7, packet);
    expect(await openFrame(receiving.receive, receiving.receiveSalt, frame)).toEqual({ sequence: 7, packet });
    // A changed header (the sender's byte) or ciphertext is refused.
    for (const at of [1, frame.length - 1]) {
      const changed = frame.slice();
      changed[at] ^= 1;
      expect(await openFrame(receiving.receive, receiving.receiveSalt, changed)).toBeNull();
    }
    // The other direction has its own key, and another call other keys.
    expect(await openFrame(sending.receive, sending.receiveSalt, frame)).toBeNull();
    const other = await callMediaKeys('call-2', blair.pair, alex.raw, blair.raw, false);
    expect(await openFrame(other.receive, other.receiveSalt, frame)).toBeNull();

    const fresh = replayCheck();
    expect([100, 100, 60, 50, 49].map(fresh)).toEqual([true, false, true, true, false]);
  });
});

describe('a call entry in the chat', { timeout: 60_000 }, () => {
  it('is stored, counts as unread only when missed, is archived and comes back on a new device', async () => {
    const { alex, blair, conversation } = await pair();
    const made = (outcome: 'missed' | 'answered') => {
      const ringing = { id: crypto.randomUUID(), conversation, caller: ALEX, callee: BLAIR, callerDevice: '', answered: null, state: 'ringing' as const, outcome: null,
        created_at: new Date().toISOString(), answered_at: outcome === 'answered' ? new Date().toISOString() : null, signals: [] };
      server.calls.set(ringing.id, ringing);
      server.finish(ringing, outcome);
    };
    made('missed');
    made('answered');
    for (const on of [alex, blair]) await on.as(engine => engine.sync());
    const calls = (on: typeof alex) => (on.engine.thread(conversation) ?? []).filter((item): item is ChatThreadCall => item.kind === 'call')
      .map(item => [item.call.outcome, item.from_me]);
    expect(calls(blair)).toEqual([['missed', false], ['answered', false]]);
    expect(calls(alex)).toEqual([['missed', true], ['answered', true]]);
    // Only the callee's missed call is unread; the chat list's last line is the newest call, for each from their side.
    expect(blair.engine.snapshot().conversations[0]).toMatchObject({ unread: 1, last_message: { text: null, from_me: false, call: { outcome: 'answered' } } });
    expect(alex.engine.snapshot().conversations[0]).toMatchObject({ unread: 0, last_message: { from_me: true, call: { outcome: 'answered' } } });
    // A call entry is neither edited nor deleted.
    const entry = server.messages.find(item => item.kind === 'call')!.id;
    expect(() => alex.engine.edit(entry, 'changed')).toThrow();
    await expect(alex.as(engine => engine.delete(entry))).rejects.toThrow();

    // Each archived them like a message it read.
    const entries = server.messages.filter(item => item.kind === 'call').map(item => item.id);
    const copies = [...server.archive.values()].filter(copy => copy.user === BLAIR && entries.includes(copy.message));
    expect(copies).toHaveLength(2);
    const key = await context.run(blair.browser, async () => (await ChatStore.open(BLAIR)).historyKey());
    expect(JSON.parse(new TextDecoder().decode(await openSealed(key as SealKey, fromBase64Url(copies[0].sealed)))).call.call_id).toBeTruthy();

    const blair2 = open(BLAIR, 'b2');
    await settled(blair2);
    await blair2.as(engine => engine.enterPassphrase(PASSPHRASES[BLAIR]));
    await until(blair2, () => calls(blair2).length === 2);
    expect(calls(blair2)).toEqual([['missed', false], ['answered', false]]);
  });
});
