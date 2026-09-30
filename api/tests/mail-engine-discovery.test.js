const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const account = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', user_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' };
const folder = { folderName: 'INBOX', dbFolderName: 'inbox' };
const mailboxId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
function fixture(t, { uids = [1], epoch = 123, gmail = false } = {}) {
  const repoPath = require.resolve('../src/services/mail-engine/repository');
  const runtimePath = require.resolve('../src/services/mail-engine/runtime');
  const transportPath = require.resolve('../src/services/mail-engine/transport');
  const reconcilePath = require.resolve('../src/services/mail-engine/reconciliation');
  const syncPath = require.resolve('../src/services/mail-engine/sync');
  const original = new Map([repoPath, runtimePath, transportPath, reconcilePath, syncPath].map(p => [p, require.cache[p]]));
  const remotes = new Map(uids.map(uid => [uid, { uid, flags: [], modseq: null, gmailMsgId: gmail ? '999' : null }]));
  const occurrences = new Map(), emails = new Map(), cursors = new Map(), gmailIds = new Map();
  const saves = [], absences = [], bodyJobs = [], reconciled = [], queries = [];
  let currentEpoch = epoch, storedEpoch = epoch, incomplete = false, started = null, duringFetch = null, mappedOperation = null;
  let nextUid = Math.max(0, ...uids) + 1;
  const db = { async execute(sql, params = []) {
    assert.equal((sql.match(/\?/g) || []).length, params.length, 'prepared SQL parameter count');
    queries.push({ sql, params });
    if (sql.includes('FROM mail_writebacks w JOIN mail_remote_occurrences s')) return [[mappedOperation &&
      mappedOperation.destinationUid === params[3] ? mappedOperation.row : null].filter(Boolean)];
    if (sql.includes('SELECT o.uid, o.observation_revision')) return [[...occurrences.values()]
      .filter(o => o.epoch === params[3] && o.uid >= params[4] && o.uid <= params[5])
      .map(o => ({ uid: o.uid, observation_revision: o.observation_revision,
        email_revision: emails.get(o.email_id).observation_revision, observed_modseq: o.modseq }))];
    if (sql.includes('SELECT uid, observation_revision FROM mail_remote_occurrences')) return [[...occurrences.values()]
      .filter(o => o.epoch === params[3] && o.uid >= params[4] && o.uid <= params[5] && o.presence === 'present')
      .map(o => ({ uid: o.uid, observation_revision: o.observation_revision }))];
    if (sql.includes('SELECT uidvalidity FROM mail_remote_mailboxes')) return [[{ uidvalidity: storedEpoch }]];
    if (sql.includes('SELECT o.email_id FROM mail_remote_occurrences')) {
      const o = occurrences.get(params[4]); return [[o && o.epoch === params[3] ? { email_id: o.email_id } : undefined].filter(Boolean)];
    }
    if (sql.includes('FROM mail_gmail_messages')) return [[gmailIds.get(params[2]) ? { email_id: gmailIds.get(params[2]) } : undefined].filter(Boolean)];
    if (sql.includes('INSERT INTO mail_gmail_messages')) { gmailIds.set(params[1], gmailIds.get(params[1]) || params[3]); return [{ affectedRows: 1 }]; }
    if (sql.includes('INSERT INTO emails')) { emails.set(params[0], { id: params[0], observation_revision: 0,
      is_read: params[10], is_starred: params[11], remote_folder: params[7],
      remote_uid: params[8], remote_uidvalidity: params[9] }); return [{ affectedRows: 1 }]; }
    if (sql.includes('DELETE FROM emails')) { emails.delete(params[0]); return [{ affectedRows: 1 }]; }
    if (sql.includes('UPDATE emails e SET e.remote_missing = NOT EXISTS')) {
      const [, , , , , selectedEpoch, start, end] = params;
      for (const gone of occurrences.values()) {
        if (gone.epoch !== selectedEpoch || gone.uid < start || gone.uid > end || gone.presence !== 'absent') continue;
        const email = emails.get(gone.email_id);
        email.remote_missing = ![...occurrences.values()].some(o => o.email_id === gone.email_id && o.epoch === selectedEpoch && o.presence === 'present');
      }
      return [{ affectedRows: 1 }];
    }
    if (sql.includes('UPDATE emails SET remote_missing = FALSE')) {
      if (emails.has(params[0])) emails.get(params[0]).remote_missing = false;
      return [{ affectedRows: 1 }];
    }
    if (sql.includes('UPDATE emails SET is_read')) {
      const e = emails.get(params[3]);
      if (e && e.observation_revision === Number(params[6])) { e.is_read = params[0]; e.is_starred = params[1]; e.observation_revision++; return [{ affectedRows: 1 }]; }
      return [{ affectedRows: 0 }];
    }
    if (sql.includes('UPDATE mail_engine_cursors SET covered_through')) {
      const c = cursors.get(params[1]);
      if (!c || Number(c.covered_through) < Number(params[5]) ||
          (sql.includes('last_covered_at <') && Date.now() - c.last_covered_at < 15 * 60 * 1000))
        return [{ affectedRows: 0 }];
      c.covered_through = 0; c.sweep_generation++;
      return [{ affectedRows: 1 }];
    }
    throw Error(`Unexpected SQL ${sql}`);
  } };
  const repository = {
    withTransaction: async fn => fn(db),
    async ensureMailbox({ epoch: selected }) {
      if (storedEpoch !== selected) { storedEpoch = selected; occurrences.clear(); cursors.clear(); }
      return { id: mailboxId, uidvalidity: selected };
    },
    async loadCursor({ stream }) { return cursors.get(stream) || null; },
    async saveCursor(input) { const row = { covered_through: input.coveredThrough,
      uidvalidity: input.epoch, sweep_generation: input.sweepGeneration || 0,
      coverage_json: input.coverage, last_covered_at: Date.now() };
      cursors.set(input.stream, row); saves.push(input); return row; },
    async getOccurrence({ uid }) { return occurrences.get(uid) || null; },
    async upsertOccurrence(input) {
      const o = { uid: input.uid, epoch: input.epoch, email_id: input.emailId,
        observation_revision: input.observationRevision, modseq: input.modseq, presence: 'present' };
      occurrences.set(input.uid, o); return o;
    },
    async markAbsentInWindow(input) {
      absences.push(input); for (const o of occurrences.values()) {
        if (o.uid >= input.windowStart && o.uid <= input.windowEnd && !input.presentUids.includes(o.uid)) o.presence = 'absent';
      }
      return 0;
    },
  };
  const transport = {
    async selectMailbox() { nextUid = Math.max(nextUid, Math.max(0, ...remotes.keys()) + 1);
      return { uidvalidity: currentEpoch, uidnext: nextUid,
        capabilities: { gmail } }; },
    async fetchMetadataWindow(_connection, input) {
      started = input;
      if (duringFetch) await duringFetch();
      const items = [...remotes.values()].filter(r => r.uid >= input.startUid && r.uid <= input.endUid);
      return { uidvalidity: currentEpoch, startUid: input.startUid, endUid: input.endUid,
        items, complete: !incomplete };
    },
  };
  const runtime = { async enqueueJob(input) { bodyJobs.push(input); }, async assertFence() {} };
  const reconciliation = { async reconcileObservedOccurrence(input) { reconciled.push(input); return []; },
    validMapping(mapping, op, dest) {
      return mapping?.sourceUids?.length === 1 && mapping?.destinationUids?.length === 1 &&
        mapping.sourceUids[0] === op.remote_uid && mapping.destinationUids[0] === dest.uid &&
        mapping.uidvalidity === dest.uidvalidity;
    } };
  for (const [p, exports] of [[repoPath, repository], [runtimePath, runtime], [transportPath, transport], [reconcilePath, reconciliation]])
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
  delete require.cache[syncPath];
  const sync = require(syncPath);
  t.after(() => { for (const [p, entry] of original) { if (entry) require.cache[p] = entry; else delete require.cache[p]; } });
  return { sync, db, remotes, occurrences, emails, cursors, saves, absences, bodyJobs, reconciled, queries,
    get started() { return started; }, setIncomplete(value) { incomplete = value; }, onFetch(fn) { duringFetch = fn; },
    setEpoch(next) { currentEpoch = next; }, setMappedMove(value) { mappedOperation = value; },
    async scan(stream = 'recent', selectedFolder = folder, manualRefresh = false) {
      return sync.scanMailboxSlice({ db, connection: {}, account, folder: selectedFolder, stream,
        manualRefresh, job: manualRefresh ? { id: 'job', lease_owner: 'worker', worker_generation: 1 } : null });
    } };
}

test('arrival during a bounded page does not invalidate committed coverage and continues at the next boundary', async t => {
  const h = fixture(t, { uids: [1, 200] });
  h.onFetch(() => { h.remotes.set(201, { uid: 201, flags: [], modseq: null }); });
  const first = await h.scan();
  assert.deepEqual([h.started.startUid, h.started.endUid], [73, 200]);
  const firstEmail = h.emails.get(h.occurrences.get(200).email_id);
  assert.deepEqual([firstEmail.remote_folder, firstEmail.remote_uid, firstEmail.remote_uidvalidity], ['INBOX', 200, 123]);
  assert.equal(first.inserted, 1);
  assert.equal(h.cursors.get('recent').covered_through, 200);
  const next = await h.scan();
  assert.equal(h.started.startUid, 201);
  assert.equal(next.inserted, 1);
  assert.equal(h.occurrences.size, 2);
});

test('history progresses through sparse windows independently of recent arrivals', async t => {
  const h = fixture(t, { uids: [1, 350] });
  await h.scan('recent');
  for (const expected of [1, 129, 257]) {
    await h.scan('history');
    assert.equal(h.started.startUid, expected);
  }
  assert.equal(h.cursors.get('history').covered_through, 350);
  assert.equal(h.occurrences.size, 2);
  assert(h.started.endUid <= 350);
  assert(h.queries.every(q => !q.sql.includes("['ALL']")));
});

test('incomplete response and cancellation retain cursor rather than skipping the window', async t => {
  const h = fixture(t, { uids: [3] });
  h.setIncomplete(true);
  await assert.rejects(h.scan('history'), /Incomplete/);
  assert.equal(h.saves.length, 0);
  h.setIncomplete(false);
  await h.scan('history');
  assert.equal(h.cursors.get('history').covered_through, 3);
});

test('generic identical copies are distinct items, Gmail capability shares account-scoped identity', async t => {
  const h = fixture(t, { uids: [1, 2] });
  await h.scan('history');
  assert.notEqual(h.occurrences.get(1).email_id, h.occurrences.get(2).email_id);
  const g = fixture(t, { uids: [1, 2], gmail: true });
  await g.scan('history');
  assert.equal(g.occurrences.get(1).email_id, g.occurrences.get(2).email_id);
});

test('finite history pass keeps its captured boundary despite continuous arrivals', async t => {
  const h = fixture(t, { uids: [1, 300] });
  const first = await h.scan('history');
  assert.equal(first.upper, 300);
  h.remotes.set(450, { uid: 450, flags: [], modseq: null });
  const second = await h.scan('history');
  assert.equal(second.upper, 300);
  h.remotes.set(900, { uid: 900, flags: [], modseq: null });
  const third = await h.scan('history');
  assert.equal(third.more, false);
  assert.equal(third.through, 300);
  assert.equal(third.currentUpper, 900);
  const fourth = await h.scan('history');
  assert.equal(fourth.upper, 900);
  assert.equal(h.started.startUid, 301);
});

test('shared MOVE settlement only runs for an exact durable provider COPYUID mapping', async t => {
  const h = fixture(t, { uids: [1] });
  await h.scan('history');
  const emailId = h.occurrences.get(1).email_id;
  h.remotes.delete(1);
  h.remotes.set(2, { uid: 2, flags: [], modseq: null, gmailMsgId: null });
  const mapping = { uidvalidity: 123, sourceUids: [1], destinationUids: [2] };
  h.setMappedMove({ destinationUid: 2, row: { id: 'op', email_id: emailId, remote_uid: 1,
    remote_uidvalidity: 123, evidence_json: JSON.stringify({ kind: 'move_outcome', completion: 'ok',
      mappingStatus: 'valid', mapping }) } });
  await h.scan('recent', { folderName: 'Archive', dbFolderName: 'archive' });
  assert.equal(h.occurrences.get(2).email_id, emailId);
  assert.equal(h.reconciled.length, 1);
  assert.deepEqual(h.reconciled[0].evidence.mapping, mapping);
  h.remotes.set(3, { uid: 3, flags: [], modseq: null, gmailMsgId: null });
  h.setMappedMove({ destinationUid: 3, row: { id: 'weak-op', email_id: emailId, remote_uid: 1,
    remote_uidvalidity: 123, evidence_json: JSON.stringify({ kind: 'move_outcome', completion: 'lost',
      mappingStatus: 'missing', mapping: { ...mapping, destinationUids: [3] } }) } });
  await h.scan('recent', { folderName: 'Archive', dbFolderName: 'archive' });
  assert.notEqual(h.occurrences.get(3).email_id, emailId);
  assert.equal(h.reconciled.length, 1, 'absence or hash never becomes uniqueness evidence');
});


test('epoch reset drops old cursors and never treats reused UID as the old occurrence', async t => {
  const h = fixture(t, { uids: [1] });
  await h.scan('history');
  const prior = h.occurrences.get(1).email_id;
  h.setEpoch(456);
  await h.scan('history');
  assert.notEqual(h.occurrences.get(1).email_id, prior);
  assert.equal(h.cursors.get('history').uidvalidity, 456);
});

test('presence marks only a complete same-epoch UID window, not unrelated sparse rows', async t => {
  const h = fixture(t, { uids: [1, 300] });
  await h.scan('recent'); await h.scan('history');
  h.remotes.delete(1);
  await h.scan('presence');
  assert.equal(h.occurrences.get(1).presence, 'absent');
  assert.equal(h.occurrences.get(300).presence, 'present');
  assert.equal(h.absences[0].windowEnd, 128);
});

test('confirmed absence projects only when no active same-epoch Gmail membership remains', async t => {
  const h = fixture(t, { uids: [1, 2], gmail: true });
  await h.scan('history');
  const id = h.occurrences.get(1).email_id;
  assert.equal(h.occurrences.get(2).email_id, id);
  h.remotes.delete(1);
  h.setIncomplete(true);
  await assert.rejects(h.scan('presence'), /Incomplete/);
  assert.notEqual(h.emails.get(id).remote_missing, true, 'partial sweep cannot declare provider absence');
  h.setIncomplete(false);
  await h.scan('presence');
  assert.equal(h.occurrences.get(1).presence, 'absent');
  assert.equal(h.emails.get(id).remote_missing, false, 'remaining Gmail label keeps item remotely present');
  h.remotes.delete(2);
  // A second complete covered window may be forced after the previous sweep.
  h.cursors.delete('presence');
  await h.scan('presence');
  assert.equal(h.emails.get(id).remote_missing, true);
  assert.equal(h.emails.has(id), true, 'retained item and archive reference are never deleted');
  h.remotes.set(2, { uid: 2, flags: [], modseq: null, gmailMsgId: '999' });
  await h.scan('flags');
  assert.equal(h.emails.get(id).remote_missing, false);
});

test('targeted reconciliation observes one UID without claiming a skipped coverage cursor', async t => {
  const h = fixture(t, { uids: [1, 300] });
  await h.scan('history');
  const prior = h.saves.length;
  const result = await h.sync.scanMailboxSlice({ db: h.db, connection: {}, account,
    folder, stream: 'presence', targetUid: 300, expectedEpoch: 123,
    job: { id: 'job', lease_owner: 'worker', worker_generation: 1 } });
  assert.equal(result.covered, true);
  assert.equal(h.started.startUid, 300);
  assert.equal(h.saves.length, prior, 'a targeted check is not full-stream coverage');
  await assert.rejects(h.sync.scanMailboxSlice({ db: h.db, connection: {}, account,
    folder, stream: 'presence', targetUid: 300, expectedEpoch: 124,
    job: { id: 'job', lease_owner: 'worker', worker_generation: 1 } }), { code: 'MAIL_EPOCH_STALE' });
});

test('slow scan cannot overwrite newer observed flags after its fetch began', async t => {
  const h = fixture(t, { uids: [1] });
  await h.scan('history');
  const email = h.emails.get(h.occurrences.get(1).email_id);
  h.onFetch(() => { h.occurrences.get(1).observation_revision++;
    email.observation_revision++; email.is_starred = 1; });
  await h.scan('flags');
  assert.equal(email.is_starred, 1);
  assert.equal(h.occurrences.get(1).observation_revision, 2);
});

test('manual flags and presence revisit covered UIDs now; periodic sweeps retain their 15-minute throttle', async t => {
  const h = fixture(t, { uids: [1] });
  await h.scan('flags'); await h.scan('presence');
  const email = h.emails.get(h.occurrences.get(1).email_id);
  h.remotes.get(1).flags = ['\\Seen', '\\Flagged'];
  assert.equal((await h.scan('flags')).covered, false);
  assert.equal(email.is_read, 0);
  assert(h.queries.some(q => q.sql.includes('last_covered_at <')));
  const refreshed = await h.scan('flags', folder, true);
  assert.equal(refreshed.covered, true);
  assert.equal(refreshed.refreshPending, false);
  assert.deepEqual([email.is_read, email.is_starred], [1, 1]);
  assert.equal(h.cursors.get('flags').sweep_generation, 1);
  assert.equal((await h.scan('flags')).covered, false, 'background is still throttled');
  h.remotes.delete(1);
  await h.scan('presence', folder, true);
  assert.equal(h.occurrences.get(1).presence, 'absent');
  assert.equal(email.remote_missing, true);
  assert.equal(h.cursors.get('presence').sweep_generation, 1);
  assert.equal((await h.scan('presence')).covered, false);
  h.cursors.get('flags').last_covered_at -= 16 * 60 * 1000;
  assert.equal((await h.scan('flags')).covered, true, 'old completed background sweep restarts without manual intent');
  assert.equal(h.cursors.get('flags').sweep_generation, 2);
});

test('manual request during a finite sweep preserves its cursor, then makes one fresh bounded pass', async t => {
  const h = fixture(t, { uids: [1, 300] });
  assert.equal((await h.scan('flags')).more, true);
  h.remotes.get(1).flags = ['\\Seen', '\\Flagged'];
  const second = await h.scan('flags', folder, true);
  assert.deepEqual([h.started.startUid, h.started.endUid], [129, 256]);
  assert.equal(second.refreshPending, true);
  assert.equal(h.cursors.get('flags').sweep_generation, 0);
  const completed = await h.scan('flags', folder, true);
  assert.deepEqual([h.started.startUid, h.started.endUid], [257, 300]);
  assert.equal(completed.more, true, 'one follow-up job persists the pending manual refresh');
  assert.equal(h.cursors.get('flags').covered_through, 300);
  const revisit = await h.scan('flags', folder, true);
  assert.deepEqual([h.started.startUid, h.started.endUid], [1, 128]);
  assert.equal(revisit.refreshPending, false);
  assert.equal(h.cursors.get('flags').sweep_generation, 1);
  const email = h.emails.get(h.occurrences.get(1).email_id);
  assert.deepEqual([email.is_read, email.is_starred], [1, 1]);
  await h.scan('flags'); await h.scan('flags');
  assert.equal(h.cursors.get('flags').covered_through, 300);
  assert.equal(h.cursors.get('flags').sweep_generation, 1, 'continuations never reset the same manual sweep again');
});

test('manual first observation has no redundant replay when there is no covered cursor', async t => {
  const h = fixture(t, { uids: [1] });
  const result = await h.scan('flags', folder, true);
  assert.equal(result.covered, true);
  assert.equal(result.more, false);
  assert.equal(result.refreshPending, false);
  assert.equal(h.cursors.get('flags').sweep_generation, 0);
});
