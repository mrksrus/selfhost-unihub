// One definition of where mail files live. The container paths are the
// defaults; MAIL_ATTACHMENT_UPLOAD_ROOT and MAIL_RAW_STORAGE_ROOT override them
// (tests point them at a temporary directory). The roots are read on every
// call, so a changed override needs no module reload.
import fs from 'node:fs/promises';
import path from 'node:path';

type MailStorageKind = 'attachment' | 'raw';

function attachmentsRoot() { return process.env.MAIL_ATTACHMENT_UPLOAD_ROOT || '/app/uploads/attachments'; }
function rawRoot() { return process.env.MAIL_RAW_STORAGE_ROOT || '/app/uploads/mail-raw'; }
function mailStorageRoot(kind: MailStorageKind) { return kind === 'raw' ? rawRoot() : attachmentsRoot(); }

function under(base: string, stored: string | null | undefined) {
  if (!stored) return null;
  const resolved = path.resolve(stored);
  return resolved.startsWith(path.resolve(base) + path.sep) ? resolved : null;
}

// A stored path is only read or removed when it lies inside the root. The
// database row already proves ownership; this stops a path from leaving it.
function mailPathUnderRoot(kind: MailStorageKind, stored: string | null | undefined) {
  return under(mailStorageRoot(kind), stored);
}

// Stricter: inside this owner's directory of the root (<root>/<userId>/...).
function ownedMailPath(kind: MailStorageKind, stored: string | null | undefined, userId: string) {
  return under(path.join(mailStorageRoot(kind), String(userId)), stored);
}

// The same owner check after following symlinks, for removals: a database
// path under the owner's directory must not reach outside it through a link.
// Rejects like realpath (ENOENT) when the file or directory is gone.
async function realOwnedMailPath(kind: MailStorageKind, stored: string | null | undefined, userId: string) {
  const resolved = ownedMailPath(kind, stored, userId);
  if (!resolved) return null;
  const [real, realBase] = await Promise.all([fs.realpath(resolved), fs.realpath(path.join(mailStorageRoot(kind), String(userId)))]);
  return real.startsWith(realBase + path.sep) ? real : null;
}

export type { MailStorageKind };
export { attachmentsRoot, rawRoot, mailPathUnderRoot, ownedMailPath, realOwnedMailPath };
