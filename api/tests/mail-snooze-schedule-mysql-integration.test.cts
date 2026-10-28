import type { FixtureValue } from './helpers/test-types.cts';
import type { RowDataPacket } from 'mysql2/promise';
// Requires an initially empty, disposable MariaDB database ending in _test.
// The real schema, list queries and notification pipeline; only the SMTP
// hand-over of a scheduled draft is replaced.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('node:crypto') as typeof import('node:crypto');
const { withTestDatabase, startTestApi } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;

const decode = (value: FixtureValue) => typeof value === 'string' ? JSON.parse(value) : value;
const inMinutes = (minutes: number, from = Date.now()) => new Date(from + minutes * 60 * 1000);

// The bootstrap admin is read once per process: both tests sign in as it.
process.env.BOOTSTRAP_ADMIN_EMAIL = 'essentials-owner@example.test';
process.env.BOOTSTRAP_ADMIN_PASSWORD = 'synthetic-essentials-owner-password';

async function setup(t: FixtureValue, name: string) {
  const { captureLog } = require('../dist/src/log') as typeof import('../src/log');
  t.after(captureLog(() => {}));
  const pool = await withTestDatabase(t);
  const api = await startTestApi(t);
  const owner = api.client(), stranger = api.client();
  assert.equal((await owner.request('POST', '/api/auth/signin', { email: 'essentials-owner@example.test', password: 'synthetic-essentials-owner-password' })).status, 200);
  assert.equal((await owner.request('PUT', '/api/admin/settings/signup-mode', { signup_mode: 'open' })).status, 200);
  assert.equal((await stranger.request('POST', '/api/auth/signup', { email: `${name}-stranger@example.test`, password: `synthetic-${name}-stranger-password`, full_name: 'Stranger' })).status, 200);
  // The owner's browser turned notifications on: events are only made for subscribed devices.
  const keyBytes = Buffer.alloc(65, 1); keyBytes[0] = 4;
  assert.equal((await owner.request('POST', '/api/notifications/subscription', { subscription: { endpoint: `https://fcm.googleapis.com/fcm/send/${name}-browser`,
    keys: { p256dh: keyBytes.toString('base64url'), auth: Buffer.alloc(16, 2).toString('base64url') } } })).status, 200);
  const ownerId = ((await owner.request('GET', '/api/auth/me')).body.user as FixtureValue).id as string;
  const account = crypto.randomUUID();
  await pool.execute(`INSERT INTO mail_accounts (id, user_id, email_address, provider, imap_host, smtp_host, encrypted_password, sync_mode, is_active)
    VALUES (?, ?, '${name}-owner@example.test', 'custom', 'imap.example.test', 'smtp.example.test', 'x', 'download', TRUE)`, [account, ownerId]);
  const email = async (fields: { folder?: string; draft?: boolean; subject: string; to?: string[]; read?: boolean }) => {
    const id = crypto.randomUUID();
    await pool.execute(`INSERT INTO emails (id, user_id, mail_account_id, subject, from_name, from_address, to_addresses, body_text, folder, is_draft, is_read, received_at)
      VALUES (?, ?, ?, ?, 'Sender Example', 'sender@example.test', ?, 'Synthetic body', ?, ?, ?, UTC_TIMESTAMP())`,
    [id, ownerId, account, fields.subject, JSON.stringify(fields.to ?? [`${name}-owner@example.test`]), fields.folder ?? 'inbox', !!fields.draft, fields.read ?? false]);
    return id;
  };
  const setMail = async (enabled: boolean) => assert.equal((await owner.request('PUT', '/api/modules', { modules: { mail: { enabled } } })).status, 200);
  return { pool, owner, stranger, ownerId, account, email, setMail };
}

test('a snoozed message leaves the lists and counts, comes back once with a notification at its account\'s detail level, and belongs to its owner', {
  skip: !process.env.MYSQL_TEST_HOST, timeout: 120000,
}, async t => {
  const { pool, owner, stranger, ownerId, account, email, setMail } = await setup(t, 'snooze');
  const snooze = require('../dist/src/services/mail-snooze') as typeof import('../src/services/mail-snooze');

  const kept = await email({ subject: 'Stays in the inbox' });
  const later = await email({ subject: 'Quarterly numbers' });
  // Both in one conversation: a snoozed message leaves the conversation too.
  await pool.execute('UPDATE emails SET thread_key = ? WHERE id IN (?, ?)', ['c'.repeat(64), kept, later]);
  const conversation = async (id: string) => ((await owner.request('GET', `/api/mail/emails/${id}/thread`)).body.messages as FixtureValue[]).map(row => row.id).sort();
  const inboxThreads = async () => (await owner.request('GET', '/api/mail/threads?folder=inbox')).body.threads as FixtureValue[];
  const draft = await email({ subject: 'Unfinished', draft: true, folder: 'drafts' });
  const subjects = async (query: string) =>
    ((await owner.request('GET', `/api/mail/emails?${query}`)).body.emails as FixtureValue[]).map(row => row.subject).sort();
  const inboxUnread = async () => ((await owner.request('GET', '/api/mail/unread-counts')).body as FixtureValue).unreadByFolder.inbox ?? 0;
  const snoozeFor = (who: FixtureValue, id: string, until: unknown) => who.request('POST', `/api/mail/emails/${id}/snooze`, { until });

  assert.equal((await snoozeFor(owner, later, inMinutes(-5).toISOString())).status, 400);
  assert.equal((await snoozeFor(owner, later, 'tomorrow')).status, 400);
  assert.equal((await snoozeFor(owner, draft, inMinutes(60).toISOString())).status, 404, 'a draft is not snoozed');
  assert.equal((await snoozeFor(stranger, later, inMinutes(60).toISOString())).status, 404);
  assert.equal((await stranger.request('DELETE', `/api/mail/emails/${later}/snooze`)).status, 404);

  assert.equal(await inboxUnread(), 2);
  assert.equal((await snoozeFor(owner, later, inMinutes(60).toISOString())).status, 200);
  assert.deepEqual(await subjects('folder=inbox'), ['Stays in the inbox']);
  assert.deepEqual(await subjects('folder=snoozed'), ['Quarterly numbers']);
  assert.deepEqual(await subjects('folder=inbox&search=quarterly'), ['Quarterly numbers'], 'search still finds it');
  assert.deepEqual(await conversation(kept), [kept], 'its conversation leaves it out');
  assert.deepEqual(await conversation(later), [kept, later].sort(), 'opened from the Snoozed view, it shows with its conversation');
  const [thread] = await inboxThreads();
  assert.deepEqual([thread.total_count, thread.message_count], [1, 1]);
  assert.equal(await inboxUnread(), 1, 'and it is not counted while snoozed');
  assert.deepEqual((await stranger.request('GET', '/api/mail/emails?folder=snoozed')).body.emails, [], 'the stranger\'s Snoozed view is their own');

  // Bringing it back by hand: no notification.
  assert.equal((await owner.request('DELETE', `/api/mail/emails/${later}/snooze`)).status, 200);
  assert.deepEqual(await subjects('folder=inbox'), ['Quarterly numbers', 'Stays in the inbox']);

  // Its time comes: the worker brings it back once, with a notification at the
  // account's detail level (sender only), even though the account's mail
  // notifications are off: the person asked for it.
  assert.equal((await owner.request('PUT', `/api/settings/values/mail-accounts/${account}`, { values: { notify_detail: 'sender', notify_enabled: false } })).status, 200);
  assert.equal((await snoozeFor(owner, later, inMinutes(5).toISOString())).status, 200);
  assert.deepEqual(await snooze.returnDueSnoozes(), { returned: 0 }, 'not due yet');
  const due = inMinutes(6);
  assert.deepEqual(await snooze.returnDueSnoozes(due), { returned: 1 });
  assert.deepEqual(await snooze.returnDueSnoozes(due), { returned: 0 }, 'and only once');
  const [events] = await pool.execute<RowDataPacket[]>("SELECT user_id, payload FROM notification_events WHERE kind = 'snooze'");
  assert.equal(events.length, 1);
  assert.equal(events[0].user_id, ownerId);
  const payload = decode(events[0].payload);
  assert.equal(payload.title, 'Snoozed email is back');
  assert.equal(payload.body, 'Sender Example', 'no subject at the sender level');
  assert.ok(!JSON.stringify(payload).includes('Quarterly'));
  assert.deepEqual(await subjects('folder=inbox'), ['Quarterly numbers', 'Stays in the inbox']);

  // Snoozed again and due while the person's Mail is switched off: it waits.
  assert.equal((await snoozeFor(owner, later, inMinutes(5).toISOString())).status, 200);
  await setMail(false);
  assert.equal((await snoozeFor(owner, later, inMinutes(5).toISOString())).status, 403, 'the routes belong to Mail');
  assert.deepEqual(await snooze.returnDueSnoozes(inMinutes(10)), { returned: 0 });
  await setMail(true);
  assert.deepEqual(await snooze.returnDueSnoozes(inMinutes(10)), { returned: 1 });
  const [[{ total }]] = await pool.execute<RowDataPacket[]>("SELECT COUNT(*) AS total FROM notification_events WHERE kind = 'snooze'");
  assert.equal(Number(total), 2, 'each return has its own notification');
});

test('kept in the folder, a snoozed message stays in its folder, conversation and counts, marked, and still comes back with its notification; the setting is the owner\'s own', {
  skip: !process.env.MYSQL_TEST_HOST, timeout: 120000,
}, async t => {
  const { pool, owner, stranger, ownerId, email } = await setup(t, 'snooze-keep');
  const snooze = require('../dist/src/services/mail-snooze') as typeof import('../src/services/mail-snooze');

  const kept = await email({ subject: 'Stays in the inbox' });
  const later = await email({ subject: 'Quarterly numbers' });
  await pool.execute('UPDATE emails SET thread_key = ? WHERE id IN (?, ?)', ['d'.repeat(64), kept, later]);
  // The stranger has a message of their own and leaves the setting at its default.
  const strangerId = ((await stranger.request('GET', '/api/auth/me')).body.user as FixtureValue).id as string;
  const strangerAccount = crypto.randomUUID(), strangerMail = crypto.randomUUID();
  await pool.execute(`INSERT INTO mail_accounts (id, user_id, email_address, provider, imap_host, smtp_host, encrypted_password, sync_mode, is_active)
    VALUES (?, ?, 'snooze-keep-stranger@example.test', 'custom', 'imap.example.test', 'smtp.example.test', 'x', 'download', TRUE)`, [strangerAccount, strangerId]);
  await pool.execute(`INSERT INTO emails (id, user_id, mail_account_id, subject, from_address, to_addresses, body_text, folder, is_draft, is_read, received_at)
    VALUES (?, ?, ?, 'Stranger mail', 'sender@example.test', '[]', 'Synthetic body', 'inbox', FALSE, FALSE, UTC_TIMESTAMP())`, [strangerMail, strangerId, strangerAccount]);

  const rows = async (who: FixtureValue, query: string) => (await who.request('GET', `/api/mail/emails?${query}`)).body.emails as FixtureValue[];
  const subjects = async (who: FixtureValue, query: string) => (await rows(who, query)).map(row => row.subject).sort();
  const conversation = async (id: string) => ((await owner.request('GET', `/api/mail/emails/${id}/thread`)).body.messages as FixtureValue[]).map(row => row.id).sort();
  const counts = async () => {
    const unread = ((await owner.request('GET', '/api/mail/unread-counts')).body as FixtureValue).unreadByFolder.inbox ?? 0;
    const inbox = ((await owner.request('GET', '/api/mail/folders')).body.folders as FixtureValue[]).find(folder => folder.slug === 'inbox');
    const badge = ((await owner.request('GET', '/api/mail/accounts')).body.accounts as FixtureValue[])[0].unread_count;
    const [thread] = (await owner.request('GET', '/api/mail/threads?folder=inbox')).body.threads as FixtureValue[];
    return { unread, total: inbox.total_count, badge, conversation: [thread.message_count, thread.total_count] };
  };
  const setKeep = async (value: 'hide' | 'keep') => {
    const saved = await owner.request('PUT', '/api/settings/values', { values: { snoozed_messages: value } });
    assert.equal(saved.status, 200);
    assert.equal((saved.body as FixtureValue).settings.snoozed_messages.value, value);
  };
  assert.equal((await owner.request('PUT', '/api/settings/values', { values: { snoozed_messages: 'show' } })).status, 400, 'only the two choices');

  await setKeep('keep');
  const until = inMinutes(60);
  assert.equal((await owner.request('POST', `/api/mail/emails/${later}/snooze`, { until: until.toISOString() })).status, 200);
  assert.deepEqual(await subjects(owner, 'folder=inbox'), ['Quarterly numbers', 'Stays in the inbox'], 'it stays in its folder');
  const listed = (await rows(owner, 'folder=inbox')).find(row => row.id === later);
  assert.ok(Math.abs(new Date(listed.snoozed_until).getTime() - until.getTime()) < 1000, 'with the time it is snoozed until, for its mark');
  assert.deepEqual(await subjects(owner, 'folder=snoozed'), ['Quarterly numbers'], 'and the Snoozed view still lists it');
  assert.deepEqual(await subjects(owner, 'folder=all'), ['Quarterly numbers', 'Stays in the inbox']);
  assert.deepEqual(await conversation(kept), [kept, later].sort(), 'its conversation keeps it');
  assert.deepEqual(await counts(), { unread: 2, total: 2, badge: 2, conversation: [2, 2] }, 'the counts follow the list');
  assert.equal(((await owner.request('GET', '/api/offline/snapshot')).body.snapshot as FixtureValue).keepSnoozed, true, 'offline lists follow it too');

  // A view rule: switching it applies at once to the message already snoozed.
  await setKeep('hide');
  assert.deepEqual(await subjects(owner, 'folder=inbox'), ['Stays in the inbox']);
  assert.deepEqual(await conversation(kept), [kept]);
  assert.deepEqual(await counts(), { unread: 1, total: 1, badge: 1, conversation: [1, 1] });
  assert.equal(((await owner.request('GET', '/api/offline/snapshot')).body.snapshot as FixtureValue).keepSnoozed, false);
  await setKeep('keep');

  // The owner's choice is not the stranger's: their snoozed message leaves their inbox.
  assert.equal(((await stranger.request('GET', '/api/settings/values')).body as FixtureValue).settings.snoozed_messages.value, 'hide');
  assert.equal((await stranger.request('POST', `/api/mail/emails/${strangerMail}/snooze`, { until: inMinutes(60).toISOString() })).status, 200);
  assert.deepEqual(await subjects(stranger, 'folder=inbox'), []);
  assert.deepEqual(await subjects(stranger, 'folder=snoozed'), ['Stranger mail']);
  assert.ok(!(await subjects(owner, 'folder=all')).includes('Stranger mail'));

  // Its time comes: it comes back once, with its notification, as when hidden.
  assert.deepEqual(await snooze.returnDueSnoozes(inMinutes(61)), { returned: 2 });
  const [events] = await pool.execute<RowDataPacket[]>("SELECT user_id, source_id FROM notification_events WHERE kind = 'snooze' AND user_id = ?", [ownerId]);
  assert.deepEqual(events.map(row => row.source_id), [later]);
  const back = (await rows(owner, 'folder=inbox')).find(row => row.id === later);
  assert.equal(back.snoozed_until, null);
  assert.ok(back.snooze_returned_at, 'marked as back from snooze');
  assert.deepEqual(await subjects(owner, 'folder=snoozed'), []);
});

test('a scheduled draft sends once at its time, waits while Mail is off, recovers a stopped send from its key, and reports a failure', {
  skip: !process.env.MYSQL_TEST_HOST, timeout: 120000,
}, async t => {
  const { pool, owner, stranger, ownerId, account, email, setMail } = await setup(t, 'schedule');
  const scheduled = require('../dist/src/services/mail-scheduled-send') as typeof import('../src/services/mail-scheduled-send');
  const drafts = require('../dist/src/services/mail-drafts') as typeof import('../src/services/mail-drafts');

  const handedOver: string[] = [];
  // The SMTP hand-over: the message is out, then the draft goes as after a real send.
  const deliver = async (userId: string, draftId: string) => {
    handedOver.push(draftId);
    await drafts.deleteDraftWithFiles(userId, draftId);
    return { success: true, messageId: `<${draftId}@example.test>` };
  };
  const status = async (draftId: string) => (await pool.execute<RowDataPacket[]>('SELECT status, last_error, client_key FROM mail_scheduled_sends WHERE email_id = ?', [draftId]))[0][0];
  const schedule = (who: FixtureValue, id: string, minutes: number) => who.request('POST', `/api/mail/drafts/${id}/schedule`, { send_at: inMinutes(minutes).toISOString() });

  const draft = await email({ subject: 'Monday update', draft: true, folder: 'drafts', to: ['team@example.test'] });
  const empty = await email({ subject: 'No one yet', draft: true, folder: 'drafts', to: [] });
  assert.equal((await schedule(owner, empty, 30)).body.code, 'DRAFT_RECIPIENTS_MISSING');
  assert.equal((await schedule(owner, draft, -1)).status, 400);
  assert.equal((await schedule(stranger, draft, 30)).status, 404);

  const first = await schedule(owner, draft, 30);
  assert.equal(first.status, 200);
  assert.equal(first.body.schedule.status, 'scheduled');
  const key = (await status(draft)).client_key;
  await schedule(owner, draft, 20);
  assert.equal((await status(draft)).client_key, key, 'moving the time keeps the key');
  assert.equal((await stranger.request('DELETE', `/api/mail/drafts/${draft}/schedule`)).status, 404);
  const listed = ((await owner.request('GET', '/api/mail/emails?folder=drafts')).body.emails as FixtureValue[]).find(row => row.id === draft);
  assert.equal(listed?.scheduled_send_status, 'scheduled', 'Drafts shows the schedule');
  // A new From account takes the schedule along: removing the former account
  // then leaves it in place.
  const other = crypto.randomUUID();
  await pool.execute(`INSERT INTO mail_accounts (id, user_id, email_address, provider, imap_host, smtp_host, encrypted_password, sync_mode, is_active)
    VALUES (?, ?, 'schedule-other@example.test', 'custom', 'imap.example.test', 'smtp.example.test', 'x', 'download', TRUE)`, [other, ownerId]);
  const scheduleAccount = async () => (await pool.execute<RowDataPacket[]>('SELECT mail_account_id FROM mail_scheduled_sends WHERE email_id = ?', [draft]))[0][0]?.mail_account_id;
  assert.equal((await owner.request('PUT', `/api/mail/drafts/${draft}`, { account_id: other })).status, 200);
  assert.equal(await scheduleAccount(), other);
  // Scheduled while another save changes the From account: the schedule takes
  // the account the draft has once its lock is held.
  const holder = await pool.getConnection();
  await holder.beginTransaction();
  await holder.execute('SELECT id FROM emails WHERE id = ? FOR UPDATE', [draft]);
  await holder.execute('UPDATE emails SET mail_account_id = ? WHERE id = ?', [account, draft]);
  const rescheduling = schedule(owner, draft, 20);
  await new Promise(resolve => setTimeout(resolve, 300));
  await holder.commit();
  holder.release();
  assert.equal((await rescheduling).status, 200);
  assert.equal(await scheduleAccount(), account);
  assert.equal((await owner.request('PUT', `/api/mail/drafts/${draft}`, { account_id: other })).status, 200);
  assert.equal((await owner.request('PUT', `/api/mail/drafts/${draft}`, { account_id: account })).status, 200);
  await pool.execute('DELETE FROM mail_accounts WHERE id = ?', [other]);
  assert.equal(await scheduleAccount(), account);
  assert.equal((await status(draft)).client_key, key, 'an edit keeps the schedule');

  assert.deepEqual(await scheduled.runDueScheduledSends(new Date(), deliver), { sent: 0 }, 'not due yet');
  // Due while Mail is off: it waits, and is sent once Mail is back.
  await setMail(false);
  assert.deepEqual(await scheduled.runDueScheduledSends(inMinutes(21), deliver), { sent: 0 });
  await setMail(true);
  // Two passes at once (a second tick, a second process) send it once.
  const passes = await Promise.all([scheduled.runDueScheduledSends(inMinutes(21), deliver), scheduled.runDueScheduledSends(inMinutes(21), deliver)]);
  assert.equal(passes[0].sent + passes[1].sent, 1);
  assert.deepEqual(handedOver, [draft]);
  assert.equal(await status(draft), undefined, 'the sent draft took its schedule with it');

  // A send that stopped without an outcome (the process ended): after the
  // stale window its key decides. Here the hand-over had finished, so the
  // receipt answers and nothing is sent again. Meanwhile the draft is locked.
  const crashed = await email({ subject: 'Sent before the crash', draft: true, folder: 'drafts', to: ['team@example.test'] });
  await schedule(owner, crashed, 5);
  const crashedKey = (await status(crashed)).client_key;
  const { sendOnce } = require('../dist/src/services/mail-send') as typeof import('../src/services/mail-send');
  await sendOnce({ userId: ownerId, clientKey: crashedKey, request: { draftId: crashed, scheduled: true } }, async () => ({ success: true, messageId: '<before-crash@example.test>' }));
  await pool.execute("UPDATE mail_scheduled_sends SET status = 'sending', updated_at = UTC_TIMESTAMP() - INTERVAL 5 MINUTE WHERE email_id = ?", [crashed]);
  assert.equal((await owner.request('PUT', `/api/mail/drafts/${crashed}`, { subject: 'Edited too late' })).body.code, 'SCHEDULED_SEND_IN_PROGRESS');
  assert.equal((await owner.request('DELETE', `/api/mail/drafts/${crashed}`)).status, 409);
  assert.equal((await owner.request('DELETE', `/api/mail/drafts/${crashed}/schedule`)).status, 409);
  assert.deepEqual(await scheduled.runDueScheduledSends(inMinutes(6), deliver), { sent: 0 }, 'a recent claim is left alone');
  await pool.execute(`UPDATE mail_scheduled_sends SET updated_at = UTC_TIMESTAMP() - INTERVAL ${scheduled.STALE_SENDING_SECONDS + 60} SECOND WHERE email_id = ?`, [crashed]);
  assert.deepEqual(await scheduled.runDueScheduledSends(inMinutes(6), deliver), { sent: 1 });
  assert.ok(!handedOver.includes(crashed), 'the receipt answered: not handed over again');
  assert.equal((await status(crashed)).status, 'sent', 'the draft that was not removed keeps a sent mark');

  // The connection was lost after the hand-over: unknown, announced, never retried.
  const lost = await email({ subject: 'Lost connection', draft: true, folder: 'drafts', to: ['team@example.test'] });
  await schedule(owner, lost, 5);
  const lostAfterData = async () => { throw Object.assign(new Error('lost after DATA'), { status: 409, code: 'SEND_OUTCOME_UNKNOWN' }); };
  assert.deepEqual(await scheduled.runDueScheduledSends(inMinutes(6), lostAfterData), { sent: 0 });
  assert.equal((await status(lost)).status, 'unknown');
  assert.deepEqual(await scheduled.runDueScheduledSends(inMinutes(60), deliver), { sent: 0 });
  assert.ok(!handedOver.includes(lost));

  // Refused before the message left: failed, with a text the person may see
  // (no SMTP reply, which can name recipients), announced once; scheduling
  // again uses a new key, and sending by hand cancels the schedule.
  const refused = await email({ subject: 'Refused', draft: true, folder: 'drafts', to: ['team@example.test'] });
  await schedule(owner, refused, 5);
  const refusedKey = (await status(refused)).client_key;
  const smtpRefusal = async () => { throw new Error('550 5.1.1 <team@example.test>: Recipient address rejected'); };
  await scheduled.runDueScheduledSends(inMinutes(6), smtpRefusal);
  const failed = await status(refused);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.last_error, 'The mail server did not accept the message.');
  await scheduled.runDueScheduledSends(inMinutes(60), deliver);
  assert.ok(!handedOver.includes(refused), 'a failed send waits for the person');
  const [problems] = await pool.execute<RowDataPacket[]>("SELECT user_id, payload FROM notification_events WHERE kind = 'scheduled-send'");
  assert.equal(problems.length, 2);
  assert.ok(problems.every(row => row.user_id === ownerId));
  assert.ok(!problems.some(row => /Refused|Lost connection|team@/.test(JSON.stringify(decode(row.payload)))), 'no message content in the notification');
  await schedule(owner, refused, 5);
  assert.notEqual((await status(refused)).client_key, refusedKey, 'a new attempt has a new key');
  assert.equal((await status(refused)).status, 'scheduled');
  // Sending it by hand replaces the schedule; refused again, the draft is free and unscheduled.
  assert.deepEqual(await scheduled.sendDraftNow(ownerId, refused, 'send-now-refused', null, async () => ({ error: 'Account not found', status: 404 })),
    { error: 'Account not found', status: 404 });
  assert.equal(await status(refused), undefined);

  // A send by hand reserves the draft: while it runs, no schedule, edit,
  // delete or scheduler pass can touch it, so it cannot go out twice.
  const manual = await email({ subject: 'Sent by hand', draft: true, folder: 'drafts', to: ['team@example.test'] });
  let finish!: () => void;
  const slowHandOver = async (userId: string, draftId: string) => {
    await new Promise<void>(resolve => { finish = resolve; });
    return deliver(userId, draftId);
  };
  const byHand = scheduled.sendDraftNow(ownerId, manual, 'send-now-manual', null, slowHandOver);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await schedule(owner, manual, 5)).body.code, 'SCHEDULED_SEND_IN_PROGRESS');
  assert.equal((await owner.request('PUT', `/api/mail/drafts/${manual}`, { subject: 'Changed meanwhile' })).body.code, 'SCHEDULED_SEND_IN_PROGRESS');
  assert.equal((await owner.request('DELETE', `/api/mail/drafts/${manual}`)).status, 409);
  await pool.execute("UPDATE mail_scheduled_sends SET updated_at = UTC_TIMESTAMP() - INTERVAL 1 HOUR WHERE email_id = ?", [manual]);
  await scheduled.runDueScheduledSends(inMinutes(60), deliver);
  assert.ok(!handedOver.includes(manual), 'the scheduler never sends a draft that is being sent by hand');
  // Older than the stale window but still running here: not settled as stopped,
  // so a second send by hand (a new key) is still refused.
  assert.equal((await status(manual)).status, 'sending');
  await assert.rejects(scheduled.sendDraftNow(ownerId, manual, 'send-now-second', null, deliver), { status: 409, code: 'SCHEDULED_SEND_IN_PROGRESS' });
  finish();
  assert.equal((await byHand).success, true);
  assert.deepEqual(handedOver.filter(id => id === manual), [manual], 'handed over once');
  assert.equal(await status(manual), undefined, 'the sent draft took its reservation with it');

  // A send by hand whose process stopped is never resumed by the scheduler:
  // without a receipt the draft is simply free again.
  const stopped = await email({ subject: 'Stopped by hand', draft: true, folder: 'drafts', to: ['team@example.test'] });
  await pool.execute(`INSERT INTO mail_scheduled_sends (id, user_id, email_id, mail_account_id, send_at, status, origin, client_key, updated_at)
    SELECT UUID(), user_id, id, mail_account_id, UTC_TIMESTAMP(), 'sending', 'send_now', 'send-now-stopped', UTC_TIMESTAMP() - INTERVAL 1 HOUR FROM emails WHERE id = ?`, [stopped]);
  await scheduled.runDueScheduledSends(inMinutes(60), deliver);
  assert.ok(!handedOver.includes(stopped));
  assert.equal(await status(stopped), undefined);

  // A deactivated person's scheduled mail does not go out.
  const inactive = await email({ subject: 'After leaving', draft: true, folder: 'drafts', to: ['team@example.test'] });
  await schedule(owner, inactive, 5);
  await pool.execute('UPDATE users SET is_active = FALSE WHERE id = ?', [ownerId]);
  assert.deepEqual(await scheduled.runDueScheduledSends(inMinutes(6), deliver), { sent: 0 });
  assert.equal((await status(inactive)).status, 'scheduled');
});
