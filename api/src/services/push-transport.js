const dns = require('node:dns');
const https = require('node:https');
const net = require('node:net');

function isPublicAddress(address) {
  if (net.isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  // Public global-unicast only; exclude documentation addresses and transition ranges.
  if (net.isIP(address) === 6) return /^[23]/i.test(address) && !/^2001:(0*:|db8:|10:|20:)|^2002:/i.test(address);
  return false;
}
function safePushLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) return callback(new Error('Push service resolved to a non-public address'));
    if (options?.all) return callback(null, addresses);
    const candidate = addresses.find(item => !options?.family || item.family === options.family) || addresses[0];
    callback(null, candidate.address, candidate.family);
  });
}
const pushAgent = new https.Agent({ lookup: safePushLookup });
module.exports = { pushAgent, isPublicAddress, safePushLookup };
