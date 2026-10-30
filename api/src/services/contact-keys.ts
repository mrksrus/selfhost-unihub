// Normalised keys of contact values and names. One owner: the store fills
// contact_values.value_key and contacts.name_key with these, the duplicate
// engine and restore matching compare them, and the upgrade step 22 copy
// uses them too, so a key computed today equals the stored one.
//
// A stored key is cut to 255 characters for its index, so two long values
// (web addresses, addresses) can share one. It finds candidates; whether two
// values are the same is decided by fullValueKey, which is never cut.
import type { ContactValueKind } from '../contracts/contacts';

const KEY_MAX = 255;

function bounded(text: string, max = KEY_MAX) {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join('') : text;
}

// Phone: the digits, with a leading + when the number was written with one.
function fullPhoneKey(value: string) {
  const text = value.trim();
  const digits = text.replace(/\D/g, '');
  return digits ? (text.startsWith('+') ? '+' : '') + digits : '';
}
const phoneKey = (value: string) => bounded(fullPhoneKey(value));

const fullEmailKey = (value: string) => value.trim().toLowerCase();
const emailKey = (value: string) => bounded(fullEmailKey(value));

// A web address without its scheme and trailing slash, so http/https and
// "example.org/" compare equal.
const fullUrlKey = (value: string) => value.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/\/+$/, '');
const urlKey = (value: string) => bounded(fullUrlKey(value));

const fullTextKey = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');

/** The whole normalised form of a value: what decides whether two values of a kind are the same. */
function fullValueKey(kind: ContactValueKind, value: string) {
  switch (kind) {
    case 'email': return fullEmailKey(value);
    case 'phone': return fullPhoneKey(value);
    case 'url': return fullUrlKey(value);
    default: return fullTextKey(value);
  }
}

/** The stored key (contact_values.value_key): the normalised form cut to 255 characters, for the index. */
function valueKey(kind: ContactValueKind, value: string) {
  return bounded(fullValueKey(kind, value));
}

/**
 * A value's identity within its kind: its full normalised key, or its
 * trimmed lower-case text when the key is empty (a phone without digits).
 */
function valueIdentity(kind: ContactValueKind, value: string) {
  return `${kind}\u0000${fullValueKey(kind, value) || `raw:${value.trim().toLowerCase()}`}`;
}

// Letters that do not decompose under NFKD.
const FOLDED: Readonly<Record<string, string>> = { 'ß': 'ss', 'æ': 'ae', 'œ': 'oe', 'ø': 'o', 'ł': 'l', 'đ': 'd', 'þ': 'th', 'ı': 'i' };
const HONORIFICS = new Set(['dr', 'prof', 'mr', 'mrs', 'ms', 'mx', 'herr', 'frau', 'dipl', 'ing', 'mag', 'med', 'jr', 'sr', 'jun', 'sen', 'phd', 'md', 'ii', 'iii']);

function foldName(text: string) {
  return text.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase()
    .replace(/[ßæœøłđþı]/g, letter => FOLDED[letter])
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

interface NameParts {
  given?: string | null;
  middle?: string | null;
  family?: string | null;
  display?: string | null;
}

// The sorted token set of a name without titles, so "Müller, Jürgen",
// "jurgen muller" and "Dr. Jürgen Müller" share one key. The name parts
// count; the display name only when there are none. Prefix and suffix fields
// are ignored.
function nameTokens(parts: NameParts) {
  return [...new Set(orderedNameTokens(parts))].sort();
}

// The same tokens in written order, so the duplicate engine can tell
// "Anna Smith" from "Smith Anna" without folding the name twice.
function orderedNameTokens({ given, middle, family, display }: NameParts) {
  const source = [given, middle, family].filter(part => part && part.trim()).join(' ') || display || '';
  return foldName(source).split(' ').filter(token => token && !HONORIFICS.has(token));
}

function nameKey(parts: NameParts) {
  return bounded(nameTokens(parts).join(' '));
}

export { valueKey, fullValueKey, valueIdentity, phoneKey, emailKey, urlKey, nameKey, nameTokens, orderedNameTokens, foldName, KEY_MAX };
export type { NameParts };
