// A chat file's encryption: the aes128gcm content coding of RFC 8188 in
// records of 64 kB, with a random 16-byte key per file that travels inside
// the message. Records keep memory bounded, give progress and mark the last
// one, so a file cut off, reordered or missing a record is refused.
import { concat } from './bytes';
import { hkdf } from './seal';

const RECORD_SIZE = 65536;
/** A record's tag and delimiter. */
const OVERHEAD = 17;
const text = (value: string) => new TextEncoder().encode(value);

export class FileDecryptError extends Error {
  constructor() { super('This file could not be decrypted: it is damaged or incomplete.'); }
}

export const newFileKey = () => crypto.getRandomValues(new Uint8Array(16));

async function recordKeys(ikm: Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>) {
  const key = await crypto.subtle.importKey('raw', await hkdf(salt, ikm, text('Content-Encoding: aes128gcm\0'), 16), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const base = await hkdf(salt, ikm, text('Content-Encoding: nonce\0'), 12);
  /** The nonce of record `seq`: the base with seq XORed into its last six bytes. */
  const nonce = (seq: number) => {
    const iv = base.slice();
    for (let i = 0; i < 6; i++) iv[11 - i] ^= Math.floor(seq / 256 ** i) & 0xff;
    return iv;
  };
  return { key, nonce };
}

/** Encrypts a Blob record by record into a Blob; `onProgress` gets the plain bytes done. */
export async function encryptFile(blob: Blob, ikm: Uint8Array<ArrayBuffer>, onProgress?: (done: number) => void): Promise<Blob> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const { key, nonce } = await recordKeys(ikm, salt);
  const header = new Uint8Array(21);
  header.set(salt);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  const parts: BlobPart[] = [header];
  const step = RECORD_SIZE - OVERHEAD;
  for (let seq = 0, start = 0; seq === 0 || start < blob.size; seq++, start += step) {
    const plain = new Uint8Array(await blob.slice(start, start + step).arrayBuffer());
    // Delimiter 1 continues, 2 ends the file.
    const last = start + step >= blob.size;
    parts.push(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce(seq) }, key, concat(plain, Uint8Array.of(last ? 2 : 1))));
    onProgress?.(Math.min(start + step, blob.size));
  }
  return new Blob(parts, { type: 'application/octet-stream' });
}

/** Decrypts an aes128gcm stream into a Blob of `type`; throws FileDecryptError for a wrong key or a changed, reordered or cut-off file. */
export async function decryptFile(stream: ReadableStream<Uint8Array>, ikm: Uint8Array<ArrayBuffer>, type: string, onProgress?: (done: number) => void): Promise<Blob> {
  const reader = stream.getReader();
  const parts: BlobPart[] = [];
  let buffer = new Uint8Array(0);
  let keys: Awaited<ReturnType<typeof recordKeys>> | null = null;
  let size = 0;
  let seq = 0;
  let done = 0;
  let ended = false;
  const record = async (sealed: Uint8Array<ArrayBuffer>) => {
    if (ended || sealed.length <= 16) throw new FileDecryptError();
    const padded = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: keys!.nonce(seq++) }, keys!.key, sealed).catch(() => { throw new FileDecryptError(); }));
    let end = padded.length - 1;
    while (end >= 0 && padded[end] === 0) end--;
    if (padded[end] !== 1 && padded[end] !== 2) throw new FileDecryptError();
    ended = padded[end] === 2;
    parts.push(padded.slice(0, end));
    onProgress?.(done += end);
  };
  for (;;) {
    const { value, done: over } = await reader.read();
    if (value) buffer = concat(buffer, value);
    if (!keys && buffer.length >= 21 && buffer.length >= 21 + buffer[20]) {
      size = new DataView(buffer.buffer).getUint32(16);
      if (size <= OVERHEAD) throw new FileDecryptError();
      keys = await recordKeys(ikm, buffer.slice(0, 16));
      buffer = buffer.slice(21 + buffer[20]);
    }
    // A full record may be the last; only the stream's end tells, so the bytes after it wait.
    while (keys && buffer.length > size) {
      await record(buffer.slice(0, size));
      buffer = buffer.slice(size);
    }
    if (over) break;
  }
  if (!keys) throw new FileDecryptError();
  if (buffer.length) await record(buffer);
  if (!ended) throw new FileDecryptError();
  return new Blob(parts, { type });
}
