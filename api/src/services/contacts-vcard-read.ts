// The vCard tokenizer (D6): bytes in, cards of properties out, for vCard 2.1,
// 3.0 and 4.0. It works on bytes because 2.1 names a character set per
// property: a value is first decoded to bytes (quoted-printable or base64),
// then to text with its CHARSET, else the file's encoding. It unfolds lines,
// joins 2.1 soft line breaks and base64 blocks, and parses groups and
// parameters. Mapping properties to the contact model is contacts-vcard-map.ts.
//
// The file is untrusted. Every pass is linear over the bytes (no regular
// expression runs over the file or a whole value), and the bounds below cut a
// line, a card or the file. Warnings name the card number and the property,
// never a value.
import { isUtf8 } from 'node:buffer';
import type { ImportWarning } from '../contracts/contacts';
import { badRequest } from '../http/errors';

const IMPORT_LIMITS = {
  fileBytes: 64 * 1024 * 1024,
  cards: 20000,
  propertiesPerCard: 500,
  // One unfolded line; a PHOTO or LOGO line is bounded by the photo size instead.
  lineBytes: 1024 * 1024,
  photoBytes: 20 * 1024 * 1024,
} as const;

type VCardVersion = '2.1' | '3.0' | '4.0';

interface VCardProperty {
  group: string | null;
  /** Upper case. */
  name: string;
  /** Upper-case keys; values as written, without quotes, RFC 6868 caret escapes decoded. */
  params: Record<string, string[]>;
  /** The value after its transfer encoding and character set, still vCard-escaped. Base64 data stays base64 text. */
  value: string;
  /** The decoded bytes of an ENCODING=b/BASE64 value. */
  binary?: Buffer;
}

interface VCardCard {
  /** Counts from 1 in file order. */
  number: number;
  version: VCardVersion | null;
  properties: VCardProperty[];
}

interface VCardReadResult {
  cards: VCardCard[];
  warnings: ImportWarning[];
  /** The encoding the file was read in: from its BOM, else utf-8 when it decodes cleanly, else windows-1252. */
  encoding: string;
}

const warn = (card: number | null, property: string | null, code: string, message: string): ImportWarning => ({ card, property, code, message });

// ── Bytes to the file's encoding ───────────────────────────────────────

/**
 * Strips a byte order mark and settles the file's encoding. UTF-16 files are
 * re-encoded as UTF-8 so the tokenizer can always split lines on single
 * bytes; any other file stays as it is, with its single-byte or UTF-8 bytes.
 */
function fileText(input: Buffer): { bytes: Buffer; encoding: string } {
  if (input.length >= 3 && input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf) return { bytes: input.subarray(3), encoding: 'utf-8' };
  if (input.length >= 2 && input[0] === 0xff && input[1] === 0xfe) return { bytes: Buffer.from(new TextDecoder('utf-16le').decode(input.subarray(2)), 'utf8'), encoding: 'utf-16le' };
  if (input.length >= 2 && input[0] === 0xfe && input[1] === 0xff) return { bytes: Buffer.from(new TextDecoder('utf-16be').decode(input.subarray(2)), 'utf8'), encoding: 'utf-16be' };
  return { bytes: input, encoding: isUtf8(input) ? 'utf-8' : 'windows-1252' };
}

/** The encoding the bytes of `fileText` are in (UTF-16 was re-encoded). */
const byteEncoding = (encoding: string) => encoding.startsWith('utf-16') ? 'utf-8' : encoding;

// A TextDecoder per label; null when ICU does not know the label.
const decoders = new Map<string, TextDecoder | null>();
function decoderFor(label: string): TextDecoder | null {
  const key = label.trim().toLowerCase();
  if (!decoders.has(key)) {
    let decoder: TextDecoder | null = null;
    try { decoder = new TextDecoder(key); } catch { decoder = null; }
    if (decoders.size < 64) decoders.set(key, decoder);
    else return decoder;
  }
  return decoders.get(key)!;
}

// ── Lines ──────────────────────────────────────────────────────────────

const SPACE = 0x20;
const TAB = 0x09;
const CR = 0x0d;
const LF = 0x0a;
const COLON = 0x3a;
const SEMICOLON = 0x3b;
const QUOTE = 0x22;
const EQUALS = 0x3d;

/** Physical lines as [start, end) offsets, split on CRLF, LF or a lone CR. */
function* physicalLines(bytes: Buffer): Generator<[number, number]> {
  let start = 0;
  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index];
    if (byte === LF) { yield [start, index]; start = index + 1; }
    else if (byte === CR) {
      yield [start, index];
      if (bytes[index + 1] === LF) index++;
      start = index + 1;
    }
  }
  if (start < bytes.length) yield [start, bytes.length];
}

const isBase64Byte = (byte: number) => (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || (byte >= 0x30 && byte <= 0x39)
  || byte === 0x2b || byte === 0x2f || byte === EQUALS || byte === SPACE || byte === TAB;

/** The property name at the start of a line ('item1.TEL;…' gives TEL), upper case, at most 64 bytes read. */
function leadingName(bytes: Buffer, start: number, end: number) {
  let nameStart = start;
  let index = start;
  const stop = Math.min(end, start + 128);
  for (; index < stop; index++) {
    const byte = bytes[index];
    if (byte === COLON || byte === SEMICOLON) break;
    if (byte === 0x2e) nameStart = index + 1;
  }
  return bytes.toString('latin1', nameStart, index).toUpperCase();
}

/**
 * One logical line being collected from its physical lines. It remembers
 * where its head ends (the first colon outside quotes) so a quoted-printable
 * soft break can be recognised without scanning the line again.
 */
class LogicalLine {
  parts: Buffer[] = [];
  length = 0;
  oversize = false;
  headEnd = -1;
  private inQuotes = false;
  private head: Buffer[] = [];
  quotedPrintable = false;
  base64Block = false;
  constructor(readonly name: string, readonly limit: number) {}

  append(chunk: Buffer) {
    if (this.oversize) return;
    if (this.length + chunk.length > this.limit) {
      this.oversize = true;
      this.parts = [];
      this.head = [];
      return;
    }
    if (this.headEnd < 0) this.scanHead(chunk);
    this.parts.push(chunk);
    this.length += chunk.length;
  }

  private scanHead(chunk: Buffer) {
    for (let index = 0; index < chunk.length; index++) {
      const byte = chunk[index];
      if (byte === QUOTE) this.inQuotes = !this.inQuotes;
      else if (byte === COLON && !this.inQuotes) {
        this.headEnd = this.length + index;
        this.head.push(chunk.subarray(0, index));
        const head = Buffer.concat(this.head).toString('latin1').toUpperCase();
        this.head = [];
        // 2.1 writes the encoding as a bare parameter; 3.0 and 2.1 as ENCODING=.
        this.quotedPrintable = /(?:^|;)(?:ENCODING=)?QUOTED-PRINTABLE(?:;|$)/.test(head);
        this.base64Block = /(?:^|;)(?:ENCODING=)?BASE64(?:;|$)/.test(head);
        return;
      }
    }
    if (this.head.length < 64) this.head.push(chunk);
  }

  /** True when the line so far ends in a quoted-printable soft break ("=" at the end of the value). */
  get softBreak() {
    if (!this.quotedPrintable || this.oversize || !this.parts.length) return false;
    const last = this.parts[this.parts.length - 1];
    return last.length > 0 && last[last.length - 1] === EQUALS && this.length - 1 > this.headEnd;
  }

  dropSoftBreak() {
    const last = this.parts[this.parts.length - 1];
    this.parts[this.parts.length - 1] = last.subarray(0, last.length - 1);
    this.length--;
  }

  bytes() { return Buffer.concat(this.parts, this.length); }
}

const BIG_PROPERTIES = new Set(['PHOTO', 'LOGO']);

/**
 * Logical lines: a line starting with a space or tab continues the previous
 * one (one whitespace character dropped); a quoted-printable value ending in
 * "=" continues on the next line as it is; a 2.1 base64 value continues on
 * lines of base64 characters until a blank line. Over-long lines come out
 * with `oversize` set and no bytes.
 */
function* logicalLines(bytes: Buffer): Generator<LogicalLine> {
  let current: LogicalLine | null = null;
  for (const [start, end] of physicalLines(bytes)) {
    const first = start < end ? bytes[start] : -1;
    if (current) {
      if (current.softBreak) {
        current.dropSoftBreak();
        current.append(bytes.subarray(start, end));
        continue;
      }
      if (first === SPACE || first === TAB) {
        current.append(bytes.subarray(start + 1, end));
        continue;
      }
      if (current.base64Block && start < end && isBase64Line(bytes, start, end)) {
        current.append(bytes.subarray(start, end));
        continue;
      }
      yield current;
      current = null;
    }
    if (start === end) continue;
    const name = leadingName(bytes, start, end);
    // Base64 of the largest photo plus line breaks; everything else is bounded by lineBytes.
    const limit = BIG_PROPERTIES.has(name) ? Math.ceil(IMPORT_LIMITS.photoBytes / 3) * 4 + 1024 * 1024 : IMPORT_LIMITS.lineBytes;
    current = new LogicalLine(name, limit);
    current.append(bytes.subarray(start, end));
  }
  if (current) yield current;
}

function isBase64Line(bytes: Buffer, start: number, end: number) {
  for (let index = start; index < end; index++) if (!isBase64Byte(bytes[index])) return false;
  return true;
}

// ── Properties ─────────────────────────────────────────────────────────

/** Splits on `separator` outside double quotes. */
function splitOutsideQuotes(text: string, separator: string) {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    if (char === separator && !quoted) { parts.push(current); current = ''; continue; }
    current += char;
  }
  parts.push(current);
  return parts;
}

// RFC 6868: ^n is a newline, ^^ a caret, ^' a double quote.
function caretDecode(text: string) {
  if (!text.includes('^')) return text;
  let out = '';
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '^' && (next === 'n' || next === 'N')) { out += '\n'; index++; }
    else if (char === '^' && next === '^') { out += '^'; index++; }
    else if (char === '^' && next === "'") { out += '"'; index++; }
    else out += char;
  }
  return out;
}

const unquote = (text: string) => (text.length >= 2 && text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text);

const BARE_ENCODINGS = new Set(['QUOTED-PRINTABLE', 'BASE64', 'B', '8BIT', '7BIT']);
const NAME_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Parameters of a head (without the name). 2.1 bare parameters become TYPE
 * values (or ENCODING), and Android's `X-CUSTOM(…)` label is one bare value.
 * TYPE splits on every comma, quoted or not (4.0 writes TYPE="work,voice");
 * other parameters split on commas outside quotes.
 */
function parseParams(segments: readonly string[]): Record<string, string[]> {
  const params: Record<string, string[]> = {};
  const add = (key: string, values: string[]) => { (params[key] ||= []).push(...values); };
  for (const segment of segments) {
    if (!segment) continue;
    const equals = segment.indexOf('=');
    if (equals < 0 || /^X-CUSTOM\(/i.test(segment)) {
      const bare = segment.trim();
      if (BARE_ENCODINGS.has(bare.toUpperCase())) add('ENCODING', [bare.toUpperCase()]);
      else add('TYPE', [bare]);
      continue;
    }
    const key = segment.slice(0, equals).trim().toUpperCase();
    if (!NAME_PATTERN.test(key)) continue;
    const raw = segment.slice(equals + 1);
    const values = key === 'TYPE'
      ? splitOutsideQuotes(raw, ',').flatMap(value => unquote(value.trim()).split(','))
      : splitOutsideQuotes(raw, ',').map(value => unquote(value.trim()));
    add(key, values.map(caretDecode).filter(value => value !== ''));
  }
  return params;
}

/** Quoted-printable to bytes; a malformed escape is kept as written. */
function decodeQuotedPrintable(bytes: Buffer): Buffer {
  const out = Buffer.allocUnsafe(bytes.length);
  let length = 0;
  const hex = (byte: number) => (byte >= 0x30 && byte <= 0x39 ? byte - 0x30 : byte >= 0x41 && byte <= 0x46 ? byte - 0x37 : byte >= 0x61 && byte <= 0x66 ? byte - 0x57 : -1);
  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index];
    if (byte === EQUALS && index + 2 < bytes.length && hex(bytes[index + 1]) >= 0 && hex(bytes[index + 2]) >= 0) {
      out[length++] = hex(bytes[index + 1]) * 16 + hex(bytes[index + 2]);
      index += 2;
    } else if (byte === EQUALS && (bytes[index + 1] === CR || bytes[index + 1] === LF)) {
      // A soft break that survived unfolding.
      index += bytes[index + 1] === CR && bytes[index + 2] === LF ? 2 : 1;
    } else out[length++] = byte;
  }
  return out.subarray(0, length);
}

function decodeBase64(text: string) {
  // One character class, no backtracking: linear.
  const compact = text.replace(/[ \t\r\n]+/g, '');
  return { compact, bytes: Buffer.from(compact, 'base64') };
}

interface PropertyOutcome { property?: VCardProperty; warning?: ImportWarning }

function parseProperty(line: Buffer, headEnd: number, fileEncoding: string, card: number): PropertyOutcome {
  if (headEnd < 0) return { warning: warn(card, null, 'LINE_UNREADABLE', 'A line without a property name was skipped') };
  const fileDecoder = decoderFor(fileEncoding)!;
  const head = fileDecoder.decode(line.subarray(0, headEnd));
  const segments = splitOutsideQuotes(head, ';');
  const qualified = segments[0].trim();
  const dot = qualified.lastIndexOf('.');
  const group = dot > 0 ? qualified.slice(0, dot) : null;
  const name = (dot > 0 ? qualified.slice(dot + 1) : qualified).toUpperCase();
  if (!NAME_PATTERN.test(name) || (group !== null && !NAME_PATTERN.test(group))) {
    return { warning: warn(card, null, 'LINE_UNREADABLE', 'A line with an unreadable property name was skipped') };
  }
  const params = parseParams(segments.slice(1));
  const valueBytes = line.subarray(headEnd + 1);
  const encoding = (params.ENCODING?.[0] || '').toUpperCase();
  const charset = params.CHARSET?.[0];
  delete params.ENCODING;
  delete params.CHARSET;
  if (encoding === 'B' || encoding === 'BASE64') {
    const { compact, bytes } = decodeBase64(valueBytes.toString('latin1'));
    const limit = BIG_PROPERTIES.has(name) ? IMPORT_LIMITS.photoBytes : IMPORT_LIMITS.lineBytes;
    if (bytes.length > limit) return { warning: warn(card, name, 'VALUE_TOO_LARGE', `${name} is larger than ${Math.round(limit / 1024 / 1024)} MB and was not read`) };
    return { property: { group, name, params, value: compact, binary: bytes } };
  }
  const raw = encoding === 'QUOTED-PRINTABLE' ? decodeQuotedPrintable(valueBytes) : valueBytes;
  let decoder = fileDecoder;
  let warning: ImportWarning | undefined;
  if (charset) {
    const named = decoderFor(charset);
    if (named) decoder = named;
    else warning = warn(card, name, 'UNKNOWN_CHARSET', `${name} names a character set UniHub does not know; it was read as ${fileEncoding}`);
  }
  return { property: { group, name, params, value: decoder.decode(raw) }, warning };
}

// ── Cards ──────────────────────────────────────────────────────────────

const lineIs = (line: LogicalLine, bytes: Buffer, word: string) => {
  if (line.oversize || line.headEnd < 0 || line.headEnd > 16 || bytes.length - line.headEnd > 32) return false;
  const head = bytes.toString('latin1', 0, line.headEnd).trim().toUpperCase();
  const value = bytes.toString('latin1', line.headEnd + 1).trim().toUpperCase();
  return head === word && value === 'VCARD';
};

const VERSIONS: Readonly<Record<string, VCardVersion>> = { '2.1': '2.1', '3.0': '3.0', '4.0': '4.0' };

/**
 * Reads every card of a vCard file. Refuses a file over the size or card
 * bounds; anything smaller that is wrong costs a property or a card and a
 * warning, never the whole file.
 */
function readVCards(input: Buffer): VCardReadResult {
  if (input.length > IMPORT_LIMITS.fileBytes) throw badRequest('IMPORT_TOO_LARGE', 'The file is larger than 64 MB.');
  const { bytes, encoding } = fileText(input);
  const fileEncoding = byteEncoding(encoding);
  const cards: VCardCard[] = [];
  const warnings: ImportWarning[] = [];
  let card: VCardCard | null = null;
  let nested: { depth: number; agent: VCardProperty | null; lines: string[]; size: number } | null = null;
  let propertyLimitWarned = false;
  const close = (closed: boolean) => {
    if (!card) return;
    if (!closed) warnings.push(warn(card.number, null, 'CARD_NOT_CLOSED', 'The contact did not end with END:VCARD; what was read is kept'));
    cards.push(card);
    card = null;
  };
  for (const line of logicalLines(bytes)) {
    if (line.oversize) {
      if (card) warnings.push(warn(card.number, line.name, 'LINE_TOO_LONG', `${line.name} is longer than the limit and was not read`));
      continue;
    }
    const text = line.bytes();
    if (nested) {
      // A 2.1 AGENT: the inner card's lines become the AGENT value.
      if (lineIs(line, text, 'BEGIN')) nested.depth++;
      else if (lineIs(line, text, 'END')) nested.depth--;
      if (nested.size + text.length <= IMPORT_LIMITS.lineBytes) { nested.lines.push(decoderFor(fileEncoding)!.decode(text)); nested.size += text.length; }
      if (nested.depth === 0) {
        if (nested.agent) nested.agent.value = nested.lines.join('\n');
        nested = null;
      }
      continue;
    }
    if (lineIs(line, text, 'BEGIN')) {
      const current: VCardCard | null = card;
      const last = current ? current.properties[current.properties.length - 1] : undefined;
      if (current && last && last.name === 'AGENT' && !last.value.trim()) {
        nested = { depth: 1, agent: last, lines: [decoderFor(fileEncoding)!.decode(text)], size: text.length };
        continue;
      }
      close(false);
      if (cards.length >= IMPORT_LIMITS.cards) {
        throw badRequest('IMPORT_TOO_MANY_CARDS', `The file holds more than ${IMPORT_LIMITS.cards.toLocaleString('en')} contacts. Split it and import the parts.`);
      }
      card = { number: cards.length + 1, version: null, properties: [] };
      propertyLimitWarned = false;
      continue;
    }
    if (!card) continue;
    if (lineIs(line, text, 'END')) { close(true); continue; }
    const outcome = parseProperty(text, line.headEnd, fileEncoding, (card as VCardCard).number);
    const open = card as VCardCard;
    if (outcome.warning) warnings.push(outcome.warning);
    const property = outcome.property;
    if (!property) continue;
    if (property.name === 'VERSION') { open.version = VERSIONS[property.value.trim()] ?? open.version; continue; }
    if (open.properties.length >= IMPORT_LIMITS.propertiesPerCard) {
      if (!propertyLimitWarned) warnings.push(warn(open.number, null, 'TOO_MANY_PROPERTIES', `The contact has more than ${IMPORT_LIMITS.propertiesPerCard} details; the rest were not read`));
      propertyLimitWarned = true;
      continue;
    }
    open.properties.push(property);
  }
  if (nested && card) warnings.push(warn((card as VCardCard).number, 'AGENT', 'CARD_NOT_CLOSED', 'A contact inside the contact did not end'));
  close(false);
  return { cards, warnings, encoding };
}

/** True when the bytes look like a vCard file (its first line, after a BOM and blank lines, is BEGIN:VCARD). */
function looksLikeVCard(input: Buffer) {
  const { bytes } = fileText(input.subarray(0, 4096));
  const text = bytes.toString('latin1').trimStart();
  return /^BEGIN\s*:\s*VCARD/i.test(text);
}

export { readVCards, looksLikeVCard, fileText, byteEncoding, decoderFor, decodeQuotedPrintable, splitOutsideQuotes, IMPORT_LIMITS };
export type { VCardProperty, VCardCard, VCardReadResult, VCardVersion };
