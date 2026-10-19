import crypto from 'crypto';
import { ENCRYPTION_KEY, ENCRYPTION_KEY_PREVIOUS } from '../config';

// Stored secrets (mail and calendar passwords, authenticator keys, ICS
// addresses) are AES-256-GCM with a key derived from ENCRYPTION_KEY:
//   v1:<iv>:<tag>:<ciphertext>   (hex; written since 0.23.0)
//   <iv>:<tag>:<ciphertext>      (earlier releases, read as v1)
// The version names the algorithm and key derivation, so a later format can
// be told apart. Values are read with ENCRYPTION_KEY, then with
// ENCRYPTION_KEY_PREVIOUS, so changing the key does not lose what is stored;
// every write uses ENCRYPTION_KEY. Backups seal with BACKUP_MASTER_KEY
// (default ENCRYPTION_KEY) on their own, see services/backup-container.ts.
const VERSION = 'v1';

function deriveKey(secret: string | undefined) {
  return crypto.createHash('sha256').update(secret as string).digest();
}

function encrypt(text: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(ENCRYPTION_KEY), iv);
  const encrypted = cipher.update(text, 'utf8', 'hex') + cipher.final('hex');
  return `${VERSION}:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted}`;
}

function parts(encryptedText: string) {
  const fields = String(encryptedText).split(':');
  if (fields.length === 4 && fields[0] === VERSION) fields.shift();
  return fields.length === 3 ? fields : null;
}

function decryptWith(secret: string | undefined, [ivHex, authTagHex, encrypted]: string[]) {
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(secret), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    return decipher.update(encrypted, 'hex', 'utf8') + decipher.final('utf8');
  } catch {
    return null;
  }
}

/** The stored value in clear, or null when it is unreadable with either key. */
function decrypt(encryptedText: string) {
  const fields = parts(encryptedText);
  if (!fields) return null;
  const current = decryptWith(ENCRYPTION_KEY, fields);
  if (current !== null || !ENCRYPTION_KEY_PREVIOUS) return current;
  return decryptWith(ENCRYPTION_KEY_PREVIOUS, fields);
}

export {
  deriveKey,
  encrypt,
  decrypt,
};
