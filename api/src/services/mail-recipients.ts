import addressparser from 'nodemailer/lib/addressparser';

/**
 * '"Doe, Jane" <jane@example.com>, Team: b@example.com;' (or a list of such entries)
 * -> ['jane@example.com', 'b@example.com']. Uses nodemailer's own parser, so what is
 * stored is exactly what SMTP would deliver to. A name typed without an address is
 * kept as typed, so an unfinished draft recipient is not lost.
 */
function normalizeRecipients(value: unknown): string[] {
  const parts = Array.isArray(value) ? value.map(String) : [String(value || '')];
  return parts
    .flatMap(part => addressparser(part, { flatten: true }))
    .map(entry => (entry.address || entry.name).trim())
    .filter(Boolean);
}

/** A stored to/cc/bcc JSON column (MariaDB returns it as text) -> string[]. */
function parseStoredRecipients(value: unknown): string[] {
  const parsed = typeof value === 'string' ? JSON.parse(value || '[]') : value;
  return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
}

export { normalizeRecipients, parseStoredRecipients };
