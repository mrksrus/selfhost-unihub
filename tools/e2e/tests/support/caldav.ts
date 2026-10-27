import { request } from 'node:https';
import { readFileSync } from 'node:fs';
import { stack } from './env.ts';

// A CalDAV client as another program would be, to see what UniHub stored on the
// server and to make the changes another client would make. The stack's Radicale
// has a "calendar" (VEVENT) and a "tasks" (VTODO) collection per provider mailbox
// (tools/e2e/support/seed.mjs); a real provider is reached with its own credentials.
export interface DavLogin { username: string; password: string; ca?: string }
/** A stack mailbox (e.g. admin@mail.test) or another server's login. */
export type Who = string | DavLogin;

const stackCa = readFileSync(stack.caFile, 'utf8');
const login = (who: Who): DavLogin => typeof who === 'string' ? { username: who, password: stack.providerPassword, ca: stackCa } : who;

interface DavResponse { status: number; headers: Record<string, string | string[] | undefined>; body: string }

function dav(method: string, url: string, who: Who, body?: string, headers: Record<string, string> = {}): Promise<DavResponse> {
  const { username, password, ca } = login(who);
  const auth = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  return new Promise((resolve, reject) => {
    const req = request(url, { method, ...(ca ? { ca } : {}), headers: { Authorization: auth, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error(`CalDAV ${method} timed out`)));
    req.end(body);
  });
}

/** A stack mailbox's collection on Radicale. */
export const collectionUrl = (mailbox: string, collection: 'calendar' | 'tasks' = 'calendar') => `${stack.caldavUrl}${mailbox}/${collection}/`;

export interface DavObject { href: string; url: string; etag: string; ics: string }

const unescapeXml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#13;/g, '\r').replace(/&amp;/g, '&');
const responses = (xml: string) => [...xml.matchAll(/<(?:\w+:)?response\b[^>]*>([\s\S]*?)<\/(?:\w+:)?response>/g)].map((m) => m[1]);

/** Every object in a calendar collection, with its iCalendar text. */
export async function listObjects(collection: string, who: Who): Promise<DavObject[]> {
  const res = await dav('REPORT', collection, who,
    '<?xml version="1.0"?><C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">'
    + '<D:prop><D:getetag/><C:calendar-data/></D:prop><C:filter><C:comp-filter name="VCALENDAR"/></C:filter></C:calendar-query>',
    { Depth: '1', 'Content-Type': 'application/xml' });
  if (res.status !== 207) throw new Error(`CalDAV REPORT: ${res.status}`);
  const objects: DavObject[] = [];
  for (const block of responses(res.body)) {
    const href = /<(?:\w+:)?href>([^<]+)</.exec(block)?.[1];
    const data = /<(?:\w+:)?calendar-data[^>]*>([\s\S]*?)<\/(?:\w+:)?calendar-data>/.exec(block)?.[1];
    if (!href || !data) continue;
    // Radicale escapes the text, Stalwart wraps it in CDATA.
    const cdata = /^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/.exec(data);
    objects.push({ href, url: new URL(href, collection).href, etag: unescapeXml(/<(?:\w+:)?getetag>([^<]+)</.exec(block)?.[1] ?? ''),
      ics: cdata ? cdata[1] : unescapeXml(data) });
  }
  return objects;
}

/** One property of the first component in an iCalendar text (unfolded, parameters dropped, text unescaped). */
export function icsValue(ics: string, name: string): string | undefined {
  const unfolded = ics.replace(/\r?\n[ \t]/g, '');
  const line = new RegExp(`^${name}(?:;[^:\\r\\n]*)?:(.*)$`, 'm').exec(unfolded)?.[1];
  return line?.replace(/\r$/, '').replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
}

/** Polls until an object with this SUMMARY is in the collection, and returns it. */
export async function waitForSummary(collection: string, who: Who, summary: string, timeout = 60_000) {
  const end = Date.now() + timeout;
  for (;;) {
    const found = (await listObjects(collection, who)).find((object) => icsValue(object.ics, 'SUMMARY') === summary);
    if (found) return found;
    if (Date.now() > end) throw new Error(`no CalDAV object "${summary}" within ${timeout / 1000} s`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/** Writes an object as another client would; with an ETag it only replaces that version. */
export async function putObject(url: string, who: Who, ics: string, etag?: string) {
  const res = await dav('PUT', url, who, ics, { 'Content-Type': 'text/calendar; charset=utf-8', ...(etag ? { 'If-Match': etag } : { 'If-None-Match': '*' }) });
  if (res.status !== 201 && res.status !== 204) throw new Error(`CalDAV PUT: ${res.status}`);
}

/**
 * Changes an object as another client would: read it, write the change against the
 * ETag it read, and on a conflict (412: changed meanwhile) read it again. Returns the
 * object as it was read for the successful write.
 */
export async function editObject(collection: string, who: Who, summary: string, edit: (ics: string) => string) {
  for (let attempt = 0; ; attempt++) {
    const current = await waitForSummary(collection, who, summary);
    const res = await dav('PUT', current.url, who, edit(current.ics), { 'Content-Type': 'text/calendar; charset=utf-8', 'If-Match': current.etag });
    if (res.status === 201 || res.status === 204) return current;
    if (res.status !== 412 || attempt >= 4) throw new Error(`CalDAV PUT: ${res.status}`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

export async function deleteObject(url: string, who: Who) {
  const res = await dav('DELETE', url, who);
  if (![200, 204, 404].includes(res.status)) throw new Error(`CalDAV DELETE: ${res.status}`);
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** A one-event iCalendar text in UTC. */
export function eventIcs({ uid, summary, start, end, description }: { uid: string; summary: string; start: Date; end: Date; description?: string }) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//UniHub e2e//Synthetic client//EN', 'BEGIN:VEVENT', `UID:${uid}`,
    `DTSTAMP:${stamp(new Date())}`, `DTSTART:${stamp(start)}`, `DTEND:${stamp(end)}`, `SUMMARY:${summary}`,
    ...(description ? [`DESCRIPTION:${description}`] : []), 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
}

/** Replaces one property's value in an iCalendar text, keeping the rest of the object. */
export function withValue(ics: string, name: string, value: string) {
  const unfolded = ics.replace(/\r?\n[ \t]/g, '');
  return unfolded.replace(new RegExp(`^${name}(;[^:\\r\\n]*)?:.*$`, 'm'), (_, params: string | undefined) => `${name}${params ?? ''}:${value}`);
}
