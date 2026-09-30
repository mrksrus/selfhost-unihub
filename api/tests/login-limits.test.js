const test = require('node:test');
const assert = require('node:assert/strict');
const { createLoginLimiter } = require('../src/security/login-limits');
const { createClientIpResolver, normalizeIp } = require('../src/security/client-ip');

test('account budgets remain separate on shared IPs and survive other account successes', () => {
  let now = 0;
  const limiter = createLoginLimiter({ now: () => now });
  for (let index = 0; index < 10; index++) {
    assert.equal(limiter.consume('password', 'user-one', 10, 600000), null);
    if (index < 3) assert.equal(limiter.consume('password', 'user-two', 10, 600000), null);
  }
  assert.equal(limiter.consume('password', 'user-one', 10, 600000), 600);
  assert.equal(limiter.consume('password', 'user-two', 10, 600000), null);
  now = 600001;
  assert.equal(limiter.consume('password', 'user-one', 10, 600000), null);
});

test('IP overload recovers in one minute and memory pressure never resets active budgets', () => {
  let now = 0;
  const limiter = createLoginLimiter({ now: () => now, maxEntries: 2 });
  assert.equal(limiter.consume('ip', 'one', 1, 60000), null);
  assert.equal(limiter.consume('ip', 'two', 1, 60000), null);
  assert.equal(limiter.consume('ip', 'three', 1, 60000), 60);
  assert.equal(limiter.consume('ip', 'one', 1, 60000), 60);
  now = 60001;
  assert.equal(limiter.consume('ip', 'three', 1, 60000), null);
});

const request = (remote, forwarded, real = '192.0.2.255') => ({ socket: { remoteAddress: remote }, headers: { 'x-forwarded-for': forwarded, 'x-real-ip': real } });
test('trusted proxy chains distinguish visitors and ignore spoofed leftmost addresses', () => {
  const resolve = createClientIpResolver({ trustProxyHeaders: true, trustedProxyCidrs: ['127.0.0.1/32', '::1/128', '172.20.0.8/32'] });
  assert.equal(resolve(request('127.0.0.1', '192.0.2.1, 198.51.100.10, 172.20.0.8')), '198.51.100.10');
  assert.equal(resolve(request('127.0.0.1', '198.51.100.11, 172.20.0.8')), '198.51.100.11');
  assert.equal(resolve(request('198.51.100.12', '192.0.2.1')), '198.51.100.12');
  assert.equal(resolve(request('::ffff:127.0.0.1', '198.51.100.10, 172.20.0.8')), '198.51.100.10');
});

test('default trusts only loopback, malformed chains fail closed, and IP aliases normalize', () => {
  const resolve = createClientIpResolver({ trustProxyHeaders: true });
  assert.equal(resolve(request('127.0.0.1', '198.51.100.10, 172.20.0.8')), '172.20.0.8');
  assert.equal(resolve(request('127.0.0.1', '198.51.100.10, invalid')), '127.0.0.1');
  assert.equal(createClientIpResolver()(request('127.0.0.1', '198.51.100.10')), '127.0.0.1');
  assert.equal(normalizeIp('::ffff:7f00:1'), '127.0.0.1');
  assert.equal(normalizeIp('2001:0db8:0000:0000:0000:0000:0000:0001'), '2001:db8::1');
  assert.throws(() => createClientIpResolver({ trustedProxyCidrs: ['172.20.0.8/invalid'] }));
});
