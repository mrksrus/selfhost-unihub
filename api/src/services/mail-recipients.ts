import addressparser from 'nodemailer/lib/addressparser';

/** 'Jane Doe <jane@example.com>'; a name with anything beyond letters, digits, spaces and apostrophes is quoted. */
function formatRecipient({ name, address }: { name: string; address: string }): string {
  if (!address) return name.trim();
  if (!name) return address;
  const quoted = /^[\w ']*$/.test(name) ? name : `"${name.replace(/(["\\])/g, '\\$1')}"`;
  return `${quoted} <${address}>`;
}

/**
 * '"Doe, Jane" <jane@example.com>, Team: b@example.com;' (or a list of such entries)
 * -> ['"Doe, Jane" <jane@example.com>', 'b@example.com']. Uses nodemailer's own parser, so
 * each entry is one recipient exactly as SMTP will address it, display name included.
 * A name typed without an address is kept as typed, so an unfinished draft recipient is not lost.
 */
function normalizeRecipients(value: unknown): string[] {
  const parts = Array.isArray(value) ? value.map(String) : [String(value || '')];
  return parts.flatMap(part => addressparser(part, { flatten: true })).map(formatRecipient).filter(Boolean);
}

/** A stored to/cc/bcc JSON column (MariaDB returns it as text) -> string[]. */
function parseStoredRecipients(value: unknown): string[] {
  const parsed = typeof value === 'string' ? JSON.parse(value || '[]') : value;
  return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
}

export { normalizeRecipients, parseStoredRecipients };
