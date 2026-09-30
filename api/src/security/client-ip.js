const net = require('node:net');

function normalizeIp(value) {
  const input = String(value || '').trim();
  const family = net.isIP(input);
  if (family === 4) return input;
  if (family !== 6 || input.includes('%')) return null;
  const normalized = new URL(`http://[${input}]/`).hostname.slice(1, -1);
  const mapped = normalized.match(/^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/);
  if (mapped) {
    const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
    return [high >>> 8, high & 255, low >>> 8, low & 255].join('.');
  }
  return normalized;
}

function createClientIpResolver({ trustProxyHeaders = false, trustedProxyCidrs = ['127.0.0.1/32', '::1/128'] } = {}) {
  const trusted = new net.BlockList();
  for (const value of trustedProxyCidrs) {
    const parts = String(value).trim().split('/');
    const family = net.isIP(parts[0]);
    const bits = family === 4 ? 32 : 128;
    const prefix = parts.length === 1 ? bits : Number(parts[1]);
    if (!family || parts.length > 2 || parts[1] === '' || !Number.isInteger(prefix) || prefix < 0 || prefix > bits) {
      throw new Error('TRUSTED_PROXY_CIDRS must contain valid IP addresses or CIDRs');
    }
    trusted.addSubnet(parts[0], prefix, family === 4 ? 'ipv4' : 'ipv6');
  }
  const isTrusted = ip => trusted.check(ip, net.isIP(ip) === 4 ? 'ipv4' : 'ipv6');
  return req => {
    let current = normalizeIp(req.socket?.remoteAddress) || 'unknown';
    if (!trustProxyHeaders || current === 'unknown' || !isTrusted(current)) return current;
    const header = req.headers['x-forwarded-for'];
    if (typeof header !== 'string' || header.length > 4096) return current;
    const chain = header.split(',');
    if (chain.length > 32) return current;
    // Each trusted proxy appends its actual peer. Stop at the first untrusted
    // hop, ignoring any client-supplied addresses farther to its left.
    for (let index = chain.length - 1; index >= 0 && isTrusted(current); index--) {
      const next = normalizeIp(chain[index]);
      if (!next) return current;
      current = next;
    }
    return current;
  };
}

module.exports = { normalizeIp, createClientIpResolver };
