import type { IncomingMessage } from 'node:http';
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { SqlExecutor, StoredFlag } from '../types';
interface SecondFactorUser extends RowDataPacket { id: string; two_factor_enabled: StoredFlag; encrypted_two_factor_secret?: string | null; two_factor_recovery_codes?: unknown }

import crypto = require('crypto');
import bcrypt = require('bcryptjs');
import imported1 = require('../state');
const { db } = imported1;
import imported2 = require('../security/encryption');
const { encrypt, decrypt } = imported2;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;
const LOGIN_CHALLENGE_MINUTES = 10;
const RECOVERY_CODE_COUNT = 10;

function base32Encode(buffer: Uint8Array) {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

function base32Decode(value: unknown) {
  const normalized = String(value || '').replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let buffer = 0;
  const bytes = [];

  for (const char of normalized) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) return null;
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

function normalizeOtpCode(code: unknown) {
  return String(code || '').replace(/\s+/g, '').trim();
}

function normalizeRecoveryCode(code: unknown) {
  const normalized = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return normalized.length === 10 ? `${normalized.slice(0, 5)}-${normalized.slice(5)}` : normalized;
}

function timingSafeEqualString(left: unknown, right: unknown) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function generateTwoFactorSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function generateTotp(secret: string, timeStep = Math.floor(Date.now() / 1000 / TOTP_PERIOD_SECONDS)) {
  const key = base32Decode(secret);
  if (!key) return null;

  const counter = Buffer.alloc(8);
  counter.writeUInt32BE(Math.floor(timeStep / 0x100000000), 0);
  counter.writeUInt32BE(timeStep >>> 0, 4);

  const hmac = crypto.createHmac('sha1', key).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = (
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  );
  return String(binary % (10 ** TOTP_DIGITS)).padStart(TOTP_DIGITS, '0');
}

function verifyTotp(secret: string, code: unknown, window = 1) {
  const normalizedCode = normalizeOtpCode(code);
  if (!/^\d{6}$/.test(normalizedCode)) return false;

  const currentStep = Math.floor(Date.now() / 1000 / TOTP_PERIOD_SECONDS);
  for (let offset = -window; offset <= window; offset += 1) {
    const expected = generateTotp(secret, currentStep + offset);
    if (expected && timingSafeEqualString(expected, normalizedCode)) return true;
  }
  return false;
}

function getOtpAuthUri({ email, secret, issuer = 'UniHub' }: { email: string; secret: string; issuer?: string }) {
  const label = encodeURIComponent(`${issuer}:${email}`);
  const issuerParam = encodeURIComponent(issuer);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${issuerParam}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SECONDS}`;
}

function generateRecoveryCodes() {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase();
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

async function hashRecoveryCodes(codes: readonly string[]) {
  return Promise.all(codes.map((code) => bcrypt.hash(normalizeRecoveryCode(code), 12)));
}

function parseRecoveryHashes(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  try {
    const parsed = JSON.parse(value as string);
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

async function verifyRecoveryCode(code: unknown, recoveryHashes: readonly string[] | null | undefined) {
  const normalized = normalizeRecoveryCode(code);
  if (!/^[A-Z0-9]{5}-[A-Z0-9]{5}$/.test(normalized) || !Array.isArray(recoveryHashes) || recoveryHashes.length === 0) {
    return { ok: false, nextHashes: recoveryHashes || [] };
  }

  for (let index = 0; index < recoveryHashes.length; index += 1) {
    if (await bcrypt.compare(normalized, recoveryHashes[index])) {
      return {
        ok: true,
        nextHashes: recoveryHashes.filter((_, itemIndex) => itemIndex !== index),
      };
    }
  }

  return { ok: false, nextHashes: recoveryHashes };
}

/** Authenticator secret of a user row, or null when it is missing or ENCRYPTION_KEY changed since it was stored. */
function readTwoFactorSecret(userRow: SecondFactorUser | null | undefined) {
  return userRow?.encrypted_two_factor_secret ? decrypt(userRow.encrypted_two_factor_secret) : null;
}

async function getTwoFactorStatus(userId: string) {
  const [rows] = await db.execute<SecondFactorUser[]>(
    'SELECT two_factor_enabled, encrypted_two_factor_secret, two_factor_recovery_codes FROM users WHERE id = ?',
    [userId]
  );
  if (rows.length === 0) return null;
  const enabled = !!rows[0].two_factor_enabled;
  return {
    enabled,
    recoveryCodesRemaining: parseRecoveryHashes(rows[0].two_factor_recovery_codes).length,
    // false: authenticator codes cannot be checked; only recovery codes still work.
    secretReadable: !enabled || readTwoFactorSecret(rows[0]) !== null,
  };
}

/** New recovery codes with their hashes. Hashing takes seconds, so callers do it before locking rows. */
async function createRecoveryCodes() {
  const codes = generateRecoveryCodes();
  return { codes, hashes: await hashRecoveryCodes(codes) };
}

async function enableTwoFactor(userId: string, secret: string, recoveryHashes: readonly string[], connection: SqlExecutor = db) {
  await connection.execute(
    `UPDATE users
     SET two_factor_enabled = TRUE,
         encrypted_two_factor_secret = ?,
         two_factor_recovery_codes = ?
     WHERE id = ?`,
    [encrypt(secret), JSON.stringify(recoveryHashes), userId]
  );
}

/** Replaces the recovery codes. False when 2FA was turned off meanwhile, for example by an admin reset. */
async function replaceRecoveryCodes(userId: string, recoveryHashes: readonly string[]) {
  const [result] = await db.execute<ResultSetHeader>(
    'UPDATE users SET two_factor_recovery_codes = ? WHERE id = ? AND two_factor_enabled = TRUE',
    [JSON.stringify(recoveryHashes), userId]
  );
  return result.affectedRows === 1;
}

async function disableTwoFactor(userId: string, connection: SqlExecutor = db) {
  await connection.execute(
    `UPDATE users
     SET two_factor_enabled = FALSE,
         encrypted_two_factor_secret = NULL,
         two_factor_recovery_codes = NULL
     WHERE id = ?`,
    [userId]
  );
}

async function verifyUserSecondFactor(userRow: SecondFactorUser | null | undefined, code: unknown, connection: SqlExecutor = db) {
  if (!userRow?.two_factor_enabled) return { ok: true, usedRecoveryCode: false };

  const secret = readTwoFactorSecret(userRow);
  if (secret && verifyTotp(secret, code)) {
    return { ok: true, usedRecoveryCode: false };
  }

  const recoveryHashes = parseRecoveryHashes(userRow.two_factor_recovery_codes);
  const recoveryResult = await verifyRecoveryCode(code, recoveryHashes);
  if (!recoveryResult.ok) return { ok: false, usedRecoveryCode: false };

  const [result] = await connection.execute<ResultSetHeader>(
    'UPDATE users SET two_factor_recovery_codes = ? WHERE id = ? AND two_factor_enabled = TRUE AND JSON_EQUALS(two_factor_recovery_codes, ?)',
    [JSON.stringify(recoveryResult.nextHashes), userRow.id, JSON.stringify(recoveryHashes)]
  );
  if (result.affectedRows !== 1) return { ok: false, usedRecoveryCode: false };
  return { ok: true, usedRecoveryCode: true, recoveryCodesRemaining: recoveryResult.nextHashes.length };
}

function hashChallengeToken(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function createTwoFactorLoginChallenge(userId: string, req: IncomingMessage) {
  const token = crypto.randomBytes(32).toString('hex');
  await db.execute('DELETE FROM two_factor_challenges WHERE expires_at < UTC_TIMESTAMP()');
  await db.execute(
    `INSERT INTO two_factor_challenges (id, user_id, token_hash, expires_at, ip_address, user_agent)
     VALUES (?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ${LOGIN_CHALLENGE_MINUTES} MINUTE), ?, ?)`,
    [
      crypto.randomUUID(),
      userId,
      hashChallengeToken(token),
      req.socket?.remoteAddress || null,
      String(req.headers['user-agent'] || '').slice(0, 1000) || null,
    ]
  );
  return token;
}

async function consumeTwoFactorLoginChallenge(token: string, connection: SqlExecutor = db, { lock = false } = {}) {
  const tokenHash = hashChallengeToken(token);
  const [rows] = await connection.execute<(SecondFactorUser & { challenge_id: string; user_id: string; email: string; full_name: string | null; avatar_url: string | null; role: string; timezone: string | null; is_active: StoredFlag })[]>(
    `SELECT u.id, c.id AS challenge_id, c.user_id, u.email, u.full_name, u.avatar_url, u.role, u.timezone, u.is_active,
            u.two_factor_enabled, u.encrypted_two_factor_secret, u.two_factor_recovery_codes
     FROM two_factor_challenges c
     INNER JOIN users u ON u.id = c.user_id
     WHERE c.token_hash = ? AND c.expires_at >= UTC_TIMESTAMP()
     LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [tokenHash]
  );
  if (rows.length === 0) return null;
  return rows[0];
}

async function deleteTwoFactorLoginChallenge(token: string, connection: SqlExecutor = db) {
  await connection.execute('DELETE FROM two_factor_challenges WHERE token_hash = ?', [hashChallengeToken(token)]);
}

export = {
  generateTwoFactorSecret,
  verifyTotp,
  getOtpAuthUri,
  generateRecoveryCodes,
  hashRecoveryCodes,
  parseRecoveryHashes,
  readTwoFactorSecret,
  getTwoFactorStatus,
  createRecoveryCodes,
  enableTwoFactor,
  replaceRecoveryCodes,
  disableTwoFactor,
  verifyUserSecondFactor,
  createTwoFactorLoginChallenge,
  consumeTwoFactorLoginChallenge,
  deleteTwoFactorLoginChallenge,
};
