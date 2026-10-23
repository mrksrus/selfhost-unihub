import { badRequest } from '../http/errors';

// A signature belongs to its mail account (a column, not a setting): rich
// text with a plain-text version for plain mail. The HTML is the person's
// own; the composer sanitizes it like any draft body before showing it.
const SIGNATURE_HTML_LIMIT = 65536;
const SIGNATURE_TEXT_LIMIT = 16384;

interface Signature { html: string | null; text: string | null }

/** The stored form of a signature from the API or an archive; '' clears it. */
function normalizeSignature(input: { html?: unknown; text?: unknown }): Signature {
  const html = input.html == null ? '' : input.html;
  const text = input.text == null ? '' : input.text;
  if (typeof html !== 'string' || typeof text !== 'string') throw badRequest('SIGNATURE_INVALID', 'A signature is text');
  if (html.length > SIGNATURE_HTML_LIMIT || text.length > SIGNATURE_TEXT_LIMIT) throw badRequest('SIGNATURE_TOO_LONG', 'The signature is too long');
  // Without visible text the rich version is empty too (an editor leaves <p><br></p>).
  const plain = text.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  return plain.trim() ? { html: html.trim() || null, text: plain } : { html: null, text: null };
}

export { normalizeSignature, SIGNATURE_HTML_LIMIT, SIGNATURE_TEXT_LIMIT };
export type { Signature };
