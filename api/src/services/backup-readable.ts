// The readable side of a user archive (D37, 0.28.0). Inside the encrypted
// envelope (backup-envelope.ts), unihub-backup.zip holds:
//
//   Mail/<account>/<folder>/<NNNNN> <date> <subject>.eml   the stored raw message
//   Recordings/<title>.<ext>                               the original audio
//   Contacts/Contacts.vcf                                  vCard 4.0, derived
//   Calendars/<calendar>.ics                               iCalendar, derived
//   UniHub restore data/                                   what restore reads
//
// Messages and recordings are the canonical stored files: backup.json names
// them by these paths and restore reads them from there, so each byte is
// stored once. Contacts and calendars are copies made for other programs;
// restore reads backup.json, never them; they are made from the same
// snapshot. Names are made portable to Windows, macOS and Linux
// (portableName) and unique within their folder, files and folders together,
// case-insensitively and as NFC, as on the file systems of Windows and macOS
// (PathTree).
import type { BackupRow } from '../types';
import type { ExportContact } from './contacts-vcard-write';
import fs from 'node:fs';
import { RESTORE_DATA_DIRECTORY } from './backup-format';
import { getBackupArchivePath } from './backup-common';
import { writeVCards } from './contacts-vcard-write';
import { parseDatetimeToMillis } from './calendar';
import { allDayRange, isValidTimeZone, resolveUserTimeZone } from './calendar-ical';

const ICAL: typeof import('ical.js').default = require('ical.js');

const PRODID = '-//UniHub//Backup//EN';
const CONTACTS_ENTRY = 'Contacts/Contacts.vcf';
const VCARD_SLICE = 200;
// Windows reserves these device names, with or without an extension.
const RESERVED_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;
// Control characters, the characters Windows forbids in a name, and
// direction overrides, which could make "gpj.exe" read as "exe.jpg".
// eslint-disable-next-line no-control-regex -- the control characters are what it refuses
const UNSAFE_CHARACTERS = /[\u0000-\u001f\u007f-\u009f<>:"/\\|?*\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

const asRows = (value: unknown) => Array.isArray(value) ? value as BackupRow[] : [];

function truncateBytes(value: string, maxBytes: number) {
  let out = '';
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > maxBytes) break;
    out += character;
    bytes += size;
  }
  return out;
}

/**
 * One file or folder name that Windows, macOS and Linux all accept, at most
 * maxBytes of UTF-8 (file systems allow 255): no forbidden or control
 * characters, no trailing dot or space, no leading dot (a hidden file, or
 * "..") and no reserved device name. Idempotent.
 */
function portableName(value: unknown, { maxBytes = 120, fallback = 'Untitled' }: { maxBytes?: number; fallback?: string } = {}) {
  let name = String(value ?? '').normalize('NFC').replace(UNSAFE_CHARACTERS, '_').replace(/\s+/g, ' ').trim();
  name = truncateBytes(name, maxBytes).replace(/[. ]+$/, '').replace(/^\.+/, dots => '_'.repeat(dots.length));
  if (!name) name = fallback;
  if (RESERVED_NAME.test(name.split('.')[0].trimEnd())) name = `_${name}`;
  return name;
}

/** The character rules of portableName for each part of an entry path, without its length limit (export-jobs.ts writeZip). */
function portableZipPath(value: unknown) {
  return String(value || 'file')
    .replace(/\\/g, '/')
    .split('/')
    .filter(part => part && part !== '.' && part !== '..')
    .map(part => portableName(part, { maxBytes: Number.MAX_SAFE_INTEGER, fallback: 'item' }))
    .join('/');
}

interface PathNode { path: string; names: Map<string, string>; folders: Map<string, PathNode>; files: number }
const folded = (name: string) => name.normalize('NFC').toLowerCase();
const pathNode = (path: string): PathNode => ({ path, names: new Map(), folders: new Map(), files: 0 });

/**
 * The names of an archive as a tree: in each folder, files and subfolders
 * share one set of names compared as Windows and macOS compare them, so a
 * file never takes a name a folder needs (or the reverse) and "Memo" and
 * "memo" never meet. A folder is found again by the identity of what it
 * stands for (a source folder), so two sources whose portable names agree
 * ("Work:Docs", "Work?Docs") get two folders: "Work_Docs" and "Work_Docs (2)".
 */
class PathTree {
  private root = pathNode('');

  private free(parent: PathNode, base: string, extension: string, owner: string) {
    let name = `${base}${extension}`;
    for (let copy = 2; parent.names.has(folded(name)); copy += 1) name = `${base} (${copy})${extension}`;
    parent.names.set(folded(name), owner);
    return name;
  }

  /** The folder `name` in `parent` that stands for `identity`, made on first use. */
  folder(parent: PathNode | null, name: string, identity = name) {
    const at = parent || this.root;
    const known = at.folders.get(identity);
    if (known) return known;
    const chosen = this.free(at, name, '', `folder:${identity}`);
    const node = pathNode(at.path ? `${at.path}/${chosen}` : chosen);
    at.folders.set(identity, node);
    return node;
  }

  /** A new file `base` + `extension` in `parent`; its full path. */
  file(parent: PathNode, base: string, extension = '') {
    parent.files += 1;
    return `${parent.path}/${this.free(parent, base, extension, 'file')}`;
  }
}

/** Unique file names in plain folders (named by their path): a second "Notes.ics" becomes "Notes (2).ics". */
class NameRegistry {
  private tree = new PathTree();

  take(directory: string, base: string, extension = '') {
    let node: PathNode | null = null;
    for (const part of directory.split('/')) node = this.tree.folder(node, part);
    return this.tree.file(node!, base, extension);
  }
}

function utcDate(value: unknown) {
  const ms = parseDatetimeToMillis(value);
  return ms === null ? 'undated' : new Date(ms).toISOString().slice(0, 10);
}

const AUDIO_EXTENSIONS: Readonly<Record<string, string>> = Object.freeze({
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg',
  'audio/opus': 'opus', 'audio/webm': 'webm', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/flac': 'flac', 'audio/x-flac': 'flac',
});
function recordingExtension(row: BackupRow | undefined, storedName: unknown) {
  for (const name of [row?.original_filename, storedName]) {
    const match = /\.([a-z0-9]{1,8})$/i.exec(String(name ?? ''));
    if (match) return `.${match[1].toLowerCase()}`;
  }
  const type = String(row?.content_type ?? '').split(';')[0].trim().toLowerCase();
  return `.${AUDIO_EXTENSIONS[type] || 'bin'}`;
}

interface ArchiveFile { kind?: unknown; id?: unknown; filename?: unknown }

/**
 * The entry path of each file of the archive, by `${kind}:${id}`: messages
 * under Mail/, recordings under Recordings/, everything else (attachments,
 * photos, the Bin's recordings) under "UniHub restore data/files/".
 */
function readableArchivePaths(data: Record<string, unknown>, files: readonly ArchiveFile[]) {
  const tree = new PathTree();
  const paths = new Map<string, string>();
  const emails = new Map(asRows(data.emails).map(row => [String(row.id), row]));
  const accounts = new Map(asRows(data.mail_accounts).map(row => [String(row.id), row]));
  const folders = new Map(asRows(data.mail_folders).map(row => [String(row.slug), row]));
  const recordings = new Map(asRows(data.recordings).map(row => [String(row.id), row]));

  const messages = files.filter(file => file.kind === 'raw_email' && emails.has(String(file.id)))
    .map(file => ({ file, email: emails.get(String(file.id))! }))
    .sort((a, b) => (parseDatetimeToMillis(a.email.received_at) ?? 0) - (parseDatetimeToMillis(b.email.received_at) ?? 0)
      || String(a.email.id).localeCompare(String(b.email.id)));
  // Every folder first, by the source it stands for (account, then each
  // level of the folder's own path), so folders keep their names and the
  // messages take the names left in them.
  const mailRoot = tree.folder(null, 'Mail');
  const folderOf = (email: BackupRow) => {
    const accountId = String(email.mail_account_id ?? '');
    const account = accounts.get(accountId);
    let node = tree.folder(mailRoot, portableName(account?.email_address, { maxBytes: 64, fallback: 'Local mail' }), `account:${accountId}`);
    const folder = folders.get(String(email.folder));
    const parts = String(folder?.display_name || email.folder || 'Inbox').split('/').filter(part => part.trim()).slice(0, 8);
    for (const [level, part] of (parts.length ? parts : ['Inbox']).entries()) {
      node = tree.folder(node, portableName(part, { maxBytes: 64, fallback: 'Folder' }), `${accountId}\0${parts.slice(0, level + 1).join('/')}`);
    }
    return node;
  };
  const placed = messages.map(message => ({ ...message, folder: folderOf(message.email) }));
  for (const { file, email, folder } of placed) {
    const number = folder.files + 1;
    const base = portableName(`${String(number).padStart(5, '0')} ${utcDate(email.received_at)} ${String(email.subject ?? '').trim() || '(no subject)'}`, { maxBytes: 100 });
    paths.set(`raw_email:${file.id}`, tree.file(folder, base, '.eml'));
  }
  const recordingRoot = tree.folder(null, 'Recordings');
  for (const file of files) {
    if (file.kind !== 'recording') continue;
    const row = recordings.get(String(file.id));
    paths.set(`recording:${file.id}`, tree.file(recordingRoot, portableName(row?.title, { maxBytes: 100, fallback: 'Recording' }), recordingExtension(row, file.filename)));
  }
  for (const file of files) {
    const key = `${file.kind}:${file.id}`;
    if (!paths.has(key)) paths.set(key, `${RESTORE_DATA_DIRECTORY}/${portableZipPath(getBackupArchivePath(file))}`);
  }
  return paths;
}

/**
 * The archive's contacts as one vCard 4.0 file, written in slices to
 * outPath; null without contacts. The cards are the ones the backup's
 * snapshot read (backup-export.ts readBackupSnapshot), so the file holds the
 * contacts backup.json holds; each photo comes from the archive's own copy
 * of its file (by SHA-256), and a card whose photo is not there goes without.
 */
async function writeContactsVcf(cards: readonly ExportContact[], photoFiles: ReadonlyMap<string, string>, outPath: string, checkCancelled: (() => unknown) | null) {
  if (!cards.length) return null;
  const out = await fs.promises.open(outPath, 'wx', 0o600);
  let count = 0;
  try {
    for (let start = 0; start < cards.length; start += VCARD_SLICE) {
      if (checkCancelled) await checkCancelled();
      const slice = await Promise.all(cards.slice(start, start + VCARD_SLICE).map(async card => {
        const file = card.contact.photo ? photoFiles.get(card.contact.photo.etag) : undefined;
        const data = file ? await fs.promises.readFile(file).catch(() => null) : null;
        return { ...card, photo: data ? { data, media_type: 'image/jpeg' } : null };
      }));
      count += slice.length;
      await out.write(Buffer.from(writeVCards(slice, '4.0'), 'utf8'));
    }
    await out.close();
  } catch (error) {
    await out.close().catch(() => {});
    await fs.promises.rm(outPath, { force: true }).catch(() => {});
    throw error;
  }
  return count;
}

function utcTime(ms: number) {
  return ICAL.Time.fromJSDate(new Date(ms), true);
}

function addText(component: InstanceType<typeof ICAL.Component>, name: string, value: unknown) {
  if (value != null && String(value).trim() !== '') component.addPropertyWithValue(name, String(value));
}

// A ToDo state as iCalendar says it: a task's STATUS and COMPLETED, an
// event's CANCELLED; UniHub's own states (changed, time moved) as an X- property.
const TASK_STATUS: Readonly<Record<string, string>> = Object.freeze({ done: 'COMPLETED', cancelled: 'CANCELLED' });

/**
 * One calendar's local events and tasks as iCalendar: a VEVENT per event, a
 * VTODO per ToDo-only item, and each subtask as a VTODO related to its
 * parent. Times are written in UTC; all-day events as dates in timeZone with
 * the exclusive end the calendar's own writer gives them (allDayRange). A
 * ToDo-only item has no date in UniHub (its stored times are placeholders),
 * so its VTODO has neither DTSTART nor DUE.
 */
function calendarIcs(name: string, events: readonly BackupRow[], subtasks: readonly BackupRow[], timeZone: string, now = Date.now()) {
  const calendar = new ICAL.Component('vcalendar');
  calendar.addPropertyWithValue('version', '2.0');
  calendar.addPropertyWithValue('prodid', PRODID);
  calendar.addPropertyWithValue('x-wr-calname', name);
  const byEvent = new Map<string, BackupRow[]>();
  for (const subtask of subtasks) byEvent.set(String(subtask.event_id), [...(byEvent.get(String(subtask.event_id)) || []), subtask]);
  for (const event of events) {
    const startMs = parseDatetimeToMillis(event.start_time);
    const endMs = parseDatetimeToMillis(event.end_time);
    if (startMs === null) continue;
    const task = event.is_todo_only === true || event.is_todo_only === 1 || event.is_todo_only === '1';
    const item = new ICAL.Component(task ? 'vtodo' : 'vevent');
    const uid = String(event.uid || event.id);
    item.addPropertyWithValue('uid', uid);
    item.addPropertyWithValue('dtstamp', utcTime(now));
    addText(item, 'summary', event.title);
    addText(item, 'description', event.description);
    addText(item, 'location', event.location);
    const allDay = event.all_day === true || event.all_day === 1 || event.all_day === '1';
    if (task) {
      // Undated: no DTSTART or DUE.
    } else if (allDay) {
      const range = allDayRange(startMs, endMs ?? startMs, timeZone);
      item.addPropertyWithValue('dtstart', range.start);
      item.addPropertyWithValue('dtend', range.end);
    } else {
      item.addPropertyWithValue('dtstart', utcTime(startMs));
      item.addPropertyWithValue('dtend', utcTime(Math.max(endMs ?? startMs, startMs)));
    }
    if (typeof event.recurrence === 'string' && /^FREQ=[A-Z]+(;[A-Z]+=[A-Za-z0-9,:+-]+)*$/.test(event.recurrence)) {
      try { item.addPropertyWithValue('rrule', ICAL.Recur.fromString(event.recurrence)); } catch { /* left out: not a rule iCalendar reads */ }
    }
    const state = typeof event.todo_status === 'string' ? event.todo_status : null;
    if (task) {
      item.addPropertyWithValue('status', (state && TASK_STATUS[state]) || 'NEEDS-ACTION');
      const doneMs = parseDatetimeToMillis(event.done_at);
      if (state === 'done' && doneMs !== null) item.addPropertyWithValue('completed', utcTime(doneMs));
    } else if (state === 'cancelled') {
      item.addPropertyWithValue('status', 'CANCELLED');
    }
    if (state) item.addPropertyWithValue('x-unihub-todo-status', state);
    calendar.addSubcomponent(item);
    const children = (byEvent.get(String(event.id)) || []).sort((a, b) => Number(a.position) - Number(b.position));
    for (const subtask of children) {
      const child = new ICAL.Component('vtodo');
      child.addPropertyWithValue('uid', `${uid}-subtask-${subtask.id}`);
      child.addPropertyWithValue('dtstamp', utcTime(now));
      addText(child, 'summary', subtask.title);
      const done = subtask.is_done === true || subtask.is_done === 1 || subtask.is_done === '1';
      child.addPropertyWithValue('status', done ? 'COMPLETED' : 'NEEDS-ACTION');
      const related = child.addPropertyWithValue('related-to', uid);
      related.setParameter('reltype', 'PARENT');
      calendar.addSubcomponent(child);
    }
  }
  return calendar.toString().replace(/\r?\n/g, '\r\n') + '\r\n';
}

/** The archive's local calendars as .ics files under Calendars/, one per calendar. */
function calendarEntries(data: Record<string, unknown>, timeZoneValue: unknown) {
  const timeZone = resolveUserTimeZone(isValidTimeZone(timeZoneValue) ? timeZoneValue : 'UTC');
  const events = asRows(data.calendar_events);
  if (!events.length) return [];
  const subtasks = asRows(data.calendar_event_subtasks);
  const calendars = asRows(data.calendar_calendars);
  const names = new NameRegistry();
  const entries: { name: string; data: Buffer }[] = [];
  const groups = new Map<string, BackupRow[]>();
  for (const event of events) groups.set(String(event.calendar_id ?? ''), [...(groups.get(String(event.calendar_id ?? '')) || []), event]);
  const ordered = [...calendars.filter(row => groups.has(String(row.id))), ...(groups.has('') ? [{ id: '', name: 'Calendar' } as BackupRow] : [])];
  for (const row of ordered) {
    const own = groups.get(String(row.id))!;
    const ids = new Set(own.map(event => String(event.id)));
    const label = String(row.name || 'Calendar');
    entries.push({
      name: names.take('Calendars', portableName(label, { maxBytes: 100, fallback: 'Calendar' }), '.ics'),
      data: Buffer.from(calendarIcs(label, own, subtasks.filter(subtask => ids.has(String(subtask.event_id))), timeZone), 'utf8'),
    });
  }
  return entries;
}

export {
  portableName,
  portableZipPath,
  NameRegistry,
  readableArchivePaths,
  writeContactsVcf,
  calendarIcs,
  calendarEntries,
  CONTACTS_ENTRY,
};
