import type { FixtureValue } from './helpers/test-types.cts';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { createClientIpResolver, normalizeIp } = require('../dist/src/security/client-ip') as typeof import('../src/security/client-ip');

const request = (remote: FixtureValue, forwarded: FixtureValue, real = '192.0.2.255') => ({ socket: { remoteAddress: remote }, headers: { 'x-forwarded-for': forwarded, 'x-real-ip': real } });
test('trusted proxy chains distinguish visitors and ignore spoofed leftmost addresses', () => {
  const resolve = createClientIpResolver({ trustProxyHeaders: true, trustedProxyCidrs: ['127.0.0.1/32', '::1/128', '172.20.0.8/32'] });
  assert.equal(resolve(request('127.0.0.1', '192.0.2.1, 198.51.100.10, 172.20.0.8') as FixtureValue), '198.51.100.10');
  assert.equal(resolve(request('127.0.0.1', '198.51.100.11, 172.20.0.8') as FixtureValue), '198.51.100.11');
  assert.equal(resolve(request('198.51.100.12', '192.0.2.1') as FixtureValue), '198.51.100.12');
  assert.equal(resolve(request('::ffff:127.0.0.1', '198.51.100.10, 172.20.0.8') as FixtureValue), '198.51.100.10');
});

test('default trusts only loopback, malformed chains fail closed, and IP aliases normalize', () => {
  const resolve = createClientIpResolver({ trustProxyHeaders: true });
  assert.equal(resolve(request('127.0.0.1', '198.51.100.10, 172.20.0.8') as FixtureValue), '172.20.0.8');
  assert.equal(resolve(request('127.0.0.1', '198.51.100.10, invalid') as FixtureValue), '127.0.0.1');
  assert.equal(createClientIpResolver()(request('127.0.0.1', '198.51.100.10') as FixtureValue), '127.0.0.1');
  assert.equal(normalizeIp('::ffff:7f00:1'), '127.0.0.1');
  assert.equal(normalizeIp('2001:0db8:0000:0000:0000:0000:0000:0001'), '2001:db8::1');
  assert.throws(() => createClientIpResolver({ trustedProxyCidrs: ['172.20.0.8/invalid'] }));
});
