// The phone composer shows a recipient field's completed entries as chips and
// keeps the entry being typed in the input. The field's value stays the one
// comma-separated string the rest of compose, drafts and sending use, so
// nothing else changes; these helpers only split it and put it back together.

export interface RecipientParts {
  /** Completed entries, each as typed or picked ("Jane Doe <jane@example.com>"). */
  entries: string[];
  /** The text after the last comma: what is still being typed. */
  draft: string;
}

/**
 * Splits on commas that are not inside a quoted name or an angle-bracket
 * address, so `"Doe, Jane" <jane@example.com>` stays one entry. Inside a
 * quoted name a backslash escapes the next character (RFC 5322), as the
 * server's parser reads it: `"Doe \", Jane"` is still one name.
 */
export function splitRecipients(value: string): RecipientParts {
  const pieces: string[] = [];
  let current = '';
  let quoted = false;
  let escaped = false;
  let bracketed = false;
  for (const char of value) {
    if (escaped) {
      escaped = false;
      current += char;
      continue;
    }
    if (char === '\\' && quoted) escaped = true;
    else if (char === '"' && !bracketed) quoted = !quoted;
    else if (char === '<' && !quoted) bracketed = true;
    else if (char === '>' && !quoted) bracketed = false;
    if (char === ',' && !quoted && !bracketed) {
      pieces.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  const entries = pieces.map((piece) => piece.trim()).filter(Boolean);
  return { entries, draft: current.trimStart() };
}

/** The field's value for these entries and the text still being typed. */
export function joinRecipients(entries: string[], draft: string): string {
  const completed = entries.filter(Boolean);
  if (completed.length === 0) return draft;
  return `${completed.join(', ')}, ${draft}`;
}

/** What a chip shows: the display name of `Name <address>`, else the address. */
export function recipientChipLabel(entry: string): string {
  const quoted = /^\s*"((?:[^"\\]|\\.)*)"\s*<[^<>]*>\s*$/.exec(entry);
  const named = quoted ? quoted[1].replace(/\\(.)/g, '$1') : /^\s*([^"<]*?)\s*<[^>]*>\s*$/.exec(entry)?.[1];
  const name = named?.trim();
  return name || entry.replace(/^<|>$/g, '').trim();
}

/** The address part of an entry (the last bracketed part; a quoted name may hold brackets), for the chip's details. */
export function recipientAddress(entry: string): string {
  const bracketed = /<([^<>]*)>\s*$/.exec(entry);
  return (bracketed ? bracketed[1] : entry).trim();
}

/** A plain check that the entry can be an address at all; the server validates when sending. */
export const looksLikeAddress = (entry: string) => /^[^\s@]+@[^\s@]+$/.test(recipientAddress(entry));
