const test = require('node:test');
const assert = require('node:assert/strict');
process.env.JWT_SECRET = 'auth-token-test-only-secret';
const jwt = require('jsonwebtoken');
const { generateToken } = require('../src/auth');

test('separate sessions for one user remain unique within the same second and verify normally', t => {
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const firstToken = generateToken('fixture-user');
  const secondToken = generateToken('fixture-user');
  assert.notEqual(firstToken, secondToken);
  const first = jwt.verify(firstToken, process.env.JWT_SECRET);
  const second = jwt.verify(secondToken, process.env.JWT_SECRET);
  assert.equal(first.iat, second.iat);
  assert.equal(first.userId, 'fixture-user');
  assert.equal(second.sub, 'fixture-user');
  assert.notEqual(first.jti, second.jti);
  assert.equal(first.exp - first.iat, 21 * 24 * 60 * 60);
});
