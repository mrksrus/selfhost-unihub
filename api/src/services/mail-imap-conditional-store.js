// node-imap 0.8.19 serializes STORE's UNCHANGEDSINCE without the RFC 4551
// parentheses. Keep its parser/queue and imap-simple's connection, but encode
// this one command ourselves. Do not alter node_modules or unconditional STORE.
const Imap = require('imap');
const installed = new WeakSet();

function installConditionalStore(imap) {
  if (!(imap instanceof Imap)) return; // Dependency-injected test connections.
  // Fail closed on a changed dependency rather than silently sending a bare
  // UNCHANGEDSINCE (or falling back to an unconditional flag replacement).
  const version = require('imap/package.json').version;
  if (version !== '0.8.19' || typeof imap._enqueue !== 'function'
      || typeof imap._parser?.prependListener !== 'function') {
    throw new Error('Unsupported node-imap conditional STORE protocol boundary');
  }
  if (installed.has(imap)) return;

  // The library discards tagged OK [MODIFIED <uid-set>]. Observe only replies
  // for our own requests, before its tagged listener calls the command callback.
  const requests = new WeakMap();
  imap._parser.prependListener('tagged', info => {
    const state = imap._curReq && requests.get(imap._curReq);
    if (state && (info.type === 'ok' || info.type === 'no')
        && String(info.textCode?.key).toUpperCase() === 'MODIFIED') {
      state.modified = true;
    }
  });

  function store(mode, uid, flag, modseq, callback) {
    if (typeof callback !== 'function') throw new TypeError('STORE requires a callback');
    if (!imap._box || imap._box.readOnly || imap._box.nomodseq || !imap.serverSupports('CONDSTORE')) {
      throw new Error('Conditional STORE requires a writable CONDSTORE mailbox');
    }
    const version = String(modseq);
    if (!Number.isSafeInteger(uid) || uid < 1 || uid > 0xffffffff || !['\\Seen', '\\Flagged'].includes(flag)
        || !/^[1-9][0-9]{0,19}$/.test(version) || BigInt(version) > 0xffffffffffffffffn) {
      throw new TypeError('Invalid conditional STORE UID, flag or MODSEQ');
    }
    // No arrays, ranges or arbitrary flag atoms: writebacks target one verified
    // UID and change exactly one flag, retaining every unrelated server flag.
    const state = { modified: false };
    imap._enqueue(`UID STORE ${uid} (UNCHANGEDSINCE ${version}) ${mode}FLAGS.SILENT (${flag})`, (error, result) => {
      if (state.modified) {
        const conflict = Object.assign(new Error('Server changed during the update; server state retained'),
          { code: 'MAIL_IMAP_MODIFIED', status: 409 });
        callback(conflict);
      } else callback(error, result);
    });
    requests.set(imap._queue[imap._queue.length - 1], state);
  }
  imap.addFlagsSince = (uid, flag, modseq, callback) => store('+', uid, flag, modseq, callback);
  imap.delFlagsSince = (uid, flag, modseq, callback) => store('-', uid, flag, modseq, callback);
  installed.add(imap);
}

module.exports = { installConditionalStore };
