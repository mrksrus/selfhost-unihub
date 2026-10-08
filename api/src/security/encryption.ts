import crypto = require('crypto');
import imported1 = require('../config');
const { ENCRYPTION_KEY } = imported1;

// ── Encryption helpers (AES-256-GCM) ─────────────────────────────
function deriveKey(secret: string | undefined) {
  return crypto.createHash('sha256').update(secret as string).digest();
}

function encrypt(text: string) {
  const iv = crypto.randomBytes(12);
  const key = deriveKey(ENCRYPTION_KEY);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return iv.toString('hex') + ':' + authTag + ':' + encrypted;
}

function decrypt(encryptedText: string) {
  try {
    const [ivHex, authTagHex, encrypted] = encryptedText.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const key = deriveKey(ENCRYPTION_KEY);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    return null;
  }
}

export = {
  deriveKey,
  encrypt,
  decrypt,
};
