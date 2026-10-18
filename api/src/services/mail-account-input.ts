// The account fields a browser sends to POST and PUT /api/mail/accounts,
// checked and normalized before anything is tested, stopped or stored: the
// connection test and the stored row use the same values, and a value the
// database column would refuse is answered with a 400 instead of a driver error.
import type { ApiError, MailAccountIdentity } from '../types';

interface ExistingMailAccount extends MailAccountIdentity {
  smtp_host?: string | null;
  smtp_port?: number | string | null;
}
interface MailAccountFields {
  email_address?: string;
  /** undefined: unchanged; null: cleared. */
  display_name?: string | null;
  /** undefined: unchanged; null: sign in with the email address. */
  username?: string | null;
  imap_host?: string;
  imap_port?: number;
  smtp_host?: string;
  smtp_port?: number;
  /** The password as typed; the route encrypts it before storing (historical field name). */
  encrypted_password?: string;
}
interface NewMailAccountInput extends MailAccountFields {
  email_address: string;
  display_name: string | null;
  provider: string;
  username: string;
  imap_host: string;
  imap_port: number;
  smtp_host: string;
  smtp_port: number;
  encrypted_password: string;
}
interface MailConnectionSettings {
  email_address: string;
  username: string;
  imap_host: string;
  imap_port: number;
  smtp_host: string;
  smtp_port: number;
}
interface MailAccountUpdateInput extends MailAccountFields {
  /** The connection settings after the update: from the body, else the stored row. */
  next: MailConnectionSettings;
}

const DEFAULT_IMAP_PORT = 993;
const DEFAULT_SMTP_PORT = 587;
const TEXT_COLUMN = 255;
const PROVIDER_COLUMN = 50;

function fail(message: string): never {
  throw Object.assign(new Error(message), { status: 400 }) as ApiError;
}
// Absent, null and the empty string all mean "not provided" (the dialog sends
// empty strings for untouched optional fields).
const provided = (value: unknown) => value !== undefined && value !== null && value !== '';

function text(value: unknown, label: string, max = TEXT_COLUMN) {
  if (!provided(value)) return undefined;
  if (typeof value !== 'string') fail(`${label} must be text.`);
  const trimmed = (value as string).trim();
  if (!trimmed) return undefined;
  if (trimmed.length > max) fail(`${label} must be ${max} characters or fewer.`);
  return trimmed;
}
function port(value: unknown, label: string) {
  if (!provided(value)) return undefined;
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^\s*\d{1,5}\s*$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(number) || number < 1 || number > 65535) fail(`${label} must be a number between 1 and 65535.`);
  return number;
}
function address(value: unknown) {
  const trimmed = text(value, 'Email address');
  if (trimmed !== undefined && !/^[^\s@<>]+@[^\s@<>]+$/.test(trimmed)) fail('Enter a valid email address.');
  return trimmed;
}
// Optional columns: undefined keeps the stored value, null clears it.
function optionalText(value: unknown, label: string) {
  return value === undefined ? undefined : text(value, label) ?? null;
}
function password(value: unknown) {
  if (!provided(value)) return undefined;
  if (typeof value !== 'string') fail('Password must be text.');
  return value as string;
}

function parseMailAccountInput(body: Record<string, unknown>): NewMailAccountInput;
function parseMailAccountInput(body: Record<string, unknown>, existing: ExistingMailAccount): MailAccountUpdateInput;
function parseMailAccountInput(body: Record<string, unknown>, existing?: ExistingMailAccount): NewMailAccountInput | MailAccountUpdateInput {
  const fields: MailAccountFields = {
    email_address: address(body.email_address),
    display_name: optionalText(body.display_name, 'Display name'),
    username: optionalText(body.username, 'Username'),
    imap_host: text(body.imap_host, 'IMAP server'),
    imap_port: port(body.imap_port, 'IMAP port'),
    smtp_host: text(body.smtp_host, 'SMTP server'),
    smtp_port: port(body.smtp_port, 'SMTP port'),
    encrypted_password: password(body.encrypted_password),
  };
  if (!existing) {
    if (!fields.email_address || !fields.encrypted_password) fail('Email address and password are required');
    if (!fields.imap_host || !fields.smtp_host) fail('IMAP and SMTP server addresses are required');
    const provider = text(body.provider, 'Mail provider', PROVIDER_COLUMN);
    if (!provider) fail('Mail provider is required.');
    return { ...fields, email_address: fields.email_address, encrypted_password: fields.encrypted_password,
      imap_host: fields.imap_host, smtp_host: fields.smtp_host, provider: provider!,
      display_name: fields.display_name ?? null, username: fields.username || fields.email_address,
      imap_port: fields.imap_port ?? DEFAULT_IMAP_PORT, smtp_port: fields.smtp_port ?? DEFAULT_SMTP_PORT };
  }
  const email = fields.email_address ?? String(existing.email_address || '');
  const next: MailConnectionSettings = {
    email_address: email,
    username: fields.username === undefined ? (existing.username || email) : (fields.username ?? email),
    imap_host: fields.imap_host ?? String(existing.imap_host || ''),
    imap_port: fields.imap_port ?? (Number(existing.imap_port) || DEFAULT_IMAP_PORT),
    smtp_host: fields.smtp_host ?? String(existing.smtp_host || ''),
    smtp_port: fields.smtp_port ?? (Number(existing.smtp_port) || DEFAULT_SMTP_PORT),
  };
  return { ...fields, next };
}

export type { NewMailAccountInput, MailAccountUpdateInput };
export { parseMailAccountInput };
