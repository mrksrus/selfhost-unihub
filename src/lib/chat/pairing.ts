// A new chat device joins without the server learning the passphrase or the
// key: it proves that it holds the history key by opening a value the server
// sealed to it, or it asks a joined device of the same person, which hands
// the key over sealed to a one-time key of the asking device. Both devices
// show a code made from that one-time key, and the person compares them.
import type { ChatAccount, ChatApproval } from '../../../api/src/contracts/chat';
import { chatApi } from '@/lib/chat-api';
import { fromBase64Url, toBase64Url } from './bytes';
import { historyKeyOf } from './key-backup';
import { createSealKey, open, seal, type SealKey } from './seal';
import type { ChatStore } from './store';

// Only the one-time key's public half travels, so its auth secret is fixed, as the history key's is.
const AUTH = new Uint8Array(16);

/** The six digits both devices show for a one-time key. */
export async function pairingCode(publicKey: Uint8Array<ArrayBuffer>) {
  return String(new DataView(await crypto.subtle.digest('SHA-256', publicKey)).getUint32(0) % 1_000_000).padStart(6, '0');
}

/** Proves that this device holds the history key; answers the device as the server has it now. */
export async function prove(key: SealKey) {
  const { sealed } = await chatApi.challenge();
  return chatApi.prove(toBase64Url(await open(key, fromBase64Url(sealed))));
}

/** Asks the person's joined devices for an approval with a new one-time key, kept in the store until the answer. */
export async function askApproval(store: ChatStore) {
  const key = await createSealKey(false, AUTH);
  await store.write([], transaction => { transaction.objectStore('keys').put(key, 'pairing'); });
  return chatApi.askApproval(toBase64Url(key.publicKey));
}

/** The history key an approval handed over; throws for one sealed to another one-time key or of another history key. */
export async function openApproval(store: ChatStore, account: ChatAccount, sealed: string) {
  const pairing = await store.get<SealKey>('keys', 'pairing');
  if (!pairing) throw new Error('This device asked for no approval.');
  const jwk = JSON.parse(new TextDecoder().decode(await open(pairing, fromBase64Url(sealed)))) as JsonWebKey;
  return historyKeyOf(account, await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']));
}

/** Hands the history key to a waiting device of the same person, sealed to the one-time key its code was made from. */
export async function approve(key: SealKey, approval: ChatApproval) {
  const jwk = await crypto.subtle.exportKey('jwk', key.privateKey);
  const sealed = await seal({ publicKey: fromBase64Url(approval.public_key), auth: AUTH }, new TextEncoder().encode(JSON.stringify(jwk)));
  await chatApi.approve(approval.chat_device_id, approval.public_key, toBase64Url(sealed));
}
