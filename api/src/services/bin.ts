import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { SqlExecutor } from '../types';
import type {
  BinDeleteResponse, BinItem, BinItemType, BinListResponse, BinModule, BinReason, BinRestored, BinRestoreResponse, BinRetention,
} from '../contracts/bin';
import crypto from 'node:crypto';
import { db } from '../state';
import { badRequest, conflict, forbidden, notFound, ApiError } from '../http/errors';
import { withTransaction } from './transactions';
import { getActiveRestoreSections, getActiveRestoreSectionsByUser } from './restore-locks';
import { isModuleEnabled } from './module-settings';

// The bin (0.28, D13, P-31): what a person deletes in UniHub that has no
// trash of its own at a provider. Contacts, events and tasks (also those of a
// CalDAV calendar, which the provider deletes for good), recordings and local
// calendars with their events wait here for the person's retention
// (user.bin_retention); mail keeps its Trash folders.
//
// An item is a verbatim snapshot of its rows (payload, versioned) taken in
// the transaction that removes them, so the item leaves its tables: lists,
// search, offline snapshots and the phone's contacts sync drop it as before.
// Files stay where file_refs names them until the purge. Each kind restores
// its own rows (KINDS); items deleted together (a merge, a calendar with its
// events, several contacts at once) share a group and come back together.
//
// Every action checks each item's module and the restore lock of its
// section here, not at the route: one route serves every module. Deleting
// for good and emptying name the bin.delete policy on their routes (F13).
//
// A shared address book has a bin of its own (address_book_id instead of
// user_id): whoever may edit the book lists, restores and deletes its items,
// under their own module switch and bin.delete rule. It keeps items for the
// book retention (bookKeepDays), and the purge takes them, and a book
// deleted that long ago with its contacts, book by book.
//
// A calendar's bin works the same (calendar_id): whoever may edit the
// calendar sees and restores what was deleted from it. An item of a person's
// calendar stays theirs too (user_id and calendar_id); one of a calendar no
// person owns has no user_id, keeps the shared retention and goes with its
// calendar when the purge takes a deleted one.

interface BinRow extends RowDataPacket {
  id: string;
  user_id: string;
  address_book_id: string | null;
  calendar_id: string | null;
  module: BinModule;
  item_type: BinItemType;
  item_id: string;
  title: string;
  reason: BinReason;
  group_id: string | null;
  payload: string;
  payload_version: number;
  file_refs: unknown;
  deleted_at: Date | string;
  purge_after: Date | string | null;
  restored_at: Date | string | null;
}
interface NewBinItem {
  module: BinModule;
  itemType: BinItemType;
  itemId: string;
  title: string;
  reason: BinReason;
  groupId?: string | null;
  payload: unknown;
  fileRefs?: readonly string[] | null;
  /** The calendar an event or task was deleted from: its bin shows the item too. */
  calendarId?: string | null;
}
/** Where the person asked an item to go back to (calendar items: an owned calendar instead of its own). */
interface RestoreChoice { calendarId?: string | null }
/** What a kind's restore answers for each item of the group it was given. */
type KindRestore = (userId: string, items: readonly BinRow[], choice: RestoreChoice) => Promise<BinRestored[]>;
interface BinKind {
  restore: KindRestore;
  /** After the items' rows are deleted for good: their files. */
  release?: (userId: string, items: readonly BinRow[]) => Promise<void>;
}

const PAYLOAD_VERSION = 1;
// A page of the list holds up to this many items, in whole groups.
const LIST_MAX = 2000;
// A restore takes up to 500 items or groups; the ids of a group's members
// count once, so a list with all its events can be sent whole (up to 5000 ids).
const IDS_MAX = 500;
const IDS_SENT_MAX = 5000;
const PURGE_BATCH = 200;
/** The undo of a merge (0.26) is promised for 30 days, whatever the retention. */
const MERGE_UNDO_DAYS = 30;
const RETENTION_DAYS: Readonly<Record<BinRetention, number | null>> = { 7: 7, 30: 30, 90: 90, forever: null };
// null is 'forever'; an unknown value reads as the default.
const daysOf = (retention: BinRetention) => Object.prototype.hasOwnProperty.call(RETENTION_DAYS, retention) ? RETENTION_DAYS[retention] : RETENTION_DAYS[30];
const MODULES: readonly BinModule[] = ['contacts', 'calendar', 'recordings'];
const ID_PATTERN = /^[0-9a-f-]{36}$/i;
const TITLE_MAX = 255;
// A shared book's bin keeps items at least this long.
const BOOK_BIN_DAYS = 30;
type BinOwner = string | { bookId: string } | { calendarId: string };
const ownerColumn = (owner: BinOwner): ['user_id' | 'address_book_id' | 'calendar_id', string] =>
  typeof owner === 'string' ? ['user_id', owner] : 'bookId' in owner ? ['address_book_id', owner.bookId] : ['calendar_id', owner.calendarId];
const books = () => require('./address-books') as typeof import('./address-books');
const calendars = () => require('./calendar-shares') as typeof import('./calendar-shares');

// The kinds, required when used: their services put items in the bin and
// so require this file.
const KINDS: Readonly<Record<BinItemType, () => BinKind>> = {
  contact: () => (require('./contact-merge') as typeof import('./contact-merge')).contactBinKind,
  event: () => (require('./bin-calendar') as typeof import('./bin-calendar')).eventBinKind,
  task: () => (require('./bin-calendar') as typeof import('./bin-calendar')).eventBinKind,
  calendar: () => (require('./bin-calendar') as typeof import('./bin-calendar')).eventBinKind,
  recording: () => (require('./recordings') as typeof import('./recordings')).recordingBinKind,
};
// The item is live again under its own id (a backup restore brought it back): a restore would add a copy.
const alreadyBack = () => conflict('BIN_ITEM_ALREADY_BACK', 'This item is already back, for example from a backup restore. Delete it from the bin if you no longer need this version.');
const MODULE_OF: Readonly<Record<BinItemType, BinModule>> = { contact: 'contacts', event: 'calendar', task: 'calendar', calendar: 'calendar', recording: 'recordings' };
// Module ids and recovery sections coincide (module-catalog.ts).
const sectionOf = (module: BinModule) => module;
const placeholders = (items: readonly unknown[]) => items.map(() => '?').join(', ');
const iso = (value: Date | string) => (value instanceof Date ? value : new Date(`${String(value).replace(' ', 'T')}Z`)).toISOString();

function parsePayload<T>(row: Pick<BinRow, 'payload'>): T | null {
  try { return JSON.parse(String(row.payload)) as T; } catch { return null; }
}
function parseRefs(value: unknown): string[] {
  let refs = value;
  if (typeof refs === 'string') { try { refs = JSON.parse(refs); } catch { return []; } }
  return Array.isArray(refs) ? refs.filter((ref): ref is string => typeof ref === 'string') : [];
}

// --- Retention ------------------------------------------------------------

/**
 * The person's retention as the settings resolve it (F1): an administrator's
 * floor or locked value for user.bin_retention is part of it.
 */
async function binRetention(userId: string, executor: SqlExecutor = db): Promise<BinRetention> {
  const { getSettings } = require('./settings') as typeof import('./settings');
  return (await getSettings('user', userId, userId, executor)).bin_retention.value;
}

/** Days an item of this reason waits; null keeps it until restored or deleted. A merged contact waits at least the undo window. */
function retentionDays(retention: BinRetention, reason: BinReason) {
  const days = daysOf(retention);
  return days === null ? null : reason === 'merged' ? Math.max(days, MERGE_UNDO_DAYS) : days;
}

/**
 * The purge's question to the data-safety policies before it deletes a
 * person's items (the bin's minimum): while deleting from the bin for good is forbidden,
 * the administrator's minimum retention ('never' for forever). It is also
 * the floor of the person's resolved bin_retention (services/settings.ts);
 * asked again here, in the purge's own transaction, so a purge never goes
 * below it whatever the setting reads. Locked, after the purge's last
 * waiting lock: the policies as committed then, and an administrator's save
 * waits for the batch (settings.ts policyLevels).
 */
async function purgeFloorDays(userId: string, executor: SqlExecutor, { lock = false } = {}): Promise<number | null | 'never'> {
  const { binRetentionFloor } = require('./settings') as typeof import('./settings');
  const floor = await binRetentionFloor(userId, executor, { lock });
  return floor === null ? null : floor === 'forever' ? 'never' : Number(floor);
}

/**
 * How long a shared book's bin keeps items: 30 days, or longer while a bin
 * minimum of Everyone or of any group asks for it; null keeps them for good
 * (a minimum of forever, or deleting for good forbidden without a minimum).
 */
async function bookKeepDays(executor: SqlExecutor = db, { lock = false } = {}): Promise<number | null> {
  const { bookBinFloor } = require('./settings') as typeof import('./settings');
  const floor = await bookBinFloor(executor, { lock });
  return floor === null ? BOOK_BIN_DAYS : floor === 'forever' ? null : Math.max(BOOK_BIN_DAYS, Number(floor));
}

/**
 * After the person changed bin_retention: every open item's purge time from
 * its deletion and the new retention, so a longer choice keeps what is in
 * the bin longer and a shorter one lets it go sooner.
 */
async function applyBinRetention(userId: string, executor: SqlExecutor = db) {
  const retention = await binRetention(userId, executor);
  // The rows by primary key, as the purge and delete for good lock them.
  const [open] = await executor.execute<(RowDataPacket & { id: string; reason: BinReason })[]>(
    'SELECT id, reason FROM bin_items WHERE user_id = ? AND restored_at IS NULL ORDER BY id', [userId]);
  for (const reason of ['deleted', 'merged', 'calendar_deleted'] as const) {
    const days = retentionDays(retention, reason);
    const ids = open.filter(row => row.reason === reason).map(row => String(row.id));
    for (let start = 0; start < ids.length; start += PURGE_BATCH) {
      const chunk = ids.slice(start, start + PURGE_BATCH);
      await executor.execute(`UPDATE bin_items SET purge_after = ${days === null ? 'NULL' : 'deleted_at + INTERVAL ? DAY'}
        WHERE id IN (${placeholders(chunk)}) AND user_id = ? AND reason = ? AND restored_at IS NULL`, [...(days === null ? [] : [days]), ...chunk, userId, reason]);
    }
  }
}

// --- Putting items in the bin -------------------------------------------

/**
 * Inside the transaction that removes the items' rows. Returns the bin ids.
 * The kinds call this with their own snapshots.
 */
async function putInBin(connection: SqlExecutor, owner: BinOwner, items: readonly NewBinItem[]) {
  if (!items.length) return [];
  // A shared item is due after the shortest shared retention; the purge asks the minimum in force then.
  const retention = typeof owner === 'string' ? await binRetention(owner, connection) : String(BOOK_BIN_DAYS) as BinRetention;
  const [column, ownerId] = ownerColumn(owner);
  const ids: string[] = [];
  for (const item of items) {
    const id = crypto.randomUUID();
    const days = retentionDays(retention, item.reason);
    await connection.execute(`INSERT INTO bin_items (id, ${column}${column === 'user_id' ? ', calendar_id' : ''}, module, item_type, item_id, title, reason, group_id, payload, payload_version, file_refs, deleted_at, purge_after)
      VALUES (?, ?${column === 'user_id' ? ', ?' : ''}, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), ${days === null ? 'NULL' : 'UTC_TIMESTAMP() + INTERVAL ? DAY'})`, [
      id, ownerId, ...(column === 'user_id' ? [item.calendarId ?? null] : []), item.module, item.itemType, item.itemId, Array.from(item.title || '').slice(0, TITLE_MAX).join(''), item.reason, item.groupId ?? null,
      JSON.stringify(item.payload), PAYLOAD_VERSION, item.fileRefs?.length ? JSON.stringify(item.fileRefs) : null, ...(days === null ? [] : [days]),
    ]);
    ids.push(id);
  }
  return ids;
}

// --- Gates ------------------------------------------------------------------

const moduleOff = (module: BinModule) => forbidden('MODULE_DISABLED', 'This module is disabled. Enable it in Settings.', { module });
const restoring = (module: BinModule) => conflict('RESTORE_IN_PROGRESS', `Restore in progress for ${module}. This section is temporarily read-only.`);

/** Per module: why its items cannot be changed now, or nothing. */
async function moduleGates(userId: string, executor: SqlExecutor = db) {
  const sections = await getActiveRestoreSections(userId, executor);
  const gates = new Map<BinModule, ApiError | null>();
  for (const module of MODULES) {
    gates.set(module, !await isModuleEnabled(userId, module, executor) ? moduleOff(module) : sections.has(sectionOf(module)) ? restoring(module) : null);
  }
  return gates;
}

function parseIds(input: unknown): string[] {
  const ids = (input && typeof input === 'object' && !Array.isArray(input) ? (input as { ids?: unknown }).ids : null);
  if (!Array.isArray(ids) || !ids.length || ids.length > IDS_SENT_MAX || !ids.every(id => typeof id === 'string' && ID_PATTERN.test(id))) {
    throw tooMany();
  }
  return [...new Set(ids as string[])];
}
const tooMany = () => badRequest('BIN_INVALID', `Expected { ids: [...] }: up to ${IDS_MAX} bin items or groups`);

// The optional destination of a restore: calendar_id, one of the person's
// calendars (the calendar kind checks it is theirs and can take the item).
function parseChoice(input: unknown): RestoreChoice {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? (input as { calendar_id?: unknown }).calendar_id : undefined;
  if (value === undefined || value === null || value === '') return {};
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw badRequest('BIN_INVALID', 'calendar_id must be the id of one of your calendars');
  return { calendarId: value };
}

function parseBook(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw notFound('BOOK_NOT_FOUND', 'Address book not found');
  return value;
}

const bookRetention = (days: number | null): BinRetention => days === null ? 'forever' : String(days) as BinRetention;

function parseCalendar(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw notFound('CALENDAR_NOT_FOUND', 'Calendar not found');
  return value;
}

/** A calendar's bin keeps its owner's retention, or the shared one when no person owns it. */
async function calendarRetention(calendarId: string) {
  const [[row]] = await db.execute<RowDataPacket[]>('SELECT user_id FROM calendar_calendars WHERE id = ?', [calendarId]);
  return row?.user_id ? binRetention(String(row.user_id)) : bookRetention(await bookKeepDays());
}

function parseModule(value: unknown): BinModule | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !MODULES.includes(value as BinModule)) throw badRequest('BIN_INVALID', `module must be one of ${MODULES.join(', ')}`);
  return value as BinModule;
}

// --- Listing ----------------------------------------------------------------

/**
 * When the purge may take an item under the retention in force now: never
 * before its stored time, and no sooner than the retention (with the
 * administrator's minimum) allows; null when nothing will take it.
 * The stored time is only moved when the person changes their retention.
 */
function shownPurgeAfter(row: Pick<BinRow, 'purge_after' | 'deleted_at' | 'reason'>, retention: BinRetention) {
  const days = retentionDays(retention, row.reason);
  if (!row.purge_after || days === null) return null;
  const earliest = new Date(iso(row.deleted_at)).getTime() + days * 86400000;
  return new Date(Math.max(new Date(iso(row.purge_after)).getTime(), earliest)).toISOString();
}

// The list pages by units: a group (items deleted together, restored
// together) or an item of its own, so a page never splits a group. A unit
// sorts by its newest item's deletion, then by its key; `before` is the
// position of the last unit of the page before, nothing else: the queries
// read only the asking person's items, so a cursor of another person's list,
// or one made up, finds nothing that is not that person's own.
const UNIT = "IF(group_id IS NULL, CONCAT('i', id), CONCAT('g', group_id))";
interface Position { at: string; unit: string }
const CURSOR_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const UNIT_PATTERN = /^[gi][0-9a-f-]{36}$/i;
const cursorOf = ({ at, unit }: Position) => Buffer.from(JSON.stringify([at, unit])).toString('base64url');
function parseCursor(value: unknown): Position | null {
  if (value === undefined || value === null || value === '') return null;
  const invalid = () => badRequest('BIN_INVALID', 'This link to older bin items is not valid. Load the bin again from the newest items.');
  if (typeof value !== 'string' || value.length > 200 || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { throw invalid(); }
  if (!Array.isArray(parsed) || parsed.length !== 2) throw invalid();
  const [at, unit] = parsed;
  if (typeof at !== 'string' || !CURSOR_PATTERN.test(at) || !Number.isFinite(Date.parse(`${at.replace(' ', 'T')}Z`))
    || typeof unit !== 'string' || !UNIT_PATTERN.test(unit)) throw invalid();
  // Only the form this file writes: a changed character is refused, not read leniently.
  if (cursorOf({ at, unit }) !== value) throw invalid();
  return { at, unit };
}

/**
 * GET /api/bin?module=&before=: the open items of the person's enabled
 * modules, newest first, a page of whole groups at a time (up to LIST_MAX
 * items; a page's first group always whole, also a larger one).
 * next_cursor, when older items remain, is the `before` of the next page.
 */
async function listBin(userId: string, moduleInput?: unknown, beforeInput?: unknown, bookInput?: unknown, calendarInput?: unknown): Promise<BinListResponse> {
  const module = parseModule(moduleInput);
  const before = parseCursor(beforeInput);
  const book = parseBook(bookInput);
  const calendar = parseCalendar(calendarInput);
  // A book's or calendar's bin for those who may edit it (404 or 403 otherwise); it holds that module's items only.
  if (book) await books().assertBook(userId, book, 'edit');
  if (calendar) await calendars().assertCalendar(userId, calendar, 'edit');
  const only = book ? 'contacts' : calendar ? 'calendar' : null;
  const enabled = [];
  for (const id of module ? [module] : MODULES) if ((!only || id === only) && await isModuleEnabled(userId, id)) enabled.push(id);
  const retention = book ? bookRetention(await bookKeepDays()) : calendar ? await calendarRetention(calendar) : await binRetention(userId);
  if (!enabled.length) return { items: [], retention, next_cursor: null };
  const [column, ownerId] = ownerColumn(book ? { bookId: book } : calendar ? { calendarId: calendar } : userId);
  const open = `${column} = ? AND restored_at IS NULL AND module IN (${placeholders(enabled)})`;
  const [units] = await db.execute<(RowDataPacket & { unit: string; at: string; size: number })[]>(
    `SELECT unit, at, size FROM (
       SELECT ${UNIT} AS unit, DATE_FORMAT(MAX(deleted_at), '%Y-%m-%d %H:%i:%s') AS at, MAX(deleted_at) AS newest, COUNT(*) AS size
       FROM bin_items WHERE ${open} GROUP BY unit) units
     ${before ? 'WHERE newest < ? OR (newest = ? AND unit > ?)' : ''}
     ORDER BY newest DESC, unit LIMIT ${LIST_MAX + 1}`, [ownerId, ...enabled, ...(before ? [before.at, before.at, before.unit] : [])]);
  const page: typeof units = [];
  let size = 0;
  for (const unit of units) {
    if (page.length && size + Number(unit.size) > LIST_MAX) break;
    page.push(unit); size += Number(unit.size);
  }
  const last = page.at(-1);
  const next_cursor = last && page.length < units.length ? cursorOf({ at: last.at, unit: last.unit }) : null;
  if (!page.length) return { items: [], retention, next_cursor: null };
  const order = new Map(page.map((unit, index) => [unit.unit, index]));
  const [found] = await db.execute<(BinRow & { unit: string; provider: string | null; origin: string | null })[]>(
    `SELECT id, module, item_type, title, reason, group_id, deleted_at, purge_after, ${UNIT} AS unit,
       JSON_VALUE(payload, '$.provider') AS provider, JSON_VALUE(payload, '$.origin') AS origin
     FROM bin_items WHERE ${open} AND ${UNIT} IN (${placeholders(page)})
     ORDER BY deleted_at DESC, id`, [ownerId, ...enabled, ...page.map(unit => unit.unit)]);
  // A unit's items together, in the units' order.
  const rows = [...found].sort((a, b) => order.get(a.unit)! - order.get(b.unit)!);
  const { restoringBinItems } = require('./calendar-move') as typeof import('./calendar-move');
  const pending = only ? new Set<string>() : await restoringBinItems(db, userId);
  const items: BinItem[] = rows.map(row => ({
    id: row.id, module: row.module, item_type: row.item_type, title: row.title, reason: row.reason, group_id: row.group_id,
    deleted_at: iso(row.deleted_at), purge_after: shownPurgeAfter(row, retention),
    provider: row.provider === 'caldav' ? 'caldav' : 'local', origin: row.origin || null,
    ...(pending.has(row.id) ? { restoring: true as const } : {}),
  }));
  return { items, retention, next_cursor };
}

// --- Restoring ------------------------------------------------------------

async function ownedItems(executor: SqlExecutor, owner: BinOwner, ids: readonly string[], { lock = false } = {}) {
  if (!ids.length) return [];
  const [column, ownerId] = ownerColumn(owner);
  const [rows] = await executor.execute<BinRow[]>(
    `SELECT * FROM bin_items WHERE ${column} = ? AND restored_at IS NULL AND id IN (${placeholders(ids)}) ORDER BY deleted_at, id${lock ? ' FOR UPDATE' : ''}`, [ownerId, ...ids]);
  return rows;
}

/**
 * The person's own items among the ids, and those of shared books and
 * calendars they may edit; another's item is not found. An administrator
 * acting for the person (bookItems false) reaches only the person's own.
 */
async function reachableItems(userId: string, ids: readonly string[], { bookItems = true } = {}) {
  const own = await ownedItems(db, userId, ids);
  const rest = ids.filter(id => !own.some(row => row.id === id));
  if (!bookItems || !rest.length) return own;
  const [found] = await db.execute<BinRow[]>(
    `SELECT * FROM bin_items WHERE (address_book_id IS NOT NULL OR calendar_id IS NOT NULL) AND restored_at IS NULL AND id IN (${placeholders(rest)}) ORDER BY deleted_at, id`, rest);
  const { can } = require('./access') as typeof import('./access');
  const editable = new Set<string>();
  for (const row of found) {
    const resource = row.address_book_id ? { kind: 'address_book' as const, id: row.address_book_id } : { kind: 'calendar' as const, id: row.calendar_id! };
    const key = `${resource.kind}:${resource.id}`;
    if (!editable.has(key) && await can(userId, resource, 'edit')) editable.add(key);
  }
  return [...own, ...found.filter(row => editable.has(row.address_book_id ? `address_book:${row.address_book_id}` : `calendar:${row.calendar_id}`))];
}

/**
 * POST /api/bin/restore and /api/bin/:id/restore. Each item comes back with
 * the others of its group. An item another person owns, or one no longer in
 * the bin, is not found; one of a disabled module or a module being restored
 * fails with that reason, the rest go on. calendar_id sends events and tasks
 * to that calendar of the person instead of their own (a list's group keeps
 * its list; other kinds ignore it).
 */
async function restoreFromBin(userId: string, input: unknown): Promise<BinRestoreResponse> {
  const ids = parseIds(input);
  const choice = parseChoice(input);
  const found = await reachableItems(userId, ids);
  const groups = new Map<string, BinRow[]>();
  const foundIds = new Set(found.map(row => row.id));
  const failed: BinRestoreResponse['failed'] = ids.filter(id => !foundIds.has(id)).map(id => ({ id, error: 'Not in the bin', code: 'BIN_ITEM_NOT_FOUND' }));
  // Counted once grouped: each group, each single item, each id not found.
  if (new Set(found.map(row => row.group_id || row.id)).size + failed.length > IDS_MAX) throw tooMany();
  const groupIds = [...new Set(found.map(row => row.group_id).filter((id): id is string => !!id))];
  const bookIds = [...new Set(found.map(row => row.address_book_id).filter((id): id is string => !!id))];
  const [members] = groupIds.length ? await db.execute<BinRow[]>(
    `SELECT * FROM bin_items WHERE (user_id = ?${bookIds.length ? ` OR address_book_id IN (${placeholders(bookIds)})` : ''}) AND restored_at IS NULL AND group_id IN (${placeholders(groupIds)})
     ORDER BY deleted_at, id`, [userId, ...bookIds, ...groupIds]) : [[] as BinRow[]];
  for (const row of [...found, ...members]) {
    const key = row.group_id || row.id;
    const group = groups.get(key) || [];
    if (!group.some(item => item.id === row.id)) group.push(row);
    groups.set(key, group);
  }
  const gates = await moduleGates(userId);
  const restored: BinRestored[] = [];
  for (const group of groups.values()) {
    const gate = gates.get(group[0].module);
    if (gate) { failed.push(...group.filter(row => ids.includes(row.id)).map(row => ({ id: row.id, error: gate.message, code: gate.code }))); continue; }
    // A calendar's group is restored by the calendar; any other by its kind.
    const lead = group.find(row => row.item_type === 'calendar') ?? group[0];
    try {
      restored.push(...await KINDS[lead.item_type]().restore(userId, group, choice));
    } catch (error) {
      const { status, code, message } = error as ApiError;
      if (!status || status >= 500) throw error;
      failed.push(...group.map(row => ({ id: row.id, error: message, code })));
    }
  }
  return { restored, failed };
}

async function restoreBinItem(userId: string, id: string, input?: unknown) {
  if (!ID_PATTERN.test(id)) throw notFound('BIN_ITEM_NOT_FOUND', 'Not in the bin');
  const answer = await restoreFromBin(userId, { ids: [id], calendar_id: parseChoice(input).calendarId });
  const failure = answer.failed.find(item => item.id === id);
  if (failure && !answer.restored.length) {
    const status = failure.code === 'BIN_ITEM_NOT_FOUND' ? 404 : failure.code === 'MODULE_DISABLED' ? 403 : 409;
    throw new ApiError(status, failure.code || 'BIN_RESTORE_FAILED', failure.error);
  }
  return answer;
}

// --- Deleting for good ------------------------------------------------------

/**
 * The administrator who deletes for the person (routes/admin-people.ts):
 * bin.delete does not stop them (F13), and `record` writes their
 * activity-log entry for what one transaction deleted, on its connection,
 * so the rows and the entry commit together or not at all.
 */
interface BinDeleteActor {
  adminId?: string;
  record?: (connection: SqlExecutor, deleted: readonly BinRow[]) => Promise<void>;
}

/**
 * Removes items for good, in one transaction, then their files. A synced
 * item being created at its server again stops (its journal row goes with
 * it); a copy the server took meanwhile shows with the next sync as an item
 * of its own. Each transaction ends with the final step (final-step.ts)
 * after its row locks: bin.delete for the person (the request boundary's
 * answer may be older than an administrator's save), and the switch and
 * restore lock of every module the items belong to.
 */
async function deleteForGood(userId: string, rows: readonly BinRow[], { adminId, record }: BinDeleteActor = {}) {
  if (!rows.length) return 0;
  const ids = rows.map(row => row.id);
  // One owner per call: the person's items, one book's or one calendar's.
  const owner: BinOwner = rows[0].address_book_id ? { bookId: rows[0].address_book_id } : rows[0].user_id === userId ? userId : { calendarId: rows[0].calendar_id! };
  const [column, ownerId] = ownerColumn(owner);
  const deleted = await withTransaction(async connection => {
    // The book's or calendar's row first, then whether the person may still edit it.
    if (typeof owner !== 'string' && 'bookId' in owner) await books().bookWrite(userId, owner.bookId)(connection);
    else if (typeof owner !== 'string') await calendars().calendarWrite(connection, userId, owner.calendarId, 'edit');
    // The journal first, in the order a commit of the restore locks them.
    else await connection.execute(`SELECT id FROM calendar_event_moves WHERE user_id = ? AND bin_item_id IN (${placeholders(ids)}) FOR UPDATE`, [userId, ...ids]);
    const locked = await ownedItems(connection, owner, ids, { lock: true });
    if (!locked.length) return [];
    const { assertFinalStep } = require('./final-step') as typeof import('./final-step');
    await assertFinalStep(connection, { userId, policies: ['bin.delete'], actor: { adminId }, modules: [...new Set(locked.map(row => row.module))] });
    await connection.execute(`DELETE FROM bin_items WHERE ${column} = ? AND id IN (${placeholders(locked.map(row => row.id))})`, [ownerId, ...locked.map(row => row.id)]);
    if (record) await record(connection, locked);
    return locked;
  });
  await releaseFiles(userId, deleted);
  return deleted.length;
}

async function releaseFiles(userId: string, rows: readonly BinRow[]) {
  for (const type of new Set(rows.map(row => row.item_type))) {
    const release = KINDS[type]().release;
    if (release) await release(userId, rows.filter(row => row.item_type === type)).catch(() => undefined);
  }
}

/** DELETE /api/bin/:id. */
async function deleteBinItem(userId: string, id: string, actor: BinDeleteActor = {}): Promise<BinDeleteResponse> {
  if (!ID_PATTERN.test(id)) throw notFound('BIN_ITEM_NOT_FOUND', 'Not in the bin');
  const [row] = await reachableItems(userId, [id], { bookItems: !actor.adminId });
  if (!row) throw notFound('BIN_ITEM_NOT_FOUND', 'Not in the bin');
  const gate = (await moduleGates(userId)).get(row.module);
  if (gate) throw gate;
  return { deleted: await deleteForGood(userId, [row], actor) };
}

/**
 * POST /api/bin/empty: the person's bin, or one module's part of it; modules
 * that are off or being restored keep theirs. Batch by batch, each its own
 * transaction (and the administrator's entry with it). When bin.delete is
 * forbidden between batches, the refusal names what the earlier batches
 * deleted (`details.deleted`); those stay deleted.
 */
async function emptyBin(userId: string, input: unknown, actor: BinDeleteActor = {}): Promise<BinDeleteResponse> {
  const body = (input && typeof input === 'object' ? input : {}) as { module?: unknown; book?: unknown; calendar?: unknown };
  const book = parseBook(body.book);
  const calendar = parseCalendar(body.calendar);
  if ((book || calendar) && actor.adminId) throw badRequest('BIN_INVALID', 'A shared bin is emptied by someone who may edit it.');
  if (book) await books().assertBook(userId, book, 'edit');
  if (calendar) await calendars().assertCalendar(userId, calendar, 'edit');
  const module = book ? 'contacts' : calendar ? 'calendar' : parseModule(body.module);
  const gates = await moduleGates(userId);
  const open = (module ? [module] : MODULES).filter(id => !gates.get(id));
  if (module && !open.length) throw gates.get(module)!;
  const [column, ownerId] = ownerColumn(book ? { bookId: book } : calendar ? { calendarId: calendar } : userId);
  let deleted = 0;
  for (;;) {
    const [rows] = open.length ? await db.execute<BinRow[]>(
      `SELECT * FROM bin_items WHERE ${column} = ? AND restored_at IS NULL AND module IN (${placeholders(open)}) ORDER BY deleted_at, id LIMIT ${PURGE_BATCH}`, [ownerId, ...open]) : [[] as BinRow[]];
    if (!rows.length) break;
    try {
      deleted += await deleteForGood(userId, rows, actor);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'POLICY_FORBIDS') error.details = { ...(error.details as object), deleted };
      throw error;
    }
    if (rows.length < PURGE_BATCH) break;
  }
  return { deleted };
}

// --- The purge (worker owner) -----------------------------------------------

/** Where the purge of one person's module goes on: after this item in (purge_after, id) order. */
interface PurgeCursor { purgeAfter: Date | string; id: string }
interface PurgeOptions {
  now?: Date;
  /** Stops between people (the worker lost its lock or shuts down). */
  active?: () => boolean;
}

/**
 * bin.purge: deletes the items past their time, person by person and
 * module by module. A module that is off or being restored keeps its items
 * for a later hour, and nothing goes that the person's retention, as the
 * policies resolve it now, still keeps (purgeFloorDays). Merge records end
 * with their merged contacts' window. Items whose re-creation at a calendar
 * server is under way wait.
 *
 * The candidates are read in (purge_after, id) order from a cursor that
 * passes every item a batch looked at, so items that must wait (a journal,
 * a policy floor) never hold back the ones after them. Each batch is one
 * transaction, its locks in the order of the other writers of bin rows:
 * the person's users row (shared; a retention change takes it exclusively,
 * changeUserSettings), the items' restore journals, then the items by
 * primary key (as delete for good and a restore's commit take them).
 * Retention and journals are read after the users row, so a change
 * committed before is seen, and one begun after waits for the batch.
 */
async function purgeBin({ now = new Date(), active = () => true }: PurgeOptions = {}) {
  const [due] = await db.execute<(RowDataPacket & { user_id: string })[]>(
    `SELECT user_id FROM bin_items WHERE user_id IS NOT NULL AND purge_after IS NOT NULL AND purge_after <= ?
     UNION SELECT user_id FROM contact_merges WHERE purge_after <= ?`, [now, now]);
  const shared = await purgeBooks(now, active);
  if (!due.length) return { items: shared, merges: 0 };
  const sections = await getActiveRestoreSectionsByUser(db);
  const { purgeMergeRecords, withPhotoLock } = require('./contact-merge') as typeof import('./contact-merge');
  let items = 0; let merges = 0;
  // The resolved retention holds the floor as the transaction's snapshot saw
  // it; with the floor read again under the lock, the stricter of both holds.
  const retentionNow = async (userId: string, cx: SqlExecutor, lock = false) => retentionDaysNow(await binRetention(userId, cx), await purgeFloorDays(userId, cx, { lock }));
  for (const { user_id: userId } of due) {
    if (!active()) break;
    for (const module of MODULES) {
      if (sections.get(userId)?.has(sectionOf(module)) || !await isModuleEnabled(userId, module)) continue;
      const work = async () => {
        if (module === 'contacts') {
          merges += await withTransaction(async cx => {
            await lockPersonForRetention(cx, userId, 'share');
            if (!await purgeMayGo(cx, userId, module)) return 0;
            const days = await retentionNow(userId, cx, true);
            return days === null ? 0 : purgeMergeRecords(cx, userId, { now, minDays: Math.max(days, MERGE_UNDO_DAYS) });
          });
        }
        let cursor: PurgeCursor | null = null;
        for (;;) {
          const from: PurgeCursor | null = cursor;
          const batch: { removed: BinRow[]; last: PurgeCursor | null } = await withTransaction(async cx => {
            await lockPersonForRetention(cx, userId, 'share');
            const [candidates] = await cx.execute<(RowDataPacket & { id: string; purge_after: Date | string })[]>(
              `SELECT b.id, b.purge_after FROM bin_items b WHERE b.user_id = ? AND b.module = ? AND b.purge_after IS NOT NULL AND b.purge_after <= ?
                 ${from ? 'AND (b.purge_after > ? OR (b.purge_after = ? AND b.id > ?))' : ''}
                 AND NOT EXISTS (SELECT 1 FROM calendar_event_moves m WHERE m.bin_item_id = b.id)
               ORDER BY b.purge_after, b.id LIMIT ${PURGE_BATCH}`, [userId, module, now, ...(from ? [from.purgeAfter, from.purgeAfter, from.id] : [])]);
            if (!candidates.length) return { removed: [] as BinRow[], last: null };
            const last: PurgeCursor = { purgeAfter: candidates[candidates.length - 1].purge_after, id: String(candidates[candidates.length - 1].id) };
            const days = await retentionNow(userId, cx);
            if (days === null) return { removed: [] as BinRow[], last: null };
            const ids = candidates.map(row => String(row.id));
            const [journals] = await cx.execute<RowDataPacket[]>(`SELECT bin_item_id FROM calendar_event_moves WHERE bin_item_id IN (${placeholders(ids)}) LOCK IN SHARE MODE`, ids);
            const restoring = new Set(journals.map(row => String(row.bin_item_id)));
            const [locked] = await cx.execute<BinRow[]>(
              `SELECT * FROM bin_items FORCE INDEX (PRIMARY) WHERE id IN (${placeholders(ids)}) AND user_id = ? ORDER BY id FOR UPDATE`, [...ids, userId]);
            // The locks above may have waited while an administrator raised
            // the floor, switched the module off or a restore was admitted.
            if (!await purgeMayGo(cx, userId, module)) return { removed: [] as BinRow[], last: null };
            const keep = await retentionNow(userId, cx, true);
            if (keep === null) return { removed: [] as BinRow[], last: null };
            // Still due by its time and the retention in force now; an undone merge's rows go at their time.
            const removed = locked.filter(row => !restoring.has(row.id) && row.purge_after && new Date(row.purge_after) <= now
              && (row.restored_at || now.getTime() - new Date(row.deleted_at).getTime() >= (row.reason === 'merged' ? Math.max(keep, MERGE_UNDO_DAYS) : keep) * 86400000));
            if (removed.length) await cx.execute(`DELETE FROM bin_items WHERE user_id = ? AND id IN (${placeholders(removed.map(row => row.id))})`, [userId, ...removed.map(row => row.id)]);
            return { removed, last: candidates.length === PURGE_BATCH ? last : null };
          });
          items += batch.removed.length;
          // Files go after the rows' known commit.
          await releaseFiles(userId, batch.removed);
          if (!batch.last || !active()) break;
          cursor = batch.last;
        }
      };
      // Purging drops photo references (file_refs); like an undo it runs under the person's photo lock.
      if (module === 'contacts') await withPhotoLock(userId, work); else await work();
    }
  }
  return { items: items + shared, merges };
}

// The two shared bins the purge takes care of: a book's, and that of a calendar no person owns.
const SHARED_BINS = {
  books: { table: 'address_books', column: 'address_book_id', kind: 'address_book', ownerless: '', items: '' },
  calendars: { table: 'calendar_calendars', column: 'calendar_id', kind: 'calendar', ownerless: ' AND user_id IS NULL', items: ' AND user_id IS NULL' },
} as const;

/**
 * The purge of shared books and of calendars no person owns: each one's
 * items older than the shared retention as it stands now, and one deleted
 * that long ago with its contents, bin and shares. Nothing goes while the
 * retention is forever. A batch locks the book's or calendar's row first, as
 * a restore and a delete for good do; a book's photo files go with the daily
 * sweep (contact-photos.ts).
 */
async function purgeBooks(now: Date, active: () => boolean) {
  let items = 0;
  const keepNow = await bookKeepDays();
  if (keepNow === null) return 0;
  const { withContactPhotoLock } = require('./contact-photos') as typeof import('./contact-photos');
  for (const [name, bin] of Object.entries(SHARED_BINS)) {
    const [due] = await db.execute<(RowDataPacket & { id: string })[]>(
      `SELECT DISTINCT ${bin.column} AS id FROM bin_items WHERE ${bin.column} IS NOT NULL${bin.items} AND purge_after IS NOT NULL AND purge_after <= ?
       UNION SELECT id FROM ${bin.table} WHERE deleted_at IS NOT NULL${bin.ownerless} AND deleted_at <= ? - INTERVAL ? DAY`, [now, now, keepNow]);
    for (const { id } of due) {
      if (!active()) break;
      const purge = async () => {
        for (;;) {
          const removed = await withTransaction(async cx => {
            await cx.execute(`SELECT id FROM ${bin.table} WHERE id = ? FOR UPDATE`, [id]);
            // Read under the lock: a minimum raised meanwhile holds.
            const keep = await bookKeepDays(cx, { lock: true });
            if (keep === null) return 0;
            const [[expired]] = await cx.execute<RowDataPacket[]>(`SELECT 1 FROM ${bin.table} WHERE id = ? AND deleted_at IS NOT NULL${bin.ownerless} AND deleted_at <= ? - INTERVAL ? DAY`, [id, now, keep]);
            if (expired) {
              const { removeGrantsOn } = require('./access') as typeof import('./access');
              await removeGrantsOn(cx, { kind: bin.kind, id });
              // A book's contacts, values, properties, photos and bin go with it (foreign keys); a calendar's events and bin are removed here.
              if (name === 'calendars') {
                await cx.execute('DELETE FROM calendar_events WHERE calendar_id = ? AND user_id IS NULL', [id]);
                await cx.execute('DELETE FROM bin_items WHERE calendar_id = ? AND user_id IS NULL', [id]);
              }
              await cx.execute(`DELETE FROM ${bin.table} WHERE id = ?`, [id]);
              return 0;
            }
            const [rows] = await cx.execute<(RowDataPacket & { id: string })[]>(
              `SELECT id FROM bin_items WHERE ${bin.column} = ?${bin.items} AND purge_after IS NOT NULL AND purge_after <= ? AND deleted_at <= ? - INTERVAL ? DAY
               ORDER BY id LIMIT ${PURGE_BATCH} FOR UPDATE`, [id, now, now, keep]);
            if (rows.length) await cx.execute(`DELETE FROM bin_items WHERE ${bin.column} = ? AND id IN (${placeholders(rows)})`, [id, ...rows.map(row => row.id)]);
            return rows.length;
          });
          items += removed;
          if (removed < PURGE_BATCH || !active()) break;
        }
      };
      if (name === 'books') await withContactPhotoLock({ bookId: id }, purge); else await purge();
    }
  }
  return items;
}

/**
 * The purge's final step (final-step.ts): the module on and not being
 * restored, as committed now; a refusal leaves the items for a later hour.
 */
async function purgeMayGo(cx: SqlExecutor, userId: string, module: BinModule) {
  const { assertFinalStep } = require('./final-step') as typeof import('./final-step');
  try {
    await assertFinalStep(cx, { userId, modules: [module] });
    return true;
  } catch (error) {
    if (error instanceof ApiError && (error.code === 'MODULE_DISABLED' || error.code === 'RESTORE_IN_PROGRESS')) return false;
    throw error;
  }
}

/**
 * The person's users row as the lock between the purge (shared) and a change
 * of their retention (exclusive): taken first, before any bin row.
 */
async function lockPersonForRetention(cx: SqlExecutor, userId: string, mode: 'share' | 'update') {
  await cx.execute(`SELECT id FROM users WHERE id = ? ${mode === 'share' ? 'LOCK IN SHARE MODE' : 'FOR UPDATE'}`, [userId]);
}

/**
 * The first lock of every restore from the bin, before its journal and bin
 * rows: the person's users row, shared. A restore's inserts need it anyway
 * (their user_id foreign key); taken first, a restore and a retention change
 * (users row exclusive, then the bin rows) wait for each other instead of
 * each holding what the other needs. The order everywhere: users row,
 * restore journal, bin rows.
 */
async function lockBinOwner(cx: SqlExecutor, userId: string) {
  await lockPersonForRetention(cx, userId, 'share');
}

/**
 * Changes the person's user settings; with bin_retention among them, in one
 * transaction with the new purge times of what is in the bin, under the
 * person's users row, so a purge batch sees either both or neither.
 */
async function changeUserSettings(userId: string, input: unknown) {
  const { updateSettings } = require('./settings') as typeof import('./settings');
  const values = (input as { values?: object } | null)?.values;
  if (!values || typeof values !== 'object' || !('bin_retention' in values)) return updateSettings('user', userId, userId, input);
  return withTransaction(async cx => {
    await lockPersonForRetention(cx, userId, 'update');
    const settings = await updateSettings('user', userId, userId, input, cx);
    await applyBinRetention(userId, cx);
    return settings;
  });
}

/** The days an item must have waited before the purge may take it now; null: none may go. */
function retentionDaysNow(retention: BinRetention, floor: number | null | 'never') {
  const days = daysOf(retention);
  if (days === null || floor === 'never') return null;
  return floor === null ? days : Math.max(days, floor);
}

// --- For backup import (backup-import.ts, stream A) ---------------------------

/** One bin row as an archive carries it. */
interface ArchivedBinItem {
  id?: unknown;
  module?: unknown;
  item_type?: unknown;
  item_id?: unknown;
  title?: unknown;
  reason?: unknown;
  group_id?: unknown;
  payload?: unknown;
  payload_version?: unknown;
  file_refs?: unknown;
  deleted_at?: unknown;
  purge_after?: unknown;
  calendar_id?: unknown;
}
interface RestoreArchivedBinOptions {
  userId: string;
  /** The recovery section being restored: only its module's items are taken. */
  section: string;
  items: readonly ArchivedBinItem[];
  /** When the archive was made: an item keeps the time it had left then. */
  exportedAt: Date;
  /** Archive calendar id → restored calendar id, so an event goes back to its list (else the default list on restore). */
  calendarIds?: ReadonlyMap<string, string>;
  /** Archive bin item id → where the import staged its recording's file (inside the person's recordings bin folder). */
  recordingFiles?: ReadonlyMap<string, string>;
  /** Archive email id → restored email id, so a binned task keeps its source email. */
  emailIds?: ReadonlyMap<string, string>;
}

/**
 * Writes the bin items of a restored archive into the person's bin, inside
 * the import's transaction. Ids and user ids in an archive are not trusted:
 * each item gets a new id and the person's own user id, and the kinds'
 * restores check every record they write again. A merged contact becomes an
 * ordinary deleted one (its merge record is not archived). An item the bin
 * already holds (the same item deleted at the same time) is not added twice,
 * so restoring an archive twice leaves one.
 */
async function restoreBinItems(connection: SqlExecutor, options: RestoreArchivedBinOptions) {
  const { userId, section, items, exportedAt } = options;
  const skipped: { id: string; reason: string }[] = [];
  const groups = new Map<string, string>();
  let restored = 0;
  for (const item of items) {
    const sourceId = typeof item.id === 'string' ? item.id : '';
    const skip = (reason: string) => skipped.push({ id: sourceId, reason });
    const type = item.item_type as BinItemType;
    if (!Object.prototype.hasOwnProperty.call(MODULE_OF, type) || item.module !== MODULE_OF[type] || sectionOf(MODULE_OF[type]) !== section) { skip('not an item of this section'); continue; }
    if (Number(item.payload_version ?? PAYLOAD_VERSION) !== PAYLOAD_VERSION) { skip('unknown payload version'); continue; }
    let payload: Record<string, unknown> | null = null;
    try { payload = (typeof item.payload === 'string' ? JSON.parse(item.payload) : item.payload) as Record<string, unknown>; } catch { payload = null; }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Object.keys(payload).length) { skip('no payload'); continue; }
    const deletedAt = new Date(String(item.deleted_at ?? ''));
    if (Number.isNaN(deletedAt.getTime()) || typeof item.item_id !== 'string' || !ID_PATTERN.test(item.item_id)) { skip('invalid item'); continue; }
    if (type === 'recording') {
      const file = options.recordingFiles?.get(sourceId);
      if (!file) { skip('its recording file is not in the archive'); continue; }
      payload = { ...payload, bin_path: file };
    }
    if (options.calendarIds) payload = remapCalendars(payload, options.calendarIds);
    // An email restored under a new id is followed; another keeps its id (the restore of the item checks it is the person's).
    if (options.emailIds) payload = remapEmails(payload, id => options.emailIds!.get(id));
    const deletedSql = deletedAt.toISOString().slice(0, 19).replace('T', ' ');
    const [present] = await connection.execute<RowDataPacket[]>('SELECT id FROM bin_items WHERE user_id = ? AND item_type = ? AND item_id = ? AND deleted_at = ? LIMIT 1',
      [userId, type, item.item_id, deletedSql]);
    if (present.length) { skip('already in the bin'); continue; }
    const purge = item.purge_after ? new Date(String(item.purge_after)) : null;
    const left = purge && !Number.isNaN(purge.getTime()) ? Math.max(0, purge.getTime() - exportedAt.getTime()) : null;
    let groupId: string | null = null;
    if (typeof item.group_id === 'string' && item.group_id) {
      groupId = groups.get(item.group_id) ?? crypto.randomUUID();
      groups.set(item.group_id, groupId);
    }
    const reason: BinReason = item.reason === 'calendar_deleted' ? 'calendar_deleted' : 'deleted';
    // The calendar whose bin shows it too, as restored.
    const calendarId = typeof item.calendar_id === 'string' ? options.calendarIds?.get(item.calendar_id) ?? null : null;
    await connection.execute(`INSERT INTO bin_items (id, user_id, calendar_id, module, item_type, item_id, title, reason, group_id, payload, payload_version, file_refs, deleted_at, purge_after)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${left === null ? 'NULL' : 'UTC_TIMESTAMP() + INTERVAL ? SECOND'})`, [
      crypto.randomUUID(), userId, calendarId, MODULE_OF[type], type, item.item_id, Array.from(String(item.title ?? '')).slice(0, TITLE_MAX).join(''), reason, groupId,
      JSON.stringify(payload), PAYLOAD_VERSION, type === 'recording' ? JSON.stringify([payload.bin_path]) : jsonRefs(item.file_refs), deletedSql,
      ...(left === null ? [] : [Math.ceil(left / 1000)]),
    ]);
    restored += 1;
  }
  return { restored, skipped };
}

function jsonRefs(value: unknown) {
  const refs = parseRefs(value).filter(ref => /^[a-f0-9]{64}$/.test(ref));
  return refs.length ? JSON.stringify(refs) : null;
}

// The calendar a binned event or a calendar's events point at, by the archive's ids.
function remapCalendars(payload: Record<string, unknown>, ids: ReadonlyMap<string, string>) {
  const mapped = { ...payload };
  const event = mapped.event as Record<string, unknown> | undefined;
  if (event && typeof event.calendar_id === 'string') mapped.event = { ...event, calendar_id: ids.get(event.calendar_id) ?? null };
  const calendar = mapped.calendar as Record<string, unknown> | undefined;
  if (calendar && typeof calendar.id === 'string' && mapped.provider === 'caldav') mapped.calendar = { ...calendar, id: ids.get(calendar.id) ?? null };
  return mapped;
}

/**
 * The source emails a binned event or task names: its row's, and for a
 * synced item each date's own state (calendar_overlay_restores' shape).
 * `to` gives an email's new id, or undefined to keep it. The payload itself
 * is returned when nothing changes.
 */
function remapEmails(payload: Record<string, unknown>, to: (id: string) => string | undefined) {
  let changed = false;
  const follow = (holder: unknown) => {
    if (!holder || typeof holder !== 'object' || Array.isArray(holder)) return holder;
    const id = (holder as { source_email_id?: unknown }).source_email_id;
    const next = typeof id === 'string' ? to(id) : undefined;
    if (!next || next === id) return holder;
    changed = true;
    return { ...holder, source_email_id: next };
  };
  const event = follow(payload.event);
  const occurrences = Array.isArray(payload.occurrences)
    ? payload.occurrences.map(occurrence => occurrence && typeof occurrence === 'object' ? { ...occurrence, state: follow((occurrence as { state?: unknown }).state) } : occurrence)
    : payload.occurrences;
  return changed ? { ...payload, event, ...(Array.isArray(payload.occurrences) ? { occurrences } : {}) } : payload;
}

/**
 * In a Gmail merge's transaction (mail-sync-policy.ts mergeGmailGroup), after
 * it locked the copies and redirected the live tasks: the person's binned
 * events and tasks that name a removed copy name the kept one, so a restore
 * from the bin keeps the link. Their rows are locked here, after the tasks
 * (emails, tasks, bin rows); a bin restore of such a task racing the merge
 * is a deadlock that both transactions retry.
 */
async function redirectBinEmails(cx: SqlExecutor, userId: string, removed: readonly string[], kept: string) {
  if (!removed.length) return 0;
  const [rows] = await cx.execute<BinRow[]>(
    `SELECT id, payload FROM bin_items WHERE user_id = ? AND item_type IN ('event', 'task') AND restored_at IS NULL
     AND (${removed.map(() => 'payload LIKE ?').join(' OR ')}) FOR UPDATE`, [userId, ...removed.map(id => `%${id}%`)]);
  const from = new Set(removed);
  let redirected = 0;
  for (const row of rows) {
    const payload = parsePayload<Record<string, unknown>>(row);
    if (!payload || typeof payload !== 'object') continue;
    const next = remapEmails(payload, id => from.has(id) ? kept : undefined);
    if (next === payload) continue;
    await cx.execute('UPDATE bin_items SET payload = ? WHERE id = ? AND user_id = ?', [JSON.stringify(next), row.id, userId]);
    redirected += 1;
  }
  return redirected;
}

/**
 * For backup export: the person's open bin items of a section, with what each
 * keeps on disk (a recording's file, a contact's photo hashes).
 */
async function exportableBinItems(executor: SqlExecutor, userId: string, section: string) {
  const modules = MODULES.filter(module => sectionOf(module) === section);
  if (!modules.length) return [];
  const [rows] = await executor.execute<BinRow[]>(
    `SELECT id, user_id, module, item_type, item_id, title, reason, group_id, payload, payload_version, file_refs, deleted_at, purge_after, calendar_id
     FROM bin_items WHERE user_id = ? AND restored_at IS NULL AND module IN (${placeholders(modules)}) ORDER BY deleted_at, id`, [userId, ...modules]);
  return rows.map(row => ({ row, files: parseRefs(row.file_refs) }));
}

export {
  alreadyBack,
  listBin,
  restoreFromBin,
  restoreBinItem,
  deleteBinItem,
  emptyBin,
  purgeBin,
  putInBin,
  bookKeepDays,
  binRetention,
  applyBinRetention,
  changeUserSettings,
  lockBinOwner,
  redirectBinEmails,
  retentionDays,
  restoreBinItems,
  exportableBinItems,
  parsePayload,
  parseRefs,
  MERGE_UNDO_DAYS,
};
export type { BinRow, BinDeleteActor, NewBinItem, BinKind, KindRestore, RestoreChoice, ArchivedBinItem, RestoreArchivedBinOptions };
