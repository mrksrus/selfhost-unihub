const dns = require('node:dns').promises;
const net = require('node:net');
const { domainToASCII } = require('node:url');
const { TRUSTED_MAIL_HOSTS } = require('../config');

// Default-deny special-use ranges, including IPv4-mapped IPv6 and transition
// mechanisms that can otherwise hide a connection to a private IPv4 address.
const nonPublicV4 = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) nonPublicV4.addSubnet(address, prefix, 'ipv4');
const globalV6 = new net.BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const nonPublicV6 = new net.BlockList();
for (const [address, prefix] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3ffe::', 16], ['3fff::', 20],
]) nonPublicV6.addSubnet(address, prefix, 'ipv6');

function normalizeNetworkHost(value) {
  let host = String(value || '').trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (net.isIP(host) && !host.includes('%')) return host;
  host = domainToASCII(host.replace(/\.$/, ''));
  if (!host || host.length > 253 || !host.split('.').every(label =>
    label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return '';
  return host;
}

function isPublicNetworkAddress(address) {
  if (net.isIP(address) === 4) return !nonPublicV4.check(address, 'ipv4');
  if (net.isIP(address) === 6 && !address.includes('%')) {
    return globalV6.check(address, 'ipv6') && !nonPublicV6.check(address, 'ipv6');
  }
  return false;
}

function isTrustedMailHost(host, trustedHosts = TRUSTED_MAIL_HOSTS) {
  const normalized = normalizeNetworkHost(host);
  if (!normalized) return false;
  return trustedHosts.some(value => {
    const allowed = normalizeNetworkHost(value);
    return allowed && (normalized === allowed || (!net.isIP(allowed) && normalized.endsWith(`.${allowed}`)));
  });
}

function networkPolicyError(message) {
  const error = new Error(message);
  error.code = 'OUTBOUND_HOST_BLOCKED';
  error.status = 400;
  return error;
}

async function resolveNetworkHost(host, { lookup = dns.lookup.bind(dns), timeoutMs = 10000 } = {}) {
  const normalized = normalizeNetworkHost(host);
  if (!normalized) throw networkPolicyError('A valid mail/calendar hostname is required.');
  if (net.isIP(normalized)) return [{ address: normalized, family: net.isIP(normalized) }];
  let timer;
  try {
    const addresses = await Promise.race([
      lookup(normalized, { all: true, verbatim: true }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(networkPolicyError('Mail/calendar DNS lookup timed out.')), timeoutMs);
      }),
    ]);
    if (!Array.isArray(addresses) || !addresses.length || addresses.some(item => !net.isIP(item.address))) {
      throw networkPolicyError('Mail/calendar hostname did not resolve to a valid address.');
    }
    return addresses.map(item => ({ address: item.address, family: net.isIP(item.address) }));
  } catch (error) {
    if (error.code === 'OUTBOUND_HOST_BLOCKED') throw error;
    throw networkPolicyError(`Mail/calendar hostname could not be resolved (${error.code || 'DNS error'}).`);
  } finally {
    clearTimeout(timer);
  }
}

// The caller MUST connect to address, never resolve hostname again. Keep hostname
// for TLS certificate verification/SNI and HTTP Host, so DNS pinning does not
// weaken authentication of the actual mail/calendar server.
async function resolveMailConnectionTarget(host, options = {}) {
  const hostname = normalizeNetworkHost(host);
  const addresses = await resolveNetworkHost(hostname, options);
  if (!isTrustedMailHost(hostname, options.trustedHosts) && addresses.some(item => !isPublicNetworkAddress(item.address))) {
    throw networkPolicyError('Mail/calendar host resolves to a non-public address. Ask the administrator to add it to TRUSTED_MAIL_HOSTS if this is intentional.');
  }
  const selected = addresses.find(item => item.family === 4) || addresses[0];
  return { hostname, ...selected };
}

module.exports = {
  normalizeNetworkHost,
  isPublicNetworkAddress,
  isTrustedMailHost,
  resolveNetworkHost,
  resolveMailConnectionTarget,
  networkPolicyError,
};
