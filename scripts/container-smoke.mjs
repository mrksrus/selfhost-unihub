import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

const container = process.env.UNIHUB_SMOKE_CONTAINER;
assert(container?.startsWith('unihub-smoke-'), 'Run through scripts/container-smoke.sh');
const base = 'http://localhost';
const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
assert(email && password);

class Session {
  cookies = new Map();
  csrf = null;
  async request(method, path, body, { expected = 200, authenticated = true, headers = {}, binary = false } = {}) {
    const response = await fetch(base + path, {
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(authenticated && this.cookies.size ? { Cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; ') } : {}),
        ...(authenticated && this.csrf && !['GET', 'HEAD'].includes(method) ? { 'X-CSRF-Token': this.csrf } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000),
    });
    assert.equal(response.status, expected, `${method} ${path} status`);
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';', 1)[0];
      const separator = pair.indexOf('=');
      this.cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
      if (method === 'POST' && path === '/api/auth/signin') {
        assert.match(cookie, /;\s*Secure(?:;|$)/i, 'production cookie must be Secure');
        assert.match(cookie, /;\s*HttpOnly(?:;|$)/i, 'production cookie must be HttpOnly');
        assert.match(cookie, /;\s*SameSite=Strict(?:;|$)/i, 'production cookie must be SameSite=Strict');
      }
    }
    if (binary) return { response, bytes: Buffer.from(await response.arrayBuffer()) };
    const data = await response.json();
    if (authenticated && data.csrfToken) this.csrf = data.csrfToken;
    return { response, data };
  }
}
function dockerNode(script, extraEnv = {}) {
  return execFileSync('docker', ['exec', ...Object.entries(extraEnv).flatMap(([key, value]) => ['-e', `${key}=${value}`]), container, 'node', '-e', script], { encoding: 'utf8', timeout: 30000 }).trim();
}
const databasePrelude = `const mysql = require('/app/api/node_modules/mysql2/promise');
const config = {host:process.env.MYSQL_HOST,port:Number(process.env.MYSQL_PORT),database:process.env.MYSQL_DATABASE,user:process.env.MYSQL_USER,password:process.env.MYSQL_PASSWORD};
if(!config.database.endsWith('_test'))throw new Error('Refusing non-test database');`;
const primary = new Session();
let otherId;
let recordingId;
try {
  const health = await primary.request('GET', '/health', undefined, { authenticated: false });
  assert.equal(health.data.health, 'ok'); assert.equal(health.data.database, 'ok');
  const directHealth = await fetch('http://localhost:4000/health', { signal: AbortSignal.timeout(5000) });
  assert.equal(directHealth.status, 200); assert.equal((await directHealth.json()).database, 'ok');
  const shell = await fetch(base + '/', { signal: AbortSignal.timeout(5000) });
  assert.equal(shell.status, 200); assert.match(shell.headers.get('content-type'), /text\/html/);
  assert.match(await shell.text(), /<div id="root"><\/div>/);
  const manifest = await fetch(base + '/manifest.webmanifest');
  assert.equal(manifest.status, 200); assert.equal((await manifest.json()).name, 'UniHub');
  const sw = await fetch(base + '/sw.js');
  assert.equal(sw.status, 200); assert.match(sw.headers.get('cache-control'), /no-store/);

  const login = await primary.request('POST', '/api/auth/signin', { email, password });
  assert.equal(login.data.user.email, email); assert.equal(login.data.user.role, 'admin');
  assert(primary.cookies.has('auth-token') && primary.cookies.has('csrf-token') && primary.csrf);
  const me = await primary.request('GET', '/api/auth/me');
  const userId = me.data.user.id;
  assert.equal(me.data.user.email, email);
  assert.equal((await primary.request('GET', '/api/notifications/config')).data.publicKey.length, 87);
  // The same operation without a CSRF token must be rejected even with valid auth cookies.
  const savedCsrf = primary.csrf; primary.csrf = null;
  await primary.request('POST', '/api/recordings/uploads/start', {}, { expected: 403 });
  primary.csrf = savedCsrf;

  // One second of 8 kHz mono PCM with a valid WAV header, generated without external tooling.
  const sampleRate = 8000; const wav = Buffer.alloc(44 + sampleRate * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(sampleRate * 2, 40);
  for (let index = 0; index < sampleRate; index++) wav.writeInt16LE(Math.round(4000 * Math.sin(2 * Math.PI * 440 * index / sampleRate)), 44 + index * 2);
  const started = await primary.request('POST', '/api/recordings/uploads/start', {
    title: 'CI container audio smoke', original_filename: '../../ci-smoke.wav', content_type: 'audio/wav', total_bytes: wav.length, duration_seconds: 1, source: 'imported',
  });
  const uploadId = started.data.upload.id;
  await primary.request('POST', `/api/recordings/uploads/${uploadId}/chunk`, { offset: 0, data_base64: wav.toString('base64') });
  const completed = await primary.request('POST', `/api/recordings/uploads/${uploadId}/complete`, { sha256: crypto.createHash('sha256').update(wav).digest('hex') });
  recordingId = completed.data.recording.id;
  assert.equal(completed.data.recording.size_bytes, wav.length);
  assert(!('storage_path' in completed.data.recording), 'API must not expose an absolute storage path');
  const listed = await primary.request('GET', '/api/recordings');
  assert(listed.data.recordings.some(item => item.id === recordingId));
  const downloaded = await primary.request('GET', `/api/recordings/${recordingId}/file?download=1`, undefined, { binary: true });
  assert.deepEqual(downloaded.bytes, wav);
  const range = await primary.request('GET', `/api/recordings/${recordingId}/file`, undefined, { binary: true, expected: 206, headers: { Range: 'bytes=0-31' } });
  assert.deepEqual(range.bytes, wav.subarray(0, 32));
  await primary.request('GET', `/api/recordings/${recordingId}/file`, undefined, { expected: 401, authenticated: false });

  // Create only a uniquely named test fixture directly; authorization is exercised through real HTTP signin.
  const otherEmail = `ci-isolation-${crypto.randomUUID()}@example.test`;
  otherId = dockerNode(databasePrelude + `(async()=>{const db=await mysql.createConnection(config);try{
    const id=require('crypto').randomUUID();const password=await require('/app/api/node_modules/bcryptjs').hash('ci-isolation-password-2026',10);
    await db.execute("INSERT INTO users (id,email,password_hash,full_name,role,is_active) VALUES (?,?,?,'CI isolation','user',TRUE)",[id,process.env.SMOKE_OTHER_EMAIL,password]);
    console.log(id);}finally{await db.end();}})().catch(error=>{console.error(error.code||error.name);process.exit(1)});`, { SMOKE_OTHER_EMAIL: otherEmail });
  const other = new Session();
  await other.request('POST', '/api/auth/signin', { email: otherEmail, password: 'ci-isolation-password-2026' });
  assert(!(await other.request('GET', '/api/recordings')).data.recordings.some(item => item.id === recordingId));
  await other.request('GET', `/api/recordings/${recordingId}/file`, undefined, { expected: 404 });
  await other.request('DELETE', `/api/recordings/${recordingId}`, undefined, { expected: 404 });

  const mp3 = await primary.request('GET', `/api/recordings/${recordingId}/file?format=mp3`, undefined, { binary: true });
  assert.match(mp3.response.headers.get('content-type'), /audio\/mpeg/); assert(mp3.bytes.length > 100);
  dockerNode(`const fs=require('fs'),path=require('path');const root='/app/uploads/recordings';
    const dir=path.join(root,process.env.SMOKE_USER_ID);const files=fs.readdirSync(dir).filter(name=>name.startsWith(process.env.SMOKE_RECORDING_ID));
    if(files.length<2)throw new Error('Expected isolated source and converted files');
    for(const file of files)if(!fs.realpathSync(path.join(dir,file)).startsWith(dir+path.sep))throw new Error('File escaped user storage');`, { SMOKE_USER_ID: userId, SMOKE_RECORDING_ID: recordingId });
  await primary.request('DELETE', `/api/recordings/${recordingId}`);
  await primary.request('GET', `/api/recordings/${recordingId}/file`, undefined, { expected: 404 });
  dockerNode(`const fs=require('fs'),path=require('path');const dir=path.join('/app/uploads/recordings',process.env.SMOKE_USER_ID);
    if(fs.existsSync(dir)&&fs.readdirSync(dir).some(name=>name.startsWith(process.env.SMOKE_RECORDING_ID)))throw new Error('Recording files remain after deletion');`, { SMOKE_USER_ID: userId, SMOKE_RECORDING_ID: recordingId });
  recordingId = null;
  await primary.request('POST', '/api/auth/signout', {});
  await primary.request('GET', '/api/auth/me', undefined, { expected: 401 });
  console.log('HTTP recording/auth/isolation smoke passed.');
} finally {
  if (recordingId) await primary.request('DELETE', `/api/recordings/${recordingId}`).catch(() => {});
  if (otherId) dockerNode(databasePrelude + `(async()=>{const db=await mysql.createConnection(config);try{
    await db.execute('DELETE FROM users WHERE id = ? AND email LIKE ?', [process.env.SMOKE_OTHER_ID,'ci-isolation-%@example.test']);
    }finally{await db.end();}})().catch(error=>{console.error(error.code||error.name);process.exit(1)});`, { SMOKE_OTHER_ID: otherId });
}
