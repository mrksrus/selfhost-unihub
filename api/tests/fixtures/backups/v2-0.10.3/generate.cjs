// Maintenance only: pass an untouched git archive of v0.10.3 as argument 1.
// Uses its real exporter and an empty disposable MySQL database.
const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
(async () => {
  const source = path.resolve(process.argv[2], 'api');
  const pool = mysql.createPool({ host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT), user: process.env.MYSQL_TEST_USER, password: process.env.MYSQL_TEST_PASSWORD, database: process.env.MYSQL_TEST_DATABASE });
  assert.match(process.env.MYSQL_TEST_DATABASE, /_test$/);
  try {
    const [tables] = await pool.query('SHOW TABLES');
    assert.equal(tables.length, 0, 'Fixture generator needs an empty test database');
    require(path.join(source, 'src/state')).setDb(pool);
    await require(path.join(source, 'src/services/database')).ensureSchema();
    const user = '01030000-0000-4000-8000-000000000001';
    const account = '01030000-0000-4000-8000-000000000002';
    const folder = '01030000-0000-4000-8000-000000000003';
    await pool.execute('INSERT INTO users (id,email,password_hash,full_name) VALUES (?,?,?,?)', [user, 'v2-fixture@example.test', 'not-a-real-password-hash', 'Schema two fixture']);
    await pool.execute('INSERT INTO mail_accounts (id,user_id,email_address,imap_host,smtp_host,encrypted_password,provider,is_active) VALUES (?,?,?,?,?,?,\'custom\',FALSE)', [account,user,'mail@example.test','imap.example.test','smtp.example.test','']);
    await pool.execute('INSERT INTO mail_folders (id,user_id,slug,display_name,is_system,position) VALUES (?,?,?,?,FALSE,99)', [folder,user,'important-v2','Important']);
    await pool.execute('INSERT INTO mail_folder_remote_boxes (folder_id,mail_account_id,remote_name) VALUES (?,?,?)', [folder,account,'Important']);
    await pool.execute('INSERT INTO emails (id,user_id,mail_account_id,from_address,to_addresses,subject,body_text,folder,source_folder,is_read) VALUES (?,?,?,?,?,?,?,?,?,TRUE)', ['01030000-0000-4000-8000-000000000004',user,account,'sender@example.test',JSON.stringify(['mail@example.test']),'Frozen schema two message','Original schema two body','important-v2','Important']);
    const entries = await require(path.join(source, 'src/services/backup')).buildBackupArchiveEntriesForUser(user, 'full');
    assert.ok(Array.isArray(entries) && entries.length >= 3);
    const output = path.join(__dirname, 'plain.zip');
    await require(path.join(source, 'src/services/export-jobs')).writeZip(entries, output);
    const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
    const hashes = {};
    for (const file of ['services/backup.js','services/backup-format.js','services/export-jobs.js','services/database.js']) hashes[file] = sha(await fs.readFile(path.join(source,'src',file)));
    await fs.writeFile(path.join(__dirname,'expected.json'),JSON.stringify({tag:'v0.10.3', commit:'04fc92d99f0af0775e45d6e62345a3ddb5a06c83', version:2, sha256:sha(await fs.readFile(output)), source_sha256:hashes, user, account, folder, subject:'Frozen schema two message', body:'Original schema two body', remote_name:'Important'},null,2)+'\n');
    console.log(output);
  } finally { await pool.end(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
