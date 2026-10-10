import type { FixtureValue } from './helpers/test-types.cts';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const policy = require('../dist/src/services/mail-sync-policy') as typeof import('../src/services/mail-sync-policy');
const { imapListToFolders } = require('../dist/src/services/mail-folders') as typeof import('../src/services/mail-folders');

test('retention windows accept only the offered choices; empty means all mail', () => {
  for (const days of [14, 30, 90, 180, 365]) {
    assert.equal(policy.parseWindowDays(days, 'sync_window_days'), days);
    assert.equal(policy.parseWindowDays(String(days), 'sync_window_days'), days);
  }
  for (const all of [null, '', 'all', 'ALL']) assert.equal(policy.parseWindowDays(all, 'sync_window_days'), null);
  assert.equal(policy.parseWindowDays(undefined, 'sync_window_days'), undefined);
  for (const bad of [0, 7, 31, -30, '30d', '1e2', 365.5, {}, true]) {
    assert.throws(() => policy.parseWindowDays(bad, 'trash_window_days'), error => (error as FixtureValue).status === 400 && /trash_window_days/.test((error as FixtureValue).message));
  }
});

test('windows apply per mailbox in Sync mode only, by INTERNALDATE', () => {
  const now = Date.parse('2026-10-01T00:00:00Z');
  const sync = { sync_mode: 'sync', sync_window_days: 30, trash_window_days: 14 };
  const inbox = { remote_name: 'INBOX', special_use: null };
  const trash = { remote_name: 'Deleted', special_use: 'trash' };
  const spam = { remote_name: '[Gmail]/Spam', special_use: null };
  assert.equal(policy.windowDaysFor(sync as FixtureValue, inbox), 30);
  assert.equal(policy.windowDaysFor(sync as FixtureValue, trash), 14);
  assert.equal(policy.windowDaysFor(sync as FixtureValue, spam), 14);
  assert.equal(policy.windowDaysFor(sync as FixtureValue, { remote_name: 'Junk', special_use: 'junk' }), 14);
  assert.equal(policy.windowDaysFor({ ...sync, sync_mode: 'download' } as FixtureValue, inbox), null, 'Download mode ignores windows');
  assert.equal(policy.outsideWindow(sync as FixtureValue, inbox, '2026-08-01T00:00:00Z', now), true);
  assert.equal(policy.outsideWindow(sync as FixtureValue, inbox, '2026-09-20T00:00:00Z', now), false);
  assert.equal(policy.outsideWindow(sync as FixtureValue, trash, '2026-09-10T00:00:00Z', now), true);
  assert.equal(policy.outsideWindow(sync as FixtureValue, inbox, null, now), false, 'Unknown dates are never old');
  assert.equal(policy.outsideWindow(sync as FixtureValue, inbox, 'not a date', now), false);
  assert.equal(policy.outsideWindow({ ...sync, sync_window_days: null } as FixtureValue, inbox, '1999-01-01T00:00:00Z', now), false, 'All mail');
  assert.deepEqual(policy.storedWindows({ sync_window_days: '90', trash_window_days: null }), { sync: 90, trash: null });
});

test('LIST marks \\All mailboxes so Sync can tell archived Gmail mail from deleted mail', () => {
  const specialUses = new Map(), all = new Set<FixtureValue>();
  const folders = imapListToFolders([
    { path: 'INBOX', flags: new Set<FixtureValue>() },
    { path: '[Gmail]/Alle Nachrichten', flags: new Set<FixtureValue>(['\\HasNoChildren', '\\All']) },
    { path: '[Gmail]/Papierkorb', flags: new Set<FixtureValue>(['\\Trash']) },
    { path: '[Gmail]', flags: new Set<FixtureValue>(['\\Noselect']) },
  ], specialUses, all);
  assert.deepEqual(folders, ['INBOX', '[Gmail]/Alle Nachrichten', '[Gmail]/Papierkorb']);
  assert.deepEqual([...all], ['[Gmail]/Alle Nachrichten']);
  assert.equal(specialUses.get('[Gmail]/Alle Nachrichten'), 'archive', 'Local folder mapping is unchanged');
  assert.equal(specialUses.get('[Gmail]/Papierkorb'), 'trash');
});

test('mode impact for Download mode removes nothing and needs no database', async () => {
  const impact = await policy.computeModeImpact({ id: 'a', user_id: 'u', sync_mode: 'sync' }, { mode: 'download' }, {
    execute: async () => { throw new Error('no query expected'); },
  } as FixtureValue);
  assert.deepEqual({ ...impact, notes: impact.notes.length }, { mode: 'download', local_only: 0, outside_window: 0,
    outside_trash_window: 0, gmail_duplicates: 0, total_removals: 0, notes: 1 });
  await assert.rejects(policy.computeModeImpact({} as FixtureValue, { mode: 'mirror' }), error => (error as FixtureValue).status === 400);
});

test('prune does nothing for Download accounts', async () => {
  assert.deepEqual(await policy.runPruneSlice({ account: { id: 'a', user_id: 'u', sync_mode: 'download' } }),
    { processed: 0, removed: 0, more: false, skipped: 'download_mode' });
});
