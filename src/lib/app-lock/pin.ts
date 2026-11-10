// The UniHub PIN (D7): kept in this browser only, as a PBKDF2 hash. The
// server never sees it and counts no attempts; it only learns that this
// device locks with a PIN. A modified page could skip it, and the docs say so.
//
// Rules: 6 to 12 digits. Five wrong PINs are free; each later one makes the
// next try wait longer (30 s, 60 s, 2 min, 4 min); the tenth signs out.
import type { AppLockPinState } from '@/hooks/use-app-lock';
import { readRecord, updateRecord } from '@/lib/app-lock/db';

export const PIN_PATTERN = /^\d{6,12}$/;
/** OWASP 2023 for PBKDF2-SHA-256. Each record keeps its own count, so a later version can raise it. */
export const PIN_ITERATIONS = 600_000;
export const FREE_ATTEMPTS = 5;
export const SIGN_OUT_AFTER = 10;
const WARN_FROM = 7;
const FIRST_WAIT_MS = 30_000;

export interface PinRecord {
  v: 1;
  userId: string;
  salt: Uint8Array;
  iterations: number;
  hash: Uint8Array;
  /** Wrong PINs since the last unlock; a try counts before it is checked, so closing the tab mid-check does not undo it. */
  failures: number;
  waitUntil: number | null;
  createdAt: number;
}

export type PinCheck =
  | { result: 'ok' }
  | { result: 'wrong'; state: AppLockPinState }
  | { result: 'wait'; state: AppLockPinState }
  /** The last allowed try failed: the record is gone and the caller signs out. */
  | { result: 'sign-out' }
  | { result: 'no-pin' }
  | { result: 'invalid' };

let newPinIterations = PIN_ITERATIONS;
/** Tests derive with fewer rounds; a record's own count is always the one checked. */
export function setPinIterationsForTests(iterations: number) { newPinIterations = iterations; }

/** Whether this browser can keep a PIN, and why not. */
export function pinSupport(): { available: boolean; reason: string | null } {
  if (typeof crypto === 'undefined' || !crypto.subtle) return { available: false, reason: 'This browser cannot keep a UniHub PIN here. Open UniHub over HTTPS.' };
  if (typeof indexedDB === 'undefined') return { available: false, reason: 'This browser cannot keep a UniHub PIN: its site storage is off.' };
  return { available: true, reason: null };
}

/** The wait before the next try after `failures` wrong PINs. */
export function waitAfter(failures: number) {
  return failures > FREE_ATTEMPTS && failures < SIGN_OUT_AFTER ? FIRST_WAIT_MS * 2 ** (failures - FREE_ATTEMPTS - 1) : 0;
}

// A clock set back must not leave a wait that never ends.
function effectiveWait(record: Pick<PinRecord, 'failures' | 'waitUntil'>, now: number) {
  if (!record.waitUntil || record.waitUntil <= now) return null;
  return Math.min(record.waitUntil, now + waitAfter(record.failures));
}

export function pinState(record: Pick<PinRecord, 'failures' | 'waitUntil'> | undefined, now = Date.now()): AppLockPinState {
  if (!record) return { failures: 0, waitUntil: null, attemptsLeft: null };
  return {
    failures: record.failures,
    waitUntil: effectiveWait(record, now),
    attemptsLeft: record.failures >= WARN_FROM ? Math.max(0, SIGN_OUT_AFTER - record.failures) : null,
  };
}

async function derive(pin: string, salt: Uint8Array, iterations: number) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, key, 256));
}

function equal(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a[index] ^ b[index];
  return difference === 0;
}

export async function readPin(userId: string) {
  return readRecord<PinRecord>('pins', userId);
}

/** Sets a new PIN for the person, with fresh counts. The caller checked the current one. */
export async function savePin(userId: string, pin: string) {
  if (!PIN_PATTERN.test(pin)) throw new Error('A PIN has 6 to 12 digits.');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(pin, salt, newPinIterations);
  await updateRecord<PinRecord>('pins', userId, () => ({ v: 1, userId, salt, iterations: newPinIterations, hash, failures: 0, waitUntil: null, createdAt: Date.now() }));
}

export async function deletePin(userId: string) {
  await updateRecord<PinRecord>('pins', userId, () => undefined);
}

/** Checks a PIN and counts the try (see PinRecord.failures). */
export async function checkPin(userId: string, pin: string, now: () => number = Date.now): Promise<PinCheck> {
  if (!PIN_PATTERN.test(pin)) return { result: 'invalid' };
  let refused = null as PinCheck | null;
  const started = now();
  const counted = await updateRecord<PinRecord>('pins', userId, record => {
    if (!record) { refused = { result: 'no-pin' }; return record; }
    if (record.failures >= SIGN_OUT_AFTER) { refused = { result: 'sign-out' }; return undefined; }
    if (effectiveWait(record, started)) { refused = { result: 'wait', state: pinState(record, started) }; return record; }
    const failures = record.failures + 1;
    return { ...record, failures, waitUntil: waitAfter(failures) ? started + waitAfter(failures) : null };
  });
  if (refused) return refused;
  if (!counted) return { result: 'no-pin' };
  const matches = equal(await derive(pin, counted.salt, counted.iterations), counted.hash);
  const finished = now();
  let outcome = { result: 'ok' } as PinCheck;
  await updateRecord<PinRecord>('pins', userId, record => {
    if (!record) { outcome = { result: 'no-pin' }; return record; }
    if (matches) { outcome = { result: 'ok' }; return { ...record, failures: 0, waitUntil: null }; }
    if (record.failures >= SIGN_OUT_AFTER) { outcome = { result: 'sign-out' }; return undefined; }
    // The wait starts when the person sees the answer, not when the check began.
    const next = { ...record, waitUntil: waitAfter(record.failures) ? finished + waitAfter(record.failures) : null };
    outcome = { result: 'wrong', state: pinState(next, finished) };
    return next;
  });
  return outcome;
}
