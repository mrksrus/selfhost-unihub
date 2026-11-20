import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor } from '../types';
import type { ChatAccount, ChatClaimedKeyPackage, ChatDevice, ChatDeviceResponse, ChatKeyBackup, ChatPreviewKey } from '../contracts/chat';

import crypto from 'node:crypto';
import { db } from '../state';
import { badRequest, conflict, notFound } from '../http/errors';
import { withTransaction } from './transactions';
import { currentDevice } from './devices';
import { liveSession } from './sessions';
import { assertCan, conversationPeople } from './access';
import { normalizeKeys } from './notification-rules';

// Chat accounts, chat devices and key packages (F5, F14). A chat device is
// one F5 device of the person that enrolled for chat; it is keyed by the
// device record, never by a session. The server holds only public keys,
// opaque MLS key packages and the passphrase-wrapped history key, and its
// list of a person's valid chat devices is trusted (every client runs the
// server's code). A chat device is removed by setting device_id NULL: its
// device record went (the foreign key does it), it signed out or it
// enrolled again; the row stays while a current group names it.

const MAX_KEY_PACKAGES = 100;

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

/** The first passphrase: 409 CHAT_ACCOUNT_EXISTS when the person has an account. */
async function createAccount(userId: string, input: ReturnType<typeof parseAccount>): Promise<ChatAccount> {
  try {
    await db.execute(`INSERT INTO chat_accounts (user_id, history_public, key_backup, backup_salt, backup_rounds, backup_format)
      VALUES (?, ?, ?, ?, ?, ?)`, accountValues(userId, input));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ER_DUP_ENTRY') throw conflict('CHAT_ACCOUNT_EXISTS', 'You already chose a chat passphrase');
    throw error;
  }
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
 * password. The person's archive copies were sealed to the old key, which no
 * device holds any more, so they go with it.
 */
async function startNewKey(userId: string, input: ReturnType<typeof parseAccount>): Promise<ChatAccount> {
  await withTransaction(async cx => {
    await cx.execute(`INSERT INTO chat_accounts (user_id, history_public, key_backup, backup_salt, backup_rounds, backup_format) VALUES (?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE history_public = VALUES(history_public), key_backup = VALUES(key_backup), backup_salt = VALUES(backup_salt),
        backup_rounds = VALUES(backup_rounds), backup_format = VALUES(backup_format), updated_at = UTC_TIMESTAMP()`, accountValues(userId, input));
    await cx.execute('DELETE FROM chat_archive WHERE user_id = ?', [userId]);
  });
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

async function deviceAnswer(chatDeviceId: string, executor: SqlExecutor = db): Promise<ChatDeviceResponse> {
  const [[row]] = await executor.execute<RowDataPacket[]>('SELECT COUNT(*) AS n FROM chat_key_packages WHERE chat_device_id = ? AND last_resort = FALSE', [chatDeviceId]);
  return { chat_device_id: chatDeviceId, key_packages: Number(row.n) };
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
    await cx.execute('UPDATE chat_devices SET device_id = NULL WHERE device_id = ? AND user_id = ?', [deviceId, userId]);
    const id = crypto.randomUUID();
    await cx.execute('INSERT INTO chat_devices (id, user_id, device_id, preview_p256dh, preview_auth) VALUES (?, ?, ?, ?, ?)',
      [id, userId, deviceId, preview?.p256dh ?? null, preview?.auth ?? null]);
    await insertKeyPackages(cx, id, packages, false);
    await insertKeyPackages(cx, id, [lastResort], true);
    return deviceAnswer(id, cx);
  });
}

/** The request's chat device with its unclaimed key packages; 404 CHAT_DEVICE_NOT_ENROLLED. */
async function describeChatDevice(userId: string, token: string | null): Promise<ChatDeviceResponse> {
  const id = await ownChatDevice(userId, token);
  if (!id) throw notEnrolled();
  return deviceAnswer(id);
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
 * The valid chat devices of these people: enrolled, with their device record
 * still there, of an active person. An Android device's previews are sealed
 * to its push channel's key.
 */
async function validDevices(userIds: readonly string[], executor: SqlExecutor = db): Promise<ChatDevice[]> {
  if (!userIds.length) return [];
  const push = (column: string) => `(SELECT p.${column} FROM push_subscriptions p WHERE p.device_id = cd.device_id AND p.user_id = cd.user_id AND p.transport = 'android'
    ORDER BY p.updated_at DESC, p.id LIMIT 1)`;
  const [rows] = await executor.execute<RowDataPacket[]>(`SELECT cd.id, cd.user_id, cd.created_at,
      COALESCE(cd.preview_p256dh, ${push('p256dh')}) AS p256dh, COALESCE(cd.preview_auth, ${push('auth')}) AS auth
    FROM chat_devices cd JOIN users u ON u.id = cd.user_id AND u.is_active = TRUE
    WHERE cd.device_id IS NOT NULL AND cd.user_id IN (${userIds.map(() => '?').join(', ')})
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
  if (session?.device_id) await db.execute('UPDATE chat_devices SET device_id = NULL WHERE device_id = ? AND user_id = ?', [session.device_id, userId]);
}

/** Deletes removed chat devices that no conversation's current group names; returns how many. */
async function pruneRemovedChatDevices(executor: SqlExecutor = db): Promise<number> {
  const [result] = await executor.execute<ResultSetHeader>(`DELETE FROM chat_devices WHERE device_id IS NULL AND NOT EXISTS (
    SELECT 1 FROM chat_group_devices gd JOIN chat_conversations c ON c.current_group_id = gd.group_id WHERE gd.chat_device_id = chat_devices.id)`);
  return result.affectedRows;
}

export {
  parseAccount, getAccount, createAccount, replaceKeyBackup, startNewKey,
  enrolDevice, describeChatDevice, addKeyPackages, validDevices, conversationDevices, claimKeyPackages,
  removeChatDeviceOfSession, pruneRemovedChatDevices,
};
