// Restoring the contacts section into the vCard model (0.26.0). The reader
// (backup-formats/v5.ts) has already turned the fixed 3+3 fields of an
// archive up to version 4 into contact_values rows. A contact that is written
// replaces its values, kept properties and photo wholesale, so restoring the
// same archive twice adds nothing. Replacing a contact from an archive older
// than version 5 is applied as an old app's whole 3+3 update (P-21): it
// changes what that format carried, and the values beyond the three places,
// labels, other fields, kept properties and the photo stay. Photo files are
// written before the transaction (backup-import.ts); here a photo row may
// only name a file that was written.
import type { RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor, BackupRow } from '../types';
import type { ContactValueKind } from '../contracts/contacts';
import type { ValueDraft, KeptPropertyDraft, LegacyFields } from './contacts';
import { LABELS, VALUE_KINDS, VALUE_LIMITS, VALUES_PER_KIND, KEPT_PROPERTIES_MAX, applyLegacyUpdate, draftNameKey, newUid, uidHash, writeKeptProperties, writeValues } from './contacts';
import { valueKey } from './contact-keys';
import { chooseTargetId, writeOwnedRow } from './backup-ownership';

type Row = BackupRow & Record<string, unknown>;
interface ArchivedValue { kind: ContactValueKind; value: string }

const SHA_PATTERN = /^[0-9a-f]{64}$/;
const text = (value: unknown) => typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
// The reader holds an archive to the limits the store writes with
// (services/contacts.ts): anything beyond them did not come from UniHub, and
// the restore stops with this error instead of cutting or dropping it.
const beyondLimits = (what: string) => Object.assign(new Error(`A contact in this backup has ${what} beyond what UniHub stores; nothing was restored.`), { status: 400 });
function bounded(value: string, max: number, what: string) {
  if (Array.from(value).length > max) throw beyondLimits(`a ${what} longer than ${max} characters`);
  return value;
}
const nullable = (value: unknown, what: string, max = 255) => { const result = text(value).trim(); return result ? bounded(result, max, what) : null; };

function groupBy(rows: unknown, key: string) {
  const grouped = new Map<string, Row[]>();
  for (const row of Array.isArray(rows) ? rows as Row[] : []) {
    const id = text(row?.[key]);
    if (id) grouped.set(id, [...(grouped.get(id) || []), row]);
  }
  return grouped;
}

// The values of one archived contact, as drafts for the store, each in its
// old apps' place (legacy_slot; the reader gives converted 3+3 values theirs).
// Unknown labels are cleared; an unknown kind, more values of a kind than a
// contact holds, a value beyond its limit or an impossible place for old apps
// stops the restore. A row without legacy_slot leaves the place to the store.
// The archived id is offered to the store, which keeps it only for a row this
// contact already has.
function archivedValues(children: readonly Row[] | undefined): ValueDraft[] {
  const sorted = [...(children || [])].sort((a, b) => Number(a.position || 0) - Number(b.position || 0));
  const counts = new Map<string, number>();
  const taken = new Set<string>();
  return sorted.flatMap((row): ValueDraft[] => {
    const kind = text(row.kind) as ContactValueKind;
    const value = text(row.value);
    if (!VALUE_KINDS.includes(kind)) throw beyondLimits('a value of an unknown kind');
    if (!value.trim()) return [];
    const count = (counts.get(kind) || 0) + 1;
    counts.set(kind, count);
    if (count > VALUES_PER_KIND) throw beyondLimits(`more than ${VALUES_PER_KIND} values of one kind (${kind})`);
    const label = LABELS[kind].has(text(row.label)) ? text(row.label) : '';
    const customLabel = label === 'custom' ? nullable(row.custom_label, 'custom label', 100) : null;
    let params = row.params;
    if (typeof params === 'string') { try { params = JSON.parse(params); } catch { params = null; } }
    // The archived place is kept (the three places an old app sees, and the
    // values it does not); a missing or repeated one falls back to the list order.
    const archivedPosition = Number(row.position);
    const position = Number.isInteger(archivedPosition) && archivedPosition >= 0 && archivedPosition <= 65535 && !taken.has(`${kind}:${archivedPosition}`) ? archivedPosition : undefined;
    if (position !== undefined) taken.add(`${kind}:${position}`);
    let legacySlot: number | null | undefined;
    if (Object.hasOwn(row, 'legacy_slot') && row.legacy_slot != null) {
      legacySlot = Number(row.legacy_slot);
      if ((kind !== 'email' && kind !== 'phone') || ![1, 2, 3].includes(legacySlot) || taken.has(`${kind}:slot${legacySlot}`)) throw beyondLimits('an impossible place for older apps');
      taken.add(`${kind}:slot${legacySlot}`);
    } else if (Object.hasOwn(row, 'legacy_slot')) legacySlot = null;
    return [{
      id: text(row.id) || null, legacy_slot: legacySlot, position, kind, value: bounded(value, VALUE_LIMITS[kind], kind), label: label === 'custom' && !customLabel ? '' : label, custom_label: customLabel, preferred: !!row.is_preferred,
      po_box: nullable(row.po_box, 'address part'), extended: nullable(row.extended, 'address part'), street: nullable(row.street, 'street', 1000), locality: nullable(row.locality, 'address part'),
      region: nullable(row.region, 'address part'), postal_code: nullable(row.postal_code, 'address part'), country: nullable(row.country, 'address part'),
      params: params && typeof params === 'object' ? params : null, vcard_group: nullable(row.vcard_group, 'vCard group', 64),
    }];
  });
}

interface ArchivedPhoto { sha256: string; thumb_sha256: string; width: number; height: number; bytes: number }

// An archived photo row, held to what the store writes.
function archivedPhoto(row: Row): ArchivedPhoto {
  const size = (value: unknown, max: number) => {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 1 || number > max) throw beyondLimits('a photo with an invalid size');
    return number;
  };
  const sha256 = text(row.sha256), thumb = text(row.thumb_sha256);
  if (!SHA_PATTERN.test(sha256) || !SHA_PATTERN.test(thumb)) throw beyondLimits('a photo with an invalid file name');
  return { sha256, thumb_sha256: thumb, width: size(row.width, 65535), height: size(row.height, 65535), bytes: size(row.bytes, 0xffffffff) };
}

function archivedProperties(rows: readonly Row[] | undefined): KeptPropertyDraft[] {
  if ((rows || []).length > KEPT_PROPERTIES_MAX) throw beyondLimits(`more than ${KEPT_PROPERTIES_MAX} kept properties`);
  return [...(rows || [])].sort((a, b) => Number(a.position || 0) - Number(b.position || 0)).flatMap(row => {
    const name = nullable(row.name, 'kept property name', 64);
    if (!name) return [];
    let params = row.params;
    if (typeof params === 'string') { try { params = JSON.parse(params); } catch { params = null; } }
    return [{ name, group: nullable(row.vcard_group, 'vCard group', 64), params: params && typeof params === 'object' ? params as KeptPropertyDraft['params'] : null, value: text(row.value), source_version: nullable(row.source_version, 'vCard version', 8) }];
  });
}

const sameName = (a: unknown, b: unknown) => text(a).trim().toLowerCase() === text(b).trim().toLowerCase();

/**
 * The existing contact an archived one is restored onto: the same id, the
 * same UID (or a UID merged into a contact), an email in common, or the same
 * name with a phone in common. A contact already claimed by this restore is
 * not taken twice.
 */
async function findExistingContactForRestore(connection: SqlExecutor, row: Row, values: readonly ArchivedValue[], userId: string, claimedIds = new Set<string>()) {
  const unclaimed = (rows: readonly (RowDataPacket & { id: string; first_name?: string; last_name?: string | null })[]) => {
    const available = rows.filter(candidate => !claimedIds.has(candidate.id));
    return (available.find(candidate => sameName(candidate.first_name, row.first_name) && sameName(candidate.last_name, row.last_name)) || available[0])?.id || null;
  };
  const [byId] = await connection.execute<(RowDataPacket & { id: string })[]>('SELECT id FROM contacts WHERE id = ? AND user_id = ?', [text(row.id), userId]);
  if (byId.length && !claimedIds.has(byId[0].id)) return byId[0].id;
  // An archive from before 0.26 has no uid; its contacts were given urn:uuid:<id>, as upgrade 22 does.
  const uid = text(row.uid).trim() || (text(row.id) ? newUid(text(row.id)) : '');
  if (uid) {
    const hash = uidHash(uid);
    const [byUid] = await connection.execute<(RowDataPacket & { id: string })[]>(`SELECT id FROM contacts WHERE user_id = ? AND uid_hash = ?
      UNION SELECT contact_id AS id FROM contact_uid_aliases WHERE user_id = ? AND uid_hash = ?`, [userId, hash, userId, hash]);
    const match = unclaimed(byUid);
    if (match) return match;
  }
  for (const value of values.filter(item => item.kind === 'email')) {
    const key = valueKey('email', value.value);
    if (!key) continue;
    const [byEmail] = await connection.execute<(RowDataPacket & { id: string; first_name: string; last_name: string | null })[]>(`SELECT c.id, c.first_name, c.last_name FROM contacts c
      WHERE c.user_id = ? AND EXISTS (SELECT 1 FROM contact_values v WHERE v.contact_id = c.id AND v.user_id = ? AND v.kind = 'email' AND v.value_key = ?)
      ORDER BY c.created_at, c.id`, [userId, userId, key]);
    const match = unclaimed(byEmail);
    if (match) return match;
  }
  const first = text(row.first_name).trim().toLowerCase();
  const last = text(row.last_name).trim().toLowerCase();
  if (first || last) {
    const phones = values.filter(item => item.kind === 'phone').map(item => valueKey('phone', item.value)).filter(Boolean);
    const [byName] = await connection.execute<(RowDataPacket & { id: string; first_name: string; last_name: string | null })[]>(`SELECT c.id, c.first_name, c.last_name FROM contacts c
      WHERE c.user_id = ? AND LOWER(c.first_name) = ? AND COALESCE(LOWER(c.last_name), '') = ?
        ${phones.length ? `AND EXISTS (SELECT 1 FROM contact_values v WHERE v.contact_id = c.id AND v.user_id = c.user_id AND v.kind = 'phone' AND v.value_key IN (${phones.map(() => '?').join(', ')}))` : ''}
      ORDER BY c.created_at, c.id`, [userId, first, last, ...phones]);
    const match = unclaimed(byName);
    if (match) return match;
  }
  return null;
}

interface RestoreContext {
  conflictMode: string;
  warnings: string[];
  checkCancelled: () => Promise<void>;
  // SHA-256 names of the photo files written for this restore.
  photoFiles?: ReadonlySet<string>;
  // The archive's own data schema (the reader converted older ones).
  sourceVersion?: number;
}

/**
 * Restores the contacts section on `connection` (the restore's transaction).
 * Returns the id of each archived contact here, and the photo files the
 * written contacts no longer use, to release after the commit.
 */
async function restoreContactsSection(connection: SqlExecutor, userId: string, data: Record<string, unknown>,
  { conflictMode, warnings, checkCancelled, photoFiles = new Set(), sourceVersion = 5 }: RestoreContext) {
  const valuesBy = groupBy(data.contact_values, 'contact_id');
  const propertiesBy = groupBy(data.contact_properties, 'contact_id');
  const photoBy = new Map(Array.from(groupBy(data.contact_photos, 'contact_id'), ([id, rows]) => [id, archivedPhoto(rows[0])]));
  const oldArchive = sourceVersion < 5;
  const releasedPhotos: string[] = [];
  let missingPhotos = 0;
  // A child row is restored only with its contact from the same archive; one
  // naming any other contact is refused, never attached to an existing row.
  const archived = new Set((Array.isArray(data.contacts) ? data.contacts as Row[] : []).map(row => text(row.id)));
  for (const [table, columns] of [['contact_values', ['contact_id']], ['contact_properties', ['contact_id']], ['contact_photos', ['contact_id']],
    ['contact_uid_aliases', ['contact_id']], ['contact_duplicate_dismissals', ['contact_a', 'contact_b']]] as const) {
    for (const row of (Array.isArray(data[table]) ? data[table] : []) as Row[]) {
      if (columns.some(column => !archived.has(text(row?.[column])))) throw new Error('Backup references an unavailable contacts record');
    }
  }
  const idMap = new Map<string, string>();
  const claimed = new Set<string>();
  for (const contact of (Array.isArray(data.contacts) ? data.contacts : []) as Row[]) {
    await checkCancelled();
    const sourceId = text(contact.id);
    const values = archivedValues(valuesBy.get(sourceId));
    const existingId = await findExistingContactForRestore(connection, contact, values, userId, claimed);
    const targetId = chooseTargetId(sourceId, existingId, conflictMode);
    claimed.add(targetId);
    idMap.set(sourceId, targetId);
    // keep_existing leaves a matched contact as it is.
    if (existingId && existingId === targetId && conflictMode !== 'replace') continue;
    const replacing = existingId === targetId;
    if (replacing && oldArchive) {
      // The reader gave each converted value its place; the matched contact keeps its uid.
      const slots = (kind: 'email' | 'phone') => [1, 2, 3].map(slot => values.find(value => value.kind === kind && value.legacy_slot === slot)?.value);
      const [emails, phones] = [slots('email'), slots('phone')];
      const fields: LegacyFields = {
        first_name: text(contact.first_name), last_name: text(contact.last_name) || null, company: text(contact.company) || null,
        job_title: text(contact.job_title) || null, notes: text(contact.notes) || null,
        email: emails[0] ?? null, email2: emails[1] ?? null, email3: emails[2] ?? null, phone: phones[0] ?? null, phone2: phones[1] ?? null, phone3: phones[2] ?? null,
      };
      await applyLegacyUpdate(connection, userId, targetId, fields, { whole: true, present: new Set(), favorite: !!contact.is_favorite, expectedVersion: null });
      continue;
    }
    let uid = text(contact.uid).trim() ? bounded(text(contact.uid).trim(), 255, 'UID') : newUid(sourceId);
    // A UID already used by another of this user's contacts (Keep both) gets a new one.
    const [[holder]] = await connection.execute<(RowDataPacket & { id: string })[]>('SELECT id FROM contacts WHERE user_id = ? AND uid_hash = ?', [userId, uidHash(uid)]);
    if (holder && holder.id !== targetId) uid = newUid(targetId);
    const draft = {
      display_name: nullable(contact.display_name, 'display name'), first_name: nullable(contact.first_name, 'first name') || '', last_name: nullable(contact.last_name, 'last name'),
      middle_name: nullable(contact.middle_name, 'middle name'), name_prefix: nullable(contact.name_prefix, 'name prefix'), name_suffix: nullable(contact.name_suffix, 'name suffix'),
      company: nullable(contact.company, 'organisation'), department: nullable(contact.department, 'department'), job_title: nullable(contact.job_title, 'job title'),
      birthday: /^(\d{4}|-)-\d{2}-\d{2}$/.test(text(contact.birthday)) ? text(contact.birthday) : null,
      anniversary: /^(\d{4}|-)-\d{2}-\d{2}$/.test(text(contact.anniversary)) ? text(contact.anniversary) : null,
      notes: !text(contact.notes) ? null : Buffer.byteLength(text(contact.notes), 'utf8') > 65535 ? (() => { throw beyondLimits('notes longer than 65535 bytes'); })() : text(contact.notes),
    };
    const columns = ['id', 'user_id', 'uid', 'uid_hash', ...Object.keys(draft), 'is_favorite', 'name_key'];
    await writeOwnedRow(connection, userId, 'contacts', columns,
      [targetId, userId, uid, uidHash(uid), ...Object.values(draft), contact.is_favorite ? 1 : 0, draftNameKey(draft)],
      columns.filter(column => column !== 'id' && column !== 'user_id'));
    if (replacing) await connection.execute('UPDATE contacts SET version = version + 1 WHERE id = ? AND user_id = ?', [targetId, userId]);
    await writeValues(connection, userId, targetId, VALUE_KINDS, values);
    await connection.execute('DELETE FROM contact_properties WHERE user_id = ? AND contact_id = ?', [userId, targetId]);
    await writeKeptProperties(connection, userId, targetId, archivedProperties(propertiesBy.get(sourceId)));
    // The archived photo, or none when the archive's contact had none. A photo
    // whose files the archive lacks leaves the stored one as it is.
    const [[previous]] = await connection.execute<(RowDataPacket & { sha256: string; thumb_sha256: string })[]>(
      'SELECT sha256, thumb_sha256 FROM contact_photos WHERE contact_id = ? AND user_id = ? FOR UPDATE', [targetId, userId]);
    const photo = photoBy.get(sourceId);
    const available = !!photo && photoFiles.has(photo.sha256) && photoFiles.has(photo.thumb_sha256);
    if (photo && !available) { missingPhotos++; continue; }
    if (previous) releasedPhotos.push(previous.sha256, previous.thumb_sha256);
    if (photo) {
      await connection.execute(`INSERT INTO contact_photos (contact_id, user_id, sha256, width, height, bytes, thumb_sha256, source) VALUES (?, ?, ?, ?, ?, ?, ?, 'restore')
        ON DUPLICATE KEY UPDATE sha256 = VALUES(sha256), width = VALUES(width), height = VALUES(height), bytes = VALUES(bytes),
          thumb_sha256 = VALUES(thumb_sha256), source = VALUES(source), created_at = CURRENT_TIMESTAMP`,
      [targetId, userId, photo.sha256, photo.width, photo.height, photo.bytes, photo.thumb_sha256]);
    } else if (previous) {
      await connection.execute('DELETE FROM contact_photos WHERE contact_id = ? AND user_id = ?', [targetId, userId]);
    }
  }
  if (missingPhotos) warnings.push(`${missingPhotos} contact photo${missingPhotos === 1 ? ' was' : 's were'} not restored because the backup lacks the picture.`);
  for (const alias of (Array.isArray(data.contact_uid_aliases) ? data.contact_uid_aliases : []) as Row[]) {
    const contactId = idMap.get(text(alias.contact_id));
    const uid = text(alias.uid).trim();
    if (!contactId || !uid) continue;
    await connection.execute('INSERT INTO contact_uid_aliases (user_id, uid_hash, uid, contact_id) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE uid = uid',
      [userId, uidHash(uid), bounded(uid, 255, 'UID'), contactId]);
  }
  for (const pair of (Array.isArray(data.contact_duplicate_dismissals) ? data.contact_duplicate_dismissals : []) as Row[]) {
    const [a, b] = [idMap.get(text(pair.contact_a)), idMap.get(text(pair.contact_b))];
    if (!a || !b || a === b) continue;
    await connection.execute('INSERT INTO contact_duplicate_dismissals (contact_a, contact_b, user_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE user_id = user_id',
      [a < b ? a : b, a < b ? b : a, userId]);
  }
  return { idMap, releasedPhotos };
}

// How many archived contacts the restore would match with an existing one
// (the same rules as the restore, each existing contact counted once).
async function countContactConflicts(connection: SqlExecutor, userId: string, data: Record<string, unknown>) {
  const valuesBy = groupBy(data.contact_values, 'contact_id');
  const claimed = new Set<string>();
  for (const contact of (Array.isArray(data.contacts) ? data.contacts : []) as Row[]) {
    const match = await findExistingContactForRestore(connection, contact, archivedValues(valuesBy.get(text(contact.id))), userId, claimed);
    if (match) claimed.add(match);
  }
  return claimed.size;
}

export { restoreContactsSection, countContactConflicts, findExistingContactForRestore, archivedValues };
