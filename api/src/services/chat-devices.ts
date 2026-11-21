import type { ServerResponse } from 'node:http';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { AuthRequest, RouteRequest, SqlExecutor } from '../types';
import type { RouteSpec, RouteTable } from '../http/route';
import type {
  ChatAccount, ChatApproval, ChatChallengeResponse, ChatClaimedKeyPackage, ChatDevice, ChatDeviceResponse, ChatDeviceSignedInDetails, ChatKeyBackup, ChatPreviewKey,
} from '../contracts/chat';

import crypto from 'node:crypto';
import { db } from '../state';
import { JWT_SECRET } from '../config';
import { getAuthTokenFromRequest } from '../auth';
import { badRequest, conflict, forbidden, notFound } from '../http/errors';
import { withTransaction } from './transactions';
import { currentDevice, signedInDeviceNames } from './devices';
import { liveSession } from './sessions';
import { assertCan, conversationPeople } from './access';
import { normalizeKeys } from './notification-rules';
import { recordAudit } from './audit';
import { publishChatDevice } from './realtime';

// Chat accounts, chat devices and key packages (F5, F14). A chat device is
// one F5 device of the person that enrolled for chat; it is keyed by the
// device record, never by a session. The server holds only public keys,
// opaque MLS key packages and the passphrase-wrapped history key, and its
// list of a person's valid chat devices is trusted (every client runs the
// server's code). A chat device is removed by setting device_id NULL: its
// device record went (the foreign key does it), it signed out or it
// enrolled again; the row stays while a current group names it.
//
// A chat device waits from its enrolment until it joins (approved_at): only
// joined devices are valid, and a waiting one is refused the chat routes
// (joinedOnly). It joins by the first passphrase or a new key on it, by
// opening a challenge sealed to the history key, or by an approval from a
// joined device of the person, which hands the history key over sealed to
// the waiting device's one-time key (pair_*). So a person can be written to
// once they have set Chat up.

const MAX_KEY_PACKAGES = 100;
const PROOF_MS = 5 * 60 * 1000;
const APPROVAL_MINUTES = 10;
// Archive copies and challenges are sealed to the history key with a fixed auth secret.
const HISTORY_AUTH = Buffer.alloc(16).toString('base64url');

// Base64url text of a length in bytes; anything else is refused with `code`.
function bytes(value: unknown, min: number, max: number, code: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) throw badRequest(code, 'Invalid chat data');
  const length = Math.floor(value.length * 3 / 4);
  if (length < min || length > max) throw badRequest(code, 'Invalid chat data');
  return value;
}
const object = (value: unknown) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
const utcIso = (value: unknown) => (value instanceof Date ? value : new Date(`${String(value).replace(' ', 'T')}Z`)).toISOString();

// --- The history key and its backup ---------------------------------------------------

/** The history public key and its passphrase-wrapped private half, as a device sends them. */
function parseAccount(input: unknown): { history_public: string; key_backup: ChatKeyBackup } {
  const body = object(input);
  const historyPublic = bytes(body.history_public, 65, 65, 'CHAT_ACCOUNT_INVALID');
  if (Buffer.from(historyPublic, 'base64url')[0] !== 4) throw badRequest('CHAT_ACCOUNT_INVALID', 'Invalid chat data');
  const backup = object(body.key_backup);
  if (backup.format !== 1 || !Number.isSafeInteger(backup.rounds) || Number(backup.rounds) < 600000 || Number(backup.rounds) > 10000000) {
    throw badRequest('CHAT_ACCOUNT_INVALID', 'Invalid chat data');
  }
  return { history_public: historyPublic, key_backup: {
    format: 1, salt: bytes(backup.salt, 16, 64, 'CHAT_ACCOUNT_INVALID'), rounds: Number(backup.rounds), wrapped: bytes(backup.wrapped, 16, 1024, 'CHAT_ACCOUNT_INVALID'),
  } };
}

/** The signed-in person's own account; null before they chose a passphrase. */
async function getAccount(userId: string, executor: SqlExecutor = db): Promise<ChatAccount | null> {
  const [[row]] = await executor.execute<RowDataPacket[]>(`SELECT history_public, key_backup, backup_salt, backup_rounds, backup_format, updated_at
    FROM chat_accounts WHERE user_id = ?`, [userId]);
  return row ? {
    history_public: String(row.history_public),
    key_backup: { format: Number(row.backup_format) as 1, salt: String(row.backup_salt), rounds: Number(row.backup_rounds), wrapped: String(row.key_backup) },
    updated_at: utcIso(row.updated_at),
  } : null;
}

const accountValues = (userId: string, { history_public, key_backup }: ReturnType<typeof parseAccount>) =>
  [userId, history_public, key_backup.wrapped, key_backup.salt, key_backup.rounds, key_backup.format];

/** The first passphrase, which joins the request's device: 409 CHAT_ACCOUNT_EXISTS when the person has an account. */
async function createAccount(userId: string, token: string | null, input: ReturnType<typeof parseAccount>): Promise<ChatAccount> {
  const joined = await withTransaction(async cx => {
    try {
      await cx.execute(`INSERT INTO chat_accounts (user_id, history_public, key_backup, backup_salt, backup_rounds, backup_format)
        VALUES (?, ?, ?, ?, ?, ?)`, accountValues(userId, input));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ER_DUP_ENTRY') throw conflict('CHAT_ACCOUNT_EXISTS', 'You already chose a chat passphrase');
      throw error;
    }
    return joinOwnDevice(userId, token, cx);
  });
  if (joined) publishChatDevice(userId, joined);
  return (await getAccount(userId))!;
}

/** A new passphrase for the same key, after the route confirmed the account password. */
async function replaceKeyBackup(userId: string, input: ReturnType<typeof parseAccount>): Promise<ChatAccount> {
  const [result] = await db.execute<ResultSetHeader>(`UPDATE chat_accounts SET key_backup = ?, backup_salt = ?, backup_rounds = ?, backup_format = ?, updated_at = UTC_TIMESTAMP()
    WHERE user_id = ? AND history_public = ?`, [input.key_backup.wrapped, input.key_backup.salt, input.key_backup.rounds, input.key_backup.format, userId, input.history_public]);
  if (!result.affectedRows) {
    if (await getAccount(userId)) throw conflict('CHAT_KEY_CHANGED', 'A new chat key was started on another device. Open Chat again.');
    throw notFound('CHAT_ACCOUNT_NOT_FOUND', 'Choose a chat passphrase first');
  }
  return (await getAccount(userId))!;
}

/**
 * A new history key and passphrase, after the route confirmed the account
 * password; it joins the request's device. The person's archive copies were
 * sealed to the old key, which no device holds any more, so they go with it.
 * Refused while another joined device of the person is signed in: otherwise
 * the account password alone would join every chat.
 */
async function startNewKey(userId: string, token: string | null, input: ReturnType<typeof parseAccount>, req: AuthRequest): Promise<ChatAccount> {
  const joined = await withTransaction(async cx => {
    const { deviceId } = await currentDevice(userId, token, cx);
    const [joined] = await cx.execute<RowDataPacket[]>('SELECT device_id FROM chat_devices WHERE user_id = ? AND approved_at IS NOT NULL AND device_id <> ?', [userId, deviceId]);
    const others = await signedInDeviceNames(userId, joined.map(row => String(row.device_id)), cx);
    if (others.length) {
      throw conflict('CHAT_DEVICE_SIGNED_IN', 'Another of your devices is still in Chat. Enter your passphrase there or approve this device from it, or sign it out first.',
        { devices: others } satisfies ChatDeviceSignedInDetails);
    }
    await cx.execute(`INSERT INTO chat_accounts (user_id, history_public, key_backup, backup_salt, backup_rounds, backup_format) VALUES (?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE history_public = VALUES(history_public), key_backup = VALUES(key_backup), backup_salt = VALUES(backup_salt),
        backup_rounds = VALUES(backup_rounds), backup_format = VALUES(backup_format), updated_at = UTC_TIMESTAMP()`, accountValues(userId, input));
    await cx.execute('DELETE FROM chat_archive WHERE user_id = ?', [userId]);
    await recordAudit({ action: 'chat.new_key', actorId: userId, targetUserId: userId, req }, cx);
    return joinOwnDevice(userId, token, cx);
  });
  if (joined) publishChatDevice(userId, joined);
  return (await getAccount(userId))!;
}

// --- Chat devices and their key packages ------------------------------------------------

function parseKeyPackages(value: unknown, min: number): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > MAX_KEY_PACKAGES) throw badRequest('CHAT_KEY_PACKAGES_INVALID', `Send ${min} to ${MAX_KEY_PACKAGES} key packages`);
  return value.map(item => bytes(item, 32, 1024, 'CHAT_KEY_PACKAGES_INVALID'));
}

/** The chat device of the request's device, or null when it is not enrolled. */
async function ownChatDevice(userId: string, token: string | null, executor: SqlExecutor = db): Promise<string | null> {
  const { deviceId } = await currentDevice(userId, token, executor);
  const [[row]] = await executor.execute<RowDataPacket[]>('SELECT id FROM chat_devices WHERE device_id = ? AND user_id = ?', [deviceId, userId]);
  return row ? String(row.id) : null;
}
const notEnrolled = () => notFound('CHAT_DEVICE_NOT_ENROLLED', 'This device is not enrolled for chat');
// An approval request that is still open, of a device that is still signed in.
const OPEN_REQUEST = `cd.approved_at IS NULL AND cd.device_id IS NOT NULL AND cd.pair_public IS NOT NULL
  AND cd.pair_requested_at > UTC_TIMESTAMP() - INTERVAL ${APPROVAL_MINUTES} MINUTE
  AND EXISTS (SELECT 1 FROM sessions s WHERE s.device_id = cd.device_id AND s.user_id = cd.user_id AND s.expires_at > UTC_TIMESTAMP())`;
// A chat device's removal: it leaves its device record and any request it made or answer it was handed.
const REMOVED = 'device_id = NULL, pair_public = NULL, pair_sealed = NULL, pair_requested_at = NULL';

async function deviceAnswer(chatDeviceId: string, executor: SqlExecutor = db): Promise<ChatDeviceResponse> {
  const [[row]] = await executor.execute<RowDataPacket[]>(`SELECT cd.approved_at, IF(${OPEN_REQUEST}, cd.pair_requested_at, NULL) AS requested_at,
      (SELECT COUNT(*) FROM chat_key_packages k WHERE k.chat_device_id = cd.id AND k.last_resort = FALSE) AS n
    FROM chat_devices cd WHERE cd.id = ?`, [chatDeviceId]);
  return { chat_device_id: chatDeviceId, key_packages: Number(row.n), state: row.approved_at ? 'joined' : 'waiting',
    approval_requested_at: row.requested_at ? utcIso(row.requested_at) : null, sealed_key: null };
}

/** Joins the request's chat device, ending any request it made; returns its id when it was waiting. */
async function joinOwnDevice(userId: string, token: string | null, cx: SqlExecutor): Promise<string | null> {
  const id = await ownChatDevice(userId, token, cx);
  if (!id) return null;
  const [result] = await cx.execute<ResultSetHeader>(`UPDATE chat_devices SET approved_at = UTC_TIMESTAMP(), pair_public = NULL, pair_sealed = NULL, pair_requested_at = NULL
    WHERE id = ? AND approved_at IS NULL`, [id]);
  return result.affectedRows ? id : null;
}

/** Whether the request's device has a joined chat device; every other chat route is refused it. */
async function chatDeviceJoined(userId: string, token: string | null, executor: SqlExecutor = db): Promise<boolean> {
  const session = await liveSession(userId, token, executor);
  if (!session?.device_id) return false;
  const [[row]] = await executor.execute<RowDataPacket[]>('SELECT 1 AS joined FROM chat_devices WHERE device_id = ? AND user_id = ? AND approved_at IS NOT NULL',
    [session.device_id, userId]);
  return !!row;
}

/**
 * The guard of the chat routes of a route file: a device that has not joined
 * gets 403 CHAT_DEVICE_WAITING on every /api/chat/ route but the `open` ones,
 * which it needs to join.
 */
function joinedOnly<T extends RouteTable>(table: T, open: readonly (keyof T & string)[] = []): T {
  for (const [key, spec] of Object.entries(table)) {
    if (!key.includes(' /api/chat/') || open.includes(key)) continue;
    const { handler } = spec;
    (table as RouteTable)[key] = { ...spec, handler: async (req: RouteRequest, userId: string | null, body: unknown, res: ServerResponse) => {
      if (!await chatDeviceJoined(String(userId), getAuthTokenFromRequest(req))) {
        throw forbidden('CHAT_DEVICE_WAITING', 'Chat opens on this device after your chat passphrase or an approval from another of your devices.');
      }
      return handler(req, userId as string, body, res);
    } } as RouteSpec;
  }
  return table;
}

async function insertKeyPackages(cx: SqlExecutor, chatDeviceId: string, packages: readonly string[], lastResort: boolean) {
  if (!packages.length) return;
  await cx.execute(`INSERT INTO chat_key_packages (chat_device_id, key_package, last_resort) VALUES ${packages.map(() => '(?, ?, ?)').join(', ')}`,
    packages.flatMap(item => [chatDeviceId, item, lastResort]));
}

/**
 * Enrols the request's device for chat with its preview key and key
 * packages. A chat device it enrolled before lost its keys (its store was
 * wiped or could not be read), so it is removed: every group naming it is
 * out of date from now on.
 */
async function enrolDevice(userId: string, token: string | null, input: unknown): Promise<ChatDeviceResponse> {
  const body = object(input);
  const preview: ChatPreviewKey | null = body.preview === null ? null : normalizeKeys(object(body.preview) as { p256dh?: unknown; auth?: unknown });
  const packages = parseKeyPackages(body.key_packages, 1);
  const lastResort = bytes(body.last_resort, 32, 1024, 'CHAT_KEY_PACKAGES_INVALID');
  return withTransaction(async cx => {
    const { deviceId } = await currentDevice(userId, token, cx);
    await cx.execute(`UPDATE chat_devices SET ${REMOVED} WHERE device_id = ? AND user_id = ?`, [deviceId, userId]);
    const id = crypto.randomUUID();
    await cx.execute('INSERT INTO chat_devices (id, user_id, device_id, preview_p256dh, preview_auth) VALUES (?, ?, ?, ?, ?)',
      [id, userId, deviceId, preview?.p256dh ?? null, preview?.auth ?? null]);
    await insertKeyPackages(cx, id, packages, false);
    await insertKeyPackages(cx, id, [lastResort], true);
    return deviceAnswer(id, cx);
  });
}

/** The request's chat device with its unclaimed key packages and the sealed history key of an approval, which is handed out once; 404 CHAT_DEVICE_NOT_ENROLLED. */
async function describeChatDevice(userId: string, token: string | null): Promise<ChatDeviceResponse> {
  return withTransaction(async cx => {
    const id = await ownChatDevice(userId, token, cx);
    if (!id) throw notEnrolled();
    const [[row]] = await cx.execute<RowDataPacket[]>('SELECT pair_sealed FROM chat_devices WHERE id = ? FOR UPDATE', [id]);
    if (row.pair_sealed) await cx.execute('UPDATE chat_devices SET pair_public = NULL, pair_sealed = NULL, pair_requested_at = NULL WHERE id = ?', [id]);
    return { ...await deviceAnswer(id, cx), sealed_key: row.pair_sealed ? String(row.pair_sealed) : null };
  });
}

// --- Joining: the proof of the history key, and approvals ---------------------------------

let proofKey: Buffer | null = null;
// The value a challenge seals: when it was made, and a keyed hash binding that
// time to this chat device and the current history key; nothing is stored.
function proofValue(chatDeviceId: string, historyPublic: string, issued: bigint) {
  proofKey ??= Buffer.from(crypto.hkdfSync('sha256', String(JWT_SECRET), Buffer.alloc(0), 'unihub chat device proof v1', 32));
  const time = Buffer.alloc(8);
  time.writeBigUInt64BE(issued);
  return Buffer.concat([time, crypto.createHmac('sha256', proofKey).update(`${chatDeviceId}\n${historyPublic}\n`).update(time).digest()]);
}

/** POST /api/chat/devices/current/challenge: a value only a holder of the history key can open. */
async function deviceChallenge(userId: string, token: string | null): Promise<ChatChallengeResponse> {
  const id = await ownChatDevice(userId, token);
  if (!id) throw notEnrolled();
  const account = await getAccount(userId);
  if (!account) throw notFound('CHAT_ACCOUNT_NOT_FOUND', 'Choose a chat passphrase first');
  const webPush = require('web-push') as typeof import('web-push');
  const { cipherText } = webPush.encrypt(account.history_public, HISTORY_AUTH, proofValue(id, account.history_public, BigInt(Date.now())), 'aes128gcm');
  return { sealed: Buffer.from(cipherText).toString('base64url') };
}

/** POST /api/chat/devices/current/proof: the opened challenge joins the device. */
async function proveDevice(userId: string, token: string | null, input: unknown): Promise<ChatDeviceResponse> {
  const value = Buffer.from(bytes(object(input).value, 40, 40, 'CHAT_PROOF_INVALID'), 'base64url');
  const { answer, joined } = await withTransaction(async cx => {
    const id = await ownChatDevice(userId, token, cx);
    if (!id) throw notEnrolled();
    const account = await getAccount(userId, cx);
    const issued = value.readBigUInt64BE(0);
    const age = Date.now() - Number(issued);
    if (!account || age < 0 || age > PROOF_MS || !crypto.timingSafeEqual(value, proofValue(id, account.history_public, issued))) {
      throw forbidden('CHAT_PROOF_INVALID', 'This device could not prove that it holds your chat key. Open Chat again.');
    }
    return { joined: await joinOwnDevice(userId, token, cx), answer: await deviceAnswer(id, cx) };
  });
  if (joined) publishChatDevice(userId, joined);
  return answer;
}

/** POST /api/chat/devices/current/approval: a waiting device asks the person's joined devices, with its one-time public key. */
async function askApproval(userId: string, token: string | null, input: unknown): Promise<ChatDeviceResponse> {
  const publicKey = bytes(object(input).public_key, 65, 65, 'CHAT_APPROVAL_INVALID');
  if (Buffer.from(publicKey, 'base64url')[0] !== 4) throw badRequest('CHAT_APPROVAL_INVALID', 'Invalid chat data');
  const id = await ownChatDevice(userId, token);
  if (!id) throw notEnrolled();
  const [asked] = await db.execute<ResultSetHeader>(`UPDATE chat_devices SET pair_public = ?, pair_sealed = NULL, pair_requested_at = UTC_TIMESTAMP()
    WHERE id = ? AND approved_at IS NULL`, [publicKey, id]);
  if (asked.affectedRows) {
    publishChatDevice(userId, id);
    const notifications = require('./notifications') as typeof import('./notifications');
    await notifications.enqueueChatDeviceApproval(userId, id);
    void notifications.processNotificationJobs().catch(() => { /* the next pass sends it */ });
  }
  return deviceAnswer(id);
}

/** GET /api/chat/devices/approvals: the person's open requests, the latest first. */
async function listApprovals(userId: string): Promise<ChatApproval[]> {
  const [rows] = await db.execute<RowDataPacket[]>(`SELECT cd.id, cd.device_id, cd.pair_public, cd.pair_requested_at FROM chat_devices cd WHERE cd.user_id = ? AND ${OPEN_REQUEST}
    ORDER BY cd.pair_requested_at DESC, cd.id`, [userId]);
  const names = new Map((await signedInDeviceNames(userId, rows.map(row => String(row.device_id)))).map(device => [device.id, device]));
  return rows.filter(row => names.has(String(row.device_id))).map(row => ({ chat_device_id: String(row.id), device: names.get(String(row.device_id))!,
    public_key: String(row.pair_public), requested_at: utcIso(row.pair_requested_at) }));
}

/** Whether a chat device of the person has a request open for this key (any key without one). */
async function openRequest(userId: string, chatDeviceId: string, publicKey: string | null, cx: SqlExecutor) {
  const [[row]] = await cx.execute<RowDataPacket[]>(`SELECT cd.id FROM chat_devices cd WHERE cd.id = ? AND cd.user_id = ? AND ${OPEN_REQUEST}
    AND (? IS NULL OR cd.pair_public = ?) FOR UPDATE`, [chatDeviceId, userId, publicKey, publicKey]);
  if (!row) throw notFound('CHAT_APPROVAL_NOT_FOUND', 'This request is no longer open. Ask again on the new device.');
}

/** POST /api/chat/devices/:id/approve: a joined device of the person hands over the sealed history key; the waiting device joins. */
async function approveDevice(userId: string, chatDeviceId: string, input: unknown) {
  const body = object(input);
  const publicKey = bytes(body.public_key, 65, 65, 'CHAT_APPROVAL_INVALID');
  const sealed = bytes(body.sealed_key, 32, 1500, 'CHAT_APPROVAL_INVALID');
  await withTransaction(async cx => {
    await openRequest(userId, chatDeviceId, publicKey, cx);
    await cx.execute('UPDATE chat_devices SET approved_at = UTC_TIMESTAMP(), pair_sealed = ?, pair_requested_at = NULL WHERE id = ?', [sealed, chatDeviceId]);
  });
  publishChatDevice(userId, chatDeviceId);
  return { approved: true as const };
}

/** DELETE /api/chat/devices/:id/approval: "This was not me"; the device keeps waiting. */
async function dropApproval(userId: string, chatDeviceId: string) {
  await withTransaction(async cx => {
    await openRequest(userId, chatDeviceId, null, cx);
    await cx.execute('UPDATE chat_devices SET pair_public = NULL, pair_requested_at = NULL WHERE id = ?', [chatDeviceId]);
  });
  publishChatDevice(userId, chatDeviceId);
  return { dropped: true as const };
}

/** More key packages, and a new last resort that replaces the old one; at most 100 unclaimed are kept. */
async function addKeyPackages(userId: string, token: string | null, input: unknown): Promise<ChatDeviceResponse> {
  const body = object(input);
  const lastResort = body.last_resort === undefined ? null : bytes(body.last_resort, 32, 1024, 'CHAT_KEY_PACKAGES_INVALID');
  const packages = parseKeyPackages(body.key_packages, lastResort ? 0 : 1);
  return withTransaction(async cx => {
    const id = await ownChatDevice(userId, token, cx);
    if (!id) throw notEnrolled();
    // The device's row is the lock: two tabs topping up at once count one after the other.
    await cx.execute('SELECT id FROM chat_devices WHERE id = ? FOR UPDATE', [id]);
    if ((await deviceAnswer(id, cx)).key_packages + packages.length > MAX_KEY_PACKAGES) {
      throw badRequest('CHAT_KEY_PACKAGES_LIMIT', `A device keeps at most ${MAX_KEY_PACKAGES} key packages`);
    }
    await insertKeyPackages(cx, id, packages, false);
    if (lastResort) {
      await cx.execute('DELETE FROM chat_key_packages WHERE chat_device_id = ? AND last_resort = TRUE', [id]);
      await insertKeyPackages(cx, id, [lastResort], true);
    }
    return deviceAnswer(id, cx);
  });
}

// --- Devices of a conversation's people -------------------------------------------------

/**
 * The valid chat devices of these people: enrolled and joined, with their
 * device record still there, of an active person. An Android device's previews are sealed
 * to its push channel's key.
 */
async function validDevices(userIds: readonly string[], executor: SqlExecutor = db): Promise<ChatDevice[]> {
  if (!userIds.length) return [];
  const push = (column: string) => `(SELECT p.${column} FROM push_subscriptions p WHERE p.device_id = cd.device_id AND p.user_id = cd.user_id AND p.transport = 'android'
    ORDER BY p.updated_at DESC, p.id LIMIT 1)`;
  const [rows] = await executor.execute<RowDataPacket[]>(`SELECT cd.id, cd.user_id, cd.created_at,
      COALESCE(cd.preview_p256dh, ${push('p256dh')}) AS p256dh, COALESCE(cd.preview_auth, ${push('auth')}) AS auth
    FROM chat_devices cd JOIN users u ON u.id = cd.user_id AND u.is_active = TRUE
    WHERE cd.device_id IS NOT NULL AND cd.approved_at IS NOT NULL AND cd.user_id IN (${userIds.map(() => '?').join(', ')})
    ORDER BY cd.user_id, cd.created_at, cd.id`, [...userIds]);
  return rows.map(row => ({
    chat_device_id: String(row.id), user_id: String(row.user_id),
    preview: row.p256dh && row.auth ? { p256dh: String(row.p256dh), auth: String(row.auth) } : null,
    created_at: utcIso(row.created_at),
  }));
}

/** The valid chat devices of the people a conversation reaches; 404 for anyone not in it. */
async function conversationDevices(userId: string, conversationId: string): Promise<ChatDevice[]> {
  await assertCan(userId, { kind: 'conversation', id: conversationId }, 'member');
  return validDevices(await conversationPeople(conversationId));
}

/**
 * One key package of every valid device of the conversation's people but
 * the caller's own, for a new group. Each package is handed out once
 * (DELETE ... RETURNING); a device with none left gets its last resort,
 * which stays.
 */
async function claimKeyPackages(userId: string, token: string | null, conversationId: string): Promise<ChatClaimedKeyPackage[]> {
  await assertCan(userId, { kind: 'conversation', id: conversationId }, 'member');
  const own = await ownChatDevice(userId, token);
  if (!own) throw notEnrolled();
  const claimed: ChatClaimedKeyPackage[] = [];
  for (const device of (await validDevices(await conversationPeople(conversationId))).filter(item => item.chat_device_id !== own)) {
    const [[taken]] = await db.query<RowDataPacket[]>(`DELETE FROM chat_key_packages WHERE chat_device_id = ? AND last_resort = FALSE
      ORDER BY id LIMIT 1 RETURNING key_package`, [device.chat_device_id]);
    let row = taken;
    if (!row) [[row]] = await db.execute<RowDataPacket[]>(`SELECT key_package FROM chat_key_packages
      WHERE chat_device_id = ? AND last_resort = TRUE ORDER BY id DESC LIMIT 1`, [device.chat_device_id]);
    if (row) claimed.push({ chat_device_id: device.chat_device_id, user_id: device.user_id, key_package: String(row.key_package), last_resort: !taken });
  }
  return claimed;
}

// --- Sign-out and clean-up --------------------------------------------------------------

/** Sign-out removes the chat device of the session's device; a session that only expires keeps it. */
async function removeChatDeviceOfSession(userId: string, token: string | null) {
  const session = await liveSession(userId, token);
  if (session?.device_id) await db.execute(`UPDATE chat_devices SET ${REMOVED} WHERE device_id = ? AND user_id = ?`, [session.device_id, userId]);
}

/** Deletes removed chat devices that no conversation's current group names; returns how many. */
async function pruneRemovedChatDevices(executor: SqlExecutor = db): Promise<number> {
  // A device record deleted (the foreign key set device_id NULL) leaves its pairing columns behind.
  await executor.execute(`UPDATE chat_devices SET ${REMOVED} WHERE device_id IS NULL AND (pair_public IS NOT NULL OR pair_sealed IS NOT NULL)`);
  const [result] = await executor.execute<ResultSetHeader>(`DELETE FROM chat_devices WHERE device_id IS NULL AND NOT EXISTS (
    SELECT 1 FROM chat_group_devices gd JOIN chat_conversations c ON c.current_group_id = gd.group_id WHERE gd.chat_device_id = chat_devices.id)`);
  return result.affectedRows;
}

export {
  bytes, object, utcIso, ownChatDevice, notEnrolled, chatDeviceJoined, joinedOnly,
  parseAccount, getAccount, createAccount, replaceKeyBackup, startNewKey,
  enrolDevice, describeChatDevice, addKeyPackages, validDevices, conversationDevices, claimKeyPackages,
  deviceChallenge, proveDevice, askApproval, listApprovals, approveDevice, dropApproval,
  removeChatDeviceOfSession, pruneRemovedChatDevices,
};
