const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('node:crypto') as typeof import('node:crypto');
const fs = require('node:fs') as typeof import('node:fs');
const os = require('node:os') as typeof import('node:os');
const path = require('node:path') as typeof import('node:path');

const config = require('../dist/src/config') as typeof import('../src/config');

// F10: every secret as a file or a variable, and an instance backup key of its own.
function scratch(t: import('node:test').TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unihub-secrets-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return (name: string, content: string) => { const file = path.join(dir, name); fs.writeFileSync(file, content, { mode: 0o600 }); return file; };
}

test('a secret comes from NAME_FILE before NAME; both set and different is refused without showing either', t => {
  const file = scratch(t);
  const value = 'synthetic-secret-' + crypto.randomBytes(8).toString('hex');
  assert.equal(config.readSecret('JWT_SECRET', {}), undefined);
  assert.equal(config.readSecret('JWT_SECRET', { JWT_SECRET: value }), value);
  // One trailing line break is how files are written; it is not part of the secret.
  assert.equal(config.readSecret('JWT_SECRET', { JWT_SECRET_FILE: file('jwt', `${value}\n`) }), value);
  assert.equal(config.readSecret('JWT_SECRET', { JWT_SECRET_FILE: file('crlf', `${value}\r\n`) }), value);
  assert.equal(config.readSecret('JWT_SECRET', { JWT_SECRET_FILE: file('same', value), JWT_SECRET: value }), value);

  const refusals: [NodeJS.ProcessEnv, RegExp][] = [
    [{ JWT_SECRET_FILE: file('other', value), JWT_SECRET: `${value}-other` }, /JWT_SECRET and JWT_SECRET_FILE are both set and differ/],
    [{ JWT_SECRET_FILE: path.join(os.tmpdir(), `missing-${crypto.randomUUID()}`) }, /JWT_SECRET_FILE \(.+\) does not exist/],
    [{ JWT_SECRET_FILE: file('empty', '\n') }, /JWT_SECRET_FILE \(.+\) is empty/],
    [{ JWT_SECRET_FILE: os.tmpdir() }, /is not a file/],
  ];
  for (const [env, message] of refusals) {
    assert.throws(() => config.readSecret('JWT_SECRET', env), (error: Error) => {
      assert.ok(error instanceof config.SecretConfigError);
      assert.match(error.message, message);
      assert.equal(error.message.includes(value), false, 'no value in the message');
      return true;
    });
  }
});

test('the database password and URL may be files, for the API and the readiness wait alike', t => {
  const file = scratch(t);
  const { getDatabaseConfig } = require('../dist/src/services/database-config') as typeof import('../src/services/database-config');
  const base = { MYSQL_HOST: 'db.example.test', MYSQL_DATABASE: 'unihub', MYSQL_USER: 'unihub' };
  assert.equal(getDatabaseConfig({ ...base, MYSQL_PASSWORD_FILE: file('db', 'synthetic-db-password\n') })?.password, 'synthetic-db-password');
  assert.equal(getDatabaseConfig({ DATABASE_URL_FILE: file('url', 'mysql://u:p%40ss@db.example.test:3307/unihub\n') })?.password, 'p@ss');
  assert.throws(() => getDatabaseConfig({ ...base, MYSQL_PASSWORD: 'a', MYSQL_PASSWORD_FILE: file('db2', 'b') }), /both set and differ/);
});

test('the instance backup is off without a destination and a key, and refuses a key that is short or another secret', t => {
  const file = scratch(t);
  const others = { JWT_SECRET: 'synthetic-jwt', ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'), ENCRYPTION_KEY_PREVIOUS: '', BACKUP_MASTER_KEY: '' };
  const key = crypto.randomBytes(48);
  const parse = (env: NodeJS.ProcessEnv) => config.parseInstanceBackupConfig(env, others);

  const off = parse({});
  assert.deepEqual([off.dir, off.key, off.missing, off.errors], [null, null, ['destination', 'key'], []]);
  // D35's defaults stay one named pair.
  assert.deepEqual([off.timeUtc, off.keep], [config.INSTANCE_BACKUP_DEFAULT_TIME_UTC, config.INSTANCE_BACKUP_DEFAULT_KEEP]);
  assert.deepEqual(parse({ INSTANCE_BACKUP_DIR: '/backup/instance' }).missing, ['key']);

  const on = parse({ INSTANCE_BACKUP_DIR: '/backup/instance/', INSTANCE_BACKUP_KEY_FILE: file('key', `${key.toString('base64')}\n`), INSTANCE_BACKUP_TIME: '01:05', INSTANCE_BACKUP_KEEP: '30' });
  assert.deepEqual([on.dir, on.missing, on.errors, on.timeUtc, on.keep], ['/backup/instance', [], [], '01:05', 30]);
  assert.ok(on.key!.equals(key));
  assert.ok(parse({ INSTANCE_BACKUP_KEY: key.toString('hex') }).key!.equals(key), 'hex works too');
  assert.ok(parse({ INSTANCE_BACKUP_KEY: key.toString('base64url') }).key!.equals(key), 'base64url works too');

  const refused: [NodeJS.ProcessEnv, RegExp][] = [
    [{ INSTANCE_BACKUP_KEY: crypto.randomBytes(16).toString('base64') }, /at least 32 random bytes/],
    [{ INSTANCE_BACKUP_KEY: 'correct horse battery staple, a passphrase' }, /at least 32 random bytes/],
    [{ INSTANCE_BACKUP_KEY: others.ENCRYPTION_KEY }, /its own key, not the value of ENCRYPTION_KEY/],
    // The same bytes written another way are the same key.
    [{ INSTANCE_BACKUP_KEY: Buffer.from(others.ENCRYPTION_KEY, 'hex').toString('base64') }, /not the value of ENCRYPTION_KEY/],
    [{ INSTANCE_BACKUP_KEY: 'a', INSTANCE_BACKUP_KEY_FILE: file('both', 'b') }, /both set and differ/],
    [{ INSTANCE_BACKUP_DIR: 'backup' }, /absolute path/],
    [{ INSTANCE_BACKUP_TIME: '3:30' }, /HH:MM/],
    [{ INSTANCE_BACKUP_TIME: '24:00' }, /HH:MM/],
    [{ INSTANCE_BACKUP_KEEP: '0' }, /from 1 to/],
    [{ INSTANCE_BACKUP_KEEP: '7 days' }, /from 1 to/],
  ];
  for (const [env, message] of refused) {
    const parsed = parse(env);
    assert.match(parsed.errors.join('\n'), message, JSON.stringify(Object.keys(env)));
    assert.equal(parsed.key, null);
    const value = String(env.INSTANCE_BACKUP_KEY || '');
    if (value.length > 8) assert.equal(parsed.errors.join('\n').includes(value), false, 'no value in the message');
  }
  assert.equal(parse({ INSTANCE_BACKUP_KEEP: '0' }).keep, config.INSTANCE_BACKUP_DEFAULT_KEEP);

  // Another secret's text, written as a key in any encoding, is that secret.
  const texts = { JWT_SECRET: `synthetic-jwt-${crypto.randomBytes(24).toString('hex')}`, ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
    ENCRYPTION_KEY_PREVIOUS: `synthetic previous key ${crypto.randomBytes(16).toString('hex')}`, BACKUP_MASTER_KEY: crypto.randomBytes(40).toString('hex') };
  for (const [name, text] of Object.entries(texts)) {
    const bytes = Buffer.from(text, 'utf8');
    const decoded = config.decodeKeyText(text);
    const encodings = [text, ` ${text}\n`, bytes.toString('base64'), bytes.toString('base64url'), bytes.toString('hex'),
      ...(decoded && decoded.length >= 32 ? [decoded.toString('base64'), decoded.toString('hex'), decoded.toString('base64url')] : [])];
    for (const encoding of encodings) {
      const parsed = config.parseInstanceBackupConfig({ INSTANCE_BACKUP_KEY: encoding }, texts);
      assert.equal(parsed.key, null, `${name} as ${encoding.slice(0, 12)}... is refused`);
      // A text that is no key at all fails as too short; every key encoding names the secret it repeats.
      if (config.decodeKeyText(encoding)) assert.match(parsed.errors.join('\n'), new RegExp(`its own key, not the value of (.* or )?${name}\\b`), `${name} as ${encoding.slice(0, 12)}...`);
    }
  }
  assert.deepEqual(config.parseInstanceBackupConfig({ INSTANCE_BACKUP_KEY: crypto.randomBytes(32).toString('base64') }, texts).errors, []);
  assert.throws(() => config.assertConfiguration(['INSTANCE_BACKUP_DIR must be its own volume']), /Configuration refused:\n- INSTANCE_BACKUP_DIR/);
});

test('the instance backup destination is refused inside the stored files, and the schedule catches up a missed day', () => {
  const backup = require('../dist/src/services/instance-backup') as typeof import('../src/services/instance-backup');
  const settings = (dir: string) => ({ dir, key: crypto.randomBytes(32), timeUtc: '03:30', keep: 14, missing: [], errors: [] });
  assert.match(backup.instanceBackupSetupErrors(settings('/app/uploads/instance-backups')).join(), /outside \/app\/uploads/);
  assert.match(backup.instanceBackupSetupErrors(settings('/app')).join(), /outside \/app\/uploads/);
  assert.deepEqual(backup.instanceBackupSetupErrors(settings('/backup/instance')), []);

  const at = (iso: string) => new Date(iso);
  assert.equal(backup.latestSlot(at('2026-11-01T03:29:59Z'), '03:30').toISOString(), '2026-10-31T03:30:00.000Z');
  assert.equal(backup.latestSlot(at('2026-11-01T03:30:00Z'), '03:30').toISOString(), '2026-11-01T03:30:00.000Z');
  assert.equal(backup.nextRun(at('2026-11-01T10:00:00Z'), '03:30').toISOString(), '2026-11-02T03:30:00.000Z');
  assert.equal(backup.nextRun(at('2026-11-01T01:00:00Z'), '03:30').toISOString(), '2026-11-01T03:30:00.000Z');

  // Only the app's own work in progress is left out, by the names its writers give it.
  const id = () => crypto.randomUUID();
  const left = (root: string, relative: string, directory = false) => backup.leftOut(root, relative.split('/'), directory);
  for (const [root, relative, directory] of [
    ['backups', 'imports', true], ['backups', 'restores', true], ['recordings', '.tmp', true],
    ['backups', `user/${id()}.zip.partial`], ['recordings', `user/memo.mp3.${id()}.tmp.mp3`],
    ['recordings', `user/restores/job/memo.mp3.${id()}.tmp.mp3`], ['mail-raw', `user/${id()}-${id()}.eml.part`],
    ['contact-photos', `user/.${'a'.repeat(64)}.jpg.${id()}.tmp`],
  ] as [string, string, boolean?][]) assert.ok(left(root, relative, directory), `${root}/${relative} is work in progress`);
  for (const [root, relative, directory] of [
    // A person's names are data, whatever they end in.
    ['attachments', `user/${id()}-${id()}-report.tmp`], ['attachments', `user/${id()}-${id()}-draft.partial`],
    ['attachments', `user/${id()}-${id()}-notes.tmp.txt`], ['attachments', `user/${id()}.eml.part`],
    ['backups', 'user/report.zip.partial'], ['backups', `user/${id()}.unihub-backup`], ['recordings', 'user/memo.webm'],
    ['recordings', 'user/memo.tmp.mp3'], ['contact-photos', `user/${'a'.repeat(64)}.jpg`],
    ['mail-raw', `user/restores/job/${id()}-${id()}.eml.part`],
    // A finished account restore's files, and same-named directories deeper down.
    ['attachments', 'user/restores', true], ['mail-raw', 'user/restores', true], ['recordings', 'user/.tmp', true],
    ['backups', 'user/restores', true], ['attachments', 'imports', true],
  ] as [string, string, boolean?][]) assert.equal(left(root, relative, directory), false, `${root}/${relative} is stored data`);
});
