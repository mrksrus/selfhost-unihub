'use strict';

// All ImapFlow protocol coupling of the mail engine stays inside the transport.
// SELECT/EXAMINE and FETCH use the library API. UID STORE and UID MOVE are
// issued through ImapFlow's command queue (exec) with explicitly built
// arguments: the convenience methods hide NO/BAD and MODIFIED, filter flags by
// PERMANENTFLAGS, put UNCHANGEDSINCE after the flag list, and messageMove()
// silently falls back to COPY + STORE + EXPUNGE when MOVE is not advertised.
const { runGuardedImap, closeImapConnection } = require('../mail-imap-guard');
const imapTools = require('imapflow/lib/tools.js');
const MAX_UID = 0xffffffff;
const MAX_WINDOW = 250;
const MAX_METADATA_BYTES = 1048576;
const MAX_RAW_BYTES = 52428800;

function uint32(value, name) {
  if (typeof value === 'bigint') value = value.toString();
  if (!(typeof value === 'number' && Number.isSafeInteger(value) || typeof value === 'string' && /^[1-9]\d*$/.test(value))
    || !/^[1-9]\d*$/.test(String(value)) || BigInt(value) > BigInt(MAX_UID)) throw new TypeError(`Invalid ${name}`);
  return Number(value);
}
function decimal(value, name) {
  if (typeof value === 'bigint') value = value.toString();
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new TypeError(`Invalid ${name}`);
  if (!/^[1-9]\d{0,19}$/.test(String(value)) || BigInt(value) > 0xffffffffffffffffn) throw new TypeError(`Invalid ${name}`);
  return String(value);
}
// Some providers (seen with iCloud) report HIGHESTMODSEQ/MODSEQ values outside
// RFC 7162, e.g. 0. Treat such a value as "no mod-sequence": the mailbox is then
// handled like a server without CONDSTORE instead of failing the whole sync.
function optionalModseq(value) {
  if (value == null || value === false) return null;
  try { return decimal(value, 'MODSEQ'); } catch { return null; }
}
function folderName(value) {
  if (typeof value !== 'string' || !value || /[\r\n\0]/.test(value)) throw new TypeError('Invalid mailbox path');
  return value;
}
function budget(value, maximum, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new TypeError(`Invalid ${name}`);
  return value;
}
function aborted(signal) {
  if (signal?.aborted) throw Object.assign(new Error('Mail command cancelled'), { code: 'MAIL_SYNC_CANCELLED' });
}
function bindAbort(connection, signal) {
  aborted(signal);
  const onAbort = () => closeImapConnection(connection);
  signal?.addEventListener('abort', onAbort, { once: true });
  return () => signal?.removeEventListener('abort', onAbort);
}
// Only capabilities the server advertises count; a missing MOVE is never
// emulated and a missing UIDPLUS never widens an EXPUNGE.
function advertised(connection, capability) {
  return connection.capabilities instanceof Map && connection.capabilities.has(capability);
}
function selected(connection, folder, uidvalidity, writable = false) {
  const box = connection.mailbox;
  if (!box || connection.state !== connection.states?.SELECTED || box.path !== imapTools.normalizePath(connection, folder)
      || uint32(box.uidValidity, 'selected UIDVALIDITY') !== uint32(uidvalidity, 'UIDVALIDITY')
      || writable && box.readOnly) throw Object.assign(new Error('Selected mailbox identity/permissions changed'), { code: 'MAIL_IMAP_EPOCH' });
  return box;
}
async function selectMailbox(connection, { folder, readOnly = false, signal } = {}) {
  folderName(folder); aborted(signal);
  const detach = bindAbort(connection, signal);
  try {
    const box = await runGuardedImap(connection, () => connection.mailboxOpen(folder, { readOnly: !!readOnly }));
    if (!box || box.path !== imapTools.normalizePath(connection, folder))
      throw Object.assign(new Error('Selected mailbox identity changed'), { code: 'MAIL_IMAP_EPOCH' });
    const uidvalidity = uint32(box.uidValidity, 'UIDVALIDITY');
    const uidnext = box.uidNext ? uint32(box.uidNext, 'UIDNEXT') : null;
    const highestmodseq = optionalModseq(box.highestModseq);
    return { folder, uidvalidity, uidnext, highestmodseq, nomodseq: !!box.noModseq, readOnly: !!box.readOnly,
      capabilities: { move: advertised(connection, 'MOVE'),
        condstore: connection.enabled?.has('CONDSTORE') === true && !box.noModseq && highestmodseq !== null,
        uidplus: advertised(connection, 'UIDPLUS'), xGmExt1: advertised(connection, 'X-GM-EXT-1') } };
  } finally { detach(); }
}
// Streams one UID FETCH. Any failure (budget, malformed or out-of-range data,
// NO/BAD) tears the session down: a half-consumed FETCH must never be followed
// by another command on the same connection.
async function fetchItems(connection, range, query, signal, onMessage, { timeoutMs } = {}) {
  const detach = bindAbort(connection, signal);
  try {
    return await runGuardedImap(connection, async () => {
      try {
        const items = [];
        for await (const message of connection.fetch(range, query, { uid: true })) items.push(onMessage(message, items));
        return items;
      } catch (error) {
        closeImapConnection(connection, error);
        throw error;
      }
    }, { timeoutMs });
  } finally { detach(); }
}
function limitError(message) { return Object.assign(new Error(message), { code: 'MAIL_IMAP_LIMIT' }); }
async function fetchMetadataWindow(connection, { folder, uidvalidity, startUid, endUid, maxMessages = 200, maxBytes = MAX_METADATA_BYTES } = {}, { signal } = {}) {
  folderName(folder); uint32(uidvalidity, 'UIDVALIDITY');
  startUid = uint32(startUid, 'start UID'); endUid = uint32(endUid, 'end UID');
  budget(maxMessages, MAX_WINDOW, 'message budget'); budget(maxBytes, MAX_METADATA_BYTES, 'byte budget');
  if (endUid < startUid || endUid - startUid + 1 > maxMessages) throw new TypeError('UID window exceeds message budget');
  selected(connection, folder, uidvalidity);
  const seen = new Set();
  // X-GM-MSGID is only Gmail's numeric id when the server has no OBJECTID
  // (ImapFlow reports either as emailId).
  const gmail = advertised(connection, 'X-GM-EXT-1') && !advertised(connection, 'OBJECTID');
  let bytes = 0;
  const items = await fetchItems(connection, `${startUid}:${endUid}`, { uid: true, flags: true, internalDate: true }, signal, (message, collected) => {
    if (!message) throw new Error('Missing FETCH attributes');
    const uid = uint32(message.uid, 'fetched UID');
    if (uid < startUid || uid > endUid || seen.has(uid) || !(message.flags instanceof Set)) throw new Error('Malformed/duplicate/out-of-range UID metadata');
    seen.add(uid);
    // INTERNALDATE decides Sync retention windows; an unparsable date is unknown, never "old".
    const internal = message.internalDate instanceof Date ? message.internalDate : message.internalDate ? new Date(message.internalDate) : null;
    const item = { uid, flags: [...message.flags], modseq: optionalModseq(message.modseq),
      gmailMsgId: gmail && message.emailId != null ? decimal(message.emailId, 'X-GM-MSGID') : null,
      internalDate: internal && Number.isFinite(internal.getTime()) ? internal.toISOString() : null };
    bytes += Buffer.byteLength(JSON.stringify(item));
    if (bytes > maxBytes) throw limitError('IMAP response exceeds byte budget');
    if (collected.length >= MAX_WINDOW) throw new Error('IMAP metadata exceeds message budget');
    return item;
  });
  selected(connection, folder, uidvalidity);
  if (items.length > maxMessages) throw new Error('Metadata response exceeds message budget');
  return { folder, uidvalidity: uint32(uidvalidity, 'UIDVALIDITY'), startUid, endUid, items, complete: true, bytes };
}
async function fetchRawMessage(connection, { folder, uidvalidity, uid, maxBytes = MAX_RAW_BYTES } = {}, { signal, timeoutMs } = {}) {
  folderName(folder); uid = uint32(uid, 'UID'); uint32(uidvalidity, 'UIDVALIDITY'); budget(maxBytes, MAX_RAW_BYTES, 'raw byte budget');
  selected(connection, folder, uidvalidity);
  // BODY.PEEK[] arrives as one literal Buffer: exact octets, never decoded.
  // ImapFlow refuses literals above MAX_RAW_BYTES before reading them.
  const items = await fetchItems(connection, String(uid), { uid: true, source: true }, signal, message => {
    if (!message || uint32(message.uid, 'fetched UID') !== uid || !Buffer.isBuffer(message.source))
      throw new Error('Incomplete or mismatched raw BODY.PEEK[] response');
    if (message.source.length > maxBytes) throw limitError('Raw message exceeds byte budget');
    return message.source;
  }, { timeoutMs });
  selected(connection, folder, uidvalidity);
  if (items.length !== 1) throw new Error('Raw fetch must return exactly one message');
  return { uid, uidvalidity: uint32(uidvalidity, 'UIDVALIDITY'), raw: items[0], bytes: items[0].length };
}
// Tagged NO/BAD reach exec() as a rejection carrying responseStatus; anything
// else (closed socket, deadline, abort) leaves the outcome unknown.
function completion(error) {
  const status = String(error?.responseStatus || '').toUpperCase();
  return status === 'NO' ? 'no' : status === 'BAD' ? 'bad' : error ? 'lost' : 'ok';
}
function responseCode(parsed) {
  const section = parsed?.attributes?.[0]?.section;
  if (!Array.isArray(section) || typeof section[0]?.value !== 'string') return null;
  return { key: section[0].value.toUpperCase(), args: section.slice(1) };
}
function outcomeBase() { return { transmission: 'not_sent', completion: 'unsupported' }; }
// Sends one command on the selected mailbox and settles with the tagged
// response (or the rejection). The response must be released with next().
async function execTagged(connection, command, attributes, options) {
  const reply = await connection.exec(command, attributes, options);
  reply.next();
  return reply.response;
}
async function setFlag(connection, { uid, uidvalidity, sourceFolder, flag, value, modseq = null } = {}, { beforeDispatch, signal } = {}) {
  if (typeof beforeDispatch !== 'function') throw new TypeError('A durable beforeDispatch fence is required');
  uid = uint32(uid, 'UID'); folderName(sourceFolder); uint32(uidvalidity, 'UIDVALIDITY');
  if (!['\\Seen', '\\Flagged'].includes(flag) || typeof value !== 'boolean') throw new TypeError('Unsupported flag/value');
  if (modseq != null) modseq = decimal(modseq, 'MODSEQ');
  selected(connection, sourceFolder, uidvalidity, true); aborted(signal);
  if (modseq && (connection.enabled?.has('CONDSTORE') !== true || connection.mailbox.noModseq))
    return { ...outcomeBase(), modified: false, modseq };
  const detach = bindAbort(connection, signal);
  try {
    await beforeDispatch();
    aborted(signal); selected(connection, sourceFolder, uidvalidity, true);
    // One verified UID, exactly one flag, retaining every unrelated server
    // flag: UID STORE <uid> [(UNCHANGEDSINCE <modseq>)] ±FLAGS.SILENT (<flag>).
    const attributes = [{ type: 'SEQUENCE', value: String(uid) },
      ...(modseq ? [[{ type: 'ATOM', value: 'UNCHANGEDSINCE' }, { type: 'ATOM', value: modseq }]] : []),
      { type: 'ATOM', value: `${value ? '+' : '-'}FLAGS.SILENT` }, [{ type: 'ATOM', value: flag }]];
    const transmission = 'possible';
    try {
      const tagged = await runGuardedImap(connection, () => execTagged(connection, 'UID STORE', attributes));
      return { transmission, completion: 'ok', modified: responseCode(tagged)?.key === 'MODIFIED', modseq };
    } catch (error) {
      return { transmission, completion: completion(error), modified: completion(error) === 'no' && responseCode(error.response)?.key === 'MODIFIED', modseq };
    }
  } finally { detach(); }
}
// For a single-UID command no ranges/multi-UID sets are admissible.
function parseCopyUid(args, uid) {
  if (!Array.isArray(args) || args.length !== 3 || args.some(arg => typeof arg?.value !== 'string')) return null;
  try {
    const epoch = uint32(args[0].value, 'COPYUID UIDVALIDITY');
    const source = uint32(args[1].value, 'COPYUID source UID');
    const destination = uint32(args[2].value, 'COPYUID destination UID');
    if (source !== uid) return null;
    return { uidvalidity: epoch, sourceUids: [source], destinationUids: [destination] };
  } catch { return null; }
}
async function nativeMove(connection, { uid, uidvalidity, sourceFolder, targetFolder } = {}, { beforeDispatch, signal } = {}) {
  if (typeof beforeDispatch !== 'function') throw new TypeError('A durable beforeDispatch fence is required');
  uid = uint32(uid, 'UID'); uint32(uidvalidity, 'UIDVALIDITY'); folderName(sourceFolder); folderName(targetFolder);
  if (sourceFolder === targetFolder) throw new TypeError('MOVE destination must differ from source');
  selected(connection, sourceFolder, uidvalidity, true); aborted(signal);
  // Critical: never messageMove(), which emulates MOVE with COPY + EXPUNGE.
  if (!advertised(connection, 'MOVE'))
    return { ...outcomeBase(), mapping: null, mappingStatus: 'missing', evidence: { placement: null, reason: 'MOVE capability unavailable' } };
  const detach = bindAbort(connection, signal);
  const codes = [];
  const observe = (parsed, placement) => {
    const code = responseCode(parsed);
    if (code?.key === 'COPYUID') codes.push({ placement, mapping: parseCopyUid(code.args, uid) });
  };
  try {
    await beforeDispatch();
    aborted(signal); selected(connection, sourceFolder, uidvalidity, true);
    if (!advertised(connection, 'MOVE'))
      return { ...outcomeBase(), mapping: null, mappingStatus: 'missing', evidence: { placement: null, reason: 'MOVE capability changed before dispatch' } };
    const attributes = [{ type: 'SEQUENCE', value: String(uid) },
      { type: 'STRING', value: imapTools.encodePath(connection, targetFolder) }];
    let result;
    try {
      // The command-scoped untagged OK handler sees an untagged [COPYUID]
      // before ImapFlow's global handlers; EXPUNGE stays with the library.
      const tagged = await runGuardedImap(connection, () => execTagged(connection, 'UID MOVE', attributes,
        { untagged: { OK: async untagged => observe(untagged, 'untagged') } }));
      observe(tagged, 'tagged');
      result = 'ok';
    } catch (error) {
      if (error?.response) observe(error.response, 'tagged');
      result = completion(error);
    }
    const valid = codes.filter(code => code.mapping);
    const duplicatePlacement = codes.length > 2 || codes.length === 2 && codes[0].placement === codes[1].placement;
    const conflicting = valid.length > 1 && valid.some(code => JSON.stringify(code.mapping) !== JSON.stringify(valid[0].mapping));
    const mappingStatus = !codes.length ? 'missing' : codes.some(code => !code.mapping) || duplicatePlacement ? 'invalid' : conflicting ? 'conflicting' : 'valid';
    return { transmission: 'possible', completion: result, mapping: mappingStatus === 'valid' ? valid[0].mapping : null, mappingStatus,
      evidence: { placement: codes.length === 2 && codes.some(c => c.placement === 'tagged') && codes.some(c => c.placement === 'untagged')
        ? 'both' : codes[0]?.placement || null, reason: mappingStatus === 'valid' ? null : mappingStatus === 'missing' ? 'COPYUID not provided' : 'COPYUID malformed or inconsistent' } };
  } finally { detach(); }
}
module.exports = { selectMailbox, fetchMetadataWindow, fetchRawMessage, setFlag, nativeMove };
