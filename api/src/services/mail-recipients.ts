/** "Name <a@example.com>, b@example.com" (or a list of such entries) -> ['a@example.com', 'b@example.com']. */
function normalizeRecipients(value: unknown): string[] {
  const parts = Array.isArray(value) ? value.map(String) : String(value || '').split(',');
  return parts
    .map(part => {
      const trimmed = part.trim();
      const match = trimmed.match(/^(.+?)\s*<(.+?)>$/);
      return (match ? match[2] : trimmed).trim();
    })
    .filter(Boolean);
}

/** A stored to/cc/bcc JSON column (MariaDB returns it as text) -> string[]. */
function parseStoredRecipients(value: unknown): string[] {
  const parsed = typeof value === 'string' ? JSON.parse(value || '[]') : value;
  return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
}

/** Stored recipients -> "a@example.com, b@example.com" for SMTP. */
function formatRecipients(value: unknown) {
  return parseStoredRecipients(value).join(', ');
}

export { normalizeRecipients, parseStoredRecipients, formatRecipients };
