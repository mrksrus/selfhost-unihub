import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';

const container = process.env.UNIHUB_SMOKE_CONTAINER;
assert(container?.startsWith('unihub-smoke-'), 'Run through scripts/container-smoke.sh');
const base = 'http://localhost';
const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
assert(email && password);

class Session {
  cookies = new Map();
  csrf = null;
  async request(method, path, body, { expected = 200, authenticated = true, headers = {}, binary = false, rawBody = false } = {}) {
    const response = await fetch(base + path, {
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(authenticated && this.cookies.size ? { Cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; ') } : {}),
        ...(authenticated && this.csrf && !['GET', 'HEAD'].includes(method) ? { 'X-CSRF-Token': this.csrf } : {}), ...headers },
      body: body === undefined ? undefined : rawBody ? body : JSON.stringify(body), signal: AbortSignal.timeout(30000),
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
async function waitForJob(session, path, status, { uploadCleaned = false } = {}) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const { data } = await session.request('GET', path);
    assert(data.job, `${path} must return a job`);
    assert.notEqual(data.job.status, 'failed', `${path}: ${data.job.error || 'job failed'}`);
    if (data.job.status === status && (!uploadCleaned || !data.job.archive_available)) return data.job;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`${path} did not reach ${status} within 60 seconds`);
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
let contactId;
let backupId;
try {
  const health = await primary.request('GET', '/health', undefined, { authenticated: false });
  assert.equal(health.data.health, 'ok'); assert.equal(health.data.database, 'ok');
  const directHealth = await fetch('http://localhost:4000/health', { signal: AbortSignal.timeout(5000) });
  assert.equal(directHealth.status, 200); assert.equal((await directHealth.json()).database, 'ok');
  for (const url of [base + '/api/auth/signup-mode', 'http://localhost:4000/api/auth/signup-mode']) {
    // fetch replaces the Host header; use the HTTP client to send the actual
    // malformed authority and exercise both nginx and the API boundary.
    const status = await new Promise((resolve, reject) => {
      const request = http.request(url, { headers: { Host: '%' }, signal: AbortSignal.timeout(5000) }, response => {
        response.resume();
        response.on('error', reject);
        response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject);
      request.end();
    });
    assert.equal(status, 400, `Malformed Host must be rejected without killing the backend: ${url}`);
  }
  assert.equal((await fetch(base + '/health', { signal: AbortSignal.timeout(5000) })).status, 200);
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

  // Exercise the browser's backup workflow through nginx, auth/CSRF, the raw
  // upload parser and actual job workers. The second synthetic user has no
  // server-side key for this archive and must supply its recovery password.
  const contactEmail = `ci-backup-${crypto.randomUUID()}@example.test`;
  const contact = await primary.request('POST', '/api/contacts', { first_name: 'CI Grüße', last_name: 'Backup', email: contactEmail, notes: 'Preserve this contact\nAnd its second line' });
  contactId = contact.data.contact.id;
  const sourceContacts = (await primary.request('GET', '/api/contacts')).data.contacts;
  const sourceRecordings = (await primary.request('GET', '/api/recordings')).data.recordings;
  const exported = await primary.request('POST', '/api/backup/jobs', { sections: ['contacts', 'recordings'], encrypt: true }, { expected: 202 });
  backupId = exported.data.job.id;
  const readyBackup = await waitForJob(primary, `/api/backup/jobs/${backupId}`, 'ready');
  await other.request('GET', `/api/backup/jobs/${backupId}`, undefined, { expected: 404 });
  await primary.request('GET', `/api/backup/jobs/${backupId}/download`, undefined, { expected: 409 });
  const revealed = await primary.request('POST', `/api/backup/jobs/${backupId}/recovery-password/reveal`, {});
  const recoveryPassword = revealed.data.recovery_password;
  assert(typeof recoveryPassword === 'string' && recoveryPassword.length > 16, 'Recovery password must be available exactly once');
  await primary.request('POST', `/api/backup/jobs/${backupId}/recovery-password/reveal`, {}, { expected: 410 });
  const archive = await primary.request('GET', `/api/backup/jobs/${backupId}/download`, undefined, { binary: true });
  assert.match(archive.response.headers.get('content-type'), /application\/vnd\.unihub\.backup/);
  assert.equal(archive.bytes.length, readyBackup.file_size);
  assert.equal(crypto.createHash('sha256').update(archive.bytes).digest('hex'), readyBackup.file_sha256);
  const imported = await other.request('POST', '/api/backup/import?sections=contacts,recordings&conflict_mode=replace', archive.bytes, {
    expected: 202, rawBody: true, headers: { 'Content-Type': 'application/vnd.unihub.backup' },
  });
  const restoreId = imported.data.job.id;
  assert.equal(imported.data.job.status, 'awaiting_password');
  await primary.request('GET', `/api/backup/restore-jobs/${restoreId}`, undefined, { expected: 404 });
  await other.request('POST', `/api/backup/restore-jobs/${restoreId}/unlock`, { password: 'incorrect-ci-recovery-password' }, { expected: 400 });
  await other.request('POST', `/api/backup/restore-jobs/${restoreId}/unlock`, { password: recoveryPassword }, { expected: 202 });
  await waitForJob(other, `/api/backup/restore-jobs/${restoreId}`, 'validated');
  await other.request('POST', `/api/backup/restore-jobs/${restoreId}/start`, {}, { expected: 202 });
  await waitForJob(other, `/api/backup/restore-jobs/${restoreId}`, 'completed', { uploadCleaned: true });
  const restoredContacts = (await other.request('GET', '/api/contacts')).data.contacts;
  const restoredRecordings = (await other.request('GET', '/api/recordings')).data.recordings;
  assert.equal(restoredContacts.length, sourceContacts.length);
  assert.equal(restoredRecordings.length, sourceRecordings.length);
  const restoredContact = restoredContacts.find(item => item.email === contactEmail);
  assert(restoredContact && restoredContact.id !== contactId);
  assert.equal(restoredContact.notes, contact.data.contact.notes);
  const restoredRecording = restoredRecordings.find(item => item.title === completed.data.recording.title);
  assert(restoredRecording && restoredRecording.id !== recordingId);
  const restoredAudio = await other.request('GET', `/api/recordings/${restoredRecording.id}/file?download=1`, undefined, { binary: true });
  assert.deepEqual(restoredAudio.bytes, wav);
  await primary.request('GET', `/api/recordings/${restoredRecording.id}/file`, undefined, { expected: 404 });
  await other.request('DELETE', `/api/backup/restore-jobs/${restoreId}`);
  await primary.request('DELETE', `/api/backup/jobs/${backupId}`); backupId = null;
  for (const item of restoredRecordings) await other.request('DELETE', `/api/recordings/${item.id}`);
  await primary.request('DELETE', `/api/contacts/${contactId}`); contactId = null;

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
  console.log('HTTP recording/auth/isolation and encrypted backup/restore round-trip smoke passed.');
} finally {
  if (recordingId) await primary.request('DELETE', `/api/recordings/${recordingId}`).catch(() => {});
  if (contactId) await primary.request('DELETE', `/api/contacts/${contactId}`).catch(() => {});
  if (backupId) await primary.request('DELETE', `/api/backup/jobs/${backupId}`).catch(() => {});
  if (otherId) dockerNode(databasePrelude + `(async()=>{const db=await mysql.createConnection(config);try{
    await db.execute('DELETE FROM users WHERE id = ? AND email LIKE ?', [process.env.SMOKE_OTHER_ID,'ci-isolation-%@example.test']);
    }finally{await db.end();}})().catch(error=>{console.error(error.code||error.name);process.exit(1)});`, { SMOKE_OTHER_ID: otherId });
}
