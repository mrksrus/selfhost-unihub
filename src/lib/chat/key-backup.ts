// The history key and its backup on the server: the private half wrapped with
// AES-GCM under a key from PBKDF2-SHA-256 of the chat passphrase. The
// passphrase never leaves the device.
import type { ChatAccount, ChatKeyBackup } from '../../../api/src/contracts/chat';
import { concat, fromBase64Url, toBase64Url } from './bytes';
import { createSealKey, type SealKey } from './seal';

const ROUNDS = 600_000;
export const MIN_PASSPHRASE_LENGTH = 12;
// Archive copies use a fixed auth secret: the history key's public half is all a sealing device needs.
const HISTORY_AUTH = new Uint8Array(16);

export class WrongPassphraseError extends Error {
  constructor() {
    super('This is not your chat passphrase.');
    this.name = 'WrongPassphraseError';
  }
}

/** A new history key; archive copies are sealed to its public half. */
export const createHistoryKey = () => createSealKey(true, HISTORY_AUTH);

async function passphraseKey(passphrase: string, salt: Uint8Array<ArrayBuffer>, rounds: number, usage: 'wrapKey' | 'unwrapKey') {
  // The same passphrase typed on another keyboard may arrive in another Unicode form.
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: rounds }, material, { name: 'AES-GCM', length: 256 }, false, [usage]);
}

/** The backup of the history key's private half under a passphrase. */
export async function wrapHistoryKey(key: SealKey, passphrase: string): Promise<ChatKeyBackup> {
  if ([...passphrase].length < MIN_PASSPHRASE_LENGTH) throw new Error(`A chat passphrase has at least ${MIN_PASSPHRASE_LENGTH} characters.`);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.wrapKey('jwk', key.privateKey, await passphraseKey(passphrase, salt, ROUNDS, 'wrapKey'), { name: 'AES-GCM', iv });
  return { format: 1, salt: toBase64Url(salt), rounds: ROUNDS, wrapped: toBase64Url(concat(iv, new Uint8Array(wrapped))) };
}

/** The history key of an account; throws WrongPassphraseError for another passphrase. */
export async function unwrapHistoryKey(account: ChatAccount, passphrase: string): Promise<SealKey> {
  const backup = account.key_backup;
  if (backup.format !== 1 || backup.rounds < ROUNDS) throw new Error('This key backup has a format this app does not know.');
  const wrapped = fromBase64Url(backup.wrapped);
  const unwrapping = await passphraseKey(passphrase, fromBase64Url(backup.salt), backup.rounds, 'unwrapKey');
  try {
    const privateKey = await crypto.subtle.unwrapKey('jwk', wrapped.slice(12), unwrapping, { name: 'AES-GCM', iv: wrapped.slice(0, 12) },
      { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    return { privateKey, publicKey: fromBase64Url(account.history_public), auth: HISTORY_AUTH };
  } catch {
    throw new WrongPassphraseError();
  }
}
