import { format } from 'date-fns';
import type { Email, MailAccount } from '@/lib/mail-api';
import { escapeHtml, plainTextToHtml, sanitizeComposeHtml } from '@/lib/mail-compose';

// What a new message, reply or forward starts with: an optional template, the
// sending account's signature and the quoted message, in rich text or plain
// text (Settings, Mail: compose format).
export type ComposeFormat = 'rich' | 'plain';
export type ResponseMode = 'reply' | 'replyAll' | 'forward';

export interface BodyParts {
  /** The template's text, or nothing. */
  intro?: { html: string | null; text: string } | null;
  /** The quoted message of a reply or forward. */
  quote?: { html: string; text: string } | null;
}

/** Text of composed HTML: paragraphs and line breaks become new lines. */
export function htmlToPlainText(html: string) {
  if (!html) return '';
  const template = document.createElement('template');
  template.innerHTML = html.replace(/\uE000/g, '');
  const content = template.content;
  content.querySelectorAll('script, style, noscript, template').forEach(node => node.remove());
  content.querySelectorAll('br').forEach(node => node.replaceWith('\n'));
  content.querySelectorAll('hr').forEach(node => node.replaceWith('\n--------\n'));
  content.querySelectorAll('blockquote').forEach(node => {
    node.replaceWith(`\n${(node.textContent || '').split('\n').map(line => `> ${line}`).join('\n')}\n`);
  });
  // A block ends its line, and starts a new one after text on the same line
  // ("Name<div>Company</div>", as the editor writes a second line). The start
  // is marked first and becomes a line break only where no break precedes it.
  content.querySelectorAll('p, div, li, tr, h1, h2, h3, h4').forEach(node => { node.prepend(BLOCK_START); node.append('\n'); });
  return (content.textContent || '')
    .replace(/\uE000+/g, (_, offset: number, text: string) => offset === 0 || text[offset - 1] === '\n' ? '' : '\n')
    .replace(/\u00a0/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

const BLOCK_START = '\uE000';

/** The account's signature in the given format, with the usual "-- " separator; empty without one. */
export function signatureFor(account: Pick<MailAccount, 'signature_html' | 'signature_text'> | null | undefined, bodyFormat: ComposeFormat) {
  const text = account?.signature_text?.trim();
  if (!text) return '';
  if (bodyFormat === 'plain') return `-- \n${text}`;
  const html = account?.signature_html ? sanitizeComposeHtml(account.signature_html) : plainTextToHtml(text);
  return `<div>-- <br>${html}</div>`;
}

/** The starting body: room to write (or the template), the signature, then the quote. */
export function composeBody(bodyFormat: ComposeFormat, signature: string, { intro = null, quote = null }: BodyParts = {}) {
  if (bodyFormat === 'plain') {
    return [intro?.text ?? '', signature, quote?.text ?? ''].filter((part, index) => index === 0 || part).join('\n\n');
  }
  // Nothing to add: an empty editor, which shows its placeholder.
  if (!intro && !signature && !quote) return '';
  const start = intro ? (intro.html ? sanitizeComposeHtml(intro.html) : plainTextToHtml(intro.text)) : '<p><br></p>';
  return `${start}${signature}${quote ? `<hr>${quote.html}` : ''}`;
}

/** The quoted message for a reply or forward, in both formats. */
export function quoteOf(email: Email, mode: ResponseMode) {
  const label = mode === 'forward' ? 'Forwarded Message' : 'Original Message';
  const sender = email.from_name || email.from_address;
  const date = format(new Date(email.received_at), 'PPpp');
  const body = email.body_text || '';
  return {
    html: `<p><strong>${label}</strong><br>From: ${escapeHtml(sender)}<br>Date: ${escapeHtml(date)}</p><blockquote>${plainTextToHtml(body)}</blockquote>`,
    text: `-------- ${label} --------\nFrom: ${sender}\nDate: ${date}\n\n${body.split('\n').map(line => `> ${line}`).join('\n')}`,
  };
}

const addressOf = (recipient: string) => (/<([^<>]+)>\s*$/.exec(recipient)?.[1] ?? recipient).trim().toLowerCase();
/**
 * Recipients of a reply: the sender; with Reply all also everyone on To and
 * Cc. The sending account's own address is never among them, and nobody is
 * named twice.
 */
export function responseRecipients(email: Email, mode: ResponseMode, ownAddress: string | null | undefined) {
  if (mode === 'forward') return { to: '', cc: '' };
  const own = (ownAddress || '').trim().toLowerCase();
  const seen = new Set<string>(own ? [own] : []);
  const keep = (recipient: string) => {
    const address = addressOf(recipient);
    if (!address || seen.has(address)) return false;
    seen.add(address);
    return true;
  };
  // As a reply always did: the sender's address (imported To/Cc are bare addresses too).
  const sender = email.from_address;
  if (mode === 'reply') return { to: sender, cc: '' };
  const to = [sender, ...(email.to_addresses || [])].filter(keep);
  const cc = (email.cc_addresses || []).filter(keep);
  return { to: to.join(', '), cc: cc.join(', ') };
}

/** The body converted when the format is switched. */
export function convertBody(body: string, to: ComposeFormat) {
  return to === 'plain' ? htmlToPlainText(body) : plainTextToHtml(body);
}
