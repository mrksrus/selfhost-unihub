// A throwaway server for tools/e2e/android/call-proof.test.mjs: it plays
// the part of a UniHub server towards the app's notification connection
// (the same stream, encryption and acknowledgements as the real one), sends
// it `call` messages, and relays a call's offer, answer, candidates and
// hang-up between the app's call page and a desktop Chromium. Both pages post
// their WebRTC counters here. Not the server's call routes: those are tested
// against the real server.
import http from 'node:http';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const webPush = createRequire(new URL('../../../api/package.json', import.meta.url))('web-push');
const version = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version;

// Both pages: the connection, the counters every two seconds, the signals by long polling.
const common = `
const call = new URLSearchParams(location.search).get('id');
const log = (event, detail = '') => fetch('/stub/event', { method: 'POST', body: JSON.stringify({ side, call, event, detail: String(detail) }) });
const signal = data => fetch('/stub/signal', { method: 'POST', body: JSON.stringify({ call, to: side === 'app' ? 'desk' : 'app', data }) });
let pc = null, ended = false, after = 0;
addEventListener('error', e => log('page-error', e.message));
addEventListener('unhandledrejection', e => log('page-error', e.reason?.stack ?? e.reason));
function connect(track) {
  pc = new RTCPeerConnection({ iceServers: [] });
  pc.addTrack(track);
  pc.onicecandidate = e => { if (e.candidate) signal({ kind: 'candidate', candidate: e.candidate.toJSON() }); };
  pc.ontrack = e => { const audio = new Audio(); audio.srcObject = new MediaStream([e.track]); audio.play().catch(error => log('play-failed', error)); };
  pc.onconnectionstatechange = () => log('connection', pc.connectionState);
  setInterval(report, 2000);
}
async function report() {
  if (!pc) return;
  const stats = { at: Date.now(), state: pc.connectionState };
  (await pc.getStats()).forEach(s => {
    if (s.type === 'inbound-rtp' && s.kind === 'audio') Object.assign(stats, { received: s.packetsReceived, energy: s.totalAudioEnergy ?? 0, level: s.audioLevel ?? 0 });
    if (s.type === 'outbound-rtp' && s.kind === 'audio') stats.sent = s.packetsSent;
    if (s.type === 'media-source' && s.kind === 'audio') stats.sourceEnergy = s.totalAudioEnergy ?? 0;
  });
  fetch('/stub/stats', { method: 'POST', body: JSON.stringify({ side, call, stats }) }).catch(() => {});
}
async function poll() {
  while (!ended) {
    let answer;
    try { answer = await (await fetch('/stub/signals?call=' + encodeURIComponent(call) + '&side=' + side + '&after=' + after)).json(); }
    catch { await new Promise(r => setTimeout(r, 1000)); continue; }
    after = answer.next;
    for (const data of answer.signals) await onSignal(data);
  }
}
function stop() { ended = true; pc?.close(); }
`;

// The app's side: a stand-in for the server's /call page, in CallActivity's WebView.
const appPage = `<!doctype html><meta name="viewport" content="width=device-width"><title>Call</title>
<style>body{font:20px sans-serif;margin:24px}button{font-size:22px;margin:8px;padding:16px 24px}</style>
<p id="state">…</p><button id="answer">Answer</button><button id="hangup">Hang up</button>
<script>
const side = 'app';
${common}
const bridge = window.UniHubAndroid;
// The page reports the call's state, as the server's /call page does (CallActivity).
const tell = state => bridge.postMessage(JSON.stringify({ type: 'call', state, id: call, muted: false }));
let pending = [], routes = [], state = 'ringing';
const showState = next => { state = next; document.getElementById('state').textContent = next; log('state', next); tell(next); };
async function onSignal(data) {
  if (data.kind === 'command') {
    if (data.action === 'hangUp') hangUp();
    const route = routes.find(r => r.kind === data.action);
    if (route) bridge.postMessage(JSON.stringify({ type: 'call', action: 'route', route: route.id }));
    return;
  }
  if (data.kind === 'hangup') { stop(); showState('ended'); setTimeout(() => tell('none'), 500); return; }
  if (!pc) { pending.push(data); return; }
  if (data.kind === 'offer') {
    await pc.setRemoteDescription(data.description);
    await pc.setLocalDescription(await pc.createAnswer());
    signal({ kind: 'answer', description: pc.localDescription.toJSON() });
  } else if (data.kind === 'candidate') {
    await pc.addIceCandidate(data.candidate).catch(error => log('candidate-failed', error));
  }
}
let starting = false;
async function start() {
  if (starting || ended) return;
  starting = true;
  showState('connecting');
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (error) { log('microphone-failed', error.name + ': ' + error.message); return; }
  log('microphone', stream.getAudioTracks()[0].label);
  connect(stream.getAudioTracks()[0]);
  pc.addEventListener('connectionstatechange', () => { if (pc.connectionState === 'connected' && state !== 'active') showState('active'); });
  const queued = pending; pending = [];
  for (const data of queued) await onSignal(data);
}
function hangUp() { if (ended) return; signal({ kind: 'hangup' }); stop(); showState('ended'); setTimeout(() => tell('none'), 500); }
bridge.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (message.type !== 'call') return;
  if (message.routes) { routes = message.routes; log('routes', routes.map(r => r.kind + (r.active ? '*' : '')).join(' ')); }
  if (!message.command) return;
  log('command', message.command);
  if (message.command === 'answer') start();
  if ((message.command === 'hangUp' || message.command === 'decline') && !ended) { signal({ kind: 'hangup' }); stop(); showState('ended'); }
});
document.getElementById('answer').onclick = start;
document.getElementById('hangup').onclick = hangUp;
// Where its buttons are, so the test can touch them as a finger would.
const layout = () => log('layout', JSON.stringify({ ratio: devicePixelRatio, buttons: Object.fromEntries([...document.querySelectorAll('button')]
  .map(b => { const r = b.getBoundingClientRect(); return [b.textContent, { x: r.x + r.width / 2, y: r.y + r.height / 2 }]; })) }));
addEventListener('resize', layout);
layout();
// Ready for the app's commands.
tell(state);
poll();
</script>`;

// The desktop's side, the caller: a steady test tone as its microphone.
const deskPage = `<!doctype html><title>Desk</title><script>
const side = 'desk';
${common}
async function onSignal(data) {
  if (data.kind === 'answer') await pc.setRemoteDescription(data.description);
  else if (data.kind === 'candidate') await pc.addIceCandidate(data.candidate).catch(error => log('candidate-failed', error));
  else if (data.kind === 'hangup') { stop(); log('ended', 'remote'); }
}
window.hangUp = () => { signal({ kind: 'hangup' }); stop(); };
(async () => {
  const context = new AudioContext();
  const tone = context.createOscillator();
  tone.frequency.value = 440;
  const out = context.createMediaStreamDestination();
  tone.connect(out);
  tone.start();
  connect(out.stream.getAudioTracks()[0]);
  await pc.setLocalDescription(await pc.createOffer());
  signal({ kind: 'offer', description: pc.localDescription.toJSON() });
  poll();
})();
</script>`;

export async function startCallStub() {
  const user = `stub-user-${crypto.randomUUID()}`;
  let device = null, stream = null;
  const queues = new Map(), waiters = new Map(), stats = new Map(), events = [], acks = [];
  const queue = key => { if (!queues.has(key)) queues.set(key, []); return queues.get(key); };
  const wake = key => { for (const resolve of waiters.get(key) ?? []) resolve(); waiters.delete(key); };
  const json = (res, status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
  const html = (res, body, headers = {}) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...headers }); res.end(body); };
  const read = req => new Promise((resolve, reject) => {
    let text = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { text += chunk; if (text.length > 1 << 20) req.destroy(); });
    req.on('end', () => { try { resolve(text ? JSON.parse(text) : {}); } catch (error) { reject(error); } });
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://stub.invalid');
    const route = `${req.method} ${url.pathname}`;
    try {
      if (route === 'GET /') {
        return html(res, '<!doctype html><title>UniHub stub</title><p>Signed in to the call stub.</p>', {
          'Set-Cookie': [`auth-token=${crypto.randomUUID()}; Path=/; HttpOnly; SameSite=Lax`, 'csrf-token=stub; Path=/; SameSite=Lax'] });
      }
      if (route === 'GET /call') return html(res, appPage);
      if (route === 'GET /desk') return html(res, deskPage);
      if (route === 'GET /api/version') return json(res, 200, { version, features: ['android-notifications'] });
      if (route === 'GET /api/auth/me') return json(res, 200, { user: { id: user, email: 'stub@example.com', full_name: 'Stub Person' } });
      if (route === 'POST /api/notifications/android/devices') {
        const { keys } = await read(req);
        device = { id: crypto.randomUUID(), keys };
        return json(res, 200, { device: device.id, endpoint: `unihub-android://${device.id}` });
      }
      if (route === 'GET /api/notifications/android/stream') {
        if (url.searchParams.get('device') !== device?.id) return json(res, 404, { error: 'Unknown device' });
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
        stream?.end();
        stream = res;
        const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 30_000);
        res.on('close', () => { clearInterval(heartbeat); if (stream === res) stream = null; });
        res.write(': connected\n\n');
        return;
      }
      if (route === 'POST /api/notifications/android/ack') { acks.push(...(await read(req)).ids); return json(res, 200, { ok: true }); }
      if (route === 'POST /api/notifications/unsubscribe') return json(res, 200, { ok: true });
      if (route === 'POST /stub/signal') {
        const { call, to, data } = await read(req);
        queue(`${call}:${to}`).push(data);
        wake(`${call}:${to}`);
        return json(res, 200, {});
      }
      if (route === 'GET /stub/signals') {
        const key = `${url.searchParams.get('call')}:${url.searchParams.get('side')}`;
        const after = Number(url.searchParams.get('after') ?? 0);
        if (queue(key).length <= after) {
          await new Promise(resolve => {
            const timer = setTimeout(resolve, 20_000);
            waiters.set(key, [...(waiters.get(key) ?? []), () => { clearTimeout(timer); resolve(); }]);
          });
        }
        const all = queue(key);
        return json(res, 200, { signals: all.slice(after), next: all.length });
      }
      if (route === 'POST /stub/stats') {
        const { side, call, stats: sample } = await read(req);
        const key = `${call}:${side}`;
        stats.set(key, [...(stats.get(key) ?? []), sample]);
        return json(res, 200, {});
      }
      if (route === 'POST /stub/event') { events.push({ ...(await read(req)), at: Date.now() }); return json(res, 200, {}); }
      return json(res, 404, { error: 'Not in the stub' });
    } catch (error) {
      return json(res, 500, { error: String(error) });
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const send = (payload) => {
    if (!stream || !device) throw new Error('the app has no notification connection to the stub');
    const body = JSON.stringify({ version: 1, userId: user, ...payload });
    const { cipherText } = webPush.encrypt(device.keys.p256dh, device.keys.auth, body, 'aes128gcm');
    const id = crypto.randomUUID();
    stream.write(`event: notification\ndata: ${JSON.stringify({ id, body: cipherText.toString('base64url') })}\n\n`);
    return id;
  };

  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    connected: () => stream !== null,
    acknowledged: id => acks.includes(id),
    /** The server's ring: a `call` message, in the shape the app reads (CallMessage). */
    ring: (call, name) => send({ kind: 'call', module: 'chat', dedupeKey: `call:${call}:ring`, title: name, body: '', url: `/call?id=${call}`, call: { id: call, event: 'ring' } }),
    stopRing: call => send({ kind: 'call', module: 'chat', dedupeKey: `call:${call}:end`, title: '', body: '', call: { id: call, event: 'end' } }),
    /** Something for the app's call page to do, as if the person tapped it there. */
    command: (call, action) => { queue(`${call}:app`).push({ kind: 'command', action }); wake(`${call}:app`); },
    stats: (call, side) => stats.get(`${call}:${side}`) ?? [],
    events: (call, side) => events.filter(e => e.call === call && (!side || e.side === side)),
    close: () => new Promise(resolve => { stream?.end(); server.closeAllConnections(); server.close(resolve); }),
  };
}
