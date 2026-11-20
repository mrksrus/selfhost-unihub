// Sealing to a P-256 key in the Web Push format (RFC 8291 over the aes128gcm
// encoding of RFC 8188), on WebCrypto. Chat seals notification previews to a
// device's preview key, which the service worker and the Android app already
// open this way, and archive copies to the person's history key.
import { concat } from './bytes';

/** A receiver's public side: its uncompressed P-256 point and 16-byte auth secret. */
export interface SealTo { publicKey: Uint8Array<ArrayBuffer>; auth: Uint8Array<ArrayBuffer> }

/** A receiver's whole key. */
export interface SealKey extends SealTo { privateKey: CryptoKey }

const P256 = { name: 'ECDH', namedCurve: 'P-256' } as const;
const RECORD_SIZE = 4096;
const text = (value: string) => new TextEncoder().encode(value);

/** A new key; a preview key is not extractable, the history key must be (its backup wraps it). */
export async function createSealKey(extractable: boolean, auth = crypto.getRandomValues(new Uint8Array(16))): Promise<SealKey> {
  const pair = await crypto.subtle.generateKey(P256, extractable, ['deriveBits']);
  return { privateKey: pair.privateKey, publicKey: new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)), auth };
}

async function hkdf(salt: Uint8Array<ArrayBuffer>, secret: BufferSource, info: Uint8Array<ArrayBuffer>, length: number) {
  const key = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

/** The content key and nonce (RFC 8291 section 3.4, RFC 8188 section 2.2 and 2.3). */
async function contentKey(shared: ArrayBuffer, to: SealTo, senderPublic: Uint8Array, salt: Uint8Array<ArrayBuffer>) {
  const ikm = await hkdf(to.auth, shared, concat(text('WebPush: info\0'), to.publicKey, senderPublic), 32);
  const key = await crypto.subtle.importKey('raw', await hkdf(salt, ikm, text('Content-Encoding: aes128gcm\0'), 16), 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { key, iv: await hkdf(salt, ikm, text('Content-Encoding: nonce\0'), 12) };
}

/** A given sender key pair's public half and its shared secret with each receiver, kept in memory while the pair lives. */
const agreed = new WeakMap<CryptoKeyPair, { senderPublic: Promise<Uint8Array>; shared: Map<string, Promise<ArrayBuffer>> }>();

async function agree(sender: CryptoKeyPair, to: SealTo) {
  const receiver = await crypto.subtle.importKey('raw', to.publicKey, P256, false, []);
  return crypto.subtle.deriveBits({ name: 'ECDH', public: receiver }, sender.privateKey, 256);
}

/**
 * Seals `plaintext` to a receiver as one aes128gcm record. The sender's key
 * pair is a new one each time unless `from` is given; with `from`, the key
 * agreement with each receiver is done once.
 */
export async function seal(to: SealTo, plaintext: Uint8Array, from?: CryptoKeyPair): Promise<Uint8Array<ArrayBuffer>> {
  const sender = from ?? await crypto.subtle.generateKey(P256, false, ['deriveBits']);
  let kept = agreed.get(sender);
  if (!kept) agreed.set(sender, kept = { senderPublic: crypto.subtle.exportKey('raw', sender.publicKey).then(raw => new Uint8Array(raw)), shared: new Map() });
  const secrets = kept.shared;
  const receiverId = String.fromCharCode(...to.publicKey);
  let shared = secrets.get(receiverId);
  if (!shared) {
    secrets.set(receiverId, shared = agree(sender, to));
    shared.catch(() => secrets.delete(receiverId));
  }
  const senderPublic = await kept.senderPublic;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const { key, iv } = await contentKey(await shared, to, senderPublic, salt);
  // The delimiter 2 ends the last (here the only) record.
  const record = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, concat(plaintext, Uint8Array.of(2))));
  const header = new Uint8Array(21);
  header.set(salt);
  new DataView(header.buffer).setUint32(16, Math.max(RECORD_SIZE, record.length));
  header[20] = senderPublic.length;
  return concat(header, senderPublic, record);
}

/** Opens what `seal` (or any RFC 8291 sender) sealed to this key; throws when it is not for it or was changed. */
export async function open(key: SealKey, sealed: Uint8Array): Promise<Uint8Array> {
  if (sealed.length < 21 + 65 + 17 || sealed[20] !== 65) throw new Error('Not a sealed message.');
  const salt = sealed.slice(0, 16);
  const senderPublic = sealed.slice(21, 86);
  const record = sealed.slice(86);
  if (record.length > new DataView(sealed.buffer, sealed.byteOffset).getUint32(16)) throw new Error('A sealed message has one record.');
  const sender = await crypto.subtle.importKey('raw', senderPublic, P256, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: sender }, key.privateKey, 256);
  const { key: contentKeyValue, iv } = await contentKey(shared, key, senderPublic, salt);
  const padded = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, contentKeyValue, record));
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  if (padded[end] !== 2) throw new Error('A sealed message ends with its delimiter.');
  return padded.slice(0, end);
}
