import type { LookupAddress, LookupOptions } from 'node:dns';
import type { LookupFunction } from 'node:net';
import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';

function isPublicAddress(address: string) {
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
// An error reply carries no address, as with dns.lookup itself; Node's
// LookupFunction type still requires one, hence the cast on the agent below.
type LookupCallback = (error: NodeJS.ErrnoException | null, address?: string | LookupAddress[], family?: number) => void;

function safePushLookup(hostname: string, options: LookupOptions, callback: LookupCallback) {
  dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) return callback(new Error('Push service resolved to a non-public address'));
    if (options?.all) return callback(null, addresses);
    const candidate = addresses.find(item => !options?.family || item.family === options.family) || addresses[0];
    callback(null, candidate.address, candidate.family);
  });
}
const pushAgent = new https.Agent({ lookup: safePushLookup as LookupFunction });
export { pushAgent, isPublicAddress, safePushLookup };
