'use strict';

// All node-imap private parser/request coupling stays inside the transport.
// Pinned imap@0.8.19 discards untagged COPYUID and only returns the tagged
// destination UID set; observe the response codes before its own listeners.
const { runGuardedImap } = require('../mail-imap-guard');
const MAX_UID = 0xffffffff;
const MAX_WINDOW = 250;
const MAX_METADATA_BYTES = 1048576;
const MAX_RAW_BYTES = 33554432;

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
  if (value == null) return null;
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
  const onAbort = () => connection.end();
  signal?.addEventListener('abort', onAbort, { once: true });
  return () => signal?.removeEventListener('abort', onAbort);
}
function selected(connection, folder, uidvalidity, writable = false) {
  const box = connection.imap._box;
  if (!box || box.name !== folder || uint32(box.uidvalidity, 'selected UIDVALIDITY') !== uint32(uidvalidity, 'UIDVALIDITY')
      || writable && box.readOnly) throw Object.assign(new Error('Selected mailbox identity/permissions changed'), { code: 'MAIL_IMAP_EPOCH' });
  return box;
}
async function selectMailbox(connection, { folder, readOnly = false, signal } = {}) {
  folderName(folder); aborted(signal);
  const detach = bindAbort(connection, signal);
  try {
    // imap-simple.openBox does not expose readOnly; use the guarded connection's
    // callback deadline for the underlying EXAMINE when requested.
    const box = readOnly
      ? await runGuardedImap(connection, done => connection.imap.openBox(folder, true, done))
      : await connection.openBox(folder);
    const uidvalidity = uint32(box.uidvalidity, 'UIDVALIDITY');
    const uidnext = box.uidnext ? uint32(box.uidnext, 'UIDNEXT') : null;
    const highestmodseq = optionalModseq(box.highestmodseq);
    return { folder, uidvalidity, uidnext, highestmodseq, nomodseq: !!box.nomodseq, readOnly: !!box.readOnly,
      capabilities: { move: connection.imap.serverSupports('MOVE'), condstore: connection.imap.serverSupports('CONDSTORE') && !box.nomodseq && highestmodseq !== null,
        uidplus: connection.imap.serverSupports('UIDPLUS'), xGmExt1: connection.imap.serverSupports('X-GM-EXT-1') } };
  } finally { detach(); }
}
function fetchItems(connection, range, options, limit, signal, onMessage) {
  return (async () => {
    const detach = bindAbort(connection, signal);
    try {
      return await runGuardedImap(connection, done => {
        let failed = false, inFlight = 0, ended = false, total = 0;
        const items = [];
        const fail = error => {
          if (failed) return;
          failed = true;
          // Parser may still be processing the same socket frame. Destroying
          // synchronously clears _curReq inside node-imap's FETCH handler.
          // Queue teardown before the rejected promise resumes its caller.
          queueMicrotask(() => connection.end());
          done(error);
        };
        const maybeDone = () => { if (ended && !inFlight && !failed) done(null, { items, bytes: total }); };
        const fetch = connection.imap.fetch(range, options);
        fetch.on('error', fail);
        fetch.on('message', message => {
          inFlight++;
          let attrs, bodyCount = 0, rawSize = 0, literalSize = null;
          const chunks = [];
          message.on('attributes', value => { attrs = value; });
          message.on('body', (stream, info) => {
            bodyCount++;
            literalSize = info.size;
            stream.on('data', chunk => {
              rawSize += chunk.length;
              if (rawSize > limit || !Number.isSafeInteger(literalSize) || literalSize > limit) fail(Object.assign(new Error('Raw message exceeds byte budget'), { code: 'MAIL_IMAP_LIMIT' }));
              else chunks.push(chunk);
            });
            stream.on('error', fail);
          });
          message.on('error', fail);
          message.on('end', () => {
            if (failed) return;
            try {
              const item = onMessage(attrs, { bodyCount, rawSize, literalSize, chunks });
              total += options.bodies?.length ? rawSize : Buffer.byteLength(JSON.stringify(item));
              if (total > limit) throw Object.assign(new Error('IMAP response exceeds byte budget'), { code: 'MAIL_IMAP_LIMIT' });
              items.push(item);
              if (items.length > MAX_WINDOW && !options.bodies?.length) throw new Error('IMAP metadata exceeds message budget');
              inFlight--; maybeDone();
            } catch (error) { fail(error); }
          });
        });
        fetch.on('end', () => { ended = true; maybeDone(); });
      });
    } finally { detach(); }
  })();
}
async function fetchMetadataWindow(connection, { folder, uidvalidity, startUid, endUid, maxMessages = 200, maxBytes = MAX_METADATA_BYTES } = {}, { signal } = {}) {
  folderName(folder); uint32(uidvalidity, 'UIDVALIDITY');
  startUid = uint32(startUid, 'start UID'); endUid = uint32(endUid, 'end UID');
  budget(maxMessages, MAX_WINDOW, 'message budget'); budget(maxBytes, MAX_METADATA_BYTES, 'byte budget');
  if (endUid < startUid || endUid - startUid + 1 > maxMessages) throw new TypeError('UID window exceeds message budget');
  selected(connection, folder, uidvalidity);
  const seen = new Set();
  const { items, bytes } = await fetchItems(connection, `${startUid}:${endUid}`, { bodies: [], markSeen: false }, maxBytes, signal, attrs => {
    if (!attrs) throw new Error('Missing FETCH attributes');
    const uid = uint32(attrs.uid, 'fetched UID');
    if (uid < startUid || uid > endUid || seen.has(uid) || !Array.isArray(attrs.flags)) throw new Error('Malformed/duplicate/out-of-range UID metadata');
    seen.add(uid);
    return { uid, flags: attrs.flags.slice(), modseq: optionalModseq(attrs.modseq),
      gmailMsgId: attrs['x-gm-msgid'] == null ? null : decimal(attrs['x-gm-msgid'], 'X-GM-MSGID') };
  });
  selected(connection, folder, uidvalidity);
  if (items.length > maxMessages) throw new Error('Metadata response exceeds message budget');
  return { folder, uidvalidity: uint32(uidvalidity, 'UIDVALIDITY'), startUid, endUid, items, complete: true, bytes };
}
async function fetchRawMessage(connection, { folder, uidvalidity, uid, maxBytes = MAX_RAW_BYTES } = {}, { signal } = {}) {
  folderName(folder); uid = uint32(uid, 'UID'); uint32(uidvalidity, 'UIDVALIDITY'); budget(maxBytes, MAX_RAW_BYTES, 'raw byte budget');
  selected(connection, folder, uidvalidity);
  const { items } = await fetchItems(connection, uid, { bodies: [''], markSeen: false }, maxBytes, signal, (attrs, body) => {
    if (!attrs || uint32(attrs.uid, 'fetched UID') !== uid || body.bodyCount !== 1
        || body.rawSize !== body.literalSize) throw new Error('Incomplete or mismatched raw BODY.PEEK[] response');
    return Buffer.concat(body.chunks, body.rawSize);
  });
  selected(connection, folder, uidvalidity);
  if (items.length !== 1) throw new Error('Raw fetch must return exactly one message');
  return { uid, uidvalidity: uint32(uidvalidity, 'UIDVALIDITY'), raw: items[0], bytes: items[0].length };
}
function completion(error) { return error?.type === 'no' ? 'no' : error?.type === 'bad' ? 'bad' : error ? 'lost' : 'ok'; }
function isCode(info, key) { return String(info?.textCode?.key).toUpperCase() === key; }
function outcomeBase() { return { transmission: 'not_sent', completion: 'unsupported' }; }
async function setFlag(connection, { uid, uidvalidity, sourceFolder, flag, value, modseq = null } = {}, { beforeDispatch, signal } = {}) {
  if (typeof beforeDispatch !== 'function') throw new TypeError('A durable beforeDispatch fence is required');
  uid = uint32(uid, 'UID'); folderName(sourceFolder); uint32(uidvalidity, 'UIDVALIDITY');
  if (!['\\Seen', '\\Flagged'].includes(flag) || typeof value !== 'boolean') throw new TypeError('Unsupported flag/value');
  if (modseq != null) modseq = decimal(modseq, 'MODSEQ');
  selected(connection, sourceFolder, uidvalidity, true); aborted(signal);
  if (modseq && (!connection.imap.serverSupports('CONDSTORE') || connection.imap._box.nomodseq))
    return { ...outcomeBase(), modified: false, modseq };
  const detach = bindAbort(connection, signal);
  const imap = connection.imap;
  let modified = false, taggedType = null;
  const observe = info => {
    if (imap._curReq?.fullcmd?.startsWith(`UID STORE ${uid} `)) {
      taggedType = info.type;
      if (isCode(info, 'MODIFIED')) modified = true;
    }
  };
  try {
    await beforeDispatch?.();
    aborted(signal); selected(connection, sourceFolder, uidvalidity, true);
    imap._parser?.prependListener('tagged', observe);
    const method = `${value ? 'add' : 'del'}Flags${modseq ? 'Since' : ''}`;
    let transmission = 'possible';
    try {
      await new Promise((resolve, reject) => imap[method](uid, flag, ...(modseq ? [modseq] : []), error => error ? reject(error) : resolve()));
      return { transmission, completion: 'ok', modified, modseq };
    } catch (error) {
      return { transmission, completion: taggedType === 'no' ? 'no' : error.code === 'MAIL_IMAP_MODIFIED' ? 'ok' : completion(error),
        modified: modified || error.code === 'MAIL_IMAP_MODIFIED', modseq };
    }
  } finally { imap._parser?.removeListener('tagged', observe); detach(); }
}
function parseCopyUid(code, uid) {
  const val = code?.val;
  if (!Array.isArray(val) || val.length !== 3) return null;
  try {
    const epoch = uint32(val[0], 'COPYUID UIDVALIDITY');
    // For a single-UID command no ranges/multi-UID sets are admissible.
    const source = uint32(val[1], 'COPYUID source UID');
    const destination = uint32(val[2], 'COPYUID destination UID');
    if (source !== uid) return null;
    return { uidvalidity: epoch, sourceUids: [source], destinationUids: [destination] };
  } catch { return null; }
}
async function nativeMove(connection, { uid, uidvalidity, sourceFolder, targetFolder } = {}, { beforeDispatch, signal } = {}) {
  if (typeof beforeDispatch !== 'function') throw new TypeError('A durable beforeDispatch fence is required');
  uid = uint32(uid, 'UID'); uint32(uidvalidity, 'UIDVALIDITY'); folderName(sourceFolder); folderName(targetFolder);
  if (sourceFolder === targetFolder) throw new TypeError('MOVE destination must differ from source');
  selected(connection, sourceFolder, uidvalidity, true); aborted(signal);
  // Critical: node-imap's move() silently performs COPY/STORE/EXPUNGE without MOVE.
  if (!connection.imap.serverSupports('MOVE'))
    return { ...outcomeBase(), mapping: null, mappingStatus: 'missing', evidence: { placement: null, reason: 'MOVE capability unavailable' } };
  const detach = bindAbort(connection, signal);
  const imap = connection.imap, codes = [];
  const observe = (info, placement) => {
    if (imap._curReq?.fullcmd?.startsWith(`UID MOVE ${uid} `) && isCode(info, 'COPYUID'))
      codes.push({ placement, mapping: parseCopyUid(info.textCode, uid) });
  };
  const untagged = info => observe(info, 'untagged');
  const tagged = info => observe(info, 'tagged');
  try {
    await beforeDispatch?.();
    aborted(signal); selected(connection, sourceFolder, uidvalidity, true);
    if (!imap.serverSupports('MOVE'))
      return { ...outcomeBase(), mapping: null, mappingStatus: 'missing', evidence: { placement: null, reason: 'MOVE capability changed before dispatch' } };
    imap._parser?.prependListener('untagged', untagged);
    imap._parser?.prependListener('tagged', tagged);
    let result;
    try {
      await new Promise((resolve, reject) => imap.move(uid, targetFolder, error => error ? reject(error) : resolve()));
      result = 'ok';
    } catch (error) { result = completion(error); }
    const valid = codes.filter(code => code.mapping);
    const duplicatePlacement = codes.length > 2 || codes.length === 2 && codes[0].placement === codes[1].placement;
    const conflicting = valid.length > 1 && valid.some(code => JSON.stringify(code.mapping) !== JSON.stringify(valid[0].mapping));
    const mappingStatus = !codes.length ? 'missing' : codes.some(code => !code.mapping) || duplicatePlacement ? 'invalid' : conflicting ? 'conflicting' : 'valid';
    return { transmission: 'possible', completion: result, mapping: mappingStatus === 'valid' ? valid[0].mapping : null, mappingStatus,
      evidence: { placement: codes.length === 2 && codes.some(c => c.placement === 'tagged') && codes.some(c => c.placement === 'untagged')
        ? 'both' : codes[0]?.placement || null, reason: mappingStatus === 'valid' ? null : mappingStatus === 'missing' ? 'COPYUID not provided' : 'COPYUID malformed or inconsistent' } };
  } finally { imap._parser?.removeListener('untagged', untagged); imap._parser?.removeListener('tagged', tagged); detach(); }
}
module.exports = { selectMailbox, fetchMetadataWindow, fetchRawMessage, setFlag, nativeMove };
