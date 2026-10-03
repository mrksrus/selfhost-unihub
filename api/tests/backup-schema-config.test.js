const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  BACKUP_UPLOAD_MAX_SIZE,
  MAIL_COMPOSE_REQUEST_MAX_SIZE,
} = require('../src/config');

const repoRoot = path.resolve(__dirname, '..', '..');

test('backup upload limit is aligned below the ZIP32 boundary', () => {
  const nginxConfig = fs.readFileSync(
    path.join(repoRoot, 'docker/nginx/default.conf'),
    'utf8'
  );

  assert.equal(BACKUP_UPLOAD_MAX_SIZE, 3900 * 1024 * 1024);
  assert.match(nginxConfig, /client_max_body_size 3900m;/);
  assert.ok(BACKUP_UPLOAD_MAX_SIZE < 0xffffffff);
});

test('mail compose upload limits allow base64 attachment overhead through nginx', () => {
  const nginxConfig = fs.readFileSync(
    path.join(repoRoot, 'docker/nginx/default.conf'),
    'utf8'
  );

  assert.equal(MAIL_COMPOSE_REQUEST_MAX_SIZE, 40 * 1024 * 1024);
  assert.match(nginxConfig, /location \/api\/ \{[\s\S]*?client_max_body_size 40m;/);
  assert.ok(MAIL_COMPOSE_REQUEST_MAX_SIZE > Math.ceil((25 * 1024 * 1024) / 3) * 4);
});

test('generated MySQL schema contains current backup job tables and indexes', () => {
  const schema = fs.readFileSync(
    path.join(repoRoot, 'docker/mariadb/schema.sql'),
    'utf8'
  );

  assert.match(schema, /^CREATE TABLE `backup_restore_jobs` \(/m);
  assert.match(schema, /^CREATE TABLE `backup_archive_keys` \(/m);
  assert.match(schema, /`recovery_password_revealed_at` timestamp NULL DEFAULT NULL/);
  assert.match(schema, /KEY `idx_data_export_jobs_user_backup` \(`user_id`,`backup_uuid`\)/);
  assert.match(schema, /KEY `idx_backup_restore_jobs_user_backup` \(`user_id`,`backup_uuid`\)/);
});

test('file downloads stream past nginx buffering and the service worker', () => {
  const nginxConfig = fs.readFileSync(path.join(repoRoot, 'docker/nginx/default.conf'), 'utf8');
  const viteConfig = fs.readFileSync(path.join(repoRoot, 'vite.config.ts'), 'utf8');
  const nginxPattern = new RegExp(nginxConfig.match(/location ~ (\^\/api\/\(backup[^ ]+\$) \{[\s\S]*?proxy_buffering off;/)[1]);
  const workerPattern = new RegExp(viteConfig.match(/!\/(\^\\\/api\\\/\(backup[^ ]+\$)\/\.test\(url\.pathname\)/)[1]);
  for (const pathname of ['/api/backup/jobs/job-1/download', '/api/recordings/rec-1/file', '/api/mail/attachments/att-1']) {
    assert.match(pathname, nginxPattern); assert.match(pathname, workerPattern);
  }
  for (const pathname of ['/api/backup/jobs/job-1', '/api/mail/emails', '/api/recordings/rec-1']) {
    assert.doesNotMatch(pathname, nginxPattern); assert.doesNotMatch(pathname, workerPattern);
  }
});
