const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const serverPath = path.join(__dirname, '..', 'server.js');
const serverSource = fs.readFileSync(serverPath, 'utf8');

test('does not contain hardcoded encryption key fallback', () => {
  assert.equal(
    serverSource.includes('unihub-encryption-key-for-email-credentials-change-me'),
    false
  );
  assert.equal(
    serverSource.includes('const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;'),
    true
  );
});

test('uses strict TLS certificate verification for mail transport', () => {
  assert.equal(
    serverSource.includes("tlsOptions: { \n          rejectUnauthorized: true,"),
    true
  );
  assert.equal(
    serverSource.includes("tls: {\n        rejectUnauthorized: true,"),
    true
  );
});

test('maps admin activate route explicitly', () => {
  assert.equal(
    serverSource.includes("routeKey = `${req.method} /api/admin/users/:id/activate`;"),
    true
  );
});

test('verifies user active status during token validation', () => {
  assert.equal(serverSource.includes('INNER JOIN users u ON u.id = s.user_id'), true);
  assert.equal(serverSource.includes('if (!session.is_active) return null;'), true);
});

test('no hardcoded default admin credentials in API bootstrap', () => {
  assert.equal(serverSource.includes('admin123'), false);
  assert.equal(serverSource.includes('admin@unihub.local'), false);
});
