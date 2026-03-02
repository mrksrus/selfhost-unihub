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

test('uses strict TLS by default with explicit override', () => {
  assert.equal(
    serverSource.includes('const allowSelfSigned = toBooleanFlag(account.allow_self_signed);'),
    true
  );
  const rejectUnauthorizedMatches = serverSource.match(/rejectUnauthorized: !allowSelfSigned,/g) || [];
  assert.equal(rejectUnauthorizedMatches.length >= 3, true);
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
