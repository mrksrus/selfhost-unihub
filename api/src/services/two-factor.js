const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db } = require('../state');
const { encrypt, decrypt } = require('../security/encryption');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;
const LOGIN_CHALLENGE_MINUTES = 10;
const RECOVERY_CODE_COUNT = 10;

function base32Encode(buffer) {
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

function base32Decode(value) {
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

function normalizeOtpCode(code) {
  return String(code || '').replace(/\s+/g, '').trim();
}

function normalizeRecoveryCode(code) {
  const normalized = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return normalized.length === 10 ? `${normalized.slice(0, 5)}-${normalized.slice(5)}` : normalized;
}

function timingSafeEqualString(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function generateTwoFactorSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function generateTotp(secret, timeStep = Math.floor(Date.now() / 1000 / TOTP_PERIOD_SECONDS)) {
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

function verifyTotp(secret, code, window = 1) {
  const normalizedCode = normalizeOtpCode(code);
  if (!/^\d{6}$/.test(normalizedCode)) return false;

  const currentStep = Math.floor(Date.now() / 1000 / TOTP_PERIOD_SECONDS);
  for (let offset = -window; offset <= window; offset += 1) {
    const expected = generateTotp(secret, currentStep + offset);
    if (expected && timingSafeEqualString(expected, normalizedCode)) return true;
  }
  return false;
}

function getOtpAuthUri({ email, secret, issuer = 'UniHub' }) {
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

async function hashRecoveryCodes(codes) {
  return Promise.all(codes.map((code) => bcrypt.hash(normalizeRecoveryCode(code), 12)));
}

function parseRecoveryHashes(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

async function verifyRecoveryCode(code, recoveryHashes) {
  const normalized = normalizeRecoveryCode(code);
  if (!normalized || !Array.isArray(recoveryHashes) || recoveryHashes.length === 0) {
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

async function getTwoFactorStatus(userId) {
  const [rows] = await db.execute(
    'SELECT two_factor_enabled, two_factor_recovery_codes FROM users WHERE id = ?',
    [userId]
  );
  if (rows.length === 0) return null;
  return {
    enabled: !!rows[0].two_factor_enabled,
    recoveryCodesRemaining: parseRecoveryHashes(rows[0].two_factor_recovery_codes).length,
  };
}

async function enableTwoFactor(userId, secret) {
  const recoveryCodes = generateRecoveryCodes();
  const recoveryHashes = await hashRecoveryCodes(recoveryCodes);
  await db.execute(
    `UPDATE users
     SET two_factor_enabled = TRUE,
         encrypted_two_factor_secret = ?,
         two_factor_recovery_codes = ?
     WHERE id = ?`,
    [encrypt(secret), JSON.stringify(recoveryHashes), userId]
  );
  return recoveryCodes;
}

async function disableTwoFactor(userId) {
  await db.execute(
    `UPDATE users
     SET two_factor_enabled = FALSE,
         encrypted_two_factor_secret = NULL,
         two_factor_recovery_codes = NULL
     WHERE id = ?`,
    [userId]
  );
}

async function verifyUserSecondFactor(userRow, code) {
  if (!userRow?.two_factor_enabled) return { ok: true, usedRecoveryCode: false };

  const secret = userRow.encrypted_two_factor_secret ? decrypt(userRow.encrypted_two_factor_secret) : null;
  if (secret && verifyTotp(secret, code)) {
    return { ok: true, usedRecoveryCode: false };
  }

  const recoveryHashes = parseRecoveryHashes(userRow.two_factor_recovery_codes);
  const recoveryResult = await verifyRecoveryCode(code, recoveryHashes);
  if (!recoveryResult.ok) return { ok: false, usedRecoveryCode: false };

  await db.execute(
    'UPDATE users SET two_factor_recovery_codes = ? WHERE id = ?',
    [JSON.stringify(recoveryResult.nextHashes), userRow.id]
  );
  return { ok: true, usedRecoveryCode: true, recoveryCodesRemaining: recoveryResult.nextHashes.length };
}

function hashChallengeToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function createTwoFactorLoginChallenge(userId, req) {
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

async function consumeTwoFactorLoginChallenge(token) {
  const tokenHash = hashChallengeToken(token);
  const [rows] = await db.execute(
    `SELECT c.id, c.user_id, u.email, u.full_name, u.avatar_url, u.role, u.timezone, u.is_active,
            u.two_factor_enabled, u.encrypted_two_factor_secret, u.two_factor_recovery_codes
     FROM two_factor_challenges c
     INNER JOIN users u ON u.id = c.user_id
     WHERE c.token_hash = ? AND c.expires_at >= UTC_TIMESTAMP()
     LIMIT 1`,
    [tokenHash]
  );
  if (rows.length === 0) return null;
  return rows[0];
}

async function deleteTwoFactorLoginChallenge(token) {
  await db.execute('DELETE FROM two_factor_challenges WHERE token_hash = ?', [hashChallengeToken(token)]);
}

module.exports = {
  generateTwoFactorSecret,
  verifyTotp,
  getOtpAuthUri,
  generateRecoveryCodes,
  hashRecoveryCodes,
  parseRecoveryHashes,
  getTwoFactorStatus,
  enableTwoFactor,
  disableTwoFactor,
  verifyUserSecondFactor,
  createTwoFactorLoginChallenge,
  consumeTwoFactorLoginChallenge,
  deleteTwoFactorLoginChallenge,
};
